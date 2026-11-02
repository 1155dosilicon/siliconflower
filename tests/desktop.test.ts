import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentStartError, childEnv, startAgentProcess } from "../desktop/src/agent-process.js";
import { addRecent, folderKey, loadRecents, MAX_RECENTS, removeRecent } from "../desktop/src/projects.js";

const ENTRY = resolve(import.meta.dir, "..", "src", "index.tsx");
const AGENT_ARGS = ["run", ENTRY, "gui", "--managed"];

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "sf-desktop-"));
}

describe("recent projects", () => {
  test("keeps the latest first, without duplicates that differ only in case", () => {
    const file = join(tempDir(), "sub", "projects.json");
    addRecent(file, "C:\\Projetos\\A");
    addRecent(file, "C:\\Projetos\\B");
    const recents = addRecent(file, "c:\\projetos\\a\\");
    expect(recents.map((p) => folderKey(p.path))).toEqual(["c:\\projetos\\a", "c:\\projetos\\b"]);
    expect(loadRecents(file)).toEqual(recents);
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

  test("a missing executable is an error, not a crash", async () => {
    const agent = startAgentProcess({ exe: join(project, "nao-existe.exe"), cwd: project });
    const error = await agent.ready.catch((e) => e);
    expect(error.failure).toBe("spawn_failed");
    await agent.stop();
  });
});
