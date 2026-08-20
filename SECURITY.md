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
- Execute arbitrary PowerShell commands (`execute_command`) with the same
  privileges as the current user.
- Spawn arbitrary MCP servers (whichever binary you configured).

By design there is **no sandbox**. The agent operates with the same
privileges as the user running `siliconflower`.

## Built-in guards

- `delete_path` requires `confirm=true` for ALL deletions (file or directory). Without
  it the tool returns an error requiring explicit confirmation.
- Filesystem roots, the current workspace and the user home (including their
  ancestors) cannot be removed through `delete_path`.
- Sensitive path checks are applied consistently to direct reads, metadata,
  glob and grep operations, including resolved junction/symlink targets.
- `web_fetch` rejects localhost, private/reserved IP addresses and redirects
  to those destinations, and limits response time and body size. Known
  limitation: the hostname is resolved once to validate it, then resolved
  again independently by the HTTP client to connect; a malicious/compromised
  DNS server that changes its answer between those two lookups (DNS
  rebinding) could bypass this check. There is no dependency-free way to pin
  the validated IP for the actual connection on the current runtime (Bun),
  so treat `web_fetch` as unsuitable for fetching untrusted, attacker-influenced
  URLs against sensitive internal endpoints.
- In `plano` mode, only an explicit read-only allowlist is available. MCP,
  hooks, subagents and persistence mutations are blocked by default.
- The system prompt in `sistema` mode instructs the model to warn before
  destructive or registry-level actions and to prefer non-destructive
  commands.
- `execute_command` is intentionally an arbitrary shell capability. File-tool
  guards do not sandbox PowerShell commands; only enable the agent where this
  trust level is acceptable.

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
