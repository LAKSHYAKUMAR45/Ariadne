# nodem2 Operations Console runbook

The tracked Compose stack and root-owned operator provide the single-admin
Operations Console. This directory is the supported production deployment
path; do not substitute ad hoc Compose commands or grant the web tier a Docker
socket. After `ariadne sync setup [username]` establishes the pinned SSH
tunnel, the administrator opens:

```text
http://127.0.0.1:14300/admin
```

The console has eight sections: **Overview**, **Members**, **Tasks**,
**Backups**, **Services**, **Deployments**, **Logs**, and **Audit**. It uses a
browser session and CSRF protection. Its password reauthentication window is
five minutes; every destructive action also requires the exact phrase shown in
the confirmation dialog. The server enforces these requirements.

## Daily operation

- Inspect health in **Overview** and service state in **Services**. The
  operator is intentionally not browser-restartable; only `sync-server` and
  PostgreSQL are approved restart targets.
- Use **Backups** to create and verify artifacts. Only currently verified
  recorded artifacts can be downloaded or restored. If a restore is
  ineligible, resolve the displayed verification issue rather than bypassing
  the guard.
- Use **Deployments** only with a listed immutable candidate SHA. Rollback is
  available only for the recorded prior revision. Both paths create and verify
  a safety backup, apply the tracked migration/cutover workflow, and require
  health checks. Wait for the durable operation result and audit event.
- Use **Logs** only for the fixed `sync-server`, `operator`, `deployment`, and
  `backup` sources. Filters and cursors are bounded; arbitrary journal queries
  and paths are not supported.
- Use **Audit** to investigate append-only authentication, membership,
  file-history, backup, service, deployment, and restore records. Use
  operation IDs to correlate progress and completion.

## Deployment, backup, and rollback controls

The `scripts/deploy`, `scripts/rollback`, `scripts/backup`,
`scripts/verify-backup`, and `scripts/restore-backup` scripts have fixed paths
and validation. They are for controlled host operation and are the only
supported alternative to the console workflow. A restore, deploy, or rollback
must not be improvised with shell or Docker commands: the tracked workflow
records state, creates and verifies a safety backup, validates eligibility,
and fails explicitly if migration or health checks do not pass.

These controls are Ariadne-only. They pin the `ariadne-nodem2` Compose project
and exact Compose file, and they must not be replaced by host-wide Docker
cleanup, host-wide restarts, or commands that can disturb unrelated nodem2
workloads.

The backup and verification systemd timers are
`ariadne-backup.timer` and `ariadne-backup-verify.timer`; the privileged
boundary is `ariadne-operator.service`. Check their state with standard
systemd status tooling during host administration, but do not paste secrets
from `/etc/ariadne/compose.env`, `/etc/ariadne/sync-server.env`, or
`/etc/ariadne/keys/` into a shell, chat, log, or document. Those root-owned
files are retrieved through the approved host access process. Rotate
credentials or encryption keys with the tracked rotation procedure rather
than recording their values.

`docker compose config --quiet` is safe for validation. Do not run plain
`docker compose config` where output can be captured because it expands
environment-file values.
