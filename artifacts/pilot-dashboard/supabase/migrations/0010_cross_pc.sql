-- Cross-PC workflow tables.
--
-- These four tables back the cross-squadron features in cross-pc.ts:
--   * xpc_registry          — one row per signed-in squadron/wing/base PC
--   * xpc_pending           — guest-pilot sortie approvals queued for the
--                             home squadron
--   * xpc_schedule_shares   — flight-schedule sheets travelling Squadron →
--                             Wing → Base in the sharing chain
--   * xpc_messages          — Sqn/Wing/Base private messages
--
-- Unlike the per-squadron operational tables, these are intentionally
-- cross-tenant: a Wing PC must see the squadrons it oversees, a guest
-- pilot's home squadron must see entries logged by other squadrons, etc.
-- We therefore cannot use the squadron_id() filter used elsewhere.
-- Instead, every authenticated user declares (via xpc_user_pcs) the
-- cross-PC ids they may speak as (their squadron name, or commander
-- scope id like "WING:NWAC"); RLS then restricts SELECT to rows where
-- the caller is a participant, and INSERT/UPDATE to rows where the
-- caller is the originator / addressee.

-- ── PC-id mapping ────────────────────────────────────────────────────────
-- Each auth user upserts the pc_id(s) they may act as. registerLocalPC()
-- in cross-pc.ts inserts into this table when the user signs in.
--
-- Inserts are gated by xpc_can_claim_pc_id(), which requires an EXACT
-- match against the immutable `app_metadata.pc_id` claim that the
-- register-license / provision-commander edge functions write into the
-- auth user's app_metadata at provision time. Because app_metadata is
-- only writable by the service role, a user cannot self-elevate by
-- sending a different id from the client — the database refuses the
-- insert. As a defense-in-depth fallback (e.g. an older account whose
-- app_metadata predates this migration and has no pc_id claim), the
-- function falls back to deriving the canonical id from the immutable
-- squadron_id claim for ops / squadron-tier accounts; commander tiers
-- without a pc_id claim are denied outright until they are re-provisioned
-- and pick up the new app_metadata.
create or replace function public.xpc_can_claim_pc_id(p_pc_id text)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  meta jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'app_metadata';
  tier text := meta ->> 'tier';
  role text := meta ->> 'role';
  claimed text := meta ->> 'pc_id';
  sqn_id uuid := nullif(meta ->> 'squadron_id', '')::uuid;
  sqn_name text;
begin
  if meta is null or p_pc_id is null or p_pc_id = '' then return false; end if;

  -- Primary path: exact match against the server-issued pc_id claim.
  if claimed is not null and claimed <> '' then
    return p_pc_id = claimed;
  end if;

  -- Legacy fallback for ops/squadron accounts provisioned before pc_id
  -- was added to app_metadata: derive the canonical id from the
  -- (immutable) squadron_id claim.
  if (role = 'ops' or tier = 'ops' or tier = 'squadron' or tier = 'deputy')
     and sqn_id is not null then
    select name into sqn_name from public.squadrons where id = sqn_id;
    return sqn_name is not null and p_pc_id = sqn_name;
  end if;

  -- Commander/HQ tiers without a pc_id claim cannot be uniquely
  -- identified server-side; deny by default until re-provisioned.
  return false;
end;
$$;
grant execute on function public.xpc_can_claim_pc_id(text) to authenticated;

create table if not exists public.xpc_user_pcs (
  user_id uuid not null references auth.users(id) on delete cascade,
  pc_id   text not null,
  primary key (user_id, pc_id)
);
alter table public.xpc_user_pcs enable row level security;

drop policy if exists xpc_user_pcs_self_select on public.xpc_user_pcs;
create policy xpc_user_pcs_self_select on public.xpc_user_pcs
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists xpc_user_pcs_self_insert on public.xpc_user_pcs;
create policy xpc_user_pcs_self_insert on public.xpc_user_pcs
  for insert to authenticated
  with check (user_id = auth.uid() and public.xpc_can_claim_pc_id(pc_id));

drop policy if exists xpc_user_pcs_self_update on public.xpc_user_pcs;
create policy xpc_user_pcs_self_update on public.xpc_user_pcs
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid() and public.xpc_can_claim_pc_id(pc_id));

drop policy if exists xpc_user_pcs_self_delete on public.xpc_user_pcs;
create policy xpc_user_pcs_self_delete on public.xpc_user_pcs
  for delete to authenticated
  using (user_id = auth.uid());

