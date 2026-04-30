// Pure logic for the Wing / Base / HQ commander "why is my dashboard
// empty?" affordance.
//
// Background (audit finding F-B-01, .local/reports audit B-commander §6).
// A freshly provisioned Wing, Base, or HQ commander signing into the
// Pilot Dashboard sees zero pilots / zero squadrons / zero alerts /
// zero currencies on every operational page. This is by design — RLS
// on `pilots` / `sorties` / `audit_log` keys off
// `squadron_id() = JWT.squadron_id`, and these multi-squadron tiers
// carry `squadron_id = NULL` in their JWT. They are intended to consume
// aggregated reads via `xpc_squadron_snapshot`, populated by the
// squadron-tier ops PCs.
//
// Before this helper existed, there was no UI affordance distinguishing
// "no squadron PC has published a snapshot yet" from "RLS hid every
// pilot row from you". A new wing commander would open the dashboard,
// see a blank Pilots list, and reasonably conclude the system is
// broken.
//
// `computeCommanderEmptyState` classifies the cause into one of four
// reason codes so the UI can render an explicit, actionable message:
//
//   • no_registry  — no squadron-tier PC has registered in
//                    `xpc_registry` yet. The wing/base/HQ commander is
//                    the first PC online and there is literally nobody
//                    to publish a snapshot. → "Register a squadron PC."
//   • no_snapshots — squadron PCs are registered but none has published
//                    a row to `xpc_squadron_snapshot` yet. Usually
//                    means the squadron Ops PC is new and has not run
//                    its publish loop, or RLS rejected the publish.
//                    → "Squadron PCs registered but none has published
//                    a daily snapshot yet."
//   • stale        — at least one snapshot exists but the most recent
//                    one is older than `staleHours`. The squadron Ops
//                    PC may be offline. → "Snapshot is N hours old —
//                    squadron PC may be offline."
//   • empty        — snapshots exist and are fresh, but the rolled-up
//                    pilot count is zero. The squadrons have genuinely
//                    empty rosters. → "Squadrons have no pilots
//                    enrolled yet."
//   • ok           — a fresh snapshot with at least one pilot exists.
//                    UI should not render the empty-state explainer.
//
// Kept as a pure function (no React, no Supabase) so it can be unit
// tested with simple inputs covering every branch.

export type CommanderEmptyReason =
  | "ok"
  | "no_registry"
  | "no_snapshots"
  | "stale"
  | "empty";

export interface CommanderEmptyStateInput {
  /** How many squadron-tier PCs are in `xpc_registry` and visible to
   *  this commander. Wing/Base/HQ should see at least one for any
   *  squadron in their span. */
  registeredSquadronCount: number;
  /** One row per published snapshot the commander can read. */
  snapshots: Array<{
    squadronId: string;
    snapshotAt: string;
    pilotCount: number;
  }>;
  /** How many hours old the newest snapshot must be before we surface
   *  the "stale" warning. Defaults to 24h (snapshots are nominally
   *  daily). */
  staleHours?: number;
  /** Override for tests — defaults to `Date.now()`. */
  now?: number;
}

export interface CommanderEmptyState {
  reason: CommanderEmptyReason;
  registeredSquadronCount: number;
  snapshotCount: number;
  /** ISO timestamp of the most recent snapshot the commander can read,
   *  or null if none. */
  latestSnapshotAt: string | null;
  /** Hours since `latestSnapshotAt`. null if no snapshots. */
  ageHours: number | null;
  /** Sum of pilot counts across every visible snapshot. */
  totalPilots: number;
  staleHours: number;
}

const DEFAULT_STALE_HOURS = 24;

export function computeCommanderEmptyState(
  input: CommanderEmptyStateInput,
): CommanderEmptyState {
  const staleHours = input.staleHours ?? DEFAULT_STALE_HOURS;
  const now = input.now ?? Date.now();
  const snapshots = input.snapshots ?? [];
  const snapshotCount = snapshots.length;
  const totalPilots = snapshots.reduce(
    (acc, s) => acc + (Number.isFinite(s.pilotCount) ? s.pilotCount : 0),
    0,
  );
  let latestMs = 0;
  let latestIso: string | null = null;
  for (const s of snapshots) {
    const t = Date.parse(s.snapshotAt);
    if (Number.isFinite(t) && t > latestMs) {
      latestMs = t;
      latestIso = s.snapshotAt;
    }
  }
  const ageHours = latestMs > 0 ? (now - latestMs) / (60 * 60 * 1000) : null;

  let reason: CommanderEmptyReason;
  if (input.registeredSquadronCount <= 0) {
    // Nobody has even registered a squadron PC. Wing/Base/HQ tiers are
    // the first ones online and have nothing to aggregate.
    reason = "no_registry";
  } else if (snapshotCount === 0) {
    // Squadron PCs exist but none has published. Usually a fresh
    // install where the Ops PC has not run its publish loop yet, or
    // the publish was silently rejected by RLS.
    reason = "no_snapshots";
  } else if (ageHours !== null && ageHours > staleHours) {
    // Newest snapshot is older than the freshness budget. Squadron Ops
    // PC may be offline — surface the age so the commander can phone.
    reason = "stale";
  } else if (totalPilots <= 0) {
    // Snapshots are recent but the rolled-up rosters are empty. The
    // squadrons have genuinely no pilots enrolled.
    reason = "empty";
  } else {
    reason = "ok";
  }

  return {
    reason,
    registeredSquadronCount: Math.max(0, input.registeredSquadronCount | 0),
    snapshotCount,
    latestSnapshotAt: latestIso,
    ageHours,
    totalPilots,
    staleHours,
  };
}

