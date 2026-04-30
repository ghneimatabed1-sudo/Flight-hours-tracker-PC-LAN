// Connections page (Settings → Connections).
//
// Three sections:
//   1. This PC (canonical id, tier, squadron, copy buttons).
//   2. My pairs — every active pair link this PC participates in,
//      with revoke + last-activity countdown.
//   3. Pair another PC — two cards: "Show code" host modal and
//      "Enter code" join modal.
//
// Self-service only. The Super-Admin Connection Map (/admin/connection-map)
// owns cross-squadron-ops links and registry-wide actions.

import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/lib/auth";
import { isLanSessionLoginEnabled } from "@/lib/internal-migration";
import {
  getLocalPcId,
  useRegisteredPCs,
  type PcTier,
} from "@/lib/cross-pc";
import {
  formatCode,
  useIssueCode,
  useRedeemCode,
  useMyPairs,
  useRevokePair,
  useWatchForIncomingPair,
  daysUntilInactivityExpiry,
  expiryUrgencyClass,
  PAIR_KIND_LABEL,
  type PairCode,
  type PairLink,
} from "@/lib/pairs";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Copy, Link2, Link2Off, Loader2, RefreshCw, ShieldCheck, Timer, Unplug, Zap } from "lucide-react";

function tierFromUser(user: ReturnType<typeof useAuth>["user"]): PcTier {
  if (!user) return "squadron";
  if (user.role === "super_admin") return "hq";
  if (user.scope === "flight") return "flight";
  if (user.scope === "wing") return "wing";
  if (user.scope === "base") return "base";
  if (user.scope === "hq") return "hq";
  return "squadron";
}

function seatLabel(user: ReturnType<typeof useAuth>["user"]): string | null {
  if (!user) return null;
  if (user.role === "ops") return "Ops";
  if (user.role === "commander") {
    if (user.scope === "flight") return "Flight Cmdr";
    if (user.scope === "squadron") return "Sqn Cmdr";
    if (user.scope === "wing") return "Wing Cmdr";
    if (user.scope === "base") return "Base Cmdr";
    if (user.scope === "hq") return "HQ";
  }
  return user.role;
}

