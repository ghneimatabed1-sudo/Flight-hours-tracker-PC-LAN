// Tiny "Offline  your work is being saved here" banner pinned to
// the top of the app. Honest about state: it shows up the moment the
// browser fires the `offline` event and disappears when `online`
// fires again. Pairs with `useFormDraft` so operators know that even
// if the LAN dies mid-form, their typing is being persisted locally.
//
// Task T-D / #371.

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { useI18n } from "@/lib/i18n";

export function OnlineStatusBanner() {
  const { t } = useI18n();
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  if (online) return null;
  return (
    <div
      role="status"
      data-testid="online-status-banner"
      className="w-full bg-amber-500/90 text-amber-950 text-xs font-medium px-3 py-1.5 flex items-center justify-center gap-2"
    >
      <WifiOff className="h-3.5 w-3.5" />
      <span>{t("onlineStatusOfflineMsg")}</span>
    </div>
  );
}

export default OnlineStatusBanner;
