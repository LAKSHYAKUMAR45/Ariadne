# Ariadne — Cloud Sync / Team Task Graph (Design-Only Draft v0.1)

**Status: design only. No implementation exists yet.** This document exists to
turn "cloud sync / team-shared task graph" from a one-line roadmap bullet into
a concrete-enough proposal that a future session (or a human) can build from,
without committing Ariadne to any infra/vendor choice today. Every open
question in §6 needs a real product decision before Phase 1 (§5) starts.

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

## 2. Goals (assuming this is greenlit)
- Let a **team** see and update a shared subset of task state (goal, status,
  todos, decisions, checkpoints) across machines/users, not just one
  developer's local workspace.
- Preserve the "SQLite is the local source of truth" principle
  (`docs/03-DATA-MODEL.md` §1) for **offline-first** operation — sync should
  be an optional, best-effort overlay, not a hard dependency for local usage.
- Avoid forcing every existing single-user workflow (CLI, MCP server, VS Code
  extension) to become network-dependent. A user who never opts in to sync
  should see zero behavior change, zero new required config, and zero new
  network calls.

## 3. Non-Goals (explicitly out of scope for v1, if built)
- Real-time collaborative editing (e.g. simultaneous cursors in one
  checkpoint) — tasks/checkpoints are append-mostly, not documents; this
  doesn't need CRDT-level guarantees.
- Full team permission systems (roles, org hierarchies) — start with
  "anyone with the shared link/token can read+write," matching the low-
  ceremony feel of the rest of the tool; revisit only if actually requested.
- Self-hosting story day one — pick the simplest hosted option first (§6),
  self-host later if there's real demand.

## 4. Proposed Shape (sketch, not committed)
1. **Sync is per-task, opt-in, and additive to the existing schema.** A task
   gains an optional `remote_id`/`synced_at` pair (nullable columns on the
   existing `tasks` table, mirroring how `branch` was added) so an
   un-synced task behaves exactly as it does today.
2. **A thin sync server** (could be a simple HTTP API backed by Postgres, or
   an existing BaaS — see §6) exposes CRUD for the subset of entities worth
   sharing: tasks, checkpoints, todos, decisions, open questions — the same
   entities `ContextBuilder` already ranks, deliberately *not* raw file/
   command logs (privacy: those are the most likely to contain secrets even
   after `Redactor.ts`, and the least useful to share).
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
   than a wholly new table.

## 5. Phasing (if greenlit)
1. **Phase 0 — Design spike / vendor decision.** Answer §6, pick a hosting
   approach, write the actual server-side schema and API contract as its own
   doc (this document deliberately stops short of that).
2. **Phase 1 — Read-only sync.** `ariadne sync push` uploads; a very small
   web view or `ariadne sync pull --readonly` proves the round trip works
   end to end (auth, transport, one entity type — start with just tasks +
   checkpoints) before any conflict-resolution logic is built.
3. **Phase 2 — Two-way sync + conflict handling** for the full entity set in
   §4.2.
4. **Phase 3 — Surface wiring**: VS Code extension UI to show "who else is
   on this task," CLI `ariadne sync status`.

## 6. Open Questions (must be answered before Phase 0 starts)
- **Hosting**: run Ariadne's own server (cost, ops burden, must be maintained
  indefinitely) vs. build on an existing BaaS (Supabase/Firebase/PlanetScale
  etc. — faster to ship, but couples the project to a vendor and its pricing)
  vs. a GitHub-native approach (e.g. storing shared state as a GitHub Gist or
  repo file the team already has push access to, avoiding new infra
  entirely, at the cost of weaker query/search capability than a real DB)?
- **Auth model**: GitHub OAuth (natural fit given the target user base is
  developers already using GitHub, and this repo's own npm/VS Code identity
  is GitHub-centric) vs. a bespoke account system vs. no auth at all
  (shared-secret link, lowest friction, weakest security)?
- **Pricing/business model**: is this a free feature, or does hosting cost
  need to be recovered (subscription, usage-based, sponsor-funded)? This
  materially affects the hosting choice above.
- **Data retention & deletion**: what happens to synced task data if a user
  deletes their local task, stops paying, or asks for their data to be
  deleted? Needs an answer before any real user data is stored remotely.
- **Scope of "team"**: is a "team" a GitHub org, an ad-hoc invite list, or
  just "anyone with this link"? This is the single biggest driver of how
  much auth/permission complexity is actually needed.
- **Redaction guarantees over the wire**: `Redactor.ts` already strips
  obvious secrets from local commands before they're stored — does the sync
  payload need a *second*, stricter redaction pass (e.g. never sync raw
  command text or file contents, only task/checkpoint/todo/decision text)?
  This doc's §4.2 already assumes "yes" by scoping the synced entity set
  down, but that assumption should be explicitly confirmed.

## 7. Recommendation
Given the current single-maintainer, no-revenue stage of the project, the
lowest-risk starting point if this is pursued at all is the **GitHub-native
approach** in §6 (store shared task state as JSON/Markdown in a repo the
team already has access to, using the existing GitHub auth every contributor
already has) rather than standing up a dedicated server + database + a new
account system. It sacrifices query power and realtime-ness, but requires
zero new hosting, zero new auth system, and zero new recurring cost — and it
can still reuse the `Exporter.ts` Markdown rendering already shipped. This
should be revisited if/when the project has enough real users to justify
dedicated infrastructure.
