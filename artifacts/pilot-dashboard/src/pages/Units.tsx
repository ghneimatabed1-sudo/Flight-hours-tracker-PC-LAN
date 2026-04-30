import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { usePilots, type Pilot } from "@/lib/squadron-data";

const CATS: Pilot["unit"][] = ["SQDN", "HQ Attached", "Other", "UH-60M", "UH-60AIL", "Both", "RCN"];

export default function Units() {
  const { t, rankOf } = useI18n();
  const { data: PILOTS } = usePilots();
  const grouped = CATS.map(c => ({ c, list: PILOTS.filter(p => p.unit === c) }));
  return (
    <div>
      <PageHead title={t("nav_units")} subtitle="Categorize pilots by unit · drag in production" />
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-3">
        {grouped.map(({ c, list }) => (
          <Card key={c}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-semibold">{c}</div>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-secondary">{list.length}</span>
            </div>
            <div className="space-y-1 max-h-[60vh] overflow-y-auto">
              {list.map(p => (
                <div key={p.id} className="text-sm py-1.5 px-2 rounded hover:bg-secondary cursor-pointer">{rankOf(p)} {p.name}</div>
              ))}
              {list.length === 0 && <div className="text-xs text-muted-foreground">Empty</div>}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
