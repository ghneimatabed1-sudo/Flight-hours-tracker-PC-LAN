import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
// @ts-expect-error - arabic-reshaper ships only a CommonJS factory with no types.
import ArabicReshaper from "arabic-reshaper";
import type { Pilot, Sortie } from "./mock";
import { pilotRank } from "./ranks";

export type PdfLang = "en" | "ar";

interface SquadronInfo {
  name?: string;
  number?: string;
  base?: string;
}

// ---------- Localization helpers ----------

// Tiny lookup table so the PDF module stays self-contained and is not coupled
// to the React i18n provider (jsPDF is called from event handlers, not React).
const STR = {
  rjaf: { en: "Royal Jordanian Air Force", ar: "سلاح الجو الملكي الأردني" },
  squadron: { en: "Squadron", ar: "السرب" },
  reportDate: { en: "Report date", ar: "تاريخ التقرير" },
  authReport: { en: "Authorization Report", ar: "تقرير الصلاحيات" },
  authReportCont: { en: "Authorization Report (cont.)", ar: "تقرير الصلاحيات (تابع)" },
  pilotDataPage: { en: "Pilot Data Page", ar: "صفحة بيانات الطيار" },
  totalsPage: { en: "Total's Page · Monthly Squadron Totals", ar: "صفحة المجاميع · المجاميع الشهرية للسرب" },
  squadronSummary: { en: "Squadron Summary", ar: "ملخص السرب" },
  squadronSnapshot: { en: "Squadron Snapshot", ar: "لقطة السرب" },
  hoursSummary: { en: "Hours Summary", ar: "ملخص الساعات" },
  currencyExpiry: { en: "Currency Expiry", ar: "انتهاء صلاحية المؤهلات" },
  monthlyByPilot: { en: "Monthly Hours by Pilot", ar: "الساعات الشهرية لكل طيار" },
  asOf: { en: "As of", ar: "حتى تاريخ" },
  confidential: {
    en: "Hawk Eye · Confidential · Page",
    ar: "عمليات سرب القوات الجوية الملكية الأردنية · سري · صفحة",
  },
  of: { en: "of", ar: "من" },
  // Auth report
  col_num: { en: "#", ar: "#" },
  col_pilot: { en: "Pilot", ar: "الطيار" },
  col_unit: { en: "Unit", ar: "الوحدة" },
  col_dayAuth: { en: "Day Auth", ar: "صلاحية نهار" },
  col_nightAuth: { en: "Night Auth", ar: "صلاحية ليل" },
  col_nvgIrt: { en: "NVG / IRT", ar: "نظارة ليلية / IRT" },
  col_signature: { en: "Signature", ar: "التوقيع" },
  col_day: { en: "Day", ar: "نهار" },
  col_night: { en: "Night", ar: "ليل" },
  col_nvg: { en: "NVG", ar: "نظارة" },
  col_sim: { en: "Sim", ar: "محاكي" },
  col_captain: { en: "Captain", ar: "قائد" },
  col_flying: { en: "Flying", ar: "طيران" },
  col_bucket: { en: "Bucket", ar: "البند" },
  bucket_opening: { en: "Opening", ar: "افتتاح" },
  bucket_month: { en: "Month", ar: "الشهر" },
  bucket_total: { en: "Total", ar: "الإجمالي" },
  // Pilot data
  field_name: { en: "Name", ar: "الاسم" },
  field_arabic: { en: "Arabic", ar: "بالعربية" },
  field_id: { en: "Pilot ID", ar: "رقم الطيار" },
  field_unit: { en: "Unit", ar: "الوحدة" },
  field_phone: { en: "Phone", ar: "الهاتف" },
  field_address: { en: "Address", ar: "العنوان" },
  field_available: { en: "Available", ar: "متاح" },
  field_doctor: { en: "Doctor Note", ar: "ملاحظة الطبيب" },
  yes: { en: "Yes", ar: "نعم" },
  no: { en: "No", ar: "لا" },
  exp_day: { en: "Day", ar: "نهار" },
  exp_night: { en: "Night", ar: "ليل" },
  // v1.1.69 — NVG is its own currency, fully independent from Night.
  // Previously absent from STR which forced PDF exports to fall back to
  // a "col_nvg" column header and silently omitted NVG from the
  // "Pilot Data Pages" report entirely.
  exp_nvg: { en: "NVG", ar: "NVG" },
  exp_irt: { en: "IRT", ar: "IRT" },
  exp_medical: { en: "Medical", ar: "طبي" },
  exp_sim: { en: "Sim", ar: "محاكي" },
  // Snapshot
  pilots_strength: { en: "Pilots on Strength", ar: "الطيارون في القوة" },
  pilots_available: { en: "Available Pilots", ar: "الطيارون المتاحون" },
  exp_soon: { en: "Currencies Expiring < 30d", ar: "مؤهلات منتهية خلال 30 يوماً" },
  sortie_count: { en: "Sorties (60-day window)", ar: "الطلعات (نافذة 60 يوماً)" },
  total_hours: { en: "Total Flight Hours (window)", ar: "إجمالي ساعات الطيران (النافذة)" },
  squadron_total: { en: "Squadron Total", ar: "إجمالي السرب" },
  cmdr_sig: { en: "Squadron Commander: ____________________________", ar: "قائد السرب: ____________________________" },
  ops_sig: { en: "Operations Officer:  ____________________________", ar: "ضابط العمليات: ____________________________" },
  date_label: { en: "Date", ar: "التاريخ" },
} as const;

function tr(key: keyof typeof STR, lang: PdfLang): string {
  return STR[key][lang];
}

// Reshape any string that contains Arabic letters into Unicode presentation
// forms (FB50–FEFF) so jsPDF — which lacks OpenType shaping — still draws
// connected letters correctly. ASCII-only strings are returned unchanged.
const ARABIC_RE = /[\u0600-\u06FF\u0750-\u077F]/;
function shape(text: string | number | undefined | null): string {
  const s = text == null ? "" : String(text);
  if (!ARABIC_RE.test(s)) return s;
  try {
    return ArabicReshaper.convertArabic(s);
  } catch {
    return s;
  }
}

// ---------- Asset loading (emblem + Arabic font) ----------

let cachedEmblem: string | null = null;
async function loadEmblem(): Promise<string> {
  if (cachedEmblem) return cachedEmblem;
  const res = await fetch(`${import.meta.env.BASE_URL}brand/emblem.png`);
  const blob = await res.blob();
  cachedEmblem = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
  return cachedEmblem;
}

