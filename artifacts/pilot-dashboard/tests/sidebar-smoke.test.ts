// Permanent regression guard against page-level "STARTUP ERROR (EARLY)"
// crashes — i.e. the kind that ends up showing the "Hawk Eye — startup
// error" overlay produced by main.tsx → showFatal() because a page
// threw on first render.
//
// Strategy
// ────────
//  1. Stand up a jsdom window with the localStorage shape AuthProvider
//     expects for each role.
//  2. For every (role × sidebar route) pair the layouts render, mount
//     the page component wrapped in I18nProvider + AuthProvider +
//     QueryClientProvider + Wouter memory router.
//  3. Use react-dom/server.renderToString. Any synchronous throw is
//     caught and recorded as a failure for that (role, route) pair.
//  4. Pages that legitimately render data tables on undefined inputs,
//     null-deref a missing roster field, or otherwise crash the React
//     tree on first render will fail the matching assertion — the test
//     is the universal smoke screen for every sidebar entry.
//
// The test deliberately covers rendering only, not effects. Effects
// run inside the browser; what we are guarding against here is the
// synchronous-throw class of crash that takes the whole tree down
// before React can mount its error boundary.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

// ── jsdom bootstrap (must run before importing any React module that
//    reads window / localStorage at module scope) ───────────────────
const dom = new JSDOM(
  "<!doctype html><html><body><div id='root'></div></body></html>",
  { url: "http://localhost/", pretendToBeVisual: true },
);
const w = dom.window as unknown as Window & typeof globalThis;
function setG(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, {
    value, writable: true, configurable: true, enumerable: true,
  });
}
setG("window", w);
setG("document", w.document);
setG("navigator", w.navigator);
setG("localStorage", w.localStorage);
setG("sessionStorage", w.sessionStorage);
setG("HTMLElement", w.HTMLElement);
setG("Element", w.Element);
setG("Node", w.Node);
setG("getComputedStyle", w.getComputedStyle.bind(w));
setG("requestAnimationFrame", (cb: FrameRequestCallback) => Number(setTimeout(() => cb(performance.now()), 16)));
setG("cancelAnimationFrame", (id: number) => clearTimeout(id));
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}
setG("IntersectionObserver", NoopObserver);
setG("ResizeObserver", NoopObserver);
setG("MutationObserver", w.MutationObserver);
const matchMedia = (q: string) => ({
  matches: false, media: q, onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
});
setG("matchMedia", matchMedia);
(w as unknown as Record<string, unknown>).matchMedia = matchMedia;
(w as unknown as Record<string, unknown>).scrollTo = () => {};

// `import.meta.env` is a Vite-only construct. Each module gets its own
// `import.meta`, so we can't shim cross-module from here — instead the
// dashboard source (supabase.ts, Diagnostic.tsx) defensively guards
// the read so the modules load cleanly under a plain Node test runner
// with no `import.meta.env` defined. The smoke test relies on that
// guard staying in place; if a future page reads `import.meta.env.X`
// directly without a guard the corresponding test case will surface
// a "Cannot read properties of undefined (reading 'X')" failure.

// ── lazy imports (after globals are set) ───────────────────────────
const React = (await import("react")).default;
const { renderToString } = await import("react-dom/server");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Router } = await import("wouter");
const { memoryLocation } = await import("wouter/memory-location");

// Provider modules — these read window/localStorage on import, so the
// jsdom bootstrap above must be in place first.
const { I18nProvider } = await import("../src/lib/i18n.tsx");
const { AuthProvider } = await import("../src/lib/auth.tsx");

// ── role catalog ──────────────────────────────────────────────────
type RoleKey =
  | "super_admin"
  | "wing_cmdr"
  | "base_cmdr"
  | "sqn_cmdr"
  | "sqn_cmdr_multi"
  | "flight_cmdr"
  | "ops"
  | "deputy";

interface Persona {
  user: { username: string; displayName: string; role: string; scope?: string; squadronIds?: string[] };
  layout: "admin" | "commander" | "ops";
}

