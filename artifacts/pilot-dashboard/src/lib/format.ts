import type { CurrencyStatus, Pilot } from "./types";

export function currencyStatus(dateStr: string): CurrencyStatus {
  // A missing or unparseable date means the commander has never entered a
  // currency for this discipline. Treat it as a distinct "not set" state so
  // the UI shows a neutral grey badge instead of falsely reporting the
  // pilot as current.
  if (!dateStr || !dateStr.trim()) return "unset";
  const target = new Date(dateStr).getTime();
  if (!Number.isFinite(target)) return "unset";
  const now = Date.now();
  const diffDays = Math.floor((target - now) / 86400000);
  if (diffDays < 0) return "expired";
  if (diffDays < 5) return "critical";
  if (diffDays < 10) return "expiringSoon";
  if (diffDays <= 15) return "warning";
  return "current";
}

export function statusClass(s: CurrencyStatus): string {
  if (s === "expired" || s === "critical") return "currency-expired";
  if (s === "warning" || s === "expiringSoon") return "currency-warning";
  if (s === "unset") return "currency-unset";
  return "currency-current";
}

export function isRedStatus(s: CurrencyStatus): boolean {
  return s === "expired" || s === "critical";
}

export function isYellowStatus(s: CurrencyStatus): boolean {
  return s === "warning" || s === "expiringSoon";
}

// "unset" sits just above "current" so a pilot with one blank field is
// surfaced above a fully-current pilot, but below any real warning/expiry.
const rank: Record<CurrencyStatus, number> = {
  current: 0,
  unset: 1,
  warning: 2,
  expiringSoon: 3,
  critical: 4,
  expired: 5,
};

export function pilotWorstStatus(p: Pilot): CurrencyStatus {
  const all: CurrencyStatus[] = [
    currencyStatus(p.dayCurrencyDate),
    currencyStatus(p.nightCurrencyDate),
    currencyStatus(p.nvgCurrencyDate ?? ""),
    currencyStatus(p.irtCurrencyDate),
    currencyStatus(p.medicalCurrencyDate),
  ];
  return all.reduce((worst, s) => (rank[s] > rank[worst] ? s : worst), "current" as CurrencyStatus);
}

// Returns the date string of the currency that drives the pilot's worst status.
// Used so badges can show "Expiring Soon · 23 Apr" rather than a bare label.
export function pilotWorstDate(p: Pilot): string | null {
  const entries: { status: CurrencyStatus; date: string }[] = [
    { status: currencyStatus(p.dayCurrencyDate), date: p.dayCurrencyDate },
    { status: currencyStatus(p.nightCurrencyDate), date: p.nightCurrencyDate },
    { status: currencyStatus(p.nvgCurrencyDate ?? ""), date: p.nvgCurrencyDate ?? "" },
    { status: currencyStatus(p.irtCurrencyDate), date: p.irtCurrencyDate },
    { status: currencyStatus(p.medicalCurrencyDate), date: p.medicalCurrencyDate },
  ];
  let best: { status: CurrencyStatus; date: string } | null = null;
  for (const e of entries) {
    if (!best || rank[e.status] > rank[best.status]) best = e;
  }
  // Only surface a date for real expiry states — "current" has no
  // interesting date, and "unset" has no date at all.
  if (!best || best.status === "current" || best.status === "unset") return null;
  return best.date;
}

// ─── Date formatting ─────────────────────────────────────────────
// The squadron / RJAF standard for every printed surface and on-screen
// date display is **DD-MM-YYYY** (e.g. 18-04-2026). Centralising it
// here means one change here flows everywhere that imports `fmtDate`.
function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }

function toDate(d: string | Date | number | null | undefined): Date | null {
  if (d == null || d === "") return null;
  const v = d instanceof Date ? d : new Date(d);
  return isNaN(v.getTime()) ? null : v;
}

// DD-MM-YYYY — the canonical squadron / PDF / print date format.
export function fmtDDMMYYYY(d: string | Date | number | null | undefined): string {
  const v = toDate(d);
  if (!v) return "—";
  return `${pad2(v.getDate())}-${pad2(v.getMonth() + 1)}-${v.getFullYear()}`;
}

// DD-MM (year omitted) — used for compact badges and calendar headers.
export function fmtDDMM(d: string | Date | number | null | undefined): string {
  const v = toDate(d);
  if (!v) return "—";
  return `${pad2(v.getDate())}-${pad2(v.getMonth() + 1)}`;
}

// DD-MM-YYYY HH:mm — for audit log / message timestamps.
export function fmtDateTimeDDMM(d: string | Date | number | null | undefined): string {
  const v = toDate(d);
  if (!v) return "—";
  return `${fmtDDMMYYYY(v)} ${pad2(v.getHours())}:${pad2(v.getMinutes())}`;
}

// Month-Year header (e.g. "APR 2026" / "نيسان 2026").
export function fmtMonthYear(period: string | Date, lang: string = "en"): string {
  let d: Date;
  if (typeof period === "string" && /^\d{4}-\d{2}$/.test(period)) {
    const [y, m] = period.split("-").map(Number);
    d = new Date(y, m - 1, 1);
  } else {
    d = period instanceof Date ? period : new Date(period);
  }
  if (isNaN(d.getTime())) return String(period);
  return d.toLocaleDateString(lang === "ar" ? "ar-EG" : "en-GB", {
    year: "numeric", month: "short",
  }).toUpperCase();
}

// Backwards-compatible aliases — every caller that used to render a
// short-month date now gets DD-MM-YYYY without further changes.
export function fmtDate(d: string, _lang?: string): string { return fmtDDMMYYYY(d); }
export function fmtDateTime(d: string, _lang?: string): string { return fmtDateTimeDDMM(d); }
