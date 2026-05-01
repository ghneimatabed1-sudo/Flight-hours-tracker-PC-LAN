# Deep static review of installer + lan-host scripts — 2026-04-30 (pass 2)

**Reviewer:** Replit task agent (no Windows hardware)
**Scope:** every file Inno Setup invokes from `[Run]`, plus the
inner `scripts/lan-host/*.ps1` they wrap.
**Why a second pass:** Task #405 asked for a real Windows-VM
dry-run. The Linux container blocks both `iscc` and Wine
(seccomp), so the dry-run is deferred. To compensate, this pass
goes one layer deeper than the 2026-04-30 STATIC-REVIEW.md and
audits the **installer-shim → inner-script** seam — the path that
the prior review only sampled.

This document records:

- bugs that are **fixed in the same commit** as this review,
- bugs that **remain open** and need real-VM time to confirm or
  fix safely (because the failure mode is interactive, encoding-
  dependent, or path-dependent).

If you are the next operator with Windows hardware, start at
`installer/test-vm/README.md` (the playbook) and `installer/test-vm/BUILD-HOST-README.md`
(the build-host setup). This document is the diff against the
previous static review.

---

## A. Bugs FIXED in this pass

### A1. Aggregator wizard wrote raw postgres password into DATABASE_URL

**File:** `scripts/lan-host/aggregator-first-time-setup.ps1`
(line ~278 in the pre-fix file).

**Symptom:** identical to bug #1 in the prior STATIC-REVIEW
("Postgres password not URL-encoded in connection string"). A
postgres password containing any of `@ : / # ? %` produced a
malformed `DATABASE_URL`, and node-postgres would report
`password authentication failed for user "postgres"` — even
though the password was correct. node-postgres truncates the
userinfo at the first reserved character.

**Why the prior review missed it:** the prior fix was applied to
`scripts/lan-host/setup-aggregator.ps1`, the older / more
elaborate aggregator script. The Inno Setup shim
`installer/script-shims/install-aggregator.ps1` actually invokes
**`aggregator-first-time-setup.ps1`** (the wizard-friendly
variant). Two scripts solve the same problem with different
codepaths; only one had the fix. The verification table in
STATIC-REVIEW.md row "aggregator-first-time-setup.ps1 — DONE
(alt UI)" understated the divergence.

**Fix applied:** before composing `DATABASE_URL`, wrap the
plaintext password in `[uri]::EscapeDataString(...)` (storing it
as `$encPg`) exactly as `first-time-setup.ps1` Step 2 does. The
plaintext is still pushed through `PGPASSWORD` for `psql` (which
does not URL-parse it) so the bootstrap commands keep working.

**Knock-on effect on uninstall:** `installer/script-shims/uninstall-prep.ps1`
parses `DATABASE_URL` with `'^postgres(?:ql)?://([^:@/]+)(?::([^@/]*))?@…'`.
That regex's password class `[^@/]*` only matches if the password
is URL-encoded — which is exactly the contract the new fix
enforces. Pre-fix: an aggregator with `Re@l#Pa%word!` would have
left the regex matching everything past the first `@` in the
password as the host, producing a garbled DSN that broke the
uninstall's `pg_terminate_backend` step. Now both ends agree.

### A2. Stdin trailing-newline + encoding hardening on installer shims

**Files:**
- `installer/script-shims/install-hub.ps1` line ~92.
- `installer/script-shims/install-aggregator.ps1` line ~83.

**Symptom (latent):** the shims pipe three lines into the inner
script via:

```powershell
$stdin = @($pgPassword, $AdminUsername, $adminPassword) -join "`r`n"
$stdin | & powershell.exe -ExecutionPolicy Bypass -NoProfile -Command $cmd
```

Two failure modes were possible:

1. **Missing terminator on the last record.** `-join "`r`n"`
   produces `pw1\r\npw2\r\nadminpw` — only two `\r\n` for three
   lines. PowerShell's pipe-to-native-exe converter usually adds
   a trailing newline (Out-String semantics), so the third
   `Read-Host` typically resolved. But on PowerShell 5.1 builds
   without that helpful trailing newline (some Server Core
   images strip it), the inner `Read-Host -AsSecureString` for
   the admin password could hang indefinitely waiting for EOL.
