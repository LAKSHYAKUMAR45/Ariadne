import type { WebviewState } from '@host/messages';

interface OverviewPanelProps {
  state: WebviewState;
}

export default function OverviewPanel({ state }: OverviewPanelProps) {
  const currentTask = state.currentTask;
  const checkpoints = [...state.checkpoints].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latestCheckpoint = checkpoints[0];

  if (!currentTask) {
    return <p>No task selected.</p>;
  }

  return (
    <div>
      <h2>{currentTask.title}</h2>
      <p>
        <strong>{currentTask.title}</strong>
      </p>
      <p>Goal: {currentTask.goal ?? 'No goal set.'}</p>
      <p>Branch: {currentTask.branch ?? 'No branch set.'}</p>
      <p>
        Counts: {state.counts.pendingTodos} pending todos, {state.counts.unresolvedErrors}{' '}
        {state.counts.unresolvedErrors === 1 ? 'unresolved error' : 'unresolved errors'},{' '}
        {state.counts.openQuestions} open questions
      </p>

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
              <li key={checkpoint.id}>
                <strong>{checkpoint.summary}</strong>{' '}
                <time dateTime={checkpoint.createdAt}>{checkpoint.createdAt}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
