import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Download,
  Upload,
  Archive,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Settings,
  FolderOpen,
  Clock,
} from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { fmtDateTimeDDMM } from "@/lib/format";
import {
  exportBackup,
  decodeBackup,
  applyBackup,
  suggestBackupFilename,
  type BackupPayload,
} from "@/lib/backup";

// Local widening for the Electron preload bridge. Optional methods because
// the same component runs in pure-browser dev mode where they don't exist.
// All other declarations of `rjafElectron` (LicenseKeys, Settings, Diagnostic)
// are merged structurally — every method is optional, so the union type is
// safe even though different files declare different subsets.
type RjafElectronBridge = {
  hardwareFingerprint?: () => Promise<string>;
  isPackaged?: () => Promise<boolean>;
  pickBackupFolder?: () => Promise<string | null>;
  writeBackupFile?: (folder: string, filename: string, content: string) => Promise<string>;
  [key: string]: unknown;
};
function getElectronBridge(): RjafElectronBridge | null {
  if (typeof window === "undefined") return null;
  return ((window as unknown) as { rjafElectron?: RjafElectronBridge }).rjafElectron ?? null;
}

// Persistent settings keys for the auto-backup feature.
const LS_INTERVAL = "rjaf.backup.autoIntervalDays";
const LS_PWD = "rjaf.backup.autoPwd";
const LS_FOLDER = "rjaf.backup.folder";
const LS_LAST = "rjaf.backup.lastAt";

