// 5-step Add Sortie wizard. A guided alternative to the dense form on
// /sortie-add. Reuses the same data hooks (useCreateSortie) and the same
// smart consistency checker (analyzeSortieDraft) so saved sorties are
// indistinguishable from those added through the legacy form. Task #337.

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import DateInput from "@/components/DateInput";
import { ReviewRow, WizardShell, type WizardStep } from "@/components/wizard/WizardShell";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import {
  usePilots, useCreateSortie, deriveSortieBuckets, type Sortie,
} from "@/lib/squadron-data";
import { analyzeSortieDraft } from "@/lib/add-sortie-smart";
import {
  loadSquadronDefaults, hydrateSquadronDefaultsFromDb,
} from "@/lib/squadron-defaults";
import { useFormDraft } from "@/lib/use-form-draft";
import { FormDraftBanner } from "@/components/FormDraftBanner";

const SORTIE_TYPES = [
  "MSN DAY", "MSN NIGHT", "MSN NVG",
  "TRG DAY", "TRG NIGHT", "TRG NVG",
  "NAV", "NAV DAY", "NAV NIGHT",
  "FCF", "ACADEMIC", "EMER", "INSTR",
  "CHECK RIDE", "TRANSPORT", "SAR", "MEDEVAC",
  "IRT", "COURSE DAY", "COURSE NVG", "COURSE NIGHT",
  "EMERGENCY TRAINING", "STAND EVAL",
  "Other…",
];
const DUAL_REQUIRED = new Set([
  "IRT", "COURSE DAY", "COURSE NVG", "COURSE NIGHT",
  "EMERGENCY TRAINING", "STAND EVAL",
]);

type Condition = "Day" | "Night";
type SeatStatus = "1st" | "2nd" | "Dual";
interface Seat {
  id: string;
  status: SeatStatus;
  captain: boolean;
  guest: boolean;
  guestName: string;
  guestSquadron: string;
  guestMil: string;
}
const blankSeat = (status: SeatStatus): Seat => ({
  id: "", status, captain: false,
  guest: false, guestName: "", guestSquadron: "", guestMil: "",
});

interface FormState {
  date: string;
  acType: string;
  acNumber: string;
  pilot: Seat;
  coPilot: Seat;
  sortieType: string;
  sortieTypeOther: string;
  msnDuty: string;
  condition: Condition;
  nvg: boolean;
  time: string;
  dualHours: string;
  instrumentFlight: boolean;
  ifSim: string;
  ifAct: string;
  ils: string;
  vor: string;
  remarks: string;
}

function blankForm(primaryAirframe: string): FormState {
  return {
    date: new Date().toISOString().slice(0, 10),
    acType: primaryAirframe,
    acNumber: "",
    pilot: { ...blankSeat("1st") },
    coPilot: { ...blankSeat("2nd") },
    sortieType: "TRG DAY",
    sortieTypeOther: "",
    msnDuty: "",
    condition: "Day",
    nvg: false,
    time: "",
    dualHours: "",
    instrumentFlight: false,
    ifSim: "",
    ifAct: "",
    ils: "",
    vor: "",
    remarks: "",
  };
}

