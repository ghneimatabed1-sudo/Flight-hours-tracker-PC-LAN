-- 0057_xpc_outbox.sql
--
-- Task #265 Part C — Outbox pattern for cross-PC events (#28).
--
-- The cross-PC channel today writes directly into `public.xpc_messages`
-- (and a few other xpc_* tables) from Edge Functions and from the
-- Electron dashboard. A network blip during one of those writes can
-- silently lose the event — the originating client thinks it sent,
-- the destination never receives, and there's no retry.
--
-- This migration introduces a transactional outbox:
--
--   • Cross-PC senders MAY route through `xpc_outbox_send(target,
--     payload)`. The payload is enqueued as a row in
--     `public.xpc_outbox`. The actual delivery is performed by
--     `public.xpc_outbox_process()` which a `pg_cron` job runs
--     every minute.
--
--   • The processor calls a target-specific dispatcher and updates
--     `sent_at` / `attempts` / `last_error` on the outbox row.
--     Exponential backoff: attempt N is held back if
--     `now() < last_attempted_at + 2^min(N,8) seconds`.
--
--   • `public.xpc_outbox_monitor()` runs hourly and emits an
--     `ops.outbox.alert` audit row whenever any row has
--     `attempts > 8 AND sent_at IS NULL` — a stuck event that
--     needs operator eyes.
--
-- This migration creates the table + processor + monitor and wires
-- the first dispatcher: `xpc_message`. Other event types
-- (`xpc_pair_create`, `xpc_share_publish`, …) can be added by
-- extending `_xpc_outbox_dispatch_one` without further migrations.
--
-- Idempotent: safe to re-run.

-- ── 1. Table ────────────────────────────────────────────────────────
create table if not exists public.xpc_outbox (
  id                uuid primary key default gen_random_uuid(),
  target            text not null,                       -- 'xpc_message', 'xpc_pair_create', …
  payload           jsonb not null,                      -- target-specific
  created_at        timestamptz not null default now(),
  created_by        uuid references auth.users(id),
  sent_at           timestamptz,
  attempts          integer not null default 0,
  last_attempted_at timestamptz,
  last_error        text
);
create index if not exists xpc_outbox_pending_idx
  on public.xpc_outbox(created_at) where sent_at is null;
create index if not exists xpc_outbox_stuck_idx
  on public.xpc_outbox(attempts) where sent_at is null;

alter table public.xpc_outbox enable row level security;

-- The outbox is operational state, not user data. Only super_admin
-- reads it from the dashboard. Senders use `xpc_outbox_send` (a
-- security-definer function) to enqueue, never INSERT directly.
drop policy if exists xpc_outbox_select on public.xpc_outbox;
create policy xpc_outbox_select on public.xpc_outbox
  for select to authenticated using (
    coalesce(
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb
         -> 'app_metadata' ->> 'role') = 'super_admin',
      false
    )
  );

-- ── 2. Sender RPC ──────────────────────────────────────────────────
-- Returns the enqueued row id so the caller can correlate later.
create or replace function public.xpc_outbox_send(
  p_target  text,
  p_payload jsonb
)
returns uuid language plpgsql security definer as $$
declare
  v_id uuid;
  v_uid uuid;
begin
  if p_target is null or length(trim(p_target)) = 0 then
    raise exception 'xpc_outbox_send: target required';
  end if;
  if p_payload is null then
    raise exception 'xpc_outbox_send: payload required';
  end if;
  v_uid := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  insert into public.xpc_outbox (target, payload, created_by)
    values (p_target, p_payload, v_uid)
    returning id into v_id;
  return v_id;
end;
$$;

-- Restrict execution: anonymous traffic should never enqueue.
revoke all on function public.xpc_outbox_send(text, jsonb) from public;
grant execute on function public.xpc_outbox_send(text, jsonb)
  to authenticated, service_role;

-- ── 3. Per-target dispatchers ──────────────────────────────────────
-- Each dispatcher takes a row's payload and performs the actual
-- side-effect. Returns void on success, raises on failure (the
-- processor catches the exception and updates last_error).
--
-- New target types are wired by extending the CASE in
-- `_xpc_outbox_dispatch_one` and adding a per-target function.
create or replace function public._xpc_outbox_dispatch_xpc_message(p_payload jsonb)
returns void language plpgsql security definer as $$
declare
  v_id           text;
  v_thread_id    text;
  v_from_pc_id   text;
  v_from_pc_name text;
  v_from_tier    text;
  v_from_user    text;
  v_to_pc_id     text;
  v_to_pc_name   text;
  v_to_tier      text;
  v_subject      text;
  v_body         text;
  v_priority     text;
begin
  v_id           := coalesce(p_payload ->> 'id', gen_random_uuid()::text);
  v_thread_id    := coalesce(p_payload ->> 'thread_id', v_id);
  v_from_pc_id   := p_payload ->> 'from_pc_id';
  v_from_pc_name := coalesce(p_payload ->> 'from_pc_name', v_from_pc_id);
  v_from_tier    := coalesce(p_payload ->> 'from_tier', 'squadron');
  v_from_user    := coalesce(p_payload ->> 'from_user', 'system');
  v_to_pc_id     := p_payload ->> 'to_pc_id';
  v_to_pc_name   := coalesce(p_payload ->> 'to_pc_name', v_to_pc_id);
  v_to_tier      := coalesce(p_payload ->> 'to_tier', 'squadron');
  v_subject      := coalesce(p_payload ->> 'subject', '(no subject)');
  v_body         := coalesce(p_payload ->> 'body', '');
  v_priority     := coalesce(p_payload ->> 'priority', 'normal');
  if v_from_pc_id is null or v_to_pc_id is null then
    raise exception 'xpc_message payload missing from_pc_id / to_pc_id';
  end if;
  insert into public.xpc_messages
    (id, thread_id, from_pc_id, from_pc_name, from_tier, from_user,
     to_pc_id, to_pc_name, to_tier, subject, body, priority, sent_at)
  values
    (v_id, v_thread_id, v_from_pc_id, v_from_pc_name, v_from_tier, v_from_user,
     v_to_pc_id, v_to_pc_name, v_to_tier, v_subject, v_body, v_priority, now())
  on conflict (id) do nothing;
