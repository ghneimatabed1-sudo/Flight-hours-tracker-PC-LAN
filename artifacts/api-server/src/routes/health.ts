import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getActiveInstallProfile } from "../lib/install-profile";
import { API_SERVER_VERSION } from "../version";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({
    status: "ok",
    installProfile: getActiveInstallProfile(),
    // Stamped into the api-server bundle at build time. The dashboard
    // reads this and compares against its own `__APP_VERSION__` so the
    // operator gets a "please refresh" banner the moment the hub is
    // upgraded out from under their cached HTML — see Task #342 /
    // T-E Step 1.
    apiServerVersion: API_SERVER_VERSION,
  });
  res.json(data);
});

export default router;
