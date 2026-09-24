import { useEffect, useMemo, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, FormEvent, ReactNode } from 'react';
import type { AriadneBridge } from '../bridge';
import type { Decision, OpenQuestion, TaskError, Todo, TodoStatus, WebviewState } from '@host/messages';

interface EntityPanelProps {
  state: WebviewState;
  bridge: AriadneBridge;
  onBusy(label: string | undefined): void;
  onError(message: string): void;
  /** Id of an entity to visually highlight and scroll into view, e.g. from search navigation. */
  highlightId?: string;
}

/**
 * Scrolls the element tagged with `data-entity-id={highlightId}` into view whenever
 * `highlightId` changes. Shared by the entity panels and the overview checkpoint timeline
 * so search-result navigation lands on the right row.
 */
export function useHighlightScroll(highlightId: string | undefined, containerRef?: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!highlightId) return;
    const root = containerRef?.current ?? document;
    const target = root.querySelector<HTMLElement>(`[data-entity-id="${highlightId}"]`);
    target?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, [highlightId, containerRef]);
}

function highlightStyle(isHighlighted: boolean): CSSProperties {
  return isHighlighted ? { boxShadow: '0 0 0 2px #facc15 inset', background: '#1e293b' } : {};
}

type TodoDraft = {
  text: string;
  status: TodoStatus;
  dirtyText: boolean;
  dirtyStatus: boolean;
};

type DecisionDraft = {
  text: string;
  rationale: string;
  dirtyText: boolean;
  dirtyRationale: boolean;
};

type TextDraft = {
  text: string;
  dirty: boolean;
};

function readTaskErrorMessage(taskError: TaskError): string {
  return taskError.message;
}

