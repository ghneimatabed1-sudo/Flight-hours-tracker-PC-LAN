import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { startOutboxWorker } from "./lib/offlineQueue";
import { reportRuntimeError } from "./lib/runtimeErrorReporter";

// Visible diagnostic overlay shown if anything synchronous below throws or
// if the bundle errors during evaluation. Without this the user sees a
// pure black window and has no way to know what went wrong.
function showFatal(err: unknown): void {
  const target = document.getElementById("root") ?? document.body;
  const msg = err instanceof Error ? `${err.name}: ${err.message}\n\n${err.stack ?? ""}` : String(err);

  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0a1226;color:#e6c97a;font-family:Inter,system-ui,sans-serif;padding:32px;text-align:center;";

  const inner = document.createElement("div");
  inner.style.cssText = "max-width:760px;";

  const title = document.createElement("div");
  title.style.cssText = "font-size:14px;letter-spacing:0.32em;text-transform:uppercase;color:#e6c97a;opacity:0.85;margin-bottom:16px;";
  title.textContent = "Hawk Eye — startup error";

  const pre = document.createElement("div");
  pre.style.cssText = "font-size:13px;line-height:1.6;color:#e6e6e6;background:rgba(255,255,255,0.04);border:1px solid rgba(230,201,122,0.25);border-radius:8px;padding:18px;text-align:left;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;max-height:60vh;overflow:auto;";
  pre.textContent = msg;

  const hint = document.createElement("div");
  hint.style.cssText = "font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-top:18px;";
  hint.textContent = "Press Ctrl+Shift+I for DevTools · Send this screen to Super Admin";

  inner.appendChild(title);
  inner.appendChild(pre);
  inner.appendChild(hint);
  overlay.appendChild(inner);

  target.replaceChildren(overlay);
}

// Discrete bottom-right toast for post-mount runtime errors that aren't
// caught by React's ErrorBoundary (async callbacks, event handlers,
// promise rejections, etc.). Auto-dismisses after 10s. The user can
// click it to copy the message — useful when reporting a bug.
function showPostMountError(err: unknown): void {
  try {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    // De-dup back-to-back identical errors within 2s
    const w = window as unknown as { __lastErrMsg?: string; __lastErrAt?: number };
    if (w.__lastErrMsg === msg && Date.now() - (w.__lastErrAt ?? 0) < 2000) return;
    w.__lastErrMsg = msg; w.__lastErrAt = Date.now();
    let host = document.getElementById("__hawkeye_err_toast");
    if (!host) {
      host = document.createElement("div");
      host.id = "__hawkeye_err_toast";
      host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:99999;display:flex;flex-direction:column;gap:8px;max-width:420px;pointer-events:none;font-family:Inter,system-ui,sans-serif;";
      document.body.appendChild(host);
    }
    const card = document.createElement("div");
    card.style.cssText = "background:#1a1410;border:1px solid rgba(245,158,11,0.5);color:#fbbf24;padding:10px 12px;border-radius:8px;font-size:12px;line-height:1.4;box-shadow:0 8px 24px rgba(0,0,0,0.5);pointer-events:auto;cursor:pointer;";
    card.title = "Click to copy error";
    card.textContent = `⚠ ${msg.slice(0, 200)}`;
    card.onclick = () => {
      try { navigator.clipboard.writeText(msg); card.style.opacity = "0.5"; } catch { /* ignore */ }
    };
    host.appendChild(card);
    setTimeout(() => { card.style.transition = "opacity .4s"; card.style.opacity = "0"; setTimeout(() => card.remove(), 400); }, 10000);
  } catch { /* never let the error reporter itself throw */ }
}

window.addEventListener("error", (e) => {
  const root = document.getElementById("root");
  // Pre-mount: full-screen fatal overlay (the bundle itself failed).
  if (root && root.children.length === 0) { showFatal(e.error ?? e.message); return; }
  // Post-mount: discrete toast so the user knows something went wrong
  // even if the page itself didn't unmount.
  showPostMountError(e.error ?? e.message);
  // Task #265 Part F — fire-and-forget POST to public.runtime_errors
  // so super_admin can see crashes from the Audit Log page even when
  // no operator manually walks the screen.
  reportRuntimeError(e.error ?? e.message, { source: "window.error" });
});
window.addEventListener("unhandledrejection", (e) => {
  const root = document.getElementById("root");
  if (root && root.children.length === 0) { showFatal(e.reason); return; }
  showPostMountError(e.reason);
  reportRuntimeError(e.reason, { source: "unhandledrejection" });
});

// ─────────────────────────────────────────────────────────────────────
// Input-freeze guard. Radix UI portals (Select, Popover, Dialog,
// Combobox) occasionally leave `pointer-events: none` set as an inline
// style on <body> or <html> after they close. When that happens every
// input on the page stops accepting clicks/keystrokes until the
// Electron window is minimised and restored. We use a MutationObserver
// to strip the offending inline style the moment it appears so the
// freeze is invisible to the operator.
// ─────────────────────────────────────────────────────────────────────
function installPointerEventsGuard(): void {
  const fix = (el: HTMLElement | null) => {
    if (!el) return;
    if (el.style.pointerEvents === "none") {
      el.style.pointerEvents = "";
    }
  };
  fix(document.body);
  fix(document.documentElement);
  const obs = new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === "attributes" && m.attributeName === "style") {
        fix(m.target as HTMLElement);
      }
    }
  });
  obs.observe(document.body, { attributes: true, attributeFilter: ["style"] });
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
}

try {
  // The outbox worker is best-effort — never let it block React mounting.
  try { startOutboxWorker(); } catch (e) { console.warn("outbox worker failed:", e); }
  try { installPointerEventsGuard(); } catch (e) { console.warn("pointer-events guard failed:", e); }
  createRoot(document.getElementById("root")!).render(<App />);
} catch (err) {
  showFatal(err);
}
