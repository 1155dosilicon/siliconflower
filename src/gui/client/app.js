import { highlightTokens, parseMarkdown } from "/markdown.js";

const $ = (id) => document.getElementById(id);
const MAX_RECONNECT_ATTEMPTS = 20;
// gui/server.ts closes the connection above this size (MAX_MESSAGE_BYTES), and the text was lost.
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
// Attachments go in the message, as Base64 (a third larger than the file).
const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
// The formats of services/media.ts: checked here so a wrong file never costs the typed message.
const ATTACHMENT_TYPES = /\.(jpe?g|png|gif|webp|bmp|mp3|wav|flac|m4a|ogg|mp4|mov|avi|wmv)$/i;
const STICK_TO_BOTTOM_PX = 80;
const REASONING_NAMES = { off: "desligado", on: "ligado", low: "baixo", med: "médio", high: "alto", max: "máximo", ultra: "ultra" };

let socket = null;
let reconnectAttempts = 0;
let state = null;
let activities = [];
let renderedMessages = 0;
let renderScheduled = false;
let forceScroll = false;
let questionShown = null;
let workingFolder = "";
/** A problem found here, before anything reached the server (e.g. a message too large). */
let localError = null;
/** Files waiting to go with the next message: `{ name, data }`, data in Base64. */
let pendingFiles = [];
let conversationFilter = "";
/** Id of the conversation whose title is being edited in the sidebar. */
let renamingId = null;
/** The next message replaces the last one sent, instead of following it. */
let editingLast = false;
const toolCards = new Map();

/* --------------------------------- DOM helpers --------------------------------- */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderInline(nodes, parent) {
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        parent.append(document.createTextNode(node.text));
        break;
      case "code":
        parent.append(el("code", "", node.text));
        break;
      case "strong":
      case "em":
      case "del":
        renderInline(node.children, parent.appendChild(el(node.type)));
        break;
      case "span":
        renderInline(node.children, parent);
        break;
      case "link": {
        const link = el("a");
        link.href = node.href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        renderInline(node.children, link);
        parent.append(link);
        break;
      }
    }
  }
}

function copyButton(getText) {
  const button = el("button", "copy", "Copiar");
  button.type = "button";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      button.textContent = "Copiado";
    } catch {
      button.textContent = "Falhou";
    }
    setTimeout(() => { button.textContent = "Copiar"; }, 1500);
  });
  return button;
}

function renderBlocks(blocks, parent) {
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
        renderInline(block.children, parent.appendChild(el("p")));
        break;
      case "heading":
        renderInline(block.children, parent.appendChild(el(`h${Math.min(block.level + 1, 6)}`)));
        break;
      case "rule":
        parent.append(el("hr"));
        break;
      case "quote":
        renderBlocks(block.children, parent.appendChild(el("blockquote")));
        break;
      case "list": {
        const list = parent.appendChild(el(block.ordered ? "ol" : "ul"));
        for (const item of block.items) renderBlocks(item, list.appendChild(el("li")));
        break;
      }
      case "codeblock": {
        const wrap = parent.appendChild(el("div", "code-block"));
        const bar = wrap.appendChild(el("div", "code-bar"));
        bar.append(el("span", "", block.lang || "texto"), copyButton(() => block.text));
        const code = wrap.appendChild(el("pre")).appendChild(el("code"));
        for (const token of highlightTokens(block.text, block.lang)) {
          code.append(token.type ? el("span", `tok-${token.type}`, token.text) : document.createTextNode(token.text));
        }
        break;
      }
      case "table": {
        const wrap = parent.appendChild(el("div", "table-wrap"));
        const table = wrap.appendChild(el("table"));
        const head = table.appendChild(el("thead")).appendChild(el("tr"));
        for (const cell of block.header) renderInline(cell, head.appendChild(el("th")));
        const body = table.appendChild(el("tbody"));
        for (const row of block.rows) {
          const tr = body.appendChild(el("tr"));
          for (const cell of row) renderInline(cell, tr.appendChild(el("td")));
        }
        break;
      }
    }
  }
}

