-- Per-pilot Supabase auth identity + row-level isolation for the mobile viewer.
--
-- Background:
--   Migration 0002 introduced an opaque per-device token and a SECURITY DEFINER
--   `pilot_snapshot` RPC. That meant every read went through one funnel and the
--   anon key alone could not pull rows from `pilots` / `sorties`. It worked,
--   but a phone with a working anon key + a valid squadron JWT (e.g. a leaked
--   dashboard session) could still read the entire squadron via the existing
--   `pilots_rw` / `sorties_rw` policies.
--
--   This migration tightens that to per-pilot scope:
--     * Each linked phone is signed in as its own Supabase auth user (created
--       by the new `link-pilot-device` edge function with service-role).
--     * That user's JWT carries `app_metadata.pilot_id` and a `role` claim of
--       'pilot' (no `squadron_id` claim, so the squadron-wide policies do not
--       fire for them).
--     * New SELECT-only policies on `pilots` / `sorties` / `squadrons` let the
--       pilot read exactly their own row(s) and nothing else.
--
--   The opaque-token RPCs from 0002 stay in place for backward compatibility,
--   but the mobile client now reads directly from the tables under RLS.

-- Track which auth user each pilot is bound to. Nullable because most pilots
-- will never link a phone, and the edge function fills this in on first link.
alter table pilots
  add column if not exists auth_user_id uuid
  references auth.users(id) on delete set null;

create unique index if not exists pilots_auth_user_idx
  on pilots(auth_user_id)
  where auth_user_id is not null;

-- JWT helper: the pilot_id claim that the edge function stamps onto the
-- mobile auth user's app_metadata. Returns null for ops/admin sessions.
create or replace function public.pilot_id() returns text
language sql stable as $$
  select nullif(coalesce(
    current_setting('request.jwt.claims', true)::jsonb #>> '{app_metadata,pilot_id}',
    ''
  ), '');
$$;

-- A pilot can read their own pilots row. The existing `pilots_rw` policy
-- (squadron-wide, for ops users) is unaffected — RLS is permissive, so any
-- matching policy grants access. Pilot JWTs deliberately omit squadron_id, so
-- the squadron policy never matches for them.
--
-- Belt-and-braces binding: we require BOTH the JWT's pilot_id claim to match
-- the row id AND the JWT's auth.uid() to match the row's auth_user_id. That
-- way ops can hard-revoke a phone simply by nulling pilots.auth_user_id (or
-- pointing it at a fresh auth user) and the previous JWT instantly stops
-- matching, even if its access token has not yet expired.
drop policy if exists pilots_self_select on pilots;
create policy pilots_self_select on pilots
  for select using (
    public.pilot_id() is not null
    and id = public.pilot_id()
    and auth_user_id is not null
    and auth_user_id = auth.uid()
  );

-- A pilot can read sorties they flew (as P1 or P2). Same auth_user_id
-- binding as above: revoking the binding on `pilots` immediately blocks
-- sortie reads too.
drop policy if exists sorties_self_select on sorties;
create policy sorties_self_select on sorties
  for select using (
    public.pilot_id() is not null
    and (pilot_id = public.pilot_id() or co_pilot_id = public.pilot_id())
    and exists (
      select 1 from pilots p
       where p.id = public.pilot_id()
         and p.auth_user_id = auth.uid()
    )
  );

-- A pilot can read the squadrons row their pilot record points at, so the
-- mobile UI can show squadron number / name / base.
drop policy if exists sq_self_select on squadrons;
create policy sq_self_select on squadrons
  for select using (
    public.pilot_id() is not null
    and id = (
      select squadron_id from pilots
       where id = public.pilot_id()
         and auth_user_id = auth.uid()
    )
  );

-- The `pilots_rw` policy from 0001 covers ops users (squadron JWT). The new
-- self-select policy covers pilot users. Default authenticated grants on
-- public tables already include SELECT, but keep it explicit so that dropping
-- anon SELECT in 0002 does not also strand authenticated pilots.
grant select on pilots to authenticated;
grant select on sorties to authenticated;
grant select on squadrons to authenticated;

-- Helper for the edge function: bind a pilot row to an auth user. Runs as
-- definer because the edge function's service-role client could do the
-- update directly, but routing it through here keeps the squadron check and
-- audit trail in one place.
create or replace function public.bind_pilot_auth_user(
  p_pilot_id text,
  p_auth_user_id uuid
) returns void
language plpgsql security definer set search_path = public, auth as $$
declare
  v_squadron uuid;
begin
  select squadron_id into v_squadron from pilots where id = p_pilot_id;
  if v_squadron is null then
    raise exception 'pilot_not_found';
  end if;

  -- If a different pilot was previously bound to this auth user, unbind them
  -- first so the unique index does not block the rebind.
  update pilots
     set auth_user_id = null
   where auth_user_id = p_auth_user_id
     and id <> p_pilot_id;

  update pilots
     set auth_user_id = p_auth_user_id,
         updated_at = now()
   where id = p_pilot_id;

  insert into audit_log (squadron_id, type, actor, detail)
  values (v_squadron, 'mobile.auth_bound', p_pilot_id,
          jsonb_build_object('pilotId', p_pilot_id, 'authUserId', p_auth_user_id));
end;
$$;

revoke all on function public.bind_pilot_auth_user(text, uuid) from public;
-- Only the service role (edge function) should call this.
grant execute on function public.bind_pilot_auth_user(text, uuid) to service_role;
