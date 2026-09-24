import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ReviewCheck, ReviewSummary, WebviewTabId } from '@host/messages';
import type { AriadneBridge } from '../bridge';
import { useStableCallback } from '../useStableCallback';

interface ReviewPanelProps {
  bridge: AriadneBridge;
  taskId?: string;
  onNavigate?: (target: { tabId: WebviewTabId; entityId?: string }) => void;
  onBusy(label: string | undefined): void;
  onError(message: string): void;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusLabel(status: ReviewCheck['status']): string {
  switch (status) {
    case 'pass':
      return 'Pass';
    case 'warning':
      return 'Warning';
    case 'fail':
      return 'Fail';
    case 'unknown':
      return 'Unknown';
  }
}

function statusStyle(status: ReviewCheck['status']): CSSProperties {
  switch (status) {
    case 'pass':
      return styles.passBadge;
    case 'warning':
      return styles.warningBadge;
    case 'fail':
      return styles.failBadge;
    case 'unknown':
      return styles.unknownBadge;
  }
}

export default function ReviewPanel({ bridge, taskId, onNavigate, onBusy, onError }: ReviewPanelProps) {
  const [review, setReview] = useState<ReviewSummary | null>(null);
  const generationRef = useRef(0);
  const activeRequestGenerationRef = useRef<number | null>(null);
  const reportBusy = useStableCallback(onBusy);
  const reportError = useStableCallback(onError);

  function invalidateReview(): void {
    const nextGeneration = generationRef.current + 1;
    generationRef.current = nextGeneration;
    setReview(null);
    if (activeRequestGenerationRef.current !== null && activeRequestGenerationRef.current < nextGeneration) {
      activeRequestGenerationRef.current = null;
      reportBusy(undefined);
    }
  }

  useEffect(() => {
    invalidateReview();

    if (!taskId) {
      reportError('');
      return;
    }

    const generation = ++generationRef.current;
    activeRequestGenerationRef.current = generation;
    reportError('');
    reportBusy('Loading review…');

    void bridge
      .request<{ review: ReviewSummary }>('review.get')
      .then((result) => {
        if (generation !== generationRef.current) return;
        setReview(result.review);
      })
      .catch((error: unknown) => {
        if (generation !== generationRef.current) return;
        reportError(formatError(error));
      })
      .finally(() => {
        if (activeRequestGenerationRef.current !== generation) return;
        activeRequestGenerationRef.current = null;
        reportBusy(undefined);
      });
  }, [bridge, reportBusy, reportError, taskId]);

  async function markTaskDone(): Promise<void> {
    if (!review) return;
    reportError('');
    reportBusy('Marking task done…');
    try {
      await bridge.request('task.setStatus', { id: review.taskId, status: 'done' });
    } catch (error: unknown) {
      reportError(formatError(error));
    } finally {
      reportBusy(undefined);
    }
  }

  if (!taskId) {
    return <p style={styles.muted}>Select a task to review its completion readiness.</p>;
  }

  if (!review) {
    return <p style={styles.muted}>Loading review checks…</p>;
  }

  return (
    <div style={styles.root}>
      <section aria-label="Review checks" style={styles.section}>
        <h3 style={styles.sectionTitle}>Completion review</h3>
        <ul style={styles.list}>
          {review.checks.map((check) => (
            <li key={check.id} style={styles.card}>
              <div style={styles.cardHeader}>
                <strong>{check.label}</strong>
                <span style={{ ...styles.badge, ...statusStyle(check.status) }}>{statusLabel(check.status)}</span>
              </div>
              <p style={styles.detail}>{check.detail}</p>
              {check.action?.tabId && onNavigate ? (
                <button
                  type="button"
                  onClick={() => onNavigate({ tabId: check.action!.tabId!, entityId: check.action?.entityId })}
                  style={styles.button}
                >
                  {check.action.label}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Review actions" style={styles.section}>
        {review.canMarkDone ? (
          <button type="button" onClick={() => void markTaskDone()} className="ariadne-btn-primary" style={styles.primaryButton}>
            Mark task done
          </button>
        ) : (
          <p style={styles.blockedText}>Resolve blocking checks first</p>
        )}
      </section>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  root: {
    display: 'grid',
    gap: '1rem',
  },
  section: {
    display: 'grid',
    gap: '0.75rem',
  },
  sectionTitle: {
    margin: 0,
  },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'grid',
    gap: '0.75rem',
  },
  card: {
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    borderRadius: '6px',
    background: 'var(--vscode-sideBar-background, var(--vscode-editor-background))',
    padding: '0.875rem',
    display: 'grid',
    gap: '0.75rem',
  },
  cardHeader: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: '0.5rem',
    alignItems: 'center',
  },
  badge: {
    borderRadius: '4px',
    padding: '0.25rem 0.625rem',
    fontSize: '0.875rem',
    fontWeight: 600,
  },
  passBadge: {
    background: 'var(--vscode-diffEditor-insertedTextBackground, var(--vscode-editorWidget-background))',
    color: 'var(--vscode-foreground)',
  },
  warningBadge: {
    background: 'var(--vscode-inputValidation-warningBackground, var(--vscode-editorWidget-background))',
    color: 'var(--vscode-inputValidation-warningForeground, var(--vscode-foreground))',
  },
  failBadge: {
    background: 'var(--vscode-inputValidation-errorBackground, var(--vscode-editorWidget-background))',
    color: 'var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground))',
  },
  unknownBadge: {
    background: 'var(--vscode-panel-border, var(--vscode-widget-border))',
    color: 'var(--vscode-foreground)',
  },
  detail: {
    margin: 0,
    color: 'var(--vscode-descriptionForeground)',
  },
  button: {
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    background: 'var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background))',
    color: 'var(--vscode-foreground)',
    borderRadius: '4px',
    padding: '0.5rem 0.875rem',
    cursor: 'pointer',
    justifySelf: 'start',
  },
  primaryButton: {
    border: '1px solid var(--vscode-button-background)',
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    borderRadius: '4px',
    padding: '0.625rem 1rem',
    cursor: 'pointer',
    justifySelf: 'start',
  },
  blockedText: {
    margin: 0,
    color: 'var(--vscode-editorWarning-foreground, #cca700)',
    fontWeight: 600,
  },
  muted: {
    margin: 0,
    color: 'var(--vscode-descriptionForeground)',
  },
};
