# @ariadne-dev/sync-server

Self-hosted cloud sync server for Ariadne. Lets multiple machines/users push
and pull `tasks` and `checkpoints` to/from a shared Postgres database for the
server's singleton team over a small REST API.

See `docs/06-CLOUD-SYNC-DESIGN.md` for the product decisions and
`docs/07-CLOUD-SYNC-API-CONTRACT.md` for the full schema + API contract this
package implements.

## Requirements

- Node.js 20+
- A reachable Postgres 14+ database

## Configuration

Set via environment variables:

| Variable                 | Required | Default | Description                                  |
| ------------------------ | -------- | ------- | --------------------------------------------- |
| `DATABASE_URL`            | yes      | —       | Postgres connection string                    |
| `ENCRYPTION_KEY_DIR`      | yes      | —       | Absolute, owner-only directory containing `active-key-id` and AES-256-GCM key files |
| `SYNC_SERVER_JWT_SECRET`  | yes      | —       | Secret used to sign/verify auth JWTs          |
| `HOST`                    | no       | `127.0.0.1` | Bind address; use `0.0.0.0` only behind a secured reverse proxy or firewall |
| `PORT`                    | no       | `4300`  | Port the HTTP server listens on               |
| `ADMIN_PUBLIC_ORIGIN`     | in production | — | Exact origin the admin dashboard is served from, e.g. `https://ariadne.example.com`. Drives the admin CSRF origin check and the session cookie's `Secure` flag. Plain `http://` is accepted only for a loopback host reached through the approved SSH tunnel. Unset outside production, where no browser origin is trusted at all |
| `DASHBOARD_DIST_DIR`      | for production HTTP server | — | Absolute path containing the built dashboard `index.html` and hashed assets |

## Operations dashboard

The production image serves the single-admin operations console at `/admin`.
For the nodem2 tunnel profile, open:

```text
http://127.0.0.1:14300/admin
```

The complete console provides **Overview**, **Members**, **Tasks**,
**Backups**, **Services**, **Deployments**, **Logs**, and **Audit**. It uses a
browser session plus CSRF token; it never accepts the sync JWT for an admin
route. A password reauthentication is valid for five minutes. Guarded
operations also require the exact confirmation phrase presented by the
dashboard and reach a durable terminal operation state before they count as
successful.

The console is restricted to typed workflows: verified backup download and
restore, `sync-server`/PostgreSQL restart, deploy of a listed trusted SHA,
rollback to the recorded revision, and guarded capture deletion. Restore,
deploy, and rollback create and verify a safety backup first. Logs are bounded
and redacted and are available only for `sync-server`, `operator`,
`deployment`, and `backup`. The web container has no Docker socket and no
arbitrary shell, path, service, journal, or Git input. See
[`deploy/nodem2/README.md`](../../deploy/nodem2/README.md) for the operator
runbook and [`docs/07-CLOUD-SYNC-API-CONTRACT.md`](../../docs/07-CLOUD-SYNC-API-CONTRACT.md)
for route details.

## Running locally

```bash
pnpm install
pnpm --filter @ariadne-dev/sync-server run build

export DATABASE_URL="postgresql://localhost:5432/ariadne_sync"
export ENCRYPTION_KEY_DIR="/etc/ariadne/keys"
export SYNC_SERVER_JWT_SECRET="change-me"

pnpm --filter @ariadne-dev/sync-server run migrate   # applies migrations/*.sql
pnpm --filter @ariadne-dev/sync-server run start      # starts the HTTP server
```

The secure default binds only to loopback. Remote clients should connect
through an SSH tunnel (the project-level `ariadne sync setup` command
automates this) or a TLS reverse proxy. Set `HOST=0.0.0.0` only when network
exposure is intentional and protected.

`pnpm start` (via `src/index.ts`) also runs pending migrations automatically
on boot, so the explicit `migrate` step above is mainly useful for CI/ops
scripts that want migrations applied as a separate, checkable step.

`ENCRYPTION_KEY_DIR` must be an **absolute** path to an owner-only directory
(for example mode `0700`) containing:

```text
/etc/ariadne/keys/
  active-key-id
  <key-id>.key
```

