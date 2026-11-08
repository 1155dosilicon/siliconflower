import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigFileError, configFile, loadConfig, loadStoredConfig, saveConfig } from "../src/config.js";
import type { AppConfig } from "../src/types.js";

const config: AppConfig = { baseURL: "https://x/v1", apiKey: "chave", model: "m", reasoning: "none" };

describe("saveConfig", () => {
  test("replaces the file whole and leaves no temporary file behind", async () => {
    await saveConfig(config);
    await saveConfig({ ...config, apiKey: "nova" });
    expect(JSON.parse(await readFile(configFile(), "utf8")).apiKey).toBe("nova");
    expect((await readdir(dirname(configFile()))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("only the owner can read the saved file", async () => {
    await rm(configFile(), { force: true });
    await saveConfig(config);
    expect((await stat(configFile())).mode & 0o777).toBe(0o600);
    await chmod(configFile(), 0o664);
    await saveConfig(config);
    expect((await stat(configFile())).mode & 0o777).toBe(0o600);
  });

  test.skipIf(process.platform === "win32")("a file left readable by an older version is fixed on load", async () => {
    await saveConfig(config);
    await chmod(configFile(), 0o664);
    expect((await loadStoredConfig())?.apiKey).toBe("chave");
    expect((await stat(configFile())).mode & 0o777).toBe(0o600);
  });

  test.skipIf(process.platform === "win32")("writes through a symlink instead of replacing it", async () => {
    const dir = join(tmpdir(), `sf_config_link_${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const real = join(dir, "config.json");
    await writeFile(real, "{}", "utf8");
    await rm(configFile(), { force: true });
    await symlink(real, configFile());
    try {
      await saveConfig(config);
      expect((await lstat(configFile())).isSymbolicLink()).toBe(true);
      expect(JSON.parse(await readFile(real, "utf8")).apiKey).toBe("chave");
    } finally {
      await rm(configFile(), { force: true });
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// A damaged file used to look like a missing one: the wizard or the settings form then saved a
// new file over it, losing what only the file had (hooks, MCP servers).
describe("a config.json that cannot be used", () => {
  async function withFile(text: string, check: () => Promise<void>) {
    await mkdir(dirname(configFile()), { recursive: true });
    await writeFile(configFile(), text, "utf8");
    try {
      await check();
    } finally {
      await rm(configFile(), { force: true });
    }
  }

  test("is an error, not a missing file, and is left untouched", async () => {
    const broken = '{ "apiKey": "k", "hooks": { "onEdit": "npm run lint" }, }';
    await withFile(broken, async () => {
      await expect(loadStoredConfig()).rejects.toBeInstanceOf(ConfigFileError);
      await expect(loadConfig()).rejects.toThrow("não é um JSON válido");
      expect(await readFile(configFile(), "utf8")).toBe(broken);
    });
    await withFile("[]", async () => {
      await expect(loadStoredConfig()).rejects.toBeInstanceOf(ConfigFileError);
    });
  });

  test("a missing file is still no config", async () => {
    await rm(configFile(), { force: true });
    expect(await loadStoredConfig()).toBeNull();
  });

  test("accepts the BOM of Windows editors and ignores fields of the wrong type", async () => {
    const odd = { apiKey: "k", model: 5, mode: 3, system: ["x"], hooks: { onEdit: "lint", postTool: 1 }, mcpServers: [] };
    await withFile(`\uFEFF${JSON.stringify(odd)}`, async () => {
      const cfg = await loadStoredConfig();
      expect(cfg).toMatchObject({ apiKey: "k", model: "", mode: "programação", hooks: { onEdit: "lint" }, mcpServers: {} });
      expect(cfg?.system).toBeUndefined();
    });
  });
});