function markdownInto(node, text) {
  node.replaceChildren();
  renderBlocks(parseMarkdown(text), node);
}

/* ----------------------------------- Timeline ----------------------------------- */

/** What the user typed, without the "[anexo: ...]" lines the session adds below it. */
function typedText(content) {
  return content.replace(/\n\n(?:\[anexo: [^\]\n]*\]\n?)+$/, "");
}

function startEditingLast() {
  const last = state.messages.findLast((m) => m.role === "user");
  if (!last || state.streaming) return;
  editingLast = true;
  const input = $("input");
  input.value = typedText(last.content);
  fitInput();
  input.focus();
  scheduleRender();
}

function stopEditingLast() {
  if (!editingLast) return;
  editingLast = false;
  $("input").value = "";
  fitInput();
  scheduleRender();
}

function messageNode(message) {
  const node = el("article", `message ${message.role}`);
  if (message.role === "user") {
    const edit = el("button", "edit-message", "Editar");
    edit.type = "button";
    edit.title = "Editar e reenviar esta mensagem (a resposta atual é descartada)";
    edit.addEventListener("click", startEditingLast);
    node.append(edit, el("div", "bubble", message.content));
    return node;
  }
  const body = node.appendChild(el("div", "markdown"));
  markdownInto(body, message.content);
  return node;
}

function toolPreview(activity) {
  try {
    const args = JSON.parse(activity.args);
    const value = args.command ?? args.path ?? args.pattern ?? args.query ?? args.url ?? args.question ?? args.name;
    return typeof value === "string" ? value.split("\n")[0].slice(0, 120) : "";
  } catch {
    return "";
  }
}

