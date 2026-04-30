import { PILOTS, SORTIES, type Sortie, type Pilot } from "./mock";

const STORAGE_PREFIX = "rjaf.archive.";
const LAST_RUN_KEY = "rjaf.archive.lastRun";

export type MonthKey = string;
export type YearKey = string;

export interface MonthArchive {
  kind: "month";
  period: MonthKey;
  createdAt: string;
  pilots: Pilot[];
  sorties: Sortie[];
  totals: { sortieCount: number; pilotCount: number; flightHours: number };
}

export interface YearArchive {
  kind: "year";
  period: YearKey;
  createdAt: string;
  months: MonthKey[];
  pilots: Pilot[];
  sorties: Sortie[];
  totals: { sortieCount: number; pilotCount: number; flightHours: number };
}

export type ArchiveEntry = MonthArchive | YearArchive;

function pad2(n: number) { return n < 10 ? `0${n}` : `${n}`; }
function ymKey(d: Date): MonthKey { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; }
function yKey(d: Date): YearKey { return `${d.getFullYear()}`; }

function monthsBetween(start: Date, endExclusive: Date): MonthKey[] {
  const out: MonthKey[] = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur < endExclusive) {
    out.push(ymKey(cur));
    cur.setMonth(cur.getMonth() + 1);
  }
  return out;
}

function totalsOf(sorties: Sortie[]) {
  const flightHours = sorties.reduce((acc, s) =>
    acc + (s.day1 || 0) + (s.day2 || 0) + (s.dayDual || 0)
        + (s.night1 || 0) + (s.night2 || 0) + (s.nightDual || 0), 0);
  const pilotCount = new Set(sorties.flatMap(s => [s.pilotId, s.coPilotId].filter(Boolean))).size;
  return { sortieCount: sorties.length, pilotCount, flightHours: Math.round(flightHours * 10) / 10 };
}

function snapshotMonth(period: MonthKey): MonthArchive {
  const sorties = SORTIES.filter(s => (s.date || "").startsWith(period));
  const pilotIds = new Set(sorties.flatMap(s => [s.pilotId, s.coPilotId].filter(Boolean)));
  const pilots = PILOTS.filter(p => pilotIds.has(p.id));
  return {
    kind: "month",
    period,
    createdAt: new Date().toISOString(),
    pilots: structuredClone(pilots),
    sorties: structuredClone(sorties),
    totals: totalsOf(sorties),
  };
}

function snapshotYear(year: YearKey, monthArchives: MonthArchive[]): YearArchive {
  const sorties = monthArchives.flatMap(m => m.sorties);
  const pilotMap = new Map<string, Pilot>();
  for (const m of monthArchives) for (const p of m.pilots) pilotMap.set(p.id, p);
  return {
    kind: "year",
    period: year,
    createdAt: new Date().toISOString(),
    months: monthArchives.map(m => m.period),
    pilots: Array.from(pilotMap.values()),
    sorties,
    totals: totalsOf(sorties),
  };
}

function readArchive<T extends ArchiveEntry>(period: string): T | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + period);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch { return null; }
}

function writeArchive(period: string, value: ArchiveEntry): void {
  try { localStorage.setItem(STORAGE_PREFIX + period, JSON.stringify(value)); } catch { /* quota */ }
}

export interface ArchiveRunResult {
  createdMonths: MonthKey[];
  createdYears: YearKey[];
}

/**
 * Idempotent monthly/yearly archive sweep.
 * Safe to call on every app boot — if no new completed month exists, returns empty arrays.
 *
 *  - Archives every completed month between the last run and now into `rjaf.archive.YYYY-MM`.
 *  - When all 12 months of a calendar year are present, also writes `rjaf.archive.YYYY`.
 */
export function runArchiveCheck(now: Date = new Date()): ArchiveRunResult {
  const created: ArchiveRunResult = { createdMonths: [], createdYears: [] };
  const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // Determine starting cursor
  const lastRun = localStorage.getItem(LAST_RUN_KEY);
  let cursor: Date;
  if (lastRun) {
    const [y, m] = lastRun.split("-").map(Number);
    cursor = new Date(y, m, 1); // first of the month AFTER last archived
  } else {
    // First boot ever: archive only the most recently completed month (if any data exists for it).
    cursor = new Date(firstOfThisMonth);
    cursor.setMonth(cursor.getMonth() - 1);
  }
  if (cursor >= firstOfThisMonth) return created;

  const targets = monthsBetween(cursor, firstOfThisMonth);
  for (const period of targets) {
    if (readArchive<MonthArchive>(period)) continue;
    const snap = snapshotMonth(period);
    if (snap.sorties.length === 0 && snap.pilots.length === 0) continue;
    writeArchive(period, snap);
    created.createdMonths.push(period);
  }

  // After writing months, check whether any complete year is now archivable.
  const yearsToCheck = new Set(targets.map(t => t.slice(0, 4)));
  for (const year of yearsToCheck) {
    if (readArchive<YearArchive>(year)) continue;
    const monthKeys = Array.from({ length: 12 }, (_, i) => `${year}-${pad2(i + 1)}`);
    const months = monthKeys.map(k => readArchive<MonthArchive>(k)).filter((x): x is MonthArchive => !!x);
    if (months.length === 12) {
      writeArchive(year, snapshotYear(year, months));
      created.createdYears.push(year);
    }
  }

  // Advance cursor to the most recent completed month.
  const last = targets[targets.length - 1];
  if (last) localStorage.setItem(LAST_RUN_KEY, last);
  return created;
}

export interface ArchiveListItem {
  key: string;
  kind: "month" | "year";
  period: string;
  createdAt: string;
  totals: { sortieCount: number; pilotCount: number; flightHours: number };
}

export function listArchives(): ArchiveListItem[] {
  const out: ArchiveListItem[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(STORAGE_PREFIX) || k === LAST_RUN_KEY) continue;
    const period = k.slice(STORAGE_PREFIX.length);
    try {
      const v = JSON.parse(localStorage.getItem(k) || "") as ArchiveEntry;
      out.push({ key: k, kind: v.kind, period, createdAt: v.createdAt, totals: v.totals });
    } catch { /* ignore */ }
  }
  // Years first, then months, both descending
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "year" ? -1 : 1;
    return b.period.localeCompare(a.period);
  });
  return out;
}

export function getArchive(period: string): ArchiveEntry | null {
  return readArchive(period);
}

/** Persist an edited archive snapshot. Recomputes totals before writing. */
export function saveArchive(period: string, value: ArchiveEntry): void {
  const next: ArchiveEntry = { ...value, totals: totalsOf(value.sorties) };
  writeArchive(period, next);
}

export function deleteArchive(period: string): void {
  try { localStorage.removeItem(STORAGE_PREFIX + period); } catch { /* noop */ }
}

export function downloadArchive(period: string): void {
  const data = readArchive(period);
  if (!data) return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `rjaf-archive-${period}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Test/dev helper: clears the cursor so the next call re-evaluates from scratch. */
export function _resetArchiveCursorForDev(): void {
  localStorage.removeItem(LAST_RUN_KEY);
}
