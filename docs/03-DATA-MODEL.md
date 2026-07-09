# Ariadne — Data Model & Storage (Draft v0.1)

## 1. Storage Decision (locked)
**SQLite is the source of truth.** Markdown is a generated export, not primary
storage. Rationale: we need queryability (ranking, search, joins across
tasks/files/commits) and safe concurrent access from multiple processes (VS Code
extension + CLI + MCP server all touching the same workspace) — Markdown/JSON files
can't give us that without inventing our own locking and indexing.

File location: `.ariadne/state.db` — **gitignored by default** (locked decision).
`ariadne export` can render any task to `.ariadne/export/<task-id>.md` for
humans, PR descriptions, or opt-in team sharing.

## 2. Why "Graph" Without a Graph Database
Conceptually the model is a graph: Task → Checkpoints → {Files, Commits, Decisions,
Errors, Todos}, plus Task ↔ Task edges (parent/child, depends-on). We get graph
*semantics* using plain relational tables + foreign keys, traversed via SQL joins.
A dedicated graph DB (Neo4j, etc.) would add an operational dependency with no
benefit at single-user, single-workspace scale. Revisit only if/when a
team/cross-repo graph feature is seriously pursued (post-MVP, not committed).

## 3. Schema (SQLite DDL sketch)

```sql
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,          -- e.g. ULID
  title         TEXT NOT NULL,
  goal          TEXT,
  status        TEXT NOT NULL DEFAULT 'active', -- active|paused|done|archived
  parent_task_id TEXT REFERENCES tasks(id),
  branch        TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE task_deps (
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  depends_on    TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on)
);

CREATE TABLE checkpoints (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL REFERENCES tasks(id),
  parent_checkpoint_id TEXT REFERENCES checkpoints(id), -- hierarchical rollup
  level             TEXT NOT NULL,     -- micro|session|milestone
  summary           TEXT NOT NULL,     -- rule-based generated text
  created_at        TEXT NOT NULL
);

CREATE TABLE files (
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  path          TEXT NOT NULL,
  role          TEXT NOT NULL,   -- edited|read|created|deleted
  last_touched  TEXT NOT NULL,
  PRIMARY KEY (task_id, path)
);

CREATE TABLE commits (
  sha           TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  checkpoint_id TEXT REFERENCES checkpoints(id),
  message       TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE decisions (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  checkpoint_id TEXT REFERENCES checkpoints(id),
  text          TEXT NOT NULL,
  rationale     TEXT,
  supersedes_id TEXT REFERENCES decisions(id),
  created_at    TEXT NOT NULL
);

CREATE TABLE todos (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  text          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|done|blocked
  source_checkpoint_id TEXT REFERENCES checkpoints(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE commands (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  cmd_redacted  TEXT NOT NULL,   -- post-Redactor text, never raw
  exit_code     INTEGER,
  summary       TEXT,            -- e.g. "3 tests failed"
  created_at    TEXT NOT NULL
);

CREATE TABLE errors (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  message       TEXT NOT NULL,
  resolved      INTEGER NOT NULL DEFAULT 0,
  resolution    TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE open_questions (
  id            TEXT PRIMARY KEY,
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  text          TEXT NOT NULL,
  resolved      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
```

Indexes: `(task_id, created_at)` on every child table for fast "most recent N"
queries used heavily by the context builder.

**Schema migrations.** A `schema_meta(key, value)` table tracks the current
`schema_version`. `packages/core/src/migrations.ts` exports an ordered
`MIGRATIONS` list and a `runMigrations(db)` runner that's called from every
`openDatabase()` (i.e. transparently for every surface — CLI, MCP server,
extension), applying any pending migration (by version, ascending) inside
its own transaction and bumping `schema_version` after each. Currently
`MIGRATIONS` is empty — v1 is still the only schema version shipped — but
the runner itself is fully implemented and tested, so future schema changes
just append an entry rather than needing new infrastructure.

## 3a. Cross-Workspace Registry Schema

In addition to each workspace's own `.ariadne/state.db` above, a single
machine-wide registry database lives at `~/.ariadne/registry.db`
(overridable via `ARIADNE_REGISTRY_PATH`, mainly for test isolation), so any
surface can discover which workspace owns a given task without scanning the
filesystem or opening every workspace's `state.db` up front. See
`packages/core/src/Registry.ts` and `02-ARCHITECTURE.md` §4a for the full
design rationale.

```sql
CREATE TABLE workspaces (
  root          TEXT PRIMARY KEY,          -- absolute workspace root path
  last_seen_at  TEXT NOT NULL
);

CREATE TABLE tasks_index (
  task_id        TEXT PRIMARY KEY,         -- same id as tasks.id in that workspace's state.db
  workspace_root TEXT NOT NULL REFERENCES workspaces(root),
  title          TEXT NOT NULL,
  goal           TEXT,
  status         TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
```

