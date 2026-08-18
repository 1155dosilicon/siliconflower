# LLMS.md — Siliconflower Architecture & Developer Guide

Este documento serve como mapa arquitetural e guia de desenvolvimento do **Siliconflower** para Modelos de Linguagem (LLMs) e desenvolvedores.

---

## 🏗️ Visão Geral da Arquitetura

O Siliconflower é um harness CLI/TUI autônomo para desenvolvimento de software, projetado exclusivamente para o ecossistema Windows (PowerShell/Bun/Node), operando com múltiplos provedores de LLM.

```text
src/
├── core/                  # Núcleo de Hooks e ciclo de vida
│   └── hooks.ts           # Hooks de eventos (preTool, postTool, onEdit, onCommand)
│
├── services/              # Serviços de Especialização do Agente
│   ├── artifact.ts        # Gestão de entregáveis e artefatos (~/.siliconflower/workspaces/<id>/artifacts/)
│   ├── background-tasks.ts# Gerenciador de tarefas assíncronas e comandos em background
│   ├── memory.ts          # Memória persistente (~/.siliconflower/workspaces/<id>/memory/)
│   ├── repomap.ts         # Gerador de RepoMap e busca semântica de símbolos em código
│   ├── smart-edit.ts      # Edição inteligente de arquivos (fuzzy/newline/exact)
│   ├── subagent.ts        # Orquestrador de subagentes especializados e sessões
│   ├── web.ts             # Busca web nativa e conversão de HTML para Markdown
│   └── worktree.ts        # Gerenciador de Git Worktrees isolados
│
├── App.tsx                # Componente TUI principal da aplicação (Ink/React)
├── MarkdownText.tsx       # Renderizador de Markdown adaptado para terminal
├── ascii.ts               # Arte ASCII e logotipo
├── config.ts              # Gerenciamento de configurações em ~/.siliconflower/config.json
├── context.ts             # Janela de contexto, histórico e compactação inteligente
├── fs-util.ts             # Utilitários de sistema de arquivos, workspace IDs e segurança de caminhos
├── glob-util.ts           # Busca por padrões globais de arquivos
├── grep.ts                # Mecanismo de busca textual e regex recursiva
├── index.tsx              # Ponto de entrada CLI (Commander)
├── llm.ts                 # Cliente unificado de chamadas e streaming para OpenAI/Anthropic
├── logger.ts              # Sistema de logs com rotação e busca (200 KB)
├── mcp.ts                 # Cliente para servidores MCP (Model Context Protocol) via stdio
├── modes.ts               # Modos de operação (programação, sistema, plano)
├── skills.ts              # Carregador e executor de skills (.md)
├── task.ts                # Adaptador de compatibilidade para subagentes
├── todo.ts                # Gerenciador de lista de tarefas na sessão
├── tools.ts               # Definição e registro central das 34 ferramentas nativas
├── types.ts               # Interfaces e tipos globais do TypeScript
└── wizard.ts              # Assistente interativo de configuração inicial
```

---

## 🛠️ Tabela de Ferramentas Nativas (34 Ferramentas)

