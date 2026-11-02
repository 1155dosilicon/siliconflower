/**
 * Protocol of `siliconflower gui --managed`, used by the desktop app: one JSON line on
 * stdout per event. The URL carries the access token, so it must never reach a log.
 * Closing stdin asks the process to shut down cleanly (it also happens if the parent dies).
 */
export type ManagedEvent =
  | { event: "ready"; url: string }
  | { event: "error"; code: "config_required" };

export function emitManagedEvent(event: ManagedEvent): void {
  console.log(JSON.stringify(event));
}
