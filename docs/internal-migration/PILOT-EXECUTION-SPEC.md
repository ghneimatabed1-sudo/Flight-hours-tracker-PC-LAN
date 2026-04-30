# Pilot Execution Spec (one squadron, 5 PCs)

Use this exact script for the first live pilot:

- 1 Ops PC (host + client)
- 1 Squadron Commander PC (client)
- 3 additional client PCs (ops/deputy/commander as needed)

## A) Pre-pilot gate (must pass before connecting users)

On host machine, from repo root:

```powershell
pnpm run lan:host:preflight
pnpm run lan:host:start
pnpm run lan:host:health -- -ApiBaseUrl "http://<host-ip>:3847"
```

On each client machine:

```powershell
pnpm run lan:client:setup-env -- -ApiBaseUrl "http://<host-ip>:3847"
```

## B) Bootstrap and account setup

1. Start app on host/client.
2. Complete first LAN admin bootstrap (using `HAWK_LAN_BOOTSTRAP_TOKEN`).
3. Create required accounts:
   - Ops pilot
   - Deputy (optional)
   - Squadron commander
4. Sign in from all 5 PCs against same API URL.

Pass condition:
- Every PC reaches dashboard without cloud/join setup screens.

## C) Operational flow tests (must all pass)

### 1. Roster/sortie consistency
- Add pilot on PC-A -> pilot appears on PC-B and commander PC.
- Add sortie on PC-A -> sortie appears on PC-B and commander PC.
- Edit/delete sortie on one PC -> reflected on others.

### 2. Schedule chain + commander surfaces
- Create schedule from ops path.
- Forward/review using commander path.
- Ensure state transitions reflect across PCs.

### 3. Messages + pending workflow
- Send message PC-A -> PC-B receives.
- Mark read/update status -> reflected sender-side.
- Pending guest approval actions propagate correctly.

### 4. Audit and diagnostics
- Verify key actions appear in audit page.
- Verify diagnostic page shows internal API healthy on each PC.

### 5. Session lifecycle
- Sign out and sign back in from multiple PCs.
- Idle timeout/logout path clears session and re-login works.

## D) Resilience tests (must pass before go-live)

### Host API restart
1. Stop host API.
2. Confirm clients show expected failure behavior (no fake success).
3. Start host API.
4. Confirm clients recover and data remains consistent.

### Backup/restore drill
1. Run:
   - `pnpm run lan:host:backup`
2. Restore latest backup on test DB or maintenance window:
   - `pnpm run lan:host:restore -- -BackupFile "<path-to.dump>" -DropAndRecreate`
3. Confirm app data integrity post-restore.

## E) Pilot sign-off output

Record the following for sign-off:

- Pilot date/time window
- Host machine name/IP
- Number of participating PCs
- Pass/fail per section (A–D)
- Blocking defects (if any) and owner
- Final verdict: `GO` or `NO-GO`
