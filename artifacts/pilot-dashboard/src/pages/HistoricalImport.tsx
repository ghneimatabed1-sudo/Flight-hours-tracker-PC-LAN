import { useMemo, useRef, useState } from "react";
import ExcelJS from "exceljs";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { useImportHistory, useUndoLastImport, getLastImportStamp, type Pilot, type Sortie } from "@/lib/squadron-data";
import { Upload, FileText, AlertCircle, CheckCircle2, X, Undo2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { fmtDateTimeDDMM } from "@/lib/format";

type RowError = { row: number; reason: string };
type Parsed<T> = { rows: T[]; errors: RowError[]; rawCount: number };

// ── CSV parsing ────────────────────────────────────────────────────────
// Minimal RFC4180-ish parser: handles quoted fields with embedded commas
// and doubled quotes. Good enough for the legacy SqDn App 21.10.16 export
// which is plain CSV with optional quoting.
function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { cur.push(field); field = ""; }
      else if (c === "\r") { /* skip */ }
      else if (c === "\n") { cur.push(field); out.push(cur); cur = []; field = ""; }
      else field += c;
    }
  }
  if (field.length > 0 || cur.length > 0) { cur.push(field); out.push(cur); }
  return out.filter(r => r.length > 1 || (r.length === 1 && r[0].trim().length > 0));
}

function toRecords(text: string): Record<string, string>[] {
  const grid = parseCsv(text);
  if (grid.length === 0) return [];
  const headers = grid[0].map(h => h.trim());
  return grid.slice(1).map(row => {
    const o: Record<string, string> = {};
    headers.forEach((h, i) => { o[h] = (row[i] ?? "").trim(); });
    return o;
  });
}

const num = (v: string | undefined, def = 0): number => {
  if (v === undefined || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};
const bool = (v: string | undefined, def = true): boolean => {
  if (v === undefined || v === "") return def;
  return /^(1|true|yes|y)$/i.test(v.trim());
};
const isDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v);

const PILOT_REQUIRED = ["id", "name", "rank"];
const SORTIE_REQUIRED = ["id", "date", "pilotId", "acType"];

