import type { RequestHandler } from "express";

/**
 * When `INTERNAL_WRITE_SECRET` is set on the server, every internal write
 * must send matching header `x-hawk-internal-write`. When unset, LAN-lab
 * installs may leave writes open (not for exposure to the public internet).
 */
export const requireInternalWriteSecret: RequestHandler = (req, res, next) => {
  const secret = process.env.INTERNAL_WRITE_SECRET?.trim();
  if (!secret) {
    next();
    return;
  }
  if (req.get("x-hawk-internal-write") !== secret) {
    res.status(403).json({ error: "internal_write_forbidden" });
    return;
  }
  next();
};
