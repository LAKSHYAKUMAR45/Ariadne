# Nodem2 Production Cloud Design

**Date:** 2026-09-21  
**Status:** Approved design  
**Scope:** Reproducible nodem2 deployment, local scheduled PostgreSQL
backups, explicit single-team authorization, encrypted task file history,
and a single-admin operations dashboard for Ariadne cloud sync.

## 1. Goals

1. Replace the manually assembled nodem2 deployment with version-controlled,
   repeatable infrastructure.
2. Produce tangible daily PostgreSQL backup files on nodem2, retain them for
   30 days, and verify weekly that the newest backup can be restored.
3. Replace the implicit flat-access model with an explicit team-membership
   authorization boundary.
4. Preserve all existing users, tasks, remote IDs, timestamps, and sync
   behavior during migration.
5. Keep the sync API and PostgreSQL inaccessible from the network except
   through the existing SSH tunnel.
6. Provide one admin with a secure operations dashboard for health, users,
   tasks, backups, services, logs, and deployments.
7. Reconstruct how a task was completed using commands, commits, checkpoints,
   decisions, encrypted file snapshots, and diffs.

## 2. Non-goals

- Multi-team tenancy in the first release.
- Per-task invitations or owner-only task visibility.
- Off-node/object-storage backups.
- Arbitrary repository browsing or uploading every repository file.
- Editing repository files through the dashboard.
- Recording every file save or keystroke.
- Replacing username/password authentication or JWTs.
- Exposing the sync server directly through HTTP, HTTPS, or a public reverse
  proxy.

## 3. Deployment Architecture

### 3.1 Tracked artifacts

The repository will contain:

```text
deploy/nodem2/
  compose.yaml
  sync-server.Dockerfile
  env.example
  scripts/
    deploy.sh
    backup.sh
    verify-backup.sh
    restore.sh
  systemd/
    ariadne-operator.service
    ariadne-backup.service
    ariadne-backup.timer
    ariadne-backup-verify.service
    ariadne-backup-verify.timer

packages/
  dashboard/
  operator/
```

The root package scripts will expose stable entry points:

```text
pnpm deploy:nodem2
pnpm backup:nodem2
pnpm verify-backup:nodem2
```

The scripts are wrappers around the tracked deployment assets; they do not
embed credentials.

### 3.2 Compose services

`deploy/nodem2/compose.yaml` defines:

- `postgres`
  - PostgreSQL 16 Alpine.
  - Persistent named volume for `/var/lib/postgresql/data`.
  - Bound to `127.0.0.1:5432` only when a host port is needed.
  - `unless-stopped` restart policy.
  - Health check using `pg_isready`.
- `sync-server`
  - Built from the tracked multi-stage Dockerfile.
  - Serves the dashboard's built static assets under `/admin`.
  - Depends on healthy Postgres.
  - Runs pending migrations during application startup.
  - Bound to `127.0.0.1:4300`.
  - `unless-stopped` restart policy.
  - Health check against `/healthz`.

The application container connects to Postgres over the private Compose
network, not through the host-published database port.

### 3.3 Secrets and state

The deploy script reads production secrets from:

```text
/etc/ariadne/sync-server.env
```

The file remains root-owned with mode `0600` and contains at least:

```text
POSTGRES_USER
POSTGRES_PASSWORD
POSTGRES_DB
SYNC_SERVER_JWT_SECRET
ARIADNE_FILE_KEYRING_PATH
```

No secret value is copied into the repository, Compose file, image, command
line, service log, or backup metadata. The Compose project receives the
environment file through an explicit `--env-file` argument.

Persistent state lives in:

- Docker volume `ariadne-pg-data` for active PostgreSQL data.
- `/var/backups/ariadne/` for timestamped backup files.
- `/etc/ariadne/keys/` for root-owned file-content encryption keys.

### 3.4 Deployment command

`deploy/nodem2/scripts/deploy.sh` is idempotent and performs:

1. Verify Linux, Docker, Docker Compose v2, required files, and root access.
2. Verify `/etc/ariadne/sync-server.env` exists and is mode `0600`.
3. Validate the Compose configuration.
4. Create a pre-deployment logical backup when an existing database is
   reachable.
5. Build the sync-server image.
6. Start/update Postgres and wait for its health check.
7. Start/update the sync server and allow application startup to apply
   migrations.
8. Wait for `/healthz` through nodem2 loopback.
9. Install/refresh the tracked backup systemd units and timers.
10. Install/refresh the root-owned operator service and Unix socket.
11. Verify dashboard login and the admin API.
12. Print service health and the newest backup path.

