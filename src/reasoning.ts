import type { ReasoningLevel } from "./types.js";

export function isXiaomiMimoEndpoint(baseURL: string): boolean {
  try {
    const hostname = new URL(baseURL).hostname.toLowerCase();
    return hostname === "xiaomimimo.com" || hostname.endsWith(".xiaomimimo.com");
  } catch {
    return false;
  }
}

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
