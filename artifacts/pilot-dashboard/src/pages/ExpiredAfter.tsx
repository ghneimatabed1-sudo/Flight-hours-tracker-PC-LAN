import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { usePilots } from "@/lib/squadron-data";

const CATS = [
  { k: "day", label: "Day" }, { k: "night", label: "Night" },
  { k: "irt", label: "IRT" }, { k: "medical", label: "Medical" }, { k: "sim", label: "Sim" },
] as const;

export default function ExpiredAfter() {
  const { t, rankOf } = useI18n();
  const { data: PILOTS } = usePilots();
  return (
    <div>
      <PageHead title={t("nav_expired")} subtitle="Side-by-side: who is expired in each category" />
      <div className="grid md:grid-cols-2 lg:grid-cols-5 gap-3">
        {CATS.map(c => {
          const exp = PILOTS
            .filter(p => !p.hiddenCurrencies?.includes(c.k))
            .filter(p => +new Date(p.expiry[c.k]) < Date.now())
            .sort((a, b) => +new Date(a.expiry[c.k]) - +new Date(b.expiry[c.k]));
          return (
            <Card key={c.k}>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold">{c.label}</h3>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-300">{exp.length}</span>
              </div>
              <div className="space-y-1.5 max-h-[60vh] overflow-y-auto">
                {exp.length === 0 && <div className="text-xs text-muted-foreground">None expired</div>}
                {exp.map(p => (
                  <div key={p.id} className="flex items-center justify-between text-sm">
                    <div className="truncate">{rankOf(p)} {p.name}</div>
                    <div className="text-[11px] font-mono text-rose-300 shrink-0">{p.expiry[c.k]}</div>
                  </div>
                ))}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
