import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { KEY_GENERATOR_HTML } from "./key-generator-html";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        // Defensive: req.url should always be a string but a malformed
        // proxy / probe could send something exotic. Never let logging
        // itself throw — that would tear down the request lifecycle.
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
// Cap body sizes so a malicious / buggy client cannot exhaust memory.
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

app.use("/api", router);

app.get("/key-generator", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(KEY_GENERATOR_HTML);
});

// Catch-all 404 for unknown paths so misconfigured clients get a clean
// JSON response instead of Express's default HTML.
app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: req.path });
});

// Global error handler. Express 5 forwards thrown / rejected handler
// errors here; without this, the response would be Express's default
// HTML error page and the error would not be logged consistently.
// The 4-arg signature is required for Express to recognise it as an
// error middleware.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const reqLogger = (req as Request & { log?: typeof logger }).log ?? logger;
  reqLogger.error({ err, path: req.path, method: req.method }, "Request handler error");
  if (res.headersSent) {
    // Headers already flushed — connection will be torn down by Express.
    return;
  }
  const message = err instanceof Error ? err.message : "internal_error";
  res.status(500).json({ error: "internal_error", message });
});

export default app;
