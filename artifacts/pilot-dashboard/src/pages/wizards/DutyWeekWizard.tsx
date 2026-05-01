// 3-step Weekly Duty Roster wizard. Pre-fills from the most recent saved
// week (when one exists) so the operator only has to tweak the diff. Saves
// through the same useSaveDutyWeek mutation so the result is identical to
// a roster created via the legacy DutyWeek page. Task #337.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import DateInput from "@/components/DateInput";
import { ReviewRow, WizardShell, type WizardStep } from "@/components/wizard/WizardShell";
import { useI18n } from "@/lib/i18n";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { usePilots, useSavedDutyWeeks, useSaveDutyWeek } from "@/lib/squadron-data";
import { useFormDraft } from "@/lib/use-form-draft";
import { FormDraftBanner } from "@/components/FormDraftBanner";

const AR_DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const RANK_OPTIONS = [
  "ملازم طيار", "ملازم/١ طيار", "نقيب طيار", "رائد طيار", "مقدم طيار", "عقيد طيار",
];

interface DutyRow {
  rank1: string; name1: string; phone1: string;
  rank2: string; name2: string; phone2: string;
}
const EMPTY_ROW: DutyRow = { rank1: "", name1: "", phone1: "", rank2: "", name2: "", phone2: "" };

function isoDay(d: Date): string { return d.toISOString().slice(0, 10); }
function nextSundayIso(): string {
  const today = new Date();
  const dow = today.getDay();
  const offset = dow === 0 ? 0 : 7 - dow;
  return isoDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset));
}
function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return isoDay(dt);
}

