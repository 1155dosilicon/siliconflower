# Arquitetura do Siliconflower

Referência para quem vai mudar o código. Comandos, regras e mapa resumido estão em [AGENTS.md](../AGENTS.md); uso, instalação e configuração estão no [README](../README.md).

## Fluxo de uma mensagem

1. **`index.tsx`** carrega a configuração efetiva (`config.json` + variáveis de ambiente), aplica as flags da CLI e inicia a GUI (`gui`, ou `gui --managed` no app de desktop). Se a configuração estiver incompleta, abre o assistente no terminal; no `--managed`, avisa o app com `config_required`. Um `config.json` que existe mas não pode ser lido (JSON inválido, sem permissão) é um erro (`ConfigFileError`) e nunca é tratado como ausente: o assistente ou o formulário gravariam um arquivo novo por cima, perdendo hooks e MCP. Sem subcomando, só mostra a ajuda.
2. **`AgentSession`** (`session.ts`), ao iniciar, carrega as skills e conecta os servidores MCP. Uma falha de MCP vai para o log e aparece como aviso na interface, sem bloquear as ferramentas nativas.
3. **A cada mensagem**, monta o prompt de sistema (`modes.ts`):
   - identidade, foco do modo e regras comuns;
   - instruções do projeto, delimitadas por `<instrucoes_do_projeto>`, e índice de memórias (`buildMemorySystemPrompt`);
   - prompt personalizado do usuário;
   - lista de skills e, por último, data, diretório atual e shell.
4. **`llm.ts`** (`streamChat`) roda o loop:
   - antes de **cada** requisição, recompacta o histórico (`compressHistory`: acima de 90 mil tokens estimados, descontados o prompt de sistema e os schemas, ou de 40 mensagens, reduz o conteúdo antigo e descarta turnos inteiros). Acima do orçamento, encurta primeiro os resultados de ferramenta, depois as mensagens do modelo e por último as do usuário, com o pedido atual no fim da fila; os argumentos das chamadas continuam um objeto JSON válido (`shrinkToolArguments`), e no Xiaomi MiMo o raciocínio das mensagens com chamadas fica, encurtado;
   - faz o streaming e executa as chamadas de ferramenta em sequência; cada passo concluído (a mensagem com as chamadas, um resultado para cada uma e o anexo de mídia) sai como evento `step`;
   - repete até a resposta não ter mais ferramentas ou até `MAX_STEPS` (50). No limite, avisa o usuário.
5. **O evento `done`** traz em `messages` o que o turno produziu: `assistant` com `toolCalls`, resultados `tool` e a resposta final. A sessão acrescenta isso ao histórico da API, separado das mensagens exibidas. Turnos cancelados ou com erro guardam os passos concluídos (eventos `step`) e, depois deles, o texto do passo interrompido com o motivo (`[Erro: ...]` ou `[interrompido pelo usuário]`): o modelo continua sabendo o que suas ferramentas já fizeram. Um passo cortado pelo cancelamento é fechado com o resultado `NOT_RUN_AFTER_CANCEL` para as chamadas que não rodaram. Chamadas de uma resposta ainda em recepção não entram, porque não rodaram.
6. **`buildOpenAIMessages`** descarta resultados `tool` cuja chamada foi compactada, evitando HTTP 400 por mensagem órfã.

Saídas de ferramenta acima de 32 mil caracteres são truncadas (início e fim). O conteúdo completo vai para `~/.siliconflower/outputs/` e o caminho aparece na resposta (`processToolOutput`). O corte é feito em `llm.ts`, para todo resultado: ferramentas nativas, MCP e subagentes. Imagens e áudios devolvidos por MCP viram uma nota curta (`mcpContentText`), em vez de Base64 como texto.

**Cancelamento**: `Esc` ou **Parar** na interface chama `AgentSession.cancel()`, que aborta o `AbortController` do turno. O SDK da OpenAI encerra o stream em silêncio ao abortar, então `llm.ts` confere o sinal depois do stream e antes de cada ferramenta: um turno cancelado nunca conta como concluído nem executa as chamadas já recebidas. O sinal chega:
- à requisição HTTP;
- aos comandos, que têm a árvore de processos encerrada;
- aos subagentes e às ferramentas deles;
- às chamadas MCP;
- às buscas recursivas (`grep_content`, `search_files`, `repo_map`, `find_symbol`) e à consulta DNS do `web_fetch`;
- aos hooks (uma ferramenta cancelada durante o `preTool` não roda);
- a uma pergunta pendente de `ask_question`.

