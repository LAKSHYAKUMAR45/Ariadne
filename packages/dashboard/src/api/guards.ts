import type {
  AcceptedOperationResponse,
  AdminOperation,
  AdminOperationCompleteEvent,
  AdminOperationEvent,
  AdminOperationState,
  AdminSession,
  AuditEvent,
  AuditResponse,
  BackupRecord,
  BackupsResponse,
  CapturedFile,
  CapturedFileMetadata,
  DeploymentCandidate,
  DeploymentsResponse,
  HostMetrics,
  LogEntry,
  LogsResponse,
  MemberMutationResponse,
  MembersResponse,
  OperationListResponse,
  OperationResponse,
  OverviewResponse,
  ReauthenticationResponse,
  ServiceStatus,
  ServicesResponse,
  TaskSummary,
  TasksResponse,
  TeamMember,
  TimelineEvent,
  TimelineResponse,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

function isTimestamp(value: unknown): value is string {
  return isString(value) && !Number.isNaN(Date.parse(value));
}

function isArrayOf<T>(value: unknown, guard: (entry: unknown) => entry is T): value is T[] {
  return Array.isArray(value) && value.every((entry) => guard(entry));
}

function isOperationState(value: unknown): value is AdminOperationState {
  return value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed';
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

export function isAdminSession(value: unknown): value is AdminSession {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isNonEmptyString(value.userId) &&
    isNonEmptyString(value.username) &&
    (value.role === 'admin' || value.role === 'member' || value.role === null) &&
    isNonEmptyString(value.csrfToken) &&
    isNullableString(value.reauthenticatedUntil) &&
    (value.expiresAt === undefined || isTimestamp(value.expiresAt))
  );
}

export function isReauthenticationResponse(value: unknown): value is ReauthenticationResponse {
  return isRecord(value) && isTimestamp(value.reauthenticatedUntil);
}

function isHostMetrics(value: unknown): value is HostMetrics {
  return (
    isRecord(value) &&
    isFiniteNumber(value.cpuPercent) &&
    isInteger(value.memoryUsedBytes) &&
    isInteger(value.memoryTotalBytes) &&
    isInteger(value.filesystemUsedBytes) &&
    isInteger(value.filesystemTotalBytes)
  );
}

export function isOverviewResponse(value: unknown): value is OverviewResponse {
  if (!isRecord(value) || !isRecord(value.database) || !isRecord(value.tasks) || !isRecord(value.members) || !isRecord(value.sync) || !isRecord(value.backup) || !isRecord(value.operations) || !isRecord(value.components) || !isRecord(value.components.database) || !isRecord(value.components.operator)) {
    return false;
  }

  return (
    isTimestamp(value.generatedAt) &&
    (value.database.status === 'healthy' || value.database.status === 'unavailable') &&
    isBoolean(value.database.healthy) &&
    (value.database.latencyMs === null || isFiniteNumber(value.database.latencyMs)) &&
    (value.host === null || isHostMetrics(value.host)) &&
    isInteger(value.databaseSizeBytes) &&
    isInteger(value.tasks.total) &&
    isInteger(value.tasks.active) &&
    isInteger(value.tasks.updatedLast24h) &&
    isInteger(value.members.total) &&
    isInteger(value.members.active) &&
    isInteger(value.members.inactive) &&
    isInteger(value.members.admins) &&
    isInteger(value.members.members) &&
    isNullableString(value.sync.lastPushAt) &&
    isNullableString(value.sync.lastPullAt) &&
    isNullableString(value.backup.latestAt) &&
    isNullableString(value.backup.latestVerifiedAt) &&
    isString(value.backup.status) &&
    isInteger(value.operations.running) &&
    isInteger(value.operations.failedLast24h) &&
    isBoolean(value.components.database.healthy) &&
    isBoolean(value.components.operator.healthy) &&
    (value.components.operator.code === undefined || isString(value.components.operator.code))
  );
}

function isTeamMember(value: unknown): value is TeamMember {
  return (
    isRecord(value) &&
    isNonEmptyString(value.userId) &&
    isNonEmptyString(value.username) &&
    (value.role === 'admin' || value.role === 'member') &&
    isBoolean(value.active) &&
    isTimestamp(value.createdAt) &&
    isBoolean(value.immutable)
  );
}

export function isMembersResponse(value: unknown): value is MembersResponse {
  return isRecord(value) && isArrayOf(value.members, isTeamMember);
}

export function isMemberMutationResponse(value: unknown): value is MemberMutationResponse {
  return isRecord(value) && isTeamMember(value.member);
}

function isTaskSummary(value: unknown): value is TaskSummary {
  return (
    isRecord(value) &&
    isNonEmptyString(value.taskId) &&
    isNonEmptyString(value.localId) &&
    isNonEmptyString(value.title) &&
    (value.goal === null || isString(value.goal)) &&
    isNonEmptyString(value.status) &&
    isNullableString(value.branch) &&
    isNullableString(value.workspaceLabel) &&
    isNonEmptyString(value.owner) &&
    isInteger(value.captureCount) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt)
  );
}

export function isTasksResponse(value: unknown): value is TasksResponse {
  return (
    isRecord(value) &&
    isArrayOf(value.tasks, isTaskSummary) &&
    isBoolean(value.hasMore) &&
    (value.nextOffset === null || isInteger(value.nextOffset))
  );
}

function isCapturedFileMetadata(value: unknown): value is CapturedFileMetadata {
  return (
    isRecord(value) &&
    isNonEmptyString(value.path) &&
    isNonEmptyString(value.contentSha256) &&
    isInteger(value.byteLength)
  );
}

