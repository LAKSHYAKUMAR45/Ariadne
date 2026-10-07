# Ariadne feature reference

This document describes the standalone project's implemented features and
availability boundaries. For installation and everyday workflows, use the
[user guide](05-USER-GUIDE.md). Design documents and the roadmap describe
intent; they are not a guarantee that every proposed integration is shipped.

## 1. Product overview

Ariadne keeps software-project working memory outside an AI chat. Tasks,
goals, decisions, todos, errors, questions, and checkpoints survive assistant
changes and session resets. Its knowledge workspace separately turns project
sources into versioned pages, searchable evidence, and a typed graph.

Baseline operation is local-first and offline. A local SQLite database is
authoritative; external providers and a self-hosted sync server are optional.
Ariadne is not a hosted AI assistant, a replacement for Git, or a guarantee
that every codebase question will retrieve the correct answer.

## 2. Packages and interfaces

| Package | Responsibility |
| --- | --- |
| `@ariadne-dev/core` | SQLite task/knowledge stores, context assembly, capture policy, analyzers, workers, retrieval, graph, and integration services. |
| `@ariadne-dev/cli` | The `ariadne` terminal interface, scripting, installation/bootstrap, sync setup, and portable knowledge archives. |
| `@ariadne-dev/mcp-server` | Local stdio MCP tools and read-only resources for AI clients. |
| `ariadne-vscode` | VS Code task panel, Copilot Chat participant, passive capture, and a confirmed knowledge-worker run-once command. |
| `@ariadne-dev/sync-server` | Optional Express/PostgreSQL task sync, browser sessions, encrypted capture history, and guarded operations APIs. |
| `packages/dashboard` | Browser operations/task UI and knowledge UI components. Knowledge components are not yet backed by routes in the standalone sync server. |

The CLI, MCP server, and VS Code extension share local core storage when
pointed at the same workspace. The browser console uses the self-hosted
server; it does not automatically open or synchronize your local knowledge
database.

## 3. Task memory

| Feature | What it provides |
| --- | --- |
| Task lifecycle | Create, list, select, edit, pause, complete, archive, and reopen tasks. Current task selection is per workspace. |
| Goals and checkpoints | An explicit goal and progress summaries at `micro`, `session`, or `milestone` level. |
| Decisions | Rationale, curation, and supersession so an obsolete decision need not dominate current context. |
| Todos | Pending, blocked, and done states, with edit/delete/reopen operations. |
| Errors | Unresolved/resolved history, resolution notes, and reopening/curation. |
| Open questions | Track unresolved issues and resolve or reopen them explicitly. |
| Context handoff | Deterministic, ranked, token-budgeted context including workspace, branch, blockers, evidence, and recent activity. No LLM is required. |
| Task search | Substring search across task titles/goals and related memory, files, and commits. This is distinct from knowledge retrieval. |
| Git integration | Record branches and new commits with `git-sync`; the editor also has passive Git capture. Git remains the source of code history. |
| Command logging | CLI `exec`, MCP `command_log`, and editor terminal capture record redacted commands and failures. |
| Markdown export | Explicitly render task memory for a handoff or PR. Exported copies require the same privacy care as the original data. |

### Capture and continuity

Explicit `capture` and checkpoint-triggered capture keep eligible, tracked,
task-touched text snapshots/diffs. Policy excludes sensitive-looking paths,
ignored content, symlinks, binaries, oversized files, generated output, and
other unsafe candidates. It is not a full repository backup.

VS Code additionally tracks saved files, terminal activity, diagnostics, and
commits. It never invents or silently switches a current task. Missing-task
and branch-mismatch warnings help avoid misattribution; terminal capture
requires shell integration.

### Multiple workspaces

Each workspace owns `.ariadne/state.db`. A machine-local
`~/.ariadne/registry.db` indexes workspace/task locations for cross-workspace
list, search, and explicit task-ID routing. Registry discovery is not sync,
and it does not consolidate project databases. Maintenance commands list,
prune, and forget registry entries.

## 4. Offline knowledge workspace

