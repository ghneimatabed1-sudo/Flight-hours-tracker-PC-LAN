// Full-screen red overlay shown the moment the api-server returns
// HTTP 507 `disk_full` to any fetch. Air-gapped Hawk Eye installs
// cannot email the operator, so the loudest possible UI surface is
// our only escalation path.
//
// State flow:
//   - Module-level `isDiskFull()` flag is flipped by the global fetch
//     interceptor in `lib/api-client.ts` whenever a 507 lands.
//   - This component subscribes to that flag and renders a fixed
//     overlay that intercepts every pointer/keyboard event so the
//     operator can't type more writes while the disk is wedged.
//   - The "I've fixed it, retry" button calls `retryAfterDiskFull()`
//     which re-checks `/api/healthz`. A 200 dismisses the overlay; a
//     non-200 leaves it up so the operator sees the failure as a
//     loud signal that they haven't actually fixed it yet.

import { useCallback, useEffect, useState } from "react";
import { AlertOctagon, Loader2 } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import {
  isDiskFull,
  retryAfterDiskFull,
  subscribeDiskFull,
} from "@/lib/api-client";

export function DiskFullOverlay() {
  const { t } = useI18n();
  const [open, setOpen] = useState<boolean>(isDiskFull());
  const [retrying, setRetrying] = useState<boolean>(false);
  const [retryFailedAt, setRetryFailedAt] = useState<number | null>(null);

  useEffect(() => subscribeDiskFull(setOpen), []);

  const onRetry = useCallback(async () => {
    setRetrying(true);
    setRetryFailedAt(null);
    try {
      const ok = await retryAfterDiskFull();
      if (!ok) setRetryFailedAt(Date.now());
    } finally {
      setRetrying(false);
    }
  }, []);

  if (!open) return null;

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="disk-full-title"
      data-testid="disk-full-overlay"
      className="fixed inset-0 z-[200000] flex items-center justify-center bg-red-950/95 text-red-50 backdrop-blur-sm px-6"
    >
      <div className="max-w-xl w-full rounded-xl border border-red-400/50 bg-red-900/70 shadow-2xl p-8 text-center">
        <AlertOctagon className="mx-auto h-14 w-14 text-red-200" aria-hidden />
        <h1
          id="disk-full-title"
          className="mt-4 text-xl font-semibold tracking-wide uppercase"
        >
          {t("diskFullTitle")}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-red-100/90">
          {t("diskFullBody")}
        </p>
        <button
          type="button"
          data-testid="disk-full-retry"
          onClick={() => { void onRetry(); }}
          disabled={retrying}
          className="mt-6 inline-flex items-center justify-center gap-2 rounded-md border border-red-200/60 bg-red-700 px-4 py-2 text-sm font-medium text-white shadow hover:bg-red-600 disabled:opacity-60"
        >
          {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {t("diskFullRetry")}
        </button>
        {retryFailedAt !== null && (
          <div
            data-testid="disk-full-retry-failed"
            className="mt-3 text-xs text-red-200/80"
          >
            {t("diskFullRetryFailed")}
          </div>
        )}
      </div>
    </div>
  );
}

export default DiskFullOverlay;
