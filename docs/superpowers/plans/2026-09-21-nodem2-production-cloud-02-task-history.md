# Encrypted Task History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture and sync auditable task Git history, readable text snapshots, and unified diffs while rejecting unsafe content and encrypting every remote content blob.

**Architecture:** Core records immutable local capture metadata/content at Git commits, checkpoints, or explicit requests. The CLI uploads validated captures through the existing tunnel. The server content-addresses plaintext, encrypts it with an active AES-256-GCM key, and stores only ciphertext plus authenticated metadata. Admin audit APIs decrypt on demand and never expose key material.

**Tech Stack:** TypeScript 5.5, Node.js crypto, Git CLI, SQLite/better-sqlite3, PostgreSQL 16, Express, Zod, Vitest, Supertest.

**Spec:** `docs/superpowers/specs/2026-09-21-nodem2-production-cloud-design.md`

## Global Constraints

- Capture only Git-tracked, task-touched, regular text files inside repository root.
- Reject symlinks, binary content, generated paths, likely secret files, files over 1 MiB, and captures over 10 MiB.
- `.ariadneignore` adds exclusions and cannot re-include built-in exclusions.
- Git-commit captures read the committed blob, not the current worktree.
- PostgreSQL stores no plaintext snapshot or diff.
- AES-256-GCM uses a fresh 96-bit nonce per encryption and authenticates task/capture/path/type/key metadata.
- Content rendering is read-only, escaped, and never interpreted as HTML.

---

### Task 1: Local capture schema and immutable store API

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/schema.ts`
- Modify: `packages/core/src/migrations.ts`
- Modify: `packages/core/src/TaskStore.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/migrations.test.ts`
- Modify: `packages/core/test/TaskStore.test.ts`

**Interfaces:**

```ts
export type FileCaptureTrigger = 'git_commit' | 'checkpoint' | 'explicit';

export interface TaskFileCapture {
  id: string;
  taskId: string;
  trigger: FileCaptureTrigger;
  gitCommitSha: string | null;
  checkpointId: string | null;
  createdAt: string;
  syncedAt: string | null;
}

export interface TaskFileCaptureEntry {
  captureId: string;
  path: string;
  content: string;
  unifiedDiff: string;
  byteLength: number;
  contentSha256: string;
}
```

- [ ] **Step 1: Write failing migration and store tests**

Assert schema version advances from `4` to `5`, existing databases preserve
all rows, and:

```ts
const created = store.createTaskFileCapture(input);
expect(store.getPendingTaskFileCaptures(taskId)).toEqual([created]);
store.markTaskFileCaptureSynced(created.id, '2026-09-21T00:00:00.000Z');
expect(store.getPendingTaskFileCaptures(taskId)).toEqual([]);
```

Also assert duplicate `(task_id, trigger, git_commit_sha, checkpoint_id)`
events are idempotent and entries are immutable after creation.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/migrations.test.ts test/TaskStore.test.ts
```

- [ ] **Step 3: Add local schema migration**

Create:

```sql
CREATE TABLE task_file_captures (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('git_commit', 'checkpoint', 'explicit')),
  git_commit_sha TEXT,
  checkpoint_id TEXT,
  created_at TEXT NOT NULL,
  synced_at TEXT,
  UNIQUE (task_id, trigger, git_commit_sha, checkpoint_id)
);

CREATE TABLE task_file_capture_entries (
  capture_id TEXT NOT NULL REFERENCES task_file_captures(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  unified_diff TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  PRIMARY KEY (capture_id, path)
);
```

Use TaskStore transactions, ULIDs, and defensive copies. Do not update entry
content after insertion.

- [ ] **Step 4: Implement and export typed store methods**

Add:

```ts
createTaskFileCapture(input: CreateTaskFileCaptureInput): TaskFileCapture;
getTaskFileCaptures(taskId: string): TaskFileCaptureWithEntries[];
getPendingTaskFileCaptures(taskId: string): TaskFileCaptureWithEntries[];
markTaskFileCaptureSynced(captureId: string, syncedAt?: string): void;
```

