// "Expiring this month" widget — shows every currency that lapses in the
// next 30 days (or already has lapsed) for any pilot in the squadron.
// Mounted on the Ops dashboard so commanders see at-a-glance who they need
// to schedule. Reuses the same expiry shape stored on every Pilot record;
// no new data flow. Task #337.

import { useMemo } from "react";
import { Link } from "wouter";
import { Card } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { usePilots } from "@/lib/squadron-data";
import { CalendarClock, ChevronRight, Activity } from "lucide-react";

type Severity = "warn" | "bad";
const TRACKED_KEYS = ["day", "night", "nvg", "irt", "medical"] as const;

interface ExpiringRow {
  pilotId: string;
  pilotName: string;
  type: string;
  expiry: string;
  daysLeft: number;
  severity: Severity;
}

function statusOf(dateStr: string): Severity | "ok" | "missing" {
  if (!dateStr) return "missing";
  const parts = dateStr.split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return "missing";
  const expiry = new Date(parts[0], parts[1] - 1, parts[2]).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((expiry - today) / 86400000);
  if (days < 0) return "bad";
  if (days <= 30) return "warn";
  return "ok";
}

export function CurrencyExpiringPanel({ testId = "panel-currency-expiring" }: { testId?: string }) {
  const { t, rankOf } = useI18n();
  const { data: PILOTS } = usePilots();

  const rows = useMemo<ExpiringRow[]>(() => {
    const out: ExpiringRow[] = [];
    PILOTS.forEach(p => {
      TRACKED_KEYS.forEach(k => {
        if (p.hiddenCurrencies?.includes(k)) return;
        const exp = p.expiry?.[k];
        const s = statusOf(exp);
        if (s !== "warn" && s !== "bad") return;
        const ts = new Date(exp + "T00:00:00").getTime();
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const days = Math.round((ts - today.getTime()) / 86400000);
        out.push({
          pilotId: p.id,
          pilotName: `${rankOf(p)} ${p.name}`.trim(),
          type: k.toUpperCase(),
          expiry: exp,
          daysLeft: days,
          severity: s,
        });
      });
    });
    return out.sort((a, b) => a.daysLeft - b.daysLeft);
  }, [PILOTS, rankOf]);

  const expiredCount = rows.filter(r => r.severity === "bad").length;
  const warnCount = rows.length - expiredCount;

  return (
    <Card className="rise" data-testid={testId}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-amber-400" />
          <h3 className="text-sm font-semibold tracking-wide">{t("expiringMonthTitle")}</h3>
          {rows.length > 0 && (
            <span className={`text-[11px] px-2 py-0.5 rounded-full font-mono ${
              expiredCount > 0 ? "bg-destructive/15 text-destructive"
                               : "bg-amber-500/15 text-amber-300"
            }`} data-testid={`${testId}-count`}>
              {expiredCount > 0 ? `${expiredCount}!` : warnCount}
            </span>
          )}
        </div>
        <Link href="/expired" className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1" data-testid={`${testId}-open`}>
          {t("expiringMonthOpen")} <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <p className="text-[11px] text-muted-foreground mb-2">{t("expiringMonthHint")}</p>

      {rows.length === 0 ? (
        <div className="flex items-center gap-3 py-5 px-3 text-muted-foreground text-sm" data-testid={`${testId}-empty`}>
          <div className="h-9 w-9 rounded-full bg-secondary/60 border border-border flex items-center justify-center text-emerald-300">
            <Activity className="h-5 w-5" />
          </div>
          <div>{t("expiringMonthEmpty")}</div>
        </div>
      ) : (
        <div className="space-y-1.5 max-h-72 overflow-y-auto pe-1">
          {rows.slice(0, 12).map((r, i) => {
            const tone = r.severity === "bad"
              ? "border-destructive/40 bg-destructive/5 text-rose-200"
              : "border-amber-500/30 bg-amber-500/5 text-amber-100";
            const label = r.severity === "bad"
              ? t("expiringMonthExpired")
              : t("expiringMonthDays").replace("{n}", String(r.daysLeft));
            return (
              <Link
                key={`${r.pilotId}-${r.type}-${i}`}
                href={`/pilot/${r.pilotId}`}
                className={`flex items-center justify-between gap-3 px-3 py-1.5 rounded-md border lift hover:opacity-90 ${tone}`}
                data-testid={`${testId}-row-${i}`}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate text-foreground">{r.pilotName}</div>
                  <div className="text-[10px] uppercase font-mono opacity-80">{r.type} · {r.expiry}</div>
                </div>
                <span className="text-[11px] font-mono font-semibold whitespace-nowrap">{label}</span>
              </Link>
            );
          })}
          {rows.length > 12 && (
            <Link href="/expired" className="block text-center text-[11px] text-muted-foreground hover:text-primary py-1.5" data-testid={`${testId}-more`}>
              + {rows.length - 12} more — view all
            </Link>
          )}
        </div>
      )}
    </Card>
  );
}
