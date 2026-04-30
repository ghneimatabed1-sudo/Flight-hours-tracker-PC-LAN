-- v1.1.60: widen DELETE policy on xpc_schedule_shares.
--
-- Previous policy restricted DELETE to the originating PC only
-- (origin_squadron_id = ANY (xpc_my_pc_ids())), which meant a
-- Squadron Cmdr / Wing / Base / HQ that received a schedule could
-- not remove a stale or wrongly-sent sheet from the shared chain
-- — only the PC that authored it could. Operationally this leaves
-- garbage rows on every downstream PC's screen.
--
-- New policy mirrors SELECT/UPDATE: any PC that the share has
-- touched (originator OR current chain holder) may delete it. This
-- matches how the rest of the chain works — every participating
-- PC has equal authority to reject/edit/forward — and lets any
-- role wipe a bad share from every screen with one click.

drop policy if exists xpc_schedule_delete on public.xpc_schedule_shares;

create policy xpc_schedule_delete
  on public.xpc_schedule_shares
  for delete
  using (
    origin_squadron_id = any (xpc_my_pc_ids())
    or current_pc_id = any (xpc_my_pc_ids())
  );
