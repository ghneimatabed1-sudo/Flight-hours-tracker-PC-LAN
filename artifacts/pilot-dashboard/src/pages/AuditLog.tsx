import { useMemo, useState } from "react";
import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";
import { useAuth } from "@/lib/auth";
import { supabaseConfigured } from "@/lib/supabase";
import { isLanSessionLoginEnabled } from "@/lib/internal-migration";
import {
  useAuditLog,
  AUDIT_PAGE_SIZE,
  AUDIT_MAX_PAGES,
  AUDIT_MAX_ROWS,
} from "@/lib/squadron-data";
import { DataUnavailableBanner } from "@/components/DataUnavailableBanner";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";

// Audit-log viewer — April 2026 rebuild. The previous version dumped the
// last 200 rows into a single unscrolled table. Field ops asked for:
//   1. Pagination — 50 rows / page, hard cap of 50 pages so the table can
//      never balloon past 2,500 entries (older rows still live in the DB
//      in live mode but are never requested by the client).
//   2. Free-text search across user / action / target columns.
//   3. Action-type quick filter (drop-down of every distinct action seen
//      in the loaded rows so it self-populates).
//   4. Date-range filter (from / to inclusive).
// All filters apply to the in-memory loaded set, then pagination slices
// the filtered result; the visible "page X of Y" recomputes accordingly.
export default function AuditLog() {
  const lanMode = isLanSessionLoginEnabled();
  const { t } = useI18n();
  const { fingerprint } = useAuth();
  const auditQ = useAuditLog();
  const { data: rows, isLoading } = auditQ;

  const [search, setSearch] = useState("");
  const [actionFilter, setActionFilter] = useState<string>("");
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [page, setPage] = useState(1);

  // Distinct action values for the drop-down. Sorted alphabetically so the
  // operator can find a specific event quickly without scrolling.
  const actionOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.action);
    return Array.from(set).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (actionFilter && r.action !== actionFilter) return false;
      if (q) {
        const hay = `${r.user} ${r.action} ${r.target}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      // Compare on the ISO date prefix (yyyy-mm-dd) which lexicographically
      // sorts the same as chronological — no Date parsing needed.
      const day = r.ts.slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    });
  }, [rows, search, actionFilter, from, to]);

  // Hard cap on visible pages — even if the DB returns more rows than
  // AUDIT_MAX_ROWS (e.g. a future cap bump), the UI never paginates past
  // AUDIT_MAX_PAGES so old browsers don't stall on huge tables.
  const totalPages = Math.max(
    1,
    Math.min(AUDIT_MAX_PAGES, Math.ceil(filtered.length / AUDIT_PAGE_SIZE)),
  );
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * AUDIT_PAGE_SIZE;
  const pageRows = filtered.slice(start, start + AUDIT_PAGE_SIZE);

  const resetFilters = () => {
    setSearch(""); setActionFilter(""); setFrom(""); setTo(""); setPage(1);
  };
  const hasFilters = !!(search || actionFilter || from || to);

  return (
    <div>
      <PageHead
        title={t("nav_audit")}
        subtitle={
          lanMode
            ? `LAN server · up to ${AUDIT_MAX_ROWS.toLocaleString()} most-recent events · ${AUDIT_PAGE_SIZE}/page`
            : supabaseConfigured
            ? `Live · up to ${AUDIT_MAX_ROWS.toLocaleString()} most-recent events · ${AUDIT_PAGE_SIZE}/page`
            : "Demo data · connect backend for live history"
        }
      />
      <DataUnavailableBanner queries={[auditQ]} testId="banner-audit-unavailable" />

      <Card className="mb-3 !p-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search user / action / target"
              className="pl-7 pr-2 py-1.5 rounded-md bg-input border border-border text-sm w-64"
              data-testid="input-audit-search"
            />
          </div>
          <label className="text-xs text-muted-foreground flex flex-col">
            <span>Action</span>
            <select
              value={actionFilter}
              onChange={e => { setActionFilter(e.target.value); setPage(1); }}
              className="mt-0.5 px-2 py-1.5 rounded-md bg-input border border-border text-sm"
              data-testid="select-audit-action"
            >
              <option value="">All actions</option>
              {actionOptions.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </label>
          <label className="text-xs text-muted-foreground flex flex-col">
            <span>From</span>
            <input
              type="date"
              value={from}
              onChange={e => { setFrom(e.target.value); setPage(1); }}
              className="mt-0.5 px-2 py-1.5 rounded-md bg-input border border-border text-sm"
              data-testid="input-audit-from"
            />
          </label>
          <label className="text-xs text-muted-foreground flex flex-col">
            <span>To</span>
            <input
              type="date"
              value={to}
              onChange={e => { setTo(e.target.value); setPage(1); }}
              className="mt-0.5 px-2 py-1.5 rounded-md bg-input border border-border text-sm"
              data-testid="input-audit-to"
            />
          </label>
          {hasFilters && (
            <button
              onClick={resetFilters}
              className="px-2.5 py-1.5 rounded-md bg-secondary border border-border text-xs inline-flex items-center gap-1 hover:bg-secondary/70"
              data-testid="button-audit-reset"
            >
              <X className="h-3 w-3" /> Clear
            </button>
          )}
          <div className="ms-auto text-xs text-muted-foreground" data-testid="text-audit-count">
            {filtered.length.toLocaleString()} match{filtered.length === 1 ? "" : "es"}
            {filtered.length !== rows.length ? ` · ${rows.length.toLocaleString()} total loaded` : ""}
          </div>
        </div>
      </Card>

      <Card className="!p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-secondary/50 text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left">Timestamp</th>
              <th className="px-3 py-2 text-left">User</th>
              <th className="px-3 py-2 text-left">Action</th>
              <th className="px-3 py-2 text-left">Target</th>
              <th className="px-3 py-2 text-left">Fingerprint</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && rows.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">Loading…</td></tr>
            )}
            {!isLoading && pageRows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted-foreground" data-testid="empty-audit">
                  {auditQ.isError ? "—" : hasFilters ? "No events match the current filters." : "No audit events yet."}
                </td>
              </tr>
            )}
            {pageRows.map((e, i) => (
              <tr key={`${e.ts}-${i}`} className="border-t border-border row-hover">
                <td className="px-3 py-2 font-mono">{e.ts}</td>
                <td className="px-3 py-2">{e.user}</td>
                <td className="px-3 py-2">{e.action}</td>
                <td className="px-3 py-2 font-mono text-muted-foreground">{e.target}</td>
                <td className="px-3 py-2 font-mono text-[11px] text-muted-foreground">{fingerprint}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="flex items-center justify-between mt-3 text-xs text-muted-foreground">
        <div data-testid="text-audit-page">Page {safePage} of {totalPages}</div>
        <div className="flex items-center gap-1">
          <button
            disabled={safePage <= 1}
            onClick={() => setPage(p => Math.max(1, p - 1))}
            className="px-2 py-1 rounded-md border border-border bg-secondary disabled:opacity-40 inline-flex items-center gap-1"
            data-testid="button-audit-prev"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Prev
          </button>
          <button
            disabled={safePage >= totalPages}
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            className="px-2 py-1 rounded-md border border-border bg-secondary disabled:opacity-40 inline-flex items-center gap-1"
            data-testid="button-audit-next"
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
