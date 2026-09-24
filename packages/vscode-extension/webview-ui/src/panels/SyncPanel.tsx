import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
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
    <ul style={styles.profileList}>
      {profiles.map((profile) => (
        <li key={`${profile.name}:${profile.serverUrl ?? ''}`} style={styles.profileItem}>
          <span>{profile.name}</span>
          {profile.serverUrl ? <span style={styles.subtleText}>{` — ${profile.serverUrl}`}</span> : null}
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
    <div style={styles.root}>
      <p aria-label="Sync status" style={styles.statusText}>
        {statusText}
      </p>

      {currentProfiles[0] ? (
        <section aria-label="Current sync profile" style={styles.card}>
          <h3 style={styles.sectionTitle}>Current profile</h3>
          <SyncProfileList profiles={currentProfiles} />
        </section>
      ) : (
        <p style={styles.subtleText}>No sync profiles detected.</p>
      )}

      {profileWarning ? (
        <p role="alert" style={styles.warningBanner}>
          {profileWarning}
        </p>
      ) : null}

      {otherProfiles.length > 0 ? (
        <section aria-label="Other sync profiles" style={styles.card}>
          <h3 style={styles.sectionTitle}>Other profiles</h3>
          <SyncProfileList profiles={otherProfiles} />
        </section>
      ) : null}

      <div style={styles.actionsRow}>
        <button type="button" onClick={() => void runSync('push', 'sync.push')} disabled={busy !== null} style={styles.secondaryButton}>
          Push local changes
        </button>
        <button
          type="button"
          onClick={() => void runSync('pull', 'sync.pull', { importNew: false })}
          disabled={busy !== null}
          style={styles.secondaryButton}
        >
          Pull remote changes
        </button>
        {confirmingImportNew ? (
          <span role="group" aria-label="Confirm pull import-new" style={styles.confirmGroup}>
            <span style={styles.subtleText}>Import new remote tasks into this workspace?</span>
            <button type="button" onClick={() => void confirmImportNewPull()} disabled={busy !== null} className="ariadne-btn-primary" style={styles.primaryButton}>
              Confirm pull import-new
            </button>
            <button type="button" onClick={cancelImportNewPull} disabled={busy !== null} style={styles.secondaryButton}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" onClick={requestImportNewPull} disabled={busy !== null} style={styles.secondaryButton}>
            Pull import-new
          </button>
        )}
        <button
          type="button"
          onClick={() => void runSync('listRemote', 'sync.listRemote')}
          disabled={busy !== null}
          style={styles.secondaryButton}
        >
          List remote tasks
        </button>
      </div>

      {guidance ? (
        <p role="alert" style={styles.warningBanner}>
          {guidance}
        </p>
      ) : null}

      <section aria-label="Sync action history" style={styles.card}>
        <h3 style={styles.sectionTitle}>Session status</h3>
        <ul style={styles.historyList}>
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
        <details style={styles.card}>
          <summary>{`Raw output: ${ACTION_LABELS[lastAction]} (${latestActionState.status})`}</summary>
          <pre aria-label="Raw sync command output" style={styles.outputBlock}>
            {latestActionState.output}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  root: {
    display: 'grid',
    gap: '1rem',
  },
  statusText: {
    margin: 0,
    color: 'var(--vscode-descriptionForeground)',
  },
  subtleText: {
    color: 'var(--vscode-descriptionForeground)',
  },
  card: {
    display: 'grid',
    gap: '0.5rem',
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    borderRadius: '6px',
    background: 'var(--vscode-sideBar-background, var(--vscode-editor-background))',
    padding: '0.75rem',
  },
  sectionTitle: {
    margin: 0,
  },
  profileList: {
    margin: 0,
    paddingLeft: '1.25rem',
  },
  profileItem: {
    marginBottom: '0.25rem',
  },
  actionsRow: {
    display: 'flex',
    gap: '0.5rem',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  secondaryButton: {
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    borderRadius: '4px',
    background: 'var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background))',
    color: 'var(--vscode-foreground)',
    padding: '0.5rem 0.875rem',
  },
  primaryButton: {
    border: '1px solid var(--vscode-button-background)',
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    borderRadius: '4px',
    padding: '0.5rem 0.875rem',
  },
  confirmGroup: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
  },
  warningBanner: {
    margin: 0,
    borderRadius: '6px',
    padding: '0.625rem 0.875rem',
    background: 'var(--vscode-inputValidation-warningBackground, var(--vscode-editorWidget-background))',
    color: 'var(--vscode-inputValidation-warningForeground, var(--vscode-foreground))',
    border: '1px solid var(--vscode-inputValidation-warningBorder, transparent)',
  },
  historyList: {
    margin: 0,
    paddingLeft: '1.25rem',
  },
  outputBlock: {
    margin: '0.5rem 0 0',
    border: '1px solid var(--vscode-panel-border, var(--vscode-widget-border))',
    borderRadius: '6px',
    background: 'var(--vscode-textCodeBlock-background, var(--vscode-editor-background))',
    padding: '0.75rem',
    overflowX: 'auto',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '0.85rem',
  },
};
