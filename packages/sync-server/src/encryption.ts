import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ACTIVE_KEY_ID_FILE = 'active-key-id';
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const KEY_SUFFIX = '.key';

const GROUP_WORLD_MASK = 0o077;
const GROUP_WORLD_WRITE_MASK = 0o022;
const EXECUTABLE_MASK = 0o111;
const OWNER_READ = 0o400;
const SPECIAL_BITS_MASK = 0o7000;
const STICKY_BIT = 0o1000;

const MAX_KEY_FILE_BYTES = 128;
const MAX_ACTIVE_KEY_ID_BYTES = 128;

const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = fs.constants.O_DIRECTORY ?? 0;

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

/**
 * Effective uid of the process loading the keys, or `null` on platforms
 * without POSIX uids (Windows). Plan 03 loads canonical root-owned `0600`
 * keys before dropping privileges, so "owned by the effective uid" is the
 * ownership contract this module enforces.
 */
function effectiveUid(): number | null {
  return typeof process.geteuid === 'function' ? process.geteuid() : null;
}

function errnoCode(error: unknown): string | null {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return null;
}

/**
 * Converts raw filesystem failures into typed config errors. Only the path and
 * the errno code are surfaced — never file contents or the underlying message,
 * which could contain key material on some platforms.
 */
function toConfigError(error: unknown, description: string, filePath: string): Error {
  const code = errnoCode(error);
  if (code === 'ENOENT') {
    return new EncryptionKeyringConfigError(`${description} is missing at ${filePath}`);
  }
  if (code === 'ELOOP' || code === 'EMLINK' || code === 'EFTYPE') {
    return new EncryptionKeyringConfigError(
      `${description} must not be a symbolic link: ${filePath}`,
    );
  }
  if (code === 'ENOTDIR') {
    return new EncryptionKeyringConfigError(`${description} is not a directory: ${filePath}`);
  }
  if (code === 'EISDIR') {
    return new EncryptionKeyringConfigError(`${description} is not a regular file: ${filePath}`);
  }
  return new EncryptionKeyringConfigError(
    `${description} could not be read (${code ?? 'unknown error'}): ${filePath}`,
  );
}

function permissionBits(stats: fs.Stats): number {
  return stats.mode & 0o7777;
}

function assertOwnedByEffectiveUid(stats: fs.Stats, description: string, filePath: string): void {
  const uid = effectiveUid();
  if (uid === null) {
    return;
  }
  if (stats.uid !== uid) {
    throw new EncryptionKeyringConfigError(
      `${description} must be owned by the effective user (uid ${uid}): ${filePath}`,
    );
  }
}

/**
 * Walks every ancestor directory of `directory` (root first) and rejects
 * symlinked components, foreign owners, and shared-writable directories that
 * are not sticky-bit protected. Prevents an attacker-controlled parent from
 * swapping the key directory underneath us.
 */
function assertSafeAncestors(directory: string): void {
  const uid = effectiveUid();
  const { root } = path.parse(directory);
  const relative = directory.slice(root.length);
  const segments = relative.split(path.sep).filter((segment) => segment.length > 0);

  const ancestors: string[] = [root];
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    ancestors.push(current);
  }

  for (const ancestor of ancestors) {
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(ancestor);
    } catch (error: unknown) {
      throw toConfigError(error, 'Encryption key directory ancestor', ancestor);
    }

    if (stats.isSymbolicLink()) {
      throw new EncryptionKeyringConfigError(
        `Encryption key directory path must not contain symbolic links: ${ancestor}`,
      );
    }
    if (!stats.isDirectory()) {
      throw new EncryptionKeyringConfigError(
        `Encryption key directory ancestor is not a directory: ${ancestor}`,
      );
    }
    if (uid !== null && stats.uid !== 0 && stats.uid !== uid) {
      throw new EncryptionKeyringConfigError(
        `Encryption key directory ancestor must be owned by root or the effective user: ${ancestor}`,
      );
    }

    const mode = permissionBits(stats);
    if ((mode & GROUP_WORLD_WRITE_MASK) !== 0 && (mode & STICKY_BIT) === 0) {
      throw new EncryptionKeyringConfigError(
        `Encryption key directory ancestor is group- or world-writable without the sticky bit: ${ancestor}`,
      );
    }
  }
}

