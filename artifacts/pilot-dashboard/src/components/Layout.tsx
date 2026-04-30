import { ReactNode, useEffect, useState, type HTMLAttributes } from "react";
import { Link, useLocation } from "wouter";
import { useI18n, type Key as TKey } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import {
  LayoutDashboard, ListChecks, PlusCircle, Users, BadgeCheck,
  Trophy, CalendarRange, PalmtreeIcon, UserX, Calendar, ClipboardList,
  ShieldAlert, FileText, Megaphone, Map, Tags, FileDown, Settings,
  Sun, Moon, Wifi, WifiOff, LogOut, Menu, History, Upload, HelpCircle,
  Archive, Bell, Activity, Link2,
  // These five icons MUST be aliased (not imported under their original
  // names). Vite/Rollup's name-mangling step in production builds leaves
  // certain lucide-react identifiers — Inbox, Mail, Share2, UserPlus,
  // Users2, FileBarChart — un-renamed in the output, which then references
  // a global that doesn't exist at runtime → "ReferenceError: Inbox is
  // not defined" and the entire renderer fails to mount (black screen).
  // Aliasing forces the minifier to bind the import to the local name
  // properly. DO NOT REVERT to the bare import without verifying the
  // built bundle no longer contains the literal names.
  UserPlus as UserPlusIcon,
  Users2 as Users2Icon,
  FileBarChart as FileBarChartIcon,
  Inbox as InboxIcon,
  Mail as MailIcon,
  Share2 as Share2Icon,
  ClipboardCheck as ClipboardCheckIcon,
} from "lucide-react";
import { canUseMessages, canUseScheduleChain, canViewFinalSchedules } from "@/lib/cross-pc";
import { LiveDataIndicator } from "@/components/LiveDataIndicator";
import { SquadronScopePicker } from "@/components/SquadronScopePicker";
import IdentityStrip from "@/components/IdentityStrip";
import HeartbeatFailureBanner from "@/components/HeartbeatFailureBanner";
import { getHeartbeatStatus, isHeartbeatFresh, subscribeHeartbeatStatus } from "@/lib/cross-pc";
import { IncomingAlertWatcher } from "@/components/IncomingAlertWatcher";
import { SessionCollisionBanner } from "@/components/SessionCollisionBanner";
import { useSidebarBadges } from "@/lib/sidebar-badges";

type Item = { p: string; k: TKey; I: typeof LayoutDashboard };
const ITEMS: readonly Item[] = [
  { p: "/", k: "nav_dashboard", I: LayoutDashboard },
  { p: "/sortie-log", k: "nav_sortielog", I: ListChecks },
  { p: "/sortie-add", k: "nav_addsortie", I: PlusCircle },
  { p: "/pending", k: "nav_pending", I: InboxIcon },
  { p: "/external-pilots", k: "nav_externalpilots", I: UserPlusIcon },
  { p: "/schedule-chain", k: "nav_schedule_chain", I: Share2Icon },
  { p: "/schedule-history", k: "nav_schedule_history", I: History },
  { p: "/final-schedules", k: "nav_final_schedules", I: ClipboardCheckIcon },
  { p: "/messages", k: "nav_messages", I: MailIcon },
  { p: "/roster", k: "nav_roster", I: Users },
  { p: "/currency", k: "nav_currency", I: BadgeCheck },
  { p: "/rankings", k: "nav_rankings", I: Trophy },
  { p: "/cycle", k: "nav_cycle", I: CalendarRange },
  { p: "/leaves", k: "nav_leaves", I: PalmtreeIcon },
  { p: "/unavailable", k: "nav_unavail", I: UserX },
  { p: "/duty", k: "nav_duty", I: Calendar },
  // Daily Missions (/schedule) was removed per April 2026 field-use review —
  // operators reported the page duplicated the Flight Program board and was
  // never used in practice. The route still exists for any deep links from
  // older screenshots; only the sidebar entry is gone.
  { p: "/flight-program", k: "nav_flight_program", I: ClipboardList },
  { p: "/risk", k: "nav_risk", I: ShieldAlert },
  { p: "/coordinating", k: "nav_coord", I: FileText },
  { p: "/notams", k: "nav_notams", I: Megaphone },
  { p: "/nav-routes", k: "nav_navroutes", I: Map },
  { p: "/units", k: "nav_units", I: Tags },
  { p: "/pdf", k: "nav_pdf", I: FileDown },
  // User Manager (/users) was retired in the April 2026 audit per
  // CO request. The route is unmounted in App.tsx so a direct URL hit
  // lands on the NotFound page (no silent redirect, no dead access).
  // The underlying Users.tsx page remains in the codebase as a future
  // re-enable point but is not reachable.
  { p: "/reminders", k: "nav_reminders", I: Bell },
  { p: "/audit", k: "nav_audit", I: History },
  { p: "/import", k: "nav_import", I: Upload },
  { p: "/archives", k: "nav_archives", I: Archive },
  { p: "/ops-team", k: "nav_opsteam", I: Users2Icon },
  { p: "/monthly-report", k: "nav_monthly_report", I: FileBarChartIcon },
  { p: "/help", k: "nav_help", I: HelpCircle },
  { p: "/connections", k: "nav_connections", I: Link2 },
  { p: "/settings", k: "nav_settings", I: Settings },
  { p: "/diagnostic", k: "nav_diagnostic", I: Activity },
] as const;

