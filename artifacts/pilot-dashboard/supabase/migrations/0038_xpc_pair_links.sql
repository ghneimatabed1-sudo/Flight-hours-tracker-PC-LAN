-- 0038_xpc_pair_links.sql
--
-- Task #138 — PC Pairing (Phase 1).
--
-- Replaces implicit registry-heartbeat discovery with EXPLICIT, visible
-- pair links. Two surfaces both write here:
--   1. Self-service pairing-code handshake (between any two PCs).
--   2. Super-Admin Connection Map (god-mode page, single-click pair).
--
-- Three tables:
--   xpc_pair_codes — short-lived 6-digit handshake codes (TTL 5 min,
--                    single-use). Readable by any authenticated user;
--                    the code itself is the secret.
--   xpc_pair_links — the persistent pair record. Source of truth for
--                    every cross-PC picker / chain target / parent-pin.
--                    Visible to either side, OR to super_admin.
--   xpc_pair_audit — append-only ledger for create / revoke / reset_pc.
--                    Visible to super_admin only.
--
-- Server-side enforcement:
--   * A BEFORE INSERT/UPDATE trigger on xpc_pair_links calls
--     xpc_validate_pairing() and rejects any combination the matrix
--     forbids — so the matrix is enforced even if a malicious client
--     bypasses resolvePairKind() in pairs.ts.
--   * The redeem path is a SECURITY DEFINER RPC (xpc_redeem_pair_code)
--     that consumes the code AND inserts the link in one transaction;
--     the codes table's UPDATE policy is therefore restricted to
--     super_admin only (the redeem RPC bypasses RLS by design).
--   * xpc_pair_links_sweep checks xpc_is_super_admin() inside the
--     function body before mutating anything; non-admin callers get a
--     "not authorised" error even though execute is granted to all
--     authenticated callers (Supabase has no separate db role for
--     super_admin; the JWT app_metadata claim is the gate).
--
-- The 90-day inactivity sweep + the cross-squadron-ops time-bound
-- expiry are enforced by the `xpc_pair_links_sweep()` function below.
-- Operators trigger it via the Connection Map button, or a Supabase
-- pg_cron schedule can call it daily — both are safe and idempotent.

-- ── Tables ───────────────────────────────────────────────────────────

create table if not exists public.xpc_pair_codes (
  code            text primary key,
  host_pc_id      text not null,
  host_tier       text not null,
  host_squadron   text,
  host_user_id    uuid references auth.users(id) on delete cascade,
  host_user_display text,
  host_user_seat  text,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  consumed_at     timestamptz
);
create index if not exists xpc_pair_codes_host_idx
  on public.xpc_pair_codes (host_pc_id);
create index if not exists xpc_pair_codes_expires_idx
  on public.xpc_pair_codes (expires_at);

create table if not exists public.xpc_pair_links (
  a_pc_id           text not null,
  b_pc_id           text not null,
  a_tier            text not null,
  b_tier            text not null,
  a_squadron        text,
  b_squadron        text,
  a_user_display    text,
  b_user_display    text,
  a_user_seat       text,
  b_user_seat       text,
  kind              text not null
    check (kind in ('in_squadron','sqn_to_wing','wing_to_base',
                    'cross_squadron_ops','peer_flight','peer_sqn',
                    'peer_wing','peer_base')),
  paired_at         timestamptz not null default now(),
  paired_by_user_id uuid,
  paired_by_label   text,
  justification     text,
  expires_at        timestamptz,
  permanent         boolean not null default false,
  last_activity_at  timestamptz not null default now(),
  revoked_at        timestamptz,
  revoked_by_user_id uuid,
  revoked_reason    text,
  primary key (a_pc_id, b_pc_id),
  -- normalise the pair so (X,Y) and (Y,X) cannot both exist.
  constraint xpc_pair_links_canonical
    check (a_pc_id < b_pc_id)
);
create index if not exists xpc_pair_links_a_idx on public.xpc_pair_links (a_pc_id);
create index if not exists xpc_pair_links_b_idx on public.xpc_pair_links (b_pc_id);
create index if not exists xpc_pair_links_kind_idx on public.xpc_pair_links (kind);
create index if not exists xpc_pair_links_active_idx
  on public.xpc_pair_links (revoked_at) where revoked_at is null;

create table if not exists public.xpc_pair_audit (
  id              uuid primary key default gen_random_uuid(),
  action          text not null
    check (action in ('code_issued','code_consumed','code_expired',
                     'pair_created','pair_revoked','pair_extended',
                     'pc_reset','sweep_revoked','validation_rejected',
                     'registry_pruned')),
  target_pc_a     text,
  target_pc_b     text,
  by_user_id      uuid,
  by_user_label   text,
  kind            text,
  justification   text,
  detail          jsonb,
  at              timestamptz not null default now()
);
create index if not exists xpc_pair_audit_at_idx on public.xpc_pair_audit (at desc);
create index if not exists xpc_pair_audit_pc_idx on public.xpc_pair_audit (target_pc_a, target_pc_b);

-- ── Helpers ──────────────────────────────────────────────────────────
--
-- xpc_my_pc_ids() ALREADY EXISTS in 0010_cross_pc.sql with signature
-- `returns text[]`. Do NOT redefine it (PostgreSQL forbids changing
-- the return type on `create or replace`). Reference it via
-- `id = any(public.xpc_my_pc_ids())`.

-- xpc_is_super_admin() is new — read the JWT claim. Stable; safe to
-- use inside RLS predicates and triggers.
create or replace function public.xpc_is_super_admin()
returns boolean
language sql stable
as $$
  select coalesce(
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb
       -> 'app_metadata' ->> 'role') = 'super_admin',
    false
  );