let cachedArabicFont: string | null = null;
async function loadArabicFontBase64(): Promise<string> {
  if (cachedArabicFont) return cachedArabicFont;
  const url = `${import.meta.env.BASE_URL}fonts/NotoNaskhArabic-Regular.ttf`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Arabic font not found at ${url} (HTTP ${res.status}). Arabic PDFs require the bundled NotoNaskhArabic-Regular.ttf in /public/fonts/.`);
  }
  const ct = res.headers.get("content-type") || "";
  // Vite serves the asset as application/octet-stream; reject HTML so a
  // missing-asset 200 fallback never silently registers garbage as a font.
  if (ct.includes("text/html")) {
    throw new Error(`Arabic font URL ${url} returned HTML, not a TTF. Check public/fonts/.`);
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength < 10000) {
    throw new Error(`Arabic font at ${url} is suspiciously small (${buf.byteLength} bytes). Likely not a valid TTF.`);
  }
  // Convert ArrayBuffer to base64 in chunks to avoid call-stack issues.
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  cachedArabicFont = btoa(bin);
  return cachedArabicFont;
}

const ARABIC_FONT_NAME = "NotoNaskhArabic";
async function setupDoc(lang: PdfLang): Promise<jsPDF> {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  if (lang === "ar") {
    const b64 = await loadArabicFontBase64();
    doc.addFileToVFS(`${ARABIC_FONT_NAME}.ttf`, b64);
    doc.addFont(`${ARABIC_FONT_NAME}.ttf`, ARABIC_FONT_NAME, "normal");
    doc.setFont(ARABIC_FONT_NAME, "normal");
    doc.setR2L(true);
  }
  return doc;
}

const baseFont = (lang: PdfLang) => (lang === "ar" ? ARABIC_FONT_NAME : "helvetica");

// DD-MM-YYYY everywhere in PDF land — squadron-wide standard. The pad
// helper keeps the format strict (single-digit days/months padded).
function pad2(n: number): string { return n < 10 ? `0${n}` : String(n); }

// DD-MM-YYYY for headers, "as-of" dates, signature blocks, etc.
function fmtDate(d: string | Date | number = new Date()): string {
  const v = d instanceof Date ? d : new Date(d);
  if (isNaN(v.getTime())) return "—";
  return `${pad2(v.getDate())}-${pad2(v.getMonth() + 1)}-${v.getFullYear()}`;
}

// YYYYMMDD slug — used as a filename suffix so reports sort
// chronologically in the OS file picker. Filenames stay ASCII so
// Windows Explorer doesn't mangle them.
function fileStamp(d: Date = new Date()): string {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
}

// Inclusive date-range filter (yyyy-mm-dd strings).
function inRange(iso: string, from?: string, to?: string): boolean {
  if (from && iso < from) return false;
  if (to && iso > to) return false;
  return true;
}

function pilotName(p: Pilot, lang: PdfLang): string {
  if (lang === "ar") {
    // Keep the rank in English for readability when Arabic name is set;
    // some squadrons use the same Arabic rank text everywhere.
    return shape(p.arabicName || p.name);
  }
  return `${pilotRank(p, "en")} ${p.name}`;
}

// ---------- Header / Footer ----------

function drawHeader(doc: jsPDF, sqdn: SquadronInfo, title: string, emblem: string, lang: PdfLang) {
  const w = doc.internal.pageSize.getWidth();
  doc.setFillColor(212, 175, 55);
  doc.rect(0, 0, w, 26, "F");
  doc.setFillColor(20, 24, 32);
  doc.rect(0, 26, w, 2, "F");

  try {
    doc.addImage(emblem, "PNG", 8, 3, 20, 20);
  } catch { /* ignore */ }

  doc.setTextColor(20, 24, 32);
  doc.setFont(baseFont(lang), "normal");
  doc.setFontSize(13);
  doc.text(shape(tr("rjaf", lang)), 32, 11);
  doc.setFontSize(10);
  const sub = `${shape(sqdn.name || tr("squadron", lang))} · ${sqdn.number || "—"} · ${shape(sqdn.base || "—")}`;
  doc.text(sub, 32, 17);
  doc.setFontSize(8);
  doc.text(`${shape(tr("reportDate", lang))}: ${fmtDate()}`, 32, 22);

  doc.setTextColor(20, 24, 32);
  doc.setFont(baseFont(lang), "normal");
  doc.setFontSize(14);
  doc.text(shape(title), 8, 36);
  doc.setDrawColor(212, 175, 55);
  doc.setLineWidth(0.4);
  doc.line(8, 38, w - 8, 38);
}

function footer(doc: jsPDF, lang: PdfLang) {
  const pageCount = doc.getNumberOfPages();
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont(baseFont(lang), "normal");
    doc.setFontSize(7);
    doc.setTextColor(100);
    const text = `${shape(tr("confidential", lang))} ${i} ${shape(tr("of", lang))} ${pageCount}`;
    doc.text(text, w / 2, h - 5, { align: "center" });
  }
}

// ---------- Capture-mode helper ----------
// Every export function in this file funnels through the local `save()`
// helper below. The "Preview before download" feature on the PdfExports
// page needs the same rendered PDF as a Blob so it can be shown in an
// iframe modal before the operator commits to saving it. Rather than
// thread an `output: "save" | "blob"` parameter through 21 export
// signatures (and risk drift), we install a module-level capture slot
// that the local `save()` consults: when a slot is set, `save()` writes
// the (Blob, filename) into it and skips the browser download; when no
// slot is set, behavior is unchanged (immediate download).
//
// We deliberately do NOT monkey-patch `jsPDF.prototype.save` here —
// jsPDF copies its `save` method onto each instance at construction
// time, so prototype patches never fire for already-built docs.
//
// captureExport restores the previous slot in `finally` so nested or
// concurrent captures behave correctly. The wrapped exporter MUST call
// `save()` exactly once (every exporter in this file does); if it
// doesn't we throw so the caller can surface a clear error rather than
// open an empty preview.
export interface PdfCapture { blob: Blob; filename: string }
type CaptureSlot = { blob: Blob | null; filename: string | null };
let captureSlot: CaptureSlot | null = null;

function save(doc: jsPDF, filename: string) {
  if (captureSlot) {
    captureSlot.blob = doc.output("blob");
    captureSlot.filename = filename;
    return;
  }
  doc.save(filename);
}

export async function captureExport(fn: () => Promise<void>): Promise<PdfCapture> {
  const slot: CaptureSlot = { blob: null, filename: null };
  const prev = captureSlot;
  captureSlot = slot;
  try {
    await fn();
  } finally {
    captureSlot = prev;
  }
  if (!slot.blob || !slot.filename) {
    throw new Error("PDF export did not produce a file");
  }
  return { blob: slot.blob, filename: slot.filename };
}

// Common autoTable styles per language so the Arabic font is applied to every
// table cell automatically.
function tableStyles(lang: PdfLang) {
  return {
    font: baseFont(lang),
    fontStyle: "normal" as const,
  };
}

// ---------- Authorization Report ----------
export async function exportAuthorizationReport(sqdn: SquadronInfo, pilots: Pilot[], lang: PdfLang = "en") {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);
  drawHeader(doc, sqdn, tr("authReport", lang), emblem, lang);

  const rows = pilots.map((p) => [
    p.id,
    pilotName(p, lang),
    shape(p.unit),
    p.expiry.day,
    p.expiry.night,
    p.expiry.irt,
    "____________",
  ]);

  autoTable(doc, {
    startY: 42,
    head: [[
      tr("col_num", lang), shape(tr("col_pilot", lang)), shape(tr("col_unit", lang)),
      shape(tr("col_dayAuth", lang)), shape(tr("col_nightAuth", lang)),
      shape(tr("col_nvgIrt", lang)), shape(tr("col_signature", lang)),
    ]],
    body: rows,
    styles: { fontSize: 8, cellPadding: 1.6, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    columnStyles: { 6: { cellWidth: 36 } },
    margin: { left: 8, right: 8 },
    didDrawPage: (data) => {
      if (data.pageNumber > 1) drawHeader(doc, sqdn, tr("authReportCont", lang), emblem, lang);
    },
  });

  const finalY = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 200;
  doc.setFont(baseFont(lang), "normal");
  doc.setFontSize(9);
  doc.setTextColor(20, 24, 32);
  doc.text(shape(tr("cmdr_sig", lang)), 8, finalY + 14);
  doc.text(shape(tr("ops_sig", lang)), 8, finalY + 22);
  doc.text(`${shape(tr("date_label", lang))}: ${fmtDate()}`, 8, finalY + 30);

  footer(doc, lang);
  save(doc, `authorization-report-${lang}-${fileStamp()}.pdf`);
}

// ---------- Pilot Data Pages ----------
export async function exportPilotDataPages(sqdn: SquadronInfo, pilots: Pilot[], lang: PdfLang = "en") {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);

  pilots.forEach((p, idx) => {
    if (idx > 0) doc.addPage();
    drawHeader(doc, sqdn, `${tr("pilotDataPage", lang)} · ${p.id}`, emblem, lang);

    autoTable(doc, {
      startY: 42,
      theme: "grid",
      styles: { fontSize: 9, cellPadding: 2, ...tableStyles(lang) },
      body: [
        [shape(tr("field_name", lang)), pilotName(p, lang), shape(tr("field_arabic", lang)), shape(p.arabicName)],
        [shape(tr("field_id", lang)), p.id, shape(tr("field_unit", lang)), shape(p.unit)],
        [shape(tr("field_phone", lang)), p.phone, shape(tr("field_address", lang)), shape(p.address)],
        [shape(tr("field_available", lang)), p.available ? shape(tr("yes", lang)) : shape(tr("no", lang)), shape(tr("field_doctor", lang)), shape(p.doctorNote || "—")],
      ],
      margin: { left: 8, right: 8 },
    });

    const y1 = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 4;
    doc.setFont(baseFont(lang), "normal");
    doc.setFontSize(10);
    doc.setTextColor(20, 24, 32);
    doc.text(shape(tr("hoursSummary", lang)), 8, y1);

    autoTable(doc, {
      startY: y1 + 2,
      head: [[
        shape(tr("col_bucket", lang)), shape(tr("col_day", lang)), shape(tr("col_night", lang)),
        shape(tr("col_nvg", lang)), shape(tr("col_sim", lang)), shape(tr("col_captain", lang)),
      ]],
      body: [
        [shape(tr("bucket_opening", lang)), p.openingDay.toFixed(1), p.openingNight.toFixed(1), p.openingNvg.toFixed(1), "—", "—"],
        [shape(tr("bucket_month", lang)), p.monthDay.toFixed(1), p.monthNight.toFixed(1), p.monthNvg.toFixed(1), p.monthSim.toFixed(1), p.monthCaptain.toFixed(1)],
        [shape(tr("bucket_total", lang)), p.totalDay.toFixed(1), p.totalNight.toFixed(1), p.totalNvg.toFixed(1), p.totalSim.toFixed(1), p.totalCaptain.toFixed(1)],
      ],
      styles: { fontSize: 9, cellPadding: 2, ...tableStyles(lang) },
      headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
      margin: { left: 8, right: 8 },
    });

    const y2 = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 4;
    doc.setFont(baseFont(lang), "normal");
    doc.text(shape(tr("currencyExpiry", lang)), 8, y2);
    autoTable(doc, {
      startY: y2 + 2,
      head: [[
        shape(tr("exp_day", lang)), shape(tr("exp_night", lang)), shape(tr("exp_nvg", lang)),
        shape(tr("exp_irt", lang)), shape(tr("exp_medical", lang)),
      ]],
      body: [[p.expiry.day, p.expiry.night, p.expiry.nvg, p.expiry.irt, p.expiry.medical]],
      styles: { fontSize: 9, cellPadding: 2, ...tableStyles(lang) },
      headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
      margin: { left: 8, right: 8 },
    });
  });

  footer(doc, lang);
  save(doc, `pilot-data-pages-${lang}-${fileStamp()}.pdf`);
}

// ---------- Total's Page ----------
export async function exportTotalsPage(sqdn: SquadronInfo, pilots: Pilot[], lang: PdfLang = "en") {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);
  drawHeader(doc, sqdn, tr("totalsPage", lang), emblem, lang);

  const rows = pilots.map((p) => [
    p.id,
    pilotName(p, lang),
    shape(p.unit),
    p.monthDay.toFixed(1),
    p.monthNight.toFixed(1),
    p.monthNvg.toFixed(1),
    p.monthSim.toFixed(1),
    p.monthCaptain.toFixed(1),
    (p.monthDay + p.monthNight + p.monthNvg).toFixed(1),
  ]);

  const sum = (k: keyof Pilot) => pilots.reduce((s, p) => s + (p[k] as number), 0);
  rows.push([
    "",
    shape(tr("squadron_total", lang)),
    "",
    sum("monthDay").toFixed(1),
    sum("monthNight").toFixed(1),
    sum("monthNvg").toFixed(1),
    sum("monthSim").toFixed(1),
    sum("monthCaptain").toFixed(1),
    (sum("monthDay") + sum("monthNight") + sum("monthNvg")).toFixed(1),
  ]);

  autoTable(doc, {
    startY: 42,
    head: [[
      tr("col_num", lang), shape(tr("col_pilot", lang)), shape(tr("col_unit", lang)),
      shape(tr("col_day", lang)), shape(tr("col_night", lang)), shape(tr("col_nvg", lang)),
      shape(tr("col_sim", lang)), shape(tr("col_captain", lang)), shape(tr("col_flying", lang)),
    ]],
    body: rows,
    styles: { fontSize: 8, cellPadding: 1.6, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    didParseCell: (data) => {
      if (data.row.index === rows.length - 1) {
        data.cell.styles.fontStyle = "normal";
        data.cell.styles.fillColor = [240, 230, 200];
      }
    },
    margin: { left: 8, right: 8 },
  });

  footer(doc, lang);
  save(doc, `totals-page-${lang}-${fileStamp()}.pdf`);
}

// ---------- Squadron Summary ----------
export async function exportSquadronSummary(sqdn: SquadronInfo, pilots: Pilot[], sorties: Sortie[], lang: PdfLang = "en") {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);

  // Cover page
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  doc.setFillColor(20, 24, 32);
  doc.rect(0, 0, w, h, "F");
  doc.setFillColor(212, 175, 55);
  doc.rect(0, 0, w, 8, "F");
  doc.rect(0, h - 8, w, 8, "F");

  try {
    doc.addImage(emblem, "PNG", w / 2 - 30, 50, 60, 70);
  } catch { /* ignore */ }

  doc.setTextColor(212, 175, 55);
  doc.setFont(baseFont(lang), "normal");
  doc.setFontSize(22);
  doc.text(shape(tr("rjaf", lang)), w / 2, 140, { align: "center" });
  doc.setFontSize(16);
  doc.setTextColor(255, 255, 255);
  doc.text(shape(sqdn.name || tr("squadron", lang)), w / 2, 152, { align: "center" });
  doc.setFontSize(12);
  doc.text(`${sqdn.number || "—"} · ${shape(sqdn.base || "—")}`, w / 2, 162, { align: "center" });
  doc.setFontSize(18);
  doc.setTextColor(212, 175, 55);
  doc.text(shape(tr("squadronSummary", lang)), w / 2, 190, { align: "center" });
  doc.setFontSize(11);
  doc.setTextColor(255, 255, 255);
  doc.text(`${shape(tr("asOf", lang))} ${fmtDate()}`, w / 2, 200, { align: "center" });

  // Snapshot page
  doc.addPage();
  drawHeader(doc, sqdn, tr("squadronSnapshot", lang), emblem, lang);

  const totalPilots = pilots.length;
  const available = pilots.filter((p) => p.available).length;
  const expSoon = pilots.filter((p) => {
    const t = Math.min(
      ...Object.values(p.expiry).map((d) => new Date(d).getTime() - Date.now()),
    );
    return t < 30 * 86400000;
  }).length;
  const sortieCount = sorties.length;
  const totalHrs = sorties.reduce((s, x) => s + x.actual, 0);

  autoTable(doc, {
    startY: 44,
    theme: "grid",
    styles: { fontSize: 11, cellPadding: 3, ...tableStyles(lang) },
    body: [
      [shape(tr("pilots_strength", lang)), String(totalPilots)],
      [shape(tr("pilots_available", lang)), String(available)],
      [shape(tr("exp_soon", lang)), String(expSoon)],
      [shape(tr("sortie_count", lang)), String(sortieCount)],
      [shape(tr("total_hours", lang)), totalHrs.toFixed(1)],
    ],
    columnStyles: { 0: { cellWidth: 80 } },
    margin: { left: 8, right: 8 },
  });

  const y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  doc.setFont(baseFont(lang), "normal");
  doc.setFontSize(11);
  doc.setTextColor(20, 24, 32);
  doc.text(shape(tr("monthlyByPilot", lang)), 8, y);
  autoTable(doc, {
    startY: y + 2,
    head: [[
      shape(tr("col_pilot", lang)), shape(tr("col_day", lang)), shape(tr("col_night", lang)),
      shape(tr("col_nvg", lang)), shape(tr("col_sim", lang)),
    ]],
    body: pilots.map((p) => [
      pilotName(p, lang),
      p.monthDay.toFixed(1),
      p.monthNight.toFixed(1),
      p.monthNvg.toFixed(1),
      p.monthSim.toFixed(1),
    ]),
    styles: { fontSize: 9, cellPadding: 1.6, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    margin: { left: 8, right: 8 },
  });

  footer(doc, lang);
  save(doc, `squadron-summary-${lang}-${fileStamp()}.pdf`);
}

// ───────────────────────────────────────────────────────────────────
// Extended PDF exports — every report below uses the shared header /
// footer / DD-MM-YYYY date helpers above, so the global polish rules
// (no UI chrome, RJAF emblem, page-fit, color-coded currency badges)
// are honoured automatically.
// ───────────────────────────────────────────────────────────────────

interface DateRange { from?: string; to?: string }

function rangeLabel(r: DateRange, lang: PdfLang): string {
  if (!r.from && !r.to) return `${shape(tr("asOf", lang))} ${fmtDate()}`;
  return `${r.from ? fmtDate(r.from) : "—"} → ${r.to ? fmtDate(r.to) : "—"}`;
}

// ─── Roster ───────────────────────────────────────────────────────
export async function exportRoster(sqdn: SquadronInfo, pilots: Pilot[], lang: PdfLang = "en") {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);
  drawHeader(doc, sqdn, lang === "ar" ? "كشف السرب" : "Squadron Roster", emblem, lang);

  autoTable(doc, {
    startY: 42,
    head: [[
      tr("col_num", lang),
      shape(tr("col_pilot", lang)),
      shape(tr("field_arabic", lang)),
      shape(tr("col_unit", lang)),
      shape(tr("field_phone", lang)),
      shape(tr("field_available", lang)),
    ]],
    body: pilots.map((p) => [
      p.id,
      pilotName(p, lang),
      shape(p.arabicName || "—"),
      shape(p.unit),
      p.phone || "—",
      p.available ? shape(tr("yes", lang)) : shape(tr("no", lang)),
    ]),
    styles: { fontSize: 9, cellPadding: 1.8, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    margin: { left: 8, right: 8 },
  });

  footer(doc, lang);
  save(doc, `roster-${lang}-${fileStamp()}.pdf`);
}

// ─── Currency status (color-coded) ────────────────────────────────
type ExpiryKey = "day" | "night" | "nvg" | "irt" | "medical" | "sim";

function statusColour(iso: string): [number, number, number] {
  const days = (new Date(iso).getTime() - Date.now()) / 86400000;
  if (isNaN(days) || days < 0) return [254, 202, 202];   // red — expired
  if (days < 15) return [254, 240, 138];                  // yellow — warn
  return [187, 247, 208];                                  // green — current
}

export async function exportCurrencyStatus(sqdn: SquadronInfo, pilots: Pilot[], lang: PdfLang = "en") {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);
  drawHeader(doc, sqdn, lang === "ar" ? "حالة المؤهلات" : "Currency Status", emblem, lang);

  const head = [[
    shape(tr("col_pilot", lang)),
    shape(tr("exp_day", lang)),
    shape(tr("exp_night", lang)),
    shape(tr("col_nvg", lang)),
    shape(tr("exp_irt", lang)),
    shape(tr("exp_medical", lang)),
    shape(tr("exp_sim", lang)),
  ]];

  const expiryKeys: ExpiryKey[] = ["day", "night", "nvg", "irt", "medical", "sim"];
  const body = pilots.map((p) => [
    pilotName(p, lang),
    ...expiryKeys.map((k) => fmtDate(p.expiry[k])),
  ]);

  autoTable(doc, {
    startY: 42,
    head, body,
    styles: { fontSize: 8.5, cellPadding: 1.6, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    didParseCell: (data) => {
      if (data.section !== "body" || data.column.index === 0) return;
      const k = expiryKeys[data.column.index - 1];
      const iso = pilots[data.row.index]?.expiry[k];
      if (!iso) return;
      data.cell.styles.fillColor = statusColour(iso);
      data.cell.styles.textColor = [20, 24, 32];
    },
    margin: { left: 8, right: 8 },
  });

  footer(doc, lang);
  save(doc, `currency-status-${lang}-${fileStamp()}.pdf`);
}

// ─── Sortie log (date-range) ──────────────────────────────────────
export async function exportSortieLog(
  sqdn: SquadronInfo, pilots: Pilot[], sorties: Sortie[], range: DateRange, lang: PdfLang = "en",
) {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);
  drawHeader(doc, sqdn, `${lang === "ar" ? "سجل الطلعات" : "Sortie Log"} · ${rangeLabel(range, lang)}`, emblem, lang);

  const pilotMap = new Map(pilots.map((p) => [p.id, p]));
  const filtered = sorties
    .filter((s) => inRange(s.date, range.from, range.to))
    .sort((a, b) => a.date.localeCompare(b.date));

  autoTable(doc, {
    startY: 42,
    head: [[
      shape(tr("date_label", lang)),
      lang === "ar" ? "نوع الطائرة" : "AC",
      shape(tr("col_pilot", lang)),
      lang === "ar" ? "مساعد" : "Co-pilot",
      lang === "ar" ? "النوع" : "Type",
      shape(tr("col_day", lang)),
      shape(tr("col_night", lang)),
      shape(tr("col_nvg", lang)),
      shape(tr("col_sim", lang)),
      lang === "ar" ? "الفعلي" : "Actual",
    ]],
    body: filtered.map((s) => {
      const pilot = pilotMap.get(s.pilotId);
      const co = pilotMap.get(s.coPilotId);
      const pName = pilot ? pilotName(pilot, lang) : (s.pilotExternal?.name ? `${shape(s.pilotExternal.name)} *` : "—");
      const cName = co ? pilotName(co, lang) : (s.coPilotExternal?.name ? `${shape(s.coPilotExternal.name)} *` : "—");
      return [
        fmtDate(s.date),
        `${s.acType} ${s.acNumber}`.trim(),
        pName,
        cName,
        shape(s.sortieType || s.name || "—"),
        (s.day1 + s.day2 + s.dayDual).toFixed(1),
        (s.night1 + s.night2 + s.nightDual).toFixed(1),
        (s.nvg ?? 0).toFixed(1),
        (s.sim ?? 0).toFixed(1),
        (s.actual ?? 0).toFixed(1),
      ];
    }),
    styles: { fontSize: 8, cellPadding: 1.4, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    margin: { left: 8, right: 8 },
  });

  footer(doc, lang);
  save(doc, `sortie-log-${lang}-${fileStamp()}.pdf`);
}

// ─── Rankings (sorted by total flight hours) ──────────────────────
export async function exportRankings(sqdn: SquadronInfo, pilots: Pilot[], lang: PdfLang = "en") {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);
  drawHeader(doc, sqdn, lang === "ar" ? "ترتيب الطيارين حسب الساعات" : "Squadron Rankings — Total Hours", emblem, lang);

  const ranked = [...pilots].sort((a, b) => {
    const ta = a.totalDay + a.totalNight + a.totalNvg;
    const tb = b.totalDay + b.totalNight + b.totalNvg;
    return tb - ta;
  });

  autoTable(doc, {
    startY: 42,
    head: [[
      lang === "ar" ? "الترتيب" : "Rank",
      shape(tr("col_pilot", lang)),
      shape(tr("col_unit", lang)),
      shape(tr("col_day", lang)),
      shape(tr("col_night", lang)),
      shape(tr("col_nvg", lang)),
      shape(tr("col_sim", lang)),
      shape(tr("col_captain", lang)),
      lang === "ar" ? "الإجمالي" : "Total",
    ]],
    body: ranked.map((p, i) => [
      String(i + 1),
      pilotName(p, lang),
      shape(p.unit),
      p.totalDay.toFixed(1),
      p.totalNight.toFixed(1),
      p.totalNvg.toFixed(1),
      p.totalSim.toFixed(1),
      p.totalCaptain.toFixed(1),
      (p.totalDay + p.totalNight + p.totalNvg).toFixed(1),
    ]),
    styles: { fontSize: 9, cellPadding: 1.6, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    margin: { left: 8, right: 8 },
  });

  footer(doc, lang);
  save(doc, `rankings-${lang}-${fileStamp()}.pdf`);
}

// ─── External pilots (guests) ─────────────────────────────────────
export async function exportExternalPilots(sqdn: SquadronInfo, sorties: Sortie[], lang: PdfLang = "en") {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);
  drawHeader(doc, sqdn, lang === "ar" ? "الطيارون الخارجيون" : "External Pilots", emblem, lang);

  // Roll up guest entries — each external name + squadron pair becomes
  // a row with their total recorded hours and number of flights here.
  type Row = { name: string; squadron: string; flights: number; hours: number; lastDate: string };
  const map = new Map<string, Row>();
  const eat = (s: Sortie, ext: { name: string; squadron: string } | undefined) => {
    if (!ext) return;
    const k = `${ext.squadron}::${ext.name}`;
    const cur = map.get(k) ?? { name: ext.name, squadron: ext.squadron, flights: 0, hours: 0, lastDate: s.date };
    cur.flights += 1;
    cur.hours += s.actual ?? 0;
    if (s.date > cur.lastDate) cur.lastDate = s.date;
    map.set(k, cur);
  };
  sorties.forEach((s) => { eat(s, s.pilotExternal); eat(s, s.coPilotExternal); });

  const rows = [...map.values()].sort((a, b) => b.hours - a.hours);

  autoTable(doc, {
    startY: 42,
    head: [[
      shape(tr("col_pilot", lang)),
      lang === "ar" ? "السرب" : "Squadron",
      lang === "ar" ? "عدد الطلعات" : "Flights",
      lang === "ar" ? "الساعات" : "Hours",
      lang === "ar" ? "آخر طلعة" : "Last flight",
    ]],
    body: rows.length === 0
      ? [[lang === "ar" ? "لا يوجد" : "No external pilots on record.", "", "", "", ""]]
      : rows.map((r) => [shape(r.name), shape(r.squadron), String(r.flights), r.hours.toFixed(1), fmtDate(r.lastDate)]),
    styles: { fontSize: 9, cellPadding: 1.8, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    margin: { left: 8, right: 8 },
  });

  footer(doc, lang);
  save(doc, `external-pilots-${lang}-${fileStamp()}.pdf`);
}

// ─── Per-pilot logbook (date-range) ───────────────────────────────
export async function exportPilotLogbook(
  sqdn: SquadronInfo, pilot: Pilot, sorties: Sortie[], range: DateRange, lang: PdfLang = "en",
) {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);
  drawHeader(
    doc, sqdn,
    `${lang === "ar" ? "سجل طيران الطيار" : "Pilot Logbook"} · ${pilotName(pilot, lang)} · ${rangeLabel(range, lang)}`,
    emblem, lang,
  );

  const own = sorties
    .filter((s) => (s.pilotId === pilot.id || s.coPilotId === pilot.id) && inRange(s.date, range.from, range.to))
    .sort((a, b) => a.date.localeCompare(b.date));

  autoTable(doc, {
    startY: 42,
    head: [[
      shape(tr("date_label", lang)),
      lang === "ar" ? "نوع الطائرة" : "AC",
      lang === "ar" ? "المقعد" : "Seat",
      lang === "ar" ? "النوع" : "Mission",
      shape(tr("col_day", lang)),
      shape(tr("col_night", lang)),
      shape(tr("col_nvg", lang)),
      shape(tr("col_sim", lang)),
      lang === "ar" ? "الفعلي" : "Actual",
    ]],
    body: own.map((s) => {
      const seat = s.pilotId === pilot.id ? (lang === "ar" ? "قائد" : "Pilot") : (lang === "ar" ? "مساعد" : "Co-pilot");
      return [
        fmtDate(s.date),
        `${s.acType} ${s.acNumber}`.trim(),
        seat,
        shape(s.sortieType || s.name || "—"),
        (s.day1 + s.day2 + s.dayDual).toFixed(1),
        (s.night1 + s.night2 + s.nightDual).toFixed(1),
        (s.nvg ?? 0).toFixed(1),
        (s.sim ?? 0).toFixed(1),
        (s.actual ?? 0).toFixed(1),
      ];
    }),
    styles: { fontSize: 8.5, cellPadding: 1.4, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    margin: { left: 8, right: 8 },
  });

  // Totals row
  const totDay = own.reduce((a, s) => a + s.day1 + s.day2 + s.dayDual, 0);
  const totNight = own.reduce((a, s) => a + s.night1 + s.night2 + s.nightDual, 0);
  const totNvg = own.reduce((a, s) => a + (s.nvg ?? 0), 0);
  const totSim = own.reduce((a, s) => a + (s.sim ?? 0), 0);
  const totAct = own.reduce((a, s) => a + (s.actual ?? 0), 0);
  const y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  doc.setFont(baseFont(lang), "normal");
  doc.setFontSize(10);
  doc.setTextColor(20, 24, 32);
  doc.text(
    `${shape(tr("squadron_total", lang))}: D ${totDay.toFixed(1)} · N ${totNight.toFixed(1)} · NVG ${totNvg.toFixed(1)} · SIM ${totSim.toFixed(1)} · ${lang === "ar" ? "إجمالي" : "Total"} ${totAct.toFixed(1)}`,
    8, y,
  );

  footer(doc, lang);
  save(doc, `logbook-${pilot.id}-${lang}-${fileStamp()}.pdf`);
}

// ─── Audit log (date-range) ───────────────────────────────────────
export interface AuditEntry { at: string; user: string; action: string; entity?: string; detail?: string }
export async function exportAuditLog(sqdn: SquadronInfo, rows: AuditEntry[], range: DateRange, lang: PdfLang = "en") {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);
  drawHeader(doc, sqdn, `${lang === "ar" ? "سجل التدقيق" : "Audit Log"} · ${rangeLabel(range, lang)}`, emblem, lang);

  const filtered = rows
    .filter((r) => inRange(r.at.slice(0, 10), range.from, range.to))
    .sort((a, b) => a.at.localeCompare(b.at));

  autoTable(doc, {
    startY: 42,
    head: [[
      lang === "ar" ? "وقت الحدث" : "When",
      lang === "ar" ? "المستخدم" : "User",
      lang === "ar" ? "الإجراء" : "Action",
      lang === "ar" ? "الكائن" : "Entity",
      lang === "ar" ? "التفاصيل" : "Detail",
    ]],
    body: filtered.map((r) => {
      const d = new Date(r.at);
      const stamp = isNaN(d.getTime()) ? r.at : `${fmtDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
      return [stamp, shape(r.user), shape(r.action), shape(r.entity || "—"), shape(r.detail || "—")];
    }),
    styles: { fontSize: 8, cellPadding: 1.4, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    columnStyles: { 4: { cellWidth: 80 } },
    margin: { left: 8, right: 8 },
  });

  footer(doc, lang);
  save(doc, `audit-log-${lang}-${fileStamp()}.pdf`);
}

