# RJAF Flight Hours System — Build Targets

This repo produces three artefacts for operational use:

| Target                 | Platform | Builder                        | Output |
|------------------------|----------|--------------------------------|--------|
| Hawk Eye PC app    | Windows  | electron-builder (NSIS)        | `HawkEye-Setup-<ver>.exe` |
| Hawk Eye iOS           | iPhone   | Xcode + expo prebuild          | `.ipa` |
| Hawk Eye Android       | Android  | Gradle + expo prebuild         | `.apk` |

All three are pre-configured for **Codemagic** (`codemagic.yaml` at the
repo root) and GitHub Actions (`.github/workflows/`). Pick whichever you
prefer — Codemagic is recommended because it's one-click and it handles
macOS, Linux, and Windows build agents in a single dashboard.

---

## Codemagic (recommended — one dashboard for all 3)

### One-time setup
1. Go to https://codemagic.io, sign in with GitHub/GitLab.
2. Add this repository as a project.
3. Codemagic auto-detects `codemagic.yaml` — you'll see three workflows:
   - **Hawk Eye — Android APK**
   - **Hawk Eye — iOS IPA**
   - **Hawk Eye — Windows Installer**

### Optional secrets (set in Codemagic UI → Environment variables)
- `INSTALL_PASSWORD` — master password the NSIS installer prompts for
  before any files are written. Encrypt it via the Codemagic UI.
- **iOS signing** (only if you want a signed production IPA for the App
  Store / TestFlight): add an App Store Connect integration. For ad-hoc
  side-loading via AltStore / Sideloadly the current unsigned build is
  fine.

### Run a build
Click **Start new build** on any of the three workflows. When it
finishes, the `.exe`, `.ipa`, and `.apk` appear under the **Artefacts**
tab of that build.

### Triggers you can add
`codemagic.yaml` supports auto-triggering on tag pushes; drop a
`triggering:` block under any workflow if you want every `v*` tag to
produce installers automatically.

---

## GitHub Actions (alternative)

The repo also ships two GitHub Actions workflows:
- `.github/workflows/dashboard-windows-installer.yml` — Windows `.exe`
- `.github/workflows/mobile-eas-build.yml` — IPA + APK via EAS

If you prefer Actions: push to GitHub, open the Actions tab, run the
workflow, download the artifact. Mobile requires an `EXPO_TOKEN` repo
secret.

---

## Manual builds (if you ever need them)

### Windows `.exe` on a Windows PC
See `artifacts/pilot-dashboard/ELECTRON_BUILD.md`. Short version:
```powershell
cd artifacts/pilot-dashboard
pnpm install
pnpm add -D electron@^32 electron-builder@^25 electron-updater@^6
$env:INSTALL_PASSWORD="YourMasterPasswordHere"
pnpm run electron:build
# → artifacts/pilot-dashboard/release/HawkEye-Setup-<ver>.exe
```

### IPA on macOS
```bash
cd artifacts/pilot-mobile
pnpm install
pnpm dlx expo prebuild --platform ios --clean
cd ios && pod install && cd ..
# Open ios/*.xcworkspace in Xcode and Archive
```

### APK on any OS with JDK 17
```bash
cd artifacts/pilot-mobile
pnpm install
pnpm dlx expo prebuild --platform android --clean
cd android
./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
```

---

## PWA (the web version of the PC app)
The published dashboard URL is already a PWA — users can "Install app"
from Chrome/Edge to get a desktop shortcut with offline caching, without
needing the Windows `.exe`. Use whichever distribution the squadron
prefers.

---

## Version bumps
- **PC app**: bump `version` in `artifacts/pilot-dashboard/package.json`.
- **Mobile**: bump `expo.version`, `ios.buildNumber`, and
  `android.versionCode` in `artifacts/pilot-mobile/app.json`.

Tag a release (`git tag v1.0.1 && git push --tags`) to trigger all three
builds at once.
