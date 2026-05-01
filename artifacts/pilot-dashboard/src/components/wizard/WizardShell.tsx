// Reusable wizard chrome — used by AddSortie, AddPilot, DutyWeek and
// Setup wizards. Provides:
//   • Numbered stepper (jumpable for completed steps)
//   • Back / Next / Finish buttons (Esc = back, Enter = next, Tab order)
//   • Plain-language inline errors surfaced from per-step validate()
//   • State preservation on Back (parent owns state; we never re-render
//     a step's body until it is the active one but the parent's state
//     is unchanged so values come back untouched on re-entry)
//
// Task #337.

import { ReactNode, useEffect, useRef, useState, KeyboardEvent } from "react";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";

export interface WizardStep {
  id: string;
  label: string;
  /** Optional short description shown under the step label in the body header. */
  hint?: string;
  /** Render the step body. Receives a stable `inputRef` that is auto-focused
   * on entry — assign it to your primary input. */
  body: ReactNode;
  /** Return a plain-language error string to block Next, or null to allow. */
  validate?: () => string | null;
  /** Mark step as optional in the stepper. */
  optional?: boolean;
}

export interface WizardShellProps {
  title: string;
  subtitle?: string;
  steps: WizardStep[];
  current: number;
  onChange: (next: number) => void;
  onFinish: () => void;
  /** True while the final submit is in flight. */
  busy?: boolean;
  /** Test id prefix (default = "wizard"). */
  testIdPrefix?: string;
  /** Optional finish button label override. */
  finishLabel?: string;
  /** Optional cancel handler — surfaces a Cancel button next to Back. */
  onCancel?: () => void;
}

export function WizardShell(props: WizardShellProps) {
  const {
    title, subtitle, steps, current, onChange, onFinish, busy,
    testIdPrefix = "wizard", finishLabel, onCancel,
  } = props;
  const { t, dir } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const isLast = current === steps.length - 1;
  const step = steps[current];

  // Auto-focus the first focusable element inside the active step body
  // on every step change so the keyboard flow stays predictable.
  useEffect(() => {
    setError(null);
    const root = rootRef.current;
    if (!root) return;
    // microtask to wait for body render
    const id = window.setTimeout(() => {
      const target = root.querySelector<HTMLElement>(
        "[data-wizard-autofocus], input:not([type='hidden']):not([disabled]), select:not([disabled]), textarea:not([disabled])",
      );
      target?.focus();
    }, 0);
    return () => window.clearTimeout(id);
  }, [current]);

  const advance = () => {
    if (busy) return;
    const err = step.validate ? step.validate() : null;
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    if (isLast) onFinish();
    else onChange(current + 1);
  };

  const back = () => {
    if (busy) return;
    setError(null);
    if (current > 0) onChange(current - 1);
    else onCancel?.();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Don't hijack Enter inside a textarea — operators expect newline.
    const target = e.target as HTMLElement;
    const isTextarea = target.tagName === "TEXTAREA";
    const isContentEditable = target.isContentEditable;
    const isButton = target.tagName === "BUTTON" || target.tagName === "A";
    if (
      e.key === "Enter" && !isTextarea && !isContentEditable && !isButton &&
      !e.shiftKey && !e.metaKey && !e.ctrlKey
    ) {
      e.preventDefault();
      advance();
    } else if (e.key === "Escape") {
      e.preventDefault();
      back();
    }
  };

  return (
    <div data-testid={`${testIdPrefix}-shell`}>
      <PageHead title={title} subtitle={subtitle} />
      <Stepper
        steps={steps}
        current={current}
        onJump={(i) => i < current && onChange(i)}
        testIdPrefix={testIdPrefix}
      />
      <Card className="mb-3">
        <div ref={rootRef} onKeyDown={onKeyDown} className="space-y-3">
          <div className="border-b border-border pb-2 mb-1">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">
              {t("wizardStepOf").replace("{n}", String(current + 1)).replace("{m}", String(steps.length))}
            </div>
            <div className="text-base font-semibold mt-0.5" data-testid={`${testIdPrefix}-step-title`}>
              {step.label}
            </div>
            {step.hint && (
              <div className="text-xs text-muted-foreground mt-0.5">{step.hint}</div>
            )}
          </div>
          <div data-testid={`${testIdPrefix}-step-body-${step.id}`}>{step.body}</div>
          {error && (
            <div
              role="alert"
              data-testid={`${testIdPrefix}-error`}
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-rose-200"
            >
              {error}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-border">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={back}
                disabled={busy || (current === 0 && !onCancel)}
                data-testid={`${testIdPrefix}-back`}
                className="px-3 py-2 rounded-md bg-secondary border border-border text-sm inline-flex items-center gap-1 disabled:opacity-40"
              >
                {dir === "rtl" ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                {current === 0 && onCancel ? t("cancel") : t("wizardBack")}
              </button>
              {onCancel && current > 0 && (
                <button
                  type="button"
                  onClick={onCancel}
                  disabled={busy}
                  data-testid={`${testIdPrefix}-cancel`}
                  className="px-3 py-2 rounded-md bg-transparent border border-border text-sm text-muted-foreground"
                >
                  {t("cancel")}
                </button>
              )}
            </div>
            <div className="text-[11px] text-muted-foreground hidden sm:block">
              {t("wizardKeyboardHint")}
            </div>
            <button
              type="button"
              onClick={advance}
              disabled={busy}
              data-testid={`${testIdPrefix}-${isLast ? "finish" : "next"}`}
              className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-semibold inline-flex items-center gap-1 disabled:opacity-50"
            >
              {isLast ? (finishLabel ?? t("wizardFinish")) : t("wizardNext")}
              {dir === "rtl" ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}

export function Stepper({
  steps, current, onJump, testIdPrefix = "wizard",
}: {
  steps: WizardStep[]; current: number; onJump?: (i: number) => void; testIdPrefix?: string;
}) {
  return (
    <ol
      className="flex items-center gap-1 mb-3 overflow-x-auto pb-1"
      data-testid={`${testIdPrefix}-stepper`}
      aria-label="Wizard steps"
    >
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        const tone = done
          ? "bg-emerald-500/15 border-emerald-400/60 text-emerald-200"
          : active
          ? "bg-primary/15 border-primary text-primary"
          : "bg-secondary border-border text-muted-foreground";
        const clickable = onJump && i < current;
        return (
          <li key={s.id} className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => clickable && onJump!(i)}
              disabled={!clickable}
              aria-current={active ? "step" : undefined}
              data-testid={`${testIdPrefix}-step-${s.id}`}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md border text-xs font-semibold transition-colors ${tone} ${clickable ? "cursor-pointer hover:opacity-90" : "cursor-default"}`}
            >
              <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-background/40 font-mono text-[10px]">
                {done ? <Check className="h-3 w-3" /> : i + 1}
              </span>
              <span className="whitespace-nowrap">{s.label}</span>
              {s.optional && (
                <span className="text-[9px] uppercase opacity-70">opt</span>
              )}
            </button>
            {i < steps.length - 1 && (
              <span className="mx-0.5 text-muted-foreground/50">·</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** Small read-only review row used by every wizard's final step. */
export function ReviewRow({ label, value, testId }: { label: string; value: ReactNode; testId?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 border-b border-border/40 last:border-b-0" data-testid={testId}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium text-foreground text-right">{value || "—"}</span>
    </div>
  );
}
