// IdentityStrip — small chip placed at the top of HQLayout that shows
// the signed-in user's identity, role, tier, and squadron allow-list as
// reported by `unit_member_self`. Task #299.
//
// Falls back to the legacy auth.tsx `User` shape when `unit_member_self`
// returns null, so commanders still on the old account model see a
// usable identity row.

import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import { fetchMemberSelf, type UnitMemberSelf } from "../lib/unit-join";

export default function IdentityStrip() {
  const { user } = useAuth();
  const [self, setSelf] = useState<UnitMemberSelf | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    if (!user) { setLoading(false); return; }
    fetchMemberSelf()
      .then((m) => { if (alive) { setSelf(m); setLoading(false); } })
      .catch(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [user?.id]);

  if (!user) return null;

  const displayName = self?.display_name ?? user.displayName ?? user.username;
  const username = self?.username ?? user.username;
  const role = self?.role ?? user.role;
  const tier = self?.tier ?? user.scope ?? "—";
  const squadrons = self?.squadron_allow_list ?? user.squadronIds ?? [];

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-amber-500/15 text-amber-300 text-[11px] font-semibold">
          {displayName.split(/\s+/).slice(0, 2).map((s) => s[0]).join("").toUpperCase().slice(0, 2)}
        </span>
        <div>
          <div className="font-medium text-slate-100">{displayName}</div>
          <div className="text-[10px] text-slate-400">@{username}</div>
        </div>
      </div>
      <span className="ml-2 rounded-full border border-slate-700 px-2 py-0.5 font-mono text-[10px] text-slate-300">{role}</span>
      <span className="rounded-full border border-slate-700 px-2 py-0.5 font-mono text-[10px] text-slate-300">{tier}</span>
      <div className="ml-auto flex flex-wrap gap-1">
        {squadrons.length === 0 && <span className="text-[10px] text-slate-500">no squadrons</span>}
        {squadrons.map((s) => (
          <span key={s} className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300">{s}</span>
        ))}
      </div>
      {loading && <span className="text-[10px] text-slate-500">…</span>}
    </div>
  );
}
