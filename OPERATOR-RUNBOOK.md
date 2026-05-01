# Hawk Eye — Operator Runbook

**Audience:** the squadron's IT support officer, not a developer. Every
step assumes you have local administrator rights on the host PC and
know how to right-click a PowerShell window and choose **Run as
Administrator**.

---

## What you have

- One **host PC** sitting in HQ. It runs Postgres + the api-server. It
  is on the squadron LAN. It is **NOT** on the public internet.
- Multiple **dashboard PCs** (workstations for ops officers and
  commanders). Each runs the Hawk Eye `.exe`. Each one talks to the
  host PC over the LAN.
- A **USB stick** for monthly backups + occasional update transport.

You do not need an internet connection to install, run, back up,
restore, or reset anything in this system.

---

## 1. First-time install — double-click `HawkEye-Setup.exe`

There is one Windows installer for every PC role:
**`HawkEye-Setup.exe`** (~150-300 MB; offline; bundles Node.js LTS,
pnpm, the prebuilt api-server, and the prebuilt dashboard, so the
target PC needs no internet and no separate Node install).

Steps for **every** role:

1. Install Postgres 14+ on the PC and pick a strong password for the
   `postgres` superuser. Write it down — the installer asks for it.
   (Skip this step on **Viewer** laptops — they have no database.)
2. Copy `HawkEye-Setup.exe` onto the PC (USB or LAN copy) and
   double-click it. Windows will ask for elevation — click **Yes**.
3. On screen 2, **pick the role** for this PC:
   - **Operation Pilot PC (Squadron Hub)** — stores the squadron's
     pilots and sortie data. One per squadron.
   - **Wing Commander PC (Aggregator)** — rolls up several squadrons
     into one wing-level dashboard.
   - **Base Commander PC (Aggregator)** — rolls up several wings into
     one base-level dashboard.
   - **Squadron / Flight Commander Laptop (Viewer only)** — no data
     stored locally; reads from the squadron hub PC.
4. Fill in the per-role prompts:
   - **Hub**: squadron name (1-15 chars, letters/digits/hyphen — this
     becomes the Windows computer name, e.g. `tigers-hub`), Postgres
     superuser password, first super-admin username + password
     (typed twice), and an optional "advertise on the LAN (mDNS)"
     checkbox.
   - **Wing / Base**: Postgres password and first super-admin
     username + password. The address book of squadron hubs is filled
     in **after** install (see "What to do after install" below).
   - **Viewer**: hub address (e.g. `tigers-hub.local`) and port
     (default 3847).
   The installer validates every field client-side and refuses to
   advance with bad input.
5. Click **Install**. The installer extracts the bundle, then runs
   the matching `scripts\lan-host\*.ps1` setup script silently in
   the background. Status reads "Setting up …". The full transcript
   lands in `<install dir>\install-log.txt` for troubleshooting.
6. **Hub installs only**: the finished page shows the **peer access
   token** in a green panel with a **Copy** button. Hand this token
   to the Wing/Base Commander PC operator. It is shown once; a copy
   is also saved to `%PROGRAMDATA%\HawkEye\peer-token-initial.txt`
   (readable only by local Administrators).
7. Click **Finish**. A desktop shortcut and Start Menu entry are
   created automatically:
   - Hub / Aggregator → **Hawk Eye Dashboard** (opens in default
     browser).
   - Viewer → **Hawk Eye Viewer** (kiosk-style window aimed at the
     hub).

If the squadron name changed the Windows computer name during a Hub
install, the install log will note that a **reboot is mandatory**
before the api-server can advertise as `<name>.local`.

#### About the SmartScreen / "Unknown publisher" prompt

The first time you double-click `HawkEye-Setup.exe`, Windows may
show a blue **"Windows protected your PC"** panel ("SmartScreen
filter prevented an unrecognised app from starting"), and the
elevation prompt will show **Unknown publisher**. This is
expected — Hawk Eye is not code-signed for the small LAN-only
deployment we ship to. The decision and rationale live at
`installer/CODE-SIGNING-DECISION.md`.

To proceed safely:

1. Verify the `.exe`'s SHA-256 matches the value your IT support
   officer gave you (PowerShell:
   `Get-FileHash .\HawkEye-Setup.exe -Algorithm SHA256`).
2. On the SmartScreen panel click **More info** → **Run anyway**.
3. On the User Account Control prompt click **Yes**.

If you skipped the SHA-256 check or the value doesn't match, do
NOT click "Run anyway" — escalate to your IT officer.

#### About visual screenshots in this section

This section's word-for-word description of the wizard pages was
authored from the installer source (`installer/HawkEye.iss`)
during a static review. **The accompanying screenshot gallery is
intentionally not yet attached** — the project's build host is
Linux and cannot run Inno Setup's compiler or boot a Windows VM,
so no real screenshots exist as of 2026-04-30. The next operator
with Windows hardware will add them; the playbook they should
follow is `installer/test-vm/README.md`, and the static-review
findings that drove this section are at
`installer/test-vm/dryrun-evidence/2026-04-30/STATIC-REVIEW-DEEP.md`.

If you are running an install for the first time and find the
wizard text differs from the description above, that is a real
bug — capture the screenshot and report it to the project.

### What to do after install

- **Wing / Base PCs (first launch only)** — when you open the
  dashboard for the first time, Hawk Eye scans the LAN for any PC
  announcing itself as a Hub. If it finds one, you get a **"Pair
  with your Hub"** card with a single button. Click **Pair with
  this Hub** and the request is sent over the LAN to the Hub's
  super_admin. The Hub super_admin sees it under **Admin → Pairing
  Inbox** and clicks **Approve**. The peer access token is then
  delivered encrypted to your PC automatically — you never copy or
  paste it — and stored in `peer_squadrons` so the aggregator's
  fan-out reads start working immediately. The dashboard reloads
  paired and ready to use. If nothing appears, fall back to the
  address-book / `setup-aggregator.ps1` flow below.
- **Viewer PCs (first launch only)** — viewers don't host an
  api-server, so the in-app pairing card doesn't apply. Use
  `setup-viewer.ps1 -AutoDiscover` from PowerShell instead; it
  browses the same `_hawkeye-hub._tcp` mDNS service, lets you pick
  the squadron's hub, and bakes its address into the local viewer
  bundle.
- **Wing / Base PCs** — if the one-click flow can't see a Hub (e.g.
  different VLAN), open the dashboard, sign in as the super-admin
  you just minted, and use **Admin → Address Book** to add the
  squadron hubs (their hostnames + peer tokens). You can also use
  `scripts\lan-host\add-squadron-peer.ps1` from PowerShell.
