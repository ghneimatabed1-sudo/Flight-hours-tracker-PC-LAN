import { Router, type IRouter } from "express";
import aggregatePeersRouter from "./aggregate-peers";
import aggregateDataRouter from "./aggregate-data";

/**
 * Aggregator-mode router. Mounted at `/api/aggregate` for both the
 * Wing and Base Commander install profiles.
 *
 * Surface:
 *   - `/api/aggregate/peers*`            — address-book CRUD + health
 *   - `/api/aggregate/pilots`            — fan-out reads
 *   - `/api/aggregate/sorties`
 *   - `/api/aggregate/leaves`
 *   - `/api/aggregate/unavailable`
 *   - `/api/aggregate/notams`
 *   - `/api/aggregate/readiness-summary`
 *
 * Aggregator profiles deliberately do NOT mount `/api/internal/*`
 * data routes — no local squadron data lives on a Wing/Base PC. All
 * reads here come from peers via `/api/peer/*`.
 */
const router: IRouter = Router();

router.use(aggregatePeersRouter);
router.use(aggregateDataRouter);

router.use((_req, res) => {
  res.status(404).json({ error: "not_found", surface: "aggregate" });
});

export default router;
