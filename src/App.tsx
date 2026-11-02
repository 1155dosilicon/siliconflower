import React, { useState, useCallback, useEffect, useRef } from "react";
import { render, Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { renderLogo } from "./ascii.js";
import { modeLabel } from "./modes.js";
import { estimateTokens, formatTokenCount } from "./context.js";
import { MarkdownText } from "./MarkdownText.js";
import { logFile } from "./logger.js";
import type { AppConfig } from "./types.js";
import { clearScreen, restoreTerminal, ANSI_CLEAR_SCREEN } from "./terminal.js";
import { reasoningLabel } from "./reasoning.js";
import { AgentSession, type SessionOverrides } from "./session.js";
import { basename } from "node:path";

interface AppProps {
  config: AppConfig;
  overrides: SessionOverrides;
}

const RESIZE_SETTLE_MS = 150;

export const App: React.FC<AppProps> = ({ config, overrides }) => {
  const { exit } = useApp();
  const { stdout, write: writeToStdout } = useStdout();

  const [session] = useState(() => new AgentSession(config, overrides));
  const [state, setState] = useState(() => session.getState());
  const [input, setInput] = useState("");
  const [cols, setCols] = useState(stdout?.columns ?? 100);
  const lastCtrlRef = useRef<number>(0);
  const { model, reasoning, mode, messages, streaming, liveText, status, error, question, todos, project } = state;

  useEffect(() => {
    const unsubscribe = session.subscribe(setState);
    setState(session.getState());
    void session.start();
    return () => {
      unsubscribe();
      void session.close();
    };
  }, [session]);

  // A new question starts with an empty input, even if something was being typed.
  useEffect(() => {
    if (question) setInput("");
  }, [question]);

  // Re-picked on every resize (cols state), so the logo never wraps in narrow windows.
  const { art, color } = renderLogo(cols);

  // Ink only erases "the N lines of the previous frame" on resize, but the terminal has
  // already reflowed those lines into a different number of rows, so fragments of old
  // frames pile up (e.g. a stacked logo under the full one). Once resizing settles, wipe
  // the screen and repaint the whole frame.
  const [repaintTick, setRepaintTick] = useState(0);
  useEffect(() => {
    if (!stdout) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handler = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        setCols(stdout.columns);
        setRepaintTick((t) => t + 1);
      }, RESIZE_SETTLE_MS);
    };
    stdout.on("resize", handler);
    return () => {
      if (timer) clearTimeout(timer);
      stdout.off("resize", handler);
    };
  }, [stdout]);

  useEffect(() => {
    if (repaintTick === 0) return;
    // Ink's write(): resets its frame bookkeeping, writes our data (clear screen + scrollback,
    // cursor home) and then redraws the full current frame from scratch.
    writeToStdout(ANSI_CLEAR_SCREEN);
  }, [repaintTick, writeToStdout]);

  const cycleReasoning = useCallback(() => {
    lastCtrlRef.current = Date.now();
    setInput((prev) => prev.replace(/[\x00-\x1F\x7F]/g, "").replace(/e$/i, ""));
    session.cycleReasoning();
  }, [session]);

  const cycleMode = useCallback(() => {
    lastCtrlRef.current = Date.now();
    setInput((prev) => prev.replace(/[\x00-\x1F\x7F]/g, "").replace(/o$/i, ""));
    session.cycleMode();
  }, [session]);

  const handleCancel = useCallback(() => {
    if (!session.cancel()) exit();
  }, [session, exit]);

  const handleInputChange = useCallback((val: string) => {
    let clean = val.replace(/[\x00-\x1F\x7F]/g, "");
    if (Date.now() - lastCtrlRef.current < 250) {
      clean = clean.replace(/[oe]$/i, "");
    }
    setInput(clean);
  }, []);

  const handleSubmit = useCallback(() => {
    if (question) {
      if (session.answer(input)) setInput("");
    } else if (input.trim()) {
      setInput("");
      void session.send(input);
    }
  }, [session, question, input]);

  useInput((input, key) => {
    // Note: lastCtrlRef is set specifically by cycleReasoning/cycleMode (Ctrl+E/Ctrl+O) below,
    // not here for every Ctrl combo — otherwise Ctrl+C/Ctrl+V/etc. would also arm the 250ms
    // window in handleInputChange and silently eat a legitimately typed trailing o/e/c.
    if (streaming) {
      if (key.ctrl && (input.toLowerCase() === "c" || input === "\x03")) handleCancel();
      return;
    }
    if (key.ctrl && (input.toLowerCase() === "e" || input === "\x05")) { cycleReasoning(); return; }
    if (key.ctrl && (input.toLowerCase() === "o" || input === "\x0f")) { cycleMode(); return; }
    if (key.ctrl && (input.toLowerCase() === "c" || input === "\x03")) { handleCancel(); return; }
  });

  const totalTokens = Math.max(state.estimatedTokens + estimateTokens(input), state.apiTokens);

  const sep = "-".repeat(Math.min(cols - 2, 80));
  const maxHistory = 50;
  const visibleMessages = messages.slice(-maxHistory);

  return (
    <Box flexDirection="column">
      <Text color={color} bold>{art}</Text>
      <Text dimColor>{sep}</Text>

      {visibleMessages.length === 0 && (
        <Text dimColor>Envie uma mensagem (Enter enviar | Ctrl+E pensamento | Ctrl+O modo | Ctrl+C sair)</Text>
      )}
      {visibleMessages.map((m, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          <Text bold color={m.role === "user" ? "cyan" : "green"}>
            {m.role === "user" ? "voce>" : "ia>"}
          </Text>
          {m.role === "assistant" ? (
            <MarkdownText>{m.content}</MarkdownText>
          ) : (
            <Text>{m.content}</Text>
          )}
          {m.reasoning && (
            <Text dimColor italic>{"  thinking: " + m.reasoning.slice(0, 200) + (m.reasoning.length > 200 ? "..." : "")}</Text>
          )}
        </Box>
      ))}
      {streaming && liveText && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="green">{"ia>"}</Text>
          <MarkdownText>{liveText}</MarkdownText>
        </Box>
      )}

      {todos.length > 0 && (
        <Box flexDirection="column" marginY={1} borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">Tarefas (To-Do):</Text>
          {todos.map((t) => {
            const symbol =
              t.status === "completed" ? "✓" : t.status === "in_progress" ? "▶" : t.status === "cancelled" ? "✗" : " ";
            const color =
              t.status === "completed" ? "green" : t.status === "in_progress" ? "cyan" : t.status === "cancelled" ? "gray" : "white";
            return (
              <Text key={t.id} color={color}>
                [{symbol}] {t.content}
              </Text>
            );
          })}
        </Box>
      )}

      {question && (
        <Box flexDirection="column" marginY={1} borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text bold color="magenta">Pergunta da IA:</Text>
          <MarkdownText>{question.question}</MarkdownText>
          {question.options?.map((opt, i) => (
            <Text key={i}>
              <Text color="yellow">{`  ${i + 1}. `}</Text>
              {opt}
            </Text>
          ))}
          <Text dimColor italic>
            {question.options?.length ? "Digite o número de uma opção ou uma resposta livre e tecle Enter." : "Digite sua resposta e tecle Enter."}
            {" (Ctrl+C cancela)"}
          </Text>
        </Box>
      )}

      <Text dimColor>{sep}</Text>
      <Box>
        <Text color="magenta" bold>{"> "}</Text>
        {!streaming || question ? (
          <TextInput
            value={input}
            onChange={handleInputChange}
            onSubmit={handleSubmit}
            placeholder={question ? "sua resposta..." : "digite para a LLM..."}
          />
        ) : (
          <Text dimColor italic>gerando resposta... (Ctrl+C cancela)</Text>
        )}
      </Box>

      <Text dimColor>{sep}</Text>
      <Box flexWrap="wrap">
        <Text><Text color="green" bold>Model:</Text> {model} </Text>
        <Text><Text color="magenta" bold>Reasoning:</Text> {reasoningLabel(reasoning, config.baseURL)} </Text>
        <Text><Text color="blue" bold>Mode:</Text> {modeLabel(mode)} </Text>
        <Text><Text color="yellow" bold>Tools:</Text> {state.toolCount} </Text>
        <Text><Text color="cyan" bold>Skills:</Text> {state.skillCount} </Text>
        <Text>
          <Text color="green" bold>Projeto:</Text>{" "}
          {project ? `${basename(project.root)} (${basename(project.markerPath)})` : "nenhum (memória de projeto off)"}{" "}
        </Text>
        <Text><Text color="red" bold>Tokens:</Text> {formatTokenCount(totalTokens)}</Text>
      </Box>
      <Text dimColor italic>{status} {totalTokens > 0 && `(${formatTokenCount(totalTokens)} tokens)`}</Text>
      {error && <Text color="red">[ERRO] {error}</Text>}
      <Text dimColor>log: {logFile().replace(/\\/g, "/")}</Text>
    </Box>
  );
};

export async function startApp(config: AppConfig, overrides: SessionOverrides) {
  clearScreen();
  try {
    // exitOnCtrlC must be off: with Ink's default, useInput never receives Ctrl+C, so the
    // app would exit instead of cancelling the current response.
    const app = render(<App config={config} overrides={overrides} />, { exitOnCtrlC: false });
    await app.waitUntilExit();
  } finally {
    restoreTerminal();
  }
}
