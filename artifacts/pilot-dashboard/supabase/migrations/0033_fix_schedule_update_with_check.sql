-- v1.1.90: fix RLS WITH CHECK on xpc_schedule_shares UPDATE.
--
-- Bug (reported 2026-04-23): Commander tries to forward / hold / reject
-- an edited schedule and Postgres returns code 42501 — "new row
-- violates row-level security policy for table xpc_schedule_shares".
--
-- Root cause: the UPDATE policy declared a USING clause but no
-- WITH CHECK clause, so Postgres reused USING for both the OLD and
-- NEW row. When a recipient PC forwards a share to the next tier,
-- the new row's current_pc_id changes to the next-tier PC — which
-- is NOT in the actor's xpc_my_pc_ids(). USING passes (the old row
-- still belonged to them), but WITH CHECK fails on the new row.
--
-- Fix: keep USING strict (only PCs that have touched the share may
-- update it) but make WITH CHECK permissive (true). This matches
-- the operational reality: every participating PC has equal
-- authority to forward, edit, hold, reject, or hand the row back
-- to any other PC in the chain — the application code (cross-pc.ts)
-- already gates which transitions are valid.

drop policy if exists xpc_schedule_update on public.xpc_schedule_shares;

create policy xpc_schedule_update
  on public.xpc_schedule_shares
  for update
  to authenticated
  using (
    origin_squadron_id = any (public.xpc_my_pc_ids())
    or current_pc_id   = any (public.xpc_my_pc_ids())
  )
  with check (true);