## Sessão e interfaces

`AgentSession` (`session.ts`) concentra a conversa e não depende de interface: histórico da API, despacho de ferramentas, modo `plano`, cancelamento e `ask_question`. As interfaces leem `getState()` (objeto substituído a cada mudança, nunca alterado), assinam `subscribe`/`onStreamEvent` e chamam as ações (`send`, `cancel`, `answer`, `setMode`, `setReasoning`).

- **GUI** (`gui/`): `gui/index.ts` controla o ciclo de vida e abre o navegador (`openUrlCommand`: `xdg-open` no Linux, `open` no macOS, `Start-Process` no Windows, sempre via `runShell`); `gui/server.ts` serve a página e faz a ponte por WebSocket; `gui/client/` é HTML, CSS e JS puros, sem build, embutidos no binário por `import ... with { type: "text" }`. Usa `Bun.serve`, então só é importada dinamicamente pelo comando `gui`, e os demais subcomandos continuam rodando em Node + tsx.

**Protocolo do WebSocket** (JSON). Servidor: `hello` (estado e ferramentas, para uma página nova ou recarregada), `state` (só as chaves que mudaram, agrupadas a cada 33 ms) e `tool`. O texto do raciocínio não vai para a página. Página: `send`, `answer`, `cancel`, `mode`, `reasoning`; valores inválidos são ignorados.

**Ciclo de vida**: sem nenhuma página conectada por 15 s, o app encerra. A tolerância existe para a página recarregar sem perder a sessão. Cada processo tem uma sessão e uma pasta de trabalho; vários projetos significam vários processos, o que também isola o estado global (`todo.ts`, tarefas em background, subagentes). Ao encerrar (fim da página ou sinal; os sinais por SO estão em [PLATAFORMAS.md](PLATAFORMAS.md)), `killAllBackgroundTasks` mata a árvore de processos das tarefas em background, que de outro modo sobreviveriam ao agente.

**App de desktop** (`desktop/`): uma casca Electron em volta da GUI, em projeto separado, que não reescreve o agente. O processo principal (`main.ts`) cuida das janelas, e `agent-process.ts` inicia um `siliconflower gui --managed` (`siliconflower.exe` no Windows) por projeto, sem console, com a pasta do projeto como `cwd`. O agente roda fora do Node do Electron para isolar a pasta e o estado por projeto e para que operações pesadas não travem a janela.

Protocolo de `--managed` (`gui/managed.ts`), uma linha JSON no stdout: `{"event":"ready","url":...}` ou `{"event":"error","code":"config_required"}`. Nesse modo não há assistente nem navegador, e o encerramento por falta de página é desligado: quem decide é o app. Ele fecha o stdin para pedir a saída limpa, com hooks e MCP, e força o fim se o agente não sair em 8 s: no Windows com `taskkill /T /F`; em Unix o agente é líder do próprio grupo de processos (`detached`) e o grupo recebe `SIGKILL`. Como o stdin também fecha quando o app morre, o agente não fica órfão nesse caso. Se o agente morrer, a janela oferece reabrir com `--resume-latest`.

**Configurações** (`desktop/src/settings.ts`): rodam no processo principal, reaproveitando `src/config.ts` no bundle (gravação atômica com `0600` em Unix), e a chave não sai de lá. O app só inicia o agente com configuração válida; sem ela, abre o formulário e depois segue para o que foi pedido. Com um `config.json` danificado, o formulário mostra o erro, não salva por cima e oferece recarregar o arquivo depois de corrigido. Um agente em execução mantém a configuração com que iniciou, então aplicar uma mudança é reiniciá-lo: o app oferece isso ao salvar, e a conversa volta com `--resume-latest`.

**Conversas salvas** (`services/conversations.ts`): `AgentSession` recebe um `ConversationStore` por dependência. A GUI passa um, em `getWorkspaceDataDir(cwd)/sessions`; sem ele (subagentes, testes), nada é salvo. Cada `<id>.jsonl` tem uma linha de resumo, para listar sem ler históricos inteiros, e uma de conteúdo: histórico da API, mensagens exibidas, cartões de ferramentas e tarefas. A gravação é atômica e acontece só depois de `commitTurn`, então o arquivo nunca tem turno incompleto. O id de uma conversa nova é definido antes de gravar, e apagar entra na mesma fila das gravações: trocar ou apagar a conversa enquanto ela é salva não faz outra conversa gravar por cima nem traz a apagada de volta; `completeHistory` ainda corta o histórico ao carregar, por garantia. Fechar no meio de uma resposta aborta o turno e `close()` espera ele ser salvo. Arquivo danificado vira um aviso e fica de fora da lista. O protocolo do WebSocket ganha `new`, `resume` e `delete`; ao trocar de conversa, o servidor reenvia `hello` e a página redesenha tudo.

