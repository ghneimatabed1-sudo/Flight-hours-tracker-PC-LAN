# Threat Model

## Project Overview

Hawk Eye — RJAF Squadron Ops is a pnpm monorepo that includes an Electron + Vite + React desktop dashboard, an Expo mobile app, a small Express API server, and a Supabase backend with PostgreSQL, Auth, Row Level Security, and Edge Functions. Its production users are super administrators, squadron operations staff, commanders, and pilots.

Production security decisions in this repository hinge on a few high-impact boundaries: public internet callers reaching Edge Functions, Electron renderer code reaching privileged main-process IPC, and client applications receiving credentials or secrets that govern squadron access. Per scan assumptions, only production-reachable issues are in scope; mock/demo-only fallback code paths, mockup sandboxes, and local preview behavior that requires Supabase to be absent are not treated as production vulnerabilities.

## Assets

- **Supabase auth users, passwords, JWT claims, and role metadata** — compromise allows attackers to impersonate ops staff, commanders, or pilots and cross trust boundaries enforced by RLS.
- **Squadron operational data** — pilot rosters, sortie history, currencies, reminder state, audit data, and squadron configuration are mission-sensitive and tenant-scoped.
- **License and provisioning state** — license records, device bindings, squadron mappings, and account bootstrap flows control whether a PC or operator can join a squadron environment.
- **Application secrets and service-role capabilities** — Supabase service-role access, TOTP challenge secrets, and any signing material are high-impact because they can bypass normal authorization controls.
- **Desktop host filesystem** — the Electron main process can write files on the operator’s machine; renderer compromise must not be able to turn that into persistence or host tampering.

## Trust Boundaries

- **Public client to Supabase Edge Functions** — browsers, Electron renderers, and mobile clients are untrusted. Any Edge Function reachable with the anon key or with `--no-verify-jwt` must authenticate and authorize the caller explicitly before using service-role privileges.
- **Public client to Express API server** — routes in `artifacts/api-server/src/app.ts` are internet-reachable and must not expose secrets or internal admin tooling.
- **Electron renderer to Electron main process** — files under `artifacts/pilot-dashboard/electron/` cross from potentially attacker-influenced renderer code into privileged OS APIs. IPC payloads must be validated as hostile.
- **Supabase service-role code to database/Auth admin APIs** — Edge Functions using `SUPABASE_SERVICE_ROLE_KEY` can bypass RLS and rotate passwords. These paths are equivalent to backend admin privileges.
- **Authenticated role boundaries inside Supabase** — super admin, ops, commander, deputy, and pilot capabilities must be enforced server-side, not by UI state or locally cached credentials.

## Scan Anchors

- **Production entry points:** `artifacts/pilot-dashboard/src/lib/supabase.ts`, `artifacts/pilot-dashboard/src/lib/auth.tsx`, `artifacts/pilot-dashboard/supabase/functions/*`, `artifacts/pilot-dashboard/electron/main.ts`, `artifacts/pilot-dashboard/electron/preload.ts`, `artifacts/api-server/src/app.ts`.
- **Highest-risk areas:** public provisioning/licensing flows (`register-license`, `provision-commander`, `validate-license`), super-admin auth flows, Electron IPC file operations, and any page that writes raw HTML (`src/pages/Currency.tsx`).
- **Public vs authenticated vs admin surfaces:** public Edge Functions and API routes are the first priority; authenticated RLS-backed queries come next; admin-only UI checks are not trusted without server enforcement.
- **Usually out of scope unless production reachability is proven:** mock/demo fallback paths gated by missing Supabase config, mock data stores, CI-only files, and mockup sandbox code.

## Threat Categories

### Spoofing

This project provisions Supabase users and grants role-bearing JWTs that drive access to squadron data. Any public bootstrap, recovery, or license-registration endpoint must verify who the caller is before creating or rotating credentials. The system must guarantee that only authorized super-admin or already-authenticated trusted actors can mint accounts, rotate passwords, bind devices, or activate licenses for a squadron.

### Tampering

Operators can enter and edit pilot, squadron, and reminder data that is later rendered in browsers, print views, and desktop windows. The system must treat all stored roster and squadron fields as untrusted when building HTML, and it must validate all Electron IPC parameters before touching the filesystem. Client-controlled data must never be allowed to alter database state, HTML execution context, or host files outside explicitly approved destinations.

### Information Disclosure

Production routes and shipped client bundles must never contain live secrets, signing material, service-role credentials, or recovery paths that reveal privileged bootstrap data. API and Edge Function responses should return only the minimum credentials needed for a legitimately authenticated flow, and public endpoints must not expose internal admin tooling or secret-bearing HTML.

### Denial of Service

Public authentication and admin bootstrap endpoints are attractive brute-force targets. The system must apply durable rate limiting or lockout controls to password and TOTP initiation paths, and public endpoints that trigger expensive admin operations must not be callable anonymously.

### Elevation of Privilege

The highest-risk failure mode in this codebase is a low-privilege or unauthenticated actor gaining ops, commander, or super-admin effective power through public Edge Functions, weak license bootstrap flows, or renderer-to-main-process escalation in Electron. The system must guarantee that service-role functions enforce authorization before acting, that renderer compromise cannot directly reach arbitrary filesystem writes, and that RLS claims cannot be minted or changed by untrusted callers.
