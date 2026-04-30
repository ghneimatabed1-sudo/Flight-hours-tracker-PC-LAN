# LAN Multi-PC Quickstart (IT + Operator)

Use this when IT has finished cabling/switching and your base server is reachable on LAN.

## 1) Pick one stable internal API address

- Use one URL that every PC can reach, for example:
  - `http://10.10.8.20:3847`
  - `http://hawk-api.local:3847` (preferred if internal DNS is available)
- Do not use `localhost` for other PCs.

## 2) Configure and run the LAN API server

- Copy `artifacts/api-server/.env.lan.example` to `.env` (or your service manager env).
- Set at least:
  - `DATABASE_URL`
  - `HAWK_INTERNAL_SESSION_AUTH=required` (recommended for real operation)
  - `HAWK_LAN_BOOTSTRAP_TOKEN` (first admin bootstrap)
- Keep `HAWK_LAN_DEV_NO_AUTH=0` for production use.
- Optional host helper:
  - `pnpm run lan:host:setup-env -- -DatabaseUrl "postgresql://USER:PASS@HOST:5432/DB" -BootstrapToken "CHANGE_ME_SECRET"`
- Start API server on the base machine:
  - `powershell -ExecutionPolicy Bypass -File .\scripts\lan-host\start-api-host.ps1`
  - (or manually: `pnpm --filter @workspace/api-server run build` then `start`)

## 3) Configure each dashboard PC build/install

- Copy `artifacts/pilot-dashboard/.env.lan.example` to `.env`.
- Set:
  - `VITE_LAN_SESSION_LOGIN=1`
  - `VITE_INTERNAL_API_URL=http://<your-server>:3847`
  - `VITE_LAN_NO_AUTH=0` (recommended for real operation)
- Install/start app on each PC with the same API URL.
- Optional helper per client PC:
  - `powershell -ExecutionPolicy Bypass -File .\scripts\lan-host\setup-dashboard-lan-env.ps1 -ApiBaseUrl "http://<your-server>:3847"`

## 4) First-time bootstrap and login

- On first PC, open app and create first LAN admin via bootstrap flow (uses `HAWK_LAN_BOOTSTRAP_TOKEN`).
- Then create required ops/deputy users from app users page.
- Sign in from each PC against the same LAN API server.

## 5) Verify PC-to-PC connectivity in app

- Open Connection Diagnostic and verify internal API health is green.
- Optional CLI health probe: `powershell -ExecutionPolicy Bypass -File .\scripts\lan-host\check-host-health.ps1 -ApiBaseUrl "http://<server-ip>:3847"`
- Confirm roster/sorties entered on PC-A appear on PC-B.
- Confirm cross-PC surfaces (messages/schedule chain/pending) update across PCs.

## 6) Recommended go-live toggles

- `HAWK_INTERNAL_SESSION_AUTH=required`
- `HAWK_LAN_DEV_NO_AUTH=0`
- `VITE_LAN_NO_AUTH=0`

## 7) If something is not syncing

- Confirm all PCs point to the exact same `VITE_INTERNAL_API_URL`.
- Confirm API server can connect to Postgres (`DATABASE_URL`).
- Confirm firewall allows API port (default `3847`) from all squadron PCs.
- Confirm no PC is still running an older cloud-configured build.
- See `docs/internal-migration/SQUADRON-HOST-KIT.md` for single-host deployment + backup steps.
