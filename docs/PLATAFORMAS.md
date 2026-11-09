# O que muda entre Windows e Linux/Unix

O Siliconflower tem um único código para Windows e Linux, só em x86_64. macOS e ARM não são suportados: o build (`build.ts`) recusa outras plataformas. As funções são as mesmas em todos: GUI no navegador (`siliconflower gui`), app de desktop em Electron, conversas salvas, ferramentas, subagentes, MCP, hooks e skills.

Esta lista é tudo o que **deve** ser diferente entre os sistemas. Fora daqui, o comportamento é o mesmo. O código específico de SO passa por `src/platform.ts` (`isWindows()`), e os testes que dependem dele escolhem o lado pela plataforma. Ao criar ou remover uma diferença, atualize este arquivo.

## Execução de comandos

| Ponto | Windows | Linux/Unix | Onde |
| :--- | :--- | :--- | :--- |
| Shell | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand` (acima de ~30 mil caracteres, `-Command`); saída forçada em UTF-8, stderr CLIXML convertido em texto | `$SHELL -c` (ou `/bin/bash`), não interativo e sem login: `.bashrc`/`.zshrc`/`.profile` não são carregados | `src/shell.ts`, `src/platform.ts` |
| Matar comandos | `taskkill /T /F` na árvore, antes do processo pai | o shell é líder de um grupo de processos (`detached`); o grupo recebe `SIGTERM` e, após 2 s, `SIGKILL`, esperando o grupo acabar | `src/shell.ts` |

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
| Memória chamada `memory` | arquivo `memory_.md`, porque `memory.md` seria o próprio índice `MEMORY.md` (sistema de arquivos sem distinção de maiúsculas) | arquivo `memory.md` | `src/services/memory.ts` (`fileNameFor`) |
| ID do workspace | caminho em minúsculas (sistema de arquivos sem distinção de maiúsculas) | caminho como está, para duas pastas que diferem só em maiúsculas não colidirem | `src/fs-util.ts` |
| Projetos recentes do app | `folderKey` em minúsculas | `folderKey` mantém maiúsculas | `desktop/src/projects.ts` |

## GUI e app de desktop

| Ponto | Windows | Linux/Unix | Onde |
| :--- | :--- | :--- | :--- |
| Abrir o navegador | `Start-Process '<url>'` | `xdg-open`, via `runShell` | `src/gui/index.ts` (`openUrlCommand`) |
| Sinais da GUI | `SIGINT`, `SIGTERM`, `SIGBREAK` | `SIGINT`, `SIGTERM`, `SIGHUP` | `src/gui/index.ts` |
| Executável do agente | `siliconflower.exe` | `siliconflower` | `desktop/src/main.ts` (`AGENT_EXE`), `desktop/electron-builder.yml` |
| Encerramento forçado do agente | `taskkill /T /F` | o agente roda em grupo de processos próprio (`detached`) e o grupo recebe `SIGKILL` | `desktop/src/agent-process.ts` |
| Pacote | instalador NSIS por usuário (`.exe`), ícone `.ico` | `.deb` (sistema, em `/opt`, sem FUSE) e AppImage (instalável por usuário com `scripts/install-appimage.sh`, que o extrai: sem FUSE), ícone `icon.png`; `win:` continua no `electron-builder.yml` | `desktop/electron-builder.yml`, `desktop/package.json` (`dist`, `dist:win`, `dist:linux`) |
| `app.setAppUserModelId` | agrupa na barra de tarefas | sem efeito (mantido igual ao Windows) | `desktop/src/main.ts` |

## Build, instalação e pacote

| Ponto | Windows | Linux/Unix | Onde |
| :--- | :--- | :--- | :--- |
| Build | `dist/siliconflower.exe` | `dist/siliconflower` (`build.ts` escolhe `bun-<sistema>-<arquitetura>` pela máquina atual) | `build.ts` |
| `install:bin` | `scripts/install.ps1` (`%LOCALAPPDATA%\Programs\siliconflower` + `PATH`) | `scripts/install-bin.js`: `~/.local/bin` em Unix (`scripts/install.sh`), `install.ps1` no Windows | `package.json`, `scripts/` |
| Release | `siliconflower.exe` e `Siliconflower-Setup-<versão>.exe` (job `windows-latest`) | `siliconflower-linux-x64`, `Siliconflower-<versão>-x86_64.AppImage`, `Siliconflower-<versão>-amd64.deb` e `install-appimage.sh` (job `ubuntu-latest`) | `.github/workflows/release.yml` |

## Requisitos mínimos

A tabela está no README (Requisitos no Linux). As versões de glibc (2.25 no app, 2.17 no agente) foram medidas nos binários da 0.8.0; kernel e CPU vêm da [documentação do Bun](https://bun.sh/docs/installation). Ao subir a versão do Electron ou do Bun, meça de novo:

```bash
objdump -T dist-desktop/linux-unpacked/siliconflower-desktop | grep -oE 'GLIBC_[0-9.]+' | sort -Vu | tail -1
objdump -T dist/siliconflower | grep -oE 'GLIBC_[0-9.]+' | sort -Vu | tail -1
```

## Testes

Os testes que dependem do shell ou de caminhos escolhem o lado pela plataforma (`process.platform === "win32"`). Os de processos órfãos contam `sleep` com `ps` em Unix e `powershell.exe` com `Get-CimInstance` no Windows (`tests/regressions.test.ts`). Só em Unix: `tests/config-save.test.ts` (permissão `0600` e links simbólicos) e o teste de `folderKey` que mantém maiúsculas. Só no Windows: o de `folderKey` sem distinção de maiúsculas (`tests/desktop.test.ts`).

## Histórico

Até a 0.6.0 havia dois repositórios, `siliconflower` (Windows) e `siliconflower-nix` (Linux/Unix); a 0.7.0 os unificou. A 0.8.0 removeu a TUI (interface de terminal), e com ela as diferenças de sinais e saída sincronizada que ela tinha. Detalhes no [CHANGELOG](../CHANGELOG.md).
