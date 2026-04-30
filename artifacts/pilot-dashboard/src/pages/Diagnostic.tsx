import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, PageHead } from "@/components/Layout";
import { useAuth } from "@/lib/auth";
import {
  registerLocalPC,
  getLocalPcId,
  getDeviceSuffix,
  getHeartbeatStatus,
  subscribeHeartbeatStatus,
  type PcTier,
} from "@/lib/cross-pc";
import { supabase, supabaseConfigured } from "@/lib/supabase";
import {
  fetchInternalApiHealth,
  fetchInternalXpcRegistryRows,
  getInternalApiHealthUrl,
  isLanSessionLoginEnabled,
} from "@/lib/internal-migration";

// Diagnostic-specific online/offline threshold. Wider than the
// ACTIVE_WINDOW_MS used by the picker queries (90 s — chosen to keep
// recipient pickers tight) because the diagnostic page exists to
// answer "which PCs do you SEE on the backend right now, online or
// not", and a PC that just slept for 100 s is still very much
// installed and connected. The task spec calls for ~2 minutes.
const DIAG_ONLINE_MS = 120_000;
// Anything older than this is treated as long-decommissioned and is
// hidden from the diagnostic table (matches the cross-pc.ts prune
// horizon — those rows are days/weeks stale and would otherwise
// dominate the table on long-lived deployments).
const DIAG_INCLUDE_MS = 7 * 24 * 60 * 60 * 1000;
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Wifi,
  WifiOff,
  Server,
  Cpu,
  Users,
  Globe,
  Network,
} from "lucide-react";

// The diagnostic page reaches into a couple of things that don't have
// dedicated public helpers — the Supabase project URL (so the operator
// can confirm two PCs are talking to the same backend) and the optional
// expected-host build constant (so we can flag a mismatch loudly when
// someone ships an installer wired to the wrong project).
// `import.meta.env` is a Vite-only construct; guard it so the page can
// also be imported from a plain Node test runner (sidebar smoke test)
// without throwing during module evaluation.
const __viteEnv: Record<string, string | undefined> =
  typeof import.meta !== "undefined" && (import.meta as { env?: Record<string, string | undefined> }).env
    ? ((import.meta as { env: Record<string, string | undefined> }).env)
    : {};
const SUPABASE_URL = __viteEnv.VITE_SUPABASE_URL ?? "";
const EXPECTED_SUPABASE_HOST = __viteEnv.VITE_EXPECTED_SUPABASE_HOST ?? "";

function urlHost(u: string): string {
  if (!u) return "";
  try { return new URL(u).host; } catch { return u; }
}

interface DiagnosticPC {
  id: string;
  squadronName: string;
  tier: PcTier;
  base?: string;
  wing?: string;
  deviceName?: string;
  lastSeen: string;
  isSelf: boolean;
}