- **Hub PCs (super_admin only)** — track who is asking to pair with
  this Hub at any time under **Admin → Pairing Inbox**. The list
  shows each requester's hostname, role (wing / base / viewer),
  squadron from its TXT announce, and the timestamp. Approve and
  the Hub mints a fresh peer token bound to that requester and
  delivers it encrypted. Deny and the requester's outbox row flips
  to `denied` immediately.
- **Any PC** — see who else is on the LAN under **Admin → LAN Peers**
  (or **Aggregator → LAN Peers** on a wing/base). The page lists
  every Hawk Eye PC currently announcing on `_hawkeye._tcp` with
  hostname, role, IP, and last-seen timestamp. Useful for sanity
  checks ("is the Tigers hub actually on the LAN right now?").
- **Hub PCs** — to broadcast this hub on the LAN later (if you left
  the mDNS checkbox off during install), run
  `scripts\lan-host\register-mdns.ps1 -SquadronName <name>`.
- **Viewer PCs** — to re-point a laptop at a different hub, run
  `scripts\lan-host\change-viewer-hub.ps1`.
- Peer tokens can be rotated any time via the dashboard's
  **Admin → Peer Tokens** page or `scripts\lan-host\reset-peer-token.ps1`.

### Manual install fallback (advanced / troubleshooting)

The PowerShell scripts under `scripts\lan-host\` are still the
canonical implementation. Run them directly when:

- The installer cannot run (e.g. you are scripting an unattended
  build, or a strict policy blocks unsigned `.exe` files).
- The installer fails partway through and `install-log.txt` shows a
  recoverable error you want to retry by hand.
- You are a developer iterating on the install flow.

See **§ 11. Manual install via PowerShell scripts** at the end of
this runbook for the per-role commands.

---

## 2. First-time install on each dashboard PC

1. Copy `Hawk Eye Setup x.y.z.exe` to the dashboard PC.
2. Run the installer as a regular user.
3. The installer creates a desktop shortcut. Launch it.
4. Sign in with the super-admin account you minted at the prompts in
   step 1.6 (username + password you typed when `first-time-setup.ps1`
   asked).
5. Inside the app: **Admin → Users → Add user** to create the per-PC
   ops officer / commander accounts.

If a dashboard PC cannot reach the host PC, check:
- Are both PCs on the same LAN?
- Does the host PC respond to `ping hawk-host.local` from the
  dashboard PC?
- Is the host PC's firewall allowing inbound TCP on port 3847?

---

## 2a. Wing or Base Commander PC (aggregator)

Use **`HawkEye-Setup.exe`** (see § 1) and pick **Wing Commander PC
(Aggregator)** or **Base Commander PC (Aggregator)** on the role
picker. The installer asks for the local Postgres password and the
first super-admin account, then runs `aggregator-first-time-setup.ps1`
silently.

A Wing/Base PC runs the api-server in `aggregator-wing` or
`aggregator-base` mode. That mode does **not** host squadron data of
its own; it fans reads out to squadron hub PCs and aggregates the
responses into a wing/base dashboard. A small local Postgres database
stores only the local super_admin, the squadron-hub address book, the
audit log, and a per-peer response cache.

### One-click pairing on first launch

When you open the aggregator dashboard for the first time, Hawk Eye
runs a **LAN auto-discovery scan** in the background — it looks for
any PC on the same network announcing `_hawkeye._tcp` with TXT
record `role=hub`. If at least one Hub is visible, you see a
full-screen card titled **"Pair with your Hub"** listing every
discovered Hub by hostname, IP, squadron name, and version.

Click **Pair with this Hub** next to the right Hub. The aggregator
sends a signed pairing request to the Hub over the LAN. The Hub's
super_admin sees it under **Admin → Pairing Inbox** with this PC's
hostname, role, and timestamp, and clicks **Approve** (or **Deny**).
On approve, the Hub mints a fresh peer access token, encrypts it
with this PC's X25519 public key (delivered with the request) and
the result is downloaded automatically. No copy-paste, no plaintext
token on screen. The card flips to "Paired successfully" and the
dashboard reloads against the Hub's data.

If the discovery card shows **"No Hub visible on this LAN"**:
- Confirm the Hub PC is powered on and on the same VLAN.
- On the Hub, run `Get-Service Bonjour` and start it if not running.
- On this PC, confirm the bundled Bonjour package was installed
  (folder `<install dir>\bonjour-portable\dns-sd.exe` exists, or
  Bonjour Print Services is installed system-wide).
- Wait 10 s and click **Retry** on the card. mDNS announces are
  re-broadcast every 30 s.
- If discovery is still empty, fall back to the address-book flow
  below (or, for cross-VLAN setups, ask the Hub super_admin to
  mint a peer token from **Admin → Peer Tokens** and paste it via
  `setup-aggregator.ps1`).

### Add a squadron after install (manual / fallback)

If you skipped the one-click pairing card, or want to add another
squadron from a different LAN, add hubs from the dashboard
(**Admin → Address Book**), or from PowerShell:

```
.\scripts\lan-host\add-squadron-peer.ps1 `
    -DisplayName "Eagles" `
    -Address "eagles-hub.local" `
    -Token   "<paste-from-hub>"
```

The address book is editable later (super_admin only) under
**Admin → Address Book**.

### Manual install fallback (PowerShell-only path)

The original PowerShell-only flow is preserved in **§ 11. Manual
install via PowerShell scripts** at the end of this runbook. Use it
when the installer cannot run (e.g. unattended deployment scripts).