export default function DutyWeekWizard() {
  const { t } = useI18n();
  const { toast } = useToast();
  const auth = useAuth();
  const [, navigate] = useLocation();
  const sqnNumber = auth.squadron?.number ?? "8";
  const { data: PILOTS } = usePilots();
  const savedQ = useSavedDutyWeeks(sqnNumber);
  const saveMut = useSaveDutyWeek();

  const [start, setStart] = useState<string>(() => nextSundayIso());
  const [rows, setRows] = useState<DutyRow[]>(() => Array.from({ length: 7 }, () => ({ ...EMPTY_ROW })));
  const [step, setStep] = useState(0);
  const [prefilledFrom, setPrefilledFrom] = useState<string | null>(null);

  // After a draft restore we need to suppress exactly one run of the
  // prefill effect below — otherwise it would clobber the just-restored
  // rows with whatever the saved-week prefill thinks belongs there for
  // the restored start date. The skip is one-shot.
  const skipNextPrefillRef = useRef(false);

  // Persist the in-flight wizard state (start date + duty rows + step)
  // so a LAN drop or reload mid-wizard doesn't cost the operator their
  // typing. We bundle into a single blob keyed by `draft.duty-week-wizard`.
  type WizardDraft = { start: string; rows: DutyRow[]; step: number };
  const wizardState: WizardDraft = useMemo(() => ({ start, rows, step }), [start, rows, step]);
  const setWizardState = (next: WizardDraft) => {
    skipNextPrefillRef.current = true;
    setStart(next.start);
    setRows(next.rows);
    setStep(next.step);
  };
  const draft = useFormDraft<WizardDraft>("draft.duty-week-wizard", wizardState, setWizardState);

  // Prior week = the latest saved week strictly BEFORE the chosen start.
  const priorWeek = useMemo(() => {
    if (!savedQ.data.length) return null;
    const earlier = savedQ.data
      .filter(w => w.start < start)
      .sort((a, b) => (a.start < b.start ? 1 : -1));
    return earlier[0] ?? null;
  }, [savedQ.data, start]);

  // Whenever the start date changes, reload rows: prefer an exact saved
  // week for that date; otherwise prefill from the prior week so the
  // operator only has to tweak the diff. Falls back to blank when no
  // history exists at all.
  useEffect(() => {
    if (skipNextPrefillRef.current) {
      // Just restored a draft — keep the rows the operator had saved.
      skipNextPrefillRef.current = false;
      return;
    }
    const exact = savedQ.data.find(w => w.start === start);
    if (exact) {
      setRows(exact.rows.map(r => ({ ...r })));
      setPrefilledFrom(null);
      return;
    }
    if (priorWeek) {
      setRows(priorWeek.rows.map(r => ({ ...r })));
      setPrefilledFrom(priorWeek.start);
      return;
    }
    setRows(Array.from({ length: 7 }, () => ({ ...EMPTY_ROW })));
    setPrefilledFrom(null);
  }, [start, savedQ.data, priorWeek]);

  const updateRow = (i: number, patch: Partial<DutyRow>) =>
    setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const autofillFromRoster = (slot: 1 | 2, i: number, name: string) => {
    const trimmed = name.trim();
    const match = PILOTS.find(p => p.arabicName?.trim() === trimmed || p.name?.trim() === trimmed);
    if (!match) {
      slot === 1 ? updateRow(i, { name1: name }) : updateRow(i, { name2: name });
      return;
    }
    if (slot === 1) updateRow(i, { name1: match.arabicName || match.name, rank1: match.rank || "", phone1: match.phone || "" });
    else updateRow(i, { name2: match.arabicName || match.name, rank2: match.rank || "", phone2: match.phone || "" });
  };

  const filledCells = useMemo(
    () => rows.reduce((a, r) => a + (r.name1 ? 1 : 0) + (r.name2 ? 1 : 0), 0),
    [rows],
  );

  const steps: WizardStep[] = [
    {
      id: "week",
      label: t("dutyWizardStepWeek"),
      hint: t("dutyWizardHintWeek"),
      validate: () => start ? null : t("dutyWizardErrWeek"),
      body: (
        <div className="space-y-3">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Start date (Sunday recommended)</span>
            <DateInput
              value={start}
              onChange={setStart}
              data-testid="wizard-duty-start"
              data-wizard-autofocus
              className="mt-1 w-full px-3 py-2 rounded-md bg-input border border-border text-sm font-mono"
            />
          </label>
          <div className="text-xs text-muted-foreground">
            Week ends: <span className="font-mono">{addDaysIso(start, 6)}</span>
          </div>
          <div className="rounded-md border border-border bg-secondary/40 p-3 text-xs">
            {prefilledFrom
              ? <span className="text-emerald-300 font-semibold">{t("dutyWizardPrefilled").replace("{date}", prefilledFrom)}</span>
              : <span className="text-muted-foreground">{t("dutyWizardNoPrior")}</span>}
          </div>
        </div>
      ),
    },
    {
      id: "fill",
      label: t("dutyWizardStepFill"),
      hint: t("dutyWizardHintFill"),
      body: (
        <div className="space-y-2">
          <table className="w-full border-collapse text-xs">
            <thead className="text-[10px] uppercase text-muted-foreground">
              <tr>
                <th className="px-1 py-1 text-start">Day</th>
                <th className="px-1 py-1">Rank #1</th>
                <th className="px-1 py-1">Pilot #1</th>
                <th className="px-1 py-1">Phone #1</th>
                <th className="px-1 py-1">Rank #2</th>
                <th className="px-1 py-1">Pilot #2</th>
                <th className="px-1 py-1">Phone #2</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-border/50">
                  <td className="px-1 py-1 font-semibold whitespace-nowrap">
                    <div>{AR_DAYS[(new Date(start + "T00:00:00").getDay() + i) % 7]}</div>
                    <div className="text-[10px] font-mono text-muted-foreground">{addDaysIso(start, i)}</div>
                  </td>
                  <td className="p-0.5">
                    <input list="wiz-duty-ranks" value={r.rank1} onChange={e => updateRow(i, { rank1: e.target.value })}
                      className="w-full px-1.5 py-1 bg-input rounded border border-border text-xs" data-testid={`wizard-duty-rank1-${i}`} />
                  </td>
                  <td className="p-0.5">
                    <input list="wiz-duty-pilots" value={r.name1} onChange={e => autofillFromRoster(1, i, e.target.value)}
                      className="w-full px-1.5 py-1 bg-input rounded border border-border text-xs" data-testid={`wizard-duty-name1-${i}`}
                      {...(i === 0 ? { ["data-wizard-autofocus" as string]: "" } : {})} />
                  </td>
                  <td className="p-0.5">
                    <input value={r.phone1} onChange={e => updateRow(i, { phone1: e.target.value })}
                      className="w-full px-1.5 py-1 bg-input rounded border border-border text-xs font-mono" data-testid={`wizard-duty-phone1-${i}`} />
                  </td>
                  <td className="p-0.5">
                    <input list="wiz-duty-ranks" value={r.rank2} onChange={e => updateRow(i, { rank2: e.target.value })}
                      className="w-full px-1.5 py-1 bg-input rounded border border-border text-xs" data-testid={`wizard-duty-rank2-${i}`} />
                  </td>
                  <td className="p-0.5">
                    <input list="wiz-duty-pilots" value={r.name2} onChange={e => autofillFromRoster(2, i, e.target.value)}
                      className="w-full px-1.5 py-1 bg-input rounded border border-border text-xs" data-testid={`wizard-duty-name2-${i}`} />
                  </td>
                  <td className="p-0.5">
                    <input value={r.phone2} onChange={e => updateRow(i, { phone2: e.target.value })}
                      className="w-full px-1.5 py-1 bg-input rounded border border-border text-xs font-mono" data-testid={`wizard-duty-phone2-${i}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id="wiz-duty-ranks">
            {RANK_OPTIONS.map(r => <option key={r} value={r} />)}
          </datalist>
          <datalist id="wiz-duty-pilots">
            {PILOTS.map(p => <option key={p.id} value={p.arabicName || p.name}>{p.rank} · {p.phone}</option>)}
          </datalist>
          <div className="text-[11px] text-muted-foreground">
            {filledCells} of 14 duty cells filled — empty cells stay blank on the printed sheet for officers to write by hand.
          </div>
        </div>
      ),
    },
    {
      id: "review",
      label: t("dutyWizardStepReview"),
      hint: t("dutyWizardHintReview"),
      body: (
        <div className="space-y-1" data-testid="wizard-duty-review">
          <ReviewRow label="Squadron" value={`Sqdn ${sqnNumber}`} />
          <ReviewRow label="Week" value={`${start} → ${addDaysIso(start, 6)}`} />
          <ReviewRow label="Source" value={prefilledFrom ? `Prefilled from ${prefilledFrom}` : "Started blank"} />
          <ReviewRow label="Filled cells" value={`${filledCells} / 14`} />
          <div className="mt-2 grid sm:grid-cols-2 gap-1.5">
            {rows.map((r, i) => {
              const day = AR_DAYS[(new Date(start + "T00:00:00").getDay() + i) % 7];
              const cells = [r.name1, r.name2].filter(Boolean).join(" · ") || "(empty)";
              return (
                <div key={i} className="text-xs px-2 py-1 rounded border border-border/60 bg-secondary/30">
                  <span className="font-mono text-muted-foreground me-2">{addDaysIso(start, i)}</span>
                  <span className="font-semibold me-2">{day}</span>
                  <span className="text-foreground">{cells}</span>
                </div>
              );
            })}
          </div>
        </div>
      ),
    },
  ];

  const submit = async () => {
    try {
      await saveMut.mutateAsync({ squadron: sqnNumber, start, rows });
      // Successful save — drop the persisted draft so the next visit
      // starts clean. Failed saves keep the draft for retry.
      draft.discardDraft();
      toast({ title: t("dutyWizardSavedTitle") });
      navigate("/duty");
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
        testIdSuffix="duty-week-wizard"
      />
      <WizardShell
        title={t("dutyWizardTitle")}
        subtitle={t("dutyWizardSubtitle")}
        steps={steps}
        current={step}
        onChange={setStep}
        onFinish={submit}
        busy={saveMut.isPending}
        testIdPrefix="wiz-duty"
        onCancel={() => navigate("/duty")}
      />
    </div>
  );
}
