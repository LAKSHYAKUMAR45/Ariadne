import { useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import type { AriadneBridge } from '../bridge';
import type { GraphifyRequestPayload, GraphifyRunResult } from '@host/messages';

interface GraphifyPanelProps {
  bridge: AriadneBridge;
  workspaceRoot?: string;
  onBusy(label: string | undefined): void;
  onError(message: string): void;
}

type GraphifyMode = GraphifyRequestPayload['mode'];

const modeTabs: Array<{ id: GraphifyMode; label: string }> = [
  { id: 'update', label: 'Update' },
  { id: 'query', label: 'Query' },
  { id: 'path', label: 'Path' },
  { id: 'explain', label: 'Explain' },
];

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function GraphifyPanel({ bridge, workspaceRoot, onBusy, onError }: GraphifyPanelProps) {
  const [mode, setMode] = useState<GraphifyMode>('update');
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [target, setTarget] = useState('');
  const [result, setResult] = useState<GraphifyRunResult | null>(null);
  const canRun = Boolean(workspaceRoot);

  async function run(payload: GraphifyRequestPayload): Promise<void> {
    if (!canRun) {
      onError('Open a workspace folder to run Graphify.');
      return;
    }

    const busyLabels: Record<GraphifyMode, string> = {
      update: 'Running graphify update…',
      query: 'Running graphify query…',
      path: 'Running graphify path…',
      explain: 'Running graphify explain…',
    };

    onBusy(busyLabels[payload.mode]);
    onError('');
    try {
      const response = await bridge.request<{ result: GraphifyRunResult }>('graphify.run', payload);
      setResult(response.result);
    } catch (error) {
      onError(readError(error));
    } finally {
      onBusy(undefined);
    }
  }

  function renderForm(): ReactElement {
    switch (mode) {
      case 'update':
        return (
          <div style={styles.form}>
            <p style={styles.helperText}>Rebuild the local code graph for the selected workspace.</p>
            <button type="button" onClick={() => void run({ mode: 'update' })} style={styles.primaryButton} disabled={!canRun}>
              Run update
            </button>
          </div>
        );
      case 'query':
        return (
          <div style={styles.form}>
            <label style={styles.fieldLabel}>
              <span>Graphify query</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Graphify query" style={styles.input} />
            </label>
            <button type="button" onClick={() => void run({ mode: 'query', query })} style={styles.primaryButton} disabled={!canRun}>
              Run query
            </button>
          </div>
        );
      case 'path':
        return (
          <div style={styles.form}>
            <label style={styles.fieldLabel}>
              <span>Graphify from</span>
              <input value={from} onChange={(event) => setFrom(event.target.value)} aria-label="Graphify from" style={styles.input} />
            </label>
            <label style={styles.fieldLabel}>
              <span>Graphify to</span>
              <input value={to} onChange={(event) => setTo(event.target.value)} aria-label="Graphify to" style={styles.input} />
            </label>
            <button type="button" onClick={() => void run({ mode: 'path', from, to })} style={styles.primaryButton} disabled={!canRun}>
              Run path
            </button>
          </div>
        );
      case 'explain':
        return (
          <div style={styles.form}>
            <label style={styles.fieldLabel}>
              <span>Graphify target</span>
              <input
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                aria-label="Graphify target"
                style={styles.input}
              />
            </label>
            <button type="button" onClick={() => void run({ mode: 'explain', target })} style={styles.primaryButton} disabled={!canRun}>
              Run explain
            </button>
          </div>
        );
    }
  }

  return (
    <div style={styles.root}>
      <div role="tablist" aria-label="Graphify modes" style={styles.tabList}>
        {modeTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={mode === tab.id}
            aria-controls={`graphify-panel-${tab.id}`}
            id={`graphify-tab-${tab.id}`}
            onClick={() => setMode(tab.id)}
            style={mode === tab.id ? { ...styles.tab, ...styles.tabActive } : styles.tab}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <section
        role="tabpanel"
        id={`graphify-panel-${mode}`}
        aria-labelledby={`graphify-tab-${mode}`}
        style={styles.panel}
      >
        {!canRun ? <p role="alert" style={styles.installHint}>Open a workspace folder to run Graphify.</p> : null}
        {renderForm()}
      </section>

      {result ? (
        <section aria-label="Graphify result" style={styles.resultSection}>
          <div style={styles.metaRow}>
            <span>Exit code: {result.exitCode}</span>
            {result.args.length > 0 ? <span>Args: {result.args.join(' ')}</span> : null}
            {result.truncated ? <span>Panel output truncated</span> : null}
          </div>
          {!result.available ? <p role="alert" style={styles.installHint}>{result.output}</p> : null}
          <pre style={styles.output}>{result.output}</pre>
        </section>
      ) : (
        <p style={styles.helperText}>Run Graphify from the extension host to update or inspect the local code graph.</p>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  root: {
    display: 'grid',
    gap: '1rem',
  },
  tabList: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
  },
  tab: {
    border: '1px solid #334155',
    background: '#1e293b',
    color: '#e2e8f0',
    borderRadius: '0.5rem',
    padding: '0.5rem 0.875rem',
    cursor: 'pointer',
  },
  tabActive: {
    border: '1px solid #2563eb',
    background: '#1d4ed8',
    color: '#eff6ff',
  },
  panel: {
    border: '1px solid #334155',
    borderRadius: '0.75rem',
    background: '#111827',
    padding: '1rem',
  },
  form: {
    display: 'grid',
    gap: '0.75rem',
  },
  fieldLabel: {
    display: 'grid',
    gap: '0.375rem',
  },
  input: {
    border: '1px solid #334155',
    borderRadius: '0.5rem',
    background: '#0f172a',
    color: '#e2e8f0',
    padding: '0.625rem 0.75rem',
  },
  primaryButton: {
    border: '1px solid #1d4ed8',
    background: '#1d4ed8',
    color: '#eff6ff',
    borderRadius: '0.5rem',
    padding: '0.625rem 1rem',
    cursor: 'pointer',
    justifySelf: 'start',
  },
  helperText: {
    margin: 0,
    color: '#94a3b8',
  },
  resultSection: {
    display: 'grid',
    gap: '0.75rem',
  },
  metaRow: {
    display: 'flex',
    gap: '0.75rem',
    flexWrap: 'wrap',
    color: '#cbd5e1',
  },
  installHint: {
    margin: 0,
    color: '#fbbf24',
  },
  output: {
    margin: 0,
    borderRadius: '0.75rem',
    border: '1px solid #334155',
    background: '#020617',
    color: '#e2e8f0',
    padding: '1rem',
    whiteSpace: 'pre-wrap',
    overflowX: 'auto',
  },
};
