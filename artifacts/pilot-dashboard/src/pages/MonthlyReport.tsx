import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { Printer, Wand2, Save, ChevronDown, ChevronUp, FileText, Plus, Trash2, Settings } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { PageHead } from "@/components/Layout";
import { useAuth } from "@/lib/auth";
import { usePilots, useSorties, useLeaves, useUnavailable } from "@/lib/squadron-data";
import {
  buildForm1Rows, buildForm2Rows, buildForm3, buildArabicRoster,
  buildAuthorizationLog, buildMissionSolo, buildPLeaves,
  buildSixMonths, buildDualHours,
  lastCompletedPeriod, loadInputsOrPrefill, saveInputs,
  periodLabel, MISSION_BUCKETS, MISSION_LABEL,
  deriveForm3Stats, suggestNextMonthPlanFrom, suggestRemarksFor,
  type ReportInputs,
} from "@/lib/monthly-report";
import { loadSquadronDefaults, fuelBurnFor } from "@/lib/squadron-defaults";

const round1 = (n: number) => Math.round(n * 10) / 10;

export default function MonthlyReport() {
  const { t } = useI18n();
  const { squadron, user } = useAuth();
  const { data: pilots = [] } = usePilots();
  const { data: sorties = [] } = useSorties();
  const { data: leaves = [] } = useLeaves();
  const { data: unavail = [] } = useUnavailable();

  const sqdnNumberForDefaults = squadron?.number || "8";
  const defaults = useMemo(
    () => loadSquadronDefaults(sqdnNumberForDefaults),
    [sqdnNumberForDefaults],
  );
  // Primary airframe + fuel-burn rate, used as the placeholder/default in
  // the Form 4 / FUEL formula when a row has no explicit override. The
  // operator edits the airframe name + rate on the Squadron defaults page
  // and any per-row overrides on the wizard.
  const primaryAirframe = defaults.primaryAirframe || "UH-60M";
  const groupName = defaults.groupName || "QUICK REACTION FORCE GROUP";
  const groupAcronym = defaults.groupAcronym || "QRFG";
  const defaultFuelHr = useMemo(() => fuelBurnFor(defaults, primaryAirframe), [defaults, primaryAirframe]);

  const [period, setPeriod] = useState<string>(() => lastCompletedPeriod());
  const [inputs, setInputs] = useState<ReportInputs>(() =>
    loadInputsOrPrefill(period, [], defaults));
  const [wizardOpen, setWizardOpen] = useState(true);
  const [saved, setSaved] = useState(false);

  // Reload persisted inputs whenever the period changes. Falls back to
  // last-month-as-this-month prefill, then to squadron defaults.
  useEffect(() => {
    setInputs(loadInputsOrPrefill(period, pilots, defaults));
  }, [period, pilots.length, defaults]);

  // Effective per-pilot REMARKS — when the operator hasn't typed anything
  // and the squadron has auto-suggest enabled, fill from the leave/
  // unavailability records so the printed Form 1 shows the suggested text
  // automatically (operator can still override at any time by typing).
  // The wizard's "Use" button still exists as an explicit accept gesture
  // when the operator wants to lock the suggestion into saved inputs.
  const effectiveRemarks = useMemo(() => {
    if (!defaults.autoSuggestRemarks) return inputs.perPilotRemarks;
    const next: Record<string, string> = { ...inputs.perPilotRemarks };
    for (const p of pilots) {
      if (next[p.id]) continue;
      const s = suggestRemarksFor(p, period, leaves, unavail);
      if (s) next[p.id] = s;
    }
    return next;
  }, [defaults.autoSuggestRemarks, inputs.perPilotRemarks, pilots, period, leaves, unavail]);

  const inputsForRender = useMemo(
    () => ({ ...inputs, perPilotRemarks: effectiveRemarks }),
    [inputs, effectiveRemarks],
  );

  const form1 = useMemo(() =>
    buildForm1Rows(pilots, sorties, period, inputsForRender), [pilots, sorties, period, inputsForRender]);
  const form2 = useMemo(() =>
    buildForm2Rows(pilots, sorties, period, form1), [pilots, sorties, period, form1]);
  const form3 = useMemo(() =>
    buildForm3(sorties, period), [sorties, period]);
  const form3Stats = useMemo(() =>
    deriveForm3Stats(inputs, form3), [inputs, form3]);
  const arabicRoster = useMemo(() =>
    buildArabicRoster(pilots, sorties, period, form1), [pilots, sorties, period, form1]);

  // ── Appendix sheets (all derived AUTO data) ──────────────────────────
  const authLog = useMemo(() =>
    buildAuthorizationLog(sorties, pilots, period), [sorties, pilots, period]);
  const missionSolo = useMemo(() =>
    buildMissionSolo(pilots, sorties, period), [pilots, sorties, period]);
  const pLeaves = useMemo(() =>
    buildPLeaves(pilots, leaves), [pilots, leaves]);
  const sixMonths = useMemo(() =>
    buildSixMonths(pilots, sorties, period, defaults.minSixMonthHours),
    [pilots, sorties, period, defaults.minSixMonthHours]);
  // Six-month header labels derived from the report period itself — used
  // by the printed thead AND the empty-state colSpan, so the table stays
  // structurally aligned even when there are no pilots in the roster.
  const sixMonthHeaders = useMemo(() => {
    const labels = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
    const [y0, m0] = period.split("-").map(Number);
    const out: { period: string; label: string; year: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(y0, m0 - 1 - i, 1);
      out.push({
        period: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`,
        label: labels[d.getMonth()],
        year: d.getFullYear(),
      });
    }
    return out;
  }, [period]);
  const dualHours = useMemo(() =>
    buildDualHours(pilots, sorties, period), [pilots, sorties, period]);

  // Authorization log totals (printed at the foot of the AUTH sheet)
  const authLogTotals = useMemo(() => authLog.reduce((a, r) => ({
    day1: round1(a.day1 + r.day1),  day2: round1(a.day2 + r.day2),  dayDual: round1(a.dayDual + r.dayDual),
    night1: round1(a.night1 + r.night1), night2: round1(a.night2 + r.night2), nightDual: round1(a.nightDual + r.nightDual),
    nvg: round1(a.nvg + r.nvg),
    ifSim: round1(a.ifSim + r.ifSim), ifAct: round1(a.ifAct + r.ifAct),
    total: round1(a.total + r.total),
    sorties: a.sorties + 1,
  }), { day1:0,day2:0,dayDual:0,night1:0,night2:0,nightDual:0,nvg:0,ifSim:0,ifAct:0,total:0,sorties:0 }), [authLog]);

  // Form 1 totals row — sum of all per-pilot columns. Officer can compare
  // this against squadron-wide reports without manually adding numbers.
  const form1Totals = useMemo(() => form1.reduce((a, r) => ({
    day1:      round1(a.day1 + r.day1),
    day2:      round1(a.day2 + r.day2),
    dayDual:   round1(a.dayDual + r.dayDual),
    night1:    round1(a.night1 + r.night1),
    night2:    round1(a.night2 + r.night2),
    nightDual: round1(a.nightDual + r.nightDual),
    nvg:       round1(a.nvg + r.nvg),
    totalForMonth: round1(a.totalForMonth + r.totalForMonth),
    cap:       a.cap + r.cap,
    sor:       a.sor + r.sor,
    ifSim:     round1(a.ifSim + r.ifSim),
    ifAct:     round1(a.ifAct + r.ifAct),
  }), { day1:0,day2:0,dayDual:0,night1:0,night2:0,nightDual:0,nvg:0,totalForMonth:0,cap:0,sor:0,ifSim:0,ifAct:0 }), [form1]);

  const form2Totals = useMemo(() => form2.reduce((a, r) => ({
    totalForMonthAllTypes: round1(a.totalForMonthAllTypes + r.totalForMonthAllTypes),
    grandTotal:            round1(a.grandTotal + r.grandTotal),
    ifSimMonth:            round1(a.ifSimMonth + r.ifSimMonth),
    ifActMonth:            round1(a.ifActMonth + r.ifActMonth),
    ifSimTotal:            round1(a.ifSimTotal + r.ifSimTotal),
    ifActTotal:            round1(a.ifActTotal + r.ifActTotal),
  }), { totalForMonthAllTypes:0, grandTotal:0, ifSimMonth:0, ifActMonth:0, ifSimTotal:0, ifActTotal:0 }), [form2]);

  const onSave = () => {
    saveInputs(period, inputs);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  const onAutoFill = () => {
    // Use last month's actual achievement as a starting estimate for both
    // "planned" (this month's plan was made before the month started) and
    // the next-month plan. Officer can tweak in seconds.
    const prevPeriod = (() => {
      const [y,m] = period.split("-").map(Number);
      const d = new Date(y, m - 2, 1);
      return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
    })();
    const prevStats = buildForm3(sorties, prevPeriod);
    const suggestion = suggestNextMonthPlanFrom({ sorties: prevStats.achievedSorties, hours: prevStats.achievedHours });
    setInputs(curr => ({
      ...curr,
      squadronStrength: pilots.length,
      ops: pilots.filter(p => p.unit === "SQDN").length,
      attached: pilots.filter(p => p.unit === "HQ Attached").length,
      pilotsAvailableNext: pilots.length,
      plannedSorties: curr.plannedSorties || suggestion.plannedSorties,
      plannedHours:   curr.plannedHours   || suggestion.plannedHours,
    }));
  };

  const updI = <K extends keyof ReportInputs>(k: K, v: ReportInputs[K]) =>
    setInputs(p => ({ ...p, [k]: v }));

  const sqdnNumber = squadron?.number || "8";
  const sqdnName = squadron?.name || "8 SQDN";
  const monthHeader = periodLabel(period).toUpperCase();
  const nextMonthHeader = periodLabel(inputs.nextMonthPlanFor).toUpperCase();

  // OPS-ONLY ACCESS LOCK
  // Placed AFTER all hooks (above) so React's hook-call order is stable
  // across role transitions on this PC. The Monthly Report is locked to
  // the Operations Pilot account on the squadron PC; other roles never
  // see it (commander tiers, deputy, HQ).
  if (user?.role !== "ops") {
    return (
      <div className="p-6">
        <PageHead
          title={t("monthlyReportTitle")}
          subtitle="Operations Pilot PC only"
          actions={null}
        />
        <div className="bg-card border border-border rounded-lg p-8 text-center text-sm text-muted-foreground"
          data-testid="monthly-report-ops-lock">
          The Monthly Report is maintained by the Operations Pilot. Sign in
          on the squadron's operations PC to view, edit, and print it.
        </div>
      </div>
    );
  }

  return (
    <div className="monthly-report print-area">
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .monthly-report { background: white !important; color: black !important; }
          body { background: white !important; }
          .form-page { page-break-after: always; padding: 12mm !important; }
          .form-page table { color: black !important; }
          .form-page table, .form-page th, .form-page td { border-color: #000 !important; }
          /* Front-sheet duplex behaviour: Form 1 (and the optional NVG
             section on its back) make up one duplex paper. The element
             that closes the front sheet forces the next form onto the
             FRONT of the next sheet (a right-side page), so when NVG
             is empty the back stays blank and the operator can simply
             print single-sided. When NVG is present, Form 1 → NVG → next
             form lands on sheet 2 front naturally. */
          .form-page-front-end { page-break-after: right !important; }
          .nvg-back-page { display: none; }
          .nvg-back-page.nvg-active { display: block; page-break-after: right !important; }
        }
        @media screen {
          .nvg-back-page.nvg-empty { display: none; }
        }
        .form-page { background: white; color: #111; padding: 18px; border-radius: 8px; margin-bottom: 16px; }
        .form-page table { width: 100%; border-collapse: collapse; font-size: 10px; }
        .form-page th, .form-page td { border: 1px solid #444; padding: 3px 4px; vertical-align: middle; }
        .form-page th { background: #eee; text-align: center; font-weight: 600; }
        .form-page td.num { text-align: right; font-variant-numeric: tabular-nums; }
        .form-page td.center { text-align: center; }
        .form-page .form-title { text-align: center; font-weight: 700; margin-bottom: 4px; font-size: 12px; }
        .form-page .form-sub { text-align: center; font-style: italic; margin-bottom: 8px; font-size: 11px; }
        .form-page .form-meta { display: flex; justify-content: space-between; font-size: 10px; margin-bottom: 6px; }
        .form-page .secret { text-align: center; font-style: italic; font-size: 9px; color: #555; }
      `}</style>

      <PageHead
        title={t("monthlyReportTitle")}
        subtitle={t("monthlyReportSubtitle")}
        actions={
          <div className="flex gap-2 no-print">
            <input type="month" value={period} onChange={e => setPeriod(e.target.value)}
              className="text-xs px-2 py-1.5 rounded-md border border-border bg-background"
              data-testid="input-monthly-period" />
            <Link href="/monthly-report/defaults"
              className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-secondary inline-flex items-center gap-1"
              data-testid="link-monthly-defaults">
              <Settings className="h-3.5 w-3.5" /> Squadron defaults
            </Link>
            <button onClick={onAutoFill}
              className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-secondary inline-flex items-center gap-1"
              data-testid="button-monthly-autofill">
              <Wand2 className="h-3.5 w-3.5" /> {t("monthlyAutoFill")}
            </button>
            <button onClick={onSave}
              className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-secondary inline-flex items-center gap-1"
              data-testid="button-monthly-save">
              <Save className="h-3.5 w-3.5" /> {saved ? t("opsTeamCopied") : t("save_changes")}
            </button>
            <button onClick={() => window.print()}
              className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground font-medium inline-flex items-center gap-1"
              data-testid="button-monthly-print">
              <Printer className="h-3.5 w-3.5" /> {t("monthlyPrint")}
            </button>
          </div>
        }
      />

      {/* Wizard */}
      <section className="bg-card border border-border rounded-lg p-4 mb-4 no-print">
        <button onClick={() => setWizardOpen(o => !o)}
          className="w-full flex items-center justify-between text-sm font-semibold mb-2"
          data-testid="button-monthly-wizard-toggle">
          <span className="inline-flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" /> {t("monthlyWizardTitle")}
          </span>
          {wizardOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        <p className="text-xs text-muted-foreground mb-2">{t("monthlyWizardBlurb")}</p>

        {/* Provenance legend — explains where each kind of value comes from */}
        <div className="flex flex-wrap gap-2 mb-3 text-[10px]" data-testid="provenance-legend">
          <Badge tone="auto">AUTO</Badge>
          <span className="text-muted-foreground">pulled from sortie log / roster / currency</span>
          <span className="text-muted-foreground/50">·</span>
          <Badge tone="default">DEFAULT</Badge>
          <span className="text-muted-foreground">squadron baseline or last month — editable</span>
          <span className="text-muted-foreground/50">·</span>
          <Badge tone="manual">MANUAL</Badge>
          <span className="text-muted-foreground">commander judgement — type each month</span>
        </div>

        {wizardOpen && (
          <div className="space-y-4">
            {/* Squadron header values */}
            <div className="text-[11px] font-semibold text-muted-foreground inline-flex items-center gap-2">
              SQUADRON HEADER <Badge tone="manual">MANUAL</Badge> <Badge tone="default">DEFAULT</Badge>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                ["squadronStrength","SQDN STRENGTH"],
                ["ops","OPS"],
                ["attached","ATTACHED"],
                ["course","COURSE"],
                ["sickLeave","SICK LEAVE"],
                ["sickRatePct","SICK RATE %"],
              ].map(([k,label]) => (
                <NumField key={k} label={label} value={(inputs as any)[k]} onChange={v => updI(k as any, v as any)} testId={`input-mr-${k}`} />
              ))}
              <div>
                <label className="text-xs text-muted-foreground">DISCIPLINE MORALE</label>
                <select value={inputs.morale} onChange={e => updI("morale", e.target.value as any)}
                  className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm"
                  data-testid="input-mr-morale">
                  <option>HIGH</option><option>MEDIUM</option><option>LOW</option>
                </select>
              </div>
              <TextField label="INCIDENTS" value={inputs.incidents} onChange={v => updI("incidents", v)} testId="input-mr-incidents" />
              <TextField label="ACCIDENTS" value={inputs.accidents} onChange={v => updI("accidents", v)} testId="input-mr-accidents" />
            </div>

            {/* Planned + aborts */}
            <div className="text-[11px] font-semibold text-muted-foreground inline-flex items-center gap-2">
              PLANNED &amp; ABORTS <Badge tone="manual">MANUAL</Badge>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <NumField label="PLANNED SORTIES" value={inputs.plannedSorties} onChange={v => updI("plannedSorties", v)} testId="input-mr-plannedS" />
              <NumField label="PLANNED HOURS" value={inputs.plannedHours} onChange={v => updI("plannedHours", v)} step={0.1} testId="input-mr-plannedH" />
              <AbortPair label="WX ABORT" s={inputs.weatherAbortS} h={inputs.weatherAbortH} onS={v=>updI("weatherAbortS",v)} onH={v=>updI("weatherAbortH",v)} testId="wx" />
              <AbortPair label="MAINT" s={inputs.maintAbortS} h={inputs.maintAbortH} onS={v=>updI("maintAbortS",v)} onH={v=>updI("maintAbortH",v)} testId="maint" />
              <AbortPair label="OPS ABORT" s={inputs.opsAbortS} h={inputs.opsAbortH} onS={v=>updI("opsAbortS",v)} onH={v=>updI("opsAbortH",v)} testId="ops" />
              <AbortPair label="AIR ABORT" s={inputs.airAbortS} h={inputs.airAbortH} onS={v=>updI("airAbortS",v)} onH={v=>updI("airAbortH",v)} testId="air" />
            </div>

            {/* Lectures */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs font-semibold inline-flex items-center gap-2">
                  LECTURES <Badge tone="default">DEFAULT</Badge> <Badge tone="manual">MANUAL</Badge>
                  <span className="text-[10px] font-normal text-muted-foreground">topics from squadron defaults · hours/quiz typed each month</span>
                </div>
                <button onClick={() => updI("lectures", [...inputs.lectures, { name: "", hours: 0, quizPct: 0, remarks: "" }])}
                  className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-secondary inline-flex items-center gap-1"
                  data-testid="button-mr-add-lecture">
                  <Plus className="h-3 w-3" /> Add lecture
                </button>
              </div>
              <div className="space-y-1">
                {inputs.lectures.map((lec, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2 items-center text-xs">
                    <input value={lec.name}
                      placeholder="Lecture name (EN/AR)"
                      dir="auto"
                      onChange={e => {
                        const next = [...inputs.lectures];
                        next[i] = { ...lec, name: e.target.value };
                        updI("lectures", next);
                      }}
                      className="col-span-3 bg-background border border-border rounded px-2 py-1"
                      data-testid={`input-mr-lec-n-${i}`} />
                    <input type="number" step="0.1" placeholder="Hours" value={lec.hours}
                      onChange={e => {
                        const next = [...inputs.lectures];
                        next[i] = { ...lec, hours: parseFloat(e.target.value) || 0 };
                        updI("lectures", next);
                      }}
                      className="col-span-2 bg-background border border-border rounded px-2 py-1"
                      data-testid={`input-mr-lec-h-${i}`} />
                    <input type="number" step="1" min="0" max="100" placeholder="Quiz%" value={lec.quizPct}
                      onChange={e => {
                        const next = [...inputs.lectures];
                        next[i] = { ...lec, quizPct: parseFloat(e.target.value) || 0 };
                        updI("lectures", next);
                      }}
                      className="col-span-2 bg-background border border-border rounded px-2 py-1"
                      data-testid={`input-mr-lec-q-${i}`} />
                    <input value={lec.remarks}
                      onChange={e => {
                        const next = [...inputs.lectures];
                        next[i] = { ...lec, remarks: e.target.value };
                        updI("lectures", next);
                      }}
                      placeholder="Remarks (EN/AR)"
                      dir="auto"
                      className="col-span-4 bg-background border border-border rounded px-2 py-1" />
                    <button onClick={() => {
                        if (!confirm("Remove this lecture row?")) return;
                        updI("lectures", inputs.lectures.filter((_, idx) => idx !== i));
                      }}
                      className="col-span-1 text-destructive hover:bg-secondary rounded p-1 inline-flex items-center justify-center"
                      data-testid={`button-mr-del-lecture-${i}`} title="Remove">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Form 4 next-month plan */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs font-semibold inline-flex items-center gap-2">
                  PLAN FOR {nextMonthHeader} <Badge tone="default">DEFAULT</Badge> <Badge tone="manual">MANUAL</Badge>
                  <span className="text-[10px] font-normal text-muted-foreground">
                    formulas: pilots × s/p = sorties · sorties × dur = hours · hours × fuel/hr = lb fuel
                  </span>
                </div>
                <button onClick={() => updI("nextPlan", [...inputs.nextPlan, { exercise: "", pilots: 0, sortiesPerPilot: 0, durationPerSortie: 0, ammo275: "-", ammo127: "-", ammo762: "-", remarks: "" }])}
                  className="text-[10px] px-2 py-0.5 rounded border border-border hover:bg-secondary inline-flex items-center gap-1"
                  data-testid="button-mr-add-plan">
                  <Plus className="h-3 w-3" /> Add exercise
                </button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-2">
                <NumField label="PILOTS AVAILABLE" value={inputs.pilotsAvailableNext} onChange={v => updI("pilotsAvailableNext", v)} testId="input-mr-pilots-next" />
                <NumField label="OPS" value={inputs.opsNext} onChange={v => updI("opsNext", v)} testId="input-mr-ops-next" />
              </div>
              <div className="space-y-1">
                {inputs.nextPlan.map((row, i) => {
                  const fuelHr = row.fuelPerHourOverride ?? defaultFuelHr;
                  const totalSorties = row.pilots * row.sortiesPerPilot;
                  const totalHours = totalSorties * row.durationPerSortie;
                  const totalFuel = totalHours * fuelHr;
                  const fuelOverridden = row.fuelPerHourOverride != null;
                  return (
                    <div key={i} className="space-y-0.5 border-b border-border/40 pb-1 last:border-b-0">
                      <div className="grid grid-cols-12 gap-2 items-center text-xs">
                        <input value={row.exercise} placeholder="Exercise (EN/AR)"
                          dir="auto"
                          onChange={e => updPlan(inputs, updI, i, { exercise: e.target.value })}
                          className="col-span-2 bg-background border border-border rounded px-2 py-1"
                          data-testid={`input-mr-plan-ex-${i}`} />
                        <input type="number" placeholder="Pilots" value={row.pilots}
                          onChange={e => updPlan(inputs, updI, i, { pilots: parseInt(e.target.value)||0 })}
                          className="col-span-1 bg-background border border-border rounded px-2 py-1"
                          data-testid={`input-mr-plan-pilots-${i}`} />
                        <input type="number" step="0.1" placeholder="S/Pilot" value={row.sortiesPerPilot}
                          onChange={e => updPlan(inputs, updI, i, { sortiesPerPilot: parseFloat(e.target.value)||0 })}
                          className="col-span-1 bg-background border border-border rounded px-2 py-1"
                          data-testid={`input-mr-plan-spp-${i}`} />
                        <input type="number" step="0.1" placeholder="Dur" value={row.durationPerSortie}
                          onChange={e => updPlan(inputs, updI, i, { durationPerSortie: parseFloat(e.target.value)||0 })}
                          className="col-span-1 bg-background border border-border rounded px-2 py-1"
                          data-testid={`input-mr-plan-dur-${i}`} />
                        <input type="number" step="1" placeholder={`${defaultFuelHr} lb/hr`}
                          value={row.fuelPerHourOverride ?? ""}
                          onChange={e => updPlan(inputs, updI, i, {
                            fuelPerHourOverride: e.target.value === "" ? undefined : (parseFloat(e.target.value) || 0),
                          })}
                          title={fuelOverridden ? "Override active" : `Inherits ${defaultFuelHr} lb/hr from squadron defaults`}
                          className={`col-span-1 bg-background border rounded px-2 py-1 ${fuelOverridden ? "border-amber-500" : "border-border"}`}
                          data-testid={`input-mr-plan-fuelhr-${i}`} />
                        <input placeholder="2.75 RKT" value={row.ammo275} dir="auto"
                          onChange={e => updPlan(inputs, updI, i, { ammo275: e.target.value })}
                          className="col-span-1 bg-background border border-border rounded px-2 py-1" />
                        <input placeholder="12.7" value={row.ammo127} dir="auto"
                          onChange={e => updPlan(inputs, updI, i, { ammo127: e.target.value })}
                          className="col-span-1 bg-background border border-border rounded px-2 py-1" />
                        <input placeholder="7.62" value={row.ammo762} dir="auto"
                          onChange={e => updPlan(inputs, updI, i, { ammo762: e.target.value })}
                          className="col-span-1 bg-background border border-border rounded px-2 py-1" />
                        <input placeholder="Remarks (EN/AR)" value={row.remarks} dir="auto"
                          onChange={e => updPlan(inputs, updI, i, { remarks: e.target.value })}
                          className="col-span-2 bg-background border border-border rounded px-2 py-1" />
                        <button onClick={() => {
                            if (!confirm("Remove this exercise row?")) return;
                            updI("nextPlan", inputs.nextPlan.filter((_, idx) => idx !== i));
                          }}
                          className="col-span-1 text-destructive hover:bg-secondary rounded p-1 inline-flex items-center justify-center"
                          data-testid={`button-mr-del-plan-${i}`} title="Remove">
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                      {/* Live formula trace — visible math so the operator (and any auditing officer) can see exactly how this row's totals were derived */}
                      <div className="text-[10px] text-muted-foreground pl-1" data-testid={`formula-trace-${i}`}>
                        <span className="font-mono">
                          {row.pilots} × {row.sortiesPerPilot} = <b>{totalSorties.toFixed(0)}</b> sorties
                          {"  ·  "}
                          {totalSorties.toFixed(0)} × {row.durationPerSortie} = <b>{totalHours.toFixed(1)}</b> hrs
                          {"  ·  "}
                          {totalHours.toFixed(1)} × {fuelHr}{fuelOverridden ? "*" : ""} lb/hr = <b>{totalFuel.toFixed(0)}</b> lb fuel
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Per-pilot remarks override */}
            {pilots.length > 0 && (
              <details className="border border-border rounded-md p-2">
                <summary className="text-xs font-semibold cursor-pointer inline-flex items-center gap-2">
                  {t("monthlyPerPilotOverrides")} ({pilots.length})
                  <Badge tone="default">DEFAULT</Badge> <Badge tone="manual">MANUAL</Badge>
                  {defaults.autoSuggestRemarks && (
                    <span className="text-[10px] font-normal text-muted-foreground">
                      auto-suggesting REMARKS from leave / unavailability records
                    </span>
                  )}
                </summary>
                <div className="space-y-1 mt-2 max-h-64 overflow-y-auto">
                  {pilots.map(p => {
                    const suggestion = defaults.autoSuggestRemarks
                      ? suggestRemarksFor(p, period, leaves, unavail)
                      : "";
                    const remarkValue = inputs.perPilotRemarks[p.id] || "";
                    const showingSuggestion = !remarkValue && suggestion;
                    return (
                      <div key={p.id} className="grid grid-cols-12 gap-2 items-center text-xs">
                        <div className="col-span-3 truncate">{p.name}</div>
                        <input placeholder="Status (EN/AR)" dir="auto"
                          value={inputs.perPilotStatus[p.id] || ""}
                          onChange={e => updI("perPilotStatus", { ...inputs.perPilotStatus, [p.id]: e.target.value })}
                          className="col-span-3 bg-background border border-border rounded px-2 py-1"
                          data-testid={`input-mr-status-${p.id}`} />
                        <input
                          placeholder={suggestion || "Remarks (EN/AR)"}
                          dir="auto"
                          value={remarkValue}
                          onChange={e => updI("perPilotRemarks", { ...inputs.perPilotRemarks, [p.id]: e.target.value })}
                          className={`col-span-5 bg-background border rounded px-2 py-1 ${showingSuggestion ? "border-emerald-500/60 italic placeholder:text-emerald-700/80 placeholder:not-italic" : "border-border"}`}
                          title={showingSuggestion ? `Auto-suggestion (placeholder). Click "Use" to apply, or type to override.` : undefined}
                          data-testid={`input-mr-remarks-${p.id}`} />
                        {showingSuggestion ? (
                          <button onClick={() => updI("perPilotRemarks", { ...inputs.perPilotRemarks, [p.id]: suggestion })}
                            className="col-span-1 text-[10px] px-1.5 py-1 rounded border border-emerald-500/60 text-emerald-700 hover:bg-emerald-50"
                            data-testid={`button-mr-use-suggestion-${p.id}`}
                            title="Apply suggested remark">
                            Use
                          </button>
                        ) : (
                          <div className="col-span-1" />
                        )}
                      </div>
                    );
                  })}
                </div>
              </details>
            )}
          </div>
        )}
      </section>

      {/* ───────── FORM 1 ───────── */}
      <section className={`form-page${form1Totals.nvg > 0 ? "" : " form-page-front-end"}`} data-testid="form1">
        <div className="form-meta">
          <div><b>{groupAcronym} RCN FORM 1</b><br/>{groupAcronym} HQ<br/>UNIT : NO {sqdnNumber} SQDN</div>
          <div className="text-center">
            <div className="form-title">{groupName}<br/>NO {sqdnNumber} SQDN</div>
            <div className="form-sub">INDIVIDUAL PILOT ACHIEVEMENTS</div>
          </div>
          <div className="text-right"><b>ACHIEVEMENTS FOR : {monthHeader}</b></div>
        </div>
        <div className="secret">SECRET ( WHEN FILLED )</div>
        <table>
          <thead>
            <tr>
              <th rowSpan={2}>#</th>
              <th colSpan={3}>PERSONAL DETAILS</th>
              <th rowSpan={2}>TYPE OF AIRCRAFT</th>
              <th rowSpan={2}>STATUS</th>
              <th colSpan={3}>DAY</th>
              <th colSpan={3}>NIGHT</th>
              <th rowSpan={2}>NVG</th>
              <th rowSpan={2}>TOTAL FOR MONTH</th>
              <th colSpan={2}>TOTAL</th>
              <th colSpan={2}>IF FOR MONTH</th>
              <th rowSpan={2}>REMARKS</th>
            </tr>
            <tr>
              <th>SERV NO</th><th>RANK</th><th>NAME</th>
              <th>1ST PILOT</th><th>2ND PILOT</th><th>DUAL</th>
              <th>1ST PILOT</th><th>2ND PILOT</th><th>DUAL</th>
              <th>CAP</th><th>SOR</th>
              <th>SIM</th><th>ACT</th>
            </tr>
          </thead>
          <tbody>
            {form1.map((r, i) => (
              <tr key={r.pilot.id} data-testid={`form1-row-${r.pilot.id}`}>
                <td className="center">{i+1}</td>
                <td className="center">{r.pilot.id}</td>
                <td className="center">{r.pilot.rank}</td>
                <td>{r.pilot.name}</td>
                <td className="center">{r.pilot.unit === "HQ Attached" ? primaryAirframe : (r.pilot.unit || primaryAirframe)}</td>
                <td className="center">{r.status}</td>
                <td className="num">{r.day1.toFixed(1)}</td>
                <td className="num">{r.day2.toFixed(1)}</td>
                <td className="num">{r.dayDual.toFixed(1)}</td>
                <td className="num">{r.night1.toFixed(1)}</td>
                <td className="num">{r.night2.toFixed(1)}</td>
                <td className="num">{r.nightDual.toFixed(1)}</td>
                <td className="num">{r.nvg.toFixed(1)}</td>
                <td className="num"><b>{r.totalForMonth.toFixed(1)}</b></td>
                <td className="num">{r.cap}</td>
                <td className="num">{r.sor}</td>
                <td className="num">{r.ifSim.toFixed(1)}</td>
                <td className="num">{r.ifAct.toFixed(1)}</td>
                <td>{r.remarks}</td>
              </tr>
            ))}
            {form1.length === 0 && (
              <tr><td colSpan={19} className="center" style={{padding:"12px"}}>{t("monthlyEmpty")}</td></tr>
            )}
            {form1.length > 0 && (
              <tr data-testid="form1-totals" style={{background:"#f3f4f6", fontWeight:700}}>
                <td colSpan={6} className="center">TOTAL</td>
                <td className="num">{form1Totals.day1.toFixed(1)}</td>
                <td className="num">{form1Totals.day2.toFixed(1)}</td>
                <td className="num">{form1Totals.dayDual.toFixed(1)}</td>
                <td className="num">{form1Totals.night1.toFixed(1)}</td>
                <td className="num">{form1Totals.night2.toFixed(1)}</td>
                <td className="num">{form1Totals.nightDual.toFixed(1)}</td>
                <td className="num">{form1Totals.nvg.toFixed(1)}</td>
                <td className="num">{form1Totals.totalForMonth.toFixed(1)}</td>
                <td className="num">{form1Totals.cap}</td>
                <td className="num">{form1Totals.sor}</td>
                <td className="num">{form1Totals.ifSim.toFixed(1)}</td>
                <td className="num">{form1Totals.ifAct.toFixed(1)}</td>
                <td></td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="secret" style={{marginTop:8}}>SECRET ( WHEN FILLED )</div>
      </section>

      {/* ───────── NVG SECTION (back of front sheet) ─────────
          Only flows onto paper when at least one pilot logged NVG hours
          this period. The print stylesheet sends Form 2 to the next
          sheet's front via `page-break-after: right` so a no-NVG month
          prints as one front-only paper. */}
      <section
        className={`form-page nvg-back-page ${form1Totals.nvg > 0 ? "nvg-active" : "nvg-empty"}`}
        data-testid="form-nvg"
      >
        <div className="form-meta">
          <div><b>{groupAcronym} NVG</b><br/>MONTH : {monthHeader}<br/>UNIT : NO {sqdnNumber} SQDN</div>
          <div className="text-center">
            <div className="form-title">{groupName}<br/>NO {sqdnNumber} SQDN</div>
            <div className="form-sub">NIGHT VISION GOGGLE HOURS — SUMMARY</div>
          </div>
          <div className="text-right"><b>FOR : {monthHeader}</b><br/><span style={{fontSize:9, color:"#555"}}>AUTO from sortie records</span></div>
        </div>
        <div className="secret">SECRET ( WHEN FILLED )</div>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>SERV NO</th>
              <th>RANK</th>
              <th>NAME</th>
              <th>NVG HRS</th>
              <th>NVG DUAL</th>
            </tr>
          </thead>
          <tbody>
            {form1.filter(r => r.nvg > 0 || (dualHours.find(d => d.pilot.id === r.pilot.id)?.nvgDual ?? 0) > 0).map((r, i) => {
              const nvgDual = dualHours.find(d => d.pilot.id === r.pilot.id)?.nvgDual ?? 0;
              return (
                <tr key={r.pilot.id} data-testid={`nvg-row-${r.pilot.id}`}>
                  <td className="center">{i+1}</td>
                  <td className="center">{r.pilot.id}</td>
                  <td className="center">{r.pilot.rank}</td>
                  <td>{r.pilot.name}</td>
                  <td className="num">{r.nvg.toFixed(1)}</td>
                  <td className="num">{nvgDual.toFixed(1)}</td>
                </tr>
              );
            })}
            <tr data-testid="nvg-totals" style={{background:"#f3f4f6", fontWeight:700}}>
              <td colSpan={4} className="center">TOTAL</td>
              <td className="num">{form1Totals.nvg.toFixed(1)}</td>
              <td className="num">{dualHours.reduce((a,r) => a + r.nvgDual, 0).toFixed(1)}</td>
            </tr>
          </tbody>
        </table>
        <div className="secret" style={{marginTop:8}}>SECRET ( WHEN FILLED )</div>
      </section>

      {/* ───────── FORM 2 ───────── */}
      <section className="form-page" data-testid="form2">
        <div className="form-meta">
          <div><b>{groupAcronym} RCN FORM 2</b><br/>{groupAcronym} HQ<br/>UNIT : NO {sqdnNumber} SQDN</div>
          <div className="text-center">
            <div className="form-title">{groupName}<br/>NO {sqdnNumber} SQDN</div>
            <div className="form-sub">INDIVIDUAL PILOT ACHIEVEMENTS</div>
          </div>
          <div className="text-right"><b>ACHIEVEMENTS FOR : {monthHeader}</b></div>
        </div>
        <div className="secret">SECRET ( WHEN FILLED )</div>
        <table>
          <thead>
            <tr>
              <th rowSpan={2}>#</th>
              <th rowSpan={2}>NAME</th>
              <th rowSpan={2}>TOTAL FOR MONTH ALL TYPES</th>
              <th rowSpan={2}>GRAND TOTAL</th>
              <th colSpan={2}>CURRENCY</th>
              <th colSpan={2}>IF FOR MONTH ALL TYPES</th>
              <th colSpan={2}>TOTAL IF</th>
              <th rowSpan={2}>IF EXPIRY DATE</th>
              <th rowSpan={2}>REMARKS</th>
            </tr>
            <tr>
              <th>NF</th><th>IF</th>
              <th>SIM</th><th>ACT</th>
              <th>SIM</th><th>ACT</th>
            </tr>
          </thead>
          <tbody>
            {form2.map((r, i) => (
              <tr key={r.pilot.id} data-testid={`form2-row-${r.pilot.id}`}>
                <td className="center">{i+1}</td>
                <td>{r.pilot.name}</td>
                <td className="num">{r.totalForMonthAllTypes.toFixed(1)}</td>
                <td className="num"><b>{r.grandTotal.toFixed(1)}</b></td>
                <td className="center">{r.currencyNF}</td>
                <td className="center">{r.currencyIF}</td>
                <td className="num">{r.ifSimMonth.toFixed(1)}</td>
                <td className="num">{r.ifActMonth.toFixed(1)}</td>
                <td className="num">{r.ifSimTotal.toFixed(1)}</td>
                <td className="num">{r.ifActTotal.toFixed(1)}</td>
                <td className="center">{r.ifExpiryDate || "—"}</td>
                <td>{r.remarks}</td>
              </tr>
            ))}
            {form2.length === 0 && (
              <tr><td colSpan={12} className="center" style={{padding:"12px"}}>{t("monthlyEmpty")}</td></tr>
            )}
            {form2.length > 0 && (
              <tr data-testid="form2-totals" style={{background:"#f3f4f6", fontWeight:700}}>
                <td colSpan={2} className="center">TOTAL</td>
                <td className="num">{form2Totals.totalForMonthAllTypes.toFixed(1)}</td>
                <td className="num">{form2Totals.grandTotal.toFixed(1)}</td>
                <td colSpan={2}></td>
                <td className="num">{form2Totals.ifSimMonth.toFixed(1)}</td>
                <td className="num">{form2Totals.ifActMonth.toFixed(1)}</td>
                <td className="num">{form2Totals.ifSimTotal.toFixed(1)}</td>
                <td className="num">{form2Totals.ifActTotal.toFixed(1)}</td>
                <td colSpan={2}></td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="secret" style={{marginTop:8}}>SECRET ( WHEN FILLED )</div>
      </section>

      {/* ───────── FORM 3 ───────── */}
      <section className="form-page" data-testid="form3">
        <div className="form-meta">
          <div><b>{groupAcronym} RCN FORM 3</b><br/>{groupAcronym} HQ<br/>UNIT : NO {sqdnNumber} SQDN</div>
          <div className="text-center">
            <div className="form-title">{groupName}<br/>NO {sqdnNumber} SQDN</div>
            <div className="form-sub">MONTHLY PLANNED FLYING TASKS</div>
          </div>
          <div className="text-right"><b>ACHIEVEMENTS FOR : {monthHeader}</b></div>
        </div>
        <div className="secret">SECRET ( WHEN FILLED )</div>
        <table>
          <thead>
            <tr>
              <th>SQDN STRENGTH</th><th>OPS</th><th>ATTACHED</th><th>COURSE</th><th>SICK LEAVE</th>
              <th>SICK RATE</th><th>DISCIPLINE MORALE</th><th>SQDN CMDR REMARKS</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="center">{inputs.squadronStrength}</td>
              <td className="center">{inputs.ops}</td>
              <td className="center">{inputs.attached}</td>
              <td className="center">{inputs.course}</td>
              <td className="center">{inputs.sickLeave}</td>
              <td className="center">{inputs.sickRatePct.toFixed(1)}%</td>
              <td className="center">{inputs.morale}</td>
              <td></td>
            </tr>
            <tr><td><b>INCIDENTS</b></td><td colSpan={7} className="center">{inputs.incidents}</td></tr>
            <tr><td><b>ACCIDENTS</b></td><td colSpan={7} className="center">{inputs.accidents}</td></tr>
          </tbody>
        </table>

        <table style={{marginTop:8}}>
          <thead>
            <tr>
              <th>MISSION</th>
              {MISSION_BUCKETS.map(b => <th key={b}>{MISSION_LABEL[b]}</th>)}
              <th>TOTAL</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><b>SORTIES</b></td>
              {MISSION_BUCKETS.map(b => <td key={b} className="num">{form3.missionTotals[b].sorties}</td>)}
              <td className="num"><b>{form3.totalSorties}</b></td>
            </tr>
            <tr>
              <td><b>HOURS</b></td>
              {MISSION_BUCKETS.map(b => <td key={b} className="num">{form3.missionTotals[b].hours.toFixed(1)}</td>)}
              <td className="num"><b>{form3.totalHours.toFixed(1)}</b></td>
            </tr>
          </tbody>
        </table>

        <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:8}}>
          <table>
            <thead><tr><th colSpan={3}>PLANNED AND ACHIEVED</th></tr>
              <tr><th></th><th>SORTIES</th><th>HOURS</th></tr></thead>
            <tbody>
              <tr><td>PLANNED</td><td className="num">{inputs.plannedSorties}</td><td className="num">{inputs.plannedHours.toFixed(1)}</td></tr>
              <tr><td>ACHIEVED</td><td className="num">{form3.achievedSorties}</td><td className="num">{form3.achievedHours.toFixed(1)}</td></tr>
              <tr style={{background:"#f8fafc"}}>
                <td><b>ACHIEVEMENT %</b></td>
                <td className="num"><b>{form3Stats.achievementSortiesPct.toFixed(1)}%</b></td>
                <td className="num"><b>{form3Stats.achievementHoursPct.toFixed(1)}%</b></td>
              </tr>
              <tr><td>WEATHER ABORT</td><td className="num">{inputs.weatherAbortS}</td><td className="num">{inputs.weatherAbortH.toFixed(1)}</td></tr>
              <tr><td>MAINTENANCE</td><td className="num">{inputs.maintAbortS}</td><td className="num">{inputs.maintAbortH.toFixed(1)}</td></tr>
              <tr><td>OPS ABORT</td><td className="num">{inputs.opsAbortS}</td><td className="num">{inputs.opsAbortH.toFixed(1)}</td></tr>
              <tr><td>AIR ABORT</td><td className="num">{inputs.airAbortS}</td><td className="num">{inputs.airAbortH.toFixed(1)}</td></tr>
              <tr style={{background:"#f8fafc"}}>
                <td><b>TOTAL ABORTS</b></td>
                <td className="num"><b>{form3Stats.totalAbortSorties}</b></td>
                <td className="num"><b>{form3Stats.totalAbortHours.toFixed(1)}</b></td>
              </tr>
              <tr>
                <td>WEATHER %</td>
                <td className="num" colSpan={2}>{form3Stats.weatherAbortPct.toFixed(1)}% of attempted sorties</td>
              </tr>
            </tbody>
          </table>
          <table>
            <thead><tr><th>LECTURES</th><th>HOURS</th><th>QUIZ</th><th>REMARKS</th></tr></thead>
            <tbody>
              {inputs.lectures.map((lec, i) => (
                <tr key={i}>
                  <td>{lec.name}</td>
                  <td className="num">{lec.hours.toFixed(1)}</td>
                  <td className="num">{lec.quizPct ? `${lec.quizPct}%` : ""}</td>
                  <td>{lec.remarks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="secret" style={{marginTop:8}}>SECRET ( WHEN FILLED )</div>
      </section>

      {/* ───────── FORM 4 ───────── */}
      <section className="form-page" data-testid="form4">
        <div className="form-meta">
          <div><b>{groupAcronym} RCN FORM 4</b><br/>MONTH : {monthHeader}<br/>UNIT : NO {sqdnNumber} SQDN</div>
          <div className="text-center">
            <div className="form-title">{groupName}<br/>NO {sqdnNumber} SQDN</div>
            <div className="form-sub">MONTHLY PLANNED FLYING TASKS</div>
          </div>
          <div className="text-right"><b>PLANNED FOR : {nextMonthHeader}</b></div>
        </div>
        <div className="secret">SECRET ( WHEN FILLED )</div>
        <table>
          <thead>
            <tr>
              <th colSpan={3}>MONTH : {monthHeader}</th>
              <th colSpan={3}>PILOTS AVAILABLE : {inputs.pilotsAvailableNext}</th>
              <th colSpan={4}>OPS : {inputs.opsNext}</th>
            </tr>
            <tr>
              <th>NO</th><th>TYPE OF EXERCISE</th><th>NO OF PILOTS</th>
              <th>NO OF SORTIES / PILOT</th><th>TIME (DURATION) / SORTIE</th>
              <th>TOTAL SORTIES FOR THE SQDN</th><th>TOTAL TIME FOR THE SQDN</th>
              <th>2.75 RKT</th><th>12.7 MM</th><th>7.62 MM</th><th>REMARKS</th>
            </tr>
          </thead>
          <tbody>
            {inputs.nextPlan.map((row, i) => {
              const totalSorties = row.pilots * row.sortiesPerPilot;
              const totalTime = totalSorties * row.durationPerSortie;
              return (
                <tr key={i} data-testid={`form4-row-${i}`}>
                  <td className="center">{i+1}</td>
                  <td className="center">{row.exercise}</td>
                  <td className="num">{row.pilots}</td>
                  <td className="num">{row.sortiesPerPilot.toFixed(1)}</td>
                  <td className="num">{row.durationPerSortie.toFixed(1)}</td>
                  <td className="num">{totalSorties.toFixed(0)}</td>
                  <td className="num">{totalTime.toFixed(1)}</td>
                  <td className="center">{row.ammo275}</td>
                  <td className="center">{row.ammo127}</td>
                  <td className="center">{row.ammo762}</td>
                  <td>{row.remarks}</td>
                </tr>
              );
            })}
            <tr>
              <td colSpan={5} className="center"><b>TOTAL</b></td>
              <td className="num"><b>{inputs.nextPlan.reduce((a,r) => a + r.pilots*r.sortiesPerPilot, 0).toFixed(0)}</b></td>
              <td className="num"><b>{inputs.nextPlan.reduce((a,r) => a + r.pilots*r.sortiesPerPilot*r.durationPerSortie, 0).toFixed(1)}</b></td>
              <td colSpan={4}></td>
            </tr>
            <tr>
              <td colSpan={7}><b>AMMO. AVAILABLE FROM PREVIOUS MONTH</b></td>
              <td className="center">{inputs.ammoPrev.rkt275}</td>
              <td className="center">{inputs.ammoPrev.mm127}</td>
              <td className="center">{inputs.ammoPrev.mm762}</td>
              <td></td>
            </tr>
            <tr>
              <td colSpan={7}><b>AMMO. REQUIRED THIS MONTH</b></td>
              <td className="center">{inputs.ammoReq.rkt275}</td>
              <td className="center">{inputs.ammoReq.mm127}</td>
              <td className="center">{inputs.ammoReq.mm762}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
        <div className="secret" style={{marginTop:8}}>SECRET ( WHEN FILLED )</div>
      </section>

      {/* ───────── FUEL ─────────
          Mirrors the workbook's separate FUEL sheet: same exercise grid as
          Form 4, plus the burn-rate column and computed total fuel. Rows
          come from inputs.nextPlan; per-row override (yellow border in the
          wizard) wins, otherwise the squadron default lb/hr is used. Total
          fuel = pilots × sorties/pilot × duration × lb/hr. */}
      <section className="form-page" data-testid="form-fuel">
        <div className="form-meta">
          <div><b>{groupAcronym} FUEL</b><br/>MONTH : {nextMonthHeader}<br/>UNIT : NO {sqdnNumber} SQDN</div>
          <div className="text-center">
            <div className="form-title">{groupName}<br/>NO {sqdnNumber} SQDN</div>
            <div className="form-sub">FUEL CONSUMPTION FORECAST</div>
          </div>
          <div className="text-right"><b>PLANNED FOR : {nextMonthHeader}</b></div>
        </div>
        <div className="secret">SECRET ( WHEN FILLED )</div>
        <table>
          <thead>
            <tr>
              <th>NO</th><th>TYPE OF EXERCISE</th><th>NO OF PILOTS</th>
              <th>NO OF SORTIES / PILOT</th><th>TIME (DURATION) / SORTIE</th>
              <th>TOTAL SORTIES</th><th>TOTAL TIME (HRS)</th>
              <th>FUEL / HOUR (LB)</th><th>TOTAL FUEL (LB)</th>
            </tr>
          </thead>
          <tbody>
            {inputs.nextPlan.map((row, i) => {
              const fuelHr = row.fuelPerHourOverride ?? defaultFuelHr;
              const totalSorties = row.pilots * row.sortiesPerPilot;
              const totalHours   = totalSorties * row.durationPerSortie;
              const totalFuel    = totalHours * fuelHr;
              return (
                <tr key={i} data-testid={`fuel-row-${i}`}>
                  <td className="center">{i+1}</td>
                  <td className="center">{row.exercise}</td>
                  <td className="num">{row.pilots}</td>
                  <td className="num">{row.sortiesPerPilot.toFixed(1)}</td>
                  <td className="num">{row.durationPerSortie.toFixed(1)}</td>
                  <td className="num">{totalSorties.toFixed(0)}</td>
                  <td className="num">{totalHours.toFixed(1)}</td>
                  <td className="num">
                    {fuelHr}
                    {row.fuelPerHourOverride != null && <sup title="Per-row override">*</sup>}
                  </td>
                  <td className="num"><b>{totalFuel.toFixed(0)}</b></td>
                </tr>
              );
            })}
            <tr style={{background:"#f3f4f6", fontWeight:700}}>
              <td colSpan={5} className="center">TOTAL</td>
              <td className="num">
                {inputs.nextPlan.reduce((a,r) => a + r.pilots * r.sortiesPerPilot, 0).toFixed(0)}
              </td>
              <td className="num">
                {inputs.nextPlan.reduce((a,r) => a + r.pilots * r.sortiesPerPilot * r.durationPerSortie, 0).toFixed(1)}
              </td>
              <td></td>
              <td className="num">
                {inputs.nextPlan
                  .reduce((a,r) => a + r.pilots * r.sortiesPerPilot * r.durationPerSortie * (r.fuelPerHourOverride ?? defaultFuelHr), 0)
                  .toFixed(0)} lb
              </td>
            </tr>
          </tbody>
        </table>
        <div style={{marginTop:6, fontSize:10, color:"#444"}}>
          Formula per row: <span style={{fontFamily:"monospace"}}>pilots × sorties/pilot × duration × fuel/hr</span>
          {" "}— default fuel/hr from squadron settings (currently {defaultFuelHr} lb/hr for {primaryAirframe}),
          per-row overrides marked with *. Edit defaults via Squadron defaults page.
        </div>
        <div className="secret" style={{marginTop:8}}>SECRET ( WHEN FILLED )</div>
      </section>

      {/* ═══════════════════════════════════════════════════════════════
          APPENDIX SHEETS — pure AUTO data, derived from sortie/leave
          records. These mirror the workbook's appendix tabs that the
          squadron commander signs alongside Forms 1-4.
          ═══════════════════════════════════════════════════════════════ */}

      {/* ───────── AUTHORIZATION (daily sortie log) ───────── */}
      <section className="form-page" data-testid="form-authorization">
        <div className="form-meta">
          <div><b>{groupAcronym} AUTHORIZATION</b><br/>MONTH : {monthHeader}<br/>UNIT : NO {sqdnNumber} SQDN</div>
          <div className="text-center">
            <div className="form-title">{groupName}<br/>NO {sqdnNumber} SQDN</div>
            <div className="form-sub">DAILY SORTIE AUTHORIZATION LOG</div>
          </div>
          <div className="text-right"><b>FOR : {monthHeader}</b><br/><span style={{fontSize:9, color:"#555"}}>AUTO from sortie records</span></div>
        </div>
        <div className="secret">SECRET ( WHEN FILLED )</div>
        <table>
          <thead>
            <tr>
              <th rowSpan={2}>#</th>
              <th rowSpan={2}>DATE</th>
              <th rowSpan={2}>A/C TYPE</th>
              <th rowSpan={2}>A/C #</th>
              <th rowSpan={2}>MISSION</th>
              <th rowSpan={2}>PC (CAPTAIN)</th>
              <th rowSpan={2}>PI</th>
              <th colSpan={3}>DAY</th>
              <th colSpan={3}>NIGHT</th>
              <th rowSpan={2}>NVG</th>
              <th colSpan={2}>IF</th>
              <th rowSpan={2}>TOTAL</th>
              <th rowSpan={2}>REMARKS</th>
            </tr>
            <tr>
              <th>1P</th><th>2P</th><th>D</th>
              <th>1P</th><th>2P</th><th>D</th>
              <th>SIM</th><th>ACT</th>
            </tr>
          </thead>
          <tbody>
            {authLog.map(r => (
              <tr key={r.no} data-testid={`auth-row-${r.no}`}>
                <td className="center">{r.no}</td>
                <td className="center">{r.date}</td>
                <td className="center">{r.acType}</td>
                <td className="center">{r.acNumber}</td>
                <td>{r.mission}</td>
                <td>{r.pcName}</td>
                <td>{r.piName}</td>
                <td className="num">{r.day1.toFixed(1)}</td>
                <td className="num">{r.day2.toFixed(1)}</td>
                <td className="num">{r.dayDual.toFixed(1)}</td>
                <td className="num">{r.night1.toFixed(1)}</td>
                <td className="num">{r.night2.toFixed(1)}</td>
                <td className="num">{r.nightDual.toFixed(1)}</td>
                <td className="num">{r.nvg.toFixed(1)}</td>
                <td className="num">{r.ifSim.toFixed(1)}</td>
                <td className="num">{r.ifAct.toFixed(1)}</td>
                <td className="num"><b>{r.total.toFixed(1)}</b></td>
                <td>{r.remarks}</td>
              </tr>
            ))}
            {authLog.length === 0 && (
              <tr><td colSpan={18} className="center" style={{padding:"12px"}}>No sorties flown this period.</td></tr>
            )}
            {authLog.length > 0 && (
              <tr data-testid="auth-totals" style={{background:"#f3f4f6", fontWeight:700}}>
                <td colSpan={7} className="center">TOTAL — {authLogTotals.sorties} SORTIES</td>
                <td className="num">{authLogTotals.day1.toFixed(1)}</td>
                <td className="num">{authLogTotals.day2.toFixed(1)}</td>
                <td className="num">{authLogTotals.dayDual.toFixed(1)}</td>
                <td className="num">{authLogTotals.night1.toFixed(1)}</td>
                <td className="num">{authLogTotals.night2.toFixed(1)}</td>
                <td className="num">{authLogTotals.nightDual.toFixed(1)}</td>
                <td className="num">{authLogTotals.nvg.toFixed(1)}</td>
                <td className="num">{authLogTotals.ifSim.toFixed(1)}</td>
                <td className="num">{authLogTotals.ifAct.toFixed(1)}</td>
                <td className="num">{authLogTotals.total.toFixed(1)}</td>
                <td></td>
              </tr>
            )}
          </tbody>
        </table>
        <div style={{marginTop:8, fontSize:10}}>
          <b>SQDN CMDR SIGNATURE:</b> _________________________________
          &nbsp;&nbsp;&nbsp; <b>DATE:</b> ____________
        </div>
        <div className="secret" style={{marginTop:8}}>SECRET ( WHEN FILLED )</div>
      </section>

      {/* ───────── P-LEAVES (annual leave matrix) ───────── */}
      <section className="form-page" data-testid="form-pleaves">
        <div className="form-meta">
          <div><b>{groupAcronym} P-LEAVES</b><br/>YEAR : {period.split("-")[0]}<br/>UNIT : NO {sqdnNumber} SQDN</div>
          <div className="text-center">
            <div className="form-title">{groupName}<br/>NO {sqdnNumber} SQDN</div>
            <div className="form-sub">PILOT ANNUAL LEAVES — DAYS PER MONTH</div>
          </div>
          <div className="text-right"><b>AS OF : {monthHeader}</b><br/><span style={{fontSize:9, color:"#555"}}>AUTO from leaves register</span></div>
        </div>
        <div className="secret">SECRET ( WHEN FILLED )</div>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>RANK</th>
              <th>NAME</th>
              {["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"].map((m, i) => (
                <th key={m} style={i === parseInt(period.split("-")[1],10)-1 ? {background:"#fde68a"} : undefined}>{m}</th>
              ))}
              <th>TOTAL</th>
            </tr>
          </thead>
          <tbody>
            {pLeaves.map((r, i) => (
              <tr key={r.pilot.id} data-testid={`pleaves-row-${r.pilot.id}`}>
                <td className="center">{i+1}</td>
                <td className="center">{r.pilot.rank}</td>
                <td>{r.pilot.name}</td>
                {r.months.map((days, mi) => (
                  <td key={mi} className="num" style={mi === parseInt(period.split("-")[1],10)-1 ? {background:"#fef3c7"} : undefined}>
                    {days > 0 ? days : ""}
                  </td>
                ))}
                <td className="num"><b>{r.total}</b></td>
              </tr>
            ))}
            {pLeaves.length === 0 && (
              <tr><td colSpan={16} className="center" style={{padding:"12px"}}>No pilots in roster.</td></tr>
            )}
            {pLeaves.length > 0 && (
              <tr style={{background:"#f3f4f6", fontWeight:700}}>
                <td colSpan={3} className="center">TOTAL</td>
                {Array.from({length:12}, (_, mi) => (
                  <td key={mi} className="num">
                    {pLeaves.reduce((a, r) => a + (r.months[mi] || 0), 0) || ""}
                  </td>
                ))}
                <td className="num">{pLeaves.reduce((a, r) => a + r.total, 0)}</td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="secret" style={{marginTop:8}}>SECRET ( WHEN FILLED )</div>
      </section>

      {/* ───────── SIX MONTHS RUNNING ───────── */}
      <section className="form-page" data-testid="form-sixmonths">
        <div className="form-meta">
          <div><b>{groupAcronym} 6-MONTHS</b><br/>ENDING : {monthHeader}<br/>UNIT : NO {sqdnNumber} SQDN</div>
          <div className="text-center">
            <div className="form-title">{groupName}<br/>NO {sqdnNumber} SQDN</div>
            <div className="form-sub">ROLLING SIX-MONTH FLYING HOURS — CURRENCY CHECK</div>
          </div>
          <div className="text-right"><b>FLOOR : {defaults.minSixMonthHours} HRS</b><br/><span style={{fontSize:9, color:"#555"}}>AUTO from sortie records</span></div>
        </div>
        <div className="secret">SECRET ( WHEN FILLED )</div>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>RANK</th>
              <th>NAME</th>
              {sixMonthHeaders.map(h => (
                <th key={h.period}>{h.label}<br/><span style={{fontWeight:400, fontSize:9}}>{h.year}</span></th>
              ))}
              <th>6-MO TOTAL</th>
              <th>AVG / MO</th>
              <th>STATUS</th>
            </tr>
          </thead>
          <tbody>
            {sixMonths.map((r, i) => (
              <tr key={r.pilot.id} data-testid={`sixmo-row-${r.pilot.id}`}>
                <td className="center">{i+1}</td>
                <td className="center">{r.pilot.rank}</td>
                <td>{r.pilot.name}</td>
                {r.cells.map(c => (
                  <td key={c.period} className="num">{c.hours > 0 ? c.hours.toFixed(1) : ""}</td>
                ))}
                <td className="num"><b>{r.total6mo.toFixed(1)}</b></td>
                <td className="num">{r.avgPerMo.toFixed(1)}</td>
                <td className="center" style={{
                  background: r.flag === "OK" ? "#dcfce7" : r.flag === "LOW" ? "#fef3c7" : "#fee2e2",
                  fontWeight: 700,
                }}>{r.flag}</td>
              </tr>
            ))}
            {sixMonths.length === 0 && (
              <tr><td colSpan={3 + sixMonthHeaders.length + 3} className="center" style={{padding:"12px"}}>No pilots in roster.</td></tr>
            )}
          </tbody>
        </table>
        <div style={{marginTop:6, fontSize:10, color:"#444"}}>
          <b>STATUS:</b> OK = at or above floor ({defaults.minSixMonthHours} hrs/6 mo);
          {" "}LOW = within 20% of floor; UNDER = below floor (action required).
          {" "}Adjust the floor in <i>Squadron defaults → Min 6-month hours</i>.
        </div>
        <div className="secret" style={{marginTop:8}}>SECRET ( WHEN FILLED )</div>
      </section>

      {/* ───────── DUAL HOURS ───────── */}
      <section className="form-page" data-testid="form-dual">
        <div className="form-meta">
          <div><b>{groupAcronym} DUAL</b><br/>MONTH : {monthHeader}<br/>UNIT : NO {sqdnNumber} SQDN</div>
          <div className="text-center">
            <div className="form-title">{groupName}<br/>NO {sqdnNumber} SQDN</div>
            <div className="form-sub">DUAL FLIGHT HOURS — INSTRUCTOR / STUDENT BREAKDOWN</div>
          </div>
          <div className="text-right"><b>FOR : {monthHeader}</b><br/><span style={{fontSize:9, color:"#555"}}>AUTO from sortie records</span></div>
        </div>
        <div className="secret">SECRET ( WHEN FILLED )</div>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>RANK</th>
              <th>NAME</th>
              <th>DAY DUAL</th>
              <th>NIGHT DUAL</th>
              <th>NVG DUAL</th>
              <th>TOTAL DUAL</th>
              <th>NON-DUAL HRS</th>
              <th>RATIO</th>
            </tr>
          </thead>
          <tbody>
            {dualHours.map((r, i) => (
              <tr key={r.pilot.id} data-testid={`dual-row-${r.pilot.id}`}>
                <td className="center">{i+1}</td>
                <td className="center">{r.pilot.rank}</td>
                <td>{r.pilot.name}</td>
                <td className="num">{r.dayDual.toFixed(1)}</td>
                <td className="num">{r.nightDual.toFixed(1)}</td>
                <td className="num">{r.nvgDual.toFixed(1)}</td>
                <td className="num"><b>{r.totalDual.toFixed(1)}</b></td>
                <td className="num">{r.totalSolo.toFixed(1)}</td>
                <td className="center" style={{fontSize:10}}>{r.ratio}</td>
              </tr>
            ))}
            {dualHours.length === 0 && (
              <tr><td colSpan={9} className="center" style={{padding:"12px"}}>No pilots in roster.</td></tr>
            )}
            {dualHours.length > 0 && (
              <tr style={{background:"#f3f4f6", fontWeight:700}}>
                <td colSpan={3} className="center">TOTAL</td>
                <td className="num">{dualHours.reduce((a,r) => a + r.dayDual, 0).toFixed(1)}</td>
                <td className="num">{dualHours.reduce((a,r) => a + r.nightDual, 0).toFixed(1)}</td>
                <td className="num">{dualHours.reduce((a,r) => a + r.nvgDual, 0).toFixed(1)}</td>
                <td className="num">{dualHours.reduce((a,r) => a + r.totalDual, 0).toFixed(1)}</td>
                <td className="num">{dualHours.reduce((a,r) => a + r.totalSolo, 0).toFixed(1)}</td>
                <td></td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="secret" style={{marginTop:8}}>SECRET ( WHEN FILLED )</div>
      </section>

      {/* ───────── MISSION SOLO ───────── */}
      <section className="form-page" data-testid="form-missionsolo">
        <div className="form-meta">
          <div><b>{groupAcronym} MISSION SOLO</b><br/>MONTH : {monthHeader}<br/>UNIT : NO {sqdnNumber} SQDN</div>
          <div className="text-center">
            <div className="form-title">{groupName}<br/>NO {sqdnNumber} SQDN</div>
            <div className="form-sub">SOLO SORTIES BY MISSION TYPE — STANDARDISATION</div>
          </div>
          <div className="text-right"><b>FOR : {monthHeader}</b><br/><span style={{fontSize:9, color:"#555"}}>AUTO from sortie records</span></div>
        </div>
        <div className="secret">SECRET ( WHEN FILLED )</div>
        <table>
          <thead>
            <tr>
              <th rowSpan={2}>#</th>
              <th rowSpan={2}>RANK</th>
              <th rowSpan={2}>NAME</th>
              <th colSpan={MISSION_BUCKETS.length}>SOLO SORTIES BY MISSION TYPE</th>
              <th rowSpan={2}>TOTAL SORTIES</th>
              <th rowSpan={2}>TOTAL HRS</th>
              <th rowSpan={2}>LAST SOLO</th>
            </tr>
            <tr>
              {MISSION_BUCKETS.map(b => <th key={b}>{MISSION_LABEL[b]}</th>)}
            </tr>
          </thead>
          <tbody>
            {missionSolo.map((r, i) => (
              <tr key={r.pilot.id} data-testid={`solo-row-${r.pilot.id}`}>
                <td className="center">{i+1}</td>
                <td className="center">{r.pilot.rank}</td>
                <td>{r.pilot.name}</td>
                {MISSION_BUCKETS.map(b => (
                  <td key={b} className="num">{r.soloByBucket[b] > 0 ? r.soloByBucket[b] : ""}</td>
                ))}
                <td className="num"><b>{r.totalSorties}</b></td>
                <td className="num">{r.totalHours.toFixed(1)}</td>
                <td className="center">{r.lastSoloDate || "—"}</td>
              </tr>
            ))}
            {missionSolo.length === 0 && (
              <tr><td colSpan={MISSION_BUCKETS.length + 6} className="center" style={{padding:"12px"}}>No pilots in roster.</td></tr>
            )}
            {missionSolo.length > 0 && (
              <tr style={{background:"#f3f4f6", fontWeight:700}}>
                <td colSpan={3} className="center">TOTAL</td>
                {MISSION_BUCKETS.map(b => (
                  <td key={b} className="num">{missionSolo.reduce((a,r) => a + r.soloByBucket[b], 0) || ""}</td>
                ))}
                <td className="num">{missionSolo.reduce((a,r) => a + r.totalSorties, 0)}</td>
                <td className="num">{missionSolo.reduce((a,r) => a + r.totalHours, 0).toFixed(1)}</td>
                <td></td>
              </tr>
            )}
          </tbody>
        </table>
        <div style={{marginTop:6, fontSize:10, color:"#444"}}>
          <b>SOLO</b> = sortie where the pilot earned non-dual seat hours and no dual instruction occurred on the flight.
          Used by the standardisation officer to track PIC currency and instructor-vs-student utilisation.
        </div>
        <div className="secret" style={{marginTop:8}}>SECRET ( WHEN FILLED )</div>
      </section>

      {/* ───────── ARABIC ROSTER ───────── */}
      <section className="form-page" data-testid="arabic-roster" dir="rtl">
        <div className="form-meta" dir="ltr">
          <div className="text-center" style={{flex:1}}>
            <div className="form-title">{groupName}<br/>NO {sqdnNumber} SQDN</div>
          </div>
        </div>
        <div className="secret">SECRET ( WHEN FILLED )</div>
        <table>
          <thead>
            <tr>
              <th>الرقم</th>
              <th>الرتبة</th>
              <th>الاسم</th>
              <th>الإختصاص الإضافي</th>
              <th>تاريخ انتهاء الفحص الطبي</th>
              <th>تاريخ آخر طلعة</th>
              <th>{`كامل ساعات طيران ${primaryAirframe}`}</th>
              <th>ساعات الشهر الماضي</th>
              <th>العنوان</th>
              <th>رقم الهاتف</th>
            </tr>
          </thead>
          <tbody>
            {arabicRoster.map((r, i) => (
              <tr key={r.pilot.id} data-testid={`arabic-row-${r.pilot.id}`}>
                <td className="center">{i+1}</td>
                <td className="center">{r.pilot.rank}</td>
                <td>{r.pilot.arabicName || r.pilot.name}</td>
                <td className="center">{inputs.perPilotStatus[r.pilot.id] || ""}</td>
                <td className="center">{r.medicalExpiry || "—"}</td>
                <td className="center">{r.lastFlightDate || "—"}</td>
                <td className="num">{r.cumulativeHoursUH60M.toFixed(1)}</td>
                <td className="num">{r.monthHours.toFixed(1)}</td>
                <td>{r.pilot.address}</td>
                <td className="center" dir="ltr">{r.pilot.phone}</td>
              </tr>
            ))}
            {arabicRoster.length === 0 && (
              <tr><td colSpan={10} className="center" style={{padding:"12px"}}>{t("monthlyEmpty")}</td></tr>
            )}
          </tbody>
        </table>
        <div className="secret" style={{marginTop:8}}>SECRET ( WHEN FILLED )</div>
      </section>
    </div>
  );
}

function NumField({ label, value, onChange, step = 1, testId }: {
  label: string; value: number; onChange: (v: number) => void; step?: number; testId?: string;
}) {
  return (
    <div>
      <label className="text-xs text-muted-foreground">{label}</label>
      <input type="number" step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm"
        data-testid={testId} />
    </div>
  );
}

function TextField({ label, value, onChange, testId }: {
  label: string; value: string; onChange: (v: string) => void; testId?: string;
}) {
  return (
    <div>
      <label className="text-xs text-muted-foreground">{label}</label>
      <input value={value} onChange={e => onChange(e.target.value)}
        className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm"
        data-testid={testId} />
    </div>
  );
}

function AbortPair({ label, s, h, onS, onH, testId }: {
  label: string; s: number; h: number; onS: (v: number) => void; onH: (v: number) => void; testId: string;
}) {
  return (
    <div>
      <label className="text-xs text-muted-foreground">{label}</label>
      <div className="flex gap-1">
        <input type="number" step="1" min="0" value={s}
          onChange={e => onS(parseInt(e.target.value)||0)}
          placeholder="S"
          className="w-1/2 bg-background border border-border rounded px-2 py-1.5 text-sm"
          data-testid={`input-mr-abort-s-${testId}`} />
        <input type="number" step="0.1" min="0" value={h}
          onChange={e => onH(parseFloat(e.target.value)||0)}
          placeholder="H"
          className="w-1/2 bg-background border border-border rounded px-2 py-1.5 text-sm"
          data-testid={`input-mr-abort-h-${testId}`} />
      </div>
    </div>
  );
}

function updPlan(
  inputs: ReportInputs,
  updI: <K extends keyof ReportInputs>(k: K, v: ReportInputs[K]) => void,
  i: number,
  patch: Partial<ReportInputs["nextPlan"][number]>,
) {
  const next = [...inputs.nextPlan];
  next[i] = { ...next[i], ...patch };
  updI("nextPlan", next);
}

/**
 * Field-provenance badge — small coloured tag rendered next to section
 * headers and the legend. Communicates at a glance whether a value comes
 * from the app data, the squadron defaults, or commander judgement.
 */
function Badge({ tone, children }: { tone: "auto" | "default" | "manual"; children: React.ReactNode }) {
  const colors = {
    auto:    "bg-emerald-50 text-emerald-700 border-emerald-300",
    default: "bg-amber-50 text-amber-800 border-amber-300",
    manual:  "bg-slate-100 text-slate-700 border-slate-300",
  } as const;
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[9px] font-semibold tracking-wide ${colors[tone]}`}>
      {children}
    </span>
  );
}
