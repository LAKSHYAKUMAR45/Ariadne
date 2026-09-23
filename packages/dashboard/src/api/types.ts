export type Guard<T> = (value: unknown) => value is T;

export interface AdminApiClient {
  get<T>(path: string, guard: Guard<T>, signal?: AbortSignal): Promise<T>;
  mutate<T>(
    method: 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body: Record<string, unknown>,
    guard: Guard<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  download(path: string, signal?: AbortSignal): Promise<Blob>;
}

export interface ConfirmationRequest {
  title: string;
  impact: string;
  expectedConfirmation: string;
  confirmationLabel: string;
  requiresReauthentication: boolean;
}

export interface AdminSession {
  userId: string;
  username: string;
  csrfToken: string;
  reauthenticatedUntil: string | null;
  expiresAt?: string;
}

export interface ReauthenticationResponse {
  reauthenticatedUntil: string;
}

export interface DatabaseHealth {
  status: 'healthy' | 'unavailable';
  healthy: boolean;
  latencyMs: number | null;
}

export interface HostMetrics {
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  filesystemUsedBytes: number;
  filesystemTotalBytes: number;
}

export interface MemberSummary {
  total: number;
  active: number;
  inactive: number;
  admins: number;
  members: number;
}

export interface BackupSummary {
  latestAt: string | null;
  latestVerifiedAt: string | null;
  status: string;
}

export interface OperationSummary {
  running: number;
  failedLast24h: number;
}

export interface OverviewComponents {
  database: {
    healthy: boolean;
  };
  operator: {
    healthy: boolean;
    code?: string;
  };
}

export interface OverviewResponse {
  generatedAt: string;
  database: DatabaseHealth;
  host: HostMetrics | null;
  databaseSizeBytes: number;
  tasks: {
    total: number;
    active: number;
    updatedLast24h: number;
  };
  members: MemberSummary;
  sync: {
    lastPushAt: string | null;
    lastPullAt: string | null;
  };
  backup: BackupSummary;
  operations: OperationSummary;
  components: OverviewComponents;
}

export interface TeamMember {
  userId: string;
  username: string;
  role: 'admin' | 'member';
  active: boolean;
  createdAt: string;
  immutable: boolean;
}

export interface MembersResponse {
  members: TeamMember[];
}

export interface MemberMutationResponse {
  member: TeamMember;
}

export interface TaskSummary {
  taskId: string;
  localId: string;
  title: string;
  goal: string | null;
  status: string;
  branch: string | null;
  workspaceLabel: string | null;
  owner: string;
  captureCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CapturedFileMetadata {
  path: string;
  contentSha256: string;
  byteLength: number;
}

export type AdminTimelineKind =
  | 'task'
  | 'commit'
  | 'checkpoint'
  | 'capture'
  | 'command'
  | 'decision'
  | 'todo'
  | 'error'
  | 'question';

export interface TimelineEvent {
  kind: AdminTimelineKind;
  id: string;
  occurredAt: string;
  summary: string;
  metadata: Record<string, unknown> & {
    files?: CapturedFileMetadata[];
  };
}

export interface TasksResponse {
  tasks: TaskSummary[];
  hasMore: boolean;
  nextOffset: number | null;
}

export interface TimelineResponse {
  taskId: string;
  events: TimelineEvent[];
}

export interface CapturedFile {
  path: string;
  content: string;
  unifiedDiff: string;
  contentSha256: string;
  byteLength: number;
}

export type BackupRecordStatus =
  | 'created'
  | 'verified'
  | 'verify_failed'
  | 'restored'
  | 'restore_failed';

export interface BackupRecord {
  filename: string;
  sha256: string;
  sizeBytes: number;
  status: BackupRecordStatus;
  createdAt: string;
  verifiedAt: string | null;
  restoreVerificationMessage: string | null;
}

export interface BackupsResponse {
  backups: BackupRecord[];
}

export interface ServiceStatus {
  name: string;
  state: string;
  detail: string;
}

export interface ServicesResponse {
  services: ServiceStatus[];
}

export interface DeploymentCandidate {
  revision: string;
  committedAt: string;
  subject: string;
}

export interface DeploymentsResponse {
  currentRevision: string;
  rollbackRevision: string;
  schemaVersion: number;
  candidates: DeploymentCandidate[];
}

export type LogSeverity = 'error' | 'warning' | 'info';

export interface LogEntry {
  sequence: number;
  timestamp: string;
  severity: LogSeverity;
  message: string;
  redacted: boolean;
}

export interface LogsResponse {
  entries: LogEntry[];
  nextCursor: string | null;
}

export type AdminOperationType =
  | 'service_restart'
  | 'deployment_apply'
  | 'deployment_rollback'
  | 'file_capture_delete'
  | 'backup_create'
  | 'backup_verify'
  | 'backup_restore';

export type AdminOperationState = 'queued' | 'running' | 'succeeded' | 'failed';

export interface AdminOperation {
  id: string;
  requestedBy: string;
  type: AdminOperationType;
  state: AdminOperationState;
  summary: string;
  output: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface OperationListResponse {
  operations: AdminOperation[];
}

export interface OperationResponse {
  operation: AdminOperation;
}

export interface AcceptedOperationResponse {
  accepted: true;
  operation: AdminOperation;
}

export interface AdminOperationEvent {
  id: number;
  operationId: string;
  state: AdminOperationState;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AdminOperationCompleteEvent {
  operationId: string;
  state: Extract<AdminOperationState, 'succeeded' | 'failed'>;
}

export interface AuditEvent {
  id: number;
  actorUserId: string | null;
  action: string;
  source: string;
  outcome: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AuditResponse {
  events: AuditEvent[];
  nextCursor: string | null;
}
