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
      return 'good';
    case 'failed':
    case 'restore_failed':
    case 'verify_failed':
    case 'unavailable':
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
      : 'status-pill status-pill--neutral';

  return (
    <span className={pillClassName}>
      <span className={dotClassName} aria-hidden="true" />
      {status}
    </span>
  );
}
