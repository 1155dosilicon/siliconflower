import { contextBridge, ipcRenderer } from "electron";

// Only the start screen, a local page, gets this bridge. Project windows show text from
// the model and from repositories, and have no preload at all.
contextBridge.exposeInMainWorld("siliconflower", {
  listRecents: () => ipcRenderer.invoke("recents:list"),
  pickFolder: () => ipcRenderer.invoke("project:pick"),
  openRecent: (path: string) => ipcRenderer.invoke("project:open-recent", path),
  forgetRecent: (path: string) => ipcRenderer.invoke("recents:forget", path),
});
