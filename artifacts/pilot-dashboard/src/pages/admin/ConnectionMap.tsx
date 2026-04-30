// Super-Admin Connection Map (/admin/connection-map).
//
// God-mode page: see every registered PC in the mesh AND every active
// pair link in one place. Click a PC, click another, hit Pair —
// instant link. Click an existing pair to revoke / extend / mark
// permanent. Cross-squadron-ops pairs require a justification + an
// expiry date and are flagged in the audit panel.
//
// Phase 1 scope: flat list of PCs + flat list of pairs + audit
// rail (no graph rendering). The flat list is plenty for ≤ ~30 PCs;
// upgrading to a force-directed graph is a Phase 2 visual nicety.

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import { isLanSessionLoginEnabled } from "@/lib/internal-migration";
import { useRegisteredPCsIncludingStale, type RegisteredPC, type PcTier } from "@/lib/cross-pc";
import {
  useAllPairs,
  usePairAudit,
  useAdminCreatePair,
  useRevokePair,
  useSetPairPermanent,
  useResetRegisteredPc,
  useRunSweep,
  bulkPairInSquadron,
  resolvePairKind,
  daysUntilInactivityExpiry,
  expiryUrgencyClass,
  PAIR_KIND_LABEL,
  type PairLink,
  type PairKind,
} from "@/lib/pairs";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, History, Info, Link2, Link2Off, Loader2, Pin, PinOff, RefreshCw, RotateCcw, Search, ShieldAlert, Trash2, Wand2 } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";

// How fresh a registry row's heartbeat must be to count as "live".
// When a row is older than this we surface a "force delete from registry"
// option in the Reset PC dialog.
const RESET_LIVE_HEARTBEAT_MS = 5 * 60 * 1000;

type PcRow = {
  id: string;
  tier: PcTier;
  squadron: string | null;
  display: string | null;
  seat: string | null;
  online: boolean;
  lastSeen: string;
};

