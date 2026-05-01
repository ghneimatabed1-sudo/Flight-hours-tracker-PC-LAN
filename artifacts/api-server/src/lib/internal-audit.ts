import { pool } from "@workspace/db";

/**
 * Insert one row into the LAN audit_log table.
 *
 * If `actor` is empty/falsy or the literal string `"system"`, the detail
 * column is annotated with `actor_unknown: true` so the operator can
 * grep for un-attributed writes (this is the only honest way to record
 * actions made under `HAWK_LAN_DEV_NO_AUTH=1` or before any LAN user is
 * provisioned). The `actor` column is set to the literal `"unknown"` in
 * that case so it never clashes with a real username.
 *
 * Best-effort: silently swallows the "table doesn't exist yet" error from
 * the bring-up window between first boot and ensureFullSchema completion.
 * Other DB errors propagate so production logs surface them.
 */
export async function appendInternalAudit(
  actor: string,
  type: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const trimmed = (actor ?? "").trim();
  const actorUnknown = !trimmed || trimmed === "system";
  const finalActor = actorUnknown ? "unknown" : trimmed;
  const finalDetail = actorUnknown
    ? { ...detail, actor_unknown: true }
    : detail;
  try {
    await pool.query(
      `
      insert into audit_log (occurred_at, actor, type, detail)
      values (now(), $1, $2, $3::jsonb)
      `,
      [finalActor, type, JSON.stringify(finalDetail)],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/relation .*audit_log.* does not exist/i.test(msg)) throw err;
  }
}