// ─── Reminders log ────────────────────────────────────────────────
export interface ReminderLogEntry { pilot: string; type: string; threshold?: string; lastSent?: string; nextDue?: string }
export async function exportRemindersLog(sqdn: SquadronInfo, rows: ReminderLogEntry[], lang: PdfLang = "en") {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);
  drawHeader(doc, sqdn, lang === "ar" ? "سجل التذكيرات" : "Reminders Log", emblem, lang);

  autoTable(doc, {
    startY: 42,
    head: [[
      shape(tr("col_pilot", lang)),
      lang === "ar" ? "النوع" : "Type",
      lang === "ar" ? "الحد" : "Threshold",
      lang === "ar" ? "آخر إرسال" : "Last sent",
      lang === "ar" ? "التالي" : "Next due",
    ]],
    body: rows.length === 0
      ? [[lang === "ar" ? "لا يوجد" : "No reminders configured.", "", "", "", ""]]
      : rows.map((r) => [
          shape(r.pilot), shape(r.type), shape(r.threshold || "—"),
          r.lastSent ? fmtDate(r.lastSent) : "—",
          r.nextDue ? fmtDate(r.nextDue) : "—",
        ]),
    styles: { fontSize: 9, cellPadding: 1.6, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    margin: { left: 8, right: 8 },
  });

  footer(doc, lang);
  save(doc, `reminders-log-${lang}-${fileStamp()}.pdf`);
}

