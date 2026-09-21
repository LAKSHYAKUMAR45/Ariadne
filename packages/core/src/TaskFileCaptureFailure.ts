export type TaskFileCaptureFailureContext = 'checkpoint' | 'explicit capture';

type TaskErrorRecorder = {
  recordError(input: { taskId: string; message: string }): unknown;
};

const CAPTURE_FAILURE_MESSAGES: Record<TaskFileCaptureFailureContext, string> = {
  checkpoint: 'Task file capture failed after checkpoint.',
  'explicit capture': 'Task file capture failed after explicit capture.',
};

const CAPTURE_FAILURE_RECORDING_MESSAGES: Record<TaskFileCaptureFailureContext, string> = {
  checkpoint: 'Ariadne failed to record the checkpoint capture failure.',
  'explicit capture': 'Ariadne failed to record the explicit capture failure.',
};

const CAPTURE_FAILURE_AGGREGATE_MESSAGES: Record<TaskFileCaptureFailureContext, string> = {
  checkpoint: 'Task file capture failed after checkpoint, and Ariadne also failed to record that capture failure.',
  'explicit capture':
    'Task file capture failed after explicit capture, and Ariadne also failed to record that capture failure.',
};

export class TaskFileCaptureFailureError extends Error {
  readonly code = 'ARIADNE_TASK_FILE_CAPTURE_FAILED';
  readonly context: TaskFileCaptureFailureContext;

  constructor(context: TaskFileCaptureFailureContext) {
    super(CAPTURE_FAILURE_MESSAGES[context]);
    this.name = 'TaskFileCaptureFailureError';
    this.context = context;
  }
}

export class TaskFileCaptureFailureRecordingError extends Error {
  readonly code = 'ARIADNE_TASK_FILE_CAPTURE_RECORDING_FAILED';
  readonly context: TaskFileCaptureFailureContext;

  constructor(context: TaskFileCaptureFailureContext) {
    super(CAPTURE_FAILURE_RECORDING_MESSAGES[context]);
    this.name = 'TaskFileCaptureFailureRecordingError';
    this.context = context;
  }
}

export class TaskFileCaptureFailureAggregateError extends AggregateError {
  readonly code = 'ARIADNE_TASK_FILE_CAPTURE_AND_RECORDING_FAILED';
  readonly context: TaskFileCaptureFailureContext;

  constructor(context: TaskFileCaptureFailureContext) {
    super(
      [new TaskFileCaptureFailureError(context), new TaskFileCaptureFailureRecordingError(context)],
      CAPTURE_FAILURE_AGGREGATE_MESSAGES[context],
    );
    this.name = 'TaskFileCaptureFailureAggregateError';
    this.context = context;
  }
}

export function throwSanitizedTaskFileCaptureFailure(
  store: TaskErrorRecorder,
  taskId: string,
  context: TaskFileCaptureFailureContext,
): never {
  const captureError = new TaskFileCaptureFailureError(context);
  try {
    store.recordError({ taskId, message: captureError.message });
  } catch {
    throw new TaskFileCaptureFailureAggregateError(context);
  }
  throw captureError;
}
