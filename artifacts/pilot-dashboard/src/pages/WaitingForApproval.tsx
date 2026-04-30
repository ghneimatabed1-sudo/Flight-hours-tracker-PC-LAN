// WaitingForApproval — polling screen between request submission and
// the super-admin's decision. Task #299.
//
// Behaviour:
//   • Polls `unit_request_status` every 4 seconds.
//   • On `approved`: pulls the freshly-minted Supabase email + password
//     from the response, signs in transparently with
//     `supabase.auth.signInWithPassword`, then clears the local pending
//     state so the next render lands on the dashboard via auth.tsx's
//     normal session listener.
//   • On `rejected`: shows the reason and offers "Start over" which
//     clears the pending state and routes back to /.
//   • On `ignored` or any other terminal: same as rejected.
//   • Survives reload — the request_id + fingerprint are stored in
//     localStorage by JoinSetup.

import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  getRequestStatus, getPendingRequest, clearPendingRequest, claimDevice,
} from "../lib/unit-join";
import { supabase } from "../lib/supabase";
import { isLanSessionLoginEnabled } from "../lib/internal-migration";

type Phase =
  | { kind: "polling" }
  | { kind: "signing-in" }
  | { kind: "approved-manual"; detail: string | null }
  | { kind: "rejected"; reason: string | null }
  | { kind: "ignored" }
  | { kind: "expired" }
  | { kind: "error"; detail: string };

const POLL_INTERVAL_MS = 4000;

