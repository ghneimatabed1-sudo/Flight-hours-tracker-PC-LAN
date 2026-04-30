// Per-PC HQ / multi-squadron scope picker.
//
// Wing, base, HQ commanders — and squadron commanders provisioned to
// oversee 2–3 squadrons (Task #26 part 1) — see a "Squadron scope"
// dropdown in the dashboard topbar (Layout). Picking a single squadron
// narrows Overview / Pilots / Currencies / Alerts to that squadron only.
// Picking "Combined" restores the union over every authorized squadron
// (the historic default).
//
// Persistence is per-PC via localStorage so the operator's last choice
// survives page reloads and tab switches without bleeding to other
// stations. The hook listens to both same-tab CustomEvents and the
// cross-tab "storage" event so a change in the Layout topbar flows
// instantly to every page that reads the scope.
//
// If the persisted scope refers to a squadron the operator no longer
// has access to (e.g. license updated, squadron removed), `effectiveScope`
// transparently falls back to "__all" — we never narrow to an empty
// universe by accident.

import { useEffect, useState } from "react";

export const SCOPE_ALL = "__all" as const;
export type SquadronScope = string; // either SCOPE_ALL or a squadron id.

const LS_KEY = "rjaf.dashboard.squadronScope";
const EVT = "rjaf:squadron-scope";

export function getSquadronScope(): SquadronScope {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw && raw.length > 0 ? raw : SCOPE_ALL;
  } catch {
    return SCOPE_ALL;
  }
}

export function setSquadronScope(next: SquadronScope): void {
  try {
    if (next === SCOPE_ALL) {
      localStorage.removeItem(LS_KEY);
    } else {
      localStorage.setItem(LS_KEY, next);
    }
  } catch {
    /* storage may be blocked — same-tab listeners still fire below */
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVT, { detail: next }));
  }
}

// Reactive read of the persisted scope. Re-renders on same-tab updates
// (CustomEvent) and on cross-tab updates (storage event).
export function useSquadronScope(): [SquadronScope, (s: SquadronScope) => void] {
  const [scope, setScope] = useState<SquadronScope>(() => getSquadronScope());
  useEffect(() => {
    const onChange = () => setScope(getSquadronScope());
    window.addEventListener(EVT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(EVT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return [scope, (next) => { setSquadronScope(next); setScope(next); }];
}

// Resolve the persisted scope against the operator's authorized squadron
// list and return the squadron ids the dashboard should consider "in
// scope" right now. Called by Overview / Pilots / Currencies / Alerts.
//
// Rules:
//   • Combined / unset / unknown id    → every authorized squadron.
//   • Single squadron in the list      → just that one.
// Multi-squadron commanders with only one authorized squadron see no
// switcher (Layout hides it) so this always collapses to the union.
export function resolveScopedIds(
  scope: SquadronScope,
  authorizedIds: readonly string[] | undefined,
): string[] {
  const ids = authorizedIds ?? [];
  if (scope === SCOPE_ALL) return [...ids];
  return ids.includes(scope) ? [scope] : [...ids];
}
