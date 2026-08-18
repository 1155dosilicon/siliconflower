import { mkdir } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Applies the Windows 'Hidden' (+h) attribute to a target path.
 * Fails silently if the path does not exist or attrib command fails.
 */
export async function hidePathOnWindows(targetPath: string): Promise<void> {
  try {
    await execAsync(`attrib +h "${targetPath}"`);
  } catch {
    // Ignore errors (e.g., command unavailable)
  }
}

/**
 * Creates a directory recursively (like `mkdir -p`).
 * If the path involves a `.siliconflower` directory, automatically applies
 * the Windows hidden attribute (`attrib +h`) to the `.siliconflower` folder so it remains
 * hidden in Windows File Explorer.
 */
export async function ensureDir(dirPath: string): Promise<string | undefined> {
  const result = await mkdir(dirPath, { recursive: true });

  if (dirPath.includes(".siliconflower")) {
    const parts = dirPath.split(/[/\\]/);
    const idx = parts.findIndex((p) => p === ".siliconflower");
    if (idx !== -1) {
      const siliconflowerPath = parts.slice(0, idx + 1).join("\\");
      await hidePathOnWindows(siliconflowerPath);
    }
  }

  return result;
}
