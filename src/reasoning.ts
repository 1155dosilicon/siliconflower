import type { ReasoningLevel } from "./types.js";

/*
 * What each provider family accepts in the request. Everything sent to an OpenAI-compatible
 * endpoint is a guess until the provider answers: these helpers name the family, and `llm.ts`
 * still adjusts a parameter the provider refuses (see the retries in `makeRequest`).
 */

export type ProviderFamily = "mimo" | "deepseek" | "deepseek-model" | "generic";

function hostnameOf(baseURL: string): string {
  try {
    return new URL(baseURL).hostname.toLowerCase();
  } catch {
    return "";
  }
}

const hostIs = (hostname: string, domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);

export function isXiaomiMimoEndpoint(baseURL: string): boolean {
  return hostIs(hostnameOf(baseURL), "xiaomimimo.com");
}

/**
 * DeepSeek's own API. Two rules of its thinking mode are unlike any other provider:
 * - With `tools` in the request, the `reasoning_content` of every earlier turn has to be sent
 *   back, and only then is it kept in the context: a turn is entirely a tool loop here, so it
 *   always applies. Without the field the model re-reads the whole file it just read.
 * - Thinking is on by default with effort `high`: leaving `reasoning_effort` out does not turn
 *   it off, only `thinking.type = "disabled"` does.
 */
export function isDeepSeekEndpoint(baseURL: string): boolean {
  const hostname = hostnameOf(baseURL);
  return hostname === "api.deepseek.com" || hostname === "api.deepseek.ai";
}

/**
 * Resellers and gateways of DeepSeek's models (SiliconFlow, Aliyun's compatible mode, ...).
 * The model name says DeepSeek, the endpoint cannot be recognized: only what follows from the
 * model itself is applied (a wider window, the larger output cap), never a parameter of the
 * endpoint's API.
 */
export function isDeepSeekModel(model: string): boolean {
  return /deepseek/i.test(model);
}

/**
 * The DeepSeek models with the 1M window: the V4 family, which is what `deepseek-flash` and
 * `deepseek-v4-pro` are on the API and `deepseek-ai/DeepSeek-V4-Pro` is on a gateway. The name is
 * all there is on a gateway, and an older `deepseek-chat`/`deepseek-r1` hosted there has a much
 * smaller window: assuming 1M for it would make the first long request be refused and the turn end
 * in an error instead of compacting.
 */
export function isDeepSeekWideWindow(model: string): boolean {
  return isDeepSeekModel(model) && /v4|flash/i.test(model);
}

export function providerFamily(baseURL: string, model = ""): ProviderFamily {
  if (isXiaomiMimoEndpoint(baseURL)) return "mimo";
  if (isDeepSeekEndpoint(baseURL)) return "deepseek";
  return isDeepSeekModel(model) ? "deepseek-model" : "generic";
}

/**
 * The provider has a thinking mode that has to be turned off explicitly: unlike a reasoning
 * effort, which absent means "off", these models think by default. The flag goes out for a
 * DeepSeek model on any host, and a gateway that rejects it (a 400 naming the parameter) gets
 * the request again without it.
 */
export function hasNativeThinking(baseURL: string, model = ""): boolean {
  const family = providerFamily(baseURL, model);
  return family === "deepseek" || family === "deepseek-model";
}

/** The provider takes `reasoning_effort` with more than one level. */
export function reasoningOptions(baseURL: string): ReasoningLevel[] {
  return isXiaomiMimoEndpoint(baseURL) ? ["none", "high"] : ["none", "low", "medium", "high", "max", "ultra"];
}

/** The level used when the wanted one is not offered: every provider has "high". */
export const DEFAULT_REASONING = "high" satisfies ReasoningLevel;

/** "max" and "ultra" exist only on some providers; a refusal falls back to "high". */
export function isExtendedReasoning(level: ReasoningLevel): boolean {
  return level === "max" || level === "ultra";
}

export function reasoningLabel(level: ReasoningLevel, baseURL: string): string {
  if (isXiaomiMimoEndpoint(baseURL)) return level === "none" ? "off" : "on";
  return ({ none: "off", low: "low", medium: "med", high: "high", max: "max", ultra: "ultra" })[level];
}
