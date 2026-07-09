// Bundles src/extension.ts -> dist/extension.js for packaging with vsce, and
// copies better-sqlite3's runtime files into dist/node_modules so the
// packaged extension can actually require() the native binding.
//
// `vscode` is always external (provided by the host at runtime).
// `better-sqlite3` is also external and deliberately NOT bundled by esbuild:
// it ships a prebuilt native `.node` binary per platform/ABI that esbuild
// cannot inline. See copyBetterSqlite3Runtime() below for how it ends up in
// the packaged extension instead.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const watch = process.argv.includes('--watch');

// `--vsce-target=<platform>-<arch>` selects which platform's native
// better-sqlite3 binary to bundle (see package:<target> npm scripts below).
// Omit it for local development, which just reuses whatever binary is
// already built/installed for the current machine.
const vsceTargetArg = process.argv.find((a) => a.startsWith('--vsce-target='));
const vsceTarget = vsceTargetArg ? vsceTargetArg.split('=')[1] : undefined;

// The Electron version bundled with the extension's minimum supported VS
// Code release (see package.json's engines.vscode). VS Code's desktop
// extension host runs on Electron's bundled Node/V8, whose ABI can differ
// from a plain Node.js release of the same version — so native modules must
// be built/fetched against Electron's ABI, not Node's, to avoid a runtime
// "NODE_MODULE_VERSION mismatch" crash. Find this by checking the
// `electron` field in https://github.com/microsoft/vscode/blob/<tag>/package.json
// for the exact engines.vscode version, and bump it whenever that floor is
// raised.
const VSCODE_ELECTRON_VERSION = '30.4.0'; // matches engines.vscode ^1.93.0

// The better-sqlite3 major version this bundling pipeline has been verified
// against end-to-end (file layout of copyRuntimePackage()'s skip lists,
// fetchElectronPrebuild()'s GitHub release asset naming assumptions, and the
// runtime deps bindings/file-uri-to-path). A major bump can silently change
// any of those without breaking `pnpm install` — see
// assertSupportedBetterSqlite3Version() below, which fails the build loudly
// instead of shipping a possibly-broken .vsix.
const SUPPORTED_BETTER_SQLITE3_MAJOR = 11;

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode', 'better-sqlite3'],
  logLevel: 'info',
};

/**
 * Fails the build loudly if @ariadne/core's better-sqlite3 dependency has
 * moved to a major version this pipeline hasn't been re-verified against.
 * Bump SUPPORTED_BETTER_SQLITE3_MAJOR only after checking that
 * copyRuntimePackage()'s skip lists, the bindings/file-uri-to-path runtime
 * dependency chain, and fetchElectronPrebuild()'s GitHub release asset
 * naming still hold for the new version (see README's "Multi-platform
 * packaging" section for how to re-verify end-to-end).
 */
function assertSupportedBetterSqlite3Version(betterSqlite3Root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(betterSqlite3Root, 'package.json'), 'utf8'));
  const major = parseInt(pkg.version.split('.')[0], 10);
  if (major !== SUPPORTED_BETTER_SQLITE3_MAJOR) {
    throw new Error(
      `better-sqlite3 resolved to v${pkg.version}, but esbuild.js's bundling pipeline was last verified ` +
        `against v${SUPPORTED_BETTER_SQLITE3_MAJOR}.x. A major version bump can change the package's file ` +
        `layout, its runtime dependency chain, or the GitHub release asset naming that ` +
        `fetchElectronPrebuild() relies on — any of which could silently produce a broken .vsix. ` +
        `Re-verify the pipeline end-to-end (see README's "Multi-platform packaging" section), then bump ` +
        `SUPPORTED_BETTER_SQLITE3_MAJOR in esbuild.js.`,
    );
  }
}

/**
 * better-sqlite3 ships a prebuilt native `.node` binary that esbuild cannot
 * inline, and its lib/ code locates that binary at runtime via the small
 * `bindings` package (which in turn needs `file-uri-to-path`). Copy just the
 * runtime-required files — no src/, no prebuild-install (install-time only)
 * — into dist/node_modules so the plain `require('better-sqlite3')` left in
 * the bundle resolves once packaged into the .vsix (see .vscodeignore).
 */
function copyRuntimePackage(specifier, destNodeModules, resolveFromDir, skipEntries = []) {
  const resolvePaths = resolveFromDir ? [resolveFromDir] : undefined;
  const pkgRoot = path.dirname(require.resolve(`${specifier}/package.json`, { paths: resolvePaths }));
  const dest = path.join(destNodeModules, specifier);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(pkgRoot)) {
    if (entry === 'node_modules' || skipEntries.includes(entry)) continue;
    fs.cpSync(path.join(pkgRoot, entry), path.join(dest, entry), { recursive: true });
  }
  return pkgRoot;
}

/**
 * Fetches the prebuilt better-sqlite3 native binary for one target
 * platform/arch, built against VS Code's Electron ABI, and places it at
 * `<destBetterSqlite3Dir>/build/Release/better_sqlite3.node`. This doesn't
 * require actually running on that platform/arch — prebuild-install just
 * downloads a pre-compiled binary from better-sqlite3's GitHub releases.
 */
function fetchElectronPrebuild(destBetterSqlite3Dir, prebuildInstallBin, platform, arch) {
  execFileSync(
    process.execPath,
    [
      prebuildInstallBin,
      '--runtime',
      'electron',
      '--target',
      VSCODE_ELECTRON_VERSION,
      '--platform',
      platform,
      '--arch',
      arch,
    ],
    { cwd: destBetterSqlite3Dir, stdio: 'inherit' },
  );
}

