// Concord desktop — a thin Electron shell around the live web app, the same
// way the real Discord client works. All app logic lives on the server side
// (concord.jeffnugget.workers.dev), so the desktop app self-updates for free.
const { app, BrowserWindow, session, shell, desktopCapturer } = require("electron");

const APP_URL = process.env.CONCORD_URL || "https://concord.jeffnugget.workers.dev/";
const APP_ORIGIN = new URL(APP_URL).origin;

// Windows toast notifications need a stable AppUserModelID.
app.setAppUserModelId("com.keiththeguy.concord");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let win = null;

  const createWindow = () => {
    win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 940,
      minHeight: 560,
      backgroundColor: "#313338",
      autoHideMenuBar: true,
      title: "Concord",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });

    win.loadURL(APP_URL);

    // Links to anywhere else open in the system browser, never in-app.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(url).origin === APP_ORIGIN;
      } catch {}
      if (!sameOrigin) {
        event.preventDefault();
        if (/^https?:/i.test(url)) shell.openExternal(url);
      }
    });

    win.on("closed", () => {
      win = null;
    });
  };

  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    const ses = session.defaultSession;

    // Mic + notifications: grant only to our own origin.
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      let trusted = !details.requestingUrl;
      if (!trusted) {
        try {
          trusted = new URL(details.requestingUrl).origin === APP_ORIGIN;
        } catch {}
      }
      const allowed = ["media", "audioCapture", "notifications", "display-capture", "clipboard-sanitized-write"];
      callback(trusted && allowed.includes(permission));
    });

    // Screen share: hand getDisplayMedia the primary screen (no picker UI —
    // it's a friends app, keep it one click like the big red button it is).
    ses.setDisplayMediaRequestHandler(
      (request, callback) => {
        desktopCapturer
          .getSources({ types: ["screen"] })
          .then((sources) => {
            if (sources[0]) callback({ video: sources[0] });
            else callback({}); // cancel per Electron's Streams contract
          })
          .catch(() => callback({}));
      },
      { useSystemPicker: true } // native picker where the OS supports it
    );

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