end;
$$;

-- ── 4. Single-row dispatch (used by both retry & manual replay) ────
create or replace function public._xpc_outbox_dispatch_one(p_id uuid)
returns boolean language plpgsql security definer as $$
declare
  v_row public.xpc_outbox%rowtype;
  v_backoff_seconds integer;
begin
  select * into v_row from public.xpc_outbox where id = p_id for update;
  if not found then
    return false;
  end if;
  if v_row.sent_at is not null then
    return true;
  end if;
  -- Exponential backoff: skip if not yet due.
  if v_row.last_attempted_at is not null then
    v_backoff_seconds := least(power(2, least(v_row.attempts, 8))::int, 256);
    if now() < v_row.last_attempted_at + (v_backoff_seconds || ' seconds')::interval then
      return false;
    end if;
  end if;
  begin
    case v_row.target
      when 'xpc_message' then
        perform public._xpc_outbox_dispatch_xpc_message(v_row.payload);
      else
        raise exception 'xpc_outbox: unknown target %', v_row.target;
    end case;
    update public.xpc_outbox
       set sent_at = now(),
           attempts = attempts + 1,
           last_attempted_at = now(),
           last_error = null
     where id = p_id;
    return true;
  exception when others then
    update public.xpc_outbox
       set attempts = attempts + 1,
           last_attempted_at = now(),
           last_error = SQLERRM
     where id = p_id;
    return false;
  end;
end;
$$;

-- ── 5. Bulk processor (cron entry point) ───────────────────────────
-- Pulls up to 500 unsent rows ordered by created_at, dispatches each.
-- Returns counts so the cron log shows progress.
create or replace function public.xpc_outbox_process()
returns table(processed integer, succeeded integer, failed integer)
language plpgsql security definer as $$
declare
  v_id uuid;
  v_proc integer := 0;
  v_ok   integer := 0;
  v_bad  integer := 0;
  v_done boolean;
begin
  for v_id in
    select id from public.xpc_outbox
     where sent_at is null
     order by created_at
     limit 500
  loop
    v_done := public._xpc_outbox_dispatch_one(v_id);
    v_proc := v_proc + 1;
    if v_done then
      v_ok := v_ok + 1;
    else
      v_bad := v_bad + 1;
    end if;
  end loop;
  processed := v_proc;
  succeeded := v_ok;
  failed    := v_bad;
  return next;
end;
$$;

select public._unschedule_if_exists('xpc-outbox-process');
select cron.schedule(
  'xpc-outbox-process',
  '* * * * *',  -- every minute
  $$ select public.xpc_outbox_process(); $$
);

-- ── 6. Monitor ─────────────────────────────────────────────────────
-- A stuck row (attempts > 8 and still unsent) is unusual and worth
-- a human eye. Insert an `ops.outbox.alert` audit row for each one
-- once per hour so the dashboard's Audit Log surfaces it. Alerts
-- are de-duped by including the outbox id; the same row will
-- re-alert each hour until the operator either replays it
-- (set attempts=0) or deletes it (and writes a justification).
create or replace function public.xpc_outbox_monitor()
returns integer language plpgsql security definer as $$
declare
  v_stuck record;
  v_count integer := 0;
begin
  for v_stuck in
    select id, target, attempts, last_error, created_at, last_attempted_at
      from public.xpc_outbox
     where sent_at is null and attempts > 8
  loop
    insert into public.audit_log
      (type, actor, detail, squadron_id, occurred_at)
    values (
      'ops.outbox.alert',
      'system.cron',
      jsonb_build_object(
        'outbox_id', v_stuck.id,
        'target',    v_stuck.target,
        'attempts',  v_stuck.attempts,
        'last_error', v_stuck.last_error,
        'created_at', v_stuck.created_at,
        'last_attempted_at', v_stuck.last_attempted_at,
        'remediation',
        'Inspect xpc_outbox row; either UPDATE attempts=0 to replay or DELETE with justification audit row.'
      ),
      null,
      now()
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

select public._unschedule_if_exists('xpc-outbox-monitor');
select cron.schedule(
  'xpc-outbox-monitor',
  '15 * * * *',  -- hourly at :15
  $$ select public.xpc_outbox_monitor(); $$
);

-- ── 7. Sanity probe ────────────────────────────────────────────────
do $$
declare r record;
begin
  raise notice 'xpc_outbox infrastructure (after 0057):';
  raise notice '  table exists: %',
    (select to_regclass('public.xpc_outbox') is not null);
  for r in
    select jobname, schedule from cron.job
     where jobname in ('xpc-outbox-process', 'xpc-outbox-monitor')
     order by jobname
  loop
    raise notice '  cron: % @ %', r.jobname, r.schedule;
  end loop;
end $$;

notify pgrst, 'reload schema';
