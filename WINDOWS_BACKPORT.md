# Backport para o Windows — correções portáveis do porte Linux/Unix

Documento de handoff para aplicar no repositório **Windows** (`siliconflower`).
Somente mudanças que valem em qualquer plataforma. **Não** inclui `src/platform.ts`, shell Unix, `install.sh`, skills unix nem o build multiplataforma.

**Origem:** commit `84a2e90` em `siliconflower-nix` (https://github.com/1155dosilicon/siliconflower-nix)

---

## 1. Reduzir spam de log no streaming (`src/llm.ts`) — alta prioridade

**Problema:** cada delta de `tool_call` gravava uma linha `INFO`, enchendo o log (~96% do arquivo em sessões com tools).

**Antes:**
```ts
if (delta.tool_calls) {
  void log("info", `LLM step ${step}: tool_call chunk recebido (${delta.tool_calls.length} parciais)`);
  for (const tc of delta.tool_calls) {
```

**Depois:**
```ts
// perto de stepHasThinking / stepHasText
let toolCallChunkCount = 0;

// no handler de delta.tool_calls
if (delta.tool_calls) {
  toolCallChunkCount += delta.tool_calls.length;
  for (const tc of delta.tool_calls) {
```

**E no resumo do step** (linha do `finish_reason`):
```ts
void log("info", `LLM step ${step}: finish_reason=${finishReason}, argBuffers=${argBuffers.size}, toolCallChunks=${toolCallChunkCount}`);
```

**Como validar:** rodar uma sessão com várias tools e conferir `logs` — não deve haver `tool_call chunk recebido`; deve aparecer `toolCallChunks=N` no fim do step.

---

## 2. Subagentes sem `read_skill` (`src/services/subagent.ts`) — alta prioridade

**Problema:** `run_task` só expunha `builtinToolsAsMcp()` (33 tools). `read_skill` (definida em `src/skills.ts` como `SKILL_TOOL`) só existia no TUI principal (`App.tsx`). Subagentes não conseguiam ler skills.

**Import no topo:**
```ts
import { builtinToolsAsMcp, runBuiltin, isBuiltin } from "../tools.js";
import { SKILL_TOOL, readSkillContent } from "../skills.js";
```

**Em `runSubagentExecution` — lista de tools:**
```ts
const tools = [
  ...builtinToolsAsMcp().filter((t) => t.name !== "run_task"),
  {
    server: "skill",
    name: SKILL_TOOL.name,
    description: SKILL_TOOL.description,
    inputSchema: SKILL_TOOL.inputSchema,
  },
];
```

**Em `executeTool` (antes do `isBuiltin`):**
```ts
executeTool: async (name, args) => {
  if (name === SKILL_TOOL.name) {
    try {
      const content = await readSkillContent(String(args.name ?? ""));
      return { result: content, isError: false };
    } catch (e) {
      return { result: String(e), isError: true };
    }
  }
  if (isBuiltin(name)) {
    return runBuiltin(name, args, { config: opts.config });
  }
  return { result: `Ferramenta ${name} não disponível no subagente`, isError: true };
},
```

**Como validar:** subagente com `run_task` pedindo para ler uma skill deve retornar o conteúdo do `.md`, não `Ferramenta read_skill não disponível`.

---

## 3. Tipagem/robustez de `stdout`/`stderr` em `exec` — média

**Problema:** `promisify(exec)` tipa saída como `string | Buffer`; `.trim()` direto quebra o `tsc` (ou depende de cast).

### `src/tools.ts` (`execute_command`)
```ts
const { stdout, stderr } = await execAsync(cmd, execOptions);
const outStr = String(stdout ?? "").trim();
const errStr = String(stderr ?? "").trim();
let output = "";
if (outStr) output += outStr;
if (errStr) output += (output ? "\n--- STDERR ---\n" : "") + errStr;
```

### `src/services/background-tasks.ts`
```ts
stdoutBuf = stdout ? String(stdout).trim() : "";
stderrBuf = stderr ? String(stderr).trim() : "";
```

**Como validar:** `bun run typecheck` limpo; `execute_command` retorna stdout/stderr normalmente.

---

## 4. (Opcional) Encoding UTF-8 nas opções de shell

Se extrair helper no Windows, use:
```ts
{ encoding: "utf8", shell: "powershell.exe", windowsHide: true, /* ... */ }
```
Evita Buffer em respostas com acentuação (PT-BR).

---

## O que NÃO backportar

| Item | Motivo |
|---|---|
| `src/platform.ts` | Abstração multi-OS; Windows pode continuar com `powershell.exe` literal |
| `scripts/install.sh` / `install-bin.js` | Instalação Unix; no Windows manter `install.ps1` |
| Skills `unix-backup` / `unix-system` | Específicas de Linux/Unix |
| `getWorkspaceId` sem lowercase | Em Windows o filesystem é case-insensitive; lowercase é **correto** lá |
| `build.ts` com `bun-linux-*` / `bun-darwin-*` | No Windows manter `bun-windows-x64` e `.exe` |
| Persona `Linux/Unix` em `modes.ts` | Textos de modo devem continuar Windows/PowerShell no repo Windows |
| `package.json` `"os"` multi + URLs do `siliconflower-nix` | Repos separados |

---

## Checklist de aplicação no repo Windows

1. Aplicar fix **1** (`llm.ts`) — anti-spam de log.
2. Aplicar fix **2** (`subagent.ts`) — `read_skill` em subagentes.
3. Aplicar fix **3** (`tools.ts` + `background-tasks.ts`) — tipo seguro em stdout/stderr.
4. Rodar: `bun run typecheck` e `bun test`.
5. Entrada no `CHANGELOG.md` (sugestão abaixo).
6. `bun run build` e smoke test da TUI.

### Sugestão de CHANGELOG (Windows)

```markdown
### Fixed
- **Log Spam no Streaming (`src/llm.ts`):** cada delta de `tool_call` gerava uma linha INFO; agora o total é agregado em `toolCallChunks` no resumo do step.
- **`read_skill` Indisponível em Subagentes (`src/services/subagent.ts`):** `run_task` passa a expor e executar `read_skill` igual à TUI principal.
- **Tipagem de Saída de `execute_command`/Background (`src/tools.ts`, `src/services/background-tasks.ts`):** coerção segura de `stdout`/`stderr` (`string | Buffer`).
```

---

## Nota sobre `getWorkspaceId` (Linux only)

No porte Linux o hash do workspace **preserva case** do path (`/Foo` ≠ `/foo`). No Windows o comportamento antigo (lowercase) deve ser mantido — não é bug lá.
