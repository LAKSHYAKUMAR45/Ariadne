# nodem2 Operations Console runbook

The tracked Compose stack and root-owned operator provide the single-admin
Operations Console. This directory is the supported production deployment
path; do not substitute ad hoc Compose commands or grant the web tier a Docker
socket. With the optional Ariadne-owned HTTPS proxy configured, the
administrator opens:

```text
https://<nodem2-address>:14300/admin
```

The proxy belongs to the `ariadne-nodem2` Compose project and does not modify
or restart unrelated nginx services. Its certificate and private key live at
`/etc/ariadne/proxy/tls.crt` and `/etc/ariadne/proxy/tls.key`. A self-signed
certificate requires a one-time browser trust exception. Set
`ADMIN_PUBLIC_ORIGIN` to the exact HTTPS origin and set
`ARIADNE_PROXY_BIND_ADDRESS`/`ARIADNE_PROXY_PORT` in
`/etc/ariadne/compose.env` before deployment. The backend remains bound to
`127.0.0.1:4300`.

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

The `scripts/import-release`, `scripts/deploy`, `scripts/rollback`, `scripts/backup`,
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

## Direct-copy release transfer

Production releases are copied directly to nodem2. Do not publish a deployment
branch, push a release ref to GitHub, clone another repository on nodem2, or
allow the tracked deployment scripts to fetch. The trust anchor is the
root-managed local ref `refs/ariadne/deploy` inside the existing
`/opt/ariadne/worktree` repository.

On the reviewed, clean local worktree, create one archive containing every
tracked file at the reviewed commit and one Git bundle containing that commit
and its object history:

```bash
SHA=$(git rev-parse HEAD)
test "$(git status --porcelain --untracked-files=all)" = ""
case "$SHA" in (*[!0-9a-f]*|"") exit 1;; esac
test "${#SHA}" -eq 40

RELEASE_DIR=$(mktemp -d)
EXPORT_REF="refs/ariadne/export/$SHA"
git update-ref "$EXPORT_REF" "$SHA"
trap 'git update-ref -d "$EXPORT_REF"; rm -rf -- "$RELEASE_DIR"' EXIT
git archive --format=tar --output="$RELEASE_DIR/ariadne-$SHA.tar" "$SHA"
git bundle create "$RELEASE_DIR/ariadne-$SHA.bundle" "$EXPORT_REF"
git bundle verify "$RELEASE_DIR/ariadne-$SHA.bundle"
test "$(git get-tar-commit-id <"$RELEASE_DIR/ariadne-$SHA.tar")" = "$SHA"
```

Copy those two files with the approved SSH transport (`rsync` or `scp`) into a
new root-owned, mode `0700` release directory on nodem2. The initial transition
also requires the reviewed `import-release` script to be installed through the
approved root host-administration path; subsequent `scripts/install` runs keep
the root-owned mode `0755` installed copy current. Then, on nodem2 as root:

```bash
/usr/local/lib/ariadne/import-release \
  "$SHA" \
  "/root/ariadne-release/ariadne-$SHA.bundle" \
  "/root/ariadne-release/ariadne-$SHA.tar"
/usr/local/lib/ariadne/deploy "$SHA"
```

`import-release` accepts only a full lowercase SHA and fixed production
worktree/root paths. It rejects unsafe ownership or modes, artifacts larger
than 2 GiB, invalid bundles, archives that do not identify the same commit,
path traversal, links, dirty destination state, and any staged content or mode
that differs from the imported commit. It first copies both caller-owned
artifacts through no-follow reads into a root-owned mode `0700` staging
directory, fails if either source changes during its copy, and performs every
subsequent validation, listing, extraction, and bundle import only from those
private snapshots.

Before worktree mutation, the importer enumerates ignored paths and rejects any
exact, ancestor, or descendant conflict with the target tracked tree. It then
protects `.git`, imports bundle objects without changing remote refs,
synchronizes only the reviewed worktree contents, and lets Git remove only
files that were tracked by the previous release but are absent from the
imported commit. Non-conflicting ignored local state and unrelated paths are
preserved. The script detaches HEAD at the reviewed SHA, requires a clean
tracked result, and only then updates `refs/ariadne/deploy`. It makes no Docker
or systemd changes.

The deploy script performs no fetch, clone, pull, push, or other Git network
operation. It requires the requested commit to be known locally and reachable
from `refs/ariadne/deploy`, then uses the existing clean-tree, backup, build,
migration, Ariadne-only Compose cutover, health, and rollback workflow.

All file synchronization is confined to `/opt/ariadne/worktree`; sibling paths
and unrelated nodem2 workloads are untouched. No release step may run
host-wide Docker cleanup, restart Docker, restart unrelated systemd units, or
operate on Compose projects, containers, ports, or volumes outside the fixed
`ariadne-nodem2` project and Ariadne units. Ariadne publishes only its fixed
loopback ports.
