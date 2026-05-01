# Shelved Artifacts

These artifacts are intentionally not part of the current LAN-only build.

## `pilot-mobile/`
Expo / React Native mobile app for pilots. Out of scope for the LAN
production rollout (Task #318) — squadrons are issuing only the desktop
client first. Source preserved here for later revival; remove once you
are sure it will not be revived. The app is **not** registered as a
workspace package and **not** booted as a workflow.

## `pilot-desktop/`
Earlier, half-built secondary Electron wrapper (different `appId`:
`com.rjaf.flighthourtracker`). The shipping desktop product is
`pilot-dashboard`'s own Electron build (`appId`:
`jo.gov.rjaf.squadron-ops`). Shelved as dead code. Restore only if you
intend to build a second branded executable.