function openNoFollow(filePath: string, description: string, extraFlags: number): number {
  try {
    return fs.openSync(filePath, fs.constants.O_RDONLY | O_NOFOLLOW | extraFlags);
  } catch (error: unknown) {
    throw toConfigError(error, description, filePath);
  }
}

function fstatOrThrow(fd: number, description: string, filePath: string): fs.Stats {
  try {
    return fs.fstatSync(fd);
  } catch (error: unknown) {
    throw toConfigError(error, description, filePath);
  }
}

/**
 * Rejects group/world bits, executable bits, and setuid/setgid/sticky bits on
 * key material, while allowing the owner-only readable modes `0400` and `0600`.
 */
function assertOwnerOnlyFileMode(stats: fs.Stats, description: string, filePath: string): void {
  const mode = permissionBits(stats);
  const insecure =
    (mode & GROUP_WORLD_MASK) !== 0 ||
    (mode & EXECUTABLE_MASK) !== 0 ||
    (mode & SPECIAL_BITS_MASK) !== 0 ||
    (mode & OWNER_READ) === 0;

  if (insecure) {
    throw new EncryptionKeyringConfigError(
      `${description} must be owner-readable only (0400 or 0600): ${filePath}`,
    );
  }
}

/**
 * Opens, validates, and reads a key file through a single descriptor so the
 * validated inode is always the one we read (no lstat/open TOCTOU window).
 */
function readSecretFile(filePath: string, description: string, maxBytes: number): Buffer {
  const fd = openNoFollow(filePath, description, 0);
  try {
    const stats = fstatOrThrow(fd, description, filePath);
    if (stats.isSymbolicLink()) {
      throw new EncryptionKeyringConfigError(
        `${description} must not be a symbolic link: ${filePath}`,
      );
    }
    if (!stats.isFile()) {
      throw new EncryptionKeyringConfigError(`${description} is not a regular file: ${filePath}`);
    }
    assertOwnedByEffectiveUid(stats, description, filePath);
    assertOwnerOnlyFileMode(stats, description, filePath);
    if (stats.size > maxBytes) {
      throw new EncryptionKeyringConfigError(
        `${description} is larger than ${maxBytes} bytes: ${filePath}`,
      );
    }

    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      let read: number;
      try {
        read = fs.readSync(fd, buffer, total, buffer.length - total, null);
      } catch (error: unknown) {
        throw toConfigError(error, description, filePath);
      }
      if (read === 0) {
        break;
      }
      total += read;
      if (total > maxBytes) {
        throw new EncryptionKeyringConfigError(
          `${description} is larger than ${maxBytes} bytes: ${filePath}`,
        );
      }
    }

    return Buffer.from(buffer.subarray(0, total));
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Closing a validated descriptor cannot invalidate the material already read.
    }
  }
}

function assertSecureKeyDirectory(directory: string): void {
  const fd = openNoFollow(directory, 'Encryption key directory', O_DIRECTORY);
  try {
    const stats = fstatOrThrow(fd, 'Encryption key directory', directory);
    if (!stats.isDirectory()) {
      throw new EncryptionKeyringConfigError(
        `Encryption key directory is not a directory: ${directory}`,
      );
    }
    assertOwnedByEffectiveUid(stats, 'Encryption key directory', directory);

    const mode = permissionBits(stats);
    if ((mode & GROUP_WORLD_MASK) !== 0) {
      throw new EncryptionKeyringConfigError(
        `Encryption key directory must not be group- or world-accessible: ${directory}`,
      );
    }
    if ((mode & SPECIAL_BITS_MASK) !== 0) {
      throw new EncryptionKeyringConfigError(
        `Encryption key directory must not use setuid, setgid, or sticky bits: ${directory}`,
      );
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Directory descriptor is only used for validation.
    }
  }
}

function normalizeActiveKeyId(raw: Buffer): string {
  const text = raw.toString('utf8');
  const withoutLineEnding = text.endsWith('\r\n')
    ? text.slice(0, -2)
    : text.endsWith('\n')
      ? text.slice(0, -1)
      : text;

  if (!KEY_ID_PATTERN.test(withoutLineEnding)) {
    throw new EncryptionKeyringConfigError(
      'active-key-id must be a non-empty lowercase identifier containing only letters, digits, and dashes',
    );
  }

  return withoutLineEnding;
}