| Feature | What it provides |
| --- | --- |
| Projects | Active/archived knowledge collections with workspace scope and relative source roots. |
| Source ingestion | Scan eligible local files, register content hashes and versions, retain immutable source content, and enqueue analysis. |
| Deterministic analyzers | Python, JavaScript/TypeScript, Markdown, and text analysis with bounded source spans. Code relationships are static evidence, not runtime proof. |
| Analysis coverage | Supported, partial, unsupported, failed, and legacy-unknown coverage; deferred relationships remain visible rather than being fabricated. |
| Queue and worker | Project-scoped claims, renewable leases, cancellation/retry, immutable-version loading, persistence, graph materialization, and generated pages. |
| Worker pool | CLI run-once or watch processing with 1-8 slots. A host-local project setting controls default concurrency; explicit run options take precedence. |
| Worker status | Queue counts, unexpired active leases, failure codes, analyzer versions, deterministic/enriched/unknown completion totals, and bounded coverage/graph/synthesis/analytics summaries. |
| Versioned pages | Typed Markdown pages, version history, links, and provenance to source/task/checkpoint/decision/file/commit evidence. |
| Content-backed search | Page/source/task/hybrid modes, indexed lexical retrieval, exact-span source citations where available, bounded context, and ambiguity indicators. |
| Native graph | Typed nodes/edges, provenance and confidence, bounded neighborhoods and paths. |
| Reviews | Create/list/resolve/reopen reviews with actor/source audit records; generated content is not automatically human-approved. |
| Task/knowledge bridge | Redacted task projection into a knowledge project and task creation from an insight. |
| Portable archives | Project-scoped, validated export/import and optional Obsidian-compatible Markdown. |

`worker run --watch` polls the queue. It is **not** a CLI source-file watcher:
changed files still need ingestion or an integrating freshness service.
`--watch --json` is rejected; run-once supports a single JSON result envelope.

Rich document and media ingestion have core adapter interfaces, but PDF,
Office, image, audio, and video parsing are not bundled turnkey CLI features.
Other languages may receive text-level processing; that does not imply
language-aware symbol/call analysis.

### Retrieval and evidence

Knowledge search distinguishes pages, sources, and task results. Source
citations can contain offsets and line/column ranges, while page/task results
may have reference-only evidence. Confidence/ambiguity describe retrieval
competition, not a calibrated probability that an answer is correct.

Optional local semantic reranking uses a locally built project model and
host-local enablement. Search does not build that model implicitly and falls
back to lexical retrieval when it is unavailable. This is separate from
external-provider embeddings.

## 5. Optional providers and core integration services

Provider profiles support OpenAI-compatible endpoint/model/capability
metadata, timeouts, enable/disable/remove, and explicit testing. Secrets stay
in host environment variables; only the environment-variable name is stored.
CLI requests directly support literal loopback HTTP origins. Named public
hosts fail closed without the reviewed pinned transport/policy integration.

Worker enrichment is optional. Provider failure produces bounded warnings
without making successful deterministic analysis depend on the provider.
Adding a profile does **not** enable CLI research or chat sending.

The following implemented core services require an integrating caller; they
must not be confused with complete end-user commands:

| Service | Boundary |
| --- | --- |
| Answer synthesis | Grounded cross-file answers with per-claim citations, ambiguity warnings, and optional validated provider refinement. |
| Semantic summaries | Source-version, page-version, and project summaries; deterministic generation with optional provider assistance. No CLI/MCP summary-generation command. |
| Freshness/reconciliation | Source scans, new-version registration, requeueing, missing-source tracking, and supervised file watching/recovery. No dedicated CLI freshness/watch command. |
| Graph reporting | Recomputable completeness/ambiguity reports, evidence/provenance checks, community/scoring/insight services. The CLI exposes basic graph inspection, not a full reporting UI. |
| Search analytics | Opt-in host-local query exposure/feedback/regression tracking with bounded, privacy-conscious records. No general CLI analytics-management surface. |
| Skills | Discover and explicitly select validated `SKILL.md` data; imported instructions do not authorize arbitrary execution. |
| Research/chat | Provider capability checks and explicit execution integration. CLI conversation create/list/history work, but research execution and chat send remain provider-required. MCP queues requests without invoking a provider. |
| Document/media adapters | Pluggable extraction; absent adapters report unsupported instead of claiming a parse. |

### Graphify compatibility

The CLI, MCP tool, and VS Code helpers can invoke a separately installed
Graphify binary for indexing/query/path/explain workflows. This is a
passthrough integration, not Ariadne's own indexing engine. A validated
Graphify JSON export can also be imported into the native knowledge graph,
preserving supported evidence/confidence and reporting rejected edges.

## 6. Interface availability