function prettyArgs(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function updateToolCard(card, activity) {
  const running = activity.result === undefined;
  card.classList.toggle("running", running);
  card.classList.toggle("failed", Boolean(activity.isError));
  card.querySelector(".tool-state").textContent = running ? "executando" : activity.isError ? "erro" : "concluída";
  const result = card.querySelector(".tool-result");
  result.hidden = running;
  card.querySelector(".tool-result-label").hidden = running;
  if (!running) result.textContent = activity.result || "(sem saída)";
}

function toolCard(activity) {
  const card = el("details", "tool");
  const summary = card.appendChild(el("summary"));
  summary.append(el("span", "tool-dot"), el("span", "tool-name", activity.name), el("span", "tool-preview", toolPreview(activity)), el("span", "tool-state"));
  card.append(el("div", "tool-label", "Argumentos"), el("pre", "", prettyArgs(activity.args)));
  card.append(el("div", "tool-label tool-result-label", "Resultado"), el("pre", "tool-result"));
  updateToolCard(card, activity);
  toolCards.set(activity.key, card);
  return card;
}

function rebuildTimeline() {
  const timeline = $("timeline");
  timeline.replaceChildren();
  toolCards.clear();
  renderedMessages = 0;
  const placeTools = (count) => {
    for (const activity of activities) {
      if (activity.afterMessage === count) timeline.append(toolCard(activity));
    }
  };
  placeTools(0);
  state.messages.forEach((message, index) => {
    timeline.append(messageNode(message));
    placeTools(index + 1);
  });
  renderedMessages = state.messages.length;
}

function appendNewMessages() {
  const timeline = $("timeline");
  for (; renderedMessages < state.messages.length; renderedMessages++) {
    timeline.append(messageNode(state.messages[renderedMessages]));
  }
}

function renderLive() {
  const live = $("live");
  // The turn goes on after its first text. Only a pending question (waiting for the user) or a
  // running tool (its card and the status bar say it) replace the box.
  const thinking = state.streaming && !state.question && !state.status.startsWith("🔨");
  const text = state.streaming ? state.liveText : "";
  if (!thinking && !text) {
    live.replaceChildren();
    return;
  }
  const wrapper = live.firstElementChild ?? live.appendChild(el("article", "message assistant"));
  const textNode = wrapper.querySelector(".markdown");
  if (text) {
    const node = textNode ?? wrapper.insertBefore(el("div", "markdown"), wrapper.firstChild);
    if (node.dataset.source !== text) {
      node.dataset.source = text;
      markdownInto(node, text);
    }
  } else {
    textNode?.remove();
  }
  // Rebuilding the box at every update would restart its animation.
  const box = wrapper.querySelector(".thinking");
  if (thinking && !box) wrapper.append(thinkingBox());
  else if (!thinking) box?.remove();
}

function thinkingBox() {
  const box = el("div", "thinking");
  box.setAttribute("role", "status");
  box.append(el("span", "thinking-dot"), el("span", "", "Pensando..."));
  return box;
}

/* ---------------------------------- Page state ---------------------------------- */

function renderQuestion() {
  const form = $("question");
  const question = state.question;
  form.hidden = !question;
  const key = question ? JSON.stringify(question) : null;
  if (key === questionShown) return;
  questionShown = key;
  $("question-input").value = "";
  if (!question) return;
  // The agent is stopped waiting for this: show it even if the user had scrolled up.
  forceScroll = true;
  markdownInto($("question-text"), question.question);
  const options = $("question-options");
  options.replaceChildren();
  for (const option of question.options ?? []) {
    const button = el("button", "option", option);
    button.type = "button";
    button.addEventListener("click", () => sendToServer({ type: "answer", text: option }));
    options.append(button);
  }
  $("question-input").focus();
}

function renderTodos() {
  const list = $("todo-list");
  $("todos").hidden = state.todos.length === 0;
  list.replaceChildren();
  const symbols = { completed: "✓", in_progress: "▶", cancelled: "✕", pending: "○" };
  for (const todo of state.todos) {
    const item = list.appendChild(el("li", `todo ${todo.status}`));
    item.append(el("span", "todo-mark", symbols[todo.status] ?? "○"), el("span", "", todo.content));
  }
}

let sidebarDrawn = null;

function formatDate(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function renderSidebar() {
  // Rebuilding the list at every token of an answer would lose hover and focus.
  const { conversations, conversationId, streaming } = state;
  if (
    sidebarDrawn?.conversations === conversations && sidebarDrawn.conversationId === conversationId &&
    sidebarDrawn.streaming === streaming && sidebarDrawn.filter === conversationFilter && sidebarDrawn.renamingId === renamingId
  ) return;
  sidebarDrawn = { conversations, conversationId, streaming, filter: conversationFilter, renamingId };

  $("new-conversation").disabled = streaming;
  $("conversation-search").hidden = conversations.length < 2 && !conversationFilter;
  const needle = conversationFilter.trim().toLowerCase();
  const shown = needle ? conversations.filter((c) => c.title.toLowerCase().includes(needle)) : conversations;
  const empty = $("no-conversations");
  empty.hidden = shown.length > 0;
  empty.textContent = conversations.length ? "Nenhuma conversa com esse texto." : "As conversas deste projeto ficam aqui.";
  $("conversation-list").replaceChildren(...shown.map((conversation) => {
    const current = conversation.id === conversationId;
    const item = el("li", `conversation${current ? " current" : ""}`);
    if (conversation.id === renamingId) {
      item.append(renameInput(conversation));
      return item;
    }
    const open = el("button", "conversation-open");
    open.type = "button";
    open.disabled = streaming;
    open.title = conversation.title;
    if (current) open.setAttribute("aria-current", "true");
    open.append(el("span", "conversation-title", conversation.title), el("span", "conversation-date", formatDate(conversation.updatedAt)));
    open.addEventListener("click", () => {
      if (!current) sendToServer({ type: "resume", id: conversation.id });
    });
    const rename = el("button", "conversation-rename", "✎");
    rename.type = "button";
    rename.title = "Renomear esta conversa";
    rename.setAttribute("aria-label", `Renomear a conversa ${conversation.title}`);
    rename.addEventListener("click", () => {
      renamingId = conversation.id;
      scheduleRender();
    });
    const remove = el("button", "conversation-delete", "×");
    remove.type = "button";
    remove.disabled = streaming;
    remove.title = "Apagar esta conversa";
    remove.setAttribute("aria-label", `Apagar a conversa ${conversation.title}`);
    remove.addEventListener("click", () => {
      if (window.confirm(`Apagar a conversa "${conversation.title}"? Isso não pode ser desfeito.`)) {
        sendToServer({ type: "delete", id: conversation.id });
      }
    });
    item.append(open, rename, remove);
    return item;
  }));
  $("conversation-list").querySelector(".conversation-title-input")?.focus();
}

/** The title edited in place: Enter saves, Esc or leaving the field gives up. */
function renameInput(conversation) {
  const input = el("input", "conversation-title-input");
  input.type = "text";
  input.value = conversation.title;
  input.maxLength = 80;
  input.setAttribute("aria-label", "Novo título da conversa");
  const finish = (save) => {
    if (renamingId !== conversation.id) return;
    renamingId = null;
    const title = input.value.trim();
    if (save && title && title !== conversation.title) sendToServer({ type: "rename", id: conversation.id, title });
    scheduleRender();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") finish(true);
    else if (event.key === "Escape") {
      event.stopPropagation(); // Esc here must not cancel the running answer
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(false));
  return input;
}

let tasksDrawn = null;

function renderTasks() {
  const tasks = state.backgroundTasks ?? [];
  if (tasksDrawn === tasks) return;
  tasksDrawn = tasks;
  $("tasks").hidden = tasks.length === 0;
  $("task-list").replaceChildren(...tasks.map((task) => {
    const item = el("li", "task");
    const text = el("span", "task-text", `${task.type === "subagent" ? "Subagente: " : ""}${task.description}`);
    text.title = `${task.description}\n${task.id} · desde ${formatDate(task.startedAt)}`;
    const stop = el("button", "task-stop", "Encerrar");
    stop.type = "button";
    stop.setAttribute("aria-label", `Encerrar a tarefa ${task.description}`);
    stop.addEventListener("click", () => sendToServer({ type: "kill-task", id: task.id }));
    item.append(el("span", "task-dot"), text, stop);
    return item;
  }));
}

function renderAttachments() {
  const list = $("attachments");
  list.hidden = pendingFiles.length === 0;
  list.replaceChildren(...pendingFiles.map((file, index) => {
    const item = el("li", "attachment");
    const remove = el("button", "", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remover ${file.name}`);
    remove.addEventListener("click", () => {
      pendingFiles = pendingFiles.filter((_, i) => i !== index);
      renderAttachments();
    });
    item.append(el("span", "", file.name), remove);
    return item;
  }));
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    // "data:<mime>;base64,<data>": only the data goes to the server, which decides the type by the name.
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.readAsDataURL(file);
  });
}

async function addFiles(files) {
  for (const file of files) {
    if (pendingFiles.length >= MAX_ATTACHMENTS) {
      localError = `No máximo ${MAX_ATTACHMENTS} arquivos por mensagem.`;
      break;
    }
    const total = pendingFiles.reduce((sum, f) => sum + f.size, 0) + file.size;
    if (total > MAX_ATTACHMENT_BYTES) {
      localError = `${file.name} não coube: os anexos de uma mensagem somam até 10 MB. Para arquivos maiores, diga o caminho e peça ao agente para lê-lo.`;
      break;
    }
    // A pasted screenshot has no useful name.
    const name = file.name && file.name !== "image.png" ? file.name : `colado-${Date.now()}.${(file.type.split("/")[1] ?? "png").replace("jpeg", "jpg")}`;
    if (!ATTACHMENT_TYPES.test(name)) {
      localError = `${name} não é imagem, áudio nem vídeo. Para outros arquivos, diga o caminho e peça ao agente para lê-lo.`;
      continue;
    }
    try {
      pendingFiles = [...pendingFiles, { name, size: file.size, data: await readAsBase64(file) }];
      localError = null;
    } catch {
      localError = `Não consegui ler ${file.name}.`;
    }
  }
  renderAttachments();
  scheduleRender();
}

function formatTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function renderChrome() {
  const root = state.project?.root ?? workingFolder;
  const folderName = root.split(/[\\/]/).filter(Boolean).pop() ?? root;
  $("project").textContent = state.project ? folderName : `${folderName} · memória de projeto desligada`;
  $("project").title = root;

  const select = $("mode");
  select.value = state.mode;
  select.disabled = state.streaming;
  $("mode-chip").dataset.mode = state.mode;
  $("mode-label").textContent = modeLabel(state.mode);
  const reasoning = $("reasoning");
  reasoning.value = state.reasoning;
  reasoning.disabled = state.streaming;

  // The thinking box already says it, right above.
  $("status").textContent = state.status.includes("pensando") ? "" : state.status;
  $("status").classList.toggle("busy", state.streaming);
  const tokens = Math.max(state.estimatedTokens, state.apiTokens);
  $("stats").textContent = `${state.model} · ${state.toolCount} ferramentas · ${state.skillCount} skills · ${formatTokens(tokens)} tokens`;

  const error = $("error");
  const message = localError ?? state.error;
  error.hidden = !message;
  error.textContent = message ?? "";

  const stopping = state.streaming;
  const action = $("action");
  action.textContent = stopping ? "Parar" : "Enviar";
  action.classList.toggle("danger", stopping);
  action.classList.toggle("primary", !stopping);

  $("empty").hidden = state.messages.length > 0 || state.streaming;

  // Only the last message can be edited, and not while an answer is running.
  const userMessages = $("timeline").querySelectorAll(".message.user");
  userMessages.forEach((node, index) => node.classList.toggle("editable", !state.streaming && index === userMessages.length - 1));
  if (editingLast && (state.streaming || !userMessages.length)) editingLast = false;
  $("editing").hidden = !editingLast;
  if (!stopping) action.textContent = editingLast ? "Reenviar" : "Enviar";
}

function isNearBottom() {
  const box = $("scroller");
  return box.scrollHeight - box.scrollTop - box.clientHeight < STICK_TO_BOTTOM_PX;
}

function scrollToEnd() {
  $("scroller").scrollTop = $("scroller").scrollHeight;
}

function updateJumpButton() {
  $("jump").hidden = isNearBottom();
}

function render() {
  renderScheduled = false;
  if (!state) return;
  const stick = isNearBottom() || forceScroll;
  forceScroll = false;
  appendNewMessages();
  renderLive();
  renderQuestion();
  renderTodos();
  renderSidebar();
  renderTasks();
  renderChrome();
  if (stick) scrollToEnd();
  updateJumpButton();
}

function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(render);
}

function setConnection(text, tone) {
  const node = $("connection");
  node.textContent = text;
  node.dataset.tone = tone;
}

function setComposerEnabled(enabled) {
  $("input").disabled = !enabled;
  $("action").disabled = !enabled;
}

/* ----------------------------------- Diagnosis ----------------------------------- */

const DOCTOR_MARKS = { ok: "✓", warn: "!", fail: "✕", skip: "–" };
const DOCTOR_STATUS_NAMES = { ok: "certo", warn: "aviso", fail: "problema", skip: "não verificado" };
/** A request is out: the checks start a shell and call the provider, so one at a time. */
let doctorRunning = false;

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
    const list = body.appendChild(el("ul", "doctor-items"));
    for (const entry of check.items) list.append(el("li", "", entry));
  }
  if (check.fixed) body.append(el("div", "doctor-fixed", `Corrigido: ${check.fixed}`));
  if (check.hint) body.append(el("div", "doctor-hint", `Como resolver: ${check.hint}`));
  item.append(mark, body);
  return item;
}

function showDoctor({ summary, tone, checks = [], fixable = false }) {
  const node = $("doctor-summary");
  node.textContent = summary;
  node.dataset.tone = tone;
  $("doctor-list").replaceChildren(...checks.map(doctorCheckNode));
  $("doctor-fix").hidden = !fixable;
  $("doctor-fix").disabled = doctorRunning;
  $("doctor-again").disabled = doctorRunning;
}

function requestDoctor(fix = false) {
  if (doctorRunning) return; // the answer on its way fills the dialog
  doctorRunning = sendToServer({ type: "doctor", ...(fix ? { fix: true } : {}) });
  showDoctor(
    doctorRunning
      ? { summary: fix ? "Corrigindo e verificando de novo..." : "Verificando... pode levar alguns segundos.", tone: "busy" }
      : { summary: "Sem conexão com o agente: não dá para verificar agora.", tone: "bad" }
  );
}

function handleDoctor(message) {
  doctorRunning = false;
  if (!message.report) {
    showDoctor({ summary: message.error ?? "Não consegui rodar o diagnóstico.", tone: "bad" });
    return;
  }
  const { checks, ok } = message.report;
  const tone = !ok ? "bad" : checks.some((check) => check.status === "warn") ? "warn" : "ok";
  showDoctor({ summary: message.summary, tone, checks, fixable: checks.some((check) => check.fixable) });
}

/* ---------------------------------- Connection ---------------------------------- */

/** False when the message was not sent: the caller keeps what the user typed. */
function sendToServer(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  const payload = JSON.stringify(message);
  const bytes = new TextEncoder().encode(payload).length;
  if (bytes > MAX_MESSAGE_BYTES) {
    localError = `Mensagem grande demais (${(bytes / 1048576).toFixed(1)} MB; o limite é 16 MB). Salve o conteúdo num arquivo e peça ao agente para lê-lo.`;
    scheduleRender();
    return false;
  }
  socket.send(payload);
  return true;
}

/** Display names only: the mode values (saved config, prompts, protocol) stay the same. */
const MODE_LABELS = { "programação": "ultracódigo" };

function modeLabel(mode) {
  return MODE_LABELS[mode] ?? mode;
}

function fillSelect(select, options) {
  select.replaceChildren();
  for (const { value, label } of options) {
    const option = el("option", "", label);
    option.value = value;
    select.append(option);
  }
}

function handleHello(message) {
  state = message.state;
  activities = message.activities;
  questionShown = null;
  const { meta } = message;
  fillSelect($("mode"), meta.modes.map((value) => ({ value, label: modeLabel(value) })));
  fillSelect($("reasoning"), meta.reasoningOptions.map(({ value, label }) => ({ value, label: REASONING_NAMES[label] ?? label })));
  workingFolder = meta.cwd;
  $("empty-cwd").textContent = `Pasta de trabalho: ${meta.cwd}`;
  document.title = `Siliconflower ${meta.version}`;
  rebuildTimeline();
  setConnection("conectado", "ok");
  setComposerEnabled(true);
  forceScroll = true;
  render();
  $("input").focus();
}

function handleTool(activity) {
  const index = activities.findIndex((a) => a.key === activity.key);
  if (index === -1) activities.push(activity);
  else activities[index] = activity;

  const existing = toolCards.get(activity.key);
  if (existing) {
    updateToolCard(existing, activity);
    return;
  }
  appendNewMessages();
  $("timeline").append(toolCard(activity));
}

function connect() {
  socket = new WebSocket(`ws://${location.host}/ws`);
  socket.addEventListener("open", () => { reconnectAttempts = 0; });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    switch (message.type) {
      case "hello":
        handleHello(message);
        return;
      case "state":
        if (!state) return;
        state = { ...state, ...message.changes };
        // The text of a running answer arrives in pieces: see flushState in gui/server.ts.
        if (message.liveAppend) state.liveText += message.liveAppend;
        break;
      case "tool":
        handleTool(message.activity);
        break;
      case "doctor":
        handleDoctor(message);
        return;
    }
    scheduleRender();
  });
  socket.addEventListener("close", () => {
    setComposerEnabled(false);
    // The answer was for this connection and will not come any more.
    if (doctorRunning) handleDoctor({ error: "A conexão com o agente caiu antes do resultado. Verifique de novo." });
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      setConnection("sessão encerrada", "bad");
      return;
    }
    reconnectAttempts++;
    setConnection("reconectando...", "warn");
    setTimeout(connect, Math.min(500 * reconnectAttempts, 3000));
  });
}

/* ------------------------------------ Actions ------------------------------------ */

function fitInput() {
  const input = $("input");
  input.style.height = "auto";
  // scrollHeight leaves out the border, which box-sizing counts in the height.
  input.style.height = `${input.scrollHeight + input.offsetHeight - input.clientHeight}px`;
}

function submitComposer() {
  if (!state) return;
  if (state.streaming) {
    sendToServer({ type: "cancel" });
    return;
  }
  const input = $("input");
  if ((!input.value.trim() && !pendingFiles.length) || socket?.readyState !== WebSocket.OPEN) return;
  if (editingLast) {
    if (!input.value.trim() || !sendToServer({ type: "edit", text: input.value })) return;
    editingLast = false;
    localError = null;
    input.value = "";
    fitInput();
    forceScroll = true;
    return;
  }
  const attachments = pendingFiles.map(({ name, data }) => ({ name, data }));
  if (!sendToServer({ type: "send", text: input.value, ...(attachments.length ? { attachments } : {}) })) return;
  localError = null;
  pendingFiles = [];
  renderAttachments();
  input.value = "";
  fitInput();
  forceScroll = true;
}

$("scroller").addEventListener("scroll", updateJumpButton, { passive: true });
$("jump").addEventListener("click", scrollToEnd);
new ResizeObserver(updateJumpButton).observe($("timeline"));

$("composer-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitComposer();
});

$("input").addEventListener("input", () => {
  fitInput();
  if (localError) {
    localError = null;
    scheduleRender();
  }
});
$("input").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  // While a response is running, Enter keeps the draft; only the button stops the turn.
  if (!state?.streaming) submitComposer();
});

$("question").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("question-input");
  if (input.value.trim()) sendToServer({ type: "answer", text: input.value });
});

