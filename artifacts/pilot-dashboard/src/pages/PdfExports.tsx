import { useEffect, useMemo, useRef, useState } from "react";
import DateInput from "@/components/DateInput";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import {
  usePilots, useSorties, useNotams, useDutyWeek, useLeaves,
  useSchedule, useAuditLog, useReminderOverview,
} from "@/lib/squadron-data";
import { supabaseConfigured } from "@/lib/supabase";
import { FileDown, FileText, Loader2, Globe, AlertTriangle, Info, Eye, X } from "lucide-react";
import {
  exportAuthorizationReport,
  exportPilotDataPages,
  exportTotalsPage,
  exportSquadronSummary,
  exportRoster,
  exportCurrencyStatus,
  exportSortieLog,
  exportRankings,
  exportExternalPilots,
  exportPilotLogbook,
  exportAuditLog,
  exportRemindersLog,
  exportNotams,
  exportNavRoutes,
  exportRiskAssessment,
  exportFlightSchedule,
  exportDutyWeek,
  exportLeaves,
  exportCycle,
  exportIndividualPilotRecord,
  exportPeriodicSummary,
  captureExport,
  type PdfLang,
  type PeriodicScope,
  type NavRouteLine,
  type RiskRow,
} from "@/lib/pdf";

// Today / 30-days-ago as ISO yyyy-mm-dd helpers — used to seed the
// date-range picker so the operator can hit "PDF" without first picking
// a range. The DD-MM-YYYY display is handled by the PDF helpers.
function isoToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

type Group = "perPilot" | "squadron" | "operational" | "admin";
interface ExportSpec {
  key: string;
  group: Group;
  title: string;
  desc: string;
  needsRange?: boolean;
  needsPilot?: boolean;
}

