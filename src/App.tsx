import React, { useState, useCallback, useEffect, useRef } from "react";
import { render, Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { renderLogo } from "./ascii.js";
import { streamChat } from "./llm.js";
import { McpManager } from "./mcp.js";
import { builtinToolsAsMcp, isBuiltin, runBuiltin } from "./tools.js";
import { loadSkills, readSkillContent, SKILL_TOOL, type Skill } from "./skills.js";
import { buildSystemPrompt, modeLabel, nextMode, type Mode } from "./modes.js";
import { log, logFile } from "./logger.js";
import type { AppConfig, ChatMessage, McpTool, ReasoningLevel, StreamEvent } from "./types.js";
import { REASONING_LEVELS } from "./types.js";

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
  const [error, setError] = useState<string | null>(null);
  const [cols, setCols] = useState(stdout?.columns ?? 100);
  const mcpRef = useRef<McpManager | null>(null);
  const skillsRef = useRef<Skill[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

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
      void mcp.close();
    };
  }, []);

  const cycleReasoning = useCallback(() => {
    setReasoning((r) => {
      const idx = REASONING_LEVELS.indexOf(r);
      const next = REASONING_LEVELS[(idx + 1) % REASONING_LEVELS.length];
      setStatus(`reasoning: ${next}`);
      setTimeout(() => setStatus("pronto"), 1200);
      return next;
    });
  }, []);

  const cycleMode = useCallback(() => {
    setMode((m) => {
      const n = nextMode(m);
      setStatus(`modo: ${n}`);
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
      if (name === SKILL_TOOL.name) {
        try {
          const content = await readSkillContent(String(args.name ?? ""));
          return { result: content, isError: false };
        } catch (e) {
          return { result: String(e), isError: true };
        }
      }
      if (isBuiltin(name)) return runBuiltin(name, args);
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
    []
  );

  const send = useCallback(
    async (text: string) => {
      if (!text.trim() || streaming) return;
      setError(null);
      setMessages((m) => [...m, { role: "user", content: text.trim() }]);
      setInput("");
      setStreaming(true);
      setLiveText("");
      setStatus("pensando...");

      const recentMessages = messages.slice(-30);
      const history: ChatMessage[] = [
        ...recentMessages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        { role: "user" as const, content: text.trim() },
      ];

      const systemPrompt = buildSystemPrompt(modeRef.current, config.system, skillsRef.current);
      const controller = new AbortController();
      abortRef.current = controller;

      let accText = "";
      let accThinking = "";
      let hadError = false;

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
              break;
            case "text":
              accText += ev.text;
              setLiveText(accText);
              break;
            case "tool_call":
              setStatus(`${ev.name}...`);
              break;
            case "tool_result":
              setStatus("...");
              break;
            case "error":
              hadError = true;
              setError(ev.message);
              await log("error", `Stream error: ${ev.message}`);
              break;
            case "done":
              {
                const final = ev.content?.trim() || accText.trim();
                const finalThinking = ev.reasoning?.trim() || accThinking.trim();
                if (final) {
                  setMessages((m) => [...m, { role: "assistant", content: final, reasoning: finalThinking || undefined }]);
                }
              }
              break;
          }
        }
        setStatus(hadError ? "erro" : "pronto");
      } catch (e) {
        hadError = true;
        const errMsg = e instanceof Error ? e.message : String(e);
        setError(errMsg);
        await log("error", `Stream failed: ${errMsg}`);
        setStatus("erro");
        if (accText || accThinking) {
          setMessages((m) => [...m, { role: "assistant", content: accText || "[stream interrompido]", reasoning: accThinking || undefined }]);
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
    if (streaming) {
      if (key.ctrl && (input.toLowerCase() === "c" || input === "\x03")) handleCancel();
      return;
    }
    if (key.ctrl && (input.toLowerCase() === "e" || input === "\x05")) { cycleReasoning(); return; }
    if (key.ctrl && (input.toLowerCase() === "o" || input === "\x0f")) { cycleMode(); return; }
    if (key.ctrl && (input.toLowerCase() === "c" || input === "\x03")) { handleCancel(); return; }
  });

  const totalTools = builtinToolsAsMcp().length + 1 + mcpCount;
  const sep = "-".repeat(Math.min(cols - 2, 80));
  const maxHistory = 50;
  const visibleMessages = messages.slice(-maxHistory);

  return (
    <Box flexDirection="column">
      <Text color={color} bold>{art}</Text>
      <Text dimColor>{sep}</Text>

      {visibleMessages.length === 0 && (
        <Text dimColor>Envie uma mensagem (Enter enviar | Ctrl+E reasoning | Ctrl+O modo | Ctrl+C sair)</Text>
      )}
      {visibleMessages.map((m, i) => (
        <Box key={i} flexDirection="column" marginBottom={1}>
          <Text bold color={m.role === "user" ? "cyan" : "green"}>
            {m.role === "user" ? "voce>" : "ia>"}
          </Text>
          <Text>{m.content}</Text>
          {m.reasoning && (
            <Text dimColor italic>{"  thinking: " + m.reasoning.slice(0, 200) + (m.reasoning.length > 200 ? "..." : "")}</Text>
          )}
        </Box>
      ))}
      {streaming && liveText && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="green">{"ia>"}</Text>
          <Text>{liveText}</Text>
        </Box>
      )}

      <Text dimColor>{sep}</Text>
      <Box>
        <Text color="magenta" bold>{"> "}</Text>
        {!streaming ? (
          <TextInput
            value={input}
            onChange={setInput}
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
        <Text><Text color="blue" bold>Modo:</Text> {modeLabel(mode)} </Text>
        <Text><Text color="yellow" bold>Tools:</Text> {totalTools} </Text>
        <Text><Text color="cyan" bold>Skills:</Text> {skills.length}</Text>
      </Box>
      <Text dimColor italic>{status}</Text>
      {error && <Text color="red">[ERRO] {error}</Text>}
      <Text dimColor>log: {logFile().replace(/\\/g, "/")}</Text>
    </Box>
  );
};

export function startApp(config: AppConfig, overrides: { model?: string; reasoning?: ReasoningLevel; mode?: Mode }) {
  render(<App config={config} overrides={overrides} />);
}
