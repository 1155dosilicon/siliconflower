import { mkdir } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Applies the Windows 'Hidden' (+h) attribute to a target path if running on Windows.
 * Fails silently if the path does not exist or attrib command fails.
 */
export async function hidePathOnWindows(targetPath: string): Promise<void> {
  if (process.platform === "win32") {
    try {
      await execAsync(`attrib +h "${targetPath}"`);
    } catch {
      // Ignore errors (e.g., non-Windows environment or command unavailable)
    }
  }
}

/**
 * Creates a directory recursively (like `mkdir -p`).
 * On Windows, if the path involves a `.siliconflower` directory, automatically applies
 * the Windows hidden attribute (`attrib +h`) to the `.siliconflower` folder so it remains
 * hidden in Windows File Explorer.
 */
export async function ensureDir(dirPath: string): Promise<string | undefined> {
  const result = await mkdir(dirPath, { recursive: true });

  if (process.platform === "win32" && dirPath.includes(".siliconflower")) {
    const parts = dirPath.split(/[/\\]/);
    const idx = parts.findIndex((p) => p === ".siliconflower");
    if (idx !== -1) {
      const siliconflowerPath = parts.slice(0, idx + 1).join("\\");
      await hidePathOnWindows(siliconflowerPath);
    }
  }

  return result;
}
