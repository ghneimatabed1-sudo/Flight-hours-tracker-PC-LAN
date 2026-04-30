// artifacts/pilot-dashboard/src/lib/pilot-transfer-policy.ts
//
// Shared predicates for the inter-squadron pilot-transfer flow
// (migration 0053 + RPC `public.transfer_pilot`).
//
// Both Roster.tsx and PilotDetail.tsx render a "Transfer" button
// gated on the signed-in user's role, and TransferPilotDialog
// filters its destination dropdown to exclude the source squadron.
// Those two predicates are also asserted by the regression test
// `supabase/tests/test-pilot-transfer-rpc.ts`.
//
// They live here — instead of being inlined at each call site —
// so the test imports the SAME function the UI uses. Without this
// shared module, drift in either copy (e.g. someone allows
// commanders to transfer, or someone widens the dropdown filter
// to include the source squadron) could land without failing the
// test, since the test would be checking its own duplicate.
//
// Intentional design rules baked in here:
//
//   * canTransferPilot: ops, deputy, admin, super_admin only.
//     Squadron commanders are deliberately read-mostly for
//     roster moves — promotion-and-transfer is an orderly-room
//     (ops) paperwork action per RJAF practice. Plain pilots
//     never see the button.
//
//   * transferDestinationCandidates: excludes the source
//     squadron because transferring a pilot to the squadron
//     they're already in would be a no-op and the SECURITY
//     DEFINER RPC rejects it server-side (sqlstate 22023). The
//     UI filter is the friendly first line of defence; the RPC
//     check is the backstop.

import type { Role, User } from "./types";

const TRANSFER_ROLES: ReadonlySet<Role> = new Set<Role>([
  "ops",
  "deputy",
  "admin",
  "super_admin",
]);

/**
 * True iff the signed-in user is allowed to move a pilot between
 * squadrons. See module header for the role rationale.
 */
export function canTransferPilot(user: User | null | undefined): boolean {
  if (!user) return false;
  return TRANSFER_ROLES.has(user.role);
}

/**
 * Squadron picker entries shown by TransferPilotDialog. The
 * source squadron is filtered out so the operator can't pick
 * the squadron the pilot is already in.
 */
export function transferDestinationCandidates<
  S extends { id: string },
>(squadrons: readonly S[], fromSquadronId: string | undefined): S[] {
  return squadrons.filter(s => s.id !== fromSquadronId);
}
