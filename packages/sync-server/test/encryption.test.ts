import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EncryptionDecryptError,
  EncryptionKeyringConfigError,
  EncryptionOperationError,
  loadEncryptionKeyring,
} from '../src/encryption.js';

interface KeyFileFixture {
  keyId: string;
  contents: Buffer | string;
  mode?: number;
}

interface KeyDirectoryFixture {
  activeKeyId?: string;
  activeKeyMode?: number;
  directoryMode?: number;
  keys?: KeyFileFixture[];
}

const createdDirectories: string[] = [];

function createKeyDirectory(fixture: KeyDirectoryFixture = {}): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-sync-keys-'));
  createdDirectories.push(directory);

  fs.chmodSync(directory, fixture.directoryMode ?? 0o700);

  if (fixture.activeKeyId !== undefined) {
    fs.writeFileSync(path.join(directory, 'active-key-id'), fixture.activeKeyId, {
      mode: fixture.activeKeyMode ?? 0o600,
    });
    fs.chmodSync(path.join(directory, 'active-key-id'), fixture.activeKeyMode ?? 0o600);
  }

  for (const key of fixture.keys ?? []) {
    const keyPath = path.join(directory, `${key.keyId}.key`);
    fs.writeFileSync(keyPath, key.contents, { mode: key.mode ?? 0o600 });
    fs.chmodSync(keyPath, key.mode ?? 0o600);
  }

  return directory;
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('sync-server encryption keyring', () => {
  it('round-trips AES-256-GCM payloads with a 12-byte nonce and 16-byte auth tag', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-20260921',
      keys: [{ keyId: 'key-20260921', contents: Buffer.alloc(32, 0x11) }],
    });

    const keyring = loadEncryptionKeyring(directory);
    const plaintext = Buffer.from('sensitive snapshot payload');
    const aad = Buffer.from('team=singleton|type=snapshot|key=key-20260921');

    const encrypted = keyring.encrypt(plaintext, aad);

    expect(encrypted.keyId).toBe('key-20260921');
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.authTag).toHaveLength(16);
    expect(encrypted.ciphertext.equals(plaintext)).toBe(false);
    expect(keyring.decrypt(encrypted, aad)).toEqual(plaintext);
  });

  it('uses randomized nonces for identical plaintext and AAD', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-20260921',
      keys: [{ keyId: 'key-20260921', contents: Buffer.alloc(32, 0x22) }],
    });

    const keyring = loadEncryptionKeyring(directory);
    const plaintext = Buffer.from('identical payload');
    const aad = Buffer.from('team=singleton|type=diff|key=key-20260921');

    const first = keyring.encrypt(plaintext, aad);
    const second = keyring.encrypt(plaintext, aad);

    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it('rejects missing AAD instead of silently authenticating empty metadata', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-20260921',
      keys: [{ keyId: 'key-20260921', contents: Buffer.alloc(32, 0x33) }],
    });

    const keyring = loadEncryptionKeyring(directory);

    expect(() => keyring.encrypt(Buffer.from('payload'), Buffer.alloc(0))).toThrowError(
      EncryptionOperationError,
    );
  });

  it('fails decryption when AAD is tampered with', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-20260921',
      keys: [{ keyId: 'key-20260921', contents: Buffer.alloc(32, 0x44) }],
    });

    const keyring = loadEncryptionKeyring(directory);
    const encrypted = keyring.encrypt(
      Buffer.from('payload'),
      Buffer.from('team=singleton|type=snapshot'),
    );

    expect(() =>
      keyring.decrypt(encrypted, Buffer.from('team=singleton|type=diff')),
    ).toThrowError(EncryptionDecryptError);
  });

  it('fails decryption when ciphertext is tampered with', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-20260921',
      keys: [{ keyId: 'key-20260921', contents: Buffer.alloc(32, 0x55) }],
    });

    const keyring = loadEncryptionKeyring(directory);
    const encrypted = keyring.encrypt(
      Buffer.from('payload'),
      Buffer.from('team=singleton|type=snapshot'),
    );
    const tampered = {
      ...encrypted,
      ciphertext: Buffer.from(encrypted.ciphertext),
    };
    tampered.ciphertext[0] ^= 0xff;

    expect(() => keyring.decrypt(tampered, Buffer.from('team=singleton|type=snapshot'))).toThrowError(
      EncryptionDecryptError,
    );
  });

  it('fails decryption when the authentication tag is tampered with', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-20260921',
      keys: [{ keyId: 'key-20260921', contents: Buffer.alloc(32, 0x66) }],
    });

    const keyring = loadEncryptionKeyring(directory);
    const encrypted = keyring.encrypt(
      Buffer.from('payload'),
      Buffer.from('team=singleton|type=snapshot'),
    );
    const tampered = {
      ...encrypted,
      authTag: Buffer.from(encrypted.authTag),
    };
    tampered.authTag[0] ^= 0xff;

    expect(() => keyring.decrypt(tampered, Buffer.from('team=singleton|type=snapshot'))).toThrowError(
      EncryptionDecryptError,
    );
  });

  it('rejects a missing active-key-id file', () => {
    const directory = createKeyDirectory({
      keys: [{ keyId: 'key-20260921', contents: Buffer.alloc(32, 0x77) }],
    });

    expect(() => loadEncryptionKeyring(directory)).toThrowError(EncryptionKeyringConfigError);
  });

  it('rejects malformed key files without echoing the key material', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-20260921',
      keys: [{ keyId: 'key-20260921', contents: 'ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD' }],
    });

    const loadKeyring = () => loadEncryptionKeyring(directory);

    expect(loadKeyring).toThrowError(EncryptionKeyringConfigError);
    expect(loadKeyring).toThrowError(
      /must contain exactly 32 raw bytes or 64 lowercase hex characters/,
    );

    try {
      loadKeyring();
    } catch (error) {
      expect((error as Error).message).not.toContain('ABCDEF');
    }
  });

  it('rejects decrypting blobs that reference an unknown key ID', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-20260921',
      keys: [{ keyId: 'key-20260921', contents: Buffer.alloc(32, 0x88) }],
    });

    const keyring = loadEncryptionKeyring(directory);
    const encrypted = keyring.encrypt(
      Buffer.from('payload'),
      Buffer.from('team=singleton|type=snapshot'),
    );

    expect(() =>
      keyring.decrypt({ ...encrypted, keyId: 'missing-key' }, Buffer.from('team=singleton|type=snapshot')),
    ).toThrowError(EncryptionDecryptError);
  });

  it('rejects insecure key directory permissions', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-20260921',
      directoryMode: 0o750,
      keys: [{ keyId: 'key-20260921', contents: Buffer.alloc(32, 0x99) }],
    });

    expect(() => loadEncryptionKeyring(directory)).toThrowError(EncryptionKeyringConfigError);
  });

  it('rejects insecure key file permissions', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-20260921',
      keys: [{ keyId: 'key-20260921', contents: Buffer.alloc(32, 0xaa), mode: 0o640 }],
    });

    expect(() => loadEncryptionKeyring(directory)).toThrowError(EncryptionKeyringConfigError);
  });

  it('rejects insecure active-key-id permissions', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-20260921',
      activeKeyMode: 0o640,
      keys: [{ keyId: 'key-20260921', contents: Buffer.alloc(32, 0xab) }],
    });

    expect(() => loadEncryptionKeyring(directory)).toThrowError(EncryptionKeyringConfigError);
  });

  it('keeps old keys readable after the active key rotates', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-1',
      keys: [
        { keyId: 'key-1', contents: Buffer.alloc(32, 0xbb) },
        { keyId: 'key-2', contents: Buffer.alloc(32, 0xcc) },
      ],
    });
    const aad = Buffer.from('team=singleton|type=snapshot');

    const oldKeyring = loadEncryptionKeyring(directory);
    const encryptedWithOldKey = oldKeyring.encrypt(Buffer.from('historical payload'), aad);

    fs.writeFileSync(path.join(directory, 'active-key-id'), 'key-2', { mode: 0o600 });
    fs.chmodSync(path.join(directory, 'active-key-id'), 0o600);

    const rotatedKeyring = loadEncryptionKeyring(directory);
    const encryptedWithNewKey = rotatedKeyring.encrypt(Buffer.from('fresh payload'), aad);

    expect(rotatedKeyring.activeKeyId).toBe('key-2');
    expect(rotatedKeyring.decrypt(encryptedWithOldKey, aad).toString('utf8')).toBe(
      'historical payload',
    );
    expect(rotatedKeyring.decrypt(encryptedWithNewKey, aad).toString('utf8')).toBe('fresh payload');
  });
});