export default function Connections() {
  const { user, squadron } = useAuth();
  const lanMode = isLanSessionLoginEnabled();
  const { toast } = useToast();
  const myPcId = getLocalPcId();
  const { data: pairs, isLoading } = useMyPairs();
  const registry = useRegisteredPCs();
  const revoke = useRevokePair();
  const [hostOpen, setHostOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);

  const myTier = tierFromUser(user);
  const mySquadron = squadron?.name ?? null;
  const mySeat = seatLabel(user);
  const myDisplay = user?.displayName ?? user?.username ?? null;

  const peerLabel = (l: PairLink) => {
    const isA = l.aPcId === myPcId;
    const peerId = isA ? l.bPcId : l.aPcId;
    const peerSeat = isA ? l.bUserSeat : l.aUserSeat;
    const peerDisplay = isA ? l.bUserDisplay : l.aUserDisplay;
    const peerSqn = isA ? l.bSquadron : l.aSquadron;
    return { peerId, peerSeat, peerDisplay, peerSqn };
  };

  return (
    <div className="space-y-6 p-4 md:p-6 max-w-5xl mx-auto">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Connections</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Pair this PC with another desktop in the chain. Pairs you create
            here decide which PCs can route schedules, messages, and edits to
            this seat — and which appear in the picker.
          </p>
        </div>
        <Badge variant="outline" className="gap-1">
          <ShieldCheck className="h-3 w-3" /> Self-service
        </Badge>
      </div>
      {lanMode && (
        <Card className="p-3 border-sky-500/30 bg-sky-500/5">
          <p className="text-xs text-sky-100">
            <span className="font-semibold">LAN mode:</span> this pairing page stays active on
            local-network installs. If peers do not appear, check that every PC is running the
            same LAN backend and verify health in <span className="font-semibold">Connection Diagnostic</span>.
          </p>
        </Card>
      )}

      {/* This PC */}
      <Card className="p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          This PC
        </h2>
        <dl className="grid sm:grid-cols-2 gap-y-2 text-sm">
          <div className="flex items-center gap-2">
            <dt className="text-muted-foreground w-28">PC ID</dt>
            <dd className="font-mono break-all">{myPcId || "(not registered)"}</dd>
            {myPcId ? (
              <button
                className="opacity-60 hover:opacity-100"
                onClick={() => { navigator.clipboard.writeText(myPcId); toast({ title: "Copied PC ID" }); }}
                title="Copy"
              ><Copy className="h-3.5 w-3.5" /></button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-muted-foreground w-28">Seat</dt>
            <dd>{mySeat ?? "—"}</dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-muted-foreground w-28">Tier</dt>
            <dd className="capitalize">{myTier}</dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-muted-foreground w-28">Squadron</dt>
            <dd>{mySquadron ?? "—"}</dd>
          </div>
        </dl>
      </Card>

      {/* My pairs */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            My pairs ({pairs.length})
          </h2>
          <Badge variant="outline" className="text-[10px]">
            <Timer className="h-3 w-3 mr-1" /> auto-expire after 90 days inactive
          </Badge>
        </div>
        {isLoading ? (
          <div className="flex items-center text-sm text-muted-foreground py-4">
            <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" /> Loading…
          </div>
        ) : pairs.length === 0 ? (
          <div className="text-sm text-muted-foreground py-6 text-center">
            <Link2Off className="h-5 w-5 mx-auto mb-2 opacity-50" />
            No active pairs. Use the buttons below to pair with another PC.
          </div>
        ) : (
          <div className="divide-y divide-border/40">
            {pairs.map(l => {
              const p = peerLabel(l);
              const days = daysUntilInactivityExpiry(l);
              const isOnline = registry.data.some(r => r.id === p.peerId && r.online);
              return (
                <div key={`${l.aPcId}|${l.bPcId}`} className="py-3 flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-sm break-all">{p.peerId}</span>
                      {isOnline ? (
                        <Badge variant="outline" className="text-[10px] text-emerald-300 border-emerald-500/30">
                          <Zap className="h-2.5 w-2.5 mr-0.5" /> online
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">offline</Badge>
                      )}
                      <Badge variant="secondary" className="text-[10px]">{PAIR_KIND_LABEL[l.kind]}</Badge>
                      {l.permanent && <Badge variant="outline" className="text-[10px]">permanent</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {p.peerSeat ? `${p.peerSeat}` : "—"}{p.peerDisplay ? ` · ${p.peerDisplay}` : ""}
                      {p.peerSqn ? ` · ${p.peerSqn}` : ""}
                    </div>
                    <div className={`text-xs mt-0.5 ${expiryUrgencyClass(days)}`}>
                      {l.permanent
                        ? "permanent — exempt from inactivity sweep"
                        : days === null
                          ? "—"
                          : days <= 0
                            ? "expires today"
                            : `auto-expires in ${days} day${days === 1 ? "" : "s"} (resets on activity)`}
                      {l.expiresAt ? ` · hard expiry ${new Date(l.expiresAt).toLocaleString()}` : ""}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={revoke.isPending}
                    onClick={async () => {
                      if (!confirm(`Unpair from ${p.peerId}? Schedules, messages, and pickers will stop routing to this peer until it is paired again.`)) return;
                      try {
                        await revoke.mutateAsync({
                          aPcId: l.aPcId, bPcId: l.bPcId,
                          reason: "user revoked from Connections",
                          byUserId: user?.id ?? null,
                        });
                        toast({ title: "Pair removed", description: p.peerId });
                      } catch (e) {
                        toast({ title: "Failed to unpair", description: (e as Error).message, variant: "destructive" });
                      }
                    }}
                  >
                    <Unplug className="h-4 w-4 mr-1" /> Unpair
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Pair another PC */}
      <Card className="p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          Pair another PC
        </h2>
        <div className="grid sm:grid-cols-2 gap-3">
          <Card className="p-4 bg-card/40">
            <h3 className="font-medium mb-1 flex items-center gap-2">
              <Link2 className="h-4 w-4" /> Show a code
            </h3>
            <p className="text-xs text-muted-foreground mb-3">
              Generates a 6-digit code valid for 5 minutes. Read it to the other
              operator over the phone or radio. They enter it on their PC.
            </p>
            <Button onClick={() => setHostOpen(true)} disabled={!myPcId}>Show code</Button>
          </Card>
          <Card className="p-4 bg-card/40">
            <h3 className="font-medium mb-1 flex items-center gap-2">
              <RefreshCw className="h-4 w-4" /> Enter a code
            </h3>
            <p className="text-xs text-muted-foreground mb-3">
              Got a 6-digit code from the other PC? Type it here. The pair is
              created instantly on both sides.
            </p>
            <Button variant="secondary" onClick={() => setJoinOpen(true)} disabled={!myPcId}>Enter code</Button>
          </Card>
        </div>
        {!myPcId && (
          <p className="text-xs text-amber-300 mt-3">
            This PC hasn't registered an ID yet. Open the dashboard once on this
            PC (any signed-in screen will do); the registration runs in the
            background within ~30 seconds.
          </p>
        )}
      </Card>

      {hostOpen && (
        <HostCodeDialog
          onClose={() => setHostOpen(false)}
          host={{
            pcId: myPcId,
            tier: myTier,
            squadron: mySquadron,
            userDisplay: myDisplay,
            userSeat: mySeat,
            userId: user?.id ?? null,
          }}
        />
      )}
      {joinOpen && (
        <JoinCodeDialog
          onClose={() => setJoinOpen(false)}
          joiner={{
            pcId: myPcId,
            tier: myTier,
            squadron: mySquadron,
            userDisplay: myDisplay,
            userSeat: mySeat,
            userId: user?.id ?? null,
          }}
        />
      )}
    </div>
  );
}

// ── Host modal ───────────────────────────────────────────────────────
function HostCodeDialog(props: {
  onClose: () => void;
  host: {
    pcId: string;
    tier: PcTier;
    squadron: string | null;
    userDisplay: string | null;
    userSeat: string | null;
    userId: string | null;
  };
}) {
  const issue = useIssueCode();
  const { toast } = useToast();
  const [code, setCode] = useState<PairCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const issuedAt = useRef<string | null>(null);
  const watched = useWatchForIncomingPair(props.host.pcId, issuedAt.current);

  // Mint immediately on open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const c = await issue.mutateAsync({
          hostPcId: props.host.pcId,
          hostTier: props.host.tier,
          hostSquadron: props.host.squadron,
          hostUserDisplay: props.host.userDisplay,
          hostUserSeat: props.host.userSeat,
          hostUserId: props.host.userId,
        });
        if (!cancelled) {
          setCode(c);
          issuedAt.current = c.expiresAt
            ? new Date(new Date(c.expiresAt).getTime() - 5 * 60_000).toISOString()
            : new Date().toISOString();
        }
      } catch (e) {
        if (!cancelled) toast({ title: "Could not generate code", description: (e as Error).message, variant: "destructive" });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tick once a second for the countdown.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Auto-close when the join side completes the handshake.
  useEffect(() => {
    if (watched) {
      toast({ title: "Pair created", description: "Other PC redeemed the code." });
      props.onClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watched]);

  const remaining = code
    ? Math.max(0, Math.ceil((new Date(code.expiresAt).getTime() - now) / 1000))
    : 0;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) props.onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pair another PC</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {!code ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Generating code…
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                Read this 6-digit code to the other operator. They open
                <span className="font-medium"> Settings → Connections </span>
                on their PC, click <span className="font-medium">Enter a code</span>, and type it in.
              </p>
              <div className="text-center py-4 bg-muted/30 rounded">
                <div className="font-mono text-4xl tracking-widest font-semibold">
                  {formatCode(code.code)}
                </div>
                <div className={`text-xs mt-2 ${remaining <= 30 ? "text-rose-300" : "text-muted-foreground"}`}>
                  {remaining > 0 ? `Expires in ${remaining}s` : "Expired"}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Single-use. The code becomes invalid the moment the other side enters it,
                or after 5 minutes — whichever comes first.
              </p>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Join modal ───────────────────────────────────────────────────────
function JoinCodeDialog(props: {
  onClose: () => void;
  joiner: {
    pcId: string;
    tier: PcTier;
    squadron: string | null;
    userDisplay: string | null;
    userSeat: string | null;
    userId: string | null;
  };
}) {
  const redeem = useRedeemCode();
  const { toast } = useToast();
  const [raw, setRaw] = useState("");
  const numeric = useMemo(() => raw.replace(/\D/g, "").slice(0, 6), [raw]);

  const submit = async () => {
    if (numeric.length !== 6) return;
    try {
      const r = await redeem.mutateAsync({
        rawCode: numeric,
        joinerPcId: props.joiner.pcId,
        joinerTier: props.joiner.tier,
        joinerSquadron: props.joiner.squadron,
        joinerUserDisplay: props.joiner.userDisplay,
        joinerUserSeat: props.joiner.userSeat,
        joinerUserId: props.joiner.userId,
      });
      toast({
        title: "Paired",
        description: `${r.hostUserDisplay ?? r.hostPcId}${r.hostSquadron ? ` (${r.hostSquadron})` : ""}`,
      });
      props.onClose();
    } catch (e) {
      toast({ title: "Could not pair", description: (e as Error).message, variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) props.onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enter pairing code</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Type the 6-digit code shown on the other PC. Hyphens are optional.
          </p>
          <Input
            autoFocus
            value={formatCode(numeric.padEnd(6, " ")).trim()}
            onChange={(e) => setRaw(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && numeric.length === 6) submit(); }}
            placeholder="00-00-00"
            className="font-mono text-lg tracking-widest text-center"
            maxLength={8}
          />
          <p className="text-xs text-muted-foreground">
            Codes expire 5 minutes after they are issued. If you get
            "code not recognised", confirm both PCs are pointed at the same
            {isLanSessionLoginEnabled() ? " LAN backend" : " backend"} (open the Diagnostic page on each).
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button disabled={numeric.length !== 6 || redeem.isPending} onClick={submit}>
            {redeem.isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Pairing…</> : "Pair"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
