import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AgentStartError, childEnv, startAgentProcess } from "../desktop/src/agent-process.js";
import { addRecent, folderKey, loadRecents, MAX_RECENTS, removeRecent } from "../desktop/src/projects.js";
import { applyInput, isConfigured, maskKey, parseInput, parseMcp, readSettings, testConnection, writeSettings, type SettingsInput } from "../desktop/src/settings.js";
import { configFile } from "../src/config.js";

const ENTRY = resolve(import.meta.dir, "..", "src", "index.tsx");
const AGENT_ARGS = ["run", ENTRY, "gui", "--managed"];

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sf-desktop-"));
}

const isWin = process.platform === "win32";

describe("recent projects", () => {
  test.skipIf(!isWin)("keeps the latest first, without duplicates that differ only in case", () => {
    const file = join(tempDir(), "sub", "projects.json");
    addRecent(file, "C:\\Projetos\\A");
    addRecent(file, "C:\\Projetos\\B");
    const recents = addRecent(file, "c:\\projetos\\a\\");
    expect(recents.map((p) => folderKey(p.path))).toEqual(["c:\\projetos\\a", "c:\\projetos\\b"]);
    expect(loadRecents(file)).toEqual(recents);
  });

  test.skipIf(isWin)("Unix: folders that differ only in case are different projects", () => {
    const file = join(tempDir(), "sub", "projects.json");
    addRecent(file, "/home/u/Projetos/A");
    addRecent(file, "/home/u/projetos/a");
    const recents = addRecent(file, "/home/u/Projetos/A/");
    expect(recents.map((p) => folderKey(p.path))).toEqual(["/home/u/Projetos/A", "/home/u/projetos/a"]);
  });

  test("folderKey folds case only on Windows", () => {
    expect(folderKey("/x/AbC", "linux")).toBe(resolve("/x/AbC"));
    expect(folderKey("/x/AbC", "win32")).toBe(resolve("/x/AbC").toLowerCase());
  });

  test("limits the list and removes entries", () => {
    const file = join(tempDir(), "projects.json");
    for (let i = 0; i < MAX_RECENTS + 5; i++) addRecent(file, `C:\\p${i}`);
    expect(loadRecents(file)).toHaveLength(MAX_RECENTS);
    expect(removeRecent(file, `C:\\p${MAX_RECENTS + 4}`)).toHaveLength(MAX_RECENTS - 1);
  });

  test("a damaged file costs only the list", () => {
    const dir = tempDir();
    const file = join(dir, "projects.json");
    writeFileSync(file, "{ isso não é json");
    expect(loadRecents(file)).toEqual([]);
    writeFileSync(file, JSON.stringify([{ path: 1 }, { path: "C:\\ok", lastOpened: "x" }, null]));
    expect(loadRecents(file).map((p) => p.path)).toEqual(["C:\\ok"]);
    addRecent(file, "C:\\novo");
    expect(readdirSync(dir)).toEqual(["projects.json"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toHaveLength(2);
  });
});

describe("settings", () => {
  const stored = { baseURL: "https://a.example/v1", apiKey: "chave-salva-muito-longa-1234", model: "m", reasoning: "high" as const, mode: "plano" as const, hooks: { onEdit: "echo" }, mcpServers: {} };
  const form = (changes: Partial<SettingsInput> = {}): SettingsInput => ({ baseURL: "https://b.example/v1", apiKey: "", model: "n", reasoning: "low", system: "", mcp: "", ...changes });

  test("only the end of the key reaches the page, and short keys not even that", () => {
    expect(maskKey("chave-salva-muito-longa-1234")).toBe("***1234");
    expect(maskKey("curta1234")).toBe("***");
    expect(maskKey("")).toBe("");
  });

  test("a blank key keeps the saved one, and a new one replaces it", () => {
    expect(applyInput(stored, form()).config?.apiKey).toBe(stored.apiKey);
    expect(applyInput(stored, form({ apiKey: "  nova  " })).config?.apiKey).toBe("nova");
  });

  test("keeps what the form does not show", () => {
    expect(applyInput(stored, form()).config).toMatchObject({ mode: "plano", hooks: { onEdit: "echo" } });
  });

  test("first use with an empty form points at each field", () => {
    const { errors } = applyInput(null, { baseURL: "ftp://x", apiKey: "", model: " ", reasoning: "high", system: "", mcp: "{" });
    expect(Object.keys(errors ?? {}).sort()).toEqual(["apiKey", "baseURL", "mcp", "model"]);
  });

  test("a level the provider does not offer falls back to one it does", () => {
    expect(applyInput(stored, form({ baseURL: "https://api.xiaomimimo.com/v1", reasoning: "low" })).config?.reasoning).toBe("high");
  });

  test("MCP accepts the two usual shapes and explains what is wrong", () => {
    const server = { arquivos: { command: "npx", args: ["-y", "x"] } };
    expect(parseMcp(JSON.stringify(server)).servers).toEqual(server);
    expect(parseMcp(JSON.stringify({ mcpServers: server })).servers).toEqual(server);
    expect(parseMcp("").servers).toEqual({});
    expect(parseMcp("{ quebrado").error).toContain("inválido");
    expect(parseMcp("[1]").error).toBeTruthy();
    expect(parseMcp(`{"a":{"args":[]}}`).error).toContain('"a"');
    expect(parseMcp(`{"a":{"command":"x","args":"y"}}`).error).toContain("args");
    expect(parseMcp(`{"a":{"command":"x","env":{"K":1}}}`).error).toContain("env");
  });

  test("the page cannot send anything but limited text", () => {
    expect(parseInput(null)).toBeNull();
    expect(parseInput({ baseURL: 1 })).toBeNull();
    expect(parseInput({ baseURL: "x".repeat(3000) })).toBeNull();
    expect(parseInput({ model: "m" })).toMatchObject({ model: "m", apiKey: "" });
  });

  test("the connection test never shows the key, even if the provider echoes it", async () => {
    const key = "chave-secreta-do-formulario";
    const echo = (async () => new Response(JSON.stringify({ error: { message: `chave ${key} recusada` } }), { status: 401 })) as unknown as typeof fetch;
    const { ok, message } = await testConnection(form({ apiKey: key }), echo);
    expect(ok).toBe(false);
    expect(message).toContain("401");
    expect(message).not.toContain(key);
  });

  test("the connection test retries with the newer token limit", async () => {
    const bodies: any[] = [];
    const picky = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return body.max_tokens ? new Response(`{"error":{"message":"use max_completion_tokens instead of max_tokens"}}`, { status: 400 }) : new Response("{}");
    }) as unknown as typeof fetch;
    expect((await testConnection(form({ apiKey: "k" }), picky)).ok).toBe(true);
    expect(bodies[1].max_completion_tokens).toBe(16);
  });

  test("a provider that cannot be reached is a message, not a crash", async () => {
    const down = (async () => { throw new Error("recusada"); }) as unknown as typeof fetch;
    expect((await testConnection(form({ apiKey: "k" }), down)).message).toContain("recusada");
  });
});