async function xlsxToRecords(file: File): Promise<Record<string, string>[]> {
  // Drop-in replacement for the CSV path: read the first worksheet,
  // treat row 1 as the header row, and produce the same shape of
  // Record<string,string> the CSV parser yields. Empty trailing rows
  // (common in Excel) are skipped so the row counter doesn't lie.
  const buf = await file.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headers: string[] = [];
  const headerRow = ws.getRow(1);
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] = String(cell.value ?? "").trim();
  });
  const out: Record<string, string>[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum === 1) return;
    const rec: Record<string, string> = {};
    let hasAny = false;
    headers.forEach((h, i) => {
      if (!h) return;
      const v = row.getCell(i + 1).value;
      let s = "";
      if (v == null) s = "";
      else if (v instanceof Date) {
        const p = (n: number) => String(n).padStart(2, "0");
        s = `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
      } else if (typeof v === "object" && "text" in (v as object)) {
        s = String((v as { text: unknown }).text ?? "");
      } else if (typeof v === "object" && "result" in (v as object)) {
        s = String((v as { result: unknown }).result ?? "");
      } else {
        s = String(v);
      }
      s = s.trim();
      if (s) hasAny = true;
      rec[h] = s;
    });
    if (hasAny) out.push(rec);
  });
  return out;
}

function parsePilotsFromRecords(recs: Record<string, string>[]): Parsed<Pilot> {
  const errors: RowError[] = [];
  const rows: Pilot[] = [];
  recs.forEach((r, i) => {
    const rowNum = i + 2; // +1 for header, +1 for 1-indexed
    const missing = PILOT_REQUIRED.filter(k => !r[k]);
    if (missing.length) {
      errors.push({ row: rowNum, reason: `Missing required column(s): ${missing.join(", ")}` });
      return;
    }
    const unitVal = (r.unit || "SQDN") as Pilot["unit"];
    const allowed: Pilot["unit"][] = ["SQDN", "HQ Attached", "Other", "UH-60M", "UH-60AIL", "Both", "RCN"];
    if (!allowed.includes(unitVal)) {
      errors.push({ row: rowNum, reason: `Invalid unit "${unitVal}"` });
      return;
    }
    rows.push({
      id: r.id,
      name: r.name,
      arabicName: r.arabicName ?? "",
      rank: r.rank,
      phone: r.phone ?? "",
      address: r.address ?? "",
      unit: unitVal,
      openingDay: num(r.openingDay),
      openingNight: num(r.openingNight),
      openingNvg: num(r.openingNvg),
      doctorNote: r.doctorNote || undefined,
      monthDay: num(r.monthDay),
      monthNight: num(r.monthNight),
      monthNvg: num(r.monthNvg),
      monthSim: num(r.monthSim),
      monthCaptain: num(r.monthCaptain),
      totalDay: num(r.totalDay),
      totalNight: num(r.totalNight),
      totalNvg: num(r.totalNvg),
      totalSim: num(r.totalSim),
      totalCaptain: num(r.totalCaptain),
      expiry: {
        day: r.expiryDay ?? "",
        night: r.expiryNight ?? "",
        nvg: r.expiryNvg ?? "",
        irt: r.expiryIrt ?? "",
        medical: r.expiryMedical ?? "",
        sim: r.expirySim ?? "",
      },
      available: bool(r.available, true),
    });
  });
  // Duplicate id check within file.
  const seen = new Set<string>();
  rows.forEach((p, i) => {
    if (seen.has(p.id)) errors.push({ row: i + 2, reason: `Duplicate pilot id "${p.id}"` });
    seen.add(p.id);
  });
  return { rows, errors, rawCount: recs.length };
}

function parseSortiesFromRecords(recs: Record<string, string>[]): Parsed<Sortie> {
  const errors: RowError[] = [];
  const rows: Sortie[] = [];
  recs.forEach((r, i) => {
    const rowNum = i + 2;
    const missing = SORTIE_REQUIRED.filter(k => !r[k]);
    if (missing.length) {
      errors.push({ row: rowNum, reason: `Missing required column(s): ${missing.join(", ")}` });
      return;
    }
    if (!isDate(r.date)) {
      errors.push({ row: rowNum, reason: `Invalid date "${r.date}" (expected YYYY-MM-DD)` });
      return;
    }
    rows.push({
      id: r.id,
      date: r.date,
      acType: r.acType,
      acNumber: r.acNumber ?? "",
      pilotId: r.pilotId,
      coPilotId: r.coPilotId ?? "",
      sortieType: r.sortieType ?? "",
      name: r.name ?? "",
      day1: num(r.day1),
      day2: num(r.day2),
      dayDual: num(r.dayDual),
      night1: num(r.night1),
      night2: num(r.night2),
      nightDual: num(r.nightDual),
      nvg: num(r.nvg),
      sim: num(r.sim),
      actual: num(r.actual),
    });
  });
  return { rows, errors, rawCount: recs.length };
}

// ── DropZone ───────────────────────────────────────────────────────────
function DropZone({
  label, fileName, onFile, onClear, dataTestPrefix,
}: {
  label: string; fileName?: string; onFile: (f: File) => void; onClear: () => void; dataTestPrefix: string;
}) {
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault(); setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) onFile(f);
      }}
      className={`border-2 border-dashed rounded-lg p-6 text-center transition ${over ? "border-primary bg-primary/10" : "border-border bg-secondary/20"}`}
      data-testid={`${dataTestPrefix}-dropzone`}
    >
      <Upload className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
      <div className="text-sm font-medium">{label}</div>
      <div className="text-xs text-muted-foreground mt-1">Drag &amp; drop a .csv or .xlsx file here, or</div>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="mt-2 text-xs px-3 py-1.5 rounded-md border border-border hover:bg-secondary"
        data-testid={`${dataTestPrefix}-browse`}
      >
        Browse files
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.currentTarget.value = ""; }}
        data-testid={`${dataTestPrefix}-input`}
      />
      {fileName && (
        <div className="mt-3 inline-flex items-center gap-2 text-xs px-2 py-1 rounded bg-secondary">
          <FileText className="h-3.5 w-3.5" />
          <span data-testid={`${dataTestPrefix}-filename`}>{fileName}</span>
          <button onClick={onClear} className="hover:text-rose-400" aria-label="Remove">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────
export default function HistoricalImport() {
  const { t } = useI18n();
  const { user, backendMode } = useAuth();
  const importMut = useImportHistory();
  const undoMut = useUndoLastImport();

  // Both CSV and XLSX paths converge on Record<string,string>[] before
  // they hit the column-mapping logic, so the preview, validation, and
  // write flows are identical regardless of how the file came in.
  const [pilotFile, setPilotFile] = useState<{ name: string; recs: Record<string, string>[] } | null>(null);
  const [sortieFile, setSortieFile] = useState<{ name: string; recs: Record<string, string>[] } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [result, setResult] = useState<{ pilots: number; sorties: number; mode: string } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [undoResult, setUndoResult] = useState<{ pilots: number; sorties: number } | null>(null);
  // Re-read on every render so the button reflects the latest stamp without a
  // useState dance — getLastImportStamp() is a synchronous localStorage read.
  const lastImportStamp = getLastImportStamp();

  const pilotsParsed = useMemo<Parsed<Pilot> | null>(
    () => (pilotFile ? parsePilotsFromRecords(pilotFile.recs) : null), [pilotFile]
  );
  const sortiesParsed = useMemo<Parsed<Sortie> | null>(
    () => (sortieFile ? parseSortiesFromRecords(sortieFile.recs) : null), [sortieFile]
  );

  const readFile = async (f: File, set: (v: { name: string; recs: Record<string, string>[] }) => void) => {
    setReadError(null);
    try {
      const lower = f.name.toLowerCase();
      if (lower.endsWith(".xlsx")) {
        const recs = await xlsxToRecords(f);
        set({ name: f.name, recs });
      } else {
        const text = await f.text();
        set({ name: f.name, recs: toRecords(text) });
      }
    } catch (e) {
      setReadError(`Could not read ${f.name}: ${(e as Error).message}`);
    }
  };

  const totalErrors = (pilotsParsed?.errors.length ?? 0) + (sortiesParsed?.errors.length ?? 0);
  const totalAccepted = (pilotsParsed?.rows.length ?? 0) + (sortiesParsed?.rows.length ?? 0);
  const canSubmit = totalAccepted > 0 && !importMut.isPending;

  const onSubmit = async () => {
    setSubmitError(null);
    setResult(null);
    try {
      const res = await importMut.mutateAsync({
        pilots: pilotsParsed?.rows ?? [],
        sorties: sortiesParsed?.rows ?? [],
        actor: user?.username,
      });
      setResult({ pilots: res.pilotsInserted, sorties: res.sortiesInserted, mode: res.mode });
      setPilotFile(null);
      setSortieFile(null);
    } catch (e) {
      setSubmitError((e as Error).message);
    }
  };

  const onUndo = async () => {
    setSubmitError(null);
    setUndoResult(null);
    try {
      const res = await undoMut.mutateAsync({ actor: user?.username });
      setUndoResult({ pilots: res.pilotsRemoved, sorties: res.sortiesRemoved });
      setResult(null);
      setConfirmUndo(false);
    } catch (e) {
      setSubmitError((e as Error).message);
      setConfirmUndo(false);
    }
  };

  return (
    <div>
      <PageHead
        title={t("nav_import")}
        subtitle={`Bring forward pilots and flight history from the legacy SqDn App 21.10.16 export. Backend: ${backendMode}.`}
        actions={lastImportStamp ? (
          <button
            onClick={() => setConfirmUndo(true)}
            disabled={undoMut.isPending}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-secondary border border-border text-sm font-medium hover:bg-secondary/80 disabled:opacity-50"
            data-testid="button-undo-import"
            title={`${t("undoLastImportHelp")}: ${fmtDateTimeDDMM(lastImportStamp)}`}
          >
            <Undo2 className="h-3.5 w-3.5" />
            {undoMut.isPending ? t("syncing") : t("undoLastImport")}
          </button>
        ) : undefined}
      />

      <div className="grid md:grid-cols-2 gap-4 mb-4">
        <Card>
          <DropZone
            label="Pilots (CSV or XLSX)"
            fileName={pilotFile?.name}
            onFile={(f) => readFile(f, setPilotFile)}
            onClear={() => setPilotFile(null)}
            dataTestPrefix="pilot"
          />
          {pilotsParsed && (
            <div className="mt-3 text-xs">
              <span className="text-emerald-300" data-testid="pilot-accepted-count">
                {pilotsParsed.rows.length} accepted
              </span>
              {pilotsParsed.errors.length > 0 && (
                <span className="text-rose-300 ml-3" data-testid="pilot-error-count">
                  {pilotsParsed.errors.length} error(s)
                </span>
              )}
              <span className="text-muted-foreground ml-3">of {pilotsParsed.rawCount} rows</span>
            </div>
          )}
        </Card>
        <Card>
          <DropZone
            label="Sorties (CSV or XLSX)"
            fileName={sortieFile?.name}
            onFile={(f) => readFile(f, setSortieFile)}
            onClear={() => setSortieFile(null)}
            dataTestPrefix="sortie"
          />
          {sortiesParsed && (
            <div className="mt-3 text-xs">
              <span className="text-emerald-300" data-testid="sortie-accepted-count">
                {sortiesParsed.rows.length} accepted
              </span>
              {sortiesParsed.errors.length > 0 && (
                <span className="text-rose-300 ml-3" data-testid="sortie-error-count">
                  {sortiesParsed.errors.length} error(s)
                </span>
              )}
              <span className="text-muted-foreground ml-3">of {sortiesParsed.rawCount} rows</span>
            </div>
          )}
        </Card>
      </div>

      {totalErrors > 0 && (
        <Card className="mb-4">
          <div className="flex items-center gap-2 text-sm font-medium text-rose-300 mb-2">
            <AlertCircle className="h-4 w-4" /> Per-row errors
          </div>
          <div className="max-h-48 overflow-y-auto text-xs font-mono space-y-1" data-testid="error-list">
            {pilotsParsed?.errors.map((e, i) => (
              <div key={`p-${i}`}>Pilots row {e.row}: {e.reason}</div>
            ))}
            {sortiesParsed?.errors.map((e, i) => (
              <div key={`s-${i}`}>Sorties row {e.row}: {e.reason}</div>
            ))}
          </div>
        </Card>
      )}

      {(pilotsParsed?.rows.length || sortiesParsed?.rows.length) ? (
        <Card className="mb-4">
          <div className="text-sm font-medium mb-2">Preview (first 5 of each)</div>
          {pilotsParsed && pilotsParsed.rows.length > 0 && (
            <div className="mb-3">
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Pilots</div>
              <table className="w-full text-xs" data-testid="pilot-preview">
                <thead className="text-left text-muted-foreground">
                  <tr><th className="px-2 py-1">ID</th><th className="px-2 py-1">Name</th><th className="px-2 py-1">Rank</th><th className="px-2 py-1">Unit</th><th className="px-2 py-1">Opening Day</th></tr>
                </thead>
                <tbody>
                  {pilotsParsed.rows.slice(0, 5).map(p => (
                    <tr key={p.id} className="border-t border-border">
                      <td className="px-2 py-1 font-mono">{p.id}</td>
                      <td className="px-2 py-1">{p.name}</td>
                      <td className="px-2 py-1">{p.rank}</td>
                      <td className="px-2 py-1">{p.unit}</td>
                      <td className="px-2 py-1">{p.openingDay}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {sortiesParsed && sortiesParsed.rows.length > 0 && (
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Sorties</div>
              <table className="w-full text-xs" data-testid="sortie-preview">
                <thead className="text-left text-muted-foreground">
                  <tr><th className="px-2 py-1">ID</th><th className="px-2 py-1">Date</th><th className="px-2 py-1">A/C</th><th className="px-2 py-1">Pilot</th><th className="px-2 py-1">Actual</th></tr>
                </thead>
                <tbody>
                  {sortiesParsed.rows.slice(0, 5).map(s => (
                    <tr key={s.id} className="border-t border-border">
                      <td className="px-2 py-1 font-mono">{s.id}</td>
                      <td className="px-2 py-1">{s.date}</td>
                      <td className="px-2 py-1">{s.acType} {s.acNumber}</td>
                      <td className="px-2 py-1">{s.pilotId}</td>
                      <td className="px-2 py-1">{s.actual}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          onClick={onSubmit}
          disabled={!canSubmit}
          className="px-4 py-2 rounded-md bg-primary text-primary-foreground font-medium disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid="import-submit"
        >
          {importMut.isPending ? "Importing…" : `Import ${totalAccepted} accepted record(s)`}
        </button>
        <a
          href="IMPORT_CSV_README.md"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-muted-foreground underline hover:text-foreground"
        >
          CSV / XLSX column reference
        </a>
      </div>

      {readError && (
        <Card className="mt-4 border border-rose-500/40">
          <div className="text-sm text-rose-300 flex items-center gap-2" data-testid="read-error">
            <AlertCircle className="h-4 w-4" /> {readError}
          </div>
        </Card>
      )}

      {submitError && (
        <Card className="mt-4 border border-rose-500/40">
          <div className="text-sm text-rose-300 flex items-center gap-2">
            <AlertCircle className="h-4 w-4" /> {submitError}
          </div>
        </Card>
      )}

      {result && (
        <Card className="mt-4 border border-emerald-500/40">
          <div className="text-sm text-emerald-300 flex items-center gap-2" data-testid="import-success">
            <CheckCircle2 className="h-4 w-4" />
            Imported {result.pilots} pilot(s) and {result.sorties} sortie(s) ({result.mode} mode).
            Records are tagged with an "imported" flag and are visible in the Audit Log.
          </div>
        </Card>
      )}

      {undoResult && (
        <Card className="mt-4 border border-amber-500/40">
          <div className="text-sm text-amber-300 flex items-center gap-2" data-testid="undo-success">
            <Undo2 className="h-4 w-4" />
            {t("undoneRemoved")
              .replace("{p}", String(undoResult.pilots))
              .replace("{s}", String(undoResult.sorties))}
          </div>
        </Card>
      )}

      {confirmUndo && (
        <ConfirmDialog
          title={t("undoLastImport")}
          message={t("undoConfirmBody")}
          confirmLabel={t("undoLastImport")}
          onCancel={() => setConfirmUndo(false)}
          onConfirm={onUndo}
          busy={undoMut.isPending}
          danger
        />
      )}
    </div>
  );
}
