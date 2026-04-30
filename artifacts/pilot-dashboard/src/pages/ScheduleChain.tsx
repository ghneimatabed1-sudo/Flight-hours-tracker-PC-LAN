import { useEffect, useMemo, useState } from "react";
import DateInput from "@/components/DateInput";
import { Card, PageHead } from "@/components/Layout";
import { useAuth } from "@/lib/auth";
import { seatLabelFromRoleScope, composeIdentityLabel } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { preferredSchedulePilotName } from "@/lib/schedule-names";
import { fetchInternalPilotOptions } from "@/lib/internal-migration";
import {
  useScheduleShares,
  useSubmitSchedule,
  useDecideSchedule,
  useAcceptScheduleEdit,
  useDismissScheduleShareForOriginator,
  useDeleteScheduleShare,
  useRegisteredPCs,
  isPcActive,
  diffSchedule,
  canUseScheduleChain,
  getLocalPcId,
  makePcMatcher,
  squadronColor,
  type ScheduleRow,
  type ScheduleShare,
  type ScheduleProgram,
  type ScheduleProgramRow,
} from "@/lib/cross-pc";
import { useToast } from "@/hooks/use-toast";
import { usePilots } from "@/lib/squadron-data";
import FlightScheduleSheet from "@/components/FlightScheduleSheet";
import { Send, Check, X, PauseCircle, Pencil, Plus, Printer, Trash2 } from "lucide-react";

// v1.1.107 — reverse of programToShareRows. When a Flight Cmdr (or
// any tier) composes a schedule via the ScheduleChain quick-row
// composer, we also populate a minimal ScheduleProgram so the share
// surfaces in the FlightProgram inbox too. Without this, Ops (or
// whoever the sheet is addressed to) only sees the share in the
// Schedule Chain sidebar — the Flight Schedule sidebar filter
// requires `!!s.program` and silently drops rows-only shares.
// Operator's exact words: "if I wrote a flight schedule on the Flight
// Commander interface, it will show up on the ScheduleChain of the
// operation pilot PC. It does not show up in the flight schedule
// sidebar option." This helper closes that gap.
function rowsToProgram(rows: ScheduleRow[], date: string, squadronName: string): ScheduleProgram {
  const toProgramRow = (r: ScheduleRow): ScheduleProgramRow => {
    // row.ac is "ACTYPE DN" (see programToShareRows below). Split off
    // the DN tag if present so the paper sheet gets a clean acType.
    const acParts = (r.ac || "").trim().split(/\s+/);
    const acType = acParts[0] ?? "";
    return {
      dn: r.dn || "D",
      acType,
      toTime: r.takeoff || "",
      pilot: r.crew?.[0] ?? "",
      coPilot: r.crew?.[1] ?? "",
      msnDuty: r.mission || "",
      duration: r.dur || "",
      fuel: r.fuel || "",
      configuration: r.config || "",
      route: r.route || "",
      remarks: r.remarks || "",
      atcTakeoff: r.atcTakeoff || r.takeoff || "",
      atcLanding: r.atcLanding || r.land || "",
    };
  };
  const dayRows = rows.filter(r => (r.dn || "D") === "D").map(toProgramRow);
  const nightRows = rows.filter(r => (r.dn || "D") !== "D").map(toProgramRow);
  return {
    date,
    mode: nightRows.length > 0 && dayRows.length > 0 ? "DAY_AND_NIGHT" : nightRows.length > 0 ? "NIGHT" : "DAY",
    airbase: "",
    squadron: squadronName,
    dayRows: dayRows.length > 0 ? dayRows : [],
    nightRows: nightRows.length > 0 ? nightRows : [],
    mainBriefer: "",
    briefTime: "",
    dayOps: "",
    nightOps: "",
    lecture: "",
    capte: "",
    nightBrief: "",
    reportingTime: "",
    acNeededDay: { main: "", stby: "" },
    acNeededNight: { main: "", stby: "" },
    fltCmdr: "",
    sqdnCmdr: "",
  };
}

// Mirror of the helper in pages/FlightProgram.tsx — flattens an
// ScheduleProgram into the compact row list the diff machinery uses.
function programToShareRows(p: ScheduleProgram): ScheduleRow[] {
  const rows: ScheduleProgramRow[] = [...p.dayRows, ...p.nightRows];
  return rows
    .filter(r => r.acType.trim() || r.pilot.trim() || r.msnDuty.trim() || r.toTime.trim())
    .map((r, i) => ({
      id:       `R-${i}`,
      ac:       `${r.acType}${r.dn ? ` ${r.dn}` : ""}`.trim(),
      config:   r.configuration,
      route:    r.route ?? "",
      crew:     [r.pilot, r.coPilot].filter(Boolean),
      mission:  r.msnDuty,
      takeoff:  r.toTime || r.atcTakeoff,
      land:     r.atcLanding,
      fuel:     r.fuel,
    }));
}

// Flight Schedule Sharing Chain — Squadron → Wing → Base. Each PC is named
// in the share dialog; tier order is enforced (no skipping). Edits default
// to going back to the originator. Diff is highlighted on screen and
// stripped on print via the .no-print-diff class (Tailwind print: prefix).

