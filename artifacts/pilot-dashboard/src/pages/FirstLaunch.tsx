// FirstLaunch — entry point for a fresh laptop with no bound member.
//
// Task #299. Replaces the old "License Key + Set Up This Device" pair.
// Round-3 review rework: the super-admin button is ALWAYS rendered so
// the operator never wonders where it went; when an SA already exists
// we render the button DISABLED with an explanatory message instead
// of silently hiding it. We also gate the "Request to join" button on
// at least one squadron existing in the cloud, otherwise the join
// would land on a JoinSetup page with an empty squadron picker and
// fail at submit time.
//
// Per CO request after v1.1.123: the legacy "Super admin sign-in" entry
// is restored as a third always-available button. This routes to the
// existing /login page (standard supabase email-and-password auth) so
// the super admin can come back in on a fresh laptop or after a
// re-install — without it, an SA whose original laptop dies has no
// way back in (the bootstrap path is locked once an SA already exists,
// and the join roles list does not include super_admin). This does
// NOT create a second SA, does NOT bypass the join-secret gate (which
// only protects the join-request anti-spam flow), and does NOT widen
// any RLS policy — the auth itself is standard supabase
// signInWithPassword that the rest of the dashboard already relies on.
//
// Routed unconditionally from App.tsx when:
//   • no Supabase session is live, AND
//   • no pending join request is parked in localStorage.

import { Link } from "wouter";
import { useEffect, useState } from "react";
import {
  checkSuperAdminExists, checkSuperAdminSetupAllowed, listSquadronsForJoin,
  unitJoinConfigured,
} from "../lib/unit-join";
import { isLanSessionLoginEnabled } from "../lib/internal-migration";

type CloudState =
  | { kind: "loading" }
  | { kind: "offline" }
  /** Cloud join/bootstrap is off, but LAN session login is on — use /login, not Supabase-first-launch flows. */
  | { kind: "lan-local" }
  | { kind: "needs-setup"; squadronCount: number }
  | { kind: "ready"; squadronCount: number; superAdminExists: boolean };

