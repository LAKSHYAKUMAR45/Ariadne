# Task 10 rollout report

**Status:** BLOCKED  
**Date:** 2026-09-23  
**Reviewed retry revision:** `3ce974cb243aa929c261b66b916880d7926103e1`  
**Deployed revision:** Not deployed; production remained on its pre-rollout image and database.

## Prior blocked attempt preserved

The prior Task 10 attempt stopped before transfer, migration, or cutover because the mandatory safety-backup workflow failed while persisting backup metadata through `psql --command` variable substitution. Production remained unchanged. The failed candidate backup triplet remains preserved as evidence in `/var/backups/ariadne` and is not treated as verified:

- `ariadne-20260923T160535Z.dump` `root:root` mode `0600`, 76323 bytes
- `ariadne-20260923T160535Z.json` `root:root` mode `0600`, 353 bytes
- `ariadne-20260923T160535Z.sha256` `root:root` mode `0600`, 96 bytes

Failure evidence from that attempt:

```text
ERROR: syntax error at or near ":"
LINE 3: set_config('ariadne.backup_filename', :'ariadne_backup...
[ariadne-backup] error: failed to persist backup metadata for ariadne-20260923T160535Z.dump
```

## Retry pre-state

- Local worktree: clean at `3ce974cb243aa929c261b66b916880d7926103e1`.
- nodem2 operator: `active`.
- `ariadne-backup.timer`: `active`.
- `ariadne-backup-verify.timer`: `active`.
- Existing production containers before retry:
  - `ariadne-nodem2-postgres-1`: `postgres:16-bookworm`, healthy.
  - `ariadne-nodem2-sync-server-1`: `ariadne-sync-server:35ea737772e4`, healthy.
- Listeners: `127.0.0.1:4300` and `127.0.0.1:15432` only; no `5432` listener.
- Existing failed backup triplet was still present with root ownership and mode `0600`.

## Reviewed revision transfer and fixed backup-script install

The reviewed commit was transferred to `/opt/ariadne/worktree` by Git bundle and checked out cleanly:

```text
3ce974cb243aa929c261b66b916880d7926103e1
```

The tracked installer was run from that worktree before the backup retry. It preserved existing secrets, key material, and callback token, installed the fixed tracked operation scripts to `/usr/local/lib/ariadne`, reloaded/enabled systemd units, and restarted the operator. Installed script ownership/modes were verified:

- `/usr/local/lib/ariadne/backup`: `root:root` mode `0755`
- `/usr/local/lib/ariadne/lib-common`: `root:root` mode `0644`
- `ariadne-operator.service`: `active`

## Fresh retry safety backup

The mandatory fresh safety backup was created through `ariadne-backup.service` after installing the reviewed backup fix and before any migration or sync-server/database cutover:

- Safety backup basename: `ariadne-20260923T162345Z`
- `sha256sum -c ariadne-20260923T162345Z.sha256`: `OK`
- `pg_restore --list`: succeeded, 158 entries
- Files:
  - `ariadne-20260923T162345Z.dump` `root:root` mode `0600`, 76323 bytes
  - `ariadne-20260923T162345Z.json` `root:root` mode `0600`, 353 bytes
  - `ariadne-20260923T162345Z.sha256` `root:root` mode `0600`, 96 bytes
- Database metadata persisted:
  - `backup_records`: `ariadne-20260923T162345Z.dump|created`

No live production restore was performed. No backup cleanup or pruning of the failed prior triplet was performed.

## Blocker before build/migration/cutover

The tracked deployment harness was invoked for the reviewed SHA after the verified fresh safety backup. It stopped before build, migration, image replacement, or database cutover:

```text
[ariadne-deploy] verifying revision against origin/main
fatal: couldn't find remote ref refs/heads/main
[ariadne-deploy] error: could not fetch refs/remotes/origin/main from origin; refusing to deploy against a stale trusted ref
```

Root-cause evidence: both local and nodem2 `origin` expose `refs/heads/master` and `refs/heads/feat/graphify-integration`, but not `refs/heads/main`. The tracked deploy script currently hard-codes `ARIADNE_TRUSTED_BRANCH=main`, so the approved deployment path refuses to proceed. This is a deployment-contract defect in the reviewed production rollout path, not a runtime health failure.

Per the critical constraints, no source edit, production patch, remote-ref workaround, manual ad hoc cutover, migration, or image replacement was made after this defect appeared.

## Schema/count/admin invariants

Pre-deploy invariant tuple, before the tracked deployment script was invoked:

```text
schema_version|task_count|member_count|active_admins|null_task_team_ids|null_member_team_ids
9|0|1|1|0|0
```

Final invariant tuple after the blocked deploy-script exit:

```text
schema_version|task_count|member_count|active_admins|null_task_team_ids|null_member_team_ids
9|0|1|1|0|0
```

Schema version remains `9`; the required schema version `10` acceptance check was not reached because migrations were not run.

