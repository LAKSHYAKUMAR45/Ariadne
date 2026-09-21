import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('sync server configuration', () => {
  const required = {
    DATABASE_URL: 'postgres://ariadne:test@localhost/ariadne',
    SYNC_SERVER_JWT_SECRET: 'test-secret',
  };

  it('binds to loopback by default for tunnel-only deployments', () => {
    expect(loadConfig(required)).toMatchObject({ host: '127.0.0.1', port: 4300 });
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
});
