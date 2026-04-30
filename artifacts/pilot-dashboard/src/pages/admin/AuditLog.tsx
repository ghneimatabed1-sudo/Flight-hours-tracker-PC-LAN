import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { fmtDateTime } from "@/lib/format";
import { ListChecks, Search, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { supabase, AUDIT_RETENTION_ROWS } from "@/lib/supabase";
import { fetchInternalAuditLogRows, isLanSessionLoginEnabled } from "@/lib/internal-migration";
import {
  applyAdminAuditFilters,
  listAdminAuditTypes,
  mapInternalAuditRowsToAdminRows,
  paginateAdminAuditRows,
} from "@/lib/admin-audit-lan";

type AuditRow = {
  id: number | string;
  type: string;
  actor: string | null;
  detail: Record<string, unknown> | null;
  occurred_at: string;
};

const PAGE_SIZE = 50;
const MAX_PAGES = Math.ceil(AUDIT_RETENTION_ROWS / PAGE_SIZE); // 50

export default function AuditLog() {
  const { t, lang } = useI18n();
  const lanMode = isLanSessionLoginEnabled();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [actorFilter, setActorFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [page, setPage] = useState(0); // zero-indexed

  // Distinct action types for the dropdown filter — pulled lazily.
  const [knownTypes, setKnownTypes] = useState<string[]>([]);

  const fetchRows = async () => {
    if (lanMode) {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchInternalAuditLogRows(AUDIT_RETENTION_ROWS);
        if (!data) throw new Error("internal_audit_fetch_failed");
        const mapped = mapInternalAuditRowsToAdminRows(data);
        const filtered = applyAdminAuditFilters(mapped, {
          actorFilter,
          typeFilter,
          fromDate,
          toDate,
        });
        setTotal(filtered.length);
        setRows(paginateAdminAuditRows(filtered, page, PAGE_SIZE));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        setRows([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
      return;
    }
    if (!supabase) {
      setRows([]);
      setTotal(0);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      let q = supabase
        .from("audit_log")
        .select("id, type, actor, detail, occurred_at", { count: "exact" })
        .order("occurred_at", { ascending: false });

      if (actorFilter.trim()) q = q.ilike("actor", `%${actorFilter.trim()}%`);
      if (typeFilter) q = q.eq("type", typeFilter);
      if (fromDate) q = q.gte("occurred_at", `${fromDate}T00:00:00`);
      if (toDate) q = q.lte("occurred_at", `${toDate}T23:59:59`);

      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      const { data, count, error: qErr } = await q.range(from, to);
      if (qErr) throw qErr;
      setRows((data ?? []) as AuditRow[]);
      setTotal(count ?? 0);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  };

  // Pull distinct types once for the dropdown — sampled from latest 1k rows.
  const fetchKnownTypes = async () => {
    if (lanMode) {
      try {
        const data = await fetchInternalAuditLogRows(AUDIT_RETENTION_ROWS);
        const mapped = mapInternalAuditRowsToAdminRows(data ?? []);
        setKnownTypes(listAdminAuditTypes(mapped));
      } catch {
        /* best-effort */
      }
      return;
    }
    if (!supabase) return;
    try {
      const { data } = await supabase
        .from("audit_log")
        .select("type")
        .order("occurred_at", { ascending: false })
        .limit(1000);
      const set = new Set<string>();
      for (const r of (data ?? []) as Array<{ type: string }>) {
        if (r.type) set.add(r.type);
      }
      setKnownTypes(Array.from(set).sort());
    } catch {
      /* best-effort */
    }
  };

  useEffect(() => {
    void fetchRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, actorFilter, typeFilter, fromDate, toDate]);

  useEffect(() => {
    void fetchKnownTypes();
  }, []);

  const totalPages = useMemo(() => {
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    return Math.min(pages, MAX_PAGES);
  }, [total]);

  const resetFilters = () => {
    setActorFilter("");
    setTypeFilter("");
    setFromDate("");
    setToDate("");
    setPage(0);
  };

  const formatDetail = (d: Record<string, unknown> | null): string => {
    if (!d || Object.keys(d).length === 0) return "—";
    try {
      return JSON.stringify(d);
    } catch {
      return "—";
    }
  };

  // Page number window (compact, like Google) — show first, last, current ±2.
  const pageWindow = useMemo(() => {
    const out: Array<number | "…"> = [];
    const cur = page;
    const last = totalPages - 1;
    const add = (n: number) => out.push(n);
    add(0);
    if (cur - 2 > 1) out.push("…");
    for (let i = Math.max(1, cur - 2); i <= Math.min(last - 1, cur + 2); i++) add(i);
    if (cur + 2 < last - 1) out.push("…");
    if (last > 0) add(last);
    return out;
  }, [page, totalPages]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <ListChecks className="h-5 w-5" />
          {t("auditLog")}
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground tabular-nums">
            {total.toLocaleString(lang === "ar" ? "ar-JO" : "en-GB")} / {AUDIT_RETENTION_ROWS}
          </span>
          <Button size="sm" variant="outline" onClick={() => void fetchRows()} disabled={loading} data-testid="button-refresh-audit">
            <RefreshCw className={`h-3.5 w-3.5 me-1 ${loading ? "animate-spin" : ""}`} />
            {lang === "ar" ? "تحديث" : "Refresh"}
          </Button>
        </div>
      </div>

      {/* Filters row */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
        <div className="relative md:col-span-2">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={actorFilter}
            onChange={e => { setActorFilter(e.target.value); setPage(0); }}
            placeholder={lang === "ar" ? "بحث بالمستخدم" : "Search user"}
            className="ps-9"
            data-testid="input-search-actor"
          />
        </div>
        <select
          value={typeFilter}
          onChange={e => { setTypeFilter(e.target.value); setPage(0); }}
          className="h-10 rounded-md border border-input bg-background px-3 text-sm"
          data-testid="select-action-type"
        >
          <option value="">{lang === "ar" ? "كل الإجراءات" : "All actions"}</option>
          {knownTypes.map(ty => (
            <option key={ty} value={ty}>{ty}</option>
          ))}
        </select>
        <Input
          type="date"
          value={fromDate}
          onChange={e => { setFromDate(e.target.value); setPage(0); }}
          data-testid="input-date-from"
        />
        <Input
          type="date"
          value={toDate}
          onChange={e => { setToDate(e.target.value); setPage(0); }}
          data-testid="input-date-to"
        />
      </div>
      {(actorFilter || typeFilter || fromDate || toDate) && (
        <div>
          <Button size="sm" variant="ghost" onClick={resetFilters} data-testid="button-reset-filters">
            {lang === "ar" ? "مسح المرشحات" : "Clear filters"}
          </Button>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 text-red-300 text-xs p-3">
          {error}
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-muted-foreground">
                  <th className="text-start py-2 px-3">{t("timestamp")}</th>
                  <th className="text-start py-2 px-3">{t("user")}</th>
                  <th className="text-start py-2 px-3">{t("action")}</th>
                  <th className="text-start py-2 px-3">{t("target")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !loading && (
                  <tr>
                    <td colSpan={4} className="py-6 text-center text-muted-foreground">
                      {t("noResults")}
                    </td>
                  </tr>
                )}
                {rows.map(a => (
                  <tr key={a.id} className="border-b border-border/60" data-testid={`row-audit-${a.id}`}>
                    <td className="py-2 px-3 tabular-nums whitespace-nowrap">{fmtDateTime(a.occurred_at, lang)}</td>
                    <td className="py-2 px-3">
                      <span className="font-mono text-xs">{a.actor ?? "—"}</span>
                    </td>
                    <td className="py-2 px-3 font-mono text-xs">{a.type}</td>
                    <td className="py-2 px-3 text-xs text-muted-foreground max-w-[420px] truncate" title={formatDetail(a.detail)}>
                      {formatDetail(a.detail)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="text-xs text-muted-foreground">
            {lang === "ar"
              ? `صفحة ${page + 1} من ${totalPages}`
              : `Page ${page + 1} of ${totalPages}`}
            {totalPages >= MAX_PAGES && (
              <span className="ms-2 text-amber-400">
                {lang === "ar" ? "(الحد الأقصى)" : "(retention cap)"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              data-testid="button-prev-page"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            {pageWindow.map((p, i) =>
              p === "…" ? (
                <span key={`e${i}`} className="px-2 text-muted-foreground">…</span>
              ) : (
                <Button
                  key={p}
                  size="sm"
                  variant={p === page ? "default" : "outline"}
                  onClick={() => setPage(p)}
                  data-testid={`button-page-${p}`}
                >
                  {p + 1}
                </Button>
              )
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              data-testid="button-next-page"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
