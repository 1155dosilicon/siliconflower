# O que muda entre Windows e Linux/Unix

O Siliconflower tem um único código para Windows, Linux e macOS/Unix. As funções são as mesmas em todos: TUI, GUI no navegador (`siliconflower gui`), app de desktop em Electron, conversas salvas, ferramentas, subagentes, MCP, hooks e skills.

Esta lista é tudo o que **deve** ser diferente entre os sistemas. Fora daqui, o comportamento é o mesmo. O código específico de SO passa por `src/platform.ts` (`isWindows()`), e os testes que dependem dele escolhem o lado pela plataforma. Ao criar ou remover uma diferença, atualize este arquivo.

Até a 0.6.0 havia dois repositórios: `siliconflower` (Windows) e `siliconflower-nix` (Linux/Unix). A 0.7.0 os unificou a partir do segundo, que já rodava nos dois sistemas.

## Execução de comandos

| Ponto | Windows | Linux/Unix | Onde |
| :--- | :--- | :--- | :--- |
| Shell | Windows PowerShell 5.1, `-NoProfile`, saída forçada em UTF-8, CLIXML decodificado | `$SHELL -c` (ou `/bin/bash`), não interativo e sem login: `.bashrc`/`.zshrc`/`.profile` não são carregados | `src/shell.ts` |
| API do executor | `runPowerShell` / `startPowerShell` | `runShell` / `startShell` (no Windows, continuam chamando o PowerShell) | `src/shell.ts`, `tools.ts`, `core/hooks.ts`, `services/background-tasks.ts` |
| Matar comandos | `taskkill /T /F` na árvore | o shell é líder de um grupo de processos (`detached`); o grupo recebe `SIGTERM` e, após 2 s, `SIGKILL`, esperando o grupo acabar | `src/shell.ts` |
| Detecção de SO e shell | não existe | `isWindows()`, `getDefaultShell()`, `getShellLabel()`, `getOsLabel()` | `src/platform.ts` |

## Prompt, ferramentas e skills

| Ponto | Windows | Linux/Unix | Onde |
| :--- | :--- | :--- | :--- |
| Identidade | "agente de IA para Windows ... PowerShell" | rótulo do SO real (`getOsLabel()`) e "shell" | `src/modes.ts` |
| Modo `sistema` | PowerShell, batch, registro, serviços; backup da chave antes de mexer no registro | bash/sh, systemd, pacotes, serviços; cópia de um arquivo de `/etc` antes de mudá-lo | `src/modes.ts` |
| Regra do shell | sem `&&`, `\|\|`, `?:`, `??` (PowerShell 5.1) | `$SHELL -c` sem aliases nem funções do usuário | `src/modes.ts` |
| Ações destrutivas | cita registro e serviços | cita serviços | `src/modes.ts` |
| Descrição de `execute_command` | PowerShell 5.1 | o shell do sistema | `src/tools.ts` |
| Skills de exemplo | `windows-backup`, `windows-privacy` | `unix-backup`, `unix-system` (cada SO só recebe as suas) | `src/skills.ts` |
| Assistente: caminho padrão do MCP filesystem | `C:/` | `/` | `src/wizard.ts` |

## Arquivos e dados

| Ponto | Windows | Linux/Unix | Onde |
| :--- | :--- | :--- | :--- |
| `config.json` | gravação atômica | gravação atômica com permissão `0600` (e correção de arquivos antigos ao ler); resolve links simbólicos antes de substituir (dotfiles, Nix/Home Manager); apaga o temporário em caso de falha | `src/config.ts` |
| ID do workspace | caminho em minúsculas (sistema de arquivos sem distinção de maiúsculas) | caminho como está, para duas pastas que diferem só em maiúsculas não colidirem | `src/fs-util.ts` |
| Projetos recentes do app | `folderKey` em minúsculas | `folderKey` mantém maiúsculas | `desktop/src/projects.ts` |

## TUI (terminal)

