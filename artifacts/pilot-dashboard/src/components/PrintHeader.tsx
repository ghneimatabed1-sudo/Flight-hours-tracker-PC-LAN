// PrintHeader — render-only-on-paper header used by every printable page.
//
// The header itself is hidden on screen (`print-only` class flips to
// display:block inside the @media print block of index.css). A consistent
// header keeps every printout — Ranking, Leaves, Monthly Report, Flight
// Program, Schedule, Sortie list — looking like one document family.
import { useAuth } from "@/lib/auth";
import { fmtDDMMYYYY } from "@/lib/format";

export interface PrintHeaderProps {
  title: string;
  subtitle?: string;
  // Optional context line — e.g. "Selected month: APR 2026" or
  // "Filtered: NVG · Capt. Smith".
  context?: string;
  // Optional date-range string when the page is showing a window.
  dateRange?: string;
}

export function PrintHeader({ title, subtitle, context, dateRange }: PrintHeaderProps) {
  const { squadron, user } = useAuth();
  const today = fmtDDMMYYYY(new Date());
  const sqnLine = squadron
    ? `${squadron.name}${squadron.base ? ` — ${squadron.base}` : ""}`
    : "RJAF";
  const generatedBy = user?.username || "—";
  return (
    <div className="print-only print-header" data-testid="print-header">
      <div className="print-header-top">
        <div className="print-header-sqn">{sqnLine}</div>
        <div className="print-header-meta">
          <div>Printed: {today}</div>
          <div>By: {generatedBy}</div>
        </div>
      </div>
      <div className="print-header-title">{title}</div>
      {subtitle && <div className="print-header-sub">{subtitle}</div>}
      {(context || dateRange) && (
        <div className="print-header-context">
          {dateRange && <span>{dateRange}</span>}
          {dateRange && context && <span> · </span>}
          {context && <span>{context}</span>}
        </div>
      )}
      <hr className="print-header-rule" />
    </div>
  );
}

export default PrintHeader;
