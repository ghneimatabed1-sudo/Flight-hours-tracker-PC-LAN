import { useEffect, useState } from "react";
import { subscribeUndo, triggerUndo, dismissUndo, type UndoEntry } from "@/lib/undo-store";
import { Undo2, X } from "lucide-react";

// Bottom-center floating toast that surfaces the most recent reversible
// action (sortie edit or delete) and counts down 30 seconds before the
// action becomes permanent. Mounted once at the App root.
export function UndoToast() {
  const [entry, setEntry] = useState<UndoEntry | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => subscribeUndo(setEntry), []);

  useEffect(() => {
    if (!entry) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [entry?.id]);

  if (!entry) return null;

  const totalMs = Math.max(1, entry.expiresAt - entry.startedAt);
  const remainingMs = Math.max(0, entry.expiresAt - now);
  const remainingSecs = Math.max(0, Math.ceil(remainingMs / 1000));
  const pct = Math.max(0, Math.min(1, remainingMs / totalMs));

  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] min-w-[320px] max-w-[420px] bg-card border border-border rounded-lg shadow-2xl overflow-hidden"
      data-testid="undo-toast"
      role="status"
      aria-live="polite"
    >
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="flex-1 text-sm" data-testid="undo-toast-message">{entry.message}</div>
        <div
          className="text-xs text-muted-foreground tabular-nums w-7 text-right"
          data-testid="undo-toast-countdown"
        >
          {remainingSecs}s
        </div>
        <button
          onClick={() => { void triggerUndo(); }}
          className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs font-semibold inline-flex items-center gap-1.5 hover:opacity-90"
          data-testid="button-undo"
        >
          <Undo2 className="h-3.5 w-3.5" />
          Undo
        </button>
        <button
          onClick={() => dismissUndo()}
          className="p-1 rounded text-muted-foreground hover:bg-secondary"
          aria-label="Dismiss"
          data-testid="button-undo-dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="h-0.5 bg-secondary">
        <div
          className="h-full bg-primary transition-[width] duration-200 ease-linear"
          style={{ width: `${pct * 100}%` }}
        />
      </div>
    </div>
  );
}
