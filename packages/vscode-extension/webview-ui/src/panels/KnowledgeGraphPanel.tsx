import { useMemo, useState } from 'react';
import type { AriadneBridge } from '../bridge';
import { knowledgeRequests, PanelState, styles, useKnowledgeRequest, type KnowledgeGraph } from './KnowledgePanelShared';

export interface KnowledgeGraphPanelProps { bridge: AriadneBridge; }

export default function KnowledgeGraphPanel({ bridge }: KnowledgeGraphPanelProps) {
  const [nodeId, setNodeId] = useState('');
  const payload = useMemo(() => ({ nodeId, depth: 2 }), [nodeId]);
  const state = useKnowledgeRequest<{ graph: KnowledgeGraph }>(bridge, knowledgeRequests.graph, payload);
  const graph = state.data?.graph;
  return <div style={styles.root}>
    <section style={styles.section} aria-label="Knowledge graph">
      <h3 style={{ margin: 0 }}>Knowledge Graph</h3>
      <div style={styles.actions}><input value={nodeId} onChange={(event) => setNodeId(event.target.value)} aria-label="Graph node" placeholder="Optional node id" style={{ flex: 1, minWidth: 150, padding: '0.5rem', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)' }} /><button type="button" style={styles.button} onClick={state.refresh}>Refresh graph</button></div>
      <PanelState state={state} emptyMessage="The knowledge graph is empty.">
        {graph ? <><div style={styles.grid}><div style={styles.card}><strong>Nodes</strong><span>{graph.nodes.length}</span></div><div style={styles.card}><strong>Edges</strong><span>{graph.edges.length}</span></div></div><ul style={{ margin: 0, paddingLeft: '1.25rem' }}>{graph.nodes.map((node) => <li key={node.id}>{node.label} <span style={styles.muted}>({node.kind ?? 'node'})</span></li>)}</ul>{graph.insights?.length ? <section style={styles.card}><strong>Insights</strong><ul>{graph.insights.map((insight) => <li key={insight}>{insight}</li>)}</ul></section> : null}</> : null}
      </PanelState>
    </section>
  </div>;
}
