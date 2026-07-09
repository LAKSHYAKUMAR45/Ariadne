import { describe, it, expect } from 'vitest';
import { redact, redactCommand, DEFAULT_REDACTION_RULES, MAX_REDACTED_LENGTH } from '../src/Redactor.js';

describe('Redactor', () => {
  it('redacts AWS access key ids', () => {
    expect(redact('aws configure set aws_access_key_id AKIAABCDEFGHIJKLMNOP')).toContain('***');
    expect(redact('AKIAABCDEFGHIJKLMNOP')).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('redacts GitHub personal access tokens', () => {
    const out = redact('curl -H "Authorization: token ghp_1234567890abcdefghij1234567890ABCD"');
    expect(out).not.toContain('ghp_1234567890abcdefghij1234567890ABCD');
  });

  it('redacts OpenAI-style API keys', () => {
    const out = redact('export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx1234567890');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwx1234567890');
  });

  it('redacts PEM private key blocks', () => {
    const out = redact('-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAKCAQ==\n-----END RSA PRIVATE KEY-----');
    expect(out).toContain('REDACTED PRIVATE KEY');
    expect(out).not.toContain('MIIBogIBAAKCAQ==');
  });

  it('redacts --password style CLI flags', () => {
    const out = redact('mysql --user=root --password=hunter2');
    expect(out).toContain('--password=***');
    expect(out).not.toContain('hunter2');
  });

  it('redacts env-style TOKEN=value assignments', () => {
    const out = redact('TOKEN=abc123 npm publish');
    expect(out).toContain('***');
    expect(out).not.toContain('abc123');
  });

  it('redacts quoted secret values', () => {
    const out = redact('curl -d \'{"api_key": "sk-live-abcdef"}\'');
    expect(out).not.toContain('sk-live-abcdef');
  });

  it('leaves ordinary commands untouched', () => {
    expect(redact('git commit -m "fix bug"')).toBe('git commit -m "fix bug"');
    expect(redact('npm run build')).toBe('npm run build');
  });

  it('truncates to MAX_REDACTED_LENGTH', () => {
    const long = 'echo ' + 'a'.repeat(1000);
    expect(redact(long).length).toBe(MAX_REDACTED_LENGTH);
  });

  it('redactCommand is an alias for redact with default rules', () => {
    expect(redactCommand('--token=secret123')).toBe(redact('--token=secret123', DEFAULT_REDACTION_RULES));
  });
});