// Diagnostic-specific registry fetcher. Bypasses useRegisteredPCs()
// because that helper hard-filters server-side to last_seen >=
// ACTIVE_WINDOW_MS — perfect for picker UIs (where you only want PCs
// that can act on a request right now), totally wrong for the
// diagnostic page (where you want to SEE the offline PCs precisely so
// you can troubleshoot why they fell off). We pull every recent row
// from xpc_registry and compute online/offline client-side against
// DIAG_ONLINE_MS so the operator sees the full backend picture and
// can adjust the threshold here without touching shared helpers.
function useDiagnosticRegistry() {
  return useQuery<DiagnosticPC[]>({
    queryKey: ["xpc", "registry", "diagnostic"],
    queryFn: async () => {
      if (isLanSessionLoginEnabled()) {
        const staleHours = Math.max(1, Math.ceil(DIAG_INCLUDE_MS / (60 * 60 * 1000)));
        const data = await fetchInternalXpcRegistryRows({
          includeStale: true,
          staleHours,
        });
        if (!data) return [];
        const me = getLocalPcId();
        const cutoffMs = Date.now() - DIAG_INCLUDE_MS;
        return data
          .filter((r) => !!r.id && !String(r.id).startsWith("TEST_DEMO:"))
          .map((r): DiagnosticPC => ({
            id: String(r.id),
            squadronName: String(r.squadron_name ?? ""),
            tier: String(r.id).startsWith("FLIGHT:")
              ? "flight"
              : ((r.tier as PcTier) ?? "squadron"),
            base: r.base ? String(r.base) : undefined,
            wing: r.wing ? String(r.wing) : undefined,
            deviceName: r.device_name ? String(r.device_name) : undefined,
            lastSeen: String(r.last_seen ?? new Date(0).toISOString()),
            isSelf: String(r.id) === me,
          }))
          .filter((r) => new Date(r.lastSeen).getTime() >= cutoffMs);
      }
      if (!supabaseConfigured || !supabase) return [];
      const cutoffIso = new Date(Date.now() - DIAG_INCLUDE_MS).toISOString();
      const { data, error } = await supabase
        .from("xpc_registry")
        .select("id, squadron_name, tier, base, wing, device_name, last_seen")
        .gte("last_seen", cutoffIso)
        .order("last_seen", { ascending: false })
        .limit(5000);
      if (error) throw error;
      const me = getLocalPcId();
      return (data ?? [])
        .filter((r: { id: string | null }) => r.id && !String(r.id).startsWith("TEST_DEMO:"))
        .map((r: Record<string, unknown>): DiagnosticPC => ({
          id: String(r.id),
          squadronName: String(r.squadron_name ?? ""),
          tier: (r.tier as PcTier) ?? "squadron",
          base: r.base ? String(r.base) : undefined,
          wing: r.wing ? String(r.wing) : undefined,
          deviceName: r.device_name ? String(r.device_name) : undefined,
          lastSeen: String(r.last_seen ?? new Date(0).toISOString()),
          isSelf: String(r.id) === me,
        }));
    },
    refetchInterval: 5_000,
    staleTime: 2_000,
    retry: 1,
  });
}

const SESSION_CHANNEL = "rjaf.session.collision";
interface SessionPing {
  kind: "ping" | "pong";
  pcId: string;
  sessionUserId: string;
  at: number;
}