2. **Encoding mismatch.** If `$OutputEncoding` is the host's
   default code page (often Windows-1252) and the inner
   `[Console]::InputEncoding` differs (UTF-8 in modern PS, Win-
   1252 in legacy), any non-ASCII byte in either password gets
   silently replaced or mojibake'd before the inner script runs
   `bcrypt(password, 12)`. Symptom: super_admin login fails
   with the password the operator typed but works with the
   garbled form. This is hard to diagnose because the install
   log shows nothing wrong.

**Fix applied:** explicitly append `"`r`n"` to `$stdin` so the
third record always ends with a terminator, and force both
`[Console]::OutputEncoding` and `$OutputEncoding` to UTF-8 for
the duration of the pipe (restored in `finally`). The inner
PowerShell defaults to UTF-8 input on PS 5.1+ when the parent
process emits a UTF-8 BOM-less stream, so this matches.

---

## B. Bugs found but NOT fixed (need real-VM time to confirm)

These are catalogued so the next operator with Windows hardware
knows exactly what to look for. Each entry says *what to expect
to see if the bug is real* so the report is unambiguous.

### B1. Hub `open-dashboard.cmd` reads a key that no script writes

**File:** `installer/script-shims/install-hub.ps1` lines ~127-131.

The generated launcher does:

```cmd
set DASH_PORT=5173
if exist "<dashEnv>" (
    for /f "tokens=2 delims==" %%P in ('findstr /b /c:"VITE_DASHBOARD_PORT=" "<dashEnv>"') do set DASH_PORT=%%P
)
start "" http://127.0.0.1:%DASH_PORT%/
```

But `scripts/lan-host/first-time-setup.ps1` Step 5 only writes
`VITE_LAN_SESSION_LOGIN`, `VITE_INTERNAL_API_URL`, and
`VITE_LAN_NO_AUTH` to that .env. **`VITE_DASHBOARD_PORT` is never
written by any script in the repo** (`rg` returns zero hits
outside this launcher). So the launcher always falls back to
5173.

