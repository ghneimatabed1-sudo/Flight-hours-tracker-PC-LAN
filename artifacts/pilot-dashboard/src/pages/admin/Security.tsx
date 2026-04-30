import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { KeyRound, ShieldCheck, ShieldAlert, RefreshCw, Lock, Monitor, LifeBuoy } from "lucide-react";
import type { PcRoleLock } from "@/lib/auth";
import { BackupCard } from "@/components/BackupCard";

export default function AdminSecurity() {
  const { t } = useI18n();
  const { adminTotpEnrolled, regenerateRecoveryCodes, changeSuperAdminPassword, resetSuperAdminPasswordWithMaster, backendMode, pcRoleLock, setPcRoleLock, pcDeviceName, setPcDeviceName, squadron, fingerprint } = useAuth();

  // Master-recovery reset is now staged through a 3-step dialog:
  //   step "key"      → enter the Master Recovery Key
  //   step "pick"     → list of PCs known to this install (just this one in
  //                     standalone mode) with a "Change password" action
  //   step "password" → new password + confirm → apply → done
  // The baked-in key is checked client-side on "key" so we don't show the
  // PC list until the key is correct. The actual password hash is only
  // written in the final step, matching the user's mental model.
  type MrStep = "closed" | "key" | "pick" | "password" | "done";
  const [mrStep, setMrStep] = useState<MrStep>("closed");
  const [mrMaster, setMrMaster] = useState("");
  const [mrNew, setMrNew] = useState("");
  const [mrConfirm, setMrConfirm] = useState("");
  const [mrBusy, setMrBusy] = useState(false);
  const [mrErr, setMrErr] = useState<string | null>(null);
  // Prefer the super-admin-assigned device name; fall back to squadron
  // identity; finally to a generic "This PC" string so the row is never
  // empty in the master-recovery picker.
  const pcLabel = pcDeviceName
    ? pcDeviceName
    : squadron?.name
      ? `${squadron.name}${squadron.number ? " — " + squadron.number : ""}`
      : t("thisPc");
  const pcFingerprintShort = fingerprint ? fingerprint.slice(0, 8).toUpperCase() : "—";
  const closeMasterDialog = () => {
    setMrStep("closed");
    setMrMaster(""); setMrNew(""); setMrConfirm("");
    setMrErr(null); setMrBusy(false);
  };
  const submitMasterKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mrBusy) return;
    setMrErr(null);
    // We piggy-back on resetSuperAdminPasswordWithMaster's master-key check
    // by calling it with a deliberately invalid new password — if the key
    // is right we'll get { error: "too_short" } back; if the key is wrong
    // we'll get { error: "bad_master" }. That way the authoritative check
    // stays in one place (auth.tsx) instead of being duplicated in the UI.
    setMrBusy(true);
    const probe = await resetSuperAdminPasswordWithMaster(mrMaster, "");
    setMrBusy(false);
    if (probe.ok) { setMrStep("pick"); return; }
    if (probe.error === "too_short") { setMrStep("pick"); return; }
    if (probe.error === "bad_master") { setMrErr(t("masterResetBadMaster")); return; }
    if (probe.error === "server_managed") { setMrErr(t("pwServerManaged")); return; }
    setMrErr(t("pwGenericError"));
  };
  const submitNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mrBusy) return;
    setMrErr(null);
    if (mrNew.length < 8) { setMrErr(t("pwTooShort")); return; }
    if (mrNew !== mrConfirm) { setMrErr(t("pwMismatch")); return; }
    setMrBusy(true);
    const res = await resetSuperAdminPasswordWithMaster(mrMaster, mrNew);
    setMrBusy(false);
    if (!res.ok) {
      if (res.error === "bad_master") setMrErr(t("masterResetBadMaster"));
      else if (res.error === "too_short") setMrErr(t("pwTooShort"));
      else if (res.error === "server_managed") setMrErr(t("pwServerManaged"));
      else setMrErr(t("pwGenericError"));
      return;
    }
    setMrStep("done");
  };

  // Local editable copy of the PC role lock so the super admin can preview
  // the choice before applying. Initialized from the persisted value.
  const [lockDraft, setLockDraft] = useState<PcRoleLock>(pcRoleLock);
  const [deviceNameDraft, setDeviceNameDraft] = useState<string>(pcDeviceName);
  const [lockSaved, setLockSaved] = useState(false);
  const lockOptionLabel = (v: PcRoleLock): string => {
    if (v === "ops") return t("roleLockOps");
    if (v === "commander") return t("roleLockCommander");
    if (v === "super_admin") return t("roleLockSuperAdmin");
    return t("roleLockNone");
  };
  const applyLock = () => {
    setPcRoleLock(lockDraft);
    setPcDeviceName(deviceNameDraft);
    setLockSaved(true);
    window.setTimeout(() => setLockSaved(false), 3000);
  };
  const clearLock = () => {
    setPcRoleLock(null);
    setPcDeviceName("");
    setLockDraft(null);
    setDeviceNameDraft("");
    setLockSaved(true);
    window.setTimeout(() => setLockSaved(false), 3000);
  };
  const lockDirty = lockDraft !== pcRoleLock || deviceNameDraft.trim() !== pcDeviceName;

  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwConfirm, setPwConfirm] = useState("");
  const [pwTotp, setPwTotp] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [pwOk, setPwOk] = useState(false);
  const [pwVisible, setPwVisible] = useState(false);
  // Supabase mode no longer blocks the change-password form — it routes
  // through the super-admin-2fa edge function, which updates the hash in
  // super_admin_credentials so every PC picks it up on next login. We
  // still track the mode so the UI can require a 6-digit TOTP only when
  // the backend actually enforces it.
  const pwRequiresTotp = backendMode === "supabase";

  // Cryptographically-strong password generator. Uses window.crypto so
  // the random bytes are uniform, and guarantees the result contains at
  // least one character from each class (upper, lower, digit, symbol) so
  // it satisfies every reasonable password policy out of the box.
  const generatePassword = (length = 20): string => {
    const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";   // no I or O
    const lower = "abcdefghijkmnopqrstuvwxyz";   // no l
    const digit = "23456789";                    // no 0 or 1
    const symbol = "!@#$%^&*_-+=?";
    const all = upper + lower + digit + symbol;
    const pickFrom = (set: string) => {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      return set[buf[0] % set.length];
    };
    const out = [
      pickFrom(upper), pickFrom(lower), pickFrom(digit), pickFrom(symbol),
    ];
    for (let i = out.length; i < length; i++) out.push(pickFrom(all));
    // Fisher–Yates shuffle with crypto randomness so the mandatory-class
    // characters aren't always in the first four positions.
    for (let i = out.length - 1; i > 0; i--) {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      const j = buf[0] % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out.join("");
  };
  const applyGeneratedPassword = async () => {
    const pw = generatePassword(20);
    setPwNew(pw);
    setPwConfirm(pw);
    setPwVisible(true);
    setPwErr(null);
    setPwOk(false);
    try { await navigator.clipboard.writeText(pw); } catch { /* clipboard may be blocked */ }
  };

  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  // In Supabase mode `adminTotpEnrolled` is only flipped after a fresh
  // verify-step in this browser session (it's not persisted to localStorage),
  // so an admin who's already signed in but hasn't re-verified during this
  // page load would falsely look "not enrolled". Their session itself is
  // proof of enrollment, so we trust signed-in super_admins here.
  const enrolled = adminTotpEnrolled || backendMode === "supabase" || backendMode === "lan";

  const reset = () => {
    setCode("");
    setErr(null);
    setBusy(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    const res = await regenerateRecoveryCodes(code);
    setBusy(false);
    if (!res.ok) {
      if (res.error === "locked") setErr(t("regenerateLocked"));
      else if (res.error === "not_enrolled") setErr(t("regenerateNotEnrolled"));
      else setErr(t("regenerateBadCode"));
      return;
    }
    setNewCodes(res.recoveryCodes ?? []);
    setOpen(false);
    reset();
  };

  const copyCodes = async () => {
    if (!newCodes) return;
    try {
      await navigator.clipboard.writeText(newCodes.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch { /* no-op */ }
  };
  const downloadCodes = () => {
    if (!newCodes) return;
    const header = "RJAF Pilot Dashboard — Super Admin recovery codes\n" +
      "Regenerated: " + new Date().toISOString() + "\n" +
      "Keep these somewhere safe. Each one works only once.\n\n";
    const blob = new Blob([header + newCodes.join("\n") + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "rjaf-admin-recovery-codes.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pwBusy) return;
    setPwErr(null);
    setPwOk(false);
    if (pwNew.length < 8) { setPwErr(t("pwTooShort")); return; }
    if (pwNew !== pwConfirm) { setPwErr(t("pwMismatch")); return; }
    if (pwRequiresTotp && !/^\d{6}$/.test(pwTotp.trim())) { setPwErr(t("pwBadTotp")); return; }
    setPwBusy(true);
    const res = await changeSuperAdminPassword(pwCurrent, pwNew, pwTotp.trim());
    setPwBusy(false);
    if (!res.ok) {
      if (res.error === "bad_current") setPwErr(t("pwBadCurrent"));
      else if (res.error === "too_short") setPwErr(t("pwTooShort"));
      else if (res.error === "same") setPwErr(t("pwSame"));
      else if (res.error === "bad_totp" || res.error === "bad") setPwErr(t("pwBadTotp"));
      else if (res.error === "locked") setPwErr(t("regenerateLocked"));
      else if (res.error === "server_managed") setPwErr(t("pwServerManaged"));
      else setPwErr(t("pwGenericError"));
      return;
    }
    setPwCurrent(""); setPwNew(""); setPwConfirm(""); setPwTotp("");
    setPwVisible(false);
    setPwOk(true);
    window.setTimeout(() => setPwOk(false), 4000);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">{t("securityTitle")}</h2>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Monitor className="h-5 w-5" />
            {t("roleLockTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">{t("roleLockDesc")}</p>
          {pcRoleLock && (
            <div className="rounded-md border border-amber-600/40 bg-amber-500/10 p-3 text-xs text-amber-200 mb-3" data-testid="text-role-lock-active">
              <span className="opacity-80">{t("roleLockActiveBadge")} </span>
              <span className="font-semibold">{lockOptionLabel(pcRoleLock)}</span>
            </div>
          )}
          <div className="space-y-3 max-w-md">
            <div>
              <label className="text-xs text-muted-foreground">{t("roleLockCurrentLabel")}</label>
              <select
                data-testid="select-role-lock"
                value={lockDraft ?? ""}
                onChange={e => {
                  const v = e.target.value;
                  setLockDraft(v === "" ? null : (v as PcRoleLock));
                  setLockSaved(false);
                }}
                className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm"
              >
                <option value="">{t("roleLockNone")}</option>
                <option value="ops">{t("roleLockOps")}</option>
                <option value="commander">{t("roleLockCommander")}</option>
                <option value="super_admin">{t("roleLockSuperAdmin")}</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{t("deviceNameLabel")}</label>
              <Input
                data-testid="input-device-name"
                value={deviceNameDraft}
                onChange={e => { setDeviceNameDraft(e.target.value.slice(0, 48)); setLockSaved(false); }}
                placeholder={t("deviceNamePlaceholder")}
                maxLength={48}
              />
              <p className="text-[11px] text-muted-foreground mt-1">{t("deviceNameHint")}</p>
            </div>
            {lockSaved && <p className="text-xs text-emerald-400" data-testid="text-role-lock-saved">{t("roleLockSaved")}</p>}
            <div className="flex gap-2">
              <Button
                type="button"
                data-testid="button-role-lock-apply"
                onClick={applyLock}
                disabled={!lockDirty}
              >
                {t("roleLockSaveBtn")}
              </Button>
              {pcRoleLock && (
                <Button
                  type="button"
                  variant="outline"
                  data-testid="button-role-lock-clear"
                  onClick={clearLock}
                >
                  {t("roleLockClearBtn")}
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            {t("changePasswordTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">{t("changePasswordBlurb")}</p>
          {pwRequiresTotp && (
            <div className="rounded-md border border-sky-600/40 bg-sky-500/10 p-2 text-[11px] text-sky-200 mb-3">
              {t("pwSyncedAcrossPCs")}
            </div>
          )}
          <form onSubmit={submitPassword} className="space-y-3 max-w-md">
            <div>
              <label className="text-xs text-muted-foreground">{t("currentPassword")}</label>
              <Input
                type="password"
                autoComplete="current-password"
                value={pwCurrent}
                onChange={e => { setPwCurrent(e.target.value); setPwErr(null); setPwOk(false); }}
                data-testid="input-admin-password-current"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-muted-foreground">{t("newPassword")}</label>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={applyGeneratedPassword}
                    className="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-accent inline-flex items-center gap-1"
                    data-testid="button-admin-password-generate"
                  >
                    <RefreshCw className="h-3 w-3" /> {t("pwGenerate")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPwVisible(v => !v)}
                    className="text-[11px] px-2 py-0.5 rounded border border-border hover:bg-accent"
                    data-testid="button-admin-password-toggle-visibility"
                  >
                    {pwVisible ? t("pwHide") : t("pwShow")}
                  </button>
                </div>
              </div>
              <Input
                type={pwVisible ? "text" : "password"}
                autoComplete="new-password"
                value={pwNew}
                onChange={e => { setPwNew(e.target.value); setPwErr(null); setPwOk(false); }}
                data-testid="input-admin-password-new"
              />
              <p className="text-[11px] text-muted-foreground mt-1">{t("pwMinHint")}</p>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{t("confirmPassword")}</label>
              <Input
                type={pwVisible ? "text" : "password"}
                autoComplete="new-password"
                value={pwConfirm}
                onChange={e => { setPwConfirm(e.target.value); setPwErr(null); setPwOk(false); }}
                data-testid="input-admin-password-confirm"
              />
            </div>
            {pwRequiresTotp && (
              <div>
                <label className="text-xs text-muted-foreground">{t("pwTotpLabel")}</label>
                <Input
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  placeholder="000000"
                  value={pwTotp}
                  onChange={e => { setPwTotp(e.target.value.replace(/\D/g, "").slice(0, 6)); setPwErr(null); setPwOk(false); }}
                  data-testid="input-admin-password-totp"
                />
                <p className="text-[11px] text-muted-foreground mt-1">{t("pwTotpHint")}</p>
              </div>
            )}
            {pwErr && <p className="text-xs text-destructive" data-testid="text-admin-password-error">{pwErr}</p>}
            {pwOk && <p className="text-xs text-emerald-400" data-testid="text-admin-password-ok">✔ {t("pwUpdated")}</p>}
            <Button
              type="submit"
              disabled={pwBusy || !pwCurrent || !pwNew || !pwConfirm || (pwRequiresTotp && pwTotp.length !== 6)}
              data-testid="button-admin-password-submit"
            >
              {pwBusy ? t("saving") : t("updatePassword")}
            </Button>
          </form>
        </CardContent>
      </Card>

      {!pwRequiresTotp && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <LifeBuoy className="h-5 w-5 text-destructive" />
              {t("masterResetTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive mb-3 inline-block">
              {t("masterResetDanger")}
            </div>
            <p className="text-xs text-muted-foreground mb-3">{t("masterResetBlurb")}</p>
            <Button
              type="button"
              variant="destructive"
              onClick={() => { setMrErr(null); setMrStep("key"); }}
              data-testid="button-open-master-recovery"
            >
              <LifeBuoy className="h-4 w-4 me-2" />
              {t("masterResetOpenBtn")}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Master-recovery dialog: key → pick PC → new password → done */}
      <Dialog open={mrStep !== "closed"} onOpenChange={(o) => { if (!o) closeMasterDialog(); }}>
        <DialogContent data-testid="dialog-master-recovery">
          {mrStep === "key" && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <LifeBuoy className="h-5 w-5 text-destructive" />
                  {t("masterResetTitle")}
                </DialogTitle>
                <DialogDescription>{t("masterResetStepKeyHint")}</DialogDescription>
              </DialogHeader>
              <form onSubmit={submitMasterKey} className="space-y-3">
                <div>
                  <label className="text-xs text-muted-foreground">{t("masterResetKey")}</label>
                  <Input
                    autoFocus
                    type="password"
                    autoComplete="off"
                    value={mrMaster}
                    onChange={e => { setMrMaster(e.target.value); setMrErr(null); }}
                    data-testid="input-master-recovery-key"
                  />
                </div>
                {mrErr && <p className="text-xs text-destructive" data-testid="text-master-recovery-error">{mrErr}</p>}
                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={closeMasterDialog} data-testid="button-master-recovery-cancel">{t("cancel")}</Button>
                  <Button type="submit" disabled={mrBusy || !mrMaster} data-testid="button-master-recovery-unlock">
                    {mrBusy ? t("saving") : t("masterResetUnlockBtn")}
                  </Button>
                </DialogFooter>
              </form>
            </>
          )}

          {mrStep === "pick" && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Monitor className="h-5 w-5" />
                  {t("masterResetPickTitle")}
                </DialogTitle>
                <DialogDescription>{t("masterResetPickHint")}</DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => { setMrErr(null); setMrStep("password"); }}
                  onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { setMrErr(null); setMrStep("password"); } }}
                  className="rounded-md border border-border hover:border-primary hover:bg-secondary/50 p-3 cursor-pointer transition-colors"
                  data-testid="row-master-recovery-pc"
                >
                  <div className="flex items-center gap-3">
                    <Monitor className="h-5 w-5 text-primary flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate" data-testid="text-master-recovery-pc-label">{pcLabel}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {t("thisPcBadge")} · ID: <span className="font-mono" data-testid="text-master-recovery-pc-id">{pcFingerprintShort}</span>
                      </div>
                    </div>
                    <Button type="button" size="sm" variant="outline" tabIndex={-1}>
                      {t("masterResetPickBtn")}
                    </Button>
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground">{t("masterResetPickNote")}</p>
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={closeMasterDialog} data-testid="button-master-recovery-close">{t("close")}</Button>
              </DialogFooter>
            </>
          )}

          {mrStep === "password" && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <KeyRound className="h-5 w-5" />
                  {t("masterResetPasswordTitle")}
                </DialogTitle>
                <DialogDescription>
                  <span className="opacity-80">{t("masterResetPasswordHintFor")} </span>
                  <span className="font-medium">{pcLabel}</span>
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={submitNewPassword} className="space-y-3">
                <div>
                  <label className="text-xs text-muted-foreground">{t("newPassword")}</label>
                  <Input
                    autoFocus
                    type="password"
                    autoComplete="new-password"
                    value={mrNew}
                    onChange={e => { setMrNew(e.target.value); setMrErr(null); }}
                    data-testid="input-master-recovery-new"
                  />
                  <p className="text-[11px] text-muted-foreground mt-1">{t("pwMinHint")}</p>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">{t("confirmPassword")}</label>
                  <Input
                    type="password"
                    autoComplete="new-password"
                    value={mrConfirm}
                    onChange={e => { setMrConfirm(e.target.value); setMrErr(null); }}
                    data-testid="input-master-recovery-confirm"
                  />
                </div>
                {mrErr && <p className="text-xs text-destructive" data-testid="text-master-recovery-error">{mrErr}</p>}
                <DialogFooter>
                  <Button type="button" variant="ghost" onClick={() => { setMrErr(null); setMrStep("pick"); }} data-testid="button-master-recovery-back">{t("back")}</Button>
                  <Button type="submit" variant="destructive" disabled={mrBusy || !mrNew || !mrConfirm} data-testid="button-master-recovery-submit">
                    {mrBusy ? t("saving") : t("masterResetBtn")}
                  </Button>
                </DialogFooter>
              </form>
            </>
          )}

          {mrStep === "done" && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-emerald-500">
                  <ShieldCheck className="h-5 w-5" />
                  {t("masterResetOk")}
                </DialogTitle>
                <DialogDescription>
                  <span className="opacity-80">{t("masterResetDoneHintFor")} </span>
                  <span className="font-medium">{pcLabel}</span>
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button type="button" onClick={closeMasterDialog} data-testid="button-master-recovery-done">{t("done")}</Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            {t("twoFactorSection")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className="flex items-center gap-2 text-sm"
            data-testid="text-2fa-status"
          >
            {enrolled ? (
              <>
                <ShieldCheck className="h-4 w-4 text-emerald-500" />
                <span>{t("twoFactorEnrolledStatus")}</span>
              </>
            ) : (
              <>
                <ShieldAlert className="h-4 w-4 text-amber-500" />
                <span>{t("twoFactorNotEnrolledStatus")}</span>
              </>
            )}
          </div>

          <div className="rounded-md border border-border p-4 space-y-3">
            <div className="flex items-center gap-2 font-medium">
              <KeyRound className="h-4 w-4" />
              {t("regenerateRecoveryCodesTitle")}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("regenerateRecoveryCodesDesc")}
            </p>
            <Button
              variant="outline"
              disabled={!enrolled}
              onClick={() => { reset(); setOpen(true); }}
              data-testid="button-open-regenerate"
            >
              <RefreshCw className="h-4 w-4 me-2" />
              {t("regenerateRecoveryCodesBtn")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
        <DialogContent data-testid="dialog-regenerate-confirm">
          <DialogHeader>
            <DialogTitle>{t("regenerateConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("regenerateConfirmHint")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-3">
            <Input
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setErr(null); }}
              placeholder="000000"
              className="font-mono tracking-widest text-center text-lg"
              data-testid="input-regenerate-code"
            />
            {err && (
              <p className="text-xs text-destructive" data-testid="text-regenerate-error">{err}</p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => { setOpen(false); reset(); }}
                data-testid="button-cancel-regenerate"
              >
                {t("cancel")}
              </Button>
              <Button
                type="submit"
                disabled={code.length !== 6 || busy}
                data-testid="button-confirm-regenerate"
              >
                {t("regenerateConfirmBtn")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!newCodes} onOpenChange={(o) => { if (!o) setNewCodes(null); }}>
        <DialogContent data-testid="dialog-regenerate-result">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-amber-500" />
              {t("regenerateNewCodesTitle")}
            </DialogTitle>
            <DialogDescription>{t("regenerateNewCodesHint")}</DialogDescription>
          </DialogHeader>
          <div
            data-testid="list-new-recovery-codes"
            className="grid grid-cols-2 gap-2 p-3 rounded-md bg-muted border border-border font-mono text-sm tracking-wider select-all"
          >
            {(newCodes ?? []).map((c, i) => (
              <div key={i} className="py-0.5" data-testid={`text-new-recovery-code-${i}`}>{c}</div>
            ))}
          </div>
          <p className="text-[11px] text-amber-500">{t("recoveryCodesWarn")}</p>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={copyCodes}
              data-testid="button-copy-new-recovery-codes"
            >
              {copied ? t("copied") : t("copy")}
            </Button>
            <Button
              variant="outline"
              onClick={downloadCodes}
              data-testid="button-download-new-recovery-codes"
            >
              {t("download")}
            </Button>
            <Button
              onClick={() => setNewCodes(null)}
              data-testid="button-ack-new-recovery-codes"
            >
              {t("done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Password-protected export / restore of the full squadron install.
          Lives at the bottom of the Security page so the super-admin sees
          it alongside the other recovery tools. */}
      <BackupCard />
    </div>
  );
}
