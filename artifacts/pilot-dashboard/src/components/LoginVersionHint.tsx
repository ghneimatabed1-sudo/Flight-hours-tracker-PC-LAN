// Quiet, single-line "the api-server has been updated, please refresh"
// hint for the Login screen (Task #386 / T-M).
//
// Why a Login-specific component?
//   * The full-screen amber `VersionMismatchBanner` is mounted inside
//     `Shell` and only renders after the operator authenticates. On
//     LAN installs the api-server can be ahead of the dashboard
//     bundle the operator's browser cached — without a hint on the
//     login page they wouldn't see the warning until after typing a
//     password into a stale form.
//   * Pre-auth UX should not be loud: the operator might just be
//     opening the page out of habit. We render a small amber line
//     under the Sign In button instead of a full banner, with a
//     `Refresh` link that triggers a hard reload.
//
// The component polls `/api/healthz` once on mount via
// `pollApiServerVersion()`; that's the same module-level state the
// post-auth banner subscribes to, so an operator who logs in and
// reaches Shell sees the loud banner immediately without a second
// poll round-trip.

import { useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import {
  getApiServerVersion,
  isApiServerAhead,
  pollApiServerVersion,
  subscribeApiServerVersion,
} from "@/lib/api-client";

function readBundledVersion(): string {
  // Vite injects this via `define:` in vite.config.ts. The same
  // helper lives in `VersionMismatchBanner.tsx` — kept duplicated
  // (rather than exported) so a build that strips the post-auth
  // banner doesn't accidentally pull this hint along with it.
  try {
    return typeof __APP_VERSION__ === "string" && __APP_VERSION__
      ? __APP_VERSION__
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function LoginVersionHint(): React.ReactElement | null {
  const { t } = useI18n();
  const [apiVer, setApiVer] = useState<string | null>(getApiServerVersion());

  useEffect(() => {
    const off = subscribeApiServerVersion(setApiVer);
    void pollApiServerVersion();
    return off;
  }, []);

  const dashVer = readBundledVersion();
  if (!apiVer) return null;
  if (!isApiServerAhead(dashVer)) return null;

  return (
    <div
      role="status"
      data-testid="login-version-hint"
      className="flex items-center justify-center gap-1.5 text-[11px] text-amber-300/90"
    >
      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{t("loginVersionHintText")}</span>
      <button
        type="button"
        onClick={() => {
          try {
            window.location.reload();
          } catch {
            /* test envs without window.location.reload */
          }
        }}
        data-testid="login-version-hint-refresh"
        className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-amber-200"
      >
        <RefreshCw className="h-3 w-3" aria-hidden="true" />
        {t("loginVersionHintRefresh")}
      </button>
    </div>
  );
}

export default LoginVersionHint;
