import { useMemo, useState } from 'react';
import { AdminApiError } from '../api/client';
import { isAcceptedOperationResponse } from '../api/guards';
import type {
  AdminOperation,
  ConfirmationRequest,
} from '../api/types';
import { ConfirmationDialog } from '../components/ConfirmationDialog';
import { OperationProgress } from '../components/OperationProgress';
import { useAuth } from './AuthProvider';

interface PendingAction {
  method: 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body: Record<string, unknown>;
  successMessage: string;
  confirmation?: ConfirmationRequest;
}

interface RunActionOptions {
  method?: 'POST' | 'PATCH' | 'DELETE';
  confirmation?: ConfirmationRequest;
}

interface PrivilegedAction {
  busy: boolean;
  error: string | null;
  message: string | null;
  run: (
    path: string,
    successMessage: string,
    body?: Record<string, unknown>,
    options?: RunActionOptions,
  ) => Promise<void>;
  dialog: React.ReactNode;
  progress: React.ReactNode;
}

const REAUTH_REQUEST: ConfirmationRequest = {
  title: 'Confirm administrator',
  impact: 'Enter your password to continue this operation.',
  expectedConfirmation: '',
  confirmationLabel: '',
  requiresReauthentication: true,
};

export function usePrivilegedAction(): PrivilegedAction {
  const { api, reauthenticate } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [operation, setOperation] = useState<AdminOperation | null>(null);

  async function execute(action: PendingAction, confirmation?: string): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);

    const nextBody = confirmation
      ? { ...action.body, confirmation }
      : action.body;

    try {
      const response = await api.mutate(
        action.method,
        action.path,
        nextBody,
        isAcceptedOperationResponse,
      );
      setOperation(response.operation);
      setMessage(action.successMessage);
    } catch (actionError: unknown) {
      if (actionError instanceof AdminApiError && actionError.code === 'reauthentication_required') {
        setPending({ ...action, confirmation: action.confirmation ?? REAUTH_REQUEST });
        return;
      }
      setError(actionError instanceof Error ? actionError.message : 'The operation could not start.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmPending(input: { confirmation: string; password?: string }): Promise<void> {
    if (!pending) {
      return;
    }

    setBusy(true);
    setDialogError(null);

    try {
      if (pending.confirmation?.requiresReauthentication) {
        await reauthenticate(input.password ?? '');
      }
      const action = pending;
      setPending(null);
      await execute(
        action,
        action.confirmation?.expectedConfirmation ? input.confirmation : undefined,
      );
    } catch (actionError: unknown) {
      setDialogError(
        actionError instanceof Error ? actionError.message : 'The password was not accepted.',
      );
    } finally {
      setBusy(false);
    }
  }

  return {
    busy,
    error,
    message,
    run: async (path, successMessage, body = {}, options) => {
      const action: PendingAction = {
        method: options?.method ?? 'POST',
        path,
        body,
        successMessage,
        confirmation: options?.confirmation,
      };

      if (options?.confirmation) {
        setPending(action);
        setDialogError(null);
        return;
      }

      await execute(action);
    },
    dialog: pending?.confirmation ? (
      <ConfirmationDialog
        request={pending.confirmation}
        busy={busy}
        error={dialogError}
        onCancel={() => {
          setPending(null);
          setDialogError(null);
        }}
        onConfirm={confirmPending}
      />
    ) : null,
    progress: useMemo(
      () => (
        <OperationProgress
          api={api}
          operationId={operation?.id ?? null}
          initialOperation={operation}
        />
      ),
      [api, operation],
    ),
  };
}
