#!/usr/bin/env bun
import { Command } from "commander";
import { configExists, loadConfig, loadStoredConfig, applyEnvOverrides, isValid, normalize, configFile, configDir } from "./config.js";
import { ensureConfig, runSetup } from "./wizard.js";
import type { AppConfig, Mode, ReasoningLevel } from "./types.js";
import { REASONING_LEVELS } from "./types.js";
import { MODES } from "./modes.js";
import { skillsDir, loadSkills, syncSkills } from "./skills.js";
import { logFile, tailLogs, clearLogs } from "./logger.js";
import { log } from "./logger.js";
import { getWorkspaceDataDir, getWorkspaceId } from "./fs-util.js";
import { findProject, markerIn, resolveWorkspaceRoot, DEFAULT_MARKER, PROJECT_TEMPLATE } from "./project.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_VERSION } from "./version.js";
import { emitManagedEvent } from "./gui/managed.js";

const program = new Command();

program
  .name("siliconflower")
  .description("AI agent with MCP, reasoning, skills, modes, and OpenAI-compatible backends.")
  .version(APP_VERSION)
  .option("-m, --model <id>", "override the model")
  .option("-r, --reasoning <level>", `reasoning level: ${REASONING_LEVELS.join(", ")}`)
  .option("--mode <mode>", `mode: ${MODES.join(", ")}`)
  .option("--base-url <url>", "override the API base URL")
  .option("--api-key <key>", "override the API key")
  .action(() => {
    // The terminal interface was removed in 0.8.0: the desktop app and `gui` are the interfaces.
    program.outputHelp();
    console.log("\nPara conversar com o agente, use o app de desktop ou rode `siliconflower gui`.");
  });

program
  .command("gui")
  .description("Open the web interface in the browser, with saved conversations (accepts the global options above)")
  .option("--port <n>", "local port (default: a free port)")
  .option("--no-open", "do not open the browser, only print the URL")
  .option("--managed", "controlled by another program (desktop app): JSON events on stdout, exits when stdin closes")
  .option("--resume-latest", "reopen the project's most recent conversation")
  .action(async (_opts, cmd: Command) => {
    const opts = cmd.optsWithGlobals();
    if (!process.versions.bun) {
      throw new Error("siliconflower gui requer o Bun ou o executável compilado (siliconflower ou siliconflower.exe).");
    }
    const port = opts.port === undefined ? 0 : Number(opts.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`--port inválida: "${opts.port}". Use um número de 0 a 65535.`);
    }
    const managed = Boolean(opts.managed);
    let resolved: Awaited<ReturnType<typeof resolveRun>>;
    try {
      // Without a terminal, the wizard would wait forever for an answer nobody can give.
      resolved = await resolveRun(opts, { interactive: !managed && Boolean(process.stdin.isTTY) });
    } catch (e) {
      if (managed && e instanceof ConfigRequiredError) {
        emitManagedEvent({ event: "error", code: "config_required" });
        process.exitCode = 1;
        return;
      }
      throw e;
    }
    await log("info", "=== siliconflower iniciado por GUI ===");
    // Imported only here: it depends on Bun, and the other subcommands also run on Node + tsx.
    const { startGui } = await import("./gui/index.js");
    await startGui(resolved.config, resolved.overrides, {
      port,
      open: opts.open && !managed,
      managed,
      resumeLatest: Boolean(opts.resumeLatest),
    });
  });

program
  .command("run")
  .description("Run one prompt to the end with no interface and print the answer (scripts and CI; accepts the global options above)")
  .argument("[prompt]", 'the request; when omitted or "-", it is read from stdin')
  .option("-q, --quiet", "do not print tool progress on stderr")
  .action(async (promptArg: string | undefined, _opts, cmd: Command) => {
    const opts = cmd.optsWithGlobals();
    let prompt = promptArg ?? "-";
    if (prompt === "-") {
      if (process.stdin.isTTY) throw new Error('Informe o pedido: siliconflower run "<pedido>", ou envie-o pela entrada padrão.');
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
      prompt = Buffer.concat(chunks).toString("utf8");
    }
    if (!prompt.trim()) throw new Error("O pedido está vazio.");
    // Nobody is there to answer the wizard; the environment alone may configure a CI run.
    const resolved = await resolveRun(opts, { interactive: false, envOnly: true });
    await log("info", "=== siliconflower iniciado por run ===");
    const { AgentSession } = await import("./session.js");
    const { runHeadless, closeHeadless } = await import("./run.js");
    const session = new AgentSession(resolved.config, resolved.overrides);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => session.cancel());
    let code = 1;
    try {
      const result = await runHeadless(session, prompt, { onProgress: opts.quiet ? undefined : (line) => console.error(line) });
      if (result.ok) {
        // Only the answer goes to stdout, and it must be flushed before process.exit.
        await new Promise<void>((resolve) => process.stdout.write(`${result.text}\n`, () => resolve()));
        code = 0;
      } else {
        console.error(`Erro: ${result.error}`);
        code = result.cancelled ? 130 : 1;
      }
    } finally {
      await closeHeadless(session);
    }
    // Background tasks and MCP handles could otherwise keep the process running.
    process.exit(code);
  });

