import { useState } from 'react';
import type { FormEvent } from 'react';
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

/**
 * Mirrors the shape of `ContextPackage` from `@ariadne-dev/core`'s ContextBuilder,
 * duplicated locally (structurally, not imported) so the webview-ui package
 * doesn't need a build-time dependency on core just for display typing.
 */
interface ContextSnapshot {
  latestSummary: string | null;
  openQuestions: string[];
  openTodos: string[];
  blockedTodos: string[];
  unresolvedErrors: string[];
  recentFiles: Array<{ path: string; role: string }>;
  recentCommits: Array<{ sha: string; message: string | null }>;
  recentCommands: Array<{ cmd: string; exitCode: number | null }>;
  decisions: string[];
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
  const [context, setContext] = useState<ContextSnapshot | null>(null);

  if (!currentTask) {
    return <p>No task selected.</p>;
  }

  function beginEdit(): void {
    setTitleDraft(currentTask!.title);
    setGoalDraft(currentTask!.goal ?? '');
    setIsEditing(true);
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const title = titleDraft.trim();
    if (!title) return;

    await runRequest('Saving task…', async () => {
      await bridge.request('task.update', {
        id: currentTask!.id,
        title,
        goal: goalDraft.trim() || null,
      });
      setIsEditing(false);
    });
  }

  async function setStatus(status: Task['status'], label: string): Promise<void> {
    await runRequest(label, async () => {
      await bridge.request('task.setStatus', { id: currentTask!.id, status });
    });
  }

  async function resumeContext(): Promise<void> {
    await runRequest('Resuming context…', async () => {
      const result = await bridge.request<{ context: ContextSnapshot }>('context.get');
      setContext(result.context);
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
    <div>
      {isEditing ? (
        <form onSubmit={(event) => void saveEdit(event)} aria-label="Edit task">
          <label>
            Task title
            <input
              aria-label="Task title"
              value={titleDraft}
              onChange={(event) => setTitleDraft(event.target.value)}
            />
          </label>
          <label>
            Task goal
            <textarea
              aria-label="Task goal"
              value={goalDraft}
              onChange={(event) => setGoalDraft(event.target.value)}
            />
          </label>
          <button type="submit">Save task</button>
          <button type="button" onClick={() => setIsEditing(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <>
          <h2>{currentTask.title}</h2>
          <p>
            <strong>{currentTask.title}</strong>
          </p>
          <p>Goal: {currentTask.goal ?? 'No goal set.'}</p>
          <p>Branch: {currentTask.branch ?? 'No branch set.'}</p>
          <button type="button" onClick={beginEdit}>
            Edit title/goal
          </button>
        </>
      )}

      <p>
        Counts: {state.counts.pendingTodos} pending todos, {state.counts.unresolvedErrors}{' '}
        {state.counts.unresolvedErrors === 1 ? 'unresolved error' : 'unresolved errors'},{' '}
        {state.counts.openQuestions} open questions
      </p>

      <section aria-label="Task lifecycle">
        <h3>Task lifecycle</h3>
        <p>Current status: {currentTask.status}</p>
        <div>
          {lifecycleActions
            .filter((action) => action.status !== currentTask.status)
            .map((action) => (
              <button key={action.status} type="button" onClick={() => void setStatus(action.status, action.label)}>
                {action.label}
              </button>
            ))}
          <button type="button" onClick={() => void resumeContext()}>
            Resume context
          </button>
        </div>
      </section>

      <section aria-label="Create checkpoint">
        <h3>Create checkpoint</h3>
        <form onSubmit={(event) => void createCheckpoint(event)}>
          <label>
            Checkpoint summary
            <textarea
              aria-label="Checkpoint summary"
              value={checkpointSummary}
              onChange={(event) => setCheckpointSummary(event.target.value)}
            />
          </label>
          <label>
            Checkpoint level
            <select
              aria-label="Checkpoint level"
              value={checkpointLevel}
              onChange={(event) => setCheckpointLevel(event.target.value as typeof checkpointLevel)}
            >
              <option value="micro">micro</option>
              <option value="session">session</option>
              <option value="milestone">milestone</option>
            </select>
          </label>
          <button type="submit">Save checkpoint</button>
        </form>
      </section>

      <section aria-label="Latest checkpoint">
        <h3>Latest checkpoint</h3>
        {latestCheckpoint ? (
          <article>
            <p>{latestCheckpoint.summary}</p>
            <p>
              <time dateTime={latestCheckpoint.createdAt}>{latestCheckpoint.createdAt}</time>
            </p>
          </article>
        ) : (
          <p>No checkpoints recorded yet.</p>
        )}
      </section>

      <section aria-label="Checkpoint timeline">
        <h3>Checkpoint timeline</h3>
        {checkpoints.length === 0 ? (
          <p>No checkpoints recorded yet.</p>
        ) : (
          <ol>
            {checkpoints.map((checkpoint) => (
              <li
                key={checkpoint.id}
                data-entity-id={checkpoint.id}
                style={
                  checkpoint.id === highlightCheckpointId
                    ? { boxShadow: '0 0 0 2px #facc15 inset', background: '#1e293b' }
                    : undefined
                }
              >
                <strong>{checkpoint.summary}</strong>{' '}
                <time dateTime={checkpoint.createdAt}>{checkpoint.createdAt}</time>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-label="Activity">
        <h3>Activity</h3>
        {context ? (
          <div>
            {context.latestSummary ? <p>{context.latestSummary}</p> : null}
            <h4>Recent commands</h4>
            {context.recentCommands.length === 0 ? (
              <p>No recent commands recorded.</p>
            ) : (
              <ul>
                {context.recentCommands.map((command, index) => (
                  <li key={`${command.cmd}-${index}`}>
                    <code>{command.cmd}</code>{' '}
                    <span>{command.exitCode === null ? '(unknown exit)' : `(exit ${command.exitCode})`}</span>
                  </li>
                ))}
              </ul>
            )}
            <h4>Recent commits</h4>
            {context.recentCommits.length === 0 ? (
              <p>No recent commits recorded.</p>
            ) : (
              <ul>
                {context.recentCommits.map((commit) => (
                  <li key={commit.sha}>
                    <code>{commit.sha.slice(0, 7)}</code> {commit.message ?? '(no message)'}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p>Click "Resume context" to load recent activity for this task.</p>
        )}
      </section>
    </div>
  );
}
