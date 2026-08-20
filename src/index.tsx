#!/usr/bin/env bun
import { Command } from "commander";
import { configExists, loadConfig, configFile, configDir } from "./config.js";
import { ensureConfig, runSetup } from "./wizard.js";
import { startApp } from "./App.js";
import type { AppConfig, Mode, ReasoningLevel } from "./types.js";
import { REASONING_LEVELS } from "./types.js";
import { MODES } from "./modes.js";
import { skillsDir, loadSkills, syncSkills } from "./skills.js";
import { logFile, tailLogs, clearLogs } from "./logger.js";
import { log } from "./logger.js";
import { getWorkspaceDataDir, getWorkspaceId } from "./fs-util.js";
import { APP_VERSION } from "./version.js";

const program = new Command();

program
  .name("siliconflower")
  .description("CLI/TUI AI agent with MCP, reasoning, skills, modes, and OpenAI/Anthropic-compatible backends.")
  .version(APP_VERSION)
  .option("-m, --model <id>", "override the model")
  .option("-r, --reasoning <level>", `reasoning level: ${REASONING_LEVELS.join(", ")}`)
  .option("--mode <mode>", `mode: ${MODES.join(", ")}`)
  .option("--provider <type>", "force provider: openai | anthropic")
  .option("--base-url <url>", "override the API base URL")
  .option("--api-key <key>", "override the API key")
  .action(async (opts) => {
    const exists = await configExists();
    let config: AppConfig | null = null;
    if (!exists) {
      config = await runSetup(null);
    } else {
      config = await loadConfig();
      if (!config) config = await runSetup(null);
    }
    const overrides: { model?: string; reasoning?: ReasoningLevel; mode?: Mode } = {};
    if (opts.model) overrides.model = opts.model;
    if (opts.reasoning) overrides.reasoning = normalizeReasoning(opts.reasoning);
    if (opts.mode) overrides.mode = normalizeMode(opts.mode);
    if (opts.provider) config.provider = opts.provider === "anthropic" ? "anthropic" : "openai";
    if (opts.baseUrl) config.baseURL = opts.baseUrl;
    if (opts.apiKey) config.apiKey = opts.apiKey;
    await log("info", "=== siliconflower iniciado por CLI ===");
    await startApp(config, overrides);
  });

program
  .command("config")
  .description("Re-run the setup wizard")
  .action(async () => {
    const existing = await loadConfig();
    await runSetup(existing);
    console.log("Done. Run `siliconflower` to start.");
  });

program
  .command("show")
  .description("Show the path and contents of the current config")
  .action(async () => {
    console.log("Config path:", configFile());
    console.log("Config dir:", configDir());
    console.log("Workspace ID:", getWorkspaceId());
    console.log("Workspace data dir:", getWorkspaceDataDir());
    const cfg = await loadConfig();
    if (!cfg) {
      console.log("No config found. Run `siliconflower config` to set one up.");
      return;
    }
    const masked = { ...cfg, apiKey: cfg.apiKey ? "***" + cfg.apiKey.slice(-4) : "" };
    console.log(JSON.stringify(masked, null, 2));
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
