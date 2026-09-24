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

---

## Review-finding fixes (round 2)

Binding ruling applied: the keyring validates that the key directory and every
key file are owned by the **effective uid** loading the keys. Plan 03 loads
canonical root-owned `0600` keys before dropping to a non-root user prior to
`listen`, so the ownership contract stays consistent end to end.

### 1. Ownership checks

`packages/sync-server/src/encryption.ts` now checks `stats.uid` against
`process.geteuid()` for the key directory, `active-key-id`, and every
`<key-id>.key` file. Platforms without POSIX uids (Windows) skip the check
instead of failing spuriously.

### 2. Ancestor-chain validation (replacement defence)

`assertSafeAncestors` walks root → parent of the key directory and rejects:

- non-absolute or non-canonical input (path is resolved first),
- symbolic-link components anywhere in the chain,
- non-directory components,
- ancestors not owned by `root` or the effective user,
- group- or world-writable ancestors **unless** the sticky bit is set (so
  `/tmp`-style `1777` shared roots remain usable while `0775` parents do not).

### 3. `createApp` keyring is required

`CreateAppOptions.encryptionKeyring` is now required and validated at runtime;
a missing or malformed keyring throws `SyncServerConfigError`. Production has
no keyless path. Tests inject a shared factory,
`packages/sync-server/test/testKeyring.ts`, built on the newly exported
in-memory `createEncryptionKeyring(activeKeyId, keys)`.

### 4. Owner-only readable modes

Key material may now be `0400` or `0600`. Group/world bits, executable bits,
and setuid/setgid/sticky bits are rejected.

### 5. Typed filesystem errors

Every `open`/`fstat`/`read`/`readdir` failure is funnelled through
`toConfigError`, producing `EncryptionKeyringConfigError` with only the path
and errno code — never the raw message or any key bytes.

### 6. TOCTOU elimination

`lstat`-then-`read` was replaced by a single-descriptor flow: `openSync` with
`O_RDONLY | O_NOFOLLOW` (plus `O_DIRECTORY` for the directory), `fstatSync` on
that same fd, and a bounded `readSync` loop (128-byte cap) from that fd.
Symlinks, non-regular files, and oversized files are rejected. `O_NOFOLLOW` /
`O_DIRECTORY` fall back to `0` where a platform does not define them, and
`ELOOP`/`EMLINK`/`EFTYPE` are all mapped to the symlink rejection so behaviour
is portable across Linux and BSD/macOS.

### 7. Absolute `ENCRYPTION_KEY_DIR`

`loadConfig` rejects a relative `ENCRYPTION_KEY_DIR`, and
`loadEncryptionKeyring` independently requires an absolute path.

### 8. Buffer guards

`encrypt` guards plaintext and AAD with `Buffer.isBuffer`; `decrypt` guards
nonce, ciphertext, auth tag, and AAD, and enforces exact 12-byte nonce and
16-byte tag lengths.

### Tests added

`test/encryption.test.ts` (28 tests) now covers foreign-uid directory and key
files, relative paths, symlinked path components, symlinked `active-key-id`
and key files, group-writable ancestors without/with the sticky bit, `0400`
acceptance, executable-mode rejection, oversized files, non-regular `.key`
entries, non-Buffer/incorrect-length crypto inputs, and typed wrapping of
`EACCES`. `test/config.test.ts` covers the absolute-path requirement, and the
new `test/app.test.ts` covers the fail-closed `createApp` contract.

### Validation

```bash
pnpm --filter @ariadne-dev/sync-server exec vitest run test/encryption.test.ts test/config.test.ts test/app.test.ts
pnpm --filter @ariadne-dev/sync-server run build
pnpm --filter @ariadne-dev/sync-server exec vitest run
```

Focused: 36 passed. Full suite: 8 files / 94 tests passed. Build clean.
