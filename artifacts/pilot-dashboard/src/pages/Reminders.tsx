import { useMemo, useState } from "react";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import {
  usePilots,
  useReminderOverview,
  type CurrencyKeyName,
  type ReminderOverviewRow,
} from "@/lib/squadron-data";
import type { Pilot } from "@/lib/mock";
import { isCurrencyHidden } from "@/lib/mock";
import { Bell, BellOff, FileDown } from "lucide-react";

const CURRENCY_KEYS: readonly CurrencyKeyName[] = ["day", "night", "irt", "medical", "sim"] as const;

type FilterKey = "all" | "no_prefs" | "due_14" | "due_today";

function daysUntil(dateStr: string | undefined | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((d.getTime() - Date.now()) / 86400000);
}

interface Joined {
  pilot: Pilot;
  prefs: ReminderOverviewRow | null;
  soonestDays: number | null;
  soonestKey: CurrencyKeyName | null;
}

function joinPrefs(pilots: Pilot[], prefs: ReminderOverviewRow[]): Joined[] {
  const byPilot = new Map(prefs.map(p => [p.pilotId, p]));
  return pilots.map(p => {
    const trackable = CURRENCY_KEYS.filter(k => !isCurrencyHidden(p, k));
    let soonestDays: number | null = null;
    let soonestKey: CurrencyKeyName | null = null;
    for (const k of trackable) {
      const d = daysUntil(p.expiry[k]);
      if (d === null) continue;
      if (soonestDays === null || d < soonestDays) {
        soonestDays = d;
        soonestKey = k;
      }
    }
    return { pilot: p, prefs: byPilot.get(p.id) ?? null, soonestDays, soonestKey };
  });
}

function hasAnyThreshold(t: ReminderOverviewRow["thresholds"]): boolean {
  return CURRENCY_KEYS.some(k => Array.isArray(t[k]) && (t[k] as number[]).length > 0);
}

function formatThresholds(t: ReminderOverviewRow["thresholds"]): string {
  const parts: string[] = [];
  for (const k of CURRENCY_KEYS) {
    const arr = t[k];
    if (Array.isArray(arr) && arr.length > 0) {
      parts.push(`${k.toUpperCase()}: ${arr.join("/")}d`);
    }
  }
  return parts.length ? parts.join(" · ") : "—";
}