const PERSONAS: Record<RoleKey, Persona> = {
  super_admin:   { user: { username: "admin", displayName: "Super Admin",     role: "super_admin" },                               layout: "admin" },
  wing_cmdr:     { user: { username: "wing",  displayName: "Wing Cmdr",       role: "commander", scope: "wing" },                  layout: "commander" },
  base_cmdr:     { user: { username: "base",  displayName: "Base Cmdr",       role: "commander", scope: "base" },                  layout: "commander" },
  sqn_cmdr:      { user: { username: "sqn",   displayName: "Sqn Cmdr",        role: "commander", scope: "squadron" },              layout: "commander" },
  sqn_cmdr_multi:{ user: { username: "sqnm",  displayName: "Sqn Cmdr Multi",  role: "commander", scope: "squadron", squadronIds: ["NO.8","NO.5"] }, layout: "commander" },
  flight_cmdr:   { user: { username: "flt",   displayName: "Flight Cmdr",     role: "commander", scope: "flight" },                layout: "commander" },
  ops:           { user: { username: "ops",   displayName: "Ops Pilot",       role: "ops" },                                       layout: "ops" },
  deputy:        { user: { username: "dep",   displayName: "Deputy Ops",      role: "deputy" },                                    layout: "ops" },
};

// Sidebar entries each layout exposes. The route list mirrors the
// arrays in src/components/Layout.tsx (squadron-ops shell) and
// src/components/HQLayout.tsx (admin + commander shells); kept here in
// one place so the smoke screen owns its own contract independent of
// any future sidebar tweak.
// Task #300 — `/admin/keys` (License Keys) and `/admin/commanders`
// were retired with the new Join → Approve → Bind flow. Their sidebar
// entries are gone too, so they're no longer smoke-tested here.
const ADMIN_ROUTES = [
  "/admin", "/admin/squadrons",
  "/admin/reminders", "/admin/audit", "/admin/security",
  "/admin/connection-map", "/connections", "/settings", "/diagnostic",
] as const;

const COMMANDER_BASE = [
  "/dashboard", "/dashboard/pilots", "/dashboard/alerts", "/dashboard/currencies",
  "/dashboard/sticky", "/dashboard/messages", "/dashboard/connections",
  "/dashboard/settings", "/dashboard/diagnostic",
] as const;
const COMMANDER_SQUADRON_FLIGHT_EXTRA = [
  "/dashboard/unavailable", "/dashboard/pilot-alerts",
] as const;
const COMMANDER_SQUADRON_ONLY_EXTRA = [
  "/dashboard/flights", "/dashboard/flight-program", "/dashboard/simulator",
] as const;
const COMMANDER_FLIGHT_ONLY_EXTRA = ["/dashboard/flight-program"] as const;
const COMMANDER_CHAIN_EXTRA = ["/dashboard/schedule-chain", "/dashboard/schedule-history"] as const;
const COMMANDER_FINAL_EXTRA = ["/dashboard/final-schedules"] as const;

const OPS_ROUTES = [
  "/", "/sortie-log", "/sortie-add", "/pending", "/external-pilots",
  "/schedule-chain", "/schedule-history", "/messages",
  "/roster", "/currency", "/rankings", "/cycle", "/leaves", "/unavailable",
  "/duty", "/flight-program", "/risk", "/coordinating", "/notams",
  "/nav-routes", "/units", "/pdf", "/reminders", "/audit", "/import",
  "/archives", "/ops-team", "/monthly-report", "/help", "/connections",
  "/settings", "/diagnostic",
] as const;

