-- ============================================================================
-- Task #191 — Stop senders from silently gaining access to recipients' inboxes
-- ============================================================================
--
-- WHY THIS EXISTS
-- ---------------
-- Migration 0035 added a SECURITY DEFINER BEFORE INSERT/UPDATE trigger,
-- `xpc_messages_autoclaim`, that calls `xpc_ensure_claim()` on BOTH the
-- row's `from_pc_id` and `to_pc_id` columns. `xpc_ensure_claim()` is
-- itself SECURITY DEFINER and writes (auth.uid(), pc_id) into
-- `xpc_user_pcs` on conflict-do-nothing — it bypasses the user-facing
-- WITH CHECK gate `xpc_can_claim_pc_id(pc_id)` that protects every
-- direct write to `xpc_user_pcs`.
--
-- The original intent (per 0035's preamble) was UX: the sender's first
-- INSERT must not be rejected with 42501 if their heartbeat-driven
-- claim hasn't completed yet. Claiming `from_pc_id` (the sender's own
-- seat) achieves that.
--
-- Claiming `to_pc_id` was either an over-eager symmetry choice or a
-- left-over from when the trigger was meant to also help the receiver
-- on UPDATE (mark-read). Either way, after migration 0049 widened the
-- SELECT policy on `xpc_messages` to honour logical-seat addressing,
-- the silent insert into `xpc_user_pcs` for the recipient's seat became
-- a real privilege-escalation vector:
--
--   1. User A sends a message to seat S (to_pc_id = S).
--   2. The trigger silently registers A as a claimant of S.
--   3. Later, user B sends a message to seat S.
--   4. A's `xpc_my_pc_ids()` now contains S, so A's SELECT on
--      xpc_messages returns B's message — even though A was never
--      meant to be a participant in any conversation addressed to S
--      that A did not personally initiate.
--
-- In the current single-tenant RJAF deployment the surface is bounded
-- (every authenticated user is already inside the perimeter), but if
-- the product ever serves multiple squadrons or units this is the kind
-- of silent privilege escalation a security review will flag.
--
-- WHAT CHANGES
-- ------------
-- 1. `xpc_messages_autoclaim` is rewritten to gate every claim through
--    `xpc_can_claim_pc_id(NEW.<col>)` — the same predicate the user-
--    facing `xpc_user_pcs_self_insert` policy uses. A claim is only
--    persisted when the calling user's app_metadata authorises that
--    pc_id; otherwise the side-effect is suppressed. The trigger keeps
--    SECURITY DEFINER so it can still call the can-claim helper (which
--    needs to read the JWT claims), but the side-effect is no longer
--    silent.
--
-- 2. Rejected claim attempts are logged to `audit_log` with a structured
--    detail payload. This makes the side-effect visible and auditable
--    — operators can grep for `xpc.message.autoclaim_blocked` to spot
--    anyone whose client UI is requesting unauthorised seats.
--
-- 3. `xpc_pending_autoclaim` and `xpc_snap_autoclaim` are tightened
--    the same way as a defense-in-depth pass over the other tables
--    that 0035 wired up. (For pending and snapshot the spam surface
--    is smaller because their SELECT policies have not been widened
--    by 0049, but the same trigger-based escalation pattern existed
--    and is closed here for consistency.)
--
-- 4. One-time backfill: every row in `xpc_user_pcs` that the user could
--    not legitimately re-create today is deleted. We can't call
--    `xpc_can_claim_pc_id` from migration context (it reads
--    `request.jwt.claims`, which is empty under the service role), so
--    we replicate its predicate against `auth.users.raw_app_meta_data`
--    inline. Legitimate users will re-establish their canonical claim
--    automatically on the next 30s heartbeat (see `ensureMyPcClaim` in
--    `artifacts/pilot-dashboard/src/lib/cross-pc.ts`).
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- - The relaxed authentication-only WITH CHECK on `xpc_messages_insert`
--   from 0035 stays. The defense for that table is now the autoclaim
--   trigger plus the can-claim gate inside it, plus the SELECT policy
--   from 0049 keyed off `xpc_pc_id_matches_mine()` which itself reads
--   the (now correct) `xpc_user_pcs` claim set.
-- - `xpc_ensure_claim()` itself is unchanged (idempotent, sentinel-
--   guarded). Other call sites of it remain valid; the new gate lives
--   in the per-table autoclaim functions.
-- - The legitimate first-send path is preserved: the sender's
--   `from_pc_id` always passes `xpc_can_claim_pc_id()` because that's
--   exactly the seat the server-issued `app_metadata.pc_id` claim
--   authorises them for.
--
-- IDEMPOTENCY
-- -----------
-- Every CREATE OR REPLACE so re-running the migration is safe. The
-- backfill DELETE is naturally idempotent (the second run finds no
-- rows to delete because the trigger no longer creates new bad rows).
-- ============================================================================

