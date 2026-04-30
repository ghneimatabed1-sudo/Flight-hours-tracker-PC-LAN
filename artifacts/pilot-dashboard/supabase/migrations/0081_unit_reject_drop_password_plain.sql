-- Migration 0081 — unit_reject_request: stop writing the dropped password_plain column.
--
-- Background. Migration 0069 defined `unit_reject_request` with an UPDATE
-- that included `password_plain = null` to scrub the bcrypt-shaped string
-- from the row at rejection time. Migration 0075 dropped
-- `device_requests.password_plain` entirely (replaced by `password_sha256`
-- + `claim_token` per the security-hardening rework). The RPC body was
-- never refreshed, so since 0075 was applied to prod every super-admin
-- "Reject" click has been returning HTTP 400 with body
--   { "code":"42703",
--     "message":"column \"password_plain\" of relation \"device_requests\" does not exist" }
-- and the request stays `pending` forever.
--
-- This migration is a CREATE OR REPLACE of the RPC body that drops the
-- offending column write. Nothing else changes — same signature, same
-- super-admin gate, same `('pending', 'ignored')` allowlist for the WHERE,
-- same `decided_at` / `decided_by` / `decision_reason` triplet.
--
-- Caught by the multi-role walk in
-- `audit-evidence/multi-pc-simple-rebuild/two-laptop-walk.md` (defect MPC-2).

create or replace function public.unit_reject_request(p_request_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
begin
  if not public.xpc_is_super_admin() then
    raise exception 'super_admin_required' using errcode = '42501';
  end if;
  v_uid := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  update public.device_requests
     set status = 'rejected',
         decided_at = now(),
         decided_by = v_uid,
         decision_reason = p_reason
   where id = p_request_id and status in ('pending', 'ignored');
  if not found then
    raise exception 'request_not_found_or_already_decided' using errcode = '22023';
  end if;
end;
$$;

revoke all on function public.unit_reject_request(uuid, text) from public;
grant execute on function public.unit_reject_request(uuid, text) to authenticated, service_role;

insert into public._migration_ledger(filename, sha256, applied_by)
values ('0081_unit_reject_drop_password_plain.sql', null, 'task-302-walk')
on conflict (filename) do nothing;
