import React, { useState, useCallback, useEffect, useRef } from "react";
import { render, Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { renderLogo } from "./ascii.js";
import { streamChat } from "./llm.js";
import { McpManager } from "./mcp.js";
import { builtinToolsAsMcp, isBuiltin, runBuiltin } from "./tools.js";
import { loadSkills, readSkillContent, SKILL_TOOL, type Skill } from "./skills.js";
import { buildSystemPrompt, modeLabel, nextMode, type Mode } from "./modes.js";
import { buildMemorySystemPrompt } from "./services/memory.js";
import { onTodosChange } from "./todo.js";
import { estimateTokens, formatTokenCount } from "./context.js";
import { MarkdownText } from "./MarkdownText.js";
import { log, logFile } from "./logger.js";
import type { AppConfig, ChatMessage, McpTool, ReasoningLevel, StreamEvent, TodoItem } from "./types.js";
import { REASONING_LEVELS } from "./types.js";
import { isToolAllowedInMode } from "./tool-policy.js";
import { runHook } from "./core/hooks.js";

const REASONING_LABEL: Record<ReasoningLevel, string> = {
  none: "off",
  low: "low",
  medium: "med",
  high: "high",
};

interface AppProps {
  config: AppConfig;
  overrides: { model?: string; reasoning?: ReasoningLevel; mode?: Mode };
}

interface UIMessage {
  role: "user" | "assistant";
  content: string;
  reasoning?: string;
}

const App: React.FC<AppProps> = ({ config, overrides }) => {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [model] = useState(overrides.model ?? config.model);
  const [reasoning, setReasoning] = useState<ReasoningLevel>(overrides.reasoning ?? config.reasoning);
  const [mode, setMode] = useState<Mode>(overrides.mode ?? config.mode ?? "programação");
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [status, setStatus] = useState("pronto");
  const [mcpCount, setMcpCount] = useState(0);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [todos, setTodosState] = useState<TodoItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [cols, setCols] = useState(stdout?.columns ?? 100);
  const [apiTokens, setApiTokens] = useState(0);
  const mcpRef = useRef<McpManager | null>(null);
  const skillsRef = useRef<Skill[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const lastCtrlRef = useRef<number>(0);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    return onTodosChange((updated) => setTodosState([...updated]));
  }, []);

  const { art, color } = renderLogo();

  useEffect(() => {
    if (!stdout) return;
    const handler = () => setCols(stdout.columns);
    stdout.on("resize", handler);
    return () => { stdout.off("resize", handler); };
  }, [stdout]);

  useEffect(() => {
    const mcp = new McpManager();
    mcpRef.current = mcp;
    let cancelled = false;
    (async () => {
      const loaded = await loadSkills();
      if (cancelled) return;
      skillsRef.current = loaded;
      setSkills(loaded);
      await log("info", `siliconflower iniciado - provider=${config.provider} model=${model}`);
      if (config.hooks) {
        await runHook("onSessionStart", config.hooks, { cwd: process.cwd() });
      }
      setStatus("conectando MCP...");
      try {
        const tools = await mcp.connectAll(config.mcpServers);
        if (cancelled) return;
        setMcpCount(tools.length);
        await log("ok", `MCP conectado: ${mcp.serverCount()} servidores, ${tools.length} ferramentas`);
        setStatus("pronto");
      } catch (e) {
        await log("error", `MCP indisponivel: ${String(e)}`);
        setStatus("MCP indisponivel");
      }
    })();
    return () => {
      cancelled = true;
      abortRef.current?.abort();
      if (config.hooks) void runHook("onSessionEnd", config.hooks, { cwd: process.cwd() });
      void mcp.close();
    };
  }, []);

  const cycleReasoning = useCallback(() => {
    lastCtrlRef.current = Date.now();
    setInput((prev) => prev.replace(/[\x00-\x1F\x7F]/g, "").replace(/e$/i, ""));
    setReasoning((r) => {
      const idx = REASONING_LEVELS.indexOf(r);
      const next = REASONING_LEVELS[(idx + 1) % REASONING_LEVELS.length];
      setStatus(`pensamento: ${next}`);
      setTimeout(() => setStatus("pronto"), 1200);
      return next;
    });
  }, []);

  const cycleMode = useCallback(() => {
    lastCtrlRef.current = Date.now();
    setInput((prev) => prev.replace(/[\x00-\x1F\x7F]/g, "").replace(/o$/i, ""));
    setMode((m) => {
      const n = nextMode(m);
      setStatus(`mode: ${n}`);
      setTimeout(() => setStatus("pronto"), 1200);
      return n;
    });
  }, []);

  const handleCancel = useCallback(() => {
    if (streaming) {
      abortRef.current?.abort();
      setStatus("cancelado");
    } else {
      exit();
    }
  }, [streaming, exit]);

  const allTools = useCallback((): McpTool[] => {
    const list: McpTool[] = [...builtinToolsAsMcp()];
    list.push({ server: "skill", name: SKILL_TOOL.name, description: SKILL_TOOL.description, inputSchema: SKILL_TOOL.inputSchema });
    const mcp = mcpRef.current;
    if (mcp) list.push(...mcp.allTools());
    return list;
  }, []);

  const executeTool = useCallback(
    async (name: string, args: Record<string, unknown>): Promise<{ result: string; isError: boolean }> => {
      if (!isToolAllowedInMode(modeRef.current, name, args)) {
        return {
          result: `[MODO PLANO ATIVO] Execução de ${name} bloqueada. Apresente o plano ao usuário e peça para alternar para o modo 'programação' (Ctrl+O) para aplicar as alterações.`,
          isError: true,
        };
      }

      if (name === SKILL_TOOL.name) {
        try {
          const content = await readSkillContent(String(args.name ?? ""));
          return { result: content, isError: false };
        } catch (e) {
          return { result: String(e), isError: true };
        }
      }
      if (isBuiltin(name)) {
        return runBuiltin(name, args, {
          config,
          mode: modeRef.current,
          signal: abortRef.current?.signal,
        });
      }
      const mcp = mcpRef.current;
      if (mcp) {
        try {
          const result = await mcp.callTool(name, args);
          return { result, isError: false };
        } catch (e) {
          return { result: String(e), isError: true };
        }
      }
      return { result: `tool not found: ${name}`, isError: true };
    },
    [config]
  );

  const handleInputChange = useCallback((val: string) => {
    let clean = val.replace(/[\x00-\x1F\x7F]/g, "");
    if (Date.now() - lastCtrlRef.current < 250) {
      clean = clean.replace(/[oOeEcC]$/i, "");
    }
    setInput(clean);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const cleanText = text.replace(/[\x00-\x1F\x7F]/g, "").trim();
      if (!cleanText || streaming) return;
      setError(null);
      setMessages((m) => [...m, { role: "user", content: cleanText }]);
      setInput("");
      setStreaming(true);
      setLiveText("");
      setStatus("pensando...");

      const recentMessages = messages.slice(-60);
      const history: ChatMessage[] = [
        ...recentMessages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        { role: "user" as const, content: cleanText },
      ];

      const memoryPrompt = await buildMemorySystemPrompt(process.cwd());
      const systemPrompt = buildSystemPrompt(modeRef.current, config.system, skillsRef.current, memoryPrompt);
      const controller = new AbortController();
      abortRef.current = controller;

      let accText = "";
      let accThinking = "";
      let hadError = false;
      let assistantMsgAdded = false;

      try {
        const gen = streamChat({
          config: { ...config, system: systemPrompt, model },
          messages: history,
          tools: allTools(),
          reasoning,
          signal: controller.signal,
          executeTool,
        });

        for await (const ev of gen as AsyncIterable<StreamEvent>) {
          switch (ev.type) {
            case "thinking":
              accThinking += ev.text;
              setStatus("🧠 pensando...");
              break;
            case "text":
              accText += ev.text;
              setLiveText(accText);
              break;
            case "tool_call":
              setStatus(`🔨 ${ev.name}...`);
              break;
            case "tool_result":
              setStatus("processando...");
              break;
            case "usage":
              if (ev.totalTokens) setApiTokens(ev.totalTokens);
              break;
            case "error":
              hadError = true;
              setError(ev.message);
              await log("error", `Stream error: ${ev.message}`);
              if (!assistantMsgAdded) {
                assistantMsgAdded = true;
                setMessages((m) => [...m, { role: "assistant", content: `[Erro: ${ev.message}]` }]);
              }
              break;
            case "done":
              {
                const final = ev.content?.trim() || accText.trim();
                const finalThinking = ev.reasoning?.trim() || accThinking.trim();
                if (final) {
                  assistantMsgAdded = true;
                  setMessages((m) => [...m, { role: "assistant", content: final, reasoning: finalThinking || undefined }]);
                }
              }
              break;
          }
        }
        setStatus(hadError ? "erro" : "pronto");
      } catch (e) {
        hadError = true;
        const isAbort = (e instanceof Error && e.name === "AbortError") || /abort/i.test(String(e));
        const errMsg = isAbort ? "Operação cancelada pelo usuário" : (e instanceof Error ? e.message : String(e));
        if (!isAbort) {
          setError(errMsg);
          await log("error", `Stream failed: ${errMsg}`);
          setStatus("erro");
        } else {
          setStatus("cancelado");
        }
        if (!assistantMsgAdded) {
          assistantMsgAdded = true;
          setMessages((m) => [
            ...m,
            {
              role: "assistant",
              content: accText || `[${errMsg}]`,
              reasoning: accThinking || undefined,
            },
          ]);
        }
      } finally {
        setStreaming(false);
        setLiveText("");
        abortRef.current = null;
      }
    },
    [config, model, reasoning, streaming, messages, allTools, executeTool]
  );

  useInput((input, key) => {
    if (key.ctrl) {
      lastCtrlRef.current = Date.now();
    }
    if (streaming) {
      if (key.ctrl && (input.toLowerCase() === "c" || input === "\x03")) handleCancel();
      return;
    }
    if (key.ctrl && (input.toLowerCase() === "e" || input === "\x05")) { cycleReasoning(); return; }
    if (key.ctrl && (input.toLowerCase() === "o" || input === "\x0f")) { cycleMode(); return; }
    if (key.ctrl && (input.toLowerCase() === "c" || input === "\x03")) { handleCancel(); return; }
  });

  const totalTools = builtinToolsAsMcp().length + 1 + mcpCount;
  const systemTokens = estimateTokens(buildSystemPrompt(mode, config.system, skills));
  const historyTokens = messages.reduce((acc, m) => acc + estimateTokens(m.content) + estimateTokens(m.reasoning ?? ""), 0);
  const liveTokens = estimateTokens(input) + estimateTokens(liveText);
  const estimatedTotal = systemTokens + historyTokens + liveTokens;
  const totalTokens = Math.max(estimatedTotal, apiTokens);

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

      <Text dimColor>{sep}</Text>
      <Box>
        <Text color="magenta" bold>{"> "}</Text>
        {!streaming ? (
          <TextInput
            value={input}
            onChange={handleInputChange}
            onSubmit={() => { if (input.trim()) send(input); }}
            placeholder="digite para a LLM..."
          />
        ) : (
          <Text dimColor italic>gerando resposta...</Text>
        )}
      </Box>

      <Text dimColor>{sep}</Text>
      <Box flexWrap="wrap">
        <Text><Text color="green" bold>Model:</Text> {model} </Text>
        <Text><Text color="magenta" bold>Reasoning:</Text> {REASONING_LABEL[reasoning]} </Text>
        <Text><Text color="blue" bold>Mode:</Text> {modeLabel(mode)} </Text>
        <Text><Text color="yellow" bold>Tools:</Text> {totalTools} </Text>
        <Text><Text color="cyan" bold>Skills:</Text> {skills.length} </Text>
        <Text><Text color="red" bold>Tokens:</Text> {formatTokenCount(totalTokens)}</Text>
      </Box>
      <Text dimColor italic>{status} {totalTokens > 0 && `(${formatTokenCount(totalTokens)} tokens)`}</Text>
      {error && <Text color="red">[ERRO] {error}</Text>}
      <Text dimColor>log: {logFile().replace(/\\/g, "/")}</Text>
    </Box>
  );
};

export function startApp(config: AppConfig, overrides: { model?: string; reasoning?: ReasoningLevel; mode?: Mode }) {
  render(<App config={config} overrides={overrides} />);
}