<details>
<summary>Show original step-by-step setup-aggregator.ps1 instructions</summary>

1. Open PowerShell **as administrator** in the source folder.
2. Run:
   ```
   pnpm install
   .\scripts\lan-host\setup-aggregator.ps1
   ```
   The script prompts in order for:
   - **PC role** — `wing` or `base`. Determines the install profile
     (`aggregator-wing` vs `aggregator-base`) recorded in
     `install_profile_meta` on first boot.
   - **Local super_admin username + password** — the operator who
     will manage the squadron-hub address book on this PC. Stored
     hashed (bcrypt) in `lan_users` like every other Hawk Eye user.
   - **Squadron hubs** — for each hub: display name (e.g. "Tigers"),
     hostname or IP (e.g. `tigers-hub.local`), and the peer access
     token from that hub's **Admin → Peer Tokens** page. The script
     loops until you say "done".
   - **Postgres superuser password** — used once to create the local
     database and run the schema bootstrap.
3. Optional auto-discover — re-run with `-AutoDiscover` to scan the
   LAN for `_hawkeye-hub._tcp` first; the script lists every hub it
   sees and asks Y/N for each one before falling through to manual
   entry. Requires Bonjour Print Services for Windows (`dns-sd.exe`).
4. The script writes:
   - `artifacts\api-server\.env` with `INSTALL_PROFILE=
     aggregator-<role>`, `DATABASE_URL`, `PORT`, a fresh bootstrap
     token, and `HAWK_INTERNAL_SESSION_AUTH=required`.
   - `artifacts\pilot-dashboard\.env.production.local` with
     `VITE_INTERNAL_API_URL` pointing at this PC's local aggregator
     (so the dashboard talks to its own api-server).
5. The script then:
   - Builds the api-server, boots it briefly to run
     `ensureFullSchema()` (creates `peer_squadrons`, `peer_cache`,
     `install_profile_meta`, `lan_users`, etc.).
   - Mints the local super_admin (single transaction; bcrypt-hashed).
   - Seeds `peer_squadrons` from the hubs you entered (single
     transaction — a partial failure leaves nothing committed; same
     for the audit log entries).
   - Builds the dashboard once.
   - Registers two scheduled tasks so both auto-start on boot:
     `HawkEye-ApiServer-OnStartup` and `HawkEye-Dashboard-OnStartup`.
6. The output ends with a self-check that hits
   `/api/aggregate/peers/health` on the local api-server. A `200`
   confirms the route is mounted with the configured peer count;
   a `401`/`403` is also a healthy outcome — it means the route is
   mounted correctly and just needs a signed-in super_admin to read
   the body. Anything else gets a clear `[FAIL]` line.

### Add a squadron later

When a new squadron stands up after the initial install, do **not**
re-run `setup-aggregator.ps1`. Use the lighter helper instead — same
validation, same audit log entry:

```
.\scripts\lan-host\add-squadron-peer.ps1 `
    -DisplayName "Eagles" `
    -Address "eagles-hub.local" `
    -Token   "<paste-from-hub>"
