import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import {
  fetchInternalSystemHealth,
  type SystemHealthReport,
  type SystemHealthComponent,
} from "@/lib/internal-migration";
import { HeartPulse, RefreshCw } from "lucide-react";
import { fmtDateTime } from "@/lib/format";
import MdnsHealthCard from "@/components/MdnsHealthCard";

const REFRESH_MS = 30_000;

function severityBadge(sev: SystemHealthComponent["severity"]) {
  if (sev === "ok") {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/15 border border-emerald-500/30">
        <span className="inline-block size-2 rounded-full bg-emerald-500 me-2" />
        OK
      </Badge>
    );
  }
  if (sev === "warn") {
    return (
      <Badge className="bg-amber-500/15 text-amber-800 hover:bg-amber-500/15 border border-amber-500/40">
        <span className="inline-block size-2 rounded-full bg-amber-500 me-2" />
        WARN
      </Badge>
    );
  }
  return (
    <Badge className="bg-red-500/15 text-red-800 hover:bg-red-500/15 border border-red-500/40">
      <span className="inline-block size-2 rounded-full bg-red-500 me-2" />
      FAIL
    </Badge>
  );
}

function detailLines(detail: Record<string, unknown> | null | undefined): string[] {
  if (!detail) return [];
  return Object.entries(detail).map(([k, v]) => {
    let s: string;
    if (v === null || v === undefined) s = "—";
    else if (typeof v === "object") s = JSON.stringify(v);
    else s = String(v);
    return `${k}: ${s}`;
  });
}

export default function SystemHealth() {
  const { t, lang } = useI18n();
  const [report, setReport] = useState<SystemHealthReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchInternalSystemHealth();
      if (!r) {
        setError("system_health_unavailable");
        setReport(null);
      } else {
        setReport(r);
      }
      setLastFetched(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setReport(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    const id = window.setInterval(() => {
      void reload();
    }, REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  const overall = report?.overall ?? "warn";
  const overallLabel = useMemo(() => {
    if (!report) return t("system_health_loading");
    if (overall === "ok") return t("system_health_overall_ok");
    if (overall === "warn") return t("system_health_overall_warn");
    return t("system_health_overall_fail");
  }, [report, overall, t]);

  return (
    <div className="space-y-4" dir={lang === "ar" ? "rtl" : "ltr"}>
      <div className="flex items-center gap-3">
        <HeartPulse className="h-6 w-6 text-primary" />
        <h2 className="text-xl font-semibold flex-1">{t("system_health_title")}</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void reload()}
          disabled={loading}
          data-testid="btn-system-health-refresh"
        >
          <RefreshCw className={`h-4 w-4 me-2 ${loading ? "animate-spin" : ""}`} />
          {t("system_health_refresh")}
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">{t("system_health_blurb")}</p>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            {severityBadge(overall)}
            <span>{overallLabel}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground space-y-1">
          {report ? (
            <>
              <div>
                {t("system_health_install_profile")}: <span className="font-mono">{report.installProfile}</span>
                {" · "}
                {t("system_health_schema_version")}: <span className="font-mono">{report.schemaVersion}</span>
              </div>
              <div>
                {t("system_health_generated_at")}: {fmtDateTime(report.generatedAt, lang)}
              </div>
            </>
          ) : null}
          {lastFetched ? (
            <div>
              {t("system_health_last_polled")}: {fmtDateTime(lastFetched.toISOString(), lang)}
            </div>
          ) : null}
          {error ? (
            <div className="text-red-700">
              {t("system_health_unreachable")}: <span className="font-mono">{error}</span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        {(report?.components ?? []).map((c) => (
          <Card key={c.key} data-testid={`system-health-card-${c.key}`}>
            <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm font-medium">{c.key}</CardTitle>
              {severityBadge(c.severity)}
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm">{c.message}</p>
              {detailLines(c.detail).length > 0 ? (
                <div className="rounded border border-border/60 bg-muted/40 px-2 py-1 font-mono text-[11px] leading-snug space-y-0.5">
                  {detailLines(c.detail).map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        ))}
        {/* mDNS broadcast badge (Task #398). The supervisor task itself
            stays Running even when dns-sd.exe is between restarts, so a
            generic scheduled-task view does not catch this — surfaced
            here next to the other host-level checks. */}
        <MdnsHealthCard />
      </div>
    </div>
  );
}
