import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { buildRouter } from "./routes";
import { logger } from "./lib/logger";
import { KEY_GENERATOR_HTML } from "./key-generator-html";
import {
  setActiveInstallProfile,
  type InstallProfile,
} from "./lib/install-profile";

/**
 * Build the Express app for the given install profile. Pinning the
 * active profile here keeps `/api/healthz` honest no matter which
 * caller constructs the app.
 */
export function buildApp(profile: InstallProfile): Express {
  setActiveInstallProfile(profile);
  const app: Express = express();

  app.use(
    pinoHttp({
      logger,
      serializers: {
        req(req) {
          // Defensive: never let logging itself throw on a malformed url.
          let path: string | undefined;
          try {
            path = typeof req.url === "string" ? req.url.split("?")[0] : undefined;
          } catch {
            path = undefined;
          }
          return {
            id: req.id,
            method: req.method,
            url: path,
          };
        },
        res(res) {
          return {
            statusCode: res.statusCode,
          };
        },
      },
    }),
  );
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));

  app.use("/api", buildRouter(profile));

  app.get("/key-generator", (_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.send(KEY_GENERATOR_HTML);
  });

  app.use((req, res) => {
    res.status(404).json({ error: "not_found", path: req.path });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const reqLogger = (req as Request & { log?: typeof logger }).log ?? logger;
    reqLogger.error({ err, path: req.path, method: req.method }, "Request handler error");
    if (res.headersSent) {
      return;
    }
    const message = err instanceof Error ? err.message : "internal_error";
    res.status(500).json({ error: "internal_error", message });
  });

  return app;
}