function parseKeyMaterial(raw: Buffer, keyPath: string): Buffer {
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

function assertOperationBuffer(value: unknown, description: string): asserts value is Buffer {
  if (!Buffer.isBuffer(value)) {
    throw new EncryptionOperationError(`${description} must be a Buffer`);
  }
}

function assertAad(aad: unknown): asserts aad is Buffer {
  assertOperationBuffer(aad, 'Encryption AAD');
  if (aad.length === 0) {
    throw new EncryptionOperationError('Encryption AAD must be a non-empty buffer');
  }
}

function assertBlobShape(blob: EncryptedBlob): void {
  if (typeof blob?.keyId !== 'string' || !KEY_ID_PATTERN.test(blob.keyId)) {
    throw new EncryptionDecryptError('Encrypted blob keyId is invalid');
  }
  if (!Buffer.isBuffer(blob.nonce)) {
    throw new EncryptionDecryptError('Encrypted blob nonce must be a Buffer');
  }
  if (!Buffer.isBuffer(blob.ciphertext)) {
    throw new EncryptionDecryptError('Encrypted blob ciphertext must be a Buffer');
  }
  if (!Buffer.isBuffer(blob.authTag)) {
    throw new EncryptionDecryptError('Encrypted blob auth tag must be a Buffer');
  }
  if (blob.nonce.length !== NONCE_BYTES) {
    throw new EncryptionDecryptError('Encrypted blob nonce must be exactly 12 bytes');
  }
  if (blob.authTag.length !== AUTH_TAG_BYTES) {
    throw new EncryptionDecryptError('Encrypted blob auth tag must be exactly 16 bytes');
  }
}

/**
 * Builds a keyring around already-validated key material. Production code must
 * go through `loadEncryptionKeyring`; tests use this to inject a deterministic
 * keyring without touching the filesystem.
 */
export function createEncryptionKeyring(
  activeKeyId: string,
  keys: ReadonlyMap<string, Buffer>,
): EncryptionKeyring {
  if (!KEY_ID_PATTERN.test(activeKeyId)) {
    throw new EncryptionKeyringConfigError('Encryption active key id is invalid');
  }

  const keyFiles = new Map<string, Buffer>();
  for (const [keyId, material] of keys) {
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new EncryptionKeyringConfigError('Encryption key id is invalid');
    }
    if (!Buffer.isBuffer(material) || material.length !== KEY_BYTES) {
      throw new EncryptionKeyringConfigError(
        `Encryption key material for ${keyId} must be exactly 32 bytes`,
      );
    }
    keyFiles.set(keyId, Buffer.from(material));
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
      assertOperationBuffer(plaintext, 'Encryption plaintext');
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

/** Loads the AES-256-GCM keyring from a strictly validated key directory. */
export function loadEncryptionKeyring(directory: string): EncryptionKeyring {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new EncryptionKeyringConfigError(
      'Encryption key directory must be an absolute path',
    );
  }

  const resolved = path.resolve(directory);
  assertSafeAncestors(resolved);
  assertSecureKeyDirectory(resolved);

  const activeKeyPath = path.join(resolved, ACTIVE_KEY_ID_FILE);
  const activeKeyId = normalizeActiveKeyId(
    readSecretFile(activeKeyPath, 'Encryption active-key-id file', MAX_ACTIVE_KEY_ID_BYTES),
  );

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (error: unknown) {
    throw toConfigError(error, 'Encryption key directory', resolved);
  }

  const keyFiles = new Map<string, Buffer>();
  for (const entry of entries) {
    if (!entry.name.endsWith(KEY_SUFFIX)) {
      continue;
    }

    const keyId = entry.name.slice(0, -KEY_SUFFIX.length);
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new EncryptionKeyringConfigError(
        `Encryption key filename must be lowercase letters, digits, and dashes: ${entry.name}`,
      );
    }

    const keyPath = path.join(resolved, entry.name);
    const raw = readSecretFile(keyPath, `Encryption key file ${entry.name}`, MAX_KEY_FILE_BYTES);
    keyFiles.set(keyId, parseKeyMaterial(raw, keyPath));
  }

  return createEncryptionKeyring(activeKeyId, keyFiles);
}
