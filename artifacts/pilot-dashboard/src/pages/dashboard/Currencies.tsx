import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { useDashPilots, useDashSquadrons } from "@/lib/dash-pilots";
import { resolveScopedIds, useSquadronScope } from "@/lib/squadron-scope";
import { currencyStatus, fmtDate } from "@/lib/format";
import type { CurrencyStatus, Pilot } from "@/lib/types";
import { Search, ArrowUpDown, Download, Printer, FileSpreadsheet, Gauge, Eye, EyeOff } from "lucide-react";
import { CommanderEmptyState } from "@/components/CommanderEmptyState";
import { SnapshotStalenessBanner } from "@/components/SnapshotStalenessBanner";

// Per-PC hide-pilot store, mirrored exactly with the ops Currency page so
// that on a dual-purpose PC (commander + ops both signed in over time) the
// "Hide" decisions stay consistent. Local-only — never propagates between
// PCs because each station owns its own roll-up view.
const HIDE_KEY = "rjaf.currency.hiddenPilots";
function loadHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as unknown;
    return new Set(Array.isArray(arr) ? (arr as string[]) : []);
  } catch { return new Set(); }
}
function saveHidden(s: Set<string>) {
  localStorage.setItem(HIDE_KEY, JSON.stringify(Array.from(s)));
}

type SortKey = "callSign" | "fullName" | "squadron" | "day" | "night" | "nvg" | "irt" | "medical" | "worst";

function rankStatus(s: CurrencyStatus): number {
  return { current: 0, unset: 1, warning: 2, expiringSoon: 3, critical: 4, expired: 5 }[s];
}

function pilotDate(p: Pilot, k: SortKey): string {
  if (k === "day") return p.dayCurrencyDate;
  if (k === "night") return p.nightCurrencyDate;
  if (k === "nvg") return p.nvgCurrencyDate ?? "";
  if (k === "irt") return p.irtCurrencyDate;
  if (k === "medical") return p.medicalCurrencyDate;
  return "";
}

function pilotWorst(p: Pilot): { status: CurrencyStatus; date: string } {
  const checks: Array<[CurrencyStatus, string]> = [
    [currencyStatus(p.dayCurrencyDate), p.dayCurrencyDate],
    [currencyStatus(p.nightCurrencyDate), p.nightCurrencyDate],
    [currencyStatus(p.nvgCurrencyDate ?? ""), p.nvgCurrencyDate ?? ""],
    [currencyStatus(p.irtCurrencyDate), p.irtCurrencyDate],
    [currencyStatus(p.medicalCurrencyDate), p.medicalCurrencyDate],
  ];
  let best: { status: CurrencyStatus; date: string } = { status: "current", date: "" };
  for (const [s, d] of checks) {
    if (rankStatus(s) > rankStatus(best.status)) best = { status: s, date: d };
  }
  return best;
}

