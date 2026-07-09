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
  // bindings/file-uri-to-path aren't direct deps of this package, so resolve
  // them relative to better-sqlite3's own (pnpm-private) node_modules.
  const bindingsRoot = copyRuntimePackage('bindings', destNodeModules, betterSqlite3Root, ['test']);
  copyRuntimePackage('file-uri-to-path', destNodeModules, bindingsRoot, ['test', '.travis.yml', '.npmignore']);

  const dest = path.join(destNodeModules, 'better-sqlite3');
  fs.mkdirSync(path.join(dest, 'build', 'Release'), { recursive: true });

  if (vsceTarget) {
    const [platform, arch] = vsceTarget.split('-');
    if (!platform || !arch) {
      throw new Error(`--vsce-target must be "<platform>-<arch>" (e.g. "darwin-arm64"), got "${vsceTarget}"`);
    }
    const prebuildInstallBin = require.resolve('prebuild-install/bin.js', { paths: [betterSqlite3Root] });
    fetchElectronPrebuild(dest, prebuildInstallBin, platform, arch);
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
    fs.copyFileSync(nativeBinding, path.join(dest, 'build', 'Release', 'better_sqlite3.node'));
  }

  console.log(`Copied better-sqlite3 + bindings runtime files into ${path.relative(__dirname, destNodeModules)}`);
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

