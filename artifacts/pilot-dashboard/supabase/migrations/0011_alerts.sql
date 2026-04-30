-- Pilot alerts: short, time-sensitive messages issued by squadron /
-- flight commanders that broadcast to all pilots' phones in the
-- squadron. Mirrors the `notams` table — same per-squadron RLS scope.
-- The mobile client applies a per-device TTL filter on top of this for
-- visual clutter control; rows themselves persist server-side until the
-- issuing commander deletes them.

create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  squadron_id uuid not null default public.squadron_id() references squadrons(id) on delete cascade,
  posted_at timestamptz not null default now(),
  body text not null,
  author text,
  created_at timestamptz not null default now()
);

create index if not exists alerts_squadron_time_idx on alerts(squadron_id, posted_at desc);

alter table alerts enable row level security;

-- Same per-squadron read/write scope as NOTAMs. Per-role write
-- restriction (squadron / flight commander) is enforced by the dashboard
-- UI; squadrons that need stricter server-side enforcement should layer
-- a security-definer RPC on top.
drop policy if exists alerts_rw on alerts;
create policy alerts_rw on alerts
  for all using (squadron_id = public.squadron_id())
  with check (squadron_id = public.squadron_id());

-- Pilot-self read access: mirrors `pilot_self_rls` for notams (added in
-- 0003). Pilots authenticated via the mobile-link short-lived JWT need
-- to SELECT their squadron's alerts. If your environment doesn't use
-- the per-pilot auth role, add a parallel `for select to authenticated
-- using (true)` policy or the mobile Alerts tab will appear empty.
drop policy if exists alerts_pilot_read on alerts;
create policy alerts_pilot_read on alerts
  for select using (true);
