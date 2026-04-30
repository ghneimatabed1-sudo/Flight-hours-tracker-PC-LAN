-- Migration 0082 — public.users.role check constraint: also allow
-- 'commander' and 'super_admin'.
--
-- Background. The legacy `public.users.role` CHECK constraint is
--   CHECK ((role = ANY (ARRAY['ops','deputy','admin','superadmin']))).
-- It predates the multi-PC rebuild's `unit_members.role` vocabulary
-- ('ops' | 'commander' | 'super_admin'). The `unit-approve-device` Edge
-- Function mirrors `unit_members.role` into `public.users.role`, with a
-- single defensive collapse `super_admin` → `'admin'`. For every
-- commander tier (flight, squadron, wing, base, hq) the mirror tries to
-- write `role='commander'`, which the constraint rejects with
--   23514: new row for relation "users" violates check constraint "users_role_check"
-- The Edge Function then returns 500 `user_mirror_failed` and the
-- joining laptop is left polling forever, while a stranded `auth.users`
-- row leaks because the auth user is created before the mirror step.
--
-- Caught by the multi-role walk in
-- `audit-evidence/multi-pc-simple-rebuild/two-laptop-walk.md` (defect MPC-1).
--
-- Fix: extend the allow-list to include the new role labels. We keep
-- the old labels for backward compatibility (existing rows already use
-- them and nothing in the new flow writes them).
--
-- Note. The Edge Function still maps `super_admin` → `'admin'`. We
-- nevertheless add `'super_admin'` to the allow-list so that a future
-- patch can drop the collapse without a separate constraint change.

alter table public.users
  drop constraint if exists users_role_check;

alter table public.users
  add constraint users_role_check
  check (role = any (array[
    'ops'::text,
    'deputy'::text,
    'admin'::text,
    'superadmin'::text,
    'commander'::text,
    'super_admin'::text
  ]));

insert into public._migration_ledger(filename, sha256, applied_by)
values ('0082_users_role_check_allow_commander.sql', null, 'task-302-walk')
on conflict (filename) do nothing;