The script uses strict shell settings, invokes commands as argument arrays
where possible, validates resolved paths, and never removes broad
directories.

### 3.5 Migration from the current deployment

The rollout must not reuse or delete the current database container until a
safety dump exists and has passed a checksum check.

The migration sequence is:

1. Record current user/task/sub-entity counts.
2. Create and checksum a safety dump from the current `ariadne-pg`
   container.
3. Stop the manually created `ariadne-sync-server.service`.
4. Start the tracked Compose stack using the existing
   `ariadne-pg-data` volume.
5. Apply schema migrations.
6. Verify recorded counts and `/healthz`.
7. Run a push/pull smoke test through the SSH tunnel.
8. Disable/remove only the superseded manually authored service after the
   Compose stack is healthy.

If any verification fails, stop the new application service and retain the
database volume, safety dump, old service unit, and logs for rollback.

## 4. Single-Team Authorization

### 4.1 Model

Nodem2 hosts exactly one Ariadne team. All active team members may read and
write all tasks in that team. This preserves collaboration while replacing
the current implicit “any authenticated user can access every row” behavior
with an explicit authorization boundary.

The first registered account creates the singleton team and receives the
`admin` role. Later open registrations join that team as `member`.

Open registration is acceptable for this deployment because:

- The API is bound to nodem2 loopback.
- Clients can reach it only through authenticated SSH access.
- Therefore, the practical admission boundary remains nodem2 SSH access.

This assumption must be revisited before exposing the API through a network
listener or reverse proxy.

### 4.2 Schema

A new migration creates:

```sql
teams (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
)

team_memberships (
  team_id UUID NOT NULL REFERENCES teams(id),
  user_id UUID NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (team_id, user_id)
)
```

It also adds:

```sql
tasks.team_id UUID REFERENCES teams(id)
```

Backfill behavior:

1. Create one singleton team.
2. Add every existing user to it.
3. Select the oldest existing user as `admin`; all others become `member`.
4. Assign every existing task to the singleton team.
5. Make `tasks.team_id` non-null after the backfill.
6. Add indexes for membership lookup and team-scoped task pagination.

Sub-entities inherit authorization through `task_id`; they do not duplicate
`team_id`.

### 4.3 Registration and authentication

Registration runs transactionally:

- If no team exists, create it and make the new user an active admin.
- Otherwise, create the user as an active member of the singleton team.

Login remains username/password based and returns the existing user JWT.
Membership is not trusted from JWT claims; the server queries active
membership on each protected request so disabling membership takes effect
without waiting for token expiry.

### 4.4 Authorization rules

Every sync request must resolve an active membership before data access.

- Task create: assign the caller's team.
- Task update: require the remote task to belong to the caller's team.
- Task incremental pull and browse: filter by caller's team.
- Checkpoint/todo/decision/error/question/command create, update, and pull:
  require the parent task to belong to the caller's team.
- Decision supersession: both decisions must belong to the same authorized
  task.
- A missing row and an inaccessible row both return `404`, avoiding resource
  existence disclosure.
- Deactivated users receive `403` for protected endpoints.

The authorization logic is centralized in focused helpers rather than
duplicated ad hoc SQL conditions throughout every route.

### 4.5 Member administration

Admins receive authenticated endpoints to:

- List team members and their active state.
- Deactivate/reactivate a member.

The initial admin role is immutable through the network API, ensuring the
dashboard has exactly one administrator. Admin recovery or transfer requires
an explicit nodem2 operator command with console/root access and creates an
audit record. Members cannot manage membership. Account deletion is out of
scope.

The CLI receives corresponding `sync members` commands. These are
administrative conveniences; all authorization remains server-side.

## 5. Backup and Restore

### 5.1 Daily backup files

`backup.sh` runs once daily through `ariadne-backup.timer`. It writes a
complete set under:

```text
/var/backups/ariadne/
  ariadne-YYYYMMDDTHHMMSSZ.dump
  ariadne-YYYYMMDDTHHMMSSZ.dump.sha256
  ariadne-YYYYMMDDTHHMMSSZ.json
```

- `.dump`: `pg_dump --format=custom`, written first to a temporary file and
  atomically renamed only after success.
- `.sha256`: checksum of the completed dump.
- `.json`: non-secret metadata including UTC timestamp, database name,
  schema version, dump size, PostgreSQL version, and application revision.

The directory is root-owned with mode `0700`; files are mode `0600`.

### 5.2 Retention

After successfully creating and verifying the new dump, the script removes
complete backup sets older than 30 days. It never deletes the newest valid
backup. Orphan temporary files older than one day may be removed.

Pruning operates only on validated filenames inside the resolved
`/var/backups/ariadne` directory.

