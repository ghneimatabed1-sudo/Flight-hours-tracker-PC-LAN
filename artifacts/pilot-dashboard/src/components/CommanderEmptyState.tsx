import { useAuth } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Clock, ServerCrash, Users } from "lucide-react";
import {
  computeCommanderEmptyState,
  renderCommanderEmptyCopy,
  type EmptyStateScope,
  type EmptyStateSurface,
} from "@/lib/commander-empty-state";
import { useCommanderSnapshotProbe } from "@/lib/cross-pc";

// "Why is my dashboard empty?" affordance for Wing / Base / HQ
// commanders (audit finding F-B-01 in B-commander.md §6).
//
// These tiers carry `squadron_id = NULL` in their JWT, so RLS on
// `pilots` / `sorties` returns zero rows for them by design. They are
// supposed to consume aggregated reads from xpc_squadron_snapshot,
// populated by the squadron-tier ops PCs. Without an empty-state
// affordance a freshly provisioned wing commander sees a blank Pilots
// list and reasonably concludes the system is broken.
//
// We render four distinct messages depending on which of the four
// documented failure modes the squadron ecosystem is in. The reasoner
// (`computeCommanderEmptyState`) lives in pure-function form for
// driven tests; this component just maps the reason code to copy.
//
// `compact=true` swaps the in-page card for a slimmer warning banner —
// used on PilotsTable where we want to keep the table chrome visible
// even while the underlying snapshot is stale.

interface Props {
  /** Which page is rendering us — used only to colour the copy
   *  ("zero pilots", "zero alerts", ...) so the explanation reads
   *  naturally on the page the operator is staring at. */
  surface: EmptyStateSurface;
  /** Render the slim warning banner (above content) instead of the
   *  full-card empty-state replacement. Default false. */
  compact?: boolean;
}

const SCOPES_ELIGIBLE = new Set(["wing", "base", "hq"]);

export function CommanderEmptyState({ surface, compact = false }: Props) {
  const { user } = useAuth();
  const isMultiSquadronCommander =
    !!user &&
    user.role === "commander" &&
    !!user.scope &&
    SCOPES_ELIGIBLE.has(user.scope);

  // Always call the hook to keep call order stable across renders, but
  // disable the network probe when this commander tier wouldn't render.
  const probe = useCommanderSnapshotProbe({ enabled: isMultiSquadronCommander });

  if (!isMultiSquadronCommander) return null;

  const state = computeCommanderEmptyState({
    registeredSquadronCount: probe.registeredSquadronCount,
    snapshots: probe.snapshots,
  });

  if (state.reason === "ok") return null;
  // Hide while the queries are still in-flight on first paint so we
  // don't flash "no squadron PC registered" to a commander whose
  // registry response is just slow.
  if (probe.isLoading && state.reason === "no_registry") return null;

  const scope = user.scope as EmptyStateScope;
  const text = renderCommanderEmptyCopy(state, surface, scope);
  const tone = TONES_BY_REASON[state.reason] ?? TONES.slate;
  const Icon = ICONS_BY_REASON[state.reason] ?? AlertCircle;
  const copy = { ...text, Icon, tone };

  if (compact) {
    return (
      <div
        className={`rounded-md border ${copy.tone.banner} p-3 text-sm flex items-start gap-3`}
        data-testid={`commander-empty-banner-${state.reason}`}
        role="status"
      >
        <copy.Icon className={`h-4 w-4 mt-0.5 shrink-0 ${copy.tone.icon}`} />
        <div className="min-w-0">
          <div className="font-semibold mb-0.5">{copy.title}</div>
          <div className={copy.tone.body}>{copy.body}</div>
          {copy.action && (
            <div className={`mt-1 text-xs ${copy.tone.action}`}>
              {copy.action}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <Card
      data-testid={`commander-empty-${state.reason}`}
      className={copy.tone.card}
    >
      <CardContent className="p-6 flex items-start gap-4">
        <div
          className={`rounded-md p-2 ${copy.tone.iconWrap}`}
          aria-hidden
        >
          <copy.Icon className={`h-6 w-6 ${copy.tone.icon}`} />
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="text-base font-semibold">{copy.title}</div>
          <div className={`text-sm ${copy.tone.body}`}>{copy.body}</div>
          {copy.action && (
            <div className={`text-sm font-medium ${copy.tone.action}`}>
              {copy.action}
            </div>
          )}
          {copy.diagnostics && (
            <div className="text-xs text-muted-foreground pt-1 font-mono">
              {copy.diagnostics}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// Per-reason visual treatment. Copy comes from
// `renderCommanderEmptyCopy` so the four reason × four surface ×
// three scope combinations can be unit-tested without React; this
// component just adds the icon + tone palette.
const TONES = {
  amber: {
    card: "border-amber-500/40 bg-amber-500/5",
    iconWrap: "bg-amber-500/15",
    icon: "text-amber-500",
    body: "text-foreground/90",
    action: "text-amber-700 dark:text-amber-300",
    banner:
      "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100",
  },
  sky: {
    card: "border-sky-500/40 bg-sky-500/5",
    iconWrap: "bg-sky-500/15",
    icon: "text-sky-500",
    body: "text-foreground/90",
    action: "text-sky-700 dark:text-sky-300",
    banner: "border-sky-500/40 bg-sky-500/10 text-sky-900 dark:text-sky-100",
  },
  slate: {
    card: "border-border bg-secondary/40",
    iconWrap: "bg-secondary",
    icon: "text-muted-foreground",
    body: "text-muted-foreground",
    action: "text-foreground",
    banner: "border-border bg-secondary/40 text-muted-foreground",
  },
};

const TONES_BY_REASON: Record<string, typeof TONES.amber> = {
  no_registry: TONES.amber,
  no_snapshots: TONES.amber,
  stale: TONES.amber,
  empty: TONES.sky,
};

const ICONS_BY_REASON: Record<string, typeof AlertCircle> = {
  no_registry: ServerCrash,
  no_snapshots: ServerCrash,
  stale: Clock,
  empty: Users,
};
