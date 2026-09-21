import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ACTIVE_KEY_ID_FILE = 'active-key-id';
const AUTH_TAG_BYTES = 16;
const FILE_MODE = 0o600;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const OWNER_ONLY_MASK = 0o077;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export interface EncryptedBlob {
  keyId: string;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

export interface EncryptionKeyring {
  activeKeyId: string;
  encrypt(plaintext: Buffer, aad: Buffer): EncryptedBlob;
  decrypt(blob: EncryptedBlob, aad: Buffer): Buffer;
}

export class EncryptionKeyringConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyringConfigError';
  }
}

export class EncryptionOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionOperationError';
  }
}

export class EncryptionDecryptError extends EncryptionOperationError {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionDecryptError';
  }
}

function fileMode(stats: fs.Stats): number {
  return stats.mode & 0o777;
}

function readLstat(filePath: string, description: string): fs.Stats {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new EncryptionKeyringConfigError(`${description} is missing at ${filePath}`);
    }
    throw error;
  }

  if (stats.isSymbolicLink()) {
    throw new EncryptionKeyringConfigError(`${description} must not be a symbolic link`);
  }

  return stats;
}

function assertOwnerOnlyDirectory(directory: string): void {
  const stats = readLstat(directory, 'Encryption key directory');
  if (!stats.isDirectory()) {
    throw new EncryptionKeyringConfigError(`Encryption key directory is not a directory: ${directory}`);
  }
  if ((fileMode(stats) & OWNER_ONLY_MASK) !== 0) {
    throw new EncryptionKeyringConfigError(
      `Encryption key directory must not be group- or world-accessible: ${directory}`,
    );
  }
}

function assertStrictFile(filePath: string, description: string): void {
  const stats = readLstat(filePath, description);
  if (!stats.isFile()) {
    throw new EncryptionKeyringConfigError(`${description} is not a regular file: ${filePath}`);
  }
  if (fileMode(stats) !== FILE_MODE) {
    throw new EncryptionKeyringConfigError(`${description} must have mode 0600: ${filePath}`);
  }
}

function normalizeActiveKeyId(rawValue: string): string {
  const withoutLineEnding = rawValue.endsWith('\r\n')
    ? rawValue.slice(0, -2)
    : rawValue.endsWith('\n')
      ? rawValue.slice(0, -1)
      : rawValue;

  if (!KEY_ID_PATTERN.test(withoutLineEnding)) {
    throw new EncryptionKeyringConfigError(
      'active-key-id must be a non-empty lowercase identifier containing only letters, digits, and dashes',
    );
  }

  return withoutLineEnding;
}

function parseKeyMaterial(keyPath: string): Buffer {
  const raw = fs.readFileSync(keyPath);
  if (raw.length === KEY_BYTES) {
    return Buffer.from(raw);
  }

  if (raw.length === KEY_BYTES * 2) {
    const hex = raw.toString('utf8');
    if (/^[0-9a-f]{64}$/.test(hex)) {
      return Buffer.from(hex, 'hex');
    }
  }

  throw new EncryptionKeyringConfigError(
    `Encryption key file must contain exactly 32 raw bytes or 64 lowercase hex characters: ${keyPath}`,
  );
}

function assertAad(aad: Buffer): void {
  if (aad.length === 0) {
    throw new EncryptionOperationError('Encryption AAD must be a non-empty buffer');
  }
}

function assertBlobShape(blob: EncryptedBlob): void {
  if (!KEY_ID_PATTERN.test(blob.keyId)) {
    throw new EncryptionDecryptError('Encrypted blob keyId is invalid');
  }
  if (blob.nonce.length !== NONCE_BYTES) {
    throw new EncryptionDecryptError('Encrypted blob nonce must be exactly 12 bytes');
  }
  if (blob.authTag.length !== AUTH_TAG_BYTES) {
    throw new EncryptionDecryptError('Encrypted blob auth tag must be exactly 16 bytes');
  }
}

export function loadEncryptionKeyring(directory: string): EncryptionKeyring {
  assertOwnerOnlyDirectory(directory);

  const activeKeyPath = path.join(directory, ACTIVE_KEY_ID_FILE);
  assertStrictFile(activeKeyPath, 'Encryption active-key-id file');
  const activeKeyId = normalizeActiveKeyId(fs.readFileSync(activeKeyPath, 'utf8'));

  const keyFiles = new Map<string, Buffer>();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith('.key')) {
      continue;
    }

    const keyId = entry.name.slice(0, -'.key'.length);
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new EncryptionKeyringConfigError(
        `Encryption key filename must be lowercase letters, digits, and dashes: ${entry.name}`,
      );
    }

    const keyPath = path.join(directory, entry.name);
    assertStrictFile(keyPath, `Encryption key file ${entry.name}`);
    keyFiles.set(keyId, parseKeyMaterial(keyPath));
  }

  const activeKey = keyFiles.get(activeKeyId);
  if (!activeKey) {
    throw new EncryptionKeyringConfigError(
      `Encryption active key ${activeKeyId} does not have a matching .key file`,
    );
  }

  return {
    activeKeyId,
    encrypt(plaintext: Buffer, aad: Buffer): EncryptedBlob {
      assertAad(aad);
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv('aes-256-gcm', activeKey, nonce);
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

      return {
        keyId: activeKeyId,
        nonce,
        ciphertext,
        authTag: cipher.getAuthTag(),
      };
    },
    decrypt(blob: EncryptedBlob, aad: Buffer): Buffer {
      assertAad(aad);
      assertBlobShape(blob);

      const key = keyFiles.get(blob.keyId);
      if (!key) {
        throw new EncryptionDecryptError(`No encryption key is loaded for keyId ${blob.keyId}`);
      }

      try {
        const decipher = createDecipheriv('aes-256-gcm', key, blob.nonce);
        decipher.setAAD(aad);
        decipher.setAuthTag(blob.authTag);
        return Buffer.concat([decipher.update(blob.ciphertext), decipher.final()]);
      } catch {
        throw new EncryptionDecryptError('Encrypted blob failed authentication');
      }
    },
  };
}
