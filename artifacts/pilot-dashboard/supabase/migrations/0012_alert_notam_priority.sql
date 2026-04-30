-- 0012_alert_notam_priority.sql
--
-- Adds a 3-level priority field to pilot Alerts and squadron NOTAMs so
-- commanders can mark an item as Normal (green), High (yellow) or Very
-- High (red). Existing rows default to 'normal' so nothing breaks for
-- already-published alerts/NOTAMs.
--
-- The same vocabulary as cross-PC private messages is used (`normal` /
-- `medium` / `urgent`) but exposed in the UI as Normal / High / Very High
-- per the operator request — keeping the DB enum identical means a future
-- "all priority items" feed can union the three sources without any
-- value translation.

alter table alerts
  add column if not exists priority text not null default 'normal'
  check (priority in ('normal','medium','urgent'));

alter table notams
  add column if not exists priority text not null default 'normal'
  check (priority in ('normal','medium','urgent'));

create index if not exists alerts_priority_idx on alerts(priority);
create index if not exists notams_priority_idx on notams(priority);