program
  .command("config")
  .description("Re-run the setup wizard")
  .action(async () => {
    const existing = await loadStoredConfig();
    await runSetup(existing);
    console.log("Done. Open the desktop app or run `siliconflower gui` to start.");
  });

program
  .command("show")
  .description("Show the path and contents of the current config")
  .action(async () => {
    console.log("Config path:", configFile());
    console.log("Config dir:", configDir());
    const project = findProject();
    console.log("Project:", project ? `${project.root} (${project.markerPath})` : "none — project memory is off in this folder");
    console.log("Workspace ID:", getWorkspaceId(resolveWorkspaceRoot()));
    console.log("Workspace data dir:", getWorkspaceDataDir());
    const cfg = await loadConfig();
    if (!cfg) {
      console.log("No config found. Run `siliconflower config` to set one up.");
      return;
    }
    const envOverrides = ["SILICONFLOWER_API_KEY", "SILICONFLOWER_BASE_URL", "SILICONFLOWER_MODEL"].filter(
      (name) => process.env[name]?.trim()
    );
    if (envOverrides.length) console.log("Environment overrides active (not saved):", envOverrides.join(", "));
    const masked = { ...cfg, apiKey: cfg.apiKey ? "***" + cfg.apiKey.slice(-4) : "" };
    console.log(JSON.stringify(masked, null, 2));
  });

program
  .command("init")
  .description(`Turn the current folder into a project: creates ${DEFAULT_MARKER} (activates project memory)`)
  .option("--agents", "create AGENTS.md instead of SILICONFLOWER.md")
  .action(async (opts) => {
    const cwd = process.cwd();
    const existing = markerIn(cwd);
    if (existing) {
      console.log(`Already a project: ${existing}`);
      return;
    }
    const parent = findProject(cwd);
    if (parent) {
      console.log(`Note: this folder is inside the project ${parent.root}; a marker here makes it a separate project.`);
    }
    const target = join(cwd, opts.agents ? "AGENTS.md" : DEFAULT_MARKER);
    await writeFile(target, PROJECT_TEMPLATE, { encoding: "utf8", flag: "wx" });
    console.log(`Created ${target}`);
    console.log("Project memory is now active here. Edit the file with instructions for the agent (keep it short).");
  });

program
  .command("ensure")
  .description("Create config if missing and exit")
  .action(async () => {
    await ensureConfig();
  });

const skillsCmd = program
  .command("skills")
  .description("Manage skills (.md)")
  .action(async () => {
    console.log("Skills directory:", skillsDir());
    const skills = await loadSkills();
    if (!skills.length) {
      console.log("No skills found. Drop .md files into:", skillsDir());
      return;
    }
    for (const s of skills) {
      console.log(`- ${s.name}${s.title ? `  -- ${s.title}` : ""}`);
    }
  });

skillsCmd
  .command("list")
  .description("List available skills")
  .action(async () => {
    console.log("Skills directory:", skillsDir());
    const skills = await loadSkills();
    if (!skills.length) {
      console.log("No skills found. Drop .md files into:", skillsDir());
      return;
    }
    for (const s of skills) {
      console.log(`- ${s.name}${s.title ? `  -- ${s.title}` : ""}`);
    }
  });

skillsCmd
  .command("sync")
  .description("Copy bundled example skills to ~/.siliconflower/skills")
  .action(async () => {
    const res = await syncSkills();
    if (res.copied.length) console.log("Copied:", res.copied.join(", "));
    if (res.skipped.length) console.log("Skipped (already exist):", res.skipped.join(", "));
    if (res.errors.length) console.error("Errors:", res.errors.join(", "));
  });

