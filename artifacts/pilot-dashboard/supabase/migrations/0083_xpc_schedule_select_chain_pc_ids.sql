-- Task #308 — Restore squadron→wing→base→HQ schedule forwarding.
--
-- Symptom (PROD project nklrdhfsbevckovqqkah, observed by Task #303):
--   When a Wing Commander forwards a schedule share to a Base Commander
--   (or any forwarding step that re-points current_pc_id to a PC the
--   forwarder does not personally own), PostgREST rejects the UPDATE
--   with:
--
--     new row violates row-level security policy
--     for table "xpc_schedule_shares" (SQLSTATE 42501)
--
--   Six audit cells (A2, A3, A5, A6, A8, M3) failed with this single
--   error and the entire Squadron→Wing→Base→HQ chain is blocked.
--
-- Root cause:
--   The xpc_schedule_select policy from migration 0010 reads
--
--     using (
--       origin_squadron_id = any (xpc_my_pc_ids())
--       or current_pc_id   = any (xpc_my_pc_ids())
--     )
--
--   PostgREST always emits a RETURNING clause on PATCH (even with
--   `Prefer: return=headers-only`), so the SELECT policy is evaluated
--   against the NEW row. Once the forwarder has re-pointed
--   current_pc_id to the next tier, the new row's current_pc_id is no
--   longer in the forwarder's xpc_my_pc_ids() set, and origin_squadron_id
--   was never theirs to begin with — so the new row is invisible to the
--   forwarder under the SELECT policy and the UPDATE is rejected.
--
--   The xpc_schedule_update USING/WITH CHECK predicates from 0035 are
--   already permissive enough on their own (USING matches the OLD row
--   which the forwarder still owns; WITH CHECK is auth-only). The
--   blocker is purely the SELECT policy fired by RETURNING.
--
-- Fix (Option 1 from the task brief — additive, zero behaviour change
-- for non-chain reads):
--   Extend the SELECT policy with one more disjunct:
--
--     or xpc_my_pc_ids() && chain_pc_ids
--
--   chain_pc_ids (text[], indexed by gin since 0013) accumulates every
--   PC that has handled the share — origin + each forward target — so
--   the forwarder's PC is always in chain_pc_ids by the time RETURNING
--   evaluates the new row. The `&&` (array overlap) operator returns
--   true when any element is shared, which is exactly the policy we
--   want: "you can see the row if you've ever been part of its chain".
--
--   This is read-side only — INSERT/UPDATE/DELETE policies are
--   unchanged. Confidentiality is preserved: a row never enters
--   chain_pc_ids unless the originator or a current holder added it
--   via a legitimate submit/forward action, both of which are gated by
--   their own ownership-checked policies.
--
-- Verification (post-deploy):
--   Re-run audit-evidence/cross-pc-operational/REPORT.md driver — cells
--   A2, A3, A5, A6, A8, M3 should flip from FAIL to PASS, lifting the
--   audit from 50/56 to 56/56 across §A and §M.

begin;

drop policy if exists xpc_schedule_select on public.xpc_schedule_shares;
create policy xpc_schedule_select on public.xpc_schedule_shares
  for select to authenticated
  using (
       origin_squadron_id = any (public.xpc_my_pc_ids())
    or current_pc_id      = any (public.xpc_my_pc_ids())
    or public.xpc_my_pc_ids() && chain_pc_ids
  );

comment on policy xpc_schedule_select on public.xpc_schedule_shares is
  'Task #308: row visible to origin, current holder, or any PC that has '
  'ever been part of the forwarding chain (so PATCH RETURNING does not '
  'reject the forwarder''s UPDATE under the SELECT policy).';

commit;