$$;
grant execute on function public.xpc_is_super_admin() to authenticated;

-- Allowed-pairing matrix. The single source of truth: every code
-- redemption AND every super-admin admin-create routes through this.
-- Returns the resolved kind text, or NULL if the pairing is forbidden
-- without super-admin override.
--
-- Seats matter at squadron tier:
--   * Two squadron-tier PCs in the SAME squadron → in_squadron (Ops
--     ↔ Flight ↔ SqnCmdr peers within one squadron).
--   * Two squadron-tier PCs in DIFFERENT squadrons, both SqnCmdr seats,
--     with super-admin override → peer_sqn (commander-to-commander
--     channel). No expiry needed (peers stay paired permanently).
--   * Otherwise different-squadron at squadron tier requires
--     super-admin + justification + hard expiry → cross_squadron_ops.
-- Seat-string canonicaliser. UIs and integrations have written the
-- Sqn Cmdr seat as "Sqn Cmdr", "SqnCmdr", "sqncmdr", "SQN_CMDR" — all
-- of which mean the same thing. Strip every non-alphanumeric and
-- lowercase so the pairing matrix sees a single canonical form.
-- Example: 'Sqn Cmdr' -> 'sqncmdr', 'Flight Cmdr' -> 'flightcmdr'.
create or replace function public.xpc_canon_seat(p_seat text)
returns text
language sql immutable
as $$
  select case
    when p_seat is null then null
    else regexp_replace(lower(p_seat), '[^a-z0-9]', '', 'g')
  end;
$$;

-- Drop the prior 9-arg signature if a previous run of this migration
-- created it (adding a defaulted param creates a NEW overload rather
-- than replacing the old one, leaving stale logic callable).
drop function if exists public.xpc_validate_pairing(
  text, text, text, text, text, text, boolean, text, timestamptz);

create or replace function public.xpc_validate_pairing(
  p_a_tier text, p_b_tier text,
  p_a_squadron text, p_b_squadron text,
  p_a_seat text, p_b_seat text,
  p_super_admin boolean,
  p_justification text,
  p_expires_at timestamptz,
  p_kind_hint text default null
) returns text
language plpgsql immutable
as $$
declare
  ta text := p_a_tier;
  tb text := p_b_tier;
  same_sqn boolean := p_a_squadron is not null
                  and p_b_squadron is not null
                  and lower(p_a_squadron) = lower(p_b_squadron);
  ca_seat text := public.xpc_canon_seat(p_a_seat);
  cb_seat text := public.xpc_canon_seat(p_b_seat);
  both_cmdr boolean := ca_seat = 'sqncmdr' and cb_seat = 'sqncmdr';
begin
  -- Symmetric — order does not matter for kind selection.
  if ta = tb then
    case ta
      when 'flight' then return 'peer_flight';
      when 'squadron' then
        if same_sqn then return 'in_squadron'; end if;
        -- peer_sqn (commander↔commander): only when seats canonicalise
        -- to SqnCmdr↔SqnCmdr OR the super-admin EXPLICITLY hints
        -- 'peer_sqn' from the Connection Map (where registry rows
        -- don't carry seat metadata). Without an explicit hint, the
        -- fallback must be cross_squadron_ops (justification+expiry).
        if p_super_admin and (
             both_cmdr
             or p_kind_hint = 'peer_sqn'
           ) then
          return 'peer_sqn';
        end if;
        if p_super_admin
           and p_justification is not null and length(p_justification) >= 8
           and p_expires_at is not null then
          return 'cross_squadron_ops';
        end if;
        return null;
      when 'wing' then return 'peer_wing';
      when 'base' then
        if p_super_admin then return 'peer_base'; end if;
        return null;
      else return null;
    end case;
  end if;

  if (ta = 'flight' and tb = 'squadron') or (ta = 'squadron' and tb = 'flight')
    then return 'in_squadron'; end if;
  if (ta = 'squadron' and tb = 'wing')   or (ta = 'wing' and tb = 'squadron')
    then return 'sqn_to_wing'; end if;
  if (ta = 'wing' and tb = 'base')       or (ta = 'base' and tb = 'wing')
    then return 'wing_to_base'; end if;

  return null;
end;
$$;

-- Trigger: enforce the matrix on every INSERT/UPDATE. Refuses the
-- write if validate_pairing returns NULL, OR if the row's `kind`
-- disagrees with the matrix's verdict (defence-in-depth — a hostile
-- client cannot pick its own kind text and bypass the matrix).
create or replace function public.xpc_pair_links_enforce()
returns trigger
language plpgsql
as $$
declare
  resolved text;
begin
  -- Pass new.kind in as p_kind_hint so a row written by an admin RPC
  -- with explicit peer_sqn intent survives re-validation here. The
  -- matrix only honours the hint when ALL other gates pass (super-admin
  -- + same-tier squadron + different squadron) so this is not an
  -- escape hatch — it just tells validate_pairing the operator's
  -- intent when seat metadata isn't on the row.
  resolved := public.xpc_validate_pairing(
    new.a_tier, new.b_tier,
    new.a_squadron, new.b_squadron,
    new.a_user_seat, new.b_user_seat,
    public.xpc_is_super_admin(),
    new.justification,
    new.expires_at,
    new.kind
  );
  if resolved is null then
    insert into public.xpc_pair_audit (action, target_pc_a, target_pc_b, kind, detail)
      values ('validation_rejected', new.a_pc_id, new.b_pc_id, new.kind,
              jsonb_build_object('reason','matrix_forbidden',
                                 'a_tier', new.a_tier, 'b_tier', new.b_tier));
    raise exception 'pairing forbidden by matrix (a_tier=%, b_tier=%)', new.a_tier, new.b_tier
      using errcode = '42501';
  end if;
  if new.kind <> resolved then
    raise exception 'pair kind % does not match matrix verdict %', new.kind, resolved
      using errcode = '42501';
  end if;
  if resolved = 'cross_squadron_ops' and not public.xpc_is_super_admin() then
    raise exception 'cross_squadron_ops links require super_admin'
      using errcode = '42501';
  end if;
  if resolved = 'peer_base' and not public.xpc_is_super_admin() then
    raise exception 'peer_base links require super_admin'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists xpc_pair_links_enforce_trg on public.xpc_pair_links;
