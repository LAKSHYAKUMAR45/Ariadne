import { createEncryptionKeyring, type EncryptionKeyring } from '../src/encryption.js';

const TEST_KEY_ID = 'test-key-1';

/**
 * Shared in-memory keyring for tests. Production code can only build a keyring
 * from an on-disk key directory (see `loadEncryptionKeyring`), so tests inject
 * this instead of leaving `createApp` keyless.
 */
export function createTestEncryptionKeyring(): EncryptionKeyring {
  return createEncryptionKeyring(TEST_KEY_ID, new Map([[TEST_KEY_ID, Buffer.alloc(32, 0x5a)]]));
}
