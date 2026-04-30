-- 0013_schedule_program.sql
-- Adds the full RJAF flight-schedule paper snapshot to xpc_schedule_shares
-- so a recipient PC renders the SAME sheet (helo header, airbase /
-- squadron, day & night bands, briefing strip, A/C-needed strip and
-- FLT.CMDR / SQDN.CMDR signature block) instead of a stripped table.
--
-- Also tracks the chain-of-custody (every PC that has handled the
-- share) so once approved, the sheet becomes visible to the entire
-- chain — matching the operator's choice that approve broadcasts to
-- all PCs that have touched the workflow so far.
--
-- All columns are nullable so old shares created before this migration
-- continue to load.

alter table public.xpc_schedule_shares
  add column if not exists program        jsonb,
  add column if not exists edited_program jsonb,
  add column if not exists chain_pc_ids   text[] not null default '{}',
  add column if not exists approved_at    timestamptz,
  add column if not exists approved_by    text;

-- Speeds up the visibility filter "I am anywhere in the chain on an
-- approved share" used by useScheduleShares.
create index if not exists xpc_schedule_shares_chain_pc_ids_gin
  on public.xpc_schedule_shares using gin (chain_pc_ids);
