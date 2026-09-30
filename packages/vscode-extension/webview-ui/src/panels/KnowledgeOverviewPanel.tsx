import { useMemo } from 'react';
import type { AriadneBridge } from '../bridge';
import { knowledgeRequests, PanelState, styles, useKnowledgeRequest, type KnowledgeOverview } from './KnowledgePanelShared';

export interface KnowledgeOverviewPanelProps {
  bridge: AriadneBridge;
  onNavigate?: (pageId: string) => void;
}

export default function KnowledgeOverviewPanel({ bridge, onNavigate }: KnowledgeOverviewPanelProps) {
  const payload = useMemo(() => ({}), []);
  const state = useKnowledgeRequest<{ overview: KnowledgeOverview }>(bridge, knowledgeRequests.overview, payload);
  const overview = state.data?.overview;
  return (
    <div style={styles.root}>
      <section aria-label="Knowledge overview" style={styles.section}>
        <h3 style={{ margin: 0 }}>{overview?.title ?? 'Knowledge workspace'}</h3>
        {!overview && state.status === 'success' ? <p style={styles.muted}>No knowledge project has been created for this workspace.</p> : null}
        <PanelState state={state} emptyMessage="No knowledge project has been created for this workspace.">
          {overview ? (
            <>
              <p style={styles.muted}>{overview.summary ?? 'Local project knowledge, sources, pages, and reviews.'}</p>
              <div style={styles.grid}>
                {[
                  ['Sources', overview.sourceCount ?? 0],
                  ['Pages', overview.pageCount ?? overview.pages?.length ?? 0],
                  ['Stale pages', overview.staleCount ?? 0],
                  ['Pending reviews', overview.pendingReviews ?? 0],
                ].map(([label, value]) => <div key={label} style={styles.card}><strong>{label}</strong><span>{value}</span></div>)}
              </div>
              {overview.pages?.length ? (
                <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                  {overview.pages.map((page) => (
                    <li key={page.id}>
                      <button type="button" style={{ ...styles.button, border: 0, padding: 0 }} onClick={() => onNavigate?.(page.id)}>
                        {page.title}
                      </button>{page.status === 'stale' ? ' (stale)' : ''}
                    </li>
                  ))}
                </ul>
              ) : <p style={styles.muted}>No generated pages yet.</p>}
            </>
          ) : null}
        </PanelState>
        <div style={styles.actions}>
          <button type="button" style={styles.button} onClick={state.refresh}>Refresh overview</button>
          <button type="button" style={styles.button} onClick={state.cancel}>Cancel request</button>
        </div>
      </section>
    </div>
  );
}
