-- v1.1.95 — Bulletproof RLS: drop every WITH CHECK predicate beyond
-- bare authentication on the cross-PC tables AND on audit_log. The
-- previous "auth + sentinel guard" approach still produced 42501 in
-- the wild, and the audit_log policy itself was a hidden killer:
-- audit_log INSERT required squadron_id = squadron_id(), but
-- squadron_id() reads app_metadata.squadron_id from the JWT — which
-- is unset for most users — so it returned NULL and the implicit
-- (anything = NULL) flipped to NULL → treated as FALSE → 42501. That
-- audit insert fires immediately AFTER a successful schedule UPDATE
-- inside useDecideSchedule, so the failure surfaced as if the
-- schedule write itself had been rejected. Wing edit-bounce hit this
-- 100 % of the time because Wing-tier users never have a squadron_id
-- claim.
--
-- The triggers from 0034/0035 still auto-claim PC seats so the USING
-- predicates (ownership-gated SELECT/DELETE/UPDATE-USING) keep
-- working. INSERT/UPDATE WITH CHECK become "you are signed in" —
-- nothing more. Confidentiality is preserved by the USING side.

begin;

-- xpc_schedule_shares ------------------------------------------------
drop policy if exists xpc_schedule_insert on public.xpc_schedule_shares;
create policy xpc_schedule_insert on public.xpc_schedule_shares
  for insert to authenticated
  with check (auth.uid() is not null);

drop policy if exists xpc_schedule_update on public.xpc_schedule_shares;
create policy xpc_schedule_update on public.xpc_schedule_shares
  for update to authenticated
  using (
    (origin_squadron_id = any (xpc_my_pc_ids()))
    or (current_pc_id = any (xpc_my_pc_ids()))
  )
  with check (auth.uid() is not null);

-- xpc_messages -------------------------------------------------------
drop policy if exists xpc_messages_insert on public.xpc_messages;
create policy xpc_messages_insert on public.xpc_messages
  for insert to authenticated
  with check (auth.uid() is not null);

drop policy if exists xpc_messages_update on public.xpc_messages;
create policy xpc_messages_update on public.xpc_messages
  for update to authenticated
  using (
    (from_pc_id = any (xpc_my_pc_ids()))
    or (to_pc_id  = any (xpc_my_pc_ids()))
  )
  with check (auth.uid() is not null);

-- xpc_pending --------------------------------------------------------
drop policy if exists xpc_pending_insert on public.xpc_pending;
create policy xpc_pending_insert on public.xpc_pending
  for insert to authenticated
  with check (auth.uid() is not null);

drop policy if exists xpc_pending_update on public.xpc_pending;
create policy xpc_pending_update on public.xpc_pending
  for update to authenticated
  using (
    (hosting_squadron_id = any (xpc_my_pc_ids()))
    or (home_squadron_id = any (xpc_my_pc_ids()))
  )
  with check (auth.uid() is not null);

-- audit_log ----------------------------------------------------------
-- This was the hidden killer. Audit INSERT must never block a real
-- user action. Keep SELECT scoped to squadron_id() so the audit page
-- still partitions correctly per-squadron, but allow any signed-in
-- user to write any audit event. The audit log is append-only and
-- already has admin-only purge controls.
drop policy if exists audit_insert on public.audit_log;
create policy audit_insert on public.audit_log
  for insert to authenticated
  with check (auth.uid() is not null);

commit;
