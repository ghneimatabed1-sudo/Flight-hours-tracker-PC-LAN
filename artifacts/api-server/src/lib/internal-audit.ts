import { pool } from "@workspace/db";

export async function appendInternalAudit(
  actor: string,
  type: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await pool.query(
      `
      insert into audit_log (occurred_at, actor, type, detail)
      values (now(), $1, $2, $3::jsonb)
      `,
      [actor || "system", type, JSON.stringify(detail)],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/relation .*audit_log.* does not exist/i.test(msg)) throw err;
  }
}
