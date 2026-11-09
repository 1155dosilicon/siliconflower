export type ReasoningLevel = "none" | "low" | "medium" | "high";
export type Mode = "programação" | "sistema" | "plano";

/** A server started here and reached by stdio (`command`), or a remote one by HTTP (`url`). */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Streamable HTTP endpoint, e.g. https://exemplo.com/mcp. */
  url?: string;
  headers?: Record<string, string>;
}

export interface AppConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  reasoning: ReasoningLevel;
  mode?: Mode;
  system?: string;
  /** Tokens one request may use (system prompt, tool schemas and history). Default: 90000. */
  contextTokens?: number;
  mcpServers?: Record<string, McpServerConfig>;
  hooks?: {
    preTool?: string;
    postTool?: string;
    onEdit?: string;
    onCommand?: string;
    onSessionStart?: string;
    onSessionEnd?: string;
  };
}

export type MediaKind = "image" | "audio" | "video";

export interface MediaAttachment {
  kind: MediaKind;
  path: string;
  mime: string;
  /** Base64, kept only in memory and only while it may still be sent. */
  data?: string;
  /** Video only. */
  fps?: number;
  mediaResolution?: "default" | "max";
  /** The provider refused this file: tells the model it never received the content. */
  rejected?: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  toolName?: string;
  toolCallId?: string;
  toolCalls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  /** Files sent with a user message: `tool` messages only carry text in these APIs. */
  media?: MediaAttachment[];
}

export interface ToolResult {
  result: string;
  isError: boolean;
  media?: MediaAttachment[];
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  priority: "high" | "medium" | "low";
}

export type StreamEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: string }
  | { type: "tool_result"; id: string; name: string; result: string; isError: boolean }
  | { type: "usage"; totalTokens?: number; promptTokens?: number; completionTokens?: number }
  | { type: "error"; message: string }
  /**
   * A finished tool step: the assistant message with its calls, a result for each call and the
   * media attachment, if any. Always complete, so it can be kept even if the turn fails later.
   */
  | { type: "step"; messages: ChatMessage[] }
  /** `messages` holds the messages produced in this turn (tool calls, tool results, final answer). */
  | { type: "done"; content: string; reasoning: string; messages?: ChatMessage[] };

export interface McpTool {
  server: string;
  name: string;
  originalName?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export const REASONING_LEVELS: ReasoningLevel[] = ["none", "low", "medium", "high"];
