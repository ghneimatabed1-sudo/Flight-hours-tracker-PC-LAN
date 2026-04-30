import { useMemo, useState } from "react";
import { UserPlus, Trash2, Copy, Check, ShieldAlert, KeyRound } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { PageHead } from "@/components/Layout";
import { useAuth } from "@/lib/auth";
import {
  listCommanders, createCommander, deleteCommander, resetCommanderPassword,
  type CommanderRecord,
} from "@/lib/commander-store";

const MAX_ASSIGNED = 3;

export default function OpsTeam() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [tick, setTick] = useState(0);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<{ username: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<CommanderRecord | null>(null);
  const [resetTarget, setResetTarget] = useState<CommanderRecord | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetBusy, setResetBusy] = useState(false);

  const allOps = useMemo(() => listCommanders().filter(c => c.role === "ops"), [tick]);
  // The currently logged-in ops pilot is the "lead" — exclude self from list of assignees.
  const assigned = useMemo(
    () => allOps.filter(c => c.username !== (user?.username || "").toLowerCase()),
    [allOps, user]
  );
  const remaining = Math.max(0, MAX_ASSIGNED - assigned.length);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (remaining === 0) return;
    setError(null);
    const pwd = password.trim();
    if (pwd.length > 0) {
      if (pwd.length < 4) { setError("password_too_short"); return; }
      if (pwd !== confirmPassword.trim()) { setError("passwords_do_not_match"); return; }
    }
    setBusy(true);
    const res = await createCommander({
      username: username.trim().toLowerCase(),
      displayName: displayName.trim() || username.trim(),
      role: "ops",
      password: pwd || undefined,
    });
    setBusy(false);
    if (!res.ok || !res.record || !res.initialPassword) {
      setError(res.error || "create_failed");
      return;
    }
    setGenerated({ username: res.record.username, password: res.initialPassword });
    setUsername(""); setDisplayName(""); setPassword(""); setConfirmPassword("");
    setTick(x => x + 1);
  };

  const openReset = (c: CommanderRecord) => {
    setResetTarget(c);
    setResetPassword("");
    setResetConfirm("");
    setResetError(null);
  };

  const onReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetTarget) return;
    setResetError(null);
    const pwd = resetPassword.trim();
    if (pwd.length > 0) {
      if (pwd.length < 4) { setResetError("password_too_short"); return; }
      if (pwd !== resetConfirm.trim()) { setResetError("passwords_do_not_match"); return; }
    }
    setResetBusy(true);
    const newPwd = await resetCommanderPassword(resetTarget.id, pwd || undefined);
    setResetBusy(false);
    if (!newPwd) { setResetError("reset_failed"); return; }
    const username = resetTarget.username;
    setResetTarget(null);
    setGenerated({ username, password: newPwd });
  };

  const onCopy = async () => {
    if (!generated) return;
    await navigator.clipboard.writeText(`User: ${generated.username}\nPassword: ${generated.password}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const onRevoke = (c: CommanderRecord) => {
    deleteCommander(c.id);
    setConfirmRevoke(null);
    setTick(x => x + 1);
  };

  return (
    <div>
      <PageHead title={t("opsTeamTitle")} subtitle={t("opsTeamSubtitle")} />

      <div className="grid gap-4 md:grid-cols-2 mt-4">
        <section className="bg-card border border-border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <UserPlus className="h-4 w-4 text-primary" />
            <h3 className="font-semibold">{t("opsTeamCreate")}</h3>
            <span className="ml-auto text-xs text-muted-foreground" data-testid="text-opsteam-remaining">
              {remaining === 0 ? t("opsTeamLimit") : t("opsTeamRemaining").replace("{n}", String(remaining))}
            </span>
          </div>

          {generated ? (
            <div className="space-y-3" data-testid="panel-opsteam-generated">
              <p className="text-sm text-emerald-300">{t("opsTeamGenerated")}</p>
              <div className="font-mono text-sm bg-background border border-border rounded p-3 space-y-1">
                <div>User: <span className="font-semibold" data-testid="text-opsteam-new-user">{generated.username}</span></div>
                <div>Pass: <span className="font-semibold" data-testid="text-opsteam-new-pass">{generated.password}</span></div>
              </div>
              <div className="flex gap-2">
                <button onClick={onCopy}
                  className="px-3 py-1.5 rounded-md border border-border text-sm inline-flex items-center gap-1 hover:bg-secondary"
                  data-testid="button-opsteam-copy">
                  {copied ? <><Check className="h-3.5 w-3.5" /> {t("opsTeamCopied")}</> : <><Copy className="h-3.5 w-3.5" /> {t("opsTeamCopy")}</>}
                </button>
                <button onClick={() => setGenerated(null)}
                  className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium"
                  data-testid="button-opsteam-done">
                  {t("done")}
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={onCreate} className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground">{t("opsTeamUsername")}</label>
                <input value={username} onChange={e => setUsername(e.target.value)}
                  required minLength={3} maxLength={32} pattern="[a-zA-Z0-9_.-]+"
                  disabled={remaining === 0}
                  className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm font-mono"
                  data-testid="input-opsteam-username" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{t("opsTeamFullName")}</label>
                <input value={displayName} onChange={e => setDisplayName(e.target.value)}
                  maxLength={64}
                  disabled={remaining === 0}
                  className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm"
                  data-testid="input-opsteam-fullname" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">{t("opsTeamPassword")}</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  minLength={4} maxLength={64} autoComplete="new-password"
                  disabled={remaining === 0}
                  placeholder={t("opsTeamPasswordPlaceholder")}
                  className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm font-mono"
                  data-testid="input-opsteam-password" />
              </div>
              {password.length > 0 && (
                <div>
                  <label className="text-xs text-muted-foreground">{t("opsTeamConfirmPassword")}</label>
                  <input type="password" value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
                    minLength={4} maxLength={64} autoComplete="new-password"
                    disabled={remaining === 0}
                    className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm font-mono"
                    data-testid="input-opsteam-password-confirm" />
                </div>
              )}
              {error && (
                <p className="text-xs text-destructive flex items-center gap-1" data-testid="text-opsteam-error">
                  <ShieldAlert className="h-3.5 w-3.5" /> {error.replace(/_/g, " ")}
                </p>
              )}
              <button type="submit" disabled={busy || remaining === 0}
                className="w-full px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-40"
                data-testid="button-opsteam-create">
                {t("opsTeamCreate")}
              </button>
            </form>
          )}
        </section>

        <section className="bg-card border border-border rounded-lg p-4">
          <h3 className="font-semibold mb-3">{t("opsTeamTitle")} ({assigned.length}/{MAX_ASSIGNED})</h3>
          {assigned.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("opsTeamEmpty")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {assigned.map(c => (
                <li key={c.id} className="flex items-center justify-between py-2 text-sm gap-2" data-testid={`row-opsteam-${c.username}`}>
                  <div className="min-w-0">
                    <div className="font-medium truncate">{c.displayName}</div>
                    <div className="text-xs text-muted-foreground font-mono truncate">{c.username}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => openReset(c)}
                      className="text-xs px-2 py-1 rounded-md border border-border text-muted-foreground hover:bg-secondary inline-flex items-center gap-1"
                      data-testid={`button-opsteam-reset-${c.username}`}>
                      <KeyRound className="h-3.5 w-3.5" /> {t("opsTeamResetPassword")}
                    </button>
                    <button onClick={() => setConfirmRevoke(c)}
                      className="text-xs px-2 py-1 rounded-md border border-destructive/40 text-destructive hover:bg-destructive/10 inline-flex items-center gap-1"
                      data-testid={`button-opsteam-revoke-${c.username}`}>
                      <Trash2 className="h-3.5 w-3.5" /> {t("opsTeamRevoke")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {resetTarget && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" data-testid="modal-opsteam-reset">
          <form onSubmit={onReset} className="bg-card border border-border rounded-lg p-5 max-w-md w-full space-y-3">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" />
              <h3 className="font-semibold">{t("opsTeamResetTitle")}</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("opsTeamResetSubtitle")} <span className="font-mono">{resetTarget.username}</span>
            </p>
            <div>
              <label className="text-xs text-muted-foreground">{t("opsTeamPassword")}</label>
              <input type="password" value={resetPassword} onChange={e => setResetPassword(e.target.value)}
                autoFocus minLength={4} maxLength={64} autoComplete="new-password"
                placeholder={t("opsTeamPasswordPlaceholder")}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm font-mono"
                data-testid="input-opsteam-reset-password" />
            </div>
            {resetPassword.length > 0 && (
              <div>
                <label className="text-xs text-muted-foreground">{t("opsTeamConfirmPassword")}</label>
                <input type="password" value={resetConfirm} onChange={e => setResetConfirm(e.target.value)}
                  minLength={4} maxLength={64} autoComplete="new-password"
                  className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm font-mono"
                  data-testid="input-opsteam-reset-confirm" />
              </div>
            )}
            {resetError && (
              <p className="text-xs text-destructive flex items-center gap-1">
                <ShieldAlert className="h-3.5 w-3.5" /> {resetError.replace(/_/g, " ")}
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setResetTarget(null)}
                className="px-3 py-1.5 rounded-md border border-border text-sm"
                data-testid="button-opsteam-reset-cancel">{t("cancel")}</button>
              <button type="submit" disabled={resetBusy}
                className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-40"
                data-testid="button-opsteam-reset-confirm">{t("opsTeamResetSubmit")}</button>
            </div>
          </form>
        </div>
      )}

      {confirmRevoke && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" data-testid="modal-opsteam-revoke">
          <div className="bg-card border border-border rounded-lg p-5 max-w-md w-full">
            <h3 className="font-semibold mb-2">{t("areYouSure")}</h3>
            <p className="text-sm text-muted-foreground mb-4">
              {t("opsTeamRevokeConfirm")} (<span className="font-mono">{confirmRevoke.username}</span>)
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmRevoke(null)}
                className="px-3 py-1.5 rounded-md border border-border text-sm"
                data-testid="button-opsteam-revoke-cancel">{t("cancel")}</button>
              <button onClick={() => onRevoke(confirmRevoke)}
                className="px-3 py-1.5 rounded-md bg-destructive text-destructive-foreground text-sm font-medium"
                data-testid="button-opsteam-revoke-confirm">{t("yesDelete")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