function routesFor(role: RoleKey): string[] {
  const persona = PERSONAS[role];
  if (persona.layout === "admin") return [...ADMIN_ROUTES];
  if (persona.layout === "commander") {
    const scope = persona.user.scope as string;
    const out = [...COMMANDER_BASE];
    if (scope === "squadron") {
      out.push(...COMMANDER_SQUADRON_ONLY_EXTRA, ...COMMANDER_SQUADRON_FLIGHT_EXTRA);
    } else if (scope === "flight") {
      out.push(...COMMANDER_FLIGHT_ONLY_EXTRA, ...COMMANDER_SQUADRON_FLIGHT_EXTRA);
    }
    if (scope === "flight" || scope === "squadron" || scope === "wing") {
      out.push(...COMMANDER_CHAIN_EXTRA);
    }
    if (scope === "flight" || scope === "squadron" || scope === "base" || scope === "wing") {
      // canViewFinalSchedules accepts these scopes (HQ would too, but
      // we don't carry an HQ persona — Final Schedules is also exercised
      // by base/wing here).
      out.push(...COMMANDER_FINAL_EXTRA);
    }
    // De-dupe (flight-program shows up twice for some scopes).
    return Array.from(new Set(out));
  }
  // ops / deputy — squadron-ops sidebar. Layout filters drop a few
  // entries for the deputy seat (flight-program, ops-team, monthly-report,
  // pending). Mirror that here so we only smoke entries that role would
  // actually see clickable in the sidebar.
  const out = [...OPS_ROUTES];
  if (role === "deputy") {
    return out.filter(p =>
      p !== "/flight-program" &&
      p !== "/ops-team" &&
      p !== "/monthly-report" &&
      p !== "/pending"
    );
  }
  return out;
}

// ── Page registry ────────────────────────────────────────────────
// Static map of route → page component. Mirrors the Switch arms in
// src/App.tsx — one entry per sidebar destination. Pages that take a
// route param (`/pilot/:id`) are not in any sidebar so they're omitted.
type PageMap = Record<string, () => Promise<{ default: React.ComponentType<unknown> }>>;
const PAGE_LOADERS: PageMap = {
  // squadron-ops
  "/":                  () => import("../src/pages/Dashboard.tsx"),
  "/sortie-log":        () => import("../src/pages/SortieLog.tsx"),
  "/sortie-add":        () => import("../src/pages/AddSortie.tsx"),
  "/pending":           () => import("../src/pages/PendingApprovals.tsx"),
  "/external-pilots":   () => import("../src/pages/ExternalPilots.tsx"),
  "/schedule-chain":    () => import("../src/pages/ScheduleChain.tsx"),
  "/schedule-history":  () => import("../src/pages/ScheduleHistory.tsx"),
  "/messages":          () => import("../src/pages/Messages.tsx"),
  "/roster":            () => import("../src/pages/Roster.tsx"),
  "/currency":          () => import("../src/pages/Currency.tsx"),
  "/rankings":          () => import("../src/pages/Rankings.tsx"),
  "/cycle":             () => import("../src/pages/Cycle.tsx"),
  "/leaves":            () => import("../src/pages/Leaves.tsx"),
  "/unavailable":       () => import("../src/pages/Unavailable.tsx"),
  "/duty":              () => import("../src/pages/DutyWeek.tsx"),
  "/flight-program":    () => import("../src/pages/FlightProgram.tsx"),
  "/risk":              () => import("../src/pages/Risk.tsx"),
  "/coordinating":      () => import("../src/pages/Coordinating.tsx"),
  "/notams":            () => import("../src/pages/NotamsPage.tsx"),
  "/nav-routes":        () => import("../src/pages/NavRoutes.tsx"),
  "/units":             () => import("../src/pages/Units.tsx"),
  "/pdf":               () => import("../src/pages/PdfExports.tsx"),
  "/reminders":         () => import("../src/pages/Reminders.tsx"),
  "/audit":             () => import("../src/pages/AuditLog.tsx"),
  "/import":            () => import("../src/pages/HistoricalImport.tsx"),
  "/archives":          () => import("../src/pages/Archives.tsx"),
  "/ops-team":          () => import("../src/pages/OpsTeam.tsx"),
  "/monthly-report":    () => import("../src/pages/MonthlyReport.tsx"),
  "/help":              () => import("../src/pages/Help.tsx"),
  "/connections":       () => import("../src/pages/Connections.tsx"),
  "/settings":          () => import("../src/pages/Settings.tsx"),
  "/diagnostic":        () => import("../src/pages/Diagnostic.tsx"),
  // admin (Task #300 retired LicenseKeys + Commanders pages)
  "/admin":                 () => import("../src/pages/admin/Overview.tsx"),
  "/admin/squadrons":       () => import("../src/pages/admin/Squadrons.tsx"),
  "/admin/reminders":       () => import("../src/pages/admin/RemindersSchedule.tsx"),
  "/admin/audit":           () => import("../src/pages/admin/AuditLog.tsx"),
  "/admin/security":        () => import("../src/pages/admin/Security.tsx"),
  "/admin/connection-map":  () => import("../src/pages/admin/ConnectionMap.tsx"),
  // commander
  "/dashboard":                  () => import("../src/pages/dashboard/Overview.tsx"),
  "/dashboard/pilots":           () => import("../src/pages/dashboard/PilotsTable.tsx"),
  "/dashboard/alerts":           () => import("../src/pages/dashboard/Alerts.tsx"),
  "/dashboard/currencies":       () => import("../src/pages/dashboard/Currencies.tsx"),
  "/dashboard/pilot-alerts":     () => import("../src/pages/dashboard/PilotAlerts.tsx"),
  "/dashboard/simulator":        () => import("../src/pages/dashboard/Simulator.tsx"),
  "/dashboard/flights":          () => import("../src/pages/dashboard/FlightRecords.tsx"),
  "/dashboard/flight-program":   () => import("../src/pages/FlightProgram.tsx"),
  "/dashboard/unavailable":      () => import("../src/pages/dashboard/UnavailableView.tsx"),
  "/dashboard/sticky":           () => import("../src/pages/StickyNotes.tsx"),
  "/dashboard/schedule-chain":   () => import("../src/pages/ScheduleChain.tsx"),
  "/dashboard/schedule-history": () => import("../src/pages/ScheduleHistory.tsx"),
  "/dashboard/final-schedules":  () => import("../src/pages/FinalSchedules.tsx"),
  "/dashboard/messages":         () => import("../src/pages/Messages.tsx"),
  "/dashboard/connections":      () => import("../src/pages/Connections.tsx"),
  "/dashboard/settings":         () => import("../src/pages/Settings.tsx"),
  "/dashboard/diagnostic":       () => import("../src/pages/Diagnostic.tsx"),
};

