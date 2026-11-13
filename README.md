# 🌸 SILICONFLOWER

![Version](https://img.shields.io/badge/version-0.12.0-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-0078D6.svg)
![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3-black.svg)
![Node](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)

Agente de IA para desenvolvimento de software em **Windows e Linux** (x86_64), como **app de desktop** ou **interface no navegador**. Tem **30 ferramentas nativas**, subagentes, tarefas em background, memória por projeto, Git worktrees, RepoMap, busca web e **MCP**, e funciona com **SiliconFlow, OpenRouter, OpenAI** e qualquer API compatível com a da OpenAI.

---

## ✨ Recursos

- 🪟 **App de desktop** (Electron): uma janela por projeto, configuração sem terminal e conversas salvas que você retoma depois. `siliconflower gui` abre a mesma interface no navegador.
- 🤖 **Subagentes e tarefas em background**: papéis `general`, `research`, `verification`, `plan`, `coder` ou `custom`; `research` e `plan` só leem.
- 🧠 **Projetos e memória**: uma pasta com `SILICONFLOWER.md` ou `AGENTS.md` vira projeto; o arquivo traz suas instruções e liga a memória do projeto, guardada fora do repositório.
- ⚡ **Modos e raciocínio**: modos `programação`, `sistema` e `plano` (somente leitura) e nível de raciocínio, escolhidos na interface.
- 🌳 **Git worktrees** em `<repo>/.worktrees/<branch>`, sem mexer na sua área de trabalho.
- 🗺️ **RepoMap**: mapa de símbolos (TS, JS, Python, Go, Rust) com poucos tokens.
- 🧩 **MCP, hooks e skills**: servidores MCP por stdio ou HTTP, comandos disparados por eventos e instruções em Markdown carregadas sob demanda.
- 📎 **Na interface**: anexe imagens (botão 📎, colar ou arrastar; áudio e vídeo na API Xiaomi MiMo), edite e reenvie a última mensagem, busque e renomeie conversas, acompanhe ou encerre o que roda em background e confira a instalação pelo botão 🩺 (**Diagnóstico**), sem abrir um terminal.
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
| Conferir se está tudo funcionando | botão **🩺** no canto superior direito ([Diagnóstico](#-diagnóstico)) |

Enquanto o agente trabalha, aparece **Pensando...** (o texto do raciocínio não é mostrado) e cada ferramenta ganha um cartão com argumentos e resultado. As conversas ficam salvas por projeto; uma resposta só é salva ao terminar ou ser interrompida.

**Modos:** `programação` (que a interface mostra como **ultracódigo**, só no nome) e `sistema` só mudam o foco do prompt (código ou administração do sistema) e não limitam nada. `plano` só deixa ler, buscar e perguntar: edições, comandos, subagentes e MCP ficam bloqueados.

### App de desktop

Cada projeto abre em sua própria janela, com seu agente: `Ctrl+O` abre outra pasta, `Ctrl+Shift+O` mostra os recentes e **Arquivo > Configurações** (`Ctrl+,`) muda provedor, chave e modelo (**Testar conexão** confere antes de salvar; a chave nunca volta para a tela). Fechar a janela encerra o agente e os comandos em background daquele projeto. Reabrir começa com uma conversa vazia; a anterior está na lateral.

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
- **Contexto:** `contextTokens` é quanto cada pedido pode usar (prompt, ferramentas e histórico); acima disso o histórico antigo é compactado. O padrão é 90 mil; aumente em modelos com janela maior (de 8 mil a 2 milhões).
- **MCP:** um servidor sobe por stdio (`command`) ou é acessado por HTTP (`url`, com `headers` opcionais). As ferramentas aparecem para o modelo como `mcp_<servidor>_<ferramenta>_<hash>`. Um servidor que caiu é reconectado na chamada seguinte.
- **Hooks:** `preTool`, `postTool`, `onEdit`, `onCommand`, `onSessionStart` e `onSessionEnd`, no `config.json` ou num `hooks.json` em `workspaces/<workspace-id>/` ou na raiz de `~/.siliconflower/`. Cada evento vem do `config.json` quando está lá e, se não, do `hooks.json`; um `hooks.json` dentro do repositório não roda. Quando cada um roda e as variáveis que recebe: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#hooks-corehooksts).
- **Skills:** arquivos Markdown em `~/.siliconflower/skills/`, lidos pelo agente com `read_skill` quando relevantes.
- **Projeto:** `siliconflower init` cria `SILICONFLOWER.md` na pasta atual. Sem esse arquivo (ou `AGENTS.md`) na pasta ou acima dela, a memória de projeto fica desligada.
- **Xiaomi MiMo:** com `baseURL` em `xiaomimimo.com`, o raciocínio vira desligado/ligado (`none`/`high`), enviado como `thinking.type`.

### Comandos

```bash
siliconflower gui            # interface no navegador (--port <n>, --no-open, --resume-latest)
siliconflower config         # assistente de configuração
siliconflower show           # configuração (chave mascarada), projeto ativo e pasta de dados
siliconflower doctor         # o diagnóstico do botão 🩺, para quando a interface não abre (--fix, --offline)
siliconflower init           # cria SILICONFLOWER.md aqui (--agents cria AGENTS.md)
siliconflower ensure         # cria a configuração se não existir
siliconflower skills list    # lista as skills; `skills sync` (ou `sync`) copia os exemplos
siliconflower logs -n 100 --level error --search timeout   # --clear apaga o log
```

Opções globais, só para aquela execução: `-m/--model`, `-r/--reasoning`, `--mode`, `--base-url`, `--api-key`. A partir do código-fonte, use `bun run start -- <comando>`.

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

Comece pelo botão **🩺** no canto superior direito da interface (app ou navegador). Ele confere a configuração, faz um pedido mínimo ao provedor (chave, endereço e modelo), mostra como estão os servidores MCP, roda um comando no shell e olha a pasta de dados, o git, os hooks, as conversas salvas e os erros recentes do log. Cada item aparece como certo (✓), aviso (!) ou problema (✕), e os dois últimos trazem o jeito de resolver.

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
- **Resposta ou arquivo cortado:** cada resposta tem até 32768 tokens de saída (16384 se o provedor recusar). O modelo é avisado e pode escrever em partes; num texto cortado, envie `continue`.
- **O agente não para de chamar ferramentas:** não há limite de passos por mensagem, para tarefas longas irem até o fim. Se o modelo ficar repetindo a mesma chamada, use `Esc` ou **Parar**: o que as ferramentas já fizeram fica no histórico.
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
