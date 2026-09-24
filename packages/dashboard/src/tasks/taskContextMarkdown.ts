import type { TaskSummary, TimelineEvent } from '../api/types';

/**
 * Dashboard-native task context export.
 *
 * This is a plain chronological dump of exactly what the Timeline pane
 * already shows for a task -- it intentionally does NOT reproduce the
 * ranked, token-budgeted context that `@ariadne-dev/core`'s
 * `ContextBuilder` produces for the CLI/MCP server/VS Code extension.
 * Those surfaces read the local SQLite `TaskStore`; the web dashboard
 * only has this team's Postgres-backed timeline data, so it gets a
 * simpler, storage-appropriate export instead of pretending to be the
 * same ranked package.
 */

const EVENT_LABELS: Record<TimelineEvent['kind'], string> = {
  task: 'Task created',
  commit: 'Commit',
  checkpoint: 'Checkpoint',
  capture: 'File capture',
  command: 'Command',
  decision: 'Decision',
  todo: 'Todo',
  error: 'Error',
  question: 'Open question',
};

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function formatMetadataLine(event: TimelineEvent): string | null {
  const { metadata } = event;
  const parts: string[] = [];
  if (typeof metadata.status === 'string') parts.push(`status: ${metadata.status}`);
  if (typeof metadata.branch === 'string' && metadata.branch) parts.push(`branch: ${metadata.branch}`);
  if (typeof metadata.level === 'string') parts.push(`level: ${metadata.level}`);
  if (Array.isArray(metadata.files) && metadata.files.length > 0) {
    parts.push(`files: ${metadata.files.map((file) => file.path).join(', ')}`);
  }
  return parts.length > 0 ? parts.join(' \u00b7 ') : null;
}

export function buildTaskContextMarkdown(task: TaskSummary, events: TimelineEvent[]): string {
  const lines: string[] = [];
  lines.push(`# ${task.title}`);
  lines.push('');
  lines.push(`- Task ID: ${task.localId}`);
  lines.push(`- Status: ${task.status}`);
  if (task.goal) lines.push(`- Goal: ${task.goal}`);
  lines.push(`- Branch: ${task.branch ?? 'none'}`);
  lines.push(`- Workspace: ${task.workspaceLabel ?? 'unlabelled'}`);
  lines.push(`- Owner: ${task.owner}`);
  lines.push(`- Last updated: ${formatTimestamp(task.updatedAt)}`);
  lines.push('');
  lines.push('## Timeline');
  lines.push('');

  if (events.length === 0) {
    lines.push('_No timeline events recorded yet._');
  } else {
    for (const event of events) {
      const label = EVENT_LABELS[event.kind] ?? event.kind;
      lines.push(`### ${formatTimestamp(event.occurredAt)} -- ${label}`);
      lines.push('');
      lines.push(event.summary);
      const metadataLine = formatMetadataLine(event);
      if (metadataLine) {
        lines.push('');
        lines.push(`(${metadataLine})`);
      }
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Wraps context markdown in a ready-to-paste `copilot -i` command using a
 * quoted heredoc, so the terminal never re-interprets quotes/backticks/`$`
 * inside the markdown. Picks a marker line that doesn't already appear in
 * the content so the heredoc can't be terminated early by accident.
 */
export function buildCopilotCliCommand(markdown: string): string {
  let marker = 'ARIADNE_CONTEXT_EOF';
  let suffix = 0;
  while (markdown.includes(marker)) {
    suffix += 1;
    marker = `ARIADNE_CONTEXT_EOF_${suffix}`;
  }
  return `copilot -i "$(cat <<'${marker}'\n${markdown}${marker}\n)"`;
}
