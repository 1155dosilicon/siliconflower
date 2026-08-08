# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Input handler: fixed `useInput` parameter names and shortcut keys (`Ctrl+C`, `Ctrl+E`, `Ctrl+O`) in `App.tsx`
- Skills: `loadSkills` now automatically syncs embedded skills if `~/.siliconflower/skills` is empty
- Config: added environment variable fallbacks (`SILICONFLOWER_API_KEY`, `SILICONFLOWER_BASE_URL`, `SILICONFLOWER_MODEL`)
- Tools: added 60-second execution timeout per tool in `runBuiltin` to prevent hung commands
- Tools: exposed `includeHidden` parameter in `search_files` schema
- Wizard: added fallback prompt if external text editor fails on Windows
- CI: added `bun test` step to CI pipeline
- Removed unrelated `demo/` folder from repository

### Added
- `.env.example` template file
- Top-level `sync` command alias (`siliconflower sync`)
- Extended unit test suite in `tests/`
- llm: request info logging (model, tool count, reasoning level)
- README: MCP environment variable docs, recommended models table, troubleshooting section

### Changed
- `engines.bun` updated to `>=1.3.0` (required for `--compile` features)
- `package.json`: filled in author and repository URLs

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
