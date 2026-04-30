import { useMemo, useState } from "react";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { useSorties, usePilots } from "@/lib/squadron-data";
import { Search, Printer, UserPlus, ChevronDown, ChevronRight } from "lucide-react";
import type { Sortie, ExternalPilotRef } from "@/lib/mock";

// External (guest) pilot roll-up. Any sortie where a seat was flown by a
// pilot from a different squadron appears here, grouped by the guest's
// name + squadron. The guest's home-squadron ops officer can use this as a
// reference to enter the same sortie in their own app so their pilot's
// hours & currencies get credited there.
interface GuestRow {
  key: string;
  name: string;
  squadron: string;
  flights: Array<{
    sortie: Sortie;
    role: "P1" | "P2";
    hostPilot: string;
  }>;
  totalHours: number;
}

function keyFor(ref: ExternalPilotRef): string {
  return `${ref.name.trim().toLowerCase()}|${ref.squadron.trim().toLowerCase()}`;
}

function sortieHours(s: Sortie): number {
  return s.day1 + s.day2 + s.dayDual + s.night1 + s.night2 + s.nightDual + s.nvg;
}

export default function ExternalPilots() {
  const { t, rankOf } = useI18n();
  const { data: SORTIES } = useSorties();
  const { data: PILOTS } = usePilots();
  const [q, setQ] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const pilotMap = useMemo(() => Object.fromEntries(PILOTS.map(p => [p.id, `${rankOf(p)} ${p.name}`])), [PILOTS]);

  const groups: GuestRow[] = useMemo(() => {
    const map = new Map<string, GuestRow>();
    for (const s of SORTIES) {
      if (s.pilotExternal) {
        const k = keyFor(s.pilotExternal);
        if (!map.has(k)) map.set(k, { key: k, name: s.pilotExternal.name, squadron: s.pilotExternal.squadron, flights: [], totalHours: 0 });
        map.get(k)!.flights.push({ sortie: s, role: "P1", hostPilot: pilotMap[s.coPilotId] || "—" });
        map.get(k)!.totalHours += sortieHours(s);
      }
      if (s.coPilotExternal) {
        const k = keyFor(s.coPilotExternal);
        if (!map.has(k)) map.set(k, { key: k, name: s.coPilotExternal.name, squadron: s.coPilotExternal.squadron, flights: [], totalHours: 0 });
        map.get(k)!.flights.push({ sortie: s, role: "P2", hostPilot: pilotMap[s.pilotId] || "—" });
        map.get(k)!.totalHours += sortieHours(s);
      }
    }
    return Array.from(map.values())
      .map(g => ({ ...g, flights: g.flights.sort((a, b) => b.sortie.date.localeCompare(a.sortie.date)) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [SORTIES, pilotMap]);

  const filtered = groups.filter(g =>
    !q || (g.name + " " + g.squadron).toLowerCase().includes(q.toLowerCase())
  );

  const totalFlights = filtered.reduce((n, g) => n + g.flights.length, 0);

  return (
    <div className="print-area">
      <PageHead
        title={t("nav_externalpilots")}
        subtitle={`${filtered.length} ${t("externalPilotsCount")} · ${totalFlights} ${t("externalFlightsCount")}`}
        actions={
          <div className="flex items-center gap-2 no-print">
            <div className="relative">
              <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder={t("search")}
                className="pl-7 pr-2 py-1.5 rounded-md bg-input border border-border text-sm" data-testid="input-search-external" />
            </div>
            <button onClick={() => window.print()} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-secondary border border-border text-sm hover:bg-secondary/80" data-testid="button-print-external">
              <Printer className="h-4 w-4" /> {t("print")}
            </button>
          </div>
        }
      />

      <Card className="mb-3 bg-amber-400/5 border-amber-400/30">
        <div className="flex items-start gap-2 text-xs">
          <UserPlus className="h-4 w-4 text-amber-300 mt-0.5 shrink-0" />
          <div className="text-amber-100/90">{t("externalPageNotice")}</div>
        </div>
      </Card>

      {filtered.length === 0 ? (
        <Card>
          <div className="text-sm text-muted-foreground text-center py-8">{t("noExternalPilots")}</div>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(g => {
            const open = expanded[g.key] ?? true;
            return (
              <Card key={g.key} className="!p-0 overflow-hidden">
                <button
                  onClick={() => setExpanded(e => ({ ...e, [g.key]: !open }))}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-secondary/30"
                  data-testid={`toggle-group-${g.key}`}
                >
                  <div className="flex items-center gap-2 text-left">
                    {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    <div>
                      <div className="font-semibold text-amber-200">{g.name}</div>
                      <div className="text-xs text-muted-foreground">{g.squadron || t("noSquadron")}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-xs">
                    <div><span className="text-muted-foreground">{t("externalFlightsCount")}:</span> <span className="font-mono font-semibold">{g.flights.length}</span></div>
                    <div><span className="text-muted-foreground">{t("hoursTotal")}:</span> <span className="font-mono font-semibold text-amber-200">{g.totalHours.toFixed(1)}</span></div>
                  </div>
                </button>
                {open && (
                  <div className="overflow-x-auto border-t border-border">
                    <table className="w-full text-xs">
                      <thead className="bg-secondary/40 text-[10px] uppercase tracking-wider text-muted-foreground">
                        <tr>
                          <Th>{t("date")}</Th><Th>{t("acNumber")}</Th>
                          <Th>{t("role")}</Th><Th>{t("hostPilot")}</Th>
                          <Th>{t("sortieType")}</Th>
                          <Th right>Day</Th><Th right>Night</Th>
                          <Th right cls="text-rose-300">NVG</Th>
                          <Th right>Sim</Th><Th right>{t("actual")}</Th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.flights.map(({ sortie: s, role, hostPilot }) => (
                          <tr key={s.id + role} className="border-t border-border row-hover">
                            <Td mono>{s.date}</Td>
                            <Td mono>{s.acNumber}</Td>
                            <Td><span className="px-1.5 py-0.5 rounded bg-secondary text-[10px] font-semibold">{role}</span></Td>
                            <Td>{hostPilot}</Td>
                            <Td>{s.sortieType}</Td>
                            <Td mono right>{(s.day1 + s.day2 + s.dayDual).toFixed(1)}</Td>
                            <Td mono right>{(s.night1 + s.night2 + s.nightDual).toFixed(1)}</Td>
                            <Td mono right cls={s.nvg ? "text-rose-300" : ""}>{s.nvg || "—"}</Td>
                            <Td mono right>{s.sim || "—"}</Td>
                            <Td mono right>{s.actual || "—"}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Th({ children, right, cls = "" }: { children: React.ReactNode; right?: boolean; cls?: string }) {
  return <th className={`px-3 py-2 ${right ? "text-right" : "text-left"} font-medium ${cls}`}>{children}</th>;
}
function Td({ children, mono, right, cls = "" }: { children: React.ReactNode; mono?: boolean; right?: boolean; cls?: string }) {
  return <td className={`px-3 py-2 ${mono ? "font-mono" : ""} ${right ? "text-right" : ""} ${cls}`}>{children}</td>;
}
