# Task 4 report — Server encryption keyring

## Outcome

Implemented a strict AES-256-GCM server keyring for the sync server and made
`ENCRYPTION_KEY_DIR` required at startup. Production startup now loads an
owner-only key directory, enforces a strict `active-key-id` + key-file
contract, uses fresh 12-byte nonces plus mandatory AAD for every encryption,
and keeps old keys available for historical decryption after rotation.

## What changed

- **Keyring implementation**
  - added `packages/sync-server/src/encryption.ts`
  - loads `/etc/ariadne/keys`-style key directories
  - enforces:
    - owner-only key directory permissions
    - mode `0600` for `active-key-id` and every key file
    - strict lowercase key ids
    - key contents of exactly 32 raw bytes or 64 lowercase hex characters
    - no plaintext or generated-key fallback
  - returns explicit typed errors:
    - `EncryptionKeyringConfigError`
    - `EncryptionOperationError`
    - `EncryptionDecryptError`
  - decrypts historical blobs with retained non-active keys

- **Server wiring**
  - `packages/sync-server/src/config.ts`
    - added required `ENCRYPTION_KEY_DIR`
    - upgraded config failures to typed `SyncServerConfigError`
  - `packages/sync-server/src/index.ts`
    - loads the keyring on startup and passes it into `createApp(...)`
  - `packages/sync-server/src/app.ts`
    - added a test-only `encryptionKeyring` app option without forcing
      unrelated unit tests to provide encryption config

- **Tests**
  - added `packages/sync-server/test/encryption.test.ts`
  - expanded `packages/sync-server/test/config.test.ts`
  - coverage includes:
    - round-trip encryption/decryption
    - randomized nonce generation
    - mandatory AAD
    - AAD/ciphertext/auth-tag tamper failure
    - missing active key metadata
    - malformed key material
    - unknown decrypt key ids
    - insecure directory/file permissions
    - key rotation with old-key decryption

- **Docs**
  - updated `packages/sync-server/README.md` with `ENCRYPTION_KEY_DIR`,
    directory layout, permission requirements, and key format constraints

## TDD notes

1. **RED**
   - wrote the new encryption/config tests first
   - verified failure with:

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/encryption.test.ts test/config.test.ts
```

2. **GREEN**
   - implemented the keyring, strict config, and startup wiring
   - reran the focused suite until it passed

3. **IMPROVE**
   - tightened validation around file modes, key-id parsing, and typed errors
   - kept error messages free of key material and avoided any logging inside the
     keyring itself

## Validation

- Focused:

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/encryption.test.ts test/config.test.ts
```

- Full sync-server validation:

```bash
pnpm --filter @ariadne-dev/sync-server run build
pnpm --filter @ariadne-dev/sync-server exec vitest run
```

All passed.
