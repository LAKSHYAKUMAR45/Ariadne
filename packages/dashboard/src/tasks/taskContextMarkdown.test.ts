import { describe, expect, it } from 'vitest';
import type { TaskSummary, TimelineEvent } from '../api/types';
import { buildCopilotCliCommand, buildTaskContextMarkdown } from './taskContextMarkdown';

const task: TaskSummary = {
  taskId: 'task-1',
  localId: 'local-1',
  title: 'Ship the widget',
  goal: 'Make the widget ship correctly',
  status: 'in_progress',
  branch: 'feat/widget',
  workspaceLabel: 'widget-repo',
  owner: 'alice',
  captureCount: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

const events: TimelineEvent[] = [
  {
    kind: 'task',
    id: 'task-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    summary: 'Ship the widget',
    metadata: { status: 'in_progress', branch: 'feat/widget' },
  },
  {
    kind: 'decision',
    id: 'dec-1',
    occurredAt: '2026-01-01T12:00:00.000Z',
    summary: 'Use bcrypt for password hashing',
    metadata: {},
  },
];

describe('buildTaskContextMarkdown', () => {
  it('renders task metadata and a chronological event list', () => {
    const markdown = buildTaskContextMarkdown(task, events);

    expect(markdown).toContain('# Ship the widget');
    expect(markdown).toContain('- Task ID: local-1');
    expect(markdown).toContain('- Goal: Make the widget ship correctly');
    expect(markdown).toContain('- Branch: feat/widget');
    expect(markdown).toContain('### 2026-01-01T00:00:00.000Z -- Task created');
    expect(markdown).toContain('### 2026-01-01T12:00:00.000Z -- Decision');
    expect(markdown).toContain('Use bcrypt for password hashing');
    expect(markdown).toContain('(status: in_progress \u00b7 branch: feat/widget)');
  });

  it('renders a placeholder when there are no events', () => {
    const markdown = buildTaskContextMarkdown(task, []);
    expect(markdown).toContain('_No timeline events recorded yet._');
  });

  it('falls back for missing optional fields', () => {
    const bareTask: TaskSummary = { ...task, goal: null, branch: null, workspaceLabel: null };
    const markdown = buildTaskContextMarkdown(bareTask, []);
    expect(markdown).not.toContain('- Goal:');
    expect(markdown).toContain('- Branch: none');
    expect(markdown).toContain('- Workspace: unlabelled');
  });
});

describe('buildCopilotCliCommand', () => {
  it('wraps markdown in a quoted heredoc copilot command', () => {
    const command = buildCopilotCliCommand('# Title\nSome content\n');
    expect(command).toContain("copilot -i \"$(cat <<'ARIADNE_CONTEXT_EOF'");
    expect(command).toContain('# Title\nSome content\nARIADNE_CONTEXT_EOF');
  });

  it('picks a fresh marker when the default marker collides with content', () => {
    const markdown = 'contains ARIADNE_CONTEXT_EOF inline\n';
    const command = buildCopilotCliCommand(markdown);
    expect(command).toContain("<<'ARIADNE_CONTEXT_EOF_1'");
    expect(command.trim().endsWith('ARIADNE_CONTEXT_EOF_1\n)"'.trim())).toBe(true);
  });
});