program
  .command("sync")
  .description("Copy bundled example skills to ~/.siliconflower/skills (alias for `skills sync`)")
  .action(async () => {
    const res = await syncSkills();
    if (res.copied.length) console.log("Copied:", res.copied.join(", "));
    if (res.skipped.length) console.log("Skipped (already exist):", res.skipped.join(", "));
    if (res.errors.length) console.error("Errors:", res.errors.join(", "));
  });

program
  .command("logs")
  .description("Show the last lines of the log")
  .option("-n, --lines <n>", "number of lines", "50")
  .option("-l, --level <level>", "filter by log level: error | warn | info | tool")
  .option("-s, --search <text>", "filter lines containing text")
  .option("--clear", "clear the log file")
  .action(async (opts) => {
    if (opts.clear) {
      await clearLogs();
      console.log("Log file cleared:", logFile());
      return;
    }
    console.log("Log file:", logFile());
    const n = parseInt(opts.lines, 10) || 50;
    const tail = await tailLogs({ lines: n, level: opts.level, search: opts.search });
    console.log(tail);
  });

class ConfigRequiredError extends Error {
  constructor() {
    super("Falta configurar o provedor de IA. Rode `siliconflower config` num terminal.");
  }
}

/** Applies the run options on top of the effective config, opening the wizard if needed and possible. */
async function resolveRun(
  opts: {
    model?: string;
    reasoning?: string;
    mode?: string;
    baseUrl?: string;
    apiKey?: string;
  },
  { interactive = true, envOnly = false }: { interactive?: boolean; /** Without config.json, use SILICONFLOWER_* and the options alone. */ envOnly?: boolean } = {}
): Promise<{ config: AppConfig; overrides: { model?: string; reasoning?: ReasoningLevel; mode?: Mode } }> {
  const overrides: { model?: string; reasoning?: ReasoningLevel; mode?: Mode } = {};
  if (opts.model) overrides.model = opts.model;
  if (opts.reasoning) {
    overrides.reasoning = normalizeReasoning(opts.reasoning);
    if (!overrides.reasoning) throw new Error(`--reasoning inválido: "${opts.reasoning}". Use: ${REASONING_LEVELS.join(", ")}`);
  }
  if (opts.mode) {
    overrides.mode = normalizeMode(opts.mode);
    if (!overrides.mode) throw new Error(`--mode inválido: "${opts.mode}". Use: ${MODES.join(", ")}`);
  }

  // The wizard always works on (and saves) the stored file; environment overrides are
  // applied on top only for this run and never written back to config.json.
  let config: AppConfig | null = (await configExists()) ? await loadConfig() : null;
  if (envOnly) {
    config ??= normalize({});
    if (opts.baseUrl) config.baseURL = opts.baseUrl;
    if (opts.apiKey) config.apiKey = opts.apiKey;
    if (!isValid(config)) {
      throw new Error(
        "Falta configurar o provedor de IA: rode `siliconflower config`, ou defina SILICONFLOWER_API_KEY, SILICONFLOWER_BASE_URL e SILICONFLOWER_MODEL."
      );
    }
    return { config, overrides };
  }
  if (!config) {
    if (!interactive) throw new ConfigRequiredError();
    config = applyEnvOverrides(await runSetup(null));
  } else if (!isValid(config) && !(opts.baseUrl || opts.apiKey)) {
    if (!interactive) throw new ConfigRequiredError();
    config = applyEnvOverrides(await runSetup(await loadStoredConfig()));
  }
  if (opts.baseUrl) config.baseURL = opts.baseUrl;
  if (opts.apiKey) config.apiKey = opts.apiKey;
  return { config, overrides };
}

function normalizeReasoning(v: string | undefined): ReasoningLevel | undefined {
  if (!v) return undefined;
  const lower = v.toLowerCase() as ReasoningLevel;
  return REASONING_LEVELS.includes(lower) ? lower : undefined;
}

function normalizeMode(v: string | undefined): Mode | undefined {
  if (!v) return undefined;
  const lower = v.toLowerCase().trim();
  if (lower === "programacao" || lower === "programação" || lower === "prog") return "programação";
  if (lower === "sistema" || lower === "sys") return "sistema";
  if (lower === "plano" || lower === "plan") return "plano";
  return (MODES as readonly string[]).includes(lower) ? (lower as Mode) : undefined;
}

program.parseAsync(process.argv).catch(async (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  await log("error", `Erro fatal na CLI: ${msg}`);
  console.error(`Erro: ${msg}`);
  process.exitCode = 1;
});