// ─── NOTAMs ───────────────────────────────────────────────────────
export interface NotamLine { id: string; date: string; text: string }
export async function exportNotams(sqdn: SquadronInfo, notams: NotamLine[], lang: PdfLang = "en") {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);
  drawHeader(doc, sqdn, "NOTAMs", emblem, lang);

  autoTable(doc, {
    startY: 42,
    head: [["#", shape(tr("date_label", lang)), lang === "ar" ? "النص" : "Text"]],
    body: notams
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((n, i) => [String(i + 1), fmtDate(n.date), shape(n.text)]),
    styles: { fontSize: 9, cellPadding: 1.8, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    columnStyles: { 0: { cellWidth: 12 }, 1: { cellWidth: 32 } },
    margin: { left: 8, right: 8 },
  });

  footer(doc, lang);
  save(doc, `notams-${lang}-${fileStamp()}.pdf`);
}

// ─── Nav routes ───────────────────────────────────────────────────
export interface NavRouteLine { id: string; name: string; aircraft: string; description?: string; estimatedHours?: number; waypoints: { name: string; coords?: string }[] }
export async function exportNavRoutes(sqdn: SquadronInfo, routes: NavRouteLine[], lang: PdfLang = "en") {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);
  drawHeader(doc, sqdn, lang === "ar" ? "مسارات الملاحة" : "Nav Routes", emblem, lang);

  autoTable(doc, {
    startY: 42,
    head: [[
      lang === "ar" ? "المسار" : "Route",
      lang === "ar" ? "الطائرة" : "Aircraft",
      lang === "ar" ? "الساعات التقديرية" : "Est. hours",
      lang === "ar" ? "نقاط الطريق" : "Waypoints",
    ]],
    body: routes.map((r) => [
      shape(r.name),
      shape(r.aircraft),
      r.estimatedHours != null ? r.estimatedHours.toFixed(1) : "—",
      shape(r.waypoints.map((w) => w.name + (w.coords ? ` (${w.coords})` : "")).join(" → ") || "—"),
    ]),
    styles: { fontSize: 9, cellPadding: 1.8, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    columnStyles: { 3: { cellWidth: 130 } },
    margin: { left: 8, right: 8 },
  });

  footer(doc, lang);
  save(doc, `nav-routes-${lang}-${fileStamp()}.pdf`);
}

