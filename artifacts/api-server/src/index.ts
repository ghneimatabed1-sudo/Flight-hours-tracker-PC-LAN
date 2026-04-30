import app from "./app";
import { logger } from "./lib/logger";
import { ensureLanAuthSchema } from "./lib/lan-auth-schema";
import type { Server } from "node:http";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// ── Process-level safety nets ────────────────────────────────────────────
// Without these, any rogue async error (a timer, a third-party callback, a
// fire-and-forget promise) terminates the entire API server and every
// connected PC loses backend access until the process is restarted.
// Node's default for unhandledRejection became "throw" in v15+, which means
// a single missing await in any code path crashes the server. We log loudly
// and keep serving — operational uptime is more important than fail-fast
// for a production rollout where a restart can take minutes.
process.on("unhandledRejection", (reason, promise) => {
  logger.error({ err: reason, promise }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err, origin) => {
  logger.error({ err, origin }, "Uncaught exception");
});

// ── HTTP server with graceful shutdown ───────────────────────────────────
let server: Server | null = null;

(async () => {
  try {
    await ensureLanAuthSchema();
  } catch (err) {
    logger.error({ err }, "Failed to ensure LAN auth schema");
    process.exit(1);
  }
  server = app.listen(port, (err?: Error) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });
})();

// Stop accepting new connections, drain in-flight requests, then exit. The
// 10-second cap prevents a hung socket from blocking shutdown indefinitely
// (which would cause the process supervisor to SIGKILL us anyway).
function shutdown(signal: string): void {
  logger.info({ signal }, "Shutdown signal received, closing server");
  if (!server) {
    process.exit(0);
  }
  const forceExit = setTimeout(() => {
    logger.warn("Forced exit after 10s shutdown timeout");
    process.exit(1);
  }, 10_000);
  forceExit.unref();
  server.close((err) => {
    if (err) {
      logger.error({ err }, "Error during server close");
      process.exit(1);
    }
    logger.info("Server closed cleanly");
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
