// SuperAdminSetup — one-shot bootstrap for the very first laptop on a
// brand-new unit. Visible only when:
//   • cloud is reachable AND
//   • `unit_super_admin_setup_allowed()` returns true (no SA exists yet
//     AND no SA already approved).
//
// Calls the `unit-super-admin-setup` edge function which creates the
// auth.users row with role='super_admin' + tier='hq', mirrors into
// public.users, and atomically marks the bootstrap window closed.
// Task #299.

import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import {
  setupSuperAdmin, checkSuperAdminSetupAllowed, unitJoinConfigured,
} from "../lib/unit-join";
import { supabase } from "../lib/supabase";
import { isLanSessionLoginEnabled } from "../lib/internal-migration";

export default function SuperAdminSetup() {
  const [, navigate] = useLocation();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!unitJoinConfigured) { setAllowed(false); return; }
    checkSuperAdminSetupAllowed()
      .then((v) => { if (alive) setAllowed(v); })
      .catch(() => { if (alive) setAllowed(false); });
    return () => { alive = false; };
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!unitJoinConfigured) { setErr("This installation isn't configured for cloud setup."); return; }
    const em = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { setErr("Enter a valid email."); return; }
    const u = username.trim().toLowerCase();
    if (u.length < 3) { setErr("Username must be at least 3 characters."); return; }
    if (!/^[a-z0-9._-]+$/.test(u)) { setErr("Username can only contain letters, numbers, dot, underscore, and dash."); return; }
    if (displayName.trim().length < 1) { setErr("Display name is required."); return; }
    if (password.length < 12) { setErr("Super-admin password must be at least 12 characters."); return; }
    if (password !== confirmPw) { setErr("Passwords do not match."); return; }
    setBusy(true);
    const r = await setupSuperAdmin({ email: em, password, displayName: displayName.trim(), username: u });
    if (!r.ok) {
      setBusy(false);
      const msg = r.error === "super_admin_already_exists" ? "A super admin already exists for this unit. Use 'I already have an account'."
        : r.error === "unauthorized" ? "Setup is not allowed right now."
        : r.error === "server_misconfigured" ? "Cloud not reachable from this PC."
        : `Setup failed (${r.error}).`;
      setErr(msg);
      return;
    }
    if (!supabase) { setBusy(false); setErr("Created, but cloud sign-in isn't available."); return; }
    const { error: signInErr } = await supabase.auth.signInWithPassword({ email: em, password });
    setBusy(false);
    if (signInErr) {
      setErr(`Created, but sign-in failed: ${signInErr.message}. Try /login.`);
      return;
    }
    window.location.hash = "/";
    window.location.reload();
  };

  if (allowed === null) {
    return <div className="min-h-screen bg-slate-950 text-slate-100 grid place-items-center text-sm text-slate-400">Checking…</div>;
  }
  if (isLanSessionLoginEnabled()) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 grid place-items-center p-6">
        <div className="w-full max-w-md space-y-4 rounded-xl border border-sky-700/40 bg-sky-900/20 p-6 text-center">
          <h1 className="text-lg font-semibold">LAN session mode active</h1>
          <p className="text-sm text-sky-100/90">
            Cloud super-admin bootstrap is disabled in LAN mode. Use LAN login
            with an existing LAN account from your internal server.
          </p>
          <Link href="/login" className="inline-block rounded-md border border-sky-400/40 px-3 py-2 text-sm text-sky-50 hover:bg-sky-800/40">
            Go to LAN login
          </Link>
        </div>
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 grid place-items-center p-6">
        <div className="w-full max-w-md space-y-4 rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-center">
          <h1 className="text-lg font-semibold">Super-admin setup not available</h1>
          <p className="text-sm text-slate-400">
            {!unitJoinConfigured
              ? "This installation isn't configured for cloud setup. The super admin must initialise from a build that includes the cloud join secret."
              : "This unit already has a super admin, or cloud setup is locked. Use 'I already have an account' or file a join request instead."}
          </p>
          <Link href="/" className="inline-block rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800">← Back</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 grid place-items-center p-6">
      <form onSubmit={onSubmit} className="w-full max-w-lg space-y-5 rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <div>
          <h1 className="text-xl font-semibold">Set up your unit's super admin</h1>
          <p className="mt-1 text-xs text-slate-400">
            This is a one-time bootstrap. Once you submit, no further
            super-admin setup is allowed from this screen — additional
            commanders join via the normal request flow.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="space-y-1 sm:col-span-2">
            <span className="text-xs uppercase tracking-wide text-slate-400">Email</span>
            <input type="email" value={email} autoComplete="off" onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="sa@unit.example" required />
          </label>
          <label className="space-y-1">
            <span className="text-xs uppercase tracking-wide text-slate-400">Username</span>
            <input type="text" value={username} autoComplete="off" onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="superadmin" required />
          </label>
          <label className="space-y-1">
            <span className="text-xs uppercase tracking-wide text-slate-400">Display name</span>
            <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm" placeholder="Unit Super Admin" required />
          </label>
          <label className="space-y-1">
            <span className="text-xs uppercase tracking-wide text-slate-400">Password (≥ 12 chars)</span>
            <input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm" required />
          </label>
          <label className="space-y-1">
            <span className="text-xs uppercase tracking-wide text-slate-400">Confirm password</span>
            <input type="password" value={confirmPw} autoComplete="new-password" onChange={(e) => setConfirmPw(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm" required />
          </label>
        </div>

        {err && <div className="rounded border border-rose-500/40 bg-rose-500/5 px-3 py-2 text-sm text-rose-200">{err}</div>}

        <div className="flex items-center justify-between">
          <Link href="/" className="text-xs text-slate-400 hover:text-slate-200">← Back</Link>
          <button type="submit" disabled={busy}
            className="rounded-md bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-amber-400 disabled:opacity-50">
            {busy ? "Setting up…" : "Create super admin"}
          </button>
        </div>
      </form>
    </div>
  );
}
