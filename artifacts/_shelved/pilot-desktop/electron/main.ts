import { app, BrowserWindow, shell } from "electron";
import * as path from "path";

// URL of the deployed Hawk Eye web dashboard. Injected at build
// time via electron-builder's env var expansion, or falls back to the
// Replit-hosted deployment. Ops officers never edit this directly.
const DASHBOARD_URL = process.env.DASHBOARD_URL
  || "https://flight-hour-tracker.replit.app/";

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: "Hawk Eye",
    autoHideMenuBar: true,
    backgroundColor: "#0b0f14",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.setMenuBarVisibility(false);

  // Open external links (mailto:, https://external…) in the default browser
  // instead of swallowing them inside the Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.loadURL(DASHBOARD_URL).catch((err) => {
    console.error("Failed to load dashboard URL:", err);
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