describe("installer config", () => {
  const desktop = resolve(import.meta.dir, "..", "desktop");
  const builder = readFileSync(join(desktop, "electron-builder.yml"), "utf8");
  const main = readFileSync(join(desktop, "src", "main.ts"), "utf8");

  test("the agent ships where the app looks for it, on each platform", () => {
    expect(builder).toContain("to: siliconflower.exe");
    expect(builder).toMatch(/to: siliconflower$/m);
    expect(main).toContain(`process.platform === "win32" ? "siliconflower.exe" : "siliconflower"`);
    expect(main).toContain("join(process.resourcesPath, AGENT_EXE)");
  });

  test("the taskbar groups the app under the id of the installer", () => {
    const appId = builder.match(/^appId: (.+)$/m)?.[1]?.trim();
    expect(main).toContain(`app.setAppUserModelId("${appId}")`);
  });

  test("does not install over the folder of the command line version", () => {
    // Per-user installs go to Programs\<package name>; scripts/install.ps1 uses Programs\siliconflower.
    const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
    expect(pkg.name).not.toBe("siliconflower");
    expect(readFileSync(resolve(desktop, "..", "scripts", "install.ps1"), "utf8")).toMatch(/Programs\\siliconflower/i);
  });

  test("Linux ships an AppImage and a .deb that can be built", () => {
    // electron-builder refuses a .deb without a homepage and a maintainer (or author email).
    const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
    expect(builder).toMatch(/^\s+- AppImage$/m);
    expect(builder).toMatch(/^\s+- deb$/m);
    expect(builder).toMatch(/^\s+maintainer: \S/m);
    expect(pkg.homepage).toStartWith("https://");
    // The window, the .deb entry and scripts/install-appimage.sh all use this name.
    expect(pkg.desktopName).toBe("siliconflower-desktop.desktop");
    expect(builder).toContain("executableName: siliconflower-desktop");
  });

  test("the installed app cannot be used to run other code", () => {
    for (const fuse of ["runAsNode: false", "enableNodeOptionsEnvironmentVariable: false", "enableNodeCliInspectArguments: false", "onlyLoadAppFromAsar: true"]) {
      expect(builder).toContain(fuse);
    }
  });
});

test("the agent does not inherit Electron's variables", () => {
  expect(childEnv({ PATH: "x", ELECTRON_RUN_AS_NODE: "1", electron_no_asar: "1" })).toEqual({ PATH: "x" });
});

