// First-time post-install Setup wizard for the very first super_admin on a
// brand-new install. Wraps the existing setupSuperAdmin() bootstrap call
// (preserves all server-side guards) and adds Welcome and Review steps so
// the operator gets context before submitting credentials. Renders the
// existing fallback panels (LAN mode, not-allowed) unchanged. Task #337.

import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { ReviewRow, WizardShell, type WizardStep } from "@/components/wizard/WizardShell";
import { useI18n } from "@/lib/i18n";
import {
  setupSuperAdmin, checkSuperAdminSetupAllowed, unitJoinConfigured,
} from "@/lib/unit-join";
import { isLanSessionLoginEnabled } from "@/lib/internal-migration";
import { useFormDraft } from "@/lib/use-form-draft";
import { FormDraftBanner } from "@/components/FormDraftBanner";

export default function SetupWizard() {
  const { t } = useI18n();
  const [, navigate] = useLocation();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Account form state
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [unitLabel, setUnitLabel] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");

  // Persist the in-flight wizard state so a LAN drop or reload mid-setup
  // doesn't cost the operator their typing. We deliberately do NOT
  // persist password / confirmPw — writing credentials to localStorage
  // would be a security regression. The operator re-enters those after
  // a Restore.
  type WizardDraft = {
    email: string; username: string; displayName: string;
    unitLabel: string; step: number;
  };
  const wizardState: WizardDraft = useMemo(
    () => ({ email, username, displayName, unitLabel, step }),
    [email, username, displayName, unitLabel, step],
  );
  const setWizardState = (next: WizardDraft) => {
    setEmail(next.email);
    setUsername(next.username);
    setDisplayName(next.displayName);
    setUnitLabel(next.unitLabel);
    setStep(next.step);
  };
  const draft = useFormDraft<WizardDraft>("draft.setup-wizard", wizardState, setWizardState);

  useEffect(() => {
    let alive = true;
    if (!unitJoinConfigured) { setAllowed(false); return; }
    checkSuperAdminSetupAllowed()
      .then(v => { if (alive) setAllowed(v); })
      .catch(() => { if (alive) setAllowed(false); });
    return () => { alive = false; };
  }, []);

  if (allowed === null) {
    return <div className="min-h-screen bg-slate-950 text-slate-100 grid place-items-center text-sm text-slate-400">Checking…</div>;
  }
  if (isLanSessionLoginEnabled()) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 grid place-items-center p-6">
        <div className="w-full max-w-md space-y-4 rounded-xl border border-sky-700/40 bg-sky-900/20 p-6 text-center">
          <h1 className="text-lg font-semibold">LAN session mode active</h1>
          <p className="text-sm text-sky-100/90">
            Cloud super-admin bootstrap is disabled in LAN mode. Use LAN login
            with an existing LAN account from your internal server.
          </p>
          <Link href="/login" className="inline-block rounded-md border border-sky-400/40 px-3 py-2 text-sm text-sky-50 hover:bg-sky-800/40">
            Go to LAN login
          </Link>
        </div>
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 grid place-items-center p-6">
        <div className="w-full max-w-md space-y-4 rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-center">
          <h1 className="text-lg font-semibold">Super-admin setup not available</h1>
          <p className="text-sm text-slate-400">
            {!unitJoinConfigured
              ? "This installation isn't configured for cloud setup. The super admin must initialise from a build that includes the cloud join secret."
              : "This unit already has a super admin, or cloud setup is locked. Use 'I already have an account' or file a join request instead."}
          </p>
          <Link href="/" className="inline-block rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800">← Back</Link>
        </div>
      </div>
    );
  }

  const validateAccount = (): string | null => {
    const em = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return t("setupWizardErrEmail");
    const u = username.trim().toLowerCase();
    if (u.length < 3 || !/^[a-z0-9._-]+$/.test(u)) return t("setupWizardErrUsername");
    if (displayName.trim().length < 1) return t("setupWizardErrDisplay");
    if (password.length < 12) return t("setupWizardErrPassword");
    if (password !== confirmPw) return t("setupWizardErrPwMismatch");
    return null;
  };

  const submit = async () => {
    setServerError(null);
    setBusy(true);
    const r = await setupSuperAdmin({
      email: email.trim().toLowerCase(),
      password,
      displayName: displayName.trim(),
      username: username.trim().toLowerCase(),
    });
    setBusy(false);
    if (!r.ok) {
      const msg = r.error === "super_admin_already_exists"
        ? "A super admin already exists for this unit. Use 'I already have an account'."
        : r.error === "unauthorized" ? "Setup is not allowed right now."
        : r.error === "server_misconfigured" ? "Cloud not reachable from this PC."
        : `Setup failed (${r.error}).`;
      setServerError(msg);
      return;
    }
    // Successful super-admin create — drop the persisted draft so a
    // future visit starts clean. Failed attempts keep the draft so the
    // operator can correct and retry.
    draft.discardDraft();
    setSuccess(true);
  };

  const steps: WizardStep[] = [
    {
      id: "welcome",
      label: t("setupWizardStepWelcome"),
      body: (
        <div className="space-y-3 text-sm">
          <p className="text-foreground/90 leading-relaxed">{t("setupWizardWelcomeBody")}</p>
          <ul className="text-xs text-muted-foreground list-disc ms-5 space-y-1">
            <li>You'll set an email, username and password (≥ 12 characters).</li>
            <li>Optionally tag this install with a short unit label.</li>
            <li>Review your input, then create the account.</li>
          </ul>
        </div>
      ),
    },
    {
      id: "account",
      label: t("setupWizardStepAccount"),
      hint: t("setupWizardAccountHint"),
      validate: validateAccount,
      body: (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Email" full>
            <input type="email" value={email} autoComplete="off" onChange={e => setEmail(e.target.value)}
              placeholder="sa@unit.example"
              data-wizard-autofocus
              data-testid="wizard-setup-email"
              className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm" />
          </Field>
          <Field label="Username">
            <input type="text" value={username} autoComplete="off" onChange={e => setUsername(e.target.value)}
              placeholder="superadmin"
              data-testid="wizard-setup-username"
              className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm" />
          </Field>
          <Field label="Display name">
            <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)}
              placeholder="Unit Super Admin"
              data-testid="wizard-setup-display"
              className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm" />
          </Field>
          <Field label="Password (≥ 12 chars)">
            <input type="password" value={password} autoComplete="new-password" onChange={e => setPassword(e.target.value)}
              data-testid="wizard-setup-password"
              className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm" />
          </Field>
          <Field label="Confirm password">
            <input type="password" value={confirmPw} autoComplete="new-password" onChange={e => setConfirmPw(e.target.value)}
              data-testid="wizard-setup-confirm"
              className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm" />
          </Field>
        </div>
      ),
    },
    {
      id: "unit",
      label: t("setupWizardStepUnit"),
      hint: t("setupWizardUnitHint"),
      optional: true,
      body: (
        <div className="space-y-3">
          <Field label={t("setupWizardLabel")}>
            <input type="text" value={unitLabel} onChange={e => setUnitLabel(e.target.value)}
              placeholder="e.g. 8 Sqdn / RJAF King Hussein AB"
              data-wizard-autofocus
              data-testid="wizard-setup-unit"
              className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm" />
          </Field>
          <p className="text-[11px] text-muted-foreground">
            This label is just a memo for this install — it isn't sent to the
            cloud bootstrap call. You can change it later in Settings.
          </p>
        </div>
      ),
    },
    {
      id: "review",
      label: t("setupWizardStepReview"),
      hint: t("setupWizardReviewHint"),
      body: (
        <div className="space-y-2">
          <ReviewRow label="Email" value={email || "—"} />
          <ReviewRow label="Username" value={username || "—"} />
          <ReviewRow label="Display name" value={displayName || "—"} />
          <ReviewRow label="Password" value={password ? "•".repeat(Math.min(password.length, 12)) : "—"} />
          {unitLabel.trim() && <ReviewRow label="Unit label" value={unitLabel.trim()} />}
          {serverError && (
            <div role="alert" data-testid="wizard-setup-server-error"
              className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-rose-200">
              {serverError}
            </div>
          )}
          {success && (
            <div role="status" data-testid="wizard-setup-success"
              className="mt-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
              {t("setupWizardCreated")}
              <Link href="/login" className="ms-2 underline font-semibold">Go to login</Link>
            </div>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <div className="max-w-2xl mx-auto space-y-2">
        <FormDraftBanner
          hasDraft={draft.hasDraft}
          onRestore={draft.restoreDraft}
          onDiscard={draft.discardDraft}
          testIdSuffix="setup-wizard"
        />
        <WizardShell
          title={t("setupWizardTitle")}
          subtitle={t("setupWizardSubtitle")}
          steps={steps}
          current={step}
          onChange={setStep}
          onFinish={success ? () => { window.location.hash = "/login"; } : submit}
          busy={busy}
          testIdPrefix="wiz-setup"
          finishLabel={success ? "Go to login" : "Create super admin"}
          onCancel={() => navigate("/")}
        />
      </div>
    </div>
  );
}

function Field({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (
    <label className={`block ${full ? "sm:col-span-2" : ""}`}>
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
