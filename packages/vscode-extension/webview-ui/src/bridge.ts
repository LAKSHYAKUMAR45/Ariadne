import type {
  HostToWebviewMessage,
  WebviewRequest,
  WebviewRequestType,
  WebviewState,
} from '@host/messages';

export interface VsCodeApi {
  postMessage(message: WebviewRequest): void;
  getState(): unknown;
  setState(state: unknown): void;
}

export interface AriadneBridge {
  request<T>(type: WebviewRequestType, payload?: unknown): Promise<T>;
  subscribe(listener: (state: WebviewState) => void): () => void;
}

function isState(value: unknown): value is WebviewState {
  return typeof value === 'object' && value !== null && 'tasks' in value && 'counts' in value;
}

function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createVsCodeBridge(vscodeApi: VsCodeApi): AriadneBridge {
  const listeners = new Set<(state: WebviewState) => void>();
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    }
  >();

  let currentState: WebviewState | undefined;
  const stored = vscodeApi.getState();
  if (isState(stored)) {
    currentState = stored;
  } else if (stored && typeof stored === 'object' && 'state' in stored && isState((stored as { state?: unknown }).state)) {
    currentState = (stored as { state: WebviewState }).state;
  }

  if (currentState) {
    vscodeApi.setState(currentState);
  }

  const handleMessage = (event: MessageEvent<HostToWebviewMessage>) => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;

    if ('type' in message && message.type === 'stateUpdate') {
      currentState = message.state;
      vscodeApi.setState(message.state);
      for (const listener of listeners) listener(message.state);
      return;
    }

    if ('id' in message) {
      const pendingRequest = pending.get(message.id);
      if (!pendingRequest) return;
      pending.delete(message.id);

      if (message.ok) {
        if (message.state) {
          currentState = message.state;
          vscodeApi.setState(message.state);
          for (const listener of listeners) listener(message.state);
        }
        pendingRequest.resolve(message.data);
      } else {
        pendingRequest.reject(new Error(message.error));
      }
    }
  };

  window.addEventListener('message', handleMessage as EventListener);

  return {
    request<T>(type: WebviewRequestType, payload?: unknown): Promise<T> {
      const id = createRequestId();
      const request: WebviewRequest = { id, type, ...(payload === undefined ? {} : { payload }) };
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          vscodeApi.postMessage(request);
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    },
    subscribe(listener: (state: WebviewState) => void): () => void {
      listeners.add(listener);
      if (currentState) {
        listener(currentState);
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
