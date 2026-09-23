import { useCallback, useMemo, useState } from 'react';
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
  confirmationValue?: string;
}

interface RunActionOptions {
  method?: 'POST' | 'PATCH' | 'DELETE';
  confirmation?: ConfirmationRequest;
}

interface PrivilegedAction {
  busy: boolean;
  error: string | null;
  message: string | null;
  operation: AdminOperation | null;
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
  const handleOperationChange = useCallback((nextOperation: AdminOperation | null): void => {
    setOperation((currentOperation) => {
      if (!nextOperation) {
        return currentOperation;
      }
      if (currentOperation && currentOperation.id !== nextOperation.id) {
        return currentOperation;
      }
      return nextOperation;
    });
  }, []);

  function requireReauthentication(action: PendingAction, confirmationValue = ''): PendingAction {
    return {
      ...action,
      confirmationValue,
      confirmation: action.confirmation
        ? {
            ...action.confirmation,
            requiresReauthentication: true,
          }
        : REAUTH_REQUEST,
    };
  }

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
        setPending(requireReauthentication(action, confirmation ?? action.confirmationValue ?? ''));
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
    operation,
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
        initialConfirmation={pending.confirmationValue}
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
          onOperationChange={handleOperationChange}
        />
      ),
      [api, handleOperationChange, operation],
    ),
  };
}
