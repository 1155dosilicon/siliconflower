import { describe, expect, test } from "bun:test";
import { estimateTokens, estimateMessagesTokens, compressHistory, processToolOutput, formatTokenCount, shrinkToolArguments } from "../src/context.js";
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

  test("processToolOutput leaves an output it already truncated as it is", async () => {
    const once = await processToolOutput("x".repeat(100_000));
    expect(await processToolOutput(once)).toBe(once);
  });
});

describe("compressHistory over the budget", () => {
  const call = (id: string, args: string): ChatMessage => ({
    role: "assistant",
    content: "",
    toolCalls: [{ id, type: "function", function: { name: "write_file", arguments: args } }],
  });

  // Cutting the text left broken JSON, which providers refuse in every later request.
  test("tool-call arguments stay a JSON object and keep their short values", () => {
    const args = JSON.stringify({ path: "/proj/src/app.ts", content: "x".repeat(400) });
    const out = compressHistory(
      [{ role: "user", content: "faça" }, call("c1", args), { role: "tool", toolCallId: "c1", content: "ok" }, { role: "user", content: "y".repeat(400_000) }],
      90_000
    );
    const sent = out.find((m) => m.toolCalls)!.toolCalls![0]!.function.arguments;
    const parsed = JSON.parse(sent);
    expect(parsed.path).toBe("/proj/src/app.ts");
    expect(parsed.content.length).toBeLessThan(200);
    expect(shrinkToolArguments("{quebrado".padEnd(200, "x"))).toBe("{}");
  });

  test("tool results are shrunk before the request the model is working on", () => {
    const request = `Refatore o módulo de pagamentos e mantenha a API pública. ${"Detalhe importante. ".repeat(20)}`;
    const out = compressHistory(
      [
        { role: "user", content: "pedido antigo ".repeat(50) },
        { role: "assistant", content: "feito" },
        { role: "user", content: request },
        call("c1", "{}"),
        { role: "tool", toolCallId: "c1", content: "A".repeat(200_000) },
        call("c2", "{}"),
        { role: "tool", toolCallId: "c2", content: "B".repeat(200_000) },
      ],
      70_000
    );
    expect(out.find((m) => m.content.startsWith("Refatore"))!.content).toBe(request);
    expect(estimateMessagesTokens(out)).toBeLessThanOrEqual(70_000);
    // The newest result is the last to go: the older one is shrunk first.
    expect(out.at(-1)!.content.length).toBeGreaterThan(out.at(-3)!.content.length);
  });

  test("keeps a shortened reasoning on tool calls when the provider requires it (Xiaomi MiMo)", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "oi" },
      { ...call("c1", "{}"), reasoning: "r".repeat(5_000) },
      { role: "tool", toolCallId: "c1", content: "z".repeat(400_000) },
      { role: "assistant", content: "fim", reasoning: "pensamento final" },
    ];
    const mimo = compressHistory(messages, 50_000, { keepToolCallReasoning: true });
    expect(mimo[1]!.reasoning?.length).toBeGreaterThan(0);
    expect(mimo[1]!.reasoning!.length).toBeLessThan(500);
    expect(mimo[3]!.reasoning).toBeUndefined();
    expect(compressHistory(messages, 50_000)[1]!.reasoning).toBeUndefined();
  });
});
