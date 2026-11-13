import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatDoctorReport, runDoctor, type DoctorCheck, type DoctorReport } from "../src/doctor.js";
import { configFile } from "../src/config.js";
import { workspaceHooksFile } from "../src/core/hooks.js";
import { getGlobalDataDir, getWorkspaceDataDir } from "../src/fs-util.js";
import { log, logFile } from "../src/logger.js";

const isWin = process.platform === "win32";
const ENV_NAMES = ["SILICONFLOWER_API_KEY", "SILICONFLOWER_BASE_URL", "SILICONFLOWER_MODEL"];
const KEY = "chave-secreta-do-doctor";
const VALID = { baseURL: "https://api.exemplo.test/v1", apiKey: KEY, model: "modelo-teste" };

const answers = (status: number, body = "{}") => (async () => new Response(body, { status })) as unknown as typeof fetch;
const find = (report: DoctorReport, id: string): DoctorCheck => report.checks.find((c) => c.id === id)!;

describe("siliconflower doctor", () => {
  let cwd: string;
  let savedConfig: string | undefined;
  const savedEnv = new Map<string, string | undefined>();

  beforeAll(() => {
    // The data folder is shared by the whole suite: leave config.json as it was found.
    savedConfig = existsSync(configFile()) ? readFileSync(configFile(), "utf8") : undefined;
    for (const name of ENV_NAMES) savedEnv.set(name, process.env[name]);
  });

  afterAll(() => {
    if (savedConfig === undefined) rmSync(configFile(), { force: true });
    else writeFileSync(configFile(), savedConfig);
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "sf-doctor-"));
    for (const name of ENV_NAMES) delete process.env[name];
    rmSync(configFile(), { force: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(getWorkspaceDataDir(cwd), { recursive: true, force: true });
  });

  function writeConfig(config: unknown): void {
    mkdirSync(dirname(configFile()), { recursive: true });
    writeFileSync(configFile(), typeof config === "string" ? config : JSON.stringify(config));
  }

  test("a working setup passes, and the real shell is exercised", async () => {
    writeConfig(VALID);
    const report = await runDoctor({ cwd, fetchImpl: answers(200) });

    expect(report.ok).toBe(true);
    expect(find(report, "config").status).toBe("ok");
    expect(find(report, "config").detail).toContain("api.exemplo.test");
    expect(find(report, "provider").status).toBe("ok");
    expect(find(report, "shell").status).toBe("ok");
    // On Unix the suite's folder follows the umask, which is a warning (tested below).
    expect(find(report, "data-dir").status).not.toBe("fail");
    expect(find(report, "mcp").detail).toBe("nenhum configurado");
    expect(find(report, "project").detail).toContain("não é um projeto");
  }, 60_000);

  test("without any configuration it fails and says how to configure", async () => {
    const report = await runDoctor({ cwd, offline: true });

    expect(report.ok).toBe(false);
    const config = find(report, "config");
    expect(config.status).toBe("fail");
    expect(config.detail).toContain("não existe");
    expect(config.hint).toContain("siliconflower config");
    // Nothing to test the provider with.
    expect(find(report, "provider").status).toBe("skip");
  }, 60_000);

  test("the environment fills what the file lacks, and the report says which variables are in use", async () => {
    writeConfig({});
    process.env.SILICONFLOWER_API_KEY = KEY;
    process.env.SILICONFLOWER_BASE_URL = VALID.baseURL;
    process.env.SILICONFLOWER_MODEL = VALID.model;
    const report = await runDoctor({ cwd, offline: true });

    expect(find(report, "config").status).toBe("ok");
    expect(find(report, "config").items?.[0]).toContain("SILICONFLOWER_MODEL");
    expect(find(report, "provider")).toMatchObject({ status: "skip", detail: "não testado (--offline)" });
  }, 60_000);

  test("the environment without config.json is not enough: the agent does not start that way", async () => {
    process.env.SILICONFLOWER_API_KEY = KEY;
    process.env.SILICONFLOWER_BASE_URL = VALID.baseURL;
    process.env.SILICONFLOWER_MODEL = VALID.model;
    const report = await runDoctor({ cwd, offline: true });

    expect(find(report, "config")).toMatchObject({ status: "fail" });
    expect(report.ok).toBe(false);
  }, 60_000);

  test("the global options are tested in place of the saved values", async () => {
    writeConfig(VALID);
    const urls: string[] = [];
    const spy = (async (url: string) => {
      urls.push(url);
      return new Response("{}");
    }) as unknown as typeof fetch;
    await runDoctor({ cwd, fetchImpl: spy, overrides: { baseURL: "https://outro.test/v1" } });

    expect(urls).toEqual(["https://outro.test/v1/chat/completions"]);
  }, 60_000);

  test("a refused key fails with the way out, and the key never reaches the report", async () => {
    writeConfig(VALID);
    const echo = answers(401, JSON.stringify({ error: { message: `chave ${KEY} recusada` } }));
    const report = await runDoctor({ cwd, fetchImpl: echo });

    expect(report.ok).toBe(false);
    const provider = find(report, "provider");
    expect(provider.status).toBe("fail");
    expect(provider.detail).toContain("401");
    expect(provider.hint).toContain("chave de API");
    expect(formatDoctorReport(report)).not.toContain(KEY);
  }, 60_000);

  test("a wrong address or model gets the 404 hint", async () => {
    writeConfig(VALID);
    const report = await runDoctor({ cwd, fetchImpl: answers(404, "not found") });

    expect(find(report, "provider").hint).toContain("/v1");
  }, 60_000);

  test("a config.json that is not JSON fails without being touched", async () => {
    writeConfig("{ quebrado");
    const report = await runDoctor({ cwd, fix: true });

    expect(report.ok).toBe(false);
    expect(find(report, "config").detail).toContain("não é um JSON válido");
    expect(find(report, "provider").status).toBe("skip");
    expect(find(report, "mcp").status).toBe("skip");
    expect(readFileSync(configFile(), "utf8")).toBe("{ quebrado");
  }, 60_000);

  test("an address that is not a URL fails before any request", async () => {
    writeConfig({ ...VALID, baseURL: "api.exemplo.test/v1" });
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const report = await runDoctor({ cwd, fetchImpl: spy });

    expect(find(report, "config").status).toBe("fail");
    expect(called).toBe(false);
  }, 60_000);

  test("an MCP server that does not connect is a warning with the reason, not a failure", async () => {
    writeConfig({ ...VALID, mcpServers: { quebrado: {}, errado: { url: "ftp://exemplo.test/mcp" } } });
    const report = await runDoctor({ cwd, fetchImpl: answers(200) });

    const mcp = find(report, "mcp");
    expect(mcp.status).toBe("warn");
    expect(mcp.detail).toBe("2 de 2 servidores não conectou");
    expect(mcp.items?.[0]).toContain("quebrado: não conectou");
    expect(mcp.items?.[1]).toContain("http://");
    expect(report.ok).toBe(true);

    const offline = await runDoctor({ cwd, offline: true });
    expect(find(offline, "mcp").status).toBe("skip");
  }, 60_000);

  test("the servers of a running session are reported as they are, without connecting again", async () => {
    // "quebrado" would fail if the doctor tried to connect it.
    writeConfig({ ...VALID, mcpServers: { arquivos: {}, quebrado: {} } });
    const known = [{ server: "arquivos", tools: 3 }, { server: "quebrado", tools: 0, error: "Executable not found in $PATH" }];
    const mcp = find(await runDoctor({ cwd, offline: true, mcp: known }), "mcp");
    expect(mcp.status).toBe("warn");
    expect(mcp.items).toEqual(["arquivos: 3 ferramentas", "quebrado: não conectou (Executable not found in $PATH)"]);

    const healthy = find(await runDoctor({ cwd, offline: true, mcp: [{ server: "arquivos", tools: 1 }] }), "mcp");
    expect(healthy).toMatchObject({ status: "ok", detail: "1 servidor conectou", items: ["arquivos: 1 ferramenta"] });

    const early = find(await runDoctor({ cwd, offline: true, mcp: "connecting" }), "mcp");
    expect(early.status).toBe("skip");
    expect(early.detail).toContain("ainda conectando");
  }, 90_000);

  test("--fix sets a damaged conversation aside without deleting it", async () => {
    writeConfig(VALID);
    const sessions = join(getWorkspaceDataDir(cwd), "sessions");
    mkdirSync(sessions, { recursive: true });
    const damaged = join(sessions, "abc.jsonl");
    writeFileSync(damaged, "isto não é uma conversa");
    writeFileSync(
      join(sessions, "boa.jsonl"),
      `${JSON.stringify({ id: "boa", title: "t", updatedAt: "2026-01-01T00:00:00.000Z", messageCount: 0 })}\n${JSON.stringify({ history: [], messages: [] })}\n`
    );

    const before = find(await runDoctor({ cwd, offline: true }), "conversations");
    expect(before).toMatchObject({ status: "warn", fixable: true, items: [damaged] });
    expect(before.detail).toContain("1 neste projeto");
    expect(existsSync(damaged)).toBe(true);

    const fixed = find(await runDoctor({ cwd, offline: true, fix: true }), "conversations");
    expect(fixed.status).toBe("ok");
    expect(fixed.fixed).toContain("1 arquivo danificado renomeado");
    expect(existsSync(damaged)).toBe(false);
    expect(readFileSync(`${damaged}.danificada`, "utf8")).toBe("isto não é uma conversa");

    const after = find(await runDoctor({ cwd, offline: true }), "conversations");
    expect(after).toMatchObject({ status: "ok", detail: "1 neste projeto" });
  }, 90_000);

  test("a hooks.json inside the repository is reported and never moved, even with --fix", async () => {
    writeConfig({ ...VALID, hooks: { onEdit: "echo editou" } });
    const repoHooks = join(cwd, ".siliconflower", "hooks.json");
    mkdirSync(dirname(repoHooks), { recursive: true });
    writeFileSync(repoHooks, JSON.stringify({ preTool: "echo do-repositorio" }));

    const hooks = find(await runDoctor({ cwd, offline: true, fix: true }), "hooks");
    expect(hooks.status).toBe("warn");
    expect(hooks.detail).toContain("em vigor: onEdit");
    expect(hooks.hint).toContain(workspaceHooksFile(cwd));
    expect(hooks.fixable).toBeUndefined();
    expect(existsSync(repoHooks)).toBe(true);
    expect(existsSync(workspaceHooksFile(cwd))).toBe(false);
  }, 60_000);

  describe("for the start screen of the app, which has no project of its own", () => {
    let other: string;

    beforeEach(() => {
      other = mkdtempSync(join(tmpdir(), "sf-doctor-"));
    });

    afterEach(() => {
      rmSync(other, { recursive: true, force: true });
      rmSync(getWorkspaceDataDir(other), { recursive: true, force: true });
    });

    function damage(folder: string): string {
      const sessions = join(getWorkspaceDataDir(folder), "sessions");
      mkdirSync(sessions, { recursive: true });
      const file = join(sessions, "abc.jsonl");
      writeFileSync(file, "isto não é uma conversa");
      return file;
    }

    test("the recent projects are checked together, and --fix reaches all of them", async () => {
      writeConfig(VALID);
      const damaged = [damage(cwd), damage(other)];
      // The same project twice (the app lists folders, and two can share a project) counts once.
      const projects = [cwd, other, cwd];

      const report = await runDoctor({ offline: true, projects });
      expect(report.checks.map((c) => c.id)).not.toContain("project");
      const before = find(report, "conversations");
      expect(before).toMatchObject({ status: "warn", fixable: true, items: damaged });
      expect(before.detail).toContain("0 em 2 projetos recentes");

      const fixed = find(await runDoctor({ offline: true, projects, fix: true }), "conversations");
      expect(fixed.status).toBe("ok");
      expect(fixed.fixed).toContain("2 arquivos danificados renomeados");
      for (const file of damaged) expect(readFileSync(`${file}.danificada`, "utf8")).toBe("isto não é uma conversa");
    }, 90_000);

    test("each hooks.json inside a repository is listed with where to move it", async () => {
      writeConfig({ ...VALID, hooks: { onEdit: "echo editou" } });
      for (const folder of [cwd, other]) {
        mkdirSync(join(folder, ".siliconflower"), { recursive: true });
        writeFileSync(join(folder, ".siliconflower", "hooks.json"), JSON.stringify({ preTool: "echo do-repositorio" }));
      }

      const hooks = find(await runDoctor({ offline: true, projects: [cwd, other] }), "hooks");
      expect(hooks.status).toBe("warn");
      expect(hooks.detail).toContain("em vigor: onEdit; 2 arquivos hooks.json não rodam");
      expect(hooks.items).toHaveLength(2);
      expect(hooks.items?.[1]).toContain(join(other, ".siliconflower", "hooks.json"));
      expect(hooks.items?.[1]).toContain(workspaceHooksFile(other));
    }, 60_000);

    test("with no recent project, only what does not depend on one is checked", async () => {
      writeConfig(VALID);
      const report = await runDoctor({ cwd, offline: true, projects: [] });

      const ids = report.checks.map((c) => c.id);
      expect(ids).toEqual(["system", "data-dir", "config", "provider", "mcp", "shell", "git", "skills", "logs"]);
      expect(report.ok).toBe(true);
    }, 60_000);
  });

  test("only the errors of the last 24 hours are reported, with the latest one", async () => {
    writeConfig(VALID);
    await log("info", "garante que o arquivo de log existe");
    appendFileSync(logFile(), "[2020-01-01 00:00:00.000] ERROR erro antigo do doctor\n");
    const quiet = find(await runDoctor({ cwd, offline: true }), "logs");
    expect(JSON.stringify(quiet)).not.toContain("erro antigo do doctor");

    await log("error", "erro recente do doctor");
    const logs = find(await runDoctor({ cwd, offline: true }), "logs");
    expect(logs.status).toBe("warn");
    expect(logs.items?.[0]).toContain("erro recente do doctor");
    expect(logs.hint).toContain(logFile());
  }, 60_000);

  test.skipIf(isWin)("Unix: a data folder other users can read is a warning that --fix closes", async () => {
    writeConfig(VALID);
    const dir = getGlobalDataDir();
    chmodSync(dir, 0o755);

    const before = find(await runDoctor({ cwd, offline: true }), "data-dir");
    expect(before).toMatchObject({ status: "warn", fixable: true });
    expect(before.detail).toContain("755");
    expect(statSync(dir).mode & 0o777).toBe(0o755);

    const fixed = find(await runDoctor({ cwd, offline: true, fix: true }), "data-dir");
    expect(fixed.status).toBe("ok");
    expect(fixed.fixed).toContain("700");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  }, 60_000);

  test.skipIf(!isWin)("Windows: the data folder has no permission bits to check", async () => {
    writeConfig(VALID);
    const dataDir = find(await runDoctor({ cwd, offline: true }), "data-dir");
    expect(dataDir.status).toBe("ok");
    expect(dataDir.fixable).toBeUndefined();
  }, 60_000);
});

