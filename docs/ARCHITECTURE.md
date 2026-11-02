# Arquitetura do Siliconflower

Referência para quem vai mudar o código. Comandos, regras e mapa resumido estão em [AGENTS.md](../AGENTS.md); uso, instalação e configuração estão no [README](../README.md).

## Fluxo de uma mensagem

1. **`index.tsx`** carrega a configuração efetiva (`config.json` + variáveis de ambiente), aplica as flags da CLI e inicia a TUI ou a GUI. Se a configuração estiver incompleta, abre o assistente.
2. **`AgentSession`** (`session.ts`), ao iniciar, carrega as skills e conecta os servidores MCP. Uma falha de MCP vai para o log e para a barra de status, sem bloquear as ferramentas nativas.
3. **A cada mensagem**, monta o prompt de sistema (`modes.ts`):
   - persona e foco do modo;
   - instruções do projeto e índice de memórias (`buildMemorySystemPrompt`);
   - prompt personalizado do usuário;
   - lista de skills e diretório atual.
4. **`llm.ts`** (`streamChat`) roda o loop:
   - antes de **cada** requisição, recompacta o histórico (`compressHistory`: acima de 90 mil tokens estimados ou 40 mensagens, reduz o conteúdo antigo e descarta turnos inteiros);
   - faz o streaming e executa as chamadas de ferramenta em sequência;
   - repete até a resposta não ter mais ferramentas ou até `MAX_STEPS` (50). No limite, avisa o usuário.
5. **O evento `done`** traz em `messages` o que o turno produziu: `assistant` com `toolCalls`, resultados `tool` e a resposta final. A sessão acrescenta isso ao histórico da API, separado das mensagens exibidas. Turnos cancelados ou com erro guardam só o texto visível.
6. **`buildOpenAIMessages`** descarta resultados `tool` cuja chamada foi compactada, evitando HTTP 400 por mensagem órfã.

Saídas de ferramenta acima de 32 mil caracteres são truncadas (início e fim). O conteúdo completo vai para `~/.siliconflower/outputs/` e o caminho aparece na resposta (`processToolOutput`).