-- Helper: list of pc_ids the current caller may act as. Reads from the
-- mapping table populated above (so RLS already enforces tier scoping).
-- SECURITY DEFINER so RLS-level policies can call it without recursion.
create or replace function public.xpc_my_pc_ids()
  returns text[]
  language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(pc_id), '{}'::text[])
    from public.xpc_user_pcs
   where user_id = auth.uid();
$$;
grant execute on function public.xpc_my_pc_ids() to authenticated;

-- ── Tables ───────────────────────────────────────────────────────────────
create table if not exists public.xpc_registry (
  id text primary key,
  squadron_name text not null,
  tier text not null check (tier in ('squadron','wing','base','hq')),
  base text,
  wing text,
  last_seen timestamptz not null default now()
);
create index if not exists xpc_registry_last_seen_idx on public.xpc_registry(last_seen desc);

create table if not exists public.xpc_pending (
  id text primary key,
  hosting_squadron_id text not null,
  hosting_squadron_name text not null,
  home_squadron_id text not null,
  home_squadron_name text not null,
  guest_pilot_name text not null,
  guest_pilot_military_number text,
  guest_seat text not null check (guest_seat in ('pilot','coPilot')),
  sortie jsonb not null,
  submitted_at timestamptz not null default now(),
  submitted_by text not null,
  status text not null default 'pending'
    check (status in ('pending','accepted','rejected','edited','deleted')),
  decided_at timestamptz,
  decided_by text,
  decision_reason text,
  edited_sortie jsonb
);
create index if not exists xpc_pending_home_status_idx
  on public.xpc_pending(home_squadron_id, status, submitted_at desc);

create table if not exists public.xpc_schedule_shares (
  id text primary key,
  flight_date date not null,
  origin_squadron_id text not null,
  origin_squadron_name text not null,
  current_tier text not null check (current_tier in ('squadron','wing','base')),
  current_pc_id text,
  current_pc_name text,
  status text not null
    check (status in ('draft','submitted','reviewed','approved','rejected','held','edited')),
  rows jsonb not null default '[]'::jsonb,
  baseline_rows jsonb not null default '[]'::jsonb,
  history jsonb not null default '[]'::jsonb,
  edited_rows jsonb,
  edited_by text,
  updated_at timestamptz not null default now()
);
create index if not exists xpc_schedule_current_pc_idx
  on public.xpc_schedule_shares(current_pc_id, flight_date desc);
create index if not exists xpc_schedule_origin_idx
  on public.xpc_schedule_shares(origin_squadron_id, flight_date desc);

create table if not exists public.xpc_messages (
  id text primary key,
  thread_id text not null,
  from_pc_id text not null,
  from_pc_name text not null,
  from_tier text not null check (from_tier in ('squadron','wing','base')),
  from_user text not null,
  to_pc_id text not null,
  to_pc_name text not null,
  to_tier text not null check (to_tier in ('squadron','wing','base')),
  subject text not null,
  body text not null,
  priority text not null check (priority in ('normal','medium','urgent')),
  sent_at timestamptz not null default now(),
  read_at timestamptz,
  in_history boolean not null default false
);
create index if not exists xpc_messages_to_idx on public.xpc_messages(to_pc_id, sent_at desc);
create index if not exists xpc_messages_from_idx on public.xpc_messages(from_pc_id, sent_at desc);
create index if not exists xpc_messages_sent_at_idx on public.xpc_messages(sent_at);

-- ── RLS ──────────────────────────────────────────────────────────────────
alter table public.xpc_registry         enable row level security;
alter table public.xpc_pending          enable row level security;
alter table public.xpc_schedule_shares  enable row level security;
alter table public.xpc_messages         enable row level security;

-- Registry: every authenticated user reads the directory (they need to
-- see other squadrons in pickers), but writes are scoped to the caller's
-- own pc id. Deletion is allowed for the caller's own row (e.g. cleanup
-- on sign-out) but not for anyone else's.
drop policy if exists xpc_registry_select on public.xpc_registry;
create policy xpc_registry_select on public.xpc_registry
  for select to authenticated using (true);

drop policy if exists xpc_registry_insert on public.xpc_registry;
create policy xpc_registry_insert on public.xpc_registry
  for insert to authenticated
  with check (id = any(public.xpc_my_pc_ids()));

