## O que muda e por quê

<!-- A motivação e a mudança, em poucas linhas. -->

## Checklist

- [ ] `bun run typecheck` e `bun test` passam
- [ ] Teste novo ou atualizado (bug corrigido ganha teste em `tests/regressions.test.ts`)
- [ ] Uma linha por item em `CHANGELOG.md`, seção `[Unreleased]`
- [ ] Docs conferidas, mesmo que não precisem mudar:
  - [ ] `README.md` (o que quem usa vê: recursos, configuração, comandos, diagnóstico)
  - [ ] `docs/ARCHITECTURE.md` (fluxo, protocolo, limites e timeouts citados)
  - [ ] `docs/PLATAFORMAS.md` (se criou ou removeu diferença entre Windows e Linux)
  - [ ] `SECURITY.md` (se mexeu em garantias de segurança)
- [ ] Testado em: <!-- Windows, Linux, ou "só no CI" -->