That's only OK if the hub's dashboard actually listens on 5173.
The hub install does **not** call `install-dashboard-startup-task.ps1`
(only `setup-aggregator.ps1` does). So a freshly installed Hub
PC has no dashboard scheduled task at all — the desktop shortcut
"Hawk Eye Dashboard" will 404 until the operator manually runs
`pnpm --filter @workspace/pilot-dashboard run preview` or similar.
Hubs may be designed this way intentionally (the dashboard is
expected to live on the wing/base aggregator, with viewers
pointed at the hub's API), but the desktop shortcut is misleading.

**To confirm on the VM:** install the Hub role, click the desktop
"Hawk Eye Dashboard" shortcut, and observe browser behaviour. If
it returns "This site can't be reached", file as a real bug.
Likely fix is one of:
- drop the shortcut from the Hub `.iss` `[Icons]` section (Hubs
  are headless),
- or have the Hub installer also call `install-dashboard-startup-task.ps1`,
- or have first-time-setup.ps1 write `VITE_DASHBOARD_PORT=5173`
  and start a local Vite preview server task.

### B2. Aggregator `open-dashboard.cmd` hardcodes port 5173

**File:** `installer/script-shims/install-aggregator.ps1` lines ~108-110.

```cmd
@echo off
start "" http://127.0.0.1:5173/
```

Unlike the hub variant, no `findstr` fallback at all. If a future
change makes `setup-aggregator.ps1`'s `-DashboardPort` parameter
accessible from the wizard (or the inner script's default
changes), the launcher silently breaks. Low priority because the
current default is 5173 everywhere, but it should at least mirror
the hub launcher's `findstr` pattern for symmetry — and it's
cheap insurance against the kind of port-collision fix that
"obviously" should not need a launcher rebuild.

**To confirm on the VM:** install Wing role, reboot, click "Hawk
Eye Dashboard". Browser should reach the dashboard at 5173. If
the aggregator dashboard task picked a different port (check
`schtasks /Query /FO LIST /V /TN HawkEye-Dashboard-OnStartup`),
file the launcher as broken.

### B3. Aggregator wizard never calls `install-dashboard-startup-task.ps1`

**File:** `scripts/lan-host/aggregator-first-time-setup.ps1`
(steps 9 & 10 install only api-server + backup tasks).

Compare with `setup-aggregator.ps1` which explicitly calls
`install-dashboard-startup-task.ps1` at line ~681. The
installer's `install-aggregator.ps1` shim invokes the wizard
script, so a fresh wing/base PC reboots without an auto-starting
dashboard. The desktop shortcut in B2 then goes nowhere.

**To confirm on the VM:** install Wing role, reboot, BEFORE
opening anything check `schtasks /Query /FO LIST /V /TN HawkEye-Dashboard-OnStartup`.
Expected (per shim contract): task exists and is `Ready`.
Actual (per code): task does not exist; query returns "ERROR:
The system cannot find the file specified."

Fix when confirmed: add a Step 9b to
`aggregator-first-time-setup.ps1` mirroring `setup-aggregator.ps1`
line ~679-686, gated on a `-SkipScheduledTasks` switch.

### B4. Single-quote escape in the shim's command-line string

**Files:**
- `install-hub.ps1` line ~112: `$cmd = "& '$inner' -SquadronName '$SquadronName' $mdnsArg"`
- `install-aggregator.ps1` line ~99: `$cmd = "& '$inner' -Role '$Role' -AggregatorName '$AggregatorName' -SkipDiscovery"`

`$inner` resolves to `$RepoRoot\scripts\lan-host\…ps1`. If
`$RepoRoot` contains an apostrophe (e.g. operator changed
DefaultDirName to `D:\O'Brien Squadron\HawkEye`), the
single-quoted string in `$cmd` terminates early and the
PowerShell parser raises a syntax error. Inno's default
`{autopf}\HawkEye` excludes apostrophes, but the wizard
exposes a "Browse…" button at the install-dir page (Inno
default behaviour), so a customer site could trigger this.

**To confirm on the VM:** run the installer and at the install-
location page browse to a path that contains an apostrophe.
Expected (per code): inner powershell exits with parser error
"The string is missing the terminator: '." If the install
proceeds normally instead, this isn't a bug.

Fix when confirmed: replace `'$inner'` with proper PowerShell
escaping, e.g. `$cmd = & "& `"$($inner.Replace('"','""'))`" …"`,
or — better — drop `-Command` and use `-File` with separate
`-ArgumentList`, which lets Start-Process handle quoting.

### B5. AppId macro evaluates to a literal that ALSO works — verify on real Inno

**File:** `installer/HawkEye.iss` line ~48: `AppId={{#MyAppId}`
where `MyAppId = "{6E4F4D0A-…-9A0E}"` (with surrounding braces).

Trace: `{#MyAppId}` is the preprocessor expression and consumes
the inner `{` and the trailing `}`. Substitution gives
`AppId={` + `{6E4F…-9A0E}` = `AppId={{6E4F…-9A0E}`. At runtime,
Inno unescapes `{{` to `{`, yielding the AppId value
`{6E4F…-9A0E}`. **This is the canonical Inno AppId form.** No
bug — but cite this trace in the BUILD-HOST-README so the next
person doesn't "fix" it.

### B6. Wizard page creation order makes Back navigation surprising

**File:** `installer/HawkEye.iss` `InitializeWizard` — pages
HubPage, HubMdnsPage, AggregatorPage, ViewerPage are all
created with `After:=RolePage.ID`. Inno inserts each new "After"
page immediately after the anchor, so the actual sequence ends
up reversed: Role → Viewer → Aggregator → Hub → HubMdns. With
`ShouldSkipPage` hiding the three non-matching pages, the
operator only ever sees one of them, so this is functionally
correct.

What can break: if someone later adds a `wpInfoBefore` page
between RolePage and the role-specific pages, "Back" from there
will land on the topmost role page (Viewer) regardless of the
selected role, because it can't be skipped going backwards.
Document, do not fix.

### B7. `Read-Host -AsSecureString` over redirected stdin is conhost-version-dependent

This is the failure mode that A2's hardening tries to mitigate
preemptively, but the only way to truly prove it works is a real
install on real conhost. PowerShell 5.1 had a bug where
`Read-Host -AsSecureString` falls back to `Console.ReadKey()`
when the host is interactive but to `Console.In.ReadLine()` when
stdin is redirected. Some build numbers got the dispatch wrong
and would block on `ReadKey` even when stdin is clearly
redirected. Microsoft fixed this in a 2020-era cumulative update.

**To confirm on the VM:** install the Hub role on a stock
Windows 11 22H2 image (no Windows updates applied beyond OOBE).
If the install hangs at "Setting up squadron hub…" with no
console output, kill setup, open `install-log.txt`, and look for
the sequence:
```
[STEP 2] Checking Postgres availability ...
   Found: psql (PostgreSQL) 16.x
```
followed by no `[STEP 3]` line. If you see that, the inner
script hung at the postgres password prompt — file as real bug
B7 with the OS build number.

### B8. `dns-sd.exe -B` output regex is column-spacing-sensitive

**Files:**
- `scripts/lan-host/setup-viewer.ps1` line ~110.
- `scripts/lan-host/discover-hubs.ps1` (matching pattern).

The regex `\bAdd\b\s+\d+\s+\d+\s+\S+\s+_hawkeye-hub\._tcp\.\s+(.+?)\s*$`
assumes Bonjour Print Services for Windows v3.0.0.10 column
layout. If a future Bonjour update inserts a "TTL" column or
swaps "if" and "Flags" columns, the regex stops matching and the
viewer's `-AutoDiscover` returns zero hubs even though `dns-sd
-B` printed them. Operators get the impression the hub isn't
broadcasting. Low risk (Bonjour for Windows hasn't shipped a
new version since 2020), but record so the bug isn't a surprise.

### B9. Viewer launcher's HubPort cast on empty string

**File:** `installer/HawkEye.iss` `GetViewerHubPort` returns
`'3847'` when blank, so `install-viewer.ps1`'s `[int]$HubPort`
cast never sees `""` from the wizard. **However**, if a future
edit removes the GetViewerHubPort fallback or someone invokes
`install-viewer.ps1` from a custom script with `-HubPort ""`,
the cast throws `InvalidCastException`. Add a defensive
`if ([string]::IsNullOrWhiteSpace($HubPort)) { $HubPort = '3847' }`
in install-viewer.ps1 line ~31 the next time someone touches the
file.

### B10. PowerShell 5.1 `schtasks /TR` quoting (re-flagged)

Already noted as Bug B in the prior STATIC-REVIEW. Still not
verified. Real-VM verification test:
- Install to a path like `C:\Program Files\Hawk Eye Test\` (with
  the space).
- Open Task Scheduler GUI → HawkEye-ApiServer-OnStartup → Actions
  tab. Confirm the registered command shows
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "<supervisor>" -RepoRoot "C:\Program Files\Hawk Eye Test"`
  with quotes intact.

If quotes are mangled, the fix is to switch from `schtasks
/Create` to `Register-ScheduledTask` + `New-ScheduledTaskAction`,
which uses argv arrays and dodges `/TR` quoting entirely. Do
this in `install-api-startup-task.ps1`, `install-dashboard-startup-task.ps1`,
and `install-backup-task.ps1` together.

---

## C. Cross-checks against the 2026-04-30 STATIC-REVIEW

| Prior bug                                  | Status today                          |
|--------------------------------------------|---------------------------------------|
| 1. Postgres password URL-encoding          | Re-fixed in `aggregator-first-time-setup.ps1` (A1) |
| 2. `Start-Sleep` race vs api-server boot   | Confirmed still fixed (poll loop intact) |
| 3. SYSTEM-context scheduled task verify    | Confirmed still fixed (run + poll intact) |
| 4. Aggregator dashboard CSP                | Confirmed still fixed in setup-aggregator.ps1; **NOT mirrored in aggregator-first-time-setup.ps1** — that script does not patch CSP at all (no `Update-DashboardCsp` helper). However the aggregator-first-time-setup.ps1 wizard delegates dashboard install entirely (B3) so the CSP issue does not surface there. Re-evaluate when B3 is fixed. |
| 5. Viewer URL ACL HRESULT 5                | Confirmed still fixed in setup-viewer.ps1 |
| A. mDNS supervisor (Task #393)             | Code present, supervisor + check scripts in place |
| B. PS 5.1 `schtasks /TR` quoting           | Still deferred — see B10 |
| C. Pre-existing `hawk_app` postgres role   | Still deferred to real VM |

---

## D. Updated verification status

| File                              | Static review (pass 2) | VM dry-run |
|-----------------------------------|------------------------|------------|
| `installer/HawkEye.iss`           | DONE (B5, B6 noted)    | DEFERRED   |
| `installer/build.ps1` + `build.mjs` | DONE                 | BLOCKED (no iscc) |
| `installer/script-shims/install-hub.ps1`        | DONE (A2 fix, B1, B4, B7) | DEFERRED |
| `installer/script-shims/install-aggregator.ps1` | DONE (A2 fix, B2, B3, B4) | DEFERRED |
| `installer/script-shims/install-viewer.ps1`     | DONE (B8, B9)         | DEFERRED |
| `installer/script-shims/uninstall-prep.ps1`     | DONE                  | DEFERRED |
| `installer/script-shims/discover-hubs.ps1`      | DONE (B8)             | DEFERRED |
| `scripts/lan-host/first-time-setup.ps1`         | DONE                  | DEFERRED |
| `scripts/lan-host/aggregator-first-time-setup.ps1` | DONE (A1 fix, B3) | DEFERRED |
| `scripts/lan-host/setup-aggregator.ps1`         | DONE (already covered prior pass) | DEFERRED |
| `scripts/lan-host/setup-viewer.ps1`             | DONE (B8)             | DEFERRED |
| `scripts/lan-host/launch-viewer.ps1`            | DONE (prior pass)     | DEFERRED |
| `scripts/lan-host/add-squadron-peer.ps1`        | DONE (prior pass)     | DEFERRED |
| `scripts/lan-host/install-api-startup-task.ps1` | DONE (B10)            | DEFERRED |
| `scripts/lan-host/install-dashboard-startup-task.ps1` | DONE (B10)      | DEFERRED |
| `scripts/lan-host/install-backup-task.ps1`      | DONE (B10)            | DEFERRED |
| `scripts/lan-host/start-api-host.ps1`           | DONE (prior pass)     | DEFERRED |
| `scripts/lan-host/api-supervisor.ps1`           | DONE (Task #393)      | DEFERRED |
| `scripts/lan-host/register-mdns.ps1`            | DONE (prior pass)     | DEFERRED |
| `scripts/lan-host/mdns-supervisor.ps1`          | DONE (Task #393)      | DEFERRED |

---

## E. What real-VM evidence still needs to be captured

Listed in priority order so a single-day VM session can do the
highest-value items first. Drop output under
`installer/test-vm/dryrun-evidence/<YYYY-MM-DD>/`:

1. **Build the .exe.** Follow `installer/test-vm/BUILD-HOST-README.md`.
   Capture `iscc-output.log` + the resulting `HawkEye-Setup.exe`
   SHA-256.
2. **Hub role with reserved-char postgres password.** Use
   `Re@l:Pa#s%word!`. Capture install transcript, `install-log.txt`,
   `01-first-boot.png`, `02-healthz.png`, B1's dashboard-shortcut
   outcome, B7's hang test on stock 22H2.
3. **Wing role, same password.** Same captures + the B2/B3
   dashboard-task confirmations.
4. **Base role, default password.** Cheaper run; one set of
   screenshots is enough.
5. **Viewer role on a non-admin user.** B7's HRESULT 5 regression
   check, plus the URL ACL spot-check from the prior playbook.
6. **Install path with apostrophe.** B4 confirmation. Also try
   install path with a space (B10).
7. **Uninstall after Wing install with reserved-char password.**
   Confirms A1's fix end-to-end via uninstall-prep.ps1's regex
   (the consumer of A1's URL-encoded output).
8. **Stock Windows 11 22H2 (no updates) Hub install.** B7 hang
   test on the conhost build that historically had the
   `Read-Host -AsSecureString` bug.

Flag anything not in this list as "out of scope; file follow-up".
