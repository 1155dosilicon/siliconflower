"use strict";

const api = window.siliconflower;
const pick = document.getElementById("pick");
const statusLine = document.getElementById("status");
const list = document.getElementById("recents");
const empty = document.getElementById("empty");

function setBusy(busy) {
  statusLine.hidden = !busy;
  // Only the start screen: the buttons of the diagnosis follow its own run.
  for (const button of document.querySelectorAll("main button")) {
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

/* ----------------------------------- Diagnosis -----------------------------------
 * Same report and same look as the button of the browser interface (src/gui/client/app.js):
 * here the main process runs the agent's `doctor` over the recent projects. */

const DOCTOR_MARKS = { ok: "✓", warn: "!", fail: "✕", skip: "–" };
const DOCTOR_STATUS_NAMES = { ok: "certo", warn: "aviso", fail: "problema", skip: "não verificado" };
const doctorDialog = document.getElementById("doctor-dialog");
const doctorFix = document.getElementById("doctor-fix");
const doctorAgain = document.getElementById("doctor-again");
/** A run is out: the checks start a shell and call the provider, so one at a time. */
let doctorRunning = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function doctorCheckNode(check) {
  const item = el("li", "doctor-check");
  item.dataset.status = check.status;
  const mark = el("span", "doctor-mark", DOCTOR_MARKS[check.status] ?? "?");
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", DOCTOR_STATUS_NAMES[check.status] ?? "");
  mark.title = DOCTOR_STATUS_NAMES[check.status] ?? "";
  const body = el("div", "doctor-body");
  // Paths, provider messages and log lines: always as text, never as markup.
  body.appendChild(el("div")).append(el("span", "doctor-title", `${check.title}: `), el("span", "doctor-detail", check.detail));
  if (check.items?.length) {
    const entries = body.appendChild(el("ul", "doctor-items"));
    for (const entry of check.items) entries.append(el("li", "", entry));
  }
  if (check.fixed) body.append(el("div", "doctor-fixed", `Corrigido: ${check.fixed}`));
  if (check.hint) body.append(el("div", "doctor-hint", `Como resolver: ${check.hint}`));
  item.append(mark, body);
  return item;
}

function showDoctor({ summary, tone, checks = [], fixable = false }) {
  const node = document.getElementById("doctor-summary");
  node.textContent = summary;
  node.dataset.tone = tone;
  document.getElementById("doctor-list").replaceChildren(...checks.map(doctorCheckNode));
  doctorFix.hidden = !fixable;
  doctorFix.disabled = doctorRunning;
  doctorAgain.disabled = doctorRunning;
}

async function requestDoctor(fix = false) {
  if (doctorRunning) return; // the answer on its way fills the dialog
  doctorRunning = true;
  showDoctor({ summary: fix ? "Corrigindo e verificando de novo..." : "Verificando... pode levar alguns segundos.", tone: "busy" });
  let result;
  try {
    result = await api.runDoctor(fix);
  } catch {
    result = undefined;
  }
  doctorRunning = false;
  if (!result?.report) {
    showDoctor({ summary: result?.error ?? "Não consegui rodar o diagnóstico.", tone: "bad" });
    return;
  }
  const { checks, ok } = result.report;
  const tone = !ok ? "bad" : checks.some((check) => check.status === "warn") ? "warn" : "ok";
  showDoctor({ summary: result.summary, tone, checks, fixable: checks.some((check) => check.fixable) });
}

document.getElementById("doctor").addEventListener("click", () => {
  doctorDialog.showModal();
  void requestDoctor();
});
doctorAgain.addEventListener("click", () => void requestDoctor());
doctorFix.addEventListener("click", () => void requestDoctor(true));
document.getElementById("doctor-close").addEventListener("click", () => doctorDialog.close());
// A click outside the box lands on the dialog itself (its backdrop).
doctorDialog.addEventListener("click", (event) => {
  if (event.target === doctorDialog) doctorDialog.close();
});

pick.addEventListener("click", () => void run(() => api.pickFolder()));
document.getElementById("settings").addEventListener("click", () => void api.openSettings());
void api.listRecents().then(render);
