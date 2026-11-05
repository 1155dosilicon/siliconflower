# Modelo de segurança

O Siliconflower roda um agente de IA com acesso real à sua máquina. As proteções abaixo são intencionais. Se você encontrar uma forma de contorná-las, reporte como bug.

## O que o agente pode fazer

Depois de configurado, o modelo pode usar ferramentas que:

- leem, criam, editam, movem e listam arquivos (caminhos relativos são resolvidos a partir do `cwd`);
- buscam arquivos e conteúdo recursivamente;
- excluem arquivos e pastas (`delete_path`);
- executam qualquer comando de shell (`execute_command`: PowerShell no Windows, `$SHELL` em Linux/Unix) com os mesmos privilégios do usuário;
- iniciam os servidores MCP configurados, seja qual for o executável.

**Não há sandbox.** O agente tem os mesmos privilégios de quem roda o `siliconflower`.

## Proteções embutidas

- **`delete_path`** exige `confirm: true` em qualquer exclusão. Raízes de disco, a pasta do usuário, o diretório atual e as pastas acima deles não podem ser removidos por essa ferramenta.
- **Caminhos sensíveis** (`C:\Windows\System32`, `SysWOW64`, `/etc`, `/root`, `/boot`, `.ssh`, `.aws`, inclusive via junction ou link simbólico) são bloqueados no caminho passado às ferramentas de arquivo, busca e grep.
  - Nas buscas recursivas, `grep_content` sempre pula pastas ocultas.
  - `search_files` pula pastas ocultas, a menos que receba `includeHidden: true`; nesse caso pode **listar nomes** dentro delas, mas a leitura continua bloqueada.
- **`web_fetch`** bloqueia:
  - localhost e IPs privados ou reservados, inclusive em redirecionamentos;
  - formas IPv6 que embutem IPv4 (`::ffff:7f00:1`, `::ffff:127.0.0.1`, IPv4-compatible, NAT64 `64:ff9b::/96`);
  - IPv6 multicast e link-local.

  Também limita tempo de resposta e tamanho do corpo.

  **Limitação conhecida:** o hostname é resolvido uma vez para validação e de novo, de forma independente, pelo cliente HTTP. Um DNS malicioso que mude a resposta entre as duas consultas (*DNS rebinding*) contorna a checagem, e não há forma sem dependências de fixar o IP validado no Bun. Não use `web_fetch` com URLs controladas por terceiros apontando para endpoints internos sensíveis.
- **Modo `plano`** usa uma allowlist explícita: leitura, buscas, web, perguntas e checklist da sessão.
  - Bloqueia MCP, subagentes e qualquer mutação persistente.
  - Hooks de ferramenta ficam desligados, mas `onSessionStart` e `onSessionEnd` configurados inline continuam rodando e podem executar comandos.
- **Modos `programação` e `sistema`** só mudam o foco do prompt. Nenhum dos dois limita privilégios.
- **Regras do prompt de sistema** pedem ao modelo que trate conteúdo de arquivos, web e ferramentas como dado, não como instrução, e que confirme ações destrutivas. São orientações ao modelo, não barreiras: uma injeção de prompt ainda pode ter sucesso.
- **Subagentes `research` e `plan`** seguem a allowlist do modo `plano`, imposta no código. Os demais papéis têm as mesmas ferramentas nativas do agente principal, exceto `run_task`.
- **`config.json`**, que guarda a chave de API, é gravado com permissão `0600` em Linux/Unix, e um arquivo antigo mais aberto é corrigido ao ser lido. Um arquivo somente leitura (ex.: na store do Nix) continua como está, e com ele a permissão que tiver.
- **`read_media`** envia o conteúdo do arquivo ao provedor configurado.
- **`execute_command`** é, por design, um shell arbitrário. As proteções das ferramentas de arquivo **não** se aplicam a comandos de shell.

## Interface gráfica (`siliconflower gui`)

A página controla um agente que executa comandos, e qualquer site aberto no navegador pode tentar acessar portas locais. Por isso:

