// JoinSetup — single form that files a `device_requests` row via
// `unit_request_join`. On success the request_id is parked in
// localStorage and the user is sent to /join/waiting where the page
// polls until approval / rejection.
//
// Task #299.

import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  listSquadronsForJoin, requestJoin, persistPendingRequest,
  unitJoinConfigured, type UnitSquadron, type UnitRole,
} from "../lib/unit-join";
import { isLanSessionLoginEnabled } from "../lib/internal-migration";

const ROLES: { value: UnitRole; label: string; multiSquadron: boolean }[] = [
  { value: "ops",      label: "Squadron Operator",        multiSquadron: false },
  { value: "flight",   label: "Flight Commander",         multiSquadron: false },
  { value: "squadron", label: "Squadron Commander",       multiSquadron: false },
  { value: "wing",     label: "Wing Commander",           multiSquadron: true  },
  { value: "base",     label: "Base Commander",           multiSquadron: true  },
  { value: "hq",       label: "HQ Commander",             multiSquadron: true  },
];

function getFingerprint(): string {
  try {
    const v = localStorage.getItem("rjaf.fp");
    if (v) return v;
  } catch { /* ignore */ }
  // Fallback fingerprint, persisted so the same laptop reuses it.
  const seed = `${navigator.userAgent}|${navigator.language}|${screen.width}x${screen.height}|${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  const fp = "FP-" + (h >>> 0).toString(16).toUpperCase().padStart(8, "0") + "-" + Math.random().toString(16).slice(2, 6).toUpperCase();
  try { localStorage.setItem("rjaf.fp", fp); } catch { /* ignore */ }
  return fp;
}

export default function JoinSetup() {
  const lanMode = isLanSessionLoginEnabled();
  const [, navigate] = useLocation();
  const [squadrons, setSquadrons] = useState<UnitSquadron[]>([]);
  const [role, setRole] = useState<UnitRole>("ops");
  const [selected, setSelected] = useState<string[]>([]);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingSquadrons, setLoadingSquadrons] = useState(true);

  useEffect(() => {
    let alive = true;
    listSquadronsForJoin()
      .then((list) => { if (alive) { setSquadrons(list); setLoadingSquadrons(false); } })
      .catch(() => { if (alive) { setLoadingSquadrons(false); } });
    return () => { alive = false; };
  }, []);

  const roleSpec = useMemo(() => ROLES.find((r) => r.value === role)!, [role]);

  const onRoleChange = (next: UnitRole) => {
    setRole(next);
    setSelected([]);
  };
  const toggleSquadron = (name: string) => {
    if (roleSpec.multiSquadron) {
      setSelected((s) => s.includes(name) ? s.filter((x) => x !== name) : [...s, name]);
    } else {
      setSelected([name]);
    }
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!unitJoinConfigured) {
      setErr("This installation isn't configured for cloud join. Contact your super admin.");
      return;
    }
    const u = username.trim().toLowerCase();
    if (u.length < 3) { setErr("Username must be at least 3 characters."); return; }
    if (!/^[a-z0-9._-]+$/.test(u)) { setErr("Username can only contain letters, numbers, dot, underscore, and dash."); return; }
    if (displayName.trim().length < 1) { setErr("Display name is required."); return; }
    if (password.length < 8) { setErr("Password must be at least 8 characters."); return; }
    if (password !== confirmPw) { setErr("Passwords do not match."); return; }
    if (role !== "hq" && selected.length === 0) { setErr("Pick at least one squadron."); return; }
    if (!roleSpec.multiSquadron && selected.length > 1) { setErr("This role only allows one squadron."); return; }

    setBusy(true);
    const fp = getFingerprint();
    const r = await requestJoin({
      role,
      squadronNames: selected,
      username: u,
      displayName: displayName.trim(),
      password,
      fingerprint: fp,
    });
    setBusy(false);
    if (!r.ok) {
      const msg = r.error === "username_too_short" ? "Username must be at least 3 characters."
        : r.error === "password_too_short" ? "Password must be at least 8 characters."
        : r.error === "single_squadron_only_for_role" ? "This role only allows one squadron."
        : r.error === "unauthorized" ? "Join is locked. Contact your super admin to unlock new joins."
        : r.error === "server_misconfigured" ? "Cloud not reachable from this PC."
        : `Could not file request (${r.error}).`;
      setErr(msg);
      return;
    }
    persistPendingRequest({
      requestId: r.result.requestId,
      username: u,
      fingerprint: fp,
      claimToken: r.result.claimToken,
      password,
      displayName: displayName.trim(),
      role,
      squadronNames: selected,
    });
    navigate("/join/waiting", { replace: true });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 grid place-items-center p-6">
      {lanMode ? (
        <div className="w-full max-w-lg space-y-4 rounded-xl border border-sky-700/40 bg-sky-900/20 p-6 text-center">
          <h1 className="text-xl font-semibold">LAN session mode active</h1>
          <p className="text-sm text-sky-100/90">
            Cloud join-request flow is disabled in LAN mode. Sign in through LAN login
            with an account created on your internal server.
          </p>
          <div className="flex items-center justify-center gap-3">
            <Link href="/" className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800">
              ← Back
            </Link>
            <Link href="/login" className="rounded-md border border-sky-400/40 px-3 py-2 text-sm text-sky-50 hover:bg-sky-800/40">
              Go to LAN login
            </Link>
          </div>
        </div>
      ) : (
      <form onSubmit={onSubmit} className="w-full max-w-lg space-y-5 rounded-xl border border-slate-800 bg-slate-900/60 p-6">
        <div>
          <h1 className="text-xl font-semibold">Request to Join Your Unit</h1>
          <p className="mt-1 text-xs text-slate-400">
            Your super admin will see this request and approve, reject,
            or ignore it. You'll stay on the next screen until they
            decide.
          </p>
        </div>

        <label className="block space-y-1">
          <span className="text-xs uppercase tracking-wide text-slate-400">Role on this PC</span>
          <select
            value={role}
            onChange={(e) => onRoleChange(e.target.value as UnitRole)}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          >
            {ROLES.map((r) => (<option key={r.value} value={r.value}>{r.label}</option>))}
          </select>
        </label>

        <fieldset className="space-y-1">
          <legend className="text-xs uppercase tracking-wide text-slate-400">
            {roleSpec.multiSquadron ? "Squadrons (one or more)" : "Squadron"}
          </legend>
          <div className="max-h-44 overflow-auto rounded-md border border-slate-800 bg-slate-950 p-2 text-sm">
            {loadingSquadrons && <div className="px-2 py-3 text-slate-500">Loading squadrons…</div>}
            {!loadingSquadrons && squadrons.length === 0 && (
              <div className="px-2 py-3 text-amber-300">
                No squadrons exist yet. Your super admin must create one first.
              </div>
            )}
            {squadrons.map((sq) => {
              const checked = selected.includes(sq.name);
              return (
                <label key={sq.id} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-slate-900 cursor-pointer">
                  <input
                    type={roleSpec.multiSquadron ? "checkbox" : "radio"}
                    name="squadron"
                    checked={checked}
                    onChange={() => toggleSquadron(sq.name)}
                  />
                  <span className="font-mono text-xs text-slate-400 w-12">{sq.number ?? "—"}</span>
                  <span>{sq.name}</span>
                  {sq.base && <span className="ml-auto text-[10px] text-slate-500">{sq.base}</span>}
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-xs uppercase tracking-wide text-slate-400">Username</span>
            <input
              type="text"
              value={username}
              autoComplete="off"
              onChange={(e) => setUsername(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              placeholder="lower.case.only"
              required
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs uppercase tracking-wide text-slate-400">Display name</span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              placeholder="Capt. Bilal Al-Khouri"
              required
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs uppercase tracking-wide text-slate-400">Password</span>
            <input
              type="password"
              value={password}
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              required
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs uppercase tracking-wide text-slate-400">Confirm password</span>
            <input
              type="password"
              value={confirmPw}
              autoComplete="new-password"
              onChange={(e) => setConfirmPw(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
              required
            />
          </label>
        </div>

        {err && <div className="rounded border border-rose-500/40 bg-rose-500/5 px-3 py-2 text-sm text-rose-200">{err}</div>}

        <div className="flex items-center justify-between">
          <Link href="/" className="text-xs text-slate-400 hover:text-slate-200">← Back</Link>
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-amber-400 disabled:opacity-50"
          >
            {busy ? "Submitting…" : "Submit request"}
          </button>
        </div>
      </form>
      )}
    </div>
  );
}
