import { useEffect, useMemo, useState } from "react";
import DateInput from "@/components/DateInput";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { usePilots } from "@/lib/squadron-data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Printer, RotateCcw } from "lucide-react";

/**
 * Rotary-Wing Risk Assessment Matrix
 *
 * Faithful digital re-creation of the paper RJAF rotary-wing form. Each
 * grid section lets the user click one cell; a small ring appears around
 * the chosen number (mirrors the pencil-circle on paper) and the value
 * flows into the live total. NVG sections only contribute when the
 * "Include NVG mission" toggle is on. Color band changes per the
 * computation rules printed at the bottom of the form.
 *
 * State persists to localStorage so a refresh / print preview round-trip
 * doesn't wipe the work in progress.
 */

const STORAGE_KEY = "rjaf.riskAssessment.v1";
const DEFAULTS_KEY = "rjaf.riskAssessment.defaults.v1";

interface RiskDefaults { rank: string; signName: string; }
function loadRiskDefaults(): RiskDefaults {
  try {
    const raw = localStorage.getItem(DEFAULTS_KEY);
    if (!raw) return { rank: "", signName: "" };
    const p = JSON.parse(raw);
    return { rank: String(p.rank ?? ""), signName: String(p.signName ?? "") };
  } catch { return { rank: "", signName: "" }; }
}
function saveRiskDefaults(d: RiskDefaults) {
  localStorage.setItem(DEFAULTS_KEY, JSON.stringify(d));
}

// ---------------------- Section data (mirrors paper form) -----------------

type CellPick = { row: number; col: number; value: number } | null;

// 1. Supervision: rows = Parent Unit / Attached, cols = Basic / Tactical
const SUPERVISION = {
  rows: ["Parent Unit", "Attached"],
  cols: ["BASIC Day/Night", "TACTICAL Day/Night"],
  values: [[1, 2], [2, 4]],
};

// 2. Planning: rows = Vague/Implied/Specific (guidance), cols = In-depth/Adequate/Minimal
const PLANNING = {
  rows: ["Vague", "Implied", "Specific"],
  cols: ["In-depth", "Adequate", "Minimal"],
  values: [
    [3, 4, 5],
    [2, 3, 4],
    [1, 2, 3],
  ],
};

// 3/4/5. Crew Sel/PC, /PI, /Add: rows = Time in AO, cols = Total Time
const CREW_SEL = {
  rows: ["<25", "<50", ">50"],
  cols: [">2000", "<2000", "<1000", "<500"],
  values: [
    [3, 4, 5, 6],
    [2, 3, 4, 5],
    [1, 2, 3, 4],
  ],
};

// 8. Crew Endurance: rows = Field/Garrison, cols = >8 / 6-8 / <6 hrs of rest
const ENDURANCE = {
  rows: ["Field", "Garrison"],
  cols: [">8 hrs", "6-8 hrs", "<6 hrs"],
  values: [
    [2, 6, 10],
    [1, 4, 10],
  ],
};

// 9. Complexity: each row × col is independently selectable (multi-pick); sum.
const COMPLEXITY_ROWS = [
  "Multiship", "Firing", "Sling Load", "Stabo/Rappel/Fast Rope",
  "Terrain FLT", "Dust Landing", "Paradrop", "Routine", "NOE", "MTF/Maint Recovery",
];
const COMPLEXITY_COLS = ["VMC D", "VMC N", "NVG", "IMC Hood"];
//                                  D   N  NVG  IMC
const COMPLEXITY_VALUES: (number | null)[][] = [
  [2, 6, 4, null],   // Multiship
  [2, 3, 5, null],   // Firing
  [2, 3, 5, null],   // Sling Load
  [1, 2, 4, null],   // Stabo
  [1, 3, 4, null],   // Terrain FLT
  [2, 6, 5, null],   // Dust Landing
  [2, 2, null, null],// Paradrop
  [1, 2, 2, null],   // Routine
  [2, 8, 4, null],   // NOE
  [3, 5, 8, null],   // MTF
];

