// Shoal's desktop app: starts the Shoal server inside Electron's main process
// (or uses the one already running on port 4000) and opens it in a window.
// Works on Windows, macOS and Linux.
import { app, BrowserWindow, Menu, shell, dialog, session } from "electron";
import { createServer } from "node:net";
import { existsSync, mkdirSync, watch } from "node:fs";
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

// GitHub sign-in runs in a small window of the app's own, so the app can
// close it the moment GitHub sends it back to Shoal's "you're signed in"
// page (/signed-in), then open the platform; no browser tab is left behind.
// Google, Apple and company single sign-on refuse to sign in inside an app
// window (a blank "Redirecting to Google" page), so if sign-in leaves GitHub
// for one of them, the window closes and sign-in continues in the system
// browser instead (signInInBrowser). Either way the Shoal server keeps the
// sign-in.
const isSignIn = (url) => /\/api\/auth\/github(\?|$)/.test(url) || /^https:\/\/github\.com\/login/.test(url);
const SIGN_IN_URL = () => `${baseUrl}/api/auth/github?return=${encodeURIComponent("/signed-in")}`;
let signInWindow = null;
let waitingForSignIn = null;

function signIn() {
  if (signInWindow) return signInWindow.focus();
  clearInterval(waitingForSignIn);
  signInWindow = new BrowserWindow({
    width: 520,
    height: 720,
    parent: mainWindow ?? undefined,
    modal: process.platform !== "darwin" && Boolean(mainWindow),
    title: "Sign in with GitHub",
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  const win = signInWindow;
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => (signInWindow = null));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  // GitHub and Shoal stay in the window; anything else is a single sign-on
  // provider, which only works in the browser.
  const follow = (event, url) => {
    if (isShoalHost(url) && new URL(url).pathname === "/signed-in") {
      if (/[?&]github_error=/.test(url)) return; // the page explains; the user closes it
      event.preventDefault();
      win.close();
      return openPlatform();
    }
    if (isShoalHost(url) || /^https:\/\/github\.com\//.test(url)) return;
    event.preventDefault();
    win.close();
    signInInBrowser();
  };
  win.webContents.on("will-navigate", follow);
  win.webContents.on("will-redirect", follow);
  win.loadURL(SIGN_IN_URL());
}

// Shoal itself, however GitHub's callback names it: this app's server,
// localhost or 127.0.0.1 (the OAuth App may be registered with either), or
// SHOAL_PUBLIC_URL.
function isShoalHost(url) {
  try {
    const { origin, hostname } = new URL(url);
    return isAppUrl(url) || hostname === "localhost" || hostname === "127.0.0.1" || (process.env.SHOAL_PUBLIC_URL && origin === new URL(process.env.SHOAL_PUBLIC_URL).origin);
  } catch {
    return false;
  }
}

function openPlatform() {
  if (!mainWindow) createWindow();
  mainWindow.loadURL(`${baseUrl}/app`);
  mainWindow.show();
  mainWindow.focus();
  app.focus({ steal: true });
}

// The browser fallback: it ends on /signed-in too, while the app checks
// /api/me until someone is signed in, then opens the platform.
function signInInBrowser() {
  shell.openExternal(SIGN_IN_URL());
  clearInterval(waitingForSignIn);
  const started = Date.now();
  waitingForSignIn = setInterval(async () => {
    if (Date.now() - started > 10 * 60_000) return clearInterval(waitingForSignIn);
    try {
      const me = await (await fetch(`${baseUrl}/api/me`)).json();
      if (!me.viewer) return;
      clearInterval(waitingForSignIn);
      openPlatform();
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
    if (isSignIn(url)) signIn();
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

// In development, rebuilding the website (npm run build) reloads the window,
// so the app always shows the current web/dist.
function reloadOnRebuild() {
  const dist = path.join(root, "web", "dist");
  if (app.isPackaged || !existsSync(dist)) return;
  let timer = null;
  watch(dist, (_e, file) => {
    if (!/\.html$/.test(file ?? "")) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const contents = mainWindow?.webContents;
      if (contents && isAppUrl(contents.getURL())) contents.reloadIgnoringCache();
    }, 500);
  });
}

app.whenReady().then(async () => {
  // Never show pages from an older build of the website.
  await session.defaultSession.clearCache();
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
// The sign-in window handles its own navigation (signIn).
app.on("web-contents-created", (_e, contents) => {
  contents.on("will-navigate", (event, url) => {
    if (contents === signInWindow?.webContents) return;
    if (isSignIn(url)) {
      event.preventDefault();
      return signIn();
    }
    if (isAppUrl(url) || url.startsWith("file:") || /^https:\/\/(github\.com|checkout\.stripe\.com)\//.test(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  });
});