| Ponto | Windows | Linux/Unix | Onde |
| :--- | :--- | :--- | :--- |
| Sinais de saída | `SIGINT`, `SIGTERM`, `SIGBREAK` | `SIGINT`, `SIGTERM`, `SIGHUP` (terminal fechado) | `src/terminal.ts` |
| Tarefas em background ao sair | encerradas com o console | a TUI chama `killAllBackgroundTasks` ao sair e nos sinais (`onExitSignal`): em grupo de processos próprio, sobreviveriam ao app | `src/App.tsx`, `src/terminal.ts` |
| Saída sincronizada (DEC 2026) | não usa | cada quadro vai entre `ESC[?2026h`/`ESC[?2026l`; reduz o piscar em terminais Linux. `SILICONFLOWER_NO_SYNC_OUTPUT=1` desliga | `src/terminal.ts`, `src/App.tsx` |

## GUI e app de desktop

| Ponto | Windows | Linux/Unix | Onde |
| :--- | :--- | :--- | :--- |
| Abrir o navegador | `Start-Process '<url>'` | `xdg-open` (Linux/BSD) ou `open` (macOS), via `runShell` | `src/gui/index.ts` (`openUrlCommand`) |
| Sinais da GUI | `SIGINT`, `SIGTERM`, `SIGBREAK` | `SIGINT`, `SIGTERM`, `SIGHUP` | `src/gui/index.ts` |
| Executável do agente | `siliconflower.exe` | `siliconflower` | `desktop/src/main.ts` (`AGENT_EXE`), `desktop/electron-builder.yml` |
| Encerramento forçado do agente | `taskkill /T /F` | o agente roda em grupo de processos próprio (`detached`) e o grupo recebe `SIGKILL` | `desktop/src/agent-process.ts` |
| Pacote | instalador NSIS por usuário (`.exe`), ícone `.ico` | AppImage, ícone `icon.png`; `win:` continua no `electron-builder.yml` | `desktop/electron-builder.yml`, `desktop/package.json` (`dist`, `dist:win`, `dist:linux`) |
| `app.setAppUserModelId` | agrupa na barra de tarefas | sem efeito (mantido igual ao Windows) | `desktop/src/main.ts` |

## Build, instalação e pacote

| Ponto | Windows | Linux/Unix | Onde |
| :--- | :--- | :--- | :--- |
| Build | `dist/siliconflower.exe` | `dist/siliconflower` (`build.ts` escolhe `bun-<sistema>-<arquitetura>` pela máquina atual) | `build.ts` |
| `install:bin` | `scripts/install.ps1` (`%LOCALAPPDATA%\Programs\siliconflower` + `PATH`) | `scripts/install-bin.js`: `~/.local/bin` em Unix (`scripts/install.sh`), `install.ps1` no Windows | `package.json`, `scripts/` |
| Release | `siliconflower.exe` e `Siliconflower-Setup-<versão>.exe` (job `windows-latest`) | `siliconflower-linux-x64` e `Siliconflower-<versão>-x86_64.AppImage` (job `ubuntu-latest`) | `.github/workflows/release.yml` |

## Testes

Os testes que dependem do shell ou de caminhos escolhem o lado pela plataforma (`process.platform === "win32"`). Os de processos órfãos contam `sleep` com `ps` em Unix e `powershell.exe` com `Get-CimInstance` no Windows (`tests/regressions.test.ts`). Só em Unix: `tests/config-save.test.ts` (permissão `0600` e links simbólicos) e o teste de `folderKey` que mantém maiúsculas. Só no Windows: o de `folderKey` sem distinção de maiúsculas (`tests/desktop.test.ts`).

## Removido na unificação

Ajustes que existiam só na versão Linux/Unix e não eram de plataforma. Saíram ao unificar com a versão Windows (veja o CHANGELOG da 0.7.0). Se voltarem, valem para todos os sistemas.

- Seção `MCPs:` da barra de status da TUI (`on (2)`, `on (1/2)`, `off`) e `mcpStatusLabel` em `src/mcp.ts` (0.6.0).
- Barra de status curta: `Projeto:` só com o nome da pasta, e a contagem de tokens fora da linha de status (0.6.0). Agora, como no Windows: `Projeto: <pasta> (<arquivo>)` e tokens repetidos na linha de status.
- Texto em streaming repassado à TUI no máximo a cada 60 ms (0.5.0). A TUI agora redesenha a cada pedaço recebido, como no Windows; a saída sincronizada continua.