| Ferramenta | Descrição | Arquivo Fonte |
| :--- | :--- | :--- |
| `read_file` | Leitura paginada de arquivos com `offset`, `limit` e linhas numeradas. | `src/tools.ts` |
| `write_file` | Criação/sobrescrita de arquivos com criação automática de pastas pai. | `src/tools.ts` |
| `edit_file` | Edição inteligente com correspondência flexível (`exact`, `normalized_newlines`, `fuzzy_whitespace`). | `src/services/smart-edit.ts` |
| `apply_patch` | Aplicação atômica de patches com múltiplos blocos de substituição. | `src/tools.ts` |
| `list_directory` | Lista arquivos e subpastas de um diretório. | `src/tools.ts` |
| `create_directory` | Cria diretórios e caminhos aninhados recursivamente. | `src/tools.ts` |
| `move_path` | Move ou renomeia arquivos e diretórios. | `src/tools.ts` |
| `delete_path` | Exclui arquivos/pastas (requer `confirm: true` para exclusão). | `src/tools.ts` |
| `file_info` | Consulta tamanho, tipo e datas de criação/modificação. | `src/tools.ts` |
| `search_files` | Busca arquivos usando padrões Glob (`**/*.ts`). | `src/glob-util.ts` |
| `grep_content` | Busca textual e regex recursiva no conteúdo dos arquivos com número de linha. | `src/grep.ts` |
| `repo_map` | Gera visualização estrutural do repositório exibindo símbolos e assinaturas. | `src/services/repomap.ts` |
| `find_symbol` | Localiza definições e assinaturas de símbolos específicos no código. | `src/services/repomap.ts` |
| `execute_command` | Execução de comandos do sistema no terminal PowerShell com timeout e captura segura. | `src/tools.ts` |
| `read_logs` | Consulta e filtra logs de execução do Siliconflower. | `src/logger.ts` |
| `ask_question` | Faz perguntas diretas ao usuário com opções interativas. | `src/tools.ts` |
| `todowrite` | Gerencia o checklist interativo de tarefas exibido na interface TUI. | `src/todo.ts` |
| `read_skill` | Carrega e lê o conteúdo de habilidades personalizadas salvas em `~/.siliconflower/skills/`. | `src/skills.ts` |
| `run_task` | Instancia subagente autônomo (papéis: `research`, `verification`, `plan`, `coder`, `general`, `custom`). | `src/services/subagent.ts` |
| `send_subagent_message`| Envia mensagens adicionais para continuar uma sessão de subagente. | `src/services/subagent.ts` |
| `manage_background_task` | Consulta status, recupera saídas ou encerra tarefas e subagentes em background. | `src/services/background-tasks.ts` |
| `save_memory` | Armazena regras, aprendizados e diretrizes persistentes entre sessões. | `src/services/memory.ts` |
| `recall_memory` | Consulta memórias salvas do projeto (`~/.siliconflower/workspaces/<id>/memory`) ou globais (`~/.siliconflower/memory`). | `src/services/memory.ts` |
| `forget_memory` | Remove memórias obsoletas ou desatualizadas. | `src/services/memory.ts` |
| `enter_worktree` | Cria um ambiente de trabalho Git isolado em branch temporária. | `src/services/worktree.ts` |
| `exit_worktree` | Remove um Git Worktree após a conclusão do trabalho ou testes. | `src/services/worktree.ts` |
| `list_worktrees` | Lista os Git Worktrees ativos no repositório. | `src/services/worktree.ts` |
| `create_artifact` | Cria e armazena artefatos estruturados (`markdown`, `html`, `json`, `code`, `mermaid`). | `src/services/artifact.ts` |
| `read_artifact` | Lê o conteúdo completo de um artefato salvo pelo ID. | `src/services/artifact.ts` |
| `list_artifacts` | Lista os artefatos disponíveis do projeto ou globais com metadados. | `src/services/artifact.ts` |
| `delete_artifact` | Remove um artefato persistente pelo ID. | `src/services/artifact.ts` |
| `web_fetch` | Baixa o conteúdo de páginas Web convertendo automaticamente para Markdown limpo. | `src/services/web.ts` |
| `web_search` | Realiza pesquisas na Web retornando snippets e URLs de referência. | `src/services/web.ts` |
| `manage_hooks` | Consulta ou atualiza ganchos de execução configurados em tempo de execução. | `src/core/hooks.ts` |

---

## 🧠 Sistema de Memória Persistente & Isolamento de Workspaces

Seguindo o padrão de harnesses modernos (como Antigravity), o Siliconflower **não polui o repositório do usuário** com pastas locais no workspace. Todos os dados são centralizados e isolados deterministicamente:

- **Projeto (Centralizado):** `~/.siliconflower/workspaces/<workspace-id>/memory/`
- **Global:** `~/.siliconflower/memory/`
- **Retrocompatibilidade:** Se existir uma pasta legada `<workspace>/.siliconflower/`, ela é consultada transparentemente para leitura/exclusão.

O `<workspace-id>` é derivado a partir do nome da pasta e um hash SHA-256 do caminho absoluto (ex: `meu-app-8f3a1b2c`).

Tipos de Memória suportados: `user`, `feedback`, `project`, `reference`.
As memórias ativas são injetadas automaticamente no prompt do sistema durante cada interação.

---

## ⚡ Hooks de Execução

Você pode configurar hooks no `config.json` do usuário:
```json
{
  "hooks": {
    "preTool": "bun run lint",
    "postTool": "git status",
    "onEdit": "bun x tsc --noEmit"
  }
}
```

Variáveis de ambiente injetadas nos hooks:
- `SILICONFLOWER_TOOL_NAME`
- `SILICONFLOWER_TOOL_ARGS`
- `SILICONFLOWER_FILE_PATH` (quando aplicável)

---

## 🔨 Comandos de Build e Validação (Windows / Bun)

- **Checagem de Tipos:** `bun run typecheck` ou `bun x tsc --noEmit`
- **Suíte de Testes:** `bun test`
- **Compilação do Executável Standalone:** `bun run build` (gera `dist/siliconflower.exe`)
- **Instalação no PATH do Windows:** `npm run install:bin` (ou `scripts/install.ps1`)
- **Execução em Desenvolvimento:** `bun start` ou `bun run src/index.tsx`

