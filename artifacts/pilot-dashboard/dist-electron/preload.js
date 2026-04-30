"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const api = {
    hardwareFingerprint: () => electron_1.ipcRenderer.invoke("rjaf:fingerprint"),
    appVersion: () => electron_1.ipcRenderer.invoke("rjaf:appVersion"),
    offlineQueuePath: () => electron_1.ipcRenderer.invoke("rjaf:offlineQueuePath"),
    isPackaged: () => electron_1.ipcRenderer.invoke("rjaf:isPackaged"),
    pickBackupFolder: () => electron_1.ipcRenderer.invoke("rjaf:pickBackupFolder"),
    writeBackupFile: (folder, filename, content) => electron_1.ipcRenderer.invoke("rjaf:writeBackupFile", folder, filename, content),
    // Auto-update controls. Returns { ok, version? } / { ok:false, reason }.
    checkForUpdates: () => electron_1.ipcRenderer.invoke("rjaf:checkForUpdates"),
    installUpdateNow: () => electron_1.ipcRenderer.invoke("rjaf:installUpdateNow"),
    // Auto-update preference (per-role, set from the Settings page). When
    // OFF, the Electron main process skips the silent startup check and
    // disables autoUpdater.autoDownload so updates only happen when the
    // operator clicks "Check for updates" manually.
    setAutoUpdate: (enabled) => electron_1.ipcRenderer.invoke("rjaf:setAutoUpdate", !!enabled),
    // Append a single line to the packaged app's renderer-error.log. Used by
    // the renderer to surface non-fatal failures (e.g. Supabase silent auth
    // failing on launch) to support without a full crash dialog.
    logRendererError: (label, detail) => electron_1.ipcRenderer.invoke("rjaf:logRendererError", label, detail),
    onUpdateEvent: (cb) => {
        const listener = (_, payload) => cb(payload);
        electron_1.ipcRenderer.on("rjaf:update", listener);
        return () => electron_1.ipcRenderer.removeListener("rjaf:update", listener);
    },
};
electron_1.contextBridge.exposeInMainWorld("rjafElectron", api);
