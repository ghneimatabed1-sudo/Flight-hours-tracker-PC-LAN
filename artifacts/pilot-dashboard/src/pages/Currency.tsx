import { useEffect, useState } from "react";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { usePilots } from "@/lib/squadron-data";
import { DataUnavailableBanner } from "@/components/DataUnavailableBanner";
import { Eye, EyeOff, ArrowUp, ArrowDown, Printer } from "lucide-react";
import type { CurrencyKey } from "@/lib/mock";

// Single matrix view for the squadron ops officer. Shows every active
// pilot in one row with all six currencies (Day, Night, NVG, IRT, Medical,
// Simulator) as columns. Each cell is the EXPIRY date — color-coded by how
// soon it expires. Single source of truth: `pilots.expiry` on the live
// pilots table; the same field that the mobile app reads and that the
// pilot edit dialog writes. No separate currency table exists.
// Sim is intentionally NOT in this list — it has no currency window per
// `.local/memory/currency-refresh.md`. The squadron commander sees the
// last-simulator date as a separate monitoring column rendered by
// `LastSimColumn` (not subject to the green/amber/red status logic).
const COLS: { k: CurrencyKey; label: string }[] = [
  { k: "day",     label: "Day"       },
  { k: "night",   label: "Night"     },
  { k: "nvg",     label: "NVG"       },
  { k: "irt",     label: "IRT"       },
  { k: "medical", label: "Medical"   },
];

// Per-PC manual hide of pilots (e.g. transferred or on long leave). Kept
// local so each station can groom its own roll-up without affecting the
// shared squadron data.
const HIDE_PILOTS_KEY = "rjaf.currency.hiddenPilots";
function loadHiddenPilots(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDE_PILOTS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(arr) ? (arr as string[]) : []);
  } catch { return new Set(); }
}
function saveHiddenPilots(s: Set<string>) {
  localStorage.setItem(HIDE_PILOTS_KEY, JSON.stringify(Array.from(s)));
}

// Per-PC hide of an entire currency column (e.g. a unit that has no
// simulator program will hide the Sim column on its station). Local-only.
const HIDE_COLS_KEY = "rjaf.currency.hiddenCols";
function loadHiddenCols(): Set<CurrencyKey> {
  try {
    const raw = localStorage.getItem(HIDE_COLS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(arr) ? (arr as CurrencyKey[]) : []);
  } catch { return new Set(); }
}
function saveHiddenCols(s: Set<CurrencyKey>) {
  localStorage.setItem(HIDE_COLS_KEY, JSON.stringify(Array.from(s)));
}

function statusOf(d: string) {
  if (!d) return { cls: "status-warn", lbl: "—", days: 0, empty: true };
  // Compare LOCAL midnight to LOCAL midnight so a date entered as "today"
  // is never accidentally counted as "yesterday" because of a timezone
  // offset (e.g. Jordan UTC+3 vs the JS Date UTC parser).
  const parts = d.split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return { cls: "status-warn", lbl: "—", days: 0, empty: true };
  const expiry = new Date(parts[0], parts[1] - 1, parts[2]).getTime();
  const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((expiry - today) / 86400000);
  if (days < 0)   return { cls: "status-bad",  lbl: `EXPIRED ${-days}d`, days, empty: false };
  if (days === 0) return { cls: "status-warn", lbl: "Expires today",     days, empty: false };
  if (days < 30)  return { cls: "status-warn", lbl: `${days}d left`,     days, empty: false };
  return                  { cls: "status-ok",  lbl: `${days}d left`,     days, empty: false };
}

function cellTextClass(s: ReturnType<typeof statusOf>) {
  if (s.empty) return "text-muted-foreground";
  if (s.cls === "status-bad")  return "text-rose-300";
  if (s.cls === "status-warn") return "text-amber-300";
  return "text-emerald-300";
}

