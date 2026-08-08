export type Provider = "openai" | "anthropic";
export type ReasoningLevel = "none" | "low" | "medium" | "high";
export type Mode = "programação" | "sistema";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AppConfig {
  provider: Provider;
  baseURL: string;
  apiKey: string;
  model: string;
  reasoning: ReasoningLevel;
  mode?: Mode;
  system?: string;
  mcpServers?: Record<string, McpServerConfig>;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  toolName?: string;
  toolCalls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

export type StreamEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: string }
  | { type: "tool_result"; id: string; name: string; result: string; isError: boolean }
  | { type: "error"; message: string }
  | { type: "done"; content: string; reasoning: string };

export interface McpTool {
  server: string;
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export const REASONING_LEVELS: ReasoningLevel[] = ["none", "low", "medium", "high"];
