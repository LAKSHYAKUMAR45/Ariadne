# @ariadne-dev/operator

The root-owned operator is the privileged boundary for the nodem2 Operations
Console. It is not a general remote-execution service. The web tier connects
to its private Unix socket and can issue only strict typed requests:

- Reads use `POST /v1/queries` for host metrics, service state, deployment
  state, verified-backup streaming, and bounded logs.
- Mutations use `POST /v1/operations` for backup create/verify/restore,
  restart of `sync-server` or PostgreSQL, deployment apply, and deployment
  rollback.

The operator rejects arbitrary commands, Docker requests, paths, service
names, journal expressions, backup names with separators, and revisions that
are not 40-character lowercase SHAs. Log reads allow only `sync-server`,
`operator`, `deployment`, and `backup`; pagination, severity, and timestamp
filters are validated before a fixed query runs.

## Operations contract

Every accepted mutation is tied to a durable dashboard operation ID. The
operator reports bounded, sanitized progress and a terminal result to the
sync server callback; it does not expose command output to the browser.
Restore accepts a recorded verified backup. Deploy accepts only a SHA reachable
from the configured trusted ref, and rollback accepts only the recorded target.
The fixed restore, deploy, and rollback workflows create and verify a fresh
safety backup before changing production state.

The console protects these requests with a browser session, CSRF, fresh
five-minute password reauthentication, and exact destructive confirmations.
The operator repeats its own input validation because the web tier is not the
privilege boundary.

## Runtime and operations

`deploy/nodem2/systemd/ariadne-operator.service` runs the process as root with
systemd hardening and a root-owned runtime directory. It is the only component
with Docker-socket access. The web container receives only a read-only bind of
the operator socket and callback credential; it never receives the Docker
socket.

Use the Operations Console at `http://127.0.0.1:14300/admin` after
`ariadne sync setup` creates the tunnel, or the tracked scripts in
[`deploy/nodem2/README.md`](../../deploy/nodem2/README.md). Never print or
embed passwords, secrets, tokens, or private keys. Retrieve them through the
secure prompt or root-owned environment files, and use the documented
rotation workflow instead of copying values into commands or logs.
