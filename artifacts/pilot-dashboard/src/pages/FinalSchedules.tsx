/* ────────────────────────────────────────────────────────────────────
   FinalSchedules — read-only Wing-approved flight schedules rollup
   ────────────────────────────────────────────────────────────────────
   v1.1.64. The Base Cmdr and the HQ Cmdr never plan a flight schedule;
   they only see the FINAL flying programme that the Wing Commander
   has approved. The page is intentionally minimal:

   • One card per squadron, sorted by latest update first.
   • Each card shows the originating Squadron Commander's name (so the
     Base / HQ operator can see which Sqn Cmdr signed off on it) and
     the most recent approved schedules for that squadron.
   • Click a date row to open the full RJAF flight schedule paper
     (read-only, with the Wing approval banner across the top).

   No Approve / Reject / Edit / Delete — viewers only. The composer
   stays on the squadron PCs.
   ──────────────────────────────────────────────────────────────────── */
import React, { useEffect, useMemo, useState } from "react";
import { markFinalSchedulesSeen } from "@/lib/sidebar-badges";
import { ChevronDown, ChevronRight, ClipboardCheck, FileText, Printer } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import {
  useScheduleShares,
  useRegisteredPCs,
  canViewFinalSchedules,
  getLocalPcId,
  squadronColor,
  type ScheduleShare,
} from "@/lib/cross-pc";
import { usePilots } from "@/lib/squadron-data";
import { useDashPilots } from "@/lib/dash-pilots";
import { pilotWorstStatus, isRedStatus } from "@/lib/format";
import FlightScheduleSheet from "@/components/FlightScheduleSheet";
import { Button } from "@/components/ui/button";

