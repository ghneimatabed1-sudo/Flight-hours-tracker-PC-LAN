import type { CurrencyStatus } from "@/lib/types";
import { useI18n } from "@/lib/i18n";
import { statusClass, currencyStatus, fmtDDMM, fmtDDMMYYYY } from "@/lib/format";

function statusLabelKey(s: CurrencyStatus): "current" | "notSet" | "warning" | "expiringSoon" | "expired" {
  if (s === "expired") return "expired";
  if (s === "critical" || s === "expiringSoon") return "expiringSoon";
  if (s === "warning") return "warning";
  if (s === "unset") return "notSet";
  return "current";
}

function fmtShort(date: string, _lang: string): string {
  // DD-MM keeps badges compact while staying consistent with the
  // squadron-wide DD-MM-YYYY standard.
  return fmtDDMM(date);
}

export function StatusBadge({ status, date }: { status: CurrencyStatus; date?: string | null }) {
  const { t, lang } = useI18n();
  const label = t(statusLabelKey(status));
  const showDate = !!date && status !== "current" && status !== "unset";
  return (
    <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium tabular-nums ${statusClass(status)}`}>
      {label}
      {showDate && (
        <span className="ms-1.5 opacity-80 font-normal">· {fmtShort(date!, lang)}</span>
      )}
    </span>
  );
}

export function CurrencyCell({ date }: { date: string }) {
  useI18n();
  const status = currencyStatus(date);
  const formatted = fmtDDMMYYYY(date);
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium tabular-nums ${statusClass(status)}`}>
      {formatted}
    </span>
  );
}
