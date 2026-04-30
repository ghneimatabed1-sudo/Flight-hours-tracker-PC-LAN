import { AlertTriangle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { isMissingSchemaError } from "@/lib/schema-errors";

interface QueryLike {
  isError: boolean;
  error: unknown;
  refetch: () => unknown;
  isFetching?: boolean;
}

export function DataUnavailableBanner({
  queries,
  testId = "banner-data-unavailable",
}: {
  queries: QueryLike[];
  testId?: string;
}) {
  const { t } = useI18n();
  // Missing-schema errors (pending migrations) are environmental and the
  // page silently falls back to mock/local data. Treating them as
  // "unavailable" would scare ops officers with a red banner whenever
  // the central project is mid-migration, so we filter them out here.
  const failed = queries.filter(q => q.isError && !isMissingSchemaError(q.error));
  if (failed.length === 0) return null;
  const firstError = failed.find(q => q.error instanceof Error)?.error as Error | undefined;
  const refetching = failed.some(q => q.isFetching);

  return (
    <div
      data-testid={testId}
      className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300 flex items-start gap-2"
      role="alert"
    >
      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="flex-1">
        <div className="font-medium">{t("data_unavailable_title")}</div>
        <div className="text-xs text-red-300/80 mt-0.5">{t("data_unavailable_desc")}</div>
        {firstError && (
          <div className="text-[11px] text-red-300/60 mt-0.5 font-mono break-all">{firstError.message}</div>
        )}
      </div>
      <button
        onClick={() => failed.forEach(q => q.refetch())}
        disabled={refetching}
        data-testid={`${testId}-retry`}
        className="px-2 py-1 rounded-md border border-red-500/40 text-xs hover:bg-red-500/20 disabled:opacity-50"
      >
        {t("retry")}
      </button>
    </div>
  );
}
