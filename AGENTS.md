# Siliconflower — guia para agentes

Agente de IA para Windows, Linux e macOS/Unix, como app de desktop e interface no navegador: TypeScript + Bun (Electron no app), sobre APIs compatíveis com OpenAI.
Um único código para todos os sistemas: o que muda entre Windows e Linux/Unix fica listado em `docs/PLATAFORMAS.md` (atualize esse arquivo ao criar ou remover uma diferença). O CI (`.github/workflows/ci.yml`) roda typecheck e testes em Windows e Linux.
Textos para o usuário, prompts e docs ficam em pt-BR. Logs e campos de protocolo ficam em ASCII.

## Comandos

```bash
bun install
bun run typecheck   # precisa passar limpo
bun test            # roda o shell real da plataforma; usa SILICONFLOWER_DATA_DIR temporário (tests/setup.ts)
bun run build       # gera dist/siliconflower (Linux/macOS) ou dist/siliconflower.exe (Windows)
npm run install:bin # Unix: copia para ~/.local/bin; Windows: %LOCALAPPDATA%\Programs\siliconflower + PATH
bun start -- gui    # roda a GUI a partir do código-fonte (sem argumentos, só mostra a ajuda)
```

Antes de dar uma tarefa por concluída: `bun run typecheck` e `bun test`.

## Mapa do código

- `src/index.tsx`: CLI (commander). `config.ts`/`wizard.ts`: configuração.
- `src/session.ts`: `AgentSession`, a conversa sem interface: histórico da API, despacho de ferramentas, cancelamento e `ask_question`.
- `src/gui/`: interface web (`server.ts` com WebSocket, `client/` em HTML/CSS/JS puros, sem build).
- `src/llm.ts`: loop de streaming e ferramentas (até 50 passos), compactação por passo, fallbacks de parâmetros. `context.ts`: compactação e truncamento de saídas.
- `src/tools.ts`: ferramentas nativas (schema + `run`). `read_skill` fica em `skills.ts`. `tool-policy.ts`: allowlist do modo `plano`.
- `src/shell.ts`: toda execução de shell (PowerShell no Windows, `$SHELL -c` em Unix). `platform.ts`: detecção de SO e shell padrão. `project.ts`: detecção de projeto (`SILICONFLOWER.md`/`AGENTS.md`).
- `src/services/`: memória, mídia, subagentes, tarefas em background, conversas salvas, web, artefatos, worktrees, repomap, smart-edit.
- `src/core/hooks.ts`: hooks. `mcp.ts`: cliente MCP.
- `desktop/`: app Electron, projeto à parte (`bun install --cwd desktop`, `bun run desktop`, `bun run typecheck:desktop`). `main.ts`: janelas e segurança. `agent-process.ts`: ciclo de vida do `siliconflower gui --managed`, um por projeto. `settings.ts`: formulário de configuração, sem Electron. `bun run desktop:dist` gera o pacote da plataforma atual em `dist-desktop/` (`.deb` e AppImage no Linux, NSIS no Windows). `scripts/install-appimage.sh`: instala o AppImage por usuário, com atalho e ícone (testes em `tests/install-appimage.test.ts`).

## Regras (cada uma já causou bug)

- **Shell só via `src/shell.ts`** (`runShell`/`startShell`). `exec`/`execFile` com PowerShell quebra acentos (CP850) e carrega o `$PROFILE`; em qualquer SO, matar só o processo pai deixa filhos órfãos (Windows usa `taskkill /T`, Unix mata o grupo de processos).
- **Código específico de SO** passa por `src/platform.ts` (`isWindows()`); testes que dependem do shell devem cobrir os dois lados.
- **Nada de `process.stdout`/`stderr.write` na sessão, nas ferramentas e na GUI** (só os subcomandos que imprimem e saem usam `console`): no `gui --managed`, o stdout é o protocolo JSON com o app (`src/gui/managed.ts`), e lixo nele quebra o app. Use `log()` de `logger.ts`, que nunca lança exceção.
- **Ferramenta nova**:
  - schema e `run` em `tools.ts`;
  - decida se entra na allowlist de `tool-policy.ts` (fora dela, fica bloqueada no modo `plano`);
  - honre `ctx.signal` se puder demorar;
  - só entra em `CANCELLABLE_BUILTINS`, que impõe timeout fixo, se nunca rodar por mais de ~1 min;
  - devolva `isError: true` em qualquer falha.
- **Histórico da API**: toda mensagem `assistant` com `toolCalls` vem seguida dos resultados `tool` correspondentes. Nunca guarde um turno incompleto (veja `done.messages` em `llm.ts`).
- **Config**: `loadConfig()` aplica as variáveis de ambiente e serve só para execução. Para editar ou salvar, use `loadStoredConfig()`.
- **Dados por projeto**: use `getWorkspaceDataDir(cwd)`, que resolve a raiz do projeto. Não grave arquivos na pasta do usuário sem ele pedir.
- **Argumentos do modelo não são confiáveis**: caminhos passam por `isPathBlockedSafe`, números por clamp.
- **GUI**: a lógica da conversa fica em `session.ts`, não na interface. Texto do modelo nunca vira HTML (sem `innerHTML`; use `textContent`). Não relaxe as checagens de token, `Host`, `Origin` nem a CSP de `gui/server.ts`: o agente executa comandos e qualquer site pode tentar acessar a porta local.
- **Abortar stream**: o SDK da OpenAI encerra a iteração em silêncio ao abortar. Confira `signal.aborted` depois do stream (`llm.ts`), senão o turno cancelado parece concluído e as ferramentas recebidas executam.
- **Versão**: `package.json`, `desktop/package.json` e `src/version.ts` mudam juntos (`tests/version.test.ts` verifica).
- **Desktop**: a URL de `gui --managed` traz o token, nunca a grave em log. Não dê preload às janelas de projeto: elas exibem texto do modelo. No `main.ts`, não use `__dirname` (o bundler o troca pela pasta do código-fonte) nem posições fixas no `argv` (o Chromium reordena os argumentos). O nome do agente muda por SO (`siliconflower` / `siliconflower.exe`), e em Unix ele roda em grupo de processos próprio para o kill forçado alcançar os filhos.

## Ao mudar comportamento

- Teste em `tests/`. Regressões de bugs vão em `tests/regressions.test.ts`.
- `CHANGELOG.md`: uma linha por item em `[Unreleased]`.
- `README.md` se a mudança afeta quem usa; `docs/ARCHITECTURE.md` se afeta fluxo ou arquitetura; `SECURITY.md` se afeta garantias de segurança.
- Contagens (número de ferramentas etc.) aparecem só no README.

## Referência

`docs/ARCHITECTURE.md` cobre o fluxo de uma mensagem, provedores e raciocínio, projetos e memória, hooks, modo `plano`, MCP e a tabela de ferramentas. Para o detalhe de cada ferramenta, os schemas em `src/tools.ts` são a fonte.
