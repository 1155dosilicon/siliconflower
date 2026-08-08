# Security model

Siliconflower runs an LLM agent with real access to your machine. The
mitigations below are deliberate; please respect them and report
workarounds as bugs.

## What the agent can do

After configuration, the model can invoke tools that:

- Read, create, edit, move, and list arbitrary files (paths are
  resolved against your `cwd` if relative).
- Search the file system recursively (`**/*.ts` supported).
- Delete files and directories (`delete_path`).
- Spawn arbitrary MCP servers (whichever binary you configured).

By design there is **no sandbox**. The agent operates with the same
privileges as the user running `siliconflower`.

## Built-in guards

- `delete_path` requires `confirm=true` for ALL deletions (file or directory). Without
  it the tool returns an error requiring explicit confirmation.
- The system prompt in `sistema` mode instructs the model to warn before
  destructive or registry-level actions and to prefer non-destructive
  commands.
- `binsh` and shell execution paths are not exposed as tools. There is no
  `run_command` tool by design.

## What you should still do

- Treat the API key (`~/.siliconflower/config.json`) like a password.
  The `show` command prints the key masked, but the raw file is plaintext.
- Prefer `--mode programacao` for editing code and switch to `--mode
  sistema` only when you intend the model to make system changes.
- Review the log (`bun run start -- logs`) periodically, especially if
  the agent has been busy.
- If you put a destructive MCP server in your config, you trust the
  upstream tool. We do not vet third-party MCP servers.

## Reporting a vulnerability

Open a private security advisory on GitHub (Security tab -> Report a
vulnerability) or email the maintainer through the address in `package.json`.
Please do not file public issues for suspected vulnerabilities.
