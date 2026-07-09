import * as fs from 'node:fs';
import * as path from 'node:path';

const GITIGNORE_FILE = '.gitignore';
const IGNORE_PATTERN = '.ariadne/';

/**
 * Matches any existing .gitignore line that already covers `.ariadne/`
 * (with or without a leading slash, with or without a trailing slash), so we
 * don't add a redundant duplicate entry if the user already has one.
 */
function alreadyIgnoresAriadne(gitignoreContents: string): boolean {
  return gitignoreContents
    .split(/\r?\n/)
    .some((line) => /^\/?\.ariadne\/?$/.test(line.trim()));
}

/**
 * Ensures `.ariadne/` is listed in the workspace's `.gitignore`, creating the
 * file if it doesn't exist yet. Best-effort and silent on failure (e.g.
 * read-only filesystem) — this must never block normal store operations.
 *
 * Enforces the "gitignored by default" locked decision (docs/03-DATA-MODEL.md
 * §1): `.ariadne/state.db` can capture terminal commands, decisions, and
 * error messages that shouldn't be accidentally committed to the repo.
 */
export function ensureGitignored(workspaceRoot: string): void {
  try {
    const gitignorePath = path.join(workspaceRoot, GITIGNORE_FILE);
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';

    if (alreadyIgnoresAriadne(existing)) return;

    const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
    const prefix = existing.length > 0 ? `${existing}${needsLeadingNewline ? '\n' : ''}\n` : '';
    fs.writeFileSync(gitignorePath, `${prefix}# Ariadne task state (local, may contain captured commands/decisions)\n${IGNORE_PATTERN}\n`, 'utf8');
  } catch {
    // Never let gitignore bookkeeping block a store from opening.
  }
}
