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
 * Sends the smallest possible request, to tell a typo (address, key, model) from a real
 * answer. Used by the settings form of the desktop app and by `siliconflower doctor`.
 */
export async function checkProvider(
  target: ProviderTarget,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = CHECK_TIMEOUT_MS
): Promise<ProviderCheck> {
  const url = `${target.baseURL.replace(/\/+$/, "")}/chat/completions`;
  const request = (limit: Record<string, number>) => fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${target.apiKey}` },
    body: JSON.stringify({ model: target.model, messages: [{ role: "user", content: "Responda apenas: ok" }], ...limit }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  try {
    let response = await request({ max_tokens: 16 });
    let body = await response.text();
    // Some models accept only the newer name of this parameter.
    if (response.status === 400 && /max_tokens/.test(body)) {
      response = await request({ max_completion_tokens: 16 });
      body = await response.text();
    }
    if (response.ok) return { ok: true, message: `Conexão ok: o modelo ${target.model} respondeu.` };
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      detail = parsed?.error?.message ?? parsed?.message ?? body;
    } catch {
      // not JSON: show it as it came
    }
    return {
      ok: false,
      status: response.status,
      message: scrub(`O provedor respondeu ${response.status}: ${String(detail).slice(0, 400)}`, target.apiKey),
    };
  } catch (e) {
    const reason = e instanceof Error && e.name === "TimeoutError" ? "o provedor não respondeu a tempo" : e instanceof Error ? e.message : String(e);
    return { ok: false, message: scrub(`Não consegui conectar: ${reason}`, target.apiKey) };
  }
}
