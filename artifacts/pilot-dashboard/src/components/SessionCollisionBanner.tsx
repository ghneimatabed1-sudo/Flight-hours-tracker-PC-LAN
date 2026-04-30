import { useEffect, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle } from "lucide-react";
import { getLocalPcId } from "@/lib/cross-pc";
import { useAuth } from "@/lib/auth";

// Mirrors the channel name used by the Diagnostic page. The two
// surfaces share the same handshake protocol so a tab open on the
// Diagnostic page and a tab on any other page see each other in <500ms.
const SESSION_CHANNEL = "rjaf.session.collision";

interface SessionPing {
  kind: "ping" | "pong";
  pcId: string;
  sessionUserId: string;
  at: number;
}

// Yellow persistent banner shown across the top of every authenticated
// page when this browser already has another Hawk Eye sign-in active in
// a different tab with a DIFFERENT auth user. Two tabs in the same
// browser profile share Supabase's auth storage, so the second sign-in
// silently overwrites the first — operators were spending hours
// debugging a "missing PC" that was actually two tabs of the same login.
//
// Detection is best-effort: if BroadcastChannel isn't available (very
// old browsers, some Electron sandboxes) the banner simply never shows
// — we'd rather miss a warning than render a false positive that hides
// real screen real estate.
export function SessionCollisionBanner() {
  const { user } = useAuth();
  const [collidingPcId, setCollidingPcId] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;
    const myUid = String(user?.id ?? "");
    const myPcId = getLocalPcId();
    const ch = new BroadcastChannel(SESSION_CHANNEL);
    const send = (kind: "ping" | "pong") => {
      ch.postMessage({
        kind,
        pcId: myPcId,
        sessionUserId: myUid,
        at: Date.now(),
      } satisfies SessionPing);
    };
    ch.onmessage = (ev: MessageEvent<SessionPing>) => {
      const p = ev.data;
      if (!p || !p.pcId || p.pcId === myPcId) return;
      if (p.sessionUserId && myUid && p.sessionUserId !== myUid) {
        setCollidingPcId(p.pcId);
      }
      if (p.kind === "ping") send("pong");
    };
    // Send the first probe shortly after mount (giving auth.getUser a
    // moment to resolve so myUid is populated) and again 1s later so a
    // tab opened just after this one still answers.
    const t1 = window.setTimeout(() => send("ping"), 250);
    const t2 = window.setTimeout(() => send("ping"), 1_000);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      ch.close();
    };
  }, [user?.id]);

  if (!collidingPcId) return null;

  return (
    <div
      className="w-full bg-amber-500/15 border-b border-amber-500/40 text-amber-100 text-xs px-4 py-2 flex items-center gap-2 flex-wrap"
      data-testid="banner-session-collision"
      role="alert"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span>
        <span className="font-semibold">Another Hawk Eye sign-in is active in this browser.</span>{" "}
        Tabs in the same browser share login storage — the two sessions will overwrite each
        other. Use a separate browser profile or a different browser for the second role.
      </span>
      <Link
        href="/diagnostic"
        className="ms-auto px-2 py-0.5 rounded bg-amber-500/25 hover:bg-amber-500/40 text-amber-50 underline"
        data-testid="link-session-collision-diagnostic"
      >
        Open diagnostic
      </Link>
    </div>
  );
}
