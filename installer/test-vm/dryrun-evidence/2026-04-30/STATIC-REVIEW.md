# Static review of lan-host installers — 2026-04-30

**Reviewer:** Replit task agent (no Windows hardware available)
**Scope:** every `.ps1` file in `scripts/lan-host/` exercised by
the Squadron Lan Host, Aggregator Hub, and Viewer install flows.
**Method:** read-only code review; no installer was actually
executed. The Replit container is Linux-only, so a real
end-to-end VM dry-run is deferred to the next operator with
Windows access. See the playbook in `installer/test-vm/README.md`.

This document records the bugs that were spottable from code
alone and the fixes applied in the same commit.

---

## Bugs found and fixed

### 1. Postgres password not URL-encoded in connection string

**Files:**
- `scripts/lan-host/first-time-setup.ps1` (was already creating
  `$encPg` for `$appUrl`, but the `.env` write path also needed
  the encoded value — fixed in earlier pass).
- `scripts/lan-host/setup-aggregator.ps1` lines 382, 411 — both
  uses of `$plainPg` in `postgresql://…` strings.
- `scripts/lan-host/add-squadron-peer.ps1` line 100.

**Symptom:** any password containing `@`, `:`, `/`, `#`, `?`, or
`%` produces a malformed `DATABASE_URL`. node-postgres reports
`password authentication failed for user …` even though the
password is correct, because the parser truncates the userinfo
at the first reserved character.

**Fix:** wrap the plaintext password in
`[uri]::EscapeDataString(...)` before interpolation. Original
plaintext is still sent to `psql` via `PGPASSWORD` env var (which
is not URL-parsed) so the bootstrap commands continue to work.

### 2. Fixed `Start-Sleep` waits race the api-server startup

**Files:**
- `scripts/lan-host/first-time-setup.ps1` Step 6b (was 6 s).
- `scripts/lan-host/setup-aggregator.ps1` Step 8b (was 8 s).
- `scripts/lan-host/setup-aggregator.ps1` Step 13 (was 6 s).

**Symptom:** on slower hardware (laptops with HDDs, contested
CPUs, AV scanning) `ensureFullSchema` takes >10 s the first time.
The installer kills the api-server process before the schema is
created, leaving partial tables and a confusing "schema
bootstrap completed" log message.

**Fix:** poll `http://127.0.0.1:<ApiPort>/api/healthz` once a
second for up to 30 s. Only then stop the process. If healthz
never returns 200, log a clear warning instead of pretending it
worked.

### 3. Scheduled task install never verified the SYSTEM-context
boot path

**Files:**
- `scripts/lan-host/first-time-setup.ps1` Step 10.
- `scripts/lan-host/setup-aggregator.ps1` Step 12.

**Symptom:** `install-api-startup-task.ps1` registers a task
that runs as `NT AUTHORITY\SYSTEM`. The most common Windows-only
failure is that node and pnpm were installed via the
"Just for me" option (Chocolatey, fnm, nvm, the standalone
.zip, etc.), which puts them on the *user* PATH only. SYSTEM
cannot find them, the task silently exits, and nothing happens
until the operator reboots and notices the dashboard is dead.

**Fix:** after registering the task, immediately call
`schtasks /Run /TN HawkEye-ApiServer-OnStartup` and poll
`/api/healthz` for 45 s. On success, stop the test run via
`schtasks /End` (the real boot will fire it again). On failure,
warn the operator with the most likely root cause and a
diagnostic command.

### 4. Aggregator dashboard CSP blocks the local API origin

**File:** `scripts/lan-host/setup-aggregator.ps1` Step 11.

**Symptom:** the bundled `dist/public/index.html` ships with a
`Content-Security-Policy` meta tag whose `connect-src` only
allows the Supabase + replit.app origins from cloud builds.
On an aggregator PC the dashboard talks to
`http://<LanHostName>:3847`, which is not on that list, so every
fetch is blocked and the dashboard renders empty. The viewer
installer (`setup-viewer.ps1`) already had a `Update-DashboardCsp`
helper for the same reason; the aggregator install just never
called the equivalent.

**Fix:** after `pnpm run build` succeeds, regex-patch the
`connect-src` directive to include both the HTTP origin
(`$baseUrl`) and the matching WebSocket origin (`ws://...`).
Idempotent — re-running the installer is safe.

