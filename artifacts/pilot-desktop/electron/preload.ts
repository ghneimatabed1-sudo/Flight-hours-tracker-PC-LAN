import { contextBridge, ipcRenderer } from "electron";
import { createHash } from "crypto";
import * as os from "os";

// Stable per-machine fingerprint: SHA-256 of hostname + primary MAC + cpu model
// + platform. Not a security boundary — the license server is the real gate —
// but it lets the dashboard bind a license key to a specific PC so a single
// key can't be shared across five computers.
function computeFingerprint(): string {
  try {
    const nets = os.networkInterfaces();
    const macs: string[] = [];
    for (const name of Object.keys(nets)) {
      for (const n of nets[name] ?? []) {
        if (n.mac && n.mac !== "00:00:00:00:00:00" && !n.internal) {
          macs.push(n.mac);
        }
      }
    }
    macs.sort();
    const cpu = os.cpus()[0]?.model ?? "unknown-cpu";
    const seed = [os.hostname(), macs.join(","), cpu, os.platform(), os.arch()].join("|");
    const hex = createHash("sha256").update(seed).digest("hex").toUpperCase();
    return `FP-${hex.slice(0, 8)}-${hex.slice(8, 12)}`;
  } catch {
    return "FP-UNKNOWN-0000";
  }
}

contextBridge.exposeInMainWorld("rjafElectron", {
  hardwareFingerprint: async () => computeFingerprint(),
  isPackaged: async () => {
    try {
      return await ipcRenderer.invoke("app:isPackaged");
    } catch {
      return true;
    }
  },
});
