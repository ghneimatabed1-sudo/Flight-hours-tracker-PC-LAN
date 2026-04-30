import { useEffect, useMemo, useState } from "react";
import { Card, PageHead } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { Plus, Trash2, Map, Save, Printer, ArrowUp, ArrowDown } from "lucide-react";

/**
 * Nav Routes — manual builder.
 *
 * Up to 20 routes. Each route has a name, an ordered list of up to
 * MAX_WAYPOINTS waypoints (just the waypoint name + leg time in minutes —
 * no lat/lon, no notes), and a derived total flight time computed by
 * summing per-leg minutes the operator types into each waypoint cell.
 *
 * Each waypoint is rendered as its own small card laid out side-by-side
 * (a horizontal flex-wrap row), so the operator can see the whole leg
 * sequence at a glance: WP1 ▸ WP2 ▸ WP3 ▸ … up to MAX_WAYPOINTS.
 *
 * Stored locally so any commander/ops officer can maintain their own
 * working set on this PC; printable for crew briefs. Lat/lon and notes
 * fields on legacy stored routes are silently ignored on render but
 * preserved in the JSON so older sheets aren't destroyed.
 *
 * Storage: rjaf.navRoutes.v1
 */

const STORAGE_KEY = "rjaf.navRoutes.v1";
const MAX_ROUTES = 20;
const MAX_WAYPOINTS = 15;

interface Waypoint {
  id: string;
  name: string;
  legMin: number;
  /** Legacy fields — preserved on disk for older saves but not rendered. */
  lat?: string;
  lon?: string;
  notes?: string;
}
interface NavRoute { id: string; name: string; aircraft: string; description: string; waypoints: Waypoint[]; }

function emptyWp(): Waypoint { return { id: crypto.randomUUID(), name: "", legMin: 0 }; }
function emptyRoute(): NavRoute { return { id: crypto.randomUUID(), name: "New Route", aircraft: "UH-60M", description: "", waypoints: [emptyWp(), emptyWp()] }; }

function load(): NavRoute[] {
  try { const raw = localStorage.getItem(STORAGE_KEY); if (raw) return JSON.parse(raw); } catch { /* */ }
  return [];
}

