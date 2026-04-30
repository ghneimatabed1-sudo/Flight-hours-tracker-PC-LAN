# Step 3 — Internal API kickoff (compatibility path)

**Status:** Done (scaffold + operator-visible health check; Supabase remains the live backend).

## Goal

Prove the monorepo **`artifacts/api-server`** Express app is reachable on the same machine or LAN as the dashboard **before** replacing PostgREST/Auth. This step does **not** move operational data off Supabase.

## What was added

| Piece | Purpose |
|--------|--------|
| [`artifacts/pilot-dashboard/src/lib/internal-migration.ts`](../../artifacts/pilot-dashboard/src/lib/internal-migration.ts) | Resolves `GET /api/healthz` URL; `fetchInternalApiHealth()` for diagnostics. |
| [`artifacts/pilot-dashboard/vite.config.ts`](../../artifacts/pilot-dashboard/vite.config.ts) | **Dev / preview:** proxy `…/__hawk_eye_internal_api` → `INTERNAL_API_PROXY_TARGET` (default `http://127.0.0.1:3847`) with path rewrite to `/api`. Respects `BASE_PATH`. |
| **Connection Diagnostic** | When a check URL exists, shows **Internal API (LAN migration)** with pass/fail and latency. |

## Environment variables

| Variable | Where | Meaning |
|----------|--------|--------|
| `INTERNAL_API_PROXY_TARGET` | Vite (dev) | Upstream for the internal API proxy. Default: `http://127.0.0.1:3847`. |
| `VITE_INTERNAL_API_URL` | Dashboard build | Optional **full base** for the internal API (no trailing slash required), e.g. `http://hawk-api.mil.internal:3847`. When set, health checks use `{base}/api/healthz` **directly** (no Vite proxy). **Production / Electron:** add that origin to **`connect-src`** in [`index.html`](../../artifacts/pilot-dashboard/index.html) (or terminate TLS / same-origin via a reverse proxy) or the browser will block `fetch`. |
| `PORT` | `api-server` | Listen port (required by `api-server`’s `index.ts`). |
| `PORT`, `BASE_PATH` | `pilot-dashboard` Vite | Unchanged; required to run the dev server. |

## Quick verify (two terminals)

**Terminal A — API (default target port 3847):**

```bash
# From repo root; Windows cmd: set PORT=3847
set PORT=3847
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/api-server run start
```

**Terminal B — Dashboard dev** (use the same `PORT` / `BASE_PATH` your project already uses, e.g. from Replit or local `.env`):

```bash
set PORT=5000
set BASE_PATH=/
pnpm --filter @workspace/pilot-dashboard run dev
```

Open **Settings → Connection Diagnostic** (or your route to `Diagnostic`). With the API up, the **Internal API** card should show **OK** and a round-trip time. If the API is down, you see an error (expected).

## CSP note (production)

Dev mode **strips** the CSP meta tag (see Vite `cspPlugin`) so the proxy works without listing `127.0.0.1`. For a **packaged** build that sets `VITE_INTERNAL_API_URL` to an internal `http://` host, **extend** the `connect-src` directive in `index.html` to include that host (or use HTTPS + internal CA and add the exact origin). This is a deliberate build-time or deploy-time step for each airbase.

## Next in the program (per master plan)

Wire real routes and session compatibility on `api-server`, then database rules and client swap — see the Cursor plan *Internal-Only Migration Parity* (steps after Step 3).