describe("doctor report", () => {
  const report = (checks: DoctorCheck[]): DoctorReport => ({ checks, ok: checks.every((c) => c.status !== "fail") });

  test("each line carries an ASCII status, and a problem carries the way to solve it", () => {
    const text = formatDoctorReport(
      report([
        { id: "shell", title: "Shell", status: "ok", detail: "funciona" },
        { id: "provider", title: "Provedor de IA", status: "fail", detail: "O provedor respondeu 401", hint: "Confira a chave." },
        { id: "mcp", title: "Servidores MCP", status: "warn", detail: "1 de 1 servidor não conectou", items: ["a: não conectou"] },
        { id: "x", title: "Outro", status: "skip", detail: "não testado" },
      ])
    );

    expect(text).toContain("[ok]    Shell: funciona");
    expect(text).toContain("[falha] Provedor de IA: O provedor respondeu 401\n        Como resolver: Confira a chave.");
    expect(text).toContain("[aviso] Servidores MCP: 1 de 1 servidor não conectou\n        - a: não conectou");
    expect(text).toContain("[--]    Outro: não testado");
    expect(text).toContain("1 problema e 1 aviso.");
    expect(text).not.toContain("--fix");
  });

  test("--fix is offered only when it can solve something, and what it did is shown", () => {
    const pending = formatDoctorReport(report([{ id: "c", title: "Conversas salvas", status: "warn", detail: "1 arquivo danificado", fixable: true }]));
    expect(pending).toContain("siliconflower doctor --fix");

    const done = formatDoctorReport(report([{ id: "c", title: "Conversas salvas", status: "ok", detail: "0 neste projeto", fixed: "1 arquivo renomeado" }]));
    expect(done).toContain("Corrigido: 1 arquivo renomeado");
    expect(done).toContain("Tudo certo.");
    expect(done).not.toContain("--fix");
  });
});
