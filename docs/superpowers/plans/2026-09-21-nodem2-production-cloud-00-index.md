# Nodem2 Production Cloud Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved nodem2 production stack, single-team authorization, encrypted task audit history, single-admin Operations Console, automated backups, and verified nodem2 rollout.

**Architecture:** Execute four independently reviewable plans in order. Authorization establishes the security boundary; task history adds encrypted auditable content; the operator/deployment plan adds the privileged operational boundary and backup lifecycle; the dashboard consumes those APIs and performs the final production migration.

**Tech Stack:** TypeScript 5.5, Node.js 20+, Express 4, PostgreSQL 16, SQLite/better-sqlite3, React 19, Vite 6, Vitest, React Testing Library, Playwright, Docker Compose v2, systemd, OpenSSH.

**Spec:** `docs/superpowers/specs/2026-09-21-nodem2-production-cloud-design.md`

## Global Constraints

- Sync API, dashboard, operator socket, and PostgreSQL remain loopback/Unix-socket only.
- Nodem2 is one singleton team with exactly one immutable network-admin account.
- Open registration is allowed only while SSH remains the external access boundary.
- Never commit credentials, JWT secrets, PostgreSQL passwords, encryption keys, private keys, or generated backup files.
- Source capture is limited to task-touched Git-tracked text files; reject binaries, generated files, secrets, files over 1 MiB, and captures over 10 MiB.
- Encrypt remote snapshots/diffs with AES-256-GCM and authenticated metadata; keys live under `/etc/ariadne/keys/`.
- The web/container tier never receives Docker-socket or arbitrary-shell access.
- Backup files live under `/var/backups/ariadne`, mode `0600`, with 30-day retention and weekly restore verification.
- Follow RED → GREEN → IMPROVE and commit after every independently reviewable task.
- Use the mandatory TypeScript, React, security-review, Docker, and testing skills when their corresponding implementation phase begins.

---

## Execution Order

1. `2026-09-21-nodem2-production-cloud-01-authorization.md`
2. `2026-09-21-nodem2-production-cloud-02-task-history.md`
3. `2026-09-21-nodem2-production-cloud-03-operator-deployment-backups.md`
4. `2026-09-21-nodem2-production-cloud-04-dashboard-rollout.md`

Do not start a later plan until the previous plan's full validation and review
gate passes. Each plan produces explicit interfaces consumed by the next.

## Baseline Prerequisite

The working tree currently contains previously completed cloud-sync,
cross-workspace, redaction, `ariadne init`, and secure SSH-tunnel work that is
not yet committed. Before Task 1 of Plan 01:

- [ ] Run:

```bash
git status --short
pnpm --filter @ariadne-dev/core exec vitest run
pnpm --filter @ariadne-dev/cli exec vitest run
pnpm --filter @ariadne-dev/mcp-server exec vitest run
ssh root@nodem2 'cd /root/dev/Ariadne/packages/sync-server && set -a && source /etc/ariadne/sync-server.env && set +a && export TEST_DATABASE_URL="${DATABASE_URL%/ariadne}/ariadne_test" && pnpm exec vitest run'
pnpm -r build
```

Expected: core 172 tests, CLI 83 tests, MCP server 53 tests, sync-server 34
tests, and all builds pass.

- [ ] Review the complete uncommitted diff for secrets and unrelated changes:

```bash
git diff --check
git diff --stat
git diff
```

- [ ] Commit the already-completed baseline in logical commits without
  changing behavior:

```bash
git add packages/core packages/cli/src/exec.ts packages/cli/test/exec.test.ts packages/mcp-server
git commit -m "fix(core): preserve task context across commands"

git add packages/sync-server/migrations/0005_subentity_updated_at.sql packages/sync-server/src/routes/sync.ts packages/sync-server/test/routes.test.ts packages/cli/src/syncClient.ts packages/cli/src/syncCommands.ts packages/cli/test/sync.test.ts docs/07-CLOUD-SYNC-API-CONTRACT.md
git commit -m "feat(sync): make curated task records bidirectional"

git add packages/cli/src/skillTemplates.ts packages/cli/src/syncTunnel.ts packages/cli/src/syncConfig.ts packages/cli/src/index.ts packages/cli/test/init.test.ts packages/cli/test/skillTemplates.test.ts packages/cli/test/syncTunnel.test.ts packages/cli/test/cli.test.ts .github README.md docs/05-USER-GUIDE.md packages/sync-server/src/config.ts packages/sync-server/src/index.ts packages/sync-server/test/config.test.ts packages/sync-server/README.md
git commit -m "feat(cli): automate secure nodem2 cloud setup"
```

If file overlap prevents these exact groups, use `git add -p` and preserve the
same three logical outcomes. Include the required Copilot co-author trailer in
each commit.

## Final Aggregate Gate

After all four plans:

- [ ] Run every package test and build:

```bash
pnpm -r build
pnpm -r test
```

- [ ] Run the nodem2 production checklist from Plan 04.
- [ ] Run TypeScript, React, Go-if-applicable, and security reviews against
  the complete branch diff.
- [ ] Confirm `git status --short` contains only deliberate generated release
  artifacts, or is clean.

