import { useEffect, useMemo, useState } from 'react';
import type { AriadneBridge } from '../bridge';
import type { SyncProfile } from '@host/messages';

interface SyncPanelProps {
  bridge: AriadneBridge;
}

function readError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function looksLikeAuthError(message: string): boolean {
  return /not logged in|login|profile|config/i.test(message);
}

const AUTH_GUIDANCE =
  'It looks like this workspace needs sync setup. Run `ariadne sync login` in a terminal, or revisit `ariadne sync setup [username]`, then try again.';

type SyncActionKey = 'profileList' | 'push' | 'pull' | 'listRemote';
type SyncRequestType = 'sync.push' | 'sync.pull' | 'sync.listRemote';

interface SyncActionState {
  status: 'completed' | 'failed';
  output: string;
}

interface SyncProfileListProps {
  profiles: SyncProfile[];
}

const ACTION_LABELS: Record<SyncActionKey, string> = {
  profileList: 'profile list',
  push: 'push local changes',
  pull: 'pull remote changes',
  listRemote: 'list remote tasks',
};

function SyncProfileList({ profiles }: SyncProfileListProps) {
  return (
    <ul>
      {profiles.map((profile) => (
        <li key={`${profile.name}:${profile.serverUrl ?? ''}`}>
          <span>{profile.name}</span>
          {profile.serverUrl ? <span>{` — ${profile.serverUrl}`}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export default function SyncPanel({ bridge }: SyncPanelProps) {
  const [profiles, setProfiles] = useState<SyncProfile[]>([]);
  const [profileWarning, setProfileWarning] = useState<string | null>(null);
  const [guidance, setGuidance] = useState<string | null>(null);
  const [busy, setBusy] = useState<SyncActionKey | null>(null);
  const [lastAction, setLastAction] = useState<SyncActionKey | null>(null);
  const [actionStates, setActionStates] = useState<Partial<Record<SyncActionKey, SyncActionState>>>({});
  const [confirmingImportNew, setConfirmingImportNew] = useState(false);

  const currentProfiles = useMemo(() => profiles.filter((profile) => profile.current), [profiles]);
  const otherProfiles = useMemo(() => profiles.filter((profile) => !profile.current), [profiles]);
  const latestActionState = lastAction ? actionStates[lastAction] : undefined;

  function updateActionState(action: SyncActionKey, status: SyncActionState['status'], output: string): void {
    setActionStates((current) => ({
      ...current,
      [action]: { status, output },
    }));
    setLastAction(action);
  }

  async function loadProfiles(): Promise<void> {
    setBusy('profileList');
    setGuidance(null);
    try {
      const result = await bridge.request<{ profiles: SyncProfile[]; output: string }>('sync.profileList');
      setProfiles(result.profiles);
      setProfileWarning(result.profiles.filter((profile) => profile.current).length > 1 ? 'Multiple current profiles reported.' : null);
      updateActionState('profileList', 'completed', result.output);
    } catch (error) {
      const message = readError(error);
      setProfiles([]);
      setProfileWarning(null);
      updateActionState('profileList', 'failed', message);
      if (looksLikeAuthError(message)) {
        setGuidance(AUTH_GUIDANCE);
      }
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void loadProfiles();
  }, [bridge]);

  async function runSync(action: Exclude<SyncActionKey, 'profileList'>, type: SyncRequestType, payload?: unknown): Promise<void> {
    setBusy(action);
    setGuidance(null);
    try {
      const result =
        type === 'sync.pull'
          ? await bridge.request<{ output: string }>(type, payload)
          : await bridge.request<{ output: string }>(type);
      updateActionState(action, 'completed', result.output);
    } catch (error) {
      const message = readError(error);
      updateActionState(action, 'failed', message);
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
    await runSync('pull', 'sync.pull', { importNew: true });
  }

  const statusText = busy
    ? `Running ${ACTION_LABELS[busy]}…`
    : lastAction
      ? `Last action: ${ACTION_LABELS[lastAction]} ${actionStates[lastAction]?.status ?? 'completed'}`
      : 'Idle. No sync actions run yet.';

  return (
    <div>
      <p aria-label="Sync status">{statusText}</p>

      {currentProfiles[0] ? (
        <section aria-label="Current sync profile">
          <h3>Current profile</h3>
          <SyncProfileList profiles={currentProfiles} />
        </section>
      ) : (
        <p>No sync profiles detected.</p>
      )}

      {profileWarning ? <p role="alert">{profileWarning}</p> : null}

      {otherProfiles.length > 0 ? (
        <section aria-label="Other sync profiles">
          <h3>Other profiles</h3>
          <SyncProfileList profiles={otherProfiles} />
        </section>
      ) : null}

      <div>
        <button type="button" onClick={() => void runSync('push', 'sync.push')} disabled={busy !== null}>
          Push local changes
        </button>
        <button type="button" onClick={() => void runSync('pull', 'sync.pull', { importNew: false })} disabled={busy !== null}>
          Pull remote changes
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
        <button type="button" onClick={() => void runSync('listRemote', 'sync.listRemote')} disabled={busy !== null}>
          List remote tasks
        </button>
      </div>

      {guidance ? <p role="alert">{guidance}</p> : null}

      <section aria-label="Sync action history">
        <h3>Session status</h3>
        <ul>
          {(['profileList', 'push', 'pull', 'listRemote'] as SyncActionKey[])
            .filter((action) => actionStates[action])
            .map((action) => (
              <li key={action}>
                {ACTION_LABELS[action]}: {actionStates[action]?.status}
              </li>
            ))}
        </ul>
      </section>

      {latestActionState && lastAction ? (
        <details>
          <summary>{`Raw output: ${ACTION_LABELS[lastAction]} (${latestActionState.status})`}</summary>
          <pre aria-label="Raw sync command output">{latestActionState.output}</pre>
        </details>
      ) : null}
    </div>
  );
}
