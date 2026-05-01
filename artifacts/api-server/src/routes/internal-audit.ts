import {
  Router,
  type IRouter,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";

import {
  recordOpAuditEvent,
  validateOpAuditEvent,
  type OpAuditEvent,
  type OpAuditOutcome,
} from "../lib/audit-log";
import { internalSessionAuthMode } from "../lib/lan-auth-config";
import { requireInternalLanSession } from "../lib/lan-auth-middleware";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";
import {
  getSystemIdentityHeaderName,
  verifySystemIdentityToken,
} from "../lib/system-identity";

/**
 * `POST /audit/op-event`
 *
 * Single ingress point for op-audit rows. Two callers in production:
 *
 *   1. The release-verify runner (`scripts/src/release-verify.mjs`)
 *      posts one row per run with the full report JSON in `details`.
 *      It authenticates with the system-identity header.
 *   2. The verify-backup PowerShell scheduled task
 *      (`scripts/lan-host/verify-backup.ps1`) posts at end-of-run.
 *      Same auth.
 *
 * Authorisation tiers (any one is sufficient):
 *
 *   a. The caller has a logged-in LAN session with role `super_admin`
 *      — covers the rare "super_admin manually retries from a shell"
 *      case and the in-process tests.
 *   b. The caller presents a valid `x-hawk-system-identity` header —
 *      covers the non-human PowerShell scripts.
 *
 * Anything else → 403. We deliberately do NOT honour the looser
 * `INTERNAL_WRITE_SECRET` here so a generic LAN-write capability
 * cannot forge attribution-bearing op-audit rows.
 *
 * IMPORTANT — middleware composition:
 *   This router is mounted on the `/api/internal/*` tree, which is
 *   gated globally by `requireInternalLanSession` so anonymous LAN
 *   clients can't reach internal CRUD. But the system-identity caller
 *   (verify-backup scheduled task, release-verify) does NOT have a
 *   LAN session — it would be rejected with 401 before this handler
 *   ever runs. To keep both auth modes working without weakening the
 *   blanket guard for every other internal route, this router is
 *   mounted ahead of `requireInternalLanSession` in `routes/index.ts`
 *   and runs the session check itself ONLY when there is no valid
 *   system-identity header.
 */

const router: IRouter = Router();

const OpEventSchema = z.object({
  event_type: z.string().min(1).max(120),
  actor_user_id: z.string().max(120).nullish(),
  actor_username: z.string().max(120).nullish(),
  outcome: z.enum(["success", "failure", "partial"]),
  summary: z.string().min(1).max(1000),
  details: z.record(z.unknown()).nullish(),
  evidence_path: z.string().max(2000).nullish(),
});

async function handleOpEvent(
  req: Request,
  res: Response,
  next: NextFunction,
  authCtx: { tokenOk: boolean; sessionOk: boolean },
): Promise<void> {
  try {
    const u = readLanUser(req);
    const role = normalizeLanRole(u?.role);
    const sessionAuthOff = internalSessionAuthMode() === "off";
    // When session auth is OFF we accept any session-attached request
    // as effectively super_admin (mirrors the rest of /api/internal/*).
    // When it is ON, we require either a valid system-identity token OR
    // a real super_admin role.
    const sessionRoleOk = sessionAuthOff || role === "super_admin";
    if (!authCtx.tokenOk && !sessionRoleOk) {
      res
        .status(403)
        .json({ ok: false, error: "system_identity_or_super_admin_required" });
      return;
    }

    const parsed = OpEventSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "invalid_op_event_payload" });
      return;
    }

    const ev: OpAuditEvent = {
      event_type: parsed.data.event_type,
      actor_user_id: parsed.data.actor_user_id ?? u?.user_id ?? null,
      // When a real LAN session is present, force-stamp its username
      // so a misbehaving script can't impersonate a human operator.
      actor_username:
        sessionRoleOk && !sessionAuthOff && u?.username
          ? u.username
          : (parsed.data.actor_username ??
            (authCtx.tokenOk ? "system" : null)),
      outcome: parsed.data.outcome as OpAuditOutcome,
      summary: parsed.data.summary,
      details: parsed.data.details ?? undefined,
      evidence_path: parsed.data.evidence_path ?? null,
    };

    const validationError = validateOpAuditEvent(ev);
    if (validationError) {
      res.status(400).json({ ok: false, error: validationError });
      return;
    }

    await recordOpAuditEvent(ev);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

router.post(
  "/audit/op-event",
  (req: Request, res: Response, next: NextFunction) => {
    const tokenHeader = req.get(getSystemIdentityHeaderName());
    const tokenOk = verifySystemIdentityToken(tokenHeader);
    if (tokenOk) {
      // Token-only callers (verify-backup.ps1, release-verify.mjs)
      // skip session enforcement entirely. The handler still runs the
      // role check before writing.
      void handleOpEvent(req, res, next, { tokenOk: true, sessionOk: false });
      return;
    }
    // No token — defer to the standard LAN-session middleware. If it
    // rejects (401), it has already written the response and we never
    // reach the handler. If it accepts, control falls through into the
    // handler with `req.lanUser` populated.
    requireInternalLanSession(req, res, (err) => {
      if (err) return next(err);
      if (res.headersSent) return;
      void handleOpEvent(req, res, next, {
        tokenOk: false,
        sessionOk: true,
      });
    });
  },
);

export default router;
