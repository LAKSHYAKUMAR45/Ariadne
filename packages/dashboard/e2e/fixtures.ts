import { test as base, expect, type Page, type Route } from '@playwright/test';
import type {
  AdminOperation,
  AdminOperationEvent,
  AdminOperationType,
  AdminSession,
  AuditEvent,
  BackupRecord,
  CapturedFile,
  CapturedFileMetadata,
  DeploymentsResponse,
  LogEntry,
  LogSeverity,
  ServiceStatus,
  TaskSummary,
  TeamMember,
  TimelineEvent,
} from '../src/api/types';

const PASSWORD = 'dashboard-password-123456';
const ADMIN_USER_ID = 'admin-id';
const ADMIN_USERNAME = 'ops-admin';
const BASE_TIME = Date.parse('2026-09-23T16:00:00.000Z');
const TASK_ID = 'task-ops-1';
const VERIFIED_BACKUP = 'ariadne-20260923T094609Z.dump';
const DEPLOY_SHA = 'a'.repeat(40);
const ROLLBACK_SHA = 'b'.repeat(40);
const CURRENT_SHA = 'f'.repeat(40);

type LogSource = 'sync-server' | 'operator' | 'deployment' | 'backup';
type OperationStreamMode = 'complete' | 'disconnect-once';
type SectionLabel =
  | 'Overview'
  | 'Members'
  | 'Tasks'
  | 'Backups'
  | 'Services'
  | 'Deployments'
  | 'Logs'
  | 'Audit';

interface CaptureFixture {
  event: TimelineEvent;
  files: Record<string, CapturedFile>;
}

interface TaskFixture {
  summary: TaskSummary;
  events: TimelineEvent[];
  captures: Map<string, CaptureFixture>;
}

interface OperationRuntime {
  operation: AdminOperation;
  terminalState: 'succeeded' | 'failed';
  output: string | null;
  streamMode: OperationStreamMode;
  streamCalls: number;
  events: AdminOperationEvent[];
  onComplete: () => void;
}

interface FixtureState {
  session: AdminSession | null;
  members: TeamMember[];
  task: TaskFixture;
  backups: BackupRecord[];
  deployments: DeploymentsResponse;
  services: ServiceStatus[];
  logs: Record<LogSource, LogEntry[]>;
  audit: AuditEvent[];
  operations: Map<string, OperationRuntime>;
  nextOperationIndex: number;
  nextOperationEventId: number;
  failNextLoginMessage: string | null;
  overviewPartialFailure: boolean;
  unexpectedRequests: string[];
}

interface ConsoleHarness {
  page: Page;
  gotoConsole: () => Promise<void>;
  openAuthenticatedConsole: (options?: { reauthenticated?: boolean }) => Promise<void>;
  login: (options?: { username?: string; password?: string }) => Promise<void>;
  navigate: (section: SectionLabel) => Promise<void>;
  failNextLogin: (message?: string) => void;
  setOverviewPartialFailure: (enabled: boolean) => void;
  expireSession: () => void;
  clearReauthentication: () => void;
}

const SECTION_HEADINGS: Record<SectionLabel, string> = {
  Overview: 'System overview',
  Members: 'Members',
  Tasks: 'Task history',
  Backups: 'Backups',
  Services: 'Services',
  Deployments: 'Deployments',
  Logs: 'Recent logs',
  Audit: 'Audit',
};

function isoAt(offsetMinutes: number): string {
  return new Date(BASE_TIME + offsetMinutes * 60_000).toISOString();
}

function futureReauthentication(): string {
  return new Date(Date.now() + 5 * 60_000).toISOString();
}

function hasFreshReauthentication(session: AdminSession | null): boolean {
  return Boolean(session?.reauthenticatedUntil && Date.parse(session.reauthenticatedUntil) > Date.now());
}

