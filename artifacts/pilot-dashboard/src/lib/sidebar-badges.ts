import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/lib/auth";
import {
  getLocalPcId,
  makePcMatcher,
  useScheduleShares,
  useMessages,
  usePendingApprovals,
  canViewFinalSchedules,
} from "@/lib/cross-pc";
import { isLanSessionLoginEnabled } from "@/lib/internal-migration";
import { listPendingRequests } from "@/lib/unit-join";
import { supabase } from "@/lib/supabase";

export type SidebarBadgeMap = Record<string, number>;

// v1.1.105 — "last seen" bookkeeping for the Final Schedules page.
// Base, HQ, Flight Cmdr and Sqn Cmdr don't get a ball-in-their-court
// schedule chain pulse (they're read-only archive viewers), so we
// give them the same red-highlight treatment Ops enjoys by counting
// every Wing-approved schedule that has arrived since they last
// opened the Final Schedules page. Storing the "seen" marker in
// localStorage keeps the state per-device, which is what the user
// expects for a desktop operator.
const K_LAST_SEEN_FINALS = "rjaf.lastSeenFinals";
const EVT_LAST_SEEN_FINALS = "rjaf:finals-seen";
const K_LAST_SEEN_FLIGHT_PROGRAM = "rjaf.lastSeenFlightProgram";
const EVT_LAST_SEEN_FLIGHT_PROGRAM = "rjaf:flight-program-seen";

export function markFinalSchedulesSeen(): void {
  try {
    window.localStorage.setItem(K_LAST_SEEN_FINALS, new Date().toISOString());
    window.dispatchEvent(new Event(EVT_LAST_SEEN_FINALS));
  } catch {
    /* private mode / storage disabled — badge will just not clear */
  }
}

// v1.1.108 — visiting /flight-program clears its red dot the same way
// /final-schedules does. Without this the actionable Flight Schedule
// inbox count would stay lit forever once a sheet landed; the operator
// would learn to ignore the badge and miss the next arrival.
export function markFlightProgramSeen(): void {
  try {
    window.localStorage.setItem(K_LAST_SEEN_FLIGHT_PROGRAM, new Date().toISOString());
    window.dispatchEvent(new Event(EVT_LAST_SEEN_FLIGHT_PROGRAM));
  } catch {
    /* private mode / storage disabled — badge will just not clear */
  }
}

function readLastSeenFinals(): string {
  try {
    return window.localStorage.getItem(K_LAST_SEEN_FINALS) ?? "1970-01-01T00:00:00Z";
  } catch {
    return "1970-01-01T00:00:00Z";
  }
}

function readLastSeenFlightProgram(): string {
  try {
    return window.localStorage.getItem(K_LAST_SEEN_FLIGHT_PROGRAM) ?? "1970-01-01T00:00:00Z";
  } catch {
    return "1970-01-01T00:00:00Z";
  }
}

// Task #299 — super-admin pending-device count poller. Only runs when
// the signed-in user is a super_admin (the only role with the Pending
// Devices page in their sidebar). Polls every 5s and also subscribes
// to realtime device_requests changes so the red badge wakes within
// ~1s of a new join landing.
function usePendingDeviceCount(role: string | undefined): number {
  const [count, setCount] = useState(0);
  const lanMode = isLanSessionLoginEnabled();
  useEffect(() => {
    if (lanMode) {
      setCount(0);
      return;
    }
    if (role !== "super_admin") {
      setCount(0);
      return;
    }
    let alive = true;
    const reload = async () => {
      try {
        const list = await listPendingRequests();
        if (!alive) return;
        setCount(list.length);
      } catch {
        /* leave count as-is on transient failure */
      }
    };
    void reload();
    const t = window.setInterval(reload, 5000);
    let cleanup: (() => void) | null = null;
    const sb = supabase;
    if (sb) {
      const ch = sb
        .channel("device_requests:sidebar-badge")
        .on("postgres_changes", { event: "*", schema: "public", table: "device_requests" }, () => {
          void reload();
        })
        .subscribe();
      cleanup = () => { void sb.removeChannel(ch); };
    }
    return () => {
      alive = false;
      window.clearInterval(t);
      if (cleanup) cleanup();
    };
  }, [role, lanMode]);
  return count;
}

