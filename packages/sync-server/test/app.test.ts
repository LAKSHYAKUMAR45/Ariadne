import path from 'node:path';
import { tmpdir } from 'node:os';
import type { Pool } from 'pg';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { SyncServerConfigError } from '../src/config.js';
import { TEST_JWT_SECRET } from './testConfig.js';
import { createTestEncryptionKeyring } from './testKeyring.js';

function createFakePool(): Pool {
  return { query: vi.fn(), connect: vi.fn() } as unknown as Pool;
}

describe('createApp encryption wiring', () => {
  it('refuses to build an app without an encryption keyring', () => {
    expect(() =>
      createApp(createFakePool(), TEST_JWT_SECRET, {
        encryptionKeyring: undefined as unknown as ReturnType<typeof createTestEncryptionKeyring>,
      }),
    ).toThrowError(SyncServerConfigError);
  });

  it('refuses to build an app with an incomplete encryption keyring', () => {
    expect(() =>
      createApp(createFakePool(), TEST_JWT_SECRET, {
        encryptionKeyring: { activeKeyId: 'key-1' } as ReturnType<
          typeof createTestEncryptionKeyring
        >,
      }),
    ).toThrowError(SyncServerConfigError);
  });

  it('exposes the injected keyring to request handlers', () => {
    const keyring = createTestEncryptionKeyring();
    const app = createApp(createFakePool(), TEST_JWT_SECRET, { encryptionKeyring: keyring });

    expect(app.locals.encryptionKeyring).toBe(keyring);
  });
});

describe('createApp request body limits', () => {
  // Points at a path that cannot exist, so the callback router mounts but every
  // request fails closed at credential resolution. That is exactly what makes
  // this a body-limit test: reaching `callback_unavailable` proves the payload
  // was parsed rather than rejected as too large.
  const missingTokenPath = path.join(tmpdir(), 'ariadne-app-test-absent-callback-token');

  function buildApp() {
    return createApp(createFakePool(), TEST_JWT_SECRET, {
      encryptionKeyring: createTestEncryptionKeyring(),
      operatorCallbackTokenPath: missingTokenPath,
    });
  }

  it('parses an operator callback larger than the 100 KB global limit', async () => {
    const output = 'deploy log line\n'.repeat(16 * 1024);
    expect(Buffer.byteLength(output, 'utf8')).toBeGreaterThan(100 * 1024);

    const res = await request(buildApp())
      .post('/api/v1/admin/operations/op-large/callback')
      .set('x-ariadne-operator-token', 'a'.repeat(64))
      .send({ operationId: 'op-large', state: 'succeeded', output });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('callback_unavailable');
  });

  it('parses an operator callback whose escaped output fills the reporter ceiling', async () => {
    // Serializes to just under the reporter's 1 MiB ceiling; the route's own
    // limit carries headroom above it so a legally fitted body is never lost.
    const output = '"\u0001'.repeat(130 * 1000);
    const serializedBytes = Buffer.byteLength(
      JSON.stringify({ operationId: 'op-escaped', state: 'succeeded', output }),
      'utf8',
    );
    expect(serializedBytes).toBeGreaterThan(900 * 1024);
    expect(serializedBytes).toBeLessThanOrEqual(1024 * 1024);

    const res = await request(buildApp())
      .post('/api/v1/admin/operations/op-escaped/callback')
      .set('x-ariadne-operator-token', 'a'.repeat(64))
      .send({ operationId: 'op-escaped', state: 'succeeded', output });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('callback_unavailable');
  });

  it('rejects an operator callback beyond the route-scoped limit', async () => {
    const res = await request(buildApp())
      .post('/api/v1/admin/operations/op-huge/callback')
      .set('x-ariadne-operator-token', 'a'.repeat(64))
      .send({ operationId: 'op-huge', state: 'succeeded', output: 'z'.repeat(3 * 1024 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('callback_payload_too_large');
  });

  it('keeps every other route on the 100 KB global limit', async () => {
    const res = await request(buildApp())
      .post('/api/v1/auth/login')
      .send({ username: 'alice', password: 'x'.repeat(200 * 1024) });

    expect(res.status).toBe(413);
  });
});
