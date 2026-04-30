import { useState } from "react";
import { Lock, Unlock, Trash2, ShieldAlert } from "lucide-react";
import {
  authorizePc,
  revokePc,
  setThisPcName,
  useFrozenAccess,
  type FrozenAccessGrant,
} from "@/lib/monthly-close";
import { recordAuditEvent } from "@/lib/supabase";
import { appendDemoAudit } from "@/lib/squadron-data";

// Super-admin-only panel for managing which operations PCs are allowed to
// edit, delete, or create sorties whose date sits in the frozen window
// (older than 12 months). The panel renders only after a role check by the
// caller — it has no internal authorization of its own.
//
// Typical flow:
//   1. The pilot/operator opens the dashboard on their PC. The PC's id and
//      friendly name are visible at the top of this panel.
//   2. The super admin signs in on that same PC (or another one) and clicks
//      "Authorize this PC" with an optional reason. The grant persists
//      across reloads and is shared with other tabs on the same browser.
//   3. The pilot can now edit / delete / create sorties in the frozen
//      window. Each change carries the PC's name + the frozen month list
//      into the audit log.
//   4. When the pilot is finished, the super admin clicks Revoke and the
//      PC is locked back out instantly.

interface Props { actor: string; }

export function FrozenAccessPanel({ actor }: Props) {
  const f = useFrozenAccess();
  const [name, setName] = useState(f.pc.name);
  const [note, setNote] = useState("");
  const [otherPcId, setOtherPcId] = useState("");
  const [otherPcName, setOtherPcName] = useState("");

  const renamePc = () => {
    if (name.trim() && name.trim() !== f.pc.name) setThisPcName(name.trim());
  };

  const grant = (id: string, displayName: string, source: "this" | "other") => {
    const g = authorizePc({
      id,
      name: displayName || f.pc.name,
      grantedBy: actor,
      note: note.trim() || undefined,
    });
    auditGrant(g, source === "this" ? "this PC" : "remote PC");
    setNote("");
    if (source === "other") { setOtherPcId(""); setOtherPcName(""); }
  };

  const revoke = (g: FrozenAccessGrant) => {
    const removed = revokePc(g.id);
    if (removed) auditRevoke(removed);
  };

  const auditGrant = (g: FrozenAccessGrant, source: string) => {
    appendDemoAudit({
      ts: new Date().toISOString().replace("T", " ").slice(0, 19),
      user: actor,
      action: "Frozen-records access granted",
      target: `${g.name} (${g.id.slice(0, 8)}…) · ${source}${g.note ? ` · ${g.note}` : ""}`,
    });
    void recordAuditEvent({
      type: "frozen_access.granted",
      actor,
      detail: { pcId: g.id, pcName: g.name, note: g.note ?? null },
    });
  };
  const auditRevoke = (g: FrozenAccessGrant) => {
    appendDemoAudit({
      ts: new Date().toISOString().replace("T", " ").slice(0, 19),
      user: actor,
      action: "Frozen-records access revoked",
      target: `${g.name} (${g.id.slice(0, 8)}…)`,
    });
    void recordAuditEvent({
      type: "frozen_access.revoked",
      actor,
      detail: { pcId: g.id, pcName: g.name },
    });
  };

  return (
    <div className="space-y-4" data-testid="panel-frozen-access">
      <div className="flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-amber-300" />
        <div className="text-sm font-semibold">Frozen-records access (older than 12 months)</div>
      </div>
      <p className="text-xs text-muted-foreground">
        Hours that are more than one year old are frozen and read-only on every
        PC. Authorize a specific operations PC below to let that workstation
        edit, delete, or back-date sorties in the frozen window. Lock it back
        when the pilot is finished — every grant, revoke, and change made under
        a grant is recorded in the audit log.
      </p>

      <div className="rounded-md border border-border bg-secondary/40 p-3 space-y-2">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">This PC</div>
        <div className="grid sm:grid-cols-[1fr_auto] gap-2 items-end">
          <label className="block">
            <span className="text-[11px] text-muted-foreground">Friendly name</span>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              onBlur={renamePc}
              className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm"
              data-testid="input-frozen-pc-name"
            />
          </label>
          <div className="text-[11px] text-muted-foreground font-mono break-all sm:text-right" data-testid="text-frozen-pc-id">
            {f.pc.id}
          </div>
        </div>
        <label className="block">
          <span className="text-[11px] text-muted-foreground">Reason (optional, recorded in audit log)</span>
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="e.g. Captain Salem needs to fix Apr-2025 captain credit"
            className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm"
            data-testid="input-frozen-note"
          />
        </label>
        <div className="flex items-center gap-2">
          {f.thisPcAuthorized ? (
            <button
              type="button"
              onClick={() => {
                const grant = f.authorizedPcs.find(g => g.id === f.pc.id);
                if (grant) revoke(grant);
              }}
              className="px-3 py-1.5 rounded-md bg-destructive/20 text-destructive border border-destructive/40 text-xs font-semibold inline-flex items-center gap-1.5"
              data-testid="button-frozen-lock-this"
            >
              <Lock className="h-3.5 w-3.5" /> Lock this PC again
            </button>
          ) : (
            <button
              type="button"
              onClick={() => grant(f.pc.id, name.trim() || f.pc.name, "this")}
              className="px-3 py-1.5 rounded-md bg-amber-500 text-amber-950 text-xs font-semibold inline-flex items-center gap-1.5"
              data-testid="button-frozen-grant-this"
            >
              <Unlock className="h-3.5 w-3.5" /> Authorize this PC
            </button>
          )}
          <span className="text-[11px] text-muted-foreground">
            {f.thisPcAuthorized
              ? "This PC can currently edit frozen months."
              : "This PC is locked out of frozen months."}
          </span>
        </div>
      </div>

      <details className="rounded-md border border-border bg-secondary/40 p-3">
        <summary className="text-xs cursor-pointer select-none">Authorize a different PC by id</summary>
        <div className="mt-3 space-y-2">
          <p className="text-[11px] text-muted-foreground">
            Ask the operator to read their PC id from this panel on their own
            workstation, then paste it here. The grant takes effect on that PC
            within a few seconds.
          </p>
          <div className="grid sm:grid-cols-2 gap-2">
            <input
              value={otherPcId}
              onChange={e => setOtherPcId(e.target.value)}
              placeholder="PC id (UUID)"
              className="px-3 py-2 rounded-md bg-input border border-border text-sm font-mono"
              data-testid="input-frozen-other-id"
            />
            <input
              value={otherPcName}
              onChange={e => setOtherPcName(e.target.value)}
              placeholder="Friendly name (optional)"
              className="px-3 py-2 rounded-md bg-input border border-border text-sm"
              data-testid="input-frozen-other-name"
            />
          </div>
          <button
            type="button"
            disabled={!otherPcId.trim()}
            onClick={() => grant(otherPcId.trim(), otherPcName.trim(), "other")}
            className="px-3 py-1.5 rounded-md bg-amber-500 text-amber-950 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
            data-testid="button-frozen-grant-other"
          >
            <Unlock className="h-3.5 w-3.5" /> Authorize that PC
          </button>
        </div>
      </details>

      <div className="rounded-md border border-border">
        <div className="px-3 py-2 border-b border-border text-xs uppercase tracking-wider text-muted-foreground flex items-center justify-between">
          <span>Currently authorized PCs</span>
          <span className="font-mono">{f.authorizedPcs.length}</span>
        </div>
        {f.authorizedPcs.length === 0 ? (
          <div className="px-3 py-4 text-xs text-muted-foreground italic" data-testid="text-frozen-empty">
            No PC is authorized — frozen months are locked everywhere.
          </div>
        ) : (
          <ul className="divide-y divide-border" data-testid="list-frozen-grants">
            {f.authorizedPcs.map(g => (
              <li key={g.id} className="px-3 py-2 flex items-center gap-3" data-testid={`row-frozen-grant-${g.id}`}>
                <Unlock className="h-3.5 w-3.5 text-amber-300 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{g.name}</div>
                  <div className="text-[11px] text-muted-foreground font-mono truncate" title={g.id}>{g.id}</div>
                  <div className="text-[11px] text-muted-foreground">
                    Granted {g.grantedAt.replace("T", " ").slice(0, 16)} by {g.grantedBy}
                    {g.note ? ` · ${g.note}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => revoke(g)}
                  className="px-2 py-1 rounded-md bg-destructive/20 text-destructive border border-destructive/40 text-[11px] inline-flex items-center gap-1"
                  data-testid={`button-frozen-revoke-${g.id}`}
                >
                  <Trash2 className="h-3 w-3" /> Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
