import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const w = dom.window as unknown as Window & typeof globalThis;
function setG(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}
setG("window", w);
setG("screen", w.screen);
setG("document", w.document);
setG("navigator", w.navigator);
setG("localStorage", w.localStorage);
setG("sessionStorage", w.sessionStorage);
setG("HTMLElement", w.HTMLElement);
setG("Element", w.Element);
setG("Node", w.Node);
setG("Event", w.Event);
setG("MouseEvent", w.MouseEvent);
setG("getComputedStyle", w.getComputedStyle.bind(w));
setG("requestAnimationFrame", (cb: FrameRequestCallback) => Number(setTimeout(() => cb(performance.now()), 16)));
setG("cancelAnimationFrame", (id: number) => clearTimeout(id));
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
setG("IntersectionObserver", NoopObserver);
setG("ResizeObserver", NoopObserver);
setG("MutationObserver", w.MutationObserver);
setG("matchMedia", () => ({
  matches: false,
  media: "",
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
}));
(w as unknown as Record<string, unknown>).scrollTo = () => {};
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { Router } = await import("wouter");
const { memoryLocation } = await import("wouter/memory-location");
const { I18nProvider } = await import("../src/lib/i18n.tsx");
const { AuthProvider } = await import("../src/lib/auth.tsx");
const AddSortie = (await import("../src/pages/AddSortie.tsx")).default;

test("add sortie form remains editable without aircraft defaults", async () => {
  localStorage.clear();
  localStorage.setItem(
    "rjaf.user",
    JSON.stringify({ username: "ops", displayName: "Ops Pilot", role: "ops" }),
  );
  localStorage.setItem("rjaf.licensed", "1");
  localStorage.setItem(
    "rjaf.squadron",
    JSON.stringify({ name: "NO.8", number: "NO.8", base: "MAFRAQ" }),
  );
  localStorage.setItem("rjaf.setupWizard.NO.8.complete", "1");

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { hook } = memoryLocation({ path: "/sortie-add", static: true });
  const host = document.getElementById("root");
  assert.ok(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(
          I18nProvider,
          null,
          React.createElement(
            AuthProvider,
            null,
            React.createElement(
              Router as unknown as React.ComponentType<{ hook: unknown; children?: React.ReactNode }>,
              { hook, children: React.createElement(AddSortie) },
            ),
          ),
        ),
      ),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  const acTypeInput = host.querySelector('input[placeholder="e.g. UH-60M"]') as HTMLInputElement | null;
  assert.ok(acTypeInput, "manual A/C Type input should be visible when defaults are empty");
  assert.equal(acTypeInput.disabled, false, "manual A/C Type input should stay editable");

  const submitBtn = host.querySelector('[data-testid="button-submit-sortie"]') as HTMLButtonElement | null;
  assert.ok(submitBtn, "submit button should exist");
  assert.equal(submitBtn.disabled, false, "submit button should not be frozen by empty defaults");

  await act(async () => {
    root.unmount();
  });
});

test("add sortie submit path stays interactive with manual A/C type", async () => {
  localStorage.clear();
  localStorage.setItem(
    "rjaf.user",
    JSON.stringify({ username: "ops", displayName: "Ops Pilot", role: "ops" }),
  );
  localStorage.setItem("rjaf.licensed", "1");
  localStorage.setItem(
    "rjaf.squadron",
    JSON.stringify({ name: "NO.8", number: "NO.8", base: "MAFRAQ" }),
  );
  localStorage.setItem("rjaf.setupWizard.NO.8.complete", "1");

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { hook } = memoryLocation({ path: "/sortie-add", static: true });
  const host = document.getElementById("root");
  assert.ok(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(
          I18nProvider,
          null,
          React.createElement(
            AuthProvider,
            null,
            React.createElement(
              Router as unknown as React.ComponentType<{ hook: unknown; children?: React.ReactNode }>,
              { hook, children: React.createElement(AddSortie) },
            ),
          ),
        ),
      ),
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 80));
  });

  const acTypeInput = host.querySelector('input[placeholder="e.g. UH-60M"]') as HTMLInputElement | null;
  assert.ok(acTypeInput, "manual A/C type input should be available");
  await act(async () => {
    acTypeInput.value = "UH-60M";
    acTypeInput.dispatchEvent(new Event("input", { bubbles: true }));
    acTypeInput.dispatchEvent(new Event("change", { bubbles: true }));
  });

  const acNoInput = host.querySelector('input[placeholder="e.g. 832"]') as HTMLInputElement | null;
  assert.ok(acNoInput, "A/C number input should exist");
  await act(async () => {
    acNoInput.value = "999";
    acNoInput.dispatchEvent(new Event("input", { bubbles: true }));
    acNoInput.dispatchEvent(new Event("change", { bubbles: true }));
  });

  const numberInputs = Array.from(host.querySelectorAll('input[type="number"]')) as HTMLInputElement[];
  assert.ok(numberInputs.length > 0, "number inputs should exist");
  await act(async () => {
    numberInputs[0]!.value = "1.0";
    numberInputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
    numberInputs[0]!.dispatchEvent(new Event("change", { bubbles: true }));
  });

  const pilotSelect = host.querySelector('[data-testid="select-pilot"]') as HTMLSelectElement | null;
  const coPilotSelect = host.querySelector('[data-testid="select-copilot"]') as HTMLSelectElement | null;
  assert.ok(pilotSelect, "pilot select should exist");
  assert.ok(coPilotSelect, "co-pilot select should exist");
  const pilotOption = pilotSelect.options[0]?.value ?? "";
  const coPilotOption = coPilotSelect.options[1]?.value ?? coPilotSelect.options[0]?.value ?? "";
  await act(async () => {
    pilotSelect.value = pilotOption;
    pilotSelect.dispatchEvent(new Event("change", { bubbles: true }));
    coPilotSelect.value = coPilotOption;
    coPilotSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });

  const submitBtn = host.querySelector('[data-testid="button-submit-sortie"]') as HTMLButtonElement | null;
  assert.ok(submitBtn, "submit button should exist");
  await act(async () => {
    submitBtn.click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 120));
  });

  assert.equal(acTypeInput.disabled, false, "manual A/C type input should remain editable after submit click");
  assert.equal(submitBtn.disabled, false, "submit should remain interactive (not frozen) after click");

  await act(async () => {
    root.unmount();
  });
});

test("add sortie form availability teardown", () => {
  try {
    (dom.window as unknown as { close?: () => void }).close?.();
  } catch {
    // ignore
  }
});
