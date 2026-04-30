import { contextBridge, ipcRenderer } from "electron";

export type UpdateEvent =
  | { kind: "checking" }
  | { kind: "available"; version: string }
  | { kind: "none"; version?: string }
  | { kind: "progress"; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { kind: "downloaded"; version: string }
  | { kind: "error"; message: string };

const api = {
  hardwareFingerprint: () => ipcRenderer.invoke("rjaf:fingerprint"),
  appVersion: () => ipcRenderer.invoke("rjaf:appVersion"),
  offlineQueuePath: () => ipcRenderer.invoke("rjaf:offlineQueuePath"),
  isPackaged: () => ipcRenderer.invoke("rjaf:isPackaged"),
  pickBackupFolder: (): Promise<string | null> =>
    ipcRenderer.invoke("rjaf:pickBackupFolder"),
  writeBackupFile: (folder: string, filename: string, content: string): Promise<string> =>
    ipcRenderer.invoke("rjaf:writeBackupFile", folder, filename, content),
  // Auto-update controls. Returns { ok, version? } / { ok:false, reason }.
  checkForUpdates: (): Promise<{ ok: boolean; version?: string | null; reason?: string }> =>
    ipcRenderer.invoke("rjaf:checkForUpdates"),
  installUpdateNow: (): Promise<boolean> => ipcRenderer.invoke("rjaf:installUpdateNow"),
  // Auto-update preference (per-role, set from the Settings page). When
  // OFF, the Electron main process skips the silent startup check and
  // disables autoUpdater.autoDownload so updates only happen when the
  // operator clicks "Check for updates" manually.
  setAutoUpdate: (enabled: boolean): Promise<boolean> =>
    ipcRenderer.invoke("rjaf:setAutoUpdate", !!enabled),
  // Append a single line to the packaged app's renderer-error.log. Used by
  // the renderer to surface non-fatal failures (e.g. Supabase silent auth
  // failing on launch) to support without a full crash dialog.
  logRendererError: (label: string, detail: string): Promise<boolean> =>
    ipcRenderer.invoke("rjaf:logRendererError", label, detail),
  onUpdateEvent: (cb: (e: UpdateEvent) => void): (() => void) => {
    const listener = (_: unknown, payload: UpdateEvent) => cb(payload);
    ipcRenderer.on("rjaf:update", listener);
    return () => ipcRenderer.removeListener("rjaf:update", listener);
  },
};

contextBridge.exposeInMainWorld("rjafElectron", api);
