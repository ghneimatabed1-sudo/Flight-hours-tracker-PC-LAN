-- 0066_snapshot_payload_hours_marker.sql
-- Round 4 AA3 — #268 (commander rollups show "0h" in every cell).
--
-- Why this is a marker and not a DDL change
-- ─────────────────────────────────────────
-- xpc_squadron_snapshot.payload is JSONB. Adding new fields to the
-- payload shape does NOT require a schema change — the table is
-- agnostic about the inner keys. The actual fix for #268 is in the
-- publisher: artifacts/pilot-dashboard/src/App.tsx now writes
--
--   roster[i].dayHours / nightHours / nvgHours / simHours / captainHours
--
-- alongside the existing roster fields, and src/lib/dash-pilots.ts
-- (adaptSnapshotPilot) reads them instead of defaulting to 0. The
-- next time each squadron's Ops PC ticks (~2 minutes after the new
-- dashboard loads) the payload upserts with the new shape, and every
-- wing/base/HQ commander rollup row now shows real hours.
--
-- This migration exists for two reasons:
--   1. To record the round-4 work in the migration ledger so the
--      audit trail stays complete and the schema-drift snapshot
--      (0060) sees a deliberate ledger entry rather than an
--      unexplained payload mutation across snapshots.
--   2. To trigger a PostgREST schema reload, which is harmless on a
--      no-op migration but keeps the apply workflow's "reload after
--      every migration" contract uniform.
--
-- No DDL is intentional; if a future round needs to enforce hour
-- fields at the table level (e.g. with a JSONB constraint), add a
-- separate numbered migration rather than editing this one.

insert into public._migration_ledger (filename, applied_at, applied_by, sha256)
values ('0066_snapshot_payload_hours_marker.sql', now(), 'task-280', null)
on conflict (filename) do nothing;

notify pgrst, 'reload schema';
