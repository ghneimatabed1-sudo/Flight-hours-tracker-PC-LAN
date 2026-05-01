// "Restore previous draft?" banner. Rendered above any form that
// uses `useFormDraft`. Visible only while the hook reports
// `hasDraft === true`; clicking either button hides the banner via
// the hook's restoreDraft / discardDraft callbacks.
//
// Task T-D / #371.

import { History, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";

interface Props {
  hasDraft: boolean;
  onRestore: () => void;
  onDiscard: () => void;
  /** Optional test id suffix so multiple forms on one page stay distinguishable. */
  testIdSuffix?: string;
}

export function FormDraftBanner({ hasDraft, onRestore, onDiscard, testIdSuffix }: Props) {
  const { t } = useI18n();
  if (!hasDraft) return null;
  const tid = testIdSuffix ? `form-draft-banner-${testIdSuffix}` : "form-draft-banner";
  return (
    <div
      role="alert"
      data-testid={tid}
      className="rounded-md border border-sky-500/40 bg-sky-500/10 text-sky-100 px-3 py-2 text-sm flex items-start gap-2"
    >
      <History className="h-4 w-4 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{t("formDraftTitle")}</div>
        <div className="text-xs text-sky-200/80 mt-0.5">{t("formDraftBody")}</div>
      </div>
      <div className="flex gap-1.5 shrink-0">
        <button
          type="button"
          onClick={onRestore}
          data-testid={`${tid}-restore`}
          className="px-2 py-1 rounded-md bg-sky-500/20 hover:bg-sky-500/30 text-xs font-medium border border-sky-500/40"
        >
          {t("formDraftRestore")}
        </button>
        <button
          type="button"
          onClick={onDiscard}
          data-testid={`${tid}-discard`}
          aria-label={t("formDraftDiscard")}
          className="px-2 py-1 rounded-md bg-transparent hover:bg-sky-500/20 text-xs border border-sky-500/40 inline-flex items-center gap-1"
        >
          <X className="h-3 w-3" /> {t("formDraftDiscard")}
        </button>
      </div>
    </div>
  );
}

export default FormDraftBanner;
