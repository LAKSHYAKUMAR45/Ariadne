import {
  createCallbackReporter,
  createOperatorServer,
  ensureCallbackToken,
  getCallbackConfig,
  getOperatorSocketPath,
} from './server.js';
import type { OperatorEventSink } from './executor.js';

export { createOperatorExecutor, DEFAULT_OUTPUT_TAIL_BYTES } from './executor.js';
export type {
  OperatorEventSink,
  OperatorExecutor,
  OperatorProgressEvent,
  OperatorResultEvent,
} from './executor.js';
export {
  OperationAdmissionRegistry,
  createSerialQueue,
  DEFAULT_TERMINAL_CACHE_MAX_ENTRIES,
  DEFAULT_TERMINAL_CACHE_TTL_MS,
} from './admission.js';
export type { AdmissionDecision, SerialQueue } from './admission.js';
export { parseOperatorRequest, type OperatorAccepted, type OperatorRequest } from './protocol.js';
export {
  CALLBACK_TOKEN_BYTES,
  CALLBACK_TOKEN_HEADER,
  DEFAULT_CALLBACK_TOKEN_PATH,
  MAX_OPERATOR_REQUEST_BODY_BYTES,
  createCallbackReporter,
  createOperatorServer,
  ensureCallbackToken,
  getCallbackConfig,
  getOperatorSocketPath,
  withRestrictiveUmask,
} from './server.js';
export type {
  CallbackConfig,
  CreateCallbackReporterOptions,
  OperatorExecuteFn,
  OperatorServer,
} from './server.js';

/**
 * Starts the service: the callback credential is resolved before the socket is
 * published so the web tier never sees an operator that cannot report results.
 * Token bytes stay in memory — only failures are written to the journal.
 */
async function startOperatorService(): Promise<void> {
  const socketPath = getOperatorSocketPath();
  const callbackConfig = getCallbackConfig();

  let reporter: OperatorEventSink | undefined;
  if (callbackConfig) {
    reporter = createCallbackReporter({
      callbackUrl: callbackConfig.callbackUrl,
      token: await ensureCallbackToken(callbackConfig.tokenPath),
      onError: (error) => {
        process.stderr.write(`${error.message}\n`);
      },
    });
  } else {
    process.stderr.write('No OPERATOR_CALLBACK_URL configured; results are not reported\n');
  }

  const server = createOperatorServer({ socketPath, reporter });
  await server.start();
}

if (require.main === module) {
  void startOperatorService().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : 'Unexpected operator startup failure';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
