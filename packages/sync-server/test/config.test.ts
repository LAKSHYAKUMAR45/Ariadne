import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('sync server configuration', () => {
  const required = {
    DATABASE_URL: 'postgresql://localhost/ariadne',
    ENCRYPTION_KEY_DIR: '/etc/ariadne/keys',
    SYNC_SERVER_JWT_SECRET: 'test-secret',
  };

  it('binds to loopback by default for tunnel-only deployments', () => {
    expect(loadConfig(required)).toMatchObject({
      encryptionKeyDir: '/etc/ariadne/keys',
      host: '127.0.0.1',
      port: 4300,
    });
  });

  it('allows an explicit bind host for reverse-proxy or direct deployments', () => {
    expect(loadConfig({ ...required, HOST: '0.0.0.0', PORT: '4400' })).toMatchObject({
      host: '0.0.0.0',
      port: 4400,
    });
  });

  it('rejects an invalid port instead of silently using a partial value', () => {
    expect(() => loadConfig({ ...required, PORT: '4300junk' })).toThrow('PORT must be an integer');
  });

  it('requires ENCRYPTION_KEY_DIR so the server never falls back to plaintext or ephemeral keys', () => {
    const { ENCRYPTION_KEY_DIR: _ignored, ...withoutEncryptionKeyDir } = required;

    expect(() => loadConfig(withoutEncryptionKeyDir)).toThrow(
      'ENCRYPTION_KEY_DIR environment variable is required',
    );
  });

  it('requires ENCRYPTION_KEY_DIR to be absolute so key loading never depends on the working directory', () => {
    expect(() => loadConfig({ ...required, ENCRYPTION_KEY_DIR: 'relative/keys' })).toThrow(
      'ENCRYPTION_KEY_DIR must be an absolute path',
    );
  });

  describe('admin dashboard origin', () => {
    it('requires ADMIN_PUBLIC_ORIGIN in production so the CSRF origin check can never be skipped', () => {
      expect(() => loadConfig({ ...required, NODE_ENV: 'production' })).toThrow(
        'ADMIN_PUBLIC_ORIGIN environment variable is required in production',
      );
    });

    it('leaves the origin unset outside production, where no browser origin is trusted', () => {
      expect(loadConfig(required)).toMatchObject({
        adminPublicOrigin: null,
        adminCookieSecure: false,
      });
    });

    it('marks the session cookie Secure for an HTTPS dashboard origin', () => {
      expect(
        loadConfig({
          ...required,
          NODE_ENV: 'production',
          ADMIN_PUBLIC_ORIGIN: 'https://ariadne.example.com',
        }),
      ).toMatchObject({
        adminPublicOrigin: 'https://ariadne.example.com',
        adminCookieSecure: true,
      });
    });

    it('allows plain HTTP only for the approved tunnelled loopback origin', () => {
      expect(
        loadConfig({
          ...required,
          NODE_ENV: 'production',
          ADMIN_PUBLIC_ORIGIN: 'http://127.0.0.1:4300',
        }),
      ).toMatchObject({
        adminPublicOrigin: 'http://127.0.0.1:4300',
        adminCookieSecure: false,
      });
    });

    it('refuses plain HTTP for any non-loopback origin, which would expose the session cookie', () => {
      expect(() =>
        loadConfig({ ...required, ADMIN_PUBLIC_ORIGIN: 'http://ariadne.example.com' }),
      ).toThrow('may only use http for a loopback host');
    });

    it('refuses an origin that is not a bare origin', () => {
      expect(() =>
        loadConfig({ ...required, ADMIN_PUBLIC_ORIGIN: 'https://ariadne.example.com/dashboard' }),
      ).toThrow('must be an origin only');
      expect(() => loadConfig({ ...required, ADMIN_PUBLIC_ORIGIN: 'ariadne.example.com' })).toThrow(
        'must be an absolute origin',
      );
      expect(() =>
        loadConfig({ ...required, ADMIN_PUBLIC_ORIGIN: 'https://user:pw@ariadne.example.com' }),
      ).toThrow('must not contain credentials');
    });
  });
});
