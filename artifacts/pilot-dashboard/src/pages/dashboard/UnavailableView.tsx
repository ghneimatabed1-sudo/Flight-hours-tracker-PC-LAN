import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { usePilots, useUnavailable } from "@/lib/squadron-data";
import { DataUnavailableBanner } from "@/components/DataUnavailableBanner";
import { UserX } from "lucide-react";

/**
 * Read-only "Unavailable Pilots" view for commanders (Flight / Squadron).
 *
 * Mirrors the ops-officer Unavailable page but strips out the add/remove
 * controls — commanders need to see who's out, but only the ops officer
 * can mutate the list from the squadron PC.
 */
export default function UnavailableView() {
  const { t } = useI18n();
  const pilotsQ = usePilots();
  const unavailQ = useUnavailable();
  const PILOTS = pilotsQ.data;
  const items = unavailQ.data;
  const pname = (id: string) => PILOTS.find(p => p.id === id)?.name || id;

  return (
    <div>
      <PageHead title={t("nav_unavail")} subtitle="Read-only · ops officer manages this list" />
      <DataUnavailableBanner queries={[pilotsQ, unavailQ]} testId="banner-cmd-unavail-unavailable" />
      <Card className="!p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-secondary/50 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Pilot</th>
              <th className="px-3 py-2 text-left">From</th>
              <th className="px-3 py-2 text-left">To</th>
              <th className="px-3 py-2 text-left">Reason</th>
            </tr>
          </thead>
          <tbody>
            {items.map(i => (
              <tr key={i.id} className="border-t border-border row-hover">
                <td className="px-3 py-2"><UserX className="inline h-3.5 w-3.5 mr-1 text-amber-400" />{pname(i.pilotId)}</td>
                <td className="px-3 py-2 font-mono">{i.from}</td>
                <td className="px-3 py-2 font-mono">{i.to}</td>
                <td className="px-3 py-2 text-muted-foreground">{i.reason}</td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-xs text-muted-foreground" data-testid="empty-cmd-unavailable">
                  {unavailQ.isError ? "—" : "No pilots marked unavailable."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
