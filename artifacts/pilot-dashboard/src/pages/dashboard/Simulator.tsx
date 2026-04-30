import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useDashPilots, useDashSquadrons } from "@/lib/dash-pilots";
import { fmtDate } from "@/lib/format";
import { Activity, ArrowUpDown, Printer, Search } from "lucide-react";

type SortKey = "name" | "squadron" | "date";

export default function Simulator() {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const squadrons = useDashSquadrons();
  const pilots = useDashPilots();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("date");
  const [asc, setAsc] = useState(true);

  if (!user || user.scope !== "squadron") return null;

  const myIds = new Set(user.squadronIds ?? []);

  const rows = useMemo(() => {
    const base = pilots
      .filter(p => myIds.has(p.squadronId))
      .map(p => {
        const sqn = squadrons.find(s => s.id === p.squadronId);
        return {
          id: p.id,
          callSign: p.callSign,
          name: lang === "ar" ? p.fullNameAr : p.fullName,
          squadron: sqn ? (lang === "ar" ? sqn.nameAr : sqn.code) : "",
          date: p.lastSimDate || null,
        };
      })
      .filter(r =>
        !q || (r.name + r.callSign + r.squadron).toLowerCase().includes(q.toLowerCase())
      );

    base.sort((a, b) => {
      let cmp = 0;
      if (sort === "name") cmp = a.name.localeCompare(b.name);
      else if (sort === "squadron") cmp = a.squadron.localeCompare(b.squadron);
      else {
        const at = a.date ? new Date(a.date).getTime() : -Infinity;
        const bt = b.date ? new Date(b.date).getTime() : -Infinity;
        cmp = at - bt;
      }
      return asc ? cmp : -cmp;
    });
    return base;
  }, [q, sort, asc, lang, myIds]);

  const toggle = (k: SortKey) => {
    if (sort === k) setAsc(v => !v);
    else { setSort(k); setAsc(k === "date" ? false : true); }
  };

  const daysAgo = (d: string | null) => {
    if (!d) return null;
    const diff = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
    if (diff <= 0) return t("today");
    if (diff === 1) return t("yesterday");
    return t("daysAgo").replace("{n}", String(diff));
  };

  return (
    <div className="space-y-4 print-area">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />{t("simulator")}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">{t("simulatorPageSubtitle")}</p>
        </div>
        <div className="flex items-center gap-2 no-print">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder={t("search")}
              data-testid="input-sim-search"
              className="pl-7 pr-2 py-1.5 rounded-md bg-input border border-border text-sm"
            />
          </div>
          <Button size="sm" variant="outline" onClick={() => window.print()} data-testid="button-print-simulator">
            <Printer className="h-3.5 w-3.5 me-1" />{t("print")}
          </Button>
        </div>
      </div>

      <Card className="!p-0 overflow-hidden">
        <CardContent className="!p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <Th onClick={() => toggle("name")}>{t("name")}</Th>
                  <Th onClick={() => toggle("squadron")}>{t("squadron")}</Th>
                  <Th onClick={() => toggle("date")}>{t("lastSimDate")}</Th>
                  <th className="px-3 py-2 text-end no-print"></th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={4} className="py-8 text-center text-muted-foreground">{t("noResults")}</td></tr>
                )}
                {rows.map(r => (
                  <tr key={r.id} className="border-t border-border/60 hover:bg-accent/30" data-testid={`row-sim-${r.id}`}>
                    <td className="px-3 py-2">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-[11px] font-mono text-muted-foreground">{r.callSign}</div>
                    </td>
                    <td className="px-3 py-2 text-xs">{r.squadron}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {r.date ? (
                        <div>
                          <div>{fmtDate(r.date, lang)}</div>
                          <div className="text-[11px] text-muted-foreground">{daysAgo(r.date)}</div>
                        </div>
                      ) : (
                        <span className="text-muted-foreground italic">{t("neverRecorded")}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-end no-print">
                      <Link href={`/dashboard/pilot/${r.id}`}>
                        <Button size="sm" variant="outline" data-testid={`button-view-sim-${r.id}`}>{t("viewDetails")}</Button>
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Th({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <th
      onClick={onClick}
      className="px-3 py-2 text-start cursor-pointer select-none hover:text-foreground"
    >
      <span className="inline-flex items-center gap-1">
        {children}
        <ArrowUpDown className="h-3 w-3 opacity-50" />
      </span>
    </th>
  );
}
