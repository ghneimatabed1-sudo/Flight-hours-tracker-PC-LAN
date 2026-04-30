import { Link, useLocation } from "wouter";
import { type ReactNode } from "react";
import { useAuth } from "@/lib/auth";
import { useI18n, type Key } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LogOut, Languages, ShieldCheck, Activity, Users, Plane, ListChecks, BarChart3, AlertTriangle, AlarmClock, Gauge, Lock, CalendarDays, ClipboardList, UserX, StickyNote, Mail, Share2, Bell, ClipboardCheck, History, Settings as SettingsIcon, Link2 as Link2Icon, Network, Inbox, Laptop } from "lucide-react";
import IdentityStrip from "@/components/IdentityStrip";
import { canUseMessages, canUseScheduleChain, canViewFinalSchedules } from "@/lib/cross-pc";
import { useSidebarBadges } from "@/lib/sidebar-badges";
import { FlightBindingGate, FlightBindingBadge } from "@/components/FlightBindingGate";
import { LiveDataIndicator } from "@/components/LiveDataIndicator";
import HeartbeatFailureBanner from "@/components/HeartbeatFailureBanner";
import emblem from "@assets/rjaf_emblem.png";
import { RecoveryCodesLowBanner } from "@/components/RecoveryCodesLowBanner";
import { SessionCollisionBanner } from "@/components/SessionCollisionBanner";

interface NavItem {
  path: string;
  labelKey: Key;
  icon: ReactNode;
}

