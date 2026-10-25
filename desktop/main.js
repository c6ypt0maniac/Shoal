// Shoal's desktop app: starts the Shoal server inside Electron's main process
// (or uses the one already running on port 4000) and opens it in a window.
// Works on Windows, macOS and Linux.
import { app, BrowserWindow, Menu, shell, dialog } from "electron";
import { createServer } from "node:net";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Packaged, the server and the built website sit in resources/ (see
// extraResources in package.json); in development, next to this folder.
const root = app.isPackaged ? process.resourcesPath : path.resolve(here, "..");
const SERVER_ENTRY = path.join(root, "server", "src", "index.js");
// GitHub sign-in only returns to the callback registered on the OAuth App,
// so prefer the same port as `npm start`.
const PREFERRED_PORT = Number(process.env.PORT) || 4000;

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow = null;
let baseUrl = null;

const portFree = (port) =>
  new Promise((resolve) => {
    const probe = createServer().once("error", () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });

const anyFreePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer().once("error", reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

// Keys and settings: the user's own .env in the app's data folder, and in
// development also server/.env, the file `npm start` reads.
function loadEnv(dataDir) {
  const files = [path.join(dataDir, ".env"), !app.isPackaged && path.join(root, "server", ".env")].filter(Boolean);
  for (const file of files) if (existsSync(file)) process.loadEnvFile(file);
}

async function startServer() {
  const dataDir = app.getPath("userData");
  mkdirSync(dataDir, { recursive: true });
  loadEnv(dataDir);
  // The install folder may be read-only, so state and cloned repos live in
  // the per-user data folder instead of next to the server code.
  process.env.SHOAL_DATA_DIR ??= path.join(dataDir, "data");
  process.env.SHOAL_WORKSPACE ??= path.join(dataDir, "workspace");

  // A Shoal server already on the preferred port (e.g. `npm start`): use it.
  // GitHub sign-in always returns to that port, so a second server on
  // another port would never see the sign-in finish.
  if (!(await portFree(PREFERRED_PORT)) && (await isShoal(`http://localhost:${PREFERRED_PORT}`))) {
    baseUrl = `http://localhost:${PREFERRED_PORT}`;
    console.log(`Shoal desktop: using the Shoal server already running on ${baseUrl}`);
    return;
  }
  const port = (await portFree(PREFERRED_PORT)) ? PREFERRED_PORT : await anyFreePort();
  if (port !== PREFERRED_PORT) console.warn(`Port ${PREFERRED_PORT} is in use; Shoal is on ${port}, so GitHub sign-in may not return here.`);
  process.env.PORT = String(port);
  process.env.SHOAL_PUBLIC_URL ??= `http://localhost:${port}`;
  baseUrl = `http://localhost:${port}`;

  await import(pathToFileURL(SERVER_ENTRY).href);
  await waitForHealth();
  console.log(`Shoal desktop: ${baseUrl}/app`);
}

// Whether a Shoal server answers at this address.
async function isShoal(url) {
  try {
    const health = await (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) })).json();
    return health?.ok === true && "integrations" in health;
  } catch {
    return false;
  }
}

// The server starts listening after its import finishes; wait until it answers.
async function waitForHealth(timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`The Shoal server didn't answer on ${baseUrl} within ${timeoutMs / 1000}s`);
}

const isAppUrl = (url) => baseUrl && url.startsWith(baseUrl);

// GitHub sign-in runs in the system browser: Google (and the other single
// sign-on providers GitHub hands off to) refuse to sign in inside an app
// window, which leaves a blank "Redirecting to Google" page. The browser
// signs in against the same Shoal server, which keeps the sign-in, and ends
// on its "you're signed in" page (/signed-in), not the website. Meanwhile
// the window checks /api/me until someone is signed in, then opens the platform.
const isSignIn = (url) => /\/api\/auth\/github(\?|$)/.test(url) || /^https:\/\/github\.com\/login/.test(url);
let waitingForSignIn = null;

function signInInBrowser() {
  shell.openExternal(`${baseUrl}/api/auth/github?return=${encodeURIComponent("/signed-in")}`);
  clearInterval(waitingForSignIn);
  const started = Date.now();
  waitingForSignIn = setInterval(async () => {
    if (Date.now() - started > 10 * 60_000) return clearInterval(waitingForSignIn);
    try {
      const me = await (await fetch(`${baseUrl}/api/me`)).json();
      if (!me.viewer) return;
      clearInterval(waitingForSignIn);
      if (!mainWindow) createWindow();
      mainWindow.loadURL(`${baseUrl}/app`);
      mainWindow.show();
      mainWindow.focus();
      app.focus({ steal: true });
    } catch {}
  }, 2000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: "Shoal",
    backgroundColor: "#d9e3dc",
    show: false,
    webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true },
  });
  mainWindow.loadFile(path.join(here, "splash.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());

  // Links meant for a new tab (PRs, CLI sign-in pages) open in the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSignIn(url)) signInInBrowser();
    else if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => (mainWindow = null));
}

function buildMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "Go",
      submenu: [
        { label: "Platform", accelerator: "CmdOrCtrl+1", click: () => mainWindow?.loadURL(`${baseUrl}/app`) },
        { label: "Home", accelerator: "CmdOrCtrl+2", click: () => mainWindow?.loadURL(`${baseUrl}/`) },
        { type: "separator" },
        { label: "Back", accelerator: process.platform === "darwin" ? "Cmd+[" : "Alt+Left", click: () => mainWindow?.webContents.navigationHistory.goBack() },
        { label: "Forward", accelerator: process.platform === "darwin" ? "Cmd+]" : "Alt+Right", click: () => mainWindow?.webContents.navigationHistory.goForward() },
        { type: "separator" },
        { label: "Open in Browser", click: () => baseUrl && shell.openExternal(mainWindow?.webContents.getURL() || baseUrl) },
        { label: "Open Data Folder", click: () => shell.openPath(app.getPath("userData")) },
      ],
    },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  buildMenu();
  createWindow();
  try {
    await startServer();
    // Opens on the home page; Go -> Platform (Cmd/Ctrl+1) goes to the platform.
    mainWindow?.loadURL(`${baseUrl}/`);
  } catch (err) {
    dialog.showErrorBox("Shoal couldn't start", err.message);
    app.quit();
  }
  // macOS keeps apps running with no windows; clicking the dock icon reopens one.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length) return;
    createWindow();
    if (baseUrl) mainWindow.loadURL(`${baseUrl}/`);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Anything that isn't the app itself, GitHub sign-in or Stripe checkout opens in the browser.
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-navigate", (event, url) => {
    if (isSignIn(url)) {
      event.preventDefault();
      return signInInBrowser();
    }
    if (isAppUrl(url) || url.startsWith("file:") || /^https:\/\/(github\.com|checkout\.stripe\.com)\//.test(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  });
});
