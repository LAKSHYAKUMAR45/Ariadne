import type { ReactNode } from 'react';

interface AsyncStateProps {
  loading: boolean;
  empty: boolean;
  error?: string | null;
  partialError?: string | null;
  loadingLabel: string;
  emptyTitle: string;
  emptyMessage: string;
  children: ReactNode;
}

export function AsyncState({
  loading,
  empty,
  error = null,
  partialError = null,
  loadingLabel,
  emptyTitle,
  emptyMessage,
  children,
}: AsyncStateProps) {
  if (loading) {
    return (
      <div className="empty-inline" role="status">
        <span className="activity-pulse" aria-hidden="true" />
        <div>
          <strong>{loadingLabel}</strong>
        </div>
      </div>
    );
  }

  if (error && empty) {
    return <div className="notice notice--error" role="alert">{error}</div>;
  }

  return (
    <>
      {partialError ? <div className="notice notice--error" role="alert">{partialError}</div> : null}
      {empty ? (
        <div className="pane-empty">
          <span>--</span>
          <p>
            <strong>{emptyTitle}</strong>
            <br />
            {emptyMessage}
          </p>
        </div>
      ) : (
        children
      )}
    </>
  );
}
