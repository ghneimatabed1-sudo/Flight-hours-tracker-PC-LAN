import { useEffect, useMemo, useState } from "react";
import { Link, useRoute } from "wouter";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { CurrencyCell, StatusBadge } from "@/components/StatusBadge";
import { useDashPilots, useDashSquadrons } from "@/lib/dash-pilots";
import { resolveScopedIds, useSquadronScope } from "@/lib/squadron-scope";
import { pilotWorstStatus, pilotWorstDate, fmtDate, currencyStatus } from "@/lib/format";
import type { CurrencyStatus, Pilot } from "@/lib/types";
import { Search, ArrowUpDown, ChevronLeft, Download, Printer, FileSpreadsheet, UserX, Clock } from "lucide-react";
import { useSquadronSnapshot } from "@/lib/cross-pc";
import { CommanderEmptyState } from "@/components/CommanderEmptyState";
import { SnapshotStalenessBanner } from "@/components/SnapshotStalenessBanner";

type SortKey = keyof Pick<Pilot, "callSign" | "fullName" | "monthlyHours" | "grandTotalHours" | "nvgTotalHours">;

export default function PilotsTable() {
  const { t, lang, dir } = useI18n();
  const { user } = useAuth();
  const squadrons = useDashSquadrons();
  const pilots = useDashPilots();
  const [, params] = useRoute("/dashboard/squadron/:id");
  const focusedSqnId = params?.id;

  const [q, setQ] = useState("");
  const [sqnFilter, setSqnFilter] = useState<string>("__all");
  const [statusFilter, setStatusFilter] = useState<"all" | "current" | "warning" | "expired">("all");
  const [sortKey, setSortKey] = useState<SortKey>("callSign");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const [scope] = useSquadronScope();
  if (!user) return null;
  // Squadron drill-down (/dashboard/squadron/:id) is intentional and
  // takes precedence over the topbar scope picker — operators should
  // always see the squadron they explicitly opened, even if their
  // saved scope is narrower or set to a different sibling. Outside
  // the drill-down, scope narrows the universe of pilots/squadrons.
  const authorizedIds = user.squadronIds ?? [];
  const baseIds = focusedSqnId ? authorizedIds : resolveScopedIds(scope, authorizedIds);
  const myIds = new Set(baseIds);
  const mySqns = squadrons.filter(s => myIds.has(s.id));
  const focusedSqn = focusedSqnId ? squadrons.find(s => s.id === focusedSqnId) : null;
  const canExport = user.role === "commander";

  // If the topbar scope changes (or restores), the per-page squadron
  // filter can become stale (e.g. it points at squadron B while the
  // operator just narrowed scope to squadron A) and would render an
  // empty table. Reset the in-page filter to "All" the moment the
  // scoped set no longer contains the previously-picked squadron.
  useEffect(() => {
    if (sqnFilter !== "__all" && !myIds.has(sqnFilter)) {
      setSqnFilter("__all");
    }
  }, [scope, sqnFilter, myIds]);

  const list = useMemo(() => {
    let l = pilots.filter(p => myIds.has(p.squadronId));
    if (focusedSqnId) l = l.filter(p => p.squadronId === focusedSqnId);
    else if (sqnFilter !== "__all") l = l.filter(p => p.squadronId === sqnFilter);
    if (statusFilter !== "all") {
      l = l.filter(p => {
        const s = pilotWorstStatus(p);
        if (statusFilter === "expired") return s === "expired" || s === "critical";
        if (statusFilter === "warning") return s === "warning" || s === "expiringSoon";
        return s === "current";
      });
    }
    if (q.trim()) {
      const s = q.toLowerCase().trim();
      l = l.filter(p => p.fullName.toLowerCase().includes(s) || p.fullNameAr.includes(s) || p.callSign.toLowerCase().includes(s));
    }
    l = [...l].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return sortDir === "asc" ? cmp : -cmp;
    });
    return l;
  }, [q, sqnFilter, statusFilter, sortKey, sortDir, focusedSqnId, myIds]);

  function setSort(k: SortKey) {
    if (sortKey === k) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir("asc"); }
  }

  // Wing/base/HQ commanders viewing a squadron drill-down read the live
  // daily snapshot the squadron's Ops PC publishes to xpc_squadron_snapshot.
  // The squadron's own commander/ops PC ignores this — they have the real
  // local data already. Squadron drill-down only.
  // Task #26 — a squadron commander provisioned to oversee 2–3 squadrons
  // is just as much a cross-squadron viewer as the wing/base tier (they
  // only physically sit at one of those squadrons), so we also let
  // multi-squadron sqn-cmdrs read the published snapshot for the squadron
  // they're not at right now.
  const isCrossSqnViewer =
    user.role === "commander" && (
      user.scope === "wing" || user.scope === "base" || user.scope === "hq" ||
      (user.scope === "squadron" && (user.squadronIds ?? []).length > 1)
    );
  const snapshotQ = useSquadronSnapshot(isCrossSqnViewer && focusedSqn ? focusedSqn.code : null);
  const snapshot = snapshotQ.data;

  const reportTitle = focusedSqn
    ? `${t("pilotReport")} — ${lang === "ar" ? focusedSqn.nameAr : focusedSqn.name}`
    : sqnFilter !== "__all"
      ? (() => {
          const s = squadrons.find(x => x.id === sqnFilter);
          return s ? `${t("pilotReport")} — ${lang === "ar" ? s.nameAr : s.name}` : t("pilotReport");
        })()
      : `${t("pilotReport")} — ${t("allSquadrons")}`;

  function statusLabel(s: CurrencyStatus): string {
    if (s === "expired") return t("expired");
    if (s === "critical" || s === "expiringSoon") return t("expiringSoon");
    if (s === "warning") return t("warning");
    if (s === "unset") return t("notSet");
    return t("current");
  }

  function exportCsv() {
    const headers = [
      t("callSign"), t("name"), t("squadron"),
      t("nvgTotal"), t("monthlyHours"), t("grandTotal"),
      t("dayCurrency"), t("nightCurrency"), t("nvgCurrency"), t("irtCurrency"), t("medicalCurrency"),
      t("status"),
    ];
    const rows = list.map(p => {
      const sqn = squadrons.find(s => s.id === p.squadronId);
      return [
        p.callSign,
        lang === "ar" ? p.fullNameAr : p.fullName,
        sqn ? (lang === "ar" ? sqn.nameAr : sqn.code) : "",
        String(p.nvgTotalHours),
        p.monthlyHours.toFixed(1),
        String(p.grandTotalHours),
        p.dayCurrencyDate,
        p.nightCurrencyDate,
        p.nvgCurrencyDate ?? "",
        p.irtCurrencyDate,
        p.medicalCurrencyDate,
        statusLabel(pilotWorstStatus(p)),
      ];
    });
    const escape = (v: string) => {
      const needs = /[",\n\r]/.test(v);
      const cleaned = v.replace(/"/g, '""');
      return needs ? `"${cleaned}"` : cleaned;
    };
    const csv = [headers, ...rows].map(r => r.map(escape).join(",")).join("\r\n");
    // Prepend BOM so Excel detects UTF-8 (important for Arabic names)
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    const scope = focusedSqn?.code ?? (sqnFilter !== "__all" ? squadrons.find(s => s.id === sqnFilter)?.code : null) ?? "all";
    a.href = url;
    a.download = `pilots-${scope}-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function exportXlsx() {
    const ExcelJS = (await import("exceljs")).default;
    const headers = [
      t("callSign"), t("name"), t("squadron"),
      t("nvgTotal"), t("monthlyHours"), t("grandTotal"),
      t("dayCurrency"), t("nightCurrency"), t("nvgCurrency"), t("irtCurrency"), t("medicalCurrency"),
      t("status"),
    ];
    // Currency columns are 1-indexed positions 7..11 in the header above.
    // Tracked here so the styling pass below knows which cells to colour.
    const currencyColIdxs = [7, 8, 9, 10, 11];

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Pilots", {
      // Freeze the header row so it stays visible while scrolling — matches
      // the on-screen sticky header expectation for printed reports.
      views: [{ state: "frozen", ySplit: 1 }],
    });
    ws.addRow(headers);

    // ── ARGB fills matching the on-screen currency badge colours ──
    // Excel uses ARGB (alpha first). We use light tints so the printed
    // sheet remains readable in B&W as well as colour.
    const fills: Record<string, { fill: string; font: string }> = {
      red:    { fill: "FFFEE2E2", font: "FF991B1B" }, // expired / critical
      amber:  { fill: "FFFEF3C7", font: "FF92400E" }, // warning / expiringSoon
      green:  { fill: "FFDCFCE7", font: "FF166534" }, // current
      grey:   { fill: "FFF1F5F9", font: "FF475569" }, // unset / blank
    };
    function colourFor(s: CurrencyStatus): keyof typeof fills {
      if (s === "expired" || s === "critical") return "red";
      if (s === "warning" || s === "expiringSoon") return "amber";
      if (s === "unset") return "grey";
      return "green";
    }

    list.forEach(p => {
      const sqn = squadrons.find(s => s.id === p.squadronId);
      const currencies: { date: string; status: CurrencyStatus }[] = [
        { date: p.dayCurrencyDate, status: currencyStatus(p.dayCurrencyDate) },
        { date: p.nightCurrencyDate, status: currencyStatus(p.nightCurrencyDate) },
        { date: p.nvgCurrencyDate ?? "", status: currencyStatus(p.nvgCurrencyDate ?? "") },
        { date: p.irtCurrencyDate, status: currencyStatus(p.irtCurrencyDate) },
        { date: p.medicalCurrencyDate, status: currencyStatus(p.medicalCurrencyDate) },
      ];
      const row = ws.addRow([
        p.callSign,
        lang === "ar" ? p.fullNameAr : p.fullName,
        sqn ? (lang === "ar" ? sqn.nameAr : sqn.code) : "",
        p.nvgTotalHours,
        Number(p.monthlyHours.toFixed(1)),
        p.grandTotalHours,
        currencies[0].date || "",
        currencies[1].date || "",
        currencies[2].date || "",
        currencies[3].date || "",
        currencies[4].date || "",
        statusLabel(pilotWorstStatus(p)),
      ]);
      currencyColIdxs.forEach((colIdx, i) => {
        const c = row.getCell(colIdx);
        const tone = fills[colourFor(currencies[i].status)];
        c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: tone.fill } };
        c.font = { color: { argb: tone.font }, bold: currencies[i].status === "expired" || currencies[i].status === "critical" };
        c.alignment = { horizontal: "center", vertical: "middle" };
      });
    });

    // Bold header row with a darker fill so it reads as a banner.
    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E293B" } };
    headerRow.alignment = { vertical: "middle", horizontal: "center" };
    headerRow.height = 20;

    // Auto-size each column to fit its widest cell. ExcelJS has no native
    // autofit, so we measure header + every value and pick a sensible width
    // (clamped to keep absurdly long names from blowing the layout).
    // We iterate by header count rather than ws.columns because exceljs
    // sometimes omits trailing columns from ws.columns when they were only
    // populated via addRow.
    for (let idx = 0; idx < headers.length; idx++) {
      const colNum = idx + 1;
      let max = String(headers[idx] ?? "").length;
      ws.eachRow({ includeEmpty: false }, row => {
        const v = row.getCell(colNum).value;
        const s = v == null ? "" : String(v);
        if (s.length > max) max = s.length;
      });
      ws.getColumn(colNum).width = Math.max(10, Math.min(32, max + 2));
    }

    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    const scope = focusedSqn?.code ?? (sqnFilter !== "__all" ? squadrons.find(s => s.id === sqnFilter)?.code : null) ?? "all";
    a.href = url;
    a.download = `pilots-${scope}-${stamp}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function printReport() {
    window.print();
  }

  const printedOnText = `${t("printedOn")}: ${fmtDate(new Date().toISOString(), lang)}`;

  return (
    <div className="space-y-4 print-area">
      <div className="flex items-center justify-between flex-wrap gap-2 no-print">
        <div>
          {focusedSqn && (
            <Link href="/dashboard/pilots" className="text-xs inline-flex items-center text-muted-foreground hover:text-foreground mb-1">
              <ChevronLeft className={`h-3 w-3 ${dir === "rtl" ? "rotate-180" : ""}`} />{t("back")}
            </Link>
          )}
          <h2 className="text-xl font-bold">
            {focusedSqn ? `${t("squadronView")}: ${lang === "ar" ? focusedSqn.nameAr : focusedSqn.name}` : t("pilots")}
          </h2>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">{list.length} {t("pilots")}</span>
          {canExport && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={exportCsv} data-testid="button-export-csv">
                <Download className="h-3.5 w-3.5 me-1.5" />{t("exportCsv")}
              </Button>
              <Button size="sm" variant="outline" onClick={exportXlsx} data-testid="button-export-xlsx">
                <FileSpreadsheet className="h-3.5 w-3.5 me-1.5" />{t("exportXlsx")}
              </Button>
              <Button size="sm" variant="outline" onClick={printReport} data-testid="button-print">
                <Printer className="h-3.5 w-3.5 me-1.5" />{t("print")}
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Wing/Base/HQ tier empty-state explainer (audit F-B-01). Shown
          only on the all-squadrons view; the squadron drill-down below
          already has its own "Daily picture" card from the snapshot. */}
      {isCrossSqnViewer && !focusedSqn && (
        <>
          <CommanderEmptyState surface="pilots" />
          <SnapshotStalenessBanner />
        </>
      )}

      {isCrossSqnViewer && focusedSqn && (
        <Card className="no-print">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="text-sm font-semibold flex items-center gap-2">
                <Clock className="h-4 w-4 text-primary" />
                Daily picture
              </div>
              <div className="text-xs text-muted-foreground">
                {snapshot
                  ? `Last sync: ${fmtDate(snapshot.snapshotAt, lang)} · ${new Date(snapshot.snapshotAt).toLocaleTimeString()}`
                  : (snapshotQ.isLoading ? "—" : "No live data from this squadron yet")}
              </div>
            </div>
            {snapshot && (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div className="rounded-md border border-border bg-secondary/30 p-2">
                    <div className="text-[10px] uppercase text-muted-foreground tracking-wider">{t("pilots")}</div>
                    <div className="text-lg font-semibold tabular-nums">{snapshot.payload.counts.pilots}</div>
                  </div>
                  <div className="rounded-md border border-border bg-secondary/30 p-2">
                    <div className="text-[10px] uppercase text-muted-foreground tracking-wider">Unavailable today</div>
                    <div className="text-lg font-semibold tabular-nums text-amber-400">{snapshot.payload.counts.unavailToday}</div>
                  </div>
                  <div className="rounded-md border border-border bg-secondary/30 p-2">
                    <div className="text-[10px] uppercase text-muted-foreground tracking-wider">{t("expiringSoon")}</div>
                    <div className="text-lg font-semibold tabular-nums text-yellow-400">{snapshot.payload.counts.expiringSoon}</div>
                  </div>
                  <div className="rounded-md border border-border bg-secondary/30 p-2">
                    <div className="text-[10px] uppercase text-muted-foreground tracking-wider">{t("expired")}</div>
                    <div className="text-lg font-semibold tabular-nums text-red-400">{snapshot.payload.counts.expired}</div>
                  </div>
                </div>
                <div>
                  <div className="text-xs font-semibold mb-1.5 flex items-center gap-1.5">
                    <UserX className="h-3.5 w-3.5 text-amber-400" />
                    Unavailable today
                    <span className="text-muted-foreground font-normal">({snapshot.payload.unavailable.length})</span>
                  </div>
                  {snapshot.payload.unavailable.length === 0 ? (
                    <div className="text-xs text-muted-foreground italic px-1 py-2">
                      All pilots available.
                    </div>
                  ) : (
                    <div className="overflow-x-auto rounded-md border border-border">
                      <table className="w-full text-xs">
                        <thead className="bg-secondary/40 text-muted-foreground uppercase text-[10px]">
                          <tr>
                            <th className="text-start px-2 py-1.5">Pilot</th>
                            <th className="text-start px-2 py-1.5">From</th>
                            <th className="text-start px-2 py-1.5">To</th>
                            <th className="text-start px-2 py-1.5">Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {snapshot.payload.unavailable.map(u => (
                            <tr key={u.id} className="border-t border-border">
                              <td className="px-2 py-1.5">{u.pilotName}</td>
                              <td className="px-2 py-1.5 font-mono">{u.from}</td>
                              <td className="px-2 py-1.5 font-mono">{u.to}</td>
                              <td className="px-2 py-1.5 text-muted-foreground">{u.reason || "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <div className="print-only print-header">
        <h1>{reportTitle}</h1>
        <div className="meta">
          <div>{printedOnText}</div>
          <div>{list.length} {t("pilots")}</div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 no-print">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t("search")} className="ps-9" data-testid="input-search" />
        </div>
        {!focusedSqnId && (
          <Select value={sqnFilter} onValueChange={setSqnFilter}>
            <SelectTrigger className="w-48" data-testid="select-sqn-filter"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">{t("selectAll")}</SelectItem>
              {mySqns.map(s => (
                <SelectItem key={s.id} value={s.id}>{lang === "ar" ? s.nameAr : s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={statusFilter} onValueChange={(v: string) => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="w-40" data-testid="select-status-filter"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("all")}</SelectItem>
            <SelectItem value="current">{t("current")}</SelectItem>
            <SelectItem value="warning">{t("expiringSoon")}</SelectItem>
            <SelectItem value="expired">{t("expired")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-muted-foreground text-xs uppercase">
                  <Th onClick={() => setSort("callSign")}>{t("callSign")}</Th>
                  <th className="text-start py-2 px-3">{t("flightName")}</th>
                  <Th onClick={() => setSort("fullName")}>{t("name")}</Th>
                  <th className="text-start py-2 px-3">{t("squadron")}</th>
                  <Th onClick={() => setSort("grandTotalHours")} align="end">{t("grandTotal")}</Th>
                  <Th onClick={() => setSort("monthlyHours")} align="end">{t("monthlyHours")}</Th>
                  <th className="text-start py-2 px-3">{t("status")}</th>
                  <th className="py-2 px-3 no-print"></th>
                </tr>
              </thead>
              <tbody>
                {list.length === 0 && (
                  <tr><td colSpan={8} className="py-8 text-center text-muted-foreground">{t("noResults")}</td></tr>
                )}
                {list.map(p => {
                  const sqn = squadrons.find(s => s.id === p.squadronId);
                  return (
                    <tr key={p.id} className="border-b border-border/60 hover:bg-accent/30" data-testid={`row-pilot-${p.id}`}>
                      <td className="py-2 px-3 font-mono text-xs">{p.callSign}</td>
                      <td className="py-2 px-3 font-mono text-xs text-muted-foreground">{p.flightName ?? "—"}</td>
                      <td className="py-2 px-3 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium">{lang === "ar" ? p.fullNameAr : p.fullName}</span>
                          {p.qualifications?.map(q => (
                            <span
                              key={q}
                              className="inline-flex items-center rounded border border-amber-400/40 bg-amber-400/10 px-1 py-0 text-[9px] font-semibold tracking-wider text-amber-600 dark:text-amber-300"
                              data-testid={`qual-${p.id}-${q}`}
                            >
                              {q}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="py-2 px-3 text-xs">{sqn ? (lang === "ar" ? sqn.nameAr : sqn.code) : ""}</td>
                      <td className="py-2 px-3 text-end tabular-nums font-semibold text-base">{p.grandTotalHours}</td>
                      <td className="py-2 px-3 text-end tabular-nums">{p.monthlyHours.toFixed(1)}</td>
                      <td className="py-2 px-3"><StatusBadge status={pilotWorstStatus(p)} date={pilotWorstDate(p)} /></td>
                      <td className="py-2 px-3 text-end no-print">
                        <Link href={`/dashboard/pilot/${p.id}`}>
                          <Button size="sm" variant="outline" data-testid={`button-view-${p.id}`}>{t("viewDetails")}</Button>
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Th({ children, onClick, align = "start" }: { children: React.ReactNode; onClick?: () => void; align?: "start" | "end" }) {
  return (
    <th className={`py-2 px-3 text-${align}`}>
      <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={onClick}>
        {children}
        {onClick && <ArrowUpDown className="h-3 w-3" />}
      </button>
    </th>
  );
}
