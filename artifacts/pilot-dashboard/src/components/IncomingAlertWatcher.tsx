import { useEffect, useRef } from "react";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import {
  getLocalPcId,
  useMessages,
  useScheduleShares,
  usePendingApprovals,
} from "@/lib/cross-pc";

// --------------------------------------------------------------------------
// IncomingAlertWatcher
// --------------------------------------------------------------------------
// Mounts once inside the main Layout and watches the three cross-PC inboxes
// (private messages, schedule shares, cross-squadron pending approvals) for
// items that target THIS PC. When a new row appears between two polls it:
//
//   1) plays a short two-tone chirp (Web Audio API — no bundled sample), and
//   2) raises an in-app toast, and
//   3) if the user has granted Notification permission (Electron grants it
//      automatically on Windows), fires an OS-level desktop notification
//      that pops up even when the dashboard window isn't focused.
//
// Only items addressed to the local PC trigger the chime — a wing PC doesn't
// hear the tone when a squadron sends a schedule to a different wing PC, a
// squadron doesn't chime on approvals that don't belong to its squadron,
// and the originator of a message never alerts on their own sent copy.
//
// The first poll after mount primes the "seen" set instead of alerting, so
// historical items already in the inbox from previous sessions don't chime
// every time the app is opened.
// --------------------------------------------------------------------------

// Play a short two-tone chirp via Web Audio. No bundled audio sample is
// needed, which keeps the installer lean and sidesteps the autoplay policy
// once the user has clicked anywhere in the app (they always have, because
// they had to sign in).
function playChirp(): void {
  try {
    const W = window as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const AC = W.AudioContext ?? W.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const now = ctx.currentTime;
    const tones: Array<[number, number]> = [
      [880, 0],      // A5
      [1175, 0.14],  // D6
    ];
    for (const [freq, delay] of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = now + delay;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.28, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.16);
    }
    // Tear the context down so Chrome/Electron doesn't hit the 6-context
    // per-tab cap if a PC receives dozens of alerts over a shift.
    window.setTimeout(() => { ctx.close().catch(() => {}); }, 600);
  } catch {
    // Audio may be blocked (e.g. headless test). Nothing to do.
  }
}

// Fires a native desktop notification WITH the OS default alert sound so
// the PC audibly beeps even when the app window isn't focused. The Web
// Audio chirp still plays inside the app for a familiar in-app cue.
function desktopNotify(title: string, body: string): void {
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, silent: false });
  } catch {
    /* Notification constructor can throw on some platforms; ignore. */
  }
}

export function IncomingAlertWatcher(): null {
  const { toast } = useToast();
  const { user, squadron } = useAuth();
  const myPcId = getLocalPcId() || null;
  // The codebase identifies the home squadron by its human-readable
  // name (same convention used in PendingApprovals.tsx and
  // GuestBackfill.tsx). Keeping the same key here means the watcher
  // and the Pending page see identical rows.
  const homeSquadronId = squadron?.name ?? null;

  // Re-fetching here reuses the same TanStack Query cache entries as the
  // Messages / Schedule Chain / Pending pages, so we don't double the
  // poll rate — each key is de-duplicated at the queryClient level.
  const msgs = useMessages(myPcId);
  const shares = useScheduleShares(myPcId);
  const pend = usePendingApprovals(homeSquadronId);

  // Ask for OS notification permission once per session. Electron on
  // Windows grants "granted" without a prompt, so this is essentially a
  // no-op in the shipped desktop app; browsers prompt the user the first
  // time they open the dashboard.
  useEffect(() => {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  // Per-session "seen" set keyed by the row id, so the same message never
  // chimes twice during one app run. The `primed` flag guards the very
  // first poll: we capture whatever is already there without firing, so
  // reopening the app doesn't replay every pending alert at once.
  const seen = useRef<{
    msg: Set<string>;
    share: Set<string>;
    pend: Set<string>;
    primed: boolean;
  }>({ msg: new Set(), share: new Set(), pend: new Set(), primed: false });

  useEffect(() => {
    if (!myPcId) return;

    // Private messages addressed to this PC. useMessages.inbox is already
    // filtered to `toPcId === myPcId && !inHistory`, but we double-check
    // the to_pc_id here to stay defensive against future changes.
    const incomingMessages = msgs.inbox.filter(m => m.toPcId === myPcId);
    // Schedule shares whose current hop is this PC (the "ball is in your
    // court" state). `currentPcId` is the addressee; originSquadronName is
    // just metadata about who started the sheet.
    const incomingShares = shares.data.filter(s => s.currentPcId === myPcId);
    // Cross-squadron pending approvals belonging to this squadron.
    const incomingPending = pend.data ?? [];

    if (!seen.current.primed) {
      for (const m of incomingMessages) seen.current.msg.add(m.id);
      for (const s of incomingShares) seen.current.share.add(s.id);
      for (const p of incomingPending) seen.current.pend.add(p.id);
      seen.current.primed = true;
      return;
    }

    let fired = false;

    for (const m of incomingMessages) {
      if (seen.current.msg.has(m.id)) continue;
      seen.current.msg.add(m.id);
      fired = true;
      const subject = m.subject?.trim() || "New message";
      const preview = (m.body ?? "").trim().slice(0, 120);
      toast({
        title: `📨 ${subject}`,
        description: `From ${m.fromPcName}${preview ? " — " + preview : ""}`,
      });
      desktopNotify(
        `New message from ${m.fromPcName}`,
        `${subject}${preview ? "\n" + preview : ""}`,
      );
    }

    for (const s of incomingShares) {
      if (seen.current.share.has(s.id)) continue;
      seen.current.share.add(s.id);
      fired = true;
      toast({
        title: `🗒️ Schedule ${s.status} · ${s.date}`,
        description: `From ${s.originSquadronName} (tier: ${s.currentTier})`,
      });
      desktopNotify(
        `Schedule waiting — ${s.date}`,
        `${s.originSquadronName} has sent a ${s.currentTier}-tier schedule for your action.`,
      );
    }

    for (const p of incomingPending) {
      if (seen.current.pend.has(p.id)) continue;
      seen.current.pend.add(p.id);
      fired = true;
      toast({
        title: `✈️ Cross-squadron approval`,
        description: `${p.hostingSquadronName} → ${p.guestPilotName}`,
      });
      desktopNotify(
        "Approval needed",
        `${p.guestPilotName} — flown as guest at ${p.hostingSquadronName}. Review & accept in Pending.`,
      );
    }

    if (fired) playChirp();
  }, [msgs.inbox, shares.data, pend.data, myPcId, toast]);

  // `user` is unused in the effect but its presence reminds us: this
  // watcher should only be mounted inside the authenticated shell so we
  // don't chime on the login screen.
  void user;

  return null;
}