-- ─── 1. xpc_messages — gated autoclaim ─────────────────────────────────────
create or replace function public.xpc_messages_autoclaim()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  -- Sender side: the inserter's own seat. Gated by xpc_can_claim_pc_id
  -- so that a malicious or buggy client cannot supply a from_pc_id
  -- value that does not match its server-issued app_metadata.pc_id.
  if new.from_pc_id is not null and new.from_pc_id <> '' and new.from_pc_id <> 'self' then
    if public.xpc_can_claim_pc_id(new.from_pc_id) then
      perform public.xpc_ensure_claim(new.from_pc_id);
    elsif uid is not null then
      insert into public.audit_log (squadron_id, type, actor, detail)
      values (
        null,
        'xpc.message.autoclaim_blocked',
        uid::text,
        jsonb_build_object(
          'column',     'from_pc_id',
          'pc_id',      new.from_pc_id,
          'to_pc_id',   new.to_pc_id,
          'message_id', new.id,
          'op',         tg_op
        )
      );
    end if;
  end if;

  -- Recipient side: previously claimed unconditionally, which is the
  -- bug this migration closes. Now gated by the same predicate.
  -- A receiver marking-read their own inbox passes (their app_metadata
  -- authorises to_pc_id); a sender addressing a third-party seat does
  -- not, so no silent claim is created on their behalf.
  if new.to_pc_id is not null and new.to_pc_id <> '' and new.to_pc_id <> 'self' then
    if public.xpc_can_claim_pc_id(new.to_pc_id) then
      perform public.xpc_ensure_claim(new.to_pc_id);
    elsif uid is not null then
      insert into public.audit_log (squadron_id, type, actor, detail)
      values (
        null,
        'xpc.message.autoclaim_blocked',
        uid::text,
        jsonb_build_object(
          'column',     'to_pc_id',
          'pc_id',      new.to_pc_id,
          'from_pc_id', new.from_pc_id,
          'message_id', new.id,
          'op',         tg_op
        )
      );
    end if;
  end if;

  return new;
end;
$$;

-- The trigger binding from 0035 still points at this function; we only
-- replaced the body. Re-asserting BEFORE INSERT/UPDATE here for safety
-- in case any later migration dropped the binding.
drop trigger if exists xpc_messages_autoclaim_biu on public.xpc_messages;
create trigger xpc_messages_autoclaim_biu
before insert or update on public.xpc_messages
for each row execute function public.xpc_messages_autoclaim();

