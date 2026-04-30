-- Migration 0081 — Task #300: drop the legacy License Keys / Commanders tables.
--
-- Task #299 replaced the License Keys + Commanders + Generate Code +
-- Set up this device flow with the new Join → Approve → Bind path
-- (unit_members + devices + device_requests). Task #300 deletes the
-- last surviving pieces: the admin pages, the api-server proxy, the
-- three legacy edge functions (register-license, provision-commander,
-- validate-license), and these two tables.
--
-- We do NOT just `drop table` — those tables hold the only audit-trail
-- record of which license keys were ever issued and which commander
-- accounts were ever provisioned through the old flow. Code review on
-- the Task #299 rollout asked for an archive copy in case a leaked-key
-- forensic question comes up later. We therefore:
--
--   1. Create a `_archived_` schema (idempotent).
--   2. Move `public.license_registry` → `_archived_.license_registry`
--      if the table exists.
--   3. Move `public.commander_accounts` → `_archived_.commander_accounts`
--      if it exists. (No CREATE TABLE for this exists in the in-tree
--      migrations — clean installs never had it. The legacy table only
--      lives on units that were running Task #299's predecessor flow,
--      which is exactly the audit-trail case we want to preserve.)
--   4. Lock down both archived copies: revoke all access, no RLS
--      policies. The data is read-only forensic evidence; only a
--      direct service-role query (i.e. an operator with the database
--      password in hand) can ever reach it again.
--
-- Cross-PC effect: the dashboard's `license-registry.ts` and
-- `commander-store.ts` libs still write to `public.license_registry` /
-- `public.commander_accounts` if a stale binary is in the field. Those
-- writes will now fail with `relation "public.<table>" does not exist`,
-- which is the correct fail-closed behavior — the legacy admin UI is
-- gone, so any client still calling those mirrors is by definition out
-- of date and should error rather than silently succeed against a
-- table the operator can no longer inspect.
--
-- Idempotent: every step is `if exists` / `create schema if not
-- exists`, so re-running the migration is a no-op.

create schema if not exists "_archived_";

-- license_registry — created in 0026 on every unit. Always present.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'license_registry'
  ) then
    -- If a previous failed run already moved it, drop the orphan in
    -- _archived_ before re-moving so the rename never collides.
    if exists (
      select 1 from information_schema.tables
      where table_schema = '_archived_' and table_name = 'license_registry'
    ) then
      execute 'drop table "_archived_".license_registry';
    end if;
    execute 'alter table public.license_registry set schema "_archived_"';
  end if;
end $$;

-- commander_accounts — only present on units that ran the legacy
-- pre-Task-#299 bootstrap. Skip silently when absent.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'commander_accounts'
  ) then
    if exists (
      select 1 from information_schema.tables
      where table_schema = '_archived_' and table_name = 'commander_accounts'
    ) then
      execute 'drop table "_archived_".commander_accounts';
    end if;
    execute 'alter table public.commander_accounts set schema "_archived_"';
  end if;
end $$;

-- Lock the archived copies so neither anon nor authenticated nor the
-- existing license_registry_* RLS policies grant any access. Forensic
-- queries must come from a privileged direct connection.
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = '_archived_' and table_name = 'license_registry'
  ) then
    execute 'alter table "_archived_".license_registry disable row level security';
    execute 'revoke all on "_archived_".license_registry from public';
    execute 'revoke all on "_archived_".license_registry from anon, authenticated';
  end if;
  if exists (
    select 1 from information_schema.tables
    where table_schema = '_archived_' and table_name = 'commander_accounts'
  ) then
    execute 'alter table "_archived_".commander_accounts disable row level security';
    execute 'revoke all on "_archived_".commander_accounts from public';
    execute 'revoke all on "_archived_".commander_accounts from anon, authenticated';
  end if;
end $$;

-- Lock the archive schema itself: only the postgres / supabase_admin
-- service role (which already has it via default schema-search-path)
-- can list or query. anon + authenticated lose USAGE so even if a
-- stale RLS-less query referenced "_archived_".<table> directly the
-- request would be denied at the schema gate.
revoke all on schema "_archived_" from public;
revoke all on schema "_archived_" from anon, authenticated;
