-- Restore xpc_registry as a full authenticated directory.
--
-- Migration 0023 tightened xpc_registry SELECT so that squadron-tier
-- viewers could only see rows they had prior interactions with. This
-- broke the core product flow: during Squadron / Flight Commander
-- first-run Setup (LicenseKeys.tsx "Linked ops squadron PC" picker),
-- the commander PC has not yet registered, has no JWT wing/base/hq
-- tier, and has no prior pending/schedule/message row — so RLS filters
-- every ops PC out and the picker shows "No ops squadron PCs are
-- registered yet" even after the ops PC was successfully set up.
--
-- The 0023 enumeration hardening was overprotective for this closed
-- single-base ecosystem. xpc_registry stores only directory metadata
-- (PC id, squadron name, tier, base, wing, last_seen) — no operational
-- data, no personnel, no hours. Rolling back to the permissive select
-- policy from 0010 restores the directory behaviour the UI relies on
-- while leaving all the *truly* sensitive tables (xpc_pending,
-- xpc_schedule_shares, xpc_messages) scoped by participant as before.

drop policy if exists xpc_registry_select on public.xpc_registry;
create policy xpc_registry_select on public.xpc_registry
  for select to authenticated using (true);
