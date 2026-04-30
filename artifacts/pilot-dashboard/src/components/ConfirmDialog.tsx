export interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
  danger?: boolean;
}

// NOTE: do NOT add `backdrop-blur-*` to the overlay below. Chromium's
// backdrop-filter on Windows w/ HW acceleration leaves a compositor-layer
// artifact that intermittently swallows keystrokes from inputs in the
// *next* dialog the user opens (e.g. Add Pilot right after delete-confirm).
// bg-black/70 is just as visually present and never breaks input.
export function ConfirmDialog({ title, message, confirmLabel, onCancel, onConfirm, busy, danger }: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-card border border-border rounded-lg shadow-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b border-border">
          <div className="text-base font-semibold">{title}</div>
        </div>
        <div className="p-4 text-sm text-muted-foreground whitespace-pre-line">{message}</div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
          <button onClick={onCancel} className="px-4 py-2 rounded-md bg-secondary border border-border text-sm" data-testid="button-cancel">Cancel</button>
          <button
            onClick={onConfirm}
            disabled={busy}
            data-testid="button-confirm"
            className={`px-4 py-2 rounded-md text-sm font-medium disabled:opacity-50 ${danger ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`}
          >
            {busy ? "…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
