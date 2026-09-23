import { useEffect, useMemo, useState } from 'react';
import type { SearchResult } from '@host/messages';
import type { AriadneBridge } from '../bridge';

interface SearchPanelProps {
  bridge: AriadneBridge;
  initialResults: SearchResult[];
}

type SearchCategory = SearchResult['matches'][number]['category'];

const categoryOrder: SearchCategory[] = ['title', 'goal', 'checkpoint', 'decision', 'todo', 'error', 'question', 'file', 'commit'];

interface SearchHit {
  category: SearchCategory;
  taskId: string;
  taskTitle: string;
  taskStatus: SearchResult['taskStatus'];
  text: string;
  createdAt: string;
}

function flattenResults(results: SearchResult[]): SearchHit[] {
  return results.flatMap((result) =>
    result.matches.map((match) => ({
      category: match.category,
      taskId: result.taskId,
      taskTitle: result.taskTitle,
      taskStatus: result.taskStatus,
      text: match.text,
      createdAt: match.createdAt,
    })),
  );
}

export default function SearchPanel({ bridge, initialResults }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [allWorkspaces, setAllWorkspaces] = useState(false);
  const [results, setResults] = useState<SearchResult[]>(initialResults);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setResults(initialResults);
  }, [initialResults]);

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

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
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
    <div>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <label>
          Search query
          <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search query" />
        </label>
        <label>
          <input
            type="checkbox"
            checked={allWorkspaces}
            onChange={(event) => setAllWorkspaces(event.target.checked)}
          />
          Search all workspaces
        </label>
        <button type="submit">Search</button>
      </form>

      {status ? <p>{status}</p> : null}

      <section aria-label="Search results">
        <h3>Search results</h3>
        {groupedHits.length === 0 ? (
          <p>No results to display.</p>
        ) : (
          groupedHits.map((group) => (
            <section key={group.category} aria-label={group.category}>
              <h4>{group.category}</h4>
              <ul>
                {group.hits.map((hit, index) => (
                  <li key={`${hit.taskId}-${hit.category}-${hit.createdAt}-${index}`}>
                    <p>{hit.text}</p>
                    <p>Task: {hit.taskId}</p>
                    <p>
                      <time dateTime={hit.createdAt}>{hit.createdAt}</time>
                    </p>
                    <p>{hit.taskTitle}</p>
                    <p>{hit.taskStatus}</p>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </section>
    </div>
  );
}
