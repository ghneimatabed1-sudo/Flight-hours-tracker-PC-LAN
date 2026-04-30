-- Migration 0079 — add device_requests.originating_city + plumb it
-- through unit_request_join.
--
-- Migration 0078 changed `unit_pending_requests` to RETURN
-- `originating_city`, but the underlying column was never added in
-- 0069 (the column appears only in a comment block). The RPC therefore
-- failed at call time with `column dr.originating_city does not exist`.
-- This migration:
--   1. Adds the column nullable (no backfill — existing rows stay
--      NULL, the UI handles that gracefully).
--   2. Recreates `unit_request_join` with an extra trailing
--      `p_originating_city text default null` argument so existing
--      callers (which omit it) keep working unchanged, AND the new
--      client (which passes the laptop's IANA timezone as a coarse
--      "where in the world is this PC" hint) can populate it.
--
-- The function body is otherwise IDENTICAL to the prod copy at the
-- moment of writing — same secret check, same validation rules, same
-- IP extraction. The single semantic change is the new column write.
--
-- Idempotent: column add uses `if not exists`; function uses
-- `create or replace`.

alter table public.device_requests
  add column if not exists originating_city text;

-- Drop the old 7-arg overload first; otherwise PostgREST refuses with
-- PGRST203 (`Could not choose the best candidate function between …`).
drop function if exists public.unit_request_join(text, text[], text, text, text, text, text);

create or replace function public.unit_request_join(
  p_role text,
  p_requested_squadron_names text[],
  p_username text,
  p_display_name text,
  p_password_sha256 text,
  p_claim_token text,
  p_fingerprint text,
  p_originating_city text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_request_id uuid;
  v_ip inet;
begin
  if not public._unit_join_secret_ok() then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if p_role not in ('ops', 'flight', 'squadron', 'wing', 'base', 'hq') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  if p_username is null or length(trim(p_username)) < 2 then
    raise exception 'username_too_short' using errcode = '22023';
  end if;
  if p_display_name is null or length(trim(p_display_name)) < 1 then
    raise exception 'display_name_required' using errcode = '22023';
  end if;
  if p_password_sha256 is null or length(p_password_sha256) <> 64 then
    raise exception 'password_hash_invalid' using errcode = '22023';
  end if;
  if p_claim_token is null or length(p_claim_token) < 16 then
    raise exception 'claim_token_invalid' using errcode = '22023';
  end if;
  if p_fingerprint is null or length(p_fingerprint) < 4 then
    raise exception 'fingerprint_required' using errcode = '22023';
  end if;
  if coalesce(array_length(p_requested_squadron_names, 1), 0) = 0 then
    raise exception 'squadrons_required' using errcode = '22023';
  end if;
  if p_role in ('ops', 'flight', 'squadron') and coalesce(array_length(p_requested_squadron_names, 1), 0) > 1 then
    raise exception 'single_squadron_only_for_role' using errcode = '22023';
  end if;
  v_ip := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-forwarded-for';
  insert into public.device_requests
    (requested_role, requested_squadron_names, username, display_name,
     password_sha256, claim_token, fingerprint, originating_ip,
     originating_city)
    values
    (p_role, p_requested_squadron_names, p_username, p_display_name,
     p_password_sha256, p_claim_token, p_fingerprint, v_ip,
     nullif(p_originating_city, ''))
    returning id into v_request_id;
  return v_request_id;
end;
$$;

revoke all on function public.unit_request_join(text, text[], text, text, text, text, text, text) from public;
grant execute on function public.unit_request_join(text, text[], text, text, text, text, text, text) to anon, authenticated, service_role;

insert into public._migration_ledger(filename, sha256, applied_by)
values ('0079_originating_city.sql', null, 'task-299-review')
on conflict (filename) do nothing;
