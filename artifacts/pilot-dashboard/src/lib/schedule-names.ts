import type { Pilot } from "@/lib/mock";

/**
 * Canonical schedule identity: always prefer the roster Flight Name.
 * We intentionally avoid falling back to full pilot name for schedule rows.
 */
export function preferredSchedulePilotName(p: Pilot): string {
  const flight = (p.flightName ?? "").trim();
  if (flight) return flight;
  const callSign = (p.callSign ?? "").trim();
  if (callSign) return callSign;
  return p.id;
}
