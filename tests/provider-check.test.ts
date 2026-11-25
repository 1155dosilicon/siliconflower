import { describe, expect, test } from "bun:test";
import { checkProvider } from "../src/provider-check.js";

const target = (model: string) => ({ baseURL: "https://exemplo.test/v1", apiKey: "k-123456789", model });

/** A fetch that answers with `responses` in order and records the bodies it saw. */
function scripted(responses: Response[]) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return responses[bodies.length - 1] ?? responses.at(-1)!;
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

const ok = () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 });
const refusal = (message: string, status = 400) =>
  new Response(JSON.stringify({ error: { message } }), { status, headers: { "Content-Type": "application/json" } });

describe("provider check", () => {
  test("a DeepSeek model is tested with the parameters a real turn sends", async () => {
    const provider = scripted([ok()]);
    const check = await checkProvider(target("deepseek-v4.1-flash"), provider.fetchImpl);
    expect(check.ok).toBe(true);
    expect(check.message).toBe("Conexão ok: o modelo deepseek-v4.1-flash respondeu.");
    expect(provider.bodies[0]?.thinking).toEqual({ type: "enabled" });
    expect(provider.bodies[0]?.reasoning_effort).toBe("high");
    expect(provider.bodies[0]?.max_tokens).toBe(16);
  });

  test("a gateway that refuses them still reports the connection and says the agent drops them", async () => {
    const provider = scripted([refusal("Unsupported parameter: thinking"), ok()]);
    const check = await checkProvider(target("deepseek-v4.1-flash"), provider.fetchImpl);
    expect(check.ok).toBe(true);
    expect(provider.bodies).toHaveLength(2);
    expect(provider.bodies[1]?.thinking).toBeUndefined();
    expect(provider.bodies[1]?.reasoning_effort).toBeUndefined();
    expect(check.message).toContain("recusa");
  });

  test("a model of another family is not sent the DeepSeek parameters", async () => {
    const provider = scripted([ok()]);
    await checkProvider(target("qwen3-max"), provider.fetchImpl);
    expect(provider.bodies[0]?.thinking).toBeUndefined();
    expect(provider.bodies[0]?.reasoning_effort).toBeUndefined();
  });

  test("a refused key fails and the key never reaches the message", async () => {
    const provider = scripted([refusal("Invalid API key: k-123456789", 401)]);
    const check = await checkProvider(target("deepseek-v4.1-flash"), provider.fetchImpl);
    expect(check.ok).toBe(false);
    expect(check.status).toBe(401);
    expect(check.message).toContain("***");
    expect(check.message).not.toContain("k-123456789");
  });
});