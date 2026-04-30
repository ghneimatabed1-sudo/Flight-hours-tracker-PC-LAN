import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { usePilots, useSorties, useNotams } from "@/lib/squadron-data";
import { computeAllTotals } from "@/lib/calculations";
import { DataUnavailableBanner } from "@/components/DataUnavailableBanner";
import { Link } from "wouter";
import {
  Plane, MoonStar, Moon, Cpu, Users, Calendar, AlertTriangle,
  ChevronRight, Activity, Megaphone, Radio,
} from "lucide-react";

type Severity = "ok" | "warn" | "bad";

function statusOf(dateStr: string): Severity {
  if (!dateStr) return "warn";
  // Local-midnight comparison so a date entered as "today" in the
  // operator's timezone never flips to "expired" because of UTC drift.
  const parts = dateStr.split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return "warn";
  const expiry = new Date(parts[0], parts[1] - 1, parts[2]).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((expiry - today) / 86400000);
  if (days < 0) return "bad";
  if (days < 30) return "warn";
  return "ok";
}

/** Isolated clock — re-renders only this little strip, not the whole dashboard. */
function LiveClockStrip({ lang }: { lang: "en" | "ar" }) {
  const { t, rankOf } = useI18n();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const align = 60_000 - (Date.now() % 60_000);
    const timeout = setTimeout(() => {
      setNow(new Date());
      interval = setInterval(() => setNow(new Date()), 60_000);
    }, align);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);
  const time = now.toLocaleTimeString(lang === "ar" ? "ar-JO" : "en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  // Squadron-wide DD-MM-YYYY (no weekday — keeps the strip compact and
  // matches every other date display in the app).
  const date = `${String(now.getDate()).padStart(2, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${now.getFullYear()}`;
  const zulu = now.toISOString().slice(11, 16) + "Z";
  return (
    <div className="flex items-center gap-2">
      <Radio className="h-3.5 w-3.5 text-primary" />
      <span className="stencil">{t("statLocal")}</span>
      <span className="font-mono text-foreground tabular-nums">{time}</span>
      <span className="text-border">·</span>
      <span className="stencil">{t("statZulu")}</span>
      <span className="font-mono text-muted-foreground tabular-nums">{zulu}</span>
      <span className="text-border">·</span>
      <span className="font-mono text-muted-foreground">{date}</span>
    </div>
  );
}

