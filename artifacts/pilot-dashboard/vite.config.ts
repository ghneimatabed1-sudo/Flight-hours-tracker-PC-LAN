import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import crypto from "crypto";
import { readFileSync } from "fs";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// CSP plugin: in DEV, removes the meta tag entirely so Vite's HMR client
// (which injects inline scripts) keeps working in the iframe preview.
// In PROD build, hashes every inline <script> body in the emitted HTML
// and rewrites the meta tag's script-src directive with the actual hashes
// so the browser executes them. Without this the production app loads
// to a blank screen because the bundle's bootstrap inline scripts get
// blocked. Inline event handlers (onload="...") cannot be hashed —
// remove them or move them into the bundle.
function cspPlugin(): Plugin {
  return {
    name: "rjaf-csp",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        const isDev = process.env.NODE_ENV !== "production";
        if (isDev) {
          // Strip the entire CSP meta tag so HMR/Replit overlays work.
          return html.replace(
            /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>\s*/i,
            "",
          );
        }
        // PROD: collect every inline <script> body, hash it, and inject
        // the list of hashes into script-src.
        const hashes: string[] = [];
        const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(html)) !== null) {
          const body = m[1];
          if (!body.trim()) continue;
          const h = crypto.createHash("sha256").update(body, "utf8").digest("base64");
          hashes.push(`'sha256-${h}'`);
        }
        const tokens = ["'self'", ...hashes].join(" ");
        return html.replace(
          /(script-src)[^;]*;/i,
          `$1 ${tokens};`,
        );
      },
    },
  };
}

// PORT and BASE_PATH are required for the dev/preview server (Replit
// workflow injects them) but irrelevant for `vite build`. We fall back
// to safe defaults so the production installer build (which only needs
// to emit static files into dist/public) works on any Windows CI host.
const rawPort = process.env.PORT ?? "5173";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// For the LAN installer the dashboard is served from "/" by an Express
// host (see installer/HawkEye.iss). For Replit dev BASE_PATH is set by
// the workflow. "/" is the correct fallback for both.
const basePath = process.env.BASE_PATH ?? "/";

/** Dev/preview: proxy same-origin `__hawk_eye_internal_api` → monorepo api-server `/api` (see src/lib/internal-migration.ts). */
const baseNorm = (basePath || "/").replace(/\/$/, "");
const internalApiProxyPath = baseNorm
  ? `${baseNorm}/__hawk_eye_internal_api`
  : "/__hawk_eye_internal_api";
const internalApiProxyTarget =
  process.env.INTERNAL_API_PROXY_TARGET
    ?? (process.env.REPL_ID ? "http://127.0.0.1:8080" : "http://127.0.0.1:3847");
function internalApiProxyRewrite(path: string): string {
  const re = baseNorm
    ? new RegExp(
        `^${baseNorm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/__hawk_eye_internal_api`,
      )
    : /^\/__hawk_eye_internal_api/;
  return path.replace(re, "/api");
}
const internalApiDevProxy = {
  [internalApiProxyPath]: {
    target: internalApiProxyTarget,
    changeOrigin: true,
    rewrite: internalApiProxyRewrite,
  },
} as const;

// Read package.json version once at config time so the runtime error
// reporter (Task #265 Part F) can tag rows with the build version.
const pkgVersion = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "unknown";
  } catch { return "unknown"; }
})();

// Resolve the short git hash at config time so the title bar can show
// exactly which commit a given install was built from. Best-effort —
// returns "nogit" if git isn't available (e.g. building from a tarball).
const gitShortHash = (() => {
  try {
    // Lazy require so test runs that don't have child_process polyfilled
    // (some bundler smoke tests) still load this config.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    return execSync("git rev-parse --short HEAD", {
      cwd: path.resolve(import.meta.dirname, "..", ".."),
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim() || "nogit";
  } catch { return "nogit"; }
})();

export default defineConfig({
  base: basePath,
  define: {
    __APP_VERSION__: JSON.stringify(pkgVersion),
    __GIT_SHORT_HASH__: JSON.stringify(gitShortHash),
  },
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    cspPlugin(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "attached_assets"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
    proxy:
      process.env.NODE_ENV !== "production" ? { ...internalApiDevProxy } : undefined,
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: { ...internalApiDevProxy },
  },
});