### 5.3 Weekly verification

`ariadne-backup-verify.timer` runs weekly:

1. Select the newest backup set.
2. Verify its SHA-256 checksum.
3. Create an isolated temporary database with a generated, validated name.
4. Restore the dump using `pg_restore`.
5. Verify the schema version and basic row counts.
6. Drop only the temporary verification database.
7. Record success/failure in journald.

A verification failure does not delete the backup.

### 5.4 Operator restore

`restore.sh <absolute-dump-path>`:

1. Require root and a dump path under `/var/backups/ariadne`.
2. Verify filename format and checksum.
3. Create a fresh pre-restore safety backup of the current database.
4. Require an explicit confirmation unless `--yes` was supplied.
5. Stop the application container.
6. Restore into a freshly recreated production database.
7. Start the application, run migrations, and verify `/healthz`.
8. Report the safety-backup path for rollback.

Any restore failure leaves the application stopped and prints an explicit
recovery command; it must not report success-shaped output.

## 6. Error Handling and Observability

- Deployment and backup scripts use `set -Eeuo pipefail`.
- Every failure identifies the command/phase and exits non-zero.
- Secrets are never echoed.
- Docker health checks cover Postgres and the sync API.
- The operator service reports typed operation state and bounded progress;
  it never returns raw shell access.
- Systemd timer output is available through `journalctl`.
- The deployment command prints service status without printing environment
  values.
- Backup metadata and logs contain no database password, JWT secret, user
  password, or bearer token.

## 7. Encrypted Task File History

### 7.1 Capture scope and triggers

Ariadne captures only Git-tracked text files already associated with a task
through its touched-file tracking.

Captures occur at:

- A successful Git commit detected by `ariadne exec` or `git-sync`.
- An explicit Ariadne checkpoint.
- An explicit file-history capture command used by automation.

Each capture records the triggering checkpoint/commit/command, the task,
workspace label, Git revision when available, and UTC timestamp. It stores:

- A content snapshot for each accepted file.
- A unified diff against the previous task capture for that file.
- A capture manifest containing accepted and rejected paths with reasons.

The system does not capture every save or arbitrary files outside the
task's touched-file set.

### 7.2 Inclusion guardrails

A file is uploaded only when all checks pass:

- It is currently Git-tracked.
- It is text, not binary.
- Its path is inside the resolved repository root.
- It is not matched by secret/generated exclusions.
- Its uncompressed content is at most 1 MiB.
- The full capture is at most 10 MiB.
- Secret scanning finds no credential-like material.

Generated/vendor/build directories use a maintained default denylist, which
can be extended by a repository `.ariadneignore`. A rejected file creates
metadata with a stable reason such as `binary`, `oversized`, `generated`,
`outside_workspace`, or `suspected_secret`; its content never leaves the
client.

### 7.3 Storage model

New server tables represent:

- `task_file_captures`: one capture event linked to a task and optional
  checkpoint/commit/command.
- `task_file_entries`: per-path snapshot/diff metadata in a capture.
- `encrypted_blobs`: content-addressed ciphertext shared by identical
  plaintext within the same team.

Snapshots and diffs are encrypted before insertion using AES-256-GCM with a
fresh nonce and authenticated metadata containing team, task, path, content
type, and key ID. The database stores ciphertext, nonce, authentication tag,
 plaintext hash, compressed size, and key ID.

Encryption keys live under `/etc/ariadne/keys/`, outside PostgreSQL,
container images, and Git. Key rotation creates a new active key while old
keys remain read-only for historical decryption. Backups record required key
IDs but do not copy key material into database dumps.

### 7.4 Retention and deletion

File history is retained while its task exists. An admin may explicitly
delete a task's cloud file history after reauthentication and confirmation.
Deletion removes references first and garbage-collects encrypted blobs only
when no remaining entry references them. The action is permanently recorded
in the admin audit log.

Hard task deletion remains out of scope; normal task archiving retains its
audit history.

## 8. Dashboard Architecture

### 8.1 Application shape

Add `packages/dashboard`, a React/Vite single-page application built into
static assets and served by the sync server under `/admin`. It uses a
dedicated `/api/v1/admin/*` surface rather than calling operational commands
from the browser.

The selected visual direction is a dark, status-first **Operations Console**
with persistent navigation and plain-language confirmations. Task detail
uses the selected **timeline-first audit view**, with a secondary file tree
and source/diff viewer.

The dashboard is desktop-first but remains usable on tablet-sized screens.
It is not intended as a general mobile administration interface.

### 8.2 Single-admin authentication

