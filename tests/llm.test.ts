import { describe, expect, test } from "bun:test";
import { parseAnthropicToolInput } from "../src/llm.js";

describe("LLM adapters", () => {
  test("reconstructs Anthropic tool input from streamed JSON deltas", () => {
    const fragments = ["{\"path\":", "\"src/index.tsx\",", "\"limit\":200}"];
    expect(parseAnthropicToolInput({}, fragments.join(""))).toEqual({
      path: "src/index.tsx",
      limit: 200,
    });
  });

  test("preserves malformed streamed input for diagnostics", () => {
    expect(parseAnthropicToolInput({}, "{bad")).toEqual({ _raw: "{bad" });
  });
});
