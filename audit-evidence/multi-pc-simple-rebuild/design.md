# Multi-PC simple Join → Approve → Bind — design

## Why

The old flow had four screens for one job (License Keys, Generate Code, Set up this device, Commanders) plus a flaky api-server proxy that returned 503 (`server_misconfigured`). A whole working day was lost trying to add a second laptop. The new flow is one screen on the joining laptop, one card on the super admin, one button to approve. Old surfaces stay registered for backward compat but are removed from navigation.

## The new account model

Three additive tables. **Nothing in the existing schema is dropped or renamed by this task** — the deprecation of `licenses`, `license_registry`, `commander_accounts` is a follow-up after one full release of the new flow has stabilised.

### `unit_members`
The consolidated user account. One row per approved person.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `auth_user_id` | uuid REFERENCES auth.users(id) | the Supabase auth user this account binds to |
| `username` | citext UNIQUE | what the operator types at login |
| `display_name` | text | shown in the top-bar identity strip |
| `role` | text CHECK in (`ops`, `commander`, `super_admin`) | `super_admin` rows exist only for the bootstrapping super admin; ordinary joins are `ops` or `commander` |
| `tier` | text CHECK in (`ops`, `flight`, `squadron`, `wing`, `base`, `hq`) | matches `app_metadata.tier` |
| `squadron_allow_list` | text[] NOT NULL | the squadron names (`NO.8`, etc.) this member is bound to. Source of truth for `app_metadata.squadron_ids` |
| `primary_squadron_id` | uuid REFERENCES squadrons(id) | NULL for wing/base/hq (no single primary). Mirrored into `app_metadata.squadron_id` for legacy single-squadron RLS |
| `status` | text CHECK in (`active`, `removed`) DEFAULT `active` | **never hard-deleted** — `removed` keeps the historical sortie/notam attribution alive |
| `removed_at`, `removed_reason` | timestamptz, text | audit trail |
| `created_at`, `updated_at` | timestamptz | |

### `devices`
One row per approved laptop. A single `unit_member` may have multiple devices over time (laptop swap).

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `member_id` | uuid REFERENCES unit_members(id) | |
| `display_name` | text | mirrors `unit_members.display_name` for the Devices & Users list |
| `fingerprint` | text NOT NULL | SHA-256 of UA+screen+TZ+local UUID, set at request time |
| `originating_ip` | inet | recorded at approve time from the request row |
| `originating_city` | text | best-effort from PostgREST `request.headers` |
| `approved_at`, `approved_by` | timestamptz, uuid | |
| `last_seen_at` | timestamptz | bumped by `unit_member_self()` ping every ≤ 30s |
| `revoked_at`, `revoked_reason` | timestamptz, text | mirrors unit_members.removed but per-device |

### `device_requests`
The pending join queue. Auto-purged after 30 days.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `requested_role` | text | `ops`, `flight`, `squadron`, `wing`, `base`, `hq` (the human-readable role from the form) |
| `requested_squadron_names` | text[] | what the requester ticked on the form |
| `username`, `display_name` | citext, text | |
| `password_plain` | text | the user's chosen password, stored briefly until approve. RLS gated to super_admin only. Cleared on approve/reject. |
| `fingerprint` | text | from the joining laptop |
| `originating_ip` | inet | from PostgREST request headers at request time |
| `submitted_at` | timestamptz DEFAULT now() | |
| `status` | text CHECK in (`pending`, `approved`, `rejected`, `ignored`) DEFAULT `pending` | |
| `decided_at`, `decided_by`, `decision_reason` | timestamptz, uuid, text | |
| `supabase_email`, `supabase_password` | text | written by the approve RPC; the joining laptop pulls these on its next status poll then signs into Supabase |
| `member_id`, `device_id` | uuid | populated on approve so the joining laptop can locally cache its identity |

## Anonymous bootstrap RPCs

