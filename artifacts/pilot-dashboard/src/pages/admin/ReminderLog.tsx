import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useI18n } from "@/lib/i18n";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { supabase, supabaseConfigured } from "@/lib/supabase";
import {
  fetchInternalReminderLogRows,
  isLanSessionLoginEnabled,
} from "@/lib/internal-migration";
import { fmtDate, fmtDateTime } from "@/lib/format";
import {
  loadReminderSession, saveReminderSession, clearReminderSession,
} from "@/lib/reminder-session";
import {
  ListChecks, ArrowLeft, Search, RefreshCw, AlertTriangle, Lock,
} from "lucide-react";

interface LogRow {
  sent_at: string;
  pilot_id: string;
  pilot_name: string;
  pilot_name_ar: string | null;
  currency_key: string;
  expiry_date: string;
  threshold_days: number;
}

const ADMIN_USERNAME = "admin";

const CURRENCY_LABEL: Record<string, { en: string; ar: string }> = {
  day: { en: "Day", ar: "نهار" },
  night: { en: "Night", ar: "ليل" },
  irt: { en: "IRT", ar: "IRT" },
  medical: { en: "Medical", ar: "طبية" },
  sim: { en: "Simulator", ar: "محاكي" },
};

export default function ReminderLog() {
  const { t, lang } = useI18n();
  const { toast } = useToast();
  const lanMode = isLanSessionLoginEnabled();
  const [hasSession, setHasSession] = useState<boolean>(() => lanMode || !!loadReminderSession());
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [authOpen, setAuthOpen] = useState(false);
  const [pwd, setPwd] = useState("");
  const [code, setCode] = useState("");

  function openAuth() {
    setPwd("");
    setCode("");
    setAuthOpen(true);
  }

  async function loadLog(token: string) {
    if (lanMode) {
      setLoading(true);
      setError(null);
      const rows = await fetchInternalReminderLogRows();
      setLoading(false);
      if (!rows) {
        setError("internal_reminder_log_failed");
        return;
      }
      setRows(rows);
      return;
    }
    if (!supabase) return;
    setLoading(true);
    setError(null);
    const res = await supabase.functions.invoke(
      "manage-reminder-schedule",
      { body: { action: "log", token } }
    );
    setLoading(false);
    if (res.error || !res.data?.ok) {
      const reason = res.data?.error ?? res.error?.message ?? "log_failed";
      if (reason === "bad_token" || reason === "missing_token") {
        clearReminderSession();
        setHasSession(false);
        openAuth();
        return;
      }
      setError(reason);
      return;
    }
    setRows((res.data.log as LogRow[]) ?? []);
  }

  async function refresh() {
    if (lanMode) {
      await loadLog("");
      return;
    }
    if (!supabaseConfigured || !supabase) {
      setError("supabase_not_configured");
      return;
    }
    const session = loadReminderSession();
    if (!session) {
      setHasSession(false);
      openAuth();
      return;
    }
    loadLog(session.token);
  }

  useEffect(() => {
    if (hasSession) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitAuth() {
    if (lanMode) return;
    if (!supabase) return;
    setBusy(true);
    const res = await supabase.functions.invoke("manage-reminder-schedule", {
      body: { action: "session", username: ADMIN_USERNAME, password: pwd, code },
    });
    setBusy(false);
    if (res.error || !res.data?.ok) {
      const reason = res.data?.error ?? res.error?.message ?? "auth_failed";
      toast({
        title: t("authFailed"),
        description: reason === "locked"
          ? t("authLocked")
          : reason === "bad_code"
            ? t("authBadCode")
            : t("authBadCreds"),
        variant: "destructive",
      });
      return;
    }
    saveReminderSession({
      token: res.data.token as string,
      expiresAt: res.data.expiresAt as number,
    });
    setHasSession(true);
    setAuthOpen(false);
    loadLog(res.data.token as string);
  }

  const today = new Date().toISOString().slice(0, 10);
  const todayCount = useMemo(
    () => rows.filter((r) => r.sent_at.slice(0, 10) === today).length,
    [rows, today]
  );

  const filtered = useMemo(() => {
    const s = q.toLowerCase().trim();
    if (!s) return rows;
    return rows.filter(
      (r) =>
        r.pilot_id.toLowerCase().includes(s) ||
        r.pilot_name.toLowerCase().includes(s) ||
        (r.pilot_name_ar ?? "").toLowerCase().includes(s) ||
        r.currency_key.toLowerCase().includes(s)
    );
  }, [rows, q]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <ListChecks className="h-5 w-5" />
          {t("reminderLog")}
        </h2>
        <div className="flex gap-2">
          <Link
            href="/admin/reminders"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card hover-elevate px-3 py-1.5 text-sm"
            data-testid="link-back-schedule"
          >
            <ArrowLeft className="h-4 w-4" />
            {t("backToSchedule")}
          </Link>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={loading || busy}
            data-testid="button-refresh-log"
          >
            <RefreshCw className={`h-4 w-4 me-1 ${loading ? "animate-spin" : ""}`} />
            {t("refresh")}
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">{t("reminderLogHelp")}</p>

      {error ? (
        <Card>
          <CardContent className="p-4 flex items-start gap-2 text-sm">
            <AlertTriangle className="h-4 w-4 text-red-500 mt-0.5" />
            <span data-testid="text-log-error">
              {error === "supabase_not_configured"
                  ? t("scheduleNeedsSupabase")
                : `${t("scheduleStatusError")}: ${error}`}
            </span>
          </CardContent>
        </Card>
      ) : !hasSession ? (
        <Card>
          <CardContent className="p-4 flex flex-wrap items-center gap-3 text-sm">
            <Lock className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1 min-w-0">{t("scheduleAuthRequired")}</span>
            <Button size="sm" onClick={openAuth} data-testid="button-unlock">
              {t("scheduleUnlock")}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative max-w-md flex-1 min-w-[220px]">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("search")}
            className="ps-9"
            data-testid="input-search-log"
          />
        </div>
        <div className="text-xs text-muted-foreground" data-testid="text-today-count">
          {t("notifiedToday")}: <span className="font-medium tabular-nums">{todayCount}</span>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                  <th className="text-start py-2 px-3">{t("sentAt")}</th>
                  <th className="text-start py-2 px-3">{t("pilot")}</th>
                  <th className="text-start py-2 px-3">{t("currencies")}</th>
                  <th className="text-start py-2 px-3">{t("expires")}</th>
                  <th className="text-end py-2 px-3">{t("daysBefore")}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-muted-foreground">
                      {loading ? t("loading") : t("noRemindersSent")}
                    </td>
                  </tr>
                )}
                {filtered.map((r, i) => {
                  const label = CURRENCY_LABEL[r.currency_key];
                  const display =
                    lang === "ar" && r.pilot_name_ar ? r.pilot_name_ar : r.pilot_name;
                  return (
                    <tr
                      key={`${r.pilot_id}-${r.currency_key}-${r.expiry_date}-${r.threshold_days}-${i}`}
                      className="border-b border-border/60"
                      data-testid={`row-log-${i}`}
                    >
                      <td className="py-2 px-3 tabular-nums whitespace-nowrap">
                        {fmtDateTime(r.sent_at, lang)}
                      </td>
                      <td className="py-2 px-3">
                        <div className="font-medium">{display}</div>
                        <div className="text-xs text-muted-foreground font-mono">{r.pilot_id}</div>
                      </td>
                      <td className="py-2 px-3">
                        {label ? (lang === "ar" ? label.ar : label.en) : r.currency_key}
                      </td>
                      <td className="py-2 px-3 tabular-nums whitespace-nowrap">
                        {fmtDate(r.expiry_date, lang)}
                      </td>
                      <td className="py-2 px-3 text-end tabular-nums">{r.threshold_days}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={authOpen} onOpenChange={(o) => !o && setAuthOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("scheduleAuthTitle")}</DialogTitle>
            <DialogDescription>{t("scheduleAuthHelp")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("password")}</label>
              <Input
                type="password"
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                autoComplete="current-password"
                data-testid="input-confirm-password"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("totpCode")}</label>
              <Input
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="123456"
                className="font-mono tracking-widest"
                data-testid="input-confirm-code"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAuthOpen(false)} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button
              onClick={submitAuth}
              disabled={busy || !pwd || code.length !== 6}
              data-testid="button-confirm-submit"
            >
              {busy ? t("loading") : t("scheduleUnlock")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
