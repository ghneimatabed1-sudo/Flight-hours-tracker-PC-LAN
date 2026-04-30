# Squadron Host Kit (single LAN host)

Use this when one machine (cabin host or Ops PC) is the mini server for one squadron.

## Target layout

- One always-on host machine on LAN (`192.168.x.x` or internal DNS name).
- Host runs:
  - Postgres
  - Hawk Eye internal API (`api-server`)
- All squadron PCs (Ops, commander, others) run dashboard client and point to the same host API URL.

## 1) Host machine prerequisites

- Windows machine on stable LAN, static IP recommended.
- Node + pnpm installed.
- PostgreSQL installed (with `pg_dump` available on PATH for backups).
- Repo cloned on host machine.

## 2) Host API configuration

1. Copy:
   - `artifacts/api-server/.env.lan.example` -> `artifacts/api-server/.env`
2. Set required values in `.env`:
   - `DATABASE_URL`
   - `HAWK_INTERNAL_SESSION_AUTH=required`
   - `HAWK_LAN_BOOTSTRAP_TOKEN`
   - `HAWK_LAN_DEV_NO_AUTH=0` (for real operation)

Optional helper (writes API `.env` in one command):

```powershell
pnpm run lan:host:setup-env -- -DatabaseUrl "postgresql://USER:PASS@HOST:5432/DB" -BootstrapToken "CHANGE_ME_SECRET"
```

## 3) Start the host API

Run preflight once first:

```powershell
pnpm run lan:host:preflight
```

From repo root on host machine:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\lan-host\start-api-host.ps1
```

Or via root script:

```powershell
pnpm run lan:host:start
```

If you already built once and only want to restart quickly:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\lan-host\start-api-host.ps1 -SkipBuild
```

## 4) Verify host health

On host or any client PC:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\lan-host\check-host-health.ps1 -ApiBaseUrl "http://<host-ip>:3847"
```

Expected result: JSON with `ok: true`.

## 5) Configure each client PC

1. Copy:
   - `artifacts/pilot-dashboard/.env.lan.example` -> `artifacts/pilot-dashboard/.env`
2. Set:
   - `VITE_LAN_SESSION_LOGIN=1`
   - `VITE_INTERNAL_API_URL=http://<host-ip>:3847`
   - `VITE_LAN_NO_AUTH=0`
3. Install/run the dashboard app on each PC.

Optional helper (writes dashboard `.env` in one command):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\lan-host\setup-dashboard-lan-env.ps1 -ApiBaseUrl "http://<host-ip>:3847"
```

Or:

```powershell
pnpm run lan:client:setup-env -- -ApiBaseUrl "http://<host-ip>:3847"
```

## 6) First-user bootstrap

- On first client login against fresh host DB, use LAN bootstrap flow with `HAWK_LAN_BOOTSTRAP_TOKEN`.
- Then create normal LAN users (ops/deputy/admin as required).

## 7) Daily backup (host machine)

Run manual backup:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\lan-host\backup-postgres.ps1
```

Backups are saved to:
- `artifacts/api-server/backups/*.dump`

Retention defaults to 14 days (override with `-RetentionDays`).

Install scheduled daily backup task (run PowerShell as Administrator):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\lan-host\install-backup-task.ps1 -RunAt "02:30" -RetentionDays 14
```

Manual restore (disaster recovery):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\lan-host\restore-postgres.ps1 -BackupFile ".\artifacts\api-server\backups\hawk-eye-lan-YYYYMMDD-HHMMSS.dump" -DropAndRecreate
```

## 8) Auto-start API on host boot

Install startup task (run PowerShell as Administrator):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\lan-host\install-api-startup-task.ps1
```

## 9) Pilot test checklist (one squadron)

- Login works from all PCs.
- Add sortie on PC-A appears on PC-B.
- Commander pages read squadron data correctly.
- Messages/schedule chain/pending approvals sync across PCs.
- Audit page shows internal events.
- Host restart recovery works (clients recover after API returns).

## 10) Expansion model

- Repeat same client setup for more PCs on same squadron host.
- For multi-squadron + wing visibility, prefer one shared backend host for all participating squadrons (role/scope in app controls visibility).

## 11) Final verification command

Before pilot sign-off, run:

```powershell
pnpm run lan:pilot:verify
```
