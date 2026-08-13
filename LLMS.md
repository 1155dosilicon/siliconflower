# LLMS.md — Siliconflower Architecture & Developer Guide

Este documento serve como mapa arquitetural e guia de desenvolvimento do **Siliconflower** para Modelos de Linguagem (LLMs) e desenvolvedores.

---

## 🏗️ Visão Geral da Arquitetura

O Siliconflower é um harness CLI/TUI autônomo para desenvolvimento de software, projetado para operar com múltiplos provedores de LLM no Windows e Linux.

```
src/
├── core/                  # Núcleo do Harness
│   ├── config.ts          # Gerenciamento de configurações em ~/.siliconflower/config.json
│   ├── context.ts         # Janela de contexto, histórico e compactação inteligente
│   ├── hooks.ts           # Hooks de eventos (preTool, postTool, onEdit, onCommand)
│   ├── llm.ts             # Cliente unificado de chamadas e streaming para OpenAI/Anthropic
│   └── modes.ts           # Modos de operação (code, architect, ask, debug)
│
├── services/              # Serviços do Agente e Ferramentas
│   ├── memory.ts          # Memória persistente entre sessões (.siliconflower/memory)
│   ├── repomap.ts         # Gerador de RepoMap e busca semântica de símbolos
│   ├── smart-edit.ts      # Edição inteligente de arquivos (fuzzy/newline normalization/exact)
│   ├── subagent.ts        # Orquestrador de subagentes concorrentes e background tasks
│   ├── worktree.ts        # Gerenciador de Git Worktrees isolados
│   ├── mcp.ts             # Cliente para servidores MCP (Model Context Protocol)
│   ├── skills.ts          # Carregador e executor de skills (.md)
│   ├── grep.ts            # Mecanismo de busca por conteúdo ripgrep/native
│   ├── glob-util.ts       # Busca por padrões globais de arquivos
│   └── todo.ts            # Gerenciador de lista de tarefas na sessão
│
├── tools.ts               # Definição e registro central de todas as ferramentas nativas
├── types.ts               # Interfaces e tipos globais do TypeScript
│
└── ui/                    # Interface do Usuário (TUI via Ink/React)
    ├── App.tsx            # Componente principal da aplicação
    ├── MarkdownText.tsx   # Renderizador de Markdown adaptado para terminal
    ├── wizard.ts          # Assistente interativo de configuração inicial
    └── ascii.ts           # Arte ASCII e logotipo
```

---

## 🛠️ Tabela de Ferramentas Nativas

| Ferramenta | Descrição | Arquivo |
| :--- | :--- | :--- |
| `read_file` | Leitura de arquivos com limite de linhas e offset. | `src/tools.ts` |
| `write_file` | Criação/sobrescrita de arquivos. | `src/tools.ts` |
| `edit_file` | Edição inteligente com correspondência flexível (exact/newline/fuzzy). | `src/services/smart-edit.ts` |
| `execute_command` | Execução de comandos do sistema (PowerShell/Bash) com timeout. | `src/tools.ts` |
| `search_files` | Busca de arquivos usando padrões Glob. | `src/services/glob-util.ts` |
| `grep_content` | Busca por expressões regulares no conteúdo dos arquivos. | `src/services/grep.ts` |
| `repo_map` | Gera um mapa estrutural do repositório exibindo símbolos e assinaturas. | `src/services/repomap.ts` |
| `find_symbol` | Localiza definições de funções, classes, tipos e variáveis no código. | `src/services/repomap.ts` |
| `save_memory` | Armazena regras e aprendizados persistentes entre sessões. | `src/services/memory.ts` |
| `recall_memory` | Consulta memórias salvas do projeto ou usuário. | `src/services/memory.ts` |
| `forget_memory` | Remove memórias obsoletas ou desatualizadas. | `src/services/memory.ts` |
| `run_task` | Executa subagentes autônomos (papeis: `general`, `research`, `verification`, `plan`). | `src/services/subagent.ts` |
| `list_background_tasks` | Exibe o status e resultados de subagentes em segundo plano. | `src/services/subagent.ts` |
| `enter_worktree` | Cria um ambiente de trabalho Git isolado em branch temporária. | `src/services/worktree.ts` |
| `exit_worktree` | Remove um Git Worktree após a conclusão do trabalho. | `src/services/worktree.ts` |
| `list_worktrees` | Lista os Git Worktrees ativos no projeto. | `src/services/worktree.ts` |

---

## 🧠 Sistema de Memória Persistente

O Siliconflower armazena memórias em markdown com cabeçalhos frontmatter sob dois diretórios:
- **Projeto:** `<workspace>/.siliconflower/memory/` (específico para o repositório atual)
- **Global:** `~/.siliconflower/memory/` (aplicável a qualquer projeto do usuário)

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

---

## 🔨 Comandos de Build e Validação (Windows / Bun)

- **Checagem de Tipos:** `bun x tsc --noEmit`
- **Compilação do Executável:** `bun run build` (gera `dist/siliconflower.exe`)
- **Execução em Desenvolvimento:** `bun start` ou `bun run src/index.tsx`
