# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Windows-Only Focus & Simplification:** Removed Linux and macOS compatibility layers, platform branching, and bash fallback logic across `src/modes.ts`, `src/tools.ts`, `src/fs-util.ts`, `src/services/background-tasks.ts`, and test suites. Siliconflower is now centered exclusively on Windows (PowerShell/Bun/Node).
- **Documentation & Packaging:** Updated `README.md`, `LLMS.md`, and `package.json` (`"os": ["win32"]`) to reflect the dedicated Windows platform focus.

## [0.2.3] - 2026-08-16

### Fixed
- **Anthropic Batch Tool Results Streaming (`src/llm.ts`):** Fixed Anthropic API HTTP 400 Bad Request error caused by parallel tool call results pushing multiple consecutive `{ role: "user" }` messages during streaming loops. Now all tool results are aggregated into a single user message with content blocks, strictly satisfying Anthropic's role alternation protocol.
- **Artifact Exact Matching & Deduplication (`src/services/artifact.ts`):** Fixed prefix collision bug where short artifact IDs matched longer IDs (e.g., `report` matching `report_analysis.md`). Added path deduplication when the workspace is located at user home root.
- **Memory Service Deduplication (`src/services/memory.ts`):** Added directory deduplication in `recallMemories` when project root matches user home.
- **Subagent Session Tracking & Unification (`src/task.ts` & `src/services/subagent.ts`):** Unified subagent invocation by delegating `runSubagentTask` in `src/task.ts` to the comprehensive `src/services/subagent.ts` pipeline, preserving session registration and background tracking. Replaced deprecated `.substr()` usage with `.slice()`.
- **Config & Wizard State Preservation (`src/config.ts` & `src/wizard.ts`):** Fixed `normalize()` dropping `hooks` settings, added normalization for unaccented mode variants (`"programacao"`, `"prog"`), and preserved existing `mode` and `hooks` settings during wizard re-configuration.
- **Plan Mode Modifying Tools Guard (`src/App.tsx`):** Expanded the modification guard in `plano` mode to encompass `move_path`, `create_directory`, `delete_artifact`, `forget_memory`, and `exit_worktree`.

### Added
- **Comprehensive Test Suites:** Added new test suites covering Smart Edit (`tests/smart-edit.test.ts`), RepoMap (`tests/repomap.test.ts`), Persistent Memory (`tests/memory.test.ts`), Subagents (`tests/subagent.test.ts`), and Config Normalization (`tests/config.test.ts`).
- **Complete Native Tools Documentation (`README.md` & `LLMS.md`):** Documented all 34 native tools, subagents architecture, memory scopes, Git worktrees, and lifecycle hooks.

## [0.2.2] - 2026-08-14

### Fixed
- **Artifact Type and Metadata Resolution (`src/services/artifact.ts`):** Fixed a bug in `listArtifacts` where non-markdown artifacts (like `.html`, `.json`, `.txt`) were incorrectly categorized as `"markdown"` because they lacked frontmatter headers. Resolved by dynamically inferring the correct type based on the file extension and parsing `updatedAt` from frontmatter metadata when present.

### Added
- **Artifact Type Verification Tests (`tests/artifact.test.ts`):** Added a new suite of integration tests to verify successful creation, type resolution, and list integration of HTML and JSON artifacts.
- **Git Worktree Testing (`tests/worktree.test.ts`):** Added a new test suite to cover the `listWorktrees` service in any active git repository environment, raising overall test coverage and reliability.

## [0.2.1] - 2026-08-12

### Fixed
- **OpenAI Tool Call History (`src/llm.ts`):** Preserved `toolCalls` metadata on assistant messages during OpenAI API payload conversion, fixing HTTP 400 `tool_call_id` mismatch errors in multi-turn history.
- **Anthropic Message Role Alternation (`src/llm.ts`):** Fixed message role sequence builder for Anthropic API by merging consecutive tool results into the preceding user message to satisfy role alternation requirements.
- **Grep Regex Syntax Error Fallback (`src/grep.ts`):** Added `SyntaxError` fallback to literal string matching when unescaped regex special characters are supplied to `grep_content`.
- **Config Enum Normalization (`src/config.ts`):** Added strict validation against `REASONING_LEVELS` and `MODES` in config normalization.
- **Anthropic Stream Connection Resolution (`src/llm.ts`):** Enhanced connection promise event listeners to prevent hanging on rapid stream completion or early aborts.
- **Event Listener Cleanup (`src/llm.ts`):** Fixed memory leak in `withConnectTimeout` by detaching `abort` signal listeners on Promise completion.
- **Tool Parameter Coercion (`src/tools.ts`):** Coerced stringified numeric arguments for `read_file`, `read_logs`, and `execute_command`.
- **Tool Timeout Alignment (`src/tools.ts`):** Dynamically scaled `runBuiltin` timeout when custom command timeouts are specified for `execute_command`.
- **Empty `oldText` Prevention (`src/tools.ts`):** Guarded `edit_file` and `apply_patch` against empty string replacements.
- **To-Do Status Normalization (`src/tools.ts`):** Added automatic mapping for LLM status/priority synonyms (`done`, `in-progress`, etc.) in `todowrite`.
- **Subagent Context Propagation (`src/task.ts`):** Passed `ToolContext` with app configuration to subagent tool executions.
- **Cross-Platform OS Prompts (`src/modes.ts`):** Dynamically generated system prompts matching the current host operating system (`process.platform`).
- **Log Rotation Concurrency Lock (`src/logger.ts`):** Added rotation lock to prevent file truncation race conditions.
- **MCP Env Type Safety (`src/mcp.ts`):** Sanitized environment variables passed to stdio transport processes.

