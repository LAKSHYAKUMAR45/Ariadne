import { useEffect, useState } from 'react';
import {
  isAdminOperationCompleteEvent,
  isAdminOperationEvent,
  isOperationResponse,
} from '../api/guards';
import type {
  AdminApiClient,
  AdminOperation,
  AdminOperationCompleteEvent,
  AdminOperationEvent,
} from '../api/types';

const POLL_INTERVAL_MS = 1_000;
const MAX_POLL_ATTEMPTS = 5;

interface UseOperationOptions {
  api: AdminApiClient;
  operationId: string | null;
  initialOperation?: AdminOperation | null;
}

interface UseOperationResult {
  operation: AdminOperation | null;
  latestEvent: AdminOperationEvent | null;
  live: boolean;
  polling: boolean;
  error: string | null;
}

function isTerminal(operation: AdminOperation | null): boolean {
  return operation?.state === 'succeeded' || operation?.state === 'failed';
}

function parseEventBlock(block: string): { event: string; data: unknown } | null {
  const lines = block.replace(/\r/g, '').split('\n');
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(':') || line.length === 0) {
      continue;
    }
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  try {
    return {
      event,
      data: JSON.parse(dataLines.join('\n')) as unknown,
    };
  } catch {
    return null;
  }
}

export function useOperation({
  api,
  operationId,
  initialOperation = null,
}: UseOperationOptions): UseOperationResult {
  const [operation, setOperation] = useState<AdminOperation | null>(initialOperation);
  const [latestEvent, setLatestEvent] = useState<AdminOperationEvent | null>(null);
  const [live, setLive] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOperation(initialOperation);
  }, [initialOperation]);

  useEffect(() => {
    if (!operationId) {
      setOperation(initialOperation);
      setLatestEvent(null);
      setLive(false);
      setPolling(false);
      setError(null);
      return;
    }

    const activeOperationId = operationId;
    const controller = new AbortController();
    let disposed = false;
    let timeoutId: number | null = null;

    async function reloadOperation(): Promise<AdminOperation | null> {
      const response = await api.get(
        `/api/v1/admin/operations/${encodeURIComponent(activeOperationId)}`,
        isOperationResponse,
        controller.signal,
      );
      if (disposed) {
        return null;
      }
      setOperation(response.operation);
      return response.operation;
    }

    async function poll(attempt: number): Promise<void> {
      if (disposed) {
        return;
      }

      setPolling(true);

      try {
        const current = await reloadOperation();
        if (!current || isTerminal(current) || attempt + 1 >= MAX_POLL_ATTEMPTS) {
          setPolling(false);
          return;
        }
      } catch (pollError: unknown) {
        if (!disposed) {
          setError(pollError instanceof Error ? pollError.message : 'Unable to refresh the operation state.');
        }
        setPolling(false);
        return;
      }

      timeoutId = window.setTimeout(() => {
        void poll(attempt + 1);
      }, POLL_INTERVAL_MS);
    }

    async function handleTerminalEvent(_event: AdminOperationCompleteEvent): Promise<void> {
      setLive(false);
      setPolling(false);
      await reloadOperation().catch((reloadError: unknown) => {
        if (!disposed) {
          setError(
            reloadError instanceof Error
              ? reloadError.message
              : 'Unable to refresh the completed operation.',
          );
        }
      });
    }

    async function connect(): Promise<void> {
      setError(null);

      try {
        const response = await fetch(
          `/api/v1/admin/operations/${encodeURIComponent(activeOperationId)}/events`,
          {
            credentials: 'same-origin',
            signal: controller.signal,
          },
        );

        if (!response.ok || !response.body) {
          throw new Error('Live updates disconnected; retrying persisted status.');
        }

        setLive(true);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let completed = false;

        while (!disposed) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() ?? '';

          for (const block of blocks) {
            const parsed = parseEventBlock(block);
            if (!parsed) {
              continue;
            }

            const eventData = parsed.data;

            if (parsed.event === 'operation_event' && isAdminOperationEvent(eventData)) {
              setLatestEvent(eventData);
              setOperation((current) =>
                current
                  ? {
                      ...current,
                      state: eventData.state,
                    }
                  : current,
              );
            }

            if (parsed.event === 'complete' && isAdminOperationCompleteEvent(eventData)) {
              completed = true;
              await handleTerminalEvent(eventData);
              return;
            }
          }
        }

        setLive(false);

        if (!completed && !disposed) {
          void poll(0);
        }
      } catch (streamError: unknown) {
        if (controller.signal.aborted || disposed) {
          return;
        }
        setLive(false);
        setError(
          streamError instanceof Error
            ? streamError.message
            : 'Live updates disconnected; retrying persisted status.',
        );
        void poll(0);
      }
    }

    void connect();

    return () => {
      disposed = true;
      controller.abort();
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [api, initialOperation, operationId]);

  return {
    operation,
    latestEvent,
    live,
    polling,
    error,
  };
}
