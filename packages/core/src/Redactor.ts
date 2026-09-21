/**
 * Shared, rule-based secret redaction — per docs/03-DATA-MODEL.md §7.
 *
 * Runs at *capture* time (before anything is written to `commands.cmd_redacted`
 * or any other store column), not at read time: secrets should never touch
 * the SQLite file in the first place. Deliberately pattern-based only (no
 * LLM calls), matching the project's "rule-based only for MVP" decision.
 *
 * Used by the VS Code extension's terminal-command passive capture today;
 * exported from @ariadne-dev/core so the CLI and MCP server can reuse the exact
 * same rules if/when they gain command-capture of their own, instead of
 * each surface reimplementing its own ad-hoc heuristic.
 */

export interface RedactionRule {
  /** Short id for the rule, useful in tests/debugging. */
  name: string;
  pattern: RegExp;
  /** Replacement string or function, passed to String.replace. */
  replace: string | ((substring: string, ...args: unknown[]) => string);
}

/**
 * Known secret-shaped tokens (cloud provider keys, common CI/VCS tokens),
 * redacted wholesale regardless of surrounding context.
 */
const KNOWN_TOKEN_RULES: RedactionRule[] = [
  { name: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/g, replace: '***' },
  { name: 'github-pat', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: '***' },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: '***' },
  { name: 'openai-key', pattern: /\bsk-[A-Za-z0-9]{20,}\b/g, replace: '***' },
  {
    name: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: '***REDACTED PRIVATE KEY***',
  },
];

/**
 * Generic `--flag value` / `flag=value` / `FLAG: value` assignments where the
 * flag/key name itself signals sensitivity (password, token, secret, api key,
 * auth, credential, etc). Value is redacted, flag name is kept for context.
 */
const SENSITIVE_KEY_NAME = '(?:password|passwd|pwd|token|secret|api[-_]?key|apikey|auth|credential|access[-_]?key)';

const ASSIGNMENT_RULES: RedactionRule[] = [
  // --password=hunter2, --password hunter2, -p=hunter2
  {
    name: 'cli-flag-assignment',
    pattern: new RegExp(`(--?${SENSITIVE_KEY_NAME}\\S*)([=\\s]+)(\\S+)`, 'gi'),
    replace: '$1$2***',
  },
  // TOKEN=abc123, export SECRET=xyz, key: "abc", "api_key": "abc"
  {
    name: 'env-style-assignment',
    pattern: new RegExp(`(["']?)(${SENSITIVE_KEY_NAME})\\1(\\s*[:=]\\s*)("[^"]*"|'[^']*'|\\S+)`, 'gi'),
    replace: '$1$2$1$3***',
  },
];

export const DEFAULT_REDACTION_RULES: RedactionRule[] = [...KNOWN_TOKEN_RULES, ...ASSIGNMENT_RULES];

export const MAX_REDACTED_LENGTH = 500;

/** Appended when a command is cut short by `MAX_REDACTED_LENGTH`, so a truncated command in `commands`/`errors` reads as "cut off here" rather than as a mangled, complete-looking string. */
const TRUNCATION_SUFFIX = ' …[truncated]';

/**
 * Redacts likely secrets from a single line of text (e.g. a terminal command
 * or its output) using pattern-based rules, then truncates to a bounded
 * length so a single pasted blob can't blow up storage.
 *
 * Multi-line input (a heredoc, a pasted multi-line script, etc.) is first
 * collapsed to its first line plus a "+N more lines" summary. Without this,
 * a long heredoc would get sliced apart by the length cap below at an
 * arbitrary byte offset — often mid-token, deep inside the *body* of the
 * heredoc rather than its meaningful first line — leaving an unreadable
 * fragment in `commands.cmd_redacted` / the auto-generated "Command failed"
 * error message.
 */
export function redact(text: string, rules: RedactionRule[] = DEFAULT_REDACTION_RULES): string {
  let result = text;
  for (const rule of rules) {
    result = result.replace(rule.pattern, rule.replace as string);
  }

  const lines = result.split('\n');
  if (lines.length > 1) {
    const extra = lines.length - 1;
    result = `${lines[0].trimEnd()} …(+${extra} more line${extra === 1 ? '' : 's'})`;
  }

  if (result.length > MAX_REDACTED_LENGTH) {
    const budget = MAX_REDACTED_LENGTH - TRUNCATION_SUFFIX.length;
    result = `${result.slice(0, budget)}${TRUNCATION_SUFFIX}`;
  }

  return result;
}

/** Back-compat alias matching the extension's original function name. */
export function redactCommand(cmd: string): string {
  return redact(cmd);
}
