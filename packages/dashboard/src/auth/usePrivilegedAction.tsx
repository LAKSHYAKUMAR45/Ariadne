import { FormEvent, useState } from 'react';
import { AdminApiError, postJson } from '../api/client';

interface PendingAction {
  path: string;
  body?: Record<string, unknown>;
  successMessage: string;
}

interface PrivilegedAction {
  busy: boolean;
  error: string | null;
  message: string | null;
  run: (path: string, successMessage: string, body?: Record<string, unknown>) => Promise<void>;
  dialog: React.ReactNode;
}

export function usePrivilegedAction(csrfToken?: string): PrivilegedAction {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [reauthError, setReauthError] = useState<string | null>(null);

  async function execute(action: PendingAction): Promise<void> {
    if (!csrfToken) {
      setError('Sign in again before starting an operation.');
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await postJson(action.path, csrfToken, action.body);
      setMessage(action.successMessage);
    } catch (actionError: unknown) {
      if (actionError instanceof AdminApiError && actionError.code === 'reauthentication_required') {
        setPending(action);
        return;
      }
      setError(actionError instanceof Error ? actionError.message : 'The operation could not start.');
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!pending || !csrfToken) {
      return;
    }
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password') ?? '');
    setBusy(true);
    setReauthError(null);
    try {
      await postJson('/api/v1/admin/session/reauthenticate', csrfToken, { password });
      const action = pending;
      setPending(null);
      await execute(action);
    } catch (actionError: unknown) {
      setReauthError(
        actionError instanceof Error ? actionError.message : 'The password was not accepted.',
      );
    } finally {
      setBusy(false);
    }
  }

  const dialog = pending ? (
    <div className="dialog-backdrop">
      <section className="reauth-dialog" role="dialog" aria-modal="true" aria-labelledby="reauth-title">
        <p className="eyebrow">Protected action</p>
        <h2 id="reauth-title">Confirm administrator</h2>
        <p>Enter your password to continue this operation.</p>
        <form onSubmit={(event) => void submitPassword(event)}>
          <label htmlFor="reauth-password">Administrator password</label>
          <input
            id="reauth-password"
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
          />
          {reauthError ? <p className="form-error" role="alert">{reauthError}</p> : null}
          <div className="dialog-actions">
            <button className="quiet-action" type="button" onClick={() => setPending(null)}>
              Cancel
            </button>
            <button className="primary-action" type="submit" disabled={busy}>
              {busy ? 'Confirming...' : 'Continue operation'}
            </button>
          </div>
        </form>
      </section>
    </div>
  ) : null;

  return {
    busy,
    error,
    message,
    run: (path, successMessage, body) => execute({ path, successMessage, body }),
    dialog,
  };
}
