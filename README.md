# 🌸 SILICONFLOWER

![Version](https://img.shields.io/badge/version-0.17.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-0078D6.svg)
![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3-black.svg)
![Node](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)

Agente de IA para desenvolvimento de software em **Windows e Linux** (x86_64), como **app de desktop** ou **interface no navegador**. Tem **30 ferramentas nativas**, subagentes, tarefas em background, memória por projeto, Git worktrees, RepoMap, busca web e **MCP**, e funciona com **DeepSeek, SiliconFlow, OpenRouter, OpenAI** e qualquer API compatível com a da OpenAI.

---

## ✨ Recursos

- 🤝 **Conversa com o seu Claude Code**: `siliconflower mcp` vira um servidor MCP, e o Claude Code (ou Claude Desktop, Cursor...) passa a delegar tarefas ao siliconflower, pedir uma segunda opinião de outro modelo ou trabalhar em paralelo com ele. Uma linha liga tudo: `claude mcp add --scope user siliconflower -- siliconflower mcp`. [Como funciona](#para-o-claude-code-e-outros-clientes-mcp-siliconflower-mcp).
- ⌨️ **Direto no terminal**: `siliconflower run "corrija o teste"` roda o agente sem abrir janela, com saída em JSON para scripts e conversas que continuam no app.
- 🪟 **App de desktop** (Electron): uma janela por projeto, configuração sem terminal e conversas salvas que você retoma depois. `siliconflower gui` abre a mesma interface no navegador.
- 🤖 **Subagentes e tarefas em background**: papéis `general`, `research`, `verification`, `plan`, `coder` ou `custom`; `research` e `plan` só leem.
- 🧠 **Projetos e memória**: uma pasta com `SILICONFLOWER.md` ou `AGENTS.md` vira projeto; o arquivo traz suas instruções e liga a memória do projeto, guardada fora do repositório.
- ⚡ **Modos e raciocínio**: modos `programação`, `sistema` e `plano` (somente leitura) e nível de raciocínio, escolhidos na interface.
- 🌳 **Git worktrees** em `<repo>/.worktrees/<branch>`, sem mexer na sua área de trabalho.
- 🗺️ **RepoMap**: mapa de símbolos (TS, JS, Python, Go, Rust) com poucos tokens.
- 🧩 **MCP, hooks e skills**: servidores MCP por stdio ou HTTP, comandos disparados por eventos e instruções em Markdown carregadas sob demanda.
- 📎 **Na interface**: anexe imagens (botão 📎, colar ou arrastar; áudio e vídeo na API Xiaomi MiMo), edite e reenvie a última mensagem, busque e renomeie conversas, acompanhe ou encerre o que roda em background e confira a instalação pelo **🩺 Diagnóstico** (na tela inicial do app; no navegador, no topo da página), sem abrir um terminal.
- 📦 **Binário único** feito com o Bun: não precisa de Node.js instalado.

---

## 🚀 Instalação

O mesmo código roda em todos os sistemas; o que muda entre eles está em [docs/PLATAFORMAS.md](docs/PLATAFORMAS.md).

### App de desktop (recomendado)

Baixe na [última versão](https://github.com/1155dosilicon/siliconflower/releases/latest):

- **Windows 10 ou 11 (x64):** `Siliconflower-Setup-<versão>.exe`. Não pede administrador. O instalador não é assinado: se o SmartScreen avisar, clique em **Mais informações** > **Executar assim mesmo**.
- **Linux (x86_64):** o `.deb` ou o AppImage com `install-appimage.sh` (veja [os três jeitos](#app-de-desktop)).

Na primeira vez, o app pede provedor, chave e modelo; depois, escolha a pasta do projeto. O app já traz o agente: não precisa de Bun nem Node.

### Agente avulso (sem o app)

Baixe `siliconflower-portatil-windows-x64.exe` (Windows) ou `siliconflower-portatil-linux-x64` (Linux), renomeie para `siliconflower.exe` ou `siliconflower` e coloque numa pasta do `PATH` (`~/.local/bin` no Linux). Dentro da pasta do projeto, `siliconflower gui` abre a interface no navegador e, na primeira vez, o assistente de configuração no terminal. Sem argumentos, o comando só mostra a ajuda.

### A partir do código-fonte

Requer [Bun >= 1.3](https://bun.sh). Sem Bun, os subcomandos que não são `gui` rodam com Node.js >= 20 após `npm install` (`node bin/siliconflower.js`).

```bash
git clone https://github.com/1155dosilicon/siliconflower.git
cd siliconflower
bun install
bun run start -- gui     # abre a interface (assistente de configuração na 1ª vez)

bun run build            # gera dist/siliconflower (dist/siliconflower.exe no Windows)
npm run install:bin      # Linux: ~/.local/bin; Windows: %LOCALAPPDATA%\Programs\siliconflower + PATH
```

Abra um novo terminal depois do `install:bin`. Para gerar o app de desktop, veja [CONTRIBUTING.md](CONTRIBUTING.md).

### Requisitos no Linux

| Item | App de desktop | Agente avulso |
| :--- | :--- | :--- |
| Arquitetura | x86_64 (sem ARM nem 32 bits) | x86_64 (sem ARM nem 32 bits) |
| CPU | qualquer x86_64 | SSE4.2 (Intel 2008 / AMD 2011 em diante); não exige AVX2 |
| glibc | **2.25+** | 2.17+ |
| Kernel | qualquer atual | 3.10+ (5.6+ recomendado pelo Bun) |
| Distribuição (estimativa) | Ubuntu 18.04, Debian 10, elementary OS 5, Mint 19, Fedora 28 ou mais novas | Ubuntu 14.04, Debian 8, RHEL/CentOS 7 ou mais novas |
| Bibliotecas | GTK 3, NSS, libnotify, libsecret, libgbm, ALSA, libXss, libXtst, AT-SPI, `xdg-utils` (o `.deb` instala) | só a glibc |
| Opcionais | FUSE 2 (`libfuse2t64`), só para abrir o AppImage direto | `git` (worktrees); `xdg-open`, para o `gui` abrir o navegador |

Testado de verdade no elementary OS 8 e no Ubuntu 24.04. No Ubuntu 14.04 e 16.04 o app não abre (`GLIBC_2.25 not found`); o agente avulso deve funcionar, sem teste. No Windows, o agente usa o Windows PowerShell 5.1, que já vem no sistema.

---

## 🖥️ Uso

### Na interface (app ou navegador)

| Ação | Como |
| :--- | :--- |
| Enviar / quebrar linha | `Enter` / `Shift+Enter` |
| Cancelar a resposta ou a pergunta em andamento | `Esc` ou **Parar** |
| Modo de trabalho | seletor **Modo**: `ultracódigo` (o modo `programação`), `sistema` ou `plano` |
| Raciocínio | seletor **Pensamento**: `none`, `low`, `medium`, `high`, `max`, `ultra` (os dois últimos só existem em alguns provedores; se o seu recusar, o pedido segue com `high`) |
| Conversas | lateral: **+ Nova conversa**, clique para retomar, **✎** para renomear, **×** para apagar; o campo de busca aparece com duas ou mais |
| Editar a última mensagem | botão **Editar** ao passar o mouse sobre ela |
| Conferir se está tudo funcionando | no app, **🩺 Diagnóstico** na tela inicial, antes de abrir uma pasta; no navegador, botão **🩺** no canto superior direito ([Diagnóstico](#-diagnóstico)) |

Enquanto o agente trabalha, aparece **Pensando...** (o texto do raciocínio não é mostrado) e cada ferramenta ganha um cartão com argumentos e resultado. As conversas ficam salvas por projeto; uma resposta só é salva ao terminar ou ser interrompida.

**Modos:** `programação` (que a interface mostra como **ultracódigo**, só no nome) e `sistema` só mudam o foco do prompt (código ou administração do sistema) e não limitam nada. `plano` só deixa ler, buscar e perguntar: edições, comandos, subagentes e MCP ficam bloqueados.

### App de desktop

Cada projeto abre em sua própria janela, com seu agente: `Ctrl+O` abre outra pasta, `Ctrl+Shift+O` mostra a tela inicial (os recentes e o **🩺 Diagnóstico**) e **Arquivo > Configurações** (`Ctrl+,`) muda provedor, chave e modelo (**Testar conexão** confere antes de salvar; a chave nunca volta para a tela). Fechar a janela encerra o agente e os comandos em background daquele projeto. Reabrir começa com uma conversa vazia; a anterior está na lateral.

No Linux, há três jeitos de instalar:

| Jeito | Para quem | Onde fica / como remover |
| :--- | :--- | :--- |
| `sudo apt install ./Siliconflower-<versão>-amd64.deb` | Debian, Ubuntu, elementary e derivados | `/opt/Siliconflower`; `sudo apt remove siliconflower-desktop` |
| `bash install-appimage.sh Siliconflower-<versão>-x86_64.AppImage` | só o seu usuário, sem senha, qualquer distribuição | `~/.local/share/siliconflower-desktop`; rode de novo com `--uninstall` |
| AppImage direto (`chmod +x` e abrir) | testar sem instalar | precisa de FUSE 2 (`libfuse2t64`) |

O `.deb` e o script não precisam de FUSE, e o script também atualiza o app. Nenhum deles apaga sua configuração e suas conversas.

> ⚠️ **Não instale o pacote `fuse`** (`apt install fuse`). No Ubuntu 24.04, no elementary OS 8 e derivados, ele remove o `fuse3` e parte da área de trabalho (Flatpak, portais, arquivos). Se já instalou, `sudo apt install fuse3` e os pacotes removidos (veja `/var/log/apt/history.log`) desfazem o estrago.

**Variáveis de ambiente e PATH:** aberto pelo menu, o app não lê o `.bashrc`/`.zshrc`. O que só é definido ali (`SILICONFLOWER_API_KEY`, ou o `PATH` do nvm, usado por `npx` em MCP e hooks) não chega ao agente. Defina em `~/.profile` ou `~/.config/environment.d/` (Linux) ou nas variáveis de ambiente do usuário (Windows), ou use caminhos completos no `config.json`.

### No navegador (`siliconflower gui`)

Rode **dentro da pasta do projeto**: ela é a pasta de trabalho do agente. A página abre no navegador padrão; com `--no-open`, só imprime a URL. Para vários projetos, rode um `gui` em cada pasta. Fechar a aba encerra o agente em cerca de 15 s (`Ctrl+C` no terminal encerra na hora). A URL traz um token de acesso: não a compartilhe.

---

## ⚙️ Configuração

Tudo fica em `~/.siliconflower/` (ou em `SILICONFLOWER_DATA_DIR`, se definida):

| O quê | Onde |
| :--- | :--- |
| Configuração | `config.json` |
| Skills | `skills/` |
| Memórias e artefatos globais | `memory/`, `artifacts/` |
| Dados do projeto (memórias, artefatos, hooks, conversas em texto puro, arquivos anexados em `uploads/`) | `workspaces/<workspace-id>/` |
| Logs e saídas longas truncadas (apagadas depois de 7 dias) | `logs/`, `outputs/` |

```json
{
  "baseURL": "https://api.siliconflow.com/v1",
  "apiKey": "sk-...",
  "model": "deepseek-ai/DeepSeek-V4-Pro",
  "reasoning": "high",
  "mode": "programação",
  "system": "prompt personalizado (opcional)",
  "contextTokens": 90000,
  "askAfterSteps": 150,
  "askAfterTokens": 8000000,
  "askAfterMinutes": 60,
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/Workspace"],
      "env": { "EXEMPLO_API_KEY": "..." }
    },
    "remoto": {
      "url": "https://exemplo.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  },
  "hooks": {
    "onEdit": "bun x tsc --noEmit",
    "postTool": "git status --short"
  }
}
```

- **Variáveis de ambiente:** `SILICONFLOWER_API_KEY`, `SILICONFLOWER_BASE_URL` e `SILICONFLOWER_MODEL` substituem os campos do `config.json` sem serem gravadas nele.
- **Chaves longe do modelo:** a chave de API e as chaves de MCP aparecem como `***` em tudo que as ferramentas devolvem ao modelo, até num `cat` do `config.json`. O que isso cobre e o que não cobre está no [SECURITY.md](SECURITY.md).
- **Contexto:** `contextTokens` é quanto cada pedido pode usar (prompt, ferramentas e histórico); acima disso o histórico antigo é compactado. O padrão é 90 mil; aumente em modelos com janela maior (de 8 mil a 2 milhões). Em modelos DeepSeek o padrão já é 800 mil (a janela é de 1M), porque compactar a cada passo muda o começo do pedido e derruba o cache do provedor — e no DeepSeek o cache responde a maior parte da entrada. Os resultados que o modelo ainda não viu são os últimos a encolher: se não couberem inteiros, cada um mostra o começo e diz como ler o resto. O plano aberto (`todowrite`) entra na nota de compactação, então continua valendo depois de um histórico descartado. Se o provedor recusar o pedido por tamanho, o histórico é encolhido e o pedido repetido; `429` e `5xx` são repetidos com espera exponencial, respeitando o `Retry-After`.
- **Limites por resposta:** não há um teto fixo, mas três orçamentos por resposta: `askAfterSteps` (passos de ferramentas, padrão 150), `askAfterTokens` (custo de todos os pedidos ao modelo somados, padrão 8 milhões) e `askAfterMinutes` (padrão 60, conferido entre os passos). Quando um acaba, a interface pergunta se deve continuar, e o orçamento recomeça dali; `0` desliga cada um. Sem ninguém para perguntar (subagentes, `run` sem terminal, MCP), o modelo é avisado quando faltam 10% e, se chegar ao fim, a resposta termina com um resumo escrito sem ferramentas: o que foi feito, o que descobriu, o que falta e o próximo passo.
- **MCP:** um servidor sobe por stdio (`command`) ou é acessado por HTTP (`url`, com `headers` opcionais). As ferramentas aparecem para o modelo como `mcp_<servidor>_<ferramenta>_<hash>`; se ele esquecer o `_<hash>` e só uma ferramenta tiver aquele nome, ela é usada mesmo assim. Um servidor que caiu é reconectado na chamada seguinte.
- **Hooks:** `preTool`, `postTool`, `onEdit`, `onCommand`, `onSessionStart` e `onSessionEnd`, no `config.json` ou num `hooks.json` em `workspaces/<workspace-id>/` ou na raiz de `~/.siliconflower/`. Cada evento vem do `config.json` quando está lá e, se não, do `hooks.json`; um `hooks.json` dentro do repositório não roda. Quando cada um roda e as variáveis que recebe: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#hooks-corehooksts).
- **Skills:** arquivos Markdown em `~/.siliconflower/skills/`, lidos pelo agente com `read_skill` quando relevantes.
- **Projeto:** `siliconflower init` cria `SILICONFLOWER.md` na pasta atual. Sem esse arquivo (ou `AGENTS.md`) na pasta ou acima dela, a memória de projeto fica desligada.
- **Xiaomi MiMo:** com `baseURL` em `xiaomimimo.com`, o raciocínio vira desligado/ligado (`none`/`high`), enviado como `thinking.type`.
- **DeepSeek:** com `baseURL` em `api.deepseek.com`, o pedido segue as regras do modo de pensamento deles, que nenhum outro provedor tem:
  - cada mensagem `assistant` volta com seu `reasoning_content` (o campo vazio quando o pensamento foi descartado): com `tools` no pedido, é isso que mantém o raciocínio no contexto deles, em vez de o modelo ler tudo de novo;
  - `none` desliga o pensamento de verdade, com `thinking.type: "disabled"` (lá o pensamento vem ligado por padrão, em `high`);
  - todos os níveis de **Pensamento** valem (`low` a `ultra`), e o limite de saída sobe para 262144 tokens.
  Num gateway que hospeda modelos DeepSeek (SiliconFlow, modo compatível da Aliyun...), o modelo é reconhecido pelo nome: a janela de contexto maior vale e, se o provedor recusar `thinking`, o pedido é repetido sem esse campo em vez de falhar.

### Comandos

```bash
siliconflower gui            # interface no navegador (--port <n>, --no-open, --resume-latest)
siliconflower run "pedido"   # manda uma mensagem e imprime a resposta, sem janela (veja abaixo)
siliconflower mcp            # servidor MCP: o Claude Code e outros clientes conversam com o agente (veja abaixo)
siliconflower config         # assistente de configuração
siliconflower show           # configuração (chave mascarada), projeto ativo e pasta de dados
siliconflower doctor         # o diagnóstico do botão 🩺, para quando a interface não abre (--fix, --offline)
siliconflower init           # cria SILICONFLOWER.md aqui (--agents cria AGENTS.md)
siliconflower ensure         # cria a configuração se não existir
siliconflower skills list    # lista as skills; `skills sync` (ou `sync`) copia os exemplos
siliconflower logs -n 100 --level error --search timeout   # --clear apaga o log
```

Opções globais, só para aquela execução: `-m/--model`, `-r/--reasoning`, `--mode`, `--base-url`, `--api-key`. A partir do código-fonte, use `bun run start -- <comando>`.

### No terminal, sem janela (`siliconflower run`)

Roda uma resposta completa do agente, com as mesmas ferramentas, skills, MCP e memória do app, e sai. A conversa é salva no projeto, então aparece no app e pode ser continuada.

```bash
siliconflower run "corrija o teste que está falhando"
siliconflower run -c "agora rode os testes de novo"        # continua a conversa mais recente
siliconflower run --resume <id> "e o outro arquivo?"        # continua uma conversa específica
siliconflower run -a tela.png "o que está errado nesta tela?"   # anexos (até 4)
cat erro.log | siliconflower run --stdin "explique este erro"   # junta o que veio pelo pipe
echo "resuma o README" | siliconflower run                      # sem texto, lê a mensagem do pipe
siliconflower run --json -q "quantos testes existem?"           # uma linha de JSON, para scripts
```

- A resposta vai para a saída padrão (aparecendo aos poucos num terminal, inteira no fim quando redirecionada); as ferramentas usadas e os erros vão para a saída de erro, que `-q` silencia.
- `--json` imprime no fim `{ok, cancelled, text, error, conversationId, tools, tokens, turnTokens, turnCost, cachedTokens, stopped}`: `tokens` é o tamanho do último pedido, `turnTokens` o total bruto da resposta e `turnCost` o mesmo turno já ponderado como em `askAfterTokens`, com `cachedTokens` mostrando quanto disso o provedor serviu do cache, e `stopped` (`reason`: `steps`, `tokens`, `time` ou `loop`) aparece quando ela parou num limite, com `text` sendo o resumo.
- `--max-steps`, `--max-tokens` e `--max-minutes` trocam os limites só nesta execução (`0` = sem limite).
- Num terminal, as perguntas do agente (`ask_question` e o "continuar?" dos limites) aparecem para você responder; um número escolhe a opção. Sem terminal (script, pipe), o agente põe a pergunta na resposta final e, num limite, a resposta termina com o resumo, como nos subagentes.
- Ctrl+C cancela a resposta; um segundo Ctrl+C sai na hora. Código de saída: `0` ok, `1` erro, `130` cancelado.
- O agente tem o mesmo poder que no app: roda comandos e altera arquivos na pasta atual sem pedir confirmação. Use `--mode plano` para só analisar.

### Para o Claude Code e outros clientes MCP (`siliconflower mcp`)

`siliconflower mcp` transforma o agente num servidor MCP (stdio). Com ele, o Claude Code (ou o Claude Desktop, o Cursor e qualquer cliente MCP) pode delegar tarefas ao siliconflower, pedir uma segunda opinião com outro modelo ou pôr os dois para trabalhar em paralelo.

No Claude Code, uma vez só, para todos os projetos:

```bash
claude mcp add --scope user siliconflower -- siliconflower mcp
```

Em clientes configurados por JSON (Claude Desktop, Cursor...):

```json
{
  "mcpServers": {
    "siliconflower": { "command": "siliconflower", "args": ["mcp"] }
  }
}
```

Ferramentas oferecidas ao cliente:

| Ferramenta | O que faz |
| :--- | :--- |
| `ask` | Manda uma tarefa ou pergunta e espera a resposta final. Argumentos: `message`; opcionais `cwd` (pasta do projeto, padrão: a pasta onde o cliente iniciou o servidor), `conversation_id` ou `continue` (continuar uma conversa), `attachments` (até 4 imagens ou PDFs), `mode`, `model`, `reasoning` e os limites `max_steps`, `max_tokens` e `max_minutes`. A resposta termina com o `conversation_id`, para continuar depois; se parou num limite ou num loop, diz o motivo (`stopped=...`) e que a resposta é um resumo parcial. |
| `list_conversations` | Lista as conversas salvas de um projeto, com o id de cada uma. |
| `read_conversation` | Mostra as últimas mensagens de uma conversa salva. |

- Cada `ask` roda um `siliconflower run` próprio dentro de `cwd`, com a configuração, as skills, os servidores MCP e a memória daquele projeto. As conversas são as mesmas do app: o que o Claude pediu aparece lá, e você pode continuar dali.
- Enquanto trabalha, cada ferramenta que o agente usa chega ao cliente como notificação de progresso.
- Cancelar a chamada no cliente (Esc no Claude Code) encerra o agente e tudo o que ele iniciou, inclusive comandos em segundo plano. O mesmo vale quando o cliente fecha.
- Não há ninguém para responder perguntas: o agente as põe na resposta final, e o cliente responde com um novo `ask` no mesmo `conversation_id`.
- As opções globais valem como padrão para todos os pedidos: `siliconflower mcp --mode plano` deixa o agente só analisar, a menos que o pedido escolha outro modo. A chave de `--api-key` chega a cada pedido pelo ambiente, não pela linha de comando.
- **Cuidado:** o cliente ganha o mesmo poder do agente na pasta que escolher, sem confirmação a cada comando. Veja [SECURITY.md](SECURITY.md#servidor-mcp-siliconflower-mcp).

---

## 🛠️ Ferramentas nativas

- 📁 **Arquivos:** `read_file`, `read_media` (imagem; áudio e vídeo só no Xiaomi MiMo), `write_file`, `edit_file`, `apply_patch`, `list_directory`, `create_directory`, `move_path`, `delete_path`, `file_info`.
- 🔍 **Busca:** `search_files`, `grep_content`, `repo_map`, `find_symbol`.
- 💻 **Execução:** `execute_command` (PowerShell no Windows, `$SHELL` em Linux/Unix, com os seus privilégios), `read_logs`, `ask_question`, `todowrite`, `read_skill`.
- 🤖 **Subagentes:** `run_task`, `send_subagent_message`, `manage_background_task`.
- 🧠 **Memória e worktrees:** `memory`, `enter_worktree`, `exit_worktree`, `list_worktrees`.
- 📄 **Artefatos e web:** `artifact`, `web_fetch`, `web_search`, `show_hooks`.

O agente não tem sandbox: leia o [SECURITY.md](SECURITY.md) antes de dar acesso ao seu computador. Detalhes de cada ferramenta: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## 🩺 Diagnóstico

No app, comece por **🩺 Diagnóstico**, no rodapé da tela inicial (a que lista os projetos recentes; `Ctrl+Shift+O` volta a ela). Ele funciona antes de abrir qualquer pasta e olha os hooks e as conversas de todos os projetos recentes de uma vez. No navegador, o botão **🩺** fica no canto superior direito da página e olha o projeto aberto. Nos dois, ele confere a configuração, faz um pedido mínimo ao provedor (chave, endereço e modelo), mostra como estão os servidores MCP, roda um comando no shell e olha a pasta de dados, o git, os hooks, as conversas salvas e os erros recentes do log. Cada item aparece como certo (✓), aviso (!) ou problema (✕), e os dois últimos trazem o jeito de resolver.

- **Corrigir o que der** aparece quando há algo que dá para resolver sozinho, sem apagar nada: renomeia conversas danificadas para `*.jsonl.danificada` (o aviso some da interface) e, no Linux, fecha a pasta de dados para outros usuários (`chmod 700`).
- **Verificar de novo** repete as verificações depois de você mexer em algo.
- Se o app nem abre o projeto, ele mostra as **Configurações**, onde **Testar conexão** faz o mesmo pedido ao provedor.

No terminal, `siliconflower doctor` faz as mesmas verificações (com `--fix` e `--offline`, que pula o provedor e os servidores MCP) e sai com código `1` quando algo impede o agente de funcionar.

O log fica em `~/.siliconflower/logs/siliconflower.log` (`siliconflower logs --level error`), também para o app.

- **HTTP 401:** confira a chave no `config.json` e em `SILICONFLOWER_API_KEY`.
- **`config.json` com erro:** a CLI e o app mostram o problema e não mexem no arquivo, para não perder hooks e servidores MCP. Corrija-o num editor (no app, depois clique em **Recarregar o arquivo**) ou apague-o para configurar do zero.
- **Hooks pararam depois de atualizar:** `<projeto>/.siliconflower/hooks.json` não roda mais, porque um repositório clonado poderia executar comandos assim. Mova o arquivo para `~/.siliconflower/workspaces/<workspace-id>/hooks.json`; `show_hooks` mostra o caminho exato.
- **HTTP 404:** confira o endereço base (normalmente termina em `/v1`) e o nome exato do modelo.
- **MCP não conecta:** a interface mostra o aviso e as ferramentas nativas continuam. `Executable not found in $PATH` no log quer dizer que o agente não acha o `command` (comum com `npx` do nvm no app aberto pelo menu): use o caminho completo, por exemplo `"command": "/home/você/.nvm/versions/node/<versão>/bin/node"` com o script do servidor em `args`, ou acerte o `PATH` (veja [App de desktop](#app-de-desktop)).
- **Alias ou função do shell não funciona em `execute_command` (Linux/Unix):** os comandos rodam com `$SHELL -c`, sem carregar `.bashrc`/`.zshrc`. Use caminhos completos.
- **Memória de outro projeto, ou nenhuma:** a memória de projeto só existe dentro de uma pasta com `SILICONFLOWER.md`/`AGENTS.md`. Confira com `siliconflower show` (linha `Project`).
- **Comando em background parou ao fechar:** fechar a janela ou a GUI encerra esses comandos. O que deve continuar precisa ser iniciado fora do agente (`systemd`, `tmux`, `nohup`).
- **Resposta ou arquivo cortado:** cada resposta tem até 32768 tokens de saída (16384 se o provedor recusar; em modelos DeepSeek, até 262144, o teto deles). O modelo é avisado e pode escrever em partes; num texto cortado, envie `continue`. Se o modelo gastar o limite inteiro pensando, sem escrever nada, o passo é repetido uma vez com o pensamento em `low`; se acontecer de novo, baixe o **Pensamento** ou divida o pedido.
- **A conexão caiu no meio da resposta (`ECONNRESET`):** o passo é repetido até duas vezes, e a interface mostra "a conexão caiu; repetindo". Nenhuma ferramenta roda em dobro, porque elas só executam depois que a resposta termina.
- **O agente não para de chamar ferramentas:** não há limite fixo de passos por mensagem, para tarefas longas irem até o fim. A mesma chamada com o mesmo resultado, ou o mesmo erro de uma ferramenta com argumentos diferentes, leva um aviso ao modelo na 3ª vez, uma instrução para mudar de abordagem na 5ª e para a resposta na 8ª (no app, pergunta antes); buscas seguidas sem resultado também são avisadas. Além disso, a cada 150 passos, 8 milhões de tokens de custo ou 60 minutos (`askAfterSteps`, `askAfterTokens`, `askAfterMinutes`) a interface pergunta se deve continuar. A qualquer momento, `Esc` ou **Parar** encerram a resposta: o que as ferramentas já fizeram fica no histórico.
- **AppImage pede FUSE / `libfuse.so.2`:** use o `.deb` ou o `install-appimage.sh`. **Nunca** `apt install fuse` (veja o aviso acima).
- **`siliconflower: command not found`:** abra um novo terminal e confira se `~/.local/bin` está no `PATH`. O app de desktop não instala esse comando.

---

## 📁 Estrutura

```text
src/          código do agente (mapa em AGENTS.md)
desktop/      app de desktop (Electron)
tests/        bun test
scripts/      instalação no PATH e do AppImage, release e checagens do CI
docs/         ARCHITECTURE.md (referência técnica) e PLATAFORMAS.md (Windows x Linux)
AGENTS.md     guia para quem mexe no código, pessoas ou agentes de IA
```

[CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md) · [CHANGELOG.md](CHANGELOG.md) · Licença **MIT** ([LICENSE](LICENSE)). A interface embute a fonte [JetBrains Mono](https://github.com/JetBrains/JetBrainsMono), sob a SIL Open Font License 1.1 ([src/gui/client/fonts/OFL.txt](src/gui/client/fonts/OFL.txt)).
