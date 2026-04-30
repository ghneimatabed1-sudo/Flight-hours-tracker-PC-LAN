-- Allow anon reads of the xpc_registry directory.
--
-- 0024 restored the permissive SELECT but scoped it to the
-- `authenticated` role. The Squadron / Flight / Wing / Base Commander
-- first-run Setup dialog runs BEFORE the PC has a Supabase session
-- (Supabase auth is only established by register-license after Setup
-- completes), so the PostgREST request carries only the anon key and
-- RLS filters every row out. The picker shows "No ops squadron PCs
-- are registered yet" even though the ops PC's row is present in
-- xpc_registry.
--
-- Make the registry readable by anon as well. The table stores only
-- directory metadata (id, squadron name, tier, base, wing, last_seen)
-- — it is by design the public address book of the ecosystem. All
-- sensitive tables (xpc_pending, xpc_schedule_shares, xpc_messages)
-- remain strictly participant-scoped and require authenticated access.

drop policy if exists xpc_registry_select on public.xpc_registry;
create policy xpc_registry_select on public.xpc_registry
  for select to anon, authenticated using (true);