-- ─── 2. xpc_pending — same defense-in-depth gating ─────────────────────────
create or replace function public.xpc_pending_autoclaim()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if new.hosting_squadron_id is not null and new.hosting_squadron_id <> '' and new.hosting_squadron_id <> 'self' then
    if public.xpc_can_claim_pc_id(new.hosting_squadron_id) then
      perform public.xpc_ensure_claim(new.hosting_squadron_id);
    elsif uid is not null then
      insert into public.audit_log (squadron_id, type, actor, detail)
      values (
        null,
        'xpc.pending.autoclaim_blocked',
        uid::text,
        jsonb_build_object(
          'column',          'hosting_squadron_id',
          'pc_id',           new.hosting_squadron_id,
          'home_squadron_id',new.home_squadron_id,
          'pending_id',      new.id,
          'op',              tg_op
        )
      );
    end if;
  end if;

  if new.home_squadron_id is not null and new.home_squadron_id <> '' and new.home_squadron_id <> 'self' then
    if public.xpc_can_claim_pc_id(new.home_squadron_id) then
      perform public.xpc_ensure_claim(new.home_squadron_id);
    elsif uid is not null then
      insert into public.audit_log (squadron_id, type, actor, detail)
      values (
        null,
        'xpc.pending.autoclaim_blocked',
        uid::text,
        jsonb_build_object(
          'column',             'home_squadron_id',
          'pc_id',              new.home_squadron_id,
          'hosting_squadron_id',new.hosting_squadron_id,
          'pending_id',         new.id,
          'op',                 tg_op
        )
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists xpc_pending_autoclaim_biu on public.xpc_pending;
create trigger xpc_pending_autoclaim_biu
before insert or update on public.xpc_pending
for each row execute function public.xpc_pending_autoclaim();

-- ─── 3. xpc_squadron_snapshot — same defense-in-depth gating ───────────────
create or replace function public.xpc_snap_autoclaim()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if new.ops_pc_id is not null and new.ops_pc_id <> '' and new.ops_pc_id <> 'self' then
    if public.xpc_can_claim_pc_id(new.ops_pc_id) then
      perform public.xpc_ensure_claim(new.ops_pc_id);
    elsif uid is not null then
      insert into public.audit_log (squadron_id, type, actor, detail)
      values (
        null,
        'xpc.snapshot.autoclaim_blocked',
        uid::text,
        jsonb_build_object(
          'column',      'ops_pc_id',
          'pc_id',       new.ops_pc_id,
          'squadron_id', new.squadron_id,
          'op',          tg_op
        )
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists xpc_snap_autoclaim_biu on public.xpc_squadron_snapshot;
create trigger xpc_snap_autoclaim_biu
before insert or update on public.xpc_squadron_snapshot
for each row execute function public.xpc_snap_autoclaim();

-- ─── 4. xpc_schedule — same defense-in-depth gating ────────────────────────
-- The xpc_schedule_autoclaim function from migration 0034/0035 also
-- blindly auto-claimed origin_squadron_id and current_pc_id. Tighten
-- it with the same can-claim gate. The schedule SELECT policy is still
-- exact-match (no logical-seat widening yet) so the privacy risk is
-- bounded — but consistency matters and the next widening migration
-- will inherit a safe baseline.
create or replace function public.xpc_schedule_autoclaim()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
begin
  if new.origin_squadron_id is not null and new.origin_squadron_id <> '' and new.origin_squadron_id <> 'self' then
    if public.xpc_can_claim_pc_id(new.origin_squadron_id) then
      perform public.xpc_ensure_claim(new.origin_squadron_id);
    elsif uid is not null then
      insert into public.audit_log (squadron_id, type, actor, detail)
      values (
        null,
        'xpc.schedule.autoclaim_blocked',
        uid::text,
        jsonb_build_object(
          'column',        'origin_squadron_id',
          'pc_id',         new.origin_squadron_id,
          'current_pc_id', new.current_pc_id,
          'share_id',      new.id,
          'op',            tg_op
        )
      );
    end if;
  end if;

  if new.current_pc_id is not null and new.current_pc_id <> '' and new.current_pc_id <> 'self' then
    if public.xpc_can_claim_pc_id(new.current_pc_id) then
      perform public.xpc_ensure_claim(new.current_pc_id);
    elsif uid is not null then
      insert into public.audit_log (squadron_id, type, actor, detail)
      values (
        null,
        'xpc.schedule.autoclaim_blocked',
        uid::text,
        jsonb_build_object(
          'column',             'current_pc_id',
          'pc_id',              new.current_pc_id,
          'origin_squadron_id', new.origin_squadron_id,
          'share_id',           new.id,
          'op',                 tg_op
        )
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists xpc_schedule_autoclaim_biu on public.xpc_schedule_shares;
create trigger xpc_schedule_autoclaim_biu
before insert or update on public.xpc_schedule_shares
for each row execute function public.xpc_schedule_autoclaim();

-- ─── 5. One-time backfill: purge silently-inserted bad claims ──────────────
-- Replicates `xpc_can_claim_pc_id` against `auth.users.raw_app_meta_data`
-- because migration context has no JWT. Anything that does NOT match
-- the user's server-issued pc_id (or, for legacy ops/squadron/deputy
-- accounts, the canonical squadron name derived from squadron_id) is
-- considered illegitimate and removed. Legitimate claims are
-- automatically re-established by `ensureMyPcClaim` on the next ~30s
-- heartbeat (or on the very next sign-in / send / decide).
--
-- We log the count first so audit_log carries a single roll-up entry
-- showing how many ghost claims this migration purged. Squadron_id is
-- left NULL because these claims are intentionally cross-tenant.
do $backfill$
declare
  purged_count integer;
begin
  with bad as (
    select upcs.user_id, upcs.pc_id
      from public.xpc_user_pcs upcs
      left join auth.users u on u.id = upcs.user_id
     where u.id is null  -- orphaned (user deleted) — drop
        or not (
          coalesce(u.raw_app_meta_data ->> 'pc_id', '') = upcs.pc_id
          or (
            (
              coalesce(u.raw_app_meta_data ->> 'role', '') = 'ops'
              or coalesce(u.raw_app_meta_data ->> 'tier', '') in ('ops','squadron','deputy')
            )
            and exists (
              select 1
                from public.squadrons s
               where s.id = nullif(u.raw_app_meta_data ->> 'squadron_id', '')::uuid
                 and s.name = upcs.pc_id
            )
          )
        )
  ),
  deleted as (
    delete from public.xpc_user_pcs upcs
     using bad
     where upcs.user_id = bad.user_id
       and upcs.pc_id   = bad.pc_id
    returning 1
  )
  select count(*) into purged_count from deleted;

  if purged_count > 0 then
    insert into public.audit_log (squadron_id, type, actor, detail)
    values (
      null,
      'xpc.user_pcs.backfill_purge',
      'migration-task-191',
      jsonb_build_object(
        'reason',  'task-191-autoclaim-no-recipient-grant',
        'removed', purged_count
      )
    );
  end if;
end;
$backfill$;

-- Reload PostgREST schema cache so the new trigger bodies and
-- audit_log entries become visible to the REST API immediately.
notify pgrst, 'reload schema';
