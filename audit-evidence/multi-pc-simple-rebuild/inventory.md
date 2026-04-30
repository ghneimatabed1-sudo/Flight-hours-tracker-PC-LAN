# Inventory of what changes in Task #299

## DELETE NOW (from sidebar / nav)

| Surface | Path | Action |
|---|---|---|
| Sidebar item "License Keys" | `src/components/HQLayout.tsx` line 50 | removed |
| Sidebar item "Commanders" | `src/components/HQLayout.tsx` line 51 | removed |
| Generate Code dialog | inside `src/pages/admin/LicenseKeys.tsx` | unreachable from UI |
| Set up this device dialog | inside `src/pages/admin/LicenseKeys.tsx` | unreachable from UI |

## DEPRECATE (kept registered, no longer linked)

| Surface | Path | Reason for keeping |
|---|---|---|
| `pages/admin/LicenseKeys.tsx` | `/admin/keys` | Direct-link viewers / bookmarks survive one release. Removed in follow-up. |
| `pages/admin/Commanders.tsx` | `/admin/commanders` | Same. |
| `pages/SetupWizard` | `/setup/squadron` | Same. |
| Edge fn `register-license` | `supabase/functions/register-license/` | The license_registry table still feeds the old activation path. Removed in follow-up. |
| Edge fn `provision-commander` | `supabase/functions/provision-commander/` | Same. |
| Edge fn `validate-license` | `supabase/functions/validate-license/` | Same. |
| Edge fn `provision-user` | `supabase/functions/provision-user/` | Was unused by new flow but harmless. |
| Table `licenses` | DB | Kept until follow-up burn-in. |
| Table `license_registry` | DB | Kept until follow-up burn-in. |

## ADD NOW

| Surface | Path |
|---|---|
| Migration | `supabase/migrations/0069_unit_members_devices_join_requests.sql` |
| Edge fn | `supabase/functions/unit-approve-device/index.ts` |
| Sidebar item "Pending Devices" | `src/components/HQLayout.tsx` |
| Sidebar item "Devices & Users" | `src/components/HQLayout.tsx` |
| First-launch screen | `src/pages/FirstLaunch.tsx` |
| Joining-an-existing-setup form | `src/pages/JoinSetup.tsx` |
| Waiting-for-approval screen | `src/pages/WaitingForApproval.tsx` |
| Pending Devices admin page | `src/pages/admin/PendingDevices.tsx` |
| Devices & Users admin page | `src/pages/admin/DevicesUsers.tsx` |
| Top-bar identity strip | `src/components/IdentityStrip.tsx` |
| Auth state machine for join flow | `src/lib/unit-join.ts` (new module) + extensions to `src/lib/auth.tsx` |

## KEEP unchanged

- `pages/admin/Squadrons.tsx` (the master squadrons list — task explicitly out-of-scope)
- `pages/admin/Security.tsx` (super-admin password / 2FA / recovery codes — out-of-scope)
- `pages/admin/AuditLog.tsx` (out-of-scope)
- `pages/admin/RemindersSchedule.tsx` (out-of-scope)
- `pages/admin/ConnectionMap.tsx` (out-of-scope)
- All operational pages (Sortie Log, Pilots, Currencies, Reports, Reminders, etc.)
- The mobile pilot link flow and the pilot phone app
- The super-admin 2FA / recovery codes path
- Monthly close / audit log archive / snapshot lockdown / currencies engine / NOTAMs / reports / Excel exports

## SECRETS

| name | location | value |
|---|---|---|
| `UNIT_JOIN_SECRET` | Supabase function secrets + (mirrored to) `VITE_UNIT_JOIN_SECRET` in the dashboard build | freshly minted; same value byte-for-byte both places |
| `SUPABASE_SERVICE_ROLE_KEY` | already set in Supabase function secrets | reused for the approve Edge Function |

The old `REGISTER_LICENSE_SECRET` stays set so the deprecated `register-license` function continues to function for any laptop that hasn't been upgraded yet.

## Documentation

- `MAINTENANCE_RUNBOOK.md` — new "Multi-PC accounts (15-year)" section.
- `replit.md` — short pointer.
