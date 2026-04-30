-- Super-admin TOTP secrets, stored server-side instead of in browser
-- localStorage. With this in place a lost laptop or a wiped browser profile
-- no longer takes the only copy of the 2FA seed with it, and the secret
-- itself is never accessible from the client (only the edge function with
-- the service role key can read it).
--
-- Trust model:
--   * RLS is enabled and there are NO policies. That means anon and
--     authenticated requests cannot read or write this table at all —
--     PostgREST silently returns zero rows. Only the Supabase service role
--     (which bypasses RLS) can touch it, and the only thing holding that
--     key is the `super-admin-2fa` edge function.
--   * The verify edge function increments failed_attempts on a bad code
--     and locks the account for 5 minutes after 5 consecutive failures.
--     This rate-limit lives on the server so a wiped browser cannot reset
--     it (the old localStorage flow could).

create table if not exists super_admin_2fa (
  username          text primary key,
  secret_b32        text not null,
  enrolled_at       timestamptz,
  last_verified_at  timestamptz,
  failed_attempts   int  not null default 0,
  locked_until      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table super_admin_2fa enable row level security;

-- No policies on purpose — see header. Belt-and-braces revoke for any
-- direct grants that may have been issued to anon/authenticated.
revoke all on super_admin_2fa from anon, authenticated;
