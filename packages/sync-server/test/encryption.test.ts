import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  /** Modes applied to generated intermediate parent directories, outermost first. */
  parentModes?: number[];
}

const createdDirectories: string[] = [];

function createKeyDirectory(fixture: KeyDirectoryFixture = {}): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-sync-keys-'));
  createdDirectories.push(base);

  const parentModes = fixture.parentModes ?? [];
  let parent = base;
  const generatedParents: string[] = [];
  parentModes.forEach((_mode, index) => {
    parent = path.join(parent, `parent-${index}`);
    fs.mkdirSync(parent);
    generatedParents.push(parent);
  });

  const directory = parentModes.length > 0 ? path.join(parent, 'keys') : base;
  if (directory !== base) {
    fs.mkdirSync(directory);
  }
  fs.chmodSync(directory, fixture.directoryMode ?? 0o700);

  if (fixture.activeKeyId !== undefined) {
    const activeKeyPath = path.join(directory, 'active-key-id');
    fs.writeFileSync(activeKeyPath, fixture.activeKeyId, { mode: fixture.activeKeyMode ?? 0o600 });
    fs.chmodSync(activeKeyPath, fixture.activeKeyMode ?? 0o600);
  }

  for (const key of fixture.keys ?? []) {
    const keyPath = path.join(directory, `${key.keyId}.key`);
    fs.writeFileSync(keyPath, key.contents, { mode: key.mode ?? 0o600 });
    fs.chmodSync(keyPath, key.mode ?? 0o600);
  }

  generatedParents.forEach((generatedParent, index) => {
    fs.chmodSync(generatedParent, parentModes[index]);
  });

  return directory;
}