export default function Currency() {
  const { t, rankOf } = useI18n();
  const pilotsQ = usePilots();
  const { data: PILOTS } = pilotsQ;

  const [hiddenPilots, setHiddenPilots] = useState<Set<string>>(() => loadHiddenPilots());
  const [hiddenCols, setHiddenCols]     = useState<Set<CurrencyKey>>(() => loadHiddenCols());
  const [showHiddenPilots, setShowHiddenPilots] = useState(false);
  // Sort: `key` is either a CurrencyKey (sort by that column's expiry) or
  // "worst" (default, sort by each pilot's nearest-expiring currency).
  // `dir` "asc" = oldest-expiry / most-overdue first, "desc" = newest first.
  const [sortKey, setSortKey] = useState<CurrencyKey | "worst">("worst");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const cycleSort = (k: CurrencyKey | "worst") => {
    if (sortKey !== k) { setSortKey(k); setSortDir("asc"); return; }
    setSortDir(d => d === "asc" ? "desc" : "asc");
  };

  // Print uses a freshly opened window so the dashboard's chrome (sidebar,
  // header, dark theme) is never sent to the printer. The page rebuilds
  // the same matrix the user sees on screen — same column visibility, same
  // pilot visibility, same sort order — and tells the browser to fit the
  // table to the paper width via @page CSS.
  const printNow = () => {
    const today = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    const head = `<tr>
      <th>Pilot</th>
      ${visibleCols.map(c => `<th>${c.label}</th>`).join("")}
      <th>Last Sim</th>
    </tr>`;
    const body = rows.filter(r => !r.pilotHidden).map(({ p, cells }) => {
      const tds = cells.map(({ na, s, date }) => {
        if (na) return `<td class="na">N/A</td>`;
        if (!date) return `<td class="empty">—</td>`;
        const cls = s.cls === "status-bad" ? "bad" : s.cls === "status-warn" ? "warn" : "ok";
        return `<td class="${cls}"><div class="d">${date}</div><div class="s">${s.lbl}</div></td>`;
      }).join("");
      // Last simulator session — monitoring only, no status coloring.
      const sim = p.lastSimDate ? `<td class="empty"><div class="d">${p.lastSimDate}</div></td>` : `<td class="empty">—</td>`;
      return `<tr><td class="name">${rankOf(p)} ${p.name}</td>${tds}${sim}</tr>`;
    }).join("");
    const cols = visibleCols.length + 2;
    const html = `<!doctype html><html><head><meta charset="utf-8">
      <title>Squadron Currencies — ${today}</title>
      <style>
        /* Landscape and edge-to-edge so a wide matrix isn't clipped. */
        @page { size: A4 landscape; margin: 10mm; }
        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; font-family: -apple-system, "Segoe UI", Inter, Arial, sans-serif; color: #111; background: #fff; }
        h1 { font-size: 14pt; margin: 0 0 4pt 0; }
        .meta { font-size: 9pt; color: #555; margin: 0 0 8pt 0; }
        table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9pt; }
        th, td { border: 0.4pt solid #999; padding: 4pt 5pt; text-align: left; vertical-align: top; word-wrap: break-word; }
        th { background: #eee; font-weight: 600; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.3pt; }
        td.name { font-weight: 600; white-space: nowrap; }
        td .d { font-family: ui-monospace, "Courier New", monospace; font-size: 9pt; }
        td .s { font-size: 7.5pt; margin-top: 1pt; }
        td.bad  { background: #fde7ea; } td.bad  .s { color: #b00020; font-weight: 600; }
        td.warn { background: #fff5d9; } td.warn .s { color: #8a5a00; }
        td.ok   { background: #e6f5ec; } td.ok   .s { color: #1b6b3a; }
        td.na, td.empty { color: #888; font-style: italic; text-align: center; }
        thead { display: table-header-group; }       /* repeat header on each printed page */
        tr    { page-break-inside: avoid; }          /* never split a pilot row across pages */
        .footer { margin-top: 6pt; font-size: 7.5pt; color: #888; text-align: right; }
      </style>
    </head><body>
      <h1>Squadron Currencies</h1>
      <p class="meta">Printed ${today} · ${rows.filter(r => !r.pilotHidden).length} pilot(s) · ${visibleCols.length} ${visibleCols.length === 1 ? "currency" : "currencies"} shown · sorted by ${sortKey === "worst" ? "nearest expiry" : visibleCols.find(c => c.k === sortKey)?.label ?? sortKey} (${sortDir === "asc" ? "earliest first" : "latest first"})</p>
      <table><thead>${head}</thead><tbody>${body || `<tr><td colspan="${cols}" style="text-align:center;color:#888;padding:20pt;">No pilots to print</td></tr>`}</tbody></table>
      <div class="footer">Hawk Eye · RJAF Squadron Ops</div>
      <script>window.onload=function(){setTimeout(function(){window.focus();window.print();},100);};</script>
    </body></html>`;
    const w = window.open("", "_blank", "width=1100,height=800");
    if (!w) { alert("Pop-up blocked — allow pop-ups for this site to print."); return; }
    w.document.open(); w.document.write(html); w.document.close();
  };

  useEffect(() => { saveHiddenPilots(hiddenPilots); }, [hiddenPilots]);
  useEffect(() => { saveHiddenCols(hiddenCols);     }, [hiddenCols]);

  const togglePilot = (id: string) => {
    setHiddenPilots(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleCol = (k: CurrencyKey) => {
    setHiddenCols(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  const visibleCols = COLS.filter(c => !hiddenCols.has(c.k));

  // Per-pilot row: how soon does THIS pilot's worst (visible) currency
  // expire? Drives row sort so the most-overdue pilot floats to the top.
  const rows = PILOTS
    .filter(p => showHiddenPilots || !hiddenPilots.has(p.id))
    .map(p => {
      const cells = visibleCols.map(c => {
        const naForPilot = p.hiddenCurrencies?.includes(c.k) ?? false;
        return { col: c, na: naForPilot, s: statusOf(p.expiry?.[c.k] ?? ""), date: p.expiry?.[c.k] ?? "" };
      });
      // Worst = smallest days value among non-NA, non-empty cells.
      const live = cells.filter(c => !c.na && !c.s.empty);
      const worstDays = live.length ? Math.min(...live.map(c => c.s.days)) : Number.POSITIVE_INFINITY;
      return { p, cells, worstDays, pilotHidden: hiddenPilots.has(p.id) };
    })
    .sort((a, b) => {
      // Hidden rows always at the bottom regardless of direction.
      const h = Number(a.pilotHidden) - Number(b.pilotHidden);
      if (h !== 0) return h;
      // Resolve the "days until expiry" value the user picked to sort by.
      // Empty / NA cells are pushed to the END (treated as +Infinity) in
      // both directions so they never crowd the actionable rows.
      const valFor = (r: typeof a): number => {
        if (sortKey === "worst") return r.worstDays;
        const cell = r.cells.find(c => c.col.k === sortKey);
        if (!cell || cell.na || cell.s.empty) return Number.POSITIVE_INFINITY;
        return cell.s.days;
      };
      const av = valFor(a), bv = valFor(b);
      // Push +Infinity to the bottom in both directions.
      if (av === Number.POSITIVE_INFINITY && bv !== Number.POSITIVE_INFINITY) return 1;
      if (bv === Number.POSITIVE_INFINITY && av !== Number.POSITIVE_INFINITY) return -1;
      return sortDir === "asc" ? av - bv : bv - av;
    });

  return (
    <div>
      <PageHead
        title={t("nav_currency")}
        subtitle="Each cell is when the currency EXPIRES. Color-coded · earliest expiry first. Hide columns or pilots that don't apply on this PC."
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-xs">
              <span className="text-muted-foreground">Sort:</span>
              <select
                value={sortKey}
                onChange={e => { setSortKey(e.target.value as CurrencyKey | "worst"); }}
                className="px-2 py-1.5 rounded-md bg-secondary border border-border text-xs"
                data-testid="select-sort-key"
              >
                <option value="worst">Nearest expiry (any)</option>
                {COLS.map(c => (
                  <option key={c.k} value={c.k}>{c.label}</option>
                ))}
              </select>
              <button
                onClick={() => setSortDir(d => d === "asc" ? "desc" : "asc")}
                className="px-2 py-1.5 rounded-md bg-secondary border border-border flex items-center gap-1"
                title={sortDir === "asc" ? "Earliest first — click for latest first" : "Latest first — click for earliest first"}
                data-testid="button-sort-dir"
              >
                {sortDir === "asc"
                  ? <><ArrowUp className="h-3 w-3" /> Earliest</>
                  : <><ArrowDown className="h-3 w-3" /> Latest</>}
              </button>
            </div>
            <button
              onClick={printNow}
              className="px-3 py-1.5 rounded-md text-xs flex items-center gap-1 bg-secondary border border-border hover:bg-secondary/70"
              data-testid="button-print"
              title="Print currently visible columns and pilots"
            >
              <Printer className="h-3 w-3" />
              Print
            </button>
            <button
              onClick={() => setShowHiddenPilots(v => !v)}
              className={`px-3 py-1.5 rounded-md text-xs flex items-center gap-1 ${showHiddenPilots ? "bg-primary text-primary-foreground" : "bg-secondary border border-border"}`}
              data-testid="button-show-hidden"
            >
              {showHiddenPilots ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {showHiddenPilots ? "Showing hidden" : `Hidden (${hiddenPilots.size})`}
            </button>
          </div>
        }
      />

      <DataUnavailableBanner queries={[pilotsQ]} testId="banner-currency-unavailable" />

      {/* Per-PC column visibility chips. Click to hide / show a currency
          column on this station only. State stays in localStorage. */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3 text-xs">
        <span className="text-muted-foreground mr-1">Columns:</span>
        {COLS.map(c => {
          const on = !hiddenCols.has(c.k);
          return (
            <button
              key={c.k}
              onClick={() => toggleCol(c.k)}
              data-testid={`toggle-col-${c.k}`}
              className={`px-2.5 py-1 rounded-full border ${on
                ? "bg-primary/15 border-primary/40 text-foreground"
                : "bg-secondary/50 border-border text-muted-foreground line-through"}`}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      <Card className="!p-0 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">
                  <button
                    onClick={() => cycleSort("worst")}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                    title="Sort by each pilot's nearest-expiring currency"
                    data-testid="sort-name"
                  >
                    {t("name")}
                    {sortKey === "worst" && (sortDir === "asc"
                      ? <ArrowUp className="h-3 w-3" />
                      : <ArrowDown className="h-3 w-3" />)}
                  </button>
                </th>
                {visibleCols.map(c => (
                  <th key={c.k} className="px-3 py-2 text-left whitespace-nowrap">
                    <button
                      onClick={() => cycleSort(c.k)}
                      className="inline-flex items-center gap-1 hover:text-foreground"
                      title={`Sort by ${c.label} expiry — click again to flip direction`}
                      data-testid={`sort-${c.k}`}
                    >
                      {c.label}
                      {sortKey === c.k && (sortDir === "asc"
                        ? <ArrowUp className="h-3 w-3" />
                        : <ArrowDown className="h-3 w-3" />)}
                    </button>
                  </th>
                ))}
                {/* Last simulator session — monitoring column. No green/amber/red
                    status (sim has no currency window per
                    `.local/memory/currency-refresh.md`). Visible to every
                    commander tier so monitoring roles can see recency. */}
                <th className="px-3 py-2 text-left whitespace-nowrap" title="Last simulator session date — monitoring only">
                  Last Sim
                </th>
                <th className="px-3 py-2 text-right w-10"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={visibleCols.length + 3} className="px-3 py-6 text-center text-xs text-muted-foreground" data-testid="empty-currency">
                    {pilotsQ.isError ? "—" : t("no_records")}
                  </td>
                </tr>
              )}
              {rows.map(({ p, cells, pilotHidden }) => (
                <tr key={p.id} className={`border-t border-border row-hover ${pilotHidden ? "opacity-50" : ""}`}>
                  <td className="px-3 py-2 whitespace-nowrap">{rankOf(p)} {p.name}</td>
                  {cells.map(({ col, na, s, date }) => (
                    <td key={col.k} className="px-3 py-2 whitespace-nowrap" data-testid={`cell-${p.id}-${col.k}`}>
                      {na ? (
                        <span className="inline-flex items-center rounded px-2 py-0.5 text-[11px] bg-secondary text-muted-foreground border border-border">
                          {t("notApplicable")}
                        </span>
                      ) : (
                        <div className="flex flex-col leading-tight">
                          <span className="font-mono text-xs">{date || "—"}</span>
                          <span className={`text-[10px] ${cellTextClass(s)}`}>{s.lbl}</span>
                        </div>
                      )}
                    </td>
                  ))}
                  {/* Last simulator session — monitoring only, no expiry colors. */}
                  <td className="px-3 py-2 whitespace-nowrap" data-testid={`cell-${p.id}-lastsim`}>
                    <span className="font-mono text-xs text-muted-foreground">{p.lastSimDate || "—"}</span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      onClick={() => togglePilot(p.id)}
                      className="p-1 rounded hover:bg-secondary text-muted-foreground"
                      title={pilotHidden ? "Show on this PC" : "Hide from this PC"}
                      data-testid={`button-hide-pilot-${p.id}`}
                    >
                      {pilotHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
