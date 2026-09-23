import { useEffect, useRef, useState } from 'react';
import { AdminApiError } from '../api/client';
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

const INITIAL_POLL_INTERVAL_MS = 1_000;
const MAX_POLL_INTERVAL_MS = 15_000;

interface UseOperationOptions {
  api: AdminApiClient;
  operationId: string | null;
  initialOperation?: AdminOperation | null;
}

interface UseOperationResult {
  operation: AdminOperation | null;
  events: AdminOperationEvent[];
  latestEvent: AdminOperationEvent | null;
  live: boolean;
  polling: boolean;
  error: string | null;
}

function isTerminal(operation: AdminOperation | null): boolean {
  return operation?.state === 'succeeded' || operation?.state === 'failed';
}

function invalidResponseError(): AdminApiError {
  return new AdminApiError(200, 'invalid_response', 'The server returned an invalid response.');
}

function isSessionFailure(error: unknown): boolean {
  return (
    error instanceof AdminApiError &&
    (error.status === 401 ||
      error.code === 'missing_session' ||
      error.code === 'reauthentication_required')
  );
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
    throw invalidResponseError();
  }
}

export function useOperation({
  api,
  operationId,
  initialOperation = null,
}: UseOperationOptions): UseOperationResult {
  const initialOperationRef = useRef(initialOperation);
  initialOperationRef.current = initialOperation;
  const [operation, setOperation] = useState<AdminOperation | null>(initialOperation);
  const [events, setEvents] = useState<AdminOperationEvent[]>([]);
  const [latestEvent, setLatestEvent] = useState<AdminOperationEvent | null>(null);
  const [live, setLive] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const seededOperation = initialOperationRef.current;

    if (!operationId) {
      setOperation(seededOperation);
      setEvents([]);
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
    const seenEventIds = new Set<number>();

    setOperation(seededOperation);
    setEvents([]);
    setLatestEvent(null);
    setLive(false);
    setPolling(false);
    setError(null);

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

    function recordEvent(operationEvent: AdminOperationEvent): void {
      if (seenEventIds.has(operationEvent.id)) {
        return;
      }
      seenEventIds.add(operationEvent.id);
      setEvents((current) => [...current, operationEvent]);
      setLatestEvent(operationEvent);
      setOperation((current) =>
        current
          ? {
              ...current,
              state: operationEvent.state,
            }
          : current,
      );
    }

    function schedulePoll(delayMs: number): void {
      if (disposed) {
        return;
      }

      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }

      timeoutId = window.setTimeout(() => {
        void poll(delayMs);
      }, delayMs);
    }

    async function poll(delayMs: number): Promise<void> {
      if (disposed) {
        return;
      }

      setPolling(true);

      try {
        const current = await reloadOperation();
        if (!current || isTerminal(current)) {
          setPolling(false);
          return;
        }
      } catch (pollError: unknown) {
        if (!disposed) {
          setError(pollError instanceof Error ? pollError.message : 'Unable to refresh the operation state.');
        }
        if (isSessionFailure(pollError)) {
          setPolling(false);
          return;
        }
        schedulePoll(Math.min(delayMs * 2, MAX_POLL_INTERVAL_MS));
        return;
      }

      if (!disposed) {
        setError(null);
      }

      if (disposed) {
        setPolling(false);
        return;
      }

      schedulePoll(Math.min(delayMs * 2, MAX_POLL_INTERVAL_MS));
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

        async function failInvalidResponse(): Promise<never> {
          await reader.cancel().catch(() => undefined);
          throw invalidResponseError();
        }

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

            const eventData: unknown = parsed.data;

            if (parsed.event === 'operation_event') {
              if (!isAdminOperationEvent(eventData)) {
                await failInvalidResponse();
              }

              const operationEvent = eventData as AdminOperationEvent;
              recordEvent(operationEvent);
              continue;
            }

            if (parsed.event === 'complete') {
              if (!isAdminOperationCompleteEvent(eventData)) {
                await failInvalidResponse();
              }

              const completeEvent = eventData as AdminOperationCompleteEvent;
              completed = true;
              await handleTerminalEvent(completeEvent);
              return;
            }

            await failInvalidResponse();
          }
        }

        setLive(false);

        if (!completed && !disposed) {
          void poll(INITIAL_POLL_INTERVAL_MS);
        }
      } catch (streamError: unknown) {
        if (controller.signal.aborted || disposed) {
          return;
        }
        if (streamError instanceof AdminApiError && streamError.code === 'invalid_response') {
          setLive(false);
          setPolling(false);
          setError(streamError.message);
          controller.abort();
          return;
        }
        setLive(false);
        setError(
          streamError instanceof Error
            ? streamError.message
            : 'Live updates disconnected; retrying persisted status.',
        );
        void poll(INITIAL_POLL_INTERVAL_MS);
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
  }, [api, operationId]);

  return {
    operation,
    events,
    latestEvent,
    live,
    polling,
    error,
  };
}