```

Without arguments the script prompts interactively. It picks up
`DATABASE_URL` from `artifacts\api-server\.env` automatically.

The address book is also editable via the dashboard later (super_admin
only) under **Admin → Address Book** — that path uses the same
`/api/aggregate/peers` API the script writes to.

### Useful flags

- `setup-aggregator.ps1 -Role wing` — skip the role prompt.
- `setup-aggregator.ps1 -AutoDiscover` — scan the LAN first.
- `setup-aggregator.ps1 -SkipDashboardBuild -SkipApiBuild` — useful
  on a re-run when the bundles are already up to date.
- `setup-aggregator.ps1 -SkipScheduledTasks` — install env + DB
  only, don't touch Windows Task Scheduler. Pair with
  `pnpm lan:host:install-startup-task` and
  `pnpm lan:aggregator:install-dashboard-task` to register the
  tasks later.
- `add-squadron-peer.ps1 -SquadronId tigers-east` — override the
  auto-slug if the default collides with an existing entry.

### Day-to-day

- The api-server scheduled task starts on boot and serves
  `/api/aggregate/*` to anything on the LAN that authenticates as
  the local super_admin.
- The dashboard scheduled task starts on boot and serves the
  built bundle on the configured local port (default 5173). Open it
  in the browser of your choice on the same PC; sign in with the
  local super_admin.
- A separate dashboard task adds the squadron status panel (online /
  offline indicator per peer) — until that ships, you can self-check
  reachability with:
  ```
  Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3847/api/aggregate/peers/health
  ```

</details>

---

## 2b. Squadron / Flight Commander laptop (viewer)

Use **`HawkEye-Setup.exe`** (see § 1) and pick **Squadron / Flight
Commander Laptop (Viewer only)** on the role picker. The installer
asks for the hub address (e.g. `tigers-hub.local`) and an optional
port, then runs `setup-viewer.ps1` silently.

A viewer laptop has **no Postgres** and **no api-server**: nothing is
stored locally and login still happens against the squadron's hub PC
over the LAN.

### One-click pairing on first launch

Viewers do **not** run a local api-server, so there is no in-app
"Pair with your Hub" card on a viewer (that card needs a local
backend to mint and store an X25519 keypair, persist outbound
requests, and host an `/api/internal/lan-pairing/approval`
endpoint — none of which exist on a viewer).

Instead, viewer first launch uses **PowerShell-side mDNS
discovery**:

```
.\scripts\lan-host\setup-viewer.ps1 -AutoDiscover
```

The script browses `_hawkeye-hub._tcp` on the LAN for ~6 seconds,
shows a numbered pick-list of hubs, lets the operator confirm one,
then bakes that hub's address into the viewer bundle. No Hub-side
super_admin approval is required for read-only viewer access — the
viewer just talks to the hub's existing read endpoints over the
LAN. The viewer can also opt in to announcing itself on
`_hawkeye._tcp` with `role=viewer` by re-running
`setup-viewer.ps1 -EnableMdns`; this is informational only and
helps a Hub super_admin see active viewers in their dashboard.

If multicast is blocked, omit `-AutoDiscover` and pass `-HubAddress
<host-or-ip> -HubPort <port>` directly.

### Re-point a viewer at a different hub

When a laptop is reassigned (e.g. Tigers → Eagles):

```
.\scripts\lan-host\change-viewer-hub.ps1
```

The script re-validates the new hub, rewrites the dashboard env,
rebuilds the local bundle, and refreshes the desktop / Start Menu
shortcuts. Existing shortcuts keep working — no reinstall needed.

After re-pointing, the dashboard's first launch on the new hub
will again show the one-click pairing card so the new Hub
super_admin can approve this viewer.

### Manual install fallback (PowerShell-only path)

The original PowerShell-only flow is preserved in **§ 11. Manual
install via PowerShell scripts** at the end of this runbook.

<details>
<summary>Show original step-by-step setup-viewer.ps1 instructions</summary>

On the commander's laptop, with Node.js 20+ and the Hawk Eye source
folder copied across (USB or LAN):
1. Open PowerShell **as administrator** in the source folder.
2. Run:
   ```
   pnpm install
   .\scripts\lan-host\setup-viewer.ps1
   ```
3. Answer the prompt:
   - **Squadron hub address** — hostname (`tigers-hub.local`) or IP
     of the squadron's host PC. The script hits the hub on
     `/api/healthz` and refuses to proceed if nothing answers or if
     the answer is from a non-hub install.
   - Optional: re-run with `-AutoDiscover` to scan the LAN for
     `_hawkeye-hub._tcp` and pick a hub from a list (requires Bonjour
     Print Services for Windows / `dns-sd.exe`).
4. The script writes the dashboard env, builds the dashboard locally
   (or copies a `-PrebuiltDist <folder>` you shipped pre-built), and
   creates a desktop shortcut + Start Menu entry under
   `Hawk Eye → Hawk Eye Viewer`.
5. The output ends with **"This PC is a viewer — it does not store
   any data locally."** If you don't see that line, the install
   failed somewhere — re-run and read the `[FAIL]` message.

### Day-to-day use
- Double-click the desktop shortcut. The launcher first hits the hub
  on `/api/healthz` and:
  - **If reachable** — opens the dashboard in a kiosk-style browser
    window (Edge `--app=` mode, falls back to Chrome, then to the
    default browser).
  - **If unreachable** — pops a message saying "Cannot reach
    `<squadron>` hub at `<address>` — check the network or contact
    your Ops Pilot" and exits without showing a stuck loading
    spinner.
- Login is the user's normal Hawk Eye username + password — same
  accounts the host PC serves to every other dashboard. Create them
  on the host via **Admin → Users** as you would for any new user.

### Re-point a viewer at a different hub
When a laptop is reassigned (e.g. Tigers → Eagles):
1. On the commander's laptop, in PowerShell **as administrator**:
   ```
   .\scripts\lan-host\change-viewer-hub.ps1
   ```
   The script prints the current hub it is pointed at, then asks for
   the new one (or accepts `-HubAddress <new-hub.local>`). It
   re-validates the new hub, rewrites the dashboard env, rebuilds
   the local bundle, updates `.viewer-config.json`, and refreshes
   the existing desktop / Start Menu shortcuts.
2. Existing shortcuts keep working — no reinstall needed.

### Useful flags
- `setup-viewer.ps1 -PrebuiltDist <folder>` — copy a prebuilt
  `dist/public` instead of building locally (useful when the laptop
  has no Node.js or is air-gapped from npm). The prebuilt bundle
  **must** have been built with `VITE_INTERNAL_API_URL=http://<this
  hub>:<port>` — Vite bakes the hub URL into the JS, so a generic
  bundle would silently call the wrong hub. The script verifies the
  bundle contains the configured URL and refuses to install if not.
- `setup-viewer.ps1 -SkipBuild` — keep the existing
  `dist/public` as-is; only rewrite env, patch CSP, and refresh
  shortcuts. Same constraint as `-PrebuiltDist`: the existing bundle
  must already target the configured hub.
- `setup-viewer.ps1 -SquadronName "Tigers"` — labels the desktop
  shortcut "Hawk Eye — Tigers" and shows "Tigers hub" in the
  unreachable-hub message.
- `setup-viewer.ps1 -LocalPort 5500` — change the local launcher
  port if 5500 is already in use on the laptop.

If Bonjour `dns-sd.exe` is missing on the laptop, `-AutoDiscover`
warns and falls back to manual entry — install Bonjour Print
Services from Apple's site if you want auto-discovery.

</details>

---

## 3. Daily monitoring

There is nothing to do daily. The api-server runs as a scheduled task
and restarts on failure. The dashboard logs every action to the audit
log; commanders can review it under **Admin → Audit Log**.

Glance once a week:
- Task Scheduler → "Hawk Eye API Server" → still Running?
- Task Scheduler → "Hawk Eye Backup" → last run succeeded?

---

## 4. Backups

Automatic: the nightly backup task runs at **02:30** local time and
writes a `.dump` file under
`<repo>\artifacts\api-server\backups\hawk-eye-lan-YYYYMMDD-HHMMSS.dump`.
Files older than 14 days are pruned automatically. To put backups
somewhere else, re-run `install-backup-task.ps1` (it overwrites the
task) and pass `-RunAt "HH:mm"`; to change the directory, pass
`-BackupDir` to `backup-postgres.ps1` or wrap it in your own scheduled
task.

Manual on-demand (also writes under
`artifacts\api-server\backups\` by default):
```
.\scripts\lan-host\backup-postgres.ps1
```

Move the resulting `.dump` file to the USB stick once a week and store
it off-site. **A backup that lives only on the host PC is not a
backup** — if the host PC dies, it dies with it.

---

## 5. Restore from backup

On a fresh host PC (after re-installing Postgres and Node) — empty
database, no existing tables:
```
.\scripts\lan-host\restore-postgres.ps1 -BackupFile "D:\hawk-eye-lan-20260429-023000.dump"
```

If the database already has data (you are restoring on top of an
existing install), pass `-DropAndRecreate` so the restore wipes the
existing schema first:
```
.\scripts\lan-host\restore-postgres.ps1 -BackupFile "D:\hawk-eye-lan-20260429-023000.dump" -DropAndRecreate
```

The script reads `DATABASE_URL` from your shell environment by default;
pass `-DatabaseUrl "postgresql://..."` to override it. The api-server
picks up the restored data on next boot.

---

## 6. Reset password / add user

Day-to-day account work is done from the dashboard, not from the host
PC scripts:

1. On any PC, sign in as **super-admin**.
2. Open **Admin → Users** in the sidebar.
3. From this page you can:
   - **Add User** — create a new ops officer or commander account
     (deputy / ops / commander_squadron / commander_wing /
     commander_base). Pick a squadron when prompted; the wing and
     base are filled in automatically from that choice.
   - **Edit** — change role or squadron scope, or use the
     "Reset password" field to set a new password (minimum 8
     characters). Tell the user to sign in with the new password and
     then go to **Settings → Change Password** to pick a personal one.
   - **Disable / Enable** — soft-disable an account without losing
     its history. A disabled user cannot sign in and any in-flight
     session is dropped on its next request. The page refuses to
     disable the last super-admin so you can never lock the host out.
   - **Delete** — permanently remove the account. Use this only when
     the person is leaving and you do not want their username sitting
     around.

All four actions write through the LAN api-server, hash passwords
before storage, and add an audit log row under your username.

Fallback for total lock-out (e.g. the only super-admin password is
lost and no other super-admin exists), run on the **host PC** —
export the database URL once per shell, then run the reset:
```
$env:DATABASE_URL = "postgresql://postgres:<pg-pw>@127.0.0.1:5432/hawkeye_internal"
.\scripts\lan-host\reset-admin-password.ps1 -Username "superadmin"
```

(or pass `-DatabaseUrl "postgresql://..."` directly to the script).
Without one of those the script aborts with `DATABASE_URL not set`.
You can read the same URL out of `artifacts\api-server\.env`.

You will be prompted for the new password twice. The new password is
hashed (never stored as plain text) and written directly to the
`lan_users` table; an audit log row is added under
`actor='host_script'`. Use this only when the in-app page is
unreachable — it bypasses the audit chain that the **Admin → Users**
page provides.

### Re-issue a peer access token

The peer access token is what the Wing Commander PC sends to read this
hub's data. The first one is printed by `first-time-setup.ps1` and
saved to `%PROGRAMDATA%\HawkEye\peer-token-initial.txt`. To mint a
fresh one (lost token, suspected leak, or routine rotation), on the
host PC, with the api-server running:

```
.\scripts\lan-host\reset-peer-token.ps1 -Username "superadmin"
```

You will be prompted for that super_admin's password. The script logs
in over HTTP, calls `POST /api/internal/peer-tokens`, prints the new
plain token in a green banner (shown **once**), and rewrites
`%PROGRAMDATA%\HawkEye\peer-token-initial.txt`. Earlier tokens stay
valid until you revoke them — sign in as super_admin and remove them
from the dashboard, or `DELETE /api/internal/peer-tokens/<id>`.

If the api-server is not running, start it first:
```
schtasks /Run /TN HawkEye-ApiServer-OnStartup
```

### Turn the LAN broadcast on or off later

If you skipped `-EnableMdns` during first-time setup but later want
this hub to be auto-discovered by an aggregator install wizard:

```
.\scripts\lan-host\register-mdns.ps1 -SquadronName "tigers-hub" -ApiPort 3847
```

To stop broadcasting:
```
.\scripts\lan-host\register-mdns.ps1 -SquadronName "tigers-hub" -Unregister
```

This requires `dns-sd.exe` (ships with Apple Bonjour Print Services).
On a stripped-down PC the script warns and exits cleanly so you can
install Bonjour and re-run.

The broadcast runs under a small supervisor wrapper
(`mdns-supervisor.ps1`) launched by the `HawkEye-Mdns-OnStartup`
scheduled task. If `dns-sd.exe` is killed (OOM, manual kill, console
session close, crash) the supervisor respawns it within ~5 seconds —
operators do not need to do anything. To confirm the broadcast is
alive without RDP'ing into the host:

```
.\scripts\lan-host\check-mdns-health.ps1
```

Exit `0` means alive, `2` means the supervisor itself died (re-run
`register-mdns.ps1` to reinstall the task), `3` means it is in the
middle of a restart (try again in ~30s). The supervisor's rolling
log lives at `%PROGRAMDATA%\HawkEye\mdns-supervisor.log` and the
latest heartbeat at `%PROGRAMDATA%\HawkEye\mdns-supervisor.heartbeat`.

#### Verifying log rotation on a host PC (one-time, install acceptance)

The shared rotation helpers in `scripts\lan-host\supervisor-log.ps1`
keep `%PROGRAMDATA%\HawkEye\*-supervisor.log` from growing without
bound. A focused Pester suite at
`scripts\lan-host\supervisor-log.Tests.ps1` exercises every branch
(append, threshold-trigger rotation, .1→.N walk, oldest-discarded,
`MaxBackups=0` discard-only, never-throws on a bad path, and the
`Get-RotatedLogCount` plateau).

The Linux dev container can't run PowerShell, so this suite is **not**
part of `pnpm run release:verify`. Instead, run it once on each host
PC during install acceptance:

```powershell
PS> Install-Module Pester -Scope CurrentUser -Force   # one-time per PC
PS> Invoke-Pester -Path scripts\lan-host\supervisor-log.Tests.ps1
```

A green run confirms the supervisor will not blow out the host's disk
even if mDNS or the api-server flap continuously for years. Re-run the
suite after any upgrade that touches `supervisor-log.ps1`.

---

## 7. Push an updated build via USB

**Before you copy anything to USB:** on the build PC (the machine that
produced the new installer), open a terminal in the source folder and
run:

```
pnpm run release:verify
```

This runs every gate (typecheck, the full pilot-dashboard test suite,
the 3-process multi-PC test, the matrix Playwright sweep, and the
"no external URLs" static check), captures evidence under
`release-evidence/<date>/`, and writes a single
`HAWKEYE-RELEASE-REPORT-<date>.md` with a verdict at the top:

| Verdict | Meaning | Action |
| --- | --- | --- |
| GREEN | All checks passed and matrix evidence matches the committed baseline. | **GO.** Continue with the steps below. |
| GREEN (provisional) | All checks passed but the matrix baseline is still the empty starter (drift detector is informational only). | **GO**, but on a host with Chromium also follow the report's recommendation: promote `release-evidence/<date>/matrix-snapshot.json` into `scripts/src/release-evidence-baseline.json`, commit, and re-run so the next release can detect drift. |
| AMBER | All checks passed but a probe outcome drifted from the (initialized) baseline — a role-gate may have changed. | **HOLD.** Read the drift table in the report. If the change is intentional, refresh `scripts/src/release-evidence-baseline.json` from `release-evidence/<date>/matrix-snapshot.json`, commit, re-run, and confirm GREEN. |
| RED | A check failed. | **NO-GO.** Open the per-check log under `release-evidence/<date>/`, fix the failure, re-run. Do not bypass. |

Only proceed to the steps below once the verdict is **GREEN**.

Hawk Eye has auto-update **disabled** by default — that is the safe
choice for a private LAN install.

To apply a new release:
1. Receive the new `Hawk Eye Setup x.y.z.exe` on a USB stick.
2. On each dashboard PC: close Hawk Eye, run the new installer
   (it overwrites the previous install in place; no settings are
   lost), launch.
3. The title bar shows the new version + git short hash. Confirm it
   matches what you were given.

If the host-side api-server source needs to change (rare):
1. Stop the "Hawk Eye API Server" scheduled task.
2. Replace the source folder on the host PC with the new copy.
3. From the source folder, in an elevated PowerShell:
   ```
   pnpm install
   ```
4. Restart the scheduled task. Watch the log under
   `scripts\lan-host\first-time-setup.log` (or the api-server's stdout)
   for the "Server listening" line.

---

## 8. Troubleshooting

First, on the host PC, run the two diagnostic scripts. Together they
cover ~80% of first-run failures:

```
pnpm lan:host:preflight   # checks .env, pnpm/pg_dump on PATH, port 3847 free
pnpm lan:host:health      # hits http://127.0.0.1:3847/api/healthz
```

| Symptom | Try this |
| --- | --- |
| Dashboard says "Cannot reach API server" | `ping hawk-host.local` from the dashboard PC. If it fails, the host PC is offline, mDNS is blocked on the LAN, or the LAN path is broken. Run `pnpm lan:host:health` on the host to confirm the api-server itself is alive. |
| Commander laptop pops "Cannot reach `<squadron>` hub at `<address>`" | The viewer launcher pre-checked `/api/healthz` and got nothing. `ping <address>` from the laptop. If the host is up but the laptop moved squadrons, run `change-viewer-hub.ps1` on the laptop to re-point it. |
| `setup-viewer.ps1` refuses with "installProfile='viewer' (expected 'hub')" | You pointed the viewer at another viewer / aggregator PC by mistake. Re-run with the **squadron host PC's** address (the one running Postgres + api-server). |
| Viewer launcher says "local launcher port busy" | Something else on the laptop is using port 5500. Re-run `setup-viewer.ps1 -LocalPort <free-port>`, or pass `-LocalPort` to `launch-viewer.ps1` for a one-off. |
| Sign-in keeps failing | Check the audit log on the host PC's Postgres for `lan_login_failed` rows. Ask user to wait 5 minutes (rate limit) and try again. If the user account was disabled, sign in as super-admin and re-enable it from **Admin → Users**. |
| Sign-in returns "lan_user_disabled" | The account is soft-disabled. Sign in as super-admin and toggle it back to **Active** from **Admin → Users**. |
| All sign-ins fail and we just rebuilt the host | Run `reset-admin-password.ps1` for the super-admin on the host PC, then sign in and use **Admin → Users** to reset everything else. |
| Wing Commander PC asks for the squadron's peer token and we don't have it | The initial token is in `%PROGRAMDATA%\HawkEye\peer-token-initial.txt` on the host (Local Administrators only). If that file is gone, mint a fresh one with `reset-peer-token.ps1 -Username "<super_admin>"` — it overwrites the file and prints the new token in a green banner. |
| Aggregator wizard cannot see this hub on the LAN | mDNS may be off, or the supervisor died. First run `scripts\lan-host\check-mdns-health.ps1` on the host: exit 0 = alive, 2 = supervisor died (re-run `register-mdns.ps1 -SquadronName "<name>" -ApiPort 3847`), 1 = mDNS was never enabled. If `dns-sd.exe` is missing, install Apple Bonjour Print Services and re-run. Either way, the operator can still type `<squadron>.local` by hand. |
| Dashboard title bar shows "v? · nogit" | The build was made from a tarball without `.git`. Functionally fine; cosmetic. |
| Auto-update toggled on by accident | Set `RJAF_ENABLE_AUTO_UPDATE=0` (or unset it) in the dashboard launch environment. The Settings → Auto-Update toggle in the app also controls this per-role. |
| Audit log row shows `actor: unknown` | Someone made a write while the api-server was in `HAWK_LAN_DEV_NO_AUTH=1` mode. Flip it back to `0` immediately. |
| `setup-aggregator.ps1` reports "Failed to seed peer_squadrons (transaction rolled back)" | One of the hubs you entered has the same auto-slug as another (the address book has a unique index on `squadron_id` per active row). Re-run with distinct display names, or run `add-squadron-peer.ps1 -SquadronId <unique>` to add the duplicate after the install completes. |
| Aggregator dashboard shows an empty squadron list | Run `Invoke-WebRequest http://127.0.0.1:3847/api/aggregate/peers/health` on the aggregator PC. Empty `peers` means nothing was seeded — re-run `setup-aggregator.ps1` (it's idempotent) or use `add-squadron-peer.ps1`. |
| Want to confirm this PC's install profile | Hit `http://127.0.0.1:3847/api/healthz`. The `installProfile` field is `hub`, `aggregator-wing`, or `aggregator-base`. The first-boot value is canonical and pinned in `install_profile_meta`. |

---

## 9. Quarterly operator checklist

Hawk Eye is built to run unattended for ~15 years on the squadron LAN.
A short quarterly walk-through (≈10 minutes per host PC) is the only
maintenance the operator owes the system. Every step below is also
surfaced on the **Admin → System Health** page in the dashboard, so the
operator can do most of this without opening PowerShell.

Schedule: **15 January, 15 April, 15 July, 15 October.** (Same day the
backup-verify Scheduled Task fires automatically.)

1. **Open the System Health page** — sign in as super-admin and visit
   **Admin → System Health**. Every tile should be green. Yellow tiles
   include the operator action right in the message; red tiles must be
   resolved immediately (writes are blocked when the disk tile turns
   red). The page refreshes every 30 seconds.
2. **Check the disk** — the *disk* tile must read >20% free. If it is
   yellow, archive old `.dump` files in
   `artifacts/api-server/backups/` to a USB stick and delete them from
   the host PC; the rest of the data lives in Postgres and does not
   prune itself.
3. **Confirm the nightly backup ran** — the *last_backup* tile should
   read "<24h ago". If it is yellow/red, run
   `pnpm lan:host:backup` once by hand to confirm the script still
   works, then re-install the Scheduled Task with
   `pnpm lan:host:install-backup-task`.
4. **Confirm the quarterly verify ran** — the *last_backup_verify*
   tile should read "<120 days ago". If older, run
   `pnpm lan:host:verify-backup` once by hand and re-install the
   quarterly task with `pnpm lan:host:install-verify-backup-task`.
5. **Check peer reachability (aggregator PCs only)** — the *peers*
   tile lists every squadron hub. Any offline peer is also listed in
   the address book on **Admin → Squadrons**; ping the listed
   hostname from the aggregator PC. If a peer reports a clock skew
   over 5 minutes, fix that PC's system clock (right-click the
   taskbar clock → *Adjust date/time*).
6. **Glance at the audit log** — the *audit_log* tile shows row count
   and on-disk size. The table is append-only and is fine to grow
   (the composite index keeps reads fast even at 10M+ rows). Open
   **Admin → Audit Log** and confirm there are no recent
   `actor: unknown` rows from outside an expected
   `HAWK_LAN_DEV_NO_AUTH=1` bring-up window.
7. **Note the schema/install-profile drift** — the
   *install_profile* tile reports the originally-installed profile
   pinned in `install_profile_meta`. If it disagrees with the
   currently-running profile, escalate to the developer; the
   first-boot value is canonical.

If every tile is green, you are done — write the date in the host PC's
log book and move on. The host PC needs no further attention until
next quarter.

### Scheduled tasks installed by the runbook

| Task | Cadence | Installed by |
| --- | --- | --- |
| `HawkEye-Postgres-Backup-Daily` | 02:30 every day | `pnpm lan:host:install-backup-task` |
| `HawkEye-Backup-Verify-Quarterly` | 03:30 on the 15th of Jan/Apr/Jul/Oct | `pnpm lan:host:install-verify-backup-task` |

Both tasks run as `SYSTEM`, read `DATABASE_URL` from
`artifacts\api-server\.env`, and write nothing to the public internet.

---

## 10. What to escalate

Contact the developer (with logs) only when:
- The api-server crashes on boot and `first-time-setup.log` shows a
  schema error — you may have an unsupported Postgres version.
- The dashboard refuses to launch with a `webSecurity` or
  `electron-updater` error in the renderer log — there is a packaging
  defect.
- An audit log search reveals writes you cannot account for, especially
  any with `actor_unknown:true` outside an expected dev-no-auth window.

Everything else is recoverable with the scripts in this folder.

---

## 11. Manual install via PowerShell scripts (advanced / fallback)

The PowerShell scripts under `scripts\lan-host\` remain the canonical
implementation of every install path. `HawkEye-Setup.exe` (see § 1)
is a thin wizard around them. Run them directly when:

- The installer cannot run (no admin rights to extract files,
  unattended deployment script, strict policy blocks unsigned `.exe`).
- The installer fails partway through and `install-log.txt` shows a
  recoverable error you want to retry by hand.
- You are a developer iterating on the install flow.

In every case: install Node.js 20+ on the target PC, copy the Hawk
Eye source folder across (USB or LAN), open PowerShell **as
administrator** in the source folder, and `pnpm install` once.

### Squadron Hub (Operation Pilot PC)

```
.\scripts\lan-host\first-time-setup.ps1            # interactive wizard
.\scripts\lan-host\first-time-setup.ps1 -EnableMdns  # also broadcast on the LAN
```

The script prompts for: squadron name (1-15 chars, letters/digits/
hyphen — becomes the Windows computer name; if the name changes the
script queues a rename + reboot), the Postgres superuser password,
and the first super-admin username + password. It writes both
`.env.production` files, creates the database, lays out every Hawk
Eye table, mints the super-admin, and registers two scheduled tasks:
`HawkEye-ApiServer-OnStartup` and `HawkEye-Postgres-Backup-Daily`
(plus `HawkEye-Mdns-OnStartup` when `-EnableMdns` was passed).

The script prints the **bootstrap token** (used once for first remote
sign-in) and the **initial peer access token** in a green banner
near the end — copy it immediately; it is shown once. A copy is
saved to `%PROGRAMDATA%\HawkEye\peer-token-initial.txt` (Local
Administrators only). Lost it? See § 6 — `reset-peer-token.ps1`
mints a fresh one.

### Wing / Base Commander PC (aggregator)

```
.\scripts\lan-host\aggregator-first-time-setup.ps1                # interactive
.\scripts\lan-host\aggregator-first-time-setup.ps1 -Role wing -SkipDiscovery
```

The interactive flow asks whether this is a `wing` or `base` PC, the
hostname (and queues a Windows rename if needed — **reboot is
mandatory** afterwards), the Postgres superuser password, and the
first super-admin username + password. By default it then auto-
discovers squadron hubs by browsing `_hawkeye-hub._tcp` on the LAN
and lets you pick them with their peer tokens; with `-SkipDiscovery`
it just sets the PC up and you add hubs later via the dashboard's
**Admin → Address Book** or `add-squadron-peer.ps1`.

To add or rotate squadrons later:

```
.\scripts\lan-host\add-squadron-peer.ps1 `
    -DisplayName "Eagles" -Address "eagles-hub.local" -Token "<paste-from-hub>"
```

`add-squadron-peer.ps1` reads `DATABASE_URL` from
`artifacts\api-server\.env` automatically. The address book is also
editable in the dashboard under **Admin → Address Book**, and via
`POST/PATCH/DELETE /api/aggregate/peers` — all super-admin-only and
recorded in `audit_log`.

### Squadron / Flight Commander laptop (viewer)

```
.\scripts\lan-host\setup-viewer.ps1                                 # interactive
.\scripts\lan-host\setup-viewer.ps1 -HubAddress tigers-hub.local    # non-interactive
.\scripts\lan-host\setup-viewer.ps1 -AutoDiscover                   # mDNS picker
.\scripts\lan-host\setup-viewer.ps1 -PrebuiltDist <folder>          # air-gapped laptop
.\scripts\lan-host\setup-viewer.ps1 -SkipBuild                      # reuse existing dist
```

The script writes the dashboard env, builds (or copies) the
dashboard locally, and creates a desktop / Start Menu shortcut under
`Hawk Eye → Hawk Eye Viewer`. The output ends with **"This PC is a
viewer — it does not store any data locally."** — if you don't see
that line, the install failed somewhere; re-run and read the
`[FAIL]` message.

To re-point an existing viewer at a different hub, use
`change-viewer-hub.ps1` instead of re-running `setup-viewer.ps1`
— it rebuilds the bundle and refreshes the existing shortcuts in
place without disturbing anything else.

### Useful extra flags (all roles)

- `-SkipScheduledTasks` — install env + DB only; register the
  scheduled tasks later with `pnpm lan:host:install-startup-task`,
  `pnpm lan:host:install-backup-task`,
  `pnpm lan:aggregator:install-dashboard-task`.
- `-SkipDashboardBuild -SkipApiBuild` (aggregator) — skip rebuilds
  on a re-run when the bundles are already up to date.
- `-LocalPort <n>` (viewer) — change the local launcher port if the
  default 5500 is in use.
- `-SquadronName "Tigers"` (viewer) — labels the desktop shortcut
  "Hawk Eye — Tigers" and shows "Tigers hub" in the unreachable-hub
  message.


---

## 12. Guard scripts (`scripts/src/check-*.mjs`)

Hawk Eye keeps a small set of release-time guard scripts that catch
regressions before a USB push. Every guard listed here is wired into
`pnpm run release:verify` (or invoked directly from a documented
workflow). Anything **not** in this list has either been retired or
should not be expected to run.

If a script under `scripts/src/check-*.mjs` is not described below
and is not invoked by any workflow file or `release:verify`, treat
it as dead code and delete it — that is exactly the housekeeping
this section exists to prevent.

| Guard | What it enforces | How it runs |
| --- | --- | --- |
| `check-no-external-urls.mjs` | After the dashboard is built, scans `artifacts/pilot-dashboard/dist/` for any `http(s)://…` literal that is not on the documented allow-list (localhost, `*.local`, `hawk-api.lan`, `hawk-hub.lan`, namespace URIs, vendor license URLs, Google Fonts). The LAN install is air-gapped — any unexpected external URL would either render as a broken icon or leak a hostname. | Invoked by `pnpm run release:verify` (`check-no-external-urls` step). Also runnable directly with `pnpm run check:no-external-urls`. Add new legitimate URLs to `ALLOW_URL_REGEXES` in the script. |
| `check-audit-evidence-mirror.mjs` | When a commit message contains `audit-NNNN-MM-DD`, asserts the same commit also touches `audit-evidence/NNNN-MM-DD/`. This was added after Round-3 sibling reports failed to reach the coordinator because they lived in gitignored `.local/`. | Run on demand with `node scripts/src/check-audit-evidence-mirror.mjs --commits N` or `--range A..B`. Defaults to `--mode warning`; promote to `--mode blocker` once a clean cycle proves no historical false positives. |
| `check-migration-prefixes.mjs` | Walks the migrations directory under the dashboard artifact, groups files by their leading `NNNN_` prefix, and fails on any new collision (the legacy collisions already applied in production are pinned in an allowlist). Prevents the silent "second migration with the same prefix never reaches production" failure mode (Audit H / Task #249). | Run on demand with `pnpm run check:migration-prefixes`. The coordinator is expected to run this before merging any round of parallel SQL work — see `MAINTENANCE_RUNBOOK.md` § "Migration prefix allocation for parallel agents." |

### Why scripts get retired

When a backend dependency goes away (e.g. when Supabase was ripped
out of Hawk Eye's runtime), every guard script that probed it is
retired in the same change set. A guard that probes a function or
endpoint that no longer exists silently passes through its error
path on every release, so it provides zero defence-in-depth and
just wastes a few seconds per `release:verify` run plus a few
minutes for the next person who reads it and tries to figure out
what it was for.

If you need to audit which guards are wired into which pipelines:

- `pnpm run release:verify`'s `CHECKS` array in
  `scripts/src/release-verify.mjs` is the authoritative list of
  guards run on every release.
- `.github/workflows/*.yml` lists any guards run by GitHub Actions
  (build / installer / mobile pipelines).
- `package.json` `scripts` section lists every guard exposed as a
  named pnpm task (`pnpm run check:*`).
