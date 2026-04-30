import { useI18n } from "@/lib/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Plane, Users, AlertTriangle, Printer } from "lucide-react";
import { useSquadrons } from "@/lib/squadron-store";
import { currencyStatus, pilotWorstStatus } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { FrozenAccessPanel } from "@/components/FrozenAccessPanel";
import { useAuth } from "@/lib/auth";
import { useQuery } from "@tanstack/react-query";
import { pilots as mockPilots } from "@/lib/mockData";
import { supabase, supabaseConfigured } from "@/lib/supabase";
import { fetchInternalPilotTableRows, isLanSessionLoginEnabled } from "@/lib/internal-migration";
import { worstStatusFromPilotData } from "@/lib/admin-overview-pilot-stats";

type AdminPilotStat = {
  squadronId: string;
  status: ReturnType<typeof currencyStatus> | ReturnType<typeof pilotWorstStatus>;
};

export default function AdminOverview() {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const lanMode = isLanSessionLoginEnabled();
  const squadrons = useSquadrons();
  const pilotStatsQ = useQuery<AdminPilotStat[]>({
    queryKey: ["admin_overview_pilot_stats"],
    queryFn: async () => {
      if (lanMode) {
        const rows = await fetchInternalPilotTableRows();
        if (!rows) return [];
        return rows.map((row) => ({
          squadronId: String(row.squadron_id ?? ""),
          status: worstStatusFromPilotData((row.data ?? {}) as Record<string, unknown>),
        }));
      }
      if (!supabaseConfigured || !supabase) {
        return mockPilots.map((p) => ({
          squadronId: p.squadronId,
          status: pilotWorstStatus(p),
        }));
      }
      const { data, error } = await supabase
        .from("pilots")
        .select("squadron_id,data");
      if (error) throw error;
      return (data ?? []).map((row) => ({
        squadronId: String(row.squadron_id ?? ""),
        status: worstStatusFromPilotData((row.data ?? {}) as Record<string, unknown>),
      }));
    },
    initialData: [],
  });
  const pilotStats = pilotStatsQ.data ?? [];
  const enabledSquadrons = squadrons.filter(s => s.enabled);
  const expired = pilotStats.filter(p => p.status === "expired" || p.status === "critical").length;
  const warning = pilotStats.filter(p => p.status === "warning" || p.status === "expiringSoon").length;

  const stats = [
    { icon: <Plane className="h-5 w-5" />, label: t("totalSquadrons"), value: `${enabledSquadrons.length}/${squadrons.length}` },
    { icon: <Users className="h-5 w-5" />, label: t("totalPilots"), value: pilotStats.length },
    { icon: <AlertTriangle className="h-5 w-5 text-red-500" />, label: t("expiredCurrencies"), value: expired },
  ];

  return (
    <div className="space-y-6 print-area">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-xl font-bold">{t("systemOverview")}</h2>
        <Button size="sm" variant="outline" onClick={() => window.print()} data-testid="button-print-admin-overview" className="no-print">
          <Printer className="h-3.5 w-3.5 me-1" />{t("print")}
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s, i) => (
          <Card key={i} data-testid={`stat-${i}`}>
            <CardContent className="p-4 flex items-center gap-3">
              <div className="rounded-md bg-primary/10 text-primary p-2">{s.icon}</div>
              <div>
                <div className="text-xs text-muted-foreground">{s.label}</div>
                <div className="text-2xl font-bold tabular-nums">{s.value}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("squadronStatus")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-start">
                <tr className="border-b border-border text-muted-foreground">
                  <th className="text-start py-2 px-2">{t("squadron")}</th>
                  <th className="text-start py-2 px-2">{t("base")}</th>
                  <th className="text-start py-2 px-2">{t("wing")}</th>
                  <th className="text-end py-2 px-2">{t("pilotCount")}</th>
                  <th className="text-end py-2 px-2">{t("expired")}</th>
                  <th className="text-end py-2 px-2">{t("expiringSoon")}</th>
                  <th className="text-start py-2 px-2">{t("status")}</th>
                </tr>
              </thead>
              <tbody>
                {squadrons.map(s => {
                  const sp = pilotStats.filter(p => p.squadronId === s.id);
                  const e = sp.filter(p => p.status === "expired" || p.status === "critical").length;
                  const w = sp.filter(p => p.status === "warning" || p.status === "expiringSoon").length;
                  return (
                    <tr key={s.id} className="border-b border-border/60 hover:bg-accent/40" data-testid={`row-sqn-${s.id}`}>
                      <td className="py-2 px-2 font-medium">{lang === "ar" ? s.nameAr : s.name}</td>
                      <td className="py-2 px-2">{lang === "ar" ? s.baseAr : s.base}</td>
                      <td className="py-2 px-2">{lang === "ar" ? s.wingAr : s.wing}</td>
                      <td className="py-2 px-2 text-end tabular-nums">{sp.length}</td>
                      <td className="py-2 px-2 text-end tabular-nums">{e > 0 ? <StatusBadge status="expired" /> : "—"}</td>
                      <td className="py-2 px-2 text-end tabular-nums">{w > 0 ? <span className="font-medium">{w}</span> : "—"}</td>
                      <td className="py-2 px-2">{s.enabled ? <span className="text-emerald-600">●</span> : <span className="text-muted-foreground">○</span>} <span className="ms-1 text-xs">{s.enabled ? t("enabled") : t("disabled")}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground mt-2">{warning} {t("expiringSoon")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          <FrozenAccessPanel actor={user?.username ?? "super.admin"} />
        </CardContent>
      </Card>
    </div>
  );
}
