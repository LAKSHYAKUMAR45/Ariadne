import { describe, expect, it } from 'vitest';
import { parseOperatorQuery, type OperatorQuery } from '../src/queryProtocol.js';

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('parseOperatorQuery', () => {
  it('accepts the exact strict discriminated union', () => {
    const queries: OperatorQuery[] = [
      { type: 'host_metrics' },
      { type: 'service_status' },
      { type: 'deployment_status' },
      { type: 'backup_read', backupName: 'ariadne-20260923T032200Z.dump' },
      {
        type: 'logs_read',
        source: 'sync-server',
        cursor: encodeCursor({
          timestamp: '2026-09-23T05:22:54+02:00',
          sequence: 7,
        }),
        limit: 100,
        severity: 'warning',
        since: '2026-09-23T05:00:00+02:00',
      },
    ];

    for (const query of queries) {
      expect(parseOperatorQuery(query)).toEqual(query);
    }
  });

  it('rejects unknown keys and invalid query variants', () => {
    const invalidQueries: unknown[] = [
      {
        type: 'backup_read',
        backupName: '../ariadne-20260923T032200Z.dump',
      },
      {
        type: 'backup_read',
        backupName: '/var/backups/ariadne-20260923T032200Z.dump',
      },
      {
        type: 'logs_read',
        source: 'sync-server',
        limit: 0,
      },
      {
        type: 'logs_read',
        source: 'sync-server',
        limit: 501,
      },
      {
        type: 'logs_read',
        source: 'sync-server',
        limit: 100,
        since: 'yesterday',
      },
      {
        type: 'logs_read',
        source: 'ssh',
        limit: 100,
      },
      {
        type: 'logs_read',
        source: 'sync-server',
        unit: 'ssh.service',
        limit: 100,
      },
      {
        type: 'logs_read',
        source: 'sync-server',
        path: '/var/log/messages',
        limit: 100,
      },
      {
        type: 'logs_read',
        source: 'sync-server',
        journal: '_SYSTEMD_UNIT=ssh.service',
        limit: 100,
      },
      {
        type: 'logs_read',
        source: 'sync-server',
        cursor: 'not-base64url',
        limit: 100,
      },
      {
        type: 'logs_read',
        source: 'sync-server',
        cursor: encodeCursor({
          timestamp: 'not-a-time',
          sequence: 1,
        }),
        limit: 100,
      },
      {
        type: 'logs_read',
        source: 'sync-server',
        cursor: encodeCursor({
          timestamp: '2026-09-23T03:22:54Z',
          sequence: -1,
        }),
        limit: 100,
      },
      {
        type: 'logs_read',
        source: 'sync-server',
        cursor: encodeCursor({
          timestamp: '2026-09-23T03:22:54Z',
          sequence: 1,
          extra: true,
        }),
        limit: 100,
      },
      {
        type: 'deployment_status',
        ignored: true,
      },
      {
        type: 'shell_exec',
      },
    ];

    for (const query of invalidQueries) {
      expect(() => parseOperatorQuery(query)).toThrowError();
    }
  });

  it('rejects caller-selected journal units', () => {
    expect(() =>
      parseOperatorQuery({
        type: 'logs_read',
        source: 'sync-server',
        unit: 'ssh.service',
        limit: 100,
      }),
    ).toThrowError();
  });
});