function buildSession(reauthenticated = false): AdminSession {
  return {
    userId: ADMIN_USER_ID,
    username: ADMIN_USERNAME,
    csrfToken: 'csrf-token',
    reauthenticatedUntil: reauthenticated ? futureReauthentication() : null,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
}

function createCapturedFile(
  path: string,
  content: string,
  unifiedDiff: string,
): { metadata: CapturedFileMetadata; file: CapturedFile } {
  return {
    metadata: {
      path,
      contentSha256: `sha-${path.replaceAll(/[^a-z0-9]/gi, '-').toLowerCase()}`,
      byteLength: Buffer.byteLength(content, 'utf8'),
    },
    file: {
      path,
      content,
      unifiedDiff,
      contentSha256: `sha-${path.replaceAll(/[^a-z0-9]/gi, '-').toLowerCase()}`,
      byteLength: Buffer.byteLength(content, 'utf8'),
    },
  };
}

function createTaskFixture(): TaskFixture {
  const captureOne = createCapturedFile(
    'src/console/panel.tsx',
    [
      'export const panel = {',
      '  title: "Operations console",',
      '  payload: "<script>window.__ariadneCaptureExecuted = true</script>",',
      '};',
    ].join('\n'),
    [
      '@@ -1,3 +1,4 @@',
      ' export const panel = {',
      '+  payload: "<script>window.__ariadneCaptureExecuted = true</script>",',
      '   title: "Operations console",',
      ' };',
    ].join('\n'),
  );
  const captureTwo = createCapturedFile(
    'docs/notes.md',
    ['# Deployment note', '', '- Verify rollback target before applying changes.'].join('\n'),
    ['@@ -1,2 +1,3 @@', ' # Deployment note', '+- Verify rollback target before applying changes.'].join('\n'),
  );

  const events: TimelineEvent[] = [
    {
      kind: 'task',
      id: 'task-event-1',
      occurredAt: isoAt(-180),
      summary: 'Task created for nodem2 production rollout',
      metadata: {},
    },
    {
      kind: 'checkpoint',
      id: 'checkpoint-1',
      occurredAt: isoAt(-140),
      summary: 'Checkpointed baseline production health before changes',
      metadata: {},
    },
    {
      kind: 'command',
      id: 'command-1',
      occurredAt: isoAt(-120),
      summary: 'Ran pnpm --filter @ariadne-dev/dashboard test',
      metadata: {},
    },
    {
      kind: 'capture',
      id: 'capture-1',
      occurredAt: isoAt(-90),
      summary: 'Captured src/console/panel.tsx',
      metadata: {
        files: [captureOne.metadata],
      },
    },
    {
      kind: 'decision',
      id: 'decision-1',
      occurredAt: isoAt(-60),
      summary: 'Guard destructive actions behind recent password reauthentication',
      metadata: {},
    },
    {
      kind: 'capture',
      id: 'capture-2',
      occurredAt: isoAt(-20),
      summary: 'Captured docs/notes.md',
      metadata: {
        files: [captureTwo.metadata],
      },
    },
  ];

  return {
    summary: {
      taskId: TASK_ID,
      localId: 'task-ops-1',
      title: 'Finish the nodem2 operations console',
      goal: 'Close the browser finish gate',
      status: 'active',
      branch: 'feat/nodem2-cloud-console',
      workspaceLabel: 'laptop:ariadne',
      owner: ADMIN_USERNAME,
      captureCount: 2,
      createdAt: isoAt(-180),
      updatedAt: isoAt(-20),
    },
    events,
    captures: new Map([
      ['capture-1', { event: events[3], files: { [captureOne.file.path]: captureOne.file } }],
      ['capture-2', { event: events[5], files: { [captureTwo.file.path]: captureTwo.file } }],
    ]),
  };
}

function createLogEntries(source: LogSource, count: number): LogEntry[] {
  return Array.from({ length: count }, (_, index) => {
    const sequence = count - index;
    const severity: LogSeverity =
      sequence % 7 === 0 ? 'error' : sequence % 3 === 0 ? 'warning' : 'info';
    const message =
      source === 'deployment' && sequence === 54
        ? 'deployment warning: rotation pending'
        : `${source} ${severity} record ${String(sequence).padStart(2, '0')}`;

    return {
      sequence,
      timestamp: isoAt(-sequence),
      severity,
      message,
      redacted: source === 'backup' && sequence % 5 === 0,
    };
  });
}

function createAuditEvents(): AuditEvent[] {
  const seeded: AuditEvent[] = [
    {
      id: 60,
      actorUserId: ADMIN_USER_ID,
      action: 'admin_operation.state_changed',
      source: 'operator',
      outcome: 'failed',
      metadata: {
        operationId: 'op-audit-60',
        backupName: VERIFIED_BACKUP,
      },
      createdAt: isoAt(-6),
    },
    {
      id: 59,
      actorUserId: ADMIN_USER_ID,
      action: 'member.state_changed',
      source: 'admin_api',
      outcome: 'succeeded',
      metadata: {
        username: 'ops-member',
      },
      createdAt: isoAt(-10),
    },
    {
      id: 58,
      actorUserId: ADMIN_USER_ID,
      action: 'admin_operation.state_changed',
      source: 'operator',
      outcome: 'failed',
      metadata: {
        operationId: 'op-audit-58',
        revision: DEPLOY_SHA,
      },
      createdAt: isoAt(-12),
    },
  ];

  for (let id = 57; id >= 1; id -= 1) {
    seeded.push({
      id,
      actorUserId: ADMIN_USER_ID,
      action: 'admin_operation.state_changed',
      source: 'operator',
      outcome: 'failed',
      metadata: { operationId: `op-audit-${id}`, service: id % 2 === 0 ? 'sync-server' : 'postgres' },
      createdAt: isoAt(-(20 + id)),
    });
  }

  return seeded;
}

function createFixtureState(): FixtureState {
  return {
    session: null,
    members: [
      {
        userId: ADMIN_USER_ID,
        username: ADMIN_USERNAME,
        role: 'admin',
        active: true,
        createdAt: isoAt(-600),
        immutable: true,
      },
      {
        userId: 'member-1',
        username: 'ops-member',
        role: 'member',
        active: true,
        createdAt: isoAt(-580),
        immutable: false,
      },
    ],
    task: createTaskFixture(),
    backups: [
      {
        filename: VERIFIED_BACKUP,
        sha256: 'a'.repeat(64),
        sizeBytes: 2048,
        status: 'verified',
        createdAt: isoAt(-75),
        verifiedAt: isoAt(-74),
        restoreVerificationMessage: 'Verified and eligible for restore or download.',
      },
    ],
    deployments: {
      currentRevision: CURRENT_SHA,
      rollbackRevision: ROLLBACK_SHA,
      schemaVersion: 11,
      candidates: [
        {
          revision: DEPLOY_SHA,
          committedAt: isoAt(-30),
          subject: 'feat: finish dashboard browser gate',
        },
        {
          revision: 'c'.repeat(40),
          committedAt: isoAt(-90),
          subject: 'fix: stabilize operator reconnect flow',
        },
      ],
    },
    services: [
      {
        name: 'sync-server',
        state: 'running',
        detail: 'HTTP listener healthy.',
      },
      {
        name: 'operator',
        state: 'running',
        detail: 'Unix socket ready.',
      },
      {
        name: 'postgres',
        state: 'running',
        detail: 'Primary database healthy.',
      },
    ],
    logs: {
      'sync-server': createLogEntries('sync-server', 18),
      operator: createLogEntries('operator', 12),
      deployment: createLogEntries('deployment', 58),
      backup: createLogEntries('backup', 9),
    },
    audit: createAuditEvents(),
    operations: new Map(),
    nextOperationIndex: 1,
    nextOperationEventId: 100,
    failNextLoginMessage: null,
    overviewPartialFailure: false,
    unexpectedRequests: [],
  };
}

function ensureSeedOperations(state: FixtureState): void {
  if (state.operations.has('op-audit-60')) {
    return;
  }

  state.operations.set('op-audit-60', {
    operation: {
      id: 'op-audit-60',
      requestedBy: ADMIN_USER_ID,
      type: 'backup_restore',
      state: 'failed',
      summary: `Restore backup ${VERIFIED_BACKUP}`,
      output: 'Restore failed after checksum verification.',
      startedAt: isoAt(-8),
      completedAt: isoAt(-6),
      createdAt: isoAt(-9),
    },
    terminalState: 'failed',
    output: 'Restore failed after checksum verification.',
    streamMode: 'complete',
    streamCalls: 0,
    events: [
      {
        id: 90,
        operationId: 'op-audit-60',
        state: 'failed',
        message: 'Restore blocked by checksum verification.',
        metadata: {},
        createdAt: isoAt(-6),
      },
    ],
    onComplete: () => undefined,
  });

  state.operations.set('op-audit-58', {
    operation: {
      id: 'op-audit-58',
      requestedBy: ADMIN_USER_ID,
      type: 'deployment_apply',
      state: 'failed',
      summary: `Deploy revision ${DEPLOY_SHA.slice(0, 12)}`,
      output: 'Deployment halted after health-check timeout.',
      startedAt: isoAt(-15),
      completedAt: isoAt(-12),
      createdAt: isoAt(-16),
    },
    terminalState: 'failed',
    output: 'Deployment halted after health-check timeout.',
    streamMode: 'complete',
    streamCalls: 0,
    events: [
      {
        id: 91,
        operationId: 'op-audit-58',
        state: 'failed',
        message: 'Deployment health checks timed out.',
        metadata: {},
        createdAt: isoAt(-12),
      },
    ],
    onComplete: () => undefined,
  });
}

function taskSummary(state: FixtureState): TaskSummary {
  return {
    ...state.task.summary,
    captureCount: state.task.events.filter((event) => event.kind === 'capture').length,
  };
}

function latestBackup(state: FixtureState): BackupRecord | null {
  return state.backups[0] ?? null;
}

function activeOperationCount(state: FixtureState): number {
  return [...state.operations.values()].filter(
    (runtime) => runtime.operation.state === 'queued' || runtime.operation.state === 'running',
  ).length;
}

function failedOperationCount(state: FixtureState): number {
  return [...state.operations.values()].filter((runtime) => runtime.operation.state === 'failed').length;
}

function buildOverview(state: FixtureState): unknown {
  const newestBackup = latestBackup(state);

  return {
    generatedAt: isoAt(0),
    database: {
      status: 'healthy',
      healthy: true,
      latencyMs: 4,
    },
    host: state.overviewPartialFailure
      ? null
      : {
          cpuPercent: 21.3,
          memoryUsedBytes: 5 * 1024 ** 3,
          memoryTotalBytes: 8 * 1024 ** 3,
          filesystemUsedBytes: 42 * 1024 ** 3,
          filesystemTotalBytes: 80 * 1024 ** 3,
        },
    databaseSizeBytes: 894_566_400,
    tasks: {
      total: 1,
      active: 1,
      updatedLast24h: 1,
    },
    members: {
      total: state.members.length,
      active: state.members.filter((member) => member.active).length,
      inactive: state.members.filter((member) => !member.active).length,
      admins: state.members.filter((member) => member.role === 'admin').length,
      members: state.members.filter((member) => member.role === 'member').length,
    },
    sync: {
      lastPushAt: isoAt(-35),
      lastPullAt: isoAt(-28),
    },
    backup: {
      latestAt: newestBackup?.createdAt ?? null,
      latestVerifiedAt: newestBackup?.verifiedAt ?? null,
      status: newestBackup?.status ?? 'unavailable',
    },
    operations: {
      running: activeOperationCount(state),
      failedLast24h: failedOperationCount(state),
    },
    components: {
      database: {
        healthy: true,
      },
      operator: state.overviewPartialFailure
        ? {
            healthy: false,
            code: 'operator_unavailable',
          }
        : {
            healthy: true,
          },
    },
  };
}

function jsonBody(status: number, body: unknown): Parameters<Route['fulfill']>[0] {
  return {
    status,
    contentType: 'application/json',
    headers: {
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill(jsonBody(status, body));
}

async function fulfillError(
  route: Route,
  status: number,
  code: string,
  message: string,
): Promise<void> {
  await fulfillJson(route, status, {
    error: {
      code,
      message,
    },
  });
}

function requestBody(route: Route): Record<string, unknown> {
  const raw = route.request().postData();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

async function assertSession(route: Route, state: FixtureState): Promise<boolean> {
  if (state.session) {
    return true;
  }
  await fulfillError(route, 401, 'missing_session', 'Authentication required.');
  return false;
}

async function assertCsrf(route: Route, state: FixtureState): Promise<boolean> {
  if (!state.session) {
    await fulfillError(route, 401, 'missing_session', 'Authentication required.');
    return false;
  }
  const presentedToken = await route.request().headerValue('x-csrf-token');
  if (presentedToken !== state.session.csrfToken) {
    await fulfillError(route, 403, 'csrf_failed', 'A valid CSRF token is required');
    return false;
  }
  return true;
}

async function assertFreshReauthentication(route: Route, state: FixtureState): Promise<boolean> {
  if (!(await assertSession(route, state))) {
    return false;
  }
  if (!hasFreshReauthentication(state.session)) {
    await fulfillError(
      route,
      403,
      'reauthentication_required',
      'Reauthentication is required for this operation.',
    );
    return false;
  }
  return true;
}

function confirmationMatches(expected: string, actual: unknown): boolean {
  return typeof actual === 'string' && actual === expected;
}

function nextOperationId(state: FixtureState): string {
  const id = `op-${String(state.nextOperationIndex).padStart(3, '0')}`;
  state.nextOperationIndex += 1;
  return id;
}

function nextEventId(state: FixtureState): number {
  const id = state.nextOperationEventId;
  state.nextOperationEventId += 1;
  return id;
}

function queueOperation(
  state: FixtureState,
  input: {
    type: AdminOperationType;
    summary: string;
    output: string | null;
    runningMessage: string;
    completedMessage: string;
    terminalState?: 'succeeded' | 'failed';
    streamMode?: OperationStreamMode;
    onComplete: () => void;
  },
): AdminOperation {
  const id = nextOperationId(state);
  const operation: AdminOperation = {
    id,
    requestedBy: ADMIN_USER_ID,
    type: input.type,
    state: 'queued',
    summary: input.summary,
    output: null,
    startedAt: null,
    completedAt: null,
    createdAt: isoAt(state.nextOperationIndex),
  };

  state.operations.set(id, {
    operation,
    terminalState: input.terminalState ?? 'succeeded',
    output: input.output,
    streamMode: input.streamMode ?? 'complete',
    streamCalls: 0,
    events: [
      {
        id: nextEventId(state),
        operationId: id,
        state: 'running',
        message: input.runningMessage,
        metadata: {},
        createdAt: isoAt(state.nextOperationIndex),
      },
      {
        id: nextEventId(state),
        operationId: id,
        state: input.terminalState ?? 'succeeded',
        message: input.completedMessage,
        metadata: {},
        createdAt: isoAt(state.nextOperationIndex + 1),
      },
    ],
    onComplete: input.onComplete,
  });

  return operation;
}

function markOperationRunning(runtime: OperationRuntime): void {
  if (runtime.operation.state !== 'queued') {
    return;
  }

  runtime.operation.state = 'running';
  runtime.operation.startedAt = runtime.events[0]?.createdAt ?? isoAt(1);
}

function completeOperation(runtime: OperationRuntime): void {
  if (runtime.operation.state === runtime.terminalState) {
    return;
  }

  runtime.operation.state = runtime.terminalState;
  runtime.operation.startedAt ??= runtime.events[0]?.createdAt ?? isoAt(1);
  runtime.operation.completedAt = runtime.events.at(-1)?.createdAt ?? isoAt(2);
  runtime.operation.output = runtime.output;
  runtime.onComplete();
}

function serializeSse(runtime: OperationRuntime, includeCompletion: boolean): string {
  const blocks: string[] = [];
  const runningEvent = runtime.events.find((event) => event.state === 'running');

  if (runningEvent) {
    blocks.push(`event: operation_event\ndata: ${JSON.stringify(runningEvent)}\n\n`);
  }

  if (includeCompletion) {
    const terminalEvent = runtime.events.at(-1);
    if (terminalEvent) {
      blocks.push(`event: operation_event\ndata: ${JSON.stringify(terminalEvent)}\n\n`);
    }
    blocks.push(
      `event: complete\ndata: ${JSON.stringify({
        operationId: runtime.operation.id,
        state: runtime.terminalState,
      })}\n\n`,
    );
  }

  return blocks.join('');
}

function filteredLogs(
  state: FixtureState,
  source: LogSource,
  severity: LogSeverity | '',
  cursor: string | null,
): { entries: LogEntry[]; nextCursor: string | null } {
  const pool = state.logs[source].filter((entry) => (severity ? entry.severity === severity : true));
  const startAt = cursor ? pool.findIndex((entry) => String(entry.sequence) === cursor) + 1 : 0;
  const slice = pool.slice(Math.max(startAt, 0), Math.max(startAt, 0) + 50);
  const next = pool.length > startAt + slice.length ? String(slice.at(-1)?.sequence ?? '') : null;
  return {
    entries: slice,
    nextCursor: next && next.length > 0 ? next : null,
  };
}

function filteredAudit(
  state: FixtureState,
  action: string,
  outcome: string,
  cursor: string | null,
): { events: AuditEvent[]; nextCursor: string | null } {
  const pool = state.audit.filter((event) => {
    if (action && event.action !== action) {
      return false;
    }
    if (outcome && event.outcome !== outcome) {
      return false;
    }
    return true;
  });

  const startAt = cursor ? pool.findIndex((event) => String(event.id) === cursor) + 1 : 0;
  const slice = pool.slice(Math.max(startAt, 0), Math.max(startAt, 0) + 50);
  const next = pool.length > startAt + slice.length ? String(slice.at(-1)?.id ?? '') : null;
  return {
    events: slice,
    nextCursor: next && next.length > 0 ? next : null,
  };
}

function listOperations(state: FixtureState): AdminOperation[] {
  return [...state.operations.values()]
    .map((runtime) => runtime.operation)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function operationById(state: FixtureState, operationId: string): OperationRuntime | undefined {
  ensureSeedOperations(state);
  return state.operations.get(operationId);
}

async function handleAdminRequest(route: Route, state: FixtureState): Promise<void> {
  ensureSeedOperations(state);

  const request = route.request();
  const url = new URL(request.url());
  const pathname = url.pathname;
  const method = request.method();

  if (pathname === '/api/v1/admin/session' && method === 'GET') {
    if (!state.session) {
      await fulfillError(route, 401, 'missing_session', 'Authentication required.');
      return;
    }
    await fulfillJson(route, 200, state.session);
    return;
  }

  if (pathname === '/api/v1/admin/session' && method === 'POST') {
    const body = requestBody(route);
    if (state.failNextLoginMessage) {
      const message = state.failNextLoginMessage;
      state.failNextLoginMessage = null;
      await fulfillError(route, 401, 'invalid_credentials', message);
      return;
    }

    if (body.username !== ADMIN_USERNAME || body.password !== PASSWORD) {
      await fulfillError(route, 401, 'invalid_credentials', 'Incorrect username or password.');
      return;
    }

    state.session = buildSession(false);
    await fulfillJson(route, 201, state.session);
    return;
  }

  if (pathname === '/api/v1/admin/session' && method === 'DELETE') {
    if (!(await assertCsrf(route, state))) {
      return;
    }
    state.session = null;
    await route.fulfill({
      status: 204,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
    return;
  }

  if (pathname === '/api/v1/admin/session/reauthenticate' && method === 'POST') {
    if (!(await assertSession(route, state)) || !(await assertCsrf(route, state))) {
      return;
    }

    const body = requestBody(route);
    if (body.password !== PASSWORD) {
      await fulfillError(route, 401, 'invalid_credentials', 'The password was not accepted.');
      return;
    }

    if (!state.session) {
      await fulfillError(route, 401, 'missing_session', 'Authentication required.');
      return;
    }

    state.session = {
      ...state.session,
      reauthenticatedUntil: futureReauthentication(),
    };
    await fulfillJson(route, 200, {
      reauthenticatedUntil: state.session.reauthenticatedUntil,
    });
    return;
  }

  if (!(await assertSession(route, state))) {
    return;
  }

  if (pathname === '/api/v1/admin/overview' && method === 'GET') {
    await fulfillJson(route, 200, buildOverview(state));
    return;
  }

  if (pathname === '/api/v1/admin/members' && method === 'GET') {
    await fulfillJson(route, 200, {
      members: state.members,
    });
    return;
  }

  const memberMatch = pathname.match(/^\/api\/v1\/admin\/members\/([^/]+)$/);
  if (memberMatch && method === 'PATCH') {
    if (!(await assertCsrf(route, state)) || !(await assertFreshReauthentication(route, state))) {
      return;
    }

    const memberId = decodeURIComponent(memberMatch[1]);
    const member = state.members.find((entry) => entry.userId === memberId);

    if (!member || member.immutable) {
      await fulfillError(route, 409, 'admin_immutable', 'The requested member cannot be changed.');
      return;
    }

    const body = requestBody(route);
    const nextActive = Boolean(body.active);
    const expectedConfirmation = `${nextActive ? 'ACTIVATE' : 'DEACTIVATE'} ${member.username}`;
    if (!confirmationMatches(expectedConfirmation, body.confirmation)) {
      await fulfillError(route, 400, 'confirmation_mismatch', 'The confirmation phrase did not match.');
      return;
    }

    member.active = nextActive;
    await fulfillJson(route, 200, { member });
    return;
  }

  if (pathname === '/api/v1/admin/tasks' && method === 'GET') {
    await fulfillJson(route, 200, {
      tasks: [taskSummary(state)],
      hasMore: false,
      nextOffset: null,
    });
    return;
  }

  const timelineMatch = pathname.match(/^\/api\/v1\/admin\/tasks\/([^/]+)\/timeline$/);
  if (timelineMatch && method === 'GET') {
    await fulfillJson(route, 200, {
      taskId: decodeURIComponent(timelineMatch[1]),
      events: state.task.events,
    });
    return;
  }

  const fileMatch = pathname.match(
    /^\/api\/v1\/admin\/tasks\/([^/]+)\/file-captures\/([^/]+)\/files\/(.+)$/,
  );
  if (fileMatch && method === 'GET') {
    const captureId = decodeURIComponent(fileMatch[2]);
    const filePath = decodeURIComponent(fileMatch[3]);
    const capture = state.task.captures.get(captureId);
    const file = capture?.files[filePath];

    if (!file) {
      await fulfillError(route, 404, 'capture_file_not_found', 'The requested captured file was not found.');
      return;
    }

    await fulfillJson(route, 200, file);
    return;
  }

  const captureDeleteMatch = pathname.match(/^\/api\/v1\/admin\/tasks\/([^/]+)\/file-captures\/([^/]+)$/);
  if (captureDeleteMatch && method === 'DELETE') {
    if (!(await assertCsrf(route, state)) || !(await assertFreshReauthentication(route, state))) {
      return;
    }

    const captureId = decodeURIComponent(captureDeleteMatch[2]);
    const body = requestBody(route);
    const expectedConfirmation = `DELETE ${captureId}`;
    if (!confirmationMatches(expectedConfirmation, body.confirmation)) {
      await fulfillError(route, 400, 'confirmation_mismatch', 'The confirmation phrase did not match.');
      return;
    }

    const operation = queueOperation(state, {
      type: 'file_capture_delete',
      summary: `Delete capture ${captureId}`,
      output: 'Capture deleted successfully.',
      runningMessage: 'Deleting captured files from encrypted task history.',
      completedMessage: 'File capture deleted.',
      onComplete: () => {
        state.task.captures.delete(captureId);
        state.task.events = state.task.events.filter((event) => event.id !== captureId);
        state.task.summary = taskSummary(state);
      },
    });

    await fulfillJson(route, 202, { accepted: true, operation });
    return;
  }

  if (pathname === '/api/v1/admin/backups' && method === 'GET') {
    await fulfillJson(route, 200, { backups: state.backups });
    return;
  }

  if (pathname === '/api/v1/admin/backups' && method === 'POST') {
    state.unexpectedRequests.push(`${method} ${pathname}`);
  }

  const downloadMatch = pathname.match(/^\/api\/v1\/admin\/backups\/([^/]+)\/download$/);
  if (downloadMatch && method === 'GET') {
    const filename = decodeURIComponent(downloadMatch[1]);
    const backup = state.backups.find((entry) => entry.filename === filename);
    if (!backup || backup.status !== 'verified') {
      await fulfillError(route, 409, 'backup_not_verified', 'Only verified backups can be downloaded.');
      return;
    }

    await route.fulfill({
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${backup.filename}"`,
      },
      body: `backup-bytes:${backup.filename}`,
    });
    return;
  }

  if (pathname === '/api/v1/admin/services' && method === 'GET') {
    await fulfillJson(route, 200, { services: state.services });
    return;
  }

  if (pathname === '/api/v1/admin/deployments' && method === 'GET') {
    await fulfillJson(route, 200, state.deployments);
    return;
  }

  if (pathname === '/api/v1/admin/operations' && method === 'GET') {
    await fulfillJson(route, 200, {
      operations: listOperations(state),
    });
    return;
  }

  if (pathname === '/api/v1/admin/operations/backups' && method === 'POST') {
    if (!(await assertCsrf(route, state))) {
      return;
    }

    const filename = `ariadne-20260923T1015${String(state.nextOperationIndex).padStart(2, '0')}Z.dump`;
    const operation = queueOperation(state, {
      type: 'backup_create',
      summary: 'Create verified database backup',
      output: 'Backup finished.',
      runningMessage: 'Creating database backup.',
      completedMessage: 'Backup created.',
      onComplete: () => {
        state.backups = [
          {
            filename,
            sha256: String(state.nextOperationIndex).repeat(64).slice(0, 64),
            sizeBytes: 3072,
            status: 'created',
            createdAt: isoAt(state.nextOperationIndex + 2),
            verifiedAt: null,
            restoreVerificationMessage: 'Verification required before restore or download.',
          },
          ...state.backups,
        ];
      },
    });

    await fulfillJson(route, 202, { accepted: true, operation });
    return;
  }

  const verifyBackupMatch = pathname.match(/^\/api\/v1\/admin\/operations\/backups\/([^/]+)\/verify$/);
  if (verifyBackupMatch && method === 'POST') {
    if (!(await assertCsrf(route, state))) {
      return;
    }

    const filename = decodeURIComponent(verifyBackupMatch[1]);
    const operation = queueOperation(state, {
      type: 'backup_verify',
      summary: `Verify backup ${filename}`,
      output: 'Backup verified successfully.',
      runningMessage: 'Running isolated restore verification.',
      completedMessage: 'Backup verification completed.',
      onComplete: () => {
        state.backups = state.backups.map((backup) =>
          backup.filename === filename
            ? {
                ...backup,
                status: 'verified',
                verifiedAt: isoAt(state.nextOperationIndex + 3),
                restoreVerificationMessage: 'Verified and eligible for restore or download.',
              }
            : backup,
        );
      },
    });

    await fulfillJson(route, 202, { accepted: true, operation });
    return;
  }

  const restoreBackupMatch = pathname.match(/^\/api\/v1\/admin\/operations\/backups\/([^/]+)\/restore$/);
  if (restoreBackupMatch && method === 'POST') {
    if (!(await assertCsrf(route, state)) || !(await assertFreshReauthentication(route, state))) {
      return;
    }

    const filename = decodeURIComponent(restoreBackupMatch[1]);
    const body = requestBody(route);
    const expectedConfirmation = `RESTORE ${filename}`;
    if (!confirmationMatches(expectedConfirmation, body.confirmation)) {
      await fulfillError(route, 400, 'confirmation_mismatch', 'The confirmation phrase did not match.');
      return;
    }

    const operation = queueOperation(state, {
      type: 'backup_restore',
      summary: `Restore backup ${filename}`,
      output: 'Restore completed after safety backup verification.',
      runningMessage: 'Restoring backup after verifying a fresh safety backup.',
      completedMessage: 'Backup restore completed.',
      onComplete: () => {
        state.backups = state.backups.map((backup) =>
          backup.filename === filename
            ? {
                ...backup,
                status: 'restored',
                restoreVerificationMessage: 'Restored after verifying a fresh safety backup.',
              }
            : backup,
        );
      },
    });

    await fulfillJson(route, 202, { accepted: true, operation });
    return;
  }

  if (pathname === '/api/v1/admin/operations/service-restart' && method === 'POST') {
    if (!(await assertCsrf(route, state)) || !(await assertFreshReauthentication(route, state))) {
      return;
    }

    const body = requestBody(route);
    const service = body.service;
    if (service !== 'sync-server' && service !== 'postgres') {
      await fulfillError(route, 400, 'invalid_request', 'Only approved services can be restarted.');
      return;
    }

    const expectedConfirmation = `RESTART ${service}`;
    if (!confirmationMatches(expectedConfirmation, body.confirmation)) {
      await fulfillError(route, 400, 'confirmation_mismatch', 'The confirmation phrase did not match.');
      return;
    }

    const operation = queueOperation(state, {
      type: 'service_restart',
      summary: `Restart ${service}`,
      output: `${service} restarted and healthy.`,
      runningMessage: `Restarting ${service} and waiting for health checks.`,
      completedMessage: `${service} restart completed.`,
      streamMode: 'disconnect-once',
      onComplete: () => {
        state.services = state.services.map((entry) =>
          entry.name === service
            ? {
                ...entry,
                detail:
                  service === 'sync-server'
                    ? 'HTTP listener healthy after restart.'
                    : 'Primary database healthy after restart.',
              }
            : entry,
        );
      },
    });

    await fulfillJson(route, 202, { accepted: true, operation });
    return;
  }

  if (pathname === '/api/v1/admin/operations/deploy' && method === 'POST') {
    if (!(await assertCsrf(route, state)) || !(await assertFreshReauthentication(route, state))) {
      return;
    }

    const body = requestBody(route);
    const revision = body.revision;
    if (typeof revision !== 'string') {
      await fulfillError(route, 400, 'invalid_request', 'A candidate revision is required.');
      return;
    }
    const expectedConfirmation = `DEPLOY ${revision}`;
    if (!confirmationMatches(expectedConfirmation, body.confirmation)) {
      await fulfillError(route, 400, 'confirmation_mismatch', 'The confirmation phrase did not match.');
      return;
    }

    const previousRevision = state.deployments.currentRevision;
    const operation = queueOperation(state, {
      type: 'deployment_apply',
      summary: `Deploy revision ${revision.slice(0, 12)}`,
      output: 'Deployment completed successfully.',
      runningMessage: 'Applying migrations and waiting for health checks.',
      completedMessage: 'Deployment completed.',
      onComplete: () => {
        state.deployments = {
          ...state.deployments,
          currentRevision: revision,
          rollbackRevision: previousRevision,
        };
      },
    });

    await fulfillJson(route, 202, { accepted: true, operation });
    return;
  }

  if (pathname === '/api/v1/admin/operations/rollback' && method === 'POST') {
    if (!(await assertCsrf(route, state)) || !(await assertFreshReauthentication(route, state))) {
      return;
    }

    const body = requestBody(route);
    const revision = body.revision;
    if (typeof revision !== 'string') {
      await fulfillError(route, 400, 'invalid_request', 'A rollback revision is required.');
      return;
    }
    const expectedConfirmation = `ROLLBACK ${revision}`;
    if (!confirmationMatches(expectedConfirmation, body.confirmation)) {
      await fulfillError(route, 400, 'confirmation_mismatch', 'The confirmation phrase did not match.');
      return;
    }

    const previousRevision = state.deployments.currentRevision;
    const operation = queueOperation(state, {
      type: 'deployment_rollback',
      summary: `Rollback revision ${revision.slice(0, 12)}`,
      output: 'Rollback completed successfully.',
      runningMessage: 'Rolling back to the previously recorded revision.',
      completedMessage: 'Rollback completed.',
      onComplete: () => {
        state.deployments = {
          ...state.deployments,
          currentRevision: revision,
          rollbackRevision: previousRevision,
        };
      },
    });

    await fulfillJson(route, 202, { accepted: true, operation });
    return;
  }

  if (pathname === '/api/v1/admin/logs' && method === 'GET') {
    const source = url.searchParams.get('source') as LogSource | null;
    const severity = (url.searchParams.get('severity') ?? '') as LogSeverity | '';
    if (!source || !(source in state.logs)) {
      await fulfillError(route, 400, 'invalid_request', 'A fixed log source is required.');
      return;
    }

    await fulfillJson(route, 200, filteredLogs(state, source, severity, url.searchParams.get('cursor')));
    return;
  }

  if (pathname === '/api/v1/admin/audit' && method === 'GET') {
    await fulfillJson(
      route,
      200,
      filteredAudit(
        state,
        url.searchParams.get('action') ?? '',
        url.searchParams.get('outcome') ?? '',
        url.searchParams.get('cursor'),
      ),
    );
    return;
  }

  const operationEventsMatch = pathname.match(/^\/api\/v1\/admin\/operations\/([^/]+)\/events$/);
  if (operationEventsMatch && method === 'GET') {
    const runtime = operationById(state, decodeURIComponent(operationEventsMatch[1]));
    if (!runtime) {
      await fulfillError(route, 404, 'operation_not_found', 'The requested operation was not found.');
      return;
    }

    runtime.streamCalls += 1;
    markOperationRunning(runtime);

    const includeCompletion =
      runtime.operation.state === runtime.terminalState ||
      runtime.streamMode === 'complete' ||
      runtime.streamCalls > 1;

    if (includeCompletion) {
      completeOperation(runtime);
    }

    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream; charset=utf-8',
      headers: {
        'Cache-Control': 'no-store',
      },
      body: serializeSse(runtime, includeCompletion),
    });
    return;
  }

  const operationMatch = pathname.match(/^\/api\/v1\/admin\/operations\/([^/]+)$/);
  if (operationMatch && method === 'GET') {
    const runtime = operationById(state, decodeURIComponent(operationMatch[1]));
    if (!runtime) {
      await fulfillError(route, 404, 'operation_not_found', 'The requested operation was not found.');
      return;
    }

    await fulfillJson(route, 200, {
      operation: runtime.operation,
    });
    return;
  }

  state.unexpectedRequests.push(`${method} ${pathname}${url.search}`);
  await fulfillError(
    route,
    500,
    'unhandled_test_request',
    `Unhandled test request: ${method} ${pathname}${url.search}`,
  );
}

async function createHarness(
  page: Page,
  state: FixtureState,
): Promise<{ harness: ConsoleHarness; pageErrors: string[]; consoleErrors: string[] }> {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      !message.text().includes('status of 401') &&
      !message.text().includes('status of 403')
    ) {
      consoleErrors.push(message.text());
    }
  });

  await page.route('**/api/v1/admin/**', async (route) => {
    await handleAdminRequest(route, state);
  });

  const harness: ConsoleHarness = {
    page,
    async gotoConsole(): Promise<void> {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Command your Ariadne cloud' })).toBeVisible();
    },
    async openAuthenticatedConsole({ reauthenticated = false } = {}): Promise<void> {
      state.session = buildSession(reauthenticated);
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'System overview' })).toBeVisible();
    },
    async login(options = {}): Promise<void> {
      const username = options.username ?? ADMIN_USERNAME;
      const password = options.password ?? PASSWORD;

      await expect(page.getByLabel('Username')).toBeVisible();
      await page.getByLabel('Username').fill(username);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: 'Open console' }).click();
      await expect(page.getByRole('heading', { name: 'System overview' })).toBeVisible();
    },
    async navigate(section: SectionLabel): Promise<void> {
      await page.getByRole('button', { name: section }).click();
      await expect(page.getByRole('heading', { name: SECTION_HEADINGS[section] })).toBeVisible();
    },
    failNextLogin(message = 'Incorrect username or password.'): void {
      state.failNextLoginMessage = message;
    },
    setOverviewPartialFailure(enabled: boolean): void {
      state.overviewPartialFailure = enabled;
    },
    expireSession(): void {
      state.session = null;
    },
    clearReauthentication(): void {
      if (state.session) {
        state.session = {
          ...state.session,
          reauthenticatedUntil: null,
        };
      }
    },
  };

  return {
    harness,
    pageErrors,
    consoleErrors,
  };
}

export const test = base.extend<{ harness: ConsoleHarness }>({
  harness: async ({ page }, use) => {
    const state = createFixtureState();
    const { harness, pageErrors, consoleErrors } = await createHarness(page, state);
    await use(harness);
    expect(state.unexpectedRequests, 'Unexpected API requests').toEqual([]);
    expect(pageErrors, 'Unexpected page errors').toEqual([]);
    expect(consoleErrors, 'Unexpected console errors').toEqual([]);
  },
});

export { expect };
