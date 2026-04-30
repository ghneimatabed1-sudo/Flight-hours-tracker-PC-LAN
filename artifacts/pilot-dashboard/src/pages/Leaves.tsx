import { useEffect, useMemo, useState } from "react";
import CalendarPickerInput from "@/components/CalendarPickerInput";
import { Card, PageHead } from "@/components/Layout";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { usePilots } from "@/lib/squadron-data";
import {
  useLeaveTypes,
  useLeaveEntries,
  useSetLeaveEntry,
  useSetAvailableForDay,
  useDeleteLeaveForDay,
  useUpsertLeaveType,
  useDeleteLeaveType,
  type LeaveType,
  type LeaveEntry,
  OTHER_TYPE_ID,
} from "@/lib/leaves-daily";
import { Plus, Trash2, Save, Settings as Cog, CheckCircle2, ChevronLeft, ChevronRight, Printer } from "lucide-react";
import { PrintHeader } from "@/components/PrintHeader";

/**
 * Leaves (rebuilt — daily-first)
 *
 * Three views:
 *   - DAILY:   the operations officer picks a date and, for every pilot in
 *              the squadron, marks Available or chooses a leave type. The
 *              "Other" type opens a free-text reason. Submitting a row
 *              writes a single-day entry (from === to === selected date).
 *   - WEEKLY:  pure totals per pilot — number of leave days in each
 *              7-day bucket of the selected month + a Total column. No
 *              entry chips, no breakdown.
 *   - MONTHLY: pure totals per pilot — number of leave days per calendar
 *              month of the selected year + a Total column. Same as
 *              weekly, just a wider time axis.
 *
 * Leave types: built-in (Leave / Morning Leave / Crew Rest / Outside Duty
 * / Sick / Other) and operator-defined custom types. The "Other" type is
 * special: the per-pilot row exposes a text field so the operator can
 * type any reason (stored in entry.note).
 */

const PALETTE = ["#22c55e","#f59e0b","#ef4444","#3b82f6","#a855f7","#06b6d4","#eab308","#ec4899"];

function daysBetween(fromIso: string, toIso: string): Date[] {
  const out: Date[] = [];
  const a = new Date(fromIso + "T00:00:00");
  const b = new Date(toIso + "T00:00:00");
  if (isNaN(a.getTime()) || isNaN(b.getTime()) || b < a) return out;
  for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) out.push(new Date(d));
  return out;
}

function fmtIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export default function Leaves() {
  const { t, rankOf } = useI18n();
  const pilotsQ = usePilots();
  const PILOTS = pilotsQ.data;

  const typesQ = useLeaveTypes();
  const entriesQ = useLeaveEntries();
  const upsertLeaveType = useUpsertLeaveType();
  const deleteLeaveType = useDeleteLeaveType();
  const setLeaveEntry = useSetLeaveEntry();
  const setAvailableForDay = useSetAvailableForDay();
  const deleteLeaveForDay = useDeleteLeaveForDay();
  const types = typesQ.data;
  const entries = entriesQ.data;

  const [view, setView] = useState<"daily" | "weekly" | "monthly">("daily");
  const today = new Date();
  const [year, setYear]   = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [dayIso, setDayIso] = useState(fmtIso(today));
  const [showSettings, setShowSettings] = useState(false);

  // Aggregations: per (pilotId, bucket) we sum leave-day counts across
  // all types (totals-only views).
  const monthlyAgg = useMemo(() => {
    const m: Record<string, number[]> = {};
    PILOTS.forEach(p => { m[p.id] = Array(12).fill(0); });
    entries.forEach(e => {
      daysBetween(e.from, e.to).forEach(d => {
        if (d.getFullYear() !== year) return;
        const arr = m[e.pilotId]; if (!arr) return;
        arr[d.getMonth()] += 1;
      });
    });
    return m;
  }, [entries, year, PILOTS]);

  const weeklyBuckets = useMemo(() => {
    const last = new Date(year, month + 1, 0).getDate();
    const buckets: { label: string; start: number; end: number }[] = [];
    for (let s = 1; s <= last; s += 7) {
      const e = Math.min(s + 6, last);
      buckets.push({ label: `${s}–${e}`, start: s, end: e });
    }
    return buckets;
  }, [year, month]);

  const weeklyAgg = useMemo(() => {
    const m: Record<string, number[]> = {};
    PILOTS.forEach(p => { m[p.id] = Array(weeklyBuckets.length).fill(0); });
    entries.forEach(e => {
      daysBetween(e.from, e.to).forEach(d => {
        if (d.getFullYear() !== year || d.getMonth() !== month) return;
        const day = d.getDate();
        const idx = weeklyBuckets.findIndex(b => day >= b.start && day <= b.end);
        if (idx < 0) return;
        const arr = m[e.pilotId]; if (!arr) return;
        arr[idx] += 1;
      });
    });
    return m;
  }, [entries, year, month, weeklyBuckets, PILOTS]);

  // Daily view: existing entry that COVERS dayIso (from <= day <= to) for
  // each pilot, plus a per-row draft (selected type + custom note for
  // the "Other" path) so unsaved changes survive accidental clicks.
  const entriesByPilotForDay = useMemo(() => {
    const m: Record<string, LeaveEntry | undefined> = {};
    entries.forEach(e => {
      if (dayIso < e.from || dayIso > e.to) return;
      // Last write wins if multiple cover the same day.
      m[e.pilotId] = e;
    });
    return m;
  }, [entries, dayIso]);

  type Draft = { typeId: string; note: string };
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  // Reset drafts whenever the day changes so a previous day's unsaved
  // selections never leak forward.
  useEffect(() => { setDrafts({}); }, [dayIso]);

  function updateDraft(pilotId: string, patch: Partial<Draft>) {
    setDrafts(d => {
      const cur = d[pilotId] ?? { typeId: "", note: "" };
      const next = { ...cur, ...patch };
      // If the user switches away from "Other", clear any leftover reason
      // text so it doesn't get carried into a different type.
      if (patch.typeId !== undefined && patch.typeId !== OTHER_TYPE_ID) {
        next.note = "";
      }
      return { ...d, [pilotId]: next };
    });
  }

  function deleteDailyForPilot(pilotId: string) {
    // Same surgery as setAvailable: pluck today out of any entry that
    // covers it, splitting multi-day ranges so surrounding days survive.
    if (!confirm("Remove this pilot's leave for the selected day?")) return;
    void deleteLeaveForDay.mutateAsync({ pilotId, dayIso });
  }

  function setAvailable(pilotId: string) {
    // Mark "Available" by removing any single-day entry covering today.
    // Multi-day entries get split: anything that includes dayIso is
    // truncated/split so the rest of the range survives.
    void setAvailableForDay.mutateAsync({ pilotId, dayIso });
    setDrafts(d => ({ ...d, [pilotId]: { typeId: "", note: "" } }));
  }

  function submitDailyForPilot(pilotId: string) {
    const draft = drafts[pilotId];
    const existing = entriesByPilotForDay[pilotId];
    const typeId = draft?.typeId || existing?.typeId || "";
    if (!typeId) return;
    const note = typeId === OTHER_TYPE_ID
      ? (draft?.note ?? existing?.note ?? "").trim()
      : "";
    if (typeId === OTHER_TYPE_ID && !note) return; // Other requires a reason.

    void setLeaveEntry.mutateAsync({
      pilotId,
      dayIso,
      typeId,
      note: note || undefined,
    });
    setDrafts(d => ({ ...d, [pilotId]: { typeId: "", note: "" } }));
  }

  function shiftDay(delta: number) {
    const d = new Date(dayIso + "T00:00:00");
    d.setDate(d.getDate() + delta);
    setDayIso(fmtIso(d));
  }

  // Type management.
  function addType() {
    const used = new Set(types.map(t => t.color));
    const next = PALETTE.find(c => !used.has(c)) ?? PALETTE[Math.floor(Math.random() * PALETTE.length)];
    void upsertLeaveType.mutateAsync({
      id: crypto.randomUUID(),
      name: "New type",
      color: next,
    });
  }
  function updateType(id: string, patch: Partial<LeaveType>) {
    const current = types.find((t) => t.id === id);
    if (!current) return;
    void upsertLeaveType.mutateAsync({ ...current, ...patch });
  }
  function removeType(id: string) {
    if (id === OTHER_TYPE_ID) {
      alert("The 'Other' type is built-in and cannot be removed.");
      return;
    }
    if (!confirm("Delete this leave type? Existing entries that use it will keep showing the raw type id.")) return;
    void deleteLeaveType.mutateAsync(id);
  }

  const typeById = useMemo(() => Object.fromEntries(types.map(t => [t.id, t])), [types]);

  // Quick stats for the daily view header.
  const dailyStats = useMemo(() => {
    let onLeave = 0;
    PILOTS.forEach(p => {
      if (entriesByPilotForDay[p.id]) onLeave += 1;
    });
    return { onLeave, available: PILOTS.length - onLeave, total: PILOTS.length };
  }, [PILOTS, entriesByPilotForDay]);

  return (
    <div>
      <PageHead
        title={t("nav_leaves")}
        subtitle="Daily availability · weekly & monthly totals"
        actions={
          <div className="flex gap-2 no-print">
            <div className="inline-flex rounded-md border border-border overflow-hidden">
              <button
                onClick={() => setView("daily")}
                className={`px-3 py-1.5 text-xs ${view === "daily" ? "bg-primary text-primary-foreground" : "bg-secondary"}`}
                data-testid="button-leaves-view-daily"
              >Daily</button>
              <button
                onClick={() => setView("weekly")}
                className={`px-3 py-1.5 text-xs ${view === "weekly" ? "bg-primary text-primary-foreground" : "bg-secondary"}`}
                data-testid="button-leaves-view-weekly"
              >Weekly</button>
              <button
                onClick={() => setView("monthly")}
                className={`px-3 py-1.5 text-xs ${view === "monthly" ? "bg-primary text-primary-foreground" : "bg-secondary"}`}
                data-testid="button-leaves-view-monthly"
              >Monthly</button>
            </div>
            <Button size="sm" variant="outline" onClick={() => setShowSettings(s => !s)} data-testid="button-leaves-types">
              <Cog className="h-4 w-4 me-1" /> Types
            </Button>
            <Button
              size="sm"
              onClick={() => window.print()}
              data-testid="button-leaves-print"
              title="Print"
            >
              <Printer className="h-4 w-4 me-1" /> {t("print")}
            </Button>
          </div>
        }
      />

      <div data-print-area>
      {/* The shared print header — visible only on paper. Must live
          INSIDE data-print-area so the global print isolation rules
          keep it visible. */}
      <PrintHeader
        title={t("nav_leaves")}
        context={
          view === "daily" ? `Day: ${dayIso}` :
          view === "weekly" ? `Weekly · ${MONTHS[month]} ${year}` :
          `Monthly · ${year}`
        }
      />
      {/* Top controls: time bucket selectors per view + legend */}
      <div className="flex flex-wrap items-center gap-2 mb-3 no-print">
        {view === "daily" && (
          <>
            <button
              onClick={() => shiftDay(-1)}
              className="p-1.5 rounded-md bg-secondary border border-border hover:bg-secondary/70"
              data-testid="button-leaves-prev-day"
              title="Previous day"
            ><ChevronLeft className="h-4 w-4" /></button>
            <CalendarPickerInput
              value={dayIso}
              onChange={setDayIso}
              className="px-2 py-1 rounded bg-input border border-border text-sm font-mono"
              data-testid="input-leaves-day"
            />
            <button
              onClick={() => shiftDay(1)}
              className="p-1.5 rounded-md bg-secondary border border-border hover:bg-secondary/70"
              data-testid="button-leaves-next-day"
              title="Next day"
            ><ChevronRight className="h-4 w-4" /></button>
            <button
              onClick={() => setDayIso(fmtIso(new Date()))}
              className="px-2 py-1 rounded-md text-xs bg-secondary border border-border hover:bg-secondary/70"
              data-testid="button-leaves-today"
            >Today</button>
            <div className="ms-auto flex items-center gap-3 text-xs">
              <span className="inline-flex items-center gap-1 text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" /> Available
                <span className="font-mono font-semibold ms-1" data-testid="text-leaves-available">{dailyStats.available}</span>
              </span>
              <span className="inline-flex items-center gap-1 text-amber-300">
                On leave
                <span className="font-mono font-semibold ms-1" data-testid="text-leaves-onleave">{dailyStats.onLeave}</span>
              </span>
              <span className="text-muted-foreground">/ {dailyStats.total}</span>
            </div>
          </>
        )}
        {view !== "daily" && (
          <>
            <label className="text-xs"><span className="text-muted-foreground me-1">Year</span>
              <input
                type="number"
                value={year}
                onChange={e => setYear(Number(e.target.value) || today.getFullYear())}
                className="w-24 px-2 py-1 rounded bg-input border border-border text-sm"
                data-testid="input-leaves-year"
              />
            </label>
            {view === "weekly" && (
              <label className="text-xs"><span className="text-muted-foreground me-1">Month</span>
                <select
                  value={month}
                  onChange={e => setMonth(Number(e.target.value))}
                  className="px-2 py-1 rounded bg-input border border-border text-sm"
                  data-testid="select-leaves-month"
                >
                  {MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
                </select>
              </label>
            )}
            <div className="ms-auto flex flex-wrap items-center gap-2 text-xs">
              {types.map(tp => (
                <span key={tp.id} className="inline-flex items-center gap-1">
                  <span className="w-3 h-3 rounded-sm border border-border" style={{ background: tp.color }} />
                  {tp.name}
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {showSettings && (
        <Card className="mb-3">
          <div className="text-sm font-semibold mb-2">Leave Types</div>
          <div className="space-y-2">
            {types.map(tp => (
              <div key={tp.id} className="flex items-center gap-2">
                <input
                  type="color"
                  value={tp.color}
                  onChange={e => updateType(tp.id, { color: e.target.value })}
                  className="w-9 h-9 rounded border border-border bg-transparent"
                  data-testid={`input-type-color-${tp.id}`}
                />
                <input
                  value={tp.name}
                  onChange={e => updateType(tp.id, { name: e.target.value })}
                  disabled={tp.id === OTHER_TYPE_ID}
                  className="flex-1 px-2 py-1.5 rounded bg-input border border-border text-sm disabled:opacity-70"
                  data-testid={`input-type-name-${tp.id}`}
                />
                <button
                  onClick={() => removeType(tp.id)}
                  disabled={tp.id === OTHER_TYPE_ID}
                  className="p-1.5 rounded hover:bg-destructive/20 text-destructive disabled:opacity-30 disabled:hover:bg-transparent"
                  title={tp.id === OTHER_TYPE_ID ? "Built-in" : "Delete type"}
                  data-testid={`button-delete-type-${tp.id}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <Button size="sm" variant="outline" onClick={addType} data-testid="button-add-type">
              <Plus className="h-4 w-4 me-1" /> Add type
            </Button>
          </div>
        </Card>
      )}

      {view === "daily" && (
        <Card className="!p-0 overflow-x-auto" data-testid="card-leaves-daily">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 uppercase tracking-wider text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Pilot</th>
                <th className="px-3 py-2 text-left">Status today</th>
                <th className="px-3 py-2 text-left w-[260px]">Set leave type</th>
                <th className="px-3 py-2 text-left w-[260px]">Reason (Other)</th>
                <th className="px-3 py-2 text-right w-[160px]">Action</th>
              </tr>
            </thead>
            <tbody>
              {PILOTS.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-xs text-muted-foreground" data-testid="empty-leaves-daily">
                    {pilotsQ.isError ? "—" : t("no_records")}
                  </td>
                </tr>
              )}
              {PILOTS.map(p => {
                const existing = entriesByPilotForDay[p.id];
                const draft = drafts[p.id] ?? { typeId: existing?.typeId ?? "", note: existing?.note ?? "" };
                const effectiveType = draft.typeId || existing?.typeId || "";
                const tp = effectiveType ? typeById[effectiveType] : undefined;
                const isOther = effectiveType === OTHER_TYPE_ID;
                return (
                  <tr key={p.id} className="border-t border-border align-middle">
                    <td className="px-3 py-2">
                      <div className="font-medium">{p.name}</div>
                      <div className="text-[11px] text-muted-foreground font-mono">{rankOf(p)} · {p.militaryNumber ?? "—"}</div>
                    </td>
                    <td className="px-3 py-2">
                      {existing ? (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] rounded px-1.5 py-0.5 border"
                          style={{
                            borderColor: typeById[existing.typeId]?.color ?? "#888",
                            background: `${typeById[existing.typeId]?.color ?? "#888"}22`,
                          }}
                          data-testid={`status-pilot-${p.id}`}
                        >
                          <span className="w-2 h-2 rounded-sm" style={{ background: typeById[existing.typeId]?.color ?? "#888" }} />
                          {typeById[existing.typeId]?.name ?? existing.typeId}
                          {existing.note ? <span className="opacity-80">· {existing.note}</span> : null}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300" data-testid={`status-pilot-${p.id}`}>
                          <CheckCircle2 className="h-3 w-3" /> Available
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={draft.typeId || existing?.typeId || ""}
                        onChange={e => updateDraft(p.id, { typeId: e.target.value })}
                        className="w-full px-2 py-1.5 rounded bg-input border border-border text-sm"
                        data-testid={`select-leave-type-${p.id}`}
                      >
                        <option value="">— choose —</option>
                        {types.map(tt => <option key={tt.id} value={tt.id}>{tt.name}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={draft.note ?? existing?.note ?? ""}
                        onChange={e => updateDraft(p.id, { note: e.target.value })}
                        disabled={!isOther}
                        placeholder={isOther ? "Type a reason…" : "—"}
                        className="w-full px-2 py-1.5 rounded bg-input border border-border text-sm disabled:opacity-50"
                        data-testid={`input-leave-note-${p.id}`}
                      />
                      {isOther && !((draft.note ?? existing?.note ?? "").trim()) ? (
                        <div className="text-[10px] text-amber-300 mt-0.5">A reason is required for Other.</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setAvailable(p.id)}
                          disabled={!existing}
                          data-testid={`button-leave-available-${p.id}`}
                          title="Mark Available (clear today's leave)"
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 me-1" /> Available
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => deleteDailyForPilot(p.id)}
                          disabled={!existing}
                          data-testid={`button-leave-delete-${p.id}`}
                          title="Delete this pilot's leave for the selected day"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => submitDailyForPilot(p.id)}
                          disabled={
                            !effectiveType
                            || (isOther && !(draft.note ?? existing?.note ?? "").trim())
                          }
                          data-testid={`button-leave-submit-${p.id}`}
                          title={existing ? "Save changes (overwrites today's entry)" : "Save leave for the selected day"}
                        >
                          <Save className="h-3.5 w-3.5 me-1" /> {existing ? "Update" : "Submit"}
                        </Button>
                      </div>
                      {tp ? (
                        <div className="text-[10px] text-muted-foreground mt-1">
                          {existing ? "Will overwrite to: " : "Will set: "}
                          <span style={{ color: tp.color }}>{tp.name}</span>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {(view === "weekly" || view === "monthly") && (
        <Card className="!p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 uppercase tracking-wider text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Pilot</th>
                {view === "monthly"
                  ? MONTHS.map(m => <th key={m} className="px-2 py-2 text-right">{m}</th>)
                  : weeklyBuckets.map(b => <th key={b.label} className="px-2 py-2 text-right">{b.label}</th>)
                }
                <th className="px-2 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {PILOTS.length === 0 && (
                <tr>
                  <td colSpan={(view === "monthly" ? MONTHS.length : weeklyBuckets.length) + 2} className="px-3 py-6 text-center text-xs text-muted-foreground" data-testid="empty-leaves">
                    {pilotsQ.isError ? "—" : t("no_records")}
                  </td>
                </tr>
              )}
              {PILOTS.map(p => {
                const arr = view === "monthly" ? monthlyAgg[p.id] : weeklyAgg[p.id];
                const total = (arr ?? []).reduce((a, b) => a + b, 0);
                return (
                  <tr key={p.id} className="border-t border-border row-hover">
                    <td className="px-3 py-2">{p.name}</td>
                    {(arr ?? []).map((v, i) => (
                      <td key={i} className="px-2 py-2 text-right font-mono" data-testid={`cell-leaves-${view}-${p.id}-${i}`}>
                        {v || <span className="text-muted-foreground/50">·</span>}
                      </td>
                    ))}
                    <td className="px-2 py-2 text-right font-mono font-semibold gold-text" data-testid={`cell-leaves-${view}-${p.id}-total`}>{total}</td>
                  </tr>
                );
              })}
            </tbody>
            {PILOTS.length > 0 && (
              <tfoot className="bg-secondary/30 border-t-2 border-border" data-testid={`row-leaves-${view}-totals`}>
                <tr className="font-semibold">
                  <td className="px-3 py-2 text-xs uppercase tracking-wider gold-text">Squadron total</td>
                  {(view === "monthly"
                    ? Array.from({ length: 12 }, (_, i) => PILOTS.reduce((a, p) => a + (monthlyAgg[p.id]?.[i] ?? 0), 0))
                    : weeklyBuckets.map((_, i) => PILOTS.reduce((a, p) => a + (weeklyAgg[p.id]?.[i] ?? 0), 0))
                  ).map((v, i) => (
                    <td key={i} className="px-2 py-2 text-right font-mono">{v || "·"}</td>
                  ))}
                  <td className="px-2 py-2 text-right font-mono font-bold gold-text" data-testid="text-squadron-grand-total">
                    {PILOTS.reduce((a, p) => {
                      const arr = view === "monthly" ? monthlyAgg[p.id] : weeklyAgg[p.id];
                      return a + (arr?.reduce((x, y) => x + y, 0) ?? 0);
                    }, 0)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </Card>
      )}
      </div>
    </div>
  );
}
