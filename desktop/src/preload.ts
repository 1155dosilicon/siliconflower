import { contextBridge, ipcRenderer } from "electron";

// Only local pages (start screen and settings) get this bridge. Project windows show text
// from the model and from repositories, and have no preload at all. The main process
// checks which window may call each channel.
contextBridge.exposeInMainWorld("siliconflower", {
  listRecents: () => ipcRenderer.invoke("recents:list"),
  pickFolder: () => ipcRenderer.invoke("project:pick"),
  openRecent: (path: string) => ipcRenderer.invoke("project:open-recent", path),
  forgetRecent: (path: string) => ipcRenderer.invoke("recents:forget", path),
  openSettings: () => ipcRenderer.invoke("settings:open"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (form: unknown) => ipcRenderer.invoke("settings:save", form),
  testSettings: (form: unknown) => ipcRenderer.invoke("settings:test", form),
  reasoningChoices: (baseURL: string) => ipcRenderer.invoke("settings:reasoning", baseURL),
});
