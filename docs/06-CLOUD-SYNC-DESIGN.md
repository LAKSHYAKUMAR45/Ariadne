# Ariadne — Cloud Sync / Team Task Graph (Design Draft v0.2 — Decisions Locked)

**Status: design decided for the singleton-team internal deployment.** This
document turns "cloud sync / team-shared task graph" from a one-line roadmap
bullet into a concrete-enough proposal that a future session (or a human)
can build from.
**Update (v0.2):** all six open questions from v0.1's §6 have been answered
for this project's actual deployment context — **internal use only, no
external/paying users** — see §6 below. The server-side schema + API
contract now captures that singleton-team model in detail.


## 1. Why This Is Different From Everything Else Shipped So Far
Every other post-MVP feature this project has shipped (`PluginRegistry`,
`CheckpointSummarizer`, cross-repo `task_link_groups`, embedding-based
ranking) is **additive and local**: new interfaces/tables in the existing
per-workspace SQLite file (`.ariadne/state.db`) or the existing local
cross-workspace registry (`~/.ariadne/registry.db`), with zero new runtime
dependencies, zero network calls, and zero new failure modes for existing
single-user usage.

Cloud sync is categorically different:
- It requires **a server component** Ariadne doesn't have today (today it's a
  CLI + VS Code extension + MCP server, all purely local processes).
- It requires **authn/authz** (who can read/write which tasks) — nothing in
  the current data model has a notion of "user" or "permission" at all.