export default function Currencies() {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const squadrons = useDashSquadrons();
  const pilots = useDashPilots();

  const [q, setQ] = useState("");
  const [sqnFilter, setSqnFilter] = useState<string>("__all");
  const [statusFilter, setStatusFilter] = useState<"all" | "current" | "warning" | "expired">("all");
  const [sortKey, setSortKey] = useState<SortKey>("worst");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const [scope] = useSquadronScope();
  if (!user) return null;
  // Topbar scope picker (HQ / multi-squadron commanders) narrows the
  // operator's authorized squadron list before we build the table.
  // Falls back to the union when scope is "Combined" or stale.
  const myIds = new Set(resolveScopedIds(scope, user.squadronIds));
  const mySqns = squadrons.filter(s => myIds.has(s.id));
  const canExport = user.role === "commander";

  // Reset the in-page squadron filter when the topbar scope no longer
  // contains it, so the table doesn't render empty after the operator
  // narrows scope to a different squadron than they had filtered to.
  useEffect(() => {
    if (sqnFilter !== "__all" && !myIds.has(sqnFilter)) {
      setSqnFilter("__all");
    }
  }, [scope, sqnFilter, myIds]);

  const list = useMemo(() => {
    let l = pilots.filter(p => myIds.has(p.squadronId));
    if (sqnFilter !== "__all") l = l.filter(p => p.squadronId === sqnFilter);
    if (statusFilter !== "all") {
      l = l.filter(p => {
        const s = pilotWorst(p).status;
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
      let cmp = 0;
      if (sortKey === "callSign") cmp = a.callSign.localeCompare(b.callSign);
      else if (sortKey === "fullName") cmp = a.fullName.localeCompare(b.fullName);
      else if (sortKey === "squadron") cmp = a.squadronId.localeCompare(b.squadronId);
      else if (sortKey === "worst") cmp = rankStatus(pilotWorst(a).status) - rankStatus(pilotWorst(b).status);
      else {
        const ad = pilotDate(a, sortKey);
        const bd = pilotDate(b, sortKey);
        cmp = ad.localeCompare(bd);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return l;
  }, [q, sqnFilter, statusFilter, sortKey, sortDir, myIds]);

  function setSort(k: SortKey) {
    if (sortKey === k) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(k); setSortDir("asc"); }
  }

  function statusLabel(s: CurrencyStatus): string {
    if (s === "expired") return t("expired");
    if (s === "critical" || s === "expiringSoon") return t("expiringSoon");
    if (s === "warning") return t("warning");
    if (s === "unset") return t("notSet");
    return t("current");
  }

  const headers = [
    t("callSign"), t("name"), t("squadron"),
    t("dayCurrency"), t("nightCurrency"), t("nvgCurrency"), t("irtCurrency"), t("medicalCurrency"),
    t("status"),
  ];

  function exportCsv() {
    const rows = list.map(p => {
      const sqn = squadrons.find(s => s.id === p.squadronId);
      const worst = pilotWorst(p);
      return [
        p.callSign,
        lang === "ar" ? p.fullNameAr : p.fullName,
        sqn ? (lang === "ar" ? sqn.nameAr : sqn.code) : "",
        p.dayCurrencyDate,
        p.nightCurrencyDate,
        p.nvgCurrencyDate ?? "",
        p.irtCurrencyDate,
        p.medicalCurrencyDate,
        statusLabel(worst.status),
      ];
    });
    const escape = (v: string) => {
      const needs = /[",\n\r]/.test(v);
      const cleaned = v.replace(/"/g, '""');
      return needs ? `"${cleaned}"` : cleaned;
    };
    const csv = [headers, ...rows].map(r => r.map(escape).join(",")).join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `currencies-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function exportXlsx() {
    const ExcelJS = (await import("exceljs")).default;
    // Currency date columns are 1-indexed positions 4..8 in the headers
    // array above. Tracked here so the styling pass below knows which
    // cells to colour.
    const currencyColIdxs = [4, 5, 6, 7, 8];

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Currencies", {
      // Freeze the header row so it stays visible while scrolling — matches
      // the on-screen sticky header expectation for printed reports.
      views: [{ state: "frozen", ySplit: 1 }],
    });
    ws.addRow(headers);

    // ── ARGB fills matching the on-screen currency badge colours ──
    // Excel uses ARGB (alpha first). We use light tints so the printed
    // sheet remains readable in B&W as well as colour. Mirrors the
    // pilot-table export so commanders see the same palette in both
    // workbooks.
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
      const worst = pilotWorst(p);
      const row = ws.addRow([
        p.callSign,
        lang === "ar" ? p.fullNameAr : p.fullName,
        sqn ? (lang === "ar" ? sqn.nameAr : sqn.code) : "",
        currencies[0].date || "",
        currencies[1].date || "",
        currencies[2].date || "",
        currencies[3].date || "",
        currencies[4].date || "",
        statusLabel(worst.status),
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
    a.href = url;
    a.download = `currencies-${stamp}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const printedOnText = `${t("printedOn")}: ${fmtDate(new Date().toISOString(), lang)}`;
  const title = sqnFilter !== "__all"
    ? (() => {
        const s = squadrons.find(x => x.id === sqnFilter);
        return s ? `${t("currencies")} — ${lang === "ar" ? s.nameAr : s.name}` : t("currencies");
      })()
    : `${t("currencies")} — ${t("allSquadrons")}`;

  return (
    <div className="space-y-4 print-area">
      <div className="flex items-center justify-between flex-wrap gap-2 no-print">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Gauge className="h-5 w-5 text-primary" />
          {t("currencies")}
        </h2>
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
              <Button size="sm" variant="outline" onClick={() => window.print()} data-testid="button-print">
                <Printer className="h-3.5 w-3.5 me-1.5" />{t("print")}
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="print-only print-header">
        <h1>{title}</h1>
        <div className="meta">
          <div>{printedOnText}</div>
          <div>{list.length} {t("pilots")}</div>
        </div>
      </div>

      {/* Wing/Base/HQ tier empty-state explainer (audit F-B-01). */}
      <CommanderEmptyState surface="currencies" />
      <SnapshotStalenessBanner />

      <div className="flex flex-wrap gap-2 no-print">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input value={q} onChange={e => setQ(e.target.value)} placeholder={t("search")} className="ps-9" data-testid="input-search-currency" />
        </div>
        <Select value={sqnFilter} onValueChange={setSqnFilter}>
          <SelectTrigger className="w-48" data-testid="select-sqn-filter-currency"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">{t("selectAll")}</SelectItem>
            {mySqns.map(s => (
              <SelectItem key={s.id} value={s.id}>{lang === "ar" ? s.nameAr : s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v: string) => setStatusFilter(v as typeof statusFilter)}>
          <SelectTrigger className="w-40" data-testid="select-status-filter-currency"><SelectValue /></SelectTrigger>
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
                  <Th onClick={() => setSort("fullName")}>{t("name")}</Th>
                  <Th onClick={() => setSort("squadron")}>{t("squadron")}</Th>
                  <Th onClick={() => setSort("day")}>{t("dayCurrency")}</Th>
                  <Th onClick={() => setSort("night")}>{t("nightCurrency")}</Th>
                  <Th onClick={() => setSort("nvg")}>{t("nvgCurrency")}</Th>
                  <Th onClick={() => setSort("irt")}>{t("irtCurrency")}</Th>
                  <Th onClick={() => setSort("medical")}>{t("medicalCurrency")}</Th>
                  <Th onClick={() => setSort("worst")}>{t("status")}</Th>
                  <th className="py-2 px-3 no-print"></th>
                </tr>
              </thead>
              <tbody>
                {list.length === 0 && (
                  <tr><td colSpan={10} className="py-8 text-center text-muted-foreground">{t("noResults")}</td></tr>
                )}
                {list.map(p => {
                  const sqn = squadrons.find(s => s.id === p.squadronId);
                  const worst = pilotWorst(p);
                  return (
                    <tr key={p.id} className="border-b border-border/60 hover:bg-accent/30" data-testid={`row-currency-${p.id}`}>
                      <td className="py-2 px-3 font-mono text-xs">{p.callSign}</td>
                      <td className="py-2 px-3 whitespace-nowrap font-medium">{lang === "ar" ? p.fullNameAr : p.fullName}</td>
                      <td className="py-2 px-3 text-xs">{sqn ? (lang === "ar" ? sqn.nameAr : sqn.code) : ""}</td>
                      <td className="py-2 px-3"><StatusBadge status={currencyStatus(p.dayCurrencyDate)} date={p.dayCurrencyDate} /></td>
                      <td className="py-2 px-3"><StatusBadge status={currencyStatus(p.nightCurrencyDate)} date={p.nightCurrencyDate} /></td>
                      <td className="py-2 px-3"><StatusBadge status={currencyStatus(p.nvgCurrencyDate ?? "")} date={p.nvgCurrencyDate ?? ""} /></td>
                      <td className="py-2 px-3"><StatusBadge status={currencyStatus(p.irtCurrencyDate)} date={p.irtCurrencyDate} /></td>
                      <td className="py-2 px-3"><StatusBadge status={currencyStatus(p.medicalCurrencyDate)} date={p.medicalCurrencyDate} /></td>
                      <td className="py-2 px-3"><StatusBadge status={worst.status} date={worst.date || undefined} /></td>
                      <td className="py-2 px-3 text-end no-print">
                        <Link href={`/dashboard/pilot/${p.id}`}>
                          <Button size="sm" variant="outline" data-testid={`button-view-currency-${p.id}`}>{t("viewDetails")}</Button>
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

function Th({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <th className="py-2 px-3 text-start">
      <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={onClick}>
        {children}
        {onClick && <ArrowUpDown className="h-3 w-3" />}
      </button>
    </th>
  );
}
