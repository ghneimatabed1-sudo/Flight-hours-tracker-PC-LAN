// 4-step Add Pilot wizard. Reuses useCreatePilot — saved pilots are
// indistinguishable from those added through Roster's PilotEditDialog.
// AR + EN names are entered side-by-side on the Identity step. Currency
// dates are entered as "last flown" + auto-computed expiry.
// Task #337.

import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import DateInput from "@/components/DateInput";
import { ReviewRow, WizardShell, type WizardStep } from "@/components/wizard/WizardShell";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { usePilots, useCreatePilot } from "@/lib/squadron-data";
import type { Pilot } from "@/lib/mock";
import { lookupRankEn, RJAF_RANKS } from "@/lib/ranks";
import { getCurrencyWindow } from "@/lib/currency-settings";
import { useFormDraft } from "@/lib/use-form-draft";
import { FormDraftBanner } from "@/components/FormDraftBanner";

interface FormState {
  id: string;
  name: string;
  arabicName: string;
  rank: string;        // Arabic
  rankEn: string;
  militaryNumber: string;
  flightName: string;
  callSign: string;
  unit: Pilot["unit"];
  phone: string;
  address: string;
  doctorNote: string;
  qualifications: string;
  // Currency: store the last-flown date; expiry is computed at submit.
  lfDay: string;
  lfNight: string;
  lfNvg: string;
  lfIrt: string;
  lfMedical: string;
  lfSim: string;
}

function blankForm(nextId: string): FormState {
  return {
    id: nextId,
    name: "",
    arabicName: "",
    rank: "",
    rankEn: "",
    militaryNumber: "",
    flightName: "",
    callSign: "",
    unit: "SQDN",
    phone: "",
    address: "",
    doctorNote: "",
    qualifications: "",
    lfDay: "",
    lfNight: "",
    lfNvg: "",
    lfIrt: "",
    lfMedical: "",
    lfSim: "",
  };
}

