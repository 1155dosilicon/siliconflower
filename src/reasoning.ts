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
  return isXiaomiMimoEndpoint(baseURL) ? ["none", "high"] : ["none", "low", "medium", "high"];
}

export function reasoningLabel(level: ReasoningLevel, baseURL: string): string {
  if (isXiaomiMimoEndpoint(baseURL)) return level === "none" ? "off" : "on";
  return ({ none: "off", low: "low", medium: "med", high: "high" })[level];
}
