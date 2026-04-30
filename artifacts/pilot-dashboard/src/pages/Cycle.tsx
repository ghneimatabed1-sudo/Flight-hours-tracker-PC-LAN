import { useMemo } from "react";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { SIX_MONTH_TASKS } from "@/lib/mock";
import { usePilots, useSorties } from "@/lib/squadron-data";
import { computeAllTotals, formatHours } from "@/lib/calculations";
import { supabaseConfigured } from "@/lib/supabase";
import { DataUnavailableBanner } from "@/components/DataUnavailableBanner";

function rng(seed: number) { let s = seed; return () => (s = (s * 9301 + 49297) % 233280) / 233280; }

export default function Cycle() {
  const { t, rankOf } = useI18n();
  const pilotsQ = usePilots();
  const sortiesQ = useSorties();
  // Belt-and-suspenders. usePilots / useSorties promise to always return an
  // array (the hook fills `data ?? fallback`), but if a future regression
  // ever lets `data` be undefined the destructure used to make this page
  // throw on first render — which surfaces as a "STARTUP ERROR (EARLY)"
  // overlay because the inner ErrorBoundary unmounts the whole router.
  // Default-coerce here so a hook-shape regression cannot take the
  // dashboard down for ops users (Audit L, F-J-01).
  const PILOTS = pilotsQ.data ?? [];
  const SORTIES = sortiesQ.data ?? [];
  // The legacy `currencies` Supabase table was a silent dead-end (never
  // written to). With it removed, live status defaults to "missing" in
  // production and falls back to deterministic demo values offline so the
  // grid still renders something for screenshots / training.
  const demo = rng(7);
  const statusOf = (_pid: string, _task: string): "done" | "partial" | "missing" => {
    if (supabaseConfigured) return "missing";
    const v = demo();
    return v > 0.4 ? "done" : v > 0.2 ? "partial" : "missing";
  };

  const totals = useMemo(() => computeAllTotals(PILOTS, SORTIES), [PILOTS, SORTIES]);
  const yearLabel = new Date().getFullYear();

  return (
    <div>
      <PageHead title={t("nav_cycle")} subtitle={`Six-month cycle · ${yearLabel}`} />
      <DataUnavailableBanner queries={[pilotsQ, sortiesQ]} testId="banner-cycle-unavailable" />

      <Card className="mb-4 !p-0 overflow-hidden">
        <div className="px-4 py-2 border-b border-border flex items-center justify-between">
          <div className="text-sm font-semibold">H1 / H2 Hours · {yearLabel}</div>
          <div className="text-[11px] text-muted-foreground">H1 = Jan–Jun · H2 = Jul–Dec · NVG kept separate from Night</div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-secondary/50 uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Pilot</th>
                <th className="px-2 py-2 text-right">H1 Day</th>
                <th className="px-2 py-2 text-right">H1 Night</th>
                <th className="px-2 py-2 text-right text-rose-300">H1 NVG</th>
                <th className="px-2 py-2 text-right">H1 Sim</th>
                <th className="px-2 py-2 text-right">H1 Capt</th>
                <th className="px-2 py-2 text-right">H1 #</th>
                <th className="px-2 py-2 text-right">H1 Total</th>
                <th className="px-2 py-2 text-right">H2 Day</th>
                <th className="px-2 py-2 text-right">H2 Night</th>
                <th className="px-2 py-2 text-right text-rose-300">H2 NVG</th>
                <th className="px-2 py-2 text-right">H2 Sim</th>
                <th className="px-2 py-2 text-right">H2 Capt</th>
                <th className="px-2 py-2 text-right">H2 #</th>
                <th className="px-2 py-2 text-right">H2 Total</th>
                <th className="px-2 py-2 text-right text-primary">Year (H1+H2)</th>
              </tr>
            </thead>
            <tbody>
              {PILOTS.length === 0 && (
                <tr>
                  <td colSpan={16} className="px-3 py-6 text-center text-muted-foreground" data-testid="empty-cycle-hours">
                    {pilotsQ.isError || sortiesQ.isError ? "—" : t("no_records")}
                  </td>
                </tr>
              )}
              {PILOTS.map(p => {
                const tot = totals[p.id];
                if (!tot) return null;
                return (
                  <tr key={p.id} className="border-t border-border row-hover">
                    <td className="px-3 py-2">{rankOf(p)} {p.name}</td>
                    <td className="px-2 py-2 text-right font-mono">{formatHours(tot.h1.day)}</td>
                    <td className="px-2 py-2 text-right font-mono">{formatHours(tot.h1.night)}</td>
                    <td className="px-2 py-2 text-right font-mono text-rose-300">{formatHours(tot.h1.nvg)}</td>
                    <td className="px-2 py-2 text-right font-mono">{formatHours(tot.h1.sim)}</td>
                    <td className="px-2 py-2 text-right font-mono">{formatHours(tot.h1.captain)}</td>
                    <td className="px-2 py-2 text-right font-mono">{tot.h1.sorties}</td>
                    <td className="px-2 py-2 text-right font-mono">{formatHours(tot.h1.total)}</td>
                    <td className="px-2 py-2 text-right font-mono">{formatHours(tot.h2.day)}</td>
                    <td className="px-2 py-2 text-right font-mono">{formatHours(tot.h2.night)}</td>
                    <td className="px-2 py-2 text-right font-mono text-rose-300">{formatHours(tot.h2.nvg)}</td>
                    <td className="px-2 py-2 text-right font-mono">{formatHours(tot.h2.sim)}</td>
                    <td className="px-2 py-2 text-right font-mono">{formatHours(tot.h2.captain)}</td>
                    <td className="px-2 py-2 text-right font-mono">{tot.h2.sorties}</td>
                    <td className="px-2 py-2 text-right font-mono">{formatHours(tot.h2.total)}</td>
                    <td className="px-2 py-2 text-right font-mono font-semibold text-primary">{formatHours(tot.h1.total + tot.h2.total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card className="!p-0 overflow-x-auto">
        <div className="px-4 py-2 border-b border-border text-sm font-semibold">Training task tracker</div>
        <table className="w-full text-xs">
          <thead className="bg-secondary/50 uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left sticky left-0 bg-secondary/80">Pilot</th>
              {SIX_MONTH_TASKS.map(t => <th key={t} className="px-2 py-2">{t}</th>)}
            </tr>
          </thead>
          <tbody>
            {PILOTS.length === 0 && (
              <tr>
                <td colSpan={SIX_MONTH_TASKS.length + 1} className="px-3 py-6 text-center text-muted-foreground" data-testid="empty-cycle">
                  {pilotsQ.isError ? "—" : t("no_records")}
                </td>
              </tr>
            )}
            {PILOTS.map(p => (
              <tr key={p.id} className="border-t border-border">
                <td className="px-3 py-2 sticky left-0 bg-card">{rankOf(p)} {p.name}</td>
                {SIX_MONTH_TASKS.map(task => {
                  const s = statusOf(p.id, task);
                  return (
                    <td key={task} className="px-2 py-2 text-center">
                      <span className={`status-dot ${s === "done" ? "status-ok" : s === "partial" ? "status-warn" : "status-bad"}`}></span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
