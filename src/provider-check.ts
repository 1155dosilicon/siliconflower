import { isDeepSeekModel } from "./reasoning.js";

const CHECK_TIMEOUT_MS = 30_000;

export interface ProviderTarget {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface ProviderCheck {
  ok: boolean;
  /** For the user, in pt-BR, and never with the key in it. */
  message: string;
  /** HTTP status of a refusal. Undefined when the model answered or the provider was not reached. */
  status?: number;
}

/** Provider messages can echo the request: never let the key reach the screen. */
function scrub(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join("***") : text;
}

/**
 * Sends the smallest possible request, to tell a typo (address, key, model) from a real answer.
 * Used by the settings form of the desktop app and by `siliconflower doctor`.
 *
 * A DeepSeek model gets the same parameters a real turn sends (`thinking` and
 * `reasoning_effort`): a gateway can accept the key and the model and still refuse one of them,
 * which would only show up on the user's first message. If it refuses one, the request is
 * repeated without them so the check still tells credentials from parameters, and the message
 * says what the agent will do.
 */
export async function checkProvider(
  target: ProviderTarget,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = CHECK_TIMEOUT_MS
): Promise<ProviderCheck> {
  const url = `${target.baseURL.replace(/\/+$/, "")}/chat/completions`;
  const request = (params: Record<string, unknown>) => fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${target.apiKey}` },
    body: JSON.stringify({
      model: target.model,
      messages: [{ role: "user", content: "Responda apenas: ok" }],
      ...params,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const attempt = async (params: Record<string, unknown>) => {
    const response = await request(params);
    return { ok: response.ok, status: response.status, body: await response.text() };
  };
  try {
    const deepseek = isDeepSeekModel(target.model);
    const params: Record<string, unknown> = {
      max_tokens: 16,
      ...(deepseek ? { thinking: { type: "enabled" }, reasoning_effort: "high" } : {}),
    };
    let result = await attempt(params);
    let note = "";
    if (!result.ok && result.status === 400 && deepseek && /thinking|reasoning_effort/i.test(result.body)) {
      delete params.thinking;
      delete params.reasoning_effort;
      note = " O provedor recusa `thinking` e/ou `reasoning_effort`: o agente repete o pedido sem eles.";
      result = await attempt(params);
    }
    // Some models accept only the newer name of this parameter.
    if (!result.ok && result.status === 400 && /max_tokens/.test(result.body)) {
      delete params.max_tokens;
      params.max_completion_tokens = 16;
      result = await attempt(params);
    }
    if (result.ok) return { ok: true, message: `Conexão ok: o modelo ${target.model} respondeu.${note}` };
    let detail = result.body;
    try {
      const parsed = JSON.parse(result.body);
      detail = parsed?.error?.message ?? parsed?.message ?? result.body;
    } catch {
      // not JSON: show it as it came
    }
    return {
      ok: false,
      status: result.status,
      message: scrub(`O provedor respondeu ${result.status}: ${String(detail).slice(0, 400)}`, target.apiKey),
    };
  } catch (e) {
    const reason = e instanceof Error && e.name === "TimeoutError" ? "o provedor não respondeu a tempo" : e instanceof Error ? e.message : String(e);
    return { ok: false, message: scrub(`Não consegui conectar: ${reason}`, target.apiKey) };
  }
}