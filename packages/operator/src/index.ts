import { createOperatorServer, getOperatorSocketPath } from './server.js';

export { createOperatorExecutor, DEFAULT_OUTPUT_TAIL_BYTES } from './executor.js';
export type {
  OperatorEventSink,
  OperatorExecutor,
  OperatorProgressEvent,
  OperatorResultEvent,
} from './executor.js';
export { parseOperatorRequest, type OperatorAccepted, type OperatorRequest } from './protocol.js';
export {
  MAX_OPERATOR_REQUEST_BODY_BYTES,
  createOperatorServer,
  getOperatorSocketPath,
  withRestrictiveUmask,
} from './server.js';
export type { OperatorExecuteFn, OperatorServer } from './server.js';

if (require.main === module) {
  const socketPath = getOperatorSocketPath();
  const server = createOperatorServer({ socketPath });

  void server.start().catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : 'Unexpected operator startup failure';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
