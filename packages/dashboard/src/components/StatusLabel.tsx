interface StatusLabelProps {
  status: string;
}

function toneForStatus(status: string): 'good' | 'warning' | 'bad' | 'neutral' {
  switch (status) {
    case 'succeeded':
    case 'verified':
    case 'running':
    case 'available':
    case 'healthy':
    case 'active':
    case 'operational':
      return 'good';
    case 'stale':
    case 'degraded':
    case 'review':
      return 'warning';
    case 'failed':
    case 'restore_failed':
    case 'verify_failed':
    case 'unavailable':
    case 'inactive':
      return 'bad';
    case 'queued':
    case 'created':
      return 'warning';
    default:
      return 'neutral';
  }
}

export function StatusLabel({ status }: StatusLabelProps) {
  const tone = toneForStatus(status);
  const dotClassName =
    tone === 'good'
      ? 'status-dot status-dot--good'
      : tone === 'bad'
        ? 'status-dot status-dot--bad'
        : 'status-dot status-dot--warning';
  const pillClassName =
    tone === 'good'
      ? 'status-pill status-pill--good'
      : tone === 'warning'
        ? 'status-pill status-pill--warning'
        : tone === 'bad'
          ? 'status-pill status-pill--bad'
      : 'status-pill status-pill--neutral';

  return (
    <span className={pillClassName}>
      <span className={dotClassName} aria-hidden="true" />
      {status}
    </span>
  );
}