export default function Dashboard() {
  const { t, lang, rankOf } = useI18n();
  const { user, squadron } = useAuth();
  const pilotsQ = usePilots();
  const sortiesQ = useSorties();
  const notamsQ = useNotams();
  const { data: PILOTS } = pilotsQ;
  const { data: SORTIES } = sortiesQ;
  const { data: NOTAMS } = notamsQ;
  const now = new Date();

  const totalsById = useMemo(() => computeAllTotals(PILOTS, SORTIES), [PILOTS, SORTIES]);
  const monthDay = +PILOTS.reduce((a, p) => a + (totalsById[p.id]?.monthDay ?? 0), 0).toFixed(1);
  const monthNight = +PILOTS.reduce((a, p) => a + (totalsById[p.id]?.monthNight ?? 0), 0).toFixed(1);
  const monthNvg = +PILOTS.reduce((a, p) => a + (totalsById[p.id]?.monthNvg ?? 0), 0).toFixed(1);
  const monthSim = +PILOTS.reduce((a, p) => a + (totalsById[p.id]?.monthSim ?? 0), 0).toFixed(1);
  const monthTotal = +(monthDay + monthNight + monthNvg + monthSim).toFixed(1);

  const sortiesMonth = SORTIES.filter(
    s => new Date(s.date).getMonth() === now.getMonth() && new Date(s.date).getFullYear() === now.getFullYear()
  ).length;
  const avail = PILOTS.filter(p => p.available).length;
  const availPct = PILOTS.length ? Math.round((avail / PILOTS.length) * 100) : 0;

  const expiring = PILOTS.flatMap(p => {
    const items: { pilot: string; type: string; date: string; status: "warn" | "bad" }[] = [];
    // Sim is monitor-only — never an "expiring" currency. See
    // `.local/memory/currency-refresh.md`.
    (["day", "night", "irt", "medical"] as const).forEach(c => {
      if (p.hiddenCurrencies?.includes(c)) return; // ops marked this currency N/A for this pilot
      const s = statusOf(p.expiry[c]);
      if (s !== "ok") items.push({ pilot: p.name, type: c.toUpperCase(), date: p.expiry[c], status: s });
    });
    return items;
  }).sort((a, b) => +new Date(a.date) - +new Date(b.date));

  const expiredCount = expiring.filter(e => e.status === "bad").length;
  const warnCount = expiring.filter(e => e.status === "warn").length;

  const monthLabel = now.toLocaleDateString(lang === "ar" ? "ar-JO" : "en-GB", { month: "short", year: "numeric" }).toUpperCase();
  void lang;

  return (
    <div className="space-y-4">
      <DataUnavailableBanner queries={[pilotsQ, sortiesQ, notamsQ]} testId="banner-dashboard-unavailable" />
      {/* ───── Mission Status Bar ───────────────────────── */}
      <div className="rise rise-1 panel scan flex items-center justify-between px-4 py-2.5 text-xs flex-wrap gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex items-center gap-1.5">
            <span className="status-dot status-ok pulse-soft"></span>
            <span className="stencil">{t("statOperational")}</span>
          </span>
          <span className="text-border">│</span>
          <span className="stencil">{t("statSqn")}</span>
          <span className="font-mono text-foreground">{squadron?.number ?? "—"} · {squadron?.base ?? "—"}</span>
          <span className="text-border">│</span>
          <span className="stencil">{t("statOp")}</span>
          <span className="font-mono text-foreground truncate">{user?.displayName ?? "—"}</span>
        </div>
        <div className="ms-auto">
          <LiveClockStrip lang={lang} />
        </div>
      </div>

      {/* ───── Hero: Month-to-date totals ──────────────── */}
      <div className="rise rise-2 frame-gold brackets p-6 md:p-7">
        <div className="grid md:grid-cols-[1fr_auto] gap-6 items-end">
          <div>
            <div className="stencil-lg mb-2">// {monthLabel} · {t("missionHours")}</div>
            <div className="flex items-baseline gap-3 flex-wrap">
              <div className="hero-num text-[clamp(56px,10vw,108px)] leading-none">
                {monthTotal.toFixed(1)}
              </div>
              <div className="stencil-lg pb-2">{t("hoursUnit")}</div>
            </div>
            <div className="hairline my-4" />
            <div className="flex items-center gap-5 flex-wrap text-sm">
              <Chip icon={<Plane className="h-3.5 w-3.5" />} label={t("dayShort")} value={monthDay} />
              <Chip icon={<MoonStar className="h-3.5 w-3.5" />} label={t("nightShort")} value={monthNight} />
              <Chip icon={<Moon className="h-3.5 w-3.5" />} label={t("nvgShort")} value={monthNvg} accent="text-rose-300" />
              <Chip icon={<Cpu className="h-3.5 w-3.5" />} label={t("simShort")} value={monthSim} />
            </div>
          </div>

          <div className="md:border-l md:border-border md:ps-6 space-y-4 min-w-[220px]">
            <BigStat
              label={t("sortiesMonth")}
              value={sortiesMonth}
              icon={<Calendar className="h-4 w-4" />}
            />
            <div>
              <div className="flex items-baseline justify-between mb-1.5">
                <span className="stencil">{t("pilotsAvail")}</span>
                <span className="font-mono text-sm"><span className="text-foreground">{avail}</span><span className="text-muted-foreground">/{PILOTS.length}</span></span>
              </div>
              <div className="meter"><i style={{ width: `${availPct}%` }} /></div>
            </div>
            <Link href="/sortie-add" className="block w-full text-center px-3 py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-semibold hover:opacity-90 inline-flex items-center justify-center gap-2 lift">
              <Plane className="h-4 w-4" /> {t("addSortie")}
            </Link>
          </div>
        </div>
      </div>

      {/* ───── Two columns: Expiring + NOTAMs ─────────── */}
      <div className="grid lg:grid-cols-[1.5fr_1fr] gap-4">
        {/* Expiring */}
        <Card className="rise rise-3 lift">
          <SectionHead
            icon={<AlertTriangle className="h-4 w-4 text-amber-400" />}
            label={t("expiringAlert")}
            badge={expiring.length}
            badgeTone={expiredCount > 0 ? "bad" : warnCount > 0 ? "warn" : "ok"}
            href="/expired"
            hrefLabel={t("viewAll")}
          />
          {expiring.length === 0 ? (
            <EmptyState icon={<Activity className="h-5 w-5" />} text={t("currenciesAllGreen")} />
          ) : (
            <div className="grid md:grid-cols-2 gap-2 max-h-80 overflow-y-auto pe-1">
              {expiring.slice(0, 18).map((e, i) => {
                const days = Math.floor((+new Date(e.date) - Date.now()) / 86400000);
                const label = days < 0
                  ? t("expiredNDays").replace("{n}", String(Math.abs(days)))
                  : t("daysLeft").replace("{n}", String(days));
                return (
                  <div key={i} className={`flex items-center justify-between gap-3 px-3 py-2 rounded-md border lift ${e.status === "bad" ? "border-destructive/40 bg-destructive/5" : "border-amber-500/30 bg-amber-500/5"}`}>
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{e.pilot}</div>
                      <div className="stencil mt-0.5">{e.type} · {e.date}</div>
                    </div>
                    <div className={`stencil text-right whitespace-nowrap ${e.status === "bad" ? "text-destructive" : "text-amber-300"}`}>
                      {label}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* NOTAMs preview */}
        <Card className="rise rise-3 lift">
          <SectionHead
            icon={<Megaphone className="h-4 w-4 text-primary" />}
            label={t("recentNotams")}
            badge={NOTAMS.length}
            href="/notams"
            hrefLabel={t("viewAll")}
          />
          {NOTAMS.length === 0 ? (
            <EmptyState icon={<Megaphone className="h-5 w-5" />} text={t("notamsEmpty")} />
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto pe-1">
              {NOTAMS.slice(0, 5).map(n => (
                <div key={n.id} className="px-3 py-2 rounded-md bg-secondary/40 border border-border/70 lift">
                  <div className="flex items-center justify-between mb-1">
                    <span className="stencil text-primary">{n.id}</span>
                    <span className="stencil">{n.date}</span>
                  </div>
                  <div className="text-sm text-foreground/90 leading-snug line-clamp-3">{n.text}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* ───── Pilot status grid ──────────────────────── */}
      <Card className="rise rise-4">
        <SectionHead
          icon={<Users className="h-4 w-4 text-primary" />}
          label={t("nav_roster")}
          badge={PILOTS.length}
          href="/roster"
          hrefLabel={t("viewAll")}
        />
        <div className="grid sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
          {PILOTS.map(p => {
            const worst = (["day", "night", "irt", "medical"] as const)
              .map(c => statusOf(p.expiry[c]))
              .reduce<Severity>((acc, s) => (acc === "bad" || s === "bad" ? "bad" : (acc === "warn" || s === "warn" ? "warn" : "ok")), "ok");
            const initials = (p.name || "").split(" ").map(s => s[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
            return (
              <Link key={p.id} href={`/pilot/${p.id}`} className="panel p-3 lift block">
                <div className="flex items-start gap-3">
                  <div className="h-10 w-10 rounded-full bg-secondary border border-border flex items-center justify-center text-xs font-semibold text-primary shrink-0">
                    {initials || "—"}
                  </div>
                  <div className="leading-tight min-w-0 flex-1">
                    <div className="text-sm font-semibold truncate">{rankOf(p)} {p.name}</div>
                    <div className="stencil mt-0.5">{p.unit} · {p.id}</div>
                  </div>
                  <span
                    className={`status-dot mt-1.5 ${worst === "bad" ? "status-bad" : worst === "warn" ? "status-warn" : "status-ok"}`}
                    title={worst === "bad" ? "Expired" : worst === "warn" ? "Expiring soon" : "Current"}
                  />
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
                  <Mini label="D" value={totalsById[p.id]?.monthDay ?? 0} />
                  <Mini label="N" value={totalsById[p.id]?.monthNight ?? 0} />
                  <Mini label="NVG" value={totalsById[p.id]?.monthNvg ?? 0} accent="text-rose-300" />
                </div>
              </Link>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

/* ───────────── helpers ───────────── */

function Chip({ icon, label, value, accent = "" }: { icon: React.ReactNode; label: string; value: number; accent?: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-muted-foreground ${accent}`}>{icon}</span>
      <span className="stencil">{label}</span>
      <span className={`font-mono font-semibold tabular-nums ${accent || "text-foreground"}`}>{value.toFixed(1)}</span>
    </div>
  );
}

function BigStat({ label, value, icon }: { label: string; value: string | number; icon: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="stencil">{label}</span>
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <div className="font-mono text-3xl font-bold tabular-nums text-foreground mt-0.5">{value}</div>
    </div>
  );
}

function SectionHead({ icon, label, badge, badgeTone = "ok", href, hrefLabel }: {
  icon: React.ReactNode; label: string; badge?: number; badgeTone?: Severity; href?: string; hrefLabel?: string;
}) {
  const tone = badgeTone === "bad" ? "bg-destructive/15 text-destructive" : badgeTone === "warn" ? "bg-amber-500/15 text-amber-300" : "bg-emerald-500/15 text-emerald-300";
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-sm font-semibold tracking-wide">{label}</h3>
        {typeof badge === "number" && (
          <span className={`text-[11px] px-2 py-0.5 rounded-full font-mono ${tone}`}>{badge}</span>
        )}
      </div>
      {href && (
        <Link href={href} className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1">
          {hrefLabel} <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      )}
    </div>
  );
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-3 py-6 px-3 text-muted-foreground text-sm">
      <div className="h-9 w-9 rounded-full bg-secondary/60 border border-border flex items-center justify-center text-emerald-300">{icon}</div>
      <div>{text}</div>
    </div>
  );
}

function Mini({ label, value, accent = "" }: { label: string; value: number; accent?: string }) {
  return (
    <div className="px-2 py-1 rounded bg-secondary/40 border border-border/70">
      <div className="stencil text-[9px]">{label}</div>
      <div className={`font-mono text-[12px] font-semibold tabular-nums ${accent || "text-foreground"}`}>{value.toFixed(1)}</div>
    </div>
  );
}
