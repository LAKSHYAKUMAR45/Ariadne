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
| `ENCRYPTION_KEY_DIR`      | yes      | —       | Owner-only directory containing `active-key-id` and AES-256-GCM key files |
| `SYNC_SERVER_JWT_SECRET`  | yes      | —       | Secret used to sign/verify auth JWTs          |
| `HOST`                    | no       | `127.0.0.1` | Bind address; use `0.0.0.0` only behind a secured reverse proxy or firewall |
| `PORT`                    | no       | `4300`  | Port the HTTP server listens on               |

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

`ENCRYPTION_KEY_DIR` must point at an owner-only directory (for example mode
`0700`) containing:

```text
/etc/ariadne/keys/
  active-key-id
  <key-id>.key
```

`active-key-id` and every `<key-id>.key` file must be mode `0600`. Each key
file must contain either exactly 32 raw bytes or exactly 64 lowercase hex
characters. The active key encrypts new content; retained older key files stay
available for historical decryption after rotation.

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