// Minimal magic-byte checks per platform, so a corrupt/truncated download or
// an unexpected prebuild-install fallback (e.g. silently building from
// source for the *host* platform instead of downloading the requested
// target) is caught immediately rather than shipping a broken .vsix.
const PLATFORM_MAGIC_CHECKS = {
  linux: (buf) => buf.length >= 4 && buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46, // \x7fELF
  darwin: (buf) => {
    if (buf.length < 4) return false;
    const magic = buf.readUInt32LE(0);
    // Mach-O magic numbers (32/64-bit, either byte order) plus fat/universal binaries.
    return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic);
  },
  win32: (buf) => buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a, // "MZ"
};

function assertValidNativeBinary(nativeBindingPath, platform) {
  if (!fs.existsSync(nativeBindingPath)) {
    throw new Error(`better-sqlite3 native binding not found at ${nativeBindingPath} after fetching prebuild.`);
  }
  const buf = fs.readFileSync(nativeBindingPath);
  const MIN_PLAUSIBLE_SIZE = 100 * 1024; // real better-sqlite3 binaries are consistently >1MB
  if (buf.length < MIN_PLAUSIBLE_SIZE) {
    throw new Error(
      `better-sqlite3 native binding at ${nativeBindingPath} is suspiciously small (${buf.length} bytes) — ` +
        `likely a failed or truncated download.`,
    );
  }
  const check = PLATFORM_MAGIC_CHECKS[platform];
  if (check && !check(buf)) {
    throw new Error(
      `better-sqlite3 native binding at ${nativeBindingPath} doesn't look like a valid "${platform}" binary ` +
        `(magic-byte check failed). prebuild-install may have silently fallen back to building for the host ` +
        `platform instead of the requested target — check its output above.`,
    );
  }
}

/**
 * Sanity-checks the locally-built dev bundle by actually requiring and
 * exercising better-sqlite3 the same way the packaged extension would
 * (dist/node_modules/better-sqlite3, resolved via bindings/file-uri-to-path).
 * Only meaningful for the no-`--vsce-target` local dev path, since that's
 * the only variant whose native binary matches this machine's platform/ABI.
 */
function verifyLocalBundleLoads(destNodeModules) {
  const script = `
    const path = require('path');
    const modulePath = path.join(${JSON.stringify(destNodeModules)}, 'better-sqlite3');
    const Database = require(modulePath);
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (x INTEGER)');
    db.prepare('INSERT INTO t (x) VALUES (?)').run(42);
    const row = db.prepare('SELECT x FROM t').get();
    if (!row || row.x !== 42) throw new Error('unexpected row: ' + JSON.stringify(row));
    db.close();
  `;
  execFileSync(process.execPath, ['-e', script], { stdio: 'inherit' });
  console.log('Verified the bundled better-sqlite3 native binding loads and works.');
}

function copyBetterSqlite3Runtime() {
  const destNodeModules = path.join(__dirname, 'dist', 'node_modules');
  fs.rmSync(destNodeModules, { recursive: true, force: true });
  fs.mkdirSync(destNodeModules, { recursive: true });

  // src/ (C++ sources) and deps/ (bundled sqlite amalgamation) are only
  // needed to *compile* the native binding, not to run the already-built one.
  const betterSqlite3Root = copyRuntimePackage('better-sqlite3', destNodeModules, undefined, [
    'src',
    'deps',
    'binding.gyp',
    'README.md',
  ]);
  assertSupportedBetterSqlite3Version(betterSqlite3Root);
  // bindings/file-uri-to-path aren't direct deps of this package, so resolve
  // them relative to better-sqlite3's own (pnpm-private) node_modules.
  const bindingsRoot = copyRuntimePackage('bindings', destNodeModules, betterSqlite3Root, ['test']);
  copyRuntimePackage('file-uri-to-path', destNodeModules, bindingsRoot, ['test', '.travis.yml', '.npmignore']);

  const dest = path.join(destNodeModules, 'better-sqlite3');
  fs.mkdirSync(path.join(dest, 'build', 'Release'), { recursive: true });
  const nativeBindingDest = path.join(dest, 'build', 'Release', 'better_sqlite3.node');

  if (vsceTarget) {
    const [platform, arch] = vsceTarget.split('-');
    if (!platform || !arch) {
      throw new Error(`--vsce-target must be "<platform>-<arch>" (e.g. "darwin-arm64"), got "${vsceTarget}"`);
    }
    const prebuildInstallBin = require.resolve('prebuild-install/bin.js', { paths: [betterSqlite3Root] });
    fetchElectronPrebuild(dest, prebuildInstallBin, platform, arch);
    assertValidNativeBinary(nativeBindingDest, platform);
    console.log(`Fetched better-sqlite3 electron-v${VSCODE_ELECTRON_VERSION} prebuild for ${platform}-${arch}`);
  } else {
    // Local dev build: reuse whatever native binary is already installed
    // for the current machine (via pnpm's normal install/rebuild step).
    const nativeBinding = path.join(betterSqlite3Root, 'build', 'Release', 'better_sqlite3.node');
    if (!fs.existsSync(nativeBinding)) {
      throw new Error(
        `better-sqlite3 native binding not found at ${nativeBinding}. Run "pnpm rebuild better-sqlite3" first.`,
      );
    }
    fs.copyFileSync(nativeBinding, nativeBindingDest);
  }

  console.log(`Copied better-sqlite3 + bindings runtime files into ${path.relative(__dirname, destNodeModules)}`);

  if (!vsceTarget) {
    verifyLocalBundleLoads(destNodeModules);
  }
}

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    copyBetterSqlite3Runtime();
  } else {
    await esbuild.build(options);
    copyBetterSqlite3Runtime();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