// ─── Risk Assessment ──────────────────────────────────────────────
export interface RiskRow { factor: string; weight: number; score: number }
export async function exportRiskAssessment(
  sqdn: SquadronInfo, rows: RiskRow[], total: number, level: string, lang: PdfLang = "en",
) {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);
  drawHeader(doc, sqdn, lang === "ar" ? "تقييم المخاطر" : "Risk Assessment", emblem, lang);

  autoTable(doc, {
    startY: 42,
    head: [[
      lang === "ar" ? "العامل" : "Factor",
      lang === "ar" ? "الوزن" : "Weight",
      lang === "ar" ? "النتيجة" : "Score",
    ]],
    body: rows.map((r) => [shape(r.factor), String(r.weight), String(r.score)]),
    styles: { fontSize: 10, cellPadding: 2, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    margin: { left: 8, right: 8 },
  });

  const y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  doc.setFont(baseFont(lang), "normal");
  doc.setFontSize(11);
  doc.setTextColor(20, 24, 32);
  doc.text(`${lang === "ar" ? "الإجمالي" : "Total"}: ${total} · ${lang === "ar" ? "المستوى" : "Level"}: ${shape(level)}`, 8, y);

  footer(doc, lang);
  save(doc, `risk-assessment-${lang}-${fileStamp()}.pdf`);
}

