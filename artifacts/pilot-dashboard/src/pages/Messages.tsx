import { useMemo, useState } from "react";
import { Card, PageHead } from "@/components/Layout";
import { useAuth } from "@/lib/auth";
import { seatLabelFromRoleScope, composeIdentityLabel } from "@/lib/types";
import {
  useMessages,
  useSendMessage,
  useMarkMessageRead,
  useRegisteredPCsIncludingStale,
  isPcActive,
  getMessageRetentionDays,
  setMessageRetentionDays,
  MESSAGE_RETENTION_MAX_DAYS,
  canUseMessages,
  getLocalPcId,
  getFlightBinding,
  squadronNameMatches,
  getHeartbeatStatus,
  subscribeHeartbeatStatus,
  type MessagePriority,
  type PrivateMessage,
} from "@/lib/cross-pc";
import { Link } from "wouter";
import { useEffect } from "react";
import { useToast } from "@/hooks/use-toast";
import { fmtDateTimeDDMM } from "@/lib/format";
import { Mail, Send, Reply, Check, AlertOctagon, Settings, Activity, UserCog } from "lucide-react";

// User-facing labels: keep the DB enum (normal/medium/urgent) but show
// the operator's preferred wording (Normal / High / Very High) and the
// agreed colour scheme — green / yellow / red.
const priorityLabels: Record<MessagePriority, string> = {
  normal: "Normal",
  medium: "High",
  urgent: "Very High",
};

// "Seen" / read-receipt is only meaningful for the chain of command the
// operator described: inside a single squadron (Flight Cmdr ↔ Squadron
// Cmdr) and between a Squadron Cmdr and the Wing Cmdr that monitors
// them. Anything involving a Base PC — or any other tier pair — keeps
// the message visible but hides the seen UI on both ends.
function seenAllowed(m: PrivateMessage): boolean {
  const a = m.fromTier;
  const b = m.toTier;
  if (a === "squadron" && b === "squadron") return true;
  if (a === "squadron" && b === "wing")     return true;
  if (a === "wing"     && b === "squadron") return true;
  // Flight Commander ↔ bound Squadron Commander is treated as the same
  // chain-of-command pair as squadron↔squadron for read-receipt purposes.
  if (a === "flight"   && b === "squadron") return true;
  if (a === "squadron" && b === "flight")   return true;
  return false;
}
const priorityClasses: Record<MessagePriority, string> = {
  normal: "bg-emerald-500/15 text-emerald-200 border-emerald-500/40",
  medium: "bg-amber-400/20 text-amber-100 border-amber-400/40",
  urgent: "bg-rose-500/20 text-rose-100 border-rose-400/40",
};