// Canonical squadron key — same shape used elsewhere to detect "NO.8" vs
// "no 8" vs "8 SQN" as the same squadron.
function canonSquadron(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function rowsFromRegistry(pcs: RegisteredPC[]): PcRow[] {
  return pcs.map(p => ({
    id: p.id,
    tier: (p.tier as PcTier) ?? "squadron",
    squadron: p.squadronName ?? null,
    display: p.deviceName ?? p.squadronName ?? null,
    seat: null,
    online: !!p.online,
    lastSeen: p.lastSeen ?? "",
  }));
}

export default function ConnectionMap() {
  const { user } = useAuth();
  const lanMode = isLanSessionLoginEnabled();
  const { toast } = useToast();
  const registry = useRegisteredPCsIncludingStale();
  const pairs = useAllPairs();
  const audit = usePairAudit(150);
  const sweep = useRunSweep();
  const reset = useResetRegisteredPc();
  const setPermanent = useSetPairPermanent();
  const revoke = useRevokePair();

  const [filter, setFilter] = useState("");
  const [selectedA, setSelectedA] = useState<string | null>(null);
  const [selectedB, setSelectedB] = useState<string | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<string | null>(null);

  const allPcs = useMemo(() => rowsFromRegistry(registry.data), [registry.data]);
  const filteredPcs = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return allPcs;
    return allPcs.filter(p =>
      p.id.toLowerCase().includes(q)
      || (p.squadron ?? "").toLowerCase().includes(q)
      || (p.display ?? "").toLowerCase().includes(q)
      || (p.seat ?? "").toLowerCase().includes(q)
      || p.tier.includes(q)
    );
  }, [allPcs, filter]);

  // Pair count per PC for the right-hand badge column.
  const pairCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of pairs.data) {
      m.set(l.aPcId, (m.get(l.aPcId) ?? 0) + 1);
      m.set(l.bPcId, (m.get(l.bPcId) ?? 0) + 1);
    }
    return m;
  }, [pairs.data]);

  // Auto-show pair dialog once user picks two distinct PCs.
  useEffect(() => {
    if (selectedA && selectedB && selectedA !== selectedB) setPairOpen(true);
  }, [selectedA, selectedB]);

  const sweepNow = async () => {
    try {
      const r = await sweep.mutateAsync();
      toast({
        title: "Sweep complete",
        description: `Revoked ${r.revoked} stale, expired ${r.expired} time-bound.`,
      });
    } catch (e) {
      toast({ title: "Sweep failed", description: (e as Error).message, variant: "destructive" });
    }
  };

  // Bulk: pair every (Ops PC ↔ Flight PC) sharing a squadron name.
  // Idempotent — safe to click any time. Powers a clean rollout when
  // a brand-new squadron registers all its PCs at once.
  const [bulking, setBulking] = useState(false);
  const bulkInSquadron = async () => {
    if (!confirm("Pair every Flight PC with its Ops PC (in-squadron) for every squadron in the registry? This is idempotent — pairs that already exist are left alone.")) return;
    setBulking(true);
    try {
      const created = await bulkPairInSquadron();
      toast({ title: "Bulk pair complete", description: `${created} new in-squadron pair${created === 1 ? "" : "s"} created.` });
    } catch (e) {
      toast({ title: "Bulk pair failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBulking(false);
    }
  };

  // Squadron grouping for the PC list — operators with multiple
  // squadrons online at once want their squadrons clustered, not a
  // flat alpha list. Wing/Base/HQ tiers cluster under "(infrastructure)".
  const groupedPcs = useMemo(() => {
    const groups = new Map<string, PcRow[]>();
    for (const p of filteredPcs) {
      const key = p.tier === "squadron" || p.tier === "flight"
        ? (p.squadron ?? "— unassigned —")
        : "Wing / Base / HQ";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(p);
    }
    // Sort group keys; "Wing / Base / HQ" always last.
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === "Wing / Base / HQ") return 1;
      if (b === "Wing / Base / HQ") return -1;
      return a.localeCompare(b);
    });
    return keys.map(k => ({ name: k, rows: groups.get(k)!.sort((x, y) => x.id.localeCompare(y.id)) }));
  }, [filteredPcs]);

  return (
    <div className="space-y-6 p-4 md:p-6 max-w-[1500px] mx-auto">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-rose-300" />
            Connection Map
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Super-Admin authority over every cross-PC pair in the mesh.
            Pick two PCs to pair, or click an existing pair to revoke,
            extend, or mark permanent. Cross-squadron-ops links require a
            justification and expiry date.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="gap-1"><Wand2 className="h-3 w-3" /> god-mode</Badge>
          <Button variant="secondary" size="sm" onClick={bulkInSquadron} disabled={bulking}>
            {bulking ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Wand2 className="h-3.5 w-3.5 mr-1" />}
            Pair every Flight ↔ Ops
          </Button>
          <Button variant="secondary" size="sm" onClick={sweepNow} disabled={sweep.isPending}>
            {sweep.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5 mr-1" />}
            Run sweep now
          </Button>
        </div>
      </div>
      {lanMode && (
        <Card className="p-3 border-sky-500/30 bg-sky-500/5">
          <p className="text-xs text-sky-100">
            <span className="font-semibold">LAN mode:</span> pairing actions on this map now use the
            internal LAN API path. If results look stale, run <span className="font-semibold">Sweep now</span> and
            verify all PCs point to the same LAN backend from Connection Diagnostic.
          </p>
        </Card>
      )}

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Left: PC list */}
        <Card className="p-4 lg:col-span-1">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Registered PCs ({allPcs.length})
          </h2>
          <div className="relative mb-3">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Filter by id, tier, squadron…"
              className="pl-7 h-8 text-sm"
            />
          </div>
          <div className="text-xs text-muted-foreground mb-2">
            Tap row to pick {selectedA ? "B (peer)" : "A (anchor)"}.
            {selectedA && (
              <button className="underline ml-2"
                onClick={() => { setSelectedA(null); setSelectedB(null); }}>
                clear
              </button>
            )}
          </div>
          <div className="max-h-[640px] overflow-auto">
            {groupedPcs.map(group => (
              <div key={group.name} className="mb-2">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground px-2 py-1 bg-muted/20 rounded mb-0.5 sticky top-0">
                  {group.name} <span className="opacity-60">({group.rows.length})</span>
                </div>
                <div className="divide-y divide-border/40">
                  {group.rows.map(p => {
                    const isA = p.id === selectedA;
                    const isB = p.id === selectedB;
                    return (
                      <button
                        key={p.id}
                        onClick={() => {
                          if (!selectedA) { setSelectedA(p.id); return; }
                          if (selectedA === p.id) { setSelectedA(null); return; }
                          setSelectedB(p.id);
                        }}
                        className={`w-full text-left py-2 px-2 rounded transition flex items-center gap-2 ${isA ? "bg-sky-500/15 ring-1 ring-sky-400/40" : isB ? "bg-emerald-500/15 ring-1 ring-emerald-400/40" : "hover:bg-muted/30"}`}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-mono truncate">{p.id}</div>
                          <div className="text-[11px] text-muted-foreground truncate">
                            {p.tier}{p.squadron ? ` · ${p.squadron}` : ""}{p.seat ? ` · ${p.seat}` : ""}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-0.5">
                          {p.online
                            ? <Badge variant="outline" className="text-[9px] text-emerald-300 border-emerald-500/30 px-1">on</Badge>
                            : <Badge variant="outline" className="text-[9px] text-muted-foreground px-1">off</Badge>}
                          <Badge variant="secondary" className="text-[9px] px-1">{pairCount.get(p.id) ?? 0}🔗</Badge>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {filteredPcs.length === 0 && (
              <div className="text-sm text-muted-foreground py-4 text-center">No PCs match.</div>
            )}
          </div>
          {selectedA && (
            <div className="mt-3 pt-3 border-t border-border/40">
              <Button size="sm" variant="destructive" className="w-full"
                disabled={reset.isPending}
                onClick={() => setResetTarget(selectedA)}
                data-testid="button-reset-pc"
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Reset selected PC
              </Button>
            </div>
          )}
        </Card>

        {/* Middle: pairs */}
        <Card className="p-4 lg:col-span-1">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            Active pairs ({pairs.data.length})
          </h2>
          {pairs.isLoading ? (
            <div className="flex items-center text-sm text-muted-foreground py-4">
              <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> Loading…
            </div>
          ) : pairs.data.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              <Link2Off className="h-5 w-5 mx-auto mb-2 opacity-50" />
              No active pair links yet.
            </div>
          ) : (
            <div className="divide-y divide-border/40 max-h-[640px] overflow-auto">
              {pairs.data.map(l => {
                const days = daysUntilInactivityExpiry(l);
                return (
                  <div key={`${l.aPcId}|${l.bPcId}`} className="py-2 text-sm">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono truncate">{l.aPcId}</span>
                      <Link2 className="h-3 w-3 opacity-50" />
                      <span className="font-mono truncate">{l.bPcId}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <Badge variant="secondary" className="text-[10px]">{PAIR_KIND_LABEL[l.kind]}</Badge>
                      {l.permanent && <Badge variant="outline" className="text-[10px]">permanent</Badge>}
                      {l.kind === "cross_squadron_ops" && (
                        <Badge variant="outline" className="text-[10px] text-amber-300 border-amber-500/30">
                          <AlertTriangle className="h-2.5 w-2.5 mr-0.5" /> cross-sqn
                        </Badge>
                      )}
                      <span className={`text-[11px] ml-auto ${expiryUrgencyClass(days)}`}>
                        {l.permanent
                          ? "permanent"
                          : days === null ? "—" : `${days}d left`}
                      </span>
                    </div>
                    {l.justification && (
                      <div className="text-[11px] text-muted-foreground mt-1 italic">
                        "{l.justification}"
                      </div>
                    )}
                    <div className="flex items-center gap-1 mt-1">
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]"
                        onClick={() => setPermanent.mutate({ aPcId: l.aPcId, bPcId: l.bPcId, permanent: !l.permanent })}>
                        {l.permanent ? <><PinOff className="h-3 w-3 mr-1" /> unpin</> : <><Pin className="h-3 w-3 mr-1" /> permanent</>}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-rose-300"
                        onClick={async () => {
                          if (!confirm(`Revoke pair ${l.aPcId} ↔ ${l.bPcId}?`)) return;
                          await revoke.mutateAsync({
                            aPcId: l.aPcId, bPcId: l.bPcId,
                            reason: "super-admin revoked",
                            byUserId: user?.id ?? null,
                          });
                        }}>
                        <Link2Off className="h-3 w-3 mr-1" /> revoke
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        {/* Right: audit */}
        <Card className="p-4 lg:col-span-1">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3 flex items-center gap-2">
            <History className="h-4 w-4" /> Audit
          </h2>
          {audit.isLoading ? (
            <div className="flex items-center text-sm text-muted-foreground py-4">
              <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> Loading…
            </div>
          ) : audit.data.rlsDenied ? (
            <div className="p-3 rounded bg-muted/30 border border-border/40 text-xs text-muted-foreground flex gap-2">
              <Info className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <div>
                The audit table is restricted to super-admins. Sign in with a
                super-admin account to view pair history. Other panels above
                continue to work as normal.
              </div>
            </div>
          ) : (
            <ol className="divide-y divide-border/40 max-h-[640px] overflow-auto text-xs">
              {audit.data.entries.map(e => (
                <li key={e.id} className="py-2">
                  <div className="flex items-center gap-2">
                    <Badge variant={e.action.includes("rejected") ? "destructive" : "outline"} className="text-[10px]">
                      {e.action}
                    </Badge>
                    <span className="text-muted-foreground ml-auto">{new Date(e.at).toLocaleString()}</span>
                  </div>
                  <div className="mt-1 font-mono break-all">
                    {e.targetPcA}{e.targetPcB ? ` ↔ ${e.targetPcB}` : ""}
                  </div>
                  {e.byUserLabel && <div className="text-muted-foreground">by {e.byUserLabel}</div>}
                  {e.justification && <div className="italic text-muted-foreground">"{e.justification}"</div>}
                </li>
              ))}
              {audit.data.entries.length === 0 && (
                <li className="py-6 text-center text-muted-foreground">No audit entries yet.</li>
              )}
            </ol>
          )}
        </Card>
      </div>

      {pairOpen && selectedA && selectedB && (
        <PairDialog
          a={allPcs.find(p => p.id === selectedA)!}
          b={allPcs.find(p => p.id === selectedB)!}
          onClose={() => { setPairOpen(false); setSelectedB(null); }}
          byUserId={user?.id ?? null}
          byUserLabel={user?.displayName ?? user?.username ?? "super_admin"}
        />
      )}

      {resetTarget && (
        <ResetPcDialog
          pcId={resetTarget}
          row={allPcs.find(p => p.id === resetTarget) ?? null}
          isPending={reset.isPending}
          onClose={() => setResetTarget(null)}
          onConfirm={async (force) => {
            try {
              await reset.mutateAsync({
                pcId: resetTarget,
                byUserId: user?.id ?? null,
                force,
              });
              toast({ title: force ? "PC force-removed" : "PC reset", description: resetTarget });
              setResetTarget(null);
              setSelectedA(null); setSelectedB(null);
            } catch (e) {
              toast({ title: "Reset failed", description: (e as Error).message, variant: "destructive" });
            }
          }}
        />
      )}
    </div>
  );
}

function ResetPcDialog(props: {
  pcId: string;
  row: PcRow | null;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (force: boolean) => Promise<void> | void;
}) {
  const [force, setForce] = useState(false);
  const lastSeen = props.row?.lastSeen ? new Date(props.row.lastSeen).getTime() : 0;
  const isStale = !props.row?.online && (!lastSeen || (Date.now() - lastSeen) > RESET_LIVE_HEARTBEAT_MS);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) props.onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-rose-300" /> Reset PC
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="font-mono text-xs break-all">{props.pcId}</div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Revokes every active pair the PC participates in and removes its
            registry + claim rows. Use this when hardware is replaced or a PC
            must re-onboard from scratch. The PC re-registers on next launch.
          </p>
          {isStale ? (
            <div className="p-3 rounded bg-amber-500/10 border border-amber-500/30 space-y-2">
              <div className="text-xs text-amber-200 flex items-center gap-1">
                <Info className="h-3.5 w-3.5" /> No recent heartbeat
              </div>
              <p className="text-[11px] text-muted-foreground">
                This PC last checked in
                {lastSeen ? ` ${Math.round((Date.now() - lastSeen) / 60000)} min ago` : " never"}.
                If the hardware is gone, you can also delete its registry row outright.
              </p>
              <label className="flex items-center gap-2 text-[12px] cursor-pointer">
                <Checkbox checked={force} onCheckedChange={(v) => setForce(!!v)} data-testid="checkbox-force-delete" />
                Also delete registry row (force delete)
              </label>
            </div>
          ) : (
            <div className="text-[11px] text-muted-foreground">
              PC is currently {props.row?.online ? "online" : "recently online"} — registry row will repopulate on its next heartbeat.
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button variant="destructive" onClick={() => props.onConfirm(force)} disabled={props.isPending} data-testid="button-confirm-reset">
            {props.isPending
              ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Resetting…</>
              : <><Trash2 className="h-4 w-4 mr-2" /> {force ? "Force delete" : "Reset"}</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PairDialog(props: {
  a: PcRow; b: PcRow;
  onClose: () => void;
  byUserId: string | null;
  byUserLabel: string;
}) {
  const create = useAdminCreatePair();
  const { toast } = useToast();
  const [justification, setJustification] = useState("");
  const [expiresLocal, setExpiresLocal] = useState("");
  const [permanent, setPermanent] = useState(false);
  // For two squadron-tier different-squadron PCs the operator picks
  // between two paths: peer_sqn (Cmdr↔Cmdr permanent) or
  // cross_squadron_ops (time-bound escape hatch). Default is escape
  // hatch so the operator MUST opt-in to peer_sqn.
  const [crossKind, setCrossKind] = useState<"cross_squadron_ops" | "peer_sqn">("cross_squadron_ops");

  const isCrossSqn = !!(props.a.tier === "squadron" && props.b.tier === "squadron"
    && props.a.squadron && props.b.squadron
    && canonSquadron(props.a.squadron) !== canonSquadron(props.b.squadron));

  // Two squadron-tier PCs registered for the SAME canonical squadron
  // are a duplicate registration, not a pair candidate. The matrix has
  // no kind for "two ops PCs of the same sqn" — every legitimate
  // in-squadron link goes Flight↔Ops, so emitting one of these would
  // be operator confusion. Surface as a hard block so the operator
  // resets one PC instead of trying to pair them.
  const isDuplicateSqn = !!(props.a.tier === "squadron" && props.b.tier === "squadron"
    && props.a.squadron && props.b.squadron
    && canonSquadron(props.a.squadron) === canonSquadron(props.b.squadron)
    && props.a.id !== props.b.id);

  const tentative: PairKind | null = useMemo(() => {
    return resolvePairKind({
      aTier: props.a.tier, bTier: props.b.tier,
      aSquadron: props.a.squadron, bSquadron: props.b.squadron,
      superAdmin: true,
      justification: justification || null,
      expiresAt: expiresLocal ? new Date(expiresLocal).toISOString() : null,
      kindHint: isCrossSqn && crossKind === "peer_sqn" ? "peer_sqn" : null,
    });
  }, [props.a, props.b, justification, expiresLocal, isCrossSqn, crossKind]);

  // Show cross-ops fields only when the operator picks the escape hatch.
  const showCrossOpsFields = isCrossSqn && crossKind === "cross_squadron_ops";

  const submit = async () => {
    try {
      const useEscape = isCrossSqn && crossKind === "cross_squadron_ops";
      await create.mutateAsync({
        a: { pcId: props.a.id, tier: props.a.tier, squadron: props.a.squadron, userDisplay: props.a.display, userSeat: props.a.seat },
        b: { pcId: props.b.id, tier: props.b.tier, squadron: props.b.squadron, userDisplay: props.b.display, userSeat: props.b.seat },
        byUserId: props.byUserId,
        byUserLabel: props.byUserLabel,
        justification: useEscape ? (justification || null) : null,
        expiresAt: useEscape ? (expiresLocal ? new Date(expiresLocal).toISOString() : null) : null,
        permanent: isCrossSqn && crossKind === "peer_sqn" ? true : permanent,
        kindHint: isCrossSqn && crossKind === "peer_sqn" ? "peer_sqn" : null,
      });
      toast({ title: "Paired", description: `${props.a.id} ↔ ${props.b.id}` });
      props.onClose();
    } catch (e) {
      toast({ title: "Pair failed", description: (e as Error).message, variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) props.onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pair PCs</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-mono">{props.a.id}</span>
            <Link2 className="h-4 w-4" />
            <span className="font-mono">{props.b.id}</span>
          </div>
          <div className="text-xs text-muted-foreground">
            {props.a.tier}{props.a.squadron ? ` · ${props.a.squadron}` : ""}
            {" ↔ "}
            {props.b.tier}{props.b.squadron ? ` · ${props.b.squadron}` : ""}
          </div>
          {isDuplicateSqn ? (
            <div className="p-3 bg-rose-500/10 rounded border border-rose-500/40 text-xs text-rose-200">
              <div className="font-medium flex items-center gap-1 mb-1">
                <AlertTriangle className="h-3.5 w-3.5" /> Duplicate squadron registration
              </div>
              <p className="leading-relaxed">
                Both PCs are registered as the squadron tier for
                <span className="font-mono mx-1">{props.a.squadron}</span>.
                Each squadron should have exactly one Ops PC. Reset the
                obsolete PC from the left column instead of pairing them.
              </p>
            </div>
          ) : tentative ? (
            <Badge variant="secondary" className="text-[10px]">{PAIR_KIND_LABEL[tentative]}</Badge>
          ) : (
            <Badge variant="destructive" className="text-[10px]">Pairing forbidden by matrix</Badge>
          )}
          {isCrossSqn && (
            <div className="space-y-2 p-3 bg-amber-500/10 rounded border border-amber-500/30">
              <div className="text-amber-300 text-xs font-medium flex items-center gap-1">
                <AlertTriangle className="h-3.5 w-3.5" /> Cross-squadron link — pick a path
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setCrossKind("cross_squadron_ops")}
                  className={`text-left p-2 rounded border text-xs ${crossKind === "cross_squadron_ops" ? "border-amber-400 bg-amber-500/15" : "border-border/40 hover:bg-muted/30"}`}
                >
                  <div className="font-medium">Ops escape hatch</div>
                  <div className="text-[10px] text-muted-foreground">Time-bound. Justification + expiry required.</div>
                </button>
                <button
                  type="button"
                  onClick={() => setCrossKind("peer_sqn")}
                  className={`text-left p-2 rounded border text-xs ${crossKind === "peer_sqn" ? "border-emerald-400 bg-emerald-500/15" : "border-border/40 hover:bg-muted/30"}`}
                >
                  <div className="font-medium">Cmdr ↔ Cmdr peer</div>
                  <div className="text-[10px] text-muted-foreground">Permanent. Use only when both seats are SqnCmdr.</div>
                </button>
              </div>
              {showCrossOpsFields && (
                <>
                  <p className="text-xs text-muted-foreground">
                    Required for cross-squadron Ops pairs: a written reason (≥ 8 chars) and a hard expiry date.
                  </p>
                  <Input
                    value={justification}
                    onChange={e => setJustification(e.target.value)}
                    placeholder="e.g. covering No.7 ops while their PC is offline"
                  />
                  <Input
                    type="datetime-local"
                    value={expiresLocal}
                    onChange={e => setExpiresLocal(e.target.value)}
                  />
                </>
              )}
            </div>
          )}
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={permanent} onChange={e => setPermanent(e.target.checked)} />
            Mark permanent (bypass 90-day inactivity sweep)
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button disabled={!tentative || create.isPending || isDuplicateSqn} onClick={submit}>
            {create.isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Pairing…</> : <><RefreshCw className="h-4 w-4 mr-2" /> Pair</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
