import { useMemo, useState } from "react";
import DateInput from "@/components/DateInput";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import {
  usePilots,
  useSorties,
  seedDemoDay,
  clearDemoSeed,
  isDemoSeedLoaded,
  canSeedDemo,
} from "@/lib/squadron-data";
import { DataUnavailableBanner } from "@/components/DataUnavailableBanner";
import { fmtDate } from "@/lib/format";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Plane,
  Clock,
  Printer,
  Users,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

// Squadron-commander read-only browser of the sorties entered by the ops
// officer on this squadron's PC. Reuses the same local squadron-data store
// the ops officer writes to. Search, month calendar, and day view keep the
// commander one click away from any sortie without scrubbing dates.
export default function FlightRecords() {
  const { t, lang, rankOf } = useI18n();
  const qc = useQueryClient();
  const pilotsQ = usePilots();
  const sortiesQ = useSorties();
  const PILOTS = pilotsQ.data;
  const SORTIES = sortiesQ.data;

  const todayIso = useMemo(() => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }, []);
  const [date, setDate] = useState<string>(todayIso);
  const [query, setQuery] = useState<string>("");
  const [calMonth, setCalMonth] = useState<string>(todayIso.slice(0, 7)); // YYYY-MM
  const [demoLoaded, setDemoLoaded] = useState<boolean>(() => isDemoSeedLoaded());

  const pilotMap = useMemo(
    () => Object.fromEntries(PILOTS.map((p) => [p.id, `${rankOf(p)} ${p.name}`])),
    [PILOTS],
  );

  const flightDays = useMemo(() => {
    const set = new Set(SORTIES.map((s) => s.date));
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [SORTIES]);

  // Map of YYYY-MM-DD → sortie count, used to paint the month calendar dots.
  const dayCountMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of SORTIES) m.set(s.date, (m.get(s.date) ?? 0) + 1);
    return m;
  }, [SORTIES]);

  // Text-search matcher. Case-insensitive across pilot name (resolved and
  // external), aircraft number, sortie type/name, and remarks. Returns true
  // for everything when the query is empty so the day view keeps working.
  const matchesQuery = (s: typeof SORTIES[number], q: string): boolean => {
    if (!q) return true;
    const needle = q.toLowerCase().trim();
    const p1 = s.pilotExternal?.name ?? pilotMap[s.pilotId] ?? "";
    const p2 = s.coPilotExternal?.name ?? pilotMap[s.coPilotId] ?? "";
    const hay = [
      s.acNumber,
      s.acType,
      s.sortieType,
      s.name,
      s.remarks ?? "",
      p1,
      p2,
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(needle);
  };

  const searching = query.trim().length > 0;

  // When searching: show matches across ALL dates, grouped by date.
  // When not searching: show just the selected day's rows (existing behaviour).
  const rowsForDay = useMemo(
    () =>
      SORTIES.filter((s) => s.date === date).sort((a, b) =>
        (a.acNumber + a.name).localeCompare(b.acNumber + b.name),
      ),
    [SORTIES, date],
  );

  const searchResults = useMemo(() => {
    if (!searching) return [];
    return SORTIES
      .filter((s) => matchesQuery(s, query))
      .sort((a, b) =>
        b.date.localeCompare(a.date) || (a.acNumber + a.name).localeCompare(b.acNumber + b.name),
      );
    // pilotMap intentionally excluded from deps — name lookup is a pure read
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [SORTIES, query, searching, pilotMap]);

  const groupedSearch = useMemo(() => {
    const groups = new Map<string, typeof SORTIES>();
    for (const s of searchResults) {
      const list = groups.get(s.date) ?? [];
      list.push(s);
      groups.set(s.date, list);
    }
    return Array.from(groups.entries());
  }, [searchResults]);

  const visibleRows = searching ? searchResults : rowsForDay;

  // Aggregate the visible sorties into five headline numbers plus two
  // per-entity breakdowns:
  //   pilotCounts   — one entry per unique pilot, with the number of sorties
  //                   they appeared in (pilot or co-pilot counts as one each).
  //   aircraftCounts — one entry per unique tail number, with how many
  //                    sorties used that airframe.
  // The headline `pilots` and `aircraft` numbers are still the unique counts
  // (set sizes). The breakdowns give the commander a quick "who flew what,
  // and how many times" readout under each tile.
  const stats = useMemo(() => {
    let hours = 0;
    let nvg = 0;
    const pilotsSet = new Set<string>();
    const acCounts = new Map<string, number>();
    const pilotCountMap = new Map<string, number>();
    for (const s of visibleRows) {
      hours += Number(s.actual) || 0;
      nvg += Number(s.nvg) || 0;
      // Unique-pilot set + per-pilot sortie tally. A single crew member
      // appearing in both the pilot and co-pilot seat on the same sortie
      // is still just one sortie for them — we de-dupe per record.
      const ids = new Set<string>();
      if (s.pilotId) ids.add(s.pilotId);
      if (s.coPilotId) ids.add(s.coPilotId);
      for (const id of ids) {
        pilotsSet.add(id);
        pilotCountMap.set(id, (pilotCountMap.get(id) ?? 0) + 1);
      }
      // Also include external (guest) pilots in the sortie tally, keyed by
      // their display string so guests from other squadrons still show up
      // in the breakdown.
      const extKeys = new Set<string>();
      if (s.pilotExternal) extKeys.add(`ext:${s.pilotExternal.name}|${s.pilotExternal.squadron}`);
      if (s.coPilotExternal) extKeys.add(`ext:${s.coPilotExternal.name}|${s.coPilotExternal.squadron}`);
      for (const k of extKeys) {
        pilotsSet.add(k);
        pilotCountMap.set(k, (pilotCountMap.get(k) ?? 0) + 1);
      }
      if (s.acNumber) {
        acCounts.set(s.acNumber, (acCounts.get(s.acNumber) ?? 0) + 1);
      }
    }
    // Sort breakdowns: most-used first, then alphabetical for stable order.
    const pilotCounts = Array.from(pilotCountMap.entries())
      .map(([id, count]) => {
        const label = id.startsWith("ext:")
          ? (() => {
              const rest = id.slice(4);
              const [name, sqn] = rest.split("|");
              return sqn ? `${name} (${sqn})` : name;
            })()
          : pilotMap[id] ?? id;
        return { id, label, count };
      })
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    const aircraftCounts = Array.from(acCounts.entries())
      .map(([ac, count]) => ({ ac, count }))
      .sort((a, b) => b.count - a.count || a.ac.localeCompare(b.ac));
    return {
      count: visibleRows.length,
      hours,
      nvg,
      pilots: pilotsSet.size,
      aircraft: acCounts.size,
      pilotCounts,
      aircraftCounts,
    };
  }, [visibleRows, pilotMap]);

  const shift = (days: number) => {
    const d = new Date(date + "T00:00:00");
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    setDate(`${y}-${m}-${dd}`);
  };

  const seatName = (id: string, ext?: { name: string; squadron: string }) => {
    if (ext) return `${ext.name}${ext.squadron ? ` (${ext.squadron})` : ""}`;
    return pilotMap[id] || "—";
  };

  const handleLoadDemo = () => {
    seedDemoDay();
    setDemoLoaded(true);
    // point the commander at the day we just seeded
    setDate(todayIso);
    setCalMonth(todayIso.slice(0, 7));
    qc.invalidateQueries({ queryKey: ["sorties"] });
    qc.invalidateQueries({ queryKey: ["pilots"] });
  };

  const handleClearDemo = () => {
    clearDemoSeed();
    setDemoLoaded(isDemoSeedLoaded());
    qc.invalidateQueries({ queryKey: ["sorties"] });
    qc.invalidateQueries({ queryKey: ["pilots"] });
  };

  return (
    <div className="space-y-4 print-area">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <CalendarDays className="h-5 w-5 text-amber-500" />
          {t("flightRecords")}
        </h2>
        <div className="flex items-center gap-2">
          {canSeedDemo() && demoLoaded && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleClearDemo}
              data-testid="button-clear-demo"
              className="no-print text-rose-300 hover:text-rose-200"
            >
              <Trash2 className="h-3.5 w-3.5 me-1" />
              {t("clearDemo")}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => window.print()}
            data-testid="button-print-flights"
            className="no-print"
          >
            <Printer className="h-3.5 w-3.5 me-1" />
            {t("print")}
          </Button>
        </div>
      </div>

      <DataUnavailableBanner
        queries={[pilotsQ, sortiesQ]}
        testId="banner-flights-unavailable"
      />

      {/* Empty-state CTA: when demo mode is possible AND there is nothing to
          look at yet, nudge the commander to load a sample day. */}
      {canSeedDemo() && !demoLoaded && SORTIES.length === 0 && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="p-4 flex items-center gap-3 flex-wrap">
            <Sparkles className="h-5 w-5 text-amber-400 shrink-0" />
            <p className="text-sm text-muted-foreground flex-1 min-w-[12rem]">
              {t("demoIntro")}
            </p>
            <Button
              size="sm"
              onClick={handleLoadDemo}
              data-testid="button-load-demo"
              className="bg-amber-500 hover:bg-amber-400 text-black"
            >
              {t("loadDemoDay")}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Search + date navigation. Typing in the search box flips the page
          into "across all dates" mode; clearing it returns to day view. */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <Search className="h-4 w-4 text-muted-foreground absolute start-2 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("searchFlights")}
                className="w-full ps-8 pe-8 py-2 rounded-md bg-input border border-border text-sm"
                data-testid="input-flights-search"
              />
              {searching && (
                <button
                  onClick={() => setQuery("")}
                  aria-label={t("clearSearch")}
                  className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  data-testid="button-clear-search"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {!searching && (
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                variant="outline"
                onClick={() => shift(-1)}
                data-testid="button-prev-day"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <DateInput
                value={date}
                onChange={(v) => setDate(v || todayIso)}
                className="px-2 py-1.5 rounded-md bg-input border border-border text-sm tabular-nums"
                data-testid="input-flight-date"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => shift(1)}
                data-testid="button-next-day"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setDate(todayIso)}
                data-testid="button-today"
              >
                {t("today")}
              </Button>
              <span className="text-sm text-muted-foreground ms-auto tabular-nums">
                {fmtDate(date, lang)}
              </span>
            </div>
          )}

          {searching && (
            <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
              <span className="px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/40 text-amber-200">
                {t("searchAllDates")}
              </span>
              <span className="tabular-nums">
                {t("searchMatches").replace("{n}", String(searchResults.length))}
              </span>
            </div>
          )}

          {!searching && flightDays.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground me-1">
                {t("recentFlyingDays")}
              </span>
              {flightDays.slice(0, 10).map((d) => {
                const active = d === date;
                return (
                  <button
                    key={d}
                    onClick={() => setDate(d)}
                    className={`text-xs px-2 py-1 rounded-md border transition ${
                      active
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-secondary/40 border-border hover:bg-secondary"
                    }`}
                    data-testid={`chip-flight-day-${d}`}
                  >
                    <span className="tabular-nums">{d}</span>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Month calendar with dots on flying days. Clicking a day sets it as
          the active date and exits search mode. Hidden while searching to
          avoid two competing navigation surfaces on screen. */}
      {!searching && (
        <MonthCalendar
          month={calMonth}
          setMonth={setCalMonth}
          selected={date}
          onPick={(d) => {
            setDate(d);
            setQuery("");
          }}
          dayCounts={dayCountMap}
          today={todayIso}
          lang={lang}
          t={t}
        />
      )}

      {/* Daily summary tiles reflect either the selected day OR the full
          search result set, whichever is active. */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <Stat
          icon={<Plane className="h-4 w-4 text-amber-500" />}
          label={t("sortiesCount")}
          value={stats.count}
        />
        <Stat
          icon={<Clock className="h-4 w-4 text-emerald-500" />}
          label={t("totalHours")}
          value={stats.hours.toFixed(1)}
        />
        <Stat
          icon={<Clock className="h-4 w-4 text-rose-400" />}
          label={t("nvgHours")}
          value={stats.nvg.toFixed(1)}
        />
        <Stat
          icon={<Users className="h-4 w-4 text-sky-400" />}
          label={t("pilotsFlown")}
          value={stats.pilots}
        />
        <Stat
          icon={<Plane className="h-4 w-4 text-sky-400" />}
          label={t("aircraftUsed")}
          value={stats.aircraft}
        />
      </div>

      {/* Breakdown chips. Unique pilots and unique aircraft are counted
          once in the tiles above; these rows spell out who/what and how
          many sorties each appeared in. Hidden when nothing is flying. */}
      {(stats.pilotCounts.length > 0 || stats.aircraftCounts.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {stats.pilotCounts.length > 0 && (
            <BreakdownChips
              icon={<Users className="h-4 w-4 text-sky-400" />}
              label={t("pilotsBreakdown")}
              entries={stats.pilotCounts.map((p) => ({
                key: p.id,
                label: p.label,
                count: p.count,
              }))}
              testIdPrefix="chip-pilot-count"
            />
          )}
          {stats.aircraftCounts.length > 0 && (
            <BreakdownChips
              icon={<Plane className="h-4 w-4 text-amber-500" />}
              label={t("aircraftBreakdown")}
              entries={stats.aircraftCounts.map((a) => ({
                key: a.ac,
                label: a.ac,
                count: a.count,
                mono: true,
              }))}
              testIdPrefix="chip-ac-count"
            />
          )}
        </div>
      )}

      {/* Sortie list. Search mode groups results by date with a header row
          (newest first); day mode keeps the original single-day layout. */}
      {searching ? (
        <div className="space-y-3">
          {groupedSearch.length === 0 ? (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground text-center" data-testid="empty-search">
                {t("noFlightsDay")}
              </CardContent>
            </Card>
          ) : (
            groupedSearch.map(([d, list]) => (
              <Card key={d}>
                <CardHeader>
                  <CardTitle className="text-base flex items-center justify-between gap-2 flex-wrap">
                    <span>{fmtDate(d, lang)}</span>
                    <button
                      onClick={() => {
                        setDate(d);
                        setQuery("");
                      }}
                      className="text-xs px-2 py-1 rounded-md bg-secondary/50 border border-border hover:bg-secondary tabular-nums"
                      data-testid={`button-jump-day-${d}`}
                    >
                      {d}
                    </button>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3 space-y-2">
                  {list.map((s, idx) => (
                    <SortieCard
                      key={s.id}
                      idx={idx}
                      s={s}
                      seatName={seatName}
                      t={t}
                    />
                  ))}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("flightsOnDay").replace("{date}", fmtDate(date, lang))}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3 space-y-2">
            {rowsForDay.length === 0 ? (
              <p
                className="p-4 text-sm text-muted-foreground text-center"
                data-testid="empty-flights"
              >
                {t("noFlightsDay")}
              </p>
            ) : (
              rowsForDay.map((s, idx) => (
                <SortieCard
                  key={s.id}
                  idx={idx}
                  s={s}
                  seatName={seatName}
                  t={t}
                />
              ))
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}) {
  return (
    <Card>
      <CardContent className="p-3 flex items-center gap-2">
        <div className="h-8 w-8 rounded-md bg-secondary/40 border border-border flex items-center justify-center">
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground truncate">
            {label}
          </div>
          <div className="text-lg font-semibold tabular-nums">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

// Compact chip list used under the summary tiles to spell out the pilots
// or aircraft that contributed to the headline count. Each chip shows the
// name (or tail number) with a small "×N" badge when it appeared in more
// than one sortie. The headline tile count stays as the unique total.
function BreakdownChips({
  icon,
  label,
  entries,
  testIdPrefix,
}: {
  icon: React.ReactNode;
  label: string;
  entries: { key: string; label: string; count: number; mono?: boolean }[];
  testIdPrefix: string;
}) {
  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-md bg-secondary/40 border border-border flex items-center justify-center">
            {icon}
          </div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {label}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {entries.map((e) => (
            <span
              key={e.key}
              data-testid={`${testIdPrefix}-${e.key}`}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-secondary/40 border border-border text-xs"
              title={`${e.label} · ${e.count}`}
            >
              <span className={`truncate max-w-[14rem] ${e.mono ? "font-mono" : ""}`}>
                {e.label}
              </span>
              <span
                className={`tabular-nums font-semibold ${
                  e.count > 1 ? "text-amber-300" : "text-muted-foreground"
                }`}
              >
                ×{e.count}
              </span>
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
        {label}
      </div>
      <div
        className={`text-sm font-semibold truncate ${
          mono ? "font-mono" : ""
        } ${accent ? "text-amber-200" : "text-foreground"}`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function HourChip({
  label,
  v,
  rose,
}: {
  label: string;
  v: number;
  rose?: boolean;
}) {
  const hasValue = !!v;
  return (
    <span className={hasValue ? (rose ? "text-rose-300" : "text-foreground") : "opacity-50"}>
      {label} <span className="font-semibold">{v || "—"}</span>
    </span>
  );
}

// A single-sortie card, extracted so it can render in both "day" and
// "search results grouped by date" modes without duplication.
function SortieCard({
  idx,
  s,
  seatName,
  t,
}: {
  idx: number;
  s: {
    id: string;
    acType: string;
    acNumber: string;
    pilotId: string;
    coPilotId: string;
    pilotExternal?: { name: string; squadron: string };
    coPilotExternal?: { name: string; squadron: string };
    sortieType: string;
    name: string;
    day1: number; day2: number; dayDual: number;
    night1: number; night2: number; nightDual: number;
    nvg: number; sim: number; actual: number;
    condition?: "Day" | "Night" | "NVG";
    remarks?: string;
  };
  seatName: (id: string, ext?: { name: string; squadron: string }) => string;
  t: (k: string) => string;
}) {
  return (
    <div
      className="rounded-lg border border-border bg-secondary/20 p-3 space-y-2"
      data-testid={`row-flight-${s.id}`}
    >
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Field
          label={`#${idx + 1} · ${t("acNumber")}`}
          value={s.acNumber || "—"}
          mono
          accent
        />
        <Field label={t("pilot")} value={seatName(s.pilotId, s.pilotExternal)} />
        <Field label={t("coPilot")} value={seatName(s.coPilotId, s.coPilotExternal)} />
        <Field label={t("sortieName")} value={s.name || "—"} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        {s.acType && (
          <span className="px-1.5 py-0.5 rounded bg-secondary/60 border border-border">
            {s.acType}
          </span>
        )}
        {s.sortieType && (
          <span className="px-1.5 py-0.5 rounded bg-secondary/60 border border-border">
            {s.sortieType}
          </span>
        )}
        {s.condition && (
          <span
            className={`px-1.5 py-0.5 rounded border ${
              s.condition === "NVG"
                ? "bg-rose-500/10 border-rose-500/40 text-rose-200"
                : s.condition === "Night"
                ? "bg-indigo-500/10 border-indigo-500/40 text-indigo-200"
                : "bg-amber-500/10 border-amber-500/40 text-amber-200"
            }`}
          >
            {s.condition}
          </span>
        )}
        <span className="ms-auto font-mono tabular-nums text-muted-foreground">
          {t("actual")}: <span className="text-foreground font-semibold">{s.actual}h</span>
        </span>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground font-mono tabular-nums border-t border-border/60 pt-2">
        <HourChip label="D1" v={s.day1} />
        <HourChip label="D2" v={s.day2} />
        <HourChip label="DD" v={s.dayDual} />
        <HourChip label="N1" v={s.night1} />
        <HourChip label="N2" v={s.night2} />
        <HourChip label="ND" v={s.nightDual} />
        <HourChip label="NVG" v={s.nvg} rose />
        <HourChip label="Sim" v={s.sim} />
      </div>

      {s.remarks && (
        <div className="text-xs text-muted-foreground italic border-t border-border/60 pt-2">
          <span className="not-italic font-medium text-foreground/80">
            {t("remarks")}:{" "}
          </span>
          {s.remarks}
        </div>
      )}
    </div>
  );
}

// Compact month calendar. Each day cell shows the day number; days with at
// least one sortie get an amber dot (with optional count badge when >1).
// Keyboard/click support; the selected date is outlined; today has a
// subtle highlight.
function MonthCalendar({
  month,
  setMonth,
  selected,
  onPick,
  dayCounts,
  today,
  lang,
  t,
}: {
  month: string; // YYYY-MM
  setMonth: (m: string) => void;
  selected: string;
  onPick: (d: string) => void;
  dayCounts: Map<string, number>;
  today: string;
  lang: "en" | "ar";
  t: (k: string) => string;
}) {
  const [y, mIdx] = month.split("-").map(Number);
  const firstOfMonth = new Date(y, mIdx - 1, 1);
  const daysInMonth = new Date(y, mIdx, 0).getDate();
  // Week starts on Sunday (RJAF / Middle East standard working week).
  const startWeekday = firstOfMonth.getDay(); // 0=Sun
  const cells: (string | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${y}-${String(mIdx).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cells.push(iso);
  }
  while (cells.length % 7 !== 0) cells.push(null);

  // MM-YYYY in line with the squadron-wide DD-MM-YYYY standard. Localised
  // weekday / month names elsewhere on the calendar still come from the
  // language; the *period* itself stays numeric.
  const monthLabel = `${String(mIdx).padStart(2, "0")}-${y}`;
  void lang;
  const weekdayLabels = lang === "ar"
    ? ["أحد", "اثن", "ثلا", "أرب", "خمي", "جمع", "سبت"]
    : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const shiftMonth = (delta: number) => {
    const d = new Date(y, mIdx - 1 + delta, 1);
    setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`);
  };

  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground me-auto">
            {t("monthCalendar")}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => shiftMonth(-1)}
            aria-label={t("prevMonth")}
            data-testid="button-prev-month"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm font-semibold tabular-nums min-w-[8rem] text-center">
            {monthLabel}
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => shiftMonth(1)}
            aria-label={t("nextMonth")}
            data-testid="button-next-month"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center">
          {weekdayLabels.map((w) => (
            <div key={w} className="text-[10px] uppercase tracking-wider text-muted-foreground py-1">
              {w}
            </div>
          ))}
          {cells.map((iso, i) => {
            if (!iso) return <div key={i} className="h-10" />;
            const count = dayCounts.get(iso) ?? 0;
            const isSel = iso === selected;
            const isToday = iso === today;
            const dayNum = Number(iso.slice(8, 10));
            return (
              <button
                key={iso}
                onClick={() => onPick(iso)}
                data-testid={`calendar-day-${iso}`}
                className={`h-10 rounded-md text-sm flex flex-col items-center justify-center transition relative tabular-nums border ${
                  isSel
                    ? "border-primary bg-primary/20 text-primary-foreground"
                    : isToday
                    ? "border-amber-500/50 bg-amber-500/10"
                    : count > 0
                    ? "border-border bg-secondary/40 hover:bg-secondary"
                    : "border-transparent hover:bg-secondary/30 text-muted-foreground"
                }`}
              >
                <span className="leading-none">{dayNum}</span>
                {count > 0 && (
                  <span
                    className={`absolute bottom-1 text-[9px] font-semibold ${
                      count > 1 ? "text-amber-300" : ""
                    }`}
                  >
                    {count > 1 ? `● ${count}` : "●"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
