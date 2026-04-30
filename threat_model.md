# Threat Model

## Project Overview

Hawk Eye is a LAN-only flight-hours management system for the Royal Jordanian Air Force. The production deployment in this repository consists of a Windows-hosted Express API server in `artifacts/api-server/` and an Electron + Vite desktop dashboard in `artifacts/pilot-dashboard/`, backed by local PostgreSQL on the squadron host PC. The current production model is closed-LAN, no Supabase, no cloud telemetry, and no internet dependency for core operations.

Production users are super administrators on the host PC, squadron ops staff, squadron commanders, and higher-tier wing/base commanders on aggregator machines. The main security decisions hinge on LAN authentication, server-side role enforcement, cross-PC peer trust, and the Electron renderer-to-main boundary. Mock/demo code, the mockup sandbox, and shelved mobile artifacts are out of scope unless production reachability is proven.

## Assets

- **LAN user accounts and sessions** — usernames, bcrypt password hashes, session tokens in `lan_sessions`, and role/scope metadata in `lan_users`. Compromise enables impersonation and downstream access to squadron or admin functions.
- **Operational squadron data** — pilots, sorties, NOTAMs, leave/unavailability, audit logs, monthly/reporting data, and readiness summaries. This data is mission-sensitive and must remain correctly scoped by squadron, wing, or base.
- **Peer trust material** — peer bearer tokens in `peer_tokens`, aggregator-side stored peer credentials, and pairing key material used to onboard other PCs. Compromise can expose read access across machines.
- **Host operational secrets** — bootstrap token, internal write secret, system-identity token, database credentials, and any packaged update trust anchors. These secrets mediate privileged automation or first-user setup.
- **Host PC integrity** — the Electron main process and LAN operator actions can touch the filesystem, scheduled tasks, and update/install flows. Renderer compromise must not become arbitrary host control.

## Trust Boundaries

- **Dashboard/Electron renderer to Express API** — all client input is untrusted. The API must authenticate and authorize requests server-side regardless of UI state.
- **Express API to PostgreSQL** — the API has direct access to all LAN data. Query safety, data scoping, and secret handling are critical because this boundary carries the full mission dataset.
- **Hub to aggregator/viewer PCs** — `/api/peer/*` and pairing flows move data and trust across different machines on the same LAN. Peer enrollment and peer-read scopes must resist spoofing and overexposure.
- **Renderer to Electron main process** — `electron/preload.ts` exposes a narrow privileged bridge into filesystem and update capabilities. IPC arguments must be validated as hostile.
- **Non-human host scripts to API** — PowerShell tasks authenticate with the system-identity token and can write audit or operational state without a human session. Those flows are effectively privileged automation.
- **Public LAN caller to auth/bootstrap surface** — unauthenticated callers can reach login/bootstrap/pairing routes and any top-level route not gated by LAN session middleware. These are the main internet-equivalent attack surface for this deployment model.

## Scan Anchors

- **Production entry points:** `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/routes/index.ts`, `artifacts/api-server/src/routes/lan-auth-public.ts`, `artifacts/api-server/src/routes/internal-lan-pairing.ts`, `artifacts/api-server/src/routes/peer-shell.ts`, `artifacts/api-server/src/routes/import-history-internal.ts`, `artifacts/pilot-dashboard/electron/main.ts`, `artifacts/pilot-dashboard/electron/preload.ts`, `artifacts/pilot-dashboard/src/lib/internal-migration.ts`.
- **Highest-risk areas:** LAN auth/bootstrap, role-enforced internal CRUD, any route that combines LAN session auth with client-shipped `VITE_INTERNAL_WRITE_SECRET`, peer token issuance and pairing approval authenticity, privileged About/System Health actions that spawn host scripts, and the Electron file-write/update bridge.
- **Public vs authenticated vs admin surfaces:** public LAN auth/bootstrap/pairing routes first; authenticated internal and aggregate routes next; super-admin-only operational routes and peer-token management are the most sensitive.
- **Usually out of scope unless production reachability is proven:** `artifacts/mockup-sandbox/`, shelved/mobile artifacts, `.agents/skills/*`, and auth-off dev paths gated by `HAWK_INTERNAL_SESSION_AUTH=off` or `VITE_LAN_NO_AUTH=1`.

## Threat Categories

### Spoofing

The primary spoofing risk is unauthorized creation or use of LAN identities: brute-forcing user passwords, abusing first-user bootstrap, forging peer identity during cross-PC pairing, or imitating trusted host-side automation with the system-identity token. The system must guarantee that only authorized operators or approved host processes can create users, obtain sessions, issue peer trust material, or act as the system, and that pairing approvals prove the real hub's identity rather than only the requester's.

### Tampering

Operators and peer machines can submit pilot, sortie, availability, pairing, and admin action inputs that directly influence mission records or host behavior. The system must validate all client-controlled fields before they reach the database, the filesystem, scheduled tasks, or pairing state, and must enforce write permissions server-side by role and squadron scope even when a coarse internal-write header is present in the shipped desktop client.

### Information Disclosure

The API serves sensitive operational data and host diagnostics to different user tiers. The system must ensure that peer reads expose only the explicitly approved datasets, that authenticated users only receive rows inside their scope, and that error responses, diagnostics, and shipped client bundles do not leak secrets, tokens, or internal host details beyond the intended operator audience.

### Denial of Service

LAN-only deployment does not remove DoS risk: any reachable LAN client can still hammer login, bootstrap, pairing, and heavy operational endpoints. The system must resist credential stuffing and request flooding on authentication surfaces, and privileged host-action routes must not allow trivial service disruption or resource exhaustion.

### Elevation of Privilege

The highest-impact failure mode is a low-privilege LAN user or compromised renderer gaining super-admin, cross-squadron, or host-level capabilities. The system must guarantee that role checks are enforced on the server, peer trust material cannot be minted or replayed by unauthorized actors, and Electron renderer compromise cannot become arbitrary file writes, unsafe updates, or execution of privileged host actions.