- [ ] **Step 5: Run core tests**

```bash
pnpm --filter @ariadne-dev/core exec vitest run
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/schema.ts packages/core/src/migrations.ts packages/core/src/TaskStore.ts packages/core/src/index.ts packages/core/test/migrations.test.ts packages/core/test/TaskStore.test.ts
git commit -m "feat(core): store immutable task file captures"
```

### Task 2: Safe Git-aware capture engine

**Files:**
- Create: `packages/core/src/FileCapture.ts`
- Create: `packages/core/test/FileCapture.test.ts`
- Modify: `packages/core/src/GitWatcher.ts`
- Modify: `packages/core/test/GitWatcher.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

```ts
export interface CaptureLimits {
  maxFileBytes: number;
  maxCaptureBytes: number;
}

export interface CaptureRequest {
  taskId: string;
  workspace: string;
  trigger: FileCaptureTrigger;
  gitCommitSha?: string;
  checkpointId?: string;
}

export interface CaptureResult {
  capture: TaskFileCaptureWithEntries | null;
  skipped: Array<{ path: string; reason: CaptureSkipReason }>;
}

export async function captureTaskFiles(
  store: TaskStore,
  request: CaptureRequest,
  limits?: CaptureLimits,
): Promise<CaptureResult>;
```

- [ ] **Step 1: Write failing eligibility tests**

Create a temporary Git repository and cover:

- tracked touched UTF-8 text file is captured;
- untouched tracked file is excluded;
- untracked, ignored, symlink, binary/NUL, and outside-root files are excluded;
- `.env`, `*.pem`, `*.key`, credential/token/secret-named paths, `.git/`,
  `node_modules/`, `dist/`, `build/`, and `.ariadne/` are always excluded;
- `.ariadneignore` excludes an additional tracked path;
- 1 MiB per-file and 10 MiB aggregate limits are exact inclusive boundaries;
- committed capture uses `git show <sha>:<path>` after the worktree changes;
- unified diff is generated against the first parent, or `/dev/null` for the
  root commit;
- paths are canonical POSIX repository-relative paths.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/FileCapture.test.ts
```

- [ ] **Step 3: Implement capture without shell interpolation**

Use the existing `execFile` helper/pattern and fixed argument arrays:

```ts
execFile('git', ['-C', workspace, 'ls-files', '-z']);
execFile('git', ['-C', workspace, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', sha]);
execFile('git', ['-C', workspace, 'show', `${sha}:${path}`]);
```

For worktree/checkpoint captures, intersect `TaskStore.getFiles(taskId)` with
`git ls-files`. Resolve each path and verify it remains beneath the canonical
workspace root before reading. Detect binary content from NUL bytes and strict
UTF-8 decoding. Compute SHA-256 over UTF-8 bytes.

- [ ] **Step 4: Integrate with `GitWatcher.syncTaskGit`**

After each new commit and touched-file record is committed locally, call
`captureTaskFiles(... trigger: 'git_commit', gitCommitSha: sha)`. Capture
failure must be recorded as an Ariadne error and surfaced; it must not silently
mark the Git commit as captured.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @ariadne-dev/core exec vitest run test/FileCapture.test.ts test/GitWatcher.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/FileCapture.ts packages/core/src/GitWatcher.ts packages/core/src/index.ts packages/core/test/FileCapture.test.ts packages/core/test/GitWatcher.test.ts
git commit -m "feat(core): capture safe Git task history"
```

### Task 3: Checkpoint and explicit capture entry points

**Files:**
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/test/cli.test.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/test/tools.test.ts`
- Modify: `.github/skills/ariadne/SKILL.md`
- Modify: `.github/agents/ariadne.agent.md`
- Modify: `packages/cli/src/skillTemplates.ts`
- Modify: `packages/cli/test/skillTemplates.test.ts`

