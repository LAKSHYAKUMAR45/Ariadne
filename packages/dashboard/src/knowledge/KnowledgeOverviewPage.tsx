import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbortError } from '../api/client';
import { isKnowledgeProjectsResponse } from '../api/guards';
import type { KnowledgeProjectSummary } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { AsyncState } from '../components/AsyncState';

const PROJECTS_PATH = '/api/v1/admin/knowledge/projects';

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function formatQueueAge(value: string | null): string {
  if (value === null) {
    return 'No queued work';
  }
  const ageMinutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
  if (ageMinutes < 60) {
    return `${ageMinutes} minute${ageMinutes === 1 ? '' : 's'}`;
  }
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) {
    return `${ageHours} hour${ageHours === 1 ? '' : 's'}`;
  }
  const ageDays = Math.floor(ageHours / 24);
  return `${ageDays} day${ageDays === 1 ? '' : 's'}`;
}

export function KnowledgeOverviewPage() {
  const { api } = useAuth();
  const [projects, setProjects] = useState<KnowledgeProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const loadProjects = useCallback(async (): Promise<void> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);

    try {
      const response = await api.get(PROJECTS_PATH, isKnowledgeProjectsResponse, controller.signal);
      if (controller.signal.aborted || controllerRef.current !== controller) {
        return;
      }
      setProjects(response.projects);
      setError(null);
    } catch (loadError: unknown) {
      if (isAbortError(loadError) || controller.signal.aborted) {
        return;
      }
      setProjects([]);
      setError(loadError instanceof Error ? loadError.message : 'Unable to load knowledge projects.');
    } finally {
      if (controllerRef.current === controller) {
        setLoading(false);
      }
    }
  }, [api]);

  useEffect(() => {
    void loadProjects();
    return () => controllerRef.current?.abort();
  }, [loadProjects]);

  const sourceCount = projects.reduce((total, project) => total + project.sourceCount, 0);
  const pageCount = projects.reduce((total, project) => total + project.pageCount, 0);
  const pendingReviewCount = projects.reduce((total, project) => total + project.pendingReviewCount, 0);
  const worker = projects.reduce(
    (summary, project) => ({
      queued: summary.queued + project.worker.queued,
      running: summary.running + project.worker.running,
      failed: summary.failed + project.worker.failed,
      oldestQueuedAt:
        summary.oldestQueuedAt === null || (
          project.worker.oldestQueuedAt !== null &&
          Date.parse(project.worker.oldestQueuedAt) < Date.parse(summary.oldestQueuedAt)
        )
          ? project.worker.oldestQueuedAt
          : summary.oldestQueuedAt,
      activeWorkerCount: summary.activeWorkerCount + project.worker.activeWorkerCount,
      deterministicCompleted: summary.deterministicCompleted + project.worker.deterministicCompleted,
      enrichedCompleted: summary.enrichedCompleted + project.worker.enrichedCompleted,
    }),
    {
      queued: 0,
      running: 0,
      failed: 0,
      oldestQueuedAt: null as string | null,
      activeWorkerCount: 0,
      deterministicCompleted: 0,
      enrichedCompleted: 0,
    },
  );

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Knowledge workspace</p>
          <h1>Knowledge overview</h1>
          <p>Project-scoped source coverage, generated pages, and review backlog.</p>
        </div>
        <button className="quiet-action" type="button" onClick={() => void loadProjects()}>
          Refresh projects
        </button>
      </header>
      <AsyncState
        loading={loading}
        empty={projects.length === 0}
        error={error}
        loadingLabel="Loading knowledge projects"
        emptyTitle="No knowledge projects"
        emptyMessage="Create a project with the Ariadne CLI before adding sources or reviews."
      >
        <section className="knowledge-metrics" aria-label="Knowledge totals">
          <article className="panel metric-panel">
            <span>Projects</span>
            <strong className="metric-value">{projects.length}</strong>
          </article>
          <article className="panel metric-panel">
            <span>Sources</span>
            <strong className="metric-value">{sourceCount}</strong>
          </article>
          <article className="panel metric-panel">
            <span>Pages</span>
            <strong className="metric-value">{pageCount}</strong>
          </article>
          <article className="panel metric-panel">
            <span>Pending reviews</span>
            <strong className="metric-value">{pendingReviewCount}</strong>
          </article>
        </section>
        <section className="panel data-panel" aria-label="Knowledge worker status">
          <div className="table-heading">
            <strong>Worker status</strong>
            <span>Oldest queued: {formatQueueAge(worker.oldestQueuedAt)}</span>
          </div>
          <dl className="knowledge-metrics">
            <div className="metric-panel"><dt>Queued</dt><dd className="metric-value">{worker.queued}</dd></div>
            <div className="metric-panel"><dt>Running</dt><dd className="metric-value">{worker.running}</dd></div>
            <div className="metric-panel"><dt>Failed</dt><dd className="metric-value">{worker.failed}</dd></div>
            <div className="metric-panel"><dt>Active workers</dt><dd className="metric-value">{worker.activeWorkerCount}</dd></div>
            <div className="metric-panel"><dt>Deterministic</dt><dd className="metric-value">{worker.deterministicCompleted}</dd></div>
            <div className="metric-panel"><dt>Enriched</dt><dd className="metric-value">{worker.enrichedCompleted}</dd></div>
          </dl>
        </section>
        <section className="panel data-panel">
          <div className="table-heading">
            <strong>Knowledge projects</strong>
            <span>{projects.length} loaded</span>
          </div>
          <div className="knowledge-project-list">
            {projects.map((project) => (
              <article className="knowledge-project-row" key={project.id}>
                <div>
                  <strong>{project.name}</strong>
                  <span>{project.description ?? 'No project description.'}</span>
                </div>
                <dl>
                  <div><dt>Sources</dt><dd>{project.sourceCount}</dd></div>
                  <div><dt>Pages</dt><dd>{project.pageCount}</dd></div>
                  <div><dt>Reviews</dt><dd>{project.pendingReviewCount}</dd></div>
                </dl>
                <div className="knowledge-project-meta">
                  <span className={`status-pill status-pill--${project.status === 'active' ? 'good' : 'neutral'}`}>
                    {project.status}
                  </span>
                  <time dateTime={project.updatedAt}>{formatTimestamp(project.updatedAt)}</time>
                </div>
              </article>
            ))}
          </div>
        </section>
      </AsyncState>
    </div>
  );
}
