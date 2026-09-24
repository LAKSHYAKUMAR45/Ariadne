import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ContextPreview } from '@host/messages';
import type { AriadneBridge } from '../bridge';

interface ContextPanelProps {
  bridge: AriadneBridge;
  taskId?: string;
  onBusy(label: string | undefined): void;
  onError(message: string): void;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderSectionSummary(section: ContextPreview['sections'][number]): string {
  if (section.truncatedCount && section.truncatedCount > 0) {
    return `${section.label}: ${section.count} included, ${section.truncatedCount} truncated`;
  }
  return `${section.label}: ${section.count} included`;
}

export default function ContextPanel({ bridge, taskId, onBusy, onError }: ContextPanelProps) {
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const generationRef = useRef(0);
  const activeRequestGenerationRef = useRef<number | null>(null);

  function invalidatePreview(): void {
    const nextGeneration = generationRef.current + 1;
    generationRef.current = nextGeneration;
    setPreview(null);
    if (
      activeRequestGenerationRef.current !== null &&
      activeRequestGenerationRef.current < nextGeneration
    ) {
      activeRequestGenerationRef.current = null;
      onBusy(undefined);
    }
  }

  useEffect(() => {
    invalidatePreview();
  }, [taskId]);

  async function previewContext(): Promise<void> {
    const generation = ++generationRef.current;
    activeRequestGenerationRef.current = generation;
    onError('');
    onBusy('Previewing context…');

    try {
      // No tokenBudget in the payload — the host applies its own sensible
      // default (DEFAULT_TOKEN_BUDGET), so this panel doesn't need to expose
      // a budget control the user has no real reason to tune.
      const result = await bridge.request<{ preview: ContextPreview }>('context.preview', {});
      if (generation !== generationRef.current) return;
      setPreview(result.preview);
    } catch (error: unknown) {
      if (generation !== generationRef.current) return;
      onError(formatError(error));
    } finally {
      if (activeRequestGenerationRef.current !== generation) return;
      activeRequestGenerationRef.current = null;
      onBusy(undefined);
    }
  }

  async function copyContext(): Promise<void> {
    if (!preview) return;
    onError('');
    onBusy('Copying context…');
    try {
      await bridge.request('context.copy', { markdown: preview.markdown });
    } catch (error: unknown) {
      onError(formatError(error));
    } finally {
      onBusy(undefined);
    }
  }

  async function openContext(): Promise<void> {
    if (!preview) return;
    onError('');
    onBusy('Opening context…');
    try {
      await bridge.request('context.open', { markdown: preview.markdown });
    } catch (error: unknown) {
      onError(formatError(error));
    } finally {
      onBusy(undefined);
    }
  }

  async function openInChat(): Promise<void> {
    if (!preview) return;
    onError('');
    onBusy('Opening in Copilot Chat…');
    try {
      await bridge.request('context.openInChat', { markdown: preview.markdown });
    } catch (error: unknown) {
      onError(formatError(error));
    } finally {
      onBusy(undefined);
    }
  }

  async function openInCli(): Promise<void> {
    if (!preview) return;
    onError('');
    onBusy('Opening in Copilot CLI…');
    try {
      await bridge.request('context.openInCli', { markdown: preview.markdown });
    } catch (error: unknown) {
      onError(formatError(error));
    } finally {
      onBusy(undefined);
    }
  }

  return (
    <div style={styles.root}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void previewContext();
        }}
        style={styles.controls}
      >
        <div style={styles.actions}>
          <button type="submit" style={styles.button}>
            Preview context
          </button>
          <button type="button" onClick={() => void copyContext()} disabled={!preview} style={styles.button}>
            Copy context
          </button>
          <button type="button" onClick={() => void openContext()} disabled={!preview} style={styles.button}>
            Open as Markdown
          </button>
          <button type="button" onClick={() => void openInChat()} disabled={!preview} style={styles.button}>
            Open in Copilot Chat
          </button>
          <button type="button" onClick={() => void openInCli()} disabled={!preview} style={styles.button}>
            Open in Copilot CLI
          </button>
        </div>
      </form>

      {preview ? (
        <>
          <section aria-label="Context sections" style={styles.section}>
            <h3 style={styles.sectionTitle}>Included sections</h3>
            <ul style={styles.list}>
              {preview.sections.map((section) => (
                <li key={section.id}>{renderSectionSummary(section)}</li>
              ))}
            </ul>
          </section>

          <section aria-label="Context metadata" style={styles.section}>
            <h3 style={styles.sectionTitle}>Preview metadata</h3>
            <dl style={styles.details}>
              <div>
                <dt>Task ID</dt>
                <dd>{preview.context.taskId}</dd>
              </div>
              <div>
                <dt>Workspace root</dt>
                <dd>{preview.context.workspaceRoot ?? 'No workspace selected'}</dd>
              </div>
              <div>
                <dt>Task branch</dt>
                <dd>{preview.context.branch ?? 'No task branch set'}</dd>
              </div>
              <div>
                <dt>Goal</dt>
                <dd>{preview.context.goal ?? 'No goal set'}</dd>
              </div>
              <div>
                <dt>Token budget</dt>
                <dd>{preview.tokenBudget}</dd>
              </div>
            </dl>
          </section>

          <section aria-label="Context preview" style={styles.section}>
            <h3 style={styles.sectionTitle}>Context preview</h3>
            <pre style={styles.preview}>
              {preview.markdown.split('\n').map((line, index, lines) => (
                <span key={`${index}-${line}`}>
                  {line}
                  {index < lines.length - 1 ? '\n' : ''}
                </span>
              ))}
            </pre>
          </section>
        </>
      ) : (
        <p style={styles.muted}>Preview the current task handoff package to inspect or share it.</p>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  root: {
    display: 'grid',
    gap: '1rem',
  },
  controls: {
    display: 'grid',
    gap: '0.75rem',
  },
  field: {
    display: 'grid',
    gap: '0.35rem',
  },
  input: {
    width: '100%',
    maxWidth: '220px',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    padding: '0.5rem 0.75rem',
    boxSizing: 'border-box',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
  button: {
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    background: 'var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background))',
    color: 'var(--vscode-foreground)',
    borderRadius: '4px',
    padding: '0.5rem 0.875rem',
    cursor: 'pointer',
  },
  section: {
    display: 'grid',
    gap: '0.5rem',
  },
  sectionTitle: {
    margin: 0,
  },
  list: {
    margin: 0,
    paddingLeft: '1.25rem',
  },
  details: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: '0.75rem',
    margin: 0,
  },
  preview: {
    margin: 0,
    padding: '0.75rem',
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    borderRadius: '6px',
    background: 'var(--vscode-sideBar-background, var(--vscode-editor-background))',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  muted: {
    margin: 0,
    color: 'var(--vscode-descriptionForeground)',
  },
};