**Interfaces:**
- Produces `ariadne capture [task-id]`.
- Existing `ariadne checkpoint` and MCP `checkpoint` capture after successful
  checkpoint creation using the exact checkpoint ID.

- [ ] **Step 1: Write failing CLI/MCP tests**

Assert:

```ts
it('captures files after a checkpoint is persisted');
it('does not capture when checkpoint creation fails');
it('captures the active task with the explicit capture command');
it('prints skipped path reasons without leaking file contents');
```

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/cli exec vitest run test/cli.test.ts
pnpm --filter @ariadne-dev/mcp-server exec vitest run test/tools.test.ts
```

- [ ] **Step 3: Implement entry points**

Call the shared core capture function only after checkpoint persistence.
Output capture ID, file count, byte count, and skipped path/reason. Never print
captured contents.

- [ ] **Step 4: Update generated guidance**

Teach the skill/agent to use `ariadne capture` before risky changes and explain
what is intentionally excluded. Update template snapshot/string tests.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @ariadne-dev/cli exec vitest run
pnpm --filter @ariadne-dev/mcp-server exec vitest run
```

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/test/cli.test.ts packages/mcp-server/src/tools.ts packages/mcp-server/test/tools.test.ts packages/cli/src/skillTemplates.ts packages/cli/test/skillTemplates.test.ts .github/skills/ariadne/SKILL.md .github/agents/ariadne.agent.md
git commit -m "feat(capture): add checkpoint and explicit file capture"
```

#### Task 3 report — round 2

- Replaced the CLI/MCP capture-failure wrappers with shared sanitized core
  error types so checkpoint/explicit capture failures never persist or surface
  raw `captureTaskFiles` / `recordError` messages.
- Single capture-failure paths now record only stable generic task errors and
  throw stable generic errors without `cause`.
- Dual-failure paths now throw a sanitized `AggregateError` whose nested errors
  are wrapper errors only, so object inspection and MCP error envelopes stay
  content-free even when both capture and failure-recording break.
- Added regression coverage for CLI checkpoint, CLI explicit capture, MCP
  checkpoint tool throws, and MCP handler error envelopes using secret marker
  strings to prove the markers never survive persistence, thrown-object
  inspection, or serialized MCP responses.

### Task 4: Server encryption keyring

**Files:**
- Create: `packages/sync-server/src/encryption.ts`
- Create: `packages/sync-server/test/encryption.test.ts`
- Modify: `packages/sync-server/src/config.ts`
- Modify: `packages/sync-server/test/config.test.ts`
- Modify: `packages/sync-server/README.md`

**Interfaces:**

```ts
export interface EncryptedBlob {
  keyId: string;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

export interface EncryptionKeyring {
  activeKeyId: string;
  encrypt(plaintext: Buffer, aad: Buffer): EncryptedBlob;
  decrypt(blob: EncryptedBlob, aad: Buffer): Buffer;
}

export function loadEncryptionKeyring(directory: string): EncryptionKeyring;
```

Key directory contract:

```text
/etc/ariadne/keys/
  active-key-id
  <key-id>.key
```

Each key file is exactly 32 raw bytes or 64 lowercase hex characters and mode
`0600`; the directory must not be group/world accessible.

- [ ] **Step 1: Write failing crypto/config tests**

Cover round trip, randomized nonces for equal plaintext, AAD tamper failure,
ciphertext/auth-tag tamper failure, missing active key, malformed key, unknown
decrypt key ID, insecure file/directory permissions, and key rotation where old
keys still decrypt.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/encryption.test.ts test/config.test.ts
```

- [ ] **Step 3: Implement strict AES-256-GCM keyring**

Use:

```ts
createCipheriv('aes-256-gcm', key, randomBytes(12));
cipher.setAAD(aad);
```

Return explicit typed errors; never fall back to plaintext or a generated
ephemeral key. Add required production config `ENCRYPTION_KEY_DIR` with a
test-only injected keyring option in `createApp`.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/encryption.test.ts test/config.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/sync-server/src/encryption.ts packages/sync-server/src/config.ts packages/sync-server/test/encryption.test.ts packages/sync-server/test/config.test.ts packages/sync-server/README.md
git commit -m "feat(sync-server): add rotating content encryption keys"
```

### Task 5: Encrypted remote history schema and repository

**Files:**
- Create: `packages/sync-server/migrations/0007_encrypted_task_history.sql`
- Create: `packages/sync-server/src/taskHistoryStore.ts`
- Create: `packages/sync-server/test/taskHistoryStore.test.ts`
- Modify: `packages/sync-server/test/migrate.test.ts`

**Interfaces:**

```ts
export interface StoreCaptureInput {
  captureId: string;
  teamId: string;
  taskId: string;
  trigger: FileCaptureTrigger;
  gitCommitSha: string | null;
  checkpointId: string | null;
  createdAt: string;
  entries: Array<{
    path: string;
    content: Buffer;
    unifiedDiff: Buffer;
    contentSha256: string;
  }>;
}
```

- [ ] **Step 1: Write failing migration/repository tests**

Assert:

- no plaintext marker appears in any text/bytea column;
- equal plaintext deduplicates to one blob by team-scoped SHA-256;
- content and diff use distinct authenticated blob types;
- idempotent capture replay does not duplicate entries;
- a capture ID replay with different metadata returns conflict;
- wrong team/task cannot read the capture;
- key rotation keeps old rows readable;
- deleting one capture preserves blobs referenced by another capture and
  garbage-collects only unreferenced blobs.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/migrate.test.ts test/taskHistoryStore.test.ts
```

- [ ] **Step 3: Implement migration 0007**

Create:

```sql
encrypted_blobs(
  id UUID PRIMARY KEY,
  team_id UUID NOT NULL,
  plaintext_sha256 TEXT NOT NULL,
  blob_type TEXT NOT NULL CHECK (blob_type IN ('snapshot','diff')),
  key_id TEXT NOT NULL,
  nonce BYTEA NOT NULL,
  ciphertext BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  plaintext_bytes INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(team_id, plaintext_sha256, blob_type)
);

task_file_captures(
  id TEXT PRIMARY KEY,
  team_id UUID NOT NULL,
  task_id TEXT NOT NULL,
  trigger TEXT NOT NULL,
  git_commit_sha TEXT,
  checkpoint_id TEXT,
  created_at TIMESTAMPTZ NOT NULL
);

task_file_capture_entries(
  capture_id TEXT NOT NULL,
  path TEXT NOT NULL,
  snapshot_blob_id UUID NOT NULL,
  diff_blob_id UUID NOT NULL,
  PRIMARY KEY(capture_id, path)
);
```

Also create append-only `task_file_history_deletions` containing actor user ID,
task/capture IDs, deleted paths/counts, timestamp, and reason. Add team/task
foreign keys and indexes. Store normalized AAD JSON containing schema version,
team ID, task ID, capture ID, path, and blob type.

- [ ] **Step 4: Implement transactional repository**

Validate limits again server-side before encryption. Encrypt before insert,
deduplicate by SHA/type/team, and commit capture + entries atomically.
Decrypt only after team-scoped lookup. Add
`deleteCapture(teamId, taskId, captureId, actorUserId, reason)` that deletes
references transactionally, records the immutable deletion row, and removes
only blobs with no remaining references.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/migrate.test.ts test/taskHistoryStore.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/sync-server/migrations/0007_encrypted_task_history.sql packages/sync-server/src/taskHistoryStore.ts packages/sync-server/test/migrate.test.ts packages/sync-server/test/taskHistoryStore.test.ts
git commit -m "feat(sync-server): store encrypted task file history"
```

### Task 6: Capture upload and admin audit APIs

**Files:**
- Create: `packages/sync-server/src/routes/taskHistory.ts`
- Create: `packages/sync-server/src/routes/adminTasks.ts`
- Modify: `packages/sync-server/src/app.ts`
- Modify: `packages/sync-server/test/routes.test.ts`
- Modify: `packages/cli/src/syncClient.ts`
- Modify: `packages/cli/src/syncCommands.ts`
- Modify: `packages/cli/test/sync.test.ts`
- Modify: `docs/07-CLOUD-SYNC-API-CONTRACT.md`

**Interfaces:**
- Produces:
  - `POST /api/v1/sync/tasks/:taskId/file-captures`
  - `GET /api/v1/admin/tasks`
  - `GET /api/v1/admin/tasks/:taskId/timeline`
  - `GET /api/v1/admin/tasks/:taskId/file-captures/:captureId/files/:path`

Audit file response:

```ts
interface AdminCapturedFile {
  path: string;
  content: string;
  unifiedDiff: string;
  contentSha256: string;
  byteLength: number;
}
```

- [ ] **Step 1: Write failing API tests**

Cover successful upload, retry idempotency, over-limit rejection, malformed
UTF-8 rejection, member upload, admin-only reads, inactive-member denial,
cross-team denial, URL-encoded traversal path rejection, and exact timeline
ordering across task, checkpoint, commit, command, decision, todo, error, open
question, and capture events.

- [ ] **Step 2: Run server tests and verify RED**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/routes.test.ts
```

- [ ] **Step 3: Implement routes**

Validate with Zod and hard request-body limits. Upload requires active team
membership and team task access. Reads require singleton admin. Timeline
returns metadata only; file content is fetched through its dedicated endpoint.
Set `Cache-Control: no-store` on decrypted content responses.

- [ ] **Step 4: Write failing CLI sync tests**

Assert `sync push` uploads pending captures after task/sub-entity sync, marks
only acknowledged IDs as synced, retries failed captures, and never logs body
content.

- [ ] **Step 5: Implement client upload**

Batch one capture per request to preserve the 10 MiB cap and simple retries.
Encode JSON as UTF-8; do not use multipart or write temporary plaintext files.

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run
pnpm --filter @ariadne-dev/cli exec vitest run
```

- [ ] **Step 7: Commit**

```bash
git add packages/sync-server/src/routes/taskHistory.ts packages/sync-server/src/routes/adminTasks.ts packages/sync-server/src/app.ts packages/sync-server/test/routes.test.ts packages/cli/src/syncClient.ts packages/cli/src/syncCommands.ts packages/cli/test/sync.test.ts docs/07-CLOUD-SYNC-API-CONTRACT.md
git commit -m "feat(sync): upload and audit encrypted task history"
```

### Task 7: History validation and security gate

- [ ] **Step 1: Run focused and aggregate validation**

```bash
pnpm --filter @ariadne-dev/core build
pnpm --filter @ariadne-dev/core exec vitest run
pnpm --filter @ariadne-dev/cli build
pnpm --filter @ariadne-dev/cli exec vitest run
pnpm --filter @ariadne-dev/mcp-server build
pnpm --filter @ariadne-dev/mcp-server exec vitest run
pnpm --filter @ariadne-dev/sync-server build
pnpm --filter @ariadne-dev/sync-server exec vitest run
git diff --check
```

- [ ] **Step 2: Run mandatory reviews**

Invoke TypeScript Reviewer and Security Reviewer. Explicitly request review of
path containment, secret exclusions, Git argument safety, content limits,
encryption nonce/AAD/key handling, cross-team access, and plaintext leakage.

- [ ] **Step 3: Add regression tests for every accepted finding**

Write the failing regression test first, implement the correction, and rerun
the focused suite.

- [ ] **Step 4: Commit review fixes if needed**

```bash
git add packages/core packages/cli packages/mcp-server packages/sync-server docs/07-CLOUD-SYNC-API-CONTRACT.md
git commit -m "fix(history): harden encrypted file capture"
```