`active-key-id` and every `<key-id>.key` file must be owner-readable only —
mode `0400` or `0600`. Group/world bits, executable bits, and
setuid/setgid/sticky bits are rejected. Each key file must contain either
exactly 32 raw bytes or exactly 64 lowercase hex characters. The active key
encrypts new content; retained older key files stay available for historical
decryption after rotation.

The keyring is deliberately strict about the filesystem it loads from:

- the key directory and every key file must be owned by the effective uid of
  the process loading them (the server loads canonical root-owned `0600` keys
  before dropping privileges, so ownership is checked against the loading uid);
- no component of the path may be a symbolic link, and key files must be
  regular files;
- ancestor directories must be owned by `root` or the effective user, and may
  not be group- or world-writable unless they are sticky-bit protected (e.g.
  `/tmp`, mode `1777`);
- files are opened once with `O_NOFOLLOW`, validated via `fstat` on that same
  descriptor, and read with a bounded read — so the inode that is validated is
  always the inode that is read;
- all filesystem failures surface as `EncryptionKeyringConfigError` carrying
  only the path and errno code, never key material.

The server refuses to start without a loaded keyring: `createApp` requires an
`encryptionKeyring`, so there is no keyless production code path.

## Encrypted task file history

Schema v7 (`migrations/0007_encrypted_task_history.sql`) stores task file
history as ciphertext only, via `src/taskHistoryStore.ts`:

- `encrypted_blobs` — gzip-compressed, AES-256-GCM ciphertext plus nonce, auth
  tag, key id, compression, plaintext SHA-256, plaintext bytes, and compressed
  bytes. Deduplication is `UNIQUE (team_id, plaintext_sha256, blob_type)`, so
  identical plaintext is stored once per team and never shared across teams.
- `task_file_captures` / `task_file_capture_entries` — capture events and their
  per-path snapshot/diff references. Capture identity is team-scoped
  (`PRIMARY KEY (team_id, id)`), so two teams may mint the same local capture id
  and neither can probe for or squat the other's ids. Composite foreign keys
  prove the task, the capture, and both blobs belong to the same team, and pin
  each reference to the correct blob type *and* to the exact expected plaintext
  SHA-256 (`snapshot_sha256` / `diff_sha256`). Swapping in another same-team
  blob, or rewriting a referenced blob's hash, is rejected by the database.
- `task_file_history_deletions` — append-only deletion audit (actor, task,
  capture, deleted paths/counts, reason); `UPDATE`/`DELETE` are blocked by a
  trigger. A table owner can still `TRUNCATE` it; revoking that requires a
  dedicated least-privilege application database role, deferred to plan 03.

Blob AAD is deliberately stable — schema/AAD version, team id, plaintext
SHA-256, blob type, key id, and compression — so one deduplicated ciphertext can
be referenced by many capture entries. Capture/task/path integrity is enforced
by the transactional foreign keys above rather than by per-path AAD. Reads
decrypt, decompress, then re-verify plaintext length and SHA-256 against both
the stored blob and the referencing entry, and fail closed with
`capture_integrity_error` when anything has been tampered with. `readCapture`
runs on a single client inside a `REPEATABLE READ` read-only transaction, so a
capture being deleted concurrently reads as either the whole capture or a
deterministic `capture_not_found`.

`storeCapture` re-validates the client guardrails server side (1 MiB per file,
10 MiB per capture, normalized relative paths, content hash match) before
anything is encrypted, and is idempotent on exact capture replays. Conflicts are
distinguished: `capture_conflict` means the same capture id already exists with
different metadata or entries, while `capture_event_conflict` means a *different*
capture id already records the same commit or checkpoint. Blob work is batched —
one locking read, one multi-row insert, one batched entry insert — so round
trips stay constant as entry count grows.

`deleteCapture` checks the actor's active team membership before capture
existence (so a non-member cannot use 403-vs-404 as an existence oracle), then
deletes entries, deletes the capture event, locks the candidate blobs
`FOR UPDATE` and garbage-collects only those with no remaining references, and
finally writes the immutable audit row. Uploads take `FOR SHARE` locks on the
blobs they reuse, so a concurrent upload and collection either serialize or
retry, and never surface a raw Postgres error (`capture_storage_conflict` is
returned if a lost race survives one retry).

## Local Postgres via Docker