function fmtHours(mins: number): string {
  if (!mins) return "0:00";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

export default function NavRoutes() {
  const { t } = useI18n();
  const [routes, setRoutes] = useState<NavRoute[]>(() => load());
  const [activeId, setActiveId] = useState<string | null>(() => {
    const r = load(); return r[0]?.id ?? null;
  });
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(routes)); }, [routes]);

  const active = useMemo(() => routes.find(r => r.id === activeId) ?? null, [routes, activeId]);
  const totalMin = active ? active.waypoints.reduce((a, w) => a + (Number(w.legMin) || 0), 0) : 0;

  function addRoute() {
    if (routes.length >= MAX_ROUTES) {
      alert(`Maximum ${MAX_ROUTES} routes.`);
      return;
    }
    const r = emptyRoute();
    setRoutes(prev => [...prev, r]);
    setActiveId(r.id);
  }
  function removeRoute(id: string) {
    if (!confirm("Delete this route?")) return;
    setRoutes(prev => prev.filter(r => r.id !== id));
    if (activeId === id) setActiveId(routes.find(r => r.id !== id)?.id ?? null);
  }
  function updateRoute(id: string, patch: Partial<NavRoute>) {
    setRoutes(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r));
  }
  function updateWp(routeId: string, wpId: string, patch: Partial<Waypoint>) {
    setRoutes(prev => prev.map(r => r.id !== routeId ? r : ({
      ...r,
      waypoints: r.waypoints.map(w => w.id === wpId ? { ...w, ...patch } : w),
    })));
  }
  function addWp(routeId: string) {
    setRoutes(prev => prev.map(r => {
      if (r.id !== routeId) return r;
      if (r.waypoints.length >= MAX_WAYPOINTS) {
        alert(`Maximum ${MAX_WAYPOINTS} waypoints per route.`);
        return r;
      }
      return { ...r, waypoints: [...r.waypoints, emptyWp()] };
    }));
  }
  function removeWp(routeId: string, wpId: string) {
    setRoutes(prev => prev.map(r => r.id !== routeId ? r : ({ ...r, waypoints: r.waypoints.filter(w => w.id !== wpId) })));
  }
  // Reorder helpers — required by spec ("Editable (rename, reorder, change
  // hours, delete)"). We swap adjacent elements in-place rather than using
  // drag-and-drop so the UX is keyboard- and touch-friendly without a
  // dependency on a DnD library.
  function moveRoute(id: string, dir: -1 | 1) {
    setRoutes(prev => {
      const i = prev.findIndex(r => r.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }
  function moveWp(routeId: string, wpId: string, dir: -1 | 1) {
    setRoutes(prev => prev.map(r => {
      if (r.id !== routeId) return r;
      const i = r.waypoints.findIndex(w => w.id === wpId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= r.waypoints.length) return r;
      const wps = r.waypoints.slice();
      [wps[i], wps[j]] = [wps[j], wps[i]];
      return { ...r, waypoints: wps };
    }));
  }
  function flashSaved() { setSavedFlash(true); setTimeout(() => setSavedFlash(false), 1200); }

  return (
    <div className="print-area">
      <PageHead
        title={t("nav_navroutes")}
        subtitle={`Manual route builder · up to ${MAX_ROUTES} routes`}
        actions={
          <div className="flex gap-2 print:hidden">
            <Button size="sm" variant="outline" onClick={() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(routes)); flashSaved(); }} data-testid="button-routes-save">
              <Save className="h-4 w-4 me-1" /> Save
            </Button>
            <Button size="sm" variant="outline" onClick={() => window.print()} data-testid="button-routes-print">
              <Printer className="h-4 w-4 me-1" /> Print
            </Button>
            <Button size="sm" onClick={addRoute} disabled={routes.length >= MAX_ROUTES} data-testid="button-add-route">
              <Plus className="h-4 w-4 me-1" /> Add Route ({routes.length}/{MAX_ROUTES})
            </Button>
            {savedFlash && <span className="self-center text-xs text-emerald-500">Saved ✓</span>}
          </div>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
        <Card className="!p-2">
          {routes.length === 0 ? (
            <div className="p-4 text-center text-xs text-muted-foreground">
              <Map className="h-10 w-10 mx-auto mb-2 text-amber-400" />
              No routes yet. Click "Add Route" to build one.
            </div>
          ) : (
            <ul className="space-y-1" data-testid="list-routes">
              {routes.map((r, idx) => {
                const mins = r.waypoints.reduce((a, w) => a + (Number(w.legMin) || 0), 0);
                return (
                  <li key={r.id}>
                    <div
                      className={`w-full px-2 py-2 rounded-md flex items-center gap-1 ${activeId === r.id ? "bg-primary/20 border border-primary/40" : "hover:bg-secondary/50"}`}
                    >
                      <div className="flex flex-col gap-0.5 shrink-0">
                        <button
                          onClick={(e) => { e.stopPropagation(); moveRoute(r.id, -1); }}
                          disabled={idx === 0}
                          className="p-0.5 rounded hover:bg-secondary disabled:opacity-30"
                          title="Move up"
                          data-testid={`button-route-up-${r.id}`}
                        >
                          <ArrowUp className="h-3 w-3" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); moveRoute(r.id, 1); }}
                          disabled={idx === routes.length - 1}
                          className="p-0.5 rounded hover:bg-secondary disabled:opacity-30"
                          title="Move down"
                          data-testid={`button-route-down-${r.id}`}
                        >
                          <ArrowDown className="h-3 w-3" />
                        </button>
                      </div>
                      <button
                        onClick={() => setActiveId(r.id)}
                        className="flex-1 min-w-0 text-left"
                        data-testid={`button-route-${r.id}`}
                      >
                        <div className="text-sm font-semibold truncate">{r.name || "Untitled"}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {r.waypoints.length} WP · {fmtHours(mins)}
                        </div>
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeRoute(r.id); }}
                        className="p-1 rounded hover:bg-destructive/20 text-destructive shrink-0"
                        title="Delete"
                        data-testid={`button-delete-route-${r.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        {active ? (
          <Card>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
              <label className="text-xs"><span className="text-muted-foreground">Route Name</span>
                <input
                  value={active.name}
                  onChange={e => updateRoute(active.id, { name: e.target.value })}
                  className="w-full mt-1 px-2 py-1.5 rounded bg-input border border-border text-sm font-semibold"
                  data-testid="input-route-name"
                />
              </label>
              <label className="text-xs"><span className="text-muted-foreground">Aircraft</span>
                <input
                  value={active.aircraft}
                  onChange={e => updateRoute(active.id, { aircraft: e.target.value })}
                  className="w-full mt-1 px-2 py-1.5 rounded bg-input border border-border text-sm"
                  data-testid="input-route-aircraft"
                />
              </label>
              <label className="text-xs"><span className="text-muted-foreground">Description</span>
                <input
                  value={active.description}
                  onChange={e => updateRoute(active.id, { description: e.target.value })}
                  className="w-full mt-1 px-2 py-1.5 rounded bg-input border border-border text-sm"
                  data-testid="input-route-description"
                />
              </label>
            </div>

            {/* Horizontal leg strip — each waypoint is its own small card
                rendered side-by-side with the next, wrapping to the next
                line when the row fills up. WP1 ▸ WP2 ▸ WP3 ▸ … with the
                little chevrons making the leg flow obvious. Each card has
                the waypoint name on top and the leg-time (minutes from
                the previous waypoint) below it. */}
            <div className="flex flex-wrap items-stretch gap-1.5" data-testid="waypoint-strip">
              {active.waypoints.map((w, i) => (
                <div key={w.id} className="flex items-stretch">
                  <div
                    className="w-[120px] rounded-md border border-border bg-secondary/20 p-1.5 flex flex-col gap-1"
                    data-testid={`wp-card-${i}`}
                  >
                    <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
                      <span>#{i + 1}</span>
                      <div className="flex items-center gap-0.5 print:hidden">
                        <button onClick={() => moveWp(active.id, w.id, -1)}
                          disabled={i === 0}
                          className="p-0.5 rounded hover:bg-secondary disabled:opacity-30" title="Move left"
                          data-testid={`button-wp-up-${i}`}>
                          <ArrowUp className="h-3 w-3 -rotate-90" />
                        </button>
                        <button onClick={() => moveWp(active.id, w.id, 1)}
                          disabled={i === active.waypoints.length - 1}
                          className="p-0.5 rounded hover:bg-secondary disabled:opacity-30" title="Move right"
                          data-testid={`button-wp-down-${i}`}>
                          <ArrowDown className="h-3 w-3 -rotate-90" />
                        </button>
                        <button onClick={() => removeWp(active.id, w.id)}
                          className="p-0.5 rounded hover:bg-destructive/20 text-destructive" title="Remove waypoint"
                          data-testid={`button-remove-wp-${i}`}>
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                    <input
                      value={w.name}
                      onChange={e => updateWp(active.id, w.id, { name: e.target.value })}
                      placeholder={i === 0 ? "Dep" : i === active.waypoints.length - 1 ? "Dest" : "WP"}
                      className="w-full px-1.5 py-1 rounded bg-input border border-border text-sm font-semibold uppercase tracking-wide"
                      data-testid={`input-wp-name-${i}`}
                    />
                    <label className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                      <span className="shrink-0">Leg</span>
                      <input
                        type="number"
                        min={0}
                        value={w.legMin}
                        onChange={e => updateWp(active.id, w.id, { legMin: Number(e.target.value) || 0 })}
                        className="w-full px-1.5 py-0.5 rounded bg-input border border-border text-xs font-mono text-right tabular-nums"
                        data-testid={`input-wp-min-${i}`}
                      />
                      <span className="shrink-0 text-muted-foreground">m</span>
                    </label>
                  </div>
                  {/* Chevron between cards — hides on the last card and
                      on the right edge of the wrap row (CSS handles wrap
                      naturally; chevron just rides along for clarity). */}
                  {i < active.waypoints.length - 1 && (
                    <div className="self-center px-0.5 text-muted-foreground select-none" aria-hidden>
                      ▸
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="mt-3 flex items-center justify-end gap-2 border-t border-border pt-2">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Total flight time</span>
              <span className="font-mono font-bold gold-text" data-testid="text-route-total">{fmtHours(totalMin)}</span>
            </div>

            <div className="mt-3 print:hidden flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => addWp(active.id)}
                disabled={active.waypoints.length >= MAX_WAYPOINTS}
                data-testid="button-add-wp"
              >
                <Plus className="h-4 w-4 me-1" /> Add Waypoint
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {active.waypoints.length} / {MAX_WAYPOINTS} waypoints
              </span>
            </div>
          </Card>
        ) : (
          <Card className="flex flex-col items-center justify-center min-h-[40vh] text-center">
            <Map className="h-12 w-12 text-amber-400 mb-2" />
            <div className="text-sm text-muted-foreground">Select a route from the left, or click <strong>Add Route</strong>.</div>
          </Card>
        )}
      </div>
    </div>
  );
}