// Browser-session collision card — listens on the same BroadcastChannel
// the global banner uses (see App.tsx) and renders the live list of
// other tabs in this browser plus any identity collision.
function BrowserSessionCard({
  myPcId,
  mySessionUserId,
}: {
  myPcId: string;
  mySessionUserId: string;
}) {
  const [peers, setPeers] = useState<SessionPing[]>([]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(SESSION_CHANNEL);
    const seen = new Map<string, SessionPing>();
    const flush = () => setPeers(Array.from(seen.values()));
    ch.onmessage = (ev: MessageEvent<SessionPing>) => {
      const p = ev.data;
      if (!p || !p.pcId || p.pcId === myPcId) return;
      seen.set(p.pcId, p);
      flush();
      if (p.kind === "ping") {
        ch.postMessage({
          kind: "pong",
          pcId: myPcId,
          sessionUserId: mySessionUserId,
          at: Date.now(),
        } satisfies SessionPing);
      }
    };
    // Probe twice — once on mount, once 300 ms later — so a tab that
    // opened just after this one still answers.
    const ping = () => ch.postMessage({
      kind: "ping",
      pcId: myPcId,
      sessionUserId: mySessionUserId,
      at: Date.now(),
    } satisfies SessionPing);
    ping();
    const t = window.setTimeout(ping, 300);
    // Re-prune anything we haven't heard from in 30 s so closed tabs
    // disappear from the list.
    const prune = window.setInterval(() => {
      const cutoff = Date.now() - 30_000;
      let changed = false;
      for (const [k, v] of seen) {
        if (v.at < cutoff) { seen.delete(k); changed = true; }
      }
      if (changed) flush();
    }, 5_000);
    return () => {
      window.clearTimeout(t);
      window.clearInterval(prune);
      ch.close();
    };
  }, [myPcId, mySessionUserId]);

  const collisions = peers.filter(
    p => p.sessionUserId && p.sessionUserId !== mySessionUserId
  );

  return (
    <Card className="space-y-3">
      <div className="flex items-center gap-2">
        <Cpu className="h-4 w-4 text-primary" />
        <div className="text-sm font-semibold">Browser session check</div>
      </div>
      {collisions.length > 0 ? (
        <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-xs text-amber-100 space-y-1.5">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" /> Multiple sign-ins detected in this browser
          </div>
          <p>
            Another tab in this browser is signed in as a different user. Tabs in the same
            browser share storage, so the two sign-ins overwrite each other and the
            "second" PC will silently flip to whichever account signed in last.
          </p>
          <p>
            <span className="font-semibold">Fix:</span> close the other tab and use a
            separate browser profile (Chrome → "Add" → new profile) or a different
            browser (Edge / Firefox) for the second role.
          </p>
          <ul className="list-disc ms-4">
            {collisions.map(c => (
              <li key={c.pcId} className="font-mono break-all">
                {c.pcId} <span className="opacity-70">({c.sessionUserId.slice(0, 8)}…)</span>
              </li>
            ))}
          </ul>
        </div>
      ) : peers.length > 0 ? (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-200 space-y-1.5">
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="h-4 w-4" /> Other tab on the same identity
          </div>
          <p>
            Another tab in this browser is open with the same signed-in user. That's
            fine — it's the same PC, two views.
          </p>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">
          No other Hawk Eye tab detected in this browser. Good — this PC has the browser
          to itself.
        </div>
      )}
    </Card>
  );
}

interface PerPcCheck {
  id: string;
  tier: PcTier;
  label: string;
  lastSeen: string;
  ageMs: number;
  online: boolean;
  status: "online" | "stale" | "offline";
}
interface VerifyResult {
  ok: boolean;
  ms?: number;
  error?: string;
  rowSeen?: boolean;
  rowLastSeen?: string;
  peerChecks?: PerPcCheck[];
}

function tierRoleLabel(tier: PcTier, isSelf: boolean): string {
  switch (tier) {
    case "squadron": return isSelf ? "Squadron Ops PC" : "Squadron";
    case "flight":   return "Flight Cmdr";
    case "wing":     return "Wing Cmdr";
    case "base":     return "Base Cmdr";
    case "hq":       return "HQ";
    default:         return tier;
  }
}

