import type { AuditEntry, LicenseKey, Pilot, Squadron, User } from "./types";

// Fresh install: no seeded squadrons, pilots, commanders, or audit entries.
// The Super Admin creates real data through the UI (or via Supabase once the
// backend is configured). These exports must stay present — the app imports
// them by name — but they start empty.

export const squadrons: Squadron[] = [];
export const pilots: Pilot[] = [];
export const commanders: User[] = [];
export const auditLog: AuditEntry[] = [];

// Install-activation key baked into every distribution so a fresh PC install
// can be unlocked without requiring a previous Super Admin to have minted one
// first. The key is NOT bound to a specific operator — anyone installing on
// a new PC types it with their own username during first-time activation.
// The Super Admin can (and should) issue additional per-operator keys from
// the LicenseKeys admin page once the app is up.
//
// Stored in the registry with the `_fullKey` field so lookupLicenseKey() can
// match the exact string the operator types. Never expires.
// The extra `_fullKey` field on the seed is consumed by license-registry.ts
// when validating an activation attempt. It intentionally isn't part of the
// LicenseKey type — the admin table only ever shows keyPreview.
export const licenseKeys: LicenseKey[] = [
  {
    id: "seed-install-key",
    squadronId: "",
    keyPreview: "MG3H…HM22",
    status: "active",
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    _fullKey: "MG3H7HM22",
  } as unknown as LicenseKey,
];

export const SUPER_ADMIN: User = {
  id: "u-admin",
  username: "admin",
  displayName: "System Owner",
  role: "super_admin",
  squadronIds: [],
};