export default function FirstLaunch() {
  const [cloud, setCloud] = useState<CloudState>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    if (!unitJoinConfigured) {
      if (isLanSessionLoginEnabled()) {
        setCloud({ kind: "lan-local" });
        return () => { alive = false; };
      }
      setCloud({ kind: "offline" });
      return () => { alive = false; };
    }
    (async () => {
      try {
        const [exists, allowed, squadrons] = await Promise.all([
          checkSuperAdminExists(),
          checkSuperAdminSetupAllowed(),
          listSquadronsForJoin(),
        ]);
        if (!alive) return;
        const squadronCount = squadrons.length;
        if (!exists && allowed) setCloud({ kind: "needs-setup", squadronCount });
        else setCloud({ kind: "ready", squadronCount, superAdminExists: exists });
      } catch {
        if (alive) setCloud({ kind: "offline" });
      }
    })();
    return () => { alive = false; };
  }, []);

  const offline =
    cloud.kind === "offline" || cloud.kind === "loading" || cloud.kind === "lan-local";
  const saButtonEnabled = cloud.kind === "needs-setup";
  const squadronCount =
    cloud.kind === "needs-setup" || cloud.kind === "ready" ? cloud.squadronCount : 0;
  const joinButtonEnabled = !offline && squadronCount > 0;
  const lanLocal = cloud.kind === "lan-local";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 grid place-items-center p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-3">
          <img
            src="brand/emblem.png"
            alt="Royal Jordanian Air Force"
            draggable={false}
            className="mx-auto h-24 w-24 object-contain"
            data-testid="img-rjaf-emblem"
          />
          <h1 className="text-2xl font-semibold">Squadron Management System</h1>
          <p className="text-sm text-slate-400">Welcome to your unit's logbook.</p>
        </div>

        <div className="space-y-3">
          {/* Super-admin button is ALWAYS rendered so the operator
              can see whether bootstrap is available. Disabled state
              carries an explanation underneath. */}
          {saButtonEnabled ? (
            <Link
              href="/setup/super-admin"
              data-testid="link-super-admin-setup"
              className="block w-full rounded-lg bg-emerald-500 px-4 py-3 text-center font-semibold text-slate-900 hover:bg-emerald-400 transition"
            >
              Set up this unit's super admin
            </Link>
          ) : (
            <button
              type="button"
              disabled
              data-testid="link-super-admin-setup"
              aria-disabled="true"
              className="block w-full rounded-lg bg-slate-800 px-4 py-3 text-center font-semibold text-slate-500 cursor-not-allowed"
            >
              {lanLocal ? "Cloud setup unavailable in LAN mode" : "Set up this unit's super admin"}
            </button>
          )}

          {joinButtonEnabled ? (
            <Link
              href="/join/setup"
              data-testid="link-join"
              className="block w-full rounded-lg bg-amber-500 px-4 py-3 text-center font-semibold text-slate-900 hover:bg-amber-400 transition"
            >
              Request to join this unit
            </Link>
          ) : (
            <button
              type="button"
              disabled
              data-testid="link-join"
              aria-disabled="true"
              className="block w-full rounded-lg bg-slate-800 px-4 py-3 text-center font-semibold text-slate-500 cursor-not-allowed"
            >
              {lanLocal ? "Cloud join unavailable in LAN mode" : "Request to join this unit"}
            </button>
          )}

          {/* Always-available re-entry path. Targets the existing
              /login page (App.tsx routes /login through to LoginGate
              regardless of FirstLaunch state). Standard email +
              password sign-in via supabase auth. Designed primarily
              for the super admin coming back on a fresh laptop. */}
          <Link
            href="/login"
            data-testid="link-existing-account"
            className="block w-full rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-3 text-center font-semibold text-slate-200 hover:bg-slate-800 transition"
          >
            {lanLocal ? "LAN sign-in" : "Super admin sign-in"}
          </Link>
        </div>

        {cloud.kind === "loading" && (
          <p className="text-center text-[11px] text-slate-500">Checking cloud reachability…</p>
        )}
        {cloud.kind === "offline" && (
          <div className="rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-200">
            Cloud not reachable from this PC, or this build wasn't
            issued with a join secret. Both setup and join are disabled.
          </div>
        )}
        {cloud.kind === "lan-local" && (
          <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3 text-xs text-sky-100">
            <strong className="font-medium text-sky-50">LAN sign-in mode.</strong>{" "}
            The first-screen cloud setup and “request to join” need Supabase
            plus a join secret — they stay off on purpose here. Use{" "}
            <strong className="font-medium">Super admin sign-in</strong> below
            with the username and password you created on the LAN server
            (bootstrap), or any other LAN account your server has.
          </div>
        )}
        {cloud.kind === "needs-setup" && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-200">
            No super admin exists yet for this unit. You're allowed to
            bootstrap one from this PC. Once a super admin is set, this
            option locks; additional commanders must join via the
            normal request flow.
          </div>
        )}
        {cloud.kind === "ready" && cloud.superAdminExists && (
          <div className="rounded-md border border-slate-700 bg-slate-900/50 p-3 text-xs text-slate-400">
            A super admin already exists for this unit. Setup is locked.
            To join this unit, file a join request and wait for the
            existing super admin to approve it from their laptop.
          </div>
        )}
        {(cloud.kind === "needs-setup" || cloud.kind === "ready") && squadronCount === 0 && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
            This unit doesn't have any squadrons configured yet. The
            super admin must add at least one squadron before any other
            commander can request to join.
          </div>
        )}

        <p className="text-center text-[11px] text-slate-500">
          {lanLocal
            ? "LAN mode is active. Sign in with a LAN account from your internal server."
            : "Joining will send a request to your unit's super admin. You'll stay on the next screen until it's approved."}
        </p>
      </div>
    </div>
  );
}