These are the only RPCs the joining laptop calls before it has a Supabase session. They are gated by a shared secret `UNIT_JOIN_SECRET` passed in `x-unit-join-secret` header (parity with the old `register-license`'s `REGISTER_LICENSE_SECRET`).

- `unit_super_admin_exists()` → bool
- `unit_squadrons_for_join()` → `[{id, name, number}]`
- `unit_request_join(p_role, p_requested_squadron_names, p_username, p_display_name, p_password_plain, p_fingerprint, p_meta)` → `{request_id}`
- `unit_request_status(p_request_id)` → `{status, supabase_email?, supabase_password?, member_id?, device_id?, decision_reason?}`

Anon-callable but the gating secret is checked inside each function via `pg_catalog.current_setting('request.headers', true)::jsonb ->> 'x-unit-join-secret'`. Same constant-time comparison technique as the old `register-license` Edge Function.

## Authenticated super-admin RPCs

- `unit_pending_requests()` → array of pending rows
- `unit_approve_request(p_request_id, p_squadron_names_override)` → `{member_id, device_id}`
  - **Server-side authority on the squadron list** — the override array is what binds. The original `requested_squadron_names` is just the proposal. A wing-commander cannot self-grant extra squadrons.
  - Calls into the `unit-approve-device` Edge Function (which has service-role privileges to create the auth.users row).
- `unit_reject_request(p_request_id, p_reason)`
- `unit_ignore_request(p_request_id)`
- `unit_list_devices()` → joined view of devices × unit_members
- `unit_update_squadrons(p_member_id, p_squadron_names)` → updates `unit_members.squadron_allow_list` AND patches `auth.users.app_metadata.squadron_ids` so the bound laptop sees the change on next session refresh
- `unit_remove_member(p_member_id, p_reason)` → flips status to `removed`, deletes the auth.users row (revokes refresh tokens immediately)

All super-admin RPCs verify `xpc_is_super_admin()` (the existing canonical predicate from migration 0068).

## Bound-member self RPC

- `unit_member_self()` → `{member_id, device_id, status, role, tier, squadron_allow_list, display_name}`
  - Returns NULL when the calling JWT no longer maps to an active `unit_members.status='active'` row.
  - Bumps `devices.last_seen_at`.
  - The dashboard's AuthProvider polls this every 30 sec; when null, force sign-out.

## Realtime

Add `device_requests` to the `supabase_realtime` publication. The Pending Devices page subscribes to `INSERT` events; on every event it re-fetches `unit_pending_requests()` to get the fresh list.

## RLS

| table | who reads | who writes |
|---|---|---|
| `unit_members` | super_admin (all), self (own row) | super_admin only |
| `devices` | super_admin (all), self (own rows) | super_admin only |
| `device_requests` | super_admin (all); anon may read its own row by id IF the secret header matches | anon may insert with secret header; super_admin may update |

## Audit triggers

Every status transition on `device_requests` and every `status` flip on `unit_members` writes an `audit_log` row with the actor, the old/new state, and a `detail` jsonb.

## Squadron binding into operational reads

The existing operational RLS already keys on `app_metadata.squadron_id` (single uuid) and `app_metadata.squadron_ids` (text[] of names). The approve RPC populates both:

- For tier ∈ {ops, flight, squadron}: `squadron_id` = the squadron uuid, `squadron_ids` = `[squadron_name]`
- For tier ∈ {wing, base, hq}: `squadron_id` = NULL, `squadron_ids` = the array of names

No RLS changes are needed downstream — the existing snapshot select policy from migration 0061/0063 already reads `squadron_ids[]` correctly.

## Wiring out the old api-server proxy

The new flow does NOT route through `api-server`. It calls the Supabase RPC directly with the anon key + the `x-unit-join-secret` header. Same anti-misuse pattern as super-admin-2fa. The 503 `server_misconfigured` from the old `/license/register` proxy is therefore irrelevant to the new flow. The old proxy stays in place as deprecation; deletion is a follow-up after one full release of the new flow has stabilised.

## Out of this task's scope

- Deleting the old `licenses`, `license_registry`, `commander_accounts` tables (data migration is in scope; deletion is a follow-up after burn-in).
- Removing the old `register-license`, `provision-commander`, `validate-license` Edge Functions (same reason).
- Migrating the user's local-only test commander accounts on laptop A — the user said they can wipe those manually after the new flow is live.