// ---------------------------------------------------------------------
// Copy renderer (audit F-B-01 closing requirement).
// ---------------------------------------------------------------------
// Translates a CommanderEmptyState + the page surface + the commander's
// scope into the human-readable strings the UI shows. Kept as a pure
// function (no React, no JSX) so the four reason × four surface ×
// three scope combinations can be asserted from a node:test driver
// without standing up jsdom.
//
// The companion React component (`CommanderEmptyState.tsx`) calls this
// helper and just chooses an icon + tone by reason.

export type EmptyStateSurface = "overview" | "pilots" | "alerts" | "currencies";
export type EmptyStateScope = "wing" | "base" | "hq";

export interface CommanderEmptyCopy {
  /** Short headline. */
  title: string;
  /** Explanation paragraph referring to the surface and scope. */
  body: string;
  /** What the commander (or whoever) should do next. */
  action?: string;
  /** Diagnostics line for ops triage (registry / snapshot counts). */
  diagnostics?: string;
}

function tierLabel(scope: EmptyStateScope): string {
  if (scope === "hq") return "HQ";
  if (scope === "wing") return "Wing";
  if (scope === "base") return "Base";
  return scope;
}

function nounForSurface(surface: EmptyStateSurface): string {
  if (surface === "pilots") return "pilots";
  if (surface === "alerts") return "currency alerts";
  if (surface === "currencies") return "currency rows";
  return "squadron data";
}

export function renderCommanderEmptyCopy(
  state: CommanderEmptyState,
  surface: EmptyStateSurface,
  scope: EmptyStateScope,
): CommanderEmptyCopy {
  const noun = nounForSurface(surface);
  const tier = tierLabel(scope);

  if (state.reason === "no_registry") {
    return {
      title: "No squadron PC has registered yet",
      body:
        `${tier} commanders don't own a single squadron's local data — your dashboard is fed by daily snapshots that each squadron's Ops PC publishes. ` +
        `Right now no squadron PC is signed in to the central registry, so there are no ${noun} to roll up.`,
      action:
        "Ask a squadron Ops officer to sign in and register their PC. The dashboard will populate within a minute of the first snapshot publish.",
      diagnostics: "xpc_registry: 0 squadron PCs · xpc_squadron_snapshot: 0 rows",
    };
  }

  if (state.reason === "no_snapshots") {
    const c = state.registeredSquadronCount;
    return {
      title: "Squadron PCs registered, no daily snapshot yet",
      body:
        `${c} squadron PC${c === 1 ? " is" : "s are"} signed in to the central registry, but none has published a snapshot to xpc_squadron_snapshot yet. ` +
        `Until a publish happens you will see no ${noun} on this page.`,
      action:
        "On the squadron's Ops PC, confirm a roster has been entered and the publish loop is running. A failed publish is recorded in the central audit log under xpc.squadron.snapshot.publish.error.",
      diagnostics: `xpc_registry: ${c} squadron PC${c === 1 ? "" : "s"} · xpc_squadron_snapshot: 0 rows`,
    };
  }

  if (state.reason === "stale") {
    const ageHours = Math.round(state.ageHours ?? 0);
    return {
      title: "Snapshot data is stale",
      body:
        `The most recent snapshot any squadron has published is ${ageHours} hour${ageHours === 1 ? "" : "s"} old ` +
        `(threshold: ${state.staleHours}h). The squadron's Ops PC may be offline or off the network — ` +
        `the ${noun} you see below may no longer reflect the current operational picture.`,
      action:
        "Check whether the squadron Ops PCs are online (Overview → squadron card status dot). Phone the squadron if the dot is grey.",
      diagnostics: `Latest snapshot: ${state.latestSnapshotAt ?? "—"} · ${state.snapshotCount} snapshot row${state.snapshotCount === 1 ? "" : "s"} from ${state.registeredSquadronCount} registered PC${state.registeredSquadronCount === 1 ? "" : "s"}`,
    };
  }

  if (state.reason === "empty") {
    return {
      title: "Snapshots are fresh — squadrons report no pilots",
      body:
        `Every registered squadron has published a recent snapshot, but the rolled-up roster is empty. ` +
        `This means the squadrons under your ${tier.toLowerCase()} have no pilots enrolled yet, so there are no ${noun} to display.`,
      action:
        "Once a squadron Ops officer enrols pilots locally and the next snapshot publishes, this page will populate automatically.",
      diagnostics: `${state.snapshotCount} snapshot row${state.snapshotCount === 1 ? "" : "s"} · ${state.totalPilots} pilots total`,
    };
  }

  // reason === "ok": defensive fallback. Callers should not invoke
  // this for the OK case (the UI hides the banner entirely).
  return { title: "", body: "" };
}
