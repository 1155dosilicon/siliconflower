# SILICONFLOWER

CLI/TUI AI agent for Windows with MCP, controllable reasoning, file-system
skills (.md), two operating modes (programacao / sistema), and pluggable
OpenAI- or Anthropic-compatible backends (SiliconFlow, OpenRouter, OpenAI,
Anthropic, proxies).

```
  S I L I C O N F L O W E R
----------------------------------------------------------
  voce  > oi, crie um backup de C:\Docs em D:\Backups
  tool   > robocopy "C:\Docs" "D:\Backups\Docs_2026-07-15" /MIR
  ia     > backup iniciado. acompanhando em D:\Backups\Docs_2026-07-15.
----------------------------------------------------------
  > digite para a LLM...
----------------------------------------------------------
  Model: deepseek-ai/DeepSeek-V3  Reason: high  Mode: PROG
  Tools: 11  Skills: 3  status: pronto
```

> The interface is intentionally minimal: ASCII-only, no Nerd Fonts required,
> works in Windows Terminal, PowerShell, cmd, ConEmu, VS Code terminal.

---

## Table of Contents

- [Features](#features)
- [Install](#install)
- [Configuration](#configuration)
- [Recommended Models](#recommended-models)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Skills](#skills)
- [MCP (Model Context Protocol)](#mcp-model-context-protocol)
- [Modes](#modes)
- [Building standalone binary](#building-standalone-binary)
- [Troubleshooting](#troubleshooting)

---

## Features

| Area            | What it does                                                                  |
|-----------------|-------------------------------------------------------------------------------|
| Backends        | OpenAI-compatible (`/v1/chat/completions`) and Anthropic (`/v1/messages`).    |
| Reasoning       | `none` / `low` / `medium` / `high`. OpenAI-compat sends `reasoning_effort`;  |
|                 | Anthropic sends `thinking` with `budget_tokens`. Cycle at runtime with `Ctrl+E`. |
| Native tools    | Read / write / edit / list / move / search / create-directory / info /        |
|                 | destructive `delete_path` with `confirm=true` guard.                           |
| MCP             | Spawn stdio MCP servers, merge their tools with the native ones.              |
| Skills (.md)    | `~/.siliconflower/skills/*.md`, discoverable, read by model via `read_skill`. |
| Modes           | `programacao` (code) and `sistema` (Windows ops). Cycle with `Ctrl+O`.        |
| Logging         | Everything is logged to `~/.siliconflower/logs/siliconflower.log` (1 MB ring). |
| Standalone .exe | `bun build --compile` produces a single Windows binary with no Node required. |

---

## Install

### Prerequisites

- Bun >= 1.1 (recommended, runs TypeScript natively): https://bun.sh
- Alternatively: Node.js >= 20 + the bundled `tsx` devDependency.

### Quick start

```powershell
git clone https://github.com/siliconflower/siliconflower.git
cd siliconflower
bun install
bun run start          # TUI; first run opens the setup wizard
```

Other entry points:

```powershell
bun run start -- -m deepseek-ai/DeepSeek-V3 -r high
node bin\siliconflower.js            # auto-detects bun -> tsx -> npx tsx
bun run build                        # produces dist\siliconflower.exe
npm run install:bin                  # install the .exe to your PATH (no admin)
```

---

## First-time setup

The wizard asks for:

1. Provider variant: `openai` or `anthropic`.
2. Base URL (default `https://api.siliconflow.com/v1`).
3. Model id (e.g. `deepseek-ai/DeepSeek-V3`, `claude-3-5-sonnet-20241022`).
4. API key (input is masked).
5. Default reasoning level.
6. Optional system prompt.
7. Optional MCP server entries.

Result is stored at `~/.siliconflower/config.json`:

```json
{
  "provider": "openai",
  "baseURL": "https://api.siliconflow.com/v1",
  "apiKey": "sk-...",
  "model": "deepseek-ai/DeepSeek-V3",
  "reasoning": "high",
  "mode": "programacao",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/"]
    }
  }
}
```

> Important: SiliconFlow speaks the OpenAI wire format. Pick
> `provider=openai` and a base URL ending in `/v1`. Selecting `anthropic`
> against a SiliconFlow endpoint yields HTTP 404.

Reconfigure any time:

```powershell
bun run start -- config   # re-runs the wizard
bun run start -- show     # prints the config (key masked)
bun run start -- ensure   # create config if missing, then exit
```

### Environment Variables Fallback

You can also configure credentials via environment variables (see `.env.example`):

- `SILICONFLOWER_API_KEY` - API key.
- `SILICONFLOWER_BASE_URL` - Base URL for OpenAI/Anthropic endpoint.
- `SILICONFLOWER_MODEL` - Default model ID.

---

## Keybindings (TUI)

| Key      | Action                                       |
|----------|----------------------------------------------|
| Enter    | Send the message                             |
| Ctrl+E   | Cycle reasoning: none -> low -> medium -> high |
| Ctrl+O   | Cycle mode: programacao <-> sistema          |
| Ctrl+C   | Cancel current stream; press twice to exit   |

Command-line flags:

```
  -m, --model <id>        override the model
  -r, --reasoning <level> none | low | medium | high
      --mode <mode>       programacao | sistema
      --provider <type>   openai | anthropic
      --base-url <url>    override the API base URL
      --api-key <key>     override the API key
```

---

## Native tools

The agent can read and modify the local file system without MCP:

| Tool             | Notes                                                                  |
|------------------|------------------------------------------------------------------------|
| `read_file`      | Read a text file; supports absolute or cwd-relative paths.             |
| `write_file`     | Create or overwrite. Creates parent directories.                       |
| `edit_file`      | Replace first occurrence (use `replaceAll=true` for all).              |
| `list_directory` | List files/folders.                                                    |
| `create_directory` | Create dir (recursive).                                              |
| `move_path`      | Rename or move.                                                        |
| `file_info`      | Size, mtime, ctime, type.                                               |
| `search_files`   | Glob search (`**/*.ts`, `*.{ts,tsx}`). Supports `includeHidden=true`.  |
| `delete_path`    | Destructive. Requires `confirm=true` for ALL file/directory deletions. |

> All tools feature a 60-second execution timeout to prevent hung processes and are protected against sensitive path traversal (`C:\Windows\System32`, `.ssh`, `.aws`, etc.).

---

## MCP

Add servers to `config.json`:

```json
"mcpServers": {
  "git": { "command": "uvx", "args": ["mcp-server-git", "--repository", "C:/repo"] },
  "fs":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Users/Eli"] },
  "brave-search": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-brave-search"]
  }
}
```

Their tools are merged with the native ones and exposed to the model together,
with a tool-calling loop of up to 8 steps per assistant turn.

### Environment variables for MCP servers

MCP servers inherit the parent process environment automatically. If you need
to override a variable, use the `env` field:

```json
"brave-search": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-brave-search"],
  "env": { "BRAVE_API_KEY": "your-key-here" }
}
```

> Do **not** use shell-style `${VAR}` syntax — the value is passed literally.
> Either set the variable in your system environment (it will be inherited),
> or put the actual value in the `env` field.

### Recommended models (NVIDIA API)

| Model | Function calling | Reasoning | Speed |
|-------|:---:|:---:|:---:|
| `nvidia/nemotron-3-ultra-550b-a55b` | yes | yes | medium |
| `meta/llama-3.1-70b-instruct` | yes | no | slow |
| `meta/llama-3.1-8b-instruct` | yes | no | fast |
| `z-ai/glm-5.2` | yes | no | unstable |

> `nvidia/nemotron-3-ultra-550b-a55b` is the best choice for tool-calling
> with reasoning on the NVIDIA API.

### Troubleshooting MCP

| Symptom | Cause | Fix |
|---------|-------|-----|
| `MCP conectado: 0 servidores` | Server failed to start | Check that `npx`/`uvx` is in your PATH |
| Tools available but model ignores them | Model doesn't support function calling | Switch to a model from the table above |
| `BRAVE_API_KEY environment variable is required` | Env var not inherited | Set it in your system env, or use `env` in config |
| Model hangs "thinking" | API timeout or model offline | Try a different model; check NVIDIA API status |

---

## Skills (.md)

Drop Markdown files in `~/.siliconflower/skills/`. Each `.md` becomes a skill
discoverable by the model; the full body is fetched on demand via `read_skill`.
Bundled skills are automatically synced on first launch if your skills directory is empty.

Bootstrap or manage skills:

```powershell
bun run start -- skills            # list discovered skills (or `siliconflower skills`)
bun run start -- sync              # copy bundled *.md into ~/.siliconflower/skills (alias for `skills sync`)
```

Recommended skill layout:

```markdown
# Skill name

## When to apply
...

## Guidelines
...

## Response format
...
```

---

## Modes

| Mode          | Focus                                                                  |
|---------------|------------------------------------------------------------------------|
| `programacao` | Read, write, review, refactor code. Follow project conventions.        |
| `sistema`     | Windows admin: PowerShell, batch, backup, privacy, registry. Always    |
|               | warns about destructive / registry impact before acting.              |

Switch at runtime with `Ctrl+O`, or override the default with `--mode sistema`.

---

## Logs

```powershell
bun run start -- logs          # last 50 lines
bun run start -- logs -n 200   # last 200 lines
```

Levels: `INFO`, `OK`, `TOOL`, `WARN`, `ERROR`. Automatic rotation at 1 MB.

---

## Project layout

```
siliconflower/
|-- bin/
|   `-- siliconflower.js     # launcher: bun -> tsx -> npx tsx
|-- src/
|   |-- index.tsx            # commander CLI + entry
|   |-- App.tsx              # ink/React TUI (with shortcut fix & history windowing)
|   |-- llm.ts               # OpenAI + Anthropic streaming, reasoning, tools
|   |-- mcp.ts               # MCP stdio client manager
|   |-- tools.ts             # native file-system tools (with 60s timeout & path protection)
|   |-- glob-util.ts         # glob -> regex search with brace expansion & character classes
|   |-- skills.ts            # skill loader with auto-sync + read_skill tool
|   |-- modes.ts             # modes + system prompts
|   |-- logger.ts            # append-only log with rotation
|   |-- config.ts            # ~/.siliconflower/config.json persistence & env fallbacks
|   |-- wizard.ts            # first-run configuration wizard (with editor fallback)
|   |-- ascii.ts             # ASCII logo (terminal-safe)
|   `-- types.ts             # shared types and enums
|-- tests/                   # unit test suite (bun test)
|-- scripts/
|   `-- install.ps1          # install the standalone .exe to PATH
|-- build.ts                 # bun build --compile pipeline
|-- .env.example             # environment variables template
|-- package.json
|-- tsconfig.json
|-- LICENSE
`-- README.md
```

---

## Development

```powershell
bun install
bun run typecheck            # tsc --noEmit
bun run dev                  # run with hot reload via Bun
bun run build                # produce dist\siliconflower.exe
```

Stack: TypeScript - Bun - React (ink) - OpenAI SDK - Anthropic SDK -
MCP SDK - commander - inquirer. No figlet, no Nerd Fonts, no Unicode glyphs.

---

## License

MIT. See `LICENSE`.
