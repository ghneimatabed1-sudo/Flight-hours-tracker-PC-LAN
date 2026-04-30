export type AdminAuditRow = {
  id: number | string;
  type: string;
  actor: string | null;
  detail: Record<string, unknown> | null;
  occurred_at: string;
};

export type AdminAuditFilters = {
  actorFilter: string;
  typeFilter: string;
  fromDate: string;
  toDate: string;
};

export function mapInternalAuditRowsToAdminRows(
  rows: Array<{
    occurred_at?: string | null;
    actor?: string | null;
    type?: string | null;
    detail?: unknown;
  }>,
): AdminAuditRow[] {
  return rows.map((r, i) => ({
    id: `${String(r.occurred_at ?? "")}:${i}`,
    type: String(r.type ?? ""),
    actor: r.actor == null || r.actor === "" ? null : String(r.actor),
    detail: r.detail && typeof r.detail === "object" ? (r.detail as Record<string, unknown>) : null,
    occurred_at: String(r.occurred_at ?? ""),
  }));
}

export function applyAdminAuditFilters(
  rows: AdminAuditRow[],
  filters: AdminAuditFilters,
): AdminAuditRow[] {
  const actorNeedle = filters.actorFilter.trim().toLowerCase();
  const typeNeedle = filters.typeFilter.trim();
  const fromTs = filters.fromDate ? Date.parse(`${filters.fromDate}T00:00:00`) : null;
  const toTs = filters.toDate ? Date.parse(`${filters.toDate}T23:59:59`) : null;

  return rows.filter((r) => {
    if (actorNeedle) {
      const actor = String(r.actor ?? "").toLowerCase();
      if (!actor.includes(actorNeedle)) return false;
    }
    if (typeNeedle && r.type !== typeNeedle) return false;
    if (fromTs != null || toTs != null) {
      const ts = Date.parse(String(r.occurred_at ?? ""));
      if (Number.isFinite(fromTs) && (!Number.isFinite(ts) || ts < (fromTs as number))) return false;
      if (Number.isFinite(toTs) && (!Number.isFinite(ts) || ts > (toTs as number))) return false;
    }
    return true;
  });
}

export function listAdminAuditTypes(rows: AdminAuditRow[]): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const t = String(r.type ?? "").trim();
    if (t) set.add(t);
  }
  return Array.from(set).sort();
}

export function paginateAdminAuditRows(
  rows: AdminAuditRow[],
  page: number,
  pageSize: number,
): AdminAuditRow[] {
  const from = Math.max(0, page) * Math.max(1, pageSize);
  return rows.slice(from, from + Math.max(1, pageSize));
}
