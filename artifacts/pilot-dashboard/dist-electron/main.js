"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Electron main process for RJAF Squadron Ops desktop app.
 *
 * This file is bundled and packaged with electron-builder to produce a real
 * Windows .exe installer (NSIS). It is NOT used in development inside Replit
 * (where the renderer is served by Vite directly).
 *
 * Build the .exe on a Windows host:
 *   1. pnpm install
 *   2. pnpm --filter @workspace/pilot-dashboard run build
 *   3. pnpm --filter @workspace/pilot-dashboard run electron:build
 *
 * See ELECTRON_BUILD.md for the full instructions including installer
 * password protection, code signing, and electron-updater configuration.
 */
const electron_1 = require("electron");
const electron_updater_1 = require("electron-updater");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const crypto = __importStar(require("crypto"));
const isDev = !electron_1.app.isPackaged;
// LAN migration safety: disable automatic updater polling by default so
// local/private builds are not silently replaced by a cloud release track.
// Operators can still enable update checks explicitly by setting this env
// var before launching the app process.
const startupAutoUpdateEnabled = String(process.env.RJAF_ENABLE_AUTO_UPDATE ?? "").trim().toLowerCase() === "1"
    || String(process.env.RJAF_ENABLE_AUTO_UPDATE ?? "").trim().toLowerCase() === "true";
