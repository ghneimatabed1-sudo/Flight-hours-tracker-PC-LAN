import { useEffect, useState } from "react";
import { Link } from "wouter";
import { AlertOctagon } from "lucide-react";
import { getHeartbeatStatus, subscribeHeartbeatStatus } from "@/lib/cross-pc";

// Loud heartbeat-failure banner (task #134). Renders a persistent red
// strip across the top of every signed-in page when the cross-PC
// registry heartbeat has been failing — either three ticks in a row,
// or a single RLS / 401 / 403 rejection (any of which means this PC
// will be invisible to every other PC's picker until fixed).
//
// The banner shows the verbatim Supabase error so the operator (or
// remote support) can read the actual reason without opening the
// browser console. It's dismissible only by a successful heartbeat
// — there is intentionally no close button. Clicking "Diagnose"
// opens /diagnostic where the operator can re-test the link.
//
// The banner picks up the surrounding shell's diagnostic route. Both
// Layout (`/diagnostic`) and HQLayout (`/diagnostic` for super-admin,
// `/dashboard/diagnostic` for commanders) mount this banner; pass
// `diagnosticPath` so the link works in both shells.
export default function HeartbeatFailureBanner({
  diagnosticPath = "/diagnostic",
}: {
  diagnosticPath?: string;
}) {
  const [hb, setHb] = useState(getHeartbeatStatus());
  useEffect(() => subscribeHeartbeatStatus(() => setHb(getHeartbeatStatus())), []);
  if (!hb.bannerVisible || !hb.errorMsg) return null;
  return (
    <div
      className="bg-rose-600 text-white px-4 py-2 text-xs sm:text-sm flex items-start gap-3 border-b border-rose-800 print:hidden"
      role="alert"
      data-testid="heartbeat-failure-banner"
    >
      <AlertOctagon className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="font-semibold">
          PC heartbeat failed. This PC will not appear in other PCs' lists.
        </div>
        <div className="opacity-95 break-words font-mono text-[11px] sm:text-xs mt-0.5">
          {hb.errorMsg}
        </div>
      </div>
      <Link
        href={diagnosticPath}
        className="shrink-0 underline font-semibold whitespace-nowrap hover:text-amber-100"
        data-testid="link-heartbeat-diagnose"
      >
        Diagnose →
      </Link>
    </div>
  );
}