| Capability | CLI | MCP | VS Code | Browser console |
| --- | --- | --- | --- | --- |
| Task memory/context | Yes | Yes | Panel/chat | Server-side task inspection |
| Local knowledge project/source/page/search/graph/reviews | Yes, within each command's contract | Bounded tools | Knowledge panel actions are incomplete | Knowledge UI exists; standalone backing routes are absent |
| Offline worker run-once | Yes | Confirmed tool | Confirmed palette command | No mounted standalone knowledge API |
| Worker watch/concurrency/provider management | Yes | No corresponding full management surface | No corresponding full management surface | Not available as a complete standalone workflow |
| Full knowledge archive transfer | Yes | Manifest write/read only | Use CLI | Not available |
| Task cloud sync | Yes | Installed CLI wrapper | Installed CLI wrapper | Inspect server state |
| Privileged server operations | Tracked operator/deploy scripts | Not general-purpose shell tools | Not general-purpose shell tools | Guarded admin workflows |

MCP knowledge writes require `confirm=true` and reads are bounded. Its
`knowledge_export`/`knowledge_import` names refer to manifest operations, not
the CLI's full portable archive transfer.

The VS Code task UI includes Overview, Activity/capture health, Context,
Review readiness, Todos, Decisions, Errors, Questions, Files, Search,
Graphify, and Sync. Task templates cover feature, bugfix, review, research,
and incident workflows. Readiness checks are advisory, not proof of test
success or a security review.

## 7. Optional self-hosted sync and operations

Task sync uses an Express/PostgreSQL service, named client profiles, and
explicit push/pull. Synced memory includes tasks, checkpoints, todos,
decisions, errors, questions, and commands. Eligible file captures also have
encrypted upload/history support; Git commit records and ordinary touched-file
metadata are not a general repository sync.

The server stores uploaded capture content using authenticated encryption.
Local SQLite/source content is not thereby encrypted. Active members share
the singleton team's task space; there is no per-task ACL hierarchy.
Conflict handling is visible and selectable, and hard deletes do not
propagate through task-memory sync. Knowledge projects/pages/graphs do not
travel through task sync.

The browser console provides Overview, Members, Tasks, Backups, Services,
Deployments, Logs, and Audit. Members are restricted to task access; other
operations require administrator authority. Browser sessions and CSRF
protection are separate from sync bearer tokens.

The server also contains shared-secret-authenticated SSO code minting and a
browser callback exchange. These are integration infrastructure, not a
general hosted identity-provider setup. The JCNR login entry flow and
deployment-specific additions remain governed by that repository's overlays.

Privileged changes require recent password reauthentication. Applicable
actions also require exact confirmation phrases. Backups must be verified;
restore/deploy/rollback create and verify a safety backup. Typed operations,
fixed service/log allowlists, trusted revisions, durable results, and audit
events constrain the console: it is not remote shell access.

See the [operator runbook](../deploy/nodem2/README.md) for deployment,
credential rotation, backup/restore, and rollback procedures. JCNR deployment
overlays and the jcnr-triage SSO entry flow are separate from this standalone
guide; consult that repository's deployment instructions for those behaviors.

## 8. Portability, safety, and limits

Knowledge archives validate project identity, same-project references,
explicit table columns, paths, required entries, checksums, and size limits
before transactional import. The manifest project ID must match the CLI
argument. `--replace` is deliberate replacement of that same project, not a
merge or ID remap.

Archive versions 1 and 2 are supported. Provider profiles/configuration,
host-local settings, derived indexes/models, and privacy-omitted data do not
travel as portable configuration. Compatible semantic summaries can travel
without provider-profile names. Import reports required derived-data rebuilds.
Obsidian support is an export format, not live two-way synchronization.

Redaction is pattern-based, not a guarantee of secret removal. Inspect data
before ingestion, provider use, export, or sync. A database backup alone does
not include all immutable source/page files; preserve those too.

The project is pre-release. The checked-in
[benchmark report](benchmarks/knowledge-baseline-v1.md) measures a small
synthetic `naas-v1` corpus, not universal accuracy on arbitrary repositories
or public datasets. No blanket public-benchmark or production-perfect claim
follows from those results.

## 9. Further reading

- [User guide](05-USER-GUIDE.md): installation, task and knowledge workflows,
  troubleshooting, and operator usage.
- [Knowledge workspace](knowledge-wiki.md): storage, integration contracts,
  synthesis, and evidence.
- [Knowledge worker](knowledge-worker.md): leases, concurrency, status,
  provider safety, and acceptance.
- [Knowledge migration](knowledge-migration.md): archive transfer and limits.
- [Architecture](02-ARCHITECTURE.md) and [data model](03-DATA-MODEL.md):
  design context; verify current behavior against implementation.
- [MCP reference](../packages/mcp-server/README.md) and
  [VS Code reference](../packages/vscode-extension/README.md): client setup.
- [Sync server](../packages/sync-server/README.md) and
  [deployment runbook](../deploy/nodem2/README.md): self-hosted operations.