export default function FinalSchedules() {
  const { lang, rankOf } = useI18n();
  const { user } = useAuth();
  const dir = lang === "ar" ? "rtl" : "ltr";
  const allowed = canViewFinalSchedules(user?.role, user?.scope);

  // Pull every Wing-approved schedule across every squadron. The
  // visibility filter inside useScheduleShares enforces "Wing-signed
  // finals only" so drafts and Sqn-only approvals never appear here.
  const myPcId = getLocalPcId();
  const { data: shares = [] } = useScheduleShares(myPcId, { viewAllApproved: allowed });

  // v1.1.105 — mark the archive as "seen" so the sidebar red-dot /
  // badge count clears the moment the operator opens this page. The
  // helper writes a timestamp to localStorage and fires a window
  // event that useSidebarBadges listens for, so the Layout refreshes
  // without a hard navigation.
  useEffect(() => {
    if (allowed) markFinalSchedulesSeen();
  }, [allowed]);
  const registry = useRegisteredPCs();
  // Cross-squadron pilot roster (already populated by the dashboard
  // sync layer on Base / HQ PCs). We use it to derive at-a-glance
  // currency-at-risk counts per squadron for the "Connected Squadrons"
  // strip — no extra fetch required.
  const dashPilots = useDashPilots();
  // usePilots returns a query object — we want the .data array (which
  // already defaults to []). Going through the query handle keeps the
  // FlightScheduleSheet's pilot picker labelled correctly when the
  // viewer expands an approved schedule.
  const { data: PILOTS } = usePilots();
  const pilotOptions = useMemo(
    () => PILOTS.map(p => ({ value: p.name, label: `${rankOf(p)} ${p.name}` })),
    [PILOTS],
  );

  // Open-card state: which squadron card is expanded, and which
  // schedule (by share id) is showing the full paper. Only one paper
  // open at a time keeps the surface clean.
  const [openSquadron, setOpenSquadron] = useState<string | null>(null);
  const [openShareId,  setOpenShareId]  = useState<string | null>(null);

  if (!allowed) {
    return (
      <div className="p-6" dir={dir}>
        <div className="rounded-md border border-border bg-card p-6 max-w-xl">
          <div className="text-sm font-semibold mb-1">
            {lang === "ar" ? "البرامج النهائية" : "Final Flight Schedules"}
          </div>
          <div className="text-xs text-muted-foreground leading-relaxed">
            {lang === "ar"
              ? "هذه الصفحة متاحة فقط لقائد القاعدة وقائد القيادة (HQ)."
              : "This page is available only to the Base Commander and HQ Commander."}
          </div>
        </div>
      </div>
    );
  }

  // Group every share by its origin squadron. We rely on
  // originSquadronId — that's the canonical PC id of the squadron
  // (e.g. "NO.8") that submitted the schedule. The paper-style shares
  // (with `program`) are the ones we display; the compact-row shares
  // are skipped so the Base / HQ surface stays consistent and clean.
  const grouped = useMemo(() => {
    const buckets = new Map<string, ScheduleShare[]>();
    for (const s of shares) {
      if (!s.program) continue; // paper sheets only
      const key = s.originSquadronId;
      const arr = buckets.get(key) ?? [];
      arr.push(s);
      buckets.set(key, arr);
    }
    // Sort each squadron's shares by approval time (latest first), then
    // sort the squadron list itself by the latest approval timestamp
    // so the most recently active squadron sits at the top.
    const out = Array.from(buckets.entries()).map(([sqnId, list]) => {
      list.sort((a, b) => (b.approvedAt ?? b.date).localeCompare(a.approvedAt ?? a.date));
      return { sqnId, sqnName: list[0].originSquadronName, latest: list[0].approvedAt ?? list[0].date, shares: list };
    });
    out.sort((a, b) => b.latest.localeCompare(a.latest));
    return out;
  }, [shares]);

  // Map squadron-id → the operator name of the Sqn Cmdr who pushed
  // the latest approved version up to Wing. We walk the history from
  // newest-first so a re-submission after edits / a rejected cycle
  // shows the person who actually owns the current Wing-approved
  // version, not whoever first started the chain weeks ago.
  const sqnCommanderFor = (s: ScheduleShare): string => {
    for (let i = s.history.length - 1; i >= 0; i--) {
      const h = s.history[i];
      if (h.action === "submitted" && h.tier === "squadron" && h.by) {
        return h.by;
      }
    }
    // Fallback to the registry display name for the squadron PC.
    const reg = registry.data.find(p => p.id === s.originSquadronId);
    return reg?.squadronName ?? s.originSquadronName;
  };

  // ────────────────────────────────────────────────────────────────────
  // v1.1.66 — "Connected Squadrons" overview strip.
  //
  // This is the at-a-glance row that sits above the per-squadron cards
  // so a Base / HQ commander can scan a network of 15-20 squadrons in
  // one glance and pick out who needs attention. We deliberately keep
  // it to four numbers per tile (Pilots / At-risk / Week / Last) so
  // it's never overwhelming.
  //
  // Source-of-truth for the squadron list is the UNION of:
  //   • squadrons that have shipped at least one Wing-approved final
  //   • squadrons whose Sqn-Cmdr or Ops PC is registered in xpc_registry
  //
  // That way a brand-new squadron that just powered on its PC for the
  // first time appears immediately as "Awaiting first schedule" — no
  // setup step on Base / HQ side.
  // ────────────────────────────────────────────────────────────────────
  const squadronEntries = useMemo(() => {
    type Entry = {
      sqnId: string;
      name: string;
      online: boolean;
      lastSeen: string | null;
      pilotCount: number;
      atRisk: number;
      finalsCount: number;
      weekFinals: number;
      lastFinalDate: string | null;
    };
    const map = new Map<string, Entry>();

    // Seed from squadrons that have shipped finals.
    for (const g of grouped) {
      map.set(g.sqnId, {
        sqnId: g.sqnId,
        name: g.sqnName,
        online: false,
        lastSeen: null,
        pilotCount: 0,
        atRisk: 0,
        finalsCount: g.shares.length,
        weekFinals: 0,
        lastFinalDate: g.latest,
      });
    }

    // Merge in registered PCs so newly-connected squadrons show up
    // before they ship their first final. The Sqn-Cmdr PC id has
    // shape "SQDNCMD:<code>#<suffix>" — peel off the squadron code
    // so it collapses onto the same entry as the Ops PC ("<code>").
    for (const pc of registry.data) {
      if (!pc.squadronName) continue;
      let sqnId = pc.id;
      const m = /^[A-Z]+CMD:([^#]+)/.exec(pc.id);
      if (m) sqnId = m[1];
      if (!sqnId) continue;
      const existing = map.get(sqnId);
      if (existing) {
        if (pc.online) existing.online = true;
        if (pc.lastSeen && (!existing.lastSeen || pc.lastSeen > existing.lastSeen)) {
          existing.lastSeen = pc.lastSeen;
        }
      } else {
        map.set(sqnId, {
          sqnId,
          name: pc.squadronName,
          online: !!pc.online,
          lastSeen: pc.lastSeen ?? null,
          pilotCount: 0,
          atRisk: 0,
          finalsCount: 0,
          weekFinals: 0,
          lastFinalDate: null,
        });
      }
    }

    // Pilot roster + currency-at-risk tally per squadron.
    for (const entry of map.values()) {
      const sqnPilots = dashPilots.filter(p => p.squadronId === entry.sqnId);
      entry.pilotCount = sqnPilots.length;
      entry.atRisk = sqnPilots.filter(p => isRedStatus(pilotWorstStatus(p))).length;
    }

    // Week-over-week finals counter.
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const s of shares) {
      if (!s.program || !s.approvedAt) continue;
      if (new Date(s.approvedAt).getTime() < weekAgo) continue;
      const e = map.get(s.originSquadronId);
      if (e) e.weekFinals += 1;
    }

    // Online-first, then alphabetical — keeps the squadrons that are
    // actually operating right now at the top of the strip.
    return Array.from(map.values()).sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [grouped, registry.data, dashPilots, shares]);

  // Click a tile in the strip → expand that squadron's card below
  // and scroll it into view. Smooth, single-action navigation.
  const focusSquadron = (sqnId: string) => {
    setOpenSquadron(sqnId);
    setOpenShareId(null);
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-testid="final-sched-sqn-${sqnId}"]`);
      el?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <div className="p-4 space-y-3" dir={dir}>
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold flex items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-emerald-400" />
            {lang === "ar" ? "البرامج النهائية المعتمدة" : "Final Approved Flight Schedules"}
          </h1>
          <div className="text-[11px] text-muted-foreground">
            {lang === "ar"
              ? "مرتّب حسب السرب · أحدث تحديث في الأعلى"
              : "Sorted by squadron · latest update first"}
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground tabular-nums">
          {grouped.length} {lang === "ar" ? "سرب" : grouped.length === 1 ? "squadron" : "squadrons"}
          {" · "}
          {shares.filter(s => s.program).length} {lang === "ar" ? "برنامج" : "schedules"}
        </div>
      </div>

      {/* v1.1.66 — Connected Squadrons strip. At-a-glance overview that
          stays compact even with 20+ squadrons; sorted online-first so
          today's active operations are right at the top. */}
      {squadronEntries.length > 0 && (
        <div className="rounded-md border border-border bg-card p-3" data-testid="connected-squadrons">
          <div className="flex items-baseline justify-between gap-2 mb-2">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
              {lang === "ar" ? "الأسراب المتصلة" : "Connected Squadrons"}
            </div>
            <div className="text-[10px] tabular-nums text-muted-foreground">
              <span className="text-emerald-300 font-semibold">
                {squadronEntries.filter(s => s.online).length}
              </span>
              <span className="opacity-60">
                {" / "}{squadronEntries.length} {lang === "ar" ? "متصل الآن" : "online now"}
              </span>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 gap-2">
            {squadronEntries.map(s => {
              const pal = squadronColor(s.sqnId);
              return (
                <button
                  key={s.sqnId}
                  type="button"
                  onClick={() => focusSquadron(s.sqnId)}
                  className="text-start rounded-md border border-border bg-background/40 hover-elevate active-elevate-2 px-2.5 py-2 flex gap-2 overflow-hidden"
                  data-testid={`sqn-tile-${s.sqnId}`}
                >
                  <div className={`w-1 shrink-0 rounded-sm ${pal.stripe}`} aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${
                          s.online ? "bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.6)]" : "bg-muted-foreground/30"
                        }`}
                        title={s.online
                          ? (lang === "ar" ? "متصل" : "Online")
                          : (lang === "ar" ? "غير متصل" : "Offline")}
                      />
                      <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border font-semibold truncate ${pal.badge}`}>
                        {s.name}
                      </span>
                    </div>
                    <div className="mt-1.5 grid grid-cols-3 gap-1">
                      <Stat
                        label={lang === "ar" ? "طيار" : "Pilots"}
                        value={s.pilotCount}
                      />
                      <Stat
                        label={lang === "ar" ? "تنبيه" : "At-risk"}
                        value={s.atRisk}
                        tone={s.atRisk > 0 ? "danger" : "muted"}
                      />
                      <Stat
                        label={lang === "ar" ? "أسبوع" : "Week"}
                        value={s.weekFinals}
                        tone={s.weekFinals > 0 ? "good" : "muted"}
                      />
                    </div>
                    <div className="mt-1.5 text-[10px] text-muted-foreground truncate">
                      {s.lastFinalDate
                        ? `${lang === "ar" ? "آخر برنامج" : "Last final"}: ${relTime(s.lastFinalDate, lang)}`
                        : (lang === "ar" ? "بانتظار أول برنامج" : "Awaiting first schedule")}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {grouped.length === 0 && (
        <div className="rounded-md border border-border bg-card p-6 text-center text-xs text-muted-foreground">
          {lang === "ar"
            ? "لا توجد برامج طيران معتمدة بعد. ستظهر هنا فور اعتماد قائد الجناح لأي برنامج."
            : "No Wing-approved flight schedules yet. As soon as the Wing Commander approves a schedule it will appear here."}
        </div>
      )}

      <div className="space-y-2">
        {grouped.map(({ sqnId, sqnName, latest, shares: sqnShares }) => {
          const expanded = openSquadron === sqnId;
          const cmdrName = sqnCommanderFor(sqnShares[0]);
          // v1.1.65 — colour each squadron card with its deterministic
          // palette: a 4px left stripe + a colour-matched name pill.
          // Same colours as the Wing-Cmdr inbox, so a Base / HQ
          // operator who's been talking to the wing about a squadron
          // recognises it instantly here.
          const pal = squadronColor(sqnId);
          return (
            <div
              key={sqnId}
              className="rounded-md border border-border bg-card overflow-hidden flex"
              data-testid={`final-sched-sqn-${sqnId}`}
            >
              <div className={`w-1 shrink-0 ${pal.stripe}`} aria-hidden="true" />
              <div className="flex-1 min-w-0">
              {/* Squadron header row — click to expand the schedule list. */}
              <button
                onClick={() => {
                  setOpenSquadron(expanded ? null : sqnId);
                  setOpenShareId(null);
                }}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 hover-elevate active-elevate-2 text-start"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {expanded
                    ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border font-semibold ${pal.badge}`}>
                        {sqnName}
                      </span>
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                      {lang === "ar" ? "قائد السرب: " : "Sqn Cmdr: "}
                      <span className="text-foreground/80">{cmdrName}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3 text-[11px] text-muted-foreground shrink-0">
                  <span className="tabular-nums">
                    {sqnShares.length} {lang === "ar" ? "برنامج" : sqnShares.length === 1 ? "schedule" : "schedules"}
                  </span>
                  <span className="tabular-nums hidden sm:inline">{prettyDate(latest)}</span>
                </div>
              </button>

              {expanded && (
                <div className="border-t border-border bg-background/30 divide-y divide-border">
                  {sqnShares.map(share => {
                    const open = openShareId === share.id;
                    return (
                      <div key={share.id}>
                        <button
                          onClick={() => setOpenShareId(open ? null : share.id)}
                          className="w-full flex items-center justify-between gap-3 px-5 py-2.5 hover-elevate text-start"
                          data-testid={`final-sched-share-${share.id}`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <div className="text-xs">
                              <div className="font-medium tabular-nums">{share.date}</div>
                              <div className="text-[10px] text-muted-foreground">
                                {lang === "ar" ? "اعتمد بواسطة قائد الجناح: " : "Wing approved by: "}
                                {share.approvedBy ?? "—"}
                                {share.approvedAt && (
                                  <> · {new Date(share.approvedAt).toLocaleString()}</>
                                )}
                              </div>
                            </div>
                          </div>
                          <span className="text-[10px] uppercase tracking-wider text-emerald-300 font-semibold">
                            {open ? (lang === "ar" ? "إخفاء" : "Hide") : (lang === "ar" ? "عرض" : "View")}
                          </span>
                        </button>
                        {open && share.program && (
                          <div className="px-3 pb-3 pt-1 space-y-2">
                            <div className="flex items-center justify-end gap-2 no-print">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => window.print()}
                                data-testid={`final-sched-print-${share.id}`}
                              >
                                <Printer className="h-3.5 w-3.5 me-1" />
                                {lang === "ar" ? "طباعة" : "Print"}
                              </Button>
                            </div>
                            <FlightScheduleSheet
                              prog={share.program}
                              pilotOptions={pilotOptions}
                              approvedAt={share.approvedAt}
                              approvedBy={share.approvedBy}
                              statusLabel={lang === "ar" ? "نهائي معتمد" : "FINAL · APPROVED"}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function prettyDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
}

// Compact one-number stat used inside the Connected Squadrons tiles.
// Three tones: muted (zero / neutral), good (green), danger (amber/red).
function Stat({
  label,
  value,
  tone = "muted",
}: {
  label: string;
  value: number;
  tone?: "muted" | "good" | "danger";
}): React.ReactElement {
  const valueClass =
    tone === "danger" ? "text-amber-300" :
    tone === "good"   ? "text-emerald-300" :
                        "text-foreground/80";
  return (
    <div className="flex flex-col items-center justify-center rounded bg-secondary/30 px-1 py-1 leading-tight">
      <div className={`text-sm font-semibold tabular-nums ${valueClass}`}>{value}</div>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
    </div>
  );
}

// Short relative-time formatter: "2h ago", "3d ago", "just now".
// Falls back to a yyyy-mm-dd if the input doesn't parse.
function relTime(iso: string, lang: "en" | "ar"): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diffMs = Date.now() - t;
  const m = Math.round(diffMs / 60_000);
  const h = Math.round(diffMs / 3_600_000);
  const d = Math.round(diffMs / 86_400_000);
  if (lang === "ar") {
    if (m < 1)  return "الآن";
    if (m < 60) return `قبل ${m} د`;
    if (h < 24) return `قبل ${h} س`;
    if (d < 30) return `قبل ${d} يوم`;
    return new Date(iso).toLocaleDateString();
  }
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
