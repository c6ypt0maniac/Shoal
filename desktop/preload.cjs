// Lets the website tell it's running in the desktop app (e.g. to hide
// "download the app" prompts). Nothing else is exposed to the page.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("shoalDesktop", { platform: process.platform });
