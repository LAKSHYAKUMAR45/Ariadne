import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { TaskFileCaptureWithEntries } from '@host/messages';
import type { AriadneBridge } from '../bridge';

interface FilesPanelProps {
  bridge: AriadneBridge;
  captures: TaskFileCaptureWithEntries[];
}

function lineClassName(line: string): string {
  if (line.startsWith('+')) return 'diff-line diff-line-add';
  if (line.startsWith('-')) return 'diff-line diff-line-remove';
  return 'diff-line diff-line-context';
}

function renderDiffText(diff: string): ReactNode {
  return diff.split('\n').map((line, index) => (
    <span key={`${index}-${line}`} className={lineClassName(line)} style={{ display: 'block' }}>
      {line}
    </span>
  ));
}

export default function FilesPanel({ bridge, captures }: FilesPanelProps) {
  const [selectedCaptureId, setSelectedCaptureId] = useState<string | null>(captures[0]?.id ?? null);
  const [loadedCaptures, setLoadedCaptures] = useState<Record<string, TaskFileCaptureWithEntries>>({});
  const [busyCaptureId, setBusyCaptureId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const captureMap = useMemo(() => {
    const entries = captures.map((capture) => [capture.id, capture] as const);
    return new Map(entries);
  }, [captures]);

  useEffect(() => {
    if (captures.length === 0) {
      setSelectedCaptureId(null);
      return;
    }

    if (!selectedCaptureId || !captures.some((capture) => capture.id === selectedCaptureId)) {
      setSelectedCaptureId(captures[0].id);
    }
  }, [captures, selectedCaptureId]);

  const selectedCapture =
    (selectedCaptureId ? loadedCaptures[selectedCaptureId] ?? captureMap.get(selectedCaptureId) : undefined) ?? undefined;

  async function selectCapture(captureId: string): Promise<void> {
    setSelectedCaptureId(captureId);
    setMessage(null);

    if (loadedCaptures[captureId]) {
      return;
    }

    setBusyCaptureId(captureId);
    try {
      const result = await bridge.request<{ capture: TaskFileCaptureWithEntries }>('files.getCapture', { id: captureId });
      setLoadedCaptures((current) => ({ ...current, [captureId]: result.capture }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyCaptureId(null);
    }
  }

  return (
    <div>
      <section aria-label="File captures">
        <h3>File captures</h3>
        {captures.length === 0 ? (
          <p>No file captures recorded for the current task.</p>
        ) : (
          <ul>
            {captures.map((capture) => (
              <li key={capture.id}>
                <button type="button" onClick={() => void selectCapture(capture.id)} aria-pressed={capture.id === selectedCaptureId}>
                  {capture.id} · {capture.entries.length} file(s)
                </button>
                {busyCaptureId === capture.id ? <p>Loading capture…</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {message ? <p role="alert">{message}</p> : null}

      <section aria-label="Selected capture details">
        <h3>Selected capture</h3>
        {selectedCapture ? (
          <div>
            <p>
              <strong>{selectedCapture.id}</strong>
            </p>
            <ul>
              {selectedCapture.entries.map((entry) => (
                <li key={entry.path}>
                  <p>{entry.path}</p>
                  <pre aria-label="Unified diff">{renderDiffText(entry.unifiedDiff)}</pre>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p>Select a capture to view its diff.</p>
        )}
      </section>
    </div>
  );
}
