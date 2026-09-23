import {
  createCallbackReporter,
  createOperatorServer,
  ensureCallbackToken,
  getCallbackConfig,
  getOperatorSocketPath,
} from './server.js';
import type { OperatorEventSink } from './executor.js';

export {
  createOperatorExecutor,
  takeUtf8Tail,
  BACKUP_RESULT_ENV_VAR,
  DEFAULT_DRAIN_GRACE_MS,
  DEFAULT_OUTPUT_TAIL_BYTES,
  MAX_BACKUP_RESULT_BYTES,
  PROCESS_GROUPS_SUPPORTED,
} from './executor.js';
export type {
  KillImplementation,
  OperatorBackupResult,
  OperatorEventSink,
  OperatorExecutor,
  OperatorProgressEvent,
  OperatorResultEvent,
  OperatorSignal,
  OperatorSpawnOptions,
  OperatorSpawnedProcess,
  SpawnImplementation,
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
  decodeOperatorLogCursor,
  encodeOperatorLogCursor,
  operatorQuerySchema,
  parseOperatorQuery,
} from './queryProtocol.js';
export type {
  BackupReadResult,
  DeploymentStatusResult,
  HostMetricsResult,
  LogsReadResult,
  OperatorLogCursor,
  OperatorLogSeverity,
  OperatorLogSource,
  OperatorQuery,
  OperatorQueryExecutor,
  OperatorQueryResult,
  ServiceStatusResult,
} from './queryProtocol.js';
export {
  createOperatorQueryExecutor,
  DEFAULT_LOG_LINE_BYTES,
  DEFAULT_QUERY_ENV,
  DEFAULT_QUERY_RESPONSE_BYTES,
  DEFAULT_QUERY_TIMEOUT_MS,
  OperatorQueryError,
} from './queryExecutor.js';
export type {
  CreateOperatorQueryExecutorOptions,
  QueryClock,
  QueryFileSystem,
  QuerySpawnImplementation,
  QuerySpawnOptions,
  QuerySpawnedProcess,
} from './queryExecutor.js';
export {
  CALLBACK_TOKEN_BYTES,
  CALLBACK_TOKEN_HEADER,
  DEFAULT_CALLBACK_MAX_ATTEMPTS,
  DEFAULT_CALLBACK_RETRY_BASE_DELAY_MS,
  DEFAULT_CALLBACK_RETRY_MAX_DELAY_MS,
  DEFAULT_CALLBACK_TOKEN_PATH,
  MAX_CALLBACK_REQUEST_BODY_BYTES,
  MAX_OPERATOR_REQUEST_BODY_BYTES,
  createCallbackReporter,
  createOperatorServer,
  ensureCallbackToken,
  fitCallbackPayload,
  getCallbackConfig,
  getOperatorSocketPath,
  withRestrictiveUmask,
} from './server.js';
export type {
  CallbackConfig,
  CreateCallbackReporterOptions,
  OperatorExecuteFn,
  OperatorQueryFn,
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

  const server = createOperatorServer({
    socketPath,
    reporter,
    onError: (error) => {
      process.stderr.write(`${error.message}\n`);
    },
  });
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