create trigger xpc_pair_links_enforce_trg
  before insert or update on public.xpc_pair_links
  for each row execute function public.xpc_pair_links_enforce();

-- ── RLS ──────────────────────────────────────────────────────────────

alter table public.xpc_pair_codes enable row level security;
alter table public.xpc_pair_links enable row level security;
alter table public.xpc_pair_audit enable row level security;

-- xpc_pair_codes: any authenticated user can SELECT (the 6-digit code
-- IS the secret; brute-forcing 1,000,000 codes against the 5-minute
-- window is rate-limited at the edge). INSERT requires the inserter
-- to own the host_pc_id (so a malicious account cannot mint codes for
-- a PC they do not control). UPDATE is super_admin only — the redeem
-- path is the SECURITY DEFINER RPC `xpc_redeem_pair_code` below,
-- which bypasses RLS by design. DELETE allowed by host owner OR
-- super_admin (cancel-in-flight from the Connection Map).
drop policy if exists xpc_pair_codes_select on public.xpc_pair_codes;
create policy xpc_pair_codes_select on public.xpc_pair_codes
  for select to authenticated using (true);

drop policy if exists xpc_pair_codes_insert on public.xpc_pair_codes;
create policy xpc_pair_codes_insert on public.xpc_pair_codes
  for insert to authenticated with check (
    public.xpc_is_super_admin()
    or host_pc_id = any(public.xpc_my_pc_ids())
  );

drop policy if exists xpc_pair_codes_update on public.xpc_pair_codes;
create policy xpc_pair_codes_update on public.xpc_pair_codes
  for update to authenticated using (public.xpc_is_super_admin())
                              with check (public.xpc_is_super_admin());

drop policy if exists xpc_pair_codes_delete on public.xpc_pair_codes;
create policy xpc_pair_codes_delete on public.xpc_pair_codes
  for delete to authenticated using (
    public.xpc_is_super_admin()
    or host_pc_id = any(public.xpc_my_pc_ids())
  );

-- xpc_pair_links: visible when caller owns either side, OR super_admin.
-- INSERT must include a side the caller owns OR super_admin override.
-- UPDATE / DELETE same gate (revoke is an UPDATE setting revoked_at).
-- The matrix trigger above enforces validity regardless of these
-- predicates — RLS is the second line of defence, not the first.
drop policy if exists xpc_pair_links_select on public.xpc_pair_links;
create policy xpc_pair_links_select on public.xpc_pair_links
  for select to authenticated using (
    public.xpc_is_super_admin()
    or a_pc_id = any(public.xpc_my_pc_ids())
    or b_pc_id = any(public.xpc_my_pc_ids())
  );

-- WRITE policies are super_admin only. All non-admin writes must go
-- through the SECURITY DEFINER RPCs below (xpc_redeem_pair_code for
-- self-service create, xpc_revoke_my_pair for participant revoke).
-- This prevents an authenticated client from minting / mutating /
-- deleting pair rows directly via the REST API.
drop policy if exists xpc_pair_links_insert on public.xpc_pair_links;
create policy xpc_pair_links_insert on public.xpc_pair_links
  for insert to authenticated with check (public.xpc_is_super_admin());

drop policy if exists xpc_pair_links_update on public.xpc_pair_links;
create policy xpc_pair_links_update on public.xpc_pair_links
  for update to authenticated using (public.xpc_is_super_admin())
                              with check (public.xpc_is_super_admin());

drop policy if exists xpc_pair_links_delete on public.xpc_pair_links;
create policy xpc_pair_links_delete on public.xpc_pair_links
  for delete to authenticated using (public.xpc_is_super_admin());

-- xpc_pair_audit: super_admin only for SELECT. Direct INSERT is
-- DENIED for everyone — only the SECURITY DEFINER trigger /
-- xpc_redeem_pair_code / xpc_admin_* RPCs write here, and DEFINER
-- bypasses RLS. This keeps the audit trail trustworthy: an
-- authenticated actor cannot forge synthetic audit rows.
drop policy if exists xpc_pair_audit_select on public.xpc_pair_audit;
create policy xpc_pair_audit_select on public.xpc_pair_audit
  for select to authenticated using (public.xpc_is_super_admin());

drop policy if exists xpc_pair_audit_insert on public.xpc_pair_audit;
-- (no insert policy → no INSERT permitted for the `authenticated` role
-- via PostgREST. Trusted SECURITY DEFINER functions write directly.)

