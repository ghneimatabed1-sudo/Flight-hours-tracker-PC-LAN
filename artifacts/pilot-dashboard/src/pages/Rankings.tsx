import { useState, useMemo } from "react";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { usePilots, useSorties } from "@/lib/squadron-data";
import { computeAllTotals } from "@/lib/calculations";
import { Trophy, Printer } from "lucide-react";
import { PrintHeader } from "@/components/PrintHeader";

const SORTS = [
  { k: "totalNvg", label: "NVG Total" },
  { k: "monthDay", label: "Monthly Day Hours" },
  { k: "monthNight", label: "Monthly Night Hours" },
  { k: "totalDay", label: "Grand Total" },
  { k: "totalCaptain", label: "Captain Hours" },
] as const;

export default function Rankings() {
  const { t, rankOf } = useI18n();
  type SortKey = typeof SORTS[number]["k"];
  const [sortKey, setSortKey] = useState<SortKey>("totalNvg");
  const { data: PILOTS } = usePilots();
  const { data: SORTIES } = useSorties();
  const totalsById = useMemo(() => computeAllTotals(PILOTS, SORTIES), [PILOTS, SORTIES]);
  const sorted = [...PILOTS].sort((a, b) => (totalsById[b.id]?.[sortKey] ?? 0) - (totalsById[a.id]?.[sortKey] ?? 0));
  const sortLabel = SORTS.find(s => s.k === sortKey)?.label ?? "";
  return (
    <div>
      <PageHead title={t("nav_rankings")} actions={
        <div className="flex items-center gap-2 no-print">
          <select value={sortKey} onChange={e => setSortKey(e.target.value as SortKey)} className="px-3 py-1.5 rounded-md bg-input border border-border text-sm">
            {SORTS.map(s => <option key={s.k} value={s.k}>{s.label}</option>)}
          </select>
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90"
            data-testid="button-rankings-print"
            title="Print"
          >
            <Printer className="h-3.5 w-3.5" /> {t("print")}
          </button>
        </div>
      } />
      {/* data-print-area scopes the printable subtree per the global
          print system. Everything outside is suppressed by index.css. */}
      <div data-print-area>
        <PrintHeader title={t("nav_rankings")} context={`Sorted by: ${sortLabel}`} />
        <Card className="!p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-secondary/50 text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-3 py-2 text-left">Pilot</th>
                <th className="px-3 py-2 text-right">Mo Day</th>
                <th className="px-3 py-2 text-right">Mo Night</th>
                <th className="px-3 py-2 text-right text-rose-300">Mo NVG</th>
                <th className="px-3 py-2 text-right">Total Day</th>
                <th className="px-3 py-2 text-right">Total Night</th>
                <th className="px-3 py-2 text-right text-rose-300">Total NVG</th>
                <th className="px-3 py-2 text-right">Captain</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p, i) => {
                const tot = totalsById[p.id];
                if (!tot) return null;
                return (
                  <tr key={p.id} className="border-t border-border row-hover">
                    <td className="px-3 py-2 font-mono">{i + 1}{i === 0 && <Trophy className="inline h-3.5 w-3.5 ml-1 text-amber-400" />}</td>
                    <td className="px-3 py-2">{rankOf(p)} {p.name}</td>
                    <td className="px-3 py-2 text-right font-mono">{tot.monthDay.toFixed(1)}</td>
                    <td className="px-3 py-2 text-right font-mono">{tot.monthNight.toFixed(1)}</td>
                    <td className="px-3 py-2 text-right font-mono text-rose-300">{tot.monthNvg.toFixed(1)}</td>
                    <td className="px-3 py-2 text-right font-mono">{tot.totalDay.toFixed(1)}</td>
                    <td className="px-3 py-2 text-right font-mono">{tot.totalNight.toFixed(1)}</td>
                    <td className="px-3 py-2 text-right font-mono text-rose-300">{tot.totalNvg.toFixed(1)}</td>
                    <td className="px-3 py-2 text-right font-mono">{tot.totalCaptain.toFixed(1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
