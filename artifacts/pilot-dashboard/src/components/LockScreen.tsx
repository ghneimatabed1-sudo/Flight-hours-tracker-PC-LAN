import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Lock } from "lucide-react";

/**
 * Full-viewport lock overlay shown over the login page.
 *
 * Visual design:
 *   - Same brand backdrop as the login page (brand-bg) so it feels like a
 *     natural extension, not a separate screen.
 *   - Soft animated radial-glow vignette + slow logo breathing for life.
 *   - Centered Hawk Eye emblem & wordmark, large clock + date.
 *   - "Press any key to unlock" hint pinned to the bottom.
 *
 * Behavior:
 *   - Any mousemove, click, key press, scroll, touch, or wheel event calls
 *     `onUnlock`. The very-first frame after mount intentionally ignores
 *     stray events (a 250ms grace period) so the same click that activated
 *     the lock doesn't immediately dismiss it.
 *   - Locale-aware date/time, updates every second.
 */
export default function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const { t, lang } = useI18n();
  const [now, setNow] = useState<Date>(() => new Date());
  const [armed, setArmed] = useState(false);

  // Tick clock every second.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // 250ms grace period so the click that opened the lock doesn't dismiss it.
  useEffect(() => {
    const id = window.setTimeout(() => setArmed(true), 250);
    return () => window.clearTimeout(id);
  }, []);

  // Listen for any user input and unlock.
  useEffect(() => {
    if (!armed) return;
    const wake = () => onUnlock();
    const events: Array<keyof DocumentEventMap> = [
      "mousemove",
      "mousedown",
      "keydown",
      "touchstart",
      "wheel",
      "scroll",
    ];
    // Boolean `useCapture` overload so add/remove always match. Object-form
    // options have left stale listeners attached in some Chromium builds,
    // which then swallow keystrokes from real input fields after the lock
    // screen unmounts (the freeze that only minimise/restore can clear).
    for (const ev of events) {
      document.addEventListener(ev, wake, true);
    }
    return () => {
      for (const ev of events) {
        document.removeEventListener(ev, wake, true);
      }
    };
  }, [armed, onUnlock]);

  const dateLocale = lang === "ar" ? "ar-JO" : "en-GB";
  const timeStr = now.toLocaleTimeString(dateLocale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const dateStr = now.toLocaleDateString(dateLocale, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <div
      data-testid="lock-screen"
      className="fixed inset-0 z-[100] brand-bg overflow-hidden cursor-none"
      aria-label={t("lockScreenAria")}
      role="dialog"
    >
      {/* Animated radial vignette — gives depth, very low opacity so the
          login brand bg keeps its identity. */}
      <div className="lock-vignette absolute inset-0 pointer-events-none" />

      {/* Subtle moving sheen across the top quarter. */}
      <div className="lock-sheen absolute inset-x-0 top-0 h-1/2 pointer-events-none" />

      <div className="relative h-full w-full flex flex-col items-center justify-center px-6">
        {/* Big centerpiece is the RJAF service emblem (the institutional
            mark). The wordmark sits below as the product credit. */}
        <img
          src="brand/emblem.png"
          alt=""
          aria-hidden="true"
          className="h-32 w-32 object-contain mb-5 lock-breathe drop-shadow-[0_0_28px_rgba(212,175,55,0.35)]"
        />
        <div className="flex items-center gap-3 max-w-[80vw] opacity-95">
          <span
            className="gold-grad font-bold tracking-[0.32em] text-3xl md:text-4xl select-none"
            style={{ fontFamily: "Inter, 'Segoe UI', system-ui, sans-serif" }}
          >
            HAWK EYE
          </span>
        </div>

        <div className="mt-12 flex flex-col items-center select-none">
          <div className="text-7xl md:text-8xl font-light tracking-[0.08em] text-foreground tabular-nums lock-time">
            {timeStr}
          </div>
          <div className="mt-2 text-xs md:text-sm uppercase tracking-[0.32em] text-muted-foreground/85">
            {dateStr}
          </div>
        </div>

        <div className="absolute bottom-10 inset-x-0 flex flex-col items-center gap-2 select-none">
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.28em] text-muted-foreground/80">
            <Lock className="h-3 w-3 text-amber-400/90" />
            {t("lockScreenLocked")}
          </div>
          <div className="text-[11px] text-muted-foreground/65">
            {t("lockScreenWake")}
          </div>
        </div>
      </div>
    </div>
  );
}