// 10. Weather: rows = D / N / NVG, cols = <500/1, >1000/3, <1000/3, <700/2
const WEATHER = {
  rows: ["Day", "Night", "NVG"],
  cols: ["<500/1", ">1000/3", "<1000/3", "<700/2"],
  values: [
    [1, 3, 4, 6],   // Day
    [2, 4, 6, 10],  // Night
    [1, 3, 4, 8],   // NVG
  ],
};

// 11. Additional Risk Factors (Day/Night)
const ADD_FACTORS_DN = [
  { k: "single", label: "Single pilot", v: 8 },
  { k: "onecrew", label: "1 Crew man",  v: 4 },
  { k: "nocrew",  label: "No crewmen",  v: 6 },
];

// 12/13/14. NVG Crew Sel/PC, /PI, /Add: TOTAL NVG TIME
const NVG_CREW = {
  cols: [">150", "<150", "<100", "<50", "<25"],
  values: [1, 2, 3, 4, 5],
};

// 15. % Illumination (NVG)
const ILLUM = {
  cols: ["100-80", "79-60", "59-40", "39-23", "<23"],
  values: [1, 2, 3, 4, 5],
};

// 16. Moon Angle (NVG)
const MOON = {
  cols: ["90-70", "69-50", "49-30", "<30"],
  values: [0, 1, 2, 3],
};

// ----------------------------- Form state --------------------------------

interface FormState {
  pic: string;
  copilot: string;
  crew: string;
  mission: string;
  date: string;
  // Section picks
  s1: CellPick;
  s2: CellPick;
  s3: CellPick;
  s4: CellPick;
  s5: CellPick;
  s6: 0 | 2 | null;       // crew coordination trained: Yes=0 / No=+2
  s7: 0 | 5 | null;       // METL task supported: Yes=0 / No=5*
  s8: CellPick;
  s8_lastHalf: boolean;   // +2 last half of duty day
  s9: Record<string, boolean>; // key = `${row}-${col}`
  s10: CellPick;
  s11: Record<string, boolean>; // selected additional factors (DN)
  // NVG
  includeNvg: boolean;
  s12: number | null;
  s13: number | null;
  s14: number | null;
  s15: number | null;
  s16: number | null;
  s17_addRiskNvg: number; // free-form add
  // Footer
  comments: string;
  rank: string;
  signName: string;
}

const EMPTY: FormState = {
  pic: "", copilot: "", crew: "", mission: "",
  date: new Date().toISOString().slice(0, 10),
  s1: null, s2: null, s3: null, s4: null, s5: null,
  s6: null, s7: null,
  s8: null, s8_lastHalf: false,
  s9: {}, s10: null, s11: {},
  includeNvg: false,
  s12: null, s13: null, s14: null, s15: null, s16: null, s17_addRiskNvg: 0,
  comments: "", rank: "", signName: "",
};

// ----------------------------- UI helpers --------------------------------

function ringIfPicked(picked: boolean): string {
  return picked
    ? "ring-2 ring-amber-400 ring-offset-1 ring-offset-background bg-amber-500/20 text-amber-200 font-bold"
    : "hover:bg-muted/40";
}