Only the singleton team's active `admin` may access the dashboard. The
dashboard reuses the Ariadne username/password account but does not expose
the CLI's long-lived JWT to JavaScript.

Dashboard login creates a short-lived server session in an HttpOnly,
SameSite=Strict cookie. Because the UI is reachable only through the SSH
tunnel on loopback HTTP, `Secure` is enabled when HTTPS is present and
otherwise omitted for the loopback deployment. State-changing requests also
require a session-bound CSRF token.

Login attempts and privileged actions are rate-limited. Restore, deployment,
Postgres restart, membership changes, and file-history deletion require
password reauthentication and a typed confirmation phrase.

### 8.3 Dashboard pages

- **Overview:** sync API, Postgres, operator, CPU, memory, filesystem,
  database size, backup age, active operations, and warnings.
- **Tasks:** search/filter remote tasks and open the task audit timeline.
- **Task audit:** commits, commands, checkpoints, decisions, todos, errors,
  questions, file captures, encrypted snapshots, and unified/side-by-side
  diffs.
- **Users:** list membership and active state, with admin-only member
  activation/deactivation controls.
- **Backups:** list metadata, create, verify, download, and guarded restore.
- **Services:** health and typed restart actions.
- **Deployments:** current/trusted available revision, migration status,
  deployment progress, and rollback information.
- **Logs:** bounded/redacted sync-server, operator, deployment, and backup
  logs with service/time/severity filters.
- **Audit log:** immutable dashboard logins and administrative operations.

Source snapshots are syntax-highlighted and read-only. The dashboard does
not render untrusted HTML from synced files.

### 8.4 Admin API

The admin API provides typed endpoints for:

- Dashboard sessions and reauthentication.
- Health/metrics summaries.
- Team membership administration.
- Task audit timelines, file trees, snapshots, and diffs.
- Backup operations and bounded download.
- Service status/restart.
- Deployment status/start.
- Redacted log queries.
- Operation progress and audit history.

Every endpoint requires active admin membership. Responses are schema
validated, paginated/bounded, and scrubbed of secrets.

Long-running actions create persisted operation records and publish progress
through server-sent events. Refreshing the browser reconnects to existing
operations instead of starting duplicates.

## 9. Privileged Operator Service

### 9.1 Boundary

The web application and sync-server container never receive the Docker
socket and never execute arbitrary shell strings.

A root-owned `ariadne-operator` systemd service listens on a Unix socket.
The socket is mounted read/write only into the sync-server container and is
protected by filesystem ownership/mode. Requests are structured and
allowlisted.

Supported operations are:

- Service and deployment status.
- Sync-server restart.
- PostgreSQL restart.
- Backup create/verify/restore.
- Bounded, redacted log retrieval.
- Migration state.
- Deploy a trusted repository revision.
- Rollback status/reporting.

There is no generic command endpoint.

### 9.2 Operation safety

- Parameters use strict schemas and enumerations.
- Paths must resolve inside fixed deployment/backup roots.
- One mutating operation runs at a time.
- Every operation has a timeout and cancellation policy.
- Deployments accept only immutable trusted commit hashes reachable from the
  configured repository/ref policy.
- Operations write immutable audit rows with actor, action, parameters
  stripped of secrets, timestamps, result, and relevant artifact IDs.
- The operator returns sanitized progress events, not raw environment or
  unrestricted process output.

## 10. Testing

### 10.1 Authorization

Integration tests using real PostgreSQL will cover:

- First registration creates the team/admin membership.
- Later registration joins the singleton team as member.
- Active team members can read/write team tasks and all sub-entities.
- A user without active membership cannot list, pull, create, or update.
- Deactivation invalidates access immediately despite a valid JWT.
- Members cannot manage membership.
- The singleton admin can activate/deactivate members.
- The network API cannot promote, demote, or deactivate the singleton admin.
- A root-only recovery command can transfer the admin role while preserving
  exactly one admin.
- Inaccessible remote IDs return `404`.
- Existing data is preserved and scoped correctly by the migration.

Tests will create a second synthetic team directly in the test database to
prove cross-team isolation even though production uses one team.

### 10.2 File history and encryption

Tests cover:

- Git-tracked touched-file selection.
- Binary/generated/oversized/out-of-root rejection.
- Secret detection prevents upload.
- Capture manifests include rejection reasons without content.
- Snapshot/diff round trips.
- AES-GCM ciphertext cannot be read without the correct key.
- Authentication fails on modified ciphertext/metadata.
- Content-addressed deduplication is team-scoped.
- Key rotation can read old captures and writes new captures with the active
  key.
- File-history deletion preserves blobs still referenced elsewhere.

### 10.3 Dashboard and admin API

