---
name: ariadne
description: 'Use for Ariadne task memory in this repo: resuming context at the start of a session, creating/switching tasks, recording checkpoints/decisions/todos/errors/open questions, logging commands, syncing git commits/files, searching task history, and exporting/backing up task state. Trigger whenever the user asks to resume prior context, track a decision or todo, log a bug/error, or otherwise persist working memory across sessions instead of relying on this chat transcript.'
---

# Ariadne Task Memory

This repo uses [Ariadne](https://github.com/LAKSHYAKUMAR45/Ariadne) — a
task-memory layer that persists an AI coding session's goal, decisions,
todos, errors, checkpoints, touched files, and commits in a local SQLite
database (`.ariadne/state.db`) instead of relying on the chat transcript,
which is lost when the session ends.

## When to use this skill

- At the **start** of a session: run `ariadne resume` (or `ariadne status`)
  to reload prior context before doing anything else.
- Whenever a **decision** is made that a future session (or teammate) would
  otherwise have to rediscover: `ariadne decision "<what>" -r "<why>"`.
- Whenever a **todo** is identified but not done immediately:
  `ariadne todo add "<text>"`.
- Whenever something **fails** (a build, a test, a command) and isn't fixed
  immediately: `ariadne error add "<summary>"`. Running the exact same
  command again successfully auto-resolves it — no manual cleanup needed.
- Whenever there's an **open question** blocking progress:
  `ariadne question add "<text>"`.
- Before a **risky or broad change**: `ariadne capture [task-id]` to persist a
  safe snapshot of the tracked, task-touched, plain-text files Ariadne is
  allowed to keep. It intentionally skips secrets, build output, vendored
  code, binaries, symlinks, oversized files, and `.ariadneignore`d paths.
- At a natural stopping point (a working increment, end of session):
  `ariadne checkpoint "<summary>" -l micro|session|milestone`.

## Core commands

```bash
# Session bootstrap
ariadne where                      # print the resolved workspace root + state db path
ariadne status                     # ranked, token-budgeted summary of the current task
ariadne resume                     # alias of "status" — use this to reload context

# Task lifecycle
ariadne task new "<title>" [-g "<goal>"]
ariadne task list
ariadne task use <task-id>
ariadne task pause|done|archive|reopen [task-id]
ariadne task edit [id] --title "<t>" --goal "<g>"

# Capture structured memory
ariadne checkpoint "<summary>" -l micro|session|milestone
ariadne capture [task-id]          # explicit safe file capture; prints id/count/bytes + skipped path/reason only
ariadne decision "<text>" -r "<rationale>" [--supersedes <decision-id>]
ariadne todo add "<text>"                 # + list/done/reopen/block/edit/delete
ariadne error add "<message>"             # + list/resolve/reopen/edit/delete
ariadne question add "<text>"             # + list/resolve/reopen/edit/delete

# Run a command with Ariadne watching (auto-records failures + successes)
ariadne exec <command> [args...]

# Git, search, export, safety
ariadne git-sync                   # backfill commits + touched files from git history
ariadne search "<query>"           # search titles/goals/todos/decisions/errors
ariadne export                     # render the current task as Markdown
ariadne backup                     # snapshot .ariadne/state.db
ariadne restore <snapshot-path>

# Cloud sync (this repository is configured for nodem2)
ariadne sync setup [username]      # one-time setup on each new machine
ariadne sync setup [username] --register  # create the account on first use
ariadne sync push
ariadne sync pull [--import-new]
```

## Workflow

1. Run `ariadne resume` at the start of a session to load prior context —
   don't rely on the chat transcript alone.
2. Create or switch to a task before doing substantive work:
   `ariadne task new "<title>"` (only if there isn't already an appropriate
   current task — check `ariadne status` first).
3. As you work, record decisions/todos/errors/questions as they come up,
   not in a batch at the end — memory captured in the moment is more
   accurate than a reconstruction later.
4. Before risky edits or large refactors, run `ariadne capture [task-id]`.
   It captures tracked, task-touched, plain-text files only and reports
   skipped path + reason instead of printing file contents.
5. Use `ariadne exec <cmd>` (instead of running `<cmd>` directly) for
   commands whose pass/fail result is worth remembering, e.g. test runs or
   builds — it auto-logs failures as errors and auto-resolves them once the
   same command succeeds.
6. Add a checkpoint at a meaningful stopping point; successful checkpoints
   also trigger the same safe file capture automatically.

## Cloud sync setup

- On each new machine, run `ariadne sync setup [username]`. It reads
  `.github/ariadne-sync.json`, verifies key-based SSH access, creates an
  SSH key and runs `ssh-copy-id` when needed, verifies nodem2 against the
  pinned SSH host-key fingerprint, starts the secure tunnel, prompts for
  the Ariadne account password without echoing it, and logs in.
- Use `--register` only when creating the cloud account for the first time.
- The setup command never stores the SSH password. After the public key is
  installed, sync commands automatically recreate a stopped tunnel.
- Run `ariadne sync push` after meaningful local changes and
  `ariadne sync pull --import-new` when adopting remote tasks on a new
  workspace.

## Notes

- All state is local SQLite (`.ariadne/state.db`) — no network calls unless
  cloud sync (`ariadne sync ...`) has been explicitly configured.
- Safe to run from any subdirectory of the repo — Ariadne walks up to find
  the workspace root (nearest `.git` or `.ariadne`).
- File capture is intentionally narrow: tracked, task-touched, plain-text
  files only. Ariadne reports capture id/count/bytes and skipped path + reason,
  never captured file contents.
