# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-11

### Added
- **Context & Token Management (`src/context.ts`):** Added token estimation (`estimateTokens`), message context compression (`compressHistory`), and large output persistence (`processToolOutput`), automatically writing large command/file outputs to `~/.siliconflower/outputs/` to protect LLM context windows.
- **Content Search Tool (`grep_content`):** Native recursive text and regex file content search tool with line numbers (`file:line: content`).
- **Read File Line Ranges (`read_file`):** Added `offset` (start line) and `limit` parameters to `read_file`, formatting lines with numbers (`1: content`).
- **Atomic Patch Applicator (`apply_patch`):** Added support for multi-block text replacement patches.
- **Subagent Task Runner (`run_task` & `src/task.ts`):** Allows delegating sub-tasks to an isolated sub-agent with its own prompt and context, returning a concise summary.
- **To-Do List Tracking (`todowrite` & `src/todo.ts`):** Native tool and interactive TUI panel displaying session task progress (`[✓]`, `[▶]`, `[ ]`).
- **Plan Mode (`plano`):** Added `plano` mode (cycling via `Ctrl+O`: `PROG` -> `SISTEMA` -> `PLANO`), blocking modifying tools until a plan is presented to the user.
- **User Question Tool (`ask_question`):** Tool for requesting decisions or clarifications directly from the user.
- **Markdown & Code Rendering (`src/MarkdownText.tsx`):** Clean Windows-compatible Markdown renderer for headers, code blocks, bold/italic, and bullet lists in the TUI.

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
