import { useState } from 'react';
import type { AriadneBridge } from '../bridge';

interface SyncPanelProps {
  bridge: AriadneBridge;
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function SyncPanel({ bridge }: SyncPanelProps) {
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function runSync(type: 'sync.push' | 'sync.pull' | 'sync.listRemote', payload?: unknown): Promise<void> {
    setBusy(type);
    try {
      const result =
        type === 'sync.push'
          ? await bridge.request<{ output: string }>(type)
          : type === 'sync.listRemote'
            ? await bridge.request<{ output: string }>(type)
            : await bridge.request<{ output: string }>(type, payload);
      setOutput(result.output);
    } catch (error) {
      setOutput(readError(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div>
        <button type="button" onClick={() => void runSync('sync.push')} disabled={busy !== null}>
          Push
        </button>
        <button type="button" onClick={() => void runSync('sync.pull', { importNew: false })} disabled={busy !== null}>
          Pull
        </button>
        <button type="button" onClick={() => void runSync('sync.pull', { importNew: true })} disabled={busy !== null}>
          Pull import-new
        </button>
        <button type="button" onClick={() => void runSync('sync.listRemote')} disabled={busy !== null}>
          List remote
        </button>
      </div>
      <pre aria-label="Sync output">{output}</pre>
    </div>
  );
}
