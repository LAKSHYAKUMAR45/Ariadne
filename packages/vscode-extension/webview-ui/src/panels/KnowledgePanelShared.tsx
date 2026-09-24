import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { AriadneBridge } from '../bridge';

export interface KnowledgeCitation {
  id: string;
  label: string;
  path?: string;
  line?: number;
}

export interface KnowledgePagePreview {
  id: string;
  title: string;
  type: string;
  summary?: string | null;
  content?: string;
  status?: 'active' | 'stale' | 'archived';
  updatedAt?: string;
  citations?: KnowledgeCitation[];
}

export interface KnowledgeOverview {
  projectId?: string;
  title?: string;
  summary?: string;
  pages?: KnowledgePagePreview[];
  sourceCount?: number;
  pageCount?: number;
  staleCount?: number;
  pendingReviews?: number;
  queue?: { queued: number; running: number; failed: number; cancelled?: number };
}

export interface KnowledgeSearchResult {
  id: string;
  title: string;
  kind: string;
  snippet: string;
  score?: number;
  stale?: boolean;
  citations?: KnowledgeCitation[];
}

export interface KnowledgeGraph {
  nodes: Array<{ id: string; label: string; kind?: string; confidence?: number }>;
  edges: Array<{ id?: string; from: string; to: string; label?: string }>;
  insights?: string[];
}

export interface KnowledgeReview {
  id: string;
  summary: string;
  status: 'pending' | 'approved' | 'rejected' | 'dismissed';
  requestedAt?: string;
  pageVersionId?: string | null;
}

export interface KnowledgeActivity {
  id: string;
  title: string;
  detail?: string;
  status?: string;
  createdAt?: string;
}

export const knowledgeRequests = {
  overview: 'knowledge.overview',
  search: 'knowledge.search',
  graph: 'knowledge.graph',
  reviews: 'knowledge.reviews',
  reviewResolve: 'knowledge.review.resolve',
  activity: 'knowledge.activity',
  queue: 'knowledge.queue',
  rebuild: 'knowledge.rebuild',
  page: 'knowledge.page',
} as const;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RequestState<T> {
  data: T | null;
  status: 'idle' | 'loading' | 'success' | 'empty' | 'stale' | 'failure' | 'cancelled';
  error?: string;
}

export function useKnowledgeRequest<T>(
  bridge: AriadneBridge,
  requestType: string,
  payload: unknown,
  enabled = true,
): RequestState<T> & { refresh: () => void; cancel: () => void } {
  const [state, setState] = useState<RequestState<T>>({ data: null, status: 'idle' });
  const [version, setVersion] = useState(0);
  const generation = useRef(0);

  const cancel = useCallback(() => {
    generation.current += 1;
    setState((current) => ({ ...current, status: current.data ? 'stale' : 'cancelled' }));
  }, []);
  const refresh = useCallback(() => {
    generation.current += 1;
    setVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, status: 'idle' });
      return;
    }
    const requestGeneration = ++generation.current;
    setState((current) => ({ data: current.data, status: current.data ? 'stale' : 'loading' }));
    void bridge
      .request<T>(requestType, payload)
      .then((data) => {
        if (requestGeneration !== generation.current) return;
        const empty = data === null || data === undefined || (Array.isArray(data) && data.length === 0);
        setState({ data, status: empty ? 'empty' : 'success' });
      })
      .catch((error: unknown) => {
        if (requestGeneration !== generation.current) return;
        setState((current) => ({ ...current, status: 'failure', error: errorMessage(error) }));
      });
  }, [bridge, enabled, payload, requestType, version]);

  return { ...state, refresh, cancel };
}

export function PanelState({ state, emptyMessage = 'Nothing to show yet.', children }: {
  state: RequestState<unknown>;
  emptyMessage?: string;
  children: ReactNode;
}): ReactNode {
  if (state.status === 'loading') return <p style={styles.muted}>Loading knowledge workspace…</p>;
  if (state.status === 'stale') {
    return <div style={styles.state}><p style={styles.muted}>Refreshing… showing the last result.</p>{children}</div>;
  }
  if (state.status === 'failure') return <p role="alert" style={styles.error}>{state.error ?? 'Knowledge request failed.'}</p>;
  if (state.status === 'cancelled') return <p style={styles.muted}>Request cancelled.</p>;
  if (state.status === 'empty') return <p style={styles.muted}>{emptyMessage}</p>;
  return <>{children}</>;
}

export const styles: Record<string, CSSProperties> = {
  root: { display: 'grid', gap: '1rem', minWidth: 0 },
  section: { display: 'grid', gap: '0.75rem', minWidth: 0 },
  card: { border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))', borderRadius: '6px', background: 'var(--vscode-sideBar-background, var(--vscode-editor-background))', padding: '0.75rem', minWidth: 0 },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.75rem' },
  muted: { margin: 0, color: 'var(--vscode-descriptionForeground)' },
  error: { margin: 0, color: 'var(--vscode-errorForeground)' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem' },
  button: { border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))', borderRadius: '4px', background: 'var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background))', color: 'var(--vscode-foreground)', padding: '0.5rem 0.75rem' },
  primary: { border: '1px solid var(--vscode-button-background)', borderRadius: '4px', background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', padding: '0.5rem 0.75rem' },
  state: { display: 'grid', gap: '0.5rem' },
};
