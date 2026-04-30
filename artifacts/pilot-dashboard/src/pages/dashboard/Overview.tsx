import { Link } from "wouter";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useDashPilots, useDashSquadrons } from "@/lib/dash-pilots";
import { resolveScopedIds, useSquadronScope } from "@/lib/squadron-scope";
import { pilotWorstStatus } from "@/lib/format";
import { ChevronRight, Lock, Plane, Users, AlertTriangle, Clock, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRegisteredPCs, type RegisteredPC } from "@/lib/cross-pc";
import { CommanderEmptyState } from "@/components/CommanderEmptyState";
import { SnapshotStalenessBanner } from "@/components/SnapshotStalenessBanner";

// Wing / Base / HQ commanders use this Overview as their landing pad.
// v1.1.25: each squadron card now shows a live connectivity badge
// (which Ops PC is online, who is currently sitting at it) so a wing
// or base commander can see at a glance which squadrons are reachable
// without having to open each one. The badge auto-refreshes via the
// existing 30s registry poll + the reconnect listeners shipped in
// v1.1.24, so no manual refresh is ever needed.
//
// Recency thresholds: a squadron's ops PC is "online" if its registry
// last_seen is within 5 minutes (covers any 30s heartbeat that just
// missed plus a couple of jittered windows), "idle" up to 30 minutes
// (sleep / brief network drop), and "offline" beyond that.
const ONLINE_MS = 5 * 60_000;
const IDLE_MS = 30 * 60_000;
type Conn = { status: "online" | "idle" | "offline"; cdr: string; ageMs: number };
function statusOf(pc: RegisteredPC | undefined): Conn {
  if (!pc) return { status: "offline", cdr: "", ageMs: Infinity };
  const ageMs = Date.now() - new Date(pc.lastSeen).getTime();
  const cdr = (pc.deviceName?.trim()) || pc.squadronName;
  const status: Conn["status"] =
    ageMs <= ONLINE_MS ? "online" : ageMs <= IDLE_MS ? "idle" : "offline";
  return { status, cdr, ageMs };
}

