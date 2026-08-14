# 🌸 SILICONFLOWER

![Version](https://img.shields.io/badge/version-0.2.2-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20PowerShell-0078D6.svg)
![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3-black.svg)
![Node](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)

Agente CLI/TUI de Inteligência Artificial para Windows com suporte nativo a **MCP** (Model Context Protocol), **Raciocínio Controlável (Reasoning)**, **Contador de Tokens em Tempo Real**, **Tratamento de Tarefas (To-Do)**, **Habilidades (.md)**, **3 Modos de Operação** e compatibilidade com APIs do **SiliconFlow, OpenRouter, OpenAI e Anthropic**.

```text
  S I L I C O N F L O W E R
--------------------------------------------------------------------------------
  voce  > crie um backup da pasta src em backups/ e organize as tarefas
  ia    > análise concluída. criando diretório e copiando arquivos...
--------------------------------------------------------------------------------
  Tarefas (To-Do):
  [✓] Analisar estrutura da pasta src
  [▶] Executar cópia de segurança em backups/
--------------------------------------------------------------------------------
  > digite para a LLM...
--------------------------------------------------------------------------------
  Model: deepseek-ai/DeepSeek-V4-Pro  Reasoning: high  Mode: PROG
  Tools: 17  Skills: 3  Tokens: 3.2K
  pronto (3.2K tokens)
```

> 💡 **Interface Limpa e Leve:** Projetada para Windows Terminal, PowerShell, CMD e VS Code Terminal. Sem necessidade de Nerd Fonts ou caracteres especiais.

---

## 📋 Sumário

- [✨ Funcionalidades](#-funcionalidades)
- [🚀 Instalação e Início Rápido](#-instalação-e-início-rápido)
- [⚙️ Configuração Inicial](#️-configuração-inicial)
- [⚡ Modelos Recomendados (2026)](#-modelos-recomendados-2026)
- [⌨️ Atalhos de Teclado (TUI)](#️-atalhos-de-teclado-tui)
- [🛠️ Ferramentas Nativas](#️-ferramentas-nativas)
- [🧩 Servidores MCP](#-servidores-mcp)
- [🧠 Modos de Operação & Raciocínio](#-modos-de-operação--raciocínio)
- [🎯 Habilidades (Skills .md)](#-habilidades-skills-md)
- [📦 Compilando Executável Standalone (.exe)](#-compilando-executável-standalone-exe)
- [📁 Estrutura do Projeto](#-estrutura-do-projeto)
- [📜 Licença](#-licença)

---

## ✨ Funcionalidades

| Área | Descrição |
| :--- | :--- |
| **Provedores LLM** | Suporte a APIs compatíveis com OpenAI (`/v1/chat/completions`) e Anthropic (`/v1/messages`). |
| **Contador de Tokens** | Contador de tokens em tempo real na TUI com estimativa local instantânea + metadados das APIs. |
| **Raciocínio (Reasoning)** | Níveis `none` / `low` / `medium` / `high`. Envia `reasoning_effort` (OpenAI/DeepSeek) ou `thinking` com `budget_tokens` (Anthropic). Alternável com `Ctrl+E`. |
| **Modos de Operação** | `programação` (código), `sistema` (administração Windows) e `plano` (apenas leitura e planejamento). Alternável com `Ctrl+O`. |
| **Ferramentas Nativas** | Leitura/escrita, busca recursiva (`grep_content`), edição atômica (`apply_patch`), execução silenciosa no PowerShell, subagentes isolados (`run_task`) e painel de tarefas (`todowrite`). |
| **Protocolo MCP** | Integração total com servidores MCP via `stdio` (ex: Git, Filesystem, Brave Search), mesclando ferramentas automaticamente. |
| **Habilidades (.md)** | Carregamento dinâmico de guias e habilidades personalizadas em `~/.siliconflower/skills/*.md`. |
| **Executável Único (.exe)** | Compilado via `bun build --compile` gerando um executável standalone no Windows sem dependência prévia do Node.js. |

---

## 🚀 Instalação e Início Rápido

### Pré-requisitos

* **Bun >= 1.1** (Recomendado): https://bun.sh
* **ou Node.js >= 20** + `tsx` (pré-instalado nas dependências).

### Clonar e Executar

```powershell
git clone https://github.com/siliconflower/siliconflower.git
cd siliconflower
bun install
bun run start          # Inicia a TUI; na 1ª vez abre o assistente de configuração
```

Outras formas de execução:

```powershell
# Iniciar com parâmetros específicos
bun run start -- -m deepseek-ai/DeepSeek-V4-Pro -r high --mode programacao

# Executar via Node.js
node bin\siliconflower.js

# Compilar e instalar no PATH do Windows (sem necessidade de admin)
bun run build
npm run install:bin
```

---

## ⚙️ Configuração Inicial

Na primeira execução, o assistente (*wizard*) solicita:

1. **Variante do Provedor:** `openai` ou `anthropic`.
2. **Base URL:** ex: `https://api.siliconflow.com/v1`, `https://openrouter.ai/api/v1` ou `https://api.anthropic.com`.
3. **Model ID:** ex: `deepseek-ai/DeepSeek-V4-Pro`, `claude-5`, `gpt-5.5`.
4. **Chave de API (API Key):** Entrada mascarada com asteriscos.
5. **Nível Padrão de Raciocínio (Reasoning):** `none`, `low`, `medium` ou `high`.
6. **Prompt de Sistema e Servidores MCP (Opcionais).**

As configurações são salvas em `~/.siliconflower/config.json`:

```json
{
  "provider": "openai",
  "baseURL": "https://api.siliconflow.com/v1",
  "apiKey": "sk-...",
  "model": "deepseek-ai/DeepSeek-V4-Pro",
  "reasoning": "high",
  "mode": "programacao",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Users/username"]
    }
  }
}
```

### Comandos de Gerenciamento da Configuração

```powershell
bun run start -- config   # Re-executa o assistente de configuração
bun run start -- show     # Exibe as configurações atuais (chave mascarada)
bun run start -- ensure   # Cria o arquivo de configuração caso não exista e sai
```

### Variáveis de Ambiente (Fallback)

Você também pode configurar suas credenciais via arquivo `.env` ou variáveis do sistema:

* `SILICONFLOWER_API_KEY` - Chave de API.
* `SILICONFLOWER_BASE_URL` - URL base da API.
* `SILICONFLOWER_MODEL` - Modelo padrão.

---

## ⚡ Modelos Recomendados (2026)

### Pesos Abertos (Open-Weights) & Provedores Compatíveis (SiliconFlow, OpenRouter, etc.)

| Modelo | Parâmetros / Ativos | Janela de Contexto | Suporte a Tools | Raciocínio (Reasoning) | Foco Principal |
| :--- | :---: | :---: | :---: | :---: | :--- |
| `deepseek-ai/DeepSeek-V4-Pro` | **284B–1.6T** (MoE) | 1M tokens | ✅ Sim | ✅ Nativo | Programação avançada, raciocínio lógico e baixo custo |
| `Qwen/Qwen-3.7-Max` | Até **1.1T** (MoE) | 1M tokens | ✅ Sim | ✅ Nativo | Código de alto nível, matemática e multilíngue |
| `meta-llama/Llama-4-Scout` | Dezenas a 100s B | **Até 10M tokens** | ✅ Sim | ❌ Não | Processamento de contextos massivos e privacidade |
| `z-ai/GLM-5.2` | **753B** (40B ativos) | 1M tokens | ✅ Sim | ✅ Nativo | Automação de tarefas, uso de terminal e agentes |
| `moonshot/Kimi-K3` | **~1T** (MoE) | 1M+ tokens | ✅ Sim | ✅ Nativo | Raciocínio avançado em código e matemática |
| `google/Gemma-4-31B` | **31B** | 256k tokens | ✅ Sim | ❌ Não | Execução local eficiente e SLM de alta inteligência |

### Modelos Proprietários (Código Fechado)

| Modelo | Desenvolvedor | Janela de Contexto | Suporte a Tools | Raciocínio | Foco Principal |
| :--- | :--- | :---: | :---: | :---: | :--- |
| `gpt-5.5` / `gpt-5.6` | OpenAI | 400k – 1M tokens | ✅ Sim | ✅ Nativo | Raciocínio avançado, fluxos autônomos e agentes |
| `claude-opus-4.8` / `claude-5` | Anthropic | 1M+ tokens | ✅ Sim | ✅ Nativo | Engenharia de software profunda e revisão de código |
| `gemini-3.5-pro` | Google | 1M – 2M tokens | ✅ Sim | ✅ Nativo | Multimodalidade nativa e contexto ultra longo |
| `grok-4.3` | xAI | 1M tokens | ✅ Sim | ✅ Nativo | Pesquisa em tempo real e raciocínio técnico |

---

## ⌨️ Atalhos de Teclado (TUI)

| Atalho | Ação |
| :--- | :--- |
| `Enter` | Envia a mensagem digitada |
| `Ctrl+E` | Alterna o nível de raciocínio (`none` ➔ `low` ➔ `medium` ➔ `high`) |
| `Ctrl+O` | Alterna o modo de operação (`programação` ➔ `sistema` ➔ `plano`) |
| `Ctrl+C` | Cancela a geração em andamento; pressione 2x para sair |

### Parâmetros de Linha de Comando (CLI)

```powershell
  -m, --model <id>        Sobrescreve o modelo selecionado
  -r, --reasoning <level> Define o nível: none | low | medium | high
      --mode <mode>       Define o modo: programacao | sistema | plano
      --provider <type>   Define o provedor: openai | anthropic
      --base-url <url>    Sobrescreve a URL base da API
      --api-key <key>     Sobrescreve a chave de API
```

---

## 🛠️ Ferramentas Nativas

O agente possui ferramentas nativas para interagir com o sistema de arquivos e executar ações sem depender de MCP externos:

| Ferramenta | Descrição |
| :--- | :--- |
| `read_file` | Lê arquivos de texto com suporte a `offset` e `limit` (linhas numeradas `1: conteúdo`). |
| `grep_content` | Busca textual e regex recursiva em arquivos (`arquivo:linha: conteúdo`). |
| `write_file` | Cria ou sobrescreve arquivos (cria diretórios pai automaticamente). |
| `edit_file` | Substitui ocorrências de texto específico (`oldText` por `newText`). |
| `apply_patch` | Aplica edições multi-bloco de forma atômica. |
| `todowrite` | Gerencia a lista de tarefas da sessão e exibe o painel interativo (`[✓]`, `[▶]`, `[ ]`). |
| `run_task` | Executa subagentes isolados para exploração e pesquisas complexas sem poluir o contexto principal. |
| `ask_question` | Faz perguntas diretas ao usuário com opções interativas. |
| `read_logs` | Consulta e filtra logs de execução do agente (`lines`, `level`, `search`). |
| `list_directory` | Lista arquivos e subpastas de um diretório. |
| `create_directory` | Cria diretórios recursivamente. |
| `move_path` | Move ou renomeia arquivos e pastas. |
| `file_info` | Consulta tamanho, datas de criação/modificação e tipo de arquivo. |
| `search_files` | Busca arquivos usando padrões glob (`**/*.ts`, `*.{ts,tsx}`). |
| `delete_path` | Exclui arquivos/pastas. Requer confirmação explícita (`confirm=true`). |
| `execute_command` | Executa comandos no PowerShell (Windows) ou Bash de forma silenciosa e transparente. |
| `create_artifact` / `read_artifact` / `list_artifacts` / `delete_artifact` | Cria, lê, lista e remove artefatos persistentes estruturados (.html, .json, .md, .txt) no diretório `.siliconflower/artifacts/`. |
| `save_memory` / `recall_memory` / `forget_memory` | Armazena, consulta e gerencia memórias e regras persistentes entre sessões em escopo de projeto ou global do usuário. |
| `enter_worktree` / `exit_worktree` / `list_worktrees` | Cria, remove e lista Git Worktrees temporários para desenvolvimento e testes isolados e seguros. |
| `repo_map` / `find_symbol` | Gera mapa estrutural completo do repositório com assinaturas ou busca símbolos específicos (funções, classes) pelo código. |
| `read_skill` | Carrega e lê o conteúdo detalhado de instruções de habilidades (.md) do usuário. |
| `manage_hooks` | Exibe e gerencia a configuração de ganchos (hooks) de execução automatizados do agente. |

> 🛡️ **Segurança e Proteção:** Todas as ferramentas possuem tempo limite de execução (timeout) de 60 segundos, executam com janelas ocultas e impedem acesso a diretórios sensíveis do sistema (`C:\Windows\System32`, `.ssh`, `.aws`, etc.). Saídas extensas são truncadas e salvas em `~/.siliconflower/outputs/`.

---

## 🧩 Servidores MCP

Adicione servidores no seu `config.json`:

```json
"mcpServers": {
  "git": { 
    "command": "uvx", 
    "args": ["mcp-server-git", "--repository", "C:/meu-repositorio"] 
  },
  "filesystem": { 
    "command": "npx", 
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Users/username"] 
  },
  "brave-search": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-brave-search"],
    "env": { "BRAVE_API_KEY": "sua-chave-aqui" }
  }
}
```

---

## 🧠 Modos de Operação & Raciocínio

| Modo | Foco |
| :--- | :--- |
| `programação` | Leitura, escrita, revisão e refatoração de código seguindo as convenções do projeto. |
| `sistema` | Administração Windows: scripts PowerShell, backups, serviços, rede e configurações. |
| `plano` | MODO APENAS LEITURA. Ferramentas de escrita e execução são bloqueadas até que você aprove o plano. |

---

## 🎯 Habilidades (Skills .md)

Adicione arquivos Markdown em `~/.siliconflower/skills/`. Cada arquivo `.md` é descoberto automaticamente e lido sob demanda pela IA via `read_skill`.

Comandos de habilidades:

```powershell
bun run start -- skills   # Lista as habilidades descobertas
bun run start -- sync     # Sincroniza habilidades padrão do pacote
```

---

## 📦 Compilando Executável Standalone (.exe)

Você pode gerar um arquivo `.exe` 100% independente para Windows:

```powershell
bun run build
```

O binário será gerado em `dist/siliconflower.exe`. Para instalá-lo no seu `%PATH%` de usuário:

```powershell
npm run install:bin
```

---

## 📁 Estrutura do Projeto

```text
siliconflower/
├── bin/
│   └── siliconflower.js     # Inicializador híbrido (Bun -> tsx -> npx tsx)
├── src/
│   ├── index.tsx            # Ponto de entrada CLI (Commander)
│   ├── App.tsx              # TUI Ink/React, barra de status e atalhos
│   ├── MarkdownText.tsx     # Renderizador de Markdown e código no terminal
│   ├── llm.ts               # Adaptador de streaming OpenAI/Anthropic & Reasoning
│   ├── context.ts           # Gestão de tokens, compressão de histórico e outputs
│   ├── grep.ts              # Mecanismo nativo de busca por texto/regex
│   ├── task.ts              # Executor de subagentes autônomos
│   ├── todo.ts              # Gerenciador do painel de tarefas (To-Do)
│   ├── mcp.ts               # Cliente gerenciador de servidores MCP stdio
│   ├── tools.ts             # Ferramentas nativas de sistema de arquivos
│   ├── glob-util.ts         # Motor de busca glob com suporte a classes de caracteres
│   ├── skills.ts            # Gerenciador e sincronizador de habilidades (.md)
│   ├── modes.ts             # Definições de persona (programação / sistema / plano)
│   ├── logger.ts            # Rotação e filtragem de logs (200 KB)
│   ├── config.ts            # Gerenciador de configurações e variáveis de ambiente
│   ├── wizard.ts            # Assistente de configuração inicial
│   ├── ascii.ts             # Logo e arte ASCII
│   └── types.ts             # Tipos e interfaces compartilhadas
├── tests/                   # Suíte de testes unitários (bun test)
├── scripts/
│   └── install.ps1          # Script de instalação do .exe no PATH do Windows
├── build.ts                 # Pipeline de compilação standalone via Bun
├── LLMS.md                  # Guia de arquitetura e contexto para agentes de IA
├── CHANGELOG.md             # Histórico de alterações do projeto
├── package.json
├── tsconfig.json
├── LICENSE
└── README.md
```

---

## 📜 Licença

Distribuído sob a licença **MIT**. Veja `LICENSE` para mais detalhes.