**Pacotes** (`desktop/electron-builder.yml`): no Linux, um `.deb` e um AppImage (`bun run desktop:dist` ou `dist:linux` em `desktop/`). O `.deb` instala em `/opt/Siliconflower` e, no `postinst` do `electron-builder`, ajusta o `chrome-sandbox` e o perfil do AppArmor. O AppImage pode ser instalado por usuário com `scripts/install-appimage.sh`, que o extrai (sem FUSE) para `~/.local/share/siliconflower-desktop`, cria o atalho e o ícone e só usa `--no-sandbox` quando o sistema bloqueia *user namespaces*. Os três usam o nome `siliconflower-desktop` (`desktopName`, `executableName`, `StartupWMClass`), para o menu associar a janela aberta ao ícone. No Windows, NSIS por usuário em `%LOCALAPPDATA%\Programs\siliconflower-desktop`: a pasta vem do `name` em `desktop/package.json` e precisa ser diferente de `Programs\siliconflower`, a do agente avulso (`scripts/install.ps1`). O agente vai em `resources/`, fora do asar, porque um executável não roda de dentro dele. O ícone é gerado por `desktop/scripts/make-icon.ts` (`.ico` no Windows, `icon.png` no Linux).

As proteções de acesso estão no [SECURITY.md](../SECURITY.md). O Markdown do modelo vira uma árvore de nós em `client/markdown.js` e só depois DOM, com `textContent` e tags fixas; a página nunca usa `innerHTML`.

## Provedores e raciocínio

Todos os provedores usam Chat Completions compatível com OpenAI (`llm.ts`):

- **Xiaomi MiMo** (`reasoning.ts`; hostname `xiaomimimo.com` ou subdomínio):
  - o raciocínio vira `thinking.type` `enabled`/`disabled`;
  - `reasoning_content` é preservado na mensagem `assistant` que antecede resultados de ferramenta;
  - o seletor **Pensamento** só oferece `none` e `high` (desligado/ligado).
- **Demais provedores**: `low`/`medium`/`high` vão como `reasoning_effort`, e o seletor **Pensamento** oferece os quatro níveis.
- **Limite de saída** (32768 tokens): vai em `max_completion_tokens` para `api.openai.com` e em `max_tokens` nos demais. Se o provedor recusar o valor, a requisição é repetida com 16384. Se a resposta for cortada nele, uma chamada de ferramenta incompleta não executa (o modelo recebe o erro, e o histórico guarda `{}` no lugar do JSON quebrado) e um texto cortado termina com um aviso. O mesmo vale para um stream encerrado sem `finish_reason`, tratado como resposta interrompida.
- **HTTP 400 só com "Request failed"**: o Xiaomi MiMo devolve isso às vezes para pedidos válidos, e a requisição é repetida uma vez.

Quando o provedor rejeita `reasoning_effort` ou o parâmetro de tokens, a requisição é repetida com o ajuste. Cada ajuste é feito no máximo uma vez e vale para os passos seguintes.

## Execução de shell (`shell.ts`)