export default function AddSortieWizard() {
  const { t, rankOf } = useI18n();
  const { toast } = useToast();
  const auth = useAuth();
  const [, navigate] = useLocation();
  const { data: PILOTS } = usePilots();
  const create = useCreateSortie();

  const [defaultsRev, setDefaultsRev] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void hydrateSquadronDefaultsFromDb(auth.squadron?.number).then(ok => {
      if (!cancelled && ok) setDefaultsRev(r => r + 1);
    });
    return () => { cancelled = true; };
  }, [auth.squadron?.number]);
  const sqdnDefaults = useMemo(
    () => loadSquadronDefaults(auth.squadron?.number),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [auth.squadron?.number, defaultsRev],
  );
  const acTypeOptions = sqdnDefaults.airframes;
  const noAircraftConfigured = acTypeOptions.length === 0;

  const [form, setForm] = useState<FormState>(() =>
    blankForm(sqdnDefaults.primaryAirframe || acTypeOptions[0] || "UH-60M"));
  const [step, setStep] = useState(0);

  // Persist the in-flight wizard state (form + current step) so a
  // LAN drop or reload mid-wizard doesn't cost the operator their
  // typing. We bundle into a single blob keyed by `draft.add-sortie-wizard`
  // so Restore puts the operator back on the exact step they left.
  type WizardDraft = { form: FormState; step: number };
  const wizardState: WizardDraft = useMemo(() => ({ form, step }), [form, step]);
  const setWizardState = (next: WizardDraft) => { setForm(next.form); setStep(next.step); };
  const draft = useFormDraft<WizardDraft>("draft.add-sortie-wizard", wizardState, setWizardState);

  // Seed pilot defaults once roster loads.
  useEffect(() => {
    if (!form.pilot.id && PILOTS[0]) {
      setForm(f => ({
        ...f,
        pilot: { ...f.pilot, id: PILOTS[0].id },
        coPilot: { ...f.coPilot, id: PILOTS[1]?.id ?? PILOTS[0].id },
      }));
    }
  }, [PILOTS, form.pilot.id]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm(f => ({ ...f, [k]: v }));
  const setSeat = (which: "pilot" | "coPilot", patch: Partial<Seat>) =>
    setForm(f => ({ ...f, [which]: { ...f[which], ...patch } }));

  const pilotById = (id: string) => PILOTS.find(p => p.id === id);
  const seatLabel = (s: Seat) => {
    if (s.guest) return s.guestName.trim() || "Guest pilot";
    const p = pilotById(s.id);
    if (!p) return s.id || "—";
    return p.flightName?.trim() || `${rankOf(p)} ${p.name}`;
  };

  const sortieTypeFinal = form.sortieType === "Other…"
    ? (form.sortieTypeOther.trim() || "OTHER")
    : form.sortieType;

  const smart = useMemo(() => analyzeSortieDraft({
    date: form.date,
    acType: form.acType,
    acNumber: form.acNumber,
    sortieType: sortieTypeFinal,
    condition: form.condition,
    nvg: form.nvg,
    time: parseFloat(form.time || "0") || 0,
    dualHours: parseFloat(form.dualHours || "0") || 0,
    instrumentFlight: form.instrumentFlight,
    ifSim: parseFloat(form.ifSim || "0") || 0,
    ifAct: parseFloat(form.ifAct || "0") || 0,
  }, []), [form, sortieTypeFinal]);

  // ── Steps ──────────────────────────────────────────────────────
  const steps: WizardStep[] = [
    {
      id: "flight",
      label: t("sortieWizardStepFlight"),
      hint: t("sortieWizardHintFlight"),
      validate: () => {
        if (!form.acType.trim()) return t("sortieWizardErrAircraft");
        return null;
      },
      body: (
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Date">
            <DateInput
              value={form.date}
              onChange={v => set("date", v)}
              max={new Date().toISOString().slice(0, 10)}
              data-testid="wizard-sortie-date"
              data-wizard-autofocus
              className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm font-mono"
            />
          </Field>
          <Field label="A/C Type">
            {noAircraftConfigured ? (
              <input
                type="text"
                value={form.acType}
                onChange={e => set("acType", e.target.value)}
                placeholder="e.g. UH-60M"
                className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm"
                data-testid="wizard-sortie-actype"
              />
            ) : (
              <select
                value={form.acType}
                onChange={e => set("acType", e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm"
                data-testid="wizard-sortie-actype"
              >
                {acTypeOptions.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            )}
          </Field>
          <Field label="A/C No">
            <input
              type="text"
              value={form.acNumber}
              onChange={e => set("acNumber", e.target.value)}
              placeholder="e.g. 832"
              className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm font-mono"
              data-testid="wizard-sortie-acnumber"
            />
          </Field>
        </div>
      ),
    },
    {
      id: "crew",
      label: t("sortieWizardStepCrew"),
      hint: t("sortieWizardHintCrew"),
      validate: () => {
        if (form.pilot.guest && !form.pilot.guestName.trim()) return t("sortieWizardErrGuestName");
        if (form.coPilot.guest && !form.coPilot.guestName.trim()) return t("sortieWizardErrGuestName");
        if (form.pilot.guest && !form.pilot.guestMil.trim()) return t("sortieWizardErrGuestMil");
        if (form.coPilot.guest && !form.coPilot.guestMil.trim()) return t("sortieWizardErrGuestMil");
        if (!form.pilot.guest && !form.coPilot.guest && form.pilot.id === form.coPilot.id && form.pilot.id) {
          return t("sortieWizardErrSamePilot");
        }
        return null;
      },
      body: (
        <div className="grid lg:grid-cols-2 gap-3">
          <SeatPanel
            label="Pilot"
            testId="pilot"
            seat={form.pilot}
            pilots={PILOTS}
            rankOf={rankOf}
            onChange={p => setSeat("pilot", p)}
          />
          <SeatPanel
            label="Co-Pilot"
            testId="copilot"
            seat={form.coPilot}
            pilots={PILOTS}
            rankOf={rankOf}
            onChange={p => setSeat("coPilot", p)}
          />
        </div>
      ),
    },
    {
      id: "mission",
      label: t("sortieWizardStepMission"),
      hint: t("sortieWizardHintMission"),
      body: (
        <div className="space-y-3">
          <Field label="Sortie type">
            <select
              value={form.sortieType}
              onChange={e => set("sortieType", e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm"
              data-testid="wizard-sortie-type"
              data-wizard-autofocus
            >
              {SORTIE_TYPES.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>
          {form.sortieType === "Other…" && (
            <Field label="Custom sortie type">
              <input
                type="text"
                value={form.sortieTypeOther}
                onChange={e => set("sortieTypeOther", e.target.value)}
                placeholder="Type your own…"
                className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm"
                data-testid="wizard-sortie-type-other"
              />
            </Field>
          )}
          <Field label="MSN / Duty (optional)">
            <input
              type="text"
              value={form.msnDuty}
              onChange={e => set("msnDuty", e.target.value)}
              placeholder="Mission name / duty"
              className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm"
              data-testid="wizard-sortie-msn"
            />
          </Field>
          <Field label="Condition">
            <div className="flex gap-2">
              <ToggleBtn active={form.condition === "Day"} onClick={() => { set("condition", "Day"); set("nvg", false); }} testId="wizard-sortie-day">DAY</ToggleBtn>
              <ToggleBtn active={form.condition === "Night"} onClick={() => set("condition", "Night")} testId="wizard-sortie-night">NIGHT</ToggleBtn>
              <label className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border ${
                form.condition === "Day" ? "opacity-40 cursor-not-allowed border-border bg-secondary"
                : form.nvg ? "bg-rose-500/20 border-rose-400 text-rose-200"
                : "bg-secondary border-border cursor-pointer"
              }`}>
                <input
                  type="checkbox"
                  checked={form.nvg}
                  disabled={form.condition === "Day"}
                  onChange={e => set("nvg", e.target.checked)}
                  className="h-3.5 w-3.5 accent-rose-400"
                  data-testid="wizard-sortie-nvg"
                />
                <span className="font-semibold">NVG</span>
              </label>
            </div>
          </Field>
        </div>
      ),
    },
    {
      id: "hours",
      label: t("sortieWizardStepHours"),
      hint: t("sortieWizardHintHours"),
      validate: () => {
        const time = parseFloat(form.time || "0") || 0;
        const dual = parseFloat(form.dualHours || "0") || 0;
        if (!(time > 0) && !(dual > 0)) return t("sortieWizardErrHours");
        if (smart.errors.length > 0) return smart.errors[0];
        return null;
      },
      body: (
        <div className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Time (hrs)">
              <input
                type="number"
                step="0.1"
                value={form.time}
                onChange={e => set("time", e.target.value)}
                placeholder="0.0"
                className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm font-mono"
                data-testid="wizard-sortie-time"
                data-wizard-autofocus
              />
            </Field>
            <Field label="Dual (hrs)">
              <input
                type="number"
                step="0.1"
                value={form.dualHours}
                onChange={e => set("dualHours", e.target.value)}
                placeholder="0.0"
                className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm font-mono"
                data-testid="wizard-sortie-dual"
              />
            </Field>
          </div>
          <div className="border border-border rounded-md p-3 bg-sky-500/5">
            <label className="inline-flex items-center gap-2 cursor-pointer select-none mb-2">
              <input
                type="checkbox"
                checked={form.instrumentFlight}
                onChange={e => set("instrumentFlight", e.target.checked)}
                className="h-4 w-4 accent-sky-400"
                data-testid="wizard-sortie-if-toggle"
              />
              <span className="text-xs font-semibold uppercase tracking-wider">Instrument Flight</span>
            </label>
            {form.instrumentFlight && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <Field label="SIM (hrs)">
                  <input type="number" step="0.1" value={form.ifSim} onChange={e => set("ifSim", e.target.value)} placeholder="0.0" className="w-full px-2 py-1.5 rounded-md bg-input border border-border text-xs font-mono" data-testid="wizard-sortie-ifsim" />
                </Field>
                <Field label="Actual (hrs)">
                  <input type="number" step="0.1" value={form.ifAct} onChange={e => set("ifAct", e.target.value)} placeholder="0.0" className="w-full px-2 py-1.5 rounded-md bg-input border border-border text-xs font-mono" data-testid="wizard-sortie-ifact" />
                </Field>
                <Field label="ILS approaches">
                  <input type="number" step="1" value={form.ils} onChange={e => set("ils", e.target.value)} placeholder="0" className="w-full px-2 py-1.5 rounded-md bg-input border border-border text-xs font-mono" data-testid="wizard-sortie-ils" />
                </Field>
                <Field label="VOR approaches">
                  <input type="number" step="1" value={form.vor} onChange={e => set("vor", e.target.value)} placeholder="0" className="w-full px-2 py-1.5 rounded-md bg-input border border-border text-xs font-mono" data-testid="wizard-sortie-vor" />
                </Field>
              </div>
            )}
          </div>
          <Field label="Remarks (optional)">
            <textarea
              value={form.remarks}
              onChange={e => set("remarks", e.target.value)}
              rows={2}
              className="w-full px-3 py-1.5 rounded-md bg-input border border-border text-xs resize-none"
              placeholder="Notes (weather, aborts, maintenance, etc.)"
              data-testid="wizard-sortie-remarks"
            />
          </Field>
          {(smart.errors.length > 0 || smart.warnings.length > 0) && (
            <div
              className={`rounded-md border p-2 text-xs space-y-1 ${
                smart.errors.length > 0
                  ? "border-destructive/60 bg-destructive/10 text-rose-200"
                  : "border-amber-400/40 bg-amber-500/10 text-amber-100"
              }`}
              data-testid="wizard-sortie-smart"
            >
              <div className="font-semibold">
                {smart.errors.length > 0 ? "Fix before saving" : "Smart checks"}
              </div>
              {smart.errors.map((m, i) => <div key={`e-${i}`}>- {m}</div>)}
              {smart.warnings.map((m, i) => <div key={`w-${i}`}>- {m}</div>)}
            </div>
          )}
        </div>
      ),
    },
    {
      id: "review",
      label: t("sortieWizardStepReview"),
      hint: t("sortieWizardHintReview"),
      body: (
        <div className="space-y-1" data-testid="wizard-sortie-review">
          <ReviewRow label="Date" value={form.date} testId="review-date" />
          <ReviewRow label="Aircraft" value={`${form.acType} ${form.acNumber}`.trim()} testId="review-ac" />
          <ReviewRow label="Pilot" value={`${seatLabel(form.pilot)} · ${form.pilot.status}${form.pilot.captain ? " · CAP" : ""}`} testId="review-pilot" />
          <ReviewRow label="Co-Pilot" value={`${seatLabel(form.coPilot)} · ${form.coPilot.status}${form.coPilot.captain ? " · CAP" : ""}`} testId="review-copilot" />
          <ReviewRow label="Sortie type" value={sortieTypeFinal} testId="review-type" />
          {form.msnDuty.trim() && <ReviewRow label="MSN / Duty" value={form.msnDuty} />}
          <ReviewRow
            label="Condition"
            value={form.condition === "Day" ? "Day" : form.nvg ? "Night · NVG" : "Night"}
            testId="review-cond"
          />
          <ReviewRow label="Time (hrs)" value={form.time || "0"} testId="review-time" />
          <ReviewRow label="Dual (hrs)" value={form.dualHours || "0"} testId="review-dual" />
          {form.instrumentFlight && (
            <ReviewRow
              label="Instrument flight"
              value={`SIM ${form.ifSim || 0}h · Actual ${form.ifAct || 0}h · ILS ${form.ils || 0} · VOR ${form.vor || 0}`}
              testId="review-if"
            />
          )}
          {form.remarks.trim() && <ReviewRow label="Remarks" value={form.remarks} />}
        </div>
      ),
    },
  ];

  const submit = async () => {
    const time = parseFloat(form.time || "0") || 0;
    const dual = parseFloat(form.dualHours || "0") || 0;
    const cond: "Day" | "Night" | "NVG" =
      form.condition === "Day" ? "Day" : form.nvg ? "NVG" : "Night";
    const dualRequired = DUAL_REQUIRED.has(sortieTypeFinal.toUpperCase());
    const effCo = dualRequired ? "Dual" : form.coPilot.status;
    const merged = deriveSortieBuckets({
      time: time + dual,
      condition: cond,
      pilotStatus: form.pilot.status,
      coPilotStatus: effCo as SeatStatus,
    });
    const ifSim = parseFloat(form.ifSim || "0") || 0;
    const ifAct = parseFloat(form.ifAct || "0") || 0;
    const eitherDual = form.pilot.status === "Dual" || effCo === "Dual" || dualRequired;
    const payload: Omit<Sortie, "id"> = {
      date: form.date,
      acType: form.acType,
      acNumber: form.acNumber.trim(),
      pilotId: form.pilot.guest ? "" : form.pilot.id,
      coPilotId: form.coPilot.guest ? "" : form.coPilot.id,
      pilotExternal: form.pilot.guest
        ? { name: form.pilot.guestName.trim(), squadron: form.pilot.guestSquadron.trim() }
        : undefined,
      coPilotExternal: form.coPilot.guest
        ? { name: form.coPilot.guestName.trim(), squadron: form.coPilot.guestSquadron.trim() }
        : undefined,
      sortieType: sortieTypeFinal,
      name: form.msnDuty.trim() || sortieTypeFinal,
      condition: cond,
      remarks: form.remarks.trim() || undefined,
      day1: merged.day1, day2: merged.day2, dayDual: merged.dayDual,
      night1: merged.night1, night2: merged.night2, nightDual: merged.nightDual,
      nvg: merged.nvg,
      nvg1: merged.nvg1 || undefined,
      nvg2: merged.nvg2 || undefined,
      nvgDual: merged.nvgDual || undefined,
      sim: ifSim,
      actual: time + dual,
      time: time + dual,
      dual: dual > 0 || eitherDual,
      pilotPosition: form.pilot.status === "2nd" ? "2nd" : "1st",
      coPilotPosition: form.coPilot.status === "1st" ? "1st" : "2nd",
      pilotSeatStatus: form.pilot.status,
      coPilotSeatStatus: effCo as SeatStatus,
      pilotIsCaptain: !!form.pilot.captain,
      coPilotIsCaptain: !!form.coPilot.captain,
      msnDuty: form.msnDuty.trim() || undefined,
      instrumentFlight: form.instrumentFlight,
      ifSim: form.instrumentFlight ? ifSim : undefined,
      ifAct: form.instrumentFlight ? ifAct : undefined,
      ils: form.instrumentFlight ? (parseInt(form.ils || "0") || 0) : undefined,
      vor: form.instrumentFlight ? (parseInt(form.vor || "0") || 0) : undefined,
    };
    try {
      await create.mutateAsync(payload);
      // Successful create — drop the persisted draft so the next visit
      // to the wizard starts clean. Failed creates keep the draft so
      // the operator can retry without retyping.
      draft.discardDraft();
      toast({ title: t("sortieWizardSavedTitle") });
      navigate("/sortie-add");
    } catch {
      /* surfaced by global error toast */
    }
  };

  return (
    <div className="space-y-2">
      <FormDraftBanner
        hasDraft={draft.hasDraft}
        onRestore={draft.restoreDraft}
        onDiscard={draft.discardDraft}
        testIdSuffix="add-sortie-wizard"
      />
      <WizardShell
        title={t("sortieWizardTitle")}
        subtitle={t("sortieWizardSubtitle")}
        steps={steps}
        current={step}
        onChange={setStep}
        onFinish={submit}
        busy={create.isPending}
        testIdPrefix="wiz-sortie"
        onCancel={() => navigate("/sortie-add")}
      />
    </div>
  );
}

// ── Local helpers ───────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function ToggleBtn({ active, onClick, children, testId }: { active: boolean; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`px-3 py-1.5 rounded-md text-xs font-semibold border transition-colors ${
        active ? "bg-primary/20 border-primary text-primary" : "bg-secondary border-border text-muted-foreground"
      }`}
    >
      {children}
    </button>
  );
}

interface SeatPanelProps {
  label: string;
  testId: string;
  seat: Seat;
  pilots: ReturnType<typeof usePilots>["data"];
  rankOf: (p: { rank: string; rankEn?: string | null }) => string;
  onChange: (patch: Partial<Seat>) => void;
}

function SeatPanel({ label, testId, seat, pilots, rankOf, onChange }: SeatPanelProps) {
  const opts = pilots.map(p => ({
    value: p.id,
    label: p.flightName?.trim() || `${rankOf(p)} ${p.name}`,
  }));
  const statuses: { v: SeatStatus; label: string; cls: string }[] = [
    { v: "1st", label: "1st PLT", cls: "bg-primary text-primary-foreground border-primary" },
    { v: "2nd", label: "2nd PLT", cls: "bg-sky-500/20 border-sky-400 text-sky-200" },
    { v: "Dual", label: "Dual", cls: "bg-violet-500/20 border-violet-400 text-violet-200" },
  ];
  return (
    <div className="border border-border rounded-md p-3 bg-secondary/20 space-y-2" data-testid={`wizard-seat-${testId}`}>
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
        <button
          type="button"
          onClick={() => onChange({ guest: !seat.guest })}
          data-testid={`wizard-seat-${testId}-guest`}
          className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${
            seat.guest ? "bg-emerald-500/20 border-emerald-400 text-emerald-200"
                       : "bg-secondary border-border text-muted-foreground"
          }`}
        >
          {seat.guest ? "Guest" : "Roster"}
        </button>
      </div>
      {seat.guest ? (
        <div className="space-y-1.5">
          <input
            type="text"
            value={seat.guestSquadron}
            onChange={e => onChange({ guestSquadron: e.target.value })}
            placeholder="Squadron name (e.g. 7 Sqn)"
            className="w-full px-2 py-1.5 rounded-md bg-input border border-border text-xs"
            data-testid={`wizard-seat-${testId}-guest-sqn`}
          />
          <input
            type="text"
            value={seat.guestName}
            onChange={e => onChange({ guestName: e.target.value })}
            placeholder="Pilot name (rank + name)"
            className="w-full px-2 py-1.5 rounded-md bg-input border border-border text-xs"
            data-testid={`wizard-seat-${testId}-guest-name`}
          />
          <input
            type="text"
            value={seat.guestMil}
            onChange={e => onChange({ guestMil: e.target.value })}
            placeholder="Military number (required) *"
            className="w-full px-2 py-1.5 rounded-md bg-input border border-border text-xs font-mono"
            data-testid={`wizard-seat-${testId}-guest-mil`}
          />
        </div>
      ) : (
        <select
          className="w-full px-2 py-1.5 rounded-md bg-input border border-border text-xs font-bold"
          value={seat.id}
          onChange={e => onChange({ id: e.target.value })}
          data-testid={`wizard-seat-${testId}-pilot`}
        >
          {opts.length === 0 && <option value="">(no pilots in roster)</option>}
          {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      <div className="flex gap-1.5">
        {statuses.map(s => (
          <button
            key={s.v}
            type="button"
            onClick={() => onChange({ status: s.v })}
            data-testid={`wizard-seat-${testId}-status-${s.v.toLowerCase()}`}
            className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-semibold border transition-colors ${
              seat.status === s.v ? s.cls : "bg-secondary border-border text-muted-foreground"
            }`}
          >{s.label}</button>
        ))}
      </div>
      <label className="inline-flex items-center gap-2 px-2 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-[11px] w-full cursor-pointer">
        <input
          type="checkbox"
          checked={seat.captain}
          onChange={e => onChange({ captain: e.target.checked })}
          className="h-3.5 w-3.5 accent-amber-400"
          data-testid={`wizard-seat-${testId}-captain`}
        />
        <span className="font-semibold text-amber-300">Count as Captain (CAP)</span>
      </label>
    </div>
  );
}