This is a denormalized **index**, not a copy of task history — no
checkpoints, todos, decisions, errors, or open questions live here, only
enough of `tasks` to list/search/locate a task and route a request to the
workspace that actually owns it. It is kept in sync automatically (upserted
on every task mutation, and bulk-backfilled whenever a workspace store is
opened) and is treated as disposable/best-effort: if it's ever deleted or
falls out of sync, the worst case is a task temporarily not showing up in
cross-workspace listing/search until that workspace is opened again — no
per-workspace data is ever at risk, since `tasks_index` is never the
authoritative copy of anything.

## 4. Context Package (Output Shape)
`task.getContext(taskId, tokenBudget)` returns a structured object — not raw
Markdown — so each client (chat participant, CLI, MCP resource) can render it how
it likes (system message, printed text, etc.):

```jsonc
{
  "taskId": "...",
  "goal": "...",
  "branch": "feature/xyz",          // task's last known tracked git branch, or null
  "workspaceRoot": "/path/to/repo", // the workspace this task's store was opened from, if the caller supplied it (null otherwise) — especially useful for cross-workspace results
  "latestSummary": "...",           // most recent checkpoint, never trimmed
  "openQuestions": ["..."],
  "openTodos": ["..."],
  "blockedTodos": ["..."],        // todos explicitly marked blocked, surfaced separately (high tier)
  "unresolvedErrors": ["..."],
  "recentFiles": [{ "path": "...", "role": "edited" }],
  "recentCommits": [{ "sha": "...", "message": "..." }],
  "recentCommands": [{ "cmd": "...", "exitCode": 0 }],
  "decisions": ["..."],
  "truncated": { "commands": 12, "resolvedTodos": 5 } // what was cut for budget
}
```

## 5. Context Ranking Algorithm (v0.1, as shipped)
Priority tiers (never-trim > high > medium > low), filled greedily under
`tokenBudget` (implemented in `packages/core/src/ContextBuilder.ts`'s
`buildContext`, shared by every surface):
1. **Never-trim:** active task goal, latest checkpoint summary (always
   included, deducted from the budget before ranking the rest).
2. **High:** unresolved open questions, unresolved errors, and *current*
   decisions (a decision is "current" unless a later decision's
   `supersedes_id` points at it).
3. **Medium:** recently touched files (path + role), pending todos, and
   commits since the last checkpoint (message only).
4. **Low:** resolved todos, historical (superseded) decisions, the full
   command log.

Within each tier, candidates are ordered most-recent-first (by `created_at`,
or `updated_at` for resolved todos) and filled greedily until the budget
runs out; anything that doesn't fit is counted per-category in the
`truncated` map rather than silently dropped. Ranking is **tier + recency
only** — no recency-decay curve and no "2x boost if referenced by an open
question/error" scoring, and there's no "repo instructions" category (no
such data model concept exists). Those were part of an earlier, more
elaborate sketch of this algorithm; they were dropped in favor of the
simpler tier+recency ordering actually implemented, since it's easier to
reason about, fully deterministic, and sufficient for the MVP's "what am I
working on" use case. A smarter (e.g. embedding-based, or recency-decayed)
ranker remains a plausible future enhancement, not required now.

## 6. Checkpoint Triggers & Hierarchy
Triggers (event-driven, not fixed-interval): N files edited since last checkpoint
(default N=5, configurable), a git commit, an unresolved error appearing, explicit
`/checkpoint` or `ariadne checkpoint`, or chat/session idle >10 min after activity.

Hierarchy: `micro` checkpoints roll into a `session` checkpoint at session end
(re-summarized: dedupe file touches, keep decisions/errors verbatim, drop
transient noise); `session` checkpoints roll into `milestone` checkpoints at major
events (e.g., PR opened, task marked done). Rollup is purely rule-based string/set
aggregation for MVP — no LLM call required.

## 7. Redaction
Before any terminal command/output is written to `commands.cmd_redacted`, run
through pattern-based redaction (common secret patterns: `AKIA[0-9A-Z]{16}`,
`ghp_[A-Za-z0-9]{36}`, generic `key=`, `token=`, `password=` assignments, `.env`
file contents). This runs at capture time, not at read time — secrets should never
touch the DB in the first place.

## 8. Open Data-Model Questions
- ID scheme: ULID (sortable, no coordination) vs UUID — leaning ULID for natural
  chronological ordering in queries.
- Should `files.role` distinguish AI-edited vs human-edited? Useful for future
  "what did the AI actually change" audit trail — deferred, not MVP-blocking.
- ~~Exact token-counting method for budget enforcement~~ — resolved: a simple
  `chars / 4` heuristic (`estimateTokens` in `ContextBuilder.ts`), not a
  model-specific tokenizer, to stay LLM-agnostic and fully offline/deterministic.