No local Postgres install needed — for local dev/testing, run one in Docker:

```bash
docker run -d --name ariadne-sync-pg \
  -e POSTGRES_PASSWORD=ariadne \
  -e POSTGRES_DB=ariadne_sync \
  -p 5432:5432 \
  postgres:16-alpine
```

## Running the test suite

Tests exercise the real HTTP routes against a real Postgres instance (no
mocking of the database) — spin up a dedicated test database first:

```bash
docker run -d --name ariadne-sync-test-pg \
  -e POSTGRES_PASSWORD=ariadne \
  -e POSTGRES_DB=ariadne_sync_test \
  -p 55432:5432 \
  postgres:16-alpine

pnpm --filter @ariadne-dev/sync-server test
```

`TEST_DATABASE_URL` defaults to
`postgresql://postgres:ariadne@localhost:55432/ariadne_sync_test` (matching
the container above); override it if you use a different host/port/db name.
Each test file resets the shared test database's schema/data before it runs
(`test/globalSetup.ts` drops+recreates the `public` schema once for the
whole run; `routes.test.ts` also `TRUNCATE`s between individual tests), so
the suite is safe to re-run repeatedly without manually resetting the
container.

## Production deployment (nodem2 Compose stack)

The tracked production stack lives in `deploy/nodem2/` and is the only
supported way to run this package in production:

| Path | Purpose |
| ---- | ------- |
| `deploy/nodem2/compose.yaml` | `postgres`, one-shot `migrate`, and `sync-server` services (fixed project name `ariadne-nodem2`) |
| `deploy/nodem2/sync-server.Dockerfile` | Multi-stage Node 20 image: build stage compiles TypeScript, runtime stage carries only `pnpm deploy --prod` output |
| `deploy/nodem2/scripts/deploy` | Deploy one trusted revision, with migration, health verification, and rollback |
| `deploy/nodem2/scripts/restart-sync-server` / `restart-postgres` | Restart exactly one service, then wait (bounded) for `pg_isready` and `/healthz` before reporting success |
| `deploy/nodem2/scripts/sync-server-entrypoint` | Container entrypoint that performs the key handoff and permanent privilege drop |
| `deploy/nodem2/.env.example` | Variable **names** only — never values |

Fixed host layout (the scripts never accept these as arguments):

```text
/opt/ariadne/worktree                      # detached deployment worktree
/opt/ariadne/worktree/deploy/nodem2/compose.yaml
/etc/ariadne/compose.env                   # root-owned 0600
/etc/ariadne/sync-server.env               # root-owned 0600
/etc/ariadne/keys/                         # root-owned 0700, keys 0600
/var/lib/ariadne/deploy/rollback-image     # recorded rollback target
```

### Deploying

```bash
/opt/ariadne/worktree/deploy/nodem2/scripts/deploy <40-char-commit-sha>
```

The script requires all secret/key files before touching Compose, rejects a
dirty worktree and any revision that is not reachable from the configured
trusted ref (`origin/main`), validates `docker compose config --quiet` before
building, builds the immutable candidate tag `ariadne-sync-server:<sha>` from the
`build.context` declared for `sync-server`/`migrate` (the checked-out worktree
root), runs migrations as a one-shot `migrate` service *before* replacing the
app, polls `http://127.0.0.1:4300/healthz`, and rolls the `sync-server` service
back to the previously deployed image when health verification fails. It never
prints secret values.

Caution: plain `docker compose config` renders every `env_file` value into its
output. Only `docker compose config --quiet` is safe to run where output may be
captured or logged.

The fixed paths above cannot be redirected by the environment: any deployment
invocation carrying `ARIADNE_DEPLOY_ROOT`/`ARIADNE_DEPLOY_ETC`/
`ARIADNE_DEPLOY_STATE`/`ARIADNE_DEPLOY_SELFTEST` fails before Docker runs. The
contract tests drive the same tracked scripts with `ARIADNE_DEPLOY_SELFTEST=1`,
which is itself refused when the caller is root or when the scripts are the copy
installed under `/opt/ariadne`.

### Runtime hardening and the root-owned key handoff

`sync-server` and `migrate` run with `read_only: true`, tmpfs `/tmp` and `/run`,
`cap_drop: [ALL]`, `no-new-privileges:true`, and publish only
`127.0.0.1:4300:4300`. No Docker socket is ever mounted.

