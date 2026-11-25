# Changelog

Todas as mudanças relevantes ficam registradas aqui. O formato segue o
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e o projeto usa
[Versionamento Semântico](https://semver.org/lang/pt-BR/). Uma linha por item.

## [Unreleased]

### Corrigido
- A interface da conversa não pisca nem pula mais durante o streaming: a resposta em andamento atualiza o Markdown bloco a bloco em vez de reconstruir o DOM inteiro a cada frame, o indicador de atividade permanece montado entre chamadas de ferramentas, os controles e estatísticas do rodapé ficam em linhas fixas sem quebrar de altura, a inserção de cards de ferramentas e o botão "Ir para o fim" não competem mais com o auto-scroll, e o painel de tarefas só redesenha quando a lista muda (`src/gui/client/`).

## [0.18.0] - 2026-11-25

### Adicionado
- Suporte de primeira classe ao DeepSeek em `api.deepseek.com`: cada mensagem `assistant` volta com `reasoning_content` (vazio quando o pensamento foi descartado), que é como o raciocínio anterior continua no contexto deles num pedido com `tools`; `none` desliga o pensamento com `thinking.type: "disabled"`, já que lá ele vem ligado por padrão em `high`; todos os níveis de raciocínio são enviados, sem o rebaixamento para `high` que outros provedores pedem; e o limite de saída sobe de 32768 para 393216 tokens, o teto do modelo (`src/reasoning.ts`, `src/llm.ts`, `src/context.ts`).
- O padrão de `contextTokens` acompanha o modelo: 800 mil para DeepSeek (janela de 1M), 90 mil para os outros. Compactar a cada passo mudava o começo do pedido e derrubava o cache do provedor, que responde a maior parte da entrada (`src/context.ts`).
- Num gateway que hospeda DeepSeek (SiliconFlow, modo compatível da Aliyun...), o modelo é reconhecido pelo nome: ele recebe o limite de saída maior e o `reasoning_content` de volta em cada mensagem `assistant`, como na API oficial, e um pedido recusado por causa de `thinking` ou de `reasoning_content` é repetido sem esse campo em vez de terminar o turno, com o ajuste valendo até o fim do turno (`src/llm.ts`).
- O **Testar conexão** do app e o 🩺 Diagnóstico testam um modelo DeepSeek com `thinking` e `reasoning_effort`, como num turno real, e dizem quando o provedor recusa esses parâmetros em vez de deixar para a primeira mensagem (`src/provider-check.ts`).

### Corrigido
- O parâmetro que liberava áudio e vídeo no pedido era o mesmo que guardava o raciocínio das mensagens: agora são dois, então um provedor novo que precise do raciocínio de volta não ganha suporte a mídia por acidente (`src/llm.ts`).
- O ajuste de `thinking` de um gateway que o recusa era refeito a cada passo do turno (um 400 e um reenvio em todos eles): agora é lembrado até o fim do turno (`src/llm.ts`).
- O raciocínio da mensagem `assistant` com `tool_calls` deixou de ser guardado no Xiaomi MiMo quando o suporte ao DeepSeek entrou; o MiMo exige `reasoning_content` ali, e a regra voltou a valer para ele (`src/llm.ts`).
- `finish_reason` `insufficient_system_resource` e `aborted`, que só o DeepSeek documenta, terminavam o turno em silêncio com a resposta possivelmente incompleta: agora ela termina com o aviso de interrupção (`src/llm.ts`).
- O padrão de `contextTokens` de 800 mil valia para qualquer modelo com "deepseek" no nome, inclusive um `deepseek-chat`/`deepseek-r1` de gateway com janela de 128 mil, que recusava todo turno longo: agora o padrão acompanha a geração (V4 e `flash`, janela de 1M), e o pedido recusado por tamanho é cortado pela metade até três vezes — antes eram duas, e de 800 mil só se chegava a 288 mil (`src/context.ts`, `src/llm.ts`).

### Alterado
- A tag `vX.Y.Z` agora publica a release direto, marcada como "Latest", em vez de deixar um rascunho para revisar à mão (`release.yml`): um rascunho esquecido levava a publicar uma segunda release na mesma tag, e a página da tag passava a mostrar a que estava sem os pacotes.

## [0.17.0] - 2026-11-25

### Corrigido
- `estimateTokens` usava uma única razão de 3,5 caracteres por token: texto CJK, cirílico ou com emoji custa até um token por caractere, então o orçamento estimava menos do que o pedido usava e o provedor recusava a requisição. Agora o cálculo separa ASCII, latino acentuado e caracteres largos (`src/context.ts`).
- Quando o começo da conversa era descartado para caber no contexto, o modelo não sabia: respondia como se aquilo nunca tivesse sido pedido, o que fazia turnos antigos serem refeitos passo a passo. Agora entra uma mensagem de compactação dizendo quantas mensagens saíram e para não refazer o que já está pronto.
- `askAfterTokens` contava cada reenvio do contexto inteiro: o limite parava a resposta em ~89 passos com o contexto cheio (e em ~400 com um contexto pequeno), sem medir custo nenhum. A entrada agora pesa 0,1 (`PREFILL_WEIGHT`), então 8M medem o custo do turno e não o tamanho do contexto.
- O rodapé da página mostrava o tamanho do contexto (`68k`) e a pergunta falava em `8M` sem dizer que eram coisas diferentes: agora aparecem três números, contexto, custo no turno e passos, e a pergunta diz que o valor é o custo.

### Adicionado
- Um pedido recusado por tamanho (`context_length_exceeded` e afins) agora encolhe o histórico e é repetido até duas vezes, em vez de terminar o turno: o `contextTokens` é uma estimativa, e um modelo com janela menor do que a configurada só descobria isso na hora da falha (`src/llm.ts`).
- `429` e `5xx` são repetidos com espera exponencial, respeitando o `Retry-After` do provedor, até três vezes antes de desistir; o retry interno do SDK da OpenAI fica desligado para não multiplicar as tentativas (`src/llm.ts`).
- O plano aberto (`todowrite`) vai na nota de compactação, então o que falta fazer sobrevive a um histórico descartado; itens concluídos e cancelados ficam de fora (`src/context.ts`, `src/session.ts`).
- `turnTokens` (soma bruta do turno), `turnCost` (o mesmo, ponderado) e `cachedTokens` no `run --json`, no estado da sessão e no `run`: dá para ver quanto cada resposta custou de fato.
- `tokenWeights` no `config.json` (`prefill` e `cacheHit`): o peso da entrada e da entrada cacheada no `askAfterTokens`. `{ prefill: 1, cacheHit: 1 }` volta à soma bruta do provedor; os padrões (0,1 e 0,025) medem custo.
- O custo do turno passou a considerar o cache de prompt (`prompt_tokens_details.cached_tokens` ou `prompt_cache_hit_tokens`), em vez de cobrar o prefixo reenviado como entrada nova; o rodapé mostra quanto veio do cache.

## [0.16.0] - 2026-11-19

### Added
- Orçamentos por resposta além dos passos: `askAfterTokens` (padrão 8M, somando todos os pedidos ao modelo) e `askAfterMinutes` (padrão 60) no `config.json`, `0` desliga; no app, ao chegar no limite, a interface pergunta se continua, como em `askAfterSteps` (`src/turn-limits.ts`, `src/llm.ts`, `src/config.ts`).
- Sem ninguém para perguntar (`run` sem terminal, MCP, subagentes), o turno que chega num limite termina com um último pedido sem ferramentas, que resume o que foi feito, o que foi descoberto, o que falta e o próximo passo, em vez de parar só com "[Parado depois de N passos]"; se esse pedido falhar, fica a nota de onde parou (`src/llm.ts`).
- Perto do limite (10% restante), sem ninguém para perguntar, o modelo recebe um aviso para encaminhar o fim, e muitas vezes termina sozinho antes da parada (`src/turn-limits.ts`).
- Detector de loop em três níveis: a mesma chamada com o mesmo resultado (inclusive alternando A, B, A, B) e o mesmo erro de uma ferramenta com argumentos variados recebem aviso na 3ª vez, uma instrução de correção na 5ª e param o turno (ou perguntam, no app) na 8ª; buscas seguidas sem resultado são avisadas na 5ª e na 8ª, sem parar (`src/turn-limits.ts`).
- `siliconflower run --max-steps/--max-tokens/--max-minutes` e, no `ask` do servidor MCP, `max_steps`/`max_tokens`/`max_minutes`: limites só para aquele pedido (`src/index.tsx`, `src/mcp-server.ts`).
- `run --json` traz `stopped` (`reason`: `steps`, `tokens`, `time` ou `loop`, com passos, tokens e segundos) e `turnTokens`, o total do turno; o `ask` diz que a resposta é um resumo parcial e como continuar (`src/run.ts`, `src/mcp-server.ts`).

### Fixed
- O `status` de uma tarefa em background ainda rodando traz `runningForSeconds`: antes, checar um build silencioso devolvia sempre o mesmo texto e parecia um loop (`src/tools.ts`).

## [0.15.0] - 2026-11-16

### Added
- `siliconflower run "mensagem"`: roda uma resposta do agente no terminal, sem janela, e sai; `-c`/`--resume <id>` continuam conversas salvas (as mesmas do app), `-a` anexa arquivos, `--stdin` junta o que veio pelo pipe, `--json` imprime o resultado para scripts e `-q` esconde as ferramentas; sem terminal, `ask_question` volta na resposta e o turno para em `askAfterSteps` (`src/run.ts`, `src/index.tsx`, `src/session.ts`).
- `siliconflower mcp`: o agente como servidor MCP (stdio) para o Claude Code e outros clientes, com as ferramentas `ask` (roda uma resposta em `siliconflower run` próprio na pasta pedida, com progresso por ferramenta, cancelamento e conversas continuáveis), `list_conversations` e `read_conversation` (`src/mcp-server.ts`, `src/index.tsx`).

## [0.14.1] - 2026-11-15

### Security
- As ferramentas de arquivo do modelo não abrem mais o `config.json` da pasta de dados, que guarda a chave de API; um `config.json` de qualquer outra pasta continua acessível (`src/fs-util.ts`).
- `SILICONFLOWER_API_KEY` não chega mais aos comandos de shell, hooks e servidores MCP, para o modelo não ler a chave com `echo $SILICONFLOWER_API_KEY`; um MCP que precise dela a recebe pelo próprio `env` (`src/shell.ts`, `src/mcp.ts`).
- O resultado de toda ferramenta chega ao modelo e à interface com a chave de API e as chaves e headers dos servidores MCP trocados por `***`: um `cat ~/.siliconflower/config.json` no shell não entrega mais a chave (`src/config.ts`, `src/llm.ts`).

## [0.14.0] - 2026-11-14

### Added
- `askAfterSteps` no `config.json` (padrão 150, `0` desliga): a cada tantos passos de ferramentas numa mesma resposta, a interface pergunta se continua, em vez de deixar um loop rodar até alguém apertar **Parar**; subagentes param nesse ponto (`src/llm.ts`, `src/session.ts`, `src/config.ts`).
- A 3ª chamada idêntica no turno (mesma ferramenta, mesmos argumentos e mesmo resultado) chega ao modelo com um aviso para mudar de abordagem (`src/llm.ts`).

### Fixed
- A compactação cortava para 120 caracteres os resultados que o modelo ainda não tinha visto (vários arquivos grandes lidos num único passo): ele relia os mesmos arquivos em loop. Agora esses resultados são os últimos a encolher, dividem o espaço que sobra e terminam com uma nota que diz como ler o resto, e um passo com mais de 20 chamadas não tem os primeiros resultados tratados como antigos (`src/context.ts`).
- Ferramenta MCP chamada sem o sufixo `_<hash>` (`mcp_brave_brave_web_search`) dava "tool not found": agora resolve quando só uma ferramenta tem esse nome, e um nome desconhecido recebe os nomes certos ou os mais parecidos (`src/mcp.ts`, `src/session.ts`).
- Uma resposta que gastava todo o limite de saída só pensando terminava com "Resposta cortada… envie continue": agora o passo é repetido uma vez com o pensamento em `low` e, se ainda assim não vier nada, o aviso diz o que houve, sem guardar o raciocínio no histórico (`src/llm.ts`).
- Uma conexão perdida no meio da resposta (`ECONNRESET`) encerrava o turno com erro: agora o passo é repetido até duas vezes, descartando o texto parcial, e a interface mostra "a conexão caiu; repetindo" (`src/llm.ts`, `src/session.ts`, `src/services/subagent.ts`).

## [0.13.0] - 2026-11-13

### Added
- `siliconflower doctor --json` (o relatório numa linha de JSON) e `--projects [pastas...]` (confere essas pastas no lugar da atual), usados pelo app para rodar o diagnóstico fora de um projeto (`src/index.tsx`, `src/doctor.ts`).

### Changed
- No app, o **🩺 Diagnóstico** saiu da janela do projeto e foi para a tela inicial: funciona antes de abrir uma pasta e confere os hooks e as conversas de todos os projetos recentes de uma vez. No navegador, o botão continua no topo da página (`desktop/src/doctor.ts`, `desktop/src/renderer/`, `src/gui/`).

## [0.12.0] - 2026-11-13

### Added
- Diagnóstico na interface: o botão 🩺 no topo confere configuração, provedor (um pedido mínimo), servidores MCP, shell, git, pasta de dados, hooks, conversas salvas e erros recentes do log, e diz como resolver cada problema; **Corrigir o que der** renomeia conversas danificadas e, no Linux, fecha a pasta de dados para outros usuários, sem apagar nada (`src/doctor.ts`, `src/gui/`).
- Comando `siliconflower doctor`, com as mesmas verificações no terminal, para quando a interface não abre (`--fix`, `--offline`).

### Removed
- Comando `siliconflower run` (execução sem interface para scripts e CI): era a base de um bot para o GitHub que não foi adiante. Com ele saem `src/run.ts`, a configuração só por variáveis de ambiente (sem `config.json`) e a seção correspondente do `SECURITY.md`.

### Changed
- O limite de 50 passos de ferramentas por mensagem acabou: uma tarefa longa segue até o modelo responder, dar erro ou ser cancelada, sem pedir `continue` (`src/llm.ts`, `src/modes.ts`).
- O **Testar conexão** do app e o `doctor` usam o mesmo pedido mínimo ao provedor (`src/provider-check.ts`, `desktop/src/settings.ts`).

## [0.11.0] - 2026-11-13

### Added
- Comando `siliconflower run "<pedido>"`: executa um pedido até o fim sem interface e imprime a resposta, para scripts e CI; lê o pedido da entrada padrão, funciona só com as variáveis `SILICONFLOWER_*` e responde `ask_question` automaticamente (`src/run.ts`).
- `bun run release <versão>` atualiza versão, badge do README e CHANGELOG de uma vez e mostra o que mudou desde a última tag para revisar as docs (`scripts/release.ts`).
- O CI recusa mudança de código sem linha no CHANGELOG e avisa quando nenhuma doc mudou (`scripts/check-changes.ts`).
- A release no GitHub usa a seção do CHANGELOG como descrição (`scripts/release-notes.ts`).
- Templates de PR, com checklist das docs, e de issue (bug e recurso) em `.github/`.
- A descrição da release traz um guia "Qual baixar?" separando o app de desktop do agente portátil (`scripts/release-notes.ts`).
- Níveis de pensamento `max` e `ultra`, no seletor, em `--reasoning` e no `config.json`; se o provedor recusar um deles, o pedido é repetido com `high` em vez de sem `reasoning_effort` (`src/reasoning.ts`, `src/llm.ts`).

### Changed
- A tela de configurações do app não vem mais com o SiliconFlow escolhido nem com o endereço dele preenchido no primeiro uso, e o campo do modelo não sugere mais IDs de um provedor específico (`desktop/src/renderer/`).
- O agente avulso sai na release como `siliconflower-portatil-windows-x64.exe` e `siliconflower-portatil-linux-x64`, para não ser confundido com o instalador (`.github/workflows/release.yml`).
- Documentação: badge de versão do README, compactação só por tokens, revisão `rev` das conversas e mensagens do WebSocket no ARCHITECTURE; `tests/docs-sync.test.ts` falha quando versão, contagem ou lista de ferramentas ou comandos da CLI da doc ficam para trás.

## [0.10.0] - 2026-11-10

### Changed
- Na interface, o modo `programação` aparece como **ultracódigo**, com as letras em arco-íris animado e fonte JetBrains Mono (OFL, embutida e recortada para Latin-1, 7 KB); o valor do modo, os prompts e a config salva não mudam (`src/gui/client/`, `src/gui/server.ts`).

## [0.9.1] - 2026-11-10

### Fixed
- Duas janelas que salvavam a mesma conversa no mesmo milissegundo não percebiam o conflito, e uma gravava por cima da outra: cada gravação leva agora uma revisão aleatória (`rev`), e arquivos antigos seguem comparados por `updatedAt` (`src/services/conversations.ts`, `src/session.ts`).

## [0.9.0] - 2026-11-09

Correções da revisão da 0.8.1 e o que faltava na interface: anexos, edição da última mensagem, tarefas em background, busca e renomeação de conversas. O projeto passa a ser só para Windows e Linux em x86_64.

### Added
- Anexar arquivos pela interface: botão 📎, colar ou arrastar. Imagens em qualquer provedor; áudio e vídeo na API Xiaomi MiMo. Até 4 arquivos e 10 MB por mensagem, guardados em `workspaces/<workspace-id>/uploads/` (`src/session.ts`, `src/gui/`).
- Tarefas em background aparecem na barra lateral, com botão para encerrar cada uma (`src/session.ts`, `src/gui/client/`).
- `manage_background_task` com `status` mostra em `partialOutput` o que um comando ainda em execução já imprimiu (`src/services/background-tasks.ts`).
- Editar e reenviar a última mensagem: o botão **Editar** aparece ao passar o mouse sobre ela; a resposta antiga sai da tela e do histórico, e os anexos vão de novo (`src/session.ts`, `src/gui/`).
- Busca e renomeação de conversas na barra lateral (`src/services/conversations.ts`, `src/gui/client/app.js`).
- Realce de sintaxe nos blocos de código, sem dependências e sem HTML do modelo (`src/gui/client/markdown.js`).
- `contextTokens` no `config.json`: quanto cada pedido pode usar antes de compactar o histórico (padrão 90 mil) (`src/context.ts`).
- Servidores MCP por HTTP: `url` e `headers` em `mcpServers`, também no formulário do app (`src/mcp.ts`, `desktop/src/settings.ts`).
- Hooks `preTool` e `postTool` também rodam para ferramentas MCP (`src/session.ts`).

### Removed
- Suporte a macOS e a ARM: o projeto é só para Windows e Linux em x86_64. `build.ts` recusa outras plataformas, `siliconflower gui` não usa mais `open`, e a documentação e o `package.json` (`os`, `cpu`) deixam de citar macOS.

### Changed
- Workflows de CI e release com `actions/checkout@v7` e `softprops/action-gh-release@v3`, que rodam em Node 24 (o Node 20 nas actions foi descontinuado pelo GitHub).
- `read_file` devolve linhas inteiras até cerca de 28 mil caracteres e diz em que linha continuar, em vez de o começo e o fim com o meio cortado; uma linha acima de 4 mil caracteres é encurtada (`src/tools.ts`).
- O texto de uma resposta em andamento vai para a página em pedaços, não inteiro a cada atualização (`src/gui/server.ts`).
- O limite de uma mensagem da página subiu de 1 MB para 16 MB, para caber os anexos (`src/gui/server.ts`).
- `@modelcontextprotocol/sdk` 1.32.2, que corrige quatro avisos de segurança do próprio SDK.

### Fixed
- Um `hooks.json` em `~/.siliconflower/` só rodava o `onCommand`: `preTool`, `postTool`, `onEdit`, `onSessionStart` e `onSessionEnd` eram ignorados sem aviso, e quem moveu o arquivo do repositório ao atualizar para a 0.8.1 ficou sem eles. Agora cada evento vem do `config.json` ou, na falta, do `hooks.json` (`src/core/hooks.ts`).
- Conversas com mais de 40 mensagens tinham os resultados antigos de ferramentas cortados para 300 caracteres mesmo com o contexto quase vazio, e o modelo esquecia os arquivos que tinha lido; a compactação agora depende só do orçamento de tokens (`src/context.ts`).
- Um erro de rede com "aborted" no texto aparecia como "cancelado pelo usuário", sem mensagem de erro (`src/llm.ts`, `src/session.ts`).
- Uma resposta vazia do provedor deixava a tela sem nada; agora aparece um aviso (`src/session.ts`).
- Um stream que parava de enviar dados no meio da resposta prendia o turno para sempre; agora falha depois de 300 s sem dados (`src/llm.ts`).
- `search_files` e o `include` de `grep_content` falhavam com `*` dentro de chaves (`{*.ts,*.js}`), e o ponto dentro de chaves casava com qualquer caractere (`src/glob-util.ts`).
- `grep_content` com uma regex de repetição aninhada, como `(a+)+`, podia congelar o agente inteiro, inclusive o botão Parar; o padrão agora é recusado (`src/grep.ts`).
- `web_fetch` com `timeoutMs` acima de 60 s era cortado em 60 s pelo limite fixo da ferramenta (`src/tools.ts`).
- `edit_file` regravava com CRLF todas as linhas de um arquivo que tivesse um só `\r\n`; agora só o trecho trocado é reescrito (`src/services/smart-edit.ts`).
- Windows: uma memória chamada `memory` era gravada no arquivo do índice e apagada por ele (`src/services/memory.ts`).
- `~/.siliconflower/outputs/` crescia sem limite; saídas com mais de 7 dias são apagadas (`src/context.ts`).
- Um servidor MCP que morria deixava suas ferramentas falhando até reiniciar o agente; agora é reconectado na chamada seguinte, e uma falha ao listar as ferramentas vai para o log (`src/mcp.ts`).
- Duas janelas no mesmo projeto (navegador e app) gravavam por cima da mesma conversa; a segunda a salvar agora continua numa cópia (`src/services/conversations.ts`).

### Security
- Credenciais em comandos e argumentos (`Bearer ...`, `sk-...`, `token=...`, senha em URL) são mascaradas antes de ir para o log (`src/logger.ts`).

## [0.8.1] - 2026-11-07

Correções de perda de conversas, de turnos interrompidos que o modelo esquecia, de saídas de ferramenta sem corte e do cancelamento, além de uma de segurança: hooks dentro do repositório não rodam mais.

### Changed
- Documentação enxugada: README sem repetições, ARCHITECTURE e PLATAFORMAS sem trechos duplicados, e o README explica o `env` do MCP e o erro de PATH com `npx` do nvm no app.

### Fixed
- Trocar de conversa, começar outra ou apagar a atual enquanto ela era salva fazia o turno seguinte gravar por cima de outra conversa ou trazia a apagada de volta (`src/session.ts`, `src/services/conversations.ts`).
- Um erro do provedor ou um cancelamento no meio do turno apagava da memória do modelo os passos de ferramenta já concluídos, e ele refazia edições e comandos sem saber; agora esses passos ficam no histórico, e as chamadas que não rodaram recebem um resultado dizendo isso (`src/llm.ts`, `src/session.ts`, `src/services/subagent.ts`).
- Resultados de MCP, `manage_background_task`, `find_symbol`, `repo_map`, `list_directory` e subagentes não eram cortados em 32 mil caracteres; o corte agora vale para toda ferramenta (`src/llm.ts`).
- Imagens e áudios devolvidos por servidores MCP chegavam ao modelo como Base64 em texto, megabytes por captura de tela; agora viram uma nota curta (`src/mcp.ts`).
- A compactação do histórico encurtava o pedido atual do usuário antes dos resultados de ferramenta e deixava JSON inválido nos argumentos das chamadas, que faz provedores recusarem os pedidos seguintes (`src/context.ts`).
- Xiaomi MiMo: a compactação removia o `reasoning_content` das mensagens com chamadas de ferramenta, que o MiMo exige; agora ele fica, encurtado (`src/context.ts`).
- Subagentes usavam `todowrite`, que substituía a lista de tarefas do usuário, e `send_subagent_message`, que contornava a proibição de recursão, e executavam ferramentas que não lhes foram oferecidas (`src/services/subagent.ts`).
- `send_subagent_message` para um subagente ainda em execução rodava a mesma sessão duas vezes ao mesmo tempo e embaralhava o histórico dela; agora é recusado.
- **Parar** não interrompia `grep_content`, `search_files`, `repo_map`, `find_symbol` nem os hooks, e uma ferramenta cancelada durante o `preTool` rodava mesmo assim (`src/grep.ts`, `src/glob-util.ts`, `src/services/repomap.ts`, `src/core/hooks.ts`, `src/tools.ts`).
- A consulta DNS do `web_fetch` ficava fora do timeout e do cancelamento, e um DNS lento travava a ferramenta (`src/services/web.ts`).
- Um `config.json` com erro de sintaxe era tratado como inexistente, e o assistente ou o formulário do app gravavam um novo por cima, perdendo hooks e servidores MCP; agora o erro aparece e o arquivo fica como está (`src/config.ts`, `desktop/src/settings.ts`).
- Um `config.json` salvo com BOM (Bloco de Notas) ou com um campo de tipo errado era descartado inteiro (`src/config.ts`).
- Hooks não rodavam para arquivos grandes: o conteúdo inteiro ia em `SILICONFLOWER_TOOL_ARGS` e estourava o limite de variável de ambiente (`E2BIG`); os textos longos agora são encurtados (`src/core/hooks.ts`).
- A conversão de HTML do `web_fetch` levava tempo quadrático em tags sem fechamento e congelava o agente inteiro por segundos ou minutos em algumas páginas (`src/services/web.ts`).
- `grep_content`, `search_files`, `repo_map` e `find_symbol` entravam em `/etc`, `/root`, `/boot`, `System32`, `.ssh` e `.aws` a partir de uma pasta acima delas (`src/fs-util.ts`).
- `find_symbol` com nome vazio devolvia todos os símbolos do repositório.
- `manage_background_task` com `list` trazia a saída inteira de cada tarefa, e uma só com megabytes escondia as outras; agora mostra o começo de cada uma (`src/tools.ts`).
- Uma mensagem acima de 1 MB na GUI fechava a conexão e sumia da caixa de texto; agora ela fica e a página explica o limite (`src/gui/client/app.js`).

### Security
- Um `.siliconflower/hooks.json` dentro do repositório não roda mais: um projeto clonado executava comandos seus a cada `execute_command`, mesmo num `git status`. O arquivo vira um aviso no log e em `show_hooks`, que indica para onde movê-lo (`src/core/hooks.ts`).

## [0.8.0] - 2026-11-05

A interface de terminal (TUI) saiu: as interfaces agora são o app de desktop e a GUI no navegador (`siliconflower gui`). O executável `siliconflower` continua: ele é o motor do app e mantém os subcomandos `gui`, `config`, `show`, `init`, `ensure`, `skills`, `sync` e `logs`.

### Changed
- `siliconflower` sem subcomando mostra a ajuda e indica o app de desktop ou `siliconflower gui`, em vez de abrir a conversa no terminal.
- O modo `plano` pede para trocar de modo pelo seletor Modo da interface, sem citar `Ctrl+O`.

### Removed
- TUI em Ink (`src/App.tsx`, `src/MarkdownText.tsx`, `src/terminal.ts`) e seus testes.
- Logo em ASCII (`src/ascii.ts`) e o teste dele.
- Atalhos de terminal `Ctrl+E`, `Ctrl+O` e `Ctrl+C`; na GUI e no app, os seletores Modo e Pensamento e o botão Parar fazem o mesmo.
- Saída sincronizada (DEC 2026) e a variável `SILICONFLOWER_NO_SYNC_OUTPUT`.
- Dependências `ink`, `ink-text-input`, `react`, `@types/react`, `@xterm/headless` e `chalk`.
- Shim de `react-devtools-core` no `build.ts`.
- Imagem da TUI no README (`assets/preview.png`).

## [0.7.0] - 2026-11-05

Versões Windows (`siliconflower` 0.5.0) e Linux/Unix (`siliconflower-nix` 0.6.0) unificadas num só código e repositório (`siliconflower`), a partir da versão Linux/Unix, que já rodava nos dois sistemas. Agora a GUI e o app de desktop também existem no Linux. O que muda entre os sistemas está em `docs/PLATAFORMAS.md`.

### Unificação
- Repositório único `1155dosilicon/siliconflower`; `siliconflower-nix` deixa de receber mudanças.
- CI em Windows e Linux: typecheck, testes e build do agente a cada push e PR (`.github/workflows/ci.yml`).
- Release por tag `vX.Y.Z`: agente e app de desktop de cada sistema num rascunho de release (`.github/workflows/release.yml`).
- Teste de órfãos no Windows (`Get-CimInstance`) volta a existir, ao lado do de Unix (`tests/regressions.test.ts`).
- `desktop/package.json`: `dist` gera o pacote do sistema atual; `dist:win` e `dist:linux` escolhem; nenhum publica sozinho (`--publish never`).

### Added
- Comando `siliconflower gui`: interface gráfica no navegador, com ferramentas, tarefas, perguntas, cancelamento e conversas salvas por projeto (`src/gui/`, `src/services/conversations.ts`). Abre o navegador com `xdg-open` no Linux e `open` no macOS.
- Opções `gui --port`, `--no-open`, `--managed` e `--resume-latest`.
- App de desktop em Electron (`desktop/`): janela própria por projeto, seletor de pasta, projetos recentes, configurações com teste de conexão e aviso quando o agente para. `bun run desktop:dist` gera um AppImage no Linux e o instalador NSIS no Windows.
- `docs/PLATAFORMAS.md`: as diferenças entre a versão Linux/Unix e a de Windows.

### Changed
- Conversa extraída de `App.tsx` para `AgentSession` (`src/session.ts`), usada pela TUI e pela GUI.
- O modo `plano` cita também o seletor Modo da interface gráfica.
- Barra de status da TUI igual à do Windows: sem a seção `MCPs:`, `Projeto:` com o arquivo do projeto e a contagem de tokens também na linha de status (desfaz o 0.6.0).
- O texto em streaming chega à TUI a cada pedaço recebido, como no Windows, em vez de no máximo a cada 60 ms.

### Linux/Unix
- App de desktop: o agente é `siliconflower` (sem `.exe`), roda em grupo de processos próprio e, se não sair em 8 s, o grupo recebe `SIGKILL` (no Windows, `taskkill /T /F`).
- App de desktop: projetos recentes diferenciam maiúsculas em Linux/Unix.
- GUI: `SIGHUP` também encerra o agente e as tarefas em background.

### Added (pacotes Linux)
- Pacote `.deb` do app de desktop para Debian, Ubuntu, elementary e derivados: instala em `/opt/Siliconflower`, com atalho, ícone e comando `siliconflower-desktop`, sem FUSE.
- `scripts/install-appimage.sh` (`bun run desktop:install`): instala o AppImage só para o usuário, sem senha e sem FUSE, com atalho em `~/.local/share/applications`, ícone e comando em `~/.local/bin`; `--uninstall` remove. Vai junto no release.
- README: requisitos do sistema (arquitetura, glibc, kernel, bibliotecas e distribuições mínimas), medidos nos binários.
- README: aviso para não instalar o pacote `fuse` no Ubuntu 24.04 e derivados, que remove o `fuse3` e parte da área de trabalho.

### Changed (pacotes Linux)
- O `.deb` declara também `libgbm1` e `libasound2`, que o Electron usa e a lista padrão do `electron-builder` não inclui.

## [0.6.0] - 2026-11-05

### Added
- Barra de status: nova seção `MCPs`, que mostra se há servidores MCP ligados e quantos (`on (2)`, `on (1/2)` com falha, `off`).

### Changed
- Barra de status mais curta: `Projeto:` mostra só o nome da pasta ou `nenhum`, e a contagem de tokens não se repete na linha de status.

## [0.5.0] - 2026-11-04

Backport do Siliconflower para Windows (0.3.0 a 0.5.0) para a versão Linux/Unix, sem a GUI e o app de desktop, com as adaptações e correções próprias de Linux/Unix listadas abaixo.

### Added
- Ferramenta `read_media`: o modelo vê imagens em qualquer provedor e ouve áudios e vê vídeos na API Xiaomi MiMo (`src/services/media.ts`).
- Prompt de sistema: regras comuns a todos os modos sobre dados que não são instrução, ações destrutivas, escopo, verificação e escolha de ferramentas, além da data atual e do shell real (`src/modes.ts`).
- Subagentes recebem as instruções do projeto, o índice de memórias, as preferências, as skills, o idioma e o diretório de trabalho; antes, só o papel (`src/services/subagent.ts`).
- Subagentes `research` e `plan` passam a ser somente leitura, com a mesma política do modo `plano`.

### Changed
- `save_memory`, `recall_memory` e `forget_memory` viraram a ferramenta `memory`, com o parâmetro `action`.
- `create_artifact`, `read_artifact`, `list_artifacts` e `delete_artifact` viraram a ferramenta `artifact`, com o parâmetro `action`.
- `manage_hooks` passou a se chamar `show_hooks`: ela só exibe a configuração.
- O prompt de sistema foi reorganizado em seções, e as instruções do projeto entram delimitadas por `<instrucoes_do_projeto>`.
- Cada papel de subagente agora define o formato da resposta final, e `verification` relata sem corrigir.
- Fechar a TUI encerra os comandos em background e o que eles iniciaram; antes, continuavam rodando (`src/App.tsx`, `src/terminal.ts`).
- TUI volta a desenhar a conversa inteira (logo, histórico e resposta completa em streaming) no quadro dinâmico; o `<Static>` e o corte da resposta em andamento (`src/LiveResponse.tsx`) foram removidos. Em terminais sem saída sincronizada (ex.: VTE) a tela pisca ao gerar respostas longas.
- O limite de saída por resposta subiu de 16384 para 32768 tokens; se o provedor recusar o valor, a requisição é repetida com 16384 (`src/llm.ts`).
- A saída do hook `onEdit` agora volta para o modelo junto com o resultado da edição; antes era descartada (`src/tools.ts`).
- A compactação do histórico desconta o prompt de sistema e os schemas do orçamento de 90 mil tokens (`src/llm.ts`).
- A estimativa de tokens passa de 3,8 para 3,5 caracteres por token, e o contador da TUI inclui os schemas das ferramentas (`src/context.ts`, `src/App.tsx`).
- Descrições de `execute_command`, `run_task`, `grep_content`, `edit_file`, `apply_patch`, `read_file` e `read_logs` agora informam limites e comportamento real (`src/tools.ts`).
- Gravação de `config.json` agora é atômica: uma queda no meio não perde a chave de API; links simbólicos são mantidos (`src/config.ts`).

### Fixed
- `config.json` ficava legível por outros usuários em Linux/Unix: agora é gravado com `0600`, e um arquivo antigo é corrigido ao ser lido (`src/config.ts`).
- `killProcessTree` em Unix ignorava filhos que sobreviveram ao shell e não mandava `SIGKILL` se o shell morresse antes; agora espera o grupo acabar (`src/shell.ts`).
- Cancelar uma resposta deixava ferramentas já recebidas executarem e guardava o turno como concluído, com status "pronto": agora o turno é interrompido de verdade (`src/llm.ts`).
- Mudar o modo ou o raciocínio e enviar uma mensagem logo depois fazia o status voltar a "pronto" durante a resposta (`src/App.tsx`).
- HTTP 400 só com "Request failed", que o Xiaomi MiMo devolve às vezes para pedidos válidos, agora é repetido uma vez em vez de virar erro na conversa (`src/llm.ts`).
- Chamada de ferramenta cortada no limite de tokens de saída não executa mais: o modelo recebe o erro e o motivo. Antes, `write_file` criava um arquivo vazio chamado `undefined` e relatava sucesso (`src/llm.ts`).
- `write_file` recusa chamadas sem `path` ou `content`; sem `content`, esvaziava o arquivo existente (`src/tools.ts`).
- Resposta de texto cortada no limite de tokens de saída agora avisa o usuário; antes terminava sem nenhum sinal (`src/llm.ts`).
- Stream encerrado sem `finish_reason`: a chamada de ferramenta incompleta dizia ao modelo para corrigir o JSON, e agora informa que a resposta foi interrompida; um texto interrompido parecia concluído, e agora termina com um aviso (`src/llm.ts`).
- `write_file` informava caracteres como se fossem bytes (`src/tools.ts`).
- O prompt aninhava o rótulo do sistema em parênteses, como `(Linux/Unix (linux, ...))` (`src/modes.ts`).
- O modo `plano` dava a entender que a autorização do usuário liberava edições; agora diz que elas seguem bloqueadas e como trocar de modo (`src/modes.ts`).
- `grep_content` parava em 200 ocorrências sem avisar; agora informa o corte (`src/tools.ts`).
- `edit_file` editava o primeiro trecho quando a correspondência flexível de espaços era ambígua; agora dá o erro previsto, sem alterar o arquivo (`src/services/smart-edit.ts`).
- O texto em streaming é repassado à TUI no máximo a cada 60 ms, em vez de a cada pedaço recebido.
- Cada quadro é enviado entre marcadores de saída sincronizada (DEC 2026), para os terminais com suporte desenharem tudo de uma vez; `SILICONFLOWER_NO_SYNC_OUTPUT=1` desativa.

## [0.2.9] - 2026-10-31

Backport das correções do Siliconflower para Windows (0.2.7 a 0.2.9) para a versão Linux/Unix. Os itens das seções 0.2.7–0.2.9 abaixo valem para todas as plataformas, salvo os marcados como Windows; as adaptações para Linux/Unix estão nesta lista.

### Linux/Unix
- Execução de shell unificada em `src/shell.ts` (`runShell`/`startShell`): PowerShell no Windows, `$SHELL -c` (ou `/bin/bash`) em Unix, não interativo e sem login, então `.bashrc`/`.zshrc`/`.profile` não são carregados (equivalente ao `-NoProfile`).
- Kill de comandos em Unix: o shell roda como líder de um novo grupo de processos e o grupo inteiro recebe `SIGTERM` (e `SIGKILL` após 2 s) em timeout, cancelamento ou estouro de buffer; antes só o shell morria e os filhos ficavam órfãos.
- `killProcessTree`/`shellExecOptions` saíram de `src/platform.ts`; `execute_command`, hooks e tarefas em background passam todos por `src/shell.ts`.
- Testes do executor de shell rodam em Windows e Unix, com regressão para processos órfãos (`tests/regressions.test.ts`).
- Não se aplicam em Unix (código continua só no Windows): UTF-8/CLIXML do PowerShell, `attrib +h` e BOM do `install.ps1`.
- Documentação (README, AGENTS.md, docs/ARCHITECTURE.md, SECURITY.md, CONTRIBUTING.md) adaptada para Windows, Linux e macOS/Unix.

### Fixed
- Logo quebrava em janelas estreitas: agora escolhe a versão completa, "SILICON/FLOWER" empilhado ou texto simples conforme a largura (`src/ascii.ts`).
- Redimensionar a janela deixava pedaços de telas antigas (logos empilhados, linhas duplicadas): depois de 150 ms sem redimensionar, a TUI limpa a tela e redesenha o quadro inteiro (`src/App.tsx`). Teste em emulador de terminal: `tests/tui-resize.test.ts`.

### Changed
- Documentação reorganizada: novo `AGENTS.md` curto (carregado automaticamente por agentes; `CLAUDE.md` aponta para ele), `LLMS.md` virou `docs/ARCHITECTURE.md` (enxuto, sem repetir README e schemas), `WINDOWS_BACKPORT.md` removido (já aplicado e desatualizado), `CONTRIBUTING.md` e `SECURITY.md` em pt-BR.
- `SECURITY.md`: corrigida a descrição da proteção de caminhos em buscas recursivas e o canal de reporte; adicionado o risco de *prompt injection* via `SILICONFLOWER.md`/`AGENTS.md` de repositórios de terceiros.

## [0.2.8] - 2026-10-29

### Added
- Projeto ativado por `SILICONFLOWER.md` ou `AGENTS.md` (na pasta ou acima, nunca em `~`); o conteúdo vira instruções no prompt. Sem o arquivo, a memória de projeto fica desligada (`src/project.ts`).
- Comando `siliconflower init` (`--agents` para `AGENTS.md`); `show` e a barra de status mostram o projeto ativo.

### Changed
- Memória sob demanda: o prompt leva só o índice (nome e descrição); o conteúdo é lido com `recall_memory` (`src/services/memory.ts`).
- Workspace identificado pela raiz do projeto: subpastas compartilham memórias, artefatos e hooks (`src/fs-util.ts`).
- Contador de tokens inclui instruções do projeto e índice de memórias.

### Fixed
- Descrições de memória com quebra de linha quebravam o frontmatter; linhas `name:` no corpo eram lidas como metadado.
- Ler memórias criava diretórios; um arquivo ilegível escondia o diretório inteiro.

## [0.2.7] - 2026-10-29

### Fixed
- `Ctrl+C` fechava o app em vez de cancelar a resposta (Ink `exitOnCtrlC`).
- Subagentes eram mortos após 60 s pelo timeout genérico de ferramentas.
- `web_fetch` cortava o HTML bruto em `maxChars` e devolvia só o menu da página.
- Saída do PowerShell com acentos corrompidos (CP850); comandos carregavam o `$PROFILE` (novo `src/shell.ts`).
- Kill de comandos deixava processos filhos órfãos.
- Histórico não era compactado dentro do loop de ferramentas.
- Modelo esquecia as chamadas de ferramenta entre mensagens.
- `api.openai.com` rejeitava `max_tokens` em modelos de raciocínio.
- SSRF via IPv6 com IPv4 embutido (`[::ffff:127.0.0.1]`).
- `siliconflower config` gravava variáveis de ambiente no `config.json`.
- `--model` não valia para subagentes; ferramentas de subagentes não eram canceláveis.
- MCP: sem cancelamento, `isError` ignorado, falhas escritas no stderr por cima da TUI.
- Hook `onCommand` nunca lia `hooks.json`.
- `edit_file`/`apply_patch` misturavam LF em arquivos CRLF.
- Artefatos: aspas quebravam metadados; trocar o tipo deixava dois arquivos.
- `htmlToMarkdown` decodificava entidades duas vezes e corrompia emojis.
- `grep_content` ignorava pastas `bin/`; `repo_map` gastava vagas com extensões sem extrator.
- `ask_question` não perguntava ao usuário; agora pausa e espera a resposta na TUI.
- `enter_worktree` dizia "ativar" sem mudar o cwd; `.worktrees/` aparecia no `git status`.
- `attrib.exe` rodava a cada mensagem.
- Falha ao carregar memórias travava a TUI.
- Limite de 50 passos terminava em silêncio.
- `run_task`, `save_memory` e `create_artifact` mascaravam erros; `search_files` truncava sem avisar.
- Valores inválidos de `--reasoning`/`--mode` eram ignorados.
- `install.ps1` sem BOM mostrava acentos corrompidos no PowerShell 5.1.
- (de 0.2.6) Spam de log por delta de `tool_call`; `read_skill` indisponível em subagentes; tipagem de `stdout`/`stderr`.

## [0.2.6-nix] - 2026-10-25

### Added
- **Suporte a Linux/Unix (`src/platform.ts` e adaptadores):** O Siliconflower agora roda em Windows, Linux e macOS/Unix. Shell padrão: PowerShell no Windows; `$SHELL` (ou `/bin/bash`) em Unix. `execute_command`, hooks e background tasks usam a plataforma atual. Skills embutidas incluem `unix-backup.md` e `unix-system.md` (as skills `windows-*` só são sincronizadas no Windows).
- **Build e instalação multiplataforma (`build.ts`, `scripts/install.sh`, `scripts/install-bin.js`):** `bun run build` gera `dist/siliconflower` no Linux/macOS ou `dist/siliconflower.exe` no Windows conforme a plataforma. `npm run install:bin` roteia para `scripts/install.sh` (`~/.local/bin`) em Unix e `scripts/install.ps1` no Windows. `package.json` aceita `win32`, `darwin` e `linux`.

### Changed
- **Persona e prompts de modo (`src/modes.ts`):** Identificam o SO e o shell ativos em vez de assumir Windows/PowerShell. O modo `sistema` foca em systemd/pacotes/shell em Unix e mantém PowerShell/registro no Windows.
- **Testes e documentação:** Suíte de testes cross-platform; `README.md`, `LLMS.md` e `SECURITY.md` descrevem Windows, Linux e macOS/Unix.

## [0.2.6] - 2026-10-17

### Added
- **Controle de pensamento Xiaomi MiMo:** Endpoints oficiais `xiaomimimo.com` agora oferecem o pensamento como opção ligado/desligado no assistente e em `Ctrl+E`. As requisições enviam `thinking.type` e preservam `reasoning_content` na continuação de chamadas de ferramentas; os demais endpoints compatíveis com OpenAI mantêm os níveis de `reasoning_effort`.

## [0.2.5] - 2026-08-23

### Removed
- **Anthropic API Support (`src/llm.ts`, `src/config.ts`, `src/types.ts`, `src/wizard.ts`, `src/index.tsx`, `build.ts`):** Dropped the Anthropic provider branch entirely, along with the `@anthropic-ai/sdk` dependency, the `anthropic` preset, the `--provider` CLI flag and the wizard provider prompt. `src/llm.ts` now carries a single OpenAI-compatible streaming adapter.
- **`provider` Config Field (`src/types.ts`, `src/config.ts`, `src/wizard.ts`):** With a single supported API variant the field carried no information and was removed from `AppConfig`. A legacy `"provider"` key in `config.json` is ignored on load and dropped on the next save; `presets()` collapsed into `defaultPreset()`. Users previously on Anthropic must repoint `baseURL`/`model` at an OpenAI-compatible endpoint.

### Added
- **Terminal Viewport & Native Mouse Scroll (`src/terminal.ts`, `src/App.tsx`, `src/index.tsx`):** Added robust terminal viewport clearing (`\x1b[2J\x1b[3J\x1b[H`) and cursor lifecycle management in the primary buffer, matching Claude Code. Starts with a clean screen without initial prompt residue while preserving full native mouse-wheel scrollback throughout the session.

### Fixed
- **Web Fetch SSRF False Positives (`src/services/web.ts`):** Corrected `isPrivateAddress` range check that previously classified all `192.0.x.x` public IPs (e.g. Automattic/WordPress VIP CDN used by TechCrunch, MIT Tech Review) as private. Added exact RFC 6890 / RFC 5737 matching for `192.0.0.0/24` and `192.0.2.0/24` while allowing legitimate public IPs.
- **Web Search Parser & Anti-Bot Protection (`src/services/web.ts`, `src/tools.ts`):** Updated DuckDuckGo HTML parser to support arbitrary attribute ordering (e.g. `rel="nofollow" class="result__a"`), added fallback regex scanning for `uddg=` redirect links, HTTP 202 anti-bot challenge handling, and context cancellation support (`ctx.signal`).
- **Web Fetch HTML to Markdown Formatting (`src/services/web.ts`):** Upgraded `htmlToMarkdown` with cleaner tag stripping (`<noscript>`, `<svg>`, `<canvas>`, `<iframe>`), code blocks formatting (`<pre><code>`), blockquotes (`>`), bold/italics, and comprehensive HTML entity decoding.
- **MCP Command Binary Resolution (`src/mcp.ts`):** Added automatic command binary resolution for Bun on Windows, allowing `bunx` to seamlessly execute MCP packages even when configurations specify `npx`.
- **Context Compaction Protocol Safety (`src/context.ts`):** `compressHistory` could drop only the `assistant` half of a tool-call turn while discarding the oldest messages, leaving an orphan `tool` message at the front of the history and causing HTTP 400 errors from the OpenAI/Anthropic APIs on long tool-heavy sessions. Turns are now discarded as a whole unit.
- **Raw History Truncation Bypassing Compaction (`src/App.tsx`):** The TUI was slicing the last 60 messages before handing history to `streamChat`, silently discarding everything older regardless of token budget and defeating the token-aware compaction in `compressHistory`. The full history is now passed through.
- **`grep_content` Path-Based Include Filters (`src/grep.ts`):** The `include` glob only matched against a bare filename, so patterns with a path segment (e.g. `src/**/*.tsx`) never matched anything. Now reuses the real glob-to-regex engine from `src/glob-util.ts` (also exported for reuse) against the path relative to `basePath`.
- **MCP Connection Leaks and Hangs (`src/mcp.ts`):** A failed MCP server handshake left its child process running (the transport was never closed), and there was no connection timeout, so a hung MCP server blocked app startup indefinitely. Added a 20s connect timeout and transport cleanup on failure.
- **Permanent Logging Disable on Transient I/O Error (`src/logger.ts`):** A single failed attempt to create the log directory (e.g. a transient permission/AV lock) marked logging as "ensured" forever, silently disabling all future logs, including errors. Failures are no longer cached, so logging retries on the next call.
- **Silent Hooks Config Fallback (`src/core/hooks.ts`):** Invalid JSON in a `hooks.json` file was indistinguishable from a missing file and silently fell back to the next source (legacy/global) without any warning. Now logs a warning when a hooks file exists but fails to parse.
- **Overzealous Ctrl-Key Input Suppression (`src/App.tsx`):** The 250ms window that strips a trailing `o`/`e`/`c` character after `Ctrl+O`/`Ctrl+E` (to swallow terminal-echoed shortcut chars) was being armed by *any* Ctrl combination (e.g. `Ctrl+C`, `Ctrl+V`), which could silently eat a legitimately typed character right after an unrelated shortcut.
- **Unhandled CLI Startup Rejection (`src/index.tsx`):** `program.parseAsync()` had no `.catch()`, so a failure during config load/setup produced an unhandled promise rejection instead of a clean error message and exit code.
- **Unbounded Background Task / Subagent Session Growth (`src/services/background-tasks.ts`, `src/services/subagent.ts`):** Finished background tasks and subagent sessions (including full message history) were never removed from their in-memory maps, growing without bound over long-lived sessions. Both are now capped, pruning the oldest finished/least-recent entries.
- **Silent Wrong-Block Edits in Fuzzy Whitespace Matching (`src/services/smart-edit.ts`):** `edit_file`'s fuzzy whitespace-matching strategy applied the edit to the first matching block without checking for other identical blocks elsewhere in the file. It now detects multiple matches and reports an ambiguity error unless `replaceAll: true` is set (which now correctly replaces every occurrence instead of only the first).

### Removed
- **Dead Compatibility Shim (`src/task.ts`):** Removed the unused `runSubagentTask` re-export wrapper around `src/services/subagent.ts` — nothing in the codebase imported it anymore. Updated `LLMS.md` accordingly.

## [0.2.4] - 2026-08-18

### Fixed
- **Anthropic Streaming Tools:** Reconstructed tool arguments from `input_json_delta` events instead of invoking tools with the empty object from `content_block_start`.
- **Plan Mode Isolation:** Replaced the partial mutation blocklist with a closed read-only allowlist; MCP tools, hooks, subagents, persistence and background cancellation can no longer bypass plan mode.
- **Cancellation and Timeouts:** Propagated abort signals to LLM requests, commands, web fetches and subagents. Cancellable operations are actively aborted; filesystem operations without cancellation support are awaited instead of falsely reporting a timeout while continuing silently.
- **Background Task State:** Killing a subagent now aborts its execution, and late completion/error callbacks can no longer overwrite the `killed` state. Subagent failures are reported as failures.
- **MCP Tool Collisions:** Added deterministic qualified MCP tool names and preserved original transport names for dispatch.
- **Context Bounds:** Large single-line outputs and recent oversized messages are bounded by character/token budgets.
- **Scoped Deletion:** Memory and artifact deletion now defaults to project scope and requires explicit `global` or `all` scope for broader removal.
- **Hooks:** Standardized hook execution on PowerShell, added file path context, edit coverage and session lifecycle hooks.
- **Web Fetch:** Applied timeout to response bodies, bounded streaming reads, validated redirects and blocked private/reserved network targets.
- **Worktrees and Launcher:** Removed shell interpolation from Git/attrib operations and from the Node launcher; `tsx` is now a runtime dependency for the documented Node fallback.
- **Hermetic Tests:** Redirected persistent data to a temporary directory during tests and added regression coverage for LLM streaming, plan policy, MCP names, scopes, cancellation, SSRF and context truncation.

### Added
- **Centralized Workspace Data Storage (`~/.siliconflower/workspaces/<workspace-id>/`):** Replaced in-tree `.siliconflower` folder creation inside user project directories with deterministic, centralized workspace data storage located in `~/.siliconflower/workspaces/<workspace-id>/` (mirroring Antigravity and modern AI harness conventions). Project workspaces now remain 100% clean and free of visible config/cache directories.
- **Workspace ID Computation (`src/fs-util.ts`):** Added `getWorkspaceId(cwd)` and `getWorkspaceDataDir(cwd)` helpers generating consistent, filesystem-safe slugs with short SHA-256 hashes.
- **Backward-Compatible Legacy Data Discovery:** Maintained full backward compatibility across `recallMemories`, `forgetMemory`, `listArtifacts`, `readArtifact`, `deleteArtifact`, and `loadHooksConfig` so existing repositories with legacy `.siliconflower` folders continue to resolve seamlessly.

### Changed
- **Windows-Only Focus & Simplification:** Removed Linux and macOS compatibility layers, platform branching, and bash fallback logic across `src/modes.ts`, `src/tools.ts`, `src/fs-util.ts`, `src/services/background-tasks.ts`, and test suites. Siliconflower is now centered exclusively on Windows (PowerShell/Bun/Node).
- **Documentation & CLI:** Updated `README.md`, `LLMS.md`, and `siliconflower show` command to display the active workspace ID and data directory path.

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

[0.6.0]: https://github.com/1155dosilicon/siliconflower-nix/commits/main
[0.5.0]: https://github.com/1155dosilicon/siliconflower-nix/commit/aa0a483
[0.2.9]: https://github.com/1155dosilicon/siliconflower-nix/commits/main
[0.2.6-nix]: https://github.com/1155dosilicon/siliconflower-nix/commit/84a2e90
[0.2.6]: https://github.com/1155dosilicon/siliconflower/compare/0.2.5...siliconflower-0.2.6
[0.2.5]: https://github.com/1155dosilicon/siliconflower/compare/0.2.4...0.2.5
[0.2.4]: https://github.com/1155dosilicon/siliconflower/compare/0.2.3...0.2.4
[0.2.3]: https://github.com/1155dosilicon/siliconflower/compare/0.2.2...0.2.3
[0.2.2]: https://github.com/1155dosilicon/siliconflower/compare/0.2.1...0.2.2
[0.2.1]: https://github.com/1155dosilicon/siliconflower/compare/0.1.0...0.2.1
[0.1.0]: https://github.com/1155dosilicon/siliconflower/releases/tag/0.1.0
