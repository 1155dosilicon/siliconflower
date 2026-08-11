import { describe, expect, test } from "bun:test";
import { estimateTokens, compressHistory, processToolOutput, formatTokenCount } from "../src/context.js";
import type { ChatMessage } from "../src/types.js";

describe("context & token management", () => {
  test("formatTokenCount formats numbers accurately", () => {
    expect(formatTokenCount(850)).toBe("850");
    expect(formatTokenCount(1200)).toBe("1.2K");
    expect(formatTokenCount(35400)).toBe("35.4K");
    expect(formatTokenCount(1500000)).toBe("1.50M");
  });
  test("estimateTokens calculates approximate token count", () => {
    const text = "Hello world from Siliconflower CLI agent";
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(text.length);
  });

  test("compressHistory keeps recent messages intact and reduces old tool results", () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "tool",
        content: `Message ${i}: ` + "x".repeat(1000),
      });
    }

    const compressed = compressHistory(messages, 5000);
    expect(compressed.length).toBe(messages.length);
    // Old tool output should be compressed
    expect(compressed[1].content).toContain("Resultado antigo de ferramenta reduzido");
    // Recent messages should remain intact
    expect(compressed[24].content).not.toContain("Resultado antigo de ferramenta reduzido");
  });

  test("processToolOutput truncates huge outputs and preserves structure", async () => {
    const hugeOutput = "line\n".repeat(10000);
    const processed = await processToolOutput(hugeOutput, 100);
    expect(processed).toContain("SAÍDA GRANDE TRUNCADA");
  });
});
