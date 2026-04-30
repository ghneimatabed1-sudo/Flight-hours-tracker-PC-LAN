// Exercises Pending Approvals **action buttons** (Accept / Reject / Drop) in
// offline mode — the same paths ops uses when Supabase is not configured.
// Complements sidebar-smoke (first render only) with real click events via
// react-dom/client + act().
//
// Run: pnpm run test:guest-pending   (from artifacts/pilot-dashboard)
//  or: npx tsx --import=./tests/asset-loader-register.mjs --test tests/guest-pending-actions.test.ts
//       with TSX_TSCONFIG_PATH pointing at tests/tsconfig.json

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { act } from "react";

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.TSX_TSCONFIG_PATH = resolve(__dirname, "tsconfig.json");

const dom = new JSDOM(
  "<!doctype html><html><body><div id=\"root\"></div></body></html>",
  { url: "http://localhost/", pretendToBeVisual: true },
);
const w = dom.window as unknown as Window & typeof globalThis;
function setG(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, {
    value, writable: true, configurable: true, enumerable: true,
  });
}
setG("window", w);
// AuthProvider fingerprint path reads bare `screen` (browser global).
setG("screen", w.screen);
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

const PENDING_KEY = "rjaf.xpc.pending";
const MOCK_PILOTS_KEY = "rjaf.mock.pilots";
const MOCK_SORTIES_KEY = "rjaf.mock.sorties";

function minimalPilot(): Record<string, unknown> {
  return {
    id: "p-guest-1",
    name: "Guest Match Pilot",
    arabicName: "ض",
    militaryNumber: "552",
    rank: "Capt",
    rankEn: "Capt",
    phone: "1",
    address: "1",
    unit: "SQDN",
    openingDay: 0, openingNight: 0, openingNvg: 0,
    monthDay: 0, monthNight: 0, monthNvg: 0, monthSim: 0, monthCaptain: 0,
    totalDay: 0, totalNight: 0, totalNvg: 0, totalSim: 0, totalCaptain: 0,
    expiry: {
      day: "2030-01-01", night: "2030-01-01", nvg: "2030-01-01",
      irt: "2030-01-01", medical: "2030-01-01", sim: "2030-01-01",
    },
    available: true,
  };
}

function minimalSortie(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: "2026-04-10",
    acType: "UH-60M",
    acNumber: "557",
    pilotId: "host-x",
    coPilotId: "",
    sortieType: "TRG",
    name: "Guest flt",
    day1: 0.5, day2: 0, dayDual: 0,
    night1: 0, night2: 0, nightDual: 0,
    nvg: 0, sim: 0, actual: 0.5,
    condition: "Day",
    ...over,
  };
}

function seedSessionAndData(pendingRows: Record<string, unknown>[]) {
  w.localStorage.clear();
  w.localStorage.setItem("rjaf.user", JSON.stringify({
    username: "ops", displayName: "Ops Pilot", role: "ops",
  }));
  w.localStorage.setItem("rjaf.licensed", "1");
  w.localStorage.setItem("rjaf.squadron", JSON.stringify({
    name: "NO.8", number: "NO.8", base: "MAFRAQ",
  }));
  w.localStorage.setItem("rjaf.setupWizard.NO.8.complete", "1");
  w.localStorage.setItem(MOCK_PILOTS_KEY, JSON.stringify([minimalPilot()]));
  w.localStorage.setItem(MOCK_SORTIES_KEY, "[]");
  w.localStorage.setItem(PENDING_KEY, JSON.stringify(pendingRows));
}