Tests cover:

- Only an active admin can create a dashboard session.
- HttpOnly session, CSRF, expiry, rate limiting, and reauthentication.
- Members and deactivated admins cannot access admin endpoints.
- Task timeline/file APIs remain task/team scoped.
- Source rendering escapes HTML/script content.
- Pagination and log-size bounds.
- Typed operation creation, progress reconnection, locking, timeout, and
  audit records.
- Destructive actions require the correct confirmation and reauthentication.
- React component states: loading, empty, healthy, warning, failure,
  operation in progress, and disconnected operator.
- Browser-level login, navigation, task audit, backup, and safe restart
  flows.

### 10.4 Deployment and backups

Shell-level tests or an isolated Compose test harness will cover:

- Environment validation and secret-file permissions.
- Compose config validity.
- Idempotent deploy.
- Backup naming, checksum generation, and 30-day pruning.
- Preservation of unrelated files in the backup directory.
- Rejection of out-of-directory restore paths and bad checksums.
- Successful restore into an isolated database.
- Failure behavior when Postgres or the sync server is unhealthy.
- Operator Unix-socket permissions and allowlist enforcement.
- Rejection of arbitrary commands, paths, branches, or revisions.

### 10.5 End-to-end nodem2 validation

Before completing rollout:

1. Build and start the tracked stack.
2. Confirm both host ports listen only on loopback.
3. Confirm the SSH tunnel can reach `/healthz`.
4. Register/login and push all supported entity types.
5. Pull/import them into a fresh workspace.
6. Capture touched files and verify encrypted database storage.
7. Log into `/admin` and inspect the task timeline, snapshot, diff, commands,
   and Git history.
8. Create a backup and inspect its dump, checksum, and metadata files.
9. Run the restore-verification job.
10. Perform a safe sync-server restart from the dashboard.
11. Verify deployment status without executing an update.
12. Confirm timers are enabled and the next run is scheduled.

## 11. Documentation and Generated Guidance

Update:

- Root README.
- User guide.
- Cloud design and API contract.
- Sync-server README.
- Generated Ariadne Copilot skill and agent.

The generated guidance will teach assistants to:

- Use `ariadne sync setup` for client onboarding.
- Treat team membership as the access boundary.
- Use `sync members` only for explicit administration requests.
- Use the tracked nodem2 deploy/backup commands rather than manually editing
  containers or systemd units.
- Never display secrets or bypass backup/restore confirmation.
- Open the dashboard only through the configured SSH tunnel.
- Treat source snapshots as sensitive encrypted task history.
- Use dashboard operations rather than arbitrary server commands.

## 12. Security Invariants

- Sync API and PostgreSQL bind to loopback only.
- SSH host identity remains fingerprint-pinned.
- Repository files contain no production secrets.
- JWT config and server environment files remain owner-only.
- Every protected database query is team-scoped directly or through an
  authorized parent task.
- Authorization is enforced server-side, never inferred from CLI behavior.
- Backup and restore paths are fixed/validated; no wildcard recursive
  deletion is used.
- Open registration remains permitted only while SSH is the external access
  boundary.
- Only the active singleton-team admin can access dashboard/admin APIs.
- The browser never receives the CLI's long-lived JWT.
- The web/container tier never receives Docker-socket or arbitrary-shell
  access.
- File contents are filtered/scanned client-side and encrypted at rest.
- Encryption keys never enter Git or PostgreSQL dumps.
- Synced source is rendered as escaped, read-only text.
- Every privileged operation is allowlisted, reauthenticated when
  destructive, serialized, and audited.

## 13. Completion Criteria

The work is complete when:

- A clean nodem2 host can be deployed from tracked files plus the secret
  environment file.
- Re-running deployment is safe and idempotent.
- Existing production data survives the authorization migration.
- Every sync endpoint enforces active single-team membership.
- Touched Git-tracked text files produce encrypted task snapshots/diffs while
  rejected files never upload content.
- The single admin can inspect a complete task audit timeline through
  `/admin`.
- Dashboard sessions, CSRF, reauthentication, rate limits, and admin checks
  pass security tests.
- The operator service supports only the approved typed operations and never
  exposes Docker or arbitrary shell execution.
- Daily backup and weekly verification timers are enabled.
- A timestamped backup set exists under `/var/backups/ariadne`.
- A verified restore succeeds in an isolated database.
- CLI, server, dashboard, operator, migration, authorization, encryption,
  deployment, browser, and backup tests pass.
- The nodem2 production smoke test succeeds through the SSH tunnel.
- Dashboard login, task audit viewing, backup verification, and safe restart
  succeed on nodem2.