// ─── Flight schedule ──────────────────────────────────────────────
export interface ScheduleLine { ac: string; config: string; crew: string; mission: string; takeoff: string; land: string; fuel: string }
export async function exportFlightSchedule(
  sqdn: SquadronInfo, dateIso: string, lines: ScheduleLine[], lang: PdfLang = "en",
) {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);
  drawHeader(doc, sqdn, `${lang === "ar" ? "برنامج الطيران" : "Flight Schedule"} · ${fmtDate(dateIso)}`, emblem, lang);

  autoTable(doc, {
    startY: 42,
    head: [[
      lang === "ar" ? "الطائرة" : "AC",
      lang === "ar" ? "التهيئة" : "Config",
      lang === "ar" ? "الطاقم" : "Crew",
      lang === "ar" ? "المهمة" : "Mission",
      lang === "ar" ? "الإقلاع" : "Takeoff",
      lang === "ar" ? "الهبوط" : "Land",
      lang === "ar" ? "الوقود" : "Fuel",
    ]],
    body: lines.map((l) => [shape(l.ac), shape(l.config), shape(l.crew), shape(l.mission), l.takeoff, l.land, l.fuel]),
    styles: { fontSize: 9, cellPadding: 1.8, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    margin: { left: 8, right: 8 },
  });

  footer(doc, lang);
  save(doc, `flight-schedule-${lang}-${fileStamp()}.pdf`);
}

// ─── Duty week ────────────────────────────────────────────────────
export interface DutyLine { day: string; mainDuty: string; standby: string; rcm: string }
export async function exportDutyWeek(
  sqdn: SquadronInfo, period: string, days: DutyLine[], counters: { name: string; count: number }[], lang: PdfLang = "en",
) {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);
  drawHeader(doc, sqdn, `${lang === "ar" ? "أسبوع الجاهزية" : "Duty Week"} · ${period}`, emblem, lang);

  autoTable(doc, {
    startY: 42,
    head: [[
      lang === "ar" ? "اليوم" : "Day",
      lang === "ar" ? "ضابط اليوم" : "Main duty",
      lang === "ar" ? "الاحتياط" : "Standby",
      "RCM",
    ]],
    body: days.map((d) => [d.day, shape(d.mainDuty), shape(d.standby), shape(d.rcm)]),
    styles: { fontSize: 10, cellPadding: 2, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    margin: { left: 8, right: 8 },
  });

  if (counters.length) {
    const y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
    doc.setFont(baseFont(lang), "normal");
    doc.setFontSize(10);
    doc.setTextColor(20, 24, 32);
    doc.text(lang === "ar" ? "العداد الشهري" : "Monthly counter", 8, y);
    autoTable(doc, {
      startY: y + 2,
      head: [[shape(tr("col_pilot", lang)), lang === "ar" ? "عدد الأيام" : "Days"]],
      body: counters.map((c) => [shape(c.name), String(c.count)]),
      styles: { fontSize: 9, cellPadding: 1.6, ...tableStyles(lang) },
      headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
      margin: { left: 8, right: 8 },
    });
  }

  footer(doc, lang);
  save(doc, `duty-week-${period}-${lang}-${fileStamp()}.pdf`);
}

// ─── Leaves ───────────────────────────────────────────────────────
export interface LeavesLine { pilot: string; months: number[]; total: number }
export async function exportLeaves(
  sqdn: SquadronInfo, year: number, rows: LeavesLine[], lang: PdfLang = "en",
) {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);
  drawHeader(doc, sqdn, `${lang === "ar" ? "الإجازات" : "Leaves"} · ${year}`, emblem, lang);

  const monthNames = lang === "ar"
    ? ["كان2", "شباط", "آذار", "نيسان", "أيار", "حزير", "تموز", "آب", "أيلول", "تش1", "تش2", "كان1"]
    : ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  autoTable(doc, {
    startY: 42,
    head: [[shape(tr("col_pilot", lang)), ...monthNames, lang === "ar" ? "الإجمالي" : "Total"]],
    body: rows.map((r) => [shape(r.pilot), ...r.months.map((m) => String(m || "")), String(r.total)]),
    styles: { fontSize: 8.5, cellPadding: 1.4, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    margin: { left: 8, right: 8 },
  });

  footer(doc, lang);
  save(doc, `leaves-${year}-${lang}-${fileStamp()}.pdf`);
}

// ─── 6-Month Cycle (H1/H2) ────────────────────────────────────────
export interface CycleLine { pilot: string; h1: number; h2: number; target: number }
export async function exportCycle(
  sqdn: SquadronInfo, half: "H1" | "H2", rows: CycleLine[], lang: PdfLang = "en",
) {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);
  drawHeader(doc, sqdn, `${lang === "ar" ? "الدورة نصف السنوية" : "6-Month Cycle"} · ${half}`, emblem, lang);

  autoTable(doc, {
    startY: 42,
    head: [[
      shape(tr("col_pilot", lang)),
      "H1", "H2",
      lang === "ar" ? "الهدف" : "Target",
      lang === "ar" ? "النسبة" : "% of target",
    ]],
    body: rows.map((r) => {
      const total = r.h1 + r.h2;
      const pct = r.target > 0 ? Math.round((total / r.target) * 100) : 0;
      return [shape(r.pilot), r.h1.toFixed(1), r.h2.toFixed(1), r.target.toFixed(1), `${pct}%`];
    }),
    styles: { fontSize: 9, cellPadding: 1.6, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    margin: { left: 8, right: 8 },
  });

  footer(doc, lang);
  save(doc, `cycle-${half}-${lang}-${fileStamp()}.pdf`);
}

// ─────────────────────────────────────────────────────────────────────────
// Periodic Summary  (canonical 10-column RJAF paper-logbook layout)
// ─────────────────────────────────────────────────────────────────────────
// Replicates the periodic summary page that every pilot signs in their paper
// logbook every six months (H1 = Jan–Jun, H2 = Jul–Dec) plus a third Annual
// option that aggregates the full calendar year.
//
// Canonical column layout (left → right):
//   Date | A/C Type | Day-1P | Day-2P | Day-Dual
//                   | Night-1P | Night-2P | Night-Dual
//                   | Total (cols 1-6) | Captain | Sim | Instr-Act
//
// Per-pilot attribution rule:
//   The 9-bucket fields on a Sortie record are SQUADRON-level totals
//   (both crewmembers add into them via deriveSortieBuckets). For a per-
//   pilot logbook view we credit the sortie's flight time `t` ONCE to the
//   bucket dictated by THIS pilot's seat status (`pilotSeatStatus` if they
//   were the listed pilot, otherwise `coPilotSeatStatus`). Sim and
//   instrument-actual hours follow standard logbook convention — both
//   crewmembers credit the full sortie value (squadron sim time is shared).
// ─────────────────────────────────────────────────────────────────────────
export type PeriodicScope = "H1" | "H2" | "FULL";

