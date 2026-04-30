# Step 2 — Auth & security design spec (approved target before code changes)

**Status:** APPROVED FOR ENGINEERING (document-only — **no** `login()` / `unit-join` code changes in Step 2).  
**Date:** 2026-04-25  
**Implements (later):** Plan Step **10** / Phase **8** “security hard cut,” after internal API routing (Steps 3–4) is stable.

**Related:** [STEP-1-baseline-inventory.md](./STEP-1-baseline-inventory.md) (current touchpoints), [DOMAIN.md](../../DOMAIN.md) (roles, not security mechanics).

---

## 1. Purpose

Lock the **replacement security model** in writing so implementation does not drift:

- **One** primary authentication factor: the **install / application password** the operator uses to open Hawk Eye on that PC (per user account), **for every role** (Ops, all commander scopes, Super Admin) — no extra “security product” steps in the default path.
- **Role-based data visibility** (what data you see) **stays** — that is **authorization**, not extra login factors.
- **Auditability** for sensitive actions **stays** (append-only or best-effort `audit_log` / equivalent) — audits **must not** block sign-in (per v1.1.95 lesson: audit failure ≠ failed login).

---

## 2. Target user experience (after full program)

1. User opens Hawk Eye; sees **one password field** (plus username if applicable / existing flows).
2. On correct password → **session established** to the **internal** backend; **app reshapes to that user’s role** (unchanged product rule).
3. **No** second step (TOTP, SMS, e-mail) in the **default** path.
4. **No** “account locked for 5 minutes” after N wrong guesses **unless** the operator later asks for a **simple** org policy (out of scope for v1 of this spec — default is **no** lockout).
5. **No** “this PC is locked to Wing only” style **login** gating (see §3.3).
6. **Join / device bootstrap** (First Launch) works **without** a `VITE_UNIT_JOIN_SECRET` baked into the client, subject to **§5** replacement controls.

---

## 3. Behaviors to remove (from current app — design target)

| # | Item | Code / config anchor (inventory) | Notes |
|---|------|-----------------------------------|--------|
| 3.1 | **Super Admin TOTP / 2FA** (Supabase path) | `auth.tsx` → `supabase.functions.invoke("super-admin-2fa", …)`; [Login.tsx](../../artifacts/pilot-dashboard/src/pages/Login.tsx) TOTP UI blocks | Replaced by **password-only** + internal session. Edge function `super-admin-2fa` **deprecated** for login after cutover. |
| 3.2 | **Standalone TOTP** (no Supabase demo path) | `auth.tsx` local `ADMIN_TOTP_SECRET_KEY`, enroll/verify, recovery codes | Remove enroll/verify UI and dependencies on same **login** path. |
| 3.3 | **Per-PC role lock** (hide / refuse wrong role) | `PC_ROLE_LOCK_KEY` (`rjaf.pcRoleLock`), `readPcRoleLock()` in `auth.tsx` (~ lines 70–80, 634–641) | Operator chose **all users** to use the same *style* of login; **PC role lock** is removed so the **assigned account** determines role, not a second lock. |
| 3.4 | **Login failure lockout** (5 fails → 5 min) | `auth.tsx` `recordFail` / `rjaf.fails`, `rjaf.lockUntil` (see ~606–618, 612+) | **Remove** for v1 of this spec. (Optional hardening later: soft delay without hard lock — not in v1.) |
| 3.5 | **Server-side lock in `super-admin-2fa` response** | `data.lockedUntil` from edge | Falls away when 2FA function removed from login. |
| 3.6 | **Join secret header for anonymous `unit_*` RPCs** | [unit-join.ts](../../artifacts/pilot-dashboard/src/lib/unit-join.ts) `VITE_UNIT_JOIN_SECRET` + `x-unit-join-secret` on `unit_request_join`, `unit_request_status`, etc. | Replaced by **server-side** controls on internal LAN (e.g. rate limit, IP allow list, mTLS, or one-time org token issued out-of-band — **design in API**, not a second end-user “secret” in every installer). |

### 3.7 Not in scope to remove (clarification)

- **Session lock / Lock screen** (gold lock) — this is **physical** privacy when stepping away, **not** multi-factor **login**. **Retain** unless operator says otherwise.
- **Idle auto-logout** (Settings) — user preference, **not** a second factor. **Retain**.
- **Supabase-or-internal `signInWithPassword` “machine password”** — today the **user-typed** password and **server-issued** password for JWT can differ; the internal migration will consolidate under **one operator-visible password** + session — detailed in **API** design (Step 3+), not here.
- **Master recovery hash** (baked break-glass) — **Decision pending:** either (a) remove in favor of **Super Admin** org process on internal LAN, or (b) keep **one** break-glass path documented only to the CO — record choice before Step 10 code cut.

---

## 4. Behaviors to keep

| # | Item | Rationale |
|---|------|------------|
| 4.1 | **Role-based menu & data** (`Layout` / `HQLayout` / claims) | Core product; unchanged intent. |
| 4.2 | **`recordAuditEvent` (non-blocking)** for login success/fail, role-lock override, master recovery, admin actions | Forensics; must never take down login. |
| 4.3 | **Licensing / squadron setup** as today until replaced by org policy | **Additive**; same data-preservation rules as [replit.md](../../replit.md). |
| 4.4 | **Unit join flow shape** (request → approve → claim) | Only the **gating** mechanism changes (§3.6), not the need for a controlled allow-list of devices. |

---

## 5. Replacement controls (internal deployment — not in the public client)

The old **join secret** exists because anonymous RPCs were exposed to the internet. On a **base-only network**, replacement controls **must** be written into the **internal API** and deployment guide:

- Firewall: only squadron + admin VLAN can reach the join API.
- Optional: mTLS, VPN, or IP allow list on the **reverse proxy**.
- Rate limits on `unit_request_join` equivalents.
- **No** long-lived **shared** secret in every `.exe` build if avoidable.

---

## 6. Open decisions (to close before Step 10 implementation)

1. **Master recovery** (§3.7) — keep or remove.
2. **Password complexity** — minimum length only, or also rotation policy (org IT).
3. **Mobile app** (pilot) — same “single password + session” model vs device-bound token; align with `artifacts/pilot-mobile/`.

---

## 7. Exit criteria (Step 2)

- [x] This document reviewed and **approved** as the target.
- [ ] **Operator sign-off** (below).

**Sign-off (operator):** I approve this as the target auth/security model for the internal-LAN migration.

| Field | |
|-------|---|
| Name | _________________________ |
| Date | _________________________ |

---

*Step 2 deliverable: design spec only. Step 3+ builds internal API; Step 10 implements this spec in code.*