drop policy if exists xpc_registry_update on public.xpc_registry;
create policy xpc_registry_update on public.xpc_registry
  for update to authenticated
  using (id = any(public.xpc_my_pc_ids()))
  with check (id = any(public.xpc_my_pc_ids()));

drop policy if exists xpc_registry_delete on public.xpc_registry;
create policy xpc_registry_delete on public.xpc_registry
  for delete to authenticated
  using (id = any(public.xpc_my_pc_ids()));

-- Pending approvals: visible to host (submitter) and home (decider) only.
-- Inserts must come from the host. Updates (decide / edit) must come
-- from the home squadron. Deletion is left to the home squadron.
drop policy if exists xpc_pending_select on public.xpc_pending;
create policy xpc_pending_select on public.xpc_pending
  for select to authenticated
  using (
    hosting_squadron_id = any(public.xpc_my_pc_ids())
    or home_squadron_id = any(public.xpc_my_pc_ids())
  );

drop policy if exists xpc_pending_insert on public.xpc_pending;
create policy xpc_pending_insert on public.xpc_pending
  for insert to authenticated
  with check (hosting_squadron_id = any(public.xpc_my_pc_ids()));

drop policy if exists xpc_pending_update on public.xpc_pending;
create policy xpc_pending_update on public.xpc_pending
  for update to authenticated
  using (home_squadron_id = any(public.xpc_my_pc_ids()))
  with check (home_squadron_id = any(public.xpc_my_pc_ids()));

drop policy if exists xpc_pending_delete on public.xpc_pending;
create policy xpc_pending_delete on public.xpc_pending
  for delete to authenticated
  using (home_squadron_id = any(public.xpc_my_pc_ids()));

-- Schedule shares: visible to origin and current holder. Inserts must
-- come from the origin. Updates can come from either side (originator
-- accepts edits; current holder decides/forwards).
drop policy if exists xpc_schedule_select on public.xpc_schedule_shares;
create policy xpc_schedule_select on public.xpc_schedule_shares
  for select to authenticated
  using (
    origin_squadron_id = any(public.xpc_my_pc_ids())
    or current_pc_id   = any(public.xpc_my_pc_ids())
  );

drop policy if exists xpc_schedule_insert on public.xpc_schedule_shares;
create policy xpc_schedule_insert on public.xpc_schedule_shares
  for insert to authenticated
  with check (origin_squadron_id = any(public.xpc_my_pc_ids()));

drop policy if exists xpc_schedule_update on public.xpc_schedule_shares;
create policy xpc_schedule_update on public.xpc_schedule_shares
  for update to authenticated
  using (
    origin_squadron_id = any(public.xpc_my_pc_ids())
    or current_pc_id   = any(public.xpc_my_pc_ids())
  );

drop policy if exists xpc_schedule_delete on public.xpc_schedule_shares;
create policy xpc_schedule_delete on public.xpc_schedule_shares
  for delete to authenticated
  using (origin_squadron_id = any(public.xpc_my_pc_ids()));

-- Messages: visible to sender and recipient. Inserts must come from the
-- sender. Updates (mark read / move to history) come from the recipient.
-- Deletion is allowed for either party (the auto-purge cutoff runs as
-- the caller so it only ever removes their own old messages).
drop policy if exists xpc_messages_select on public.xpc_messages;
create policy xpc_messages_select on public.xpc_messages
  for select to authenticated
  using (
    from_pc_id = any(public.xpc_my_pc_ids())
    or to_pc_id = any(public.xpc_my_pc_ids())
  );

drop policy if exists xpc_messages_insert on public.xpc_messages;
create policy xpc_messages_insert on public.xpc_messages
  for insert to authenticated
  with check (from_pc_id = any(public.xpc_my_pc_ids()));

drop policy if exists xpc_messages_update on public.xpc_messages;
create policy xpc_messages_update on public.xpc_messages
  for update to authenticated
  using (to_pc_id = any(public.xpc_my_pc_ids()))
  with check (to_pc_id = any(public.xpc_my_pc_ids()));

drop policy if exists xpc_messages_delete on public.xpc_messages;
create policy xpc_messages_delete on public.xpc_messages
  for delete to authenticated
  using (
    from_pc_id = any(public.xpc_my_pc_ids())
    or to_pc_id = any(public.xpc_my_pc_ids())
  );
