# Orientações para Agentes de IA / LLMs Futuras

Este arquivo é um guia de arquitetura e contexto otimizado para que qualquer LLM ou agente CLI que trabalhe no **Siliconflower** entenda a estrutura rapidamente sem gastar contexto desnecessário.

---

## 1. Visão Geral do Projeto

**Siliconflower** é um agente de IA CLI/TUI para Windows/Linux, escrito em **TypeScript / Bun**, com interface em **React (Ink)**.

**Tecnologias principais:**
- **Runtime & Build:** Bun >= 1.3.0 (`bun run start`, `bun build --compile`)
- **TUI:** Ink (React no terminal) + `ink-text-input`
- **LLM Backends:** `@anthropic-ai/sdk` e `openai` (compatível com SiliconFlow, OpenRouter, OpenAI, Proxies)
- **Protocolo MCP:** `@modelcontextprotocol/sdk` (conexão stdio)

---

## 2. Estrutura de Arquivos e Responsabilidades (`src/`)

Quando precisar alterar ou adicionar uma funcionalidade, consulte apenas o arquivo específico:

| Funcionalidade / Área | Arquivo Principal | O que faz |
|-----------------------|-------------------|-----------|
| **Tipos & Contratos** | `src/types.ts` | Definições de interfaces, eventos de stream, To-Dos, e modos. |
| **Ferramentas Nativas** | `src/tools.ts` | Implementação de `read_file`, `write_file`, `edit_file`, `apply_patch`, `grep_content`, `todowrite`, `run_task`, `ask_question`, `read_logs`, etc. |
| **Integração com LLM** | `src/llm.ts` | Loops de execução (até 25 passos), adaptadores OpenAI e Anthropic, streaming, reasoning. |
| **Gestão de Contexto** | `src/context.ts` | Estimativa de tokens, compressão de histórico (`compressHistory`) e persistência de saídas grandes (`processToolOutput`). |
| **Modos & System Prompts** | `src/modes.ts` | Definição dos modos `programação`, `sistema` e `plano`. |
| **Interface TUI (React/Ink)** | `src/App.tsx` | Componente principal, tratamento de atalhos (`Ctrl+O`, `Ctrl+E`, `Ctrl+C`), painel de To-Dos e estado da conversa. |
| **Renderização Markdown** | `src/MarkdownText.tsx` | Renderizador de títulos, blocos de código e negrito no terminal Windows. |
| **Busca por Conteúdo** | `src/grep.ts` | Motor de busca por texto/regex em arquivos (nativo, sem dependências externas). |
| **Gerenciador de To-Dos** | `src/todo.ts` | Estado reativo da lista de tarefas da sessão. |
| **Subagentes Autônomos** | `src/task.ts` | Executor de tarefas autônomas em contexto isolado. |
| **Sistema de Logs** | `src/logger.ts` | Rotação automática a cada 200 KB, `tailLogs` e filtros. |
| **Cliente MCP** | `src/mcp.ts` | Gerenciamento e chamada de servidores MCP externos via stdio. |
| **Habilidades (.md)** | `src/skills.ts` | Carregador de habilidades customizadas de `~/.siliconflower/skills/`. |
| **Setup & Configuração** | `src/wizard.ts` & `src/config.ts` | Wizard interativo e leitura/gravação de `~/.siliconflower/config.json`. |

---

## 3. O que LER (Arquivos Importantes)

- **Para adicionar ou editar uma ferramenta:** Leia `src/tools.ts` e `src/types.ts`.
- **Para alterar comportamento de mensagens/LLM:** Leia `src/llm.ts` e `src/context.ts`.
- **Para alterar visual/atalhos do terminal:** Leia `src/App.tsx` e `src/MarkdownText.tsx`.
- **Para adicionar testes:** Crie ou modifique arquivos na pasta `tests/`.

---

## 4. O que IGNORAR (NÃO LER para Economizar Contexto)

**JAMAIS leia os seguintes diretórios/arquivos para evitar estouro da janela de contexto:**
- ❌ **`node_modules/`**: Arquivos de dependências externas.
- ❌ **`dist/`**: Executáveis compilados.
- ❌ **`bun.lock` / `package-lock.json`**: Arquivos de lock.
- ❌ **`~/.siliconflower/outputs/` / `~/.siliconflower/logs/`**: Arquivos temporários gerados durante o uso.
- ❌ **Imagens, binários e arquivos `.zip`**.

---

## 5. Comandos de Verificação e Validação

Após realizar alterações, SEMPRE valide o projeto com estes comandos:

```powershell
bun run typecheck   # Validação rigorosa de tipos TypeScript (tsc --noEmit)
bun test            # Execução da suíte de testes unitários em tests/
bun run build       # Teste de compilação do executável standalone dist/siliconflower.exe
```
