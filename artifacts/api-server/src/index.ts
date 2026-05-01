import { buildApp } from "./app";
import { logger } from "./lib/logger";
import {
  ensureLanAuthSchema,
  ensureLegacyCleanup,
} from "./lib/lan-auth-schema";
import {
  recordInstallProfile,
  resolveInstallProfile,
  setActiveInstallProfile,
  type InstallProfile,
} from "./lib/install-profile";
import {
  installProfileToRole,
  LanDiscoveryService,
  setLanDiscoveryService,
} from "./lib/lan-discovery";
import { makeDnsSdBrowseTransport } from "./lib/lan-discovery-dnssd";
import type { Server } from "node:http";
import os from "node:os";

let profile: InstallProfile;
try {
  profile = resolveInstallProfile();
} catch (err) {
  logger.error({ err }, "Failed to resolve INSTALL_PROFILE");
  process.exit(1);
}

if (profile === "viewer") {
  logger.error(
    { profile },
    "INSTALL_PROFILE=viewer has no backend — install dashboard only. Refusing to start.",
  );
  process.exit(0);
}

setActiveInstallProfile(profile);
logger.info({ profile }, `Hawk Eye api-server starting in '${profile}' mode`);

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

// Process-level safety nets: a single missing await must not tear down
// every connected PC's backend.
process.on("unhandledRejection", (reason, promise) => {
  logger.error({ err: reason, promise }, "Unhandled promise rejection");
});

process.on("uncaughtException", (err, origin) => {
  logger.error({ err, origin }, "Uncaught exception");
});

let server: Server | null = null;

(async () => {
  try {
    await ensureLanAuthSchema();
    await ensureLegacyCleanup();
  } catch (err) {
    logger.error({ err }, "Failed to ensure LAN auth schema");
    process.exit(1);
  }

  try {
    const meta = await recordInstallProfile(profile);
    if (meta.profile !== profile) {
      logger.warn(
        {
          firstBootedProfile: meta.profile,
          firstBootedAt: meta.firstBootedAt,
          currentProfile: profile,
        },
        "Install profile drift detected — first-boot profile is canonical",
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to record install profile metadata");
  }

  const app = buildApp(profile);
  server = app.listen(port, (err?: Error) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port, profile }, "Server listening");
  });

  // Start LAN auto-discovery (Task T-R). The dns-sd transport is
  // best-effort: if dns-sd.exe isn't on PATH (e.g. someone uninstalled
  // Bonjour) it logs a warning and the discovery service simply
  // reports an empty peer list. We disable the loop entirely on
  // explicit opt-out (HAWK_LAN_DISCOVERY=off) so air-gapped sites
  // that block multicast never spawn the child process at all.
  const discoveryMode = (process.env.HAWK_LAN_DISCOVERY ?? "").trim().toLowerCase();
  if (discoveryMode !== "off" && discoveryMode !== "0" && discoveryMode !== "false") {
    try {
      const role = installProfileToRole(profile);
      const txt: Record<string, string> = {
        role,
        hostname: os.hostname(),
        version: process.env.npm_package_version ?? "",
        squadron: process.env.SQUADRON_NAME ?? "",
        wing: process.env.WING_NAME ?? "",
        base: process.env.BASE_NAME ?? "",
      };
      const svc = new LanDiscoveryService({
        selfHostname: os.hostname(),
        selfRole: role,
        selfPort: port,
        selfTxt: txt,
        transport: makeDnsSdBrowseTransport(),
        logger: {
          warn: (...args) => logger.warn(...(args as [unknown])),
          info: (...args) => logger.info(...(args as [unknown])),
        },
      });
      await svc.start();
      setLanDiscoveryService(svc);
      logger.info({ role }, "lan-discovery started");
    } catch (err) {
      logger.warn({ err }, "lan-discovery failed to start; continuing without it");
    }
  } else {
    logger.info("lan-discovery disabled via HAWK_LAN_DISCOVERY env");
  }
})();

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
