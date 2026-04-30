import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { useSchedule } from "@/lib/squadron-data";
import { DataUnavailableBanner } from "@/components/DataUnavailableBanner";
import { PrintHeader } from "@/components/PrintHeader";
import { Printer } from "lucide-react";

export default function Schedule() {
  const { t } = useI18n();
  const scheduleQ = useSchedule();
  const { data: MISSIONS } = scheduleQ;
  return (
    <div>
      <PageHead
        title={t("nav_schedule")}
        subtitle="Daily flight schedule · RJAF format"
        actions={
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90 no-print"
            data-testid="button-schedule-print"
            title="Print"
          >
            <Printer className="h-3.5 w-3.5" /> {t("print")}
          </button>
        }
      />
      <DataUnavailableBanner queries={[scheduleQ]} testId="banner-schedule-unavailable" />
      {/* The PrintHeader must live INSIDE the data-print-area so the
          global print isolation rules keep it visible. */}
      <div data-print-area>
      <PrintHeader title={t("nav_schedule")} subtitle="Daily flight schedule · RJAF format" />
      <Card className="!p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-secondary/50 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">A/C</th>
              <th className="px-3 py-2 text-left">Config</th>
              <th className="px-3 py-2 text-left">Crew</th>
              <th className="px-3 py-2 text-left">Mission</th>
              <th className="px-3 py-2 text-right">Takeoff</th>
              <th className="px-3 py-2 text-right">Land</th>
              <th className="px-3 py-2 text-right">Fuel</th>
            </tr>
          </thead>
          <tbody>
            {MISSIONS.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-xs text-muted-foreground" data-testid="empty-schedule">
                  {scheduleQ.isError ? "—" : t("no_records")}
                </td>
              </tr>
            )}
            {MISSIONS.map((m) => (
              <tr key={m.id} className="border-t border-border row-hover">
                <td className="px-3 py-2 font-mono">{m.ac}</td>
                <td className="px-3 py-2">{m.config}</td>
                <td className="px-3 py-2">{m.crew.join(" / ")}</td>
                <td className="px-3 py-2">{m.mission}</td>
                <td className="px-3 py-2 text-right font-mono">{m.takeoff}</td>
                <td className="px-3 py-2 text-right font-mono">{m.land}</td>
                <td className="px-3 py-2 text-right font-mono">{m.fuel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      </div>
    </div>
  );
}
