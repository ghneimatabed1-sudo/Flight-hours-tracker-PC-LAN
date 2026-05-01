import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { normalizeLanRole, readLanUser } from "../lib/lan-authz";

const router: IRouter = Router();

const SELECT_COLS = `
  s.id::text as id,
  s.number,
  s.name,
  s.base,
  s.wing,
  s.wing_id,
  s.base_id
`;

type Row = {
  id: string;
  number: string;
  name: string;
  base: string;
  wing: string | null;
  wing_id: string | null;
  base_id: string | null;
};

/**
 * Squadron registry mirror, served from the LAN api-server.
 *
 * Returns the same column shape the dashboard expects in
 * `refreshSquadronsFromDb` / `squadronsFromRemoteRows`, plus the
 * authorisation IDs `wing_id` and `base_id` so the admin Users UI
 * can hand real IDs (not display strings) to the create/edit user
 * routes — without these, wing/base commander accounts would carry
 * display names where authorisation expects IDs and read-scope
 * filters would silently match nothing.
 *
 * Read-scope rules (enforced on the squadron row itself, not on
 * pilot/sortie children):
 *
 *  - super_admin / admin       -> see every squadron.
 *  - commander_wing            -> own squadron + every squadron with
 *                                 the same wing_id.
 *  - commander_base            -> own squadron + every squadron with
 *                                 the same base_id.
 *  - ops / commander_squadron  -> own squadron only.
 *  - commander (legacy)        -> own squadron only (fail-closed).
 *  - unknown                   -> empty list.
 *
 * When no LAN user is attached to the request (no-auth lab mode) we
 * return everything, matching the existing wide-open behaviour the
 * dashboard relies on for first-launch bootstrap.
 */
router.get("/squadrons", async (req, res, next) => {
  try {
    const lanUser = readLanUser(req);

    if (!lanUser) {
      const all = await pool.query<Row>(`
        select ${SELECT_COLS}
        from squadrons s
        order by s.name asc
      `);
      res.json({ items: all.rows });
      return;
    }

    const role = normalizeLanRole(lanUser.role);
    if (role === "super_admin" || role === "admin") {
      const all = await pool.query<Row>(`
        select ${SELECT_COLS}
        from squadrons s
        order by s.name asc
      `);
      res.json({ items: all.rows });
      return;
    }

    const sqId = (lanUser.squadron_id ?? "").trim();
    const wingId = (lanUser.wing_id ?? "").trim();
    const baseId = (lanUser.base_id ?? "").trim();

    if (role === "commander_wing") {
      if (!wingId && !sqId) {
        res.json({ items: [] });
        return;
      }
      const q = await pool.query<Row>(
        `
        select ${SELECT_COLS}
        from squadrons s
        where ($1 <> '' and s.wing_id = $1) or s.id::text = $2
        order by s.name asc
        `,
        [wingId, sqId],
      );
      res.json({ items: q.rows });
      return;
    }

    if (role === "commander_base") {
      if (!baseId && !sqId) {
        res.json({ items: [] });
        return;
      }
      const q = await pool.query<Row>(
        `
        select ${SELECT_COLS}
        from squadrons s
        where ($1 <> '' and s.base_id = $1) or s.id::text = $2
        order by s.name asc
        `,
        [baseId, sqId],
      );
      res.json({ items: q.rows });
      return;
    }

    if (role === "ops" || role === "commander_squadron" || role === "commander") {
      if (!sqId) {
        res.json({ items: [] });
        return;
      }
      const q = await pool.query<Row>(
        `
        select ${SELECT_COLS}
        from squadrons s
        where s.id::text = $1
        order by s.name asc
        `,
        [sqId],
      );
      res.json({ items: q.rows });
      return;
    }

    res.json({ items: [] });
  } catch (err) {
    next(err);
  }
});

export default router;