function setSession(persona: Persona) {
  const ls = w.localStorage;
  ls.clear();
  ls.setItem("rjaf.user", JSON.stringify(persona.user));
  if (persona.layout !== "admin") {
    ls.setItem("rjaf.licensed", "1");
    ls.setItem("rjaf.squadron", JSON.stringify({ name: "NO.8", number: "NO.8", base: "MAFRAQ" }));
    ls.setItem("rjaf.setupWizard.NO.8.complete", "1");
  }
}

function makeTree(path: string, page: React.ComponentType<unknown>): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { hook } = memoryLocation({ path, static: true });
  return React.createElement(
    QueryClientProvider, { client: qc },
    React.createElement(I18nProvider, null,
      React.createElement(AuthProvider, null,
        React.createElement(Router as unknown as React.ComponentType<{ hook: unknown; children: React.ReactNode }>,
          { hook },
          React.createElement(page),
        ),
      ),
    ),
  );
}

interface CaseResult {
  role: RoleKey;
  route: string;
  ok: boolean;
  error?: string;
  ssrOnlyWarning?: boolean;
}
const RESULTS: CaseResult[] = [];

const ROLE_KEYS = Object.keys(PERSONAS) as RoleKey[];

// Errors that ONLY appear under react-dom/server.renderToString and which
// cannot reach the user in the browser. The most common one is React 18's
// useSyncExternalStore "Missing getServerSnapshot" warning that Radix UI
// internals emit during SSR — it is a hint to provide a server snapshot,
// not a real crash. Filter these so the smoke screen asserts the class of
// bug we actually care about (synchronous throw on first render that would
// take the whole dashboard down behind the "Hawk Eye — startup error"
// overlay) and not React-dev SSR noise.
const SSR_ONLY_PATTERNS: RegExp[] = [
  /Missing getServerSnapshot/i,
];

