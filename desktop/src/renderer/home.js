"use strict";

const api = window.siliconflower;
const pick = document.getElementById("pick");
const statusLine = document.getElementById("status");
const list = document.getElementById("recents");
const empty = document.getElementById("empty");

function setBusy(busy) {
  statusLine.hidden = !busy;
  for (const button of document.querySelectorAll("button")) {
    button.disabled = busy || button.dataset.missing === "true";
  }
}

async function run(action) {
  setBusy(true);
  try {
    await action();
  } finally {
    setBusy(false);
  }
  render(await api.listRecents());
}

function render(recents) {
  empty.hidden = recents.length > 0;
  list.replaceChildren(...recents.map((project) => {
    const item = document.createElement("li");

    const open = document.createElement("button");
    open.type = "button";
    open.className = "recent";
    open.title = project.path;
    open.disabled = !project.exists;
    open.dataset.missing = String(!project.exists);
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = project.name;
    const path = document.createElement("span");
    path.className = "path";
    path.textContent = project.path;
    open.append(name, path);
    if (!project.exists) {
      const missing = document.createElement("span");
      missing.className = "missing";
      missing.textContent = "Pasta não encontrada";
      open.append(missing);
    }
    open.addEventListener("click", () => void run(() => api.openRecent(project.path)));

    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "forget";
    forget.textContent = "×";
    forget.title = "Tirar da lista";
    forget.setAttribute("aria-label", `Tirar ${project.name} da lista`);
    forget.addEventListener("click", async () => render(await api.forgetRecent(project.path)));

    item.append(open, forget);
    return item;
  }));
}

pick.addEventListener("click", () => void run(() => api.pickFolder()));
void api.listRecents().then(render);
