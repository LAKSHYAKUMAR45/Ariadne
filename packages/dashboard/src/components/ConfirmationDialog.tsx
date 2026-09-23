import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { ConfirmationRequest } from '../api/types';

interface ConfirmationDialogProps {
  request: ConfirmationRequest;
  busy: boolean;
  error: string | null;
  children?: ReactNode;
  onCancel: () => void;
  onConfirm: (input: { confirmation: string; password?: string }) => Promise<void>;
}

export function ConfirmationDialog({
  request,
  busy,
  error,
  children,
  onCancel,
  onConfirm,
}: ConfirmationDialogProps) {
  const titleId = useId();
  const confirmationId = useId();
  const passwordId = useId();
  const confirmationRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const restoreTargetRef = useRef<HTMLElement | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [password, setPassword] = useState('');

  const requiresConfirmation = request.expectedConfirmation.length > 0;
  const canSubmit =
    !busy &&
    (!requiresConfirmation || confirmation === request.expectedConfirmation) &&
    (!request.requiresReauthentication || password.length > 0);

  useEffect(() => {
    restoreTargetRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setConfirmation('');
    setPassword('');

    const focusTarget = requiresConfirmation
      ? confirmationRef.current
      : request.requiresReauthentication
        ? passwordRef.current
        : cancelRef.current;
    focusTarget?.focus();

    return () => {
      restoreTargetRef.current?.focus();
    };
  }, [request.expectedConfirmation, request.requiresReauthentication, requiresConfirmation]);

  function restoreFocus(): void {
    restoreTargetRef.current?.focus();
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    await onConfirm({
      confirmation,
      password: request.requiresReauthentication ? password : undefined,
    });
  }

  function cancel(): void {
    restoreFocus();
    onCancel();
  }

  return (
    <div className="dialog-backdrop">
      <section className="reauth-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <p className="eyebrow">Protected action</p>
        <h2 id={titleId}>{request.title}</h2>
        <p>{request.impact}</p>
        {children}
        <form onSubmit={(event) => void submit(event)}>
          {requiresConfirmation ? (
            <>
              <label htmlFor={confirmationId}>{request.confirmationLabel}</label>
              <input
                ref={confirmationRef}
                id={confirmationId}
                type="text"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </>
          ) : null}
          {request.requiresReauthentication ? (
            <>
              <label htmlFor={passwordId}>Administrator password</label>
              <input
                ref={passwordRef}
                id={passwordId}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </>
          ) : null}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="dialog-actions">
            <button ref={cancelRef} className="quiet-action" type="button" onClick={cancel}>
              Cancel
            </button>
            <button className="primary-action" type="submit" disabled={!canSubmit}>
              {busy ? 'Confirming...' : 'Continue operation'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