export default function PdfExports() {
  const { t, lang } = useI18n();
  const { squadron } = useAuth();
  const pilotsQ = usePilots();
  const sortiesQ = useSorties();
  const notamsQ = useNotams();
  const dutyQ = useDutyWeek();
  const leavesQ = useLeaves();
  const scheduleQ = useSchedule();
  const auditQ = useAuditLog();
  const remindersQ = useReminderOverview();

  const pilots = pilotsQ.data;
  const sorties = sortiesQ.data;
  const isDemo = !supabaseConfigured;
  const dataUnavailable = !isDemo && (pilotsQ.isError || sortiesQ.isError);
  const dataLoading = !isDemo && (pilotsQ.isLoading || sortiesQ.isLoading);
  const fetchError = pilotsQ.error ?? sortiesQ.error;

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Preview-modal state. We hold the generated PDF as both a Blob (for the
  // Download button — re-uses the same render, no second pass) and as an
  // object URL (for the iframe src). The URL is revoked on close so we
  // don't leak. `previewTitle` is the human-readable export name shown in
  // the modal header.
  const [preview, setPreview] = useState<{
    url: string;
    blob: Blob;
    filename: string;
    title: string;
  } | null>(null);
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  // PDF language defaults to the app language but the operator can flip
  // per-export — useful when the squadron commander wants an Arabic copy
  // while the dashboard runs in English.
  const [pdfLang, setPdfLang] = useState<PdfLang>(lang);
  const overridden = useRef(false);
  useEffect(() => { if (!overridden.current) setPdfLang(lang); }, [lang]);
  const choose = (l: PdfLang) => { overridden.current = true; setPdfLang(l); };

  // Date-range picker (default: last 30 days). Used by Sortie Log,
  // Pilot Logbook, Audit Log, etc.
  const [from, setFrom] = useState<string>(isoDaysAgo(30));
  const [to, setTo] = useState<string>(isoToday());

  // Per-pilot picker (default: first pilot in roster).
  // Year picker for the Periodic Summary (paper-logbook 6-month / annual
  // page). Defaults to the current calendar year. Operator can pick any of
  // the past three years from the dropdown — covers the typical retro-fill
  // window for missed signatures.
  const [pdfYear, setPdfYear] = useState<number>(new Date().getFullYear());

  const [pilotId, setPilotId] = useState<string>("");
  useEffect(() => {
    if (!pilotId && pilots.length > 0) setPilotId(pilots[0].id);
  }, [pilots, pilotId]);
  const pickedPilot = useMemo(() => pilots.find((p) => p.id === pilotId) ?? null, [pilots, pilotId]);

  const sqdn = {
    name: squadron?.name || "Squadron",
    number: squadron?.number || "",
    base: squadron?.base || "",
  };

  // Read nav routes from local storage where the Nav Routes page persists
  // them. Keeps this page decoupled from the Nav Routes implementation.
  const navRoutes = useMemo<NavRouteLine[]>(() => {
    try {
      const raw = localStorage.getItem("rjaf.navRoutes.v1");
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((r: { id?: string; name?: string; aircraft?: string; description?: string; estimatedHours?: number; waypoints?: { name?: string; coords?: string }[] }) => ({
        id: String(r.id ?? ""),
        name: String(r.name ?? "—"),
        aircraft: String(r.aircraft ?? "—"),
        description: r.description,
        estimatedHours: r.estimatedHours,
        waypoints: Array.isArray(r.waypoints) ? r.waypoints.map((w) => ({ name: String(w.name ?? ""), coords: w.coords })) : [],
      }));
    } catch { return []; }
  }, []);

  const EXPORTS: ExportSpec[] = [
    { key: "auth", group: "squadron", title: t("pdf_auth_title"), desc: t("pdf_auth_desc") },
    { key: "data", group: "squadron", title: t("pdf_data_title"), desc: t("pdf_data_desc") },
    { key: "totals", group: "squadron", title: t("pdf_totals_title"), desc: t("pdf_totals_desc") },
    { key: "summary", group: "squadron", title: t("pdf_summary_title"), desc: t("pdf_summary_desc") },
    { key: "roster", group: "squadron", title: lang === "ar" ? "كشف السرب" : "Squadron Roster", desc: lang === "ar" ? "كل الطيارين مع الوحدة والهاتف والحالة." : "Every pilot with unit, phone, availability." },
    { key: "rankings", group: "squadron", title: lang === "ar" ? "ترتيب الطيارين" : "Rankings", desc: lang === "ar" ? "مرتب حسب إجمالي الساعات." : "Sorted by total flight hours." },
    { key: "currency", group: "squadron", title: lang === "ar" ? "حالة المؤهلات" : "Currency Status", desc: lang === "ar" ? "ملوّن: أحمر / أصفر / أخضر." : "Color-coded — red / yellow / green." },
    { key: "external", group: "squadron", title: lang === "ar" ? "الطيارون الخارجيون" : "External Pilots", desc: lang === "ar" ? "ضيوف من أسراب أخرى مع الساعات." : "Guest pilots from other squadrons (with hours)." },
    { key: "cycleH1", group: "squadron", title: "Cycle · H1", desc: lang === "ar" ? "النصف الأول مع الهدف." : "First-half hours vs. target." },
    { key: "cycleH2", group: "squadron", title: "Cycle · H2", desc: lang === "ar" ? "النصف الثاني مع الهدف." : "Second-half hours vs. target." },

    { key: "sortieLog", group: "operational", title: lang === "ar" ? "سجل الطلعات" : "Sortie Log", desc: lang === "ar" ? "ضمن نطاق التاريخ المحدد." : "Within the selected date range.", needsRange: true },
    { key: "schedule", group: "operational", title: lang === "ar" ? "برنامج الطيران اليومي" : "Flight Schedule", desc: lang === "ar" ? "الجدول اليومي الحالي." : "Current daily flight sheet." },
    { key: "duty", group: "operational", title: lang === "ar" ? "أسبوع الجاهزية" : "Duty Week", desc: lang === "ar" ? "أسبوع كامل مع العداد الشهري." : "Per-period duty with monthly counter." },
    { key: "leaves", group: "operational", title: lang === "ar" ? "الإجازات" : "Leaves", desc: lang === "ar" ? "شبكة شهرية + الإجمالي." : "Monthly grid + totals." },
    { key: "navRoutes", group: "operational", title: lang === "ar" ? "مسارات الملاحة" : "Nav Routes", desc: lang === "ar" ? "كل المسارات مع نقاط الطريق والساعات التقديرية." : "All routes with waypoints + estimated hours." },
    { key: "risk", group: "operational", title: lang === "ar" ? "تقييم المخاطر" : "Risk Assessment", desc: lang === "ar" ? "العوامل والمستوى الإجمالي." : "Factors, weights, and overall level." },
    { key: "notams", group: "operational", title: "NOTAMs", desc: lang === "ar" ? "كل التعميمات الحالية." : "All current notices." },

    { key: "pilotLogbook", group: "perPilot", title: lang === "ar" ? "سجل طيران الطيار" : "Pilot Logbook", desc: lang === "ar" ? "طلعات طيار محدد ضمن نطاق تاريخ." : "Selected pilot, date-range filtered.", needsRange: true, needsPilot: true },
    { key: "pilotRecord", group: "perPilot", title: lang === "ar" ? "السجل الكامل للطيار" : "Individual Pilot Record", desc: lang === "ar" ? "ملف كامل: الهوية، الساعات، المؤهلات، آخر 30 طلعة." : "Full dossier — identity, hours, currencies, last 30 sorties.", needsPilot: true },
    // Periodic Summary — canonical 10-column RJAF paper-logbook page.
    // Three scopes: First Half (Jan-Jun), Second Half (Jul-Dec), Annual.
    // Year picker is shown in the controls strip above.
    { key: "periodicH1", group: "perPilot", title: lang === "ar" ? `ملخص دوري · النصف الأول · ${pdfYear}` : `Periodic Summary · H1 · ${pdfYear}`, desc: lang === "ar" ? "صفحة كتاب السجل الورقي للنصف الأول (يناير-يونيو)." : "Paper-logbook periodic summary page — Jan–Jun.", needsPilot: true },
    { key: "periodicH2", group: "perPilot", title: lang === "ar" ? `ملخص دوري · النصف الثاني · ${pdfYear}` : `Periodic Summary · H2 · ${pdfYear}`, desc: lang === "ar" ? "صفحة كتاب السجل الورقي للنصف الثاني (يوليو-ديسمبر)." : "Paper-logbook periodic summary page — Jul–Dec.", needsPilot: true },
    { key: "periodicAnnual", group: "perPilot", title: lang === "ar" ? `ملخص دوري · السنوي · ${pdfYear}` : `Periodic Summary · Annual · ${pdfYear}`, desc: lang === "ar" ? "صفحة كتاب السجل الورقي للسنة الكاملة." : "Paper-logbook periodic summary page — full calendar year.", needsPilot: true },

    { key: "audit", group: "admin", title: lang === "ar" ? "سجل التدقيق" : "Audit Log", desc: lang === "ar" ? "كل أحداث التحرير ضمن نطاق تاريخ." : "Every edit/delete within the date range.", needsRange: true },
    { key: "reminders", group: "admin", title: lang === "ar" ? "سجل التذكيرات" : "Reminders Log", desc: lang === "ar" ? "تذكيرات الطيارين المسجلة." : "Configured pilot reminders + last sent." },
  ];

  // Build the per-spec export closure. Used by both `run` (direct save)
  // and `runPreview` (captured into a Blob via captureExport so the modal
  // can show the same render before the operator commits to download).
  function buildExporter(spec: ExportSpec): () => Promise<void> {
    const r = { from, to };
    return async () => {
      switch (spec.key) {
        case "auth": await exportAuthorizationReport(sqdn, pilots, pdfLang); break;
        case "data": await exportPilotDataPages(sqdn, pilots, pdfLang); break;
        case "totals": await exportTotalsPage(sqdn, pilots, pdfLang); break;
        case "summary": await exportSquadronSummary(sqdn, pilots, sorties, pdfLang); break;
        case "roster": await exportRoster(sqdn, pilots, pdfLang); break;
        case "rankings": await exportRankings(sqdn, pilots, pdfLang); break;
        case "currency": await exportCurrencyStatus(sqdn, pilots, pdfLang); break;
        case "external": await exportExternalPilots(sqdn, sorties, pdfLang); break;
        case "cycleH1":
        case "cycleH2": {
          const half = spec.key === "cycleH1" ? "H1" : "H2";
          const target = 50;
          const rows = pilots.map((p) => ({
            pilot: p.name,
            h1: half === "H1" ? p.totalDay + p.totalNight : 0,
            h2: half === "H2" ? p.totalDay + p.totalNight : 0,
            target,
          }));
          await exportCycle(sqdn, half as "H1" | "H2", rows, pdfLang);
          break;
        }
        case "sortieLog": await exportSortieLog(sqdn, pilots, sorties, r, pdfLang); break;
        case "schedule": {
          const lines = scheduleQ.data.map((e) => ({
            ac: e.ac, config: e.config, crew: e.crew.join(" / "),
            mission: e.mission, takeoff: e.takeoff, land: e.land, fuel: e.fuel,
          }));
          await exportFlightSchedule(sqdn, isoToday(), lines, pdfLang); break;
        }
        case "duty": {
          const period = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
          const counters = new Map<string, number>();
          dutyQ.data.forEach((d) => {
            [d.mainDuty, d.standby, d.rcm].forEach((n) => { if (n && n !== "—") counters.set(n, (counters.get(n) ?? 0) + 1); });
          });
          const counterRows = [...counters.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
          await exportDutyWeek(sqdn, period, dutyQ.data, counterRows, pdfLang); break;
        }
        case "leaves": {
          const year = new Date().getFullYear();
          const pilotMap = new Map(pilots.map((p) => [p.id, p]));
          const rows = leavesQ.data.map((l) => ({
            pilot: pilotMap.get(l.pilotId)?.name ?? l.pilotId,
            months: l.months,
            total: l.total,
          }));
          await exportLeaves(sqdn, year, rows, pdfLang); break;
        }
        case "navRoutes": await exportNavRoutes(sqdn, navRoutes, pdfLang); break;
        case "risk": {
          const rows: RiskRow[] = [
            { factor: lang === "ar" ? "الطقس" : "Weather", weight: 3, score: 2 },
            { factor: lang === "ar" ? "الطاقم" : "Crew", weight: 2, score: 1 },
            { factor: lang === "ar" ? "المهمة" : "Mission", weight: 4, score: 3 },
            { factor: lang === "ar" ? "الطائرة" : "Aircraft", weight: 2, score: 1 },
          ];
          const total = rows.reduce((s, r) => s + r.weight * r.score, 0);
          const level = total < 15 ? (lang === "ar" ? "منخفض" : "Low") : total < 30 ? (lang === "ar" ? "متوسط" : "Medium") : (lang === "ar" ? "عالي" : "High");
          await exportRiskAssessment(sqdn, rows, total, level, pdfLang); break;
        }
        case "notams": await exportNotams(sqdn, notamsQ.data, pdfLang); break;
        case "pilotLogbook": {
          if (!pickedPilot) throw new Error("No pilot selected");
          await exportPilotLogbook(sqdn, pickedPilot, sorties, r, pdfLang); break;
        }
        case "pilotRecord": {
          if (!pickedPilot) throw new Error("No pilot selected");
          await exportIndividualPilotRecord(sqdn, pickedPilot, sorties, pdfLang); break;
        }
        case "periodicH1":
        case "periodicH2":
        case "periodicAnnual": {
          if (!pickedPilot) throw new Error("No pilot selected");
          const scope: PeriodicScope =
            spec.key === "periodicH1" ? "H1"
            : spec.key === "periodicH2" ? "H2"
            : "FULL";
          await exportPeriodicSummary(sqdn, pickedPilot, sorties, pdfYear, scope, pdfLang);
          break;
        }
        case "audit": {
          const rows = auditQ.data.map((a) => ({
            at: a.ts, user: a.user, action: a.action,
            entity: a.target, detail: undefined,
          }));
          await exportAuditLog(sqdn, rows, r, pdfLang); break;
        }
        case "reminders": {
          const pilotMap = new Map(pilots.map((p) => [p.id, p]));
          const rows = remindersQ.data.map((row) => {
            const enabledKeys = Object.keys(row.thresholds).filter((k) => (row.thresholds as Record<string, number[] | undefined>)[k]?.length);
            const allThresholds = Object.values(row.thresholds).flat().filter((v): v is number => typeof v === "number");
            return {
              pilot: pilotMap.get(row.pilotId)?.name ?? row.pilotId,
              type: enabledKeys.join(", ") || (row.pushEnabled ? "push" : "—"),
              threshold: allThresholds.length ? allThresholds.join(", ") : "—",
              lastSent: row.lastSentAt ?? undefined,
              nextDue: row.lastSentExpiry ?? undefined,
            };
          });
          await exportRemindersLog(sqdn, rows, pdfLang); break;
        }
      }
    };
  }

  // Direct save — preserves the original "click PDF, file lands in
  // Downloads" flow for operators who don't want a preview step.
  async function run(spec: ExportSpec) {
    if (dataUnavailable) { setError(t("pdf_data_unavailable")); return; }
    setBusy(spec.key);
    setError(null);
    try {
      await buildExporter(spec)();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate PDF");
    } finally {
      setBusy(null);
    }
  }

  // Preview — render the PDF into a Blob and open the modal viewer. The
  // same Blob backs the modal's Download button so the operator sees the
  // exact bytes that will be saved (no second render, no risk of drift
  // between preview and download).
  async function runPreview(spec: ExportSpec) {
    if (dataUnavailable) { setError(t("pdf_data_unavailable")); return; }
    setBusy(`preview:${spec.key}`);
    setError(null);
    try {
      const cap = await captureExport(buildExporter(spec));
      const url = URL.createObjectURL(cap.blob);
      setPreview({ url, blob: cap.blob, filename: cap.filename, title: spec.title });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate PDF");
    } finally {
      setBusy(null);
    }
  }

  // Download the previewed PDF. Re-uses the captured Blob so it's exactly
  // what the operator just verified — no re-render.
  function downloadPreview() {
    if (!preview) return;
    const a = document.createElement("a");
    a.href = preview.url;
    a.download = preview.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function closePreview() {
    // The useEffect cleanup above revokes the object URL when `preview`
    // changes (or the component unmounts), so we just clear the state.
    setPreview(null);
  }

  const groups: { id: Group; title: string }[] = [
    { id: "perPilot", title: lang === "ar" ? "لكل طيار" : "Per pilot" },
    { id: "squadron", title: lang === "ar" ? "السرب" : "Squadron" },
    { id: "operational", title: lang === "ar" ? "تشغيلي" : "Operational" },
    { id: "admin", title: lang === "ar" ? "إداري" : "Admin" },
  ];

  return (
    <div>
      <PageHead title={t("nav_pdf")} subtitle={t("pdf_subtitle")} />

      {/* Controls strip */}
      <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-amber-400" />
          <span className="text-muted-foreground">{t("pdf_language")}:</span>
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            <button
              onClick={() => choose("en")}
              data-testid="button-pdflang-en"
              className={`px-3 py-1 text-xs ${pdfLang === "en" ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`}
            >English</button>
            <button
              onClick={() => choose("ar")}
              data-testid="button-pdflang-ar"
              className={`px-3 py-1 text-xs ${pdfLang === "ar" ? "bg-primary text-primary-foreground" : "hover:bg-secondary"}`}
            >العربية</button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{lang === "ar" ? "النطاق" : "Range"}:</span>
          <DateInput value={from} onChange={setFrom}
            className="text-xs px-2 py-1 rounded-md border border-border bg-background"
            data-testid="input-pdf-from" />
          <span className="text-muted-foreground">→</span>
          <DateInput value={to} onChange={setTo}
            className="text-xs px-2 py-1 rounded-md border border-border bg-background"
            data-testid="input-pdf-to" />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{lang === "ar" ? "السنة" : "Year"}:</span>
          <select value={pdfYear} onChange={(e) => setPdfYear(Number(e.target.value))}
            className="text-xs px-2 py-1 rounded-md border border-border bg-background"
            data-testid="select-pdf-year">
            {[0, 1, 2, 3].map((d) => {
              const y = new Date().getFullYear() - d;
              return <option key={y} value={y}>{y}</option>;
            })}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{lang === "ar" ? "الطيار" : "Pilot"}:</span>
          <select value={pilotId} onChange={(e) => setPilotId(e.target.value)}
            className="text-xs px-2 py-1 rounded-md border border-border bg-background"
            data-testid="select-pdf-pilot">
            {pilots.map((p) => (
              <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
            ))}
          </select>
        </div>
      </div>

      {isDemo && (
        <div data-testid="banner-pdf-demo"
          className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200 flex items-start gap-2">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{t("pdf_demo_notice")}</span>
        </div>
      )}
      {dataUnavailable && (
        <div data-testid="banner-pdf-unavailable"
          className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="font-medium">{t("pdf_data_unavailable")}</div>
            {fetchError instanceof Error && (
              <div className="text-xs text-red-300/80 mt-0.5">{fetchError.message}</div>
            )}
          </div>
          <button onClick={() => { pilotsQ.refetch(); sortiesQ.refetch(); }}
            data-testid="button-pdf-retry"
            className="px-2 py-1 rounded-md border border-red-500/40 text-xs hover:bg-red-500/20">
            {t("pdf_retry")}
          </button>
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300"
          data-testid="banner-pdf-error">
          {error}
        </div>
      )}

      {groups.map((g) => {
        const items = EXPORTS.filter((e) => e.group === g.id);
        if (items.length === 0) return null;
        return (
          <section key={g.id} className="mb-6">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">{g.title}</h2>
            <div className="grid md:grid-cols-2 gap-3">
              {items.map((e) => {
                const isBusy = busy === e.key;
                const isPreviewBusy = busy === `preview:${e.key}`;
                const disabled = busy !== null || dataUnavailable || dataLoading || (e.needsPilot && !pickedPilot);
                return (
                  <Card key={e.key} className="flex items-start gap-3">
                    <FileText className="h-8 w-8 text-amber-400 shrink-0" />
                    <div className="flex-1">
                      <div className="text-sm font-semibold">{e.title}</div>
                      <div className="text-xs text-muted-foreground">{e.desc}</div>
                      {e.needsRange && (
                        <div className="text-[10px] text-muted-foreground/70 mt-1">{lang === "ar" ? "يستخدم نطاق التاريخ أعلاه" : "Uses the date range above"}</div>
                      )}
                      {e.needsPilot && (
                        <div className="text-[10px] text-muted-foreground/70 mt-1">{lang === "ar" ? "يستخدم الطيار المحدد أعلاه" : "Uses the selected pilot above"}</div>
                      )}
                    </div>
                    <div className="flex flex-col gap-1.5 shrink-0">
                      <button onClick={() => run(e)}
                        disabled={disabled}
                        title={dataUnavailable ? t("pdf_data_unavailable") : undefined}
                        data-testid={`button-pdf-${e.key}`}
                        className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm inline-flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed">
                        {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
                        PDF
                      </button>
                      <button onClick={() => runPreview(e)}
                        disabled={disabled}
                        title={dataUnavailable ? t("pdf_data_unavailable") : (lang === "ar" ? "معاينة قبل التنزيل" : "Preview before downloading")}
                        data-testid={`button-pdf-preview-${e.key}`}
                        className="px-3 py-1.5 rounded-md border border-border bg-secondary text-foreground text-sm inline-flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed">
                        {isPreviewBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
                        {lang === "ar" ? "معاينة" : "Preview"}
                      </button>
                    </div>
                  </Card>
                );
              })}
            </div>
          </section>
        );
      })}

      {/* Preview modal — shows the freshly generated PDF in an iframe so
          operators can verify Arabic shaping, layout, and pilot names
          before committing the file to disk. The Download button reuses
          the same Blob (no second render) so what they see is exactly
          what they get. */}
      {preview && (
        <div
          data-testid="modal-pdf-preview"
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={closePreview}
        >
          <div
            className="bg-card border border-border rounded-lg shadow-2xl w-full max-w-5xl h-[90vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 p-3 border-b border-border">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="h-5 w-5 text-amber-400 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate" data-testid="text-pdf-preview-title">{preview.title}</div>
                  <div className="text-xs text-muted-foreground truncate">{preview.filename}</div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={downloadPreview}
                  data-testid="button-pdf-preview-download"
                  className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm inline-flex items-center gap-1.5"
                >
                  <FileDown className="h-4 w-4" />
                  {pdfLang === "ar" ? "تنزيل" : "Download"}
                </button>
                <button
                  onClick={closePreview}
                  data-testid="button-pdf-preview-close"
                  aria-label={pdfLang === "ar" ? "إغلاق" : "Close"}
                  className="px-2 py-1.5 rounded-md border border-border bg-secondary text-foreground text-sm inline-flex items-center gap-1.5"
                >
                  <X className="h-4 w-4" />
                  <span>{pdfLang === "ar" ? "إغلاق" : "Close"}</span>
                </button>
              </div>
            </div>
            <iframe
              src={preview.url}
              title={preview.title}
              data-testid="iframe-pdf-preview"
              className="flex-1 w-full bg-white rounded-b-lg"
            />
          </div>
        </div>
      )}
    </div>
  );
}
