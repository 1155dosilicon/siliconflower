# Contributing to Siliconflower

Thanks for your interest in contributing. This project is small and focused,
so contributions tend to come in three shapes:

1. Bug reports and feature requests (open an issue first).
2. Documentation fixes (PR directly).
3. Source changes (PR; please read the guidelines below).

## Development setup

```powershell
git clone https://github.com/siliconflower/siliconflower.git
cd siliconflower
bun install
bun run typecheck
bun run dev
```

Requirements: Bun >= 1.3 (recommended) or Node >= 20 with `tsx`.

## Source layout

- `src/index.tsx` -- CLI entry (commander).
- `src/App.tsx` -- TUI (ink/React). Keep components small and pure when
  possible.
- `src/llm.ts` -- OpenAI + Anthropic streaming adapters. Keep both
  branches symmetric so a new provider is roughly doubling one function,
  not redesigning the loop.
- `src/tools.ts` -- Native tool implementations. Validate input paths with
  the helpers in this file; never trust model output.
- `src/mcp.ts` -- MCP client lifecycle. Treat MCP failures as warnings,
  not fatal errors -- the agent should still run with native tools.
- `src/skills.ts`, `src/modes.ts`, `src/wizard.ts` -- user-facing config and
  prompts. New user-facing strings should be in Portuguese (pt-BR).
- `src/logger.ts` -- Append-only log. Never throw from `log()`.

## Style

- TypeScript strict mode. No `any` unless wrapping an SDK response.
- No emojis in source, comments, or UI strings.
- No Unicode box-drawing glyphs in TUI output unless wrapped in a way that
  falls back to ASCII on terminals that do not render them. The current
  UI is ASCII-only on purpose.
- Prefer `void promise.catch(...)` over unhandled promise paths.

## Pull request workflow

1. Fork and create a feature branch off `main`.
2. Run `bun run typecheck`. CI must pass.
3. Add or update tests for the changed behavior where reasonable
   (the project keeps tests light; focus on happy-path smoke tests).
4. Include a one-line entry in `CHANGELOG.md` under an `Unreleased`
   section.
5. Open the PR; the description should state motivation, the change, and
   any backwards-compatibility impact.