export default function Messages() {
  const { user, squadron } = useAuth();
  const { toast } = useToast();
  const allowed = canUseMessages(user?.role, user?.scope);
  const myTier: "flight" | "squadron" | "wing" | "base" =
    user?.scope === "wing" ? "wing"
    : user?.scope === "base" ? "base"
    : user?.scope === "flight" ? "flight"
    : "squadron";
  const isFlightCmdr = user?.role === "commander" && user?.scope === "flight";
  const flightBinding = isFlightCmdr ? getFlightBinding() : null;
  // Use the canonical PC id written by registerLocalPC (squadron name for
  // squadron tier, "WING:..." / "BASE:..." for commander tiers) so both
  // the writer (sender) and the reader (recipient inbox filter) agree.
  const canonicalId = getLocalPcId();
  const fallbackId = myTier === "squadron"
    ? (squadron?.name ?? user?.username ?? "")
    : `${myTier.toUpperCase()}:${squadron?.name ?? user?.username ?? user?.displayName ?? "CMD"}`;
  const myPcId = canonicalId || fallbackId || null;
  const myPcName = squadron?.name ?? user?.displayName ?? "Local PC";

  // v1.1.110 (task #134) — pull stale (90 s – 24 h) PCs into the
  // picker so the operator can see and choose them. The row is
  // marked stale in the dropdown label and a yellow toast fires on
  // send, but the operator is no longer dead-ended by a brief
  // heartbeat lapse on the recipient PC.
  const registry = useRegisteredPCsIncludingStale();
  // Re-render the compose surface whenever the heartbeat status
  // changes so the "Show error" disclosure picks up new failures
  // without waiting for the next user interaction.
  const [, setHbTick] = useState(0);
  useEffect(() => subscribeHeartbeatStatus(() => setHbTick(x => x + 1)), []);
  const inbox = useMessages(myPcId);
  const send = useSendMessage();
  const markRead = useMarkMessageRead();

  const [tab, setTab] = useState<"inbox" | "sent" | "history" | "compose" | "settings">("inbox");
  const [composeTo, setComposeTo] = useState<string>("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<MessagePriority>("normal");
  const [replyTo, setReplyTo] = useState<PrivateMessage | null>(null);
  const [retention, setRetention] = useState(getMessageRetentionDays());

  // Private messages are limited to Squadron / Wing / Base PCs — HQ
  // and any other tiers are excluded from both the recipient picker
  // and the inbox filter. Flight Commander PCs may only message their
  // bound Squadron Commander, so the picker collapses to that one row.
  // Squadron commanders officially link specific flight commander PCs in
  // their squadron at setup time (see LicenseKeys.tsx Setup dialog). Those
  // IDs are persisted to localStorage on this PC so the Messages picker can
  // surface them as extra private-message counterparts — otherwise flight
  // tiers are excluded by the base filter below.
  const linkedFlightPcIds = useMemo<string[]>(() => {
    try {
      const raw = localStorage.getItem("rjaf.linkedFlightPcIds");
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }, []);

  const selectablePCs = useMemo(
    () => {
      // Hide PCs that haven't reported in 30 days. Without this filter the
      // recipient picker grows unbounded as PCs are reinstalled / retired
      // and would become unusable at 100+ deployments. Linked-flight PCs
      // bypass the staleness filter so a freshly-reimaged flight PC is
      // never invisible to its own squadron commander while it warms up.
      // v1.1.73: tighten the recipient picker to PCs whose heartbeat is
      // within the 90 s active window — operators can never address a
      // PC that has actually gone offline. Threshold lives in
      // cross-pc.ts (see isPcActive()). Existing inbox / sent threads
      // with now-inactive PCs keep rendering with an "Offline" badge —
      // only the composer side is gated. Linked-flight bindings still
      // bypass the active filter so a freshly reimaged flight PC stays
      // addressable.
      // task #134: relax the 90 s gate — stale PCs (between 90 s and
      // 24 h) are now KEPT in the picker so the operator can still
      // address them. The dropdown row marks them with a grey dot
      // and a yellow warning fires on send. Truly-dead PCs (>24 h)
      // are excluded server-side by useRegisteredPCsIncludingStale.
      const base = registry.data.filter(
        p => !p.isSelf && (
          p.tier === "squadron" || p.tier === "wing" || p.tier === "base" || p.tier === "flight"
        ),
      ).sort((a, b) => {
        // Sort by tier (base → wing → squadron → flight) then by displayed
        // name so finding a specific PC in a 100-row dropdown is fast.
        const tierOrder = { base: 0, wing: 1, squadron: 2, flight: 3 } as const;
        const ta = tierOrder[a.tier as keyof typeof tierOrder] ?? 9;
        const tb = tierOrder[b.tier as keyof typeof tierOrder] ?? 9;
        if (ta !== tb) return ta - tb;
        return (a.deviceName || a.squadronName).localeCompare(b.deviceName || b.squadronName);
      });
      if (isFlightCmdr && flightBinding) {
        // v1.1.30: a Flight Cmdr PC was previously locked to messaging
        // ONLY the PC it was bound to (the Ops PC, since Ops is the
        // squadron anchor). That meant the squadron commander could
        // never be reached from the flight commander's PC even though
        // both PCs sit in the same squadron group. Widen the picker so
        // the Flight Cmdr can message every squadron-tier PC that
        // belongs to the same squadron as the bound Ops PC — that
        // surfaces both the Ops PC and the Squadron Commander PC.
        // Names are normalised the same way the LicenseKeys setup
        // dialog matches them (lowercase + strip non-alphanumeric, plus
        // a substring + bare-number fallback), so spelling drift like
        // "NO.8" vs "no 8" vs "8 SQN" still groups correctly.
        const boundPc = registry.data.find(p => p.id === flightBinding.pcId);
        // v1.1.34 / task #134: when the Ops PC is fully shut down and
        // its registry row hasn't synced to this Flight PC yet,
        // `boundPc` is undefined — fall back to this Flight PC's own
        // squadron name from the auth context. Squadron-name
        // comparison is now routed through the shared
        // squadronNameMatches() helper so spelling drift like "NO.8"
        // vs "no 8" vs "8 SQN" vs "8 SQDN" still groups correctly
        // (single source of truth in cross-pc.ts).
        const opsSqName = boundPc?.squadronName ?? squadron?.name ?? "";
        const filtered = base.filter(p =>
          // Always include the bound Ops PC even if registry doesn't
          // show it (defensive — the binding is the source of truth).
          p.id === flightBinding.pcId
          // Plus every squadron-tier PC sharing the bound squadron —
          // picks up the Squadron Commander PC alongside the Ops PC.
          || (p.tier === "squadron" && squadronNameMatches(p.squadronName, opsSqName))
        );
        // v1.1.108 forgiving fallback (ported from FlightProgram.tsx):
        // when the strict Flight-Cmdr filter still yields zero rows,
        // surface every non-self PC the registry knows about so the
        // operator can pick manually rather than be dead-ended. The
        // submit-time same-squadron guard still applies so a Flight
        // Cmdr cannot accidentally message outside their bound
        // squadron — this only affects what they SEE.
        if (filtered.length === 0) {
          return {
            list: registry.data
              .filter(p => !p.isSelf)
              .sort((a, b) => (a.deviceName || a.squadronName).localeCompare(b.deviceName || b.squadronName)),
            usingFallback: true,
          };
        }
        return { list: filtered, usingFallback: false };
      }
      return { list: base, usingFallback: false };
    },
    [registry.data, isFlightCmdr, flightBinding?.pcId, linkedFlightPcIds],
  );
  const usingFlightFallback = selectablePCs.usingFallback;
  // v1.1.73: previously a "show every non-self PC" fallback fired when
  // the strict tier filter yielded zero rows, so an operator could
  // still pick someone manually. That fallback is removed because it
  // re-introduced offline PCs into the picker and violated the
  // single-source active rule. With the picker empty, the operator
  // must use a "By role" logical seat — those are virtual and route
  // to whoever's actually online next.
  const effectiveSelectablePCs = selectablePCs.list;
  // Set of every PC id the local registry currently considers active
  // (heartbeat in the last 90 s). Passed into MessageList so existing
  // threads with a now-inactive counterpart can render an "Offline"
  // badge — the message itself is never hidden or removed on
  // disconnect, only annotated.
  const activePcIds = useMemo(
    () => new Set(registry.data.filter(isPcActive).map(p => p.id)),
    [registry.data],
  );

  if (!allowed) {
    return (
      <div>
        <PageHead title="Messages" />
        <Card>
          <div className="text-sm text-muted-foreground py-6 text-center">
            Private messages are reserved for Squadron, Wing and Base tiers.
          </div>
        </Card>
      </div>
    );
  }

  const composeReset = () => {
    setComposeTo(""); setSubject(""); setBody(""); setPriority("normal"); setReplyTo(null);
  };

  // v1.1.45: virtual logical-seat recipients. The operator can address
  // a TIER+SQUADRON seat (e.g. "Any Flight Cmdr in NO.8") even when no
  // such PC has registered itself yet. The message ships with toPcId =
  // "FLIGHT:<sqn>" (no suffix) and the v1.1.44 logical-seat matcher on
  // the receiving PC catches it because their myLogicalSeat strips the
  // "#<deviceSuffix>" tail.
  const sqName = squadron?.name ?? "";
  const logicalSeatTargets = useMemo(() => {
    if (!sqName) return [] as Array<{ id: string; label: string; tier: "flight"|"squadron"|"wing"|"base" }>;
    const out: Array<{ id: string; label: string; tier: "flight"|"squadron"|"wing"|"base" }> = [];
    if (myTier === "squadron" || myTier === "wing" || myTier === "base") {
      out.push({ id: `FLIGHT:${sqName}`, label: `Any Flight Cmdr in ${sqName}`, tier: "flight" });
    }
    if (myTier === "flight") {
      out.push({ id: `SQDNCMD:${sqName}`, label: `Squadron Cmdr of ${sqName}`, tier: "squadron" });
      out.push({ id: sqName, label: `Squadron Ops PC (${sqName})`, tier: "squadron" });
    }
    return out;
  }, [sqName, myTier]);

  const submitSend = async () => {
    if (!composeTo) { toast({ title: "Pick a recipient PC", variant: "destructive" }); return; }
    if (!subject.trim() || !body.trim()) { toast({ title: "Subject and body required", variant: "destructive" }); return; }
    const realTarget = registry.data.find(p => p.id === composeTo);
    const seatTarget = logicalSeatTargets.find(s => s.id === composeTo);
    // v1.1.73: belt-and-braces submit-time guard. The recipient is
    // considered offline when its id is neither a logical seat nor in
    // the active-PC set (server-side filter already trims stale rows
    // out of registry, so a composeTo that refers to a PC missing
    // from registry is necessarily offline — covers replies to a PC
    // that has since dropped). Logical seats are virtual and bypass.
    // task #134: stale recipients (90 s – 24 h) are no longer dead-
    // ended. If the picked PC is in the registry but stale, warn the
    // operator with a yellow toast and proceed — the message will
    // queue locally / land when the PC's heartbeat resumes. Truly
    // unknown PCs (not even in the 24 h registry) still hard-block.
    if (composeTo && !seatTarget && !realTarget) {
      toast({
        title: "Recipient not found",
        description: "That PC has not been seen in the last 24 hours. Pick another recipient or use a 'By role' option above.",
        variant: "destructive",
      });
      return;
    }
    if (composeTo && realTarget && !seatTarget && !activePcIds.has(composeTo)) {
      toast({
        title: "Recipient is stale",
        description: "No heartbeat in the last 90 seconds — sending anyway. The message will queue and deliver once their PC reconnects.",
        variant: "default",
        className: "bg-amber-500/15 border-amber-500/40 text-amber-100",
      });
    }
    if (!realTarget && !seatTarget) { toast({ title: "Recipient not found", variant: "destructive" }); return; }
    const target = realTarget ?? {
      id: seatTarget!.id,
      squadronName: seatTarget!.label,
      tier: seatTarget!.tier,
    } as { id: string; squadronName: string; tier: "flight"|"squadron"|"wing"|"base" };
    if (target.tier !== "squadron" && target.tier !== "wing" && target.tier !== "base" && target.tier !== "flight") {
      toast({ title: "Messages restricted to Flt/Sqn/Wing/Base only", variant: "destructive" });
      return;
    }
    if (isFlightCmdr && flightBinding && !seatTarget) {
      // v1.1.31: Flight Cmdr may message the bound Ops PC OR any
      // squadron-tier PC inside the same squadron (the Squadron Cmdr
      // PC). Anything outside that scope (other squadrons, wing/base,
      // unrelated flight PCs) stays blocked. Mirrors the picker's own
      // selectablePCs filter so what the operator can SEE matches
      // what the send guard accepts.
      const boundPc = registry.data.find(p => p.id === flightBinding.pcId);
      // task #134: route same-squadron comparison through the shared
      // squadronNameMatches() helper so picker and submit guard agree
      // (they used to maintain two near-identical normalisers that
      // could silently drift).
      const opsSqName = boundPc?.squadronName ?? squadron?.name ?? "";
      const isBound = target.id === flightBinding.pcId;
      const isSquadronPeer = target.tier === "squadron" && squadronNameMatches(target.squadronName, opsSqName);
      if (!isBound && !isSquadronPeer) {
        toast({ title: "Flight Commander may only message PCs in the bound squadron", variant: "destructive" });
        return;
      }
    }
    await send.mutateAsync({
      threadId: replyTo?.threadId,
      fromPcId: myPcId ?? "self",
      fromPcName: myPcName,
      fromTier: myTier,
      fromUser: user?.username ?? "ops",
      fromDisplayName: user?.displayName,
      fromRank: user?.rank,
      fromSeatLabel: seatLabelFromRoleScope(user?.role, user?.scope),
      toPcId: target.id,
      toPcName: target.squadronName,
      toTier: target.tier,
      subject: subject.trim(),
      body: body.trim(),
      priority,
    });
    if (replyTo) {
      await markRead.mutateAsync({ id: replyTo.id });
    }
    toast({ title: "Message sent" });
    composeReset();
    setTab("sent");
  };

  const startReply = (m: PrivateMessage) => {
    setReplyTo(m);
    setComposeTo(m.fromPcId);
    setSubject(m.subject.startsWith("Re:") ? m.subject : `Re: ${m.subject}`);
    setBody("");
    setPriority(m.priority);
    setTab("compose");
  };

  const tabs = [
    { id: "inbox" as const, label: `Inbox (${inbox.inbox.length})`, icon: Mail },
    { id: "sent" as const, label: "Sent", icon: Send },
    { id: "history" as const, label: "History", icon: Check },
    { id: "compose" as const, label: replyTo ? "Reply" : "Compose", icon: Send },
    { id: "settings" as const, label: "Settings", icon: Settings },
  ];

  return (
    <div>
      <PageHead title="Messages" subtitle="Sqn ↔ Wing ↔ Base · text only · auto-deletes after retention window" />
      <div className="flex gap-2 mb-3 flex-wrap">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-md text-xs font-semibold border inline-flex items-center gap-1.5 ${
              tab === t.id ? "bg-primary text-primary-foreground border-primary" : "bg-secondary border-border"
            }`}
            data-testid={`tab-${t.id}`}
          >
            <t.icon className="h-3.5 w-3.5" />{t.label}
          </button>
        ))}
      </div>

      {tab === "inbox" && <MessageList items={inbox.inbox} onReply={startReply} onMark={(m) => markRead.mutateAsync({ id: m.id }).then(() => toast({ title: "Marked read" }))} myPcId={myPcId} kind="inbox" activePcIds={activePcIds} />}
      {tab === "sent" && <MessageList items={inbox.sent} myPcId={myPcId} kind="sent" activePcIds={activePcIds} />}
      {tab === "history" && <MessageList items={inbox.history} myPcId={myPcId} kind="history" activePcIds={activePcIds} />}

      {tab === "compose" && (
        <Card>
          <div className="space-y-3">
            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Recipient PC</label>
              <select
                value={composeTo}
                onChange={e => setComposeTo(e.target.value)}
                className="w-full mt-1 px-3 py-1.5 rounded-md bg-input border border-border text-sm"
                data-testid="select-recipient"
              >
                <option value="">— pick a registered PC or logical seat —</option>
                {logicalSeatTargets.length > 0 && (
                  <optgroup label="By role (delivers to whoever is signed in)">
                    {logicalSeatTargets.map(s => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </optgroup>
                )}
                <optgroup label={`Registered PCs (${effectiveSelectablePCs.length})`}>
                  {effectiveSelectablePCs.map(p => {
                    const active = isPcActive(p);
                    // task #134: stale rows (older than 90 s but within
                    // 24 h) stay selectable. The label includes a grey
                    // "●" dot, the literal word "stale", and a relative
                    // "last seen Xm ago" so operators can judge how
                    // long ago the recipient was reachable. Screen
                    // readers get the same info via aria-label so
                    // visually-impaired users aren't disadvantaged.
                    const ageLbl = !active ? ` — last seen ${relativeAge(p.lastSeen)}` : "";
                    const lbl = active ? " · online" : ` · ● stale${ageLbl}`;
                    const aria = active
                      ? `${p.deviceName || p.squadronName}, ${p.tier}, online`
                      : `${p.deviceName || p.squadronName}, ${p.tier}, stale, last seen ${relativeAge(p.lastSeen)}`;
                    return (
                      <option key={p.id} value={p.id} aria-label={aria}>
                        {p.deviceName || p.squadronName} · {p.tier}{lbl}
                      </option>
                    );
                  })}
                </optgroup>
              </select>
              {usingFlightFallback && (
                <p
                  className="text-[11px] text-amber-300 mt-1 border border-amber-500/40 bg-amber-500/10 rounded-md px-2 py-1"
                  data-testid="text-fallback-warning"
                  role="alert"
                >
                  Showing every registered PC because no exact match was found — pick carefully.
                </p>
              )}
              {effectiveSelectablePCs.length === 0 && (
                <DeadEndGate
                  hb={getHeartbeatStatus()}
                  myTier={myTier}
                  logicalSeatTargets={logicalSeatTargets}
                  onPickSeat={(id) => { setComposeTo(id); }}
                />
              )}
              <p className="text-[11px] text-muted-foreground mt-1">
                Registry on this PC: {registry.data.length} PC(s) total
                {registry.data.length > 0 && (
                  <> · {registry.data.filter(p => p.tier === "flight").length} flight, {registry.data.filter(p => p.tier === "squadron").length} squadron, {registry.data.filter(p => p.tier === "wing").length} wing, {registry.data.filter(p => p.tier === "base").length} base</>
                )}
              </p>
              {composeTo && (() => {
                // task #134: stale recipients (no heartbeat in 90 s
                // but seen in the last 24 h) are now allowed — show
                // a non-blocking yellow note explaining the message
                // will queue. Truly-unknown recipients still get a
                // red blocker note (Send button is disabled below).
                const seat = logicalSeatTargets.find(s => s.id === composeTo);
                if (seat) return null;
                const sel = effectiveSelectablePCs.find(p => p.id === composeTo);
                if (sel && isPcActive(sel)) return null;
                if (sel) {
                  return (
                    <p className="text-[11px] text-amber-700 dark:text-amber-300 mt-1" data-testid="text-stale-warning">
                      This PC is stale (no heartbeat in the last 90 s, but seen in the last 24 h). Sending is allowed — the message will queue and deliver once their PC reconnects.
                    </p>
                  );
                }
                return (
                  <p className="text-[11px] text-rose-700 dark:text-rose-300 mt-1">
                    This recipient has not been seen in the last 24 h — pick another recipient or use a "By role" option above.
                  </p>
                );
              })()}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div>
                <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Subject</label>
                <input value={subject} onChange={e => setSubject(e.target.value)} className="w-full mt-1 px-3 py-1.5 rounded-md bg-input border border-border text-sm" data-testid="input-subject" />
              </div>
              <div>
                <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Priority</label>
                <div className="flex gap-2 mt-1">
                  {(["normal", "medium", "urgent"] as const).map(p => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPriority(p)}
                      className={`flex-1 px-2 py-1.5 rounded-md text-xs font-semibold border capitalize ${
                        priority === p ? priorityClasses[p] : "bg-secondary border-border text-muted-foreground"
                      }`}
                      data-testid={`priority-${p}`}
                    >
                      {p === "urgent" && <AlertOctagon className="h-3 w-3 inline mr-1" />}{priorityLabels[p]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wider text-muted-foreground">Message (text only)</label>
              <textarea
                value={body}
                onChange={e => setBody(e.target.value)}
                rows={6}
                className="w-full mt-1 px-3 py-1.5 rounded-md bg-input border border-border text-sm font-mono"
                data-testid="input-body"
              />
            </div>
            <div className="flex gap-2">
              {(() => {
                // Block Send when the chosen recipient is a real PC
                // whose heartbeat has lapsed (>90 s). Logical-seat
                // targets are virtual and always allowed. The check
                // runs against `activePcIds` rather than the picker's
                // own selectable list so a Reply targeting a PC that
                // has since dropped off the registry (server-side
                // active-window filter excludes it) is still
                // recognised as offline and the button stays disabled.
                const seat = logicalSeatTargets.find(s => s.id === composeTo);
                // task #134: only hard-block when the recipient is
                // genuinely unknown (not in the 24 h registry AND not
                // a logical seat). Stale-but-seen recipients submit
                // through with a yellow toast.
                const knownInRegistry = !!composeTo && registry.data.some(p => p.id === composeTo);
                const recipientUnknown = !!composeTo && !seat && !knownInRegistry;
                return (
                  <button
                    onClick={submitSend}
                    disabled={send.isPending || recipientUnknown}
                    title={recipientUnknown ? "Recipient PC has not been seen in the last 24 h — cannot send" : undefined}
                    className="px-4 py-2 rounded-md bg-primary text-primary-foreground font-semibold inline-flex items-center gap-2 disabled:opacity-50"
                    data-testid="button-send"
                  >
                    <Send className="h-4 w-4" /> Send
                  </button>
                );
              })()}
              <button onClick={composeReset} className="px-4 py-2 rounded-md bg-secondary border border-border text-sm">Clear</button>
            </div>
          </div>
        </Card>
      )}

      {tab === "settings" && (
        <Card>
          <div className="space-y-3">
            <div className="text-sm font-semibold">Auto-delete window</div>
            <div className="text-xs text-muted-foreground">
              Messages are purged automatically after this many days. Hard ceiling: {MESSAGE_RETENTION_MAX_DAYS} days.
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                max={MESSAGE_RETENTION_MAX_DAYS}
                value={retention}
                onChange={e => setRetention(Number(e.target.value))}
                className="w-24 px-3 py-1.5 rounded-md bg-input border border-border text-sm"
                data-testid="input-retention"
              />
              <span className="text-xs text-muted-foreground">days</span>
              <button
                onClick={() => { setMessageRetentionDays(retention); setRetention(getMessageRetentionDays()); toast({ title: "Retention saved" }); }}
                className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold"
                data-testid="button-save-retention"
              >Save</button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

// Dead-end replacement (task #134). When the picker has no recipients
// AND there are no logical-seat targets either, the operator used to
// see a single line of amber text and a disabled Send button. Replace
// that with three actionable cards so they always have a next step:
//
//   1. Diagnose — link to /diagnostic so the operator can see WHY
//      their PC isn't seeing other PCs (heartbeat error, RLS, no
//      Supabase config, etc.).
//   2. Send by role — explains the "By role" path and points at the
//      logical-seat picker above (covers wing/base operators when
//      no flight PCs are online yet).
//   3. Show error — collapsible details panel with the verbatim last
//      heartbeat error so they can copy-paste it to support.
// Render a relative-age suffix like "12s ago" / "4m ago" / "2h ago"
// for a stale PC's lastSeen timestamp. Used in the picker label and
// aria-label so operators can judge how stale a recipient is at a
// glance (a 91-second lag is very different from a 4-hour lag).
function relativeAge(lastSeen: string): string {
  const ms = Date.now() - new Date(lastSeen).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function DeadEndGate({
  hb,
  myTier,
  logicalSeatTargets,
  onPickSeat,
}: {
  hb: ReturnType<typeof getHeartbeatStatus>;
  myTier: "flight" | "squadron" | "wing" | "base";
  logicalSeatTargets: Array<{ id: string; label: string; tier: "flight"|"squadron"|"wing"|"base" }>;
  onPickSeat: (id: string) => void;
}) {
  const [showErr, setShowErr] = useState(false);
  const seatsAvailable = logicalSeatTargets.length > 0;
  return (
    <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2" data-testid="messages-dead-end">
      <Link
        href={myTier === "flight" || myTier === "squadron" ? "/diagnostic" : "/dashboard/diagnostic"}
        className="rounded-md border border-border bg-secondary/40 p-3 hover:bg-secondary/60 transition"
        data-testid="dead-end-diagnose"
      >
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <Activity className="h-3.5 w-3.5" /> Diagnose
        </div>
        <div className="text-[11px] text-muted-foreground mt-1">
          Open the diagnostic page to see why this PC isn't seeing the other PCs (heartbeat / RLS / config).
        </div>
      </Link>
      <button
        type="button"
        onClick={seatsAvailable ? () => onPickSeat(logicalSeatTargets[0].id) : undefined}
        disabled={!seatsAvailable}
        className="text-left rounded-md border border-border bg-secondary/40 p-3 hover:bg-secondary/60 transition disabled:opacity-50 disabled:cursor-not-allowed"
        data-testid="dead-end-by-role"
        title={seatsAvailable
          ? `Auto-select "${logicalSeatTargets[0].label}" so the message routes to whoever signs in for that seat`
          : "No logical-seat targets are available for your role"}
      >
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <UserCog className="h-3.5 w-3.5" /> Send by role anyway
        </div>
        <div className="text-[11px] text-muted-foreground mt-1">
          {seatsAvailable
            ? <>Click to address <em>{logicalSeatTargets[0].label}</em> — the message routes to whoever signs in for that seat.</>
            : "No logical-seat targets are available — wait for another PC to register, or use Diagnose."}
        </div>
      </button>
      <button
        type="button"
        onClick={() => setShowErr(v => !v)}
        className="text-left rounded-md border border-border bg-secondary/40 p-3 hover:bg-secondary/60 transition"
        data-testid="dead-end-show-error"
      >
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <AlertOctagon className="h-3.5 w-3.5" /> {showErr ? "Hide error" : "Show error"}
        </div>
        <div className="text-[11px] text-muted-foreground mt-1">
          {hb.errorMsg
            ? "View the last cross-PC heartbeat error verbatim."
            : "No recent heartbeat error recorded — registry may simply be empty on this network."}
        </div>
        {showErr && hb.errorMsg && (
          <pre className="mt-2 whitespace-pre-wrap break-words text-[10px] font-mono text-rose-300 bg-black/30 p-2 rounded border border-rose-500/30">
            {hb.errorMsg}
          </pre>
        )}
      </button>
    </div>
  );
}

function MessageList({ items, onReply, onMark, myPcId, kind, activePcIds }: {
  items: PrivateMessage[];
  onReply?: (m: PrivateMessage) => void;
  onMark?: (m: PrivateMessage) => void;
  myPcId: string | null;
  kind: "inbox" | "sent" | "history";
  // Set of PC ids whose heartbeat is within the 90 s active window.
  // Used to render an "Offline" badge on existing messages whose
  // counterpart PC has gone quiet — the message itself stays visible
  // and readable (read-only history, never deleted on disconnect).
  activePcIds: ReadonlySet<string>;
}) {
  if (items.length === 0) {
    return (
      <Card>
        <div className="text-sm text-muted-foreground text-center py-8">No messages.</div>
      </Card>
    );
  }
  return (
    <div className="space-y-2">
      {items.map(m => {
        // Read-receipt UI is only available on the chain-of-command pairs
        // the operator authorised: squadron-internal (Sqn Cmdr ↔ Flight
        // Cmdr) and Squadron Cmdr ↔ Wing Cmdr (either direction).
        const seenOK = seenAllowed(m);
        // Render "User · PC" so it's instantly clear who is talking from
        // which PC. The username comes from the sender's own login.
        // Task #137: prefer the rich identity (rank + display name +
        // seat label + PC name) when the row carries it; fall back to
        // the legacy "user · pc" pair for messages written before
        // migration 0039.
        const fromLabel = composeIdentityLabel({
          rank: m.fromRank,
          displayName: m.fromDisplayName,
          username: m.fromUser,
          seatLabel: m.fromSeatLabel,
          pcName: m.fromPcName,
        }) || `${m.fromUser} · ${m.fromPcName}`;
        const toLabel   = `${m.toPcName}`;
        // The "counterpart" is whichever PC is on the other end of this
        // message — for inbox/history rows that's the sender, for sent
        // rows it's the recipient. If their heartbeat has lapsed we
        // surface an "Offline" pill so the operator knows they can read
        // the thread but cannot expect a live reply right now.
        const counterpartId = kind === "sent" ? m.toPcId : m.fromPcId;
        const counterpartOffline = !!counterpartId && !activePcIds.has(counterpartId);
        return (
          <Card key={m.id} className={`!p-3 border-l-4 ${
            m.priority === "urgent" ? "border-l-rose-400"
            : m.priority === "medium" ? "border-l-amber-400"
            : "border-l-emerald-500/60"
          }`} data-testid={`msg-${m.id}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold truncate">{m.subject}</div>
                <div className="text-[11px] text-muted-foreground">
                  {kind === "sent" ? `to ${toLabel}` : `from ${fromLabel}`} · {fmtDateTimeDDMM(m.sentAt)}
                  {/* Read-receipt line — only rendered for the authorised
                      chain-of-command pairs. On every other PC pair the
                      message still appears, just without the seen UI. */}
                  {seenOK && (
                    m.readAt
                      ? (kind === "sent"
                          ? ` · seen by ${m.toPcName} ${fmtDateTimeDDMM(m.readAt)}`
                          : ` · seen ${fmtDateTimeDDMM(m.readAt)}`)
                      : (kind === "sent" ? " · not seen yet" : "")
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {counterpartOffline && (
                  <span
                    className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border border-zinc-500/40 bg-zinc-500/10 text-zinc-400"
                    title="Counterpart PC has not sent a heartbeat in the last 90 seconds. The thread is still readable, but you cannot send to this PC right now."
                    data-testid={`offline-${m.id}`}
                  >Offline</span>
                )}
                <span className={`text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border ${priorityClasses[m.priority]}`}>{priorityLabels[m.priority]}</span>
              </div>
            </div>
            <div className="text-sm mt-2 whitespace-pre-wrap font-mono">{m.body}</div>
            {(onReply || onMark) && m.toPcId === myPcId && (
              <div className="flex gap-2 mt-2">
                {onReply && (
                  <button onClick={() => onReply(m)} className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded bg-secondary border border-border" data-testid={`reply-${m.id}`}>
                    <Reply className="h-3 w-3" /> Reply
                  </button>
                )}
                {onMark && seenOK && !m.readAt && (
                  <button onClick={() => onMark(m)} className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-200 font-semibold" data-testid={`mark-${m.id}`}>
                    <Check className="h-3 w-3" /> Mark Seen
                  </button>
                )}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
