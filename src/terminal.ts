/**
 * Terminal Screen and Viewport Manager for Siliconflower.
 *
 * Implements full Alternate Screen Buffer management (\x1b[?1049h / \x1b[?1049l)
 * to provide a clean, isolated full-screen TUI experience matching major harnesses
 * like Claude Code and Antigravity CLI, preserving the user's shell history upon exit.
 */

export const ANSI_ENTER_ALT_SCREEN = "\x1b[?1049h\x1b[2J\x1b[3J\x1b[H";
export const ANSI_LEAVE_ALT_SCREEN = "\x1b[?1049l\x1b[?25h";

let inAlternateScreen = false;
let lifecycleRegistered = false;

export interface TerminalOptions {
  force?: boolean;
  stream?: NodeJS.WriteStream;
}

/**
 * Activates the Alternate Screen Buffer, clears the display & scrollback,
 * and sets the cursor to (0,0).
 */
export function enterAlternateScreen(options?: TerminalOptions): boolean {
  const stream = options?.stream ?? process.stdout;
  const isTty = Boolean(stream.isTTY || options?.force);

  if (!isTty) {
    return false;
  }

  if (!inAlternateScreen) {
    stream.write(ANSI_ENTER_ALT_SCREEN);
    inAlternateScreen = true;
  }

  registerLifecycleHooks(stream);
  return true;
}

/**
 * Restores the Primary Screen Buffer and ensures cursor visibility.
 */
export function leaveAlternateScreen(options?: TerminalOptions): boolean {
  const stream = options?.stream ?? process.stdout;
  const isTty = Boolean(stream.isTTY || options?.force);

  if (inAlternateScreen) {
    if (isTty) {
      stream.write(ANSI_LEAVE_ALT_SCREEN);
    }
    inAlternateScreen = false;
    return true;
  }
  return false;
}

/**
 * Checks whether the Alternate Screen Buffer is currently active.
 */
export function isAlternateScreenActive(): boolean {
  return inAlternateScreen;
}

/**
 * Registers exit and signal listeners to guarantee terminal restoration.
 */
function registerLifecycleHooks(stream: NodeJS.WriteStream) {
  if (lifecycleRegistered) return;
  lifecycleRegistered = true;

  const restore = () => {
    leaveAlternateScreen({ stream, force: true });
  };

  process.once("exit", restore);

  const handleSignal = () => {
    restore();
    process.exit(0);
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);
  if (process.platform === "win32") {
    process.once("SIGBREAK" as NodeJS.Signals, handleSignal);
  }
}
