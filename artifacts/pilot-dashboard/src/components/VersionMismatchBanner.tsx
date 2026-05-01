// Amber, non-dismissable banner that warns the operator the api-server
// has been upgraded to a newer build than the dashboard HTML they have
// open. Without this the dashboard may make calls against schemas /
// payload shapes the older bundle doesn't understand and silently
// render half-broken pages.
//
// Behaviour:
//   - On mount, polls `/api/healthz` once and every 60s thereafter.
//   - Keeps the api-server version in module-level state via
//     `subscribeApiServerVersion` so callers from other places (e.g.
//     other banners, tests) can flip it without re-fetching.
//   - Renders nothing when api-server version is missing or <= bundled
//     dashboard version; renders the amber bar when api-server is
//     strictly ahead.
//   - The banner has no dismiss button on purpose — refreshing the
//     page is the only correct response.

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";

import { useI18n } from "@/lib/i18n";
import {
  getApiServerVersion,
  isApiServerAhead,
  pollApiServerVersion,
  subscribeApiServerVersion,
} from "@/lib/api-client";

const POLL_INTERVAL_MS = 60_000;

function readBundledVersion(): string {
  // Vite injects this via `define:` in vite.config.ts. In the
  // node-based component test we set a stub onto globalThis before
  // importing this module so the comparison still produces a value.
  try {
    return typeof __APP_VERSION__ === "string" && __APP_VERSION__
      ? __APP_VERSION__
      : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function VersionMismatchBanner() {
  const { t } = useI18n();
  const [apiVer, setApiVer] = useState<string | null>(getApiServerVersion());

  useEffect(() => {
    const off = subscribeApiServerVersion(setApiVer);
    void pollApiServerVersion();
    const id = window.setInterval(() => {
      void pollApiServerVersion();
    }, POLL_INTERVAL_MS);
    return () => {
      off();
      window.clearInterval(id);
    };
  }, []);

  const dashVer = readBundledVersion();
  if (!apiVer) return null;
  if (!isApiServerAhead(dashVer)) return null;

  return (
    <div
      role="alert"
      data-testid="banner-version-mismatch"
      className="rounded-md border border-amber-500/50 bg-amber-500/15 text-amber-100 px-3 py-2 text-sm flex items-start gap-2"
    >
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{t("versionMismatchTitle")}</div>
        <div className="text-xs text-amber-100/80 mt-0.5">
          {t("versionMismatchBody")}
        </div>
        <div className="text-[11px] font-mono text-amber-100/60 mt-1">
          {t("versionMismatchHubLabel")}: {apiVer} ·{" "}
          {t("versionMismatchDashboardLabel")}: {dashVer}
        </div>
      </div>
    </div>
  );
}

export default VersionMismatchBanner;