- It requires **a conflict resolution strategy** for concurrent edits (today,
  SQLite's own transaction semantics are the only concurrency control, and
  that only works because there's exactly one writer process per local file).
- It has **real recurring cost and privacy implications** (hosting, data
  retention, what happens to a user's task data if they stop paying / the
  service shuts down) that no other feature in this repo has had to consider.

For these reasons this feature should not be built opportunistically the way
the others were — it needs an explicit go/no-go and answers to §6 first.

## 2. Goals (decided: build this)
- Let one **team** (internal users only, on a self-hosted server — see §6)
  see and update a shared subset of task state (goal, status, todos,
  decisions, checkpoints) across machines/users, not just one developer's
  local workspace. The first successful registration becomes that team's
  admin; later registrations join the same team as members.
- Preserve the "SQLite is the local source of truth" principle
  (`docs/03-DATA-MODEL.md` §1) for **offline-first** operation — sync should
  be an optional, best-effort overlay, not a hard dependency for local usage.
- Avoid forcing every existing single-user workflow (CLI, MCP server, VS Code
  extension) to become network-dependent. A user who never opts in to sync
  should see zero behavior change, zero new required config, and zero new
  network calls.

## 3. Non-Goals (explicitly out of scope for v1)
- Real-time collaborative editing (e.g. simultaneous cursors in one
  checkpoint) — tasks/checkpoints are append-mostly, not documents; this
  doesn't need CRDT-level guarantees.
- Role-based/org-hierarchy permission systems — per §6, this deployment has
  exactly one shared team. Revisit only if the tool is ever opened up beyond
  internal use and needs multiple teams or org boundaries.
- Multi-tenant hosting, billing, or public sign-up — this is an internally
  operated server for a known set of users, not a hosted product.

## 4. Proposed Shape (decided direction, still sketch-level on implementation detail)
1. **Sync is per-task, opt-in, and additive to the existing schema.** A task
   gains an optional `remote_id`/`synced_at` pair (nullable columns on the
   existing `tasks` table, mirroring how `branch` was added) so an
   un-synced task behaves exactly as it does today.
2. **A self-hosted sync server** (§6: our own server, not a BaaS) — an HTTP
   API backed by a database (e.g. Postgres) with its own `users` table
   (username + hashed password, §6) for auth, plus CRUD endpoints for the
   syncable entities: tasks, checkpoints, todos, decisions, open questions,
   *and* commands/files (§6: internal use means these can sync too — the
   only hard exclusion is actual secrets, which `Redactor.ts`'s existing
   local pass already strips before anything is written to SQLite in the
   first place; see §6 for why no second redaction tier is needed here).
3. **Push-based sync, not live subscription, for v1.** A new `ariadne
   sync push`/`ariadne sync pull` (or an equivalent MCP tool / VS Code
   command) reads local SQLite rows changed since `synced_at`, uploads them,
   and downloads anything newer from the server — modeled after `git
   push`/`git pull`, not a websocket. This sidesteps building realtime
   infrastructure for a v1 and matches the existing git-centric mental model
   (`docs/02-ARCHITECTURE.md`'s GitWatcher integration).
4. **Conflict resolution: last-write-wins by field, with a visible warning.**
   Simpler than a full CRDT/OT system; acceptable because task metadata
   (status, goal, todo text) is low-frequency-write compared to, say, a
   real-time document. If a field changed both locally and remotely since
   the last sync, the sync command reports the conflict and asks the user to
   pick a side (or takes remote-wins/local-wins based on a flag) rather than
   silently overwriting.
5. **Reuse `CrossRepoLinks.ts`'s "group" concept** for "team task" instead of
   inventing a second grouping mechanism — a synced task is conceptually a
   task that belongs to a remote-backed group, so the existing
   `task_link_groups` table (already in the shared local registry) is a
   plausible foundation for "which tasks are shared, and with whom" rather
   than a wholly new table. Given §6's singleton-team model (only active
   members of that team can see/edit shared tasks), this group is closer to
   "which tasks are published to the server" than a permissioned membership
   list — no per-task ACL logic needed inside the group itself for v1.
6. **Deletion is local-only (§6).** `ariadne task archive`/deleting a local
   task never issues a delete call to the server; the server is additive-only
   from the client's perspective in v1 (simplifies the API surface — no
   delete endpoint needed yet, and no risk of one user's local cleanup
   destroying another user's visibility into shared history).

## 5. Phasing
1. **Phase 0 — Server schema + API contract.** All vendor/product decisions
   are now made (§6) — the paired contract doc now records the actual
   server-side schema (users, tasks, checkpoints, todos, decisions, open
   questions, commands, files) and REST/RPC API surface, while this document
   stays at the decision/rationale level.
2. **Phase 1 — Read-only sync.** `ariadne sync push` uploads; a very small
   web view or `ariadne sync pull --readonly` proves the round trip works
   end to end (auth, transport, one entity type — start with just tasks +
   checkpoints) before any conflict-resolution logic is built.
3. **Phase 2 — Two-way sync + conflict handling** for the full entity set in
   §4.2.
4. **Phase 3 — Surface wiring**: VS Code extension UI to show "who else is
   on this task," CLI `ariadne sync status`.

## 6. Decisions (v0.2 — internal-use deployment, resolves v0.1's open questions)
All of the following were confirmed for this project's actual context: an
**internally operated deployment for a known set of users, not a public
product** — which materially simplifies several of these versus the v0.1
draft's general-purpose framing.
- **Hosting: run our own server.** No BaaS, no GitHub-native storage
  workaround — full control, and the ops burden is acceptable for internal
  use. This is the one place v0.1's own recommendation (GitHub-native) was
  explicitly overridden — that recommendation assumed a public/low-resource
  context that doesn't apply here.
- **Auth model: username/password against a database we run.** A `users`
  table on the sync server (username + salted/hashed password — e.g.
  bcrypt/argon2, never plaintext) rather than GitHub OAuth or a bespoke
  token-link scheme. Simple to implement and sufficient for an internal,
  known-user-set deployment.
- **Membership model: one team, one admin.** The server keeps a single
  shared team per deployment. The first registration becomes that team's
  admin; later registrations join as active members. All sync routes check
  active membership before allowing reads or writes.
- **Network admin is immutable through the normal admin API.** The
  `/api/v1/admin/*` member-management surface can toggle other members'
  active state, but it cannot promote, demote, or deactivate the singleton
  admin. Root-only admin transfer belongs in the separate operator flow
  planned elsewhere.
- **404 hides inaccessible resources.** Sync endpoints intentionally return
  `404` for tasks that are outside the caller's team or otherwise not
  visible, so the API does not leak cross-team existence.
- **Pricing/business model: free — no pricing needed.** Internal tool, no
  external/paying users, so no billing, metering, or plan tiers to design.
- **Data retention & deletion: server-side data is additive/indefinite.**
  Deleting a local task does **not** delete it from the server — the server
  keeps synced data indefinitely regardless of local state (see §4.6 for the
  API-surface consequence: no delete endpoint needed for v1). If a hard
  server-side deletion/GC need arises later (e.g. disk usage), it can be a
  separate admin-only operation, not part of the client-facing sync protocol.
- **Scope of "team": one shared internal team.** Any active member of the
  singleton team can see and edit the shared tasks for that team — no
  per-task ACLs, invite lists, or org/group structure for v1. This is the
  simplest possible model and matches an internal, trusted-user deployment;
  revisit only if this is ever exposed beyond the current internal audience.
- **Redaction over the wire: no extra restriction beyond existing
  `Redactor.ts` secret-stripping.** Unlike v0.1's draft (which scoped the
  synced entity set down to exclude raw commands/files entirely, out of
  caution for a general-audience product), the internal-use context here
  means commands and files **can** sync too — the only hard exclusion is
  actual sensitive data (passwords, tokens, keys), which `Redactor.ts`
  already strips locally before anything is written to SQLite, so there's
  nothing additional to strip before upload. No second server-side redaction
  pass is required for v1, though revisiting this is cheap later (it would
  just be an additional filter step in the sync-push code path) if the
  trust model ever changes.

## 7. Status
All open questions from v0.1 are now resolved for this deployment (§6) —
the paired server schema + API contract now reflects those decisions, and
this document remains the rationale layer for them.
