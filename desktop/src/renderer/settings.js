"use strict";

const api = window.siliconflower;
const $ = (id) => document.getElementById(id);
const FIELDS = ["baseURL", "apiKey", "model", "reasoning", "system", "mcp"];

function readForm() {
  return Object.fromEntries(FIELDS.map((field) => [field, $(field).value]));
}

function showErrors(errors = {}) {
  let first = null;
  for (const node of document.querySelectorAll(".field-error")) {
    const message = errors[node.dataset.for];
    node.hidden = !message;
    node.textContent = message ?? "";
    if (message) first ??= node.dataset.for;
  }
  if (errors.mcp) $("advanced").open = true;
  if (first) $(first).focus();
}

function showResult(ok, message) {
  const result = $("result");
  result.hidden = !message;
  result.dataset.ok = String(ok);
  result.textContent = message ?? "";
}

function setBusy(busy) {
  $("test").disabled = busy;
  $("save").disabled = busy;
}

function syncPreset() {
  const url = $("baseURL").value.trim().replace(/\/+$/, "");
  const known = [...$("preset").options].some((option) => option.value === url && url);
  $("preset").value = known ? url : "";
}

/** Providers offer different levels. Keeps the choice when the new list still has it. */
async function fillReasoning(wanted) {
  const choices = await api.reasoningChoices($("baseURL").value);
  const select = $("reasoning");
  select.replaceChildren(...choices.map(({ value, label }) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));
  select.value = choices.some((choice) => choice.value === wanted) ? wanted : choices.at(-1).value;
}

$("preset").addEventListener("change", () => {
  if ($("preset").value) $("baseURL").value = $("preset").value;
  else $("baseURL").focus();
  void fillReasoning($("reasoning").value);
});

$("baseURL").addEventListener("change", () => {
  syncPreset();
  void fillReasoning($("reasoning").value);
});

$("test").addEventListener("click", async () => {
  setBusy(true);
  showErrors();
  showResult(true, "Testando...");
  try {
    const { ok, message } = await api.testSettings(readForm());
    showResult(ok, message);
  } catch {
    showResult(false, "Não consegui fazer o teste.");
  } finally {
    setBusy(false);
  }
});

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(true);
  showResult(true, "");
  try {
    const { ok, errors } = await api.saveSettings(readForm());
    if (!ok) showErrors(errors);
    else showErrors();
  } catch {
    showResult(false, "Não consegui salvar a configuração.");
  } finally {
    setBusy(false);
  }
});

void (async () => {
  const settings = await api.getSettings();
  const firstRun = !settings.keyHint && !settings.baseURL;
  $("welcome").hidden = !firstRun;
  if (firstRun) $("title").textContent = "Bem-vindo ao Siliconflower";
  $("baseURL").value = settings.baseURL || $("preset").value;
  $("model").value = settings.model;
  $("system").value = settings.system;
  $("mcp").value = settings.mcp;
  $("advanced").open = Boolean(settings.system || settings.mcp);
  $("apiKey").placeholder = settings.keyHint ? `Salva: ${settings.keyHint}` : "Cole aqui a sua chave";
  $("key-help").textContent = settings.keyHint ? "Deixe em branco para manter a chave salva." : "Fica guardada só neste computador.";
  if (settings.envOverrides.length) {
    $("env-note").hidden = false;
    $("env-note").textContent = `Variáveis de ambiente ativas têm prioridade sobre o que está salvo aqui: ${settings.envOverrides.join(", ")}.`;
  }
  syncPreset();
  await fillReasoning(settings.reasoning);
  $(firstRun ? "apiKey" : "model").focus();
})();
