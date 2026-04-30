-- ============================================================================
-- Task #172 — receiver SELECT must honour logical-seat addressing
-- ============================================================================
--
-- WHY THIS EXISTS
-- ---------------
-- Audit D (2026-04-25) phase 3 caught an asymmetry on `xpc_messages`:
-- the wing PC inserted three rows addressed to the base PC, every INSERT
-- returned ok, but the base PC's immediate SELECT returned 0 rows. The
-- reverse direction (base reply → wing read) worked sub-second. The
-- focused repro (.local/scripts/repro-task-172-xpc-messages-receive.mjs)
-- confirmed the cause is NOT the dependency on `xpc_pair_links` floated
-- in the task brief — the existing SELECT policy never references
-- `xpc_pair_links` at all. The actual cause is that the policy uses
-- exact equality:
--
--   from_pc_id = any (xpc_my_pc_ids())  or  to_pc_id = any (xpc_my_pc_ids())
--
-- while the client-side picker (see `logicalSeatTargets` in
-- `artifacts/pilot-dashboard/src/pages/Messages.tsx`) and the matching
-- helper `makePcMatcher` in `artifacts/pilot-dashboard/src/lib/cross-pc.ts`
-- treat three id shapes as the SAME logical seat:
--
--   1. exact:        BASE:DEMO#bbbbbb            (the registered PC)
--   2. logical:      BASE:DEMO                   ("Any base in DEMO")
--   3. peer mirror:  Ops "<sqn>"  ↔  "SQDNCMD:<sqn>"
--
-- When the writer addresses by shape #2 (the picker option "Any Sqn
-- Cmdr in NO.X" / "Any base in DEMO") the receiver's exact-equality
-- SELECT misses entirely, so the inbox stays empty even though the row
-- is on the table. The client-side post-fetch matcher never gets a
-- chance because the row never crosses the wire. This migration fixes
-- the asymmetry by extending SELECT (and UPDATE / DELETE for symmetry)
-- to use a SQL port of `makePcMatcher`.
--
-- WHAT CHANGES
-- ------------
-- 1. New helper `xpc_pc_id_matches_mine(text) -> boolean` — direct port
--    of `makePcMatcher` semantics (exact / peer / logical-seat). Returns
--    true if any of the calling user's claimed pc_ids would have caught
--    the supplied pc_id under the client-side matcher.
-- 2. xpc_messages_select: SELECT policy USING re-expressed in terms of
--    the new helper for both `from_pc_id` and `to_pc_id`. The previous
--    exact-equality predicate was a strict subset of the new predicate,
--    so no message that was visible before becomes invisible.
-- 3. xpc_messages_update: USING widened the same way so a Sqn Cmdr who
--    claimed `SQDNCMD:NO.8#xyz` can still mark-read a message addressed
--    to the logical seat `SQDNCMD:NO.8`. WITH CHECK is preserved as
--    the relaxed authentication-only form from migration 0035.
-- 4. xpc_messages_delete: USING widened the same way so the per-call
--    auto-purge can sweep messages addressed to a logical seat the
--    caller owns.
--
-- WHAT DOES NOT CHANGE
-- --------------------
-- - INSERT WITH CHECK (auth-only, sentinel-guarded) is unchanged.
-- - The autoclaim trigger `xpc_messages_autoclaim` from migration 0035
--   continues to fire and is unchanged. (It claims the sender's seat at
--   write time so the very first send doesn't trip 42501 before the
--   heartbeat completes.)
-- - `xpc_pair_links` is NOT introduced into the SELECT path. The audit
--   brief's hypothesis that the receiver requires a live pair link was
--   refuted by the focused repro and is documented in
--   `.local/reports/audit-2026-04-25/D-cross-pc.md`.
--
-- IDEMPOTENCY
-- -----------
-- Every CREATE OR REPLACE / DROP POLICY IF EXISTS so re-running this
-- migration is a no-op.
-- ============================================================================

