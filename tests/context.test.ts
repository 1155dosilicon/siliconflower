import { describe, expect, test } from "bun:test";
import { estimateTokens, estimateMessagesTokens, compressHistory, processToolOutput, formatTokenCount } from "../src/context.js";
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

  test("compressHistory preserves message order and enforces the token budget", () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "tool",
        content: `Message ${i}: ` + "x".repeat(1000),
      });
    }

    const compressed = compressHistory(messages, 5000);
    expect(compressed.length).toBe(messages.length);
    expect(estimateMessagesTokens(compressed)).toBeLessThanOrEqual(5000);
    expect(compressed[0].role).toBe(messages[0].role);
    expect(compressed[24].role).toBe(messages[24].role);
  });

  test("processToolOutput truncates huge outputs and preserves structure", async () => {
    const hugeOutput = "line\n".repeat(10000);
    const processed = await processToolOutput(hugeOutput, 100);
    expect(processed).toContain("SAÍDA GRANDE TRUNCADA");
  });

  test("processToolOutput bounds a huge single-line output", async () => {
    const hugeOutput = "x".repeat(100_000);
    const processed = await processToolOutput(hugeOutput, 1000);
    expect(processed).toContain("SAÍDA GRANDE TRUNCADA");
    expect(processed.length).toBeLessThan(1500);
  });
});