const blankRow = (): ScheduleRow => ({
  id: `R-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
  ac: "", config: "", route: "", crew: [], mission: "", takeoff: "", land: "", fuel: "",
  dn: "D", dur: "", remarks: "", atcTakeoff: "", atcLanding: "",
});

export default function ScheduleChain() {
  const { user, squadron } = useAuth();
  const { toast } = useToast();
  const allowed = canUseScheduleChain(user?.role, user?.scope);
  // v1.0.45: "flight" is now a first-class schedule-chain tier so a
  // Flight Commander PC can compose & submit a sortie schedule to the
  // parent Squadron, and receive shares back from the Squadron.
  // v1.1.28: "ops" is added as a peer of "squadron". The Ops Pilot's
  // PC sits at squadron tier in the registry (canonical id = squadron
  // code) but its composer addresses Flight Cmdrs (down) and the
  // Squadron Cmdr (peer at squadron tier) instead of Wing — Ops never
  // forwards up the chain, it only shares laterally inside the squadron.
  const myTier: "flight" | "ops" | "squadron" | "wing" | "base" =
    user?.role === "ops" ? "ops"
    : user?.scope === "flight" ? "flight"
    : user?.scope === "wing" ? "wing"
    : user?.scope === "base" ? "base"
    : "squadron";
  // Canonical PC id from registerLocalPC. Squadron tier uses the squadron
  // name; commander tiers use a tier-prefixed id (FLIGHT:..., WING:...,
  // BASE:...) so the chain reader (incoming filter) sees what the
  // upstream writer (forward target) addressed.
  const canonicalId = getLocalPcId();
  const fallbackId = myTier === "squadron"
    ? (squadron?.name ?? user?.username ?? "")
    : `${myTier.toUpperCase()}:${user?.displayName ?? user?.username ?? "CMD"}`;
  const myPcId = canonicalId || fallbackId || null;
  const myPcName = squadron?.name ?? user?.displayName ?? "Local PC";

  // Task #137 — rich actor identity stamped into every history entry so
  // downstream views ("Last actor", "Last action by", etc.) can render
  // "Maj. Ahmad · Flight Cmdr · NO.8 SQDN" instead of a bare username.
  const actorIdentity = {
    byDisplayName: user?.displayName,
    byRank: user?.rank,
    bySeatLabel: seatLabelFromRoleScope(user?.role, user?.scope),
  };

  const sharesQ = useScheduleShares(myPcId);
  const registry = useRegisteredPCs();
  const submit = useSubmitSchedule();
  const decide = useDecideSchedule();
  const acceptEdits = useAcceptScheduleEdit();
  const dismissMine = useDismissScheduleShareForOriginator();
  const deleteShare = useDeleteScheduleShare();
  const pilotsQ = usePilots();
  // Schedule composer stores pilot/co-pilot as the roster Flight Name
  // (or call-sign/id fallback), never the full pilot name.
  const pilotOptions = useMemo(
    () => pilotsQ.data.map(p => ({
      value: preferredSchedulePilotName(p),
      label: preferredSchedulePilotName(p),
    })),
    [pilotsQ.data],
  );
  const [internalPilotOptions, setInternalPilotOptions] = useState<Array<{ value: string; label: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    void fetchInternalPilotOptions().then((rows) => {
      if (cancelled) return;
      if (rows.length === 0) return;
      setInternalPilotOptions(rows.map((r) => ({ value: r.scheduleName, label: r.scheduleName })));
    });
    return () => { cancelled = true; };
  }, []);
  const effectivePilotOptions = internalPilotOptions.length > 0 ? internalPilotOptions : pilotOptions;

  const [draftRows, setDraftRows] = useState<ScheduleRow[]>([blankRow()]);
  const [draftDate, setDraftDate] = useState(new Date().toISOString().slice(0, 10));
  const [submitTo, setSubmitTo] = useState("");
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [forwardTo, setForwardTo] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  // Per-share local edit buffers — when an incoming share carries a
  // full program snapshot we let the reviewer edit it in place, then
  // Save & return ships the revised program back to the originator.
  const [editBuffer, setEditBuffer] = useState<Record<string, ScheduleProgram>>({});

  // Chain targets:
  //   Squadron tier → may compose to Wing (up-chain) OR to Flight
  //                    (down-chain, so a Flight Cmdr sees tomorrow's
  //                    programme in their inbox and can return edits).
  //   Wing tier     → forwards approved programmes to Base.
  //   Flight tier   → composes and submits back to Squadron.
  //   Base tier     → terminal.
  // Hide PCs whose heartbeat has lapsed so an operator can never forward
  // a programme to a PC that's actually offline right now. The threshold
  // (90 s) lives in cross-pc.ts as the single source of truth — see
  // isPcActive(). Linked-flight bindings still bypass this filter so a
  // freshly reimaged flight PC is never invisible to its squadron.
  const isFresh = (p: { lastSeen: string }) => isPcActive(p);
  const sortByName = <T extends { deviceName?: string; squadronName: string }>(arr: T[]): T[] =>
    [...arr].sort((a, b) =>
      (a.deviceName || a.squadronName).localeCompare(b.deviceName || b.squadronName),
    );
  // v1.1.98 multi-squadron org chart. Each PC declares its parent in the
  // chain (Sqn → Wing, Wing → Base) via `rjaf.parentPcId` localStorage,
  // mirrored to xpc_registry.parent_pc_id. When set, the upstream forward
  // dropdown locks to ONLY that parent — no more "Sqn Cmdr in NO.8 sees
  // every Wing PC in the country and one mis-click ships to the wrong
  // wing." Falls back to today's permissive listing if the operator
  // hasn't pinned a parent yet (with a banner above the dropdown so the
  // omission is visible).
  const myParentPcId = useMemo<string | null>(() => {
    try { return localStorage.getItem("rjaf.parentPcId") || null; } catch { return null; }
  }, []);
  const wingPCs = useMemo(
    () => {
      const all = registry.data.filter(p => !p.isSelf && p.tier === "wing" && isFresh(p));
      // Sqn Cmdr forwards UP to wing — lock to my pinned parent if present.
      if ((myTier === "squadron" || myTier === "ops") && myParentPcId) {
        const pinned = all.filter(p => p.id === myParentPcId);
        if (pinned.length > 0) return sortByName(pinned);
      }
      return sortByName(all);
    },
    [registry.data, myTier, myParentPcId],
  );
  const basePCs = useMemo(
    () => {
      const all = registry.data.filter(p => !p.isSelf && p.tier === "base" && isFresh(p));
      // Wing Cmdr forwards UP to base — lock to my pinned parent if present.
      if (myTier === "wing" && myParentPcId) {
        const pinned = all.filter(p => p.id === myParentPcId);
        if (pinned.length > 0) return sortByName(pinned);
      }
      return sortByName(all);
    },
    [registry.data, myTier, myParentPcId],
  );
  // Squadron commanders explicitly link specific flight commander PCs at
  // setup time. When that linkage exists on this PC, narrow the down-chain
  // composer list to just those — otherwise fall back to every registered
  // flight PC (legacy behaviour for pre-linkage installs).
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
  const flightPCs = useMemo(
    () => {
      // v1.1.73: every Flight PC must pass the 90 s active gate — no
      // exceptions. The earlier "linked-flight bypass" let an offline
      // PC stay selectable as long as it had been bound at setup; per
      // spec stale PCs cannot be selected, forwarded to, or messaged.
      const all = registry.data.filter(p => !p.isSelf && p.tier === "flight" && isFresh(p));
      // v1.1.98 multi-squadron: an Ops PC or Sqn Cmdr PC may only address
      // its OWN flights. Each Flight PC declares squadronPcId pointing
      // at the Sqn-tier PC it belongs to. When set on at least one row,
      // we trust the org chart and hide flights that belong elsewhere.
      const myPcId = fallbackId;
      const ownFlights = all.filter(p => p.squadronPcId === myPcId);
      if (ownFlights.length > 0) return sortByName(ownFlights);
      // Legacy fallback: if NO flight has declared a squadronPcId yet,
      // show every active Flight PC (preserves pre-v1.1.98 behaviour).
      const anyFlightPinned = all.some(p => p.squadronPcId);
      return sortByName(anyFlightPinned ? [] : all);
    },
    [registry.data, linkedFlightPcIds, fallbackId],
  );
  const squadronPCs = useMemo(
    () => sortByName(registry.data.filter(p => !p.isSelf && p.tier === "squadron" && isFresh(p))),
    [registry.data],
  );
  // v1.1.103 — carve out the Sqn Cmdr PCs (id prefix SQDNCMD:) from the
  // broader squadron-tier list so the Flight Cmdr's approve-and-forward
  // picker can aim specifically at the Sqn Cmdr desk instead of also
  // offering the Ops PC (which is tier="squadron" but a peer, not an
  // upstream approver).
  const sqnCmdrPCs = useMemo(
    () => squadronPCs.filter(p => p.id.startsWith("SQDNCMD:")),
    [squadronPCs],
  );
  // v1.1.104 — Flight Cmdr forward targets on approve are STRICTLY
  // Sqn Cmdr PCs. The operator's authoritative chain spec:
  //    Ops ↔ Flight Cmdr (compose/edit) → Sqn Cmdr → Wing → Base
  // No skip-to-Wing fallback. When no Sqn Cmdr PC is registered, the
  // button shows a clear block message telling the operator to
  // provision a Sqn Cmdr desk, rather than silently short-circuiting
  // the chain.
  const flightApproveForwardTargets = sqnCmdrPCs;
  // Am I running on a Sqn Cmdr PC? Ops and Sqn Cmdr both resolve to
  // myTier === "squadron", but only the Sqn Cmdr's canonical id carries
  // the SQDNCMD: prefix. Used to gate the squadron→wing auto-forward so
  // the Ops PC (which never approves up-chain) doesn't get a false
  // forward dropdown.
  const isSqnCmdrPc = useMemo(
    () => (canonicalId || fallbackId).startsWith("SQDNCMD:"),
    [canonicalId, fallbackId],
  );
  // Which PCs may this tier address on the composer? Squadron composers
  // see both Wing (up-chain) and Flight (down-chain). Flight composers
  // see Squadron PCs.
  const composeTargets = useMemo(() => {
    if (myTier === "flight") return squadronPCs;
    if (myTier === "squadron") return [...wingPCs, ...flightPCs];
    // v1.1.98 — operator hard rule: "Ops Pilot PC cannot directly send
    // to the wing commander. He can only talk to the flight commander."
    // Ops's compose targets are Flight PCs ONLY. The Sqn Cmdr PC is NOT
    // a valid Ops compose target; if Ops needs the Sqn Cmdr to see the
    // sheet, Ops sends to Flight, Flight approves and forwards up.
    if (myTier === "ops") return flightPCs;
    return [];
  }, [myTier, squadronPCs, wingPCs, flightPCs]);
  // v1.1.38: when the strict tier-filtered list is empty (e.g. Sqn Cmdr
  // sees zero Flight or Wing PCs because the registry rows for those
  // PCs were registered before the FLIGHT:/WING: id-prefix scheme and
  // their DB tier is still "squadron"), fall back to every non-self PC
  // the registry knows about. The picker tags each row with its current
  // tier so the operator can pick the right one anyway. Real-world
  // ops-room recovery: the Sqn Cmdr can still ship the schedule even
  // when the auto-classifier on his PC has lost track of who is who.
  // v1.1.73: the previous "show every non-self PC when the strict
  // tier-based picker yields nothing" fallback is removed because it
  // re-introduced offline PCs into the forward-target list. The
  // active-PC rule is enforced uniformly through composeTargets and
  // its underlying isFresh() = isPcActive() filter.
  const composeTargetsFallback: typeof composeTargets = [];
  const usingFallbackTargets = false;
  const effectiveTargets = composeTargets;

  // The ScheduleTier wire enum has flight|squadron|wing|base only —
  // "ops" is a UI-only distinction (the Ops PC sits at squadron tier in
  // the registry). Map "ops" → "squadron" whenever the value crosses
  // the wire (decide history entries, RLS-checked tier comparisons).
  const wireTier: "flight" | "squadron" | "wing" | "base" =
    myTier === "ops" ? "squadron" : myTier;

  if (!allowed) {
    return (
      <div>
        <PageHead title="Flight Schedule Sharing" />
        <Card>
          <div className="text-sm text-muted-foreground py-6 text-center">
            Schedule sharing is reserved for Flight Commander, Squadron, Wing and Base tiers.
          </div>
        </Card>
      </div>
    );
  }

  const updateRow = (id: string, patch: Partial<ScheduleRow>) =>
    setDraftRows(rs => rs.map(r => r.id === id ? { ...r, ...patch } : r));
  const removeRow = (id: string) => setDraftRows(rs => rs.filter(r => r.id !== id));

  // v1.1.45: virtual logical-seat targets. The Sqn Cmdr (and Wing/Base/Ops)
  // can ship a schedule to a TIER+SQUADRON seat directly — e.g. "Any
  // Flight Cmdr in NO.8" — even when no Flight Cmdr PC has registered
  // itself in xpc_registry yet, OR when the registry on this PC just
  // hasn't synced. The share is sent with currentPcId = "FLIGHT:NO.8"
  // (no suffix). On the receiving Flight Cmdr PC the v1.1.40 logical-seat
  // matcher catches it because their myLogicalSeat is "FLIGHT:NO.8"
  // (stripped from "FLIGHT:NO.8#xyz"). This makes registry presence
  // optional — one PC can address another by role, not by hardware id.
  const sqName = squadron?.name ?? "";
  const logicalSeatTargets = useMemo(() => {
    if (!sqName) return [] as Array<{ id: string; label: string; tier: "flight"|"squadron"|"wing"|"base" }>;
    const out: Array<{ id: string; label: string; tier: "flight"|"squadron"|"wing"|"base" }> = [];
    if (myTier === "squadron" || myTier === "ops" || myTier === "wing" || myTier === "base") {
      out.push({ id: `FLIGHT:${sqName}`, label: `Any Flight Cmdr in ${sqName}`, tier: "flight" });
    }
    if (myTier === "flight" || myTier === "ops") {
      out.push({ id: `SQDNCMD:${sqName}`, label: `Squadron Cmdr of ${sqName}`, tier: "squadron" });
      // Bare squadron id reaches the Ops PC of this squadron.
      out.push({ id: sqName, label: `Squadron Ops PC (${sqName})`, tier: "squadron" });
    }
    return out;
  }, [sqName, myTier]);

  const submitDraft = async () => {
    // Resolve target: either a real registry row, or one of the virtual
    // logical-seat options injected above.
    const realTarget = registry.data.find(p => p.id === submitTo);
    const seatTarget = logicalSeatTargets.find(s => s.id === submitTo);
    if (!realTarget && !seatTarget) { toast({ title: "Pick a recipient PC", variant: "destructive" }); return; }
    // v1.1.73: belt-and-braces submit-time guard — even if a stale
    // option made it into the dropdown via a race, the forward is
    // rejected here so the schedule never lands at an offline PC.
    if (realTarget && !isPcActive(realTarget)) {
      toast({
        title: "Recipient is offline",
        description: "That PC has not sent a heartbeat in the last 90 seconds. Pick another recipient or use a 'By role' option.",
        variant: "destructive",
      });
      return;
    }
    const valid = draftRows.filter(r => r.ac.trim() || r.mission.trim());
    if (valid.length === 0) { toast({ title: "Add at least one row", variant: "destructive" }); return; }
    // v1.1.92: refuse to submit when this PC has no resolvable seat id.
    // Sending "self" was the smoking gun behind the recurring 42501 RLS
    // failures on the Ops PC: Postgres rejects an INSERT whose
    // origin_squadron_id is not in the user's xpc_my_pc_ids().
    if (!myPcId || myPcId === "self") {
      toast({
        title: "PC seat not registered",
        description: "Sign out and sign back in so this PC can claim its squadron seat, then try again.",
        variant: "destructive",
      });
      return;
    }
    const targetId = realTarget?.id ?? seatTarget!.id;
    const targetName = realTarget?.squadronName ?? seatTarget!.label;
    const targetTier = (realTarget?.tier ?? seatTarget!.tier) as "flight" | "squadron" | "wing" | "base";
    try {
      await submit.mutateAsync({
        date: draftDate,
        originSquadronId: myPcId,
        originSquadronName: myPcName,
        rows: valid,
        targetPcId: targetId,
        targetPcName: targetName,
        targetTier,
        submittedBy: user?.username ?? "ops",
        submittedByDisplayName: user?.displayName,
        submittedByRank: user?.rank,
        submittedBySeatLabel: seatLabelFromRoleScope(user?.role, user?.scope),
        // v1.1.107 — attach a program so the share also surfaces in
        // the FlightProgram inbox (which filters on `!!s.program`).
        program: rowsToProgram(valid, draftDate, myPcName),
      });
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      toast({ title: "Submit failed", description: msg, variant: "destructive" });
      return;
    }
    toast({ title: `Schedule sent to ${targetName}` });
    setDraftRows([blankRow()]);
    setSubmitTo("");
  };

  // v1.1.56: Ops PC <-> Sqn Cmdr peering and logical-seat (suffix-stripped)
  // matching are now both folded into makePcMatcher in cross-pc.ts so
  // the schedule inbox and the message inbox can never disagree about
  // which incoming items belong to this seat. Previously two near-
  // identical copies of this logic lived here and in useMessages.
  // Two near-identical copies used to live here and there; consolidating
  // them eliminates the drift risk where the message inbox and the
  // schedule inbox could disagree about which items belong to this seat.
  const matchesMe = useMemo(() => makePcMatcher(myPcId), [myPcId]);
  // v1.1.108 — Program-style shares (full RJAF flight-schedule sheet)
  // ALSO surface in the Flight Schedule page's inbox
  // (FlightProgramShareInbox). For roles that have access to BOTH
  // pages — Ops Pilot, Sqn Cmdr, Flight Cmdr, super_admin — the
  // duplicate card was confusing and approving from one page left the
  // other unchanged. So those roles get program shares HIDDEN here
  // and acted on over there.
  // Wing Cmdr and Base Cmdr do NOT have the Flight Schedule page in
  // their sidebar, so for them program shares MUST stay in Schedule
  // Chain — otherwise wing approval of a flight-schedule sheet is
  // simply unreachable. Same applies to the chainCount badge below.
  const seesFlightProgramInbox =
    user?.role === "super_admin"
    || user?.role === "ops"
    || (user?.role === "commander" && (user?.scope === "flight" || user?.scope === "squadron"));
  const dedupeProgram = (s: typeof sharesQ.data[number]) =>
    seesFlightProgramInbox ? !s.program : true;
  const incomingAll = sharesQ.data.filter(s => matchesMe(s.currentPcId) && dedupeProgram(s));
  const sent = sharesQ.data.filter(s => matchesMe(s.originSquadronId) && !matchesMe(s.currentPcId) && dedupeProgram(s));

  // v1.1.65 — Wing-Cmdr inbox triage. With 15-20+ squadrons feeding
  // up the chain the flat list is overwhelming, so the wing operator
  // gets two simple controls: a "filter by squadron" chip row and a
  // sort selector. State is local-only — no persistence needed.
  const [wingSquadronFilter, setWingSquadronFilter] = useState<string | null>(null);
  const [wingSort, setWingSort] = useState<"squadron" | "newest" | "oldest">("squadron");
  const wingSquadronCounts = useMemo(() => {
    if (myTier !== "wing") return [] as Array<{ id: string; name: string; count: number }>;
    const m = new Map<string, { id: string; name: string; count: number }>();
    for (const s of incomingAll) {
      const cur = m.get(s.originSquadronId) ?? { id: s.originSquadronId, name: s.originSquadronName, count: 0 };
      cur.count += 1;
      m.set(s.originSquadronId, cur);
    }
    return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [myTier, incomingAll]);
  const incoming = useMemo(() => {
    if (myTier !== "wing") return incomingAll;
    let list = incomingAll;
    if (wingSquadronFilter) list = list.filter(s => s.originSquadronId === wingSquadronFilter);
    const copy = [...list];
    if (wingSort === "squadron") {
      copy.sort((a, b) =>
        a.originSquadronName.localeCompare(b.originSquadronName) ||
        b.date.localeCompare(a.date)
      );
    } else if (wingSort === "newest") {
      copy.sort((a, b) => b.date.localeCompare(a.date));
    } else {
      copy.sort((a, b) => a.date.localeCompare(b.date));
    }
    return copy;
  }, [myTier, incomingAll, wingSquadronFilter, wingSort]);

  return (
    <div>
      <PageHead
        title="Flight Schedule Sharing"
        subtitle={
          seesFlightProgramInbox
            ? `Compact-row chain (program-style sheets are handled in Flight Schedule). This PC: ${myPcName} (${myTier})`
            : `Chain: Flight ↔ Squadron → Wing → Base · this PC: ${myPcName} (${myTier})`
        }
      />

      {/* Compose new schedule — available to Squadron, Flight and Ops
          tiers. Squadron composers pick a Wing PC (up-chain) or a Flight
          PC (down-chain). Flight composers pick a Squadron PC. Ops Pilot
          composers pick a Flight Cmdr PC or the Squadron Cmdr PC. */}
      {/* v1.1.98 multi-squadron setup-incomplete banner. When this PC's
          tier needs to forward upchain (Sqn→Wing or Wing→Base) and the
          operator has NOT pinned a parent in Settings → Chain Setup, AND
          the registry shows more than one possible parent, surface a
          loud warning so the operator doesn't silently mis-route to the
          wrong wing/base. Single-install deployments stay silent. */}
      {((myTier === "squadron" || myTier === "ops") && !myParentPcId && wingPCs.length > 1) && (
        <Card className="mb-3 border-amber-400/50 bg-amber-500/10">
          <div className="text-amber-100 text-sm font-semibold mb-1">⚠ Multiple Wing PCs visible — pin your parent</div>
          <div className="text-xs text-amber-100/80">
            This PC sees {wingPCs.length} Wing Cmdr PCs. Without pinning your squadron's parent Wing
            in <span className="font-mono">Settings → Chain Setup</span>, the forward dropdown will list all of them and a wrong click
            will ship the day to a different wing.
          </div>
        </Card>
      )}
      {(myTier === "wing" && !myParentPcId && basePCs.length > 1) && (
        <Card className="mb-3 border-amber-400/50 bg-amber-500/10">
          <div className="text-amber-100 text-sm font-semibold mb-1">⚠ Multiple Base PCs visible — pin your parent</div>
          <div className="text-xs text-amber-100/80">
            This wing sees {basePCs.length} Base Cmdr PCs. Pin the parent base in <span className="font-mono">Settings → Chain Setup</span> so
            "Approve & send to Base" routes to the right one every time.
          </div>
        </Card>
      )}
      {(myTier === "squadron" || myTier === "flight" || myTier === "ops") && (
        <Card className="mb-3">
          <div className="text-sm font-semibold mb-2">Compose & submit</div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
            <div>
              <label className="text-[11px] text-muted-foreground">Date</label>
              <DateInput value={draftDate} onChange={setDraftDate} className="w-full mt-1 px-3 py-1.5 rounded-md bg-input border border-border text-sm" data-testid="input-draft-date" />
            </div>
            <div className="sm:col-span-2">
              <label className="text-[11px] text-muted-foreground">
                {myTier === "flight"
                  ? "Send to (Squadron PC)"
                  : myTier === "ops"
                  ? "Send to (Flight Cmdr PC)"
                  : "Send to (Wing or Flight PC)"}
              </label>
              <select value={submitTo} onChange={e => setSubmitTo(e.target.value)} className="w-full mt-1 px-3 py-1.5 rounded-md bg-input border border-border text-sm" data-testid="select-target">
                <option value="">
                  {myTier === "flight"
                    ? "— pick a Squadron PC or seat —"
                    : myTier === "ops"
                    ? "— pick a Flight Cmdr / Sqn Cmdr PC or seat —"
                    : "— pick a registered PC or logical seat —"}
                </option>
                {logicalSeatTargets.length > 0 && (
                  <optgroup label="By role (delivers to whoever is signed in)">
                    {logicalSeatTargets.map(s => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </optgroup>
                )}
                <optgroup label={`Registered PCs (${effectiveTargets.length})`}>
                  {effectiveTargets.map(p => (
                    <option key={p.id} value={p.id} disabled={!isPcActive(p)}>
                      {p.deviceName || p.squadronName}
                      {p.tier === "flight"
                        ? " · Flight Cmdr"
                        : p.tier === "squadron"
                        ? " · Squadron Cmdr"
                        : p.tier === "wing" && p.wing
                        ? ` · ${p.wing}`
                        : ""}
                      {p.online ? " · online" : " · offline"}
                    </option>
                  ))}
                </optgroup>
              </select>
              {usingFallbackTargets && (
                <p className="text-[10px] text-amber-300 mt-1">
                  No PCs matched the strict tier filter — showing every PC in the registry ({effectiveTargets.length}). Pick the right one manually.
                </p>
              )}
              {effectiveTargets.length === 0 && (
                <p className="text-[10px] text-amber-300 mt-1">
                  No other PC has registered yet on this network. Use a "By role" option above — the share will deliver the moment that role's PC comes online.
                </p>
              )}
              <p className="text-[10px] text-muted-foreground mt-1">
                Registry on this PC: {registry.data.length} PC(s) total
                {registry.data.length > 0 && (
                  <> · {registry.data.filter(p => p.tier === "flight").length} flight, {registry.data.filter(p => p.tier === "squadron").length} squadron, {registry.data.filter(p => p.tier === "wing").length} wing, {registry.data.filter(p => p.tier === "base").length} base</>
                )}
              </p>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {/* v1.1.47: header layout mirrors the printed Flight
                    Schedule sheet — merged CREW (PILOT + CO-PILOT) and
                    merged ATC USE (TAKE OFF + LANDING) so the operator
                    composes shares against the SAME column structure
                    they print on paper. */}
                <tr>
                  <th rowSpan={2} className="px-1 text-left">NO</th>
                  <th rowSpan={2} className="px-1 text-left">D/N</th>
                  <th rowSpan={2} className="px-1 text-left">A/C TYPE</th>
                  <th colSpan={2} className="px-1 text-center border-b border-border">CREW</th>
                  <th rowSpan={2} className="px-1 text-left">CONFIGURATION</th>
                  <th rowSpan={2} className="px-1 text-left">ROUTE</th>
                  <th rowSpan={2} className="px-1 text-left">T/O TIME</th>
                  <th rowSpan={2} className="px-1 text-left">MSN \ DUTY</th>
                  <th rowSpan={2} className="px-1 text-left">DUR.</th>
                  <th rowSpan={2} className="px-1 text-left">FUEL</th>
                  <th rowSpan={2} className="px-1 text-left">REMARKS</th>
                  <th colSpan={2} className="px-1 text-center border-b border-border">ATC USE</th>
                  <th rowSpan={2} />
                </tr>
                <tr>
                  <th className="px-1 text-left">PILOT</th>
                  <th className="px-1 text-left">CO-PILOT</th>
                  <th className="px-1 text-left">TAKE OFF</th>
                  <th className="px-1 text-left">LANDING</th>
                </tr>
              </thead>
              <tbody>
                {draftRows.map((r, idx) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="p-1 text-center text-muted-foreground font-mono text-[11px]">{idx + 1}</td>
                    <td className="p-1">
                      <select value={r.dn ?? "D"} onChange={e => updateRow(r.id, { dn: e.target.value })} className="w-14 px-1 py-1 bg-input border border-border rounded text-xs font-mono" data-testid={`input-draft-dn-${idx}`}>
                        <option value="D">D</option>
                        <option value="N">N</option>
                        <option value="NVG">NVG</option>
                      </select>
                    </td>
                    <td className="p-1"><input value={r.ac} onChange={e => updateRow(r.id, { ac: e.target.value })} className="w-20 px-1 py-1 bg-input border border-border rounded text-xs font-mono" placeholder="UH-60M" /></td>
                    <td className="p-1"><input value={(r.crew ?? [])[0] ?? ""} onChange={e => updateRow(r.id, { crew: [e.target.value, (r.crew ?? [])[1] ?? ""].filter((v, i) => v || i === 0) })} className="w-28 px-1 py-1 bg-input border border-border rounded text-xs" placeholder="Pilot" data-testid="input-draft-pilot" /></td>
                    <td className="p-1"><input value={(r.crew ?? [])[1] ?? ""} onChange={e => updateRow(r.id, { crew: [(r.crew ?? [])[0] ?? "", e.target.value].filter((v, i) => v || i === 0) })} className="w-28 px-1 py-1 bg-input border border-border rounded text-xs" placeholder="Co-Pilot" data-testid="input-draft-copilot" /></td>
                    <td className="p-1"><input value={r.config} onChange={e => updateRow(r.id, { config: e.target.value })} className="w-24 px-1 py-1 bg-input border border-border rounded text-xs" /></td>
                    <td className="p-1"><input value={r.route ?? ""} onChange={e => updateRow(r.id, { route: e.target.value })} className="w-28 px-1 py-1 bg-input border border-border rounded text-xs" placeholder="OJAM-OJAQ" data-testid="input-draft-route" /></td>
                    <td className="p-1"><input value={r.takeoff} onChange={e => updateRow(r.id, { takeoff: e.target.value })} className="w-16 px-1 py-1 bg-input border border-border rounded text-xs font-mono" placeholder="0800" /></td>
                    <td className="p-1"><input value={r.mission} onChange={e => updateRow(r.id, { mission: e.target.value })} className="w-28 px-1 py-1 bg-input border border-border rounded text-xs" /></td>
                    <td className="p-1"><input value={r.dur ?? ""} onChange={e => updateRow(r.id, { dur: e.target.value })} className="w-16 px-1 py-1 bg-input border border-border rounded text-xs font-mono" placeholder="1+30" data-testid={`input-draft-dur-${idx}`} /></td>
                    <td className="p-1"><input value={r.fuel} onChange={e => updateRow(r.id, { fuel: e.target.value })} className="w-16 px-1 py-1 bg-input border border-border rounded text-xs font-mono" /></td>
                    <td className="p-1"><input value={r.remarks ?? ""} onChange={e => updateRow(r.id, { remarks: e.target.value })} className="w-28 px-1 py-1 bg-input border border-border rounded text-xs" data-testid={`input-draft-remarks-${idx}`} /></td>
                    <td className="p-1"><input value={r.atcTakeoff ?? ""} onChange={e => updateRow(r.id, { atcTakeoff: e.target.value })} className="w-16 px-1 py-1 bg-input border border-border rounded text-xs font-mono" data-testid={`input-draft-atc-to-${idx}`} /></td>
                    <td className="p-1"><input value={r.atcLanding ?? r.land ?? ""} onChange={e => updateRow(r.id, { atcLanding: e.target.value, land: e.target.value })} className="w-16 px-1 py-1 bg-input border border-border rounded text-xs font-mono" placeholder="0930" data-testid={`input-draft-atc-ldg-${idx}`} /></td>
                    <td className="p-1"><button onClick={() => removeRow(r.id)} className="p-1 text-muted-foreground hover:text-rose-300"><Trash2 className="h-3 w-3" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex gap-2 mt-2">
            <button onClick={() => setDraftRows(rs => [...rs, blankRow()])} className="px-3 py-1.5 rounded-md bg-secondary border border-border text-xs inline-flex items-center gap-1" data-testid="add-row">
              <Plus className="h-3 w-3" /> Add row
            </button>
            <button onClick={submitDraft} disabled={submit.isPending} className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold inline-flex items-center gap-1 disabled:opacity-50" data-testid="button-submit-schedule">
              <Send className="h-3 w-3" /> {myTier === "flight" ? "Submit to Squadron" : "Submit"}
            </button>
          </div>
        </Card>
      )}

      {/* Wing/Base see which downstream squadron PCs are currently
          registered, so they know which units may originate shares. */}
      {(myTier === "wing" || myTier === "base") && (
        <Card className="mb-3">
          <div className="text-sm font-semibold mb-2">Registered Squadron PCs ({squadronPCs.length})</div>
          {squadronPCs.length === 0 ? (
            <div className="text-xs text-muted-foreground py-2">No squadron PC has registered yet.</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {squadronPCs.map(p => (
                <span
                  key={p.id}
                  className="text-[11px] px-2 py-1 rounded bg-sky-500/15 text-sky-200 border border-sky-400/30"
                  data-testid={`sqn-pc-${p.id}`}
                  title={`Last seen ${new Date(p.lastSeen).toLocaleString()}`}
                >
                  {p.squadronName}
                </span>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* Incoming for this PC */}
      <Card className="mb-3">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
          <div className="text-sm font-semibold">
            Incoming · awaiting your action ({incoming.length}
            {wingSquadronFilter ? ` of ${incomingAll.length}` : ""})
          </div>
          {/* v1.1.65 — Wing-Cmdr triage controls. Shown only when the
              wing operator is signed in; squadron / flight / ops / base
              tiers don't see enough volume to warrant sorting controls. */}
          {myTier === "wing" && incomingAll.length > 1 && (
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-muted-foreground uppercase tracking-wider">Sort</span>
              <select
                value={wingSort}
                onChange={e => setWingSort(e.target.value as "squadron" | "newest" | "oldest")}
                className="px-2 py-1 rounded bg-input border border-border"
                data-testid="wing-sort"
              >
                <option value="squadron">By squadron (A→Z)</option>
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
              </select>
            </div>
          )}
        </div>

        {/* Squadron filter chips for the Wing Cmdr — one chip per
            squadron with a pending count, plus an "All" reset chip.
            Each chip is colour-coded with the same palette used on the
            badge inside each row, so the wing operator builds an
            instinctive colour memory for each squadron. */}
        {myTier === "wing" && wingSquadronCounts.length > 1 && (
          <div className="flex flex-wrap gap-1.5 mb-3 pb-2 border-b border-border">
            <button
              type="button"
              onClick={() => setWingSquadronFilter(null)}
              className={`text-[11px] px-2 py-1 rounded border ${
                wingSquadronFilter === null
                  ? "bg-foreground/10 border-foreground/40 text-foreground font-semibold"
                  : "bg-secondary/40 border-border text-muted-foreground hover:bg-secondary"
              }`}
              data-testid="wing-filter-all"
            >
              All ({incomingAll.length})
            </button>
            {wingSquadronCounts.map(s => {
              const pal = squadronColor(s.id);
              const active = wingSquadronFilter === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setWingSquadronFilter(active ? null : s.id)}
                  className={`text-[11px] px-2 py-1 rounded border inline-flex items-center gap-1.5 ${pal.badge} ${
                    active ? "ring-2 ring-offset-1 ring-offset-background ring-foreground/40 font-semibold" : "opacity-90 hover:opacity-100"
                  }`}
                  data-testid={`wing-filter-${s.id}`}
                >
                  <span className={`inline-block h-1.5 w-1.5 rounded-full ${pal.stripe}`} />
                  {s.name}
                  <span className="tabular-nums opacity-80">· {s.count}</span>
                </button>
              );
            })}
          </div>
        )}

        {incoming.length === 0 ? (
          <div className="text-xs text-muted-foreground py-3">Nothing waiting.</div>
        ) : (
          <div className="space-y-2">
            {incoming.map(share => {
              const open = reviewing === share.id;
              // v1.1.65 — colour the squadron badge + a 4px left stripe
              // with this squadron's deterministic palette so a Wing Cmdr
              // scanning many rows can pick out a specific squadron at
              // a glance without reading the name first.
              const pal = squadronColor(share.originSquadronId);
              return (
                <div
                  key={share.id}
                  className="border border-border rounded-md overflow-hidden flex"
                  data-testid={`incoming-${share.id}`}
                >
                  <div className={`w-1 shrink-0 ${pal.stripe}`} aria-hidden="true" />
                  <div className="flex-1 min-w-0">
                  <button type="button" onClick={() => setReviewing(open ? null : share.id)} className="w-full px-3 py-2 flex items-center justify-between hover:bg-secondary/30 text-left">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`text-[10px] uppercase tracking-wider px-2 py-1 rounded border font-semibold whitespace-nowrap ${pal.badge}`}
                        data-testid={`origin-sqn-${share.id}`}
                      >
                        {share.originSquadronName}
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-semibold truncate">{share.date}</div>
                        <div className="text-[11px] text-muted-foreground">{share.rows.length} sortie{share.rows.length === 1 ? "" : "s"} · status {share.status}</div>
                      </div>
                    </div>
                    <span className="text-[10px] uppercase tracking-wider px-2 py-1 rounded bg-amber-500/20 text-amber-200 border border-amber-400/30">{share.currentTier}</span>
                  </button>
                  {open && (
                    <div className="border-t border-border p-3 space-y-3">
                      {share.program ? (
                        <FlightScheduleSheet
                          prog={editBuffer[share.id] ?? share.program}
                          onChange={editBuffer[share.id]
                            ? (next) => setEditBuffer(b => ({ ...b, [share.id]: next }))
                            : undefined}
                          pilotOptions={effectivePilotOptions}
                          statusLabel={editBuffer[share.id] ? "EDITING" : share.status.toUpperCase()}
                          approvedAt={share.approvedAt}
                          approvedBy={share.approvedBy}
                        />
                      ) : (
                        <ScheduleTable share={share} />
                      )}
                      <div className="flex flex-wrap gap-2 items-end">
                        {/* Wing tier: when the wing commander approves a
                            squadron→wing share, the program is auto-
                            forwarded to a Base PC for read-only visibility.
                            The wing may pick which Base PC the share lands
                            on; default is the first registered base. */}
                        {share.currentTier === "wing" && myTier === "wing" && basePCs.length > 0 && (
                          <div>
                            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">On approve, send to Base PC</label>
                            <select value={forwardTo || basePCs[0]?.id || ""} onChange={e => setForwardTo(e.target.value)} className="px-2 py-1 rounded bg-input border border-border text-xs" data-testid={`forward-target-${share.id}`}>
                              {basePCs.map(p => (
                                <option key={p.id} value={p.id}>{p.deviceName || p.squadronName}{p.online ? " · online" : " · offline"}</option>
                              ))}
                            </select>
                          </div>
                        )}
                        {/* v1.1.104 Flight tier: Flight Cmdr approves and
                            auto-forwards to the Sqn Cmdr (strict per
                            chain spec — no Wing shortcut). When the
                            squadron hasn't provisioned a Sqn Cmdr PC
                            yet, the approve button is hidden and an
                            amber block message tells the operator to
                            register one. */}
                        {share.currentTier === "flight" && myTier === "flight" && sqnCmdrPCs.length > 0 && (
                          <div>
                            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                              On approve, send to Squadron Cmdr
                            </label>
                            <select value={forwardTo || sqnCmdrPCs[0]?.id || ""} onChange={e => setForwardTo(e.target.value)} className="px-2 py-1 rounded bg-input border border-border text-xs" data-testid={`forward-target-${share.id}`}>
                              {sqnCmdrPCs.map(p => (
                                <option key={p.id} value={p.id}>{p.deviceName || p.squadronName}{p.online ? " · online" : " · offline"}</option>
                              ))}
                            </select>
                          </div>
                        )}
                        {share.currentTier === "flight" && myTier === "flight" && sqnCmdrPCs.length === 0 && (
                          <div className="w-full text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2">
                            <div className="font-semibold">No Squadron Commander PC registered.</div>
                            <div className="text-muted-foreground">
                              This squadron needs a Sqn Cmdr PC online before the Flight Cmdr can forward the schedule up the chain. Ask the Sqn Cmdr to sign in on their PC once with internet on.
                            </div>
                          </div>
                        )}
                        {/* v1.1.103 Sqn Cmdr tier: when the Sqn Cmdr
                            approves a share sitting at squadron tier,
                            auto-forward up to Wing. Only fires on an
                            actual Sqn Cmdr PC (id prefix SQDNCMD:) —
                            Ops PC shares this tier but never approves
                            up-chain. */}
                        {share.currentTier === "squadron" && myTier === "squadron" && isSqnCmdrPc && wingPCs.length > 0 && (
                          <div>
                            <label className="text-[10px] uppercase tracking-wider text-muted-foreground">On approve, send to Wing Cmdr</label>
                            <select value={forwardTo || wingPCs[0]?.id || ""} onChange={e => setForwardTo(e.target.value)} className="px-2 py-1 rounded bg-input border border-border text-xs" data-testid={`forward-target-${share.id}`}>
                              {wingPCs.map(p => (
                                <option key={p.id} value={p.id}>{p.deviceName || p.squadronName}{p.online ? " · online" : " · offline"}</option>
                              ))}
                            </select>
                          </div>
                        )}
                        <input
                          value={decisionNote}
                          onChange={e => setDecisionNote(e.target.value)}
                          placeholder="Optional note"
                          className="flex-1 min-w-[10rem] px-2 py-1.5 bg-input border border-border rounded text-xs"
                        />
                        <button
                          onClick={async () => {
                            const approver = user?.username ?? "cmd";
                            // v1.1.108 — wrap the entire decide chain in
                            // a try/catch with an explicit error toast.
                            // Without this, a failing mutateAsync (RLS
                            // rejection, network drop, stale claim)
                            // silently aborted the click handler and
                            // the operator saw NOTHING — no toast, no
                            // state change, leaving them to wonder
                            // whether the press registered. The success
                            // toast already existed; the failure path
                            // just needs the same visibility.
                            try {
                            // Wing approval auto-forwards the program to a
                            // Base PC so the base sees the approved sheet
                            // in their inbox without an extra click. We
                            // forward FIRST (which moves the share to the
                            // base tier) then approve, so the approval
                            // event lands at the right currentPcId.
                            if (myTier === "wing" && share.currentTier === "wing" && basePCs.length > 0) {
                              const baseId = forwardTo || basePCs[0].id;
                              const baseTarget = basePCs.find(p => p.id === baseId) ?? basePCs[0];
                              await decide.mutateAsync({
                                id: share.id, action: "forward", by: approver, ...actorIdentity, tier: wireTier,
                                forwardPcId: baseTarget.id, forwardPcName: baseTarget.squadronName,
                              });
                              await decide.mutateAsync({
                                id: share.id, action: "approve", by: approver, ...actorIdentity, tier: "base",
                                note: decisionNote || undefined,
                              });
                              toast({ title: `Approved · sent to ${baseTarget.squadronName}` });
                            } else if (myTier === "flight" && share.currentTier === "flight" && flightApproveForwardTargets.length > 0) {
                              // v1.1.103 Flight Cmdr approves → forward up-
                              // chain. Target is the first Sqn Cmdr PC when
                              // present, otherwise a Wing PC (graceful
                              // skip for squadrons without a Sqn Cmdr
                              // desk). Derived next-tier from the id prefix
                              // so the approval event lands with the right
                              // wire tier.
                              const targetId = forwardTo || flightApproveForwardTargets[0].id;
                              const target = flightApproveForwardTargets.find(p => p.id === targetId) ?? flightApproveForwardTargets[0];
                              const nextTier: "squadron" | "wing" = target.id.startsWith("SQDNCMD:") ? "squadron" : "wing";
                              await decide.mutateAsync({
                                id: share.id, action: "forward", by: approver, ...actorIdentity, tier: wireTier,
                                forwardPcId: target.id, forwardPcName: target.squadronName,
                              });
                              await decide.mutateAsync({
                                id: share.id, action: "approve", by: approver, ...actorIdentity, tier: nextTier,
                                note: decisionNote || undefined,
                              });
                              toast({ title: `Approved · sent to ${target.squadronName}` });
                            } else if (myTier === "squadron" && isSqnCmdrPc && share.currentTier === "squadron" && wingPCs.length > 0) {
                              // v1.1.103 Sqn Cmdr approves → forward to
                              // Wing. Mirror of Wing→Base: forward first,
                              // approve second so the approval event lands
                              // at the right current_pc_id.
                              const wingId = forwardTo || wingPCs[0].id;
                              const wingTarget = wingPCs.find(p => p.id === wingId) ?? wingPCs[0];
                              await decide.mutateAsync({
                                id: share.id, action: "forward", by: approver, ...actorIdentity, tier: wireTier,
                                forwardPcId: wingTarget.id, forwardPcName: wingTarget.squadronName,
                              });
                              await decide.mutateAsync({
                                id: share.id, action: "approve", by: approver, ...actorIdentity, tier: "wing",
                                note: decisionNote || undefined,
                              });
                              toast({ title: `Approved · sent to ${wingTarget.squadronName}` });
                            } else {
                              await decide.mutateAsync({ id: share.id, action: "approve", by: approver, ...actorIdentity, tier: wireTier, note: decisionNote || undefined });
                              // v1.1.108 — Flight Cmdr Approve when no
                              // upstream PC is registered: be explicit
                              // that the chain has paused here, so the
                              // operator doesn't sit waiting for a
                              // forward that will never happen.
                              if (myTier === "flight" && share.currentTier === "flight" && flightApproveForwardTargets.length === 0) {
                                toast({ title: "Approved — no Sqn Cmdr PC registered, chain paused here" });
                              } else if (myTier === "squadron" && isSqnCmdrPc && share.currentTier === "squadron" && wingPCs.length === 0) {
                                toast({ title: "Approved — no Wing PC registered, chain paused here" });
                              } else {
                                toast({ title: "Approved" });
                              }
                            }
                            setDecisionNote("");
                            } catch (e) {
                              toast({
                                title: "Approve failed",
                                description: (e as Error)?.message ?? String(e),
                                variant: "destructive",
                              });
                            }
                          }}
                          className="px-3 py-1.5 rounded-md bg-emerald-500/20 border border-emerald-400/40 text-emerald-100 text-xs font-semibold inline-flex items-center gap-1"
                          data-testid={`approve-${share.id}`}
                        >
                          <Check className="h-3 w-3" />
                          {myTier === "wing" && share.currentTier === "wing" && basePCs.length > 0
                            ? "Approve & send to Base"
                            : myTier === "flight" && share.currentTier === "flight" && flightApproveForwardTargets.length > 0
                              ? `Approve & send to ${sqnCmdrPCs.length > 0 ? "Sqn Cmdr" : "Wing"}`
                              : myTier === "squadron" && isSqnCmdrPc && share.currentTier === "squadron" && wingPCs.length > 0
                                ? "Approve & send to Wing"
                                : "Approve"}
                        </button>
                        {/* v1.1.104 chain spec: Wing and Base tiers are
                            approve-only. No Reject, no Edit, no Hold —
                            they're read-only reviewers who either stamp
                            the sheet forward or (at Base) archive it.
                            Gate is on myTier, not share.currentTier,
                            because the operator's role decides what
                            actions they can take. */}
                        {myTier !== "wing" && myTier !== "base" && (
                          <button
                            onClick={async () => {
                              try {
                                await decide.mutateAsync({ id: share.id, action: "reject", by: user?.username ?? "ops", ...actorIdentity, tier: wireTier, note: decisionNote || undefined });
                                toast({ title: "Rejected" }); setDecisionNote("");
                              } catch (e) {
                                toast({
                                  title: "Reject failed",
                                  description: (e as Error)?.message ?? String(e),
                                  variant: "destructive",
                                });
                              }
                            }}
                            className="px-3 py-1.5 rounded-md bg-rose-500/20 border border-rose-400/40 text-rose-100 text-xs font-semibold inline-flex items-center gap-1"
                            data-testid={`reject-${share.id}`}
                          >
                            <X className="h-3 w-3" /> Reject
                          </button>
                        )}
                        {/* v1.1.106 — explicit "Send to [next tier]"
                            button, distinct from Approve. The chain is
                            now two-click by design: (1) Approve stamps
                            your decision, (2) Send forwards up-chain.
                            The combined "Approve & send" green button
                            still works as a one-click shortcut, but
                            operators who want to review, edit, and
                            then forward separately now have a clear
                            Send action. Button shows up for:
                              • Flight Cmdr on a flight-tier share → Sqn Cmdr
                              • Sqn Cmdr on a squadron-tier share → Wing Cmdr
                              • Wing Cmdr on a wing-tier share     → Base Cmdr
                            When no target PC is registered for the
                            next tier, the button hides (the chain
                            cannot advance yet — the amber "please
                            provision" block above explains why). */}
                        {(() => {
                          let target: { id: string; squadronName: string; deviceName?: string } | null = null;
                          let nextTierLabel = "";
                          let nextWireTier: "squadron" | "wing" | "base" | null = null;
                          if (myTier === "flight" && share.currentTier === "flight" && sqnCmdrPCs.length > 0) {
                            const id = forwardTo || sqnCmdrPCs[0].id;
                            target = sqnCmdrPCs.find(p => p.id === id) ?? sqnCmdrPCs[0];
                            nextTierLabel = "Sqn Cmdr";
                            nextWireTier = "squadron";
                          } else if (myTier === "squadron" && isSqnCmdrPc && share.currentTier === "squadron" && wingPCs.length > 0) {
                            const id = forwardTo || wingPCs[0].id;
                            target = wingPCs.find(p => p.id === id) ?? wingPCs[0];
                            nextTierLabel = "Wing Cmdr";
                            nextWireTier = "wing";
                          } else if (myTier === "wing" && share.currentTier === "wing" && basePCs.length > 0) {
                            const id = forwardTo || basePCs[0].id;
                            target = basePCs.find(p => p.id === id) ?? basePCs[0];
                            nextTierLabel = "Base Cmdr";
                            nextWireTier = "base";
                          }
                          if (!target || !nextWireTier) return null;
                          const t = target;
                          const nt = nextWireTier;
                          return (
                            <button
                              onClick={async () => {
                                try {
                                  await decide.mutateAsync({
                                    id: share.id, action: "forward", by: user?.username ?? "cmd", tier: wireTier,
                                    forwardPcId: t.id, forwardPcName: t.squadronName,
                                  });
                                  // Stamp an approval event at the new
                                  // tier so the receiver sees "approved
                                  // by [upstream]" in the audit trail
                                  // and the final-schedules archive can
                                  // distinguish Wing-signed finals.
                                  await decide.mutateAsync({
                                    id: share.id, action: "approve", by: user?.username ?? "cmd", ...actorIdentity, tier: nt,
                                    note: decisionNote || undefined,
                                  });
                                  toast({ title: `Sent to ${t.squadronName || nextTierLabel}` });
                                  setDecisionNote("");
                                } catch (e) {
                                  toast({
                                    title: "Forward failed",
                                    description: e instanceof Error ? e.message : "Could not send to the next tier. Check your connection and try again.",
                                    variant: "destructive",
                                  });
                                }
                              }}
                              className="px-3 py-1.5 rounded-md bg-indigo-500/20 border border-indigo-400/50 text-indigo-100 text-xs font-semibold inline-flex items-center gap-1"
                              data-testid={`send-next-${share.id}`}
                              title={`Forward this schedule to ${t.deviceName || t.squadronName || nextTierLabel}`}
                            >
                              <Send className="h-3 w-3" /> Send to {nextTierLabel}
                            </button>
                          );
                        })()}
                        {/* v1.1.60 hard delete — wipes the share from EVERY
                            PC. Available to every role on every inbox card
                            (RLS migration 0029 grants delete to any
                            participating PC, mirroring update authority). */}
                        <button
                          onClick={async () => {
                            if (!window.confirm("Delete this flight schedule from EVERY PC?\n\nThis is permanent. Originator, reviewers, approvers — everyone loses their copy. Cannot be undone.")) return;
                            await deleteShare.mutateAsync({ id: share.id });
                            toast({ title: "Schedule deleted from every PC" });
                          }}
                          className="px-3 py-1.5 rounded-md bg-rose-700/30 border border-rose-500/60 text-rose-50 text-xs font-semibold inline-flex items-center gap-1"
                          data-testid={`delete-${share.id}`}
                          title="Permanent delete — removes this schedule from every PC in the chain"
                        >
                          <Trash2 className="h-3 w-3" /> Delete
                        </button>
                        {myTier !== "wing" && myTier !== "base" && (
                          <button
                            onClick={async () => {
                              try {
                                await decide.mutateAsync({ id: share.id, action: "hold", by: user?.username ?? "ops", ...actorIdentity, tier: wireTier, note: decisionNote || undefined });
                                toast({ title: "Held" }); setDecisionNote("");
                              } catch (e) {
                                toast({
                                  title: "Hold failed",
                                  description: e instanceof Error ? e.message : "Could not record the hold. Check your connection and try again.",
                                  variant: "destructive",
                                });
                              }
                            }}
                            className="px-3 py-1.5 rounded-md bg-secondary border border-border text-xs inline-flex items-center gap-1"
                          >
                            <PauseCircle className="h-3 w-3" /> Hold
                          </button>
                        )}
                        {myTier !== "wing" && myTier !== "base" && (share.program ? (
                          editBuffer[share.id] ? (
                            <>
                              <button
                                onClick={async () => {
                                  const buf = editBuffer[share.id];
                                  try {
                                    await decide.mutateAsync({
                                      id: share.id,
                                      action: "edit",
                                      by: user?.username ?? "ops", ...actorIdentity,
                                      tier: wireTier,
                                      note: decisionNote || undefined,
                                      editedProgram: buf,
                                      editedRows: programToShareRows(buf),
                                    });
                                    setEditBuffer(b => { const { [share.id]: _, ...rest } = b; return rest; });
                                    setDecisionNote("");
                                    toast({ title: "Edits returned to originator" });
                                  } catch (e) {
                                    toast({
                                      title: "Edit failed",
                                      description: e instanceof Error ? e.message : "Could not return edits to originator. Check your connection and try again.",
                                      variant: "destructive",
                                    });
                                  }
                                }}
                                className="px-3 py-1.5 rounded-md bg-amber-500/20 border border-amber-400/40 text-amber-100 text-xs font-semibold inline-flex items-center gap-1"
                                data-testid={`save-edit-${share.id}`}
                              >
                                <Pencil className="h-3 w-3" /> Save & return to originator
                              </button>
                              <button
                                onClick={() => setEditBuffer(b => { const { [share.id]: _, ...rest } = b; return rest; })}
                                className="px-3 py-1.5 rounded-md bg-secondary border border-border text-xs inline-flex items-center gap-1"
                              >
                                Cancel edit
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() =>
                                setEditBuffer(b => ({
                                  ...b,
                                  [share.id]: JSON.parse(JSON.stringify(share.program)) as ScheduleProgram,
                                }))
                              }
                              className="px-3 py-1.5 rounded-md bg-secondary border border-border text-xs inline-flex items-center gap-1"
                              data-testid={`edit-${share.id}`}
                            >
                              <Pencil className="h-3 w-3" /> Edit sheet
                            </button>
                          )
                        ) : (
                          <button
                            onClick={async () => {
                              try {
                                await decide.mutateAsync({ id: share.id, action: "edit", by: user?.username ?? "ops", ...actorIdentity, tier: wireTier, note: decisionNote || undefined, editedRows: share.rows });
                                toast({ title: "Edits returned to originator" }); setDecisionNote("");
                              } catch (e) {
                                toast({
                                  title: "Edit failed",
                                  description: e instanceof Error ? e.message : "Could not return edits to originator. Check your connection and try again.",
                                  variant: "destructive",
                                });
                              }
                            }}
                            className="px-3 py-1.5 rounded-md bg-secondary border border-border text-xs inline-flex items-center gap-1"
                          >
                            <Pencil className="h-3 w-3" /> Edit & return
                          </button>
                        ))}
                        <button
                          onClick={() => window.print()}
                          className="px-3 py-1.5 rounded-md bg-secondary border border-border text-xs inline-flex items-center gap-1 no-print"
                          data-testid={`print-${share.id}`}
                        >
                          <Printer className="h-3 w-3" /> Print
                        </button>
                      </div>
                    </div>
                  )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Sent / status */}
      <Card>
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-semibold">Sent ({sent.length})</div>
          <button onClick={() => window.print()} className="text-xs px-2 py-1 rounded bg-secondary border border-border inline-flex items-center gap-1 no-print">
            <Printer className="h-3 w-3" /> Print
          </button>
        </div>
        {sent.length === 0 ? (
          <div className="text-xs text-muted-foreground py-3">No schedules sent yet.</div>
        ) : (
          <div className="space-y-2">
            {sent.map(share => (
              <div key={share.id} className="border border-border rounded-md p-3" data-testid={`sent-${share.id}`}>
                <div className="flex items-center justify-between mb-1">
                  <div className="text-sm font-semibold">{share.date}</div>
                  <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-secondary border border-border">{share.status}</span>
                </div>
                <div className="text-[11px] text-muted-foreground mb-2">
                  Now at: {share.currentPcName ?? "—"} ({share.currentTier})
                  {(() => {
                    // Task #137: surface the last actor on the chain so
                    // an originator scanning sent shares can immediately
                    // see "Maj. Ahmad · Flight Cmdr · NO.8 SQDN" instead
                    // of inferring it from the audit log.
                    const last = (share.history ?? [])[share.history.length - 1];
                    if (!last) return null;
                    const lbl = composeIdentityLabel({
                      rank: last.byRank,
                      displayName: last.byDisplayName,
                      username: last.by,
                      seatLabel: last.bySeatLabel,
                    });
                    return lbl ? <div>Last actor: {lbl} · {last.action}</div> : null;
                  })()}
                </div>
                {share.program ? (
                  <FlightScheduleSheet
                    prog={share.editedProgram ?? share.program}
                    pilotOptions={effectivePilotOptions}
                    statusLabel={share.editedProgram ? "EDIT PROPOSED" : share.status.toUpperCase()}
                    approvedAt={share.approvedAt}
                    approvedBy={share.approvedBy}
                  />
                ) : (
                  <ScheduleTable share={share} />
                )}
                {(share.editedRows || share.editedProgram) && (
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={async () => { await acceptEdits.mutateAsync({ id: share.id, by: user?.username ?? "ops", ...actorIdentity }); toast({ title: "Accepted edits" }); }}
                      className="px-3 py-1.5 rounded-md bg-emerald-500/20 border border-emerald-400/40 text-emerald-100 text-xs font-semibold inline-flex items-center gap-1"
                      data-testid={`accept-edits-${share.id}`}
                    >
                      <Check className="h-3 w-3" /> Accept edits from {share.editedBy ?? "downstream"}
                    </button>
                  </div>
                )}
                <div className="mt-2 flex items-center justify-between gap-2">
                  <div className="text-[10px] text-muted-foreground">
                    History: {share.history.map(h => `${h.tier}/${h.action}`).join(" → ")}
                  </div>
                  {/* Two delete options on the Sent card:
                      • "Delete from my view" — local hide only, receivers
                        keep their copy (legacy v1.1.54 behaviour).
                      • "Delete everywhere" — v1.1.60 hard delete that
                        wipes the share from every PC in the chain. */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={async () => {
                        if (!window.confirm("Hide this schedule from your own screen only? Other PCs that received or approved it will keep their copy.")) return;
                        await dismissMine.mutateAsync({ id: share.id });
                        toast({ title: "Removed from your view" });
                      }}
                      className="px-2 py-1 rounded-md bg-secondary border border-border text-[11px] inline-flex items-center gap-1 text-muted-foreground hover:text-rose-200 hover:border-rose-400/40 no-print"
                      data-testid={`dismiss-${share.id}`}
                      title="Hide this schedule from your own screen. Receivers keep their copy."
                    >
                      <Trash2 className="h-3 w-3" /> Delete from my view
                    </button>
                    <button
                      onClick={async () => {
                        if (!window.confirm("Delete this flight schedule from EVERY PC?\n\nThis is permanent. Originator, reviewers, approvers — everyone loses their copy. Cannot be undone.")) return;
                        await deleteShare.mutateAsync({ id: share.id });
                        toast({ title: "Schedule deleted from every PC" });
                      }}
                      className="px-2 py-1 rounded-md bg-rose-700/30 border border-rose-500/60 text-rose-50 text-[11px] font-semibold inline-flex items-center gap-1 no-print"
                      data-testid={`delete-sent-${share.id}`}
                      title="Permanent delete — removes this schedule from every PC in the chain"
                    >
                      <Trash2 className="h-3 w-3" /> Delete everywhere
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function ScheduleTable({ share }: { share: ScheduleShare }) {
  // Diff against the baseline (last-accepted snapshot). On screen this
  // adds colored backgrounds; the print stylesheet (.no-print-diff in
  // index.css) drops the highlight so paper output is always clean.
  const diff = useMemo(
    () => diffSchedule(share.baselineRows, share.editedRows ?? share.rows),
    [share.baselineRows, share.rows, share.editedRows],
  );
  return (
    <div className="overflow-x-auto">
      {/* v1.1.47: same column layout as the printed Flight Schedule
          sheet (merged CREW and ATC USE headers). */}
      <table className="w-full text-xs">
        <thead className="text-[10px] uppercase tracking-wider text-muted-foreground bg-secondary/30">
          <tr>
            <th rowSpan={2} className="px-2 py-1 text-left">NO</th>
            <th rowSpan={2} className="px-2 py-1 text-left">D/N</th>
            <th rowSpan={2} className="px-2 py-1 text-left">A/C TYPE</th>
            <th colSpan={2} className="px-2 py-1 text-center border-b border-border">CREW</th>
            <th rowSpan={2} className="px-2 py-1 text-left">CONFIGURATION</th>
            <th rowSpan={2} className="px-2 py-1 text-left">ROUTE</th>
            <th rowSpan={2} className="px-2 py-1 text-right">T/O TIME</th>
            <th rowSpan={2} className="px-2 py-1 text-left">MSN \ DUTY</th>
            <th rowSpan={2} className="px-2 py-1 text-right">DUR.</th>
            <th rowSpan={2} className="px-2 py-1 text-right">FUEL</th>
            <th rowSpan={2} className="px-2 py-1 text-left">REMARKS</th>
            <th colSpan={2} className="px-2 py-1 text-center border-b border-border">ATC USE</th>
          </tr>
          <tr>
            <th className="px-2 py-1 text-left">PILOT</th>
            <th className="px-2 py-1 text-left">CO-PILOT</th>
            <th className="px-2 py-1 text-right">TAKE OFF</th>
            <th className="px-2 py-1 text-right">LANDING</th>
          </tr>
        </thead>
        <tbody>
          {diff.map((d, idx) => {
            const r = d.next ?? d.prev!;
            const cls =
              d.kind === "added" ? "no-print-diff bg-emerald-500/10"
              : d.kind === "removed" ? "no-print-diff bg-rose-500/10 line-through opacity-70"
              : d.kind === "changed" ? "no-print-diff bg-amber-500/10"
              : "";
            return (
              <tr key={r.id} className={`border-t border-border ${cls}`} data-testid={`diff-${d.kind}`}>
                <td className="px-2 py-1 text-center font-mono">{idx + 1}</td>
                <td className="px-2 py-1 font-mono">{r.dn ?? ""}</td>
                <td className="px-2 py-1 font-mono">{r.ac}</td>
                <td className="px-2 py-1">{(r.crew ?? [])[0] ?? ""}</td>
                <td className="px-2 py-1">{(r.crew ?? [])[1] ?? ""}</td>
                <td className="px-2 py-1">{r.config}</td>
                <td className="px-2 py-1">{r.route ?? ""}</td>
                <td className="px-2 py-1 text-right font-mono">{r.takeoff}</td>
                <td className="px-2 py-1">{r.mission}</td>
                <td className="px-2 py-1 text-right font-mono">{r.dur ?? ""}</td>
                <td className="px-2 py-1 text-right font-mono">{r.fuel}</td>
                <td className="px-2 py-1">{r.remarks ?? ""}</td>
                <td className="px-2 py-1 text-right font-mono">{r.atcTakeoff ?? ""}</td>
                <td className="px-2 py-1 text-right font-mono">{r.atcLanding ?? r.land ?? ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
