# Real-Windows VM dry-run playbook

This folder is for the next operator who has access to actual
Windows hardware (or a real Windows VM with PowerShell 5.1+).

The Replit container that built Hawk Eye is Linux-only, so the
PowerShell installers in `scripts/lan-host/` cannot be executed
end-to-end here. The bug fixes in commit accompanying this file
were derived from a static code review only — see
`dryrun-evidence/2026-04-30/STATIC-REVIEW.md`.

When you actually run the install on bare metal, please follow
the steps below and drop screenshots + logs into a new dated
folder under `dryrun-evidence/`.

---

## Prerequisites on the test machine

- Windows 10 22H2 or Windows 11 23H2 (clean snapshot strongly
  recommended — the installer makes machine-wide changes:
  hostname, scheduled tasks, firewall rules, postgres role,
  netsh URL ACLs).
- 8 GB RAM minimum, 30 GB free disk.
- Local administrator account.
- No prior PostgreSQL install (the installer probes for it but a
  pre-existing install hides class-of-bugs we need to catch).

Take a VM snapshot named `pre-install` before each role.

## Roles to dry-run (run each on its own snapshot)

1. **Squadron Lan Host** — `scripts/lan-host/first-time-setup.ps1`
2. **Aggregator Hub** — `scripts/lan-host/setup-aggregator.ps1`
3. **Viewer / Kiosk PC** — `scripts/lan-host/setup-viewer.ps1`
4. **Add-peer flow** — `scripts/lan-host/add-squadron-peer.ps1`
   (run this ON the aggregator after role 2)

For each role: revert to `pre-install`, run the installer in an
elevated PowerShell, capture the full transcript, then reboot
once and verify the auto-start tasks fire.

## What to capture per role

Drop these files into `dryrun-evidence/<YYYY-MM-DD>/<role>/`:

- `transcript.txt` — `Start-Transcript` output of the install run.
- `01-first-boot.png` — Desktop + Task Scheduler view after the
  fresh-snapshot reboot, showing `HawkEye-ApiServer-OnStartup`
  in `Ready` state.
- `02-healthz.png` — Browser at `http://127.0.0.1:3847/api/healthz`
  returning 200.
- `03-dashboard.png` — Dashboard rendering at the LAN host name.
- `04-task-history.png` — Task Scheduler → History tab for the
  startup task, proving SYSTEM context launched node successfully.
- `schtasks.txt` — `schtasks /Query /FO LIST /V /TN HawkEye-*`
- `netstat.txt` — `netstat -ano | findstr LISTENING`
- `eventvwr-app.evtx` — Application event log export from the
  install hour (catches Postgres / scheduled task errors the
  console misses).

## Specific things the static review could not verify — please
exercise these explicitly

1. **postgres password with reserved chars.** When prompted,
   type a password that contains `@`, `:`, `#` and `%` (for
   example: `Re@l:Pa#s%word!`). Confirm the api-server connects
   on first boot. Pre-fix this would silently produce
   `password authentication failed`.
2. **Scheduled task in SYSTEM context.** After install, reboot
   and confirm the api-server is reachable on `:3847` BEFORE you
   log in. (RDP into the box without logging in to the console
   user, if possible.) The Step 10 verifier in the installer now
   triggers this at install time, but a real boot is the truth.
3. **Viewer URL ACL.** Log in as a non-admin user on the viewer
   PC and double-click the desktop shortcut. Pre-fix this
   crashed with HRESULT 5; the installer now reserves the ACL
   for `BUILTIN\Users` in Step 5b. If it still fails, capture
   the popup.
4. **Aggregator dashboard CSP.** Open the dashboard in Chrome,
   open DevTools → Console, and confirm there are no
   `Refused to connect because it violates the following
   Content Security Policy directive: "connect-src ..."`
   warnings pointing at the aggregator host name.
5. **Add-peer with reserved-char password.** If the aggregator
   was set up without a stored DATABASE_URL, the add-peer
   wizard prompts for the postgres password. Type one with `@`
   and `#`. Confirm the peer row lands in `peer_squadrons`.
