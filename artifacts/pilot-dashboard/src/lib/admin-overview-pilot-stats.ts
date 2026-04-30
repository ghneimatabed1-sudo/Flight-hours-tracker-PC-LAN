import { currencyStatus } from "@/lib/format";

export type PilotCurrencyStatus = ReturnType<typeof currencyStatus>;

const rank: Record<PilotCurrencyStatus, number> = {
  current: 0,
  unset: 1,
  warning: 2,
  expiringSoon: 3,
  critical: 4,
  expired: 5,
};

export function worstStatusFromPilotData(
  data: Record<string, unknown> | null | undefined,
): PilotCurrencyStatus {
  const d = (data ?? {}) as Record<string, unknown>;
  const expiry = (d.expiry ?? {}) as Record<string, unknown>;
  const statuses: PilotCurrencyStatus[] = [
    currencyStatus(String(expiry.day ?? "")),
    currencyStatus(String(expiry.night ?? "")),
    currencyStatus(String(expiry.nvg ?? "")),
    currencyStatus(String(expiry.irt ?? "")),
    currencyStatus(String(expiry.medical ?? "")),
  ];
  return statuses.reduce(
    (acc, s) => (rank[s] > rank[acc] ? s : acc),
    "current" as PilotCurrencyStatus,
  );
}
