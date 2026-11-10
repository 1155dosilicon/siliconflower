# Contribuindo com o Siliconflower

O projeto é pequeno e focado. As contribuições costumam ser de três tipos:

1. Relatos de bug e pedidos de recurso: abra uma issue primeiro.
2. Correções de documentação: abra o PR direto.
3. Mudanças no código: abra um PR seguindo as orientações abaixo.

## Ambiente

```bash
git clone https://github.com/1155dosilicon/siliconflower.git
cd siliconflower
bun install
bun run typecheck
bun test
bun run dev -- gui   # sem subcomando, só mostra a ajuda
```

Requisitos: Windows ou Linux em x86_64 (macOS e ARM não são suportados), Bun >= 1.3 (recomendado) ou Node >= 20 com `tsx`.

Para mexer no app de desktop (`desktop/`, projeto à parte):

```bash
bun install --cwd desktop
bun run typecheck:desktop
bun run build          # uma vez, ou quando o agente mudar: o app usa dist/siliconflower (dist/siliconflower.exe no Windows)
bun run desktop
bun run desktop:dist   # gera o pacote da plataforma atual em dist-desktop/ (.deb e AppImage no Linux, instalador .exe no Windows)
```

O mesmo código roda em Windows e Linux/Unix. O que é próprio de cada sistema passa por `src/platform.ts` e está listado em `docs/PLATAFORMAS.md`. O CI roda typecheck e testes nos dois; se você não tem um dos sistemas, deixe o CI testar e diga isso no PR.

O mapa do código, os comandos e as regras que já evitaram bugs estão em [AGENTS.md](AGENTS.md). A arquitetura detalhada está em [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Estilo

- TypeScript em modo strict. Sem `any`, exceto ao envolver respostas de SDK.
- Textos para o usuário e prompts em pt-BR. Logs, campos de protocolo e saídas lidas por máquina em ASCII.
- Unicode decorativo só nos indicadores de status já existentes da interface. Mensagens operacionais precisam fazer sentido mesmo num terminal que não mostra esses símbolos.
- Prefira `void promise.catch(...)` a caminhos de promise sem tratamento. `log()` nunca deve lançar exceção.
- Saída do modelo não é confiável: valide caminhos e argumentos.

## Fluxo de pull request

1. Faça um fork e crie uma branch a partir de `main`.
2. `bun run typecheck` e `bun test` precisam passar.
3. Adicione ou atualize testes do comportamento alterado. Correções de bug ganham um teste em `tests/regressions.test.ts`.
4. Registre a mudança em `CHANGELOG.md`, seção `[Unreleased]`, com **uma linha** por item. O CI recusa mudanças em `src/`, `desktop/src/`, `scripts/` ou `bin/` sem linha no CHANGELOG; refatorações e testes que não afetam ninguém levam `[skip changelog]` na mensagem do commit.
5. Confira as docs, mesmo que não precisem mudar: o template do PR lista quais. `tests/docs-sync.test.ts` pega versão, ferramentas e comandos fora do README.
6. Na descrição do PR, explique a motivação, a mudança e qualquer impacto em compatibilidade.

## Lançando uma versão

```bash
bun run release 0.11.0   # versão nos 3 arquivos, badge do README e [Unreleased] -> [0.11.0]
```

O script recusa versão menor que a atual, `[Unreleased]` vazio e mudanças sem commit. Ele não faz commit: mostra o que mudou no código e nas docs desde a última tag, para conferir se README, `docs/` e `SECURITY.md` acompanham, e depois os comandos de commit, tag e push. A tag `vX.Y.Z` dispara `.github/workflows/release.yml`, que gera os pacotes e cria a release em rascunho com a seção do CHANGELOG como descrição; revise e publique à mão.
