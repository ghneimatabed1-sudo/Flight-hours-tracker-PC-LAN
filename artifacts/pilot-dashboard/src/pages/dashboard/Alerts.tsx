import { Link } from "wouter";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useDashPilots, useDashSquadrons } from "@/lib/dash-pilots";
import { resolveScopedIds, useSquadronScope } from "@/lib/squadron-scope";
import { currencyStatus, fmtDate } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import type { CurrencyStatus } from "@/lib/types";
import { AlertTriangle, Printer } from "lucide-react";
import { CommanderEmptyState } from "@/components/CommanderEmptyState";
import { SnapshotStalenessBanner } from "@/components/SnapshotStalenessBanner";

export default function Alerts() {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const squadrons = useDashSquadrons();
  const pilots = useDashPilots();
  const [scope] = useSquadronScope();
  if (!user) return null;
  // Topbar scope picker (HQ / multi-squadron commanders) narrows the
  // operator's authorized squadron list before alerts are computed.
  // Falls back to the union when scope is "Combined" or stale.
  const myIds = new Set(resolveScopedIds(scope, user.squadronIds));

  type AlertItem = { pilotId: string; pilot: string; sqn: string; type: string; date: string; status: CurrencyStatus };
  const items: AlertItem[] = [];
  for (const p of pilots) {
    if (!myIds.has(p.squadronId)) continue;
    const sqn = squadrons.find(s => s.id === p.squadronId);
    if (!sqn) continue;
    const checks: Array<[string, string]> = [
      [t("dayCurrency"), p.dayCurrencyDate],
      [t("nightCurrency"), p.nightCurrencyDate],
      [t("nvgCurrency"), p.nvgCurrencyDate ?? ""],
      [t("irtCurrency"), p.irtCurrencyDate],
      [t("medicalCurrency"), p.medicalCurrencyDate],
    ];
    for (const [type, date] of checks) {
      const s = currencyStatus(date);
      // "unset" fields aren't alerts — they just mean the commander hasn't
      // entered that discipline's date yet. Only real expiries/warnings
      // belong on this page.
      if (s !== "current" && s !== "unset") {
        items.push({
          pilotId: p.id,
          pilot: lang === "ar" ? p.fullNameAr : p.fullName,
          sqn: lang === "ar" ? sqn.nameAr : sqn.code,
          type, date, status: s,
        });
      }
    }
  }
  const rank: Record<CurrencyStatus, number> = { current: 0, unset: 1, warning: 2, expiringSoon: 3, critical: 4, expired: 5 };
  items.sort((a, b) => {
    if (a.status !== b.status) return rank[b.status] - rank[a.status];
    return new Date(a.date).getTime() - new Date(b.date).getTime();
  });

  const expired = items.filter(i => i.status === "expired" || i.status === "critical");
  const warning = items.filter(i => i.status === "warning" || i.status === "expiringSoon");

  return (
    <div className="space-y-4 print-area">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-xl font-bold flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-amber-500" />{t("alerts")}</h2>
        <Button size="sm" variant="outline" onClick={() => window.print()} data-testid="button-print-alerts" className="no-print">
          <Printer className="h-3.5 w-3.5 me-1" />{t("print")}
        </Button>
      </div>

      {/* Wing/Base/HQ tier empty-state explainer (audit F-B-01). */}
      <CommanderEmptyState surface="alerts" />
      <SnapshotStalenessBanner />

      <Section title={`${t("expired")} (${expired.length})`} items={expired} t={t} />
      <Section title={`${t("expiringSoon")} (${warning.length})`} items={warning} t={t} />
    </div>
  );
}

function Section({ title, items, t }: { title: string; items: Array<{ pilotId: string; pilot: string; sqn: string; type: string; date: string; status: CurrencyStatus }>; t: (k: never) => string }) {
  const { lang } = useI18n();
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="p-0">
        {items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">—</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-muted-foreground text-xs">
                  <th className="text-start py-2 px-3">{t("pilot" as never)}</th>
                  <th className="text-start py-2 px-3">{t("squadron" as never)}</th>
                  <th className="text-start py-2 px-3">{t("currencies" as never)}</th>
                  <th className="text-start py-2 px-3">{t("status" as never)}</th>
                  <th className="py-2 px-3"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((i, idx) => (
                  <tr key={idx} className="border-b border-border/60" data-testid={`row-alert-${idx}`}>
                    <td className="py-2 px-3 font-medium">{i.pilot}</td>
                    <td className="py-2 px-3">{i.sqn}</td>
                    <td className="py-2 px-3">{i.type} · <span className="tabular-nums">{fmtDate(i.date, lang)}</span></td>
                    <td className="py-2 px-3"><StatusBadge status={i.status} /></td>
                    <td className="py-2 px-3 text-end">
                      <Link href={`/dashboard/pilot/${i.pilotId}`}>
                        <Button size="sm" variant="outline" data-testid={`button-view-alert-${idx}`}>{t("viewDetails" as never)}</Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