-- ─── 1. Helper function ──────────────────────────────────────────────────
--
-- Direct port of `makePcMatcher` in `artifacts/pilot-dashboard/src/lib/cross-pc.ts`.
-- Given a candidate pc_id (typically xpc_messages.to_pc_id or .from_pc_id),
-- return true iff one of the caller's claimed pc_ids would match it
-- under the three identity rules the client UI uses.
--
-- Marked STABLE so the planner can cache the result within a single
-- query. SECURITY DEFINER so the lookup against xpc_user_pcs sees all
-- of the caller's claim rows even when the calling role doesn't have
-- direct SELECT on xpc_user_pcs (the row-level policy on that table
-- already restricts users to their own rows, so the definer escalation
-- only widens the lookup, never the visibility of OTHER users' claims).
create or replace function public.xpc_pc_id_matches_mine(p_pc_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  my_id text;
  peer text;
  hash_idx int;
  my_seat text;
  other_seat text;
begin
  if p_pc_id is null or p_pc_id = '' then return false; end if;
  if auth.uid() is null then return false; end if;

  for my_id in
    select pc_id from public.xpc_user_pcs where user_id = auth.uid()
  loop
    -- Rule 1: exact equality (the original semantics).
    if my_id = p_pc_id then
      return true;
    end if;

    -- Rule 2: peer-squadron mirror — Ops "<sqn>" ↔ Sqn Cmdr "SQDNCMD:<sqn>".
    -- Mirrors the JS:
    --   peerSquadronId = forPcId.startsWith("SQDNCMD:")
    --     ? forPcId.slice("SQDNCMD:".length)
    --     : (!forPcId.includes(":") ? `SQDNCMD:${forPcId}` : null);
    if my_id like 'SQDNCMD:%' then
      peer := substring(my_id from 9);
    elsif position(':' in my_id) = 0 then
      peer := 'SQDNCMD:' || my_id;
    else
      peer := null;
    end if;
    if peer is not null and peer = p_pc_id then
      return true;
    end if;

    -- Rule 3: logical-seat strip — when MY id has a #suffix, compare the
    -- prefix against the candidate's prefix. Matches the JS branch:
    --   if (logicalSeat !== null) {
    --     const otherSeat = i < 0 ? id : id.slice(0, i);
    --     if (otherSeat === logicalSeat) return true;
    --   }
    hash_idx := position('#' in my_id);
    if hash_idx > 0 then
      my_seat := substring(my_id from 1 for hash_idx - 1);
      if position('#' in p_pc_id) > 0 then
        other_seat := substring(p_pc_id from 1 for position('#' in p_pc_id) - 1);
      else
        other_seat := p_pc_id;
      end if;
      if other_seat = my_seat then
        return true;
      end if;
    end if;
  end loop;

  return false;
end;
$$;

revoke all on function public.xpc_pc_id_matches_mine(text) from public;
grant execute on function public.xpc_pc_id_matches_mine(text) to authenticated;

-- ─── 2. xpc_messages_select — honour logical-seat semantics ──────────────
drop policy if exists xpc_messages_select on public.xpc_messages;
create policy xpc_messages_select on public.xpc_messages
  for select to authenticated
  using (
    public.xpc_pc_id_matches_mine(from_pc_id)
    or public.xpc_pc_id_matches_mine(to_pc_id)
  );

-- ─── 3. xpc_messages_update — same widening for mark-read / move-history ──
-- USING widened to the new matcher; WITH CHECK preserved as the relaxed
-- form from migration 0036 (any authenticated user; the trigger from
-- 0035 enforces the sender/recipient claim invariants at write time).
drop policy if exists xpc_messages_update on public.xpc_messages;
create policy xpc_messages_update on public.xpc_messages
  for update to authenticated
  using (
    public.xpc_pc_id_matches_mine(from_pc_id)
    or public.xpc_pc_id_matches_mine(to_pc_id)
  )
  with check (auth.uid() is not null);

-- ─── 4. xpc_messages_delete — same widening for the per-call auto-purge ──
-- The retention sweep (`purgeExpiredMessages` in cross-pc.ts) issues a
-- DELETE filtered by `sent_at < cutoff`, but only the rows the caller
-- legitimately owns are eligible under RLS. Without this widening, the
-- sweep silently leaves logical-seat-addressed messages behind forever,
-- defeating the retention policy.
drop policy if exists xpc_messages_delete on public.xpc_messages;
create policy xpc_messages_delete on public.xpc_messages
  for delete to authenticated
  using (
    public.xpc_pc_id_matches_mine(from_pc_id)
    or public.xpc_pc_id_matches_mine(to_pc_id)
  );

-- Reload PostgREST schema cache so the new policies and function become
-- callable via the REST API immediately. Convention from 0041 / 0044.
notify pgrst, 'reload schema';
