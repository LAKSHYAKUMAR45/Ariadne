import { useEffect, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import type { Task, WebviewState } from '@host/messages';
import type { AriadneBridge } from '../bridge';
import { useHighlightScroll, useRequestRunner } from './EntityPanels';

interface OverviewPanelProps {
  state: WebviewState;
  bridge: AriadneBridge;
  onBusy(label: string | undefined): void;
  onError(message: string): void;
  /** Checkpoint id to highlight and scroll to, e.g. from search navigation. */
  highlightCheckpointId?: string;
}

const lifecycleActions: Array<{ status: Task['status']; label: string }> = [
  { status: 'active', label: 'Reopen as active' },
  { status: 'paused', label: 'Pause task' },
  { status: 'done', label: 'Mark done' },
  { status: 'archived', label: 'Archive task' },
];

export default function OverviewPanel({ state, bridge, onBusy, onError, highlightCheckpointId }: OverviewPanelProps) {
  const runRequest = useRequestRunner(onBusy, onError);
  useHighlightScroll(highlightCheckpointId);

  const currentTask = state.currentTask;
  const checkpoints = [...state.checkpoints].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latestCheckpoint = checkpoints[0];

  const [isEditing, setIsEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(currentTask?.title ?? '');
  const [goalDraft, setGoalDraft] = useState(currentTask?.goal ?? '');
  const [checkpointSummary, setCheckpointSummary] = useState('');
  const [checkpointLevel, setCheckpointLevel] = useState<'micro' | 'session' | 'milestone'>('micro');

  useEffect(() => {
    setIsEditing(false);
    setTitleDraft(currentTask?.title ?? '');
    setGoalDraft(currentTask?.goal ?? '');
  }, [currentTask?.id]);

  if (!currentTask) {
    return <p>No task selected.</p>;
  }
  const selectedTask = currentTask;

  function beginEdit(): void {
    setTitleDraft(selectedTask.title);
    setGoalDraft(selectedTask.goal ?? '');
    setIsEditing(true);
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const title = titleDraft.trim();
    if (!title) return;

    await runRequest('Saving task…', async () => {
      await bridge.request('task.update', {
        id: selectedTask.id,
        title,
        goal: goalDraft.trim() || null,
      });
      setIsEditing(false);
    });
  }

  async function setStatus(status: Task['status'], label: string): Promise<void> {
    await runRequest(label, async () => {
      await bridge.request('task.setStatus', { id: selectedTask.id, status });
    });
  }

  async function createCheckpoint(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const summary = checkpointSummary.trim();
    if (!summary) return;

    await runRequest('Saving checkpoint…', async () => {
      await bridge.request('checkpoint.create', { summary, level: checkpointLevel });
      setCheckpointSummary('');
    });
  }

  return (
    <div style={styles.root}>
      {isEditing ? (
        <form onSubmit={(event) => void saveEdit(event)} aria-label="Edit task" style={styles.form}>
          <label style={styles.fieldLabel}>
            Task title
            <input
              aria-label="Task title"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
              style={styles.textInput}
            />
          </label>
          <label style={styles.fieldLabel}>
            Task goal
            <textarea
              aria-label="Task goal"
              value={goalDraft}
              onChange={(event) => setGoalDraft(event.target.value)}
              style={styles.textArea}
            />
          </label>
          <div style={styles.actionsRow}>
            <button type="submit" className="ariadne-btn-primary" style={styles.primaryButton}>
              Save task
            </button>
            <button type="button" onClick={() => setIsEditing(false)} style={styles.secondaryButton}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <section style={styles.card} aria-label="Task summary">
          <h2 style={styles.taskTitle}>{selectedTask.title}</h2>
          <p style={styles.subtleText}>Goal: {selectedTask.goal ?? 'No goal set.'}</p>
          <p style={styles.subtleText}>Branch: {selectedTask.branch ?? 'No branch set.'}</p>
          <button type="button" onClick={beginEdit} style={styles.secondaryButton}>
            Edit title/goal
          </button>
        </section>
      )}

      <p style={styles.subtleText}>
        Counts: {state.counts.pendingTodos} pending todos, {state.counts.unresolvedErrors}{' '}
        {state.counts.unresolvedErrors === 1 ? 'unresolved error' : 'unresolved errors'},{' '}
        {state.counts.openQuestions} open questions
      </p>

      <section aria-label="Task lifecycle" style={styles.card}>
        <h3 style={styles.sectionTitle}>Task lifecycle</h3>
        <p style={styles.subtleText}>Current status: {selectedTask.status}</p>
        <div style={styles.actionsRow}>
          {lifecycleActions
            .filter((action) => action.status !== selectedTask.status)
            .map((action) => (
              <button
                key={action.status}
                type="button"
                onClick={() => void setStatus(action.status, action.label)}
                style={styles.secondaryButton}
              >
                {action.label}
              </button>
            ))}
        </div>
      </section>

      <section aria-label="Create checkpoint" style={styles.card}>
        <h3 style={styles.sectionTitle}>Create checkpoint</h3>
        <form onSubmit={(event) => void createCheckpoint(event)} style={styles.form}>
          <label style={styles.fieldLabel}>
            Checkpoint summary
            <textarea
              aria-label="Checkpoint summary"
              value={checkpointSummary}
              onChange={(event) => setCheckpointSummary(event.target.value)}
              style={styles.textArea}
            />
          </label>
          <label style={styles.fieldLabel}>
            Checkpoint level
            <select
              aria-label="Checkpoint level"
              value={checkpointLevel}
              onChange={(event) => setCheckpointLevel(event.target.value as typeof checkpointLevel)}
              style={styles.selectInput}
            >
              <option value="micro">micro</option>
              <option value="session">session</option>
              <option value="milestone">milestone</option>
            </select>
          </label>
          <button type="submit" className="ariadne-btn-primary" style={{ ...styles.primaryButton, ...styles.selfStart }}>
            Save checkpoint
          </button>
        </form>
      </section>

      <section aria-label="Latest checkpoint" style={styles.card}>
        <h3 style={styles.sectionTitle}>Latest checkpoint</h3>
        {latestCheckpoint ? (
          <article>
            <p>{latestCheckpoint.summary}</p>
            <p style={styles.subtleText}>
              <time dateTime={latestCheckpoint.createdAt}>{latestCheckpoint.createdAt}</time>
            </p>
          </article>
        ) : (
          <p style={styles.subtleText}>No checkpoints recorded yet.</p>
        )}
      </section>

      <section aria-label="Checkpoint timeline" style={styles.card}>
        <h3 style={styles.sectionTitle}>Checkpoint timeline</h3>
        {checkpoints.length === 0 ? (
          <p style={styles.subtleText}>No checkpoints recorded yet.</p>
        ) : (
          <ol style={styles.timeline}>
            {checkpoints.map((checkpoint) => (
              <li
                key={checkpoint.id}
                data-entity-id={checkpoint.id}
                style={{
                  ...styles.timelineItem,
                  ...(checkpoint.id === highlightCheckpointId
                    ? { boxShadow: '0 0 0 2px var(--vscode-focusBorder) inset', background: 'var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background))' }
                    : undefined),
                }}
              >
                <strong>{checkpoint.summary}</strong>{' '}
                <span style={styles.subtleText}>
                  <time dateTime={checkpoint.createdAt}>{checkpoint.createdAt}</time>
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-label="Workflow handoff" style={styles.card}>
        <h3 style={styles.sectionTitle}>Workflow handoff</h3>
        <p style={styles.subtleText}>Use the Activity tab for timeline history and capture health.</p>
        <p style={styles.subtleText}>Use the Context tab to preview, copy, or open the current task handoff package.</p>
      </section>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  root: {
    display: 'grid',
    gap: '1rem',
  },
  card: {
    display: 'grid',
    gap: '0.5rem',
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    borderRadius: '6px',
    background: 'var(--vscode-sideBar-background, var(--vscode-editor-background))',
    padding: '0.75rem',
  },
  taskTitle: {
    margin: 0,
  },
  sectionTitle: {
    margin: 0,
  },
  subtleText: {
    margin: 0,
    color: 'var(--vscode-descriptionForeground)',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  fieldLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    color: 'var(--vscode-descriptionForeground)',
    fontSize: '0.875rem',
  },
  textInput: {
    width: '100%',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    padding: '0.5rem 0.75rem',
    boxSizing: 'border-box',
  },
  textArea: {
    width: '100%',
    minHeight: '4.5rem',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    padding: '0.5rem 0.75rem',
    boxSizing: 'border-box',
    resize: 'vertical',
    fontFamily: 'inherit',
  },
  selectInput: {
    width: '100%',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    padding: '0.5rem 0.75rem',
    boxSizing: 'border-box',
  },
  actionsRow: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
  },
  selfStart: {
    alignSelf: 'flex-start',
  },
  primaryButton: {
    border: '1px solid var(--vscode-button-background)',
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    borderRadius: '4px',
    padding: '0.5rem 0.875rem',
  },
  secondaryButton: {
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    background: 'var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background))',
    color: 'var(--vscode-foreground)',
    borderRadius: '4px',
    padding: '0.5rem 0.875rem',
    alignSelf: 'flex-start',
  },
  timeline: {
    display: 'grid',
    gap: '0.5rem',
    margin: 0,
    paddingLeft: '1.25rem',
  },
  timelineItem: {
    margin: 0,
  },
};
