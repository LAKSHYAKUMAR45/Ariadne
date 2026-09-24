import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { AriadneBridge } from '../bridge';
import { knowledgeRequests, PanelState, styles, useKnowledgeRequest, type KnowledgeSearchResult } from './KnowledgePanelShared';

export interface KnowledgeSearchPanelProps { bridge: AriadneBridge; onOpenPage?: (id: string) => void; }

export default function KnowledgeSearchPanel({ bridge, onOpenPage }: KnowledgeSearchPanelProps) {
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const payload = useMemo(() => ({ query: submitted, mode: 'hybrid' }), [submitted]);
  const state = useKnowledgeRequest<{ results: KnowledgeSearchResult[] }>(bridge, knowledgeRequests.search, payload, submitted.length > 0);
  function submit(event: FormEvent): void { event.preventDefault(); setSubmitted(query.trim()); }
  const results = state.data?.results ?? [];
  return <div style={styles.root}>
    <form onSubmit={submit} style={styles.actions} aria-label="Knowledge search">
      <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Knowledge search query" placeholder="Search pages, sources, and tasks" style={{ flex: 1, minWidth: 160, padding: '0.5rem', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)' }} />
      <button className="ariadne-btn-primary" type="submit" style={styles.primary}>Search</button>
      {submitted ? <button type="button" style={styles.button} onClick={state.cancel}>Cancel</button> : null}
    </form>
    <PanelState state={state} emptyMessage="No knowledge matches found.">
      <section aria-label="Knowledge search results" style={styles.section}>
        <h3 style={{ margin: 0 }}>Results {submitted ? `for “${submitted}”` : ''}</h3>
        {results.map((result) => <article key={result.id} style={styles.card}>
          <button type="button" style={{ ...styles.button, border: 0, padding: 0, textAlign: 'left' }} onClick={() => onOpenPage?.(result.id)}><strong>{result.title}</strong></button>
          <span style={styles.muted}>{result.kind}{result.stale ? ' · stale' : ''}{result.score === undefined ? '' : ` · score ${result.score.toFixed(2)}`}</span>
          <p style={{ margin: 0 }}>{result.snippet}</p>
          {result.citations?.length ? <small style={styles.muted}>Citations: {result.citations.map((citation) => citation.label).join(', ')}</small> : null}
        </article>)}
      </section>
    </PanelState>
  </div>;
}
