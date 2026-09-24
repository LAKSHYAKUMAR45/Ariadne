import { useMemo, useState } from 'react';
import type { AriadneBridge } from '../bridge';
import { knowledgeRequests, PanelState, styles, useKnowledgeRequest, type KnowledgeReview } from './KnowledgePanelShared';

export interface KnowledgeReviewPanelProps { bridge: AriadneBridge; }

export default function KnowledgeReviewPanel({ bridge }: KnowledgeReviewPanelProps) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const state = useKnowledgeRequest<{ reviews: KnowledgeReview[] }>(bridge, knowledgeRequests.reviews, useMemo(() => ({ status: 'pending' }), []));
  async function resolve(review: KnowledgeReview, action: 'accept' | 'reject' | 'skip'): Promise<void> {
    setBusyId(review.id);
    try { await bridge.request(knowledgeRequests.reviewResolve, { reviewId: review.id, action }); state.refresh(); } finally { setBusyId(null); }
  }
  return <div style={styles.root}><section style={styles.section} aria-label="Knowledge reviews"><h3 style={{ margin: 0 }}>Review queue</h3><PanelState state={state} emptyMessage="No pending knowledge reviews.">{state.data?.reviews.map((review) => <article key={review.id} style={styles.card}><strong>{review.summary}</strong><span style={styles.muted}>{review.status}{review.requestedAt ? ` · ${review.requestedAt}` : ''}</span><div style={styles.actions}>{(['accept', 'reject', 'skip'] as const).map((action) => <button key={action} type="button" disabled={busyId === review.id} style={styles.button} onClick={() => void resolve(review, action)}>{busyId === review.id ? 'Saving…' : action}</button>)}</div></article>)}</PanelState><button type="button" style={styles.button} onClick={state.refresh}>Refresh reviews</button></section></div>;
}
