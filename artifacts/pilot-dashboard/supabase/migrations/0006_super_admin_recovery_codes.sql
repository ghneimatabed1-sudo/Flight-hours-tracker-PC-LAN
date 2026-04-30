-- Recovery codes for the super-admin TOTP. Without these, a lost or wiped
-- authenticator device would permanently lock the only super-admin account
-- out of the dashboard. Ten single-use codes are generated at enrollment,
-- shown once to the admin, and stored here only as SHA-256 hashes so an
-- attacker with read access to the DB cannot use them.
--
-- Trust model: same as super_admin_2fa — RLS is enabled with no policies,
-- only the service role (held by the super-admin-2fa edge function) can
-- read/write these columns.

alter table super_admin_2fa
  add column if not exists recovery_code_hashes   text[]         not null default '{}',
  add column if not exists recovery_code_used_at  timestamptz[]  not null default '{}';
