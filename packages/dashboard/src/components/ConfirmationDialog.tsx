import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { ConfirmationRequest } from '../api/types';

interface ConfirmationDialogProps {
  request: ConfirmationRequest;
  busy: boolean;
  error: string | null;
  initialConfirmation?: string;
  children?: ReactNode;
  onCancel: () => void;
  onConfirm: (input: { confirmation: string; password?: string }) => Promise<void>;
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function focusableElements(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter((element) => !element.hasAttribute('disabled') && element.tabIndex !== -1);
}

export function ConfirmationDialog({
  request,
  busy,
  error,
  initialConfirmation = '',
  children,
  onCancel,
  onConfirm,
}: ConfirmationDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const errorId = useId();
  const confirmationId = useId();
  const passwordId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const confirmationRef = useRef<HTMLInputElement | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const restoreTargetRef = useRef<HTMLElement | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [password, setPassword] = useState('');

  const requiresConfirmation = request.expectedConfirmation.length > 0;
  const canSubmit =
    !busy &&
    (!requiresConfirmation || confirmation === request.expectedConfirmation) &&
    (!request.requiresReauthentication || password.length > 0);
  const describedBy = useMemo(
    () => (error ? `${descriptionId} ${errorId}` : descriptionId),
    [descriptionId, error, errorId],
  );

  useEffect(() => {
    restoreTargetRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setConfirmation(initialConfirmation);
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
  }, [
    initialConfirmation,
    request.expectedConfirmation,
    request.requiresReauthentication,
    requiresConfirmation,
  ]);

  useEffect(() => {
    if (error) {
      errorRef.current?.focus();
    }
  }, [error]);

  function restoreFocus(): void {
    restoreTargetRef.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Tab') {
      return;
    }

    const root = dialogRef.current;
    if (!root) {
      return;
    }

    const elements = focusableElements(root);
    if (elements.length === 0) {
      return;
    }

    const first = elements[0];
    const last = elements[elements.length - 1];
    const activeElement = document.activeElement;

    if (event.shiftKey && activeElement === first) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && activeElement === last) {
      event.preventDefault();
      first.focus();
    }
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
      <section
        ref={dialogRef}
        className="reauth-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        onKeyDown={handleKeyDown}
      >
        <p className="eyebrow">Protected action</p>
        <h2 id={titleId}>{request.title}</h2>
        <p id={descriptionId}>{request.impact}</p>
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
          {error ? (
            <p ref={errorRef} id={errorId} className="form-error" role="alert" tabIndex={-1}>
              {error}
            </p>
          ) : null}
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
