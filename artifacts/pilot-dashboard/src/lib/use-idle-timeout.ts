import { useEffect, useRef } from "react";

/**
 * Fires `onIdle` after `timeoutMs` of no user input.
 *
 * "User input" = mousemove, mousedown, keydown, touchstart, wheel,
 * visibilitychange-back-to-visible. The timer resets on any of these and on
 * remount. Pass `enabled: false` to suspend (e.g. while a modal is open or
 * the user is already on the lock screen).
 *
 * Implementation notes:
 *   - Uses a single timer reset in a ref to avoid re-binding listeners on
 *     every render. We listen at the document level with capture so events
 *     get counted regardless of which element they target.
 *   - Calls `onIdle` exactly once per idle period; the consumer is responsible
 *     for either disabling the hook or unmounting after the callback fires.
 */
export function useIdleTimeout(
  timeoutMs: number,
  onIdle: () => void,
  enabled: boolean = true,
): void {
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;

  useEffect(() => {
    if (!enabled || timeoutMs <= 0) return;

    let timer: number | null = null;
    let fired = false;

    const arm = () => {
      if (fired) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (fired) return;
        fired = true;
        try {
          onIdleRef.current();
        } catch {
          /* swallow — caller errors shouldn't break the timer */
        }
      }, timeoutMs);
    };

    const onActivity = () => {
      if (fired) return;
      arm();
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") arm();
    };

    const events: Array<keyof DocumentEventMap> = [
      "mousemove",
      "mousedown",
      "keydown",
      "touchstart",
      "wheel",
      "scroll",
    ];
    // Use the boolean `useCapture` overload so add and remove always agree.
    // The mismatched-options overload (object on add, object on remove) has
    // historically failed to detach listeners in some Chromium builds, leaving
    // stale capture-phase listeners on document that break input focus until
    // the window is minimised/restored.
    for (const ev of events) {
      document.addEventListener(ev, onActivity, true);
    }
    document.addEventListener("visibilitychange", onVisibility);

    arm();

    return () => {
      if (timer !== null) window.clearTimeout(timer);
      for (const ev of events) {
        document.removeEventListener(ev, onActivity, true);
      }
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [timeoutMs, enabled]);
}
