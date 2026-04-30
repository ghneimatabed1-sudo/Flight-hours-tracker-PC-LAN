import { useState } from "react";
import { useAuth, RECOVERY_CODES_LOW_THRESHOLD } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { AlertTriangle, Copy, Download, KeyRound } from "lucide-react";

export function RecoveryCodesLowBanner() {
  const { user, adminRecoveryCodesRemaining, regenerateAdminRecoveryCodes } = useAuth();
  const { t, dir } = useI18n();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuedCodes, setIssuedCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  if (
    !user ||
    user.role !== "super_admin" ||
    adminRecoveryCodesRemaining === null ||
    adminRecoveryCodesRemaining > RECOVERY_CODES_LOW_THRESHOLD
  ) {
    return null;
  }

  const remaining = adminRecoveryCodesRemaining;
  const body =
    remaining <= 0
      ? t("recoveryLowBodyNone")
      : remaining === 1
        ? t("recoveryLowBodyOne").replace("{n}", "1")
        : t("recoveryLowBodyMany").replace("{n}", String(remaining));

  const reset = () => {
    setCode("");
    setError(null);
    setIssuedCodes(null);
    setBusy(false);
    setCopied(false);
  };

  const onSubmit = async () => {
    setBusy(true);
    setError(null);
    const res = await regenerateAdminRecoveryCodes(code);
    setBusy(false);
    if (!res.ok) {
      setError(res.error === "locked" ? t("recoveryRegenerateLocked") : t("recoveryRegenerateBad"));
      return;
    }
    setIssuedCodes(res.recoveryCodes ?? []);
  };

  const onCopy = async () => {
    if (!issuedCodes) return;
    await navigator.clipboard.writeText(issuedCodes.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const onDownload = () => {
    if (!issuedCodes) return;
    const header =
      "RJAF Pilot Dashboard — Super Admin recovery codes\n" +
      "Generated: " + new Date().toISOString() + "\n" +
      "Each code may be used only once.\n\n";
    const blob = new Blob([header + issuedCodes.join("\n") + "\n"], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "rjaf-admin-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const onClose = (next: boolean) => {
    setOpen(next);
    if (!next) reset();
  };

  return (
    <>
      <Alert
        variant="destructive"
        className="no-print"
        data-testid="banner-recovery-codes-low"
      >
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>{t("recoveryLowTitle")}</AlertTitle>
        <AlertDescription className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <span>{body}</span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setOpen(true)}
            data-testid="button-regenerate-recovery-codes"
          >
            <KeyRound className="h-3.5 w-3.5 me-1" />
            {t("recoveryRegenerate")}
          </Button>
        </AlertDescription>
      </Alert>

      <Dialog open={open} onOpenChange={onClose}>
        <DialogContent dir={dir} data-testid="dialog-regenerate-recovery">
          <DialogHeader>
            <DialogTitle>{t("recoveryRegenerateTitle")}</DialogTitle>
            <DialogDescription>{t("recoveryRegenerateHint")}</DialogDescription>
          </DialogHeader>

          {!issuedCodes ? (
            <div className="space-y-3">
              <Input
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                className="tracking-[0.4em] text-center text-lg"
                data-testid="input-regenerate-totp"
              />
              {error && (
                <p className="text-xs text-destructive" data-testid="text-regenerate-error">
                  {error}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">{t("recoveryCodesHint")}</p>
              <div
                className="rounded border border-border bg-muted/40 p-3 font-mono text-sm tabular-nums"
                data-testid="list-new-recovery-codes"
              >
                {issuedCodes.map((c, i) => (
                  <div key={i} className="py-0.5" data-testid={`text-new-recovery-code-${i}`}>
                    {c}
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                {t("recoveryCodesWarn")}
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onCopy}
                  data-testid="button-copy-new-recovery-codes"
                >
                  <Copy className="h-3.5 w-3.5 me-1" />
                  {copied ? t("copied") : t("copy")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onDownload}
                  data-testid="button-download-new-recovery-codes"
                >
                  <Download className="h-3.5 w-3.5 me-1" />
                  {t("download")}
                </Button>
              </div>
            </div>
          )}

          <DialogFooter>
            {!issuedCodes ? (
              <>
                <Button variant="ghost" onClick={() => onClose(false)} data-testid="button-cancel-regenerate">
                  {t("cancel")}
                </Button>
                <Button
                  onClick={onSubmit}
                  disabled={busy || code.length !== 6}
                  data-testid="button-confirm-regenerate"
                >
                  {t("recoveryRegenerateConfirm")}
                </Button>
              </>
            ) : (
              <Button onClick={() => onClose(false)} data-testid="button-ack-new-recovery-codes">
                {t("recoveryCodesAck")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
