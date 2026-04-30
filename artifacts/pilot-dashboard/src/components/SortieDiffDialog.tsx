import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { Sortie } from "@/lib/mock";

// Side-by-side change-summary dialog used for both sortie edits and
// deletes. For edits, only fields whose value actually changed are listed
// (old → new, color-coded). For deletes, every populated field of the
// record is shown in a single column so the operator can verify what is
// about to be removed.

const FIELDS: { key: keyof Sortie; label: string }[] = [
  { key: "date", label: "Date" },
  { key: "acType", label: "A/C Type" },
  { key: "acNumber", label: "A/C Number" },
  { key: "pilotId", label: "Pilot" },
  { key: "coPilotId", label: "Co-Pilot" },
  { key: "sortieType", label: "Sortie Type" },
  { key: "name", label: "Name / Duty" },
  { key: "condition", label: "Condition" },
  { key: "day1", label: "Day 1st PLT" },
  { key: "day2", label: "Day 2nd PLT" },
  { key: "dayDual", label: "Day Dual" },
  { key: "night1", label: "Night 1st PLT" },
  { key: "night2", label: "Night 2nd PLT" },
  { key: "nightDual", label: "Night Dual" },
  { key: "nvg", label: "NVG" },
  { key: "sim", label: "SIM" },
  { key: "actual", label: "Total Time" },
  { key: "dual", label: "Dual flag" },
  { key: "instrumentFlight", label: "Instrument Flight" },
  { key: "ifSim", label: "IF SIM" },
  { key: "ifAct", label: "IF Actual" },
  { key: "ils", label: "ILS approaches" },
  { key: "vor", label: "VOR approaches" },
  { key: "remarks", label: "Remarks" },
];

function fmt(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "—";
  return String(v);
}

interface DiffDialogProps {
  mode: "edit" | "delete";
  before: Sortie;
  after?: Sortie | null;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
  pilotName?: (id: string, ext?: { name: string; squadron: string }) => string;
}

export function SortieDiffDialog({ mode, before, after, onCancel, onConfirm, busy, pilotName }: DiffDialogProps) {
  const display = (k: keyof Sortie, s: Sortie | null | undefined): string => {
    if (!s) return "—";
    if (k === "pilotId") {
      const v = s.pilotId;
      if (s.pilotExternal) return `${s.pilotExternal.name} (${s.pilotExternal.squadron || "guest"})`;
      return pilotName ? pilotName(v) : fmt(v);
    }
    if (k === "coPilotId") {
      const v = s.coPilotId;
      if (s.coPilotExternal) return `${s.coPilotExternal.name} (${s.coPilotExternal.squadron || "guest"})`;
      return pilotName ? pilotName(v) : fmt(v);
    }
    return fmt((s as unknown as Record<string, unknown>)[k as string]);
  };

  const rows = FIELDS.map((f) => {
    const oldStr = display(f.key, before);
    const newStr = mode === "edit" ? display(f.key, after ?? null) : "";
    return { key: f.key, label: f.label, oldStr, newStr, changed: oldStr !== newStr };
  });

  const editChanges = rows.filter((r) => r.changed);
  const deleteFields = rows.filter((r) => r.oldStr !== "—");

  const title = mode === "delete" ? "Delete this sortie?" : "Save these changes?";
  const description = mode === "delete"
    ? "Totals, currencies, archives, and rankings will be recalculated. You'll have 30 seconds to undo after the action commits."
    : "Review the differences below. After you confirm, you'll have 30 seconds to undo before the change becomes permanent.";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="max-w-2xl" data-testid={`dialog-sortie-${mode}`}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="text-xs text-muted-foreground -mt-2 font-mono" data-testid="diff-subject">
          {before.id} · {before.date} · {before.acType} {before.acNumber} · {before.sortieType}
        </div>

        {mode === "edit" && editChanges.length === 0 && (
          // No-changes path doubles as a manual "rescue" for sorties that
          // were saved on an older build whose side-effect chain (e.g. the
          // IRT currency-refresh branch added later) wasn't yet wired in.
          // Hitting Save here re-runs the full update path, which calls
          // applyCurrencyRefresh — and bumpDate is monotonic so re-running
          // it on a healthy sortie is a no-op. That's why the button stays
          // enabled and is relabelled below.
          <div className="text-sm text-muted-foreground italic py-4 text-center border border-border rounded-md space-y-1" data-testid="diff-empty">
            <div>No changes detected.</div>
            <div className="text-[11px] not-italic text-muted-foreground/80">
              Click <span className="font-semibold text-foreground/80">Refresh currencies</span> below to re-run currency &amp; totals refresh on this sortie without editing it.
            </div>
          </div>
        )}

        {mode === "edit" && editChanges.length > 0 && (
          <div className="border border-border rounded-md overflow-hidden">
            <div className="grid grid-cols-[140px_1fr_1fr] text-[11px] uppercase tracking-wider bg-secondary text-muted-foreground">
              <div className="px-2 py-1.5">Field</div>
              <div className="px-2 py-1.5">Before</div>
              <div className="px-2 py-1.5">After</div>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {editChanges.map((r) => (
                <div
                  key={String(r.key)}
                  className="grid grid-cols-[140px_1fr_1fr] text-xs border-t border-border"
                  data-testid={`diff-row-${String(r.key)}`}
                >
                  <div className="px-2 py-1.5 font-medium">{r.label}</div>
                  <div className="px-2 py-1.5 font-mono bg-rose-500/10 text-rose-200 break-words">
                    <span className="line-through decoration-rose-400/40">{r.oldStr}</span>
                  </div>
                  <div className="px-2 py-1.5 font-mono bg-emerald-500/10 text-emerald-200 break-words">
                    {r.newStr}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {mode === "delete" && (
          <div className="border border-rose-400/40 rounded-md overflow-hidden bg-rose-500/5">
            <div className="px-3 py-1.5 text-[11px] uppercase tracking-wider bg-rose-500/15 text-rose-200">
              Will be removed
            </div>
            <div className="max-h-72 overflow-y-auto">
              {deleteFields.map((r) => (
                <div
                  key={String(r.key)}
                  className="grid grid-cols-[160px_1fr] text-xs border-t border-border/60"
                  data-testid={`diff-del-row-${String(r.key)}`}
                >
                  <div className="px-2 py-1.5 font-medium text-muted-foreground">{r.label}</div>
                  <div className="px-2 py-1.5 font-mono">{r.oldStr}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-md bg-secondary border border-border text-sm"
            data-testid="button-diff-cancel"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className={`px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50 ${
              mode === "delete" ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"
            }`}
            data-testid="button-diff-confirm"
          >
            {busy
              ? "…"
              : mode === "delete"
                ? "Delete sortie"
                : editChanges.length === 0
                  ? "Refresh currencies"
                  : "Save changes"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