function readNum(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (raw == null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

type Phase =
  | { kind: "idle" }
  | { kind: "exporting" }
  | { kind: "exported"; filename: string }
  | { kind: "error"; message: string }
  | { kind: "picked"; file: File }
  | { kind: "decoding" }
  | { kind: "decoded"; payload: BackupPayload; file: File }
  | { kind: "applying" }
  | { kind: "applied" };

export function BackupCard() {
  const { t, lang } = useI18n();
  const isAr = lang === "ar";
  const fileRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [exportPwd, setExportPwd] = useState("");
  const [exportPwd2, setExportPwd2] = useState("");
  const [restorePwd, setRestorePwd] = useState("");

  // ── Auto-backup settings ──────────────────────────────────────────────
  const [intervalDays, setIntervalDays] = useState<number>(() => readNum(LS_INTERVAL, 0));
  const [savedPwd, setSavedPwd] = useState<string>(() => localStorage.getItem(LS_PWD) ?? "");
  const [folder, setFolder] = useState<string>(() => localStorage.getItem(LS_FOLDER) ?? "");
  const [lastAt, setLastAt] = useState<string>(() => localStorage.getItem(LS_LAST) ?? "");
  const [newPwd, setNewPwd] = useState("");
  const [newPwd2, setNewPwd2] = useState("");
  const [autoMsg, setAutoMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);

  const hasFolderPicker = !!getElectronBridge()?.pickBackupFolder;

  const tx = (en: string, ar: string) => (isAr ? ar : en);

  // Save the interval (changing the number commits immediately).
  function saveInterval(v: number) {
    const clamped = Math.max(0, Math.min(365, Math.floor(v) || 0));
    setIntervalDays(clamped);
    localStorage.setItem(LS_INTERVAL, String(clamped));
    setAutoMsg({ kind: "ok", text: tx("Settings saved.", "تم حفظ الإعدادات.") });
  }

  function saveAutoPassword() {
    if (newPwd.length < 6) {
      setAutoMsg({ kind: "err", text: t("backup_pwd_too_short") });
      return;
    }
    if (newPwd !== newPwd2) {
      setAutoMsg({ kind: "err", text: t("backup_pwd_mismatch") });
      return;
    }
    localStorage.setItem(LS_PWD, newPwd);
    setSavedPwd(newPwd);
    setNewPwd("");
    setNewPwd2("");
    setAutoMsg({ kind: "ok", text: tx("Auto-backup password saved.", "تم حفظ كلمة مرور النسخ التلقائي.") });
  }

  function clearAutoPassword() {
    localStorage.removeItem(LS_PWD);
    setSavedPwd("");
    setAutoMsg({ kind: "ok", text: tx("Saved password cleared.", "تم مسح كلمة المرور المحفوظة.") });
  }

  async function pickFolder() {
    const bridge = getElectronBridge();
    if (!hasFolderPicker || !bridge?.pickBackupFolder) return;
    try {
      const chosen = await bridge.pickBackupFolder();
      if (!chosen) return;
      setFolder(chosen);
      localStorage.setItem(LS_FOLDER, chosen);
      setAutoMsg({ kind: "ok", text: tx("Backup folder updated.", "تم تحديث مجلد النسخ.") });
    } catch (e) {
      setAutoMsg({ kind: "err", text: (e as Error).message });
    }
  }

  function clearFolder() {
    localStorage.removeItem(LS_FOLDER);
    setFolder("");
    setAutoMsg({
      kind: "ok",
      text: tx(
        "Cleared. Backups will use your Downloads folder.",
        "تم المسح. ستُحفظ النسخ في مجلد التنزيلات.",
      ),
    });
  }

  // Run an auto-backup once: encrypt with savedPwd, then either write to the
  // chosen folder via Electron, or trigger a normal browser download. Caller
  // is responsible for guarding against missing password.
  async function runAutoBackup(reason: "manual" | "scheduled") {
    if (!savedPwd) {
      setAutoMsg({ kind: "err", text: tx("Set an auto-backup password first.", "اضبط كلمة مرور النسخ أولاً.") });
      return;
    }
    setAutoBusy(true);
    setAutoMsg(null);
    try {
      const text = await exportBackup(savedPwd);
      const filename = suggestBackupFilename();
      let savedPath = "";
      const bridge = getElectronBridge();
      if (folder && bridge?.writeBackupFile) {
        savedPath = await bridge.writeBackupFile(folder, filename, text);
      } else {
        const blob = new Blob([text], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        savedPath = tx("Downloads folder", "مجلد التنزيلات");
      }
      const now = new Date().toISOString();
      localStorage.setItem(LS_LAST, now);
      setLastAt(now);
      setAutoMsg({
        kind: "ok",
        text:
          reason === "manual"
            ? tx(`Backup saved to: ${savedPath}`, `تم حفظ النسخة في: ${savedPath}`)
            : tx(`Auto-backup saved to: ${savedPath}`, `حُفظت النسخة التلقائية في: ${savedPath}`),
      });
    } catch (e) {
      setAutoMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setAutoBusy(false);
    }
  }

  // Scheduler: on mount, if interval > 0 and (now - lastAt) >= intervalDays,
  // and a saved password exists, run an auto-backup. Runs once per app load.
  useEffect(() => {
    if (intervalDays <= 0 || !savedPwd) return;
    const last = lastAt ? +new Date(lastAt) : 0;
    const dueAt = last + intervalDays * 86400000;
    if (Date.now() < dueAt) return;
    void runAutoBackup("scheduled");
    // We intentionally only run this on first mount; subsequent setting
    // changes don't re-fire (the operator can press "Back up now" instead).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetExport = () => {
    setExportPwd("");
    setExportPwd2("");
  };

  const doExport = async () => {
    if (exportPwd.length < 6) {
      setPhase({ kind: "error", message: t("backup_pwd_too_short") });
      return;
    }
    if (exportPwd !== exportPwd2) {
      setPhase({ kind: "error", message: t("backup_pwd_mismatch") });
      return;
    }
    setPhase({ kind: "exporting" });
    try {
      const text = await exportBackup(exportPwd);
      const filename = suggestBackupFilename();
      const blob = new Blob([text], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      resetExport();
      setPhase({ kind: "exported", filename });
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message });
    }
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setRestorePwd("");
    setPhase({ kind: "picked", file: f });
    e.target.value = "";
  };

  const doDecode = async () => {
    if (phase.kind !== "picked") return;
    if (!restorePwd) {
      setPhase({ kind: "error", message: t("backup_pwd_required") });
      return;
    }
    setPhase({ kind: "decoding" });
    try {
      const text = await phase.file.text();
      const payload = await decodeBackup(text, restorePwd);
      setPhase({ kind: "decoded", payload, file: phase.file });
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message });
    }
  };

  const doApply = async () => {
    if (phase.kind !== "decoded") return;
    setPhase({ kind: "applying" });
    try {
      applyBackup(phase.payload);
      setPhase({ kind: "applied" });
      setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      setPhase({ kind: "error", message: (e as Error).message });
    }
  };

  const fmtBytes = (n: number) =>
    n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

  // Compute the "next due" hint shown in the settings panel.
  function nextDueText(): string {
    if (intervalDays <= 0) return tx("Disabled", "متوقف");
    if (!lastAt) return tx("Will run on next app start", "سيُنفّذ عند تشغيل التطبيق التالي");
    const dueAt = +new Date(lastAt) + intervalDays * 86400000;
    const ms = dueAt - Date.now();
    if (ms <= 0) return tx("Due now (will run on next start)", "مستحق الآن (يعمل عند التشغيل التالي)");
    const days = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    return tx(`In ${days}d ${hours}h`, `بعد ${days} يوم ${hours} ساعة`);
  }

  return (
    <Card data-testid="card-backup">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Archive className="h-4 w-4" /> {t("backup_title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6 text-sm">
        <p className="text-xs text-muted-foreground leading-relaxed">
          {t("backup_blurb")}
        </p>

        {/* ── Export ─────────────────────────── */}
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider">
            <Download className="h-3.5 w-3.5" /> {t("backup_export_title")}
          </div>
          <p className="text-[11px] text-muted-foreground">{t("backup_export_help")}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <Input
              type="password"
              value={exportPwd}
              onChange={e => setExportPwd(e.target.value)}
              placeholder={t("backup_pwd_placeholder")}
              data-testid="input-backup-password"
              autoComplete="new-password"
            />
            <Input
              type="password"
              value={exportPwd2}
              onChange={e => setExportPwd2(e.target.value)}
              placeholder={t("backup_pwd_confirm_placeholder")}
              data-testid="input-backup-password-confirm"
              autoComplete="new-password"
            />
          </div>
          <Button
            onClick={doExport}
            disabled={phase.kind === "exporting" || !exportPwd || !exportPwd2}
            size="sm"
            data-testid="button-export-backup"
          >
            {phase.kind === "exporting" ? (
              <><Loader2 className="h-3.5 w-3.5 me-2 animate-spin" />{t("backup_exporting")}</>
            ) : (
              <><Download className="h-3.5 w-3.5 me-2" />{t("backup_export_btn")}</>
            )}
          </Button>
        </div>

        {/* ── Auto-backup settings ─────────────────────────── */}
        <div className="space-y-3 rounded-md border border-border p-3" data-testid="section-auto-backup">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider">
            <Settings className="h-3.5 w-3.5" /> {tx("Auto-Backup", "النسخ التلقائي")}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {tx(
              "Save a backup automatically every N days using a stored password. The check runs each time the app starts.",
              "احفظ نسخة احتياطية تلقائياً كل عدد محدد من الأيام باستخدام كلمة مرور مخزّنة. يجري الفحص في كل مرة يفتح التطبيق.",
            )}
          </p>

          {/* Interval */}
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs font-medium min-w-[120px]">
              {tx("Backup every", "نسخ كل")}
            </label>
            <Input
              type="number"
              min={0}
              max={365}
              value={intervalDays}
              onChange={e => saveInterval(Number(e.target.value))}
              className="w-24"
              data-testid="input-auto-interval"
            />
            <span className="text-xs text-muted-foreground">
              {tx("days (0 = off)", "يوم (0 = إيقاف)")}
            </span>
          </div>

          {/* Saved password */}
          <div className="space-y-2 pt-2 border-t border-border/60">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <label className="text-xs font-medium">
                {tx("Auto-backup password", "كلمة مرور النسخ التلقائي")}
              </label>
              <span className="text-[11px] text-muted-foreground">
                {savedPwd
                  ? tx("Saved ✓ — enter a new one to change it", "محفوظة ✓ — أدخل كلمة جديدة لتغييرها")
                  : tx("Not set", "غير مضبوطة")}
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Input
                type="password"
                value={newPwd}
                onChange={e => setNewPwd(e.target.value)}
                placeholder={tx("New auto-backup password", "كلمة مرور جديدة")}
                data-testid="input-auto-password"
                autoComplete="new-password"
              />
              <Input
                type="password"
                value={newPwd2}
                onChange={e => setNewPwd2(e.target.value)}
                placeholder={t("backup_pwd_confirm_placeholder")}
                data-testid="input-auto-password-confirm"
                autoComplete="new-password"
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button
                size="sm"
                onClick={saveAutoPassword}
                disabled={!newPwd || !newPwd2}
                data-testid="button-save-auto-password"
              >
                {savedPwd ? tx("Change password", "تغيير كلمة المرور") : tx("Save password", "حفظ كلمة المرور")}
              </Button>
              {savedPwd && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={clearAutoPassword}
                  data-testid="button-clear-auto-password"
                >
                  {tx("Clear saved password", "مسح كلمة المرور المحفوظة")}
                </Button>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {tx(
                "The password is stored on this PC only. Keep it secret — anyone who can read this PC's storage can read it.",
                "تُحفظ كلمة المرور على هذا الحاسوب فقط. احتفظ بها سراً — أي شخص يستطيع قراءة تخزين الحاسوب يستطيع قراءتها.",
              )}
            </p>
          </div>

          {/* Folder */}
          <div className="space-y-2 pt-2 border-t border-border/60">
            <label className="text-xs font-medium flex items-center gap-1.5">
              <FolderOpen className="h-3.5 w-3.5" />
              {tx("Backup folder", "مجلد النسخ")}
            </label>
            {hasFolderPicker ? (
              <>
                <div className="font-mono text-[11px] bg-muted/60 p-2 rounded break-all" data-testid="text-backup-folder">
                  {folder || tx("(not set — using Downloads folder)", "(غير محدد — يستخدم مجلد التنزيلات)")}
                </div>
                <div className="flex gap-2 flex-wrap">
                  <Button size="sm" variant="outline" onClick={pickFolder} data-testid="button-pick-folder">
                    <FolderOpen className="h-3.5 w-3.5 me-2" />
                    {tx("Choose folder…", "اختر المجلد…")}
                  </Button>
                  {folder && (
                    <Button size="sm" variant="outline" onClick={clearFolder} data-testid="button-clear-folder">
                      {tx("Use Downloads folder", "استخدم مجلد التنزيلات")}
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {tx(
                  "Backups will be saved to your browser's Downloads folder. Folder picker is only available in the desktop app.",
                  "ستُحفظ النسخ في مجلد التنزيلات في المتصفح. اختيار المجلد متاح في تطبيق سطح المكتب فقط.",
                )}
              </p>
            )}
          </div>

          {/* Status row */}
          <div className="pt-2 border-t border-border/60 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
            <div className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">{tx("Last auto-backup:", "آخر نسخة تلقائية:")}</span>
              <span className="font-mono" data-testid="text-last-auto">
                {lastAt ? fmtDateTimeDDMM(lastAt) : tx("Never", "لم تُنشأ بعد")}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">{tx("Next due:", "التالية مستحقة:")}</span>
              <span className="font-mono" data-testid="text-next-due">{nextDueText()}</span>
            </div>
          </div>

          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => runAutoBackup("manual")}
              disabled={autoBusy || !savedPwd}
              data-testid="button-run-auto-now"
            >
              {autoBusy ? (
                <><Loader2 className="h-3.5 w-3.5 me-2 animate-spin" />{t("backup_exporting")}</>
              ) : (
                <><Download className="h-3.5 w-3.5 me-2" />{tx("Back up now", "نسخ الآن")}</>
              )}
            </Button>
          </div>

          {autoMsg && (
            <div
              className={`flex items-start gap-2 text-[11px] ${
                autoMsg.kind === "ok" ? "text-emerald-500" : "text-destructive"
              }`}
              data-testid="text-auto-msg"
            >
              {autoMsg.kind === "ok" ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              )}
              <span>{autoMsg.text}</span>
            </div>
          )}
        </div>

        {/* ── Restore ────────────────────────── */}
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider">
            <Upload className="h-3.5 w-3.5" /> {t("backup_restore_title")}
          </div>
          <p className="text-[11px] text-muted-foreground">{t("backup_restore_help")}</p>

          <input
            ref={fileRef}
            type="file"
            accept=".rjafbackup,application/octet-stream,text/plain"
            onChange={onPickFile}
            className="hidden"
            data-testid="input-backup-file"
          />
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileRef.current?.click()}
              data-testid="button-pick-backup-file"
            >
              <Upload className="h-3.5 w-3.5 me-2" />{t("backup_pick_file")}
            </Button>
            {(phase.kind === "picked" || phase.kind === "decoded") && (
              <span className="text-[11px] text-muted-foreground font-mono" data-testid="text-picked-backup-file">
                {phase.file.name} · {fmtBytes(phase.file.size)}
              </span>
            )}
          </div>

          {phase.kind === "picked" && (
            <div className="space-y-2 pt-2 border-t border-border/60">
              <Input
                type="password"
                value={restorePwd}
                onChange={e => setRestorePwd(e.target.value)}
                placeholder={t("backup_pwd_placeholder")}
                data-testid="input-restore-password"
                autoComplete="current-password"
              />
              <Button size="sm" onClick={doDecode} disabled={!restorePwd} data-testid="button-decode-backup">
                {t("backup_verify")}
              </Button>
            </div>
          )}

          {phase.kind === "decoding" && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("backup_decoding")}
            </div>
          )}

          {phase.kind === "decoded" && (
            <div className="space-y-2 pt-2 border-t border-border/60 text-xs">
              <div className="rounded-md bg-muted/60 p-2 font-mono leading-relaxed" data-testid="text-backup-summary">
                <div>{t("backup_created")}: {new Date(phase.payload.createdAt).toLocaleString()}</div>
                <div>{t("backup_squadron")}: {phase.payload.squadronId || "—"}</div>
                <div>{t("backup_device")}: {phase.payload.deviceName || "—"}</div>
                <div>
                  {t("backup_contents")}: {phase.payload.mock.pilots.length} pilots, {phase.payload.mock.sorties.length} sorties,{" "}
                  {Object.keys(phase.payload.storage).length} config keys
                </div>
              </div>
              <p className="text-[11px] text-amber-500 flex items-start gap-1">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <span>{t("backup_apply_warn")}</span>
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="destructive" onClick={doApply} data-testid="button-apply-backup">
                  {t("backup_apply_btn")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setPhase({ kind: "idle" })} data-testid="button-cancel-backup">
                  {t("cancel")}
                </Button>
              </div>
            </div>
          )}

          {phase.kind === "applying" && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("backup_applying")}
            </div>
          )}

          {phase.kind === "applied" && (
            <div className="flex items-center gap-2 text-xs text-emerald-500" data-testid="text-backup-applied">
              <CheckCircle2 className="h-3.5 w-3.5" /> {t("backup_applied")}
            </div>
          )}
        </div>

        {phase.kind === "exported" && (
          <div className="flex items-center gap-2 text-xs text-emerald-500" data-testid="text-backup-exported">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {t("backup_exported")}: <span className="font-mono">{phase.filename}</span>
          </div>
        )}

        {phase.kind === "error" && (
          <div className="flex items-start gap-2 text-xs text-destructive" data-testid="text-backup-error">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{phase.message}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