### 5. Viewer launcher fails with HRESULT 5 on non-admin desktops

**Files:**
- `scripts/lan-host/setup-viewer.ps1` (new Step 5b).
- `scripts/lan-host/launch-viewer.ps1` lines 140-150.

**Symptom:** `System.Net.HttpListener.Start()` fails with
`HttpListenerException` ErrorCode 5 (Access Denied) on Windows
when the calling user has no URL ACL reservation for the prefix.
The desktop shortcut runs as a normal user, so every launch
crashes. Worse, the launcher displayed a generic "port busy"
message that misled operators into looking for the wrong fix.

**Fix:**
- `setup-viewer.ps1` Step 5b reserves
  `http://127.0.0.1:<LocalPort>/` for `BUILTIN\Users` via
  `netsh http add urlacl …` while the elevated install shell is
  still active. Idempotent: deletes any prior reservation first.
- `launch-viewer.ps1` now inspects the `HttpListenerException`
  ErrorCode and shows the right MessageBox: HRESULT 5 →
  "needs URL permission" with the exact `netsh` command, 32/183
  → "port busy", anything else → generic with the inner
  exception text.

---

## Bugs not fixed in this pass (documented for next operator)

### A. mDNS broadcast (`dns-sd.exe`) does not auto-restart — FIXED in Task #393

If the foreground `dns-sd.exe -R …` process died (OOM, manual
kill, console session close), peers stopped seeing this host and
the only fix was a manual restart.

**Fix:** introduced `scripts/lan-host/mdns-supervisor.ps1`, a
PowerShell watchdog loop that spawns `dns-sd.exe`, waits for it,
and respawns it within 5s on any exit (capped at 60s on repeated
rapid failures, reset to 5s after a run that lasts >=60s). The
`HawkEye-Mdns-OnStartup` scheduled task now invokes the supervisor
instead of `dns-sd.exe` directly. The supervisor writes a heartbeat
file at `%PROGRAMDATA%\HawkEye\mdns-supervisor.heartbeat` every 15s
and a rolling log at `%PROGRAMDATA%\HawkEye\mdns-supervisor.log`.
Operators can run `scripts/lan-host/check-mdns-health.ps1` to
verify the broadcast is alive without RDP'ing into the host
(exit 0 = alive, 1 = never installed, 2 = supervisor died, 3 =
between restarts). VM dry-run still deferred — see playbook.

### B. PowerShell 5.1 `schtasks /TR` quoting

When the repo path contains spaces, the quoting in
`install-api-startup-task.ps1` works in PS 7 but PS 5.1 mangles
embedded quotes in some Windows builds. The current code uses
backtick-escaped doublequotes which appears correct, but only a
real install on a path like `C:\Program Files\Hawk Eye\...` will
prove it. Listed as an explicit verification step in the
playbook.

### C. Out-of-band postgres role pre-existence

If a previous Hawk Eye install left a `hawk_app` postgres role
behind, the install script `CREATE ROLE` fails. There is logic
to detect this, but it has never been exercised end-to-end on
real hardware. Listed in playbook.

---

## Verification status of each script

| File                              | Static review | VM dry-run |
|-----------------------------------|---------------|------------|
| first-time-setup.ps1              | DONE          | DEFERRED   |
| setup-aggregator.ps1              | DONE          | DEFERRED   |
| aggregator-first-time-setup.ps1   | DONE (alt UI) | DEFERRED   |
| setup-viewer.ps1                  | DONE          | DEFERRED   |
| launch-viewer.ps1                 | DONE          | DEFERRED   |
| add-squadron-peer.ps1             | DONE          | DEFERRED   |
| install-api-startup-task.ps1      | DONE          | DEFERRED   |
| install-dashboard-startup-task.ps1| DONE          | DEFERRED   |
| install-backup-task.ps1           | DONE          | DEFERRED   |
| start-api-host.ps1                | DONE          | DEFERRED   |
| register-mdns.ps1                 | DONE          | DEFERRED   |

`DEFERRED` = the linux container has no PowerShell runtime, so
the script could not be executed. See `installer/test-vm/README.md`
for how to clear these once Windows access is available.
