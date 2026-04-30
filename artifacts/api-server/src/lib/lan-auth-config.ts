/**
 * - `HAWK_INTERNAL_SESSION_AUTH=off` — internal data routes do not require a
 *   LAN session (current hybrid/dev default).
 * - `HAWK_INTERNAL_SESSION_AUTH=required` — all `/api/internal/*` data routes
 *   require a valid `x-hawk-lan-session` (or `Authorization: Bearer …`) except
 *   the `/api/internal/auth/lan/*` bootstrap + login routes.
 */
export function internalSessionAuthMode(): "off" | "required" {
  const v = (process.env.HAWK_INTERNAL_SESSION_AUTH ?? "off").trim().toLowerCase();
  if (v === "required" || v === "1" || v === "true" || v === "yes") {
    return "required";
  }
  return "off";
}

export function readLanSessionTokenFromRequest(req: {
  get(name: string): string | undefined;
}): string | null {
  const h = (req.get("x-hawk-lan-session") ?? "").trim();
  if (h) return h;
  const auth = (req.get("authorization") ?? "").trim();
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1]!.trim() : null;
}