function isTimelineEvent(value: unknown): value is TimelineEvent {
  if (!isRecord(value) || !isStringRecord(value.metadata)) {
    return false;
  }

  return (
    (value.kind === 'task' ||
      value.kind === 'commit' ||
      value.kind === 'checkpoint' ||
      value.kind === 'capture' ||
      value.kind === 'command' ||
      value.kind === 'decision' ||
      value.kind === 'todo' ||
      value.kind === 'error' ||
      value.kind === 'question') &&
    isNonEmptyString(value.id) &&
    isTimestamp(value.occurredAt) &&
    isString(value.summary) &&
    (value.metadata.files === undefined || isArrayOf(value.metadata.files, isCapturedFileMetadata))
  );
}

export function isTimelineResponse(value: unknown): value is TimelineResponse {
  return isRecord(value) && isNonEmptyString(value.taskId) && isArrayOf(value.events, isTimelineEvent);
}

export function isCapturedFile(value: unknown): value is CapturedFile {
  return (
    isRecord(value) &&
    isNonEmptyString(value.path) &&
    isString(value.content) &&
    isString(value.unifiedDiff) &&
    isNonEmptyString(value.contentSha256) &&
    isInteger(value.byteLength)
  );
}

function isBackupRecord(value: unknown): value is BackupRecord {
  return (
    isRecord(value) &&
    isNonEmptyString(value.filename) &&
    isNonEmptyString(value.sha256) &&
    isInteger(value.sizeBytes) &&
    (value.status === 'created' ||
      value.status === 'verified' ||
      value.status === 'verify_failed' ||
      value.status === 'restored' ||
      value.status === 'restore_failed') &&
    isTimestamp(value.createdAt) &&
    isNullableString(value.verifiedAt) &&
    isNullableString(value.restoreVerificationMessage)
  );
}

export function isBackupsResponse(value: unknown): value is BackupsResponse {
  return isRecord(value) && isArrayOf(value.backups, isBackupRecord);
}

function isServiceStatus(value: unknown): value is ServiceStatus {
  return (
    isRecord(value) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.state) &&
    (value.detail === undefined || isNonEmptyString(value.detail))
  );
}

export function isServicesResponse(value: unknown): value is ServicesResponse {
  return isRecord(value) && isArrayOf(value.services, isServiceStatus);
}

function isDeploymentCandidate(value: unknown): value is DeploymentCandidate {
  return (
    isRecord(value) &&
    isNonEmptyString(value.revision) &&
    isTimestamp(value.committedAt) &&
    isNonEmptyString(value.subject)
  );
}

export function isDeploymentsResponse(value: unknown): value is DeploymentsResponse {
  return (
    isRecord(value) &&
    isNonEmptyString(value.currentRevision) &&
    isNullableString(value.rollbackRevision) &&
    isInteger(value.schemaVersion) &&
    isArrayOf(value.candidates, isDeploymentCandidate)
  );
}

function isLogEntry(value: unknown): value is LogEntry {
  return (
    isRecord(value) &&
    isInteger(value.sequence) &&
    isTimestamp(value.timestamp) &&
    (value.severity === 'error' || value.severity === 'warning' || value.severity === 'info') &&
    isString(value.message) &&
    isBoolean(value.redacted)
  );
}

export function isLogsResponse(value: unknown): value is LogsResponse {
  return (
    isRecord(value) &&
    isArrayOf(value.entries, isLogEntry) &&
    (value.nextCursor === null || isString(value.nextCursor))
  );
}

export function isAdminOperation(value: unknown): value is AdminOperation {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.requestedBy) &&
    (value.type === 'service_restart' ||
      value.type === 'deployment_apply' ||
      value.type === 'deployment_rollback' ||
      value.type === 'file_capture_delete' ||
      value.type === 'backup_create' ||
      value.type === 'backup_verify' ||
      value.type === 'backup_restore') &&
    isOperationState(value.state) &&
    isNonEmptyString(value.summary) &&
    (value.output === null || isString(value.output)) &&
    (value.startedAt === null || isTimestamp(value.startedAt)) &&
    (value.completedAt === null || isTimestamp(value.completedAt)) &&
    isTimestamp(value.createdAt)
  );
}

export function isAcceptedOperationResponse(value: unknown): value is AcceptedOperationResponse {
  return isRecord(value) && value.accepted === true && isAdminOperation(value.operation);
}

export function isOperationResponse(value: unknown): value is OperationResponse {
  return isRecord(value) && isAdminOperation(value.operation);
}

export function isOperationListResponse(value: unknown): value is OperationListResponse {
  return isRecord(value) && isArrayOf(value.operations, isAdminOperation);
}

export function isAdminOperationEvent(value: unknown): value is AdminOperationEvent {
  return (
    isRecord(value) &&
    isInteger(value.id) &&
    isNonEmptyString(value.operationId) &&
    isOperationState(value.state) &&
    isNonEmptyString(value.message) &&
    isStringRecord(value.metadata) &&
    isTimestamp(value.createdAt)
  );
}

export function isAdminOperationCompleteEvent(value: unknown): value is AdminOperationCompleteEvent {
  return (
    isRecord(value) &&
    isNonEmptyString(value.operationId) &&
    (value.state === 'succeeded' || value.state === 'failed')
  );
}

function isAuditEvent(value: unknown): value is AuditEvent {
  return (
    isRecord(value) &&
    isInteger(value.id) &&
    (value.actorUserId === null || isString(value.actorUserId)) &&
    isNonEmptyString(value.action) &&
    isNonEmptyString(value.source) &&
    isNonEmptyString(value.outcome) &&
    isStringRecord(value.metadata) &&
    isTimestamp(value.createdAt)
  );
}

export function isAuditResponse(value: unknown): value is AuditResponse {
  return (
    isRecord(value) &&
    isArrayOf(value.events, isAuditEvent) &&
    (value.nextCursor === null || isString(value.nextCursor))
  );
}