// Cache page-module loaders across cases. Without this each repeat of a
// shared route (e.g. /diagnostic appears under multiple roles) re-imports
// the entire module graph, blowing the runtime out by 10× and tripping
// CI timeouts.
const MODULE_CACHE = new Map<string, React.ComponentType<unknown>>();
async function loadPage(route: string): Promise<React.ComponentType<unknown>> {
  const cached = MODULE_CACHE.get(route);
  if (cached) return cached;
  const loader = PAGE_LOADERS[route];
  if (!loader) throw new Error(`no page loader registered for route ${route}`);
  const mod = await loader();
  MODULE_CACHE.set(route, mod.default);
  return mod.default;
}

// One single node:test entry that walks every (role × route) pair and
// records each as a sub-result. node:test's per-test overhead (set-up,
// reporter flush, async tick) was 0.5–7 s per case, which blew the 109
// pairs past CI's 5 min ceiling. By rolling them into one test we keep
// the failure granularity (every failing pair is named in the thrown
// AggregateError below AND in the evidence JSON) while running the
// whole suite in a few seconds.
test("sidebar smoke · all roles × all sidebar routes", async () => {
  for (const role of ROLE_KEYS) {
    const persona = PERSONAS[role];
    setSession(persona);
    for (const route of routesFor(role)) {
      let err: Error | null = null;
      let Page: React.ComponentType<unknown> | null = null;
      try {
        Page = await loadPage(route);
      } catch (e) {
        err = e instanceof Error ? e : new Error(String(e));
      }
      if (Page && !err) {
        try {
          renderToString(makeTree(route, Page));
        } catch (e) {
          err = e instanceof Error ? e : new Error(String(e));
        }
      }
      const message = err ? `${err.name}: ${err.message}` : undefined;
      const ssrOnly = !!message && SSR_ONLY_PATTERNS.some(re => re.test(message));
      RESULTS.push({
        role,
        route,
        ok: err === null || ssrOnly,
        error: message,
        ssrOnlyWarning: ssrOnly || undefined,
      });
    }
  }

  const realFailures = RESULTS.filter(r => !r.ok);
  if (realFailures.length > 0) {
    const lines = realFailures.map(r => `  · ${r.role} ${r.route} → ${r.error}`).join("\n");
    assert.fail(
      `${realFailures.length} sidebar route(s) threw on first render:\n${lines}`,
    );
  }
});

// Tear down jsdom internals so the node process can exit promptly. The
// JSDOM Window holds a handful of internal Timers / event-loop refs;
// without explicit close they keep node alive past the last test, which
// shows up as a `pnpm test` that "passes" but hangs forever.
test("sidebar smoke · teardown jsdom", () => {
  try { (dom.window as unknown as { close?: () => void }).close?.(); }
  catch { /* best-effort teardown */ }
});

// Dump a structured evidence file at the end of the run, regardless of
// pass/fail. Audit L's repro.json + verify.json both come straight out
// of this artifact — re-running the test is the canonical reproduction.
test("write smoke evidence artifact", () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const target = process.env.SIDEBAR_SMOKE_REPORT
    ?? resolve(__dirname, "../../../.local/reports/audit-2026-04-27/evidence/L/sidebar-smoke.json");
  mkdirSync(dirname(target), { recursive: true });
  const failed = RESULTS.filter(r => !r.ok);
  const payload = {
    generatedAt: new Date().toISOString(),
    totalCases: RESULTS.length,
    failed: failed.length,
    cases: RESULTS,
  };
  writeFileSync(target, JSON.stringify(payload, null, 2));
});