6. **mDNS broadcast survival.** `dns-sd.exe` is now wrapped by
   `mdns-supervisor.ps1` (Task #393). On the host, kill the
   `dns-sd.exe` process and confirm:
   - within ~5s a fresh `dns-sd.exe` PID appears in Task Manager,
   - `scripts\lan-host\check-mdns-health.ps1` returns exit 0 with
     `state: running` and a non-zero `restartCount`,
   - `%PROGRAMDATA%\HawkEye\mdns-supervisor.log` contains a
     `dns-sd.exe pid=… exited code=… — restarting in 5s` line,
   - peers continue to resolve `<squadron>.local`.
   Then end the supervisor's scheduled task
   (`schtasks /End /TN HawkEye-Mdns-OnStartup`), confirm
   `check-mdns-health.ps1` eventually returns exit 2 (stale
   heartbeat), and re-register via `register-mdns.ps1` to verify
   recovery is one command.

## Known PowerShell 5.1 quirks worth eyeballing

- `schtasks /TR` quoting: confirm the registered command in the
  Task Scheduler GUI shows `powershell.exe -File "C:\...\start-api-host.ps1"`
  with quotes intact even when the path has a space.
- `Read-Host -AsSecureString` masks input differently in Windows
  Terminal vs `conhost.exe`. Try both.
- `Out-File -Encoding ASCII` (used for `.env`) writes CRLF on
  Windows. node reads this fine, but verify no BOM crept in.

## After the dry-run

1. Fill out `dryrun-evidence/<date>/SUMMARY.md` with one section
   per role: `PASSED`, `PASSED-WITH-NOTES`, or `FAILED-NEEDS-CODE-FIX`.
2. For each `FAILED-NEEDS-CODE-FIX`, open a follow-up task with
   the transcript line numbers + screenshot.
3. Append a short note to `OPERATOR-RUNBOOK.md` Appendix
   "Visual install walkthrough" linking the screenshots so the
   field operators have a known-good reference.

---

## Pass 2 (2026-04-30) — extra checks deferred from static review

A second deeper static review was done on 2026-04-30; see
`dryrun-evidence/2026-04-30/STATIC-REVIEW-DEEP.md`. It found two
fixable bugs (applied in the same commit) and ten observations
that need real Windows time to resolve. Please add the following
checks to your dryrun checklist on top of what's listed above —
they target the .exe-driven install path specifically, which the
prior playbook only covered through the inner `.ps1` scripts:

### .exe-driven install (the path operators actually take)

For each role, in addition to running the inner `.ps1` directly:

- **First**, build the installer per `installer/test-vm/BUILD-HOST-README.md`.
  Drop `iscc-output.log` and `iscc-output.sha256` into
  `dryrun-evidence/<date>/build-host/`.
- **Then** double-click `HawkEye-Setup.exe` on the test VM,
  capture the SmartScreen + UAC dialogs (`00-smartscreen.png`,
  `00-uac.png`), and pick the role.
- After install, capture `<install dir>\install-log.txt` (this
  is the per-install log the shim writes; it includes the inner
  `.ps1` transcript). Save as `install-log.txt` next to the
  screenshots. **Without this file the dryrun is not reproducible
  — the inner .ps1 doesn't write to its own log when invoked
  through the shim.**

### Hub-role-specific extra checks (deferred from STATIC-REVIEW-DEEP)

- **B1 — desktop-shortcut "Hawk Eye Dashboard" target.** Click
  the shortcut after install. Expected: dashboard renders.
  Suspected actual: 404 / "site can't be reached" because the
  Hub does not currently install a dashboard scheduled task and
  the .env never sets `VITE_DASHBOARD_PORT`. File outcome.
- **B7 — `Read-Host -AsSecureString` over redirected stdin.**
  Use a clean Windows 11 22H2 image with NO Windows Updates
  applied. If install hangs at "Setting up squadron hub…", read
  `install-log.txt` for the last `[STEP N]` line — if it ends
  before STEP 3, file as B7.
- **A1 (verification)** — run the install with postgres password
  `Re@l:Pa#s%word!`. After install, sign in to the dashboard
  with the super_admin you set. Then **uninstall** via Settings →
  Apps → Hawk Eye → Uninstall, watch the uninstall log, and
  confirm the database was actually dropped (run `psql -U postgres
  -c "\l"` after).

### Aggregator-role-specific extra checks

- **B2 — `open-dashboard.cmd` hardcodes 5173.** Open the
  generated `installer\open-dashboard.cmd` and confirm the
  hardcoded port matches whatever the dashboard actually listens
  on after a reboot (should be 5173).
- **B3 — dashboard scheduled task missing.** After install,
  reboot, then BEFORE opening anything else run:
  ```powershell
  schtasks /Query /FO LIST /V /TN HawkEye-Dashboard-OnStartup
  ```
  Expected (per shim contract): task exists. Suspected actual:
  "ERROR: The system cannot find the file specified."
- **A1 + A2 (verification)** — same reserved-char password run
  as the Hub, confirms encoding survives both the installer
  shim's stdin pipe AND the inner script's `DATABASE_URL`
  composition.

### Cross-role extra checks

- **B4 — install path with `'`.** Pick install location
  `D:\O'Brien Squadron\HawkEye` (operator types it in the wizard's
  Destination Folder page). Expected (per code): inner powershell
  exits with parser error. If install proceeds normally, B4 isn't
  a real bug. Either way, file the outcome.
- **B10 — install path with space.** Pick `C:\Program Files\Hawk Eye Test\`.
  Then open Task Scheduler → HawkEye-ApiServer-OnStartup →
  Actions and screenshot the Action's command line. Quote
  integrity is what we're checking.

### Code-signing dry-run

`installer/CODE-SIGNING-DECISION.md` documents that we ship
unsigned. Capture two screenshots on a fresh internet-connected
Windows VM:
- `00-smartscreen-blocked.png` — the blue SmartScreen panel
  before clicking "More info".
- `00-smartscreen-runanyway.png` — the panel after "More info",
  showing the "Run anyway" button.

These prove the operator dismissal path documented in
`OPERATOR-RUNBOOK.md` § 1 still works on the current Windows
build. If a future Windows release removes the "Run anyway"
button (Microsoft has tightened SmartScreen multiple times since
2023), the decision-to-stay-unsigned needs revisiting.