-- ── Redeem RPC (SECURITY DEFINER atomic consume + insert) ────────────
--
-- The pair-codes table's UPDATE policy locks non-admins out, so the
-- joiner cannot mark a code consumed via direct SQL. This RPC is the
-- only legal redemption path. It:
--   1. Looks up the code (must be unconsumed + unexpired).
--   2. Validates the joiner owns its claimed pcId.
--   3. Resolves the kind via xpc_validate_pairing (super_admin=false).
--   4. UPSERTs the link in canonical (a < b) order — the matrix
--      trigger above re-validates as defence-in-depth.
--   5. Marks the code consumed.
-- Returns the resolved (a_pc_id, b_pc_id) tuple so the client can
-- reload its pair list without a second round trip.
create or replace function public.xpc_redeem_pair_code(
  p_code text,
  p_joiner_pc_id text,
  p_joiner_tier text,
  p_joiner_squadron text,
  p_joiner_user_display text,
  p_joiner_user_seat text
) returns table(a_pc_id text, b_pc_id text, kind text)
language plpgsql security definer set search_path = public
as $$
declare
  v_code public.xpc_pair_codes%rowtype;
  v_kind text;
  v_a text; v_b text;
  v_a_tier text; v_b_tier text;
  v_a_sq text; v_b_sq text;
  v_a_disp text; v_b_disp text;
  v_a_seat text; v_b_seat text;
begin
  -- Auth required.
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  -- Joiner must actually own the PC id it claims.
  if p_joiner_pc_id is null
     or not (p_joiner_pc_id = any(public.xpc_my_pc_ids())) then
    raise exception 'joiner does not own pc_id %', p_joiner_pc_id
      using errcode = '42501';
  end if;

  select * into v_code
    from public.xpc_pair_codes
   where code = p_code
   for update;
  if not found then
    raise exception 'code not found' using errcode = 'P0002';
  end if;
  if v_code.consumed_at is not null then
    raise exception 'code already used' using errcode = '22023';
  end if;
  if v_code.expires_at < now() then
    raise exception 'code expired' using errcode = '22023';
  end if;
  if v_code.host_pc_id = p_joiner_pc_id then
    raise exception 'host and joiner are the same PC' using errcode = '22023';
  end if;

  v_kind := public.xpc_validate_pairing(
    v_code.host_tier, p_joiner_tier,
    v_code.host_squadron, p_joiner_squadron,
    v_code.host_user_seat, p_joiner_user_seat,
    false, null, null
  );
  if v_kind is null then
    insert into public.xpc_pair_audit (action, target_pc_a, target_pc_b, by_user_id, detail)
      values ('validation_rejected', v_code.host_pc_id, p_joiner_pc_id, auth.uid(),
              jsonb_build_object('reason','matrix_forbidden_self_service',
                                 'host_tier', v_code.host_tier,
                                 'joiner_tier', p_joiner_tier));
    raise exception 'self-service pair forbidden by matrix (host=%, joiner=%)',
      v_code.host_tier, p_joiner_tier
      using errcode = '42501';
  end if;

  -- Canonical (a < b) ordering.
  if v_code.host_pc_id < p_joiner_pc_id then
    v_a := v_code.host_pc_id; v_b := p_joiner_pc_id;
    v_a_tier := v_code.host_tier; v_b_tier := p_joiner_tier;
    v_a_sq := v_code.host_squadron; v_b_sq := p_joiner_squadron;
    v_a_disp := v_code.host_user_display; v_b_disp := p_joiner_user_display;
    v_a_seat := v_code.host_user_seat; v_b_seat := p_joiner_user_seat;
  else
    v_a := p_joiner_pc_id; v_b := v_code.host_pc_id;
    v_a_tier := p_joiner_tier; v_b_tier := v_code.host_tier;
    v_a_sq := p_joiner_squadron; v_b_sq := v_code.host_squadron;
    v_a_disp := p_joiner_user_display; v_b_disp := v_code.host_user_display;
    v_a_seat := p_joiner_user_seat; v_b_seat := v_code.host_user_seat;
  end if;

  insert into public.xpc_pair_links
    (a_pc_id, b_pc_id, a_tier, b_tier, a_squadron, b_squadron,
     a_user_display, b_user_display, a_user_seat, b_user_seat,
     kind, paired_by_user_id, paired_by_label, revoked_at, revoked_reason)
  values
    (v_a, v_b, v_a_tier, v_b_tier, v_a_sq, v_b_sq,
     v_a_disp, v_b_disp, v_a_seat, v_b_seat,
     v_kind, auth.uid(), p_joiner_user_display, null, null)
  on conflict (a_pc_id, b_pc_id) do update
    set kind = excluded.kind,
        a_tier = excluded.a_tier, b_tier = excluded.b_tier,
        a_squadron = excluded.a_squadron, b_squadron = excluded.b_squadron,
        a_user_display = excluded.a_user_display, b_user_display = excluded.b_user_display,
        a_user_seat = excluded.a_user_seat, b_user_seat = excluded.b_user_seat,
        paired_at = now(),
        paired_by_user_id = excluded.paired_by_user_id,
        paired_by_label = excluded.paired_by_label,
        revoked_at = null, revoked_reason = null,
        last_activity_at = now();

  update public.xpc_pair_codes
     set consumed_at = now()
   where code = p_code;

  insert into public.xpc_pair_audit (action, target_pc_a, target_pc_b, by_user_id, kind, detail)
    values ('pair_created', v_a, v_b, auth.uid(), v_kind,
            jsonb_build_object('via','code','code', p_code));

  -- Auto-stamp side effects so the handshake completes the routing
  -- setup operators expect:
  --   * in_squadron flight↔ops  → flight PC's squadron_pc_id := ops PC
  --   * sqn_to_wing             → squadron PC's parent_pc_id := wing PC
  --   * wing_to_base            → wing PC's parent_pc_id := base PC
  -- All three are conditional updates — operators may have already
  -- pinned a parent / squadron host, in which case we leave it alone
  -- (no overwriting of existing structure).
  if v_kind = 'in_squadron' then
    -- The flight-tier side gets squadron_pc_id pointing at the
    -- squadron-tier (Ops) side. Walks both orderings.
    update public.xpc_registry r
       set squadron_pc_id = case
             when (select tier from public.xpc_registry where id = v_a) = 'flight'
             then v_b else v_a end
     where id = case
             when (select tier from public.xpc_registry where id = v_a) = 'flight'
             then v_a else v_b end
       and squadron_pc_id is null;
  elsif v_kind = 'sqn_to_wing' then
    update public.xpc_registry r
       set parent_pc_id = case
             when (select tier from public.xpc_registry where id = v_a) = 'squadron'
             then v_b else v_a end
     where id = case
             when (select tier from public.xpc_registry where id = v_a) = 'squadron'
             then v_a else v_b end
       and parent_pc_id is null;
  elsif v_kind = 'wing_to_base' then
    update public.xpc_registry r
       set parent_pc_id = case
             when (select tier from public.xpc_registry where id = v_a) = 'wing'
             then v_b else v_a end
     where id = case
             when (select tier from public.xpc_registry where id = v_a) = 'wing'
             then v_a else v_b end
       and parent_pc_id is null;
  end if;

  return query select v_a, v_b, v_kind;
