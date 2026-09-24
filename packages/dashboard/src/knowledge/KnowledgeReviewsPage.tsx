import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbortError } from '../api/client';
import {
  isKnowledgeProjectsResponse,
  isKnowledgeReviewMutationResponse,
  isKnowledgeReviewsResponse,
} from '../api/guards';
import type { KnowledgeProjectSummary, KnowledgeReview, KnowledgeReviewAction } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { AsyncState } from '../components/AsyncState';

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

export function KnowledgeReviewsPage() {
  const { api } = useAuth();
  const [projects, setProjects] = useState<KnowledgeProjectSummary[]>([]);
  const [projectId, setProjectId] = useState('');
  const [reviews, setReviews] = useState<KnowledgeReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.get('/api/v1/admin/knowledge/projects', isKnowledgeProjectsResponse, controller.signal)
      .then((response) => {
        const activeProjects = response.projects.filter((project) => project.status === 'active');
        setProjects(activeProjects);
        setProjectId((current) => current || activeProjects[0]?.id || '');
      })
      .catch((loadError: unknown) => {
        if (!isAbortError(loadError)) setError(loadError instanceof Error ? loadError.message : 'Unable to load knowledge projects.');
      });
    return () => controller.abort();
  }, [api]);

  const loadReviews = useCallback(async (): Promise<void> => {
    controllerRef.current?.abort();
    if (!projectId) {
      setReviews([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const response = await api.get(
        `/api/v1/admin/knowledge/projects/${encodeURIComponent(projectId)}/reviews?status=pending`,
        isKnowledgeReviewsResponse,
        controller.signal,
      );
      if (controller.signal.aborted || controllerRef.current !== controller) return;
      if (response.reviews.some((review) => review.projectId !== projectId)) {
        throw new Error('The review response did not match the selected knowledge project.');
      }
      setReviews(response.reviews);
      setError(null);
    } catch (loadError: unknown) {
      if (!isAbortError(loadError) && !controller.signal.aborted) {
        setReviews([]);
        setError(loadError instanceof Error ? loadError.message : 'Unable to load knowledge reviews.');
      }
    } finally {
      if (controllerRef.current === controller) setLoading(false);
    }
  }, [api, projectId]);

  useEffect(() => {
    void loadReviews();
    return () => controllerRef.current?.abort();
  }, [loadReviews]);

  const resolveReview = useCallback(async (review: KnowledgeReview, action: KnowledgeReviewAction): Promise<void> => {
    setPendingActionId(review.id);
    setError(null);
    try {
      const response = await api.mutate(
        'PATCH',
        `/api/v1/admin/knowledge/projects/${encodeURIComponent(projectId)}/reviews/${encodeURIComponent(review.id)}`,
        { action, evidence: { kind: 'dashboard', id: review.id } },
        isKnowledgeReviewMutationResponse,
      );
      setReviews((current) => current.filter((item) => item.id !== response.review.id));
    } catch (resolveError: unknown) {
      setError(resolveError instanceof Error ? resolveError.message : 'Unable to resolve the knowledge review.');
    } finally {
      setPendingActionId(null);
    }
  }, [api, projectId]);

  return (
    <div className="page-stack">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Knowledge workspace</p>
          <h1>Knowledge reviews</h1>
          <p>Resolve generated knowledge with an explicit accept, reject, or skip decision.</p>
        </div>
        <button className="quiet-action" type="button" onClick={() => void loadReviews()}>Refresh reviews</button>
      </header>
      <label className="source-select knowledge-project-picker">
        <span>Project</span>
        <select aria-label="Knowledge project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          <option value="">Select a project</option>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
      <AsyncState
        loading={loading}
        empty={!projectId || reviews.length === 0}
        error={error}
        loadingLabel="Loading knowledge reviews"
        emptyTitle={projectId ? 'No pending reviews' : 'No active knowledge projects'}
        emptyMessage={projectId ? 'This project has no pending review actions.' : 'Create an active project before reviewing generated knowledge.'}
      >
        <section className="knowledge-review-list" aria-label="Pending knowledge reviews">
          {reviews.map((review) => (
            <article className="panel knowledge-review" key={review.id}>
              <div>
                <p className="eyebrow">Requested {formatTimestamp(review.requestedAt)}</p>
                <h2>{review.summary ?? 'Generated knowledge requires review'}</h2>
                <p className="member-static">Page version: {review.pageVersionId ?? 'Not linked to a page version'}</p>
              </div>
              <div className="row-action-group">
                <button className="quiet-action row-action" type="button" disabled={pendingActionId === review.id} onClick={() => void resolveReview(review, 'accept')}>Accept</button>
                <button className="quiet-action row-action" type="button" disabled={pendingActionId === review.id} onClick={() => void resolveReview(review, 'reject')}>Reject</button>
                <button className="quiet-action row-action" type="button" disabled={pendingActionId === review.id} onClick={() => void resolveReview(review, 'skip')}>Skip</button>
              </div>
            </article>
          ))}
        </section>
      </AsyncState>
    </div>
  );
}
