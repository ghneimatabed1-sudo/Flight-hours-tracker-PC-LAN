import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { isLanNoAuthEnabled, isLanSessionLoginEnabled } from "@/lib/internal-migration";
import { useI18n } from "@/lib/i18n";
import { useIdleTimeout } from "@/lib/use-idle-timeout";
import LockScreen from "@/components/LockScreen";
import { ShieldCheck, Languages, KeyRound, Smartphone, Phone, Mail, Lock } from "lucide-react";
import QRCode from "qrcode";

// 1 hour of no input on the login page → auto lock. Tuned generously so
// real operators briefly stepping away to grab a coffee don't get locked,
// but a PC left unattended overnight always ends up on the screensaver.
const LOGIN_AUTO_LOCK_MS = 60 * 60 * 1000;

type LoginUpdaterState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "none"; version?: string }
  | { kind: "progress"; percent: number; transferred: number; total: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

type LoginElectronBridge = {
  checkForUpdates?: () => Promise<{ ok: boolean; version?: string | null; reason?: string }>;
  installUpdateNow?: () => Promise<boolean>;
  onUpdateEvent?: (cb: (e: LoginUpdaterState) => void) => () => void;
  isPackaged?: () => Promise<boolean>;
};

function getLoginBridge(): LoginElectronBridge | null {
  return (window as unknown as { rjafElectron?: LoginElectronBridge }).rjafElectron ?? null;
}

function fmtMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export default function LoginGate() {
  const {
    licensed, configured, activateLicense, configureSquadron, login, fingerprint,
    lockedUntil, user, pendingAdmin, verifyAdminTotp, cancelAdminTotp,
    pendingRecoveryCodes, ackRecoveryCodes, provisionSuperAdmin, pcRoleLock,
    pcDeviceName, silentAuthError, clearSilentAuthError, lanDevQuickLogin,
  } = useAuth();
  const { t, lang, setLang } = useI18n();

  const [licenseKey, setLicenseKey] = useState("");
  const [licUsername, setLicUsername] = useState("");
  const [licError, setLicError] = useState<string | null>(null);

  // Squadron-bootstrap fields are blank on first run so a fresh install at
  // any squadron (NO.5 SQDN, NO.7 SQDN, etc.) doesn't quietly accept NO.8's
  // values. The placeholders show the expected shape; the operator types
  // their own. Once configured the values persist via lib/auth.tsx.
  const [name, setName] = useState("");
  const [num, setNum] = useState("");
  const [base, setBase] = useState("");

  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // First-run Super Admin password setup. Triggered manually (link from the
  // login form) or when login() returns { error: "admin_not_provisioned" }.
  // On a fresh install we DO NOT auto-jump here — every install ships with
  // the baked-in default admin password hash, so the Super Admin can log in
  // straight away with the password we agreed on. They rotate it later from
  // Admin → Security if they want.
  const [setupMode, setSetupMode] = useState(false);
  const [setupPw1, setSetupPw1] = useState("");
  const [setupPw2, setSetupPw2] = useState("");
  const [setupErr, setSetupErr] = useState<string | null>(null);
  const [setupOk, setSetupOk] = useState(false);

  const [code, setCode] = useState("");
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryCopied, setRecoveryCopied] = useState(false);

  // Single in-flight flag for every async submit on this screen (license
  // activation, sign-in, 2FA / recovery verify, first-run provision). All
  // three hit Supabase edge functions over the public internet and can take
  // 10–30 s when the link is slow. Without a visible busy state the inputs
  // stay enabled with no spinner — operators have reported the page feeling
  // "frozen" because the cursor stops blinking inside the field while the
  // browser is busy with the fetch and they have no idea anything is
  // happening. Gating the form on `busy` disables the inputs, swaps the
  // button label to a "Verifying…" message, and prevents the duplicate
  // submits that were turning a slow network into a 60 s+ stall.
  const [busy, setBusy] = useState(false);
  const [updState, setUpdState] = useState<LoginUpdaterState>({ kind: "idle" });
  const [updPackaged, setUpdPackaged] = useState(false);
  const bridge = getLoginBridge();

  useEffect(() => {
    if (!bridge) return;
    bridge.isPackaged?.().then((v) => setUpdPackaged(!!v)).catch(() => {});
    const off = bridge.onUpdateEvent?.((e) => setUpdState(e));
    return () => { off?.(); };
  }, [bridge]);

  const onCheckUpdates = async () => {
    if (!bridge?.checkForUpdates || !updPackaged) return;
    setUpdState({ kind: "checking" });
    const res = await bridge.checkForUpdates();
    if (!res.ok && res.reason) setUpdState({ kind: "error", message: res.reason });
  };
  const onInstallUpdateNow = async () => {
    await bridge?.installUpdateNow?.();
  };

  // First-screen policy:
  //   - Fresh install (no PC role lock yet) → Super Admin login. The very
  //     first action on any new PC is the Super Admin signing in to assign
  //     the role for this machine.
  //   - PC locked to "ops" → license-key / squadron-setup flow.
  //   - PC locked to "super_admin" or "commander" → HQ login.
  // The user can always switch from the admin login back to the license
  // form via the "← License" link below the sign-in button when needed.
  const [hqMode, setHqMode] = useState(pcRoleLock !== "ops");
  useEffect(() => {
    setHqMode(pcRoleLock !== "ops");
  }, [pcRoleLock]);

  // Lock screen — manual ("Lock screen" button bottom-left) or automatic
  // after LOGIN_AUTO_LOCK_MS of no input. The idle timer is suppressed
  // while the lock is already showing, while a 2FA prompt is open, or
  // while the recovery codes are being displayed (those flows are
  // sensitive — we don't want to dismiss them by triggering a screensaver).
  const [locked, setLocked] = useState(false);
  useIdleTimeout(
    LOGIN_AUTO_LOCK_MS,
    () => setLocked(true),
    !locked && !pendingAdmin && !pendingRecoveryCodes,
  );

  const lockedRemaining = lockedUntil ? Math.max(0, Math.ceil((lockedUntil - Date.now()) / 1000)) : 0;

  useEffect(() => {
    if (!pendingAdmin) { setQrDataUrl(null); return; }
    let cancelled = false;
    QRCode.toDataURL(pendingAdmin.otpauth, { margin: 1, width: 192, color: { dark: "#0b0b0b", light: "#ffffffff" } })
      .then(url => { if (!cancelled) setQrDataUrl(url); })
      .catch(() => { if (!cancelled) setQrDataUrl(null); });
    return () => { cancelled = true; };
  }, [pendingAdmin]);

  useEffect(() => { setCode(""); setCodeErr(null); setRecoveryMode(false); }, [pendingAdmin?.mode]);

  const submitLicense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setLicError(null);
    setBusy(true);
    try {
      const r = await activateLicense(licenseKey, licUsername);
      if (!r.ok) setLicError(r.error || "Invalid");
    } finally {
      setBusy(false);
    }
  };
  const submitSetup = (e: React.FormEvent) => {
    e.preventDefault();
    configureSquadron({ name, number: num, base });
  };
  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setErr(null);
    setBusy(true);
    try {
      const r = await login(u, p);
      if (!r.ok && !r.requires2fa) {
        if (r.error === "admin_not_provisioned") {
          setSetupMode(true);
          setSetupPw1(""); setSetupPw2(""); setSetupErr(null); setSetupOk(false);
          return;
        }
        if (r.error === "role_locked") { setErr(t("roleLockMismatch")); return; }
        setErr(r.error === "locked" ? t("lockedOut") : t("badCreds"));
      }
    } finally {
      setBusy(false);
    }
  };
  const lanNoAuth = isLanNoAuthEnabled();
  const quickLogin = async (kind: "super_admin" | "ops" | "commander") => {
    if (!lanNoAuth || busy) return;
    setErr(null);
    setBusy(true);
    try {
      const r = await lanDevQuickLogin(kind);
      if (!r.ok) setErr(r.error ?? "login_failed");
    } finally {
      setBusy(false);
    }
  };
  const submitProvision = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setSetupErr(null);
    if (setupPw1.length < 8) { setSetupErr(t("pwTooShort")); return; }
    if (setupPw1 !== setupPw2) { setSetupErr(t("pwMismatch")); return; }
    setBusy(true);
    let r: Awaited<ReturnType<typeof provisionSuperAdmin>>;
    try {
      r = await provisionSuperAdmin(setupPw1);
    } finally {
      setBusy(false);
    }
    if (!r.ok) {
      setSetupErr(r.error === "too_short" ? t("pwTooShort") : t("badCreds"));
      return;
    }
    setSetupOk(true);
    // Pre-fill the login form so they can sign in immediately.
    setU("admin"); setP(setupPw1);
    setSetupPw1(""); setSetupPw2("");
    // Drop back to the login form after a brief confirmation.
    window.setTimeout(() => { setSetupMode(false); setSetupOk(false); }, 1200);
  };
  const submitTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setCodeErr(null);
    setBusy(true);
    try {
      const r = await verifyAdminTotp(code);
      if (!r.ok) {
        setCodeErr(r.error === "locked" ? t("lockedOut") : t("twoFactorBad"));
      }
    } finally {
      setBusy(false);
    }
  };
  const copyRecoveryCodes = async () => {
    if (!pendingRecoveryCodes) return;
    try {
      await navigator.clipboard.writeText(pendingRecoveryCodes.join("\n"));
      setRecoveryCopied(true);
      window.setTimeout(() => setRecoveryCopied(false), 2000);
    } catch { /* no-op */ }
  };
  const downloadRecoveryCodes = () => {
    if (!pendingRecoveryCodes) return;
    const header = "RJAF Pilot Dashboard — Super Admin recovery codes\n" +
      "Generated: " + new Date().toISOString() + "\n" +
      "Keep these somewhere safe. Each one works only once.\n\n";
    const blob = new Blob([header + pendingRecoveryCodes.join("\n") + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "rjaf-admin-recovery-codes.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const lanAuth = isLanSessionLoginEnabled();
  const showLogin =
    hqMode
    || (configured && !user && (licensed || lanAuth));

  if (locked) {
    return <LockScreen onUnlock={() => setLocked(false)} />;
  }

  return (
    // Scrollable shell: outer pins to viewport height and owns the scrollbar,
    // inner `min-h-full` flex grows to content so short forms stay centered
    // but tall ones (license activation, 2FA enroll with QR + recovery codes,
    // squadron setup) push the body and scroll naturally. Without this the
    // login screen got vertically clipped inside small windows / iframes
    // because `items-center` on a `min-h-screen` flex parent overflows
    // symmetrically with no scroll path.
    <div className="h-screen overflow-y-auto brand-bg">
    <div className="min-h-full flex items-center justify-center p-6">
      {silentAuthError && (
        <div
          role="alert"
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 max-w-xl w-[min(36rem,calc(100%-2rem))] rounded-md border border-amber-500/60 bg-amber-500/10 text-amber-100 px-4 py-3 shadow-lg flex items-start gap-3"
        >
          <ShieldCheck className="h-4 w-4 mt-0.5 flex-none" />
          <div className="text-sm leading-snug flex-1">
            <div className="font-medium">Sign-in expired</div>
            <div className="opacity-90">{silentAuthError}</div>
          </div>
          <button
            type="button"
            onClick={clearSilentAuthError}
            className="text-xs px-2 py-1 rounded border border-amber-500/60 hover:bg-amber-500/20"
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="absolute top-4 right-4 rtl:left-4 rtl:right-auto">
        <button onClick={() => setLang(lang === "en" ? "ar" : "en")} className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-secondary inline-flex items-center gap-1.5">
          <Languages className="h-3.5 w-3.5" />
          {lang === "en" ? t("arabic") : t("english")}
        </button>
      </div>

      {/* Manual lock-screen trigger. Sits opposite the language switcher,
          bottom-left, deliberately understated so it never competes with
          the sign-in form. Hidden during 2FA / recovery flows so a stray
          click can't trash an in-progress sensitive action. */}
      {!pendingAdmin && !pendingRecoveryCodes && (
        <div className="fixed bottom-4 left-4 rtl:right-4 rtl:left-auto z-50">
          <button
            type="button"
            data-testid="button-lock-screen"
            onClick={() => setLocked(true)}
            title={t("lockScreen")}
            className="text-xs px-3 py-1.5 rounded-md border border-border/70 bg-background/40 backdrop-blur hover:bg-secondary hover:border-amber-500/40 inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground transition-colors"
          >
            <Lock className="h-3.5 w-3.5" />
            {t("lockScreen")}
          </button>
        </div>
      )}

      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-6">
          <img src="brand/emblem.png" className="h-24 w-24 object-contain mb-3" alt="Royal Jordanian Air Force" />
          {/* April 2026: replaced the old Hawk-Eye wordmark with the RJAF
              emblem text mark per CO request — the eye glyph was off-brand
              for any non-Hawk Eye context. The emblem.png above carries
              the visual identity; this line just shows the app name. */}
          <div
            className="h-10 max-w-full flex items-center justify-center text-2xl font-semibold tracking-wide gold-grad"
            aria-label={t("appName")}
          >
            {t("appName")}
          </div>
          <div className="text-xs text-muted-foreground text-center mt-2">{t("appTag")}</div>
        </div>

        <div className="panel p-6">
          {pendingRecoveryCodes ? (
            <div className="space-y-3" data-testid="panel-recovery-codes">
              <div className="flex items-center gap-2 text-sm font-medium">
                <KeyRound className="h-4 w-4 text-amber-400" />
                {t("recoveryCodesTitle")}
              </div>
              <p className="text-xs text-muted-foreground">{t("recoveryCodesHint")}</p>
              <div
                data-testid="list-recovery-codes"
                className="grid grid-cols-2 gap-2 p-3 rounded-md bg-input border border-border font-mono text-sm tracking-wider select-all"
              >
                {pendingRecoveryCodes.map((c, i) => (
                  <div key={i} className="py-0.5" data-testid={`text-recovery-code-${i}`}>{c}</div>
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="button-copy-recovery-codes"
                  onClick={copyRecoveryCodes}
                  className="flex-1 py-1.5 rounded-md border border-border hover:bg-secondary text-xs"
                >
                  {recoveryCopied ? t("copied") : t("copy")}
                </button>
                <button
                  type="button"
                  data-testid="button-download-recovery-codes"
                  onClick={downloadRecoveryCodes}
                  className="flex-1 py-1.5 rounded-md border border-border hover:bg-secondary text-xs"
                >
                  {t("download")}
                </button>
              </div>
              <p className="text-[11px] text-amber-400">{t("recoveryCodesWarn")}</p>
              <button
                type="button"
                data-testid="button-ack-recovery-codes"
                onClick={() => { setRecoveryCopied(false); ackRecoveryCodes(); }}
                className="w-full py-2 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90"
              >
                {t("recoveryCodesAck")}
              </button>
            </div>
          ) : pendingAdmin ? (
            <form onSubmit={submitTotp} className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Smartphone className="h-4 w-4 text-amber-400" />
                {pendingAdmin.mode === "enroll"
                  ? t("twoFactorEnrollTitle")
                  : recoveryMode ? t("recoveryVerifyTitle") : t("twoFactorVerifyTitle")}
              </div>
              {pendingAdmin.mode === "enroll" && (
                <>
                  <p className="text-xs text-muted-foreground">{t("twoFactorEnrollHint")}</p>
                  <div className="flex justify-center bg-white p-3 rounded-md">
                    {qrDataUrl
                      ? <img src={qrDataUrl} alt="2FA QR" className="h-44 w-44" data-testid="img-totp-qr" />
                      : <div className="h-44 w-44 animate-pulse bg-muted rounded" />}
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">{t("twoFactorSecret")}</label>
                    <div data-testid="text-totp-secret" className="mt-1 px-3 py-2 rounded-md bg-input border border-border font-mono text-xs tracking-wider break-all select-all">
                      {pendingAdmin.secret}
                    </div>
                  </div>
                </>
              )}
              {pendingAdmin.mode === "verify" && (
                <p className="text-xs text-muted-foreground">
                  {recoveryMode ? t("recoveryVerifyHint") : t("twoFactorVerifyHint")}
                </p>
              )}
              <div>
                <label htmlFor="totp-code" className="text-xs text-muted-foreground">
                  {recoveryMode ? t("recoveryCodeLabel") : t("twoFactorCode")}
                </label>
                {recoveryMode ? (
                  <input
                    id="totp-code"
                    data-testid="input-recovery-code"
                    autoComplete="one-time-code"
                    autoCapitalize="characters"
                    autoFocus
                    spellCheck={false}
                    maxLength={9}
                    value={code}
                    disabled={busy}
                    onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z2-7-]/g, "").slice(0, 9))}
                    className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-center font-mono text-base tracking-[0.3em] uppercase disabled:opacity-60"
                    placeholder="XXXX-XXXX"
                  />
                ) : (
                  <input
                    id="totp-code"
                    data-testid="input-totp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={code}
                    disabled={busy}
                    onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                    className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-center font-mono text-lg tracking-[0.4em] disabled:opacity-60"
                    placeholder="000000"
                  />
                )}
              </div>
              {lockedRemaining > 0
                ? <div className="text-xs text-amber-400">{t("lockedOut")} ({lockedRemaining}s)</div>
                : codeErr && <div className="text-xs text-destructive">{codeErr}</div>}
              <button
                type="submit"
                data-testid="button-verify-totp"
                disabled={
                  busy ||
                  lockedRemaining > 0 ||
                  (recoveryMode
                    ? code.replace(/-/g, "").length !== 8
                    : code.length !== 6)
                }
                className="w-full py-2 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90 disabled:opacity-50"
              >
                {busy
                  ? t("verifying")
                  : pendingAdmin.mode === "enroll"
                    ? t("twoFactorEnrollBtn")
                    : recoveryMode ? t("recoveryVerifyBtn") : t("twoFactorVerifyBtn")}
              </button>
              {pendingAdmin.mode === "verify" && (
                <button
                  type="button"
                  data-testid="button-toggle-recovery"
                  onClick={() => { setRecoveryMode(r => !r); setCode(""); setCodeErr(null); }}
                  className="w-full text-[11px] text-amber-400 hover:text-amber-300 underline"
                >
                  {recoveryMode ? t("recoveryUseTotp") : t("recoveryLostDevice")}
                </button>
              )}
              <button
                type="button"
                onClick={() => { cancelAdminTotp(); setCode(""); setCodeErr(null); setRecoveryMode(false); }}
                className="w-full text-[11px] text-muted-foreground hover:text-foreground underline"
              >
                ← {t("cancel")}
              </button>
            </form>
          ) : setupMode ? (
            <form onSubmit={submitProvision} className="space-y-3" data-testid="form-first-run-setup">
              <div className="flex items-center gap-2 text-sm font-medium">
                <KeyRound className="h-4 w-4 text-amber-400" />
                {t("firstRunTitle")}
              </div>
              <p className="text-xs text-muted-foreground">{t("firstRunHint")}</p>
              <Field label={t("newPassword")} value={setupPw1} onChange={setSetupPw1} type="password" autoFocus />
              <Field label={t("confirmPassword")} value={setupPw2} onChange={setSetupPw2} type="password" />
              {setupOk
                ? <div className="text-xs text-emerald-400">{t("pwSet")}</div>
                : setupErr && <div className="text-xs text-destructive">{setupErr}</div>}
              <button
                type="submit"
                data-testid="button-provision-admin"
                disabled={busy || setupOk}
                className="w-full py-2 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90 disabled:opacity-50"
              >
                {busy ? t("verifying") : t("provision")}
              </button>
              <button
                type="button"
                onClick={() => { setSetupMode(false); setSetupErr(null); }}
                className="w-full text-[11px] text-muted-foreground hover:text-foreground underline"
              >
                ← {t("cancel")}
              </button>
            </form>
          ) : showLogin ? (
            <form onSubmit={submitLogin} className="space-y-3">
              <div className="text-sm font-medium" data-testid="text-login-title">
                {lanAuth
                  ? t("lanLoginTitle")
                  : pcRoleLock === null && !(licensed && configured)
                  ? t("firstOpenSuperAdminPrompt")
                  : t("loginTitle")}
              </div>
              {pcDeviceName && (
                <div
                  className="rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs"
                  data-testid="text-login-device-name"
                >
                  <span className="opacity-70">{t("deviceNameBadge")}: </span>
                  <span className="font-medium">{pcDeviceName}</span>
                </div>
              )}
              {bridge && updPackaged && (
                <div className="rounded-md border border-border bg-secondary/30 px-3 py-2 space-y-2" data-testid="login-update-panel">
                  <div className="text-xs font-medium">Update</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={onCheckUpdates}
                      disabled={updState.kind === "checking" || updState.kind === "progress"}
                      className="px-2.5 py-1 rounded border border-border bg-secondary text-xs disabled:opacity-50"
                      data-testid="button-login-check-update"
                    >
                      {updState.kind === "checking"
                        ? "Checking…"
                        : updState.kind === "progress"
                        ? "Downloading…"
                        : "Check for update"}
                    </button>
                    {updState.kind === "downloaded" && (
                      <button
                        type="button"
                        onClick={onInstallUpdateNow}
                        className="px-2.5 py-1 rounded bg-primary text-primary-foreground text-xs"
                        data-testid="button-login-install-update"
                      >
                        Restart & install
                      </button>
                    )}
                    {updState.kind === "available" && (
                      <span className="text-[11px] text-amber-400">v{updState.version} found</span>
                    )}
                    {updState.kind === "none" && (
                      <span className="text-[11px] text-emerald-400">Up to date</span>
                    )}
                    {updState.kind === "error" && (
                      <span className="text-[11px] text-destructive truncate max-w-[14rem]" title={updState.message}>Error: {updState.message}</span>
                    )}
                    {updState.kind === "progress" && (
                      <span className="text-[11px] text-muted-foreground">
                        {updState.percent.toFixed(0)}% · {fmtMB(updState.transferred)}/{fmtMB(updState.total)}
                      </span>
                    )}
                  </div>
                </div>
              )}
              <Field label={t("username")} value={u} onChange={setU} autoFocus={!u} />
              <Field label={t("password")} value={p} onChange={setP} type="password" autoFocus={!!u && !p} />
              {lanNoAuth && (
                <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-2.5 space-y-2">
                  <div className="text-[11px] text-sky-100">
                    Local test mode (no password checks)
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    <button type="button" onClick={() => { void quickLogin("super_admin"); }} disabled={busy} className="px-2 py-1 rounded bg-sky-700/70 hover:bg-sky-600 text-[11px] disabled:opacity-50">Super Admin</button>
                    <button type="button" onClick={() => { void quickLogin("ops"); }} disabled={busy} className="px-2 py-1 rounded bg-sky-700/70 hover:bg-sky-600 text-[11px] disabled:opacity-50">Ops</button>
                    <button type="button" onClick={() => { void quickLogin("commander"); }} disabled={busy} className="px-2 py-1 rounded bg-sky-700/70 hover:bg-sky-600 text-[11px] disabled:opacity-50">Cmdr</button>
                  </div>
                </div>
              )}
              {lockedRemaining > 0
                ? <div className="text-xs text-amber-400">{t("lockedOut")} ({lockedRemaining}s)</div>
                : err && <div className="text-xs text-destructive">{err}</div>}
              <button data-testid="button-signin" disabled={busy || lockedRemaining > 0} className="w-full py-2 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90 disabled:opacity-50">{busy ? t("verifying") : t("signIn")}</button>
              {/* Dev-only escape hatch: when running in the in-browser preview
                  (no Supabase backend, hostname is replit.dev / localhost) the
                  2FA secret + lockout live in localStorage. If the operator
                  enters the wrong TOTP a few times they get locked out for 5
                  min with no way to recover without DevTools — which is awful
                  for iterating on the UI. This button only renders in that
                  exact preview context, never in shipped Electron builds or
                  any deployed Supabase environment. */}
              {(() => {
                const h = typeof window !== "undefined" ? window.location.hostname : "";
                const isDevPreview =
                  h.endsWith(".replit.dev") || h.endsWith(".repl.co") || h === "localhost" || h === "127.0.0.1";
                if (!isDevPreview) return null;
                return (
                  <button
                    type="button"
                    data-testid="button-dev-reset-2fa"
                    onClick={() => {
                      try {
                        localStorage.removeItem("rjaf.lockUntil");
                        localStorage.removeItem("rjaf.failedAttempts");
                        localStorage.removeItem("rjaf.adminTotp.secret");
                        localStorage.removeItem("rjaf.adminTotp.recoveryCodes");
                        localStorage.removeItem("rjaf.adminTotp.recoveryUsed");
                      } catch {}
                      window.location.reload();
                    }}
                    className="w-full text-[10px] text-muted-foreground/70 hover:text-amber-400 underline underline-offset-2"
                  >
                    Reset lockout & 2FA enrollment (dev preview only)
                  </button>
                );
              })()}
              {u.trim().toLowerCase() !== "admin" && (
                <button
                  type="button"
                  data-testid="button-admin-access"
                  onClick={() => {
                    setHqMode(true);
                    setU("admin");
                    setP("");
                    setErr(null);
                  }}
                  className="w-full text-[11px] text-amber-400 hover:text-amber-300 underline pt-0.5"
                >
                  {pcRoleLock !== null || (licensed && configured)
                    ? t("adminAccess")
                    : t("superAdminAccess")}
                </button>
              )}
              {hqMode && !licensed && (
                <button type="button" onClick={() => setHqMode(false)} className="w-full text-[11px] text-muted-foreground hover:text-foreground underline">
                  ← {t("licenseTitle")}
                </button>
              )}
            </form>
          ) : !licensed && !lanAuth ? (
            <form onSubmit={submitLicense} className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="h-4 w-4 text-amber-400" />
                {t("licenseTitle")}
              </div>
              <p className="text-xs text-muted-foreground">{t("licensePrompt")}</p>
              <div>
                <label htmlFor="lic-user" className="text-xs text-muted-foreground">{t("operatorUsername")}</label>
                <input
                  id="lic-user"
                  data-testid="input-license-username"
                  value={licUsername}
                  onChange={e => setLicUsername(e.target.value)}
                  autoFocus={!licUsername}
                  className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm"
                  placeholder={t("operatorUsernamePh")}
                  autoComplete="username"
                />
              </div>
              <div>
                <label htmlFor="lic-key" className="text-xs text-muted-foreground">{t("licenseKey")}</label>
                <input
                  id="lic-key"
                  data-testid="input-license-key"
                  value={licenseKey}
                  onChange={e => setLicenseKey(e.target.value)}
                  autoFocus={!!licUsername && !licenseKey}
                  className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border font-mono text-sm tracking-wider"
                  placeholder="EE-XXX-XXXX-XXXX-XXXX-XXXX"
                />
              </div>
              <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                <KeyRound className="h-3 w-3" /> {t("bindNotice")}
              </div>
              <div className="text-[11px] font-mono text-muted-foreground break-all">FP: {fingerprint}</div>
              {licError && <div className="text-xs text-destructive">{licError}</div>}
              <button disabled={busy} className="w-full py-2 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90 disabled:opacity-50">{busy ? t("verifying") : t("activate")}</button>
              <button
                type="button"
                data-testid="button-license-superadmin-access"
                onClick={() => { setHqMode(true); setU("admin"); setP(""); setErr(null); }}
                className="w-full text-xs text-amber-400 hover:text-amber-300 pt-1"
              >
                {t("superAdminPanel")} / {t("commanderDashboard")} →
              </button>
              <p className="text-[10px] text-muted-foreground text-center leading-snug">
                {t("licenseSuperAdminHint")}
              </p>
            </form>
          ) : (
            <form onSubmit={submitSetup} className="space-y-3">
              <div className="text-sm font-medium">{t("setupTitle")}</div>
              <p className="text-xs text-muted-foreground">{t("setupHint")}</p>
              <Field label={t("sqdnName")} value={name} onChange={setName} />
              <div className="grid grid-cols-2 gap-2">
                <Field label={t("sqdnNumber")} value={num} onChange={setNum} />
                <Field label={t("base")} value={base} onChange={setBase} />
              </div>
              <button className="w-full py-2 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90">{t("save")}</button>
            </form>
          )}
        </div>

        {/* Contact strip — subtle, centered, visible on every login screen
            so anyone without a license key can find the developer. */}
        <div className="mt-6 flex flex-col items-center gap-2.5">
          <div className="flex items-center gap-3 w-full">
            <div className="h-px flex-1 bg-gradient-to-r from-transparent to-border" />
            <div className="text-[10px] uppercase tracking-[0.2em] gold-grad font-semibold">
              {t("creditsTitle")}
            </div>
            <div className="h-px flex-1 bg-gradient-to-l from-transparent to-border" />
          </div>

          <div className="text-center">
            <span
              className="text-sm uppercase tracking-[0.2em] font-bold bg-gradient-to-r from-amber-400 via-amber-200 to-amber-400 bg-clip-text text-transparent select-none"
              data-testid="text-credit-login"
            >
              DEVELOPED BY CAPT. ABEDALQADER GHUNMAT
            </span>
          </div>

          <div className="flex flex-wrap justify-center gap-2">
            <a
              href="tel:+9620775008345"
              data-testid="link-credits-phone"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border bg-secondary/40 hover:bg-secondary hover:border-amber-400/40 transition text-[11px] font-medium text-foreground"
            >
              <Phone className="h-3 w-3 text-amber-400" />
              +962 77 500 8345
            </a>
            <a
              href="mailto:ghneimatabed1@icloud.com"
              data-testid="link-credits-email"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border bg-secondary/40 hover:bg-secondary hover:border-amber-400/40 transition text-[11px] font-medium text-foreground"
            >
              <Mail className="h-3 w-3 text-amber-400" />
              ghneimatabed1@icloud.com
            </a>
          </div>

          <p className="text-[10px] text-muted-foreground text-center leading-snug max-w-xs px-2">
            {t("creditsBlurb")}
          </p>
        </div>

        <div className="text-[10px] text-center text-muted-foreground mt-5">
          © RJAF — Encrypted in transit (TLS) and at rest. Audit logged.
        </div>
        <div className="text-[11px] text-center mt-2">
          <span
            className="uppercase tracking-[0.2em] font-semibold bg-gradient-to-r from-amber-400 via-amber-200 to-amber-400 bg-clip-text text-transparent select-none"
            data-testid="text-credit-login"
          >
            Developed by Capt. ABEDALQADER GHUNMAT
          </span>
        </div>
      </div>
    </div>
    </div>
  );
}

function Field({
  label, value, onChange, type = "text", autoFocus = false, disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const id = `f-${label.replace(/\s+/g, "-").toLowerCase()}`;
  const dt = label.toLowerCase().includes("user") ? "input-username" : label.toLowerCase().includes("pass") ? "input-password" : undefined;
  return (
    <div>
      <label htmlFor={id} className="text-xs text-muted-foreground">{label}</label>
      <input
        id={id}
        data-testid={dt}
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        autoFocus={autoFocus}
        disabled={disabled}
        className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm disabled:opacity-60"
      />
    </div>
  );
}
