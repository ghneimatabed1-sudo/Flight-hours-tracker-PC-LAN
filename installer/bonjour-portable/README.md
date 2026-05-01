# installer/bonjour-portable

Drop the redistributable Apple Bonjour binaries here so the Hawk Eye
installer can ship them alongside the rest of the app. Without them,
`_hawkeye._tcp` magic LAN auto-discovery silently does nothing on
Hawk Eye PCs that don't already have Bonjour Print Services
installed — operators have to fall back to manual pairing via
`setup-aggregator.ps1`.

## Files expected in this directory

```
installer/bonjour-portable/
  ├── dns-sd.exe          (x64 unless your fleet is mixed; mDNSResponder ships both)
  ├── dnssd.dll
  ├── mdnsNSP.dll         (some setups use mdnsNSPLockdown.dll instead — keep both if you have them)
  ├── jdns_sd.dll         (only if any peer JVM tooling needs it; harmless to ship)
  └── LICENSE.txt         (Apple Public Source License 2.0 — REQUIRED, see below)
```

`build.ps1` will copy this directory verbatim into the staged
installer payload, and `installer/HawkEye.iss` lays it down at
`{app}\bonjour-portable\` (i.e. `C:\Program Files\HawkEye\bonjour-portable\`)
on the target PC. `scripts/lan-host/register-mdns.ps1` resolves
`dns-sd.exe` from there as a final fallback after PATH and the
default Bonjour install dirs.

## Where to obtain the binaries

Apple does **not** ship a stand-alone Bonjour SDK in 2026, but the
files above are bundled inside two redistributable Apple installers:

1. **Bonjour Print Services for Windows 2.0.2** —
   <https://support.apple.com/kb/dl999>. Install on a clean dev VM,
   copy `dns-sd.exe`, `dnssd.dll`, `mdnsNSP.dll` from
   `C:\Program Files\Bonjour\` into this directory.
2. The **Bonjour SDK for Windows** (Apple Developer downloads,
   requires a free Apple ID). Ships the same three binaries plus
   the import library — extract the same three files.

Either source is acceptable; the binaries are byte-identical for
the same Bonjour version.

## License obligations

These binaries are licensed under the **Apple Public Source License
2.0** (mDNSResponder is open source). Redistribution is permitted
provided the licence text accompanies the binaries on the target PC.
**Always copy the matching `LICENSE.txt` into this directory** before
running `build.ps1`. The Hawk Eye installer copies it to
`{app}\bonjour-portable\LICENSE.txt` so `Programs and Features` →
*Hawk Eye* → *Open install folder* surfaces it for any audit.

## Verifying the bundle on a target PC

After install, on a Hawk Eye PC:

```powershell
& "C:\Program Files\HawkEye\bonjour-portable\dns-sd.exe" -V
```

…should print the Bonjour version. Then:

```powershell
& "C:\Program Files\HawkEye\bonjour-portable\dns-sd.exe" -B _hawkeye._tcp
```

…should list every Hawk Eye PC currently advertising on this LAN
segment (Ctrl-C to exit).

## What happens if this directory is empty?

`installer/HawkEye.iss` uses `skipifsourcedoesntexist` for this
payload, so the installer still builds. On the target PC, the
register-mdns.ps1 supervisor logs a clear `dns-sd.exe not found`
warning and exits cleanly without touching the scheduled task.
First-launch pairing on aggregators / viewers degrades gracefully
to the "LAN auto-discovery is offline" empty state, and the operator
can still complete the pairing manually.