export default function WaitingForApproval() {
  const [, navigate] = useLocation();
  const pending = getPendingRequest();
  const lanMode = isLanSessionLoginEnabled();
  const [phase, setPhase] = useState<Phase>({ kind: "polling" });
  const [elapsed, setElapsed] = useState(0);
  const [manualTick, setManualTick] = useState(0);
  const tickRef = useRef<number | null>(null);

  // Wall-clock counter so the user sees something is alive.
  useEffect(() => {
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (lanMode) {
      clearPendingRequest();
      navigate("/login", { replace: true });
      return;
    }
    if (!pending) {
      navigate("/", { replace: true });
      return;
    }
    let alive = true;
    const poll = async () => {
      if (!alive) return;
      try {
        const s = await getRequestStatus(pending.requestId);
        if (!alive) return;
        if (s.status === "approved" && s.supabase_email && supabase) {
          setPhase({ kind: "signing-in" });
          // Step 1: claim — exchange the throw-away placeholder password
          // for the password the joining laptop chose at JoinSetup time.
          // The server only ever sees the SHA-256 of that password (set
          // at request_join time); the claim edge function verifies the
          // claim_token + password hash, then calls
          // admin.updateUserById to install the real bcrypt hash.
          if (!s.claim_consumed) {
            const claim = await claimDevice(pending.requestId, pending.claimToken, pending.password);
            if (!alive) return;
            if (!claim.ok) {
              setPhase({ kind: "error", detail: `Claim failed: ${claim.error ?? "unknown"}` });
              return;
            }
          }
          // Step 2: sign in with the password the user actually typed.
          const { error } = await supabase.auth.signInWithPassword({
            email: s.supabase_email,
            password: pending.password,
          });
          if (!alive) return;
          if (error) {
            setPhase({ kind: "error", detail: `Sign-in after approval failed: ${error.message}` });
            return;
          }
          // Successful sign-in. Clear local pending and full-reload so
          // auth.tsx hydrates the new session on a clean tree. We use
          // location.hash="" rather than href="/" so the hash router
          // (Electron) lands on the dashboard root.
          clearPendingRequest();
          window.location.hash = "/";
          window.location.reload();
          return;
        }
        if (s.status === "approved") {
          // Recovery path: approval completed but this client cannot finish
          // automatic sign-in (missing Supabase config/session/email).
          // Keep the operator in control with a manual "Continue to login"
          // action instead of silently polling forever.
          setPhase({
            kind: "approved-manual",
            detail: !supabase
              ? "Approved, but this build is not cloud-configured for automatic sign-in."
              : (!s.supabase_email
                  ? "Approved, but the server response did not include sign-in email."
                  : null),
          });
          return;
        }
        if (s.status === "rejected") { setPhase({ kind: "rejected", reason: s.decision_reason }); return; }
        if (s.status === "ignored")  { setPhase({ kind: "ignored" }); return; }
        if (s.status === "unknown")  { setPhase({ kind: "expired" }); return; }
        // status === 'pending' — keep polling
      } catch (err) {
        // Transient error — log and keep going.
        // eslint-disable-next-line no-console
        console.warn("[join-status]", err);
      }
      if (alive) tickRef.current = window.setTimeout(poll, POLL_INTERVAL_MS);
    };
    void poll();
    return () => {
      alive = false;
      if (tickRef.current) window.clearTimeout(tickRef.current);
    };
  }, [lanMode, pending, navigate, manualTick]);

  if (lanMode) return null;
  if (!pending) return null;

  const startOver = () => {
    clearPendingRequest();
    navigate("/", { replace: true });
  };
  const continueToLogin = () => {
    clearPendingRequest();
    navigate("/login", { replace: true });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 grid place-items-center p-6">
      <div className="w-full max-w-md space-y-5 rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">
            {phase.kind === "polling" && "Waiting for super admin approval…"}
            {phase.kind === "signing-in" && "Approved — signing you in…"}
            {phase.kind === "approved-manual" && "Approved — continue to login"}
            {phase.kind === "rejected" && "Request rejected"}
            {phase.kind === "ignored" && "Request set aside"}
            {phase.kind === "expired" && "Request not found"}
            {phase.kind === "error" && "Sign-in error"}
          </h1>
          <p className="text-xs text-slate-400">
            Request <span className="font-mono text-slate-300">{pending.requestId.slice(0, 8)}…</span>
          </p>
        </div>

        {/* Review-round-4 identity strip — show display name, role,
            and the squadron list the operator picked at JoinSetup
            time so they can confirm the SA will see the right
            identity. */}
        <div
          data-testid="waiting-identity-strip"
          className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-1.5 text-xs"
        >
          <div className="flex justify-between gap-2">
            <span className="text-slate-500">Display name</span>
            <span className="text-slate-100 text-right">{pending.displayName}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-slate-500">Username</span>
            <span className="font-mono text-slate-200 text-right">{pending.username}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-slate-500">Role</span>
            <span className="font-mono text-slate-200 text-right uppercase">{pending.role}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-slate-500">Squadron(s)</span>
            <span className="text-slate-200 text-right">
              {pending.squadronNames.length > 0 ? pending.squadronNames.join(", ") : "—"}
            </span>
          </div>
          <p className="pt-1 text-[10px] text-slate-500">
            If any of this is wrong, hit "Start over" and refile.
          </p>
        </div>

        {phase.kind === "polling" && (
          <div className="space-y-3">
            <div className="h-2 overflow-hidden rounded-full bg-slate-800">
              <div className="h-full w-1/3 animate-pulse bg-amber-500/70" />
            </div>
            <p className="text-sm text-slate-300">
              Your super admin will see this on their dashboard within
              seconds. Ask them to open <span className="font-mono">Pending Devices</span>.
            </p>
            <p className="text-[11px] text-slate-500">
              Polling every {POLL_INTERVAL_MS / 1000} seconds. You can close
              this PC and come back — the request will still be here.
              Elapsed: {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}.
            </p>
            <button
              type="button"
              onClick={() => setManualTick((x) => x + 1)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-900"
            >
              Refresh approval status now
            </button>
          </div>
        )}

        {phase.kind === "signing-in" && (
          <div className="text-sm text-emerald-300">
            Approved. Loading your dashboard…
          </div>
        )}

        {phase.kind === "approved-manual" && (
          <div className="space-y-3">
            <div className="rounded border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-200">
              Your request is approved. Continue to Login and sign in with your approved username/password.
              {phase.detail ? ` ${phase.detail}` : ""}
            </div>
            <button
              type="button"
              onClick={continueToLogin}
              className="w-full rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
            >
              Continue to Login
            </button>
            <button
              type="button"
              onClick={() => setManualTick((x) => x + 1)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-900"
            >
              Refresh approval status now
            </button>
          </div>
        )}

        {(phase.kind === "rejected" || phase.kind === "ignored" || phase.kind === "expired" || phase.kind === "error") && (
          <div className="space-y-3">
            <div className="rounded border border-rose-500/40 bg-rose-500/5 px-3 py-2 text-sm text-rose-200">
              {phase.kind === "rejected" && (phase.reason ?? "Your super admin rejected this request without giving a reason.")}
              {phase.kind === "ignored" && "Your super admin set this request aside. Contact them or start a new request."}
              {phase.kind === "expired" && "This request no longer exists in the queue. It may have been purged."}
              {phase.kind === "error" && phase.detail}
            </div>
            <button
              type="button"
              onClick={startOver}
              className="w-full rounded-md bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-amber-400"
            >
              Start over
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
