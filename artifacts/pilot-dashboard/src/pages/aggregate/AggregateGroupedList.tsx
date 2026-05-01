// Shared layout for the aggregator-mode read pages.
//
// Fetches `/api/aggregate/<kind>` once on mount, groups the resulting
// rows by `squadron_name` (falling back to `squadron_id` when the
// peer didn't report a friendly name), and renders each group with a
// sticky sub-header. Above the table sits the offline-peers banner so
// the operator can see at a glance which squadrons couldn't be
// reached and how stale their cached rows are.
//
// Per-resource columns are intentionally generic — the page renders
// every primitive field on the row in a definition list. Per-kind
// dedicated views will follow once the squadron data shapes settle;
// today the goal is to surface honest cross-squadron data, even if
// the presentation is utilitarian.

import { useEffect, useMemo, useState } from "react";
import {
  fetchAggregateRows,
  type AggregateRow,
  type AggregateRowKind,
  type PeerHealthStatus,
} from "@/lib/internal-migration";
import OfflinePeersBanner from "@/components/OfflinePeersBanner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RefreshCw, Server } from "lucide-react";
import { useI18n } from "@/lib/i18n";

interface Props {
  kind: AggregateRowKind;
  /** i18n key for the page heading. */
  titleKey: Parameters<ReturnType<typeof useI18n>["t"]>[0];
}

interface State {
  loaded: boolean;
  items: AggregateRow[];
  peers: PeerHealthStatus[];
  error: string | null;
}

const FIELD_HIDE = new Set([
  "source_peer_id",
  "squadron_id",
  "squadron_name",
]);

function groupBySquadron(items: AggregateRow[]): Map<string, AggregateRow[]> {
  const out = new Map<string, AggregateRow[]>();
  for (const row of items) {
    const key =
      (typeof row.squadron_name === "string" && row.squadron_name) ||
      (typeof row.squadron_id === "string" && row.squadron_id) ||
      "—";
    const list = out.get(key) ?? [];
    list.push(row);
    out.set(key, list);
  }
  return out;
}

function rowFields(row: AggregateRow): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = [];
  for (const k of Object.keys(row)) {
    if (FIELD_HIDE.has(k)) continue;
    const v = row[k];
    if (v == null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out.push({ key: k, value: String(v) });
    } else {
      // Truncate complex values so a deep object can't blow the cell.
      const s = JSON.stringify(v);
      out.push({ key: k, value: s.length > 240 ? `${s.slice(0, 240)}…` : s });
    }
  }
  return out;
}

export function AggregateGroupedList({ kind, titleKey }: Props) {
  const { t } = useI18n();
  const [state, setState] = useState<State>({
    loaded: false,
    items: [],
    peers: [],
    error: null,
  });
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetchAggregateRows(kind);
        if (cancelled) return;
        if (r === null) {
          setState({
            loaded: true,
            items: [],
            peers: [],
            error: "unavailable",
          });
        } else {
          setState({
            loaded: true,
            items: r.items,
            peers: r.peers,
            error: null,
          });
        }
      } catch (e) {
        if (cancelled) return;
        setState({
          loaded: true,
          items: [],
          peers: [],
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, reloadTick]);

  const groups = useMemo(() => groupBySquadron(state.items), [state.items]);

  return (
    <div className="space-y-3" data-testid={`aggregate-page-${kind}`}>
      <div className="flex items-center gap-2">
        <Server className="h-5 w-5 text-amber-300" />
        <h1 className="text-xl font-semibold flex-1">{t(titleKey)}</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setReloadTick(x => x + 1)}
          data-testid="aggregate-refresh"
        >
          <RefreshCw className="h-4 w-4 me-1" />
          {t("refresh")}
        </Button>
      </div>

      <OfflinePeersBanner peers={state.peers} />

      {!state.loaded && (
        <Card><CardContent className="py-6 text-sm text-muted-foreground">{t("loading")}</CardContent></Card>
      )}
      {state.loaded && state.error === "unavailable" && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            {t("aggregateUnavailable")}
          </CardContent>
        </Card>
      )}
      {state.loaded && state.error && state.error !== "unavailable" && (
        <Card>
          <CardContent className="py-6 text-sm text-rose-300">
            {state.error}
          </CardContent>
        </Card>
      )}
      {state.loaded && state.items.length === 0 && state.error === null && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            {t("aggregateEmpty")}
          </CardContent>
        </Card>
      )}

      {Array.from(groups.entries()).map(([sqn, rows]) => (
        <section
          key={sqn}
          className="rounded-md border border-border bg-card"
          data-testid={`aggregate-group-${sqn}`}
        >
          <header className="sticky top-0 z-10 bg-card/95 backdrop-blur px-3 py-2 border-b border-border flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-muted-foreground">
              {t("squadron")}
            </span>
            <span className="font-medium">{sqn}</span>
            <span className="ms-auto text-xs text-muted-foreground">
              {rows.length} {t("rows")}
            </span>
          </header>
          <ul className="divide-y divide-border">
            {rows.map((row, idx) => {
              const fields = rowFields(row);
              const id =
                typeof row.id === "string" || typeof row.id === "number"
                  ? String(row.id)
                  : `r${idx}`;
              return (
                <li
                  key={`${id}-${idx}`}
                  className="px-3 py-2 text-sm grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1"
                >
                  {fields.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    fields.map(f => (
                      <div key={f.key} className="min-w-0 truncate">
                        <span className="text-muted-foreground">{f.key}: </span>
                        <span>{f.value}</span>
                      </div>
                    ))
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default AggregateGroupedList;