$("new-conversation").addEventListener("click", () => sendToServer({ type: "new" }));
$("conversation-search").addEventListener("input", (event) => {
  conversationFilter = event.target.value;
  scheduleRender();
});

$("attach").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (event) => {
  void addFiles([...event.target.files]);
  event.target.value = ""; // the same file can be chosen again
});
$("input").addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.files ?? [])];
  if (!files.length) return; // plain text: the default paste
  event.preventDefault();
  void addFiles(files);
});
const dropZone = $("composer-form");
dropZone.addEventListener("dragover", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  dropZone.classList.add("dragging");
});
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragging"));
dropZone.addEventListener("drop", (event) => {
  dropZone.classList.remove("dragging");
  const files = [...(event.dataTransfer?.files ?? [])];
  if (!files.length) return;
  event.preventDefault();
  void addFiles(files);
});
$("toggle-sidebar").addEventListener("click", () => { $("sidebar").hidden = !$("sidebar").hidden; });
// Narrow windows start with the room for the conversation itself.
$("sidebar").hidden = window.matchMedia("(max-width: 760px)").matches;

$("mode").addEventListener("change", (event) => sendToServer({ type: "mode", mode: event.target.value }));
$("reasoning").addEventListener("change", (event) => sendToServer({ type: "reasoning", level: event.target.value }));

$("cancel-edit").addEventListener("click", stopEditingLast);

const doctorDialog = $("doctor-dialog");
$("doctor").addEventListener("click", () => {
  doctorDialog.showModal();
  requestDoctor();
});
$("doctor-again").addEventListener("click", () => requestDoctor());
$("doctor-fix").addEventListener("click", () => requestDoctor(true));
$("doctor-close").addEventListener("click", () => doctorDialog.close());
// A click outside the box lands on the dialog itself (its backdrop).
doctorDialog.addEventListener("click", (event) => {
  if (event.target === doctorDialog) doctorDialog.close();
});

document.addEventListener("keydown", (event) => {
  // Esc there closes the dialog: it must not also stop the running answer.
  if (doctorDialog.open) return;
  if (event.key === "Escape" && editingLast) stopEditingLast();
  else if (event.key === "Escape" && state?.streaming) sendToServer({ type: "cancel" });
});

setConnection("conectando...", "warn");
setComposerEnabled(false);
fitInput();
connect();