// Renders a clickable matrix where exactly one cell can be selected.
function PickMatrix({
  rows, cols, values, picked, onPick, idPrefix,
}: {
  rows: string[]; cols: string[]; values: number[][];
  picked: CellPick;
  onPick: (p: CellPick) => void;
  idPrefix: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="text-xs border-collapse">
        <thead>
          <tr>
            <th className="p-1"></th>
            {cols.map(c => <th key={c} className="px-2 py-1 font-medium text-muted-foreground">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((rLabel, r) => (
            <tr key={rLabel}>
              <td className="px-2 py-1 text-muted-foreground whitespace-nowrap">{rLabel}</td>
              {cols.map((_c, c) => {
                const v = values[r][c];
                const isPicked = !!picked && picked.row === r && picked.col === c;
                return (
                  <td key={c} className="p-0.5">
                    <button
                      type="button"
                      onClick={() => onPick(isPicked ? null : { row: r, col: c, value: v })}
                      className={`w-9 h-9 rounded-full border border-border text-sm transition ${ringIfPicked(isPicked)}`}
                      data-testid={`pick-${idPrefix}-${r}-${c}`}
                    >
                      {v}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PickRow({
  cols, values, picked, onPick, idPrefix,
}: {
  cols: string[]; values: number[];
  picked: number | null; onPick: (v: number | null) => void;
  idPrefix: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5 items-center">
      {cols.map((c, i) => {
        const isPicked = picked === values[i];
        return (
          <button
            key={c}
            type="button"
            onClick={() => onPick(isPicked ? null : values[i])}
            className={`min-w-[3.5rem] px-2 h-9 rounded-full border border-border text-xs transition ${ringIfPicked(isPicked)}`}
            data-testid={`pick-${idPrefix}-${i}`}
          >
            <div className="text-[10px] text-muted-foreground leading-tight">{c}</div>
            <div className="font-bold text-sm leading-tight">{values[i]}</div>
          </button>
        );
      })}
    </div>
  );
}

function YesNo({
  yesValue, noValue, picked, onPick, idPrefix,
}: {
  yesValue: 0; noValue: 2 | 5;
  picked: number | null;
  onPick: (v: 0 | 2 | 5 | null) => void;
  idPrefix: string;
}) {
  return (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={() => onPick(picked === yesValue ? null : yesValue)}
        className={`px-4 h-9 rounded-full border border-border text-xs ${ringIfPicked(picked === yesValue)}`}
        data-testid={`pick-${idPrefix}-yes`}
      >
        YES (+{yesValue})
      </button>
      <button
        type="button"
        onClick={() => onPick(picked === noValue ? null : noValue)}
        className={`px-4 h-9 rounded-full border border-border text-xs ${ringIfPicked(picked === noValue)}`}
        data-testid={`pick-${idPrefix}-no`}
      >
        NO (+{noValue}{noValue === 5 ? "*" : ""})
      </button>
    </div>
  );
}

// ----------------------------- Main page ---------------------------------

export default function Risk() {
  const { t } = useI18n();
  const pilots = usePilots();

  const [form, setForm] = useState<FormState>(() => {
    const defaults = loadRiskDefaults();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = { ...EMPTY, ...JSON.parse(raw) } as FormState;
        // Apply rank/signName defaults only when the form was reset/blank.
        if (!parsed.rank) parsed.rank = defaults.rank;
        if (!parsed.signName) parsed.signName = defaults.signName;
        return parsed;
      }
    } catch { /* swallow */ }
    return { ...EMPTY, rank: defaults.rank, signName: defaults.signName };
  });
  const [defaults, setDefaults] = useState<RiskDefaults>(() => loadRiskDefaults());
  const [showDefaults, setShowDefaults] = useState(false);
  const [defaultsSavedFlash, setDefaultsSavedFlash] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(form)); } catch { /* swallow */ }
  }, [form]);

  function up<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm(prev => ({ ...prev, [k]: v }));
  }

  // -------------------- Live calculations -------------------------------
  const dnTotal = useMemo(() => {
    let s = 0;
    [form.s1, form.s2, form.s3, form.s4, form.s5, form.s8, form.s10].forEach(p => { if (p) s += p.value; });
    if (form.s6 != null) s += form.s6;
    if (form.s7 != null) s += form.s7;
    if (form.s8_lastHalf) s += 2;
    // Section 9 multi-select sum
    Object.entries(form.s9).forEach(([k, on]) => {
      if (!on) return;
      const [r, c] = k.split("-").map(Number);
      const v = COMPLEXITY_VALUES[r]?.[c];
      if (typeof v === "number") s += v;
    });
    // Section 11 additional factors
    ADD_FACTORS_DN.forEach(f => { if (form.s11[f.k]) s += f.v; });
    return s;
  }, [form]);

  const nvgTotal = useMemo(() => {
    if (!form.includeNvg) return 0;
    let s = 0;
    [form.s12, form.s13, form.s14, form.s15, form.s16].forEach(v => { if (v != null) s += v; });
    s += form.s17_addRiskNvg || 0;
    return s;
  }, [form]);

  const totalRisk = dnTotal + nvgTotal;

  function bandDN(score: number) {
    if (score < 16) return { lbl: "LOW RISK", cls: "bg-emerald-600 text-white", note: "Approval: FLIGHT CMDR or higher" };
    if (score <= 28) return { lbl: "MEDIUM RISK *", cls: "bg-amber-500 text-black", note: "Approval: SQDN CMDR or higher" };
    return { lbl: "HIGH RISK **", cls: "bg-rose-600 text-white", note: "Approval: BASE CMDR or higher" };
  }
  function bandNVG(score: number) {
    if (score < 25) return { lbl: "LOW RISK", cls: "bg-emerald-600 text-white", note: "Approval: FLIGHT CMDR or higher" };
    if (score <= 40) return { lbl: "MEDIUM RISK *", cls: "bg-amber-500 text-black", note: "Approval: SQDN CMDR or higher" };
    if (score <= 50) return { lbl: "HIGH RISK **", cls: "bg-rose-600 text-white", note: "Approval: BASE CMDR or higher" };
    return { lbl: "EXTREMELY HIGH RISK ***", cls: "bg-red-900 text-white", note: "Approval: DIRECTOR OF AIR OPS / RJAF CMDR" };
  }
  const dnBand = bandDN(dnTotal);
  const nvgBand = bandNVG(nvgTotal);

  // Roster autofill list of names for the datalists
  const pilotNames = useMemo(
    () => (pilots.data ?? []).map(p => p.name).filter((n, i, a) => n && a.indexOf(n) === i),
    [pilots.data],
  );

  function reset() {
    if (window.confirm("Clear the entire risk assessment form?")) {
      const d = loadRiskDefaults();
      setForm({ ...EMPTY, date: new Date().toISOString().slice(0, 10), rank: d.rank, signName: d.signName });
    }
  }

  function applyDefaults() {
    saveRiskDefaults(defaults);
    // Also fill the live form's rank/signName when blank, so the operator
    // immediately sees the new defaults reflected without a manual reset.
    setForm(prev => ({
      ...prev,
      rank: prev.rank || defaults.rank,
      signName: prev.signName || defaults.signName,
    }));
    setDefaultsSavedFlash(true);
    setTimeout(() => setDefaultsSavedFlash(false), 1400);
  }

  // Section 9 toggle helper
  function toggleS9(r: number, c: number) {
    if (COMPLEXITY_VALUES[r][c] == null) return;
    const k = `${r}-${c}`;
    setForm(prev => ({ ...prev, s9: { ...prev.s9, [k]: !prev.s9[k] } }));
  }

  return (
    <div className="space-y-4 print:space-y-1 print-area print:text-[10px]">
      <PageHead
        title={t("nav_risk")}
        subtitle="Rotary-Wing Risk Assessment Matrix"
        actions={
          <div className="flex gap-2 print:hidden">
            <Button variant="outline" onClick={() => setShowDefaults(v => !v)} data-testid="button-risk-defaults">
              Default Settings
            </Button>
            <Button variant="outline" onClick={reset} data-testid="button-risk-reset">
              <RotateCcw className="h-4 w-4 mr-1" /> Reset
            </Button>
            <Button onClick={() => window.print()} data-testid="button-risk-print">
              <Printer className="h-4 w-4 mr-1" /> Print
            </Button>
          </div>
        }
      />

      {showDefaults && (
        <Card className="print:hidden border-amber-500/40">
          <div className="text-sm font-semibold mb-2">Default Settings</div>
          <div className="text-xs text-muted-foreground mb-3">
            Set the default Rank and Name that auto-fill the signature block on every new risk assessment.
            These are stored on this PC only.
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Default RANK</Label>
              <Input
                value={defaults.rank}
                onChange={e => setDefaults(d => ({ ...d, rank: e.target.value }))}
                placeholder="e.g. CAPT"
                data-testid="input-risk-default-rank"
              />
            </div>
            <div>
              <Label className="text-xs">Default NAME</Label>
              <Input
                value={defaults.signName}
                onChange={e => setDefaults(d => ({ ...d, signName: e.target.value }))}
                placeholder="e.g. Abedalqader Ghunmat"
                data-testid="input-risk-default-name"
              />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={applyDefaults} data-testid="button-risk-defaults-save">
              Save defaults
            </Button>
            {defaultsSavedFlash && <span className="text-xs text-emerald-500 font-medium">Saved ✓</span>}
          </div>
        </Card>
      )}

      {/* HEADER — crew, mission, date */}
      <Card>
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <div>
            <Label className="text-xs">PIC</Label>
            <Input
              list="risk-pilot-names"
              value={form.pic}
              onChange={e => up("pic", e.target.value)}
              data-testid="input-risk-pic"
            />
          </div>
          <div>
            <Label className="text-xs">COPILOT</Label>
            <Input
              list="risk-pilot-names"
              value={form.copilot}
              onChange={e => up("copilot", e.target.value)}
              data-testid="input-risk-copilot"
            />
          </div>
          <div>
            <Label className="text-xs">CREW</Label>
            <Input
              value={form.crew}
              onChange={e => up("crew", e.target.value)}
              placeholder="e.g. SGT Ali, SGT Omar"
              data-testid="input-risk-crew"
            />
          </div>
          <div className="md:col-span-1">
            <Label className="text-xs">MISSION</Label>
            <Input value={form.mission} onChange={e => up("mission", e.target.value)} data-testid="input-risk-mission" />
          </div>
          <div>
            <Label className="text-xs">DATE</Label>
            <DateInput value={form.date} onChange={(v) => up("date", v)} data-testid="input-risk-date" className="px-3 py-2 rounded-md bg-input border border-border text-sm" />
          </div>
        </div>
        {/* Datalist used by all pilot-name inputs */}
        <datalist id="risk-pilot-names">
          {pilotNames.map(n => <option key={n} value={n} />)}
        </datalist>
      </Card>

      {/* DAY/NIGHT SECTIONS 1-11 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 print:grid-cols-2 gap-3 print:gap-1">
        <Card>
          <h3 className="text-sm font-semibold mb-2">1. Supervision <span className="text-xs text-muted-foreground">(CMD/Control)</span></h3>
          <PickMatrix rows={SUPERVISION.rows} cols={SUPERVISION.cols} values={SUPERVISION.values}
            picked={form.s1} onPick={p => up("s1", p)} idPrefix="s1" />
        </Card>

        <Card>
          <h3 className="text-sm font-semibold mb-2">2. Planning <span className="text-xs text-muted-foreground">(Guidance × Time)</span></h3>
          <PickMatrix rows={PLANNING.rows} cols={PLANNING.cols} values={PLANNING.values}
            picked={form.s2} onPick={p => up("s2", p)} idPrefix="s2" />
        </Card>

        <Card>
          <h3 className="text-sm font-semibold mb-2">3. Crew Sel/PC <span className="text-xs text-muted-foreground">(Time in AO × Total Time)</span></h3>
          <PickMatrix rows={CREW_SEL.rows} cols={CREW_SEL.cols} values={CREW_SEL.values}
            picked={form.s3} onPick={p => up("s3", p)} idPrefix="s3" />
        </Card>

        <Card>
          <h3 className="text-sm font-semibold mb-2">4. Crew Sel/PI</h3>
          <PickMatrix rows={CREW_SEL.rows} cols={CREW_SEL.cols} values={CREW_SEL.values}
            picked={form.s4} onPick={p => up("s4", p)} idPrefix="s4" />
        </Card>

        <Card>
          <h3 className="text-sm font-semibold mb-2">5. Crew Sel/Add</h3>
          <PickMatrix rows={CREW_SEL.rows} cols={CREW_SEL.cols} values={CREW_SEL.values}
            picked={form.s5} onPick={p => up("s5", p)} idPrefix="s5" />
        </Card>

        <Card>
          <h3 className="text-sm font-semibold mb-2">6. All crew members crew-coordination trained</h3>
          <YesNo yesValue={0} noValue={2} picked={form.s6} onPick={v => up("s6", v as 0 | 2 | null)} idPrefix="s6" />
        </Card>

        <Card>
          <h3 className="text-sm font-semibold mb-2">7. METL Task <span className="text-xs text-muted-foreground">(supported by training manual)</span></h3>
          <YesNo yesValue={0} noValue={5} picked={form.s7} onPick={v => up("s7", v as 0 | 5 | null)} idPrefix="s7" />
          <div className="text-[11px] text-muted-foreground mt-1">* NO requires BASE CMDR approval.</div>
        </Card>

        <Card>
          <h3 className="text-sm font-semibold mb-2">8. Crew Endurance <span className="text-xs text-muted-foreground">(Quality of Rest × Hours)</span></h3>
          <PickMatrix rows={ENDURANCE.rows} cols={ENDURANCE.cols} values={ENDURANCE.values}
            picked={form.s8} onPick={p => up("s8", p)} idPrefix="s8" />
          <label className="flex items-center gap-2 text-xs mt-2">
            <input type="checkbox" checked={form.s8_lastHalf} onChange={e => up("s8_lastHalf", e.target.checked)} data-testid="check-s8-lasthalf" />
            +2 if mission flown during last half of duty day
          </label>
        </Card>

        <Card className="lg:col-span-2">
          <h3 className="text-sm font-semibold mb-2">9. Complexity <span className="text-xs text-muted-foreground">(select every applicable cell — values are summed)</span></h3>
          <div className="overflow-x-auto">
            <table className="text-xs border-collapse">
              <thead>
                <tr>
                  <th className="px-2 py-1"></th>
                  {COMPLEXITY_COLS.map(c => <th key={c} className="px-2 py-1 text-muted-foreground">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {COMPLEXITY_ROWS.map((rLabel, r) => (
                  <tr key={rLabel}>
                    <td className="px-2 py-1 text-muted-foreground whitespace-nowrap">{rLabel}</td>
                    {COMPLEXITY_COLS.map((_c, c) => {
                      const v = COMPLEXITY_VALUES[r][c];
                      if (v == null) {
                        return <td key={c} className="p-0.5"><div className="w-9 h-9 grid place-items-center text-muted-foreground text-[10px]">NA</div></td>;
                      }
                      const k = `${r}-${c}`;
                      const on = !!form.s9[k];
                      return (
                        <td key={c} className="p-0.5">
                          <button
                            type="button"
                            onClick={() => toggleS9(r, c)}
                            className={`w-9 h-9 rounded-full border border-border text-sm transition ${ringIfPicked(on)}`}
                            data-testid={`pick-s9-${r}-${c}`}
                          >
                            {v}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card>
          <h3 className="text-sm font-semibold mb-2">10. Weather <span className="text-xs text-muted-foreground">(Ceiling/Visibility)</span></h3>
          <PickMatrix rows={WEATHER.rows} cols={WEATHER.cols} values={WEATHER.values}
            picked={form.s10} onPick={p => up("s10", p)} idPrefix="s10" />
        </Card>

        <Card>
          <h3 className="text-sm font-semibold mb-2">11. Additional Risk Factors (Day/Night)</h3>
          <div className="space-y-1.5">
            {ADD_FACTORS_DN.map(f => (
              <label key={f.k} className="flex items-center justify-between text-sm border border-border rounded px-2 py-1">
                <span>{f.label}</span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">+{f.v}</span>
                  <input
                    type="checkbox"
                    checked={!!form.s11[f.k]}
                    onChange={e => up("s11", { ...form.s11, [f.k]: e.target.checked })}
                    data-testid={`check-s11-${f.k}`}
                  />
                </span>
              </label>
            ))}
          </div>
        </Card>
      </div>

      {/* NVG TOGGLE & SECTIONS 12-17 */}
      <Card>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={form.includeNvg}
            onChange={e => up("includeNvg", e.target.checked)}
            data-testid="check-include-nvg"
          />
          Include NVG Mission (sections 12-17)
        </label>
      </Card>

      {form.includeNvg && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Card>
            <h3 className="text-sm font-semibold mb-2">12. NVG Crew Sel/PC <span className="text-xs text-muted-foreground">(Total NVG Time)</span></h3>
            <PickRow cols={NVG_CREW.cols} values={NVG_CREW.values} picked={form.s12} onPick={v => up("s12", v)} idPrefix="s12" />
          </Card>
          <Card>
            <h3 className="text-sm font-semibold mb-2">13. NVG Crew Sel/PI</h3>
            <PickRow cols={NVG_CREW.cols} values={NVG_CREW.values} picked={form.s13} onPick={v => up("s13", v)} idPrefix="s13" />
          </Card>
          <Card>
            <h3 className="text-sm font-semibold mb-2">14. NVG Crew Sel/Add</h3>
            <PickRow cols={NVG_CREW.cols} values={NVG_CREW.values} picked={form.s14} onPick={v => up("s14", v)} idPrefix="s14" />
          </Card>
          <Card>
            <h3 className="text-sm font-semibold mb-2">15. % Illumination (NVG)</h3>
            <PickRow cols={ILLUM.cols} values={ILLUM.values} picked={form.s15} onPick={v => up("s15", v)} idPrefix="s15" />
          </Card>
          <Card>
            <h3 className="text-sm font-semibold mb-2">16. Moon Angle (NVG)</h3>
            <PickRow cols={MOON.cols} values={MOON.values} picked={form.s16} onPick={v => up("s16", v)} idPrefix="s16" />
          </Card>
          <Card>
            <h3 className="text-sm font-semibold mb-2">17. Additional Risk Factors (NVG)</h3>
            <Input
              type="number"
              min={0}
              value={form.s17_addRiskNvg}
              onChange={e => up("s17_addRiskNvg", Number(e.target.value) || 0)}
              data-testid="input-s17"
            />
            <div className="text-[11px] text-muted-foreground mt-1">Free-form additional risk total to add to NVG score.</div>
          </Card>
        </div>
      )}

      {/* SUMMARY */}
      <Card>
        <h3 className="text-sm font-semibold mb-2">Risk Summary</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <table className="text-xs w-full">
              <tbody>
                <RiskRow label="1. Supervision"          v={form.s1?.value} />
                <RiskRow label="2. Planning"             v={form.s2?.value} />
                <RiskRow label="3. Crew Sel/PC"          v={form.s3?.value} />
                <RiskRow label="4. Crew Sel/PI"          v={form.s4?.value} />
                <RiskRow label="5. Crew Sel/Add"         v={form.s5?.value} />
                <RiskRow label="6. Crew Coord Trained"   v={form.s6} />
                <RiskRow label="7. METL Task"            v={form.s7} />
                <RiskRow label="8. Crew Endurance"       v={(form.s8?.value ?? 0) + (form.s8_lastHalf ? 2 : 0)} />
                <RiskRow label="9. Complexity"           v={Object.entries(form.s9).reduce((a, [k, on]) => {
                  if (!on) return a;
                  const [r, c] = k.split("-").map(Number);
                  return a + (COMPLEXITY_VALUES[r]?.[c] ?? 0);
                }, 0)} />
                <RiskRow label="10. Weather"             v={form.s10?.value} />
                <RiskRow label="11. Additional (DN)"     v={ADD_FACTORS_DN.reduce((a, f) => a + (form.s11[f.k] ? f.v : 0), 0)} />
                <tr className="border-t-2 border-border">
                  <td className="py-1 font-bold">TOTAL DAY/NIGHT</td>
                  <td className="py-1 text-right font-bold text-lg" data-testid="text-dn-total">{dnTotal}</td>
                </tr>
              </tbody>
            </table>
            <div className={`mt-2 px-3 py-2 rounded font-bold text-sm ${dnBand.cls}`} data-testid="band-dn">
              {dnBand.lbl}
              <div className="text-[11px] font-normal opacity-90">{dnBand.note}</div>
            </div>
          </div>

          {form.includeNvg && (
            <div>
              <table className="text-xs w-full">
                <tbody>
                  <RiskRow label="12. NVG Crew Sel/PC"  v={form.s12} />
                  <RiskRow label="13. NVG Crew Sel/PI"  v={form.s13} />
                  <RiskRow label="14. NVG Crew Sel/Add" v={form.s14} />
                  <RiskRow label="15. Illumination"     v={form.s15} />
                  <RiskRow label="16. Moon Angle"       v={form.s16} />
                  <RiskRow label="17. Additional (NVG)" v={form.s17_addRiskNvg} />
                  <tr className="border-t-2 border-border">
                    <td className="py-1 font-bold">TOTAL NVG</td>
                    <td className="py-1 text-right font-bold text-lg" data-testid="text-nvg-total">{nvgTotal}</td>
                  </tr>
                  <tr>
                    <td className="py-1 font-bold">TOTAL RISK</td>
                    <td className="py-1 text-right font-bold text-lg" data-testid="text-total-risk">{totalRisk}</td>
                  </tr>
                </tbody>
              </table>
              <div className={`mt-2 px-3 py-2 rounded font-bold text-sm ${nvgBand.cls}`} data-testid="band-nvg">
                {nvgBand.lbl}
                <div className="text-[11px] font-normal opacity-90">{nvgBand.note}</div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-3 text-[11px] text-muted-foreground space-y-0.5 border-t border-border pt-2">
          <div>Low risk mission requires approval of the FLIGHT CMDR or higher authority</div>
          <div>* Medium risk mission requires approval of the SQDN CMDR or higher authority</div>
          <div>** High risk mission requires approval of the BASE CMDR or higher authority</div>
          <div>*** Extremely high risk mission requires approval of the DIRECTOR OF AIR OPS / RJAF CMDR</div>
        </div>
      </Card>

      {/* COMMENTS + SIGN */}
      <Card>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="md:col-span-2">
            <Label className="text-xs">Additional Comments</Label>
            <Textarea
              rows={4}
              value={form.comments}
              onChange={e => up("comments", e.target.value)}
              data-testid="input-risk-comments"
            />
          </div>
          <div className="space-y-2">
            <div>
              <Label className="text-xs">RANK</Label>
              <Input value={form.rank} onChange={e => up("rank", e.target.value)} data-testid="input-risk-rank" />
            </div>
            <div>
              <Label className="text-xs">NAME</Label>
              <Input value={form.signName} onChange={e => up("signName", e.target.value)} data-testid="input-risk-signname" />
            </div>
            <div>
              <Label className="text-xs">SIGNATURE</Label>
              <div className="h-12 border border-dashed border-border rounded grid place-items-center text-xs text-muted-foreground">
                Sign on printed copy
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

function RiskRow({ label, v }: { label: string; v: number | null | undefined }) {
  return (
    <tr>
      <td className="py-0.5 text-muted-foreground">{label}</td>
      <td className="py-0.5 text-right font-mono">{v ?? "—"}</td>
    </tr>
  );
}