export function HQLayout({ children }: { children: ReactNode }) {
  const { user, logout, squadron } = useAuth();
  const { t, lang, setLang, dir } = useI18n();
  const [location] = useLocation();
  // v1.1.108 — surface the same red-dot / counter pulse the squadron
  // sidebar uses, so commander seats (Flight Cmdr, Sqn Cmdr, Wing,
  // Base, HQ) actually notice an incoming schedule, message, or
  // pending guest. The badge map is keyed by squadron-style paths
  // (`/schedule-chain`, `/flight-program`, ...) — strip the
  // `/dashboard` prefix when looking up commander-shell entries.
  const badges = useSidebarBadges();
  const badgeFor = (path: string): number => {
    if (path === "/dashboard") return 0;
    const stripped = path.replace(/^\/dashboard/, "") || "/";
    return badges[stripped] ?? badges[path] ?? 0;
  };
  // PC heartbeat is centralised in App.tsx → ArchiveBootstrap so that
  // every signed-in role (commander tiers, ops officers) registers
  // exactly once with a stable, tier-aware id. Don't duplicate it here.

  if (!user) return <>{children}</>;

  const isAdmin = user.role === "super_admin";

  const items: NavItem[] = isAdmin
    ? [
        { path: "/admin", labelKey: "systemOverview", icon: <BarChart3 className="h-4 w-4" /> },
        // Task #299 — Pending Devices replaces License Keys + Generate Code,
        // Devices & Users replaces Commanders. Old routes still mounted in
        // App.tsx for direct-link compat but no longer surfaced in nav.
        { path: "/admin/pending-devices", labelKey: "pendingDevices", icon: <Inbox className="h-4 w-4" /> },
        { path: "/admin/devices-users", labelKey: "devicesAndUsers", icon: <Laptop className="h-4 w-4" /> },
        { path: "/admin/squadrons", labelKey: "squadrons", icon: <Plane className="h-4 w-4" /> },
        { path: "/admin/reminders", labelKey: "remindersSchedule", icon: <AlarmClock className="h-4 w-4" /> },
        { path: "/admin/audit", labelKey: "auditLog", icon: <ListChecks className="h-4 w-4" /> },
        { path: "/admin/security", labelKey: "nav_security", icon: <Lock className="h-4 w-4" /> },
        { path: "/admin/connection-map", labelKey: "nav_connection_map", icon: <Network className="h-4 w-4" /> },
        { path: "/connections", labelKey: "nav_connections", icon: <Link2Icon className="h-4 w-4" /> },
        { path: "/settings", labelKey: "nav_settings", icon: <SettingsIcon className="h-4 w-4" /> },
        { path: "/diagnostic", labelKey: "nav_diagnostic", icon: <Activity className="h-4 w-4" /> },
      ]
    : [
        { path: "/dashboard", labelKey: "overview", icon: <BarChart3 className="h-4 w-4" /> },
        { path: "/dashboard/pilots", labelKey: "pilots", icon: <Users className="h-4 w-4" /> },
        { path: "/dashboard/alerts", labelKey: "alerts", icon: <AlertTriangle className="h-4 w-4" /> },
        // Currencies roll-up — Day / Night / NVG / IRT / Medical / Sim per
        // pilot, with Hide-column and sort. All commander scopes (squadron,
        // flight, wing, base, HQ) get this view.
        { path: "/dashboard/currencies", labelKey: "currencies", icon: <Gauge className="h-4 w-4" /> },
        // Squadron-scope commanders can browse the sorties the ops officer
        // has entered, filterable by day. Intentionally hidden for HQ / base
        // / wing scope (they don't own a single squadron's local data store).
        ...(user.scope === "squadron"
          ? ([
              { path: "/dashboard/flights", labelKey: "flightRecords", icon: <CalendarDays className="h-4 w-4" /> },
              { path: "/dashboard/flight-program", labelKey: "nav_flight_program", icon: <ClipboardList className="h-4 w-4" /> },
              { path: "/dashboard/simulator", labelKey: "simulator", icon: <Gauge className="h-4 w-4" /> },
            ] satisfies NavItem[])
          : []),
        // Flight commanders own the same authoring surface as the squadron
        // commander for their flight: the daily flight schedule sheet
        // (FlightProgram), the read-only Flight Records browser for sorties
        // already entered by the Ops officer, and the Simulator log used to
        // record / sign off sim rides. Audit J F-J-05 noted these three
        // entries were missing from the flight-cmdr sidebar — the operator
        // had no way to reach them even though the routes existed. We mount
        // the same trio used by the squadron block above so a flight cmdr's
        // sidebar matches the spec (Flight Records · Flight Program ·
        // Simulator) without giving them squadron-wide cross-flight scope.
        ...(user.scope === "flight"
          ? ([
              { path: "/dashboard/flights", labelKey: "flightRecords", icon: <CalendarDays className="h-4 w-4" /> },
              { path: "/dashboard/flight-program", labelKey: "nav_flight_program", icon: <ClipboardList className="h-4 w-4" /> },
              { path: "/dashboard/simulator", labelKey: "simulator", icon: <Gauge className="h-4 w-4" /> },
            ] satisfies NavItem[])
          : []),
        // Squadron + Flight commanders get a read-only Unavailable list
        // (see who in the squadron is on leave / grounded). Wing / base /
        // HQ scope skip it — they don't drill into a single squadron's
        // operational availability from this surface.
        ...(user.scope === "squadron" || user.scope === "flight"
          ? ([{ path: "/dashboard/unavailable", labelKey: "nav_unavail", icon: <UserX className="h-4 w-4" /> }] satisfies NavItem[])
          : []),
        // Pilot Alerts — squadron + flight commanders push short messages
        // straight to pilots' phones. Other commander scopes don't have a
        // direct line to pilot mobiles, so they don't see this entry.
        ...(user.scope === "squadron" || user.scope === "flight"
          ? ([{ path: "/dashboard/pilot-alerts", labelKey: "nav_pilot_alerts", icon: <Bell className="h-4 w-4" /> }] satisfies NavItem[])
          : []),
        // Sticky notes calendar is a per-PC scratchpad for every commander.
        { path: "/dashboard/sticky", labelKey: "nav_sticky", icon: <StickyNote className="h-4 w-4" /> },
        // Flight Schedule creation is squadron-level only. Flight / wing /
        // base / HQ-scope commanders don't own a specific squadron's daily
        // sheet so they don't get this page in their sidebar.
        ...(canUseScheduleChain(user.role, user.scope)
          ? ([
              { path: "/dashboard/schedule-chain", labelKey: "nav_schedule_chain", icon: <Share2 className="h-4 w-4" /> },
              { path: "/dashboard/schedule-history", labelKey: "nav_schedule_history", icon: <History className="h-4 w-4" /> },
            ] satisfies NavItem[])
          : []),
        // v1.1.64 — Base / HQ commanders are read-only viewers of every
        // Wing-approved flight schedule across every squadron, sorted
        // per squadron with the originating Sqn Cmdr name visible.
        ...(canViewFinalSchedules(user.role, user.scope)
          ? ([{ path: "/dashboard/final-schedules", labelKey: "nav_final_schedules", icon: <ClipboardCheck className="h-4 w-4" /> }] satisfies NavItem[])
          : []),
        ...(canUseMessages(user.role, user.scope)
          ? ([{ path: "/dashboard/messages", labelKey: "nav_messages", icon: <Mail className="h-4 w-4" /> }] satisfies NavItem[])
          : []),
        // Settings: every commander scope (squadron / flight / wing / base
        // / HQ) needs the auto-updater toggle and the manual "Check for
        // app update" button. Without this entry the operator on a flight
        // commander PC has no way to pull a new installer build.
        { path: "/dashboard/connections", labelKey: "nav_connections", icon: <Link2Icon className="h-4 w-4" /> },
        { path: "/dashboard/settings", labelKey: "nav_settings", icon: <SettingsIcon className="h-4 w-4" /> },
        { path: "/dashboard/diagnostic", labelKey: "nav_diagnostic", icon: <Activity className="h-4 w-4" /> },
      ];

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground" dir={dir}>
      <header className="bg-sidebar text-sidebar-foreground border-b border-sidebar-border">
        <div className="px-4 sm:px-6 py-3 flex items-center gap-3">
          <img src={emblem} alt="RJAF Emblem" className="h-10 w-10 object-contain" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-base sm:text-lg font-semibold truncate">{t("hqAppName")}</h1>
              {isAdmin ? (
                <Badge className="bg-amber-500 text-amber-950 hover:bg-amber-500">
                  <ShieldCheck className="h-3 w-3 me-1" />{t("superAdminPanel")}
                </Badge>
              ) : (
                <Badge variant="secondary" className="bg-sidebar-accent text-sidebar-accent-foreground">
                  <Activity className="h-3 w-3 me-1" />{t("commanderDashboard")}
                </Badge>
              )}
            </div>
            <p className="text-xs text-sidebar-foreground/70 truncate">
              {t("signedInAs")}: <span className="font-medium">{user.displayName}</span>
              {!isAdmin && user.scope && (
                <> · {t(("scope" + user.scope.charAt(0).toUpperCase() + user.scope.slice(1)) as Key)}</>
              )}
            </p>
            {/* v1.1.67 — surface the same live-sync pill (green/amber/red)
                that Sqn / Wing operators see, so Base & HQ commanders can
                tell at a glance whether their PC is talking to the cloud. */}
            <div className="mt-1 flex items-center gap-2 flex-wrap">
              <LiveDataIndicator />
              <FlightBindingBadge />
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLang(lang === "en" ? "ar" : "en")}
            className="text-sidebar-foreground hover-elevate"
            data-testid="button-lang"
          >
            <Languages className="h-4 w-4 me-1" />{t("langToggle")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={logout}
            className="text-sidebar-foreground hover-elevate"
            data-testid="button-logout"
          >
            <LogOut className="h-4 w-4 me-1" />{t("signOut")}
          </Button>
        </div>
        <div className="px-4 sm:px-6 pb-2 -mt-1 flex items-center justify-end">
          <span
            className="text-[10px] uppercase tracking-[0.18em] font-medium bg-gradient-to-r from-amber-300 via-amber-100 to-amber-300 bg-clip-text text-transparent select-none"
            data-testid="text-credit"
          >
            Developed by Capt. ABEDALQADER GHUNMAT
          </span>
        </div>
      </header>

      <div className="flex-1 flex flex-col md:flex-row">
        <nav className="md:w-60 bg-sidebar border-b md:border-b-0 md:border-e border-sidebar-border">
          <ul className="flex md:flex-col overflow-x-auto md:overflow-visible p-2 gap-1">
            {items.map(item => {
              const isActive = location === item.path || (item.path !== "/admin" && item.path !== "/dashboard" && location.startsWith(item.path));
              const isExactRoot = (item.path === "/admin" || item.path === "/dashboard") && location === item.path;
              const active = isActive || isExactRoot;
              const count = badgeFor(item.path);
              const showBadge = count > 0 && !active;
              return (
                <li key={item.path}>
                  <Link
                    href={item.path}
                    className={`relative flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap hover-elevate active-elevate-2 ${
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                        : showBadge
                        ? "bg-rose-500/10 text-rose-100 ring-1 ring-rose-500/40"
                        : "text-sidebar-foreground/85"
                    }`}
                    data-testid={`nav-${item.path.split("/").pop()}`}
                  >
                    <span className="relative shrink-0">
                      {item.icon}
                      {showBadge && (
                        <span
                          className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-rose-500 animate-pulse"
                          aria-hidden
                        />
                      )}
                    </span>
                    <span>{t(item.labelKey)}</span>
                    {showBadge && (
                      <span
                        className="ms-auto inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-rose-500 text-white text-[10px] font-bold leading-none animate-pulse"
                        data-testid={`nav-badge-${item.path.split("/").pop()}`}
                        aria-label={`${count} new`}
                      >
                        {count > 99 ? "99+" : count}
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <main className="flex-1 min-w-0 p-4 sm:p-6 space-y-4 overflow-y-auto">
          <HeartbeatFailureBanner diagnosticPath={isAdmin ? "/diagnostic" : "/dashboard/diagnostic"} />
          <SessionCollisionBanner />
          {isAdmin && <RecoveryCodesLowBanner />}
          <IdentityStrip />
          <FlightBindingGate>
            {children}
          </FlightBindingGate>
        </main>
      </div>

      <footer className="border-t border-border bg-card px-4 py-2 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 items-center justify-between">
        <span>{t("classifiedFooter")}</span>
        <span>{t("sessionTimeout")}</span>
      </footer>
    </div>
  );
}