// Mutable global controlled by the renderer's per-role auto-update toggle
// (Settings → Auto-Update). Defaults ON to preserve historical behaviour
// for installs that never set the preference. Updated via the
// `rjaf:setAutoUpdate` IPC handler below.
let autoUpdateEnabled = true;
let mainWindow = null;
function hardwareFingerprint() {
    const cpus = os.cpus().map(c => c.model).join("|");
    const macs = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
        const list = ifaces[name];
        if (!list)
            continue;
        for (const info of list) {
            if (info.mac && info.mac !== "00:00:00:00:00:00")
                macs.push(info.mac);
        }
    }
    const macSeed = macs.sort().join("|");
    const seed = `${os.hostname()}|${os.platform()}|${os.arch()}|${cpus}|${macSeed}|${os.totalmem()}`;
    return "FP-" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24).toUpperCase();
}
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1100,
        minHeight: 720,
        backgroundColor: "#0a1226",
        title: "RJAF Squadron Ops",
        icon: path.join(__dirname, "..", "public", "brand", "emblem.png"),
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            // sandbox:false because sandbox:true under file:// can silently
            // refuse to evaluate ES module scripts loaded by Vite (Chromium
            // treats them as cross-origin), producing a black window with no
            // error in the renderer console. The preload still uses
            // contextBridge so the security posture remains correct.
            sandbox: false,
            // Required so Chromium will evaluate Vite's ES module bundle
            // when it's loaded from a file:// URL. Without this, Electron 32+
            // blocks the script with no visible error and the window stays
            // blank. We only ever load local files (no remote content), so
            // this does not increase real attack surface.
            webSecurity: false,
        },
    });
    electron_1.Menu.setApplicationMenu(null);
    // Reveal the window only once the renderer paints its first frame so
    // operators don't see a flash of empty chrome before full-screen kicks in.
    // SAFETY NET: if `ready-to-show` doesn't fire within 4 seconds (slow
    // network blocking on Google Fonts, renderer hang, etc.), force-show
    // the window anyway so operators are never staring at an invisible
    // process that's only visible in Task Manager.
    let shown = false;
    const showOnce = (reason) => {
        if (shown || !mainWindow)
            return;
        shown = true;
        try {
            mainWindow.maximize();
            mainWindow.show();
            mainWindow.focus();
        }
        catch (e) {
            logErr("show-failed", `${reason}: ${e.message}`);
        }
    };
    mainWindow.once("ready-to-show", () => showOnce("ready-to-show"));
    // SAFETY NET: if `ready-to-show` doesn't fire within 15 seconds, force the
    // window visible so the operator never stares at an invisible process. We
    // log this to the renderer-error log for diagnostics but do NOT pop a modal
    // — on cold installs (first launch after install, Windows Defender scan,
    // SmartScreen, font fetch) the renderer routinely needs >4s to paint, and
    // showing an "error" modal that requires a click on every cold start is
    // worse than the (rare) silent-blank-window case it was guarding against.
    // The modal is still raised for *real* failures (did-fail-load,
    // render-process-gone, preload-error, missing-index, loadFile-rejected).
    setTimeout(() => {
        if (!shown) {
            logErr("ready-to-show-timeout", "Renderer did not signal ready within 15s — forcing window visible. This is usually harmless on cold installs.", { silent: true });
            showOnce("timeout");
        }
    }, 15000);
    // ── Diagnostics so we never ship another silent blue-screen ─────────
    // If the renderer fails to load (bad path, missing asset, ESM blocked
    // under file://) or crashes, write a log under userData and pop a
    // dialog so the operator can take a screenshot for support.
    const logFile = path.join(electron_1.app.getPath("userData"), "renderer-error.log");
    const logErr = (label, detail, opts) => {
        const line = `[${new Date().toISOString()}] ${label}: ${detail}\n`;
        try {
            fs.appendFileSync(logFile, line);
        }
        catch { /* best effort */ }
        // Suppress the modal + DevTools auto-open for non-fatal diagnostics
        // (e.g. ready-to-show-timeout, which only means "cold start was slow").
        // Real failures still pop the modal so Super Admin can be alerted.
        if (!isDev && !opts?.silent) {
            try {
                mainWindow?.webContents.openDevTools({ mode: "detach" });
            }
            catch { /* ignore */ }
            electron_1.dialog.showErrorBox("Hawk Eye — startup error", `${label}\n\n${detail}\n\nA log was written to:\n${logFile}\n\n` +
                `Please send this file to the Super Admin.`);
        }
    };
    // Types are loose here because electron typings aren't included in this
    // project's tsconfig (matches the rest of this file).
    mainWindow.webContents.on("did-fail-load", ((_e, code, desc, url) => {
        logErr("did-fail-load", `code=${code} url=${url} ${desc}`);
    }));
    mainWindow.webContents.on("render-process-gone", ((_e, details) => {
        logErr("render-process-gone", `reason=${details.reason} exitCode=${details.exitCode}`);
    }));
    mainWindow.webContents.on("preload-error", ((_e, preloadPath, error) => {
        logErr("preload-error", `${preloadPath}: ${error.message}`);
    }));
    if (isDev) {
        mainWindow.loadURL("http://localhost:5173/");
    }
    else {
        const indexPath = path.join(__dirname, "..", "dist", "public", "index.html");
        if (!fs.existsSync(indexPath)) {
            logErr("missing-index", `index.html not found at ${indexPath}`);
            return;
        }
        mainWindow.loadFile(indexPath).catch((err) => {
            logErr("loadFile-rejected", err?.message || String(err));
        });
    }
    // ── Navigation hardening ────────────────────────────────────────────
    // Defence-in-depth on top of the renderer-side CSP. The renderer must
    // never navigate the BrowserWindow itself away from our local
    // file:// bundle, and external links should only open in the user's
    // real browser when they are explicitly safe schemes.
    const SAFE_OPEN_SCHEMES = new Set(["https:", "http:", "mailto:"]);
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        try {
            const u = new URL(url);
            if (SAFE_OPEN_SCHEMES.has(u.protocol))
                electron_1.shell.openExternal(url);
        }
        catch { /* malformed URL — refuse silently */ }
        return { action: "deny" };
    });
    // Block ALL in-window navigation away from the local bundle. The
    // dashboard is a single-page app — every legitimate navigation is a
    // hash change, never a full page load. If anything tries to navigate
    // the window itself (clicked anchor, JS redirect, devtools) we refuse.
    mainWindow.webContents.on("will-navigate", ((evt, url) => {
        try {
            const u = new URL(url);
            // Allow same-origin file:// (our own bundle) and the dev server
            // when running unpackaged. Everything else is blocked + opened
            // externally if it's a safe scheme.
            if (u.protocol === "file:")
                return;
            if (isDev && u.origin === "http://localhost:5173")
                return;
            evt.preventDefault();
            if (SAFE_OPEN_SCHEMES.has(u.protocol))
                electron_1.shell.openExternal(url);
        }
        catch {
            evt.preventDefault();
        }
    }));
    // Block attaching new webviews — we don't use them anywhere.
    mainWindow.webContents.on("will-attach-webview", ((evt) => {
        evt.preventDefault();
    }));
}
electron_1.app.whenReady().then(() => {
    createWindow();
    // Auto-update from the public Releases repo. The repo only contains the
    // compiled installer + latest.yml — never the source code. Pilots get a
    // popup when a newer version is published.
    if (!isDev) {
        // Auto-update preference is persisted per-role in the renderer
        // (localStorage `rjaf.autoUpdate.<role>`). On launch we don't know the
        // current role yet, so the renderer pushes the resolved value back
        // through `rjaf:setAutoUpdate` once it boots. Until that arrives we
        // default to ON to preserve the prior behaviour for already-deployed
        // installs.
        electron_updater_1.autoUpdater.autoDownload = autoUpdateEnabled;
        electron_updater_1.autoUpdater.autoInstallOnAppQuit = autoUpdateEnabled;
        // Skip GitHub pre-releases. CI publishes every build as a pre-release
        // for manual testing; only when the user flips a release to "Latest"
        // on GitHub does it reach installed apps.
        electron_updater_1.autoUpdater.allowPrerelease = false;
        electron_updater_1.autoUpdater.channel = "latest";
        electron_updater_1.autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(null);
        // Pipe every update lifecycle event to the renderer so the Settings
        // page can show real progress instead of guessing. Renderer subscribes
        // via `rjafElectron.onUpdateEvent(cb)`.
        const send = (channel, payload) => {
            for (const w of electron_1.BrowserWindow.getAllWindows()) {
                if (!w.isDestroyed())
                    w.webContents.send(channel, payload);
            }
        };
        electron_updater_1.autoUpdater.on("checking-for-update", () => send("rjaf:update", { kind: "checking" }));
        electron_updater_1.autoUpdater.on("update-available", (info) => send("rjaf:update", { kind: "available", version: info.version }));
        electron_updater_1.autoUpdater.on("update-not-available", (info) => send("rjaf:update", { kind: "none", version: info.version }));
        electron_updater_1.autoUpdater.on("download-progress", (p) => send("rjaf:update", { kind: "progress", percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond }));
        electron_updater_1.autoUpdater.on("update-downloaded", (info) => send("rjaf:update", { kind: "downloaded", version: info.version }));
        electron_updater_1.autoUpdater.on("error", (err) => send("rjaf:update", { kind: "error", message: err?.message ?? String(err) }));
        if (autoUpdateEnabled && startupAutoUpdateEnabled) {
            electron_updater_1.autoUpdater.checkForUpdatesAndNotify().catch((err) => {
                // eslint-disable-next-line no-console
                console.warn("Update check failed:", err.message);
            });
        }
    }
    electron_1.app.on("activate", () => {
        if (electron_1.BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});
electron_1.app.on("window-all-closed", () => {
    if (process.platform !== "darwin")
        electron_1.app.quit();
});
electron_1.ipcMain.handle("rjaf:fingerprint", () => hardwareFingerprint());
electron_1.ipcMain.handle("rjaf:appVersion", () => electron_1.app.getVersion());
electron_1.ipcMain.handle("rjaf:offlineQueuePath", () => {
    const dir = path.join(electron_1.app.getPath("userData"), "offline-queue");
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    return dir;
});
electron_1.ipcMain.handle("rjaf:isPackaged", () => electron_1.app.isPackaged);
// Renderer-side errors (e.g. Supabase silent auth failure on launch) are
// piped here so the main process appends them to the same renderer-error.log
// file the startup-error handlers above use. Support reads that single file
// when triaging "I clicked the icon and nothing happened" reports.
electron_1.ipcMain.handle("rjaf:logRendererError", (_evt, label, detail) => {
    try {
        const logFile = path.join(electron_1.app.getPath("userData"), "renderer-error.log");
        const safeLabel = String(label ?? "renderer").slice(0, 64);
        const safeDetail = String(detail ?? "").slice(0, 4096);
        const line = `[${new Date().toISOString()}] ${safeLabel}: ${safeDetail}\n`;
        fs.appendFileSync(logFile, line);
        return true;
    }
    catch {
        return false;
    }
});
// Manual update controls. Renderer-driven so the user has a button instead
// of waiting for the silent startup poll.
electron_1.ipcMain.handle("rjaf:checkForUpdates", async () => {
    if (isDev)
        return { ok: false, reason: "dev-mode" };
    try {
        const r = await electron_updater_1.autoUpdater.checkForUpdates();
        return { ok: true, version: r?.updateInfo?.version ?? null };
    }
    catch (err) {
        return { ok: false, reason: err?.message ?? String(err) };
    }
});
electron_1.ipcMain.handle("rjaf:installUpdateNow", () => {
    // Quits all windows, runs the NSIS installer, relaunches the new build.
    setImmediate(() => electron_updater_1.autoUpdater.quitAndInstall(true, true));
    return true;
});
// Renderer-driven auto-update toggle (Settings page → per-role flag).
// Flipping this OFF disables autoDownload + autoInstallOnAppQuit so the
// app will only check/install when the operator explicitly clicks the
// manual button. ON restores the silent behaviour.
electron_1.ipcMain.handle("rjaf:setAutoUpdate", (_evt, enabled) => {
    autoUpdateEnabled = !!enabled;
    try {
        electron_updater_1.autoUpdater.autoDownload = autoUpdateEnabled;
        electron_updater_1.autoUpdater.autoInstallOnAppQuit = autoUpdateEnabled;
    }
    catch { /* not yet initialised in dev */ }
    return autoUpdateEnabled;
});
// ── Backup file-system bridge ───────────────────────────────────────────
// Lets the renderer ask the user to pick a folder, and write the encrypted
// .rjafbackup file directly to disk. Without these handlers the renderer
// falls back to a normal browser download into the user's Downloads folder.
electron_1.ipcMain.handle("rjaf:pickBackupFolder", async () => {
    if (!mainWindow)
        return null;
    const res = await electron_1.dialog.showOpenDialog(mainWindow, {
        title: "Choose backup folder",
        properties: ["openDirectory", "createDirectory"],
    });
    if (res.canceled || res.filePaths.length === 0)
        return null;
    return res.filePaths[0];
});
electron_1.ipcMain.handle("rjaf:writeBackupFile", async (_evt, folder, filename, content) => {
    if (!folder || !filename)
        throw new Error("folder and filename are required");
    // Sanity: refuse path-traversal in filename, must stay flat in the chosen folder.
    if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
        throw new Error("invalid filename");
    }
    if (!fs.existsSync(folder))
        fs.mkdirSync(folder, { recursive: true });
    const full = path.join(folder, filename);
    await fs.promises.writeFile(full, content, "utf8");
    return full;
});
