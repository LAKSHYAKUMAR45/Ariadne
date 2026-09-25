import { describe, expect, it } from 'vitest';
import { buildAppOptions } from '../src/index.js';
import type { SyncServerConfig } from '../src/config.js';
import type { EncryptionKeyring } from '../src/encryption.js';

/**
 * Regression coverage for a real production bug: main() used to build the
 * createApp() options object inline and forgot to include ssoSharedSecret,
 * so every deployed server silently ran with an empty SSO shared secret --
 * every real /internal/sso/codes request failed with invalid_secret even
 * when jcnr-triage sent the exact right value, because the comparison was
 * always against ''. No existing test caught this: every other test in this
 * package calls createApp() directly with ssoSharedSecret already supplied,
 * bypassing main()'s wiring entirely. This test exercises the actual
 * config-to-options mapping main() uses, with no server/DB required.
 */
describe('buildAppOptions', () => {
  const config: SyncServerConfig = {
    databaseUrl: 'postgres://unused',
    encryptionKeyDir: '/unused',
    jwtSecret: 'jwt-secret',
    host: '127.0.0.1',
    port: 4300,
    operatorSocketPath: null,
    operatorCallbackTokenPath: null,
    adminPublicOrigin: 'https://nodem2:14300',
    adminCookieSecure: true,
    dashboardDistDir: '/unused/dashboard',
    ssoSharedSecret: 'the-real-shared-secret',
  };
  const keyring = {} as EncryptionKeyring;

  it('passes every config field the app needs through to createApp options, including ssoSharedSecret', () => {
    const options = buildAppOptions(config, keyring, null, null);

    expect(options.ssoSharedSecret).toBe('the-real-shared-secret');
    expect(options.adminPublicOrigin).toBe('https://nodem2:14300');
    expect(options.adminCookieSecure).toBe(true);
    expect(options.dashboardDistDir).toBe('/unused/dashboard');
    expect(options.operatorCallbackTokenPath).toBeNull();
    expect(options.encryptionKeyring).toBe(keyring);
    expect(options.operatorClient).toBeNull();
    expect(options.operatorQueryClient).toBeNull();
  });
});
