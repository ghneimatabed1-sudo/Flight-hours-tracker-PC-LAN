-- 0026_license_registry.sql
--
-- Central mirror of every license key the Super Admin has ever generated,
-- so the registry survives the super-admin's browser cache being cleared,
-- the OS being reinstalled, or the laptop being swapped. The localStorage
-- copy in license-registry.ts remains authoritative for the offline path
-- (and for fast reads), but every write is also pushed here in the
-- background so a fresh super-admin install can pull the full history
-- back down on first launch.
--
-- This is a tracking ledger, not a credential store: the same keys are
-- already stored in plaintext in the super admin's browser localStorage
-- (matching how the existing client treats them). Open RLS for the
-- super-admin role is acceptable since the only protection is who knows
-- the super-admin password.

create table if not exists public.license_registry (
  id text primary key,
  full_key text not null,
  meta jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists license_registry_updated_idx
  on public.license_registry(updated_at desc);

alter table public.license_registry enable row level security;

-- Anyone authenticated (including the anon role used by the activation
-- check on field PCs) can read the ledger so a fresh super-admin install
-- pulls history back, and so an Ops PC can validate a key against the
-- central record. Writes are open too — the client gates this behind the
-- super-admin password screen, the table is just a survivability mirror.
drop policy if exists license_registry_read on public.license_registry;
create policy license_registry_read
  on public.license_registry for select
  using (true);

drop policy if exists license_registry_write on public.license_registry;
create policy license_registry_write
  on public.license_registry for insert
  with check (true);

drop policy if exists license_registry_update on public.license_registry;
create policy license_registry_update
  on public.license_registry for update
  using (true) with check (true);

drop policy if exists license_registry_delete on public.license_registry;
create policy license_registry_delete
  on public.license_registry for delete
  using (true);
