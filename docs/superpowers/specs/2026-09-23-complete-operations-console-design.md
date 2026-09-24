# Complete Ariadne Operations Console Design

**Date:** 2026-09-23
**Status:** Approved for implementation planning
**Baseline:** Deployed dashboard MVP at revision
`35ea737772e4d1dde2b6cd86d90abf40edcf04c0`

## 1. Goal

Complete the original Ariadne Operations Console on top of the deployed MVP.
The single administrator must be able to inspect cloud state, manage members,
review synced task history, manage backups, operate approved services, deploy
and roll back tracked revisions, and inspect immutable audit and bounded log
history from `/admin`.

The completed console must preserve the current security boundary:

- the dashboard uses database-backed browser sessions, not the sync JWT;
- all browser mutations require the configured origin and CSRF token;
- destructive operations require recent password reauthentication;
- the web container receives neither the Docker socket nor arbitrary shell
  access;
- privileged work crosses the existing Unix socket as a typed operator
  request;
- all privileged operations are serialized, durable, and audited.

## 2. Scope

### 2.1 Complete dashboard surfaces

The dashboard contains these primary sections:

1. **Overview**
   - Database health and latency.
   - Host CPU, memory, filesystem, and database size.
   - Sync server, operator, and PostgreSQL state.
   - Task, member, sync, backup, and operation summaries.
   - Explicit healthy, warning, stale, unavailable, and failed states.

2. **Members**
   - List the singleton team's users and membership state.
   - Activate or deactivate members.
   - Never mutate, deactivate, promote, or demote the singleton admin through
     the network API.

3. **Tasks**
   - Retain the timeline-first three-pane task workbench.
   - Inspect checkpoints, todos, decisions, errors, questions, commands, Git
     events, file captures, snapshots, and diffs.
   - Delete a selected file capture only after recent reauthentication and an
     exact destructive confirmation.

4. **Backups**
   - List backup metadata and verification state.
   - Create, verify, and download a verified backup.
   - Restore an eligible verified backup through the tracked operator workflow.
   - Explain why a backup is ineligible rather than merely disabling controls.

5. **Services**
   - Show sync server, operator, and PostgreSQL state.
   - Restart the sync server or PostgreSQL through allowlisted operator
     operations.
   - Keep the operator itself outside browser restart control.

6. **Deployments**
   - Show the current revision, previous rollback revision, schema version, and
     bounded deployment history.
   - List immutable candidate commit SHAs reachable from the configured trusted
     remote and ref.
   - Deploy an approved revision or roll back to the recorded previous revision.
   - Display migration and health-check progress and final outcome.

7. **Logs**
   - Read only the fixed sources `sync-server`, `operator`, `deployment`, and
     `backup`.
   - Filter by severity and time, and paginate with opaque cursors.
   - Strip ANSI sequences, redact secrets, bound individual and total response
     size, and never expose filesystem paths or arbitrary journal queries.

8. **Audit**
   - Show append-only administrator authentication, membership, file-history,
     backup, service, deployment, and restore events.
   - Filter and paginate without permitting edits or deletion.
   - Link operation-related events to the durable operation record.

### 2.2 Documentation and assistant guidance

Update the user guide, sync-server/operator documentation, API contract, and
generated Ariadne Copilot guidance. Guidance must direct operators to the
dashboard or tracked scripts, require backups and confirmation for destructive
work, and prohibit secret display and arbitrary server commands.

## 3. Architecture

Extend the existing React, sync-server, PostgreSQL, and privileged operator
stack in place.

The React dashboard calls same-origin `/api/v1/admin/*` endpoints. The sync
server authenticates the admin session, enforces CSRF and origin checks,
validates request schemas, reads team-scoped data, creates durable operations,
and sends only typed requests to the operator. The operator independently
validates every requested service, backup basename, revision, and transition
before running fixed tracked scripts or fixed argument arrays.

Read-only operator queries cover host metrics, service state, deployment state,
verified backup streaming, and fixed-source logs. The sync server aggregates
independent data sources with per-source timeouts. Database failure returns
`503`; unavailable optional operator data is represented as an explicit
component error and never as fabricated healthy data.

## 4. Privileged Operation Model

The durable operation types are:

- backup create;
- backup verify;
- backup restore;
- sync-server restart;
- PostgreSQL restart;
- deployment apply;
- deployment rollback;
- file-capture deletion.

Every privileged operation has:

- an authenticated singleton-admin actor;
- recent password reauthentication, no older than five minutes;
- an exact typed confirmation for destructive actions;
- strict schema validation and allowlisted identifiers;
- a durable queued/running/succeeded/failed state;
- bounded, redacted progress and result details;
- append-only audit events;
- serialization against incompatible concurrent operations;
- a defined timeout and explicit failure outcome.

The dashboard must reconnect to an existing operation after refresh by its
operation ID. It must not show optimistic success before the durable terminal
state exists.

## 5. Operation Safety Rules

### 5.1 Backup restore

A backup is restorable only when its recorded basename is valid, the dump and
metadata exist, its checksum matches, and its latest verification succeeded.
Before restoring production, the operator creates and verifies a fresh safety
backup. The restore runs through the tracked restore workflow, applies required
migrations, restarts dependent services, and completes only after database and
HTTP health checks pass. A failed restore records an explicit failed terminal
state and retains the safety backup and diagnostics.

### 5.2 Service restart

Only `sync-server` and `postgres` are browser-selectable. PostgreSQL restart
waits for database readiness before restarting or validating the sync server.
The operator service is not browser-restartable because it is the trusted
execution boundary.