export default function DiagnosticPage() {
  const { user, squadron, fingerprint } = useAuth();
  const lanMode = isLanSessionLoginEnabled();
  const pcsQ = useDiagnosticRegistry();
  const [now, setNow] = useState(Date.now());
  const [hb, setHb] = useState(getHeartbeatStatus());
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult | null>(null);
  const [internalApi, setInternalApi] = useState<{
    loading: boolean;
    result: Awaited<ReturnType<typeof fetchInternalApiHealth>> | null;
  }>({ loading: false, result: null });

  const runInternalApiCheck = useCallback(() => {
    if (!getInternalApiHealthUrl()) {
      setInternalApi({ loading: false, result: null });
      return;
    }
    setInternalApi(prev => ({ ...prev, loading: true }));
    void fetchInternalApiHealth().then((result) => {
      setInternalApi({ loading: false, result });
    });
  }, []);
  useEffect(() => {
    runInternalApiCheck();
  }, [runInternalApiCheck]);

  // Re-render every 5 s so the "Xs ago" labels stay live and the
  // online/offline pill flips as heartbeats arrive.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => subscribeHeartbeatStatus(() => setHb(getHeartbeatStatus())), []);

  // Fast 5 s polling on this page so the registry table feels live
  // (the default refetchInterval is 30 s — fine elsewhere, but on the
  // page that exists specifically to tell the operator what's online
  // right now we want a tighter loop).
  useEffect(() => {
    const id = window.setInterval(() => { void pcsQ.refetch(); }, 5_000);
    return () => window.clearInterval(id);
  }, [pcsQ]);

  const myPcId = getLocalPcId();
  const pcs: DiagnosticPC[] = pcsQ.data ?? [];
  const myRow = pcs.find(r => r.id === myPcId);
  const myTier: PcTier | undefined = myRow?.tier;
  const myScope = user?.scope;

  const projectHost = urlHost(SUPABASE_URL);
  const expectedHost = urlHost(EXPECTED_SUPABASE_HOST);
  const hostMismatch = !!expectedHost && !!projectHost && expectedHost !== projectHost;
  const lanApiHost = urlHost(getInternalApiHealthUrl() ?? "");

  const [sessionUserId, setSessionUserId] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (lanMode) {
        if (!cancelled) setSessionUserId(user?.id ?? "");
        return;
      }
      if (!supabase) return;
      try {
        const { data } = await supabase.auth.getUser();
        if (!cancelled) setSessionUserId(data?.user?.id ?? "");
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [lanMode, user?.id]);

  const onVerify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    const t0 = performance.now();
    try {
      if (lanMode) {
        const health = await fetchInternalApiHealth();
        const ms = Math.round(performance.now() - t0);
        if (!health.ok) {
          setVerifyResult({
            ok: false,
            ms,
            error: `Internal API check failed — ${health.error}`,
          });
          return;
        }
        setVerifyResult({
          ok: true,
          ms,
          rowSeen: true,
          rowLastSeen: new Date().toISOString(),
          peerChecks: [],
        });
        return;
      }
      if (!supabaseConfigured || !supabase) {
        setVerifyResult({
          ok: false,
          error: "Supabase is not configured on this PC — VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are empty.",
        });
        return;
      }
      if (!myPcId) {
        setVerifyResult({ ok: false, error: "This PC has no registered id yet — sign in first." });
        return;
      }
      // Use the canonical heartbeat path. registerLocalPC() runs the
      // SAME claim + upsert sequence (with the legacy-schema fallback
      // and ensureMyPcClaim retry behavior) that every 30 s heartbeat
      // and every cross-PC mutation depends on — so the verify result
      // reflects what would actually happen during normal operation,
      // not a bespoke shortcut. The function is fire-and-forget but
      // reports its outcome via subscribeHeartbeatStatus, which we
      // await with a deadline below before reading the row back.
      const tier: PcTier = myTier ?? "squadron";
      const displayName = squadron?.name || user?.displayName || myPcId;
      const baselineHb = getHeartbeatStatus();
      const baselineErrAt = baselineHb.errorAt ?? 0;
      const baselineOkAt = baselineHb.okAt ?? 0;
      registerLocalPC({
        id: myPcId,
        displayName,
        tier,
        base: squadron?.base,
      });
      // Wait for the heartbeat status to actually change (either OK
      // bumped or a fresh error appeared) up to ~6 s. If neither event
      // fires we still proceed to the readback — better to surface the
      // raw "row missing" diagnostic than block forever.
      const hbOutcome = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        const deadline = window.setTimeout(() => {
          unsub?.();
          resolve({ ok: false, error: "Heartbeat did not respond within 6 s." });
        }, 6_000);
        const unsub = subscribeHeartbeatStatus(() => {
          const cur = getHeartbeatStatus();
          if ((cur.errorAt ?? 0) > baselineErrAt && cur.errorMsg) {
            window.clearTimeout(deadline);
            unsub?.();
            resolve({ ok: false, error: cur.errorMsg });
          } else if ((cur.okAt ?? 0) > baselineOkAt) {
            window.clearTimeout(deadline);
            unsub?.();
            resolve({ ok: true });
          }
        });
      });
      if (!hbOutcome.ok && hbOutcome.error) {
        const ms = Math.round(performance.now() - t0);
        setVerifyResult({
          ok: false,
          ms,
          error: `Heartbeat reported: ${hbOutcome.error}`,
        });
        return;
      }
      // Readback — even when the heartbeat reports OK we still confirm
      // the row is selectable from this client (covers the "upsert
      // succeeded but RLS USING hides it on read" edge case where this
      // PC would publish but never appear in its OWN registry view).
      const readRes = await supabase
        .from("xpc_registry")
        .select("id, last_seen")
        .eq("id", myPcId)
        .maybeSingle();
      if (readRes.error) {
        const ms = Math.round(performance.now() - t0);
        setVerifyResult({
          ok: false,
          ms,
          error: `Readback failed — ${readRes.error.code ?? ""} ${readRes.error.message}`.trim(),
        });
        return;
      }
      if (!readRes.data) {
        const ms = Math.round(performance.now() - t0);
        setVerifyResult({
          ok: false,
          ms,
          rowSeen: false,
          error: "Row not found after upsert — RLS likely rejected the write silently.",
        });
        return;
      }
      // Refresh the registry cache so the per-PC checks below see the
      // freshest last_seen for every peer (other PCs heartbeat every
      // ~30 s; we want to evaluate against the latest snapshot, not the
      // 5 s-stale cache).
      const refreshed = await pcsQ.refetch();
      const peers = (refreshed.data ?? pcs).filter(p => !p.isSelf);
      const tNow = Date.now();
      // Two-level threshold: ≤ DIAG_ONLINE_MS (2 min) = online, ≤ 3×
      // window (~6 min) = stale (PC was online recently but its last
      // heartbeat slipped — usually means OS sleep / Wi-Fi hiccup),
      // beyond that = offline. Peers that haven't checked in within
      // DIAG_INCLUDE_MS (1 week) are filtered out at the query level
      // as decommissioned.
      const peerChecks: PerPcCheck[] = peers.map(p => {
        const ageMs = tNow - new Date(p.lastSeen).getTime();
        const online = ageMs <= DIAG_ONLINE_MS;
        const stale = !online && ageMs <= DIAG_ONLINE_MS * 3;
        return {
          id: p.id,
          tier: p.tier,
          label: p.deviceName || p.squadronName || p.id,
          lastSeen: p.lastSeen,
          ageMs,
          online,
          status: online ? "online" : stale ? "stale" : "offline",
        } satisfies PerPcCheck;
      });
      const ms = Math.round(performance.now() - t0);
      setVerifyResult({
        ok: true,
        ms,
        rowSeen: true,
        rowLastSeen: readRes.data.last_seen as string | undefined,
        peerChecks,
      });
    } catch (e) {
      setVerifyResult({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setVerifying(false);
    }
  };

  const sortedPcs = useMemo(() => {
    return [...pcs].sort((a, b) => {
      if (a.isSelf && !b.isSelf) return -1;
      if (!a.isSelf && b.isSelf) return 1;
      return new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime();
    });
  }, [pcs]);

  const ago = (iso: string) => {
    const ms = now - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  };

  const isOnline = (iso: string) => now - new Date(iso).getTime() <= DIAG_ONLINE_MS;
  const deviceSuffix = (() => {
    try { return getDeviceSuffix(); } catch { return ""; }
  })();

  return (
    <div className="space-y-4">
      <PageHead
        title="Connection Diagnostic"
        subtitle={lanMode
          ? "LAN mode: verify local API reachability and this workstation identity."
          : "See which PCs are linked to this backend and verify your link in seconds."}
      />

      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="space-y-3">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-primary" />
            <div className="text-sm font-semibold">{lanMode ? "Backend (LAN API)" : "Backend (Supabase project)"}</div>
          </div>
          {lanMode ? (
            <>
              <div className="text-xs text-muted-foreground">Internal API host</div>
              <div className="font-mono text-xs break-all bg-secondary p-2 rounded border border-border">
                {lanApiHost || "(not set)"}
              </div>
              {internalApi.result?.ok ? (
                <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-200 flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4" /> Internal API reachable ({internalApi.result.ms} ms)
                </div>
              ) : (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-100">
                  Internal API status is unknown. Use the "Check" button in the LAN panel below.
                </div>
              )}
            </>
          ) : !supabaseConfigured ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-xs text-rose-200">
              <div className="flex items-center gap-2 font-semibold">
                <AlertTriangle className="h-4 w-4" /> Not configured
              </div>
              <p className="mt-1">
                This PC has no Supabase URL baked in — it can't see any other PC. The
                installer must be built with <span className="font-mono">VITE_SUPABASE_URL</span> and
                {" "}<span className="font-mono">VITE_SUPABASE_ANON_KEY</span> set.
              </p>
            </div>
          ) : (
            <>
              <div className="text-xs text-muted-foreground">Project URL (host only — anon key never shown)</div>
              <div className="font-mono text-xs break-all bg-secondary p-2 rounded border border-border">
                {projectHost}
              </div>
              {expectedHost && (
                hostMismatch ? (
                  <div className="rounded-md border border-destructive/60 bg-destructive/10 p-3 text-xs text-rose-200 space-y-1">
                    <div className="flex items-center gap-2 font-semibold">
                      <AlertTriangle className="h-4 w-4" /> Wrong backend
                    </div>
                    <p>
                      This PC is talking to <span className="font-mono">{projectHost}</span>, but
                      the expected project for this build is{" "}
                      <span className="font-mono">{expectedHost}</span>. Other PCs on the
                      expected project will not see this one.
                    </p>
                  </div>
                ) : (
                  <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-200 flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4" /> Matches expected backend
                    {" "}<span className="font-mono">{expectedHost}</span>.
                  </div>
                )
              )}
              {!expectedHost && (
                <p className="text-[11px] text-muted-foreground">
                  Tip: every PC in your test rig must show the same host above. If two
                  PCs show different hosts, they will never see each other.
                </p>
              )}
            </>
          )}
        </Card>

        <Card className="space-y-3">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-primary" />
            <div className="text-sm font-semibold">This PC</div>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-muted-foreground">Canonical id</dt>
            <dd className="font-mono break-all">{myPcId || <span className="italic text-amber-300">(not registered yet)</span>}</dd>
            <dt className="text-muted-foreground">Tier</dt>
            <dd className="font-mono">{myTier ?? "—"}</dd>
            <dt className="text-muted-foreground">Scope</dt>
            <dd className="font-mono">{myScope ?? "—"}</dd>
            <dt className="text-muted-foreground">Signed in as</dt>
            <dd>{user?.displayName} <span className="text-muted-foreground">({user?.role})</span></dd>
            <dt className="text-muted-foreground">Device suffix</dt>
            <dd className="font-mono">{deviceSuffix || "—"}</dd>
            <dt className="text-muted-foreground">PC fingerprint</dt>
            <dd className="font-mono break-all">{fingerprint}</dd>
            <dt className="text-muted-foreground">Last heartbeat OK</dt>
            <dd>{hb.okAt ? `${ago(new Date(hb.okAt).toISOString())}` : "—"}</dd>
          </dl>
          {hb.errorMsg && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-rose-200">
              <span className="font-semibold">Heartbeat error:</span> {hb.errorMsg}
            </div>
          )}
          <div className="space-y-2 pt-1">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={onVerify}
                disabled={verifying}
                data-testid="button-verify-connectivity"
                className="px-3 py-1.5 rounded-md text-sm bg-primary text-primary-foreground inline-flex items-center gap-2 disabled:opacity-60"
              >
                {verifying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {verifying ? "Verifying…" : "Verify connectivity"}
              </button>
              {verifyResult && (verifyResult.ok ? (
                <span className="text-xs text-emerald-300 inline-flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Round-trip OK · {verifyResult.ms} ms
                  {verifyResult.rowLastSeen && (
                    <span className="text-muted-foreground ms-1">
                      · row last_seen {new Date(verifyResult.rowLastSeen).toLocaleTimeString()}
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-xs text-rose-300 break-all">
                  <AlertTriangle className="h-3.5 w-3.5 inline" /> {verifyResult.error}
                </span>
              ))}
            </div>
            {verifyResult?.ok && verifyResult.peerChecks && (
              <div
                className="rounded-md border border-border bg-secondary/30 p-2 text-xs space-y-1"
                data-testid="verify-peer-checks"
              >
                <div className="font-semibold flex items-center gap-2">
                  <Users className="h-3.5 w-3.5 text-primary" />
                  Per-PC reachability ({verifyResult.peerChecks.length} other PC{verifyResult.peerChecks.length === 1 ? "" : "s"})
                </div>
                {verifyResult.peerChecks.length === 0 ? (
                  <p className="text-muted-foreground">
                    No other PCs are registered on this backend yet. As soon as another
                    Hawk Eye PC signs in and heartbeats once, it will appear here.
                  </p>
                ) : (
                  <ul className="space-y-0.5">
                    {verifyResult.peerChecks.map(c => (
                      <li
                        key={c.id}
                        data-testid={`verify-peer-${c.id}`}
                        className="flex items-center gap-2 flex-wrap"
                      >
                        <span className={
                          c.status === "online" ? "text-emerald-300" :
                          c.status === "stale" ? "text-amber-300" : "text-rose-300"
                        }>
                          {c.status === "online" ? "● online" : c.status === "stale" ? "● stale" : "● offline"}
                        </span>
                        <span className="font-mono break-all">{c.id}</span>
                        <span className="text-muted-foreground">
                          ({tierRoleLabel(c.tier, false)}{c.label && c.label !== c.id ? ` · ${c.label}` : ""}) · last heartbeat {ago(c.lastSeen)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </Card>
      </div>

      {getInternalApiHealthUrl() && (
        <Card className="space-y-3" data-testid="card-internal-api-health">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Network className="h-4 w-4 text-primary" />
              <div className="text-sm font-semibold">Internal API (LAN migration)</div>
            </div>
            <button
              type="button"
              onClick={() => runInternalApiCheck()}
              disabled={internalApi.loading}
              className="px-2.5 py-1 rounded-md text-xs bg-secondary border border-border hover:bg-secondary/70 inline-flex items-center gap-1.5 disabled:opacity-60"
              data-testid="button-refresh-internal-api"
            >
              {internalApi.loading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              Check
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Monorepo <span className="font-mono">@workspace/api-server</span> at{" "}
            <span className="font-mono">/api/healthz</span>. In dev, traffic is proxied from{" "}
            <span className="font-mono">…/__hawk_eye_internal_api</span> (see{" "}
            <span className="font-mono">vite.config.ts</span>).
            Set <span className="font-mono">VITE_INTERNAL_API_URL</span> for a direct base URL; production
            builds must allow that host in CSP <span className="font-mono">connect-src</span> (see internal-migration docs).
          </p>
          {internalApi.loading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Contacting internal API…
            </div>
          )}
          {!internalApi.loading && internalApi.result && (
            internalApi.result.ok ? (
              <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-200 flex flex-wrap items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>OK · {internalApi.result.ms} ms</span>
                <span className="text-muted-foreground font-mono break-all">
                  {getInternalApiHealthUrl()}
                </span>
              </div>
            ) : (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-xs text-rose-200 space-y-1">
                <div className="flex items-center gap-2 font-semibold">
                  <AlertTriangle className="h-4 w-4" /> {internalApi.result.error}
                </div>
                {internalApi.result.ms != null && (
                  <p className="text-muted-foreground">After {internalApi.result.ms} ms</p>
                )}
                <p className="font-mono break-all text-[11px] opacity-80">
                  {getInternalApiHealthUrl()}
                </p>
              </div>
            )
          )}
        </Card>
      )}

      <BrowserSessionCard myPcId={myPcId} mySessionUserId={sessionUserId || user?.id || ""} />

      {!lanMode && (
      <Card className="space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            <div className="text-sm font-semibold">PCs on this backend</div>
            <span className="text-xs text-muted-foreground tabular-nums">
              ({sortedPcs.length} total)
            </span>
          </div>
          <button
            onClick={() => void pcsQ.refetch()}
            className="px-2.5 py-1 rounded-md text-xs bg-secondary border border-border hover:bg-secondary/70 inline-flex items-center gap-1.5"
            data-testid="button-refresh-registry"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </div>
        {pcsQ.isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading registry…
          </div>
        ) : sortedPcs.length === 0 ? (
          <div className="text-xs text-muted-foreground">
            No PCs registered. If this PC is signed in but missing here, the heartbeat
            write is failing — check the heartbeat error above and the Backend card.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-secondary/40 text-muted-foreground">
                <tr>
                  <th className="text-start px-3 py-2">PC id</th>
                  <th className="text-start px-3 py-2">Role / Scope</th>
                  <th className="text-start px-3 py-2">Device label</th>
                  <th className="text-start px-3 py-2">Base / Wing</th>
                  <th className="text-start px-3 py-2">Last seen (ago)</th>
                  <th className="text-start px-3 py-2">Last seen (UTC)</th>
                  <th className="text-start px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sortedPcs.map(pc => {
                  const online = isOnline(pc.lastSeen);
                  return (
                    <tr key={pc.id} className={pc.isSelf ? "bg-primary/5" : ""} data-testid={`diag-row-${pc.id}`}>
                      <td className="px-3 py-2 font-mono break-all">
                        {pc.id}
                        {pc.isSelf && (
                          <span className="ms-2 inline-flex items-center px-1.5 py-0.5 rounded text-[10px] bg-primary/20 text-primary border border-primary/40">
                            this PC
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div>{tierRoleLabel(pc.tier, pc.isSelf)}</div>
                        <div className="text-[10px] text-muted-foreground font-mono">tier: {pc.tier}</div>
                      </td>
                      <td className="px-3 py-2">{pc.deviceName || pc.squadronName || "—"}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {[pc.base, pc.wing].filter(Boolean).join(" · ") || "—"}
                      </td>
                      <td className="px-3 py-2 tabular-nums">{ago(pc.lastSeen)}</td>
                      <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                        {(() => { try { return new Date(pc.lastSeen).toISOString().replace("T", " ").slice(0, 19) + "Z"; } catch { return pc.lastSeen; } })()}
                      </td>
                      <td className="px-3 py-2">
                        {online ? (
                          <span className="inline-flex items-center gap-1 text-emerald-300">
                            <span className="h-2 w-2 rounded-full bg-emerald-400" /> online
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <span className="h-2 w-2 rounded-full bg-muted-foreground/60" /> offline
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">
          Online = heartbeat within the last {Math.round(DIAG_ONLINE_MS / 1000)} s.
          Refreshes automatically every 5 s.
        </p>
      </Card>
      )}

      <Card className="space-y-2">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-primary" />
          <div className="text-sm font-semibold">{lanMode ? "LAN test-rig setup tips" : "Test-rig setup tips"}</div>
        </div>
        <ul className="text-xs text-muted-foreground space-y-1 list-disc ms-5">
          <li>Every PC in your rig must show the same backend host above.</li>
          <li>Two tabs in the <em>same</em> browser profile share the sign-in storage — the second sign-in silently replaces the first.</li>
          <li>Use a separate Chrome profile (Chrome → "Add" → new profile) or a different browser (Edge / Firefox) for each role you want to simulate.</li>
          <li>The installed Electron app is its own process and is always isolated.</li>
        </ul>
      </Card>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {pcsQ.isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : navigator.onLine ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
        Browser is {navigator.onLine ? "online" : "offline"}.
      </div>
    </div>
  );
}
