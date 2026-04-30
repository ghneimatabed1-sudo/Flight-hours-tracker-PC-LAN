import { useMemo } from "react";
import { Clock } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { useCommanderSnapshotProbe } from "@/lib/cross-pc";

// Per-squadron staleness banner — Round 3 O Part C (task #263).
//
// `<CommanderEmptyState>` already fires when EVERY snapshot the
// commander can read is stale (its `reason === "stale"` branch). That
// banner is aggregate, though: if a commander oversees three squadrons
// and two are publishing fresh snapshots while the third has been
// silent for 36h, the empty-state reasoner stays at `"ok"` and the
// commander has no signal that one of their squadrons is dark.
//
// This banner closes that gap. It walks every snapshot the commander
// can read, filters to the ones they're licensed for, and lists each
// one whose `snapshot_at` is older than the staleness budget — naming
// the squadron and the age. The aggregate banner still owns the
// "everything is stale / nothing has published" cases, so we hide
// ourselves whenever the aggregate banner is also visible.
//
// Mounted on every commander rollup surface (Overview, PilotsTable,
// Currencies, Alerts) so the staleness signal is the same wherever
// the commander is looking.

const SCOPES_ELIGIBLE = new Set(["wing", "base", "hq", "squadron"]);
const STALE_HOURS = 24;

export function SnapshotStalenessBanner() {
  const { user } = useAuth();

  // Gate: must be a commander whose dashboard rolls up multiple
  // squadrons. Squadron-tier commanders licensed to a single squadron
  // get the squadron drill-down's freshness card and don't need a
  // page-level banner.
  const isRollupCommander =
    !!user &&
    user.role === "commander" &&
    !!user.scope &&
    SCOPES_ELIGIBLE.has(user.scope) &&
    (user.scope !== "squadron" || (user.squadronIds ?? []).length > 1);

  // Always wire the hook so call order is stable across renders. The
  // `enabled` flag suppresses the network probe on the no-op path.
  const probe = useCommanderSnapshotProbe({ enabled: isRollupCommander });

  const stale = useMemo(() => {
    if (!isRollupCommander) return [] as Array<{ squadronId: string; ageHours: number }>;
    const authorized = new Set(user?.squadronIds ?? []);
    const now = Date.now();
    const out: Array<{ squadronId: string; ageHours: number }> = [];
    for (const s of probe.snapshots) {
      if (authorized.size > 0 && !authorized.has(s.squadronId)) continue;
      const t = Date.parse(s.snapshotAt);
      if (!Number.isFinite(t)) continue;
      const ageHours = (now - t) / (60 * 60 * 1000);
      if (ageHours > STALE_HOURS) {
        out.push({ squadronId: s.squadronId, ageHours });
      }
    }
    out.sort((a, b) => b.ageHours - a.ageHours);
    return out;
  }, [isRollupCommander, probe.snapshots, user?.squadronIds]);

  if (!isRollupCommander) return null;
  if (stale.length === 0) return null;
  // If EVERY snapshot we can read is stale (or the registry hasn't
  // produced any), `<CommanderEmptyState>` is already showing the
  // page-replacement card / banner — suppress this one to avoid
  // double-warning.
  const visibleSnapshotCount = probe.snapshots.filter(s => {
    const authorized = new Set(user?.squadronIds ?? []);
    return authorized.size === 0 || authorized.has(s.squadronId);
  }).length;
  if (visibleSnapshotCount > 0 && stale.length >= visibleSnapshotCount) return null;

  return (
    <div
      className="rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100 p-3 text-sm flex items-start gap-3"
      data-testid="snapshot-staleness-banner"
      role="status"
    >
      <Clock className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
      <div className="min-w-0">
        <div className="font-semibold mb-1">
          Snapshot{stale.length === 1 ? "" : "s"} stale ({STALE_HOURS}h+)
        </div>
        <div className="text-foreground/90">
          {stale.length === 1
            ? "One squadron's snapshot is older than the freshness budget — its Ops PC may be offline. Numbers below for that squadron may not reflect the current operational picture."
            : `${stale.length} squadrons' snapshots are older than the freshness budget — their Ops PCs may be offline. Numbers below for these squadrons may not reflect the current operational picture.`}
        </div>
        <ul className="mt-2 space-y-0.5 text-xs font-mono">
          {stale.map(s => (
            <li key={s.squadronId} data-testid={`snapshot-stale-row-${s.squadronId}`}>
              <span className="font-semibold">{s.squadronId}</span> —{" "}
              {Math.round(s.ageHours)}h old
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
