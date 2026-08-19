# 🌸 SILICONFLOWER

![Version](https://img.shields.io/badge/version-0.2.4-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20PowerShell-0078D6.svg)
![Bun](https://img.shields.io/badge/Bun-%3E%3D1.3-black.svg)
![Node](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)

Agente de IA em terminal (CLI/TUI) de alta performance para desenvolvimento de software no Windows. Integra **34 ferramentas nativas**, **Subagentes Concorrentes & Background Tasks**, **Memória Persistente**, **Git Worktrees**, **RepoMap**, **Busca Web** e **Protocolo MCP**, compatível com **SiliconFlow, OpenRouter, OpenAI e Anthropic**.

<p align="center">
  <img src="assets/preview.png" alt="SiliconFlower TUI Preview" width="100%" />
</p>

---

## ✨ Recursos Principais

- 🤖 **Subagentes & Background Tasks**: Spawning de agentes autônomos com papéis dedicados (`research`, `verification`, `plan`, `coder`, `custom`) em segundo plano.
- 🧠 **Memória Persistente & Workspace Limpo**: Armazena preferências, regras e contexto do projeto de forma isolada em `~/.siliconflower/workspaces/<workspace-id>/memory/`, mantendo o repositório do projeto 100% limpo sem pastas visíveis no workspace (estilo Antigravity e harnesses modernos).
- 🌳 **Git Worktrees Isolados**: Testes e refatorações em branches temporárias sem afetar a área de trabalho atual.
- 🗺️ **RepoMap & Símbolos**: Mapeamento estrutural de código (TS, JS, Python, Go, Rust, C/C++) com baixo consumo de tokens.
- ⚡ **Raciocínio & Modos de Operação**: Controle de *reasoning effort* / *thinking tokens* (`Ctrl+E`) e modos de segurança (`Ctrl+O`: `programação`, `sistema`, `plano`).
- 🧩 **Ecossistema MCP & Hooks**: Suporte nativo ao Model Context Protocol e automações disparadas por eventos do ciclo de vida (`preTool`, `postTool`, `onEdit`, `onCommand`, `onSessionStart`, `onSessionEnd`).
- 📦 **Binário Nativo Standalone**: Compilação para `.exe` único via Bun, sem necessidade de Node.js instalado.

---

## 🚀 Início Rápido

### Pré-requisitos
- [Bun >= 1.3](https://bun.sh) *(recomendado)* ou Node.js >= 20.

```powershell
# 1. Clonar e instalar dependências
git clone https://github.com/siliconflower/siliconflower.git
cd siliconflower
bun install

# 2. Iniciar (abre o wizard de configuração na 1ª execução)
bun run start
```

### Compilar e Instalar no PATH do Windows
```powershell
bun run build          # Gera dist/siliconflower.exe
npm run install:bin    # Adiciona ao PATH do usuário
siliconflower          # Executa a partir de qualquer pasta
```

---

## ⚙️ Configuração & Armazenamento Isolado

As configurações globais e dados do Siliconflower ficam organizados em `~/.siliconflower/`:

- **Configurações:** `~/.siliconflower/config.json`
- **Habilidades (Skills):** `~/.siliconflower/skills/`
- **Memórias Globais:** `~/.siliconflower/memory/`
- **Artefatos Globais:** `~/.siliconflower/artifacts/`
- **Workspaces Isolados:** `~/.siliconflower/workspaces/<workspace-id>/` (armazena memórias, artefatos e hooks do projeto sem poluir o repositório local)
- **Logs:** `~/.siliconflower/logs/`
- **Saídas Truncadas:** `~/.siliconflower/outputs/`

```json
{
  "provider": "openai",
  "baseURL": "https://api.siliconflow.com/v1",
  "apiKey": "sk-...",
  "model": "deepseek-ai/DeepSeek-V4-Pro",
  "reasoning": "high",
  "mode": "programação"
}
```

### Comandos de Gerenciamento & Flags CLI
```powershell
bun run start -- config       # Reabre o assistente de configuração
bun run start -- show         # Exibe a configuração ativa e ID do workspace
bun run start -- -m <model> -r <level> --mode <mode>  # Executa com parâmetros específicos
```

> **Variáveis de Ambiente (Fallback):** `SILICONFLOWER_API_KEY`, `SILICONFLOWER_BASE_URL`, `SILICONFLOWER_MODEL`.

---

## ⌨️ Atalhos & Modos de Operação

### Atalhos no Terminal (TUI)
| Atalho | Ação |
| :--- | :--- |
| `Enter` | Envia a mensagem |
| `Ctrl+E` | Alterna o nível de raciocínio (`none` ➔ `low` ➔ `medium` ➔ `high`) |
| `Ctrl+O` | Alterna o modo de operação (`programação` ➔ `sistema` ➔ `plano`) |
| `Ctrl+C` | Cancela geração em andamento / Pressione 2x para sair |

### Modos de Segurança
- **`programação`**: Acesso completo a ferramentas de código, leitura, escrita e testes.
- **`sistema`**: Focado em administração de SO, processos e scripts PowerShell.
- **`plano`**: Modo seguro *apenas leitura* — bloqueia edições de arquivo e comandos modificadores.

No modo `plano`, ferramentas desconhecidas e ferramentas MCP também são bloqueadas por padrão. Apenas a lista nativa explicitamente classificada como leitura pode ser usada; subagentes, worktrees, persistência e cancelamento de tarefas ficam indisponíveis.

---

## 🛠️ Ferramentas Nativas (34 Ferramentas)

O Siliconflower disponibiliza um conjunto completo de ferramentas integradas:

- 📁 **Arquivos & Edição**: `read_file`, `write_file`, `edit_file` (fuzzy/newline matching), `apply_patch`, `list_directory`, `create_directory`, `move_path`, `delete_path`, `file_info`.
- 🔍 **Busca & Navegação**: `search_files` (glob), `grep_content` (regex), `repo_map`, `find_symbol`.
- 💻 **Execução & Tarefas**: `execute_command` (PowerShell arbitrário com os privilégios do usuário), `read_logs`, `ask_question`, `todowrite`, `read_skill`.
- 🤖 **Subagentes & Async**: `run_task`, `send_subagent_message`, `manage_background_task`.
- 🧠 **Memória & Worktrees**: `save_memory`, `recall_memory`, `forget_memory`, `enter_worktree`, `exit_worktree`, `list_worktrees`.
- 📄 **Artefatos & Web**: `create_artifact`, `read_artifact`, `list_artifacts`, `delete_artifact`, `web_fetch` (HTML para Markdown), `web_search`, `manage_hooks`.

> 📖 Para a documentação técnica detalhada das ferramentas e arquitetura, consulte o [LLMS.md](LLMS.md).

---

## 🧩 Extensibilidade

### Servidores MCP (`~/.siliconflower/config.json`)
```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:/Workspace"]
    }
  }
}
```

As ferramentas MCP são anunciadas à LLM com nomes qualificados e estáveis no formato `mcp_<servidor>_<ferramenta>_<hash>`. Isso evita colisões entre servidores ou com ferramentas nativas; o nome original continua sendo usado ao chamar o servidor.

### Testes e diretório de dados alternativo

Defina `SILICONFLOWER_DATA_DIR` para redirecionar configurações e dados persistentes para outro diretório. A suíte de testes usa essa variável automaticamente e nunca escreve no perfil real do usuário.

### Hooks de Automação
```json
{
  "hooks": {
    "onEdit": "bun x tsc --noEmit",
    "postTool": "git status --short"
  }
}
```

### Habilidades Customizadas (Skills)
Crie arquivos Markdown em `~/.siliconflower/skills/` com instruções especializadas. O agente as carrega sob demanda com `read_skill`.

---

## 📁 Estrutura do Projeto

```text
siliconflower/
├── src/
│   ├── core/           # Hooks e ciclo de vida (preTool, postTool, etc.)
│   ├── services/       # Subagentes, RepoMap, Memória, Worktrees, Artefatos, Web
│   ├── App.tsx         # Interface TUI (Ink / React)
│   ├── llm.ts          # Adaptador unificado OpenAI / Anthropic com streaming
│   ├── tools.ts        # Registro central das 34 ferramentas nativas
│   └── index.tsx       # CLI e comandos de entrada
├── scripts/            # Scripts de instalação no Windows PATH
├── tests/              # Suíte de testes unitários (bun test)
├── build.ts            # Pipeline de compilação Bun (.exe standalone)
└── LLMS.md             # Guia de arquitetura e referência técnica
```

---

## 📜 Licença

Distribuído sob a licença **MIT**. Veja [LICENSE](LICENSE) para mais informações.
