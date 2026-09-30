import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbortError } from '../api/client';
import { isKnowledgeProjectsResponse, isKnowledgeSearchResponse } from '../api/guards';
import type { KnowledgeProjectSummary, KnowledgeSearchResult } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { AsyncState } from '../components/AsyncState';

function citationLabel(citation: KnowledgeSearchResult['citations'][number]): string {
  const location = citation.url ?? citation.path ?? citation.sourceId ?? 'Unknown source';
  return citation.span?.label ? `${location} - ${citation.span.label}` : location;
}

export function KnowledgeSearchPage() {
  const { api } = useAuth();
  const [projects, setProjects] = useState<KnowledgeProjectSummary[]>([]);
  const [projectId, setProjectId] = useState('');
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [results, setResults] = useState<KnowledgeSearchResult[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [searching, setSearching] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.get('/api/v1/admin/knowledge/projects', isKnowledgeProjectsResponse, controller.signal)
      .then((response) => {
        setProjects(response.projects.filter((project) => project.status === 'active'));
        setProjectId((current) => current || response.projects.find((project) => project.status === 'active')?.id || '');
        setProjectError(null);
      })
      .catch((loadError: unknown) => {
        if (!isAbortError(loadError)) {
          setProjectError(loadError instanceof Error ? loadError.message : 'Unable to load knowledge projects.');
        }
      })
      .finally(() => setLoadingProjects(false));
    return () => controller.abort();
  }, [api]);

  const search = useCallback(async (): Promise<void> => {
    const nextQuery = query.trim();
    if (!projectId || !nextQuery) {
      setSubmittedQuery(nextQuery);
      setResults([]);
      setSearchError(null);
      return;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setSearching(true);
    setSubmittedQuery(nextQuery);
    setSearchError(null);

    try {
      const params = new URLSearchParams({ query: nextQuery, mode: 'hybrid' });
      const response = await api.get(
        `/api/v1/admin/knowledge/projects/${encodeURIComponent(projectId)}/search?${params.toString()}`,
        isKnowledgeSearchResponse,
        controller.signal,
      );
      if (controller.signal.aborted || controllerRef.current !== controller) {
        return;
      }
      if (response.projectId !== projectId) {
        throw new Error('The search response did not match the selected knowledge project.');
      }
      setResults(response.results);
    } catch (searchError: unknown) {
      if (!isAbortError(searchError) && !controller.signal.aborted) {
        setResults([]);
        setSearchError(searchError instanceof Error ? searchError.message : 'Unable to search knowledge.');
      }
    } finally {
      if (controllerRef.current === controller) {
        setSearching(false);
      }
    }
  }, [api, projectId, query]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const empty = submittedQuery.length > 0 && results.length === 0;

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Knowledge workspace</p>
          <h1>Knowledge search</h1>
          <p>Search one active project at a time; every generated result retains its source citations.</p>
        </div>
      </header>
      <form
        className="knowledge-search-form"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label className="source-select">
          <span>Project</span>
          <select
            aria-label="Knowledge project"
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
              setSubmittedQuery('');
              setResults([]);
              setSearchError(null);
            }}
            disabled={loadingProjects}
          >
            <option value="">Select a project</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label className="knowledge-query">
          <span>Search query</span>
          <input aria-label="Search knowledge" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search pages, sources, and task history" />
        </label>
        <button className="primary-action page-action" type="submit" disabled={!projectId || query.trim().length === 0 || searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>
      {projectError ? <div className="notice notice--error" role="alert">{projectError}</div> : null}
      {loadingProjects ? <div className="empty-inline" role="status"><span className="activity-pulse" aria-hidden="true" /><strong>Loading knowledge projects</strong></div> : null}
      {!loadingProjects && projects.length === 0 ? <div className="pane-empty"><span>--</span><p><strong>No active knowledge projects</strong><br />Create an active project before searching.</p></div> : null}
      {!loadingProjects && projects.length > 0 && !submittedQuery ? <div className="pane-empty"><span>??</span><p><strong>Search a knowledge project</strong><br />Results are limited to the selected project boundary.</p></div> : null}
      {!loadingProjects && submittedQuery ? (
        <AsyncState
          loading={searching}
          empty={empty}
          error={searchError}
          loadingLabel="Searching knowledge"
          emptyTitle="No matching knowledge"
          emptyMessage={`No pages, sources, or task history matched “${submittedQuery}”.`}
        >
          <section className="knowledge-results" aria-label="Knowledge search results">
            {results.map((result) => (
              <article className="panel knowledge-result" key={`${result.kind}-${result.id}`}>
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">{result.kind}</p>
                    <h2>{result.title}</h2>
                  </div>
                  <span className="member-static">Score {result.score.toFixed(1)}</span>
                </div>
                {result.searchConfidence ? (
                  <p>
                    Confidence: {result.searchConfidence}
                    {result.ambiguityReason ? ` (${result.ambiguityReason.replaceAll('_', ' ')})` : ''}
                  </p>
                ) : null}
                {result.searchConfidence === 'ambiguous' && result.ambiguityAlternatives !== undefined ? (
                  <p>{result.ambiguityAlternatives} competing alternative{result.ambiguityAlternatives === 1 ? '' : 's'}</p>
                ) : null}
                <p>{result.snippet}</p>
                <div className="citation-list" aria-label={`Citations for ${result.title}`}>
                  {result.citations.length === 0 ? <span className="member-static">No source citation available.</span> : null}
                  {result.citations.map((citation) => (
                    <span key={`${citation.sourceId}-${citation.span?.id ?? citation.path ?? citation.url}`}>
                      {citationLabel(citation)}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </section>
        </AsyncState>
      ) : null}
    </div>
  );
}