export async function exportPeriodicSummary(
  sqdn: SquadronInfo,
  pilot: Pilot,
  sorties: Sortie[],
  year: number,
  scope: PeriodicScope,
  lang: PdfLang = "en",
) {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);

  const scopeLabel =
    scope === "H1" ? (lang === "ar" ? "النصف الأول" : "First Half")
    : scope === "H2" ? (lang === "ar" ? "النصف الثاني" : "Second Half")
    : (lang === "ar" ? "السنوي" : "Annual");

  const startMonth = scope === "H2" ? 6 : 0;
  const endMonth = scope === "H1" ? 5 : 11;
  const startDate = new Date(year, startMonth, 1);
  const endDate = new Date(year, endMonth + 1, 0);

  const fmtDateShort = (d: Date) => {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
  };
  const periodLabel = `${fmtDateShort(startDate)} → ${fmtDateShort(endDate)}`;

  drawHeader(
    doc, sqdn,
    `${lang === "ar" ? "ملخص دوري" : "Periodic Summary"} · ${scopeLabel} ${year} · ${pilotName(pilot, lang)}`,
    emblem, lang,
  );

  // Identity strip
  autoTable(doc, {
    startY: 42, theme: "grid",
    body: [[
      shape(tr("field_name", lang)), pilotName(pilot, lang),
      shape(tr("field_id", lang)), pilot.id,
      shape(tr("field_unit", lang)), shape(pilot.unit),
    ]],
    styles: { fontSize: 9, cellPadding: 2, ...tableStyles(lang) },
    margin: { left: 8, right: 8 },
  });

  type Bucket = {
    day1: number; day2: number; dayDual: number;
    night1: number; night2: number; nightDual: number;
    captain: number; sim: number; instrument: number;
    sorties: number;
  };
  const blank = (): Bucket => ({
    day1: 0, day2: 0, dayDual: 0,
    night1: 0, night2: 0, nightDual: 0,
    captain: 0, sim: 0, instrument: 0, sorties: 0,
  });

  const byAc = new Map<string, Bucket>();
  const grand = blank();

  for (const s of sorties) {
    const isPilot = s.pilotId === pilot.id;
    const isCo = s.coPilotId === pilot.id;
    if (!isPilot && !isCo) continue;

    // Local Y/M/D parse — same approach as squadron-data to avoid TZ skew.
    const parts = (s.date || "").split("-");
    if (parts.length !== 3) continue;
    const y = Number(parts[0]);
    const m = Number(parts[1]) - 1;
    const d = Number(parts[2]);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) continue;
    if (y !== year) continue;
    if (m < startMonth || m > endMonth) continue;

    // Resolve this pilot's seat. Prefer the canonical pilotSeatStatus /
    // coPilotSeatStatus fields; fall back to the legacy pilotIsCaptain
    // boolean (true → "1st", false → "2nd") for pre-rebuild records.
    //
    // Co-pilot fallback subtlety: legacy rows often carry only
    // `pilotIsCaptain` and leave `coPilotIsCaptain` undefined. Treating
    // an undefined boolean as "false" silently mis-attributes the co-pilot
    // to the 2nd seat even when the listed pilot was ALSO 2nd. So when the
    // co-pilot's own legacy flag is missing, we infer it as the opposite
    // of the listed pilot's flag (standard 2-seat assumption: exactly one
    // of the two crewmembers is captain).
    let seat: "1st" | "2nd" | "Dual" | undefined =
      isPilot ? s.pilotSeatStatus : s.coPilotSeatStatus;
    if (!seat) {
      let legacy: boolean;
      if (isPilot) {
        legacy = !!s.pilotIsCaptain;
      } else if (s.coPilotIsCaptain != null) {
        legacy = !!s.coPilotIsCaptain;
      } else {
        // Co-pilot flag missing: invert the pilot flag so seats stay paired.
        legacy = !s.pilotIsCaptain;
      }
      seat = legacy ? "1st" : "2nd";
    }

    const t = Number(s.actual ?? s.time ?? 0);
    const sim = Number(s.sim ?? 0);
    const instr = Number(s.ifAct ?? 0);

    // Determine condition. Prefer explicit s.condition; else infer from
    // which 9-bucket family carries hours (NVG sorties fold into Night
    // for the paper-logbook 10-col layout — the canonical RJAF book has
    // no NVG column on the periodic summary page).
    let condition: "Day" | "Night" | "NVG" = s.condition ?? "Day";
    if (!s.condition) {
      const nightTotal = (s.night1 ?? 0) + (s.night2 ?? 0) + (s.nightDual ?? 0);
      const nvgTotal = (s.nvg1 ?? 0) + (s.nvg2 ?? 0) + (s.nvgDual ?? 0) + (s.nvg ?? 0);
      if (nvgTotal > 0) condition = "NVG";
      else if (nightTotal > 0) condition = "Night";
    }

    const key = s.acType || "—";
    if (!byAc.has(key)) byAc.set(key, blank());
    const b = byAc.get(key)!;

    if (t > 0) {
      if (condition === "Day") {
        if (seat === "1st") { b.day1 += t; grand.day1 += t; }
        else if (seat === "Dual") { b.dayDual += t; grand.dayDual += t; }
        else { b.day2 += t; grand.day2 += t; }
      } else {
        // Night and NVG both bucket into the Night columns on the
        // periodic summary page (paper logbook has no NVG column).
        if (seat === "1st") { b.night1 += t; grand.night1 += t; }
        else if (seat === "Dual") { b.nightDual += t; grand.nightDual += t; }
        else { b.night2 += t; grand.night2 += t; }
      }
      if (seat === "1st") { b.captain += t; grand.captain += t; }
    }

    b.sim += sim; grand.sim += sim;
    b.instrument += instr; grand.instrument += instr;
    b.sorties += 1; grand.sorties += 1;
  }

  // Period banner
  const yBanner = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 6;
  doc.setFont(baseFont(lang), "normal"); doc.setFontSize(10); doc.setTextColor(20, 24, 32);
  doc.text(shape(`${lang === "ar" ? "الفترة" : "Period"}: ${periodLabel}    ·    ${lang === "ar" ? "الطلعات" : "Sorties"}: ${grand.sorties}`), 8, yBanner);

  // 10-column canonical table (with grouped Day/Night sub-headers)
  const dualLbl = lang === "ar" ? "ثنائي" : "Dual";
  const acKeys = [...byAc.keys()].sort();
  const rows: (string | number)[][] = acKeys.length === 0
    ? [[periodLabel, "—", "0.0", "0.0", "0.0", "0.0", "0.0", "0.0", "0.0", "0.0", "0.0", "0.0"]]
    : acKeys.map((ac) => {
        const b = byAc.get(ac)!;
        const total6 = b.day1 + b.day2 + b.dayDual + b.night1 + b.night2 + b.nightDual;
        return [
          periodLabel, ac,
          b.day1.toFixed(1), b.day2.toFixed(1), b.dayDual.toFixed(1),
          b.night1.toFixed(1), b.night2.toFixed(1), b.nightDual.toFixed(1),
          total6.toFixed(1),
          b.captain.toFixed(1), b.sim.toFixed(1), b.instrument.toFixed(1),
        ];
      });

  const grandTotal6 = grand.day1 + grand.day2 + grand.dayDual + grand.night1 + grand.night2 + grand.nightDual;

  autoTable(doc, {
    startY: yBanner + 2,
    head: [
      [
        { content: shape(tr("date_label", lang)), rowSpan: 2 },
        { content: lang === "ar" ? "نوع الطائرة" : "A/C Type", rowSpan: 2 },
        { content: shape(tr("col_day", lang)), colSpan: 3 },
        { content: shape(tr("col_night", lang)), colSpan: 3 },
        { content: lang === "ar" ? "الإجمالي (1-6)" : "Total (1-6)", rowSpan: 2 },
        { content: shape(tr("col_captain", lang)), rowSpan: 2 },
        { content: shape(tr("col_sim", lang)), rowSpan: 2 },
        { content: lang === "ar" ? "أجهزة فعلي" : "Instr Act", rowSpan: 2 },
      ],
      ["1P", "2P", dualLbl, "1P", "2P", dualLbl],
    ],
    body: rows,
    foot: [[
      { content: lang === "ar" ? "الإجمالي" : "TOTAL", colSpan: 2, styles: { halign: "right", fontStyle: "bold" } },
      grand.day1.toFixed(1), grand.day2.toFixed(1), grand.dayDual.toFixed(1),
      grand.night1.toFixed(1), grand.night2.toFixed(1), grand.nightDual.toFixed(1),
      { content: grandTotal6.toFixed(1), styles: { fontStyle: "bold" } },
      grand.captain.toFixed(1), grand.sim.toFixed(1), grand.instrument.toFixed(1),
    ]],
    styles: { fontSize: 8, cellPadding: 1.6, halign: "center", ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], halign: "center", ...tableStyles(lang) },
    footStyles: { fillColor: [240, 240, 230], textColor: [20, 24, 32], ...tableStyles(lang), fontStyle: "bold" },
    margin: { left: 8, right: 8 },
  });

  // Certification + 3 signature lines + stamp box
  let yC = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 12;
  doc.setFontSize(10);
  doc.text(
    shape(lang === "ar"
      ? `أصدّق صحة المعلومات للفترة من ${fmtDateShort(startDate)} إلى ${fmtDateShort(endDate)}.`
      : `Certified correct for the period from ${fmtDateShort(startDate)} to ${fmtDateShort(endDate)}.`),
    8, yC,
  );
  yC += 18;

  const sigW = 55;
  const blocks = lang === "ar"
    ? ["الطيار", "قائد السرب", "قائد الجناح"]
    : ["Self", "Sqdn Cdr", "Flight Cdr"];
  doc.setFontSize(9);
  blocks.forEach((label, i) => {
    const x = 10 + i * (sigW + 8);
    doc.line(x, yC, x + sigW, yC);
    doc.text(shape(label), x, yC + 5);
  });

  // Stamp box to the right of the signatures (or below if it overflows).
  const stampX = 10 + 3 * (sigW + 8) + 8;
  const stampW = 32, stampH = 22;
  if (stampX + stampW < 200) {
    doc.rect(stampX, yC - 16, stampW, stampH);
    doc.text(shape(lang === "ar" ? "ختم" : "Stamp"), stampX + 9, yC - 4);
  } else {
    doc.rect(10, yC + 12, stampW, stampH);
    doc.text(shape(lang === "ar" ? "ختم" : "Stamp"), 19, yC + 24);
  }

  footer(doc, lang);
  save(doc, `periodic-${scope.toLowerCase()}-${year}-${pilot.id}-${lang}-${fileStamp()}.pdf`);
}