`runShell`/`startShell` são usados por `execute_command`, hooks, tarefas em background e para abrir o navegador. O shell vem de `platform.ts` (`getDefaultShell`): PowerShell 5.1 no Windows, `$SHELL -c` em Unix. Em timeout, abort ou estouro de buffer, a árvore de processos inteira é encerrada antes do processo pai, para não deixar filhos órfãos. Os detalhes de cada sistema (codificação, UTF-8, CLIXML, grupos de processos) estão em [PLATAFORMAS.md](PLATAFORMAS.md#execução-de-comandos).

## Projetos e memória

**Projeto** (`project.ts`): uma pasta é projeto quando contém `SILICONFLOWER.md` ou `AGENTS.md`; o primeiro tem prioridade. `findProject` procura na pasta atual e nas pastas acima dela, sem considerar `~`. `siliconflower init` cria o arquivo.

- **Dentro de um projeto**:
  - o conteúdo do arquivo entra no prompt como instruções, até 20 mil caracteres;
  - as memórias de projeto ficam ativas;
  - o workspace é identificado pela raiz do projeto, então as subpastas compartilham memórias, artefatos e hooks.
- **Fora de um projeto**:
  - a memória de projeto fica desligada e a leitura não cria diretórios;
  - `memory` com `save` ou `forget` no escopo `project` devolve um erro que orienta usar `global` ou `init`.

**Armazenamento**, sempre fora do repositório:

| Dado | Local |
| :--- | :--- |
| Memórias de projeto | `~/.siliconflower/workspaces/<workspace-id>/memory/` |
| Memórias globais | `~/.siliconflower/memory/` (valem em qualquer pasta) |
| Artefatos | `.../workspaces/<workspace-id>/artifacts/` ou `~/.siliconflower/artifacts/`; metadados em `<id>.meta` |
| Legado (só leitura e exclusão) | `<raiz-do-projeto>/.siliconflower/` |

`<workspace-id>` = nome da pasta + 8 caracteres do SHA-256 do caminho (`getWorkspaceDataDir`). `SILICONFLOWER_DATA_DIR` substitui `~/.siliconflower`, e a suíte de testes usa isso.

**Memória sob demanda**: o prompt recebe só o **índice** (nome, tipo, escopo e descrição; até 60 entradas e 6 mil caracteres). O modelo lê o conteúdo com `memory` (`action: "recall"`) quando for relevante. Tipos: `user`, `feedback`, `project`, `reference`.

## Hooks (`core/hooks.ts`)

| Hook | Quando | Origem |
| :--- | :--- | :--- |
| `preTool`, `postTool` | Antes e depois de cada ferramenta nativa (não no modo `plano`) | `hooks` do `config.json` |
| `onEdit` | Depois de `write_file`, `edit_file`, `apply_patch`, `move_path` e `delete_path` bem-sucedidos | `config.json` |
| `onCommand` | Antes de `execute_command` | `hooks.onCommand` inline; se ausente, o primeiro `hooks.json` em: workspace → `~/.siliconflower/` |
| `onSessionStart`, `onSessionEnd` | Abertura e fechamento da sessão (GUI ou app), inclusive no modo `plano` | `config.json` |

Os hooks rodam via `shell.ts`, com timeout de 30 s, e recebem estas variáveis:
- `SILICONFLOWER_EVENT`;
- `SILICONFLOWER_TOOL_NAME`;
- `SILICONFLOWER_TOOL_ARGS` (JSON; textos acima de 2 mil caracteres são encurtados, e o todo fica em até 16 mil, para caber numa variável de ambiente);
- `SILICONFLOWER_COMMAND` (até 16 mil caracteres);
- `SILICONFLOWER_FILE_PATH`.

Um `hooks.json` dentro do repositório (`<raiz>/.siliconflower/hooks.json`, lido até a 0.8.0) nunca roda, porque um projeto clonado executaria comandos seus: ele vira um aviso no log e em `show_hooks`, que indica para onde movê-lo. O resultado de um hook não bloqueia a ferramenta. A saída do `onEdit` é acrescentada ao resultado da edição (até 8 mil caracteres), que continua sem erro mesmo se o hook falhar. `show_hooks` mostra a configuração em vigor.

## Modo `plano` e MCP

**Modo `plano`**: `tool-policy.ts` define uma allowlist fechada, só com leitura, busca, web, perguntas e `todowrite`. Ferramentas com `action` entram só nas ações de leitura: `manage_background_task` (`list`, `status`), `memory` (`recall`) e `artifact` (`read`, `list`). Fica bloqueado:
- qualquer ferramenta fora da lista;
- MCP;
- subagentes;
- qualquer mutação.

A checagem é feita em `session.ts` antes de despachar a ferramenta. `programação` e `sistema` só mudam o foco do prompt e não restringem nada. A mesma política vale para os subagentes `research` e `plan` (`services/subagent.ts`).

**MCP** (`mcp.ts`):
- os servidores de `mcpServers` sobem via stdio, com timeout de conexão de 20 s;
- as ferramentas são expostas como `mcp_<servidor>_<ferramenta>_<hash>` (no máximo 64 caracteres, sem colisões), e o nome original é usado só no transporte;
- cada chamada tem timeout de 120 s e é cancelável;
- `isError: true` do servidor chega ao modelo como erro.

## Ferramentas nativas

Os schemas em `src/tools.ts` são a fonte de verdade; esta tabela só indica onde está cada coisa e o comportamento que não é óbvio.

| Ferramenta | Implementação | Observações |
| :--- | :--- | :--- |
| `read_file`, `write_file`, `list_directory`, `create_directory`, `move_path`, `file_info` | `tools.ts` | Caminhos validados por `isPathBlockedSafe` (System32/SysWOW64, `/etc`, `/root`, `/boot`, `.ssh`, `.aws`, incluindo links) |
| `read_media` | `tools.ts` + `services/media.ts` | Veja "Mídia" abaixo |
| `delete_path` | `tools.ts` | Exige `confirm: true`; protege raízes de disco, a pasta do usuário, o cwd e as pastas acima deles |
| `edit_file` | `services/smart-edit.ts` | Correspondência exata → quebras de linha normalizadas → espaços flexíveis (erro se ambíguo); preserva CRLF |
| `apply_patch` | `tools.ts` | Vários blocos, gravação única; preserva CRLF |
| `search_files` | `glob-util.ts` | No máximo 1000 resultados, 200 exibidos com aviso; não entra nas pastas bloqueadas, nem com `includeHidden` |
| `grep_content` | `grep.ts` | Regex sem distinção de maiúsculas; ignora `IGNORED_SOURCE_DIRS`, pastas ocultas e bloqueadas, binários e arquivos acima de 2 MB; para em 200 ocorrências e avisa |
| `repo_map`, `find_symbol` | `services/repomap.ts` | Extração por regex: TS/JS, Python, Go, Rust; não entram nas pastas bloqueadas; `find_symbol` exige um nome |
| `execute_command` | `tools.ts` + `shell.ts` | Timeout de até 120 s; `runInBackground` cria tarefa com timeout de até 1 h |
| `manage_background_task` | `services/background-tasks.ts` | `list`, `status`, `kill` |
| `run_task`, `send_subagent_message` | `services/subagent.ts` | Sem timeout fixo, cancelável; subagentes não têm `run_task`, `send_subagent_message`, `todowrite` nem MCP e só executam as ferramentas oferecidas a eles; recebem o contexto do projeto (`buildSubagentPrompt`), e `research` e `plan` são somente leitura; `send_subagent_message` recusa um subagente ainda em execução |
| `ask_question` | `tools.ts` + `session.ts` | Pausa e espera a resposta na interface; sem interface, pede ao modelo que repasse a pergunta |
| `todowrite` | `todo.ts` | Checklist da sessão |
| `memory` | `services/memory.ts` | `save`, `recall`, `forget`; veja "Projetos e memória" |
| `artifact` | `services/artifact.ts` | `create`, `read`, `list`, `delete`; mudar o tipo remove o arquivo antigo |
| `enter_worktree`, `exit_worktree`, `list_worktrees` | `services/worktree.ts` | `<raiz>/.worktrees/<branch>` + `.git/info/exclude`; não muda o cwd |
| `web_fetch`, `web_search` | `services/web.ts` | Bloqueio de SSRF (inclui IPv6 que embute IPv4); `maxChars` limita o Markdown, não o HTML |
| `read_logs` | `logger.ts` | Log de 200 KB, mantendo as últimas 500 linhas |
| `show_hooks` | `core/hooks.ts` | Somente leitura |
| `read_skill` | `skills.ts` | Skills em `~/.siliconflower/skills/` |

### Mídia

`read_media` lê o arquivo em Base64 (até 37 MB) e devolve o texto do resultado mais um anexo. Mensagens `tool` só levam texto, então `llm.ts` envia os anexos do passo numa mensagem `user` logo depois de todos os resultados, marcada como dado e não como pedido do usuário.

- **Formato** (`services/media.ts`): `image_url` em qualquer provedor. `input_audio` e `video_url` seguem o formato da API Xiaomi MiMo; nos demais provedores a ferramenta recusa áudio e vídeo.
- **Reenvio**: o histórico vai inteiro a cada passo, então `pruneMedia` mantém só os 4 arquivos mais recentes, até 50 MB em Base64 no total. Os mais antigos viram uma nota com o caminho, e o modelo pode ler de novo.
- **Conversas salvas**: `stripMediaData` grava só o caminho, nunca o conteúdo.
- **Recusa do provedor**: um HTTP 400, 413, 415 ou 422 num pedido com mídia faz `rejectMedia` trocar os arquivos por uma nota e repetir o pedido. Sem isso, o arquivo ficaria no histórico e todos os pedidos seguintes da conversa falhariam.

Limites de segurança e o que **não** é protegido (comandos de shell, MCP): [SECURITY.md](../SECURITY.md).