export default function Layout({ children }: { children: ReactNode }) {
  const { t, lang, setLang } = useI18n();
  const { user, logout, squadron } = useAuth();
  const [loc] = useLocation();
  const [open, setOpen] = useState(true);
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  // Re-render the topbar Online badge whenever the heartbeat ticks so
  // the badge can flip green → amber → red as the cross-PC link
  // degrades. The badge no longer relies on navigator.onLine alone —
  // a PC can be on the LAN but cut off from Supabase by RLS / firewall.
  const [, setHbTick] = useState(0);
  useEffect(() => subscribeHeartbeatStatus(() => setHbTick(x => x + 1)), []);
  const hb = getHeartbeatStatus();
  const hbFresh = isHeartbeatFresh();
  // task #134 spec — three states keyed off NETWORK availability and
  // heartbeat freshness:
  //   • green  : navigator.onLine && heartbeat fresh (≤90 s)
  //   • amber  : navigator.onLine && heartbeat stale OR failing (the
  //              network is up, but our PC is not talking to Supabase /
  //              registry — operator should diagnose)
  //   • red    : !navigator.onLine (PC is off the network entirely)
  // Click anywhere on the badge opens /diagnostic so the operator can
  // immediately investigate. The badge is a button, not a span, so
  // it's keyboard-focusable and screen-reader-clickable.
  const linkState: "green" | "amber" | "red" = !online
    ? "red"
    : hbFresh && !hb.bannerVisible
      ? "green"
      : "amber";
  const linkLabel = linkState === "green"
    ? t("online")
    : linkState === "amber"
      ? (hb.okAt ? "Stale" : "Connecting…")
      : t("offline");
  const linkCls = linkState === "green"
    ? "text-emerald-300 bg-emerald-500/10"
    : linkState === "amber"
      ? "text-amber-300 bg-amber-500/10"
      : "text-rose-300 bg-rose-500/15";
  const badges = useSidebarBadges();

  // Theme: dark (default — military) or light (daylight / briefing room).
  // Persisted per device in localStorage so commanders / ops officers
  // don't have to re-pick on every load. Applied by toggling the class
  // on <html>; the CSS variables in index.css do the rest.
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    if (typeof window === "undefined") return "dark";
    const saved = window.localStorage.getItem("rjaf.theme");
    return saved === "light" ? "light" : "dark";
  });
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("dark", "light");
    root.classList.add(theme);
    try { window.localStorage.setItem("rjaf.theme", theme); } catch { /* storage may be blocked */ }
  }, [theme]);

  return (
    <div className="min-h-screen brand-bg flex">
      {/* Sidebar */}
      <aside className={`${open ? "w-64" : "w-16"} transition-all duration-200 bg-sidebar border-r border-sidebar-border flex flex-col shrink-0`}>
        <div className="h-16 flex items-center gap-2 px-3 border-b border-sidebar-border">
          <img src="brand/emblem.png" className="h-9 w-9 object-contain" alt="RJAF" />
          {open && (
            <div className="leading-tight">
              <div className="text-[11px] tracking-widest text-muted-foreground">RJAF</div>
              <div className="text-sm font-semibold gold-grad">{squadron?.name || "Squadron Ops"}</div>
            </div>
          )}
        </div>
        <nav className="flex-1 overflow-y-auto py-2">
          {ITEMS.filter(({ p }) => {
            // Flight Schedule (creation / editing) is restricted to the ops
            // officer and super admin on the squadron PC. Deputies and
            // other roles don't see it in the sidebar and the page itself
            // blocks direct URL access.
            if (p === "/flight-program") {
              // v1.1.100: Flight Schedule is back in the Ops sidebar.
              // The Ops officer authors the daily schedule sheet here
              // and forwards it up the chain (Ops → Flight Cmdr) via
              // Schedule Chain. Restricted to the Ops officer + super
              // admin (other roles wouldn't have ops-side write access
              // to the flight-program payload anyway).
              return user?.role === "ops" || user?.role === "super_admin";
            }
            if (p === "/ops-team") {
              // Only the lead ops pilot manages the assigned ops sub-accounts.
              return user?.role === "ops";
            }
            if (p === "/monthly-report") {
              // Monthly Report (QRFG RCN Forms 1-4 + Arabic roster) is owned
              // by the squadron ops officer.
              return user?.role === "ops";
            }
            // Cross-PC features are gated by role+scope. Messages excludes
            // Flight Cmdr and Ops Pilot deputies; Schedule Sharing excludes
            // Ops Pilot deputies but lets Flight Cmdrs participate. Pending
            // Approvals belongs to the squadron ops officer specifically —
            // it cascades into the local calc engine on accept.
            if (p === "/messages") return canUseMessages(user?.role, undefined);
            if (p === "/schedule-chain") {
              // v1.1.28: Ops Pilot is now a first-class participant in
              // the schedule chain (peer share with linked Flight Cmdrs
              // AND with the Squadron Cmdr, both directions). The label
              // is shown for every role canUseScheduleChain accepts.
              return canUseScheduleChain(user?.role, user?.scope);
            }
            if (p === "/schedule-history") {
              // v1.1.108: Schedule History is the read-only audit
              // ledger for any PC that participates in the schedule
              // chain (same gate as /schedule-chain). Decisions move
              // off the active inbox once approved/rejected; this is
              // where the operator goes to look up "what did the
              // chain say about Sunday's sheet last week".
              return canUseScheduleChain(user?.role, user?.scope);
            }
            if (p === "/final-schedules") {
              // v1.1.64: Base + HQ Cmdrs see a read-only rollup of every
              // Wing-approved flight schedule, sorted per squadron.
              return canViewFinalSchedules(user?.role, user?.scope);
            }
            if (p === "/pending") return user?.role === "ops" || user?.role === "super_admin";
            return true;
          }).map(({ p, k, I }) => {
            const active = loc === p || (p !== "/" && loc.startsWith(p));
            // v1.1.97: unread/incoming badge so the operator notices a
            // new schedule, message or pending guest even if they missed
            // the toast notification. Pulses when there's anything to
            // act on; suppressed while you're already viewing that page.
            const count = badges[p] ?? 0;
            const showBadge = count > 0 && !active;
            return (
              <Link
                key={p}
                href={p}
                className={`relative flex items-center gap-3 px-3 py-2 mx-2 my-0.5 rounded-md text-sm row-hover ${active ? "bg-sidebar-accent text-sidebar-primary font-medium" : showBadge ? "bg-rose-500/10 text-rose-100 ring-1 ring-rose-500/40" : "text-sidebar-foreground"}`}
                data-testid={`nav-${p.replace(/^\//, "") || "home"}`}
              >
                <span className="relative shrink-0">
                  <I className="h-4 w-4" />
                  {showBadge && !open && (
                    <span
                      className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-sidebar animate-pulse"
                      aria-hidden
                    />
                  )}
                </span>
                {open && <span className="truncate">{t(k)}</span>}
                {open && showBadge && (
                  <span
                    className="ml-auto inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-rose-500 text-white text-[10px] font-bold leading-none animate-pulse"
                    data-testid={`nav-badge-${p.replace(/^\//, "")}`}
                    aria-label={`${count} new`}
                  >
                    {count > 99 ? "99+" : count}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="p-2 border-t border-sidebar-border flex items-center gap-2">
          <button onClick={() => setOpen(o => !o)} className="p-2 rounded hover:bg-sidebar-accent" title="Toggle">
            <Menu className="h-4 w-4" />
          </button>
          <button
            onClick={logout}
            aria-label={t("logout")}
            className={`rounded hover:bg-sidebar-accent ${
              open ? "px-2 py-1.5 inline-flex items-center gap-2 text-xs border border-sidebar-border" : "p-2"
            }`}
            title={t("logout")}
            data-testid="button-sidebar-logout"
          >
            <LogOut className="h-4 w-4" />
            {open && <span>{t("logout")}</span>}
          </button>
          {open && <span className="text-[10px] text-muted-foreground">v1.0.0</span>}
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Topbar */}
        <header className="h-16 flex items-center justify-between px-4 border-b border-border bg-card/40 backdrop-blur">
          <div className="flex items-center gap-3 min-w-0">
            <img src="brand/emblem.png" className="h-10 object-contain" alt="RJAF" />
            <div className="leading-tight min-w-0">
              <div className="title-line truncate">
                {squadron ? `${squadron.number} SQDN · ${squadron.base}` : "Squadron Operations"}
              </div>
              <div className="text-sm font-semibold truncate">{t("appTag")}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/diagnostic"
              className={`flex items-center gap-1 text-xs px-2 py-1 rounded-md ${linkCls} hover:opacity-90 cursor-pointer`}
              title={hb.errorMsg ? `${linkLabel} — ${hb.errorMsg} · Click to diagnose` : `${linkLabel} · Click to diagnose`}
              data-testid="badge-link-state"
              data-state={linkState}
              aria-label={`Connection ${linkLabel}. Click to open diagnostics.`}
            >
              {linkState === "green" ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              {linkLabel}
            </Link>
            <LiveDataIndicator />
            <SquadronScopePicker />
            <button onClick={() => setLang(lang === "en" ? "ar" : "en")} className="text-xs px-2 py-1 rounded-md border border-border hover:bg-secondary">
              {lang === "en" ? t("arabic") : t("english")}
            </button>
            <button
              className="p-2 rounded-md hover:bg-secondary"
              title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              data-testid="button-theme-toggle"
              data-print-hide
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button
              onClick={logout}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md border border-border hover:bg-secondary"
              title={t("logout")}
              data-testid="button-topbar-logout"
            >
              <LogOut className="h-3.5 w-3.5" />
              {t("logout")}
            </button>
            <div className="hidden md:flex items-center gap-2 ml-2 pl-3 border-l border-border">
              <div className="text-right rtl:text-left leading-tight" data-testid="text-signed-in-as">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{t("signedInAs")}</div>
                <div className="text-sm font-medium">{user?.displayName}</div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{user?.role}</div>
              </div>
              <button onClick={logout} className="p-2 rounded-md hover:bg-secondary" title={t("logout")}>
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </header>
        <HeartbeatFailureBanner diagnosticPath="/diagnostic" />
        <SessionCollisionBanner />
        {/* Task #299 — IdentityStrip mounts under every authenticated
            shell (HQLayout for SA/commander, Layout for squadron ops)
            so every operator sees a permanent reminder of the bound
            member, role, scope, and machine fingerprint without
            needing to open a settings panel. */}
        <IdentityStrip />
        <main className="flex-1 overflow-y-auto p-5">{children}</main>
      </div>
      {/* Cross-PC alert watcher: chimes + toasts + desktop notifications
          when a message, schedule share, or pending approval arrives that
          targets THIS PC. Mounted inside Layout so it only runs on the
          authenticated shell (never on the login screen). */}
      <IncomingAlertWatcher />
    </div>
  );
}

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="flex items-end justify-between mb-4 gap-3 flex-wrap">
      <div>
        <h1 className="text-xl font-semibold gold-grad">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({
  children,
  className = "",
  ...rest
}: { children: ReactNode; className?: string } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`panel p-4 ${className}`} {...rest}>
      {children}
    </div>
  );
}