- o servidor escuta só em `127.0.0.1`;
- cada execução gera um token aleatório de 256 bits. A URL com o token troca por um cookie `HttpOnly` e `SameSite=Strict` e redireciona, tirando o token da barra de endereços e do histórico;
- toda requisição precisa do cookie e do cabeçalho `Host` esperado, o que barra *DNS rebinding*. O WebSocket também confere `Origin`, o que barra outros sites;
- a CSP bloqueia scripts inline e de terceiros, conexões externas, imagens externas e uso em frames;
- o texto do modelo e das ferramentas nunca vira HTML: tags aparecem como texto, links só aceitam `http`, `https` e `mailto`, e imagens viram links, sem carregar nada;
- a chave de API não é enviada à página.

**Limitações:** a conexão local não é criptografada, e outro programa rodando na sua conta consegue ler o token (na linha de comando do navegador, nos dados do navegador ou na saída do terminal). A interface não é uma barreira contra software local: ela tem os mesmos privilégios do resto do agente. Não exponha a porta com proxy ou túnel e não compartilhe a URL.

## Conversas salvas

A GUI e o app guardam as conversas em `~/.siliconflower/workspaces/<projeto>/sessions/`, **em texto puro**. Isso inclui suas mensagens e a saída das ferramentas: um arquivo `.env` que o agente tenha lido, por exemplo, fica nelas. A chave de API do provedor não é gravada, mas um segredo que passe pela conversa é. Os arquivos ficam com as permissões da sua conta: em Linux/Unix, confira que `~/.siliconflower` não é legível por outros usuários (o `config.json` é gravado com `0600`, mas as conversas seguem a `umask`). Apague pelo **×** na lateral o que não deve ficar guardado. De imagens, áudios e vídeos lidos com `read_media`, só o caminho é gravado; o conteúdo vai ao provedor, mas não para o disco.

## App de desktop (`desktop/`)

A janela mostra a mesma página, com texto vindo do modelo e de repositórios, e usa as mesmas proteções do servidor, inclusive o token: outros programas e sites continuam podendo tentar acessar a porta local. Além disso:

- as janelas rodam com `sandbox` e `contextIsolation`, sem Node. A janela de um projeto não tem nenhuma ponte com o processo principal; só a tela inicial, página local, tem uma, e o processo principal confere o remetente e os argumentos;
- a chave de API não vai para a tela de configurações, que recebe no máximo `***1234`. **Testar conexão** envia a chave ao endereço escrito no formulário, e a resposta do provedor é filtrada para não exibi-la;
- a página só pede para abrir um projeto que já está nos recentes. Uma pasta nova só vem do seletor nativo, escolhida pelo usuário;
- a janela só navega na origem do seu servidor local. Links abrem no navegador padrão, e só `http` e `https`;
- todas as permissões são negadas, menos escrever na área de transferência (botão **Copiar**), e downloads são cancelados;
- cada projeto tem sessão própria, em memória, então o cookie de um não chega ao outro;
- a URL com o token só passa pelo pipe entre o app e o agente e nunca vai para o log.

- no app instalado, os *fuses* do Electron desligam o uso do executável como interpretador Node (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`), e ele só carrega o código de dentro do próprio pacote, com integridade verificada.

**Limitação:** o AppImage e o instalador do Windows ainda não são assinados, então não há como conferir a origem do arquivo (no Windows, o SmartScreen pode avisar ao executá-lo). Baixe só de uma fonte em que confia.


## Instruções de projeto vêm do repositório

`SILICONFLOWER.md` e `AGENTS.md` são enviados ao modelo como instruções do projeto, procurados na pasta atual e nas pastas acima dela. Num repositório clonado de terceiros, esses arquivos podem conter instruções maliciosas (*prompt injection*), por exemplo para rodar comandos ou enviar arquivos para fora. Leia esses arquivos antes de abrir o agente num repositório que você não conhece.

## O que você ainda deve fazer

- **Trate a chave de API como senha.** `show` mostra a chave mascarada, mas `~/.siliconflower/config.json` é texto puro. Para manter a chave fora desse arquivo, deixe o campo vazio e use `SILICONFLOWER_API_KEY`. Valores de ambiente nunca são gravados no `config.json`, nem pelo assistente `config`.
- **Não use `--mode` como barreira de permissão.** Ele só define o foco do modelo.
- **Revise o log** (`siliconflower logs`) de vez em quando, principalmente depois de sessões longas.
- **Servidores MCP de terceiros não são auditados por este projeto.** Ao configurar um, você confia nele.

## Reportando uma vulnerabilidade

Abra um *security advisory* privado no GitHub (aba Security → Report a vulnerability). Não abra issues públicas para suspeitas de vulnerabilidade.
