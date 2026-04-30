-- Task #137 — sender identity in messages/shares + per-squadron defaults.
--
-- 1. Cross-PC messages and schedule shares now carry rich sender identity
--    (display name, rank and seat label) so every inbox / history surface
--    can render "Maj. Ahmad · Flight Cmdr · NO.8 SQDN" instead of the
--    cryptic auth username. Old rows leave the new columns NULL and the
--    UI falls back to the legacy from_user / from_pc_name pair.
--
-- 2. The hard-coded UH-60M aircraft list and monthly hour targets that
--    used to live in `squadron-defaults.ts` now persist on the squadron
--    row itself (`default_aircraft`, `default_monthly_targets`) so a
--    fresh install of any helicopter squadron lands on its own baseline
--    instead of NO.8 SQDN's. The columns default to empty so existing
--    deployments keep working — the Setup Wizard fills them in.

alter table public.xpc_messages
  add column if not exists from_display_name text,
  add column if not exists from_rank         text,
  add column if not exists from_seat_label   text;

alter table public.xpc_schedule_shares
  add column if not exists submitter_display_name text,
  add column if not exists submitter_rank         text,
  add column if not exists submitter_seat_label   text;

alter table public.xpc_pending
  add column if not exists submitter_display_name text,
  add column if not exists submitter_rank         text,
  add column if not exists submitter_seat_label   text;

alter table public.squadrons
  add column if not exists default_aircraft         jsonb not null default '[]'::jsonb,
  add column if not exists default_monthly_targets  jsonb not null default '{}'::jsonb;


-- Reload PostgREST schema cache so RPCs / new columns become callable
-- via the REST API immediately. See .local/memory/supabase-admin.md and
-- the convention documented in 0041_canon_identity.sql.
notify pgrst, 'reload schema';