## Final service/container/listener/mount state

- Health endpoint after blocker: `{"ok":true}`
- Containers:
  - `ariadne-nodem2-postgres-1`: `postgres:16-bookworm`, healthy.
  - `ariadne-nodem2-sync-server-1`: `ariadne-sync-server:35ea737772e4`, healthy.
- Services/timers:
  - `ariadne-operator.service`: `active`
  - `ariadne-backup.timer`: `active`
  - `ariadne-backup-verify.timer`: `active`
- Listeners:
  - `127.0.0.1:4300`
  - `127.0.0.1:15432`
  - no `5432`
- Web-container mounts:
  - `/etc/ariadne/keys` mounted read-only
  - `/run/ariadne` mounted read-only at `/run/ariadne-operator`
  - no Docker socket mount

## Rollout and acceptance state

- Build: not reached.
- Migration: not reached.
- Schema version `10`: not reached.
- Sync-server image/container cutover: not reached; previous image/container remained active.
- Operator restart after build: not reached; the earlier installer restart succeeded before backup/deploy.
- Live backup after deployment: not reached.
- Eight-page console acceptance: deferred because no deployment occurred.
- Literal file content rendering: deferred.
- `no-store` response verification: deferred.
- Guarded controls: deferred; no operation IDs were generated.
- Durable operation IDs/states: none generated during deferred guarded-control checks.
- Restart persistence: deferred.
- Deploy/rollback through eligible server-returned SHAs: deferred because the deployment-status/deploy trust path is blocked by the missing `origin/main` trusted ref.
- Test member state: unchanged; activation/deactivation check not reached.
- Test capture deletion: not reached; no capture was deleted.
- Rollback: not performed because no migration/cutover occurred and the existing production service remained healthy.

## Preserved rollback artifacts and production state

- Previous production image `ariadne-sync-server:35ea737772e4` remained running and healthy.
- Existing PostgreSQL container and volume remained running and healthy.
- Prior failed backup triplet `ariadne-20260923T160535Z.*` remains preserved.
- Fresh retry safety backup triplet `ariadne-20260923T162345Z.*` remains preserved and checksum/list verification passed.
- No rollback-image/current-revision/rollback-revision state files were created by the failed deploy attempt before it exited.
- No environment contents, credentials, API tokens, passwords, keys, or secret log values were printed or recorded.

## Deferred defect

**Blocking defect:** the tracked deployment harness refuses every rollout because it fetches the fixed trusted ref `origin/main`, while this repository currently publishes `master` and `feat/graphify-integration` but no `main`. The fix must be reviewed separately before any retry, either by making the tracked trusted ref match the published deployment branch or by publishing the required trusted branch. The next attempt must again start from pre-state checks and a fresh verified safety backup before migration or cutover.

## Bounded deployment-policy fix

**Status:** IMPLEMENTED LOCALLY; not deployed to nodem2.  
**Implementation commit:** `b5e5a7195f24b079c3c948b21791d2eadbeb10c8`

**Root cause:** the production deployment contract intentionally fails closed by fetching the fixed trusted ref before checking immutable SHA reachability. The fixed branch was `main`, but this repository does not publish `origin/main`, so every rollout stopped at the mandatory trusted-ref refresh before build, migration, or cutover.

**Fix:** the fixed, non-user-controlled trusted branch is now `deploy/nodem2`. The mandatory fetch and reachability checks remain unchanged: `deploy` still fetches the trusted branch before trust, maps it to `refs/remotes/origin/deploy/nodem2`, verifies the requested 40-character SHA is a known commit, and requires that SHA to be an ancestor of the trusted tip. The deployment/runbook docs now reiterate that operations are scoped to the Ariadne `ariadne-nodem2` Compose project and must not perform host-wide cleanup or restarts that could disturb unrelated nodem2 workloads.

**RED:** after adding the contract requiring the exact refspec, the old code failed as expected:

```text
FAIL deploy script > fetches only the dedicated nodem2 deployment branch into the trusted remote ref
Expected: origin +refs/heads/deploy/nodem2:refs/remotes/origin/deploy/nodem2
Received: origin +refs/heads/main:refs/remotes/origin/main
```

**GREEN / validation:**

```text
pnpm --filter @ariadne-dev/operator exec vitest run ../../deploy/nodem2/test/deploy.test.ts
# 51 passed

pnpm --filter @ariadne-dev/operator exec vitest run ../../deploy/nodem2/test
# 161 passed

pnpm --filter @ariadne-dev/operator test
# 249 passed

pnpm --filter @ariadne-dev/operator build
# passed

shellcheck deploy/nodem2/scripts/*
# passed
```

Tracked search for stale deployment-policy refs found no `origin/main`,
`refs/heads/main`, `refs/remotes/origin/main`, or `ARIADNE_TRUSTED_BRANCH=main`
references outside the new negative contract assertions.
