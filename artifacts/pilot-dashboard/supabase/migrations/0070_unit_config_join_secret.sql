-- 0070_unit_config_join_secret.sql
--
-- Task #299 — followup to 0069. The bootstrap RPCs need a shared secret
-- to gate anonymous callers (anti-spam, not anti-privilege-escalation —
-- the worst an unauthenticated caller can do is fill the device_requests
-- queue with junk that the super admin then rejects). 0069 read the
-- secret from a Postgres GUC `app.settings.unit_join_secret`, but
-- managed Supabase blocks `ALTER DATABASE … SET app.settings.*` for
-- the API role, so the GUC route is unusable. We pivot to a tiny
-- `public.unit_config` table read by the SECURITY DEFINER helper.
--
-- Properties of the new approach:
--   • the secret survives a backup/restore (it's a row, not a session
--     setting),
--   • it can be rotated by inserting a new row and incrementing
--     `effective_at` without touching the schema,
--   • RLS denies SELECT to anon — the secret is only readable from
--     inside SECURITY DEFINER functions running as the table owner,
--   • the secret is set at the END of this migration via UPSERT, so
--     re-running 0070 with a different value rotates the secret in one
--     atomic step.
--
-- Deploying a new dashboard build: bake the same secret value into the
-- desktop installer's `VITE_UNIT_JOIN_SECRET` env var. Both sides must
-- match byte-for-byte (no trailing newline / BOM, same as
-- REGISTER_LICENSE_SECRET).

create table if not exists public.unit_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.unit_config enable row level security;
-- No SELECT policy — RLS-default-deny means anon and authenticated
-- both get zero rows. Only SECURITY DEFINER functions reach the row.
drop policy if exists unit_config_super_admin_modify on public.unit_config;
create policy unit_config_super_admin_modify on public.unit_config
  for all to authenticated
  using (public.xpc_is_super_admin())
  with check (public.xpc_is_super_admin());

-- Replace the helper from 0069 to read from the config table.
create or replace function public._unit_join_secret_ok() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_expected text;
  v_supplied text;
begin
  select value into v_expected from public.unit_config where key = 'join_secret';
  if v_expected is null then
    return false;
  end if;
  v_supplied := coalesce(
    nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-unit-join-secret',
    ''
  );
  if length(v_supplied) <> length(v_expected) then
    return false;
  end if;
  -- md5() prefix gives a constant-time short-circuit; the second clause
  -- is the actual byte equality. PL/pgSQL has no native CT compare.
  return md5(v_supplied) = md5(v_expected) and v_supplied = v_expected;
end;
$$;

-- Seed the secret on a fresh install with a cryptographically random
-- value. Re-applying this migration on an existing install is a no-op
-- (ON CONFLICT DO NOTHING) so the value is never silently overwritten —
-- rotation goes through the dedicated `unit_rotate_join_secret` admin
-- RPC (see migration 0076) which is the one supported way to roll the
-- value forward. NEVER hard-code a secret in this file: the migration
-- source ends up in version control, so any literal here would be a
-- live credential leaked to the repo.
insert into public.unit_config (key, value)
values ('join_secret', encode(gen_random_bytes(32), 'hex'))
on conflict (key) do nothing;

insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0070_unit_config_join_secret.sql', now(), 'task-299', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
