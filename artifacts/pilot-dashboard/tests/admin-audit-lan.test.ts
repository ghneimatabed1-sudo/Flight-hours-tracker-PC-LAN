import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyAdminAuditFilters,
  listAdminAuditTypes,
  mapInternalAuditRowsToAdminRows,
  paginateAdminAuditRows,
} from "../src/lib/admin-audit-lan";

test("admin audit LAN map/filter/paginate", () => {
  const mapped = mapInternalAuditRowsToAdminRows([
    {
      occurred_at: "2026-04-26T10:00:00.000Z",
      actor: "local.admin",
      type: "internal.reminders.enable",
      detail: { cron: "0 6 * * *" },
    },
    {
      occurred_at: "2026-04-26T11:00:00.000Z",
      actor: "local.ops",
      type: "internal.sorties.insert",
      detail: { id: "S-1" },
    },
  ]);

  assert.equal(mapped.length, 2);
  assert.equal(mapped[0]?.type, "internal.reminders.enable");

  const filtered = applyAdminAuditFilters(mapped, {
    actorFilter: "admin",
    typeFilter: "",
    fromDate: "",
    toDate: "",
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.actor, "local.admin");

  const types = listAdminAuditTypes(mapped);
  assert.deepEqual(types, ["internal.reminders.enable", "internal.sorties.insert"]);

  const page0 = paginateAdminAuditRows(mapped, 0, 1);
  const page1 = paginateAdminAuditRows(mapped, 1, 1);
  assert.equal(page0.length, 1);
  assert.equal(page1.length, 1);
  assert.notEqual(page0[0]?.id, page1[0]?.id);
});
