import { describe, expect, test } from "bun:test";
import { buildOpenAIMessages, buildOpenAITools, enrichError } from "../src/llm.js";
import type { AppConfig, ChatMessage, McpTool } from "../src/types.js";

const testConfig: AppConfig = {
  baseURL: "https://api.siliconflow.com/v1",
  apiKey: "test-key",
  model: "deepseek-ai/DeepSeek-V3",
  system: "You are a helpful coding assistant.",
  reasoning: "high",
  mode: "programação",
};

describe("OpenAI LLM adapter", () => {
  test("builds OpenAI message structure with system and user messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Hello!" },
      { role: "assistant", content: "Hi! How can I help?" },
    ];

    const result = buildOpenAIMessages(testConfig, messages);
    expect(result.length).toBe(3);
    expect(result[0]).toEqual({ role: "system", content: "You are a helpful coding assistant." });
    expect(result[1]).toEqual({ role: "user", content: "Hello!" });
    expect(result[2]).toEqual({ role: "assistant", content: "Hi! How can I help?" });
  });

  test("properly formats tool calls and tool responses", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_123",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"src/index.ts"}' },
          },
        ],
      },
      {
        role: "tool",
        content: "file content here",
        toolCallId: "call_123",
      },
    ];

    const result = buildOpenAIMessages({ ...testConfig, system: undefined }, messages);
    expect(result.length).toBe(2);
    expect(result[0]).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_123",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"src/index.ts"}' },
        },
      ],
    });
    expect(result[1]).toEqual({
      role: "tool",
      content: "file content here",
      tool_call_id: "call_123",
    });
  });

  test("builds OpenAI function tool definitions", () => {
    const tools: McpTool[] = [
      {
        server: "builtin",
        name: "test_tool",
        description: "A test tool",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ];

    const openAiTools = buildOpenAITools(tools);
    expect(openAiTools.length).toBe(1);
    expect(openAiTools[0].type).toBe("function");
    expect(openAiTools[0].function.name).toBe("test_tool");
    expect(openAiTools[0].function.description).toBe("A test tool");
  });

  test("enriches errors with HTTP status and helpful hints", () => {
    const err404 = { status: 404, message: "Not Found" };
    expect(enrichError(err404, testConfig)).toContain("404: check the baseURL and the model ID");

    const err401 = { status: 401, message: "Unauthorized" };
    expect(enrichError(err401, testConfig)).toContain("401: API key is invalid");
  });
});