function readPendingRaw(): Record<string, unknown>[] {
  try {
    const raw = w.localStorage.getItem(PENDING_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

function readSortiesLen(): number {
  try {
    const raw = w.localStorage.getItem(MOCK_SORTIES_KEY);
    if (!raw) return 0;
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.length : 0;
  } catch {
    return 0;
  }
}

function pendingRow(
  id: string,
  opts: { guestMil: string; guestName?: string },
): Record<string, unknown> {
  const guestPilotName = opts.guestName ?? "Guest Match Pilot";
  return {
    id,
    hostingSquadronId: "OTHER",
    hostingSquadronName: "OTHER SQN",
    homeSquadronId: "NO.8",
    homeSquadronName: "NO.8",
    guestPilotName,
    guestPilotMilitaryNumber: opts.guestMil,
    guestSeat: "pilot",
    sortie: minimalSortie({ pilotId: "", coPilotId: "cp-local" }),
    submittedAt: new Date().toISOString(),
    submittedBy: "host.ops",
    status: "pending",
  };
}

test("Pending Approvals · Accept / Reject / Drop (offline)", async () => {
  const idAccept = "pend-accept-1";
  const idReject = "pend-reject-1";
  const idDrop = "pend-drop-1";

  seedSessionAndData([
    pendingRow(idAccept, { guestMil: "552" }),
    pendingRow(idReject, { guestMil: "99999", guestName: "Nobody Roster" }),
    pendingRow(idDrop, { guestMil: "552" }),
  ]);

  const React = (await import("react")).default;
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { Router } = await import("wouter");
  const { memoryLocation } = await import("wouter/memory-location");
  const { I18nProvider } = await import("../src/lib/i18n.tsx");
  const { AuthProvider } = await import("../src/lib/auth.tsx");
  const { default: PendingApprovals } = await import("../src/pages/PendingApprovals.tsx");

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { hook } = memoryLocation({ path: "/pending", static: true });
  const el = w.document.createElement("div");
  w.document.body.appendChild(el);
  const root = createRoot(el);

  const tree = React.createElement(
    QueryClientProvider, { client: qc },
    React.createElement(I18nProvider, null,
      React.createElement(AuthProvider, null,
        React.createElement(
          Router as unknown as React.ComponentType<{
            hook: unknown;
            children?: React.ReactNode;
          }>,
          { hook, children: React.createElement(PendingApprovals) },
        ),
      ),
    ),
  );

  await act(async () => {
    root.render(tree);
  });

  const flush = async (ms = 80) => {
    await act(async () => {
      await new Promise<void>(r => setTimeout(r, ms));
    });
  };

  /** Prefer native `.click()` so React + jsdom see a consistent event. */
  function uiClick(target: Element) {
    (target as HTMLButtonElement | HTMLElement).click();
  }

  async function waitForCard(id: string, timeoutMs = 4000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const hit = el.querySelector(`[data-testid="pending-${id}"]`);
      if (hit) return;
      await flush(30);
    }
    const snippet = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 900);
    throw new Error(`timeout waiting for pending-${id}. Body snippet: ${snippet}`);
  }

  const expand = async (id: string) => {
    await waitForCard(id);
    const card = el.querySelector(`[data-testid="pending-${id}"]`);
    assert.ok(card, `card pending-${id}`);
    const rowBtn = card!.querySelector("button");
    assert.ok(rowBtn, "expand row button");
    await act(async () => {
      uiClick(rowBtn!);
    });
    await flush();
  };

  // ── Accept (military number matches roster pilot 552) ─────────────
  await expand(idAccept);
  const acceptBtn = el.querySelector(`[data-testid="accept-${idAccept}"]`) as HTMLButtonElement | null;
  assert.ok(acceptBtn && !acceptBtn.disabled, "Accept visible");
  await act(async () => {
    uiClick(acceptBtn!);
  });
  await flush(200);
  const sortiesAfterAccept = readSortiesLen();
  assert.ok(sortiesAfterAccept >= 1, "sortie cascaded to local store");
  const afterAccept = readPendingRaw().find(r => r.id === idAccept) as { status?: string } | undefined;
  assert.equal(afterAccept?.status, "accepted");

  // ── Reject (manual pick + reason) ───────────────────────────────────
  await expand(idReject);
  const pick = el.querySelector(`[data-testid="pilot-pick-${idReject}"]`) as HTMLSelectElement | null;
  assert.ok(pick, "pilot pick for reject row");
  await act(async () => {
    pick!.value = "p-guest-1";
    const ev = pick!.ownerDocument.createEvent("HTMLEvents");
    ev.initEvent("change", true, false);
    pick!.dispatchEvent(ev);
  });
  await flush();
  const rejectOpen = el.querySelector(`[data-testid="reject-${idReject}"]`) as HTMLButtonElement | null;
  assert.ok(rejectOpen, "Reject button");
  await act(async () => {
    uiClick(rejectOpen!);
  });
  await flush();
  const ta = el.querySelector(`[data-testid="reason-${idReject}"]`) as HTMLTextAreaElement | null;
  assert.ok(ta, "reason textarea");
  const proto = window.HTMLTextAreaElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  assert.ok(desc?.set, "textarea value setter");
  await act(async () => {
    desc!.set!.call(ta, "duplicate flight");
    const ev = ta!.ownerDocument.createEvent("HTMLEvents");
    ev.initEvent("input", true, false);
    ta!.dispatchEvent(ev);
  });
  await flush();
  const sendRej = [...el.querySelectorAll("button")].find(b => b.textContent?.includes("Send rejection"));
  assert.ok(sendRej, "Send rejection");
  await act(async () => {
    uiClick(sendRej!);
  });
  await flush(200);
  const afterReject = readPendingRaw().find(r => r.id === idReject) as { status?: string; decisionReason?: string } | undefined;
  assert.equal(afterReject?.status, "rejected");

  // ── Drop ────────────────────────────────────────────────────────────
  await expand(idDrop);
  const dropBtn = [...el.querySelectorAll("button")].find(b => b.textContent?.includes("Drop"));
  assert.ok(dropBtn, "Drop");
  await act(async () => {
    uiClick(dropBtn!);
  });
  await flush(200);
  const afterDrop = readPendingRaw().find(r => r.id === idDrop) as { status?: string } | undefined;
  assert.equal(afterDrop?.status, "deleted");

  await act(async () => {
    root.unmount();
  });
  try { (dom.window as unknown as { close?: () => void }).close?.(); }
  catch { /* ignore */ }
});
