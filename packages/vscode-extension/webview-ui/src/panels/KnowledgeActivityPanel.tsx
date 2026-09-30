import { useMemo } from 'react';
import type { AriadneBridge } from '../bridge';
import { knowledgeRequests, PanelState, styles, useKnowledgeRequest, type KnowledgeActivity } from './KnowledgePanelShared';

export interface KnowledgeActivityPanelProps { bridge: AriadneBridge; }

export default function KnowledgeActivityPanel({ bridge }: KnowledgeActivityPanelProps) {
  const state = useKnowledgeRequest<{ items: KnowledgeActivity[]; queue?: { queued: number; running: number; failed: number } }>(bridge, knowledgeRequests.activity, useMemo(() => ({ limit: 100 }), []));
  return <div style={styles.root}><section style={styles.section} aria-label="Knowledge activity"><h3 style={{ margin: 0 }}>Knowledge activity</h3><PanelState state={state} emptyMessage="No knowledge activity recorded.">{state.data?.queue ? <div style={styles.grid}>{Object.entries(state.data.queue).map(([label, value]) => <div key={label} style={styles.card}><strong>{label}</strong><span>{value}</span></div>)}</div> : null}<ol style={{ margin: 0, paddingLeft: '1.25rem' }}>{state.data?.items.map((item) => <li key={item.id}><strong>{item.title}</strong>{item.detail ? ` — ${item.detail}` : ''}<small style={styles.muted}>{item.createdAt ?? ''}</small></li>)}</ol></PanelState><button type="button" style={styles.button} onClick={state.refresh}>Refresh activity</button></section></div>;
}