### 5.3 Deployment and rollback

The browser may submit only an immutable SHA returned by deployment status.
The operator confirms that the SHA is reachable from the configured trusted
remote/ref, creates and verifies a safety backup, records the current rollback
revision, builds or retrieves the tracked image, runs migrations, performs the
cutover, and requires health checks before success. Rollback accepts only the
recorded eligible rollback revision and follows the same backup and health
rules.

### 5.4 Capture deletion

Deletion is scoped to the selected team task and capture. It removes capture
entries transactionally, garbage-collects only unreferenced encrypted blobs,
and writes a file-history deletion audit record. The UI shows the affected
paths and requires an exact confirmation before submission.

## 6. User Experience

Keep the existing dark, dense, status-first command-center visual system.
Avoid decorative charts, generic card grids, gradients, and non-operational
visual noise.

Each page must implement:

- loading, empty, healthy, warning, failed, and disconnected states;
- keyboard navigation and visible focus;
- clear operation eligibility and disabled reasons;
- responsive restructuring rather than merely shrinking columns;
- explicit timestamps and freshness;
- no raw secrets, internal paths, stack traces, or arbitrary operator output.

Destructive actions use a consistent confirmation dialog that explains impact,
requests the exact confirmation phrase, collects the administrator password
when reauthentication is stale, and presents the resulting operation progress.

## 7. API and Data Constraints

- All admin responses use `Cache-Control: no-store`, except immutable hashed
  dashboard assets.
- Pagination limits and response-size caps are enforced server-side.
- Backup download streams only a verified recorded basename with attachment
  headers, checksum metadata, maximum-size enforcement, backpressure handling,
  and client-abort cleanup.
- Log callers cannot provide unit names, paths, journal expressions, or output
  fields.
- Deployment callers cannot provide branches, paths, commands, image names, or
  arbitrary Git expressions.
- Member mutations can change only the active state of a non-admin membership.
- Audit records are append-only and contain sanitized structured metadata.

## 8. Error Handling

Errors identify the failed boundary without exposing sensitive internals.
Validation failures, stale reauthentication, conflicts, operator
unavailability, operation timeouts, and dependency health failures receive
distinct API codes and dashboard messages.

The dashboard keeps readable data available when an optional operator query
fails, but disables dependent controls and displays the real component error.
It never converts a failed request into an empty or successful state.

## 9. Testing

Implementation follows RED, GREEN, IMPROVE.

### 9.1 Integration tests

Use real PostgreSQL where the existing suite does. Cover:

- session, CSRF, origin, expiry, rate limiting, and reauthentication;
- member listing and allowed/forbidden state changes;
- task scoping, escaped content rendering, and capture deletion;
- backup list, create, verify, download, eligibility, and restore;
- sync-server and PostgreSQL restart;
- deployment candidate validation, apply, rollback, and migration failures;
- operation locking, timeout, progress, reconnect, and audit linkage;
- fixed log sources, filtering, redaction, cursor pagination, and size limits;
- operator-disconnected and partial-read behavior.

### 9.2 React tests

Cover all page states, guarded confirmation flows, disabled reasons, operation
progress/reconnect, stale request cancellation, keyboard behavior, focus
management, responsive structural changes, and axe assertions.

### 9.3 Browser tests

Playwright covers:

- login and logout;
- overview and navigation;
- member activation/deactivation;
- task timeline, snapshot, diff, and capture deletion;
- backup create, verify, download, and guarded restore;
- service restart and operation reconnection;
- deployment and rollback using test doubles or an isolated harness;
- audit and log filtering;
- session expiry and reauthentication.

### 9.4 Finish gate

The full TypeScript build, focused and full tests, production image build,
React review, TypeScript review, security review, accessibility checks, and
responsive finish gate must pass before nodem2 rollout.

## 10. Nodem2 Rollout

1. Record current revision, service, timer, listener, schema, task, member, and
   backup state.
2. Create and verify a fresh root-owned safety backup.
3. Build the tracked production image and apply migrations.
4. Deploy without deleting the previous image, database volume, or rollback
   artifacts.
5. Verify health and login through `http://127.0.0.1:14300/admin`.
6. Smoke-test every read surface.
7. Exercise guarded operations in a safe order: backup create/verify/download,
   sync-server restart, PostgreSQL restart, isolated restore verification,
   member state round trip on a non-admin test member, capture deletion on test
   data, and deployment/rollback in the approved rollout harness.
8. Restart the stack and verify login, data, audit, and operation persistence.
9. Confirm only loopback listeners, active timers/operator, no Docker socket in
   the web container, and preserved rollback artifacts.

Live production restore is not used merely to prove the button. The restore
workflow is accepted after isolated restore succeeds and all live preconditions
and confirmation guards are verified.

## 11. Completion Criteria

The work is complete when:

- all eight dashboard sections are functional and polished;
- all guarded controls use typed operator requests and durable operations;
- no dashboard path permits arbitrary commands, paths, services, revisions, or
  journal queries;
- destructive actions enforce recent reauthentication and exact confirmation;
- backup, restore, restart, deploy, rollback, deletion, logs, and audit tests
  pass;
- browser accessibility and responsive critical flows pass;
- production image, migration, and full repository validation pass;
- nodem2 is deployed with a verified safety backup and rollback artifacts;
- tunnel-based login, read surfaces, guarded controls, persistence, timers,
  listeners, and service health pass final verification;
- operational documentation and generated Copilot guidance describe the
  completed workflows.
