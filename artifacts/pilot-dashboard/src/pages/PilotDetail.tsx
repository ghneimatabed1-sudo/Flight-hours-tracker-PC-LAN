import { useEffect, useMemo, useRef, useState } from "react";
import { useRoute, Link } from "wouter";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import {
  usePilots,
  useSorties,
  useUpdatePilot,
  usePilotLinkStatus,
  useIssueLinkCode,
  useRevokePilotDevices,
  useTransferPilot,
  type Pilot,
  type PilotLinkStatus,
} from "@/lib/squadron-data";
import { useDashSquadrons } from "@/lib/dash-pilots";
import type { OtherAircraftEntry } from "@/lib/mock";
import { computePilotTotals } from "@/lib/calculations";
import { useAuth } from "@/lib/auth";
import { canTransferPilot } from "@/lib/pilot-transfer-policy";
import { TransferPilotDialog } from "./Roster";
import {
  ArrowLeft,
  ArrowRightLeft,
  Smartphone,
  KeyRound,
  Copy,
  Check,
  ShieldOff,
  RefreshCw,
  AlertTriangle,
  Eye,
  EyeOff,
} from "lucide-react";

// All five operational currencies (Day, Night, NVG, IRT, Medical) plus Sim
// recency. Each is fully independent — flying Night does NOT refresh NVG and
// vice versa. The hide toggle below sets `hiddenCurrencies` on the pilot so
// non-applicable items (e.g. NVG for a pilot who never flies goggles) render
// as "N/A" everywhere and are excluded from expired/warning counts.
const cats = [
  { k: "day", label: "Day" },
  { k: "night", label: "Night" },
  { k: "nvg", label: "NVG" },
  { k: "irt", label: "IRT" },
  { k: "medical", label: "Medical" },
  // Sim is NOT a currency (no expiry window). The pilot's last simulator
  // date renders as a separate monitoring row below the currency grid so
  // commanders can still see it without it triggering false-red status.
] as const;
type CurrencyKey = typeof cats[number]["k"];

function statusInfo(dateStr: string) {
  const days = Math.floor((+new Date(dateStr) - Date.now()) / 86400000);
  if (days < 0) return { cls: "status-bad", label: `EXPIRED ${-days}d` };
  if (days < 30) return { cls: "status-warn", label: `${days}d` };
  return { cls: "status-ok", label: `${days}d` };
}

