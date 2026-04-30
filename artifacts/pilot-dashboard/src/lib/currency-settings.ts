// Per-squadron currency window overrides. The ops officer can change the
// refresh window (default 60 days) for Day and NVG/Night currencies so the
// auto-bump on sortie save matches local SOP. Stored in localStorage so it
// survives reloads on the same desktop client.

import { useEffect, useState } from "react";

export interface CurrencyWindow {
  day: number;
  // v1.1.69 — Night and NVG are fully independent currencies, each with
  // its own refresh window. Previously the interface omitted `night` so
  // TS silently allowed cross-aliasing in setters.
  night: number;
  nvg: number;
  instrument: number;
  medical: number;
}

// Defaults per RJAF UH-60M SOP (April 2026 brief): Day/Night/NVG = 30 days,
// Instrument (IRT) = 365 days, Medical = 365 days. Editable per squadron.
export const DEFAULT_CURRENCY_WINDOW: CurrencyWindow = {
  day: 30,
  night: 30,
  nvg: 30,
  instrument: 365,
  medical: 365,
};
const LS_KEY = "rjaf_currency_window_v2";
const LEGACY_KEY = "rjaf_currency_window_v1";

function clamp(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  // Medical can run up to ~3 years (1095 days) so widen the upper bound.
  return Math.max(1, Math.min(1095, Math.round(n)));
}

export function getCurrencyWindow(): CurrencyWindow {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_CURRENCY_WINDOW };
    const p = JSON.parse(raw) as Partial<CurrencyWindow>;
    return {
      day: clamp(Number(p.day ?? DEFAULT_CURRENCY_WINDOW.day), DEFAULT_CURRENCY_WINDOW.day),
      // v1.1.69 — Night and NVG are independent. Do NOT cross-fall-back
      // between them, even for legacy migration: a squadron whose old
      // settings only stored `nvg` will simply pick up the 30-day Night
      // default rather than silently inheriting the NVG window.
      night: clamp(Number(p.night ?? DEFAULT_CURRENCY_WINDOW.night), DEFAULT_CURRENCY_WINDOW.night),
      nvg: clamp(Number(p.nvg ?? DEFAULT_CURRENCY_WINDOW.nvg), DEFAULT_CURRENCY_WINDOW.nvg),
      instrument: clamp(Number(p.instrument ?? DEFAULT_CURRENCY_WINDOW.instrument), DEFAULT_CURRENCY_WINDOW.instrument),
      medical: clamp(Number(p.medical ?? DEFAULT_CURRENCY_WINDOW.medical), DEFAULT_CURRENCY_WINDOW.medical),
    };
  } catch {
    return { ...DEFAULT_CURRENCY_WINDOW };
  }
}

export function setCurrencyWindow(w: CurrencyWindow): void {
  const next: CurrencyWindow = {
    day: clamp(w.day, DEFAULT_CURRENCY_WINDOW.day),
    night: clamp(w.night, DEFAULT_CURRENCY_WINDOW.night),
    nvg: clamp(w.nvg, DEFAULT_CURRENCY_WINDOW.nvg),
    instrument: clamp(w.instrument, DEFAULT_CURRENCY_WINDOW.instrument),
    medical: clamp(w.medical, DEFAULT_CURRENCY_WINDOW.medical),
  };
  localStorage.setItem(LS_KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent("rjaf:currency-window", { detail: next }));
}

export function useCurrencyWindow(): [CurrencyWindow, (w: CurrencyWindow) => void] {
  const [w, setW] = useState<CurrencyWindow>(() => getCurrencyWindow());
  useEffect(() => {
    const onChange = () => setW(getCurrencyWindow());
    window.addEventListener("rjaf:currency-window", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("rjaf:currency-window", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return [w, (next) => { setCurrencyWindow(next); setW(next); }];
}