**Cancelamento**: a TUI é renderizada com `exitOnCtrlC: false`. `Ctrl+C` durante uma resposta (ou `Esc`/**Parar** na GUI) chama `AgentSession.cancel()`, que aborta o `AbortController` do turno. O SDK da OpenAI encerra o stream em silêncio ao abortar, então `llm.ts` confere o sinal depois do stream e antes de cada ferramenta: um turno cancelado nunca conta como concluído nem executa as chamadas já recebidas. O sinal chega:
- à requisição HTTP;
- aos comandos, que têm a árvore de processos encerrada;
- aos subagentes e às ferramentas deles;
- às chamadas MCP;
- a uma pergunta pendente de `ask_question`.

Com o agente ocioso, `Ctrl+C` sai.

**Redimensionamento**: o Ink 5 apaga "as N linhas do quadro anterior", mas o terminal já refez a quebra dessas linhas em outra quantidade de linhas, e sobram fragmentos. Por isso, 150 ms depois do último `resize`, a `App` chama `useStdout().write(ANSI_CLEAR_SCREEN)`. Esse `write` do Ink zera a contabilidade do quadro, limpa a tela e o scrollback e redesenha o quadro inteiro. O logo (`ascii.ts`) escolhe a variante pela largura: completo, empilhado ou texto.

## Sessão e interfaces

`AgentSession` (`session.ts`) concentra a conversa e não depende de interface: histórico da API, despacho de ferramentas, modo `plano`, cancelamento e `ask_question`. As interfaces leem `getState()` (objeto substituído a cada mudança, nunca alterado), assinam `subscribe`/`onStreamEvent` e chamam as ações (`send`, `cancel`, `answer`, `setMode`, `setReasoning`).

- **TUI** (`App.tsx`): desenha o estado com Ink.
- **GUI** (`gui/`): `gui/index.ts` controla o ciclo de vida e abre o navegador; `gui/server.ts` serve a página e faz a ponte por WebSocket; `gui/client/` é HTML, CSS e JS puros, sem build, embutidos no `.exe` por `import ... with { type: "text" }`. Usa `Bun.serve`, então só é importada dinamicamente pelo comando `gui`, e a TUI continua rodando em Node + tsx.

**Protocolo do WebSocket** (JSON). Servidor: `hello` (estado e ferramentas, para uma página nova ou recarregada), `state` (só as chaves que mudaram, agrupadas a cada 33 ms) e `tool`. O texto do raciocínio não vai para a página. Página: `send`, `answer`, `cancel`, `mode`, `reasoning`; valores inválidos são ignorados.

**Ciclo de vida**: sem nenhuma página conectada por 15 s, o app encerra. A tolerância existe para a página recarregar sem perder a sessão. Cada processo tem uma sessão e uma pasta de trabalho; vários projetos significam vários processos, o que também isola o estado global (`todo.ts`, tarefas em background, subagentes). Ao encerrar, a GUI mata a árvore de processos das tarefas em background; a TUI ainda não faz isso.

**App de desktop** (`desktop/`): uma casca Electron em volta da GUI, em projeto separado, que não reescreve o agente. O processo principal (`main.ts`) cuida das janelas, e `agent-process.ts` inicia um `siliconflower.exe gui --managed` por projeto, sem console, com a pasta do projeto como `cwd`. O agente roda fora do Node do Electron para isolar a pasta e o estado por projeto e para que operações pesadas não travem a janela.

Protocolo de `--managed` (`gui/managed.ts`), uma linha JSON no stdout: `{"event":"ready","url":...}` ou `{"event":"error","code":"config_required"}`. Nesse modo não há assistente nem navegador, e o encerramento por falta de página é desligado: quem decide é o app. Ele fecha o stdin para pedir a saída limpa, com hooks e MCP, e usa `taskkill /T /F` se o agente não sair em 8 s. Como o stdin também fecha quando o app morre, o agente não fica órfão nesse caso. Se o agente morrer, a janela oferece reabrir com `--resume-latest`.

**Configurações** (`desktop/src/settings.ts`): rodam no processo principal, reaproveitando `src/config.ts` no bundle, e a chave não sai de lá. O app só inicia o agente com configuração válida; sem ela, abre o formulário e depois segue para o que foi pedido. Um agente em execução mantém a configuração com que iniciou, então aplicar uma mudança é reiniciá-lo: o app oferece isso ao salvar, e a conversa volta com `--resume-latest`.

**Conversas salvas** (`services/conversations.ts`): `AgentSession` recebe um `ConversationStore` por dependência. A GUI passa um, em `getWorkspaceDataDir(cwd)/sessions`; a TUI não passa, e nada é salvo. Cada `<id>.jsonl` tem uma linha de resumo, para listar sem ler históricos inteiros, e uma de conteúdo: histórico da API, mensagens exibidas, cartões de ferramentas e tarefas. A gravação é atômica e acontece só depois de `commitTurn`, então o arquivo nunca tem turno incompleto; `completeHistory` ainda corta o histórico ao carregar, por garantia. Fechar no meio de uma resposta aborta o turno e `close()` espera ele ser salvo. Arquivo danificado vira um aviso e fica de fora da lista. O protocolo do WebSocket ganha `new`, `resume` e `delete`; ao trocar de conversa, o servidor reenvia `hello` e a página redesenha tudo.

**Instalador** (`desktop/electron-builder.yml`): NSIS por usuário, em `%LOCALAPPDATA%\Programs\siliconflower-desktop`, pasta que vem do `name` em `desktop/package.json`. Ela precisa ser diferente de `Programs\siliconflower`, usada pelo CLI (`scripts/install.ps1`), senão desinstalar o app apagaria o CLI. O agente vai em `resources\`, fora do asar, porque o Windows não executa arquivos de dentro dele. O ícone é gerado por `desktop/scripts/make-icon.ts`.

As proteções de acesso estão no [SECURITY.md](../SECURITY.md). O Markdown do modelo vira uma árvore de nós em `client/markdown.js` e só depois DOM, com `textContent` e tags fixas; a página nunca usa `innerHTML`.

## Provedores e raciocínio

Todos os provedores usam Chat Completions compatível com OpenAI (`llm.ts`):

- **Xiaomi MiMo** (`reasoning.ts`; hostname `xiaomimimo.com` ou subdomínio):
  - o raciocínio vira `thinking.type` `enabled`/`disabled`;
  - `reasoning_content` é preservado na mensagem `assistant` que antecede resultados de ferramenta;
  - `Ctrl+E` alterna entre `none` e `high`.
- **Demais provedores**: `low`/`medium`/`high` vão como `reasoning_effort`, e `Ctrl+E` percorre os quatro níveis.
- **Limite de saída** (16384 tokens): vai em `max_completion_tokens` para `api.openai.com` e em `max_tokens` nos demais.

Quando o provedor rejeita `reasoning_effort` ou o parâmetro de tokens, a requisição é repetida com o ajuste. Cada ajuste é feito no máximo uma vez e vale para os passos seguintes.

## Execução de shell (`shell.ts`)

`runPowerShell`/`startPowerShell` são usados por `execute_command`, hooks e tarefas em background. Eles:

- executam `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand`, o que evita problemas de aspas (acima de ~30 mil caracteres, usam `-Command`);
- forçam UTF-8 na saída;
- convertem o stderr CLIXML em texto;
- em timeout, abort ou estouro de buffer, rodam `taskkill /T /F` **antes** de matar o processo pai, para não deixar filhos órfãos.

## Projetos e memória

**Projeto** (`project.ts`): uma pasta é projeto quando contém `SILICONFLOWER.md` ou `AGENTS.md`; o primeiro tem prioridade. `findProject` procura na pasta atual e nas pastas acima dela, sem considerar `~`. `siliconflower init` cria o arquivo.

- **Dentro de um projeto**:
  - o conteúdo do arquivo entra no prompt como instruções, até 20 mil caracteres;
  - as memórias de projeto ficam ativas;
  - o workspace é identificado pela raiz do projeto, então as subpastas compartilham memórias, artefatos e hooks.
- **Fora de um projeto**:
  - a memória de projeto fica desligada e a leitura não cria diretórios;
  - `save_memory`/`forget_memory` com escopo `project` devolvem um erro que orienta usar `global` ou `init`.

**Armazenamento**, sempre fora do repositório:

| Dado | Local |
| :--- | :--- |
| Memórias de projeto | `~/.siliconflower/workspaces/<workspace-id>/memory/` |
| Memórias globais | `~/.siliconflower/memory/` (valem em qualquer pasta) |
| Artefatos | `.../workspaces/<workspace-id>/artifacts/` ou `~/.siliconflower/artifacts/`; metadados em `<id>.meta` |
| Legado (só leitura e exclusão) | `<raiz-do-projeto>/.siliconflower/` |

`<workspace-id>` = nome da pasta + 8 caracteres do SHA-256 do caminho (`getWorkspaceDataDir`). `SILICONFLOWER_DATA_DIR` substitui `~/.siliconflower`, e a suíte de testes usa isso.

**Memória sob demanda**: o prompt recebe só o **índice** (nome, tipo, escopo e descrição; até 60 entradas e 6 mil caracteres). O modelo lê o conteúdo com `recall_memory` quando for relevante. Tipos: `user`, `feedback`, `project`, `reference`.

## Hooks (`core/hooks.ts`)

| Hook | Quando | Origem |
| :--- | :--- | :--- |
| `preTool`, `postTool` | Antes e depois de cada ferramenta nativa (não no modo `plano`) | `hooks` do `config.json` |
| `onEdit` | Depois de `write_file`, `edit_file`, `apply_patch`, `move_path` e `delete_path` bem-sucedidos | `config.json` |
| `onCommand` | Antes de `execute_command` | `hooks.onCommand` inline; se ausente, o primeiro `hooks.json` em: workspace → `<raiz>/.siliconflower/` → `~/.siliconflower/` |
| `onSessionStart`, `onSessionEnd` | Abertura e fechamento da TUI, inclusive no modo `plano` | `config.json` |

Os hooks rodam via `shell.ts`, com timeout de 30 s, e recebem estas variáveis:
- `SILICONFLOWER_EVENT`;
- `SILICONFLOWER_TOOL_NAME`;
- `SILICONFLOWER_TOOL_ARGS` (JSON);
- `SILICONFLOWER_COMMAND`;
- `SILICONFLOWER_FILE_PATH`.

O resultado de um hook não bloqueia a ferramenta. `manage_hooks` mostra a configuração em vigor.

## Modo `plano` e MCP

**Modo `plano`**: `tool-policy.ts` define uma allowlist fechada, só com leitura, busca, web, perguntas, `todowrite` e `manage_background_task` restrito a `list`/`status`. Fica bloqueado:
- qualquer ferramenta fora da lista;
- MCP;
- subagentes;
- qualquer mutação.

A checagem é feita em `session.ts` antes de despachar a ferramenta. `programação` e `sistema` só mudam o foco do prompt e não restringem nada.

**MCP** (`mcp.ts`):
- os servidores de `mcpServers` sobem via stdio, com timeout de conexão de 20 s;
- as ferramentas são expostas como `mcp_<servidor>_<ferramenta>_<hash>` (no máximo 64 caracteres, sem colisões), e o nome original é usado só no transporte;
- cada chamada tem timeout de 120 s e é cancelável;
- `isError: true` do servidor chega ao modelo como erro.

## Ferramentas nativas

Os schemas em `src/tools.ts` são a fonte de verdade; esta tabela só indica onde está cada coisa e o comportamento que não é óbvio.

| Ferramenta | Implementação | Observações |
| :--- | :--- | :--- |
| `read_file`, `write_file`, `list_directory`, `create_directory`, `move_path`, `file_info` | `tools.ts` | Caminhos validados por `isPathBlockedSafe` (System32, `.ssh`, `.aws`, incluindo links) |
| `delete_path` | `tools.ts` | Exige `confirm: true`; protege raízes de disco, a pasta do usuário, o cwd e as pastas acima deles |
| `edit_file` | `services/smart-edit.ts` | Correspondência exata → quebras de linha normalizadas → espaços flexíveis (erro se ambíguo); preserva CRLF |
| `apply_patch` | `tools.ts` | Vários blocos, gravação única; preserva CRLF |
| `search_files` | `glob-util.ts` | No máximo 1000 resultados, 200 exibidos com aviso |
| `grep_content` | `grep.ts` | Regex sem distinção de maiúsculas; ignora `IGNORED_SOURCE_DIRS`, pastas ocultas e binários |
| `repo_map`, `find_symbol` | `services/repomap.ts` | Extração por regex: TS/JS, Python, Go, Rust |
| `execute_command` | `tools.ts` + `shell.ts` | Timeout de até 120 s; `runInBackground` cria tarefa com timeout de até 1 h |
| `manage_background_task` | `services/background-tasks.ts` | `list`, `status`, `kill` |
| `run_task`, `send_subagent_message` | `services/subagent.ts` | Sem timeout fixo, cancelável; subagentes não têm `run_task` nem MCP |
| `ask_question` | `tools.ts` + `session.ts` | Pausa e espera a resposta na interface (TUI ou GUI); sem interface, pede ao modelo que repasse a pergunta |
| `todowrite` | `todo.ts` | Checklist da sessão |
| `save_memory`, `recall_memory`, `forget_memory` | `services/memory.ts` | Veja "Projetos e memória" |
| `create_artifact`, `read_artifact`, `list_artifacts`, `delete_artifact` | `services/artifact.ts` | Mudar o tipo remove o arquivo antigo |
| `enter_worktree`, `exit_worktree`, `list_worktrees` | `services/worktree.ts` | `<raiz>/.worktrees/<branch>` + `.git/info/exclude`; não muda o cwd |
| `web_fetch`, `web_search` | `services/web.ts` | Bloqueio de SSRF (inclui IPv6 que embute IPv4); `maxChars` limita o Markdown, não o HTML |
| `read_logs` | `logger.ts` | Log de 200 KB, mantendo as últimas 500 linhas |
| `manage_hooks` | `core/hooks.ts` | Somente leitura |
| `read_skill` | `skills.ts` | Skills em `~/.siliconflower/skills/` |

Limites de segurança e o que **não** é protegido (comandos PowerShell, MCP): veja [SECURITY.md](../SECURITY.md).
