import { parseMarkdown } from "/markdown.js";

const $ = (id) => document.getElementById(id);
const MAX_RECONNECT_ATTEMPTS = 20;
const STICK_TO_BOTTOM_PX = 80;
const REASONING_NAMES = { off: "desligado", on: "ligado", low: "baixo", med: "médio", high: "alto" };

let socket = null;
let reconnectAttempts = 0;
let state = null;
let activities = [];
let renderedMessages = 0;
let renderScheduled = false;
let forceScroll = false;
let questionShown = null;
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
        wrap.appendChild(el("pre")).append(el("code", "", block.text));
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

function messageNode(message) {
  const node = el("article", `message ${message.role}`);
  if (message.role === "user") {
    node.append(el("div", "bubble", message.content));
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
  // A pending question means the agent is waiting for the user, not thinking.
  const thinking = state.streaming && !state.liveText && !state.question;
  // Rebuilding the box at every update would restart its animation.
  if (thinking && live.querySelector(".thinking")) return;
  live.replaceChildren();
  if (!state.streaming || (!thinking && !state.liveText)) return;
  const wrapper = live.appendChild(el("article", "message assistant"));
  if (thinking) wrapper.append(thinkingBox());
  else markdownInto(wrapper.appendChild(el("div", "markdown")), state.liveText);
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

function formatTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function renderChrome() {
  const projectName = state.project ? state.project.root.split(/[\\/]/).pop() : null;
  $("project").textContent = projectName ?? "sem projeto (memória de projeto desligada)";
  $("project").title = state.project?.root ?? "";

  const select = $("mode");
  select.value = state.mode;
  select.disabled = state.streaming;
  const reasoning = $("reasoning");
  reasoning.value = state.reasoning;
  reasoning.disabled = state.streaming;

  // The thinking box already says it, right above.
  $("status").textContent = state.status.includes("pensando") ? "" : state.status;
  $("status").classList.toggle("busy", state.streaming);
  const tokens = Math.max(state.estimatedTokens, state.apiTokens);
  $("stats").textContent = `${state.model} · ${state.toolCount} ferramentas · ${state.skillCount} skills · ${formatTokens(tokens)} tokens`;

  const error = $("error");
  error.hidden = !state.error;
  error.textContent = state.error ?? "";

  const stopping = state.streaming;
  const action = $("action");
  action.textContent = stopping ? "Parar" : "Enviar";
  action.classList.toggle("danger", stopping);
  action.classList.toggle("primary", !stopping);

  $("empty").hidden = state.messages.length > 0 || state.streaming;
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

/* ---------------------------------- Connection ---------------------------------- */

function sendToServer(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
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
  fillSelect($("mode"), meta.modes.map((value) => ({ value, label: value })));
  fillSelect($("reasoning"), meta.reasoningOptions.map(({ value, label }) => ({ value, label: REASONING_NAMES[label] ?? label })));
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
        break;
      case "tool":
        handleTool(message.activity);
        break;
    }
    scheduleRender();
  });
  socket.addEventListener("close", () => {
    setComposerEnabled(false);
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      setConnection("sessão encerrada: rode siliconflower gui de novo", "bad");
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
  if (!input.value.trim() || socket?.readyState !== WebSocket.OPEN) return;
  sendToServer({ type: "send", text: input.value });
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

$("input").addEventListener("input", fitInput);
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

$("mode").addEventListener("change", (event) => sendToServer({ type: "mode", mode: event.target.value }));
$("reasoning").addEventListener("change", (event) => sendToServer({ type: "reasoning", level: event.target.value }));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state?.streaming) sendToServer({ type: "cancel" });
});

setConnection("conectando...", "warn");
setComposerEnabled(false);
fitInput();
connect();
