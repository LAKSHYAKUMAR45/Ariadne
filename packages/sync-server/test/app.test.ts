import type { Pool } from 'pg';
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
