# Code-signing decision for `HawkEye-Setup.exe`

**Decision date:** 2026-04-30
**Decided by:** project lead (during Task #405 deep static review)
**Status:** ship UNSIGNED for the LAN / air-gapped target;
revisit if a customer site requires signed binaries.

---

## Context

Hawk Eye runs on private squadron / wing / base LANs that are by
design **not connected to the public internet**. The installer
is delivered to operators on USB sticks or via internal LAN
copy. There is no auto-update channel; upgrades are deliberate,
operator-driven re-installs of a new `.exe` from the same out-of-
band channel.

The user base is small (low double-digit PCs per deployment),
known to one another, and trained on operator procedures. The
threat model is "an operator has a USB with the official .exe
on it" — not "a user downloaded an .exe from the internet".

## Why unsigned, for now

1. **No internet on the target PC.** Authenticode validation
   that calls back to a CRL/OCSP responder doesn't help (and
   often *hurts* — startup latency on disconnected networks)
   because the cert validator can't reach the CA.
2. **Cost of a real Authenticode cert is non-trivial.**
   - DigiCert / Sectigo OV: ~USD 400/year.
   - DigiCert / Sectigo EV (which is what actually clears
     SmartScreen reputation immediately): ~USD 600-800/year +
     hardware token.
   - Justifiable when a deployment exceeds ~50 PCs or when a
     customer's procurement requires it, but not before.
3. **Operator trust path already exists.** The .exe is
   transferred on USB sticks the operator's IT support officer
   prepared. The same officer also runs the install. There is
   no "stranger sent me this" step that signing would protect.
4. **SmartScreen is dismissable.** On a fresh Windows 11 PC
   with internet briefly available, SmartScreen flags the .exe
   on first run with "Windows protected your PC". The dismissal
   path is documented and one-click ("More info" → "Run anyway").
   See § Operator instructions below.

## What unsigned costs us

| Friction                                  | Mitigation in this repo |
|-------------------------------------------|-------------------------|
| SmartScreen "Run anyway" prompt on first run on internet-connected PCs | Documented in `OPERATOR-RUNBOOK.md` § 1 |
| UAC dialog shows publisher as "Unknown publisher" instead of "Hawk Eye" | Documented; operator confirms via the .exe SHA-256 they were given |
| AV products may quarantine on first run | Operator pre-allowlists `HawkEye-Setup.exe` SHA-256 in the AV console; `installer/test-vm/dryrun-evidence/<date>/build-host/iscc-output.sha256` is the published value |
| Some Group Policy environments block unsigned installers entirely | Customers in this category trigger the "signed build" branch (see below) |

## When to switch to signed

Switch to signing as soon as **any** of:

- a customer's IT requires it in writing,
- the deployment grows past ~50 PCs (where individual SmartScreen
  dismissals become a support burden),
- we add an over-the-network update channel (then signing is
  required for the trust chain).

## How to add signing without changing `HawkEye.iss`

When the time comes, the change is local to the build host:

1. Acquire an EV code-signing certificate (DigiCert/Sectigo) and
   its hardware token (USB HSM).
2. Install the SafeNet drivers + the cert on the build host.
3. Configure Inno Setup's `[Setup]` block to sign during
   compilation by appending the following lines to
   `installer/HawkEye.iss` (don't commit them — keep them in a
   build-host-local `installer/HawkEye.signed.iss` overlay):

   ```
   SignTool=signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /sha1 <thumbprint> $f
   SignedUninstaller=yes
   ```
   And register the SignTool in Inno (Tools → Configure Sign
   Tools…) named `signtool` with command:
   ```
   "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe" sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /sha1 <thumbprint> $f
   ```
4. Re-build with `installer/build.ps1` — `iscc` will sign both
   the installer and the embedded `unins000.exe`.
5. Verify with `signtool verify /pa /v installer\output\HawkEye-Setup.exe`.

The `.iss` file, the script-shims, and `scripts/lan-host/*.ps1`
do not need changes for signing. Only the build-host overlay
and the SignTool registration differ.

## Operator instructions for unsigned `.exe`

Add the following text under `OPERATOR-RUNBOOK.md` § 1
(an appendix is added in the same commit as this document):

> The first time you double-click `HawkEye-Setup.exe`, Windows
> may show a blue "**Windows protected your PC**" panel
> ("SmartScreen filter prevented an unrecognised app from
> starting"). This is expected — the installer is not
> code-signed for our small LAN-only deployment. Verify the
> file's SHA-256 matches the value your IT officer gave you, then
> click **More info** → **Run anyway**. The User Account Control
> prompt that follows will show "Unknown publisher" — this is
> also expected; click **Yes** if you trust the SHA-256.

## Tracking

If/when the decision flips to signed, replace this document with
the new policy and add a row to the deployment changelog:
"YYYY-MM-DD: switched HawkEye-Setup.exe to code-signed builds
(thumbprint <…>, valid until <…>)."