end;
$$;

revoke all on function public.xpc_redeem_pair_code(text,text,text,text,text,text) from public;
grant execute on function public.xpc_redeem_pair_code(text,text,text,text,text,text) to authenticated;

-- ── Admin write RPCs (SECURITY DEFINER, super_admin gated) ───────────
--
-- These are the only write paths a non-self-service caller has. RLS
-- on xpc_pair_links is locked to super_admin-direct, which means the
-- Connection Map's "create pair" / "revoke pair" / "set permanent"
-- buttons MUST go through these functions. Each one performs its own
-- super_admin gate (so DEFINER privileges don't leak to the public).
-- Drop the prior 13-arg signature for the same overload reason as
-- xpc_validate_pairing above.
drop function if exists public.xpc_admin_create_pair(
  text, text, text, text, text, text, text, text, text, text,
  text, timestamptz, boolean);

create or replace function public.xpc_admin_create_pair(
  p_a_pc_id text, p_b_pc_id text,
  p_a_tier text, p_b_tier text,
  p_a_squadron text, p_b_squadron text,
  p_a_seat text, p_b_seat text,
  p_a_user_display text, p_b_user_display text,
  p_justification text default null,
  p_expires_at timestamptz default null,
  p_permanent boolean default false,
  p_kind_hint text default null
) returns table(a_pc_id text, b_pc_id text, kind text)
language plpgsql security definer set search_path = public
as $$
declare
  v_kind text;
  ca text; cb text;
  cat text; cbt text;
  cas text; cbs text;
  cas_seat text; cbs_seat text;
  cad text; cbd text;
begin
  if not public.xpc_is_super_admin() then
    raise exception 'admin-create requires super_admin' using errcode = '42501';
  end if;
  if p_a_pc_id is null or p_b_pc_id is null or p_a_pc_id = p_b_pc_id then
    raise exception 'invalid pc ids' using errcode = '22023';
  end if;
  v_kind := public.xpc_validate_pairing(
    p_a_tier, p_b_tier, p_a_squadron, p_b_squadron,
    p_a_seat, p_b_seat, true, p_justification, p_expires_at, p_kind_hint
  );
  if v_kind is null then
    raise exception 'admin-create rejected by matrix' using errcode = '42501';
  end if;
  if p_a_pc_id < p_b_pc_id then
    ca := p_a_pc_id; cb := p_b_pc_id;
    cat := p_a_tier; cbt := p_b_tier;
    cas := p_a_squadron; cbs := p_b_squadron;
    cas_seat := p_a_seat; cbs_seat := p_b_seat;
    cad := p_a_user_display; cbd := p_b_user_display;
  else
    ca := p_b_pc_id; cb := p_a_pc_id;
    cat := p_b_tier; cbt := p_a_tier;
    cas := p_b_squadron; cbs := p_a_squadron;
    cas_seat := p_b_seat; cbs_seat := p_a_seat;
    cad := p_b_user_display; cbd := p_a_user_display;
  end if;
  insert into public.xpc_pair_links
    (a_pc_id, b_pc_id, a_tier, b_tier, a_squadron, b_squadron,
     a_user_seat, b_user_seat, a_user_display, b_user_display,
     kind, paired_by_user_id, paired_by_label,
     justification, expires_at, permanent,
     revoked_at, revoked_reason)
  values
    (ca, cb, cat, cbt, cas, cbs, cas_seat, cbs_seat, cad, cbd,
     v_kind, auth.uid(), 'super_admin',
     p_justification, p_expires_at, coalesce(p_permanent, false),
     null, null)
  on conflict (a_pc_id, b_pc_id) do update
    set kind = excluded.kind,
        a_tier = excluded.a_tier, b_tier = excluded.b_tier,
        a_squadron = excluded.a_squadron, b_squadron = excluded.b_squadron,
        a_user_seat = excluded.a_user_seat, b_user_seat = excluded.b_user_seat,
        a_user_display = excluded.a_user_display, b_user_display = excluded.b_user_display,
        paired_at = now(),
        paired_by_user_id = excluded.paired_by_user_id,
        paired_by_label = 'super_admin',
        justification = excluded.justification,
        expires_at = excluded.expires_at,
        permanent = excluded.permanent,
        revoked_at = null, revoked_reason = null,
        last_activity_at = now();
  insert into public.xpc_pair_audit (action, target_pc_a, target_pc_b, by_user_id, kind, justification, detail)
    values ('pair_created', ca, cb, auth.uid(), v_kind, p_justification,
            jsonb_build_object('via','admin','permanent', coalesce(p_permanent, false),
                               'expires_at', p_expires_at));

  -- Same auto-stamp side effects as xpc_redeem_pair_code (see comment
  -- there). Conditional on the existing parent/squadron host being
  -- NULL so we never overwrite a deliberate operator decision.
  if v_kind = 'in_squadron' then
    update public.xpc_registry
       set squadron_pc_id = case when (select tier from public.xpc_registry where id = ca) = 'flight' then cb else ca end
     where id = case when (select tier from public.xpc_registry where id = ca) = 'flight' then ca else cb end
       and squadron_pc_id is null;
  elsif v_kind = 'sqn_to_wing' then
    update public.xpc_registry
       set parent_pc_id = case when (select tier from public.xpc_registry where id = ca) = 'squadron' then cb else ca end
     where id = case when (select tier from public.xpc_registry where id = ca) = 'squadron' then ca else cb end
       and parent_pc_id is null;
  elsif v_kind = 'wing_to_base' then
    update public.xpc_registry
       set parent_pc_id = case when (select tier from public.xpc_registry where id = ca) = 'wing' then cb else ca end
     where id = case when (select tier from public.xpc_registry where id = ca) = 'wing' then ca else cb end
       and parent_pc_id is null;
  end if;

  return query select ca, cb, v_kind;
end;
$$;
revoke all on function public.xpc_admin_create_pair(text,text,text,text,text,text,text,text,text,text,text,timestamptz,boolean,text) from public;
grant execute on function public.xpc_admin_create_pair(text,text,text,text,text,text,text,text,text,text,text,timestamptz,boolean,text) to authenticated;

-- xpc_admin_set_permanent: super_admin toggles the permanent flag.
create or replace function public.xpc_admin_set_permanent(
  p_a_pc_id text, p_b_pc_id text, p_permanent boolean
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.xpc_is_super_admin() then
    raise exception 'requires super_admin' using errcode = '42501';
  end if;
  update public.xpc_pair_links
     set permanent = coalesce(p_permanent, false),
         last_activity_at = now()
   where a_pc_id = p_a_pc_id and b_pc_id = p_b_pc_id;
  insert into public.xpc_pair_audit (action, target_pc_a, target_pc_b, by_user_id, detail)
    values ('pair_extended', p_a_pc_id, p_b_pc_id, auth.uid(),
            jsonb_build_object('permanent', coalesce(p_permanent, false)));
end;
$$;
revoke all on function public.xpc_admin_set_permanent(text,text,boolean) from public;
grant execute on function public.xpc_admin_set_permanent(text,text,boolean) to authenticated;

-- xpc_admin_revoke_pair: super_admin force-revoke any pair.
create or replace function public.xpc_admin_revoke_pair(
  p_a_pc_id text, p_b_pc_id text, p_reason text
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.xpc_is_super_admin() then
    raise exception 'requires super_admin' using errcode = '42501';
  end if;
  update public.xpc_pair_links
     set revoked_at = now(),
         revoked_by_user_id = auth.uid(),
         revoked_reason = coalesce(nullif(p_reason,''), 'super_admin revoke')
   where a_pc_id = p_a_pc_id and b_pc_id = p_b_pc_id
     and revoked_at is null;
  insert into public.xpc_pair_audit (action, target_pc_a, target_pc_b, by_user_id, justification)
    values ('pair_revoked', p_a_pc_id, p_b_pc_id, auth.uid(),
            coalesce(nullif(p_reason,''), 'super_admin revoke'));
end;
$$;
revoke all on function public.xpc_admin_revoke_pair(text,text,text) from public;
grant execute on function public.xpc_admin_revoke_pair(text,text,text) to authenticated;

-- xpc_revoke_my_pair: a participant withdraws consent for one of
-- THEIR OWN pairs. Verifies the caller owns either side. Cannot
-- mutate `permanent` or `expires_at` — only sets revoked_at.
create or replace function public.xpc_revoke_my_pair(
  p_a_pc_id text, p_b_pc_id text, p_reason text default null
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_owner boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select (p_a_pc_id = any(public.xpc_my_pc_ids())
       or p_b_pc_id = any(public.xpc_my_pc_ids()))
    into v_owner;
  if not v_owner and not public.xpc_is_super_admin() then
    raise exception 'caller does not own either side of this pair' using errcode = '42501';
  end if;
  update public.xpc_pair_links
     set revoked_at = now(),
         revoked_by_user_id = auth.uid(),
         revoked_reason = coalesce(nullif(p_reason,''), 'participant revoke')
   where a_pc_id = p_a_pc_id and b_pc_id = p_b_pc_id
     and revoked_at is null;
  insert into public.xpc_pair_audit (action, target_pc_a, target_pc_b, by_user_id, justification)
    values ('pair_revoked', p_a_pc_id, p_b_pc_id, auth.uid(),
            coalesce(nullif(p_reason,''), 'participant revoke'));
end;
$$;
revoke all on function public.xpc_revoke_my_pair(text,text,text) from public;
grant execute on function public.xpc_revoke_my_pair(text,text,text) to authenticated;

-- xpc_admin_reset_pc: super_admin one-shot reset of a registered PC.
-- Atomically: revokes every active pair the PC participates in,
-- deletes the registry row, deletes any user-pc claims, and writes a
-- single pc_reset audit row. All-or-nothing — on any error the whole
-- transaction rolls back, so reset can never silently half-succeed.
create or replace function public.xpc_admin_reset_pc(p_pc_id text, p_reason text default null)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_revoked int := 0;
begin
  if not public.xpc_is_super_admin() then
    raise exception 'reset requires super_admin' using errcode = '42501';
  end if;
  if p_pc_id is null or length(p_pc_id) = 0 then
    raise exception 'pc id required' using errcode = '22023';
  end if;
  with rev as (
    update public.xpc_pair_links
       set revoked_at = now(),
           revoked_by_user_id = auth.uid(),
           revoked_reason = coalesce(nullif(p_reason,''), 'auto: PC reset by super-admin')
     where revoked_at is null
       and (a_pc_id = p_pc_id or b_pc_id = p_pc_id)
     returning 1
  ) select count(*) into v_revoked from rev;

  delete from public.xpc_registry where id = p_pc_id;
  delete from public.xpc_user_pcs where pc_id = p_pc_id;

  insert into public.xpc_pair_audit (action, target_pc_a, by_user_id, justification, detail)
    values ('pc_reset', p_pc_id, auth.uid(),
            coalesce(nullif(p_reason,''), 'super_admin reset'),
            jsonb_build_object('revokedPairCount', v_revoked));
  return v_revoked;
end;
$$;
revoke all on function public.xpc_admin_reset_pc(text,text) from public;
grant execute on function public.xpc_admin_reset_pc(text,text) to authenticated;

-- xpc_admin_bulk_pair_in_squadron: super_admin one-shot — for every
-- (Ops PC ↔ Flight PC) sharing a squadron name, ensure an active
-- in_squadron pair link exists. Idempotent (ON CONFLICT DO NOTHING +
-- revoked_at NULL filter). Returns count of newly-created pairs.
-- Powers the Connection Map "Pair every Flight PC with its Ops PC"
-- bulk button so a fresh deployment is operational in one click.
create or replace function public.xpc_admin_bulk_pair_in_squadron()
returns int
language plpgsql security definer set search_path = public
as $$
declare
  ops record;
  peer record;
  ca text; cb text;
  cat text; cbt text;
  cas text; cbs text;
  cad text; cbd text;
  cas_seat text; cbs_seat text;
  k text;
  v_created int := 0;
begin
  if not public.xpc_is_super_admin() then
    raise exception 'requires super_admin' using errcode = '42501';
  end if;
  for ops in
    select id, squadron_name, tier from public.xpc_registry
     where tier = 'squadron'
  loop
    for peer in
      select id, squadron_name, tier from public.xpc_registry
       where id <> ops.id
         and tier = 'flight'
         and squadron_name = ops.squadron_name
    loop
      if ops.id < peer.id then
        ca := ops.id; cb := peer.id;
        cat := ops.tier; cbt := peer.tier;
        cas := ops.squadron_name; cbs := peer.squadron_name;
      else
        ca := peer.id; cb := ops.id;
        cat := peer.tier; cbt := ops.tier;
        cas := peer.squadron_name; cbs := ops.squadron_name;
      end if;
      cas_seat := null; cbs_seat := null; cad := null; cbd := null;
      k := public.xpc_validate_pairing(cat, cbt, cas, cbs, cas_seat, cbs_seat, true, null, null);
      if k is null then continue; end if;
      insert into public.xpc_pair_links
        (a_pc_id, b_pc_id, a_tier, b_tier, a_squadron, b_squadron,
         kind, paired_by_user_id, paired_by_label)
      values
        (ca, cb, cat, cbt, cas, cbs, k, auth.uid(), 'bulk: in_squadron')
      on conflict (a_pc_id, b_pc_id) do nothing;
      if found then
        v_created := v_created + 1;
        insert into public.xpc_pair_audit (action, target_pc_a, target_pc_b, by_user_id, kind, detail)
          values ('pair_created', ca, cb, auth.uid(), k,
                  jsonb_build_object('via','bulk_in_squadron'));
      end if;
    end loop;
  end loop;
  return v_created;
end;
$$;
revoke all on function public.xpc_admin_bulk_pair_in_squadron() from public;
grant execute on function public.xpc_admin_bulk_pair_in_squadron() to authenticated;

-- ── Maintenance: 90-day sweep + expiry sweep ─────────────────────────
--
-- Idempotent. Safe to call from a Supabase pg_cron job or manually
-- from the Connection Map. SUPER ADMIN ONLY — checked at the top of
-- the function body. Returns the count of links it revoked / expired.
create or replace function public.xpc_pair_links_sweep(
  p_inactive_days int default 90
) returns table(revoked_count int, expired_count int)
language plpgsql security definer set search_path = public
as $$
declare
  v_revoked int := 0;
  v_expired int := 0;
begin
  -- Authority: the JWT app_metadata.role MUST be super_admin to mutate
  -- the registry-wide pair table. (NOTE: we cannot use `current_user`
  -- as a fallback here because SECURITY DEFINER makes current_user the
  -- function owner, which would let any caller through. Scheduled
  -- pg_cron jobs are deferred to follow-up #139 and will get a
  -- dedicated `xpc_pair_links_sweep_internal()` callable only by the
  -- service role, separate from this interactive entry point.)
  if not public.xpc_is_super_admin() then
    raise exception 'sweep is super_admin only' using errcode = '42501';
  end if;

  -- 1. time-bound expiries (cross_squadron_ops, etc.)
  with rev as (
    update public.xpc_pair_links
       set revoked_at = now(),
           revoked_reason = 'auto: time-bound expiry'
     where revoked_at is null
       and expires_at is not null
       and expires_at < now()
       and not permanent
     returning a_pc_id, b_pc_id, kind
  )
  insert into public.xpc_pair_audit (action, target_pc_a, target_pc_b, kind, justification)
    select 'sweep_revoked', a_pc_id, b_pc_id, kind, 'time-bound expiry' from rev;
  get diagnostics v_expired = row_count;

  -- 2. inactivity sweep — `permanent` checkbox bypasses this.
  with rev as (
    update public.xpc_pair_links
       set revoked_at = now(),
           revoked_reason = format('auto: no activity in %s days', p_inactive_days)
     where revoked_at is null
       and not permanent
       and last_activity_at < now() - make_interval(days => p_inactive_days)
     returning a_pc_id, b_pc_id, kind
  )
  insert into public.xpc_pair_audit (action, target_pc_a, target_pc_b, kind, justification)
    select 'sweep_revoked', a_pc_id, b_pc_id, kind,
           format('inactive %s days', p_inactive_days) from rev;
  get diagnostics v_revoked = row_count;

  -- 3. expired one-shot codes (housekeeping; not security-critical).
  delete from public.xpc_pair_codes where expires_at < now() - interval '1 hour';

  -- 4. registry pruning — PCs whose `last_seen` heartbeat is older
  -- than the same inactivity window are clearly retired hardware.
  -- Drop the registry row, its claim row, and audit each prune so the
  -- Connection Map's history tab tells the operator why a PC vanished.
  -- We do NOT need to touch xpc_pair_links here — those rows were
  -- already revoked by step 2 above (heartbeat tick is what bumps
  -- last_activity_at, so a PC that hasn't heartbeat'd in 90 days has,
  -- by definition, also failed step 2's inactivity check).
  declare
    pruned_id text;
  begin
    for pruned_id in
      select id from public.xpc_registry
       where last_seen is not null
         and last_seen < now() - make_interval(days => p_inactive_days)
    loop
      delete from public.xpc_user_pcs where pc_id = pruned_id;
      delete from public.xpc_registry where id = pruned_id;
      insert into public.xpc_pair_audit (action, target_pc_a, kind, justification)
        values ('registry_pruned', pruned_id, null,
                format('no heartbeat in %s days', p_inactive_days));
    end loop;
  end;

  return query select v_revoked, v_expired;
end;
$$;

revoke all on function public.xpc_pair_links_sweep(int) from public;
grant execute on function public.xpc_pair_links_sweep(int) to authenticated;

-- Bump last_activity_at when EITHER side heartbeats. Cheap and safe
-- to call frequently — no audit row, just a timestamp write. Caller
-- must own the pc_id (checked inside) — prevents activity-spoofing.
create or replace function public.xpc_pair_touch(p_pc_id text)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v int;
begin
  if not (p_pc_id = any(public.xpc_my_pc_ids())) and not public.xpc_is_super_admin() then
    raise exception 'cannot touch pairs for pc_id you do not own' using errcode = '42501';
  end if;
  update public.xpc_pair_links
     set last_activity_at = now()
   where revoked_at is null
     and (a_pc_id = p_pc_id or b_pc_id = p_pc_id);
  get diagnostics v = row_count;
  return v;
end;
$$;

revoke all on function public.xpc_pair_touch(text) from public;
grant execute on function public.xpc_pair_touch(text) to authenticated;

-- ── One-shot backfill from existing data ─────────────────────────────
--
-- Walks xpc_registry to seed in_squadron pair links between every
-- Ops PC and every Flight/SqnCmdr PC sharing the same squadron name.
-- Idempotent: ON CONFLICT DO NOTHING. Skips rows already present
-- (so re-running this migration is a no-op). Bypasses the trigger by
-- temporarily disabling it inside the block — backfill is trusted.
do $$
declare
  ops record;
  peer record;
  ca text; cb text;
  cat text; cbt text;
  cas text; cbs text;
  k text;
begin
  if not exists (select 1 from information_schema.tables
                   where table_schema = 'public' and table_name = 'xpc_registry') then
    return;
  end if;

  alter table public.xpc_pair_links disable trigger xpc_pair_links_enforce_trg;

  for ops in
    select id, squadron_name, tier from public.xpc_registry
     where tier = 'squadron' and id !~ '^(SQDNCMD|FLIGHT|WING|BASE|HQ):'
  loop
    for peer in
      select id, squadron_name, tier from public.xpc_registry
       where id <> ops.id
         and squadron_name = ops.squadron_name
         and (tier in ('squadron','flight'))
    loop
      if ops.id < peer.id then
        ca := ops.id;  cb := peer.id;
        cat := ops.tier; cbt := peer.tier;
        cas := ops.squadron_name; cbs := peer.squadron_name;
      else
        ca := peer.id; cb := ops.id;
        cat := peer.tier; cbt := ops.tier;
        cas := peer.squadron_name; cbs := ops.squadron_name;
      end if;
      k := public.xpc_validate_pairing(cat, cbt, cas, cbs, null, null, true, null, null);
      if k is null then continue; end if;
      insert into public.xpc_pair_links
        (a_pc_id, b_pc_id, a_tier, b_tier, a_squadron, b_squadron,
         kind, paired_by_label)
      values
        (ca, cb, cat, cbt, cas, cbs, k, 'backfill 0038')
      on conflict (a_pc_id, b_pc_id) do nothing;
    end loop;
  end loop;

  alter table public.xpc_pair_links enable trigger xpc_pair_links_enforce_trg;
end $$;


-- Reload PostgREST schema cache so RPCs / new columns become callable
-- via the REST API immediately. See .local/memory/supabase-admin.md and
-- the convention documented in 0041_canon_identity.sql.
notify pgrst, 'reload schema';
