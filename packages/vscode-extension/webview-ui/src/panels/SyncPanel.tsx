import { useState } from 'react';
import type { AriadneBridge } from '../bridge';

interface SyncPanelProps {
  bridge: AriadneBridge;
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function looksLikeAuthError(message: string): boolean {
  return /auth|login|token|unauthoriz|credential|forbidden|401|403/i.test(message);
}

const AUTH_GUIDANCE =
  'It looks like this workspace may not be signed in to cloud sync. Run `ariadne sync setup [username]` in a terminal, then try again.';

export default function SyncPanel({ bridge }: SyncPanelProps) {
  const [output, setOutput] = useState('');
  const [guidance, setGuidance] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [confirmingImportNew, setConfirmingImportNew] = useState(false);

  async function runSync(type: 'sync.push' | 'sync.pull' | 'sync.listRemote', payload?: unknown): Promise<void> {
    setBusy(type);
    setGuidance(null);
    try {
      const result =
        type === 'sync.push'
          ? await bridge.request<{ output: string }>(type)
          : type === 'sync.listRemote'
            ? await bridge.request<{ output: string }>(type)
            : await bridge.request<{ output: string }>(type, payload);
      setOutput(result.output);
      setLastAction(type);
    } catch (error) {
      const message = readError(error);
      setOutput(message);
      setLastAction(type);
      if (looksLikeAuthError(message)) {
        setGuidance(AUTH_GUIDANCE);
      }
    } finally {
      setBusy(null);
    }
  }

  function requestImportNewPull(): void {
    setConfirmingImportNew(true);
  }

  function cancelImportNewPull(): void {
    setConfirmingImportNew(false);
  }

  async function confirmImportNewPull(): Promise<void> {
    setConfirmingImportNew(false);
    await runSync('sync.pull', { importNew: true });
  }

  const statusText = busy
    ? `Running ${busy}…`
    : lastAction
      ? `Last action: ${lastAction} completed`
      : 'Idle. No sync actions run yet.';

  return (
    <div>
      <p aria-label="Sync status">{statusText}</p>

      <div>
        <button type="button" onClick={() => void runSync('sync.push')} disabled={busy !== null}>
          Push
        </button>
        <button type="button" onClick={() => void runSync('sync.pull', { importNew: false })} disabled={busy !== null}>
          Pull
        </button>
        {confirmingImportNew ? (
          <span role="group" aria-label="Confirm pull import-new">
            <span>Import new remote tasks into this workspace?</span>
            <button type="button" onClick={() => void confirmImportNewPull()} disabled={busy !== null}>
              Confirm pull import-new
            </button>
            <button type="button" onClick={cancelImportNewPull} disabled={busy !== null}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" onClick={requestImportNewPull} disabled={busy !== null}>
            Pull import-new
          </button>
        )}
        <button type="button" onClick={() => void runSync('sync.listRemote')} disabled={busy !== null}>
          List remote
        </button>
      </div>

      {guidance ? <p role="alert">{guidance}</p> : null}

      <pre aria-label="Sync output">{output}</pre>
    </div>
  );
}
