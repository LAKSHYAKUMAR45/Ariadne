import { useMemo, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import type { SearchResult } from '@host/messages';
import type { AriadneBridge } from '../bridge';

interface SearchPanelProps {
  bridge: AriadneBridge;
  initialResults: SearchResult[];
  onNavigate?: (hit: SearchHit) => void;
}

export type SearchCategory = SearchResult['matches'][number]['category'];

const categoryOrder: SearchCategory[] = ['title', 'goal', 'checkpoint', 'decision', 'todo', 'error', 'question', 'file', 'commit'];

export interface SearchHit {
  id: string;
  category: SearchCategory;
  taskId: string;
  taskTitle: string;
  taskStatus: SearchResult['taskStatus'];
  text: string;
  createdAt: string;
}

function actionLabel(hit: SearchHit): string {
  if (hit.category === 'file') {
    return `Open file ${hit.id}`;
  }

  if (hit.category === 'commit') {
    return `Open commit ${hit.id}`;
  }

  return `Open ${hit.category} result: ${hit.text}`;
}

function flattenResults(results: SearchResult[]): SearchHit[] {
  return results.flatMap((result) =>
    result.matches.map((match) => ({
      id: match.id,
      category: match.category,
      taskId: result.taskId,
      taskTitle: result.taskTitle,
      taskStatus: result.taskStatus,
      text: match.text,
      createdAt: match.createdAt,
    })),
  );
}

export default function SearchPanel({ bridge, initialResults, onNavigate }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [allWorkspaces, setAllWorkspaces] = useState(false);
  const [results, setResults] = useState<SearchResult[]>(initialResults);
  const [status, setStatus] = useState<string | null>(null);

  const groupedHits = useMemo(() => {
    const hits = flattenResults(results);
    return categoryOrder
      .map((category) => ({
        category,
        hits: hits
          .filter((hit) => hit.category === category)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      }))
      .filter((group) => group.hits.length > 0);
  }, [results]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setStatus('Enter a search query to begin.');
      return;
    }

    setStatus('Searching…');
    try {
      const result = await bridge.request<{ results: SearchResult[] }>('search.run', {
        query: trimmed,
        allWorkspaces,
      });
      setResults(result.results);
      setStatus(result.results.length === 0 ? 'No results found.' : null);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div style={styles.root}>
      <form onSubmit={(event) => void handleSubmit(event)} style={styles.form}>
        <label style={styles.fieldLabel}>
          Search query
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search query"
            style={styles.textInput}
          />
        </label>
        <label style={styles.checkboxLabel}>
          <input
            type="checkbox"
            checked={allWorkspaces}
            onChange={(event) => setAllWorkspaces(event.target.checked)}
          />
          Search all workspaces
        </label>
        <button type="submit" className="ariadne-btn-primary" style={{ ...styles.primaryButton, ...styles.selfStart }}>
          Search
        </button>
      </form>

      {status ? <p style={styles.subtleText}>{status}</p> : null}

      <section aria-label="Search results" style={styles.section}>
        <h3 style={styles.sectionTitle}>Search results</h3>
        {groupedHits.length === 0 ? (
          <p style={styles.subtleText}>No results to display.</p>
        ) : (
          groupedHits.map((group) => (
            <section key={group.category} aria-label={group.category} style={styles.group}>
              <h4 style={styles.groupTitle}>{group.category}</h4>
              <ul style={styles.hitList}>
                {group.hits.map((hit, index) => {
                  const label = actionLabel(hit);
                  return (
                    <li key={`${hit.taskId}-${hit.category}-${hit.createdAt}-${index}`}>
                      <button type="button" onClick={() => onNavigate?.(hit)} aria-label={label} style={styles.hitButton}>
                        <span style={styles.hitLabel}>{label}</span>
                        {label !== hit.text ? <span style={styles.hitText}>{hit.text}</span> : null}
                        <span style={styles.hitMeta}>Task: {hit.taskId}</span>
                        <span style={styles.hitMeta}>
                          <time dateTime={hit.createdAt}>{hit.createdAt}</time>
                        </span>
                        <span style={styles.hitMeta}>{hit.taskTitle}</span>
                        <span style={styles.hitMeta}>{hit.taskStatus}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
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
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  fieldLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.375rem',
    color: 'var(--vscode-descriptionForeground)',
    fontSize: '0.875rem',
  },
  checkboxLabel: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    color: 'var(--vscode-descriptionForeground)',
  },
  textInput: {
    width: '100%',
    border: '1px solid var(--vscode-input-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    background: 'var(--vscode-input-background)',
    color: 'var(--vscode-input-foreground)',
    padding: '0.5rem 0.75rem',
    boxSizing: 'border-box',
  },
  selfStart: {
    alignSelf: 'flex-start',
  },
  primaryButton: {
    border: '1px solid var(--vscode-button-background)',
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    borderRadius: '4px',
    padding: '0.5rem 0.875rem',
  },
  subtleText: {
    margin: 0,
    color: 'var(--vscode-descriptionForeground)',
  },
  section: {
    display: 'grid',
    gap: '0.75rem',
  },
  sectionTitle: {
    margin: 0,
  },
  group: {
    display: 'grid',
    gap: '0.5rem',
  },
  groupTitle: {
    margin: 0,
    textTransform: 'capitalize',
    color: 'var(--vscode-descriptionForeground)',
  },
  hitList: {
    display: 'grid',
    gap: '0.5rem',
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  hitButton: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    borderRadius: '6px',
    background: 'var(--vscode-sideBar-background, var(--vscode-editor-background))',
    color: 'var(--vscode-foreground)',
    padding: '0.625rem 0.75rem',
  },
  hitLabel: {
    display: 'block',
    fontWeight: 600,
  },
  hitText: {
    display: 'block',
    color: 'var(--vscode-foreground)',
  },
  hitMeta: {
    display: 'block',
    fontSize: '0.85rem',
    color: 'var(--vscode-descriptionForeground)',
  },
};