describe("agent process", () => {
  let configured: string;
  let unconfigured: string;
  let project: string;

  beforeAll(() => {
    configured = tempDir();
    unconfigured = tempDir();
    project = tempDir();
    writeFileSync(join(configured, "config.json"), JSON.stringify({ baseURL: "http://127.0.0.1:9/v1", apiKey: "k", model: "m" }));
  });

  afterAll(() => {
    for (const dir of [configured, unconfigured, project]) rmSync(dir, { recursive: true, force: true });
  });

  const envFor = (dataDir: string): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, SILICONFLOWER_DATA_DIR: dataDir };
    for (const name of ["SILICONFLOWER_API_KEY", "SILICONFLOWER_BASE_URL", "SILICONFLOWER_MODEL"]) delete env[name];
    return env;
  };

  test("missing config is reported instead of waiting for the wizard", async () => {
    const agent = startAgentProcess({ exe: process.execPath, args: AGENT_ARGS, cwd: project, env: envFor(unconfigured) });
    const error = await agent.ready.catch((e) => e);
    expect(error).toBeInstanceOf(AgentStartError);
    expect(error.failure).toBe("config_required");
    expect((await agent.exited).code).toBe(1);
  }, 20_000);

  test("the plain gui command also refuses the wizard without a terminal", async () => {
    const proc = Bun.spawn([process.execPath, "run", ENTRY, "gui", "--no-open"], {
      cwd: project,
      env: envFor(unconfigured),
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(1);
    expect(stderr).toContain("siliconflower config");
  }, 20_000);

  test("reports the URL, serves it, and closing stdin ends the process cleanly", async () => {
    const agent = startAgentProcess({ exe: process.execPath, args: AGENT_ARGS, cwd: project, env: envFor(configured) });
    const url = await agent.ready;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}$/);
    expect((await fetch(url, { redirect: "manual" })).status).toBe(303);
    await agent.stop();
    expect((await agent.exited).code).toBe(0);
    expect(fetch(url)).rejects.toThrow();
  }, 20_000);

  test("a program that ignores the request to close is killed", async () => {
    const script = join(project, "stubborn.ts");
    writeFileSync(script, `console.log(JSON.stringify({ event: "ready", url: "http://127.0.0.1:1/" })); process.stdin.resume(); process.stdin.on("end", () => {}); setInterval(() => {}, 1000);`);
    const agent = startAgentProcess({ exe: process.execPath, args: ["run", script], cwd: project, stopTimeoutMs: 300 });
    await agent.ready;
    await agent.stop();
    expect(await Promise.race([agent.exited.then(() => "exited"), Bun.sleep(5_000).then(() => "alive")])).toBe("exited");
  }, 20_000);

  test("a damaged config is reported, and the file is left as it was", async () => {
    const damaged = tempDir();
    const broken = '{ "apiKey": "k", }';
    writeFileSync(join(damaged, "config.json"), broken);
    try {
      const agent = startAgentProcess({ exe: process.execPath, args: AGENT_ARGS, cwd: project, env: envFor(damaged) });
      const error = await agent.ready.catch((e) => e);
      expect(error.failure).toBe("exited");
      expect(error.detail).toContain("não é um JSON válido");
      expect(readFileSync(join(damaged, "config.json"), "utf8")).toBe(broken);
    } finally {
      rmSync(damaged, { recursive: true, force: true });
    }
  }, 20_000);

  test("a missing executable is an error, not a crash", async () => {
    const agent = startAgentProcess({ exe: join(project, "nao-existe.exe"), cwd: project });
    const error = await agent.ready.catch((e) => e);
    expect(error.failure).toBe("spawn_failed");
    await agent.stop();
  });
});

describe("settings form with a damaged config.json", () => {
  // The form used to open empty and saving replaced the file: hooks and MCP servers were lost.
  test("shows the problem and never saves over the file", async () => {
    const broken = '{ "baseURL": "https://a.example/v1", "apiKey": "chave-salva-muito-longa", "model": "m", "hooks": { "onEdit": "lint" }, }';
    mkdirSync(dirname(configFile()), { recursive: true });
    writeFileSync(configFile(), broken);
    try {
      expect((await readSettings({})).fileError).toContain("não é um JSON válido");
      expect(await isConfigured()).toBe(false);
      const res = await writeSettings({ baseURL: "https://b.example/v1", apiKey: "outra-chave-1234567", model: "n", reasoning: "high", system: "", mcp: "" });
      expect(res.ok).toBe(false);
      expect(res.fileError).toContain("não foi alterado");
      expect(readFileSync(configFile(), "utf8")).toBe(broken);
    } finally {
      rmSync(configFile(), { force: true });
    }
  });
});