Canonical keys stay root-owned `0600` on the host and are mounted read-only at
`/etc/ariadne/keys`. Because the keyring validates ownership against the
effective uid (see above), the entrypoint starts as root *only* to copy the key
bytes into the in-memory tmpfs directory `/run/ariadne/keys`, give it to
UID/GID `10001`, and then `exec setpriv --reuid --regid --clear-groups
--inh-caps=-all --no-new-privs` the Node process. Host permissions are never
weakened, and the listener never runs as root.

That transition needs exactly three capabilities back (`CHOWN`, `SETGID`,
`SETUID`) on top of `cap_drop: [ALL]`; they are consumed by the entrypoint
before `exec` and are not retained. Verified in the built image:

```text
uid 10001 gid 10001 groups [ 10001 ]
keydir uid 10001 mode 700 (active-key-id, primary.key both uid 10001 mode 600)
CapInh: 0 | CapPrm: 0 | CapEff: 0 | NoNewPrivs: 1
canReadCanonical EACCES   canWriteRootFs EROFS   keyring loaded
```

Deployment contract tests (fake `docker`/`git`/`curl`) live in
`deploy/nodem2/test/deploy.test.ts`:

```bash
pnpm --filter @ariadne-dev/operator exec vitest run ../../deploy/nodem2/test/deploy.test.ts
docker compose -f deploy/nodem2/compose.yaml --env-file deploy/nodem2/.env.example config --quiet
```

### Operation result reporting

The privileged operator reports every operation it runs to
`POST /api/v1/admin/operations/:id/callback` (root-created shared credential,
loopback only). Because a `service_restart` operation takes that very endpoint
down while its own result is being reported, two properties hold together:

- the restart scripts do not exit until `/healthz` (and, for postgres,
  `pg_isready`) answers again, within a fixed attempt/interval budget, and fail
  the operation when it never does; and
- the operator retries a report with bounded exponential backoff on transport
  failures and 5xx rejections, never on a 4xx the web tier would keep refusing.
  A redelivered report that matches the state already recorded is accepted as
  success, so a retry can never append a duplicate event or reopen an
  operation.

Backup operations additionally hand the web tier one small, strictly validated
description of the artifact they acted on — filename, checksum, size,
timestamp, and a short sanitized message, all derived from the backup's own
sidecars via a private result file (`ARIADNE_RESULT_FILE`). Command output is
never parsed for this. The description is written to `backup_records` inside
the same transaction as the terminal state change, so `backup_create`,
`backup_verify`, and `backup_restore` outcomes (including failures of the
latter two) are always recorded against the backup they examined.

The same shell library also closes the scheduled/manual gap: when no private
result file is present, `backup` and `verify-backup` upsert the validated
`backup_records` row directly via fixed `psql --set ... current_setting(...)`
inputs, and `restore-backup` records only the fresh pre-restore safety backup
before the application is stopped or the canonical database name is swapped.

## API surface

Summary (full detail in `docs/07-CLOUD-SYNC-API-CONTRACT.md`):

- `GET /healthz` — liveness check, no auth.
- `POST /api/v1/auth/register` — create an account (`username`, `password`) and return the assigned singleton-team role (`admin` for the first account, `member` thereafter).
- `POST /api/v1/auth/login` — returns a JWT bearer token.
- `GET /api/v1/admin/members` / `PATCH /api/v1/admin/members/:userId` — temporary bearer-authenticated singleton-admin member management. Only the active singleton admin can use these routes, and the admin role itself is immutable here.
- `POST /api/v1/sync/tasks` — push (create/update) tasks. Requires auth.
- `GET /api/v1/sync/tasks?since=<ISO8601>` — pull tasks updated after `since`. Requires auth.
- `POST /api/v1/sync/checkpoints` — push checkpoints (insert-only/immutable). Requires auth.
- `GET /api/v1/sync/checkpoints?taskRemoteId=<id>&since=<ISO8601>` — pull checkpoints for a task. Requires auth.

Access is shared within the singleton team: any active member can
read/write any task or checkpoint in that team, while inaccessible task IDs
are hidden with `404 Not Found` rather than exposed cross-team.