export async function exportIndividualPilotRecord(
  sqdn: SquadronInfo, pilot: Pilot, sorties: Sortie[], lang: PdfLang = "en",
) {
  const emblem = await loadEmblem();
  const doc = await setupDoc(lang);
  drawHeader(doc, sqdn, `${lang === "ar" ? "السجل الكامل للطيار" : "Individual Pilot Record"} · ${pilotName(pilot, lang)}`, emblem, lang);

  // Identity block
  autoTable(doc, {
    startY: 42, theme: "grid",
    body: [
      [shape(tr("field_name", lang)), pilotName(pilot, lang), shape(tr("field_arabic", lang)), shape(pilot.arabicName || "—")],
      [shape(tr("field_id", lang)), pilot.id, shape(tr("field_unit", lang)), shape(pilot.unit)],
      [shape(tr("field_phone", lang)), pilot.phone || "—", shape(tr("field_address", lang)), shape(pilot.address || "—")],
      [shape(tr("field_available", lang)), pilot.available ? shape(tr("yes", lang)) : shape(tr("no", lang)),
       shape(tr("field_doctor", lang)), shape(pilot.doctorNote || "—")],
    ],
    styles: { fontSize: 9, cellPadding: 2, ...tableStyles(lang) },
    margin: { left: 8, right: 8 },
  });

  // H1/H2 + career hours
  let y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 4;
  doc.setFont(baseFont(lang), "normal"); doc.setFontSize(10); doc.setTextColor(20, 24, 32);
  doc.text(shape(tr("hoursSummary", lang)), 8, y);
  autoTable(doc, {
    startY: y + 2,
    head: [[shape(tr("col_bucket", lang)), shape(tr("col_day", lang)), shape(tr("col_night", lang)),
            shape(tr("col_nvg", lang)), shape(tr("col_sim", lang)), shape(tr("col_captain", lang))]],
    body: [
      [shape(tr("bucket_opening", lang)), pilot.openingDay.toFixed(1), pilot.openingNight.toFixed(1),
       pilot.openingNvg.toFixed(1), "—", "—"],
      // INITIAL HOURS (baseline) — pre-Hawk-Eye lifetime hours. Shown as a
      // separate row so the operator can see exactly what the baseline
      // contributes to the lifetime totals beneath it. Only printed when
      // a baseline exists. See `.local/memory/initial-hours.md`.
      // Skip the row entirely when every baseline bucket is zero — avoids
      // a noisy "0.0  0.0  0.0  —  0.0" line on legacy pilots whose JSONB
      // happens to carry an all-zero `initialHours` object.
      ...(pilot.initialHours && (
        (pilot.initialHours.day1 ?? 0) + (pilot.initialHours.day2 ?? 0) + (pilot.initialHours.dayDual ?? 0) +
        (pilot.initialHours.night1 ?? 0) + (pilot.initialHours.night2 ?? 0) + (pilot.initialHours.nightDual ?? 0) +
        (pilot.initialHours.nvg1 ?? 0) + (pilot.initialHours.nvg2 ?? 0) + (pilot.initialHours.nvgDual ?? 0) +
        (pilot.initialHours.captain ?? 0) + (pilot.initialHours.instrument ?? 0)
      ) > 0
        ? [[
            lang === "ar" ? "الساعات الأولية" : "Initial (baseline)",
            ((pilot.initialHours.day1 ?? 0) + (pilot.initialHours.day2 ?? 0) + (pilot.initialHours.dayDual ?? 0)).toFixed(1),
            ((pilot.initialHours.night1 ?? 0) + (pilot.initialHours.night2 ?? 0) + (pilot.initialHours.nightDual ?? 0)).toFixed(1),
            ((pilot.initialHours.nvg1 ?? 0) + (pilot.initialHours.nvg2 ?? 0) + (pilot.initialHours.nvgDual ?? 0)).toFixed(1),
            "—",
            (pilot.initialHours.captain ?? 0).toFixed(1),
          ]]
        : []),
      [shape(tr("bucket_month", lang)), pilot.monthDay.toFixed(1), pilot.monthNight.toFixed(1),
       pilot.monthNvg.toFixed(1), pilot.monthSim.toFixed(1), pilot.monthCaptain.toFixed(1)],
      [shape(tr("bucket_total", lang)), pilot.totalDay.toFixed(1), pilot.totalNight.toFixed(1),
       pilot.totalNvg.toFixed(1), pilot.totalSim.toFixed(1), pilot.totalCaptain.toFixed(1)],
    ],
    styles: { fontSize: 9, cellPadding: 2, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    margin: { left: 8, right: 8 },
  });

  // Currencies (color-coded)
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 4;
  doc.text(shape(tr("currencyExpiry", lang)), 8, y);
  const expiryKeys: ExpiryKey[] = ["day", "night", "nvg", "irt", "medical", "sim"];
  autoTable(doc, {
    startY: y + 2,
    head: [expiryKeys.map((k) => shape(tr(`exp_${k}` as keyof typeof STR, lang)))],
    body: [expiryKeys.map((k) => fmtDate(pilot.expiry[k]))],
    didParseCell: (data) => {
      if (data.section !== "body") return;
      const k = expiryKeys[data.column.index];
      data.cell.styles.fillColor = statusColour(pilot.expiry[k]);
      data.cell.styles.textColor = [20, 24, 32];
    },
    styles: { fontSize: 9, cellPadding: 2, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    margin: { left: 8, right: 8 },
  });

  // Last 30 sorties
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 4;
  doc.text(lang === "ar" ? "آخر 30 طلعة" : "Last 30 sorties", 8, y);
  const last30 = sorties
    .filter((s) => s.pilotId === pilot.id || s.coPilotId === pilot.id)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 30);
  autoTable(doc, {
    startY: y + 2,
    head: [[
      shape(tr("date_label", lang)),
      lang === "ar" ? "نوع الطائرة" : "AC",
      lang === "ar" ? "النوع" : "Mission",
      shape(tr("col_day", lang)),
      shape(tr("col_night", lang)),
      shape(tr("col_nvg", lang)),
      lang === "ar" ? "الفعلي" : "Actual",
    ]],
    body: last30.length === 0
      ? [[lang === "ar" ? "لا توجد طلعات" : "No sorties on record.", "", "", "", "", "", ""]]
      : last30.map((s) => [
          fmtDate(s.date),
          `${s.acType} ${s.acNumber}`.trim(),
          shape(s.sortieType || s.name || "—"),
          (s.day1 + s.day2 + s.dayDual).toFixed(1),
          (s.night1 + s.night2 + s.nightDual).toFixed(1),
          (s.nvg ?? 0).toFixed(1),
          (s.actual ?? 0).toFixed(1),
        ]),
    styles: { fontSize: 8.5, cellPadding: 1.4, ...tableStyles(lang) },
    headStyles: { fillColor: [20, 24, 32], textColor: [212, 175, 55], ...tableStyles(lang) },
    margin: { left: 8, right: 8 },
  });

  footer(doc, lang);
  save(doc, `pilot-record-${pilot.id}-${lang}-${fileStamp()}.pdf`);
}

export const PDF_EXPORTS = {
  authorization: exportAuthorizationReport,
  pilotData: exportPilotDataPages,
  totals: exportTotalsPage,
  summary: exportSquadronSummary,
  roster: exportRoster,
  currencyStatus: exportCurrencyStatus,
  sortieLog: exportSortieLog,
  rankings: exportRankings,
  externalPilots: exportExternalPilots,
  pilotLogbook: exportPilotLogbook,
  auditLog: exportAuditLog,
  remindersLog: exportRemindersLog,
  notams: exportNotams,
  navRoutes: exportNavRoutes,
  riskAssessment: exportRiskAssessment,
  flightSchedule: exportFlightSchedule,
  dutyWeek: exportDutyWeek,
  leaves: exportLeaves,
  cycle: exportCycle,
  individualPilotRecord: exportIndividualPilotRecord,
  periodicSummary: exportPeriodicSummary,
} as const;