function addDaysIso(iso: string, days: number): string {
  if (!iso) return "";
  const parts = iso.split("-").map(Number);
  if (parts.length !== 3) return "";
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function AddPilotWizard() {
  const { t, rankOf } = useI18n();
  const { toast } = useToast();
  const auth = useAuth();
  const [, navigate] = useLocation();
  const { data: PILOTS } = usePilots();
  const create = useCreatePilot();
  const win = getCurrencyWindow();

  const nextId = useMemo(() => {
    const nums = PILOTS.map(p => parseInt(p.id.replace(/\D/g, ""), 10)).filter(n => !isNaN(n));
    const max = nums.length ? Math.max(...nums) : 0;
    return `P${String(max + 1).padStart(3, "0")}`;
  }, [PILOTS]);

  const [form, setForm] = useState<FormState>(() => blankForm(nextId));
  const [step, setStep] = useState(0);

  // Persist the in-flight wizard state (form + current step) so a
  // LAN drop or reload mid-wizard doesn't cost the operator their
  // typing. We bundle into a single blob keyed by `draft.add-pilot-wizard`
  // so Restore puts the operator back on the exact step they left.
  type WizardDraft = { form: FormState; step: number };
  const wizardState: WizardDraft = useMemo(() => ({ form, step }), [form, step]);
  const setWizardState = (next: WizardDraft) => { setForm(next.form); setStep(next.step); };
  const draft = useFormDraft<WizardDraft>("draft.add-pilot-wizard", wizardState, setWizardState);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm(f => ({ ...f, [k]: v }));

  const onArabicRankChange = (next: string) => {
    setForm(f => {
      const auto = lookupRankEn(next);
      const prevAuto = lookupRankEn(f.rank);
      const englishLooksAuto = !f.rankEn || f.rankEn === prevAuto;
      return {
        ...f,
        rank: next,
        rankEn: englishLooksAuto && auto ? auto : (f.rankEn || ""),
      };
    });
  };

  const dupMil = useMemo(() => {
    const mil = form.militaryNumber.trim().toLowerCase();
    if (!mil) return null;
    return PILOTS.find(p => (p.militaryNumber ?? "").trim().toLowerCase() === mil) || null;
  }, [PILOTS, form.militaryNumber]);

  const steps: WizardStep[] = [
    {
      id: "identity",
      label: t("pilotWizardStepIdentity"),
      hint: t("pilotWizardHintIdentity"),
      validate: () => {
        if (!form.name.trim()) return t("pilotWizardErrName");
        if (!form.arabicName.trim()) return t("pilotWizardErrArabicName");
        if (!form.militaryNumber.trim()) return t("err_militaryNumberRequired");
        if (dupMil) return `${t("err_militaryNumberDuplicate")} (${rankOf(dupMil)} ${dupMil.name} · ${dupMil.id})`;
        return null;
      },
      body: (
        <div className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label={`${t("name")} (EN)`}>
              <input
                value={form.name}
                onChange={e => set("name", e.target.value)}
                placeholder="John Smith"
                className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm"
                data-testid="wizard-pilot-name"
                data-wizard-autofocus
              />
            </Field>
            <Field label={`${t("arabicName")} (AR)`}>
              <input
                dir="rtl"
                value={form.arabicName}
                onChange={e => set("arabicName", e.target.value)}
                placeholder="جون سميث"
                className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm text-right"
                data-testid="wizard-pilot-arabic-name"
              />
            </Field>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label={`${t("rank")} (AR)`}>
              <input
                list="wiz-pilot-rank-ar"
                dir="rtl"
                value={form.rank}
                onChange={e => onArabicRankChange(e.target.value)}
                placeholder="رائد طيار"
                className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm text-right"
                data-testid="wizard-pilot-rank"
              />
              <datalist id="wiz-pilot-rank-ar">
                {RJAF_RANKS.map(r => <option key={r.ar} value={r.ar}>{r.en}</option>)}
              </datalist>
            </Field>
            <Field label={`${t("rank")} (EN)`}>
              <input
                value={form.rankEn}
                onChange={e => set("rankEn", e.target.value)}
                placeholder="Major"
                className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm"
                data-testid="wizard-pilot-rank-en"
              />
            </Field>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label={`${t("militaryNumber")} *`}>
              <input
                value={form.militaryNumber}
                onChange={e => set("militaryNumber", e.target.value)}
                placeholder="e.g. 12345"
                className={`w-full px-3 py-2 rounded-md bg-input border text-sm font-mono ${
                  dupMil ? "border-destructive/60" : "border-border"
                }`}
                data-testid="wizard-pilot-military"
              />
            </Field>
            <Field label="Pilot ID">
              <input
                value={form.id}
                onChange={e => set("id", e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm font-mono"
                data-testid="wizard-pilot-id"
              />
            </Field>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Call sign (optional)">
              <input
                value={form.callSign}
                onChange={e => set("callSign", e.target.value)}
                placeholder="e.g. Falcon 1"
                className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm"
                data-testid="wizard-pilot-callsign"
              />
            </Field>
            <Field label="Flight name (optional)">
              <input
                value={form.flightName}
                onChange={e => set("flightName", e.target.value)}
                placeholder="Short name on schedules"
                className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm"
                data-testid="wizard-pilot-flightname"
              />
            </Field>
          </div>
        </div>
      ),
    },
    {
      id: "contact",
      label: t("pilotWizardStepContact"),
      hint: t("pilotWizardHintContact"),
      body: (
        <div className="space-y-3">
          <Field label="Unit">
            <select
              value={form.unit}
              onChange={e => set("unit", e.target.value as Pilot["unit"])}
              className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm"
              data-testid="wizard-pilot-unit"
              data-wizard-autofocus
            >
              <option value="SQDN">SQDN</option>
              <option value="HQ Attached">HQ Attached</option>
              <option value="UH-60M">UH-60M</option>
              <option value="UH-60AIL">UH-60AIL</option>
              <option value="Both">Both</option>
              <option value="RCN">RCN</option>
              <option value="Other">Other</option>
            </select>
          </Field>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label={t("phone")}>
              <input
                value={form.phone}
                onChange={e => set("phone", e.target.value)}
                placeholder="07X XXX XXXX"
                className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm font-mono"
                data-testid="wizard-pilot-phone"
              />
            </Field>
            <Field label={t("address")}>
              <input
                value={form.address}
                onChange={e => set("address", e.target.value)}
                placeholder="Optional"
                className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm"
                data-testid="wizard-pilot-address"
              />
            </Field>
          </div>
          <Field label="Qualifications (slash-separated)">
            <input
              value={form.qualifications}
              onChange={e => set("qualifications", e.target.value)}
              placeholder="AC / IP / NVG"
              className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm"
              data-testid="wizard-pilot-quals"
            />
          </Field>
          <Field label={t("doctorNote")}>
            <input
              value={form.doctorNote}
              onChange={e => set("doctorNote", e.target.value)}
              placeholder="Any flight-medical note"
              className="w-full px-3 py-2 rounded-md bg-input border border-border text-sm"
              data-testid="wizard-pilot-doctor"
            />
          </Field>
        </div>
      ),
    },
    {
      id: "currency",
      label: t("pilotWizardStepCurrency"),
      hint: t("pilotWizardHintCurrency"),
      body: (
        <div className="space-y-3">
          <div className="text-[11px] text-muted-foreground">
            Enter the date each was last flown. Expiry is computed automatically
            using the configured windows (Day {win.day}d · Night {win.night}d ·
            NVG {win.nvg}d · Instrument {win.instrument}d · Medical {win.medical}d).
            Sim is informational only.
          </div>
          <div className="grid sm:grid-cols-3 gap-3">
            <CurrencyField label="Last Day" value={form.lfDay} onChange={v => set("lfDay", v)} days={win.day} testId="wizard-pilot-lfday" autoFocus />
            <CurrencyField label="Last Night" value={form.lfNight} onChange={v => set("lfNight", v)} days={win.night} testId="wizard-pilot-lfnight" />
            <CurrencyField label="Last NVG" value={form.lfNvg} onChange={v => set("lfNvg", v)} days={win.nvg} testId="wizard-pilot-lfnvg" />
            <CurrencyField label="Last Instrument" value={form.lfIrt} onChange={v => set("lfIrt", v)} days={win.instrument} testId="wizard-pilot-lfirt" />
            <CurrencyField label="Last Medical" value={form.lfMedical} onChange={v => set("lfMedical", v)} days={win.medical} testId="wizard-pilot-lfmedical" />
            <CurrencyField label="Last Sim (monitor only)" value={form.lfSim} onChange={v => set("lfSim", v)} days={0} testId="wizard-pilot-lfsim" />
          </div>
        </div>
      ),
    },
    {
      id: "review",
      label: t("pilotWizardStepReview"),
      hint: t("pilotWizardHintReview"),
      body: (
        <div className="space-y-1" data-testid="wizard-pilot-review">
          <ReviewRow label="ID" value={form.id} />
          <ReviewRow label={t("name")} value={form.name} />
          <ReviewRow label={t("arabicName")} value={form.arabicName} />
          <ReviewRow label={t("rank")} value={`${form.rank}${form.rankEn ? ` · ${form.rankEn}` : ""}`} />
          <ReviewRow label={t("militaryNumber")} value={form.militaryNumber} />
          <ReviewRow label="Unit" value={form.unit} />
          {form.phone && <ReviewRow label={t("phone")} value={form.phone} />}
          {form.callSign && <ReviewRow label="Call sign" value={form.callSign} />}
          {form.flightName && <ReviewRow label="Flight name" value={form.flightName} />}
          {form.qualifications && <ReviewRow label="Qualifications" value={form.qualifications} />}
          {form.lfDay && <ReviewRow label="Last Day" value={`${form.lfDay} → expires ${addDaysIso(form.lfDay, win.day)}`} />}
          {form.lfNight && <ReviewRow label="Last Night" value={`${form.lfNight} → expires ${addDaysIso(form.lfNight, win.night)}`} />}
          {form.lfNvg && <ReviewRow label="Last NVG" value={`${form.lfNvg} → expires ${addDaysIso(form.lfNvg, win.nvg)}`} />}
          {form.lfIrt && <ReviewRow label="Last Instrument" value={`${form.lfIrt} → expires ${addDaysIso(form.lfIrt, win.instrument)}`} />}
          {form.lfMedical && <ReviewRow label="Last Medical" value={`${form.lfMedical} → expires ${addDaysIso(form.lfMedical, win.medical)}`} />}
        </div>
      ),
    },
  ];

  const submit = async () => {
    const expiry = {
      day: addDaysIso(form.lfDay, win.day),
      night: addDaysIso(form.lfNight, win.night),
      nvg: addDaysIso(form.lfNvg, win.nvg),
      irt: addDaysIso(form.lfIrt, win.instrument),
      medical: addDaysIso(form.lfMedical, win.medical),
      sim: "",
    };
    const qualSegments = form.qualifications.split(/[\/-]/).map(s => s.trim()).filter(Boolean);
    const pilot: Pilot = {
      id: form.id,
      name: form.name.trim(),
      arabicName: form.arabicName.trim(),
      militaryNumber: form.militaryNumber.trim(),
      rank: form.rank.trim(),
      rankEn: form.rankEn.trim(),
      callSign: form.callSign.trim() || undefined,
      flightName: form.flightName.trim() || undefined,
      phone: form.phone.trim(),
      address: form.address.trim(),
      unit: form.unit,
      doctorNote: form.doctorNote.trim(),
      openingDay: 0,
      openingNight: 0,
      openingNvg: 0,
      monthDay: 0,
      monthNight: 0,
      monthNvg: 0,
      monthSim: 0,
      monthCaptain: 0,
      totalDay: 0,
      totalNight: 0,
      totalNvg: 0,
      totalSim: 0,
      totalCaptain: 0,
      expiry,
      available: true,
      qualifications: qualSegments,
      qualification: qualSegments.join(" / "),
      qualificationSeparator: "/",
      lastSimDate: form.lfSim || "",
    };
    try {
      await create.mutateAsync({ pilot, actor: auth.user?.username });
      // Successful create — drop the persisted draft so the next visit
      // to the wizard starts clean. Failed creates intentionally keep
      // the draft so the operator can retry without retyping.
      draft.discardDraft();
      toast({ title: t("pilotWizardSavedTitle") });
      navigate("/roster");
    } catch (e) {
      toast({ title: (e as Error).message || "Create failed", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-2">
      <FormDraftBanner
        hasDraft={draft.hasDraft}
        onRestore={draft.restoreDraft}
        onDiscard={draft.discardDraft}
        testIdSuffix="add-pilot-wizard"
      />
      <WizardShell
        title={t("pilotWizardTitle")}
        subtitle={t("pilotWizardSubtitle")}
        steps={steps}
        current={step}
        onChange={setStep}
        onFinish={submit}
        busy={create.isPending}
        testIdPrefix="wiz-pilot"
        onCancel={() => navigate("/roster")}
      />
    </div>
  );
}

// ── helpers ──

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function CurrencyField({ label, value, onChange, days, testId, autoFocus }: {
  label: string; value: string; onChange: (v: string) => void; days: number; testId: string; autoFocus?: boolean;
}) {
  const expiry = days > 0 && value ? addDaysIso(value, days) : "";
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</span>
      <DateInput
        value={value}
        onChange={onChange}
        data-testid={testId}
        {...(autoFocus ? { ["data-wizard-autofocus" as string]: "" } : {})}
        className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm"
      />
      {days > 0 && (
        expiry
          ? <span className="block mt-0.5 text-[10px] text-emerald-400">→ {expiry} ({days}d)</span>
          : <span className="block mt-0.5 text-[10px] text-muted-foreground/60">No date set</span>
      )}
      {days === 0 && <span className="block mt-0.5 text-[10px] text-muted-foreground/60 italic">Monitor only</span>}
    </label>
  );
}