export default function CommanderOverview() {
  const { t, lang, dir } = useI18n();
  const { user } = useAuth();
  const squadrons = useDashSquadrons();
  const pilots = useDashPilots();
  const reg = useRegisteredPCs();
  // Index squadron-tier PCs by their canonical id (= squadron code) for
  // O(1) lookup per card. Non-squadron tiers (flight, wing, base, hq)
  // are skipped — only the squadron's canonical ops PC matters here.
  const opsPcByCode = new Map<string, RegisteredPC>();
  for (const pc of reg.data) {
    if (pc.tier === "squadron") opsPcByCode.set(pc.id, pc);
  }
  const [scope] = useSquadronScope();
  if (!user) return null;

  // HQ / multi-squadron commanders pick a squadron (or "Combined") in
  // the topbar. resolveScopedIds collapses the choice against the
  // operator's authorized list so this page only renders the squadrons
  // they want to see right now.
  const myIds = new Set(resolveScopedIds(scope, user.squadronIds));
  const mySqns = squadrons.filter(s => myIds.has(s.id));
  const myPilots = pilots.filter(p => myIds.has(p.squadronId));
  const expired = myPilots.filter(p => { const s = pilotWorstStatus(p); return s === "expired" || s === "critical"; }).length;
  const warning = myPilots.filter(p => { const s = pilotWorstStatus(p); return s === "warning" || s === "expiringSoon"; }).length;

  const stats = [
    { icon: <Plane className="h-5 w-5" />, label: t("totalSquadrons"), value: mySqns.length },
    { icon: <Users className="h-5 w-5" />, label: t("totalPilots"), value: myPilots.length },
    { icon: <AlertTriangle className="h-5 w-5 text-red-500" />, label: t("expiredCurrencies"), value: expired },
    { icon: <Clock className="h-5 w-5 text-amber-500" />, label: t("expiringSoon"), value: warning },
  ];

  return (
    <div className="space-y-6 print-area">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-xl font-bold">{t("overview")}</h2>
        <div className="flex items-center gap-2 no-print">
          <Badge variant="outline" className="gap-1"><Lock className="h-3 w-3" />{t("readOnly")}</Badge>
          <Button size="sm" variant="outline" onClick={() => window.print()} data-testid="button-print-overview">
            <Printer className="h-3.5 w-3.5 me-1" />{t("print")}
          </Button>
        </div>
      </div>
      {/* Wing / Base / HQ tiers see no operational rows by RLS design
          and feed off xpc_squadron_snapshot. The empty-state explains
          which of (no PC registered / no snapshot published / stale /
          empty roster) is the cause. Renders nothing for squadron and
          flight scopes. */}
      <CommanderEmptyState surface="overview" />
      <SnapshotStalenessBanner />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s, i) => (
          <Card key={i}>
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

      <div>
        <h3 className="text-base font-semibold mb-3">{t("squadron")}</h3>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {mySqns.map(s => {
            const sp = pilots.filter(p => p.squadronId === s.id);
            const e = sp.filter(p => { const s = pilotWorstStatus(p); return s === "expired" || s === "critical"; }).length;
            const w = sp.filter(p => { const s = pilotWorstStatus(p); return s === "warning" || s === "expiringSoon"; }).length;
            const c = sp.length - e - w;
            // Live connectivity for this squadron's canonical Ops PC.
            // Squadron.code is the same value the ops PC uses as its
            // canonical id in xpc_registry, so a direct map lookup is
            // exact — no fuzzy matching, no name-collision risk.
            const conn = statusOf(opsPcByCode.get(s.code));
            const dot =
              conn.status === "online" ? "bg-emerald-500"
              : conn.status === "idle" ? "bg-amber-500"
              : "bg-zinc-400 dark:bg-zinc-600";
            const dotTitle =
              conn.status === "online" ? "Ops PC online"
              : conn.status === "idle" ? "Ops PC idle (>5 min since last heartbeat)"
              : "Ops PC offline";
            return (
              <Link key={s.id} href={`/dashboard/squadron/${s.id}`}>
                <Card className="hover-elevate cursor-pointer transition" data-testid={`card-sqn-${s.id}`}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-base flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        <span
                          className={`inline-block h-2 w-2 rounded-full ${dot} ${conn.status === "online" ? "animate-pulse" : ""}`}
                          title={dotTitle}
                          data-testid={`ops-pc-status-${s.id}`}
                        />
                        {lang === "ar" ? s.nameAr : s.name}
                      </span>
                      <ChevronRight className={`h-4 w-4 text-muted-foreground ${dir === "rtl" ? "rotate-180" : ""}`} />
                    </CardTitle>
                    <p className="text-xs text-muted-foreground">
                      {lang === "ar" ? s.baseAr : s.base} · {lang === "ar" ? s.wingAr : s.wing}
                    </p>
                    {/* Operator currently sitting at the squadron's ops PC.
                        Falls back to "Ops PC offline" when no live registry
                        row exists or the heartbeat is stale beyond 30 min,
                        so the wing/base commander knows nobody is reachable
                        on that desk right now. */}
                    {conn.status === "offline" ? (
                      <p className="text-[11px] text-muted-foreground italic" data-testid={`ops-pc-cdr-${s.id}`}>
                        Ops PC offline
                      </p>
                    ) : (
                      <p className="text-[11px] text-muted-foreground truncate" title={conn.cdr} data-testid={`ops-pc-cdr-${s.id}`}>
                        On console: <span className="text-foreground font-medium">{conn.cdr}</span>
                      </p>
                    )}
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-2xl font-bold tabular-nums">{sp.length}</div>
                        <div className="text-xs text-muted-foreground">{t("pilotCount")}</div>
                      </div>
                      <div className="flex gap-1.5 text-xs">
                        <span className="flex flex-col items-center rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-900 dark:text-emerald-200 px-2 py-1 min-w-12">
                          <span className="font-bold tabular-nums">{c}</span>
                          <span>{t("current")}</span>
                        </span>
                        <span className="flex flex-col items-center rounded bg-amber-100 dark:bg-amber-950 text-amber-900 dark:text-amber-200 px-2 py-1 min-w-12">
                          <span className="font-bold tabular-nums">{w}</span>
                          <span>{t("warning")}</span>
                        </span>
                        <span className="flex flex-col items-center rounded bg-red-100 dark:bg-red-950 text-red-900 dark:text-red-200 px-2 py-1 min-w-12">
                          <span className="font-bold tabular-nums">{e}</span>
                          <span>{t("expired")}</span>
                        </span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