function formatTs(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function csvEscape(v: string): string {
  const needs = /[",\n\r]/.test(v);
  const cleaned = v.replace(/"/g, '""');
  return needs ? `"${cleaned}"` : cleaned;
}

export default function Reminders() {
  const { t, rankOf } = useI18n();
  const { data: pilots } = usePilots();
  const { data: prefs, isLoading } = useReminderOverview();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");

  const joined = useMemo(() => joinPrefs(pilots, prefs), [pilots, prefs]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return joined.filter(({ pilot, prefs, soonestDays }) => {
      if (q && !`${rankOf(pilot)} ${pilot.name} ${pilot.arabicName}`.toLowerCase().includes(q)) {
        return false;
      }
      if (filter === "no_prefs") {
        return !prefs?.pushEnabled || !hasAnyThreshold(prefs?.thresholds ?? {});
      }
      if (filter === "due_14") {
        return soonestDays !== null && soonestDays >= 0 && soonestDays <= 14;
      }
      if (filter === "due_today") {
        return soonestDays === 0;
      }
      return true;
    }).sort((a, b) => {
      // Most urgent first; pilots with no expiry data sink.
      const da = a.soonestDays ?? Number.POSITIVE_INFINITY;
      const db = b.soonestDays ?? Number.POSITIVE_INFINITY;
      return da - db;
    });
  }, [joined, filter, search]);

  function exportCsv() {
    const headers = [
      t("name"),
      "Push",
      "Platform",
      "Thresholds",
      "Soonest expiry",
      "Days remaining",
      "Last reminder",
      "Last reminder currency",
      "Last reminder threshold",
    ];
    const rows = filtered.map(({ pilot, prefs, soonestDays, soonestKey }) => [
      `${rankOf(pilot)} ${pilot.name}`,
      prefs?.pushEnabled ? "on" : "off",
      prefs?.platform ?? "",
      formatThresholds(prefs?.thresholds ?? {}),
      soonestKey && pilot.expiry[soonestKey] ? `${soonestKey} ${pilot.expiry[soonestKey]}` : "",
      soonestDays === null ? "" : String(soonestDays),
      formatTs(prefs?.lastSentAt ?? null),
      prefs?.lastSentCurrency ?? "",
      prefs?.lastSentThresholdDays === null || prefs?.lastSentThresholdDays === undefined
        ? ""
        : `${prefs.lastSentThresholdDays}d`,
    ]);
    const csv = [headers, ...rows].map(r => r.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pilot-reminders-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const FILTERS: ReadonlyArray<{ k: FilterKey; label: string }> = [
    { k: "all", label: t("all") },
    { k: "no_prefs", label: t("reminders_filter_no_prefs") },
    { k: "due_14", label: t("reminders_filter_due_14") },
    { k: "due_today", label: t("reminders_filter_due_today") },
  ];

  const totalEnrolled = joined.filter(j => j.prefs?.pushEnabled).length;
  const totalUnconfigured = joined.filter(
    j => !j.prefs?.pushEnabled || !hasAnyThreshold(j.prefs?.thresholds ?? {}),
  ).length;

  return (
    <div>
      <PageHead
        title={t("nav_reminders")}
        subtitle={t("reminders_subtitle")}
        actions={
          <button
            onClick={exportCsv}
            className="px-3 py-1.5 rounded-md bg-secondary border border-border text-sm inline-flex items-center gap-1.5"
            data-testid="button-reminders-export-csv"
          >
            <FileDown className="h-4 w-4" /> {t("exportCsv")}
          </button>
        }
      />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <Card>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            {t("reminders_stat_enrolled")}
          </div>
          <div className="text-2xl font-semibold gold-grad mt-1">{totalEnrolled}</div>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            {t("reminders_stat_unconfigured")}
          </div>
          <div className="text-2xl font-semibold text-amber-300 mt-1">{totalUnconfigured}</div>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            {t("reminders_stat_total")}
          </div>
          <div className="text-2xl font-semibold mt-1">{joined.length}</div>
        </Card>
      </div>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {FILTERS.map(f => (
          <button
            key={f.k}
            onClick={() => setFilter(f.k)}
            className={`px-3 py-1.5 rounded-md text-xs ${
              filter === f.k
                ? "bg-primary text-primary-foreground"
                : "bg-secondary border border-border"
            }`}
            data-testid={`filter-${f.k}`}
          >
            {f.label}
          </button>
        ))}
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t("search")}
          className="ms-auto px-3 py-1.5 rounded-md bg-card border border-border text-sm"
          data-testid="input-reminders-search"
        />
      </div>

      <Card className="!p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-secondary/50 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">{t("name")}</th>
              <th className="px-3 py-2 text-left">{t("reminders_col_push")}</th>
              <th className="px-3 py-2 text-left">{t("reminders_col_thresholds")}</th>
              <th className="px-3 py-2 text-left">{t("reminders_col_soonest")}</th>
              <th className="px-3 py-2 text-left">{t("reminders_col_last_sent")}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td className="px-3 py-3 text-muted-foreground" colSpan={5}>
                  {t("loading")}
                </td>
              </tr>
            )}
            {!isLoading && filtered.length === 0 && (
              <tr>
                <td className="px-3 py-3 text-muted-foreground" colSpan={5}>
                  {t("noResults")}
                </td>
              </tr>
            )}
            {filtered.map(({ pilot, prefs, soonestDays, soonestKey }) => {
              const enrolled = Boolean(prefs?.pushEnabled);
              const threshSummary = formatThresholds(prefs?.thresholds ?? {});
              const noThresholds = threshSummary === "—";
              const dueCls =
                soonestDays === null
                  ? "text-muted-foreground"
                  : soonestDays < 0
                    ? "text-rose-300"
                    : soonestDays <= 14
                      ? "text-amber-300"
                      : "text-emerald-300";
              return (
                <tr
                  key={pilot.id}
                  className="border-t border-border row-hover"
                  data-testid={`row-pilot-${pilot.id}`}
                >
                  <td className="px-3 py-2">
                    <div>{rankOf(pilot)} {pilot.name}</div>
                    <div className="text-xs text-muted-foreground">{pilot.arabicName}</div>
                  </td>
                  <td className="px-3 py-2">
                    {enrolled ? (
                      <span className="inline-flex items-center gap-1 text-emerald-300">
                        <Bell className="h-3.5 w-3.5" /> {t("enabled")}
                        {prefs?.platform && (
                          <span className="text-[10px] uppercase text-muted-foreground ms-1">
                            {prefs.platform}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-muted-foreground">
                        <BellOff className="h-3.5 w-3.5" /> {t("disabled")}
                      </span>
                    )}
                  </td>
                  <td className={`px-3 py-2 font-mono text-xs ${noThresholds ? "text-muted-foreground" : ""}`}>
                    {threshSummary}
                  </td>
                  <td className="px-3 py-2">
                    {soonestKey && pilot.expiry[soonestKey] ? (
                      <span>
                        <span className="text-muted-foreground me-1">
                          {soonestKey.toUpperCase()}
                        </span>
                        <span className="font-mono">{pilot.expiry[soonestKey]}</span>
                        <span className={`ms-2 ${dueCls}`}>
                          {soonestDays !== null && soonestDays < 0
                            ? t("expiredNDays").replace("{n}", String(-soonestDays))
                            : soonestDays !== null
                              ? t("daysLeft").replace("{n}", String(soonestDays))
                              : ""}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {prefs?.lastSentAt ? (
                      <div>
                        <div className="font-mono text-xs">{formatTs(prefs.lastSentAt)}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {prefs.lastSentCurrency?.toUpperCase()} ·{" "}
                          {prefs.lastSentThresholdDays}d {t("reminders_before_expiry")}
                        </div>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">{t("reminders_never_fired")}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