export default function PilotDetail() {
  const { t, rankOf } = useI18n();
  const [, params] = useRoute<{ id: string }>("/pilot/:id");
  const { data: PILOTS } = usePilots();
  const { data: SORTIES } = useSorties();
  const { user } = useAuth();
  const transferPilot = useTransferPilot();
  const allSquadrons = useDashSquadrons();
  const [transferring, setTransferring] = useState(false);
  const [transferErr, setTransferErr] = useState("");
  const p = PILOTS.find(x => x.id === params?.id);
  const totals = useMemo(
    () => (p ? computePilotTotals(p, SORTIES) : null),
    [p, SORTIES],
  );
  if (!p || !totals) return <div className="p-6">Pilot not found.</div>;
  const sorties = SORTIES.filter(s => s.pilotId === p.id || s.coPilotId === p.id).sort((a, b) => b.date.localeCompare(a.date));

  // Same gate as Roster.tsx — sourced from the shared
  // pilot-transfer-policy module so the regression test in
  // supabase/tests/test-pilot-transfer-rpc.ts catches drift.
  const canTransfer = canTransferPilot(user);
  const currentSquadronId = user?.squadronIds?.[0];
  const actor = user?.username;

  const onTransfer = async (toSquadronId: string) => {
    setTransferErr("");
    try {
      await transferPilot.mutateAsync({
        pilotId: p.id,
        toSquadronId,
        pilotName: p.name,
        fromSquadronId: currentSquadronId,
        actor,
      });
      setTransferring(false);
    } catch (e) {
      setTransferErr((e as Error).message || "Transfer failed");
    }
  };

  return (
    <div>
      <PageHead title={`${rankOf(p)} ${p.name}`} subtitle={`${p.arabicName} · ${t("militaryNumber")}: ${p.militaryNumber || p.id} · ${p.unit}`} actions={
        <div className="flex items-center gap-2">
          {canTransfer && (
            <button
              onClick={() => { setTransferErr(""); setTransferring(true); }}
              className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-secondary inline-flex items-center gap-1"
              data-testid="button-transfer-pilot-detail"
            >
              <ArrowRightLeft className="h-3.5 w-3.5" />
              Transfer
            </button>
          )}
          <Link href="/roster" className="text-xs px-3 py-1.5 rounded-md border border-border hover:bg-secondary inline-flex items-center gap-1"><ArrowLeft className="h-3.5 w-3.5" />Back</Link>
        </div>
      } />

      {transferErr && (
        <div className="mb-3 px-3 py-2 rounded-md bg-rose-500/15 border border-rose-500/40 text-xs text-rose-200" data-testid="text-transfer-error">
          {transferErr}
        </div>
      )}
      {transferring && (
        <TransferPilotDialog
          pilot={p}
          fromSquadronId={currentSquadronId}
          squadrons={allSquadrons}
          onCancel={() => setTransferring(false)}
          onConfirm={onTransfer}
          busy={transferPilot.isPending}
        />
      )}

      {/* System ID — used to identify the pilot when revoking their mobile
          device link. Surfaced here so the operator can copy it without
          digging through the database or guessing from the URL. */}
      <PilotIdBadge pilotId={p.id} />

      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <Card>
          <div className="text-sm font-semibold mb-2">This Month</div>
          <Stat k="Day" v={totals.monthDay} /><Stat k="Night" v={totals.monthNight} /><Stat k="NVG" v={totals.monthNvg} accent="text-rose-300" /><Stat k="Sim" v={totals.monthSim} /><Stat k="Captain" v={totals.monthCaptain} />
        </Card>
        <Card>
          <div className="text-sm font-semibold mb-2">Grand Totals</div>
          <Stat k="Day" v={totals.totalDay} /><Stat k="Night" v={totals.totalNight} /><Stat k="NVG" v={totals.totalNvg} accent="text-rose-300" /><Stat k="Sim" v={totals.totalSim} /><Stat k="Captain" v={totals.totalCaptain} /><Stat k="Instrument" v={p.initialHours?.instrument ?? 0} />
        </Card>
        <CurrenciesCard pilot={p} />
      </div>

      {/* Half-cycle (H1 Jan–Jun / H2 Jul–Dec) breakdown for the current
          calendar year. Excludes opening balance — only counts sorties flown
          this year so the squadron commander can see training load by half
          at a glance. NVG is its own column, never folded into Night. */}
      <Card className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold">H1 / H2 Hours · {new Date().getFullYear()}</div>
          <div className="text-[11px] text-muted-foreground">H1 Jan–Jun · H2 Jul–Dec · NVG separate from Night</div>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <HalfCard label="H1 (Jan–Jun)" h={totals.h1} />
          <HalfCard label="H2 (Jul–Dec)" h={totals.h2} />
        </div>
        <div className="mt-3 pt-3 border-t border-border flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Year total (Day + Night)</span>
          <span className="font-mono font-semibold text-primary">{totals.yearHours.toFixed(1)} hrs</span>
        </div>
      </Card>

      <MobileAccessCard pilotId={p.id} />

      <OtherAircraftCard pilot={p} />

      <Card className="!p-0 overflow-hidden">
        <div className="px-4 py-2 border-b border-border text-sm font-semibold">Sortie History ({sorties.length})</div>
        <div className="overflow-x-auto max-h-[60vh]">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 text-xs uppercase tracking-wider text-muted-foreground sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left">{t("date")}</th>
                <th className="px-3 py-2 text-left">A/C</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-right">Day</th>
                <th className="px-3 py-2 text-right">Night</th>
                <th className="px-3 py-2 text-right text-rose-300">NVG</th>
                <th className="px-3 py-2 text-right">Actual</th>
              </tr>
            </thead>
            <tbody>
              {sorties.map(s => (
                <tr key={s.id} className="border-t border-border row-hover">
                  <td className="px-3 py-2 font-mono">{s.date}</td>
                  <td className="px-3 py-2">{s.acType} <span className="text-muted-foreground">#{s.acNumber}</span></td>
                  <td className="px-3 py-2">{s.sortieType}</td>
                  <td className="px-3 py-2">{s.name}</td>
                  <td className="px-3 py-2 text-right font-mono">{(s.day1 + s.day2 + s.dayDual).toFixed(1)}</td>
                  <td className="px-3 py-2 text-right font-mono">{(s.night1 + s.night2 + s.nightDual).toFixed(1)}</td>
                  <td className="px-3 py-2 text-right font-mono text-rose-300">{s.nvg || "—"}</td>
                  <td className="px-3 py-2 text-right font-mono">{s.actual}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function CurrenciesCard({ pilot }: { pilot: Pilot }) {
  const { t, rankOf } = useI18n();
  const update = useUpdatePilot();
  const hidden = pilot.hiddenCurrencies ?? [];

  function toggle(k: CurrencyKey) {
    const set = new Set(hidden);
    if (set.has(k)) set.delete(k); else set.add(k);
    const next = Array.from(set) as CurrencyKey[];
    update.mutate({ ...pilot, hiddenCurrencies: next.length ? next : undefined });
  }

  const anyHidden = hidden.length > 0;

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm font-semibold">Currencies</div>
        {anyHidden ? (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-secondary border border-border text-muted-foreground">
            {hidden.length} {t("currencyHiddenBadge")}
          </span>
        ) : null}
      </div>
      {/* Last simulator session — monitoring row, no expiry status. Visible
          to every commander tier so monitoring roles can see recency.
          Sim has no currency window; see `.local/memory/currency-refresh.md`. */}
      <div className="flex items-center justify-between py-1.5 border-b border-border text-sm" data-testid="row-last-sim">
        <span>Last Simulator</span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{pilot.lastSimDate || "—"}</span>
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-secondary border border-border text-muted-foreground">
            monitor
          </span>
        </div>
      </div>
      {cats.map(c => {
        const isHidden = hidden.includes(c.k);
        const s = isHidden ? null : statusInfo(pilot.expiry[c.k]);
        return (
          <div key={c.k} className={`flex items-center justify-between py-1.5 border-b border-border last:border-b-0 text-sm ${isHidden ? "opacity-60" : ""}`}>
            <span>{c.label}</span>
            <div className="flex items-center gap-2">
              {isHidden ? (
                <span className="text-xs px-2 py-0.5 rounded bg-secondary border border-border text-muted-foreground">{t("notApplicable")}</span>
              ) : (
                <>
                  <span className="font-mono text-xs text-muted-foreground">{pilot.expiry[c.k]}</span>
                  <span className={`status-dot ${s!.cls}`}></span>
                  <span className="text-xs w-20 text-right">{s!.label}</span>
                </>
              )}
              <button
                onClick={() => toggle(c.k)}
                title={isHidden ? t("currencyShow") : t("currencyHide")}
                aria-label={isHidden ? t("currencyShow") : t("currencyHide")}
                className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
                data-testid={`button-toggle-currency-${c.k}`}
              >
                {isHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
        );
      })}
      {anyHidden ? (
        <p className="text-[11px] text-muted-foreground mt-2 leading-snug">{t("currencyHiddenHint")}</p>
      ) : null}
    </Card>
  );
}

function HalfCard({ label, h }: { label: string; h: import("@/lib/calculations").HalfYearBreakdown }) {
  return (
    <div className="rounded-md border border-border bg-secondary/20 p-3">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">{label} · {h.sorties} sortie{h.sorties === 1 ? "" : "s"}</div>
      <div className="grid grid-cols-2 gap-x-3 text-sm">
        <Stat k="Day" v={h.day} />
        <Stat k="Night" v={h.night} />
        <Stat k="NVG" v={h.nvg} accent="text-rose-300" />
        <Stat k="Sim" v={h.sim} />
        <Stat k="Captain" v={h.captain} />
        <Stat k="Total (D+N)" v={h.total} accent="font-semibold" />
      </div>
    </div>
  );
}

function Stat({ k, v, accent = "" }: { k: string; v: number; accent?: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border last:border-b-0 text-sm">
      <span className="text-muted-foreground">{k}</span>
      <span className={`font-mono ${accent}`}>{v}</span>
    </div>
  );
}

function fmtDateTime(iso: string | null | undefined) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return iso; }
}

function statusBadge(t: ReturnType<typeof useI18n>["t"], status: PilotLinkStatus): { label: string; cls: string } {
  if (status.device && status.device.revokedAt === null) return { label: t("mobileStatusLinked"), cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" };
  if (status.device && status.device.revokedAt !== null) return { label: t("mobileStatusRevoked"), cls: "bg-rose-500/15 text-rose-300 border-rose-500/30" };
  return { label: t("mobileStatusNotLinked"), cls: "bg-secondary text-muted-foreground border-border" };
}

function MobileAccessCard({ pilotId }: { pilotId: string }) {
  const { t, rankOf } = useI18n();
  const { user } = useAuth();
  const issue = useIssueLinkCode();
  const revoke = useRevokePilotDevices();
  const [code, setCode] = useState<string | null>(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [revokedNotice, setRevokedNotice] = useState(false);

  // Clear all transient state when the user navigates to a different pilot —
  // never leak a previous pilot's one-time code onto a different page.
  useEffect(() => {
    setCode(null);
    setCodeExpiresAt(null);
    setCopied(false);
    setError(null);
    setRevokedNotice(false);
  }, [pilotId]);

  // While a code is showing, poll status every 5s so we can auto-clear the
  // displayed code as soon as the pilot consumes it on the mobile app
  // (the server marks pilot_link_codes.consumed_at, which removes the row
  //  from our pendingCode query).
  const statusQ = usePilotLinkStatus(pilotId);
  useEffect(() => {
    if (!code) return;
    const id = setInterval(() => statusQ.refetch(), 5000);
    return () => clearInterval(id);
  }, [code, statusQ]);

  useEffect(() => {
    if (!codeExpiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [codeExpiresAt]);

  // Auto-clear the displayed code once the server reports it was consumed.
  // We only flip from "showing" to "cleared" once we've actually observed the
  // pendingCode in the server's status (avoids racing the post-issue refetch:
  // the local `code` is set immediately, but status may briefly still be the
  // pre-issue snapshot with pendingCode === null).
  const sawPendingForLocalCode = useRef(false);
  useEffect(() => {
    if (!code) { sawPendingForLocalCode.current = false; return; }
    if (statusQ.data?.pendingCode) {
      sawPendingForLocalCode.current = true;
    } else if (sawPendingForLocalCode.current && statusQ.data && statusQ.data.pendingCode === null) {
      setCode(null);
      setCodeExpiresAt(null);
      sawPendingForLocalCode.current = false;
    }
  }, [code, statusQ.data]);

  const remainingMs = codeExpiresAt ? Math.max(0, +new Date(codeExpiresAt) - now) : 0;
  const expired = Boolean(codeExpiresAt) && remainingMs <= 0;
  const remainingLabel = useMemo(() => {
    const s = Math.ceil(remainingMs / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  }, [remainingMs]);

  const status: PilotLinkStatus = statusQ.data ?? { device: null, pendingCode: null };
  const badge = statusBadge(t, status);

  async function onIssue() {
    setError(null);
    setCopied(false);
    setRevokedNotice(false);
    try {
      const res = await issue.mutateAsync({ pilotId, actor: user?.username });
      setCode(res.code);
      setCodeExpiresAt(res.expiresAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onRevoke() {
    if (!window.confirm(t("mobileRevokeConfirm"))) return;
    setError(null);
    setCode(null);
    setCodeExpiresAt(null);
    try {
      await revoke.mutateAsync({ pilotId, actor: user?.username });
      setRevokedNotice(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function onCopy() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // ignore — clipboard may be blocked
    }
  }

  const hasActiveDevice = status.device && status.device.revokedAt === null;

  return (
    <Card className="mb-4 space-y-3" data-testid="card-mobile-access">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-md bg-secondary border border-border flex items-center justify-center shrink-0">
            <Smartphone className="h-5 w-5 text-primary" />
          </div>
          <div>
            <div className="text-sm font-semibold gold-grad">{t("mobileAccess")}</div>
            <p className="text-xs text-muted-foreground max-w-md">{t("mobileLinkBlurb")}</p>
          </div>
        </div>
        <span className={`text-[11px] uppercase tracking-wider font-semibold px-2 py-1 rounded border ${badge.cls}`} data-testid="badge-mobile-status">{badge.label}</span>
      </div>

      <div className="grid sm:grid-cols-2 gap-2 text-xs">
        <Field label={t("mobileLinkedAt")} value={status.device ? fmtDateTime(status.device.linkedAt) : t("mobileNever")} />
        <Field label={t("mobileLastSeen")} value={status.device ? fmtDateTime(status.device.lastSeenAt) : t("mobileNever")} />
      </div>

      {status.pendingCode && !code ? (
        <div className="flex items-center gap-2 text-xs text-amber-300/90 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>{t("mobilePendingCode")}</span>
        </div>
      ) : null}

      {code ? (
        <div className="space-y-2 rounded-md border border-primary/40 bg-primary/5 p-3">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">{t("mobileCodeReady")}</div>
          <div className="flex items-center gap-2">
            <div className="font-mono text-3xl tracking-[0.4em] font-bold text-primary px-3 py-2 bg-background/60 rounded select-all" data-testid="text-mobile-code">{code}</div>
            <button
              onClick={onCopy}
              className="px-3 py-2 rounded-md text-sm bg-secondary border border-border inline-flex items-center gap-1.5 hover:bg-secondary/70"
              data-testid="button-copy-code"
            >
              {copied ? <><Check className="h-3.5 w-3.5 text-emerald-400" />{t("mobileCopied")}</> : <><Copy className="h-3.5 w-3.5" />{t("mobileCopy")}</>}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">{t("mobileCodeHint")}</p>
          <div className="text-xs">
            {expired
              ? <span className="text-rose-300">{t("mobileCodeExpired")}</span>
              : <span className="text-muted-foreground">{t("mobileCodeExpiresIn")} <span className="font-mono text-foreground">{remainingLabel}</span></span>}
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="text-xs text-rose-300 bg-rose-500/10 border border-rose-500/30 rounded-md px-3 py-2" data-testid="text-mobile-error">{error}</div>
      ) : null}
      {revokedNotice ? (
        <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-md px-3 py-2" data-testid="text-revoked-notice">{t("mobileRevoked")}</div>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          onClick={onIssue}
          disabled={issue.isPending}
          className="px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground font-medium inline-flex items-center gap-1.5 disabled:opacity-60"
          data-testid="button-generate-code"
        >
          {code ? <RefreshCw className="h-3.5 w-3.5" /> : <KeyRound className="h-3.5 w-3.5" />}
          {issue.isPending ? t("mobileGenerating") : (code ? t("mobileRegenerate") : t("mobileGenerateCode"))}
        </button>
        <button
          onClick={onRevoke}
          disabled={revoke.isPending || !hasActiveDevice}
          className="px-3 py-1.5 rounded-md text-sm bg-destructive/20 text-destructive border border-destructive/40 inline-flex items-center gap-1.5 disabled:opacity-50"
          data-testid="button-revoke-device"
        >
          <ShieldOff className="h-3.5 w-3.5" />
          {revoke.isPending ? t("mobileRevoking") : t("mobileRevoke")}
        </button>
      </div>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-secondary/40 border border-border rounded-md px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</div>
      <div className="text-sm font-mono mt-0.5">{value}</div>
    </div>
  );
}

// Compact, copyable badge that surfaces the pilot's system ID. The ID is
// the value the operator types into the Admin → Pilots → Revoke flow when
// invalidating a stolen / lost mobile device, so it has to be visible on
// the pilot's individual page (not just buried in URLs or DB rows).
function PilotIdBadge({ pilotId }: { pilotId: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(pilotId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked — no-op */ }
  };
  return (
    <div className="mb-4 flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
        Pilot ID
      </span>
      <code
        data-testid="text-pilot-id"
        className="flex-1 font-mono text-sm tracking-wide text-foreground break-all select-all"
      >
        {pilotId}
      </code>
      <button
        type="button"
        data-testid="button-copy-pilot-id"
        onClick={onCopy}
        title="Copy ID"
        className="text-[11px] px-2 py-1 rounded-md border border-border hover:bg-secondary inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

// Other-aircraft experience editor. Lets the ops officer record airframes
// the pilot has flown outside this squadron's primary type (e.g. UH-1H,
// AH-1F) along with total hours and a free-form note. Stored on the pilot
// record as `otherAircraft: { type, hours, notes }[]` and persisted via
// useUpdatePilot. Read-only for any role that can't edit pilots — the
// underlying mutation already enforces that, we just hide the controls.
function OtherAircraftCard({ pilot }: { pilot: Pilot }) {
  const update = useUpdatePilot();
  const auth = useAuth();
  const canEdit = auth.user?.role === "ops" || auth.user?.role === "admin" || auth.user?.role === "super_admin";
  const list: OtherAircraftEntry[] = pilot.otherAircraft ?? [];
  const [draft, setDraft] = useState<OtherAircraftEntry>({ type: "", hours: undefined, notes: "" });

  const save = (next: OtherAircraftEntry[]) => {
    update.mutate({ ...pilot, otherAircraft: next });
  };

  const add = () => {
    if (!draft.type.trim()) return;
    save([...list, { type: draft.type.trim(), hours: draft.hours, notes: draft.notes?.trim() || undefined }]);
    setDraft({ type: "", hours: undefined, notes: "" });
  };
  const remove = (i: number) => {
    save(list.filter((_, idx) => idx !== i));
  };

  return (
    <Card className="!p-4">
      <div className="text-sm font-semibold mb-2">Other-Aircraft Experience</div>
      {list.length === 0 ? (
        <div className="text-xs text-muted-foreground" data-testid="empty-other-aircraft">
          No other-aircraft experience recorded.
        </div>
      ) : (
        <table className="w-full text-sm" data-testid="table-other-aircraft">
          <thead className="text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left py-1">Type</th>
              <th className="text-left py-1">Hours</th>
              <th className="text-left py-1">Notes</th>
              {canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {list.map((e, i) => (
              <tr key={`${e.type}-${i}`} className="border-t border-border">
                <td className="py-1 font-medium">{e.type}</td>
                <td className="py-1 font-mono">{e.hours ?? "—"}</td>
                <td className="py-1 text-muted-foreground">{e.notes ?? "—"}</td>
                {canEdit && (
                  <td className="py-1 text-right">
                    <button
                      onClick={() => remove(i)}
                      className="text-xs text-destructive hover:underline"
                      data-testid={`button-remove-other-ac-${i}`}
                    >
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-end gap-2 mt-3 pt-3 border-t border-border">
          <label className="text-xs text-muted-foreground flex flex-col">
            <span>Type</span>
            <input
              value={draft.type}
              onChange={e => setDraft(d => ({ ...d, type: e.target.value }))}
              placeholder="e.g. UH-1H"
              className="mt-0.5 px-2 py-1.5 rounded-md bg-input border border-border text-sm w-40"
              data-testid="input-other-ac-type"
            />
          </label>
          <label className="text-xs text-muted-foreground flex flex-col">
            <span>Hours</span>
            <input
              type="number"
              min={0}
              step="0.1"
              value={draft.hours ?? ""}
              onChange={e => setDraft(d => ({ ...d, hours: e.target.value === "" ? undefined : Number(e.target.value) }))}
              className="mt-0.5 px-2 py-1.5 rounded-md bg-input border border-border text-sm w-24 font-mono"
              data-testid="input-other-ac-hours"
            />
          </label>
          <label className="text-xs text-muted-foreground flex flex-col flex-1 min-w-[160px]">
            <span>Notes</span>
            <input
              value={draft.notes ?? ""}
              onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))}
              placeholder="Optional"
              className="mt-0.5 px-2 py-1.5 rounded-md bg-input border border-border text-sm"
              data-testid="input-other-ac-notes"
            />
          </label>
          <button
            onClick={add}
            disabled={!draft.type.trim() || update.isPending}
            className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50"
            data-testid="button-add-other-ac"
          >
            Add
          </button>
        </div>
      )}
    </Card>
  );
}