## [0.2.0] - 2026-08-11

### Added
- **Live Token Counter (`Tokens:` in TUI):** Real-time session token counter in the TUI status bar and execution status (`🧠 pensando...`, `🔨 tool_name...`), combining live local token estimation with official API stream usage metadata (`stream_options: { include_usage: true }`).
- **Context & Token Management (`src/context.ts`):** Added token estimation (`estimateTokens`), message context compression (`compressHistory`), and large output persistence (`processToolOutput`), automatically writing large command/file outputs to `~/.siliconflower/outputs/` to protect LLM context windows.
- **Content Search Tool (`grep_content`):** Native recursive text and regex file content search tool with line numbers (`file:line: content`).
- **Read File Line Ranges (`read_file`):** Added `offset` (start line) and `limit` parameters to `read_file`, formatting lines with numbers (`1: content`).
- **Atomic Patch Applicator (`apply_patch`):** Added support for multi-block text replacement patches.
- **Subagent Task Runner (`run_task` & `src/task.ts`):** Allows delegating sub-tasks to an isolated sub-agent with its own prompt and context, returning a concise summary.
- **To-Do List Tracking (`todowrite` & `src/todo.ts`):** Native tool and interactive TUI panel displaying session task progress (`[✓]`, `[▶]`, `[ ]`).
- **Plan Mode (`plano`):** Added `plano` mode (cycling via `Ctrl+O`: `PROG` -> `SISTEMA` -> `PLANO`), blocking modifying tools until a plan is presented to the user.
- **User Question Tool (`ask_question`):** Tool for requesting decisions or clarifications directly from the user.
- **Markdown & Code Rendering (`src/MarkdownText.tsx`):** Clean Windows-compatible Markdown renderer for headers, code blocks, bold/italic, and bullet lists in the TUI.
- **Log Management & Inspection (`read_logs` & `src/logger.ts`):** Auto-rotation at 200 KB, CLI filtering (`siliconflower logs --level error --search keyword --clear`), and native `read_logs` tool for focused LLM error diagnostics.
- **LLM Agent Guide (`LLMS.md`):** Added a dedicated project architecture and context guide for future LLM agents, detailing what files to read and what directories to ignore.

### Fixed
- **Shortcut Input Handler:** Fixed `Ctrl+O` and `Ctrl+E` keyboard event handling in Windows Terminal / PowerShell to prevent trailing shortcut characters (`'o'`, `'e'`) from polluting the input field.
- **Tool Call Loop Limit:** Expanded step limit from 8 to 25 tool calls per user turn with infinite loop guard protection.

## [0.1.0] - 2026-07-15

### Added

- First public release.
- TUI (ink/React) with transcript, status bar, logo, and animated cursor.
- Native file-system tools: `read_file`, `write_file`, `edit_file`,
  `list_directory`, `create_directory`, `move_path`, `file_info`,
  `search_files`, `delete_path` (with `confirm=true` guard for recursive
  deletes).
- MCP stdio client manager; tools merged with natives, loop of up to 8
  tool-call steps per assistant turn.
- OpenAI-compatible and Anthropic streaming adapters with reasoning
  control (`reasoning_effort` / `thinking` + `budget_tokens`).
- Skills: bundled `.md` examples, `read_skill` tool, `skills sync` command.
- Modes (`programacao` / `sistema`) with system-prompt focus variants.
- Logging with automatic 1 MB rotation; `logs` command to tail history.
- Standalone Windows build via `bun build --compile` (shim for
  `react-devtools-core`, single-binary distribution).
- PowerShell installer (`scripts/install.ps1`) that adds the binary to the
  user PATH without admin.
- First-run wizard with provider presets for SiliconFlow, OpenRouter,
  OpenAI, and Anthropic.

[Unreleased]: https://github.com/siliconflower/siliconflower/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/siliconflower/siliconflower/releases/tag/v0.1.0
