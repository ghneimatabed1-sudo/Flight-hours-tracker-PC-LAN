import { Link, useRoute } from "wouter";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDashPilots, useDashSquadrons } from "@/lib/dash-pilots";
import { pilotWorstStatus, pilotWorstDate, currencyStatus, fmtDate } from "@/lib/format";
import { StatusBadge } from "@/components/StatusBadge";
import { ChevronLeft, Lock, Plane, Calendar, Award, Printer, Sun, Moon, MoonStar, Cpu, Gauge, Star } from "lucide-react";

export default function PilotDetail() {
  const { t, lang, dir } = useI18n();
  const { user } = useAuth();
  const squadrons = useDashSquadrons();
  const pilots = useDashPilots();
  const [, params] = useRoute("/dashboard/pilot/:id");
  const id = params?.id;
  const pilot = pilots.find(p => p.id === id);
  const squadron = pilot ? squadrons.find(s => s.id === pilot.squadronId) : null;

  if (!user) return null;
  if (!pilot || !squadron || !(user.squadronIds ?? []).includes(pilot.squadronId)) {
    return <div className="text-center py-12 text-muted-foreground">{t("noResults")}</div>;
  }

  const currencies = [
    { label: t("dayCurrency"), date: pilot.dayCurrencyDate },
    { label: t("nightCurrency"), date: pilot.nightCurrencyDate },
    { label: t("nvgCurrency"), date: pilot.nvgCurrencyDate ?? "" },
    { label: t("irtCurrency"), date: pilot.irtCurrencyDate },
    { label: t("medicalCurrency"), date: pilot.medicalCurrencyDate },
  ];

  return (
    <div className="space-y-4 print-area">
      <div className="flex items-center justify-between gap-2 no-print">
        <Link href="/dashboard/pilots" className="text-xs inline-flex items-center text-muted-foreground hover:text-foreground">
          <ChevronLeft className={`h-3 w-3 me-1 ${dir === "rtl" ? "rotate-180" : ""}`} />{t("back")}
        </Link>
        <Button size="sm" variant="outline" onClick={() => window.print()} data-testid="button-print-pilot">
          <Printer className="h-3.5 w-3.5 me-1" />{t("print")}
        </Button>
      </div>

      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-bold">{lang === "ar" ? pilot.fullNameAr : pilot.fullName}</h2>
          <p className="text-sm text-muted-foreground font-mono">
            {pilot.callSign}
            {pilot.flightName ? ` · ${pilot.flightName}` : ""}
            {" · "}
            {lang === "ar" ? squadron.nameAr : squadron.name}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <StatusBadge status={pilotWorstStatus(pilot)} date={pilotWorstDate(pilot)} />
          <Badge variant="outline" className="gap-1"><Lock className="h-3 w-3" />{t("readOnly")}</Badge>
        </div>
      </div>

      {pilot.qualifications && pilot.qualifications.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap" data-testid="pilot-qualifications">
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
            {t("qualifications")}:
          </span>
          {pilot.qualifications.map(q => (
            <span
              key={q}
              className="inline-flex items-center rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] font-semibold tracking-wider text-amber-600 dark:text-amber-300"
            >
              {q}
            </span>
          ))}
        </div>
      )}

      <Card className="border-primary/40 bg-primary/5">
        <CardContent className="p-5 flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="text-xs text-muted-foreground flex items-center gap-1"><Award className="h-3 w-3" />{t("grandTotal")}</div>
            <div className="text-4xl font-extrabold tabular-nums">{pilot.grandTotalHours}</div>
          </div>
          <div className="text-end">
            <div className="text-xs text-muted-foreground flex items-center gap-1 justify-end"><Plane className="h-3 w-3" />{t("monthlyHours")}</div>
            <div className="text-2xl font-bold tabular-nums">{pilot.monthlyHours.toFixed(1)}</div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">{t("hourBreakdown")}</CardTitle></CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <HourStat icon={<Sun className="h-3 w-3" />} label={t("dayHours")} value={pilot.dayHours} />
            <HourStat icon={<Moon className="h-3 w-3" />} label={t("nightHours")} value={pilot.nightHours} />
            <HourStat icon={<MoonStar className="h-3 w-3" />} label={t("nvgTotal")} value={pilot.nvgTotalHours} accent="text-rose-500 dark:text-rose-300" />
            <HourStat icon={<Gauge className="h-3 w-3" />} label={t("instrumentHours")} value={pilot.instrumentHours} />
            <HourStat icon={<Cpu className="h-3 w-3" />} label={t("simHours")} value={pilot.simHours} />
            <HourStat icon={<Star className="h-3 w-3" />} label={t("captainHours")} value={pilot.captainHours} accent="text-amber-600 dark:text-amber-400" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">{t("currencies")}</CardTitle></CardHeader>
        <CardContent>
          <div className="grid sm:grid-cols-2 gap-3">
            {currencies.map(c => {
              const status = currencyStatus(c.date);
              return (
                <div key={c.label} className="flex items-center justify-between rounded-md border p-3">
                  <div>
                    <div className="text-xs text-muted-foreground">{c.label}</div>
                    <div className="font-medium tabular-nums">{fmtDate(c.date, lang)}</div>
                  </div>
                  <StatusBadge status={status} date={c.date} />
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Link href={`/dashboard/squadron/${pilot.squadronId}`}>
        <Button variant="outline" data-testid="button-squadron">{t("squadronView")}: {lang === "ar" ? squadron.nameAr : squadron.name}</Button>
      </Link>
    </div>
  );
}

function HourStat({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: number | undefined; accent?: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-[11px] text-muted-foreground flex items-center gap-1">{icon}{label}</div>
      <div className={`text-xl font-bold tabular-nums ${accent ?? ""}`}>{value ?? "—"}</div>
    </div>
  );
}
