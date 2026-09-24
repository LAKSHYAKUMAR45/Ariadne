import React from 'react';
import { createRoot } from 'react-dom/client';
import './webview.css';
import App from './App';
import { createVsCodeBridge } from './bridge';
import type { WebviewState } from '@host/messages';

declare global {
  interface Window {
    acquireVsCodeApi?: () => {
      postMessage(message: unknown): void;
      getState(): unknown;
      setState(state: unknown): void;
    };
  }
}

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Ariadne webview root element not found.');
}

const vscodeApi = window.acquireVsCodeApi?.();

if (!vscodeApi) {
  throw new Error('VS Code webview API is unavailable.');
}

const bridge = createVsCodeBridge(vscodeApi);
const initialState = vscodeApi.getState();
const parsedState = isWebviewState(initialState) ? initialState : undefined;

createRoot(rootElement).render(
  <React.StrictMode>
    <App bridge={bridge} initialState={parsedState} />
  </React.StrictMode>,
);

function isWebviewState(value: unknown): value is WebviewState {
  return typeof value === 'object' && value !== null && 'tasks' in value && 'counts' in value;
}