function readQuestionText(question: OpenQuestion): string {
  return question.text;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useRequestRunner(onBusy: (label: string | undefined) => void, onError: (message: string) => void) {
  return async function runRequest(label: string, action: () => Promise<void>): Promise<void> {
    onError('');
    onBusy(label);
    try {
      await action();
    } catch (error: unknown) {
      onError(formatErrorMessage(error));
    } finally {
      onBusy(undefined);
    }
  };
}

function ensureTodoDrafts(todos: Todo[]): Record<string, TodoDraft> {
  return todos.reduce<Record<string, TodoDraft>>((acc, todo) => {
    acc[todo.id] = {
      text: todo.text,
      status: todo.status,
      dirtyText: false,
      dirtyStatus: false,
    };
    return acc;
  }, {});
}

function toTodoDraft(todo: Todo): TodoDraft {
  return {
    text: todo.text,
    status: todo.status,
    dirtyText: false,
    dirtyStatus: false,
  };
}

function reconcileTodoDraft(current: TodoDraft | undefined, todo: Todo): TodoDraft {
  if (!current) {
    return toTodoDraft(todo);
  }

  return {
    text: current.dirtyText ? current.text : todo.text,
    status: current.dirtyStatus ? current.status : todo.status,
    dirtyText: current.dirtyText && current.text !== todo.text,
    dirtyStatus: current.dirtyStatus && current.status !== todo.status,
  };
}

function useTodoDrafts(todos: Todo[]) {
  const [drafts, setDrafts] = useState<Record<string, TodoDraft>>(() => ensureTodoDrafts(todos));

  useEffect(() => {
    setDrafts((current) => {
      return todos.reduce<Record<string, TodoDraft>>((next, todo) => {
        next[todo.id] = reconcileTodoDraft(current[todo.id], todo);
        return next;
      }, {});
    });
  }, [todos]);

  return [drafts, setDrafts] as const;
}

function useDecisionDrafts(decisions: Decision[]) {
  const [drafts, setDrafts] = useState<Record<string, DecisionDraft>>(() =>
    decisions.reduce<Record<string, DecisionDraft>>((acc, decision) => {
      acc[decision.id] = {
        text: decision.text,
        rationale: decision.rationale ?? '',
        dirtyText: false,
        dirtyRationale: false,
      };
      return acc;
    }, {}),
  );

  useEffect(() => {
    setDrafts((current) => {
      return decisions.reduce<Record<string, DecisionDraft>>((next, decision) => {
        const existing = current[decision.id];
        next[decision.id] = existing
          ? {
              text: existing.dirtyText ? existing.text : decision.text,
              rationale: existing.dirtyRationale ? existing.rationale : decision.rationale ?? '',
              dirtyText: existing.dirtyText && existing.text !== decision.text,
              dirtyRationale: existing.dirtyRationale && existing.rationale !== (decision.rationale ?? ''),
            }
          : {
              text: decision.text,
              rationale: decision.rationale ?? '',
              dirtyText: false,
              dirtyRationale: false,
            };
        return next;
      }, {});
    });
  }, [decisions]);

  return [drafts, setDrafts] as const;
}

function useTextDrafts<T extends { id: string }>(items: T[], readText: (item: T) => string) {
  const [drafts, setDrafts] = useState<Record<string, TextDraft>>(() =>
    items.reduce<Record<string, TextDraft>>((acc, item) => {
      acc[item.id] = { text: readText(item), dirty: false };
      return acc;
    }, {}),
  );

  useEffect(() => {
    setDrafts((current) => {
      return items.reduce<Record<string, TextDraft>>((next, item) => {
        const existing = current[item.id];
        const text = readText(item);
        next[item.id] = existing
          ? {
              text: existing.dirty ? existing.text : text,
              dirty: existing.dirty && existing.text !== text,
            }
          : { text, dirty: false };
        return next;
      }, {});
    });
  }, [items, readText]);

  return [drafts, setDrafts] as const;
}

function PanelShell({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${title}-title`} style={styles.panel}>
      <h3 id={`${title}-title`} style={styles.title}>
        {title}
      </h3>
      <p style={styles.description}>{description}</p>
      {children}
    </section>
  );
}

function ToolbarButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} type={props.type ?? 'button'} style={{ ...styles.button, ...(props.style ?? {}) }} />;
}

export function TodosPanel({ state, bridge, onBusy, onError, highlightId }: EntityPanelProps) {
  const runRequest = useRequestRunner(onBusy, onError);
  useHighlightScroll(highlightId);
  const [drafts, setDrafts] = useTodoDrafts(state.todos);
  const [newText, setNewText] = useState('');
  const currentTaskId = state.currentTaskId;

  const todos = useMemo(() => state.todos, [state.todos]);

  if (!currentTaskId) {
    return <PanelShell title="Todos" description="Editable todos for the current task."><p>No task selected.</p></PanelShell>;
  }

  async function addTodo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = newText.trim();
    if (!text) return;

    await runRequest('Creating todo…', async () => {
      await bridge.request('todo.create', { text });
      setNewText('');
    });
  }

  async function updateTodo(todoId: string) {
    const draft = drafts[todoId];
    if (!draft) return;
    const text = draft.text.trim();
    if (!text) return;

    await runRequest('Updating todo…', async () => {
      await bridge.request('todo.updateText', { id: todoId, text });
      await bridge.request('todo.setStatus', { id: todoId, status: draft.status });
      setDrafts((current) => ({
        ...current,
        [todoId]: {
          text,
          status: draft.status,
          dirtyText: false,
          dirtyStatus: false,
        },
      }));
    });
  }

  async function deleteTodo(todoId: string) {
    await runRequest('Deleting todo…', async () => {
      await bridge.request('todo.delete', { id: todoId });
    });
  }

  return (
    <PanelShell title="Todos" description="Editable todos for the current task.">
      <form onSubmit={(event) => void addTodo(event)} style={styles.form}>
        <label style={styles.field}>
          <span style={styles.label}>New todo text</span>
          <input
            aria-label="New todo text"
            value={newText}
            onChange={(event) => setNewText(event.target.value)}
            style={styles.input}
          />
        </label>
        <ToolbarButton type="submit">Add todo</ToolbarButton>
      </form>

      <div style={styles.list}>
        {todos.map((todo) => {
          const draft = drafts[todo.id] ?? {
            text: todo.text,
            status: todo.status,
            dirtyText: false,
            dirtyStatus: false,
          };
          return (
            <article key={todo.id} data-entity-id={todo.id} style={{ ...styles.card, ...highlightStyle(todo.id === highlightId) }}>
              <div style={styles.row}>
                <label style={styles.field}>
                  <span style={styles.label}>Todo text for {todo.id}</span>
                  <input
                    aria-label={`Todo text for ${todo.id}`}
                    value={draft.text ?? ''}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [todo.id]: {
                          ...(current[todo.id] ?? {
                            text: todo.text,
                            status: todo.status,
                            dirtyText: false,
                            dirtyStatus: false,
                          }),
                          text: event.target.value,
                          dirtyText: true,
                        },
                      }))
                    }
                    style={styles.input}
                  />
                </label>
                <label style={styles.field}>
                  <span style={styles.label}>Todo status for {todo.id}</span>
                  <select
                    aria-label={`Todo status for ${todo.id}`}
                    value={draft.status ?? 'pending'}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [todo.id]: {
                          ...(current[todo.id] ?? {
                            text: todo.text,
                            status: todo.status,
                            dirtyText: false,
                            dirtyStatus: false,
                          }),
                          status: event.target.value as TodoStatus,
                          dirtyStatus: true,
                        },
                      }))
                    }
                    style={styles.input}
                  >
                    <option value="pending">pending</option>
                    <option value="done">done</option>
                    <option value="blocked">blocked</option>
                  </select>
                </label>
              </div>
              <div style={styles.actions}>
                <ToolbarButton type="button" onClick={() => void updateTodo(todo.id)}>
                  Save {todo.id}
                </ToolbarButton>
                <ToolbarButton type="button" onClick={() => void deleteTodo(todo.id)}>
                  Delete {todo.id}
                </ToolbarButton>
              </div>
            </article>
          );
        })}
      </div>
    </PanelShell>
  );
}

export function DecisionsPanel({ state, bridge, onBusy, onError, highlightId }: EntityPanelProps) {
  const runRequest = useRequestRunner(onBusy, onError);
  useHighlightScroll(highlightId);
  const [drafts, setDrafts] = useDecisionDrafts(state.decisions);
  const [newText, setNewText] = useState('');
  const [newRationale, setNewRationale] = useState('');
  const currentTaskId = state.currentTaskId;

  if (!currentTaskId) {
    return <PanelShell title="Decisions" description="Editable decisions for the current task."><p>No task selected.</p></PanelShell>;
  }

  async function addDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = newText.trim();
    const rationale = newRationale.trim();
    if (!text) return;

    await runRequest('Creating decision…', async () => {
      await bridge.request('decision.create', {
        text,
        rationale,
      });
      setNewText('');
      setNewRationale('');
    });
  }

  async function updateDecision(decisionId: string) {
    const draft = drafts[decisionId];
    if (!draft) return;
    const text = draft.text.trim();
    if (!text) return;

    await runRequest('Updating decision…', async () => {
      await bridge.request('decision.update', {
        id: decisionId,
        text,
        rationale: draft.rationale.trim() || null,
      });
      setDrafts((current) => ({
        ...current,
        [decisionId]: {
          text,
          rationale: draft.rationale.trim(),
          dirtyText: false,
          dirtyRationale: false,
        },
      }));
    });
  }

  async function deleteDecision(decisionId: string) {
    await runRequest('Deleting decision…', async () => {
      await bridge.request('decision.delete', { id: decisionId });
    });
  }

  return (
    <PanelShell title="Decisions" description="Editable decisions for the current task.">
      <form onSubmit={(event) => void addDecision(event)} style={styles.form}>
        <label style={styles.field}>
          <span style={styles.label}>New decision text</span>
          <input
            aria-label="New decision text"
            value={newText}
            onChange={(event) => setNewText(event.target.value)}
            style={styles.input}
          />
        </label>
        <label style={styles.field}>
          <span style={styles.label}>New decision rationale</span>
          <textarea
            aria-label="New decision rationale"
            value={newRationale}
            onChange={(event) => setNewRationale(event.target.value)}
            style={styles.textarea}
          />
        </label>
        <ToolbarButton type="submit">Add decision</ToolbarButton>
      </form>

      <div style={styles.list}>
        {state.decisions.map((decision) => {
          const draft = drafts[decision.id] ?? {
            text: decision.text,
            rationale: decision.rationale ?? '',
            dirtyText: false,
            dirtyRationale: false,
          };
          return (
            <article key={decision.id} data-entity-id={decision.id} style={{ ...styles.card, ...highlightStyle(decision.id === highlightId) }}>
              <div style={styles.row}>
                <label style={styles.field}>
                  <span style={styles.label}>Decision text for {decision.id}</span>
                  <input
                    aria-label={`Decision text for ${decision.id}`}
                    value={draft.text ?? ''}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [decision.id]: {
                          ...(current[decision.id] ?? {
                            text: decision.text,
                            rationale: decision.rationale ?? '',
                            dirtyText: false,
                            dirtyRationale: false,
                          }),
                          text: event.target.value,
                          dirtyText: true,
                        },
                      }))
                    }
                    style={styles.input}
                  />
                </label>
                <label style={styles.field}>
                  <span style={styles.label}>Decision rationale for {decision.id}</span>
                  <textarea
                    aria-label={`Decision rationale for ${decision.id}`}
                    value={draft.rationale ?? ''}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [decision.id]: {
                          ...(current[decision.id] ?? {
                            text: decision.text,
                            rationale: decision.rationale ?? '',
                            dirtyText: false,
                            dirtyRationale: false,
                          }),
                          rationale: event.target.value,
                          dirtyRationale: true,
                        },
                      }))
                    }
                    style={styles.textarea}
                  />
                </label>
              </div>
              <div style={styles.actions}>
                <ToolbarButton type="button" onClick={() => void updateDecision(decision.id)}>
                  Save {decision.id}
                </ToolbarButton>
                <ToolbarButton type="button" onClick={() => void deleteDecision(decision.id)}>
                  Delete {decision.id}
                </ToolbarButton>
              </div>
            </article>
          );
        })}
      </div>
    </PanelShell>
  );
}

export function ErrorsPanel({ state, bridge, onBusy, onError, highlightId }: EntityPanelProps) {
  const runRequest = useRequestRunner(onBusy, onError);
  useHighlightScroll(highlightId);
  const [drafts, setDrafts] = useTextDrafts(state.errors, readTaskErrorMessage);
  const [newMessage, setNewMessage] = useState('');

  async function addError(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = newMessage.trim();
    if (!message) return;

    await runRequest('Creating error…', async () => {
      await bridge.request('error.create', { message });
      setNewMessage('');
    });
  }

  async function updateError(errorId: string) {
    const draft = drafts[errorId];
    if (!draft) return;
    const message = draft.text.trim();
    if (!message) return;

    await runRequest('Updating error…', async () => {
      await bridge.request('error.update', { id: errorId, message });
      setDrafts((current) => ({
        ...current,
        [errorId]: {
          text: message,
          dirty: false,
        },
      }));
    });
  }

  async function resolveError(errorId: string) {
    await runRequest('Resolving error…', async () => {
      await bridge.request('error.resolve', { id: errorId });
    });
  }

  async function reopenError(errorId: string) {
    await runRequest('Reopening error…', async () => {
      await bridge.request('error.reopen', { id: errorId });
    });
  }

  async function deleteError(errorId: string) {
    await runRequest('Deleting error…', async () => {
      await bridge.request('error.delete', { id: errorId });
    });
  }

  return (
    <PanelShell title="Errors" description="Editable errors for the current task.">
      <form onSubmit={(event) => void addError(event)} style={styles.form}>
        <label style={styles.field}>
          <span style={styles.label}>New error message</span>
          <input
            aria-label="New error message"
            value={newMessage}
            onChange={(event) => setNewMessage(event.target.value)}
            style={styles.input}
          />
        </label>
        <ToolbarButton type="submit">Add error</ToolbarButton>
      </form>

      <div style={styles.list}>
        {state.errors.map((taskError) => {
          const draft = drafts[taskError.id] ?? { text: taskError.message, dirty: false };
          return (
            <article key={taskError.id} data-entity-id={taskError.id} style={{ ...styles.card, ...highlightStyle(taskError.id === highlightId) }}>
              <div style={styles.row}>
                <label style={styles.field}>
                  <span style={styles.label}>Error message for {taskError.id}</span>
                  <input
                    aria-label={`Error message for ${taskError.id}`}
                    value={draft.text ?? ''}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [taskError.id]: {
                          ...(current[taskError.id] ?? { text: taskError.message, dirty: false }),
                          text: event.target.value,
                          dirty: true,
                        },
                      }))
                    }
                    style={styles.input}
                  />
                </label>
                <span style={styles.status}>{taskError.resolved ? 'Resolved' : 'Open'}</span>
              </div>
              <div style={styles.actions}>
                <ToolbarButton type="button" onClick={() => void updateError(taskError.id)}>
                  Save {taskError.id}
                </ToolbarButton>
                <ToolbarButton type="button" onClick={() => void resolveError(taskError.id)}>
                  Resolve {taskError.id}
                </ToolbarButton>
                <ToolbarButton type="button" onClick={() => void reopenError(taskError.id)}>
                  Reopen {taskError.id}
                </ToolbarButton>
                <ToolbarButton type="button" onClick={() => void deleteError(taskError.id)}>
                  Delete {taskError.id}
                </ToolbarButton>
              </div>
            </article>
          );
        })}
      </div>
    </PanelShell>
  );
}

export function QuestionsPanel({ state, bridge, onBusy, onError, highlightId }: EntityPanelProps) {
  const runRequest = useRequestRunner(onBusy, onError);
  useHighlightScroll(highlightId);
  const [drafts, setDrafts] = useTextDrafts(state.questions, readQuestionText);
  const [newText, setNewText] = useState('');

  async function addQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = newText.trim();
    if (!text) return;

    await runRequest('Creating question…', async () => {
      await bridge.request('question.create', { text });
      setNewText('');
    });
  }

  async function updateQuestion(questionId: string) {
    const draft = drafts[questionId];
    if (!draft) return;
    const text = draft.text.trim();
    if (!text) return;

    await runRequest('Updating question…', async () => {
      await bridge.request('question.update', { id: questionId, text });
      setDrafts((current) => ({
        ...current,
        [questionId]: {
          text,
          dirty: false,
        },
      }));
    });
  }

  async function resolveQuestion(questionId: string) {
    await runRequest('Resolving question…', async () => {
      await bridge.request('question.resolve', { id: questionId });
    });
  }

  async function reopenQuestion(questionId: string) {
    await runRequest('Reopening question…', async () => {
      await bridge.request('question.reopen', { id: questionId });
    });
  }

  async function deleteQuestion(questionId: string) {
    await runRequest('Deleting question…', async () => {
      await bridge.request('question.delete', { id: questionId });
    });
  }

  return (
    <PanelShell title="Questions" description="Editable questions for the current task.">
      <form onSubmit={(event) => void addQuestion(event)} style={styles.form}>
        <label style={styles.field}>
          <span style={styles.label}>New question text</span>
          <input
            aria-label="New question text"
            value={newText}
            onChange={(event) => setNewText(event.target.value)}
            style={styles.input}
          />
        </label>
        <ToolbarButton type="submit">Add question</ToolbarButton>
      </form>

      <div style={styles.list}>
        {state.questions.map((question) => {
          const draft = drafts[question.id] ?? { text: question.text, dirty: false };
          return (
            <article key={question.id} data-entity-id={question.id} style={{ ...styles.card, ...highlightStyle(question.id === highlightId) }}>
              <div style={styles.row}>
                <label style={styles.field}>
                  <span style={styles.label}>Question text for {question.id}</span>
                  <input
                    aria-label={`Question text for ${question.id}`}
                    value={draft.text ?? ''}
                    onChange={(event) =>
                      setDrafts((current) => ({
                        ...current,
                        [question.id]: {
                          ...(current[question.id] ?? { text: question.text, dirty: false }),
                          text: event.target.value,
                          dirty: true,
                        },
                      }))
                    }
                    style={styles.input}
                  />
                </label>
                <span style={styles.status}>{question.resolved ? 'Resolved' : 'Open'}</span>
              </div>
              <div style={styles.actions}>
                <ToolbarButton type="button" onClick={() => void updateQuestion(question.id)}>
                  Save {question.id}
                </ToolbarButton>
                <ToolbarButton type="button" onClick={() => void resolveQuestion(question.id)}>
                  Resolve {question.id}
                </ToolbarButton>
                <ToolbarButton type="button" onClick={() => void reopenQuestion(question.id)}>
                  Reopen {question.id}
                </ToolbarButton>
                <ToolbarButton type="button" onClick={() => void deleteQuestion(question.id)}>
                  Delete {question.id}
                </ToolbarButton>
              </div>
            </article>
          );
        })}
      </div>
    </PanelShell>
  );
}

const styles: Record<string, CSSProperties> = {
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  title: {
    margin: 0,
    fontSize: '1.1rem',
  },
  description: {
    margin: 0,
    color: '#94a3b8',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    padding: '0.75rem',
    border: '1px solid #334155',
    borderRadius: '0.75rem',
    background: '#0f172a',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    padding: '0.75rem',
    border: '1px solid #334155',
    borderRadius: '0.75rem',
    background: '#0f172a',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr) auto',
    gap: '0.75rem',
    alignItems: 'start',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.35rem',
  },
  label: {
    fontSize: '0.875rem',
    color: '#cbd5e1',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    border: '1px solid #334155',
    borderRadius: '0.5rem',
    background: '#111827',
    color: '#e2e8f0',
    padding: '0.5rem 0.75rem',
  },
  textarea: {
    width: '100%',
    minHeight: '4.25rem',
    boxSizing: 'border-box',
    border: '1px solid #334155',
    borderRadius: '0.5rem',
    background: '#111827',
    color: '#e2e8f0',
    padding: '0.5rem 0.75rem',
    resize: 'vertical',
  },
  button: {
    border: '1px solid #334155',
    background: '#1e293b',
    color: '#e2e8f0',
    borderRadius: '0.5rem',
    padding: '0.5rem 0.875rem',
    cursor: 'pointer',
  },
  status: {
    alignSelf: 'center',
    color: '#94a3b8',
    fontSize: '0.875rem',
  },
};
