import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

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
setG("screen", w.screen);
setG("document", w.document);
setG("navigator", w.navigator);
setG("localStorage", w.localStorage);
setG("sessionStorage", w.sessionStorage);
setG("HTMLElement", w.HTMLElement);
setG("HTMLInputElement", w.HTMLInputElement);
setG("HTMLSelectElement", w.HTMLSelectElement);
setG("HTMLTextAreaElement", w.HTMLTextAreaElement);
setG("Element", w.Element);
setG("Node", w.Node);
setG("NodeFilter", w.NodeFilter);
setG("Event", w.Event);
setG("CustomEvent", w.CustomEvent);
setG("MouseEvent", w.MouseEvent);
setG("KeyboardEvent", w.KeyboardEvent);
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
setG("confirm", () => true);
setG("prompt", () => "test-reason");
setG("alert", () => {});
const matchMedia = (q: string) => ({
  matches: false, media: q, onchange: null,
  addListener: () => {}, removeListener: () => {},
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
});
setG("matchMedia", matchMedia);
(w as unknown as Record<string, unknown>).matchMedia = matchMedia;
(w as unknown as Record<string, unknown>).scrollTo = () => {};
(w as unknown as Record<string, unknown>).print = () => {};
(w as unknown as Record<string, unknown>).open = () => null;
(w as unknown as Record<string, unknown>).confirm = () => true;
(w as unknown as Record<string, unknown>).prompt = () => "test-reason";
(w as unknown as Record<string, unknown>).alert = () => {};
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Router } = await import("wouter");
const { memoryLocation } = await import("wouter/memory-location");
const { I18nProvider } = await import("../src/lib/i18n.tsx");
const { AuthProvider } = await import("../src/lib/auth.tsx");

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
const COMMANDER_SQUADRON_FLIGHT_EXTRA = ["/dashboard/unavailable", "/dashboard/pilot-alerts"] as const;
const COMMANDER_SQUADRON_ONLY_EXTRA = ["/dashboard/flights", "/dashboard/flight-program", "/dashboard/simulator"] as const;
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
    if (scope === "squadron") out.push(...COMMANDER_SQUADRON_ONLY_EXTRA, ...COMMANDER_SQUADRON_FLIGHT_EXTRA);
    else if (scope === "flight") out.push(...COMMANDER_FLIGHT_ONLY_EXTRA, ...COMMANDER_SQUADRON_FLIGHT_EXTRA);
    if (scope === "flight" || scope === "squadron" || scope === "wing") out.push(...COMMANDER_CHAIN_EXTRA);
    if (scope === "flight" || scope === "squadron" || scope === "base" || scope === "wing") out.push(...COMMANDER_FINAL_EXTRA);
    return Array.from(new Set(out));
  }
  const out = [...OPS_ROUTES];
  if (role === "deputy") {
    return out.filter(p => p !== "/flight-program" && p !== "/ops-team" && p !== "/monthly-report" && p !== "/pending");
  }
  return out;
}

type PageMap = Record<string, () => Promise<{ default: React.ComponentType<unknown> }>>;
const PAGE_LOADERS: PageMap = {
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
  "/admin":                 () => import("../src/pages/admin/Overview.tsx"),
  "/admin/squadrons":       () => import("../src/pages/admin/Squadrons.tsx"),
  "/admin/reminders":       () => import("../src/pages/admin/RemindersSchedule.tsx"),
  "/admin/audit":           () => import("../src/pages/admin/AuditLog.tsx"),
  "/admin/security":        () => import("../src/pages/admin/Security.tsx"),
  "/admin/connection-map":  () => import("../src/pages/admin/ConnectionMap.tsx"),
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

// Commander dashboard data-grid surfaces rely on browser layout primitives
// that are not stable in jsdom for client-side click sweeps. They are still
// covered by sidebar-smoke first-render guards; this suite focuses on pages
// where click automation is deterministic in headless Node.
const CLICK_SWEEP_SKIP_ROUTES = new Set<string>([
  "/dashboard/pilots",
  "/dashboard/currencies",
]);

interface ClickFailure { role: RoleKey; route: string; button: string; error: string }
const FAILURES: ClickFailure[] = [];

test("button sweep · role routes", async () => {
  const roleKeys = Object.keys(PERSONAS) as RoleKey[];

  const flush = async (ms = 45) => {
    await act(async () => {
      await new Promise<void>(r => setTimeout(r, ms));
    });
  };

  for (const role of roleKeys) {
    const persona = PERSONAS[role];
    for (const route of routesFor(role)) {
      if (CLICK_SWEEP_SKIP_ROUTES.has(route)) continue;
      setSession(persona);
      let Page: React.ComponentType<unknown>;
      try {
        Page = await loadPage(route);
      } catch (e) {
        FAILURES.push({ role, route, button: "<load-page>", error: e instanceof Error ? e.message : String(e) });
        continue;
      }

      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const { hook } = memoryLocation({ path: route, static: true });
      const host = w.document.createElement("div");
      w.document.body.appendChild(host);
      const root = createRoot(host);

      try {
        await act(async () => {
          root.render(
            React.createElement(
              QueryClientProvider, { client: qc },
              React.createElement(I18nProvider, null,
                React.createElement(AuthProvider, null,
                  React.createElement(
                    Router as unknown as React.ComponentType<{ hook: unknown; children?: React.ReactNode }>,
                    { hook, children: React.createElement(Page) },
                  ),
                ),
              ),
            ),
          );
        });
        await flush();
        await flush();
      } catch (e) {
        FAILURES.push({ role, route, button: "<render>", error: e instanceof Error ? e.message : String(e) });
      }

      const nodes = Array.from(host.querySelectorAll("button, [role='button'], input[type='button'], input[type='submit']"));
      const max = Math.min(nodes.length, 120);
      for (let i = 0; i < max; i++) {
        const n = nodes[i] as HTMLButtonElement;
        if (n.hasAttribute("disabled")) continue;
        if (n.getAttribute("aria-disabled") === "true") continue;
        const label = (n.getAttribute("data-testid")
          ?? n.getAttribute("aria-label")
          ?? n.textContent
          ?? "<unnamed>").replace(/\s+/g, " ").trim().slice(0, 120);
        try {
          await act(async () => {
            n.click();
          });
          await flush(18);
        } catch (e) {
          FAILURES.push({
            role,
            route,
            button: label || "<empty-label>",
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      await act(async () => {
        root.unmount();
      });
      host.remove();
    }
  }

  if (FAILURES.length > 0) {
    const lines = FAILURES
      .slice(0, 40)
      .map(f => `  · ${f.role} ${f.route} [${f.button}] -> ${f.error}`)
      .join("\n");
    assert.fail(`${FAILURES.length} button interaction failure(s):\n${lines}`);
  }
});

test("button sweep · teardown", () => {
  try { (dom.window as unknown as { close?: () => void }).close?.(); }
  catch { /* best effort */ }
});