function restorePermissions(directory: string): void {
  fs.chmodSync(directory, 0o700);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      restorePermissions(path.join(directory, entry.name));
    }
  }
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    restorePermissions(directory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
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

  it('rejects a key directory that is not owned by the effective user', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-20260921',
      keys: [{ keyId: 'key-20260921', contents: Buffer.alloc(32, 0x01) }],
    });
    vi.spyOn(process, 'geteuid').mockReturnValue((process.geteuid?.() ?? 0) + 4242);

    expect(() => loadEncryptionKeyring(directory)).toThrowError(
      /Encryption key directory must be owned by the effective user/,
    );
  });

  it('rejects key files that are not owned by the effective user', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-20260921',
      keys: [{ keyId: 'key-20260921', contents: Buffer.alloc(32, 0x02) }],
    });
    const realFstatSync = fs.fstatSync.bind(fs);
    vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => {
      const stats = realFstatSync(fd);
      if (!stats.isFile()) {
        return stats;
      }
      return Object.create(stats, { uid: { value: stats.uid + 4242 } }) as fs.Stats;
    }) as typeof fs.fstatSync);

    expect(() => loadEncryptionKeyring(directory)).toThrowError(
      /must be owned by the effective user/,
    );
  });

  it('rejects relative key directory paths', () => {
    expect(() => loadEncryptionKeyring('relative/keys')).toThrowError(
      /Encryption key directory must be an absolute path/,
    );
  });

  it('rejects symbolic links anywhere in the key directory path', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-sync-keys-'));
    createdDirectories.push(base);
    const real = path.join(base, 'real');
    fs.mkdirSync(real, { mode: 0o700 });
    fs.writeFileSync(path.join(real, 'active-key-id'), 'key-1', { mode: 0o600 });
    fs.writeFileSync(path.join(real, 'key-1.key'), Buffer.alloc(32, 0x03), { mode: 0o600 });
    const link = path.join(base, 'link');
    fs.symlinkSync(real, link);

    expect(() => loadEncryptionKeyring(path.join(link, '.'))).toThrowError(
      EncryptionKeyringConfigError,
    );
    expect(() => loadEncryptionKeyring(link)).toThrowError(EncryptionKeyringConfigError);
  });

  it('rejects group-writable ancestor directories without the sticky bit', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-20260921',
      parentModes: [0o775],
      keys: [{ keyId: 'key-20260921', contents: Buffer.alloc(32, 0x04) }],
    });

    expect(() => loadEncryptionKeyring(directory)).toThrowError(
      /group- or world-writable without the sticky bit/,
    );
  });

  it('accepts sticky-bit protected shared ancestors such as /tmp', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-20260921',
      parentModes: [0o1777],
      keys: [{ keyId: 'key-20260921', contents: Buffer.alloc(32, 0x05) }],
    });

    expect(loadEncryptionKeyring(directory).activeKeyId).toBe('key-20260921');
  });

  it('rejects a symlinked active-key-id file', () => {
    const directory = createKeyDirectory({
      keys: [{ keyId: 'key-1', contents: Buffer.alloc(32, 0x06) }],
    });
    fs.writeFileSync(path.join(directory, 'pointer'), 'key-1', { mode: 0o600 });
    fs.symlinkSync(path.join(directory, 'pointer'), path.join(directory, 'active-key-id'));

    expect(() => loadEncryptionKeyring(directory)).toThrowError(
      /must not be a symbolic link/,
    );
  });

  it('rejects a symlinked key file', () => {
    const directory = createKeyDirectory({ activeKeyId: 'key-1' });
    const target = path.join(directory, 'material');
    fs.writeFileSync(target, Buffer.alloc(32, 0x07), { mode: 0o600 });
    fs.symlinkSync(target, path.join(directory, 'key-1.key'));

    expect(() => loadEncryptionKeyring(directory)).toThrowError(/must not be a symbolic link/);
  });

  it('accepts owner-read-only 0400 key material', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-1',
      activeKeyMode: 0o400,
      keys: [{ keyId: 'key-1', contents: Buffer.alloc(32, 0x08), mode: 0o400 }],
    });

    const keyring = loadEncryptionKeyring(directory);
    const aad = Buffer.from('team=singleton|type=snapshot');
    const encrypted = keyring.encrypt(Buffer.from('payload'), aad);

    expect(keyring.decrypt(encrypted, aad).toString('utf8')).toBe('payload');
  });

  it('rejects executable key files', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-1',
      keys: [{ keyId: 'key-1', contents: Buffer.alloc(32, 0x09), mode: 0o700 }],
    });

    expect(() => loadEncryptionKeyring(directory)).toThrowError(
      /must be owner-readable only \(0400 or 0600\)/,
    );
  });

  it('rejects oversized key files instead of reading them into memory', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-1',
      keys: [{ keyId: 'key-1', contents: Buffer.alloc(4096, 0x0a) }],
    });

    expect(() => loadEncryptionKeyring(directory)).toThrowError(/is larger than/);
  });

  it('rejects non-regular files that use the .key suffix', () => {
    const directory = createKeyDirectory({ activeKeyId: 'key-1' });
    fs.mkdirSync(path.join(directory, 'key-1.key'), { mode: 0o700 });

    expect(() => loadEncryptionKeyring(directory)).toThrowError(/is not a regular file/);
  });

  it('rejects non-Buffer plaintext and AAD inputs', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-1',
      keys: [{ keyId: 'key-1', contents: Buffer.alloc(32, 0x0b) }],
    });
    const keyring = loadEncryptionKeyring(directory);
    const aad = Buffer.from('team=singleton|type=snapshot');

    expect(() => keyring.encrypt('payload' as unknown as Buffer, aad)).toThrowError(
      EncryptionOperationError,
    );
    expect(() =>
      keyring.encrypt(Buffer.from('payload'), 'aad' as unknown as Buffer),
    ).toThrowError(EncryptionOperationError);
  });

  it('rejects non-Buffer nonce, ciphertext, and auth tag inputs on decrypt', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-1',
      keys: [{ keyId: 'key-1', contents: Buffer.alloc(32, 0x0c) }],
    });
    const keyring = loadEncryptionKeyring(directory);
    const aad = Buffer.from('team=singleton|type=snapshot');
    const encrypted = keyring.encrypt(Buffer.from('payload'), aad);

    expect(() =>
      keyring.decrypt({ ...encrypted, nonce: 'nonce' as unknown as Buffer }, aad),
    ).toThrowError(EncryptionDecryptError);
    expect(() =>
      keyring.decrypt({ ...encrypted, ciphertext: 'cipher' as unknown as Buffer }, aad),
    ).toThrowError(EncryptionDecryptError);
    expect(() =>
      keyring.decrypt({ ...encrypted, authTag: 'tag' as unknown as Buffer }, aad),
    ).toThrowError(EncryptionDecryptError);
    expect(() =>
      keyring.decrypt({ ...encrypted, nonce: Buffer.alloc(11) }, aad),
    ).toThrowError(/exactly 12 bytes/);
    expect(() =>
      keyring.decrypt({ ...encrypted, authTag: Buffer.alloc(15) }, aad),
    ).toThrowError(/exactly 16 bytes/);
  });

  it('reports unreadable key material as a typed config error without key bytes', () => {
    const directory = createKeyDirectory({
      activeKeyId: 'key-1',
      keys: [{ keyId: 'key-1', contents: Buffer.alloc(32, 0x0d) }],
    });
    const realOpenSync = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation(((filePath: fs.PathLike, ...rest: unknown[]) => {
      if (String(filePath).endsWith('key-1.key')) {
        const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      return realOpenSync(filePath, ...(rest as [number]));
    }) as typeof fs.openSync);

    expect(() => loadEncryptionKeyring(directory)).toThrowError(EncryptionKeyringConfigError);
  });
});