export function useSidebarBadges(): SidebarBadgeMap {
  const { user, squadron } = useAuth();
  const pendingDeviceCount = usePendingDeviceCount(user?.role);

  const myTier =
    (user?.role as string | undefined) === "flight_cmdr" ? "flight"
    : user?.scope === "flight" ? "flight"
    : user?.scope === "wing" ? "wing"
    : user?.scope === "base" ? "base"
    : user?.scope === "hq" ? "hq"
    : "squadron";

  const canonicalId = getLocalPcId();
  const fallbackId = myTier === "squadron"
    ? (squadron?.name ?? user?.username ?? "")
    : `${myTier.toUpperCase()}:${user?.displayName ?? user?.username ?? "CMD"}`;
  const myPcId = canonicalId || fallbackId || null;

  const homeSquadronId = squadron?.name ?? null;

  // Base/HQ/Flight/Sqn Cmdrs can all read the Wing-approved archive.
  // Only pull the broader rollup when this user is actually allowed
  // to view it — avoids extra traffic for Ops/Flight peers who don't
  // see the page.
  const finalsViewer = canViewFinalSchedules(user?.role, user?.scope);

  const sharesQ = useScheduleShares(myPcId, { viewAllApproved: finalsViewer });
  const messagesQ = useMessages(myPcId);
  const pendingQ = usePendingApprovals(homeSquadronId);

  const matchesMe = useMemo(() => makePcMatcher(myPcId), [myPcId]);

  // Reactively track the "Final Schedules last opened" timestamp so
  // the red dot clears the moment the user visits that page, and
  // re-arms whenever a newer Wing-approved schedule lands.
  const [lastSeenFinals, setLastSeenFinals] = useState<string>(() => readLastSeenFinals());
  const [lastSeenFP, setLastSeenFP] = useState<string>(() => readLastSeenFlightProgram());
  useEffect(() => {
    const syncFinals = () => setLastSeenFinals(readLastSeenFinals());
    const syncFP = () => setLastSeenFP(readLastSeenFlightProgram());
    const syncStorage = () => { syncFinals(); syncFP(); };
    window.addEventListener(EVT_LAST_SEEN_FINALS, syncFinals);
    window.addEventListener(EVT_LAST_SEEN_FLIGHT_PROGRAM, syncFP);
    window.addEventListener("storage", syncStorage);
    return () => {
      window.removeEventListener(EVT_LAST_SEEN_FINALS, syncFinals);
      window.removeEventListener(EVT_LAST_SEEN_FLIGHT_PROGRAM, syncFP);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);

  return useMemo(() => {
    const shares = sharesQ.data ?? [];
    const inbox = messagesQ.inbox ?? [];
    const pending = pendingQ.data ?? [];

    // v1.1.108 — Schedule Chain dedup. Roles that ALSO have the Flight
    // Schedule page in their sidebar (Ops Pilot, Sqn Cmdr, Flight Cmdr,
    // super_admin) act on program-style sheets there, so the chain
    // badge mustn't double-count them. Wing + Base commanders have no
    // Flight Schedule sidebar entry, so for them program shares MUST
    // remain visible/badged in Schedule Chain — otherwise wing
    // approval of a flight-schedule sheet is unreachable.
    const seesFlightProgramInbox =
      user?.role === "super_admin"
      || user?.role === "ops"
      || (user?.role === "commander" && (user?.scope === "flight" || user?.scope === "squadron"));

    // Schedule chain: ball-in-my-court rows the user has not yet acted on.
    // Approved / rejected terminals don't count — they're history.
    const chainCount = shares.filter(s =>
      s.currentPcId !== null
      && matchesMe(s.currentPcId)
      && s.status !== "approved"
      && s.status !== "rejected"
      && (!seesFlightProgramInbox || !s.program),
    ).length;

    // v1.1.108 — Flight Schedule page (program-style sheets) badge so
    // Flight Cmdrs / Sqn Cmdrs / Ops actually notice that a sheet
    // landed in the Flight Schedule inbox. Wing + Base never see
    // /flight-program in their sidebar, so the badge is suppressed
    // for them (the chain badge above carries the signal instead).
    const flightProgramCount = seesFlightProgramInbox
      ? shares.filter(s => {
          if (!s.program) return false;
          if (s.currentPcId === null || !matchesMe(s.currentPcId)) return false;
          if (s.status === "approved" || s.status === "rejected") return false;
          // Use the latest history timestamp (or fall back to the
          // share's own date) to decide whether the row arrived AFTER
          // this PC last opened /flight-program. Mirrors the finals
          // "seen" pattern so the badge clears on visit and re-arms
          // only when something genuinely new lands.
          const arrivedAt =
            (s.history && s.history.length > 0 ? s.history[s.history.length - 1].at : null)
            ?? s.date;
          return arrivedAt > lastSeenFP;
        }).length
      : 0;

    // Messages: inbox items still unread (no readAt) and not yet archived
    // to history. useMessages already filters out in-history items.
    const messageCount = inbox.filter(m => !m.readAt).length;

    // Pending guest approvals: every row is awaiting an Ops decision.
    const pendingCount = pending.length;

    // Final Schedules: count Wing-approved schedules that arrived
    // (approvedAt) AFTER this PC last opened the archive page. Gives
    // Base / HQ / Flight Cmdr / Sqn Cmdr the same unread-style red
    // highlight Ops sees on /schedule-chain + /messages. Only counts
    // when the user has access to the page in the first place — no
    // point in computing it for Ops/deputies who don't see it.
    const finalsCount = finalsViewer
      ? shares.filter(s =>
          s.status === "approved"
          && !!s.approvedAt
          && s.approvedAt > lastSeenFinals,
        ).length
      : 0;

    return {
      "/schedule-chain": chainCount,
      "/flight-program": flightProgramCount,
      "/messages": messageCount,
      "/pending": pendingCount,
      "/final-schedules": finalsCount,
      // Task #299 — super-admin pending-device queue badge.
      "/admin/pending-devices": pendingDeviceCount,
    };
  }, [sharesQ.data, messagesQ.inbox, pendingQ.data, matchesMe, finalsViewer, lastSeenFinals, lastSeenFP, user?.role, user?.scope, pendingDeviceCount]);
}
