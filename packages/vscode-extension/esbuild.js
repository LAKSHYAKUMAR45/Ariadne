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
const os = require('os');
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

// Node.js versions to also bundle a better-sqlite3 prebuild for, alongside
// the Electron one above, so a *single* packaged .vsix works both as a
// plain desktop install (Electron's bundled Node/V8 ABI) and over
// Remote-SSH/Tunnels/Codespaces/WSL (VS Code Server's own plain Node.js,
// whose ABI is independent of Electron's and varies by release). Each
// entry just needs to resolve to a distinct NODE_MODULE_VERSION that some
// supported VS Code Server release actually ships; exact patch version
// doesn't matter (prebuild-install/node-abi key off the ABI number, not the
// patch), so these are simply recent representative releases per major.
// Extend this list if a newer VS Code Server major Node version shows up
// with a different ABI than everything already covered here.
const BUNDLED_NODE_VERSIONS = ['18.20.4', '20.18.1', '22.11.0', '24.0.0'];

// The better-sqlite3 major version this bundling pipeline has been verified
// against end-to-end (file layout of copyRuntimePackage()'s skip lists,
// fetchAbiPrebuilds()'s GitHub release asset naming assumptions, and the
// runtime deps bindings/file-uri-to-path). A major bump can silently change
// any of those without breaking `pnpm install` — see
// assertSupportedBetterSqlite3Version() below, which fails the build loudly
// instead of shipping a possibly-broken .vsix.
const SUPPORTED_BETTER_SQLITE3_MAJOR = 11;

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  // Named extension.bundle.js (not extension.js) because package.json's
  // "main" now points at native-bootstrap.js — a small plain CJS file
  // (copied in verbatim below, not run through esbuild) that picks the
  // right better-sqlite3 native binding for the current runtime's ABI
  // *before* require()-ing this bundle, which is what actually pulls in
  // better-sqlite3 via @ariadne-dev/core. See native-bootstrap.js for why.
  outfile: 'dist/extension.bundle.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode', 'better-sqlite3'],
  logLevel: 'info',
};

/**
 * Fails the build loudly if @ariadne-dev/core's better-sqlite3 dependency has
 * moved to a major version this pipeline hasn't been re-verified against.
 * Bump SUPPORTED_BETTER_SQLITE3_MAJOR only after checking that
 * copyRuntimePackage()'s skip lists, the bindings/file-uri-to-path runtime
 * dependency chain, and fetchAbiPrebuilds()'s GitHub release asset
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
        `fetchAbiPrebuilds() relies on — any of which could silently produce a broken .vsix. ` +
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
 * Fetches the prebuilt better-sqlite3 native binary for a specific plain
 * Node.js version/platform/arch (as opposed to fetchAbiPrebuilds' desktop-vs-server
 * Electron ABI), and places it at
 * `<destBetterSqlite3Dir>/build/Release/better_sqlite3.node`. Used for the
 * "local dev but the actual host is VS Code Server's own Node" case — see
 * findRunningVscodeServerNode() below.
 */
function fetchNodeRuntimePrebuild(destBetterSqlite3Dir, prebuildInstallBin, nodeVersion, platform, arch) {
  execFileSync(
    process.execPath,
    [prebuildInstallBin, '--runtime', 'node', '--target', nodeVersion, '--platform', platform, '--arch', arch],
    { cwd: destBetterSqlite3Dir, stdio: 'inherit' },
  );
}

/**
 * Compiles better-sqlite3's native binding from source against a specific
 * Node.js version, for when no prebuilt binary exists for it yet (e.g. a
 * Node major version too new for better-sqlite3's published GitHub release
 * assets to cover — this happens routinely right after a new Node major
 * ships). Copies just the source files needed to compile (not the shared
 * pnpm-store package itself, so this never mutates the native binary other
 * packages in the workspace — e.g. @ariadne-dev/core — resolve via the same
 * pnpm store entry) into a scratch directory, builds there via node-gyp,
 * and returns the path to the resulting `.node` file plus the scratch
 * directory (caller is responsible for cleaning it up).
 */
function compileNodeRuntimeBinary(betterSqlite3PkgRoot, nodeVersion) {
  const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'better-sqlite3-build-'));
  try {
    for (const entry of ['binding.gyp', 'src', 'deps', 'package.json']) {
      const srcPath = path.join(betterSqlite3PkgRoot, entry);
      if (fs.existsSync(srcPath)) fs.cpSync(srcPath, path.join(buildDir, entry), { recursive: true });
    }
    execFileSync('npx', ['--yes', 'node-gyp', 'rebuild', '--release', `--target=${nodeVersion}`], {
      cwd: buildDir,
      stdio: 'inherit',
    });
    const builtBinding = path.join(buildDir, 'build', 'Release', 'better_sqlite3.node');
    if (!fs.existsSync(builtBinding)) {
      throw new Error(`node-gyp rebuild did not produce ${builtBinding}`);
    }
    return { builtBinding, buildDir };
  } catch (err) {
    fs.rmSync(buildDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * VS Code Server (Remote-SSH/Tunnels/Codespaces) runs the extension host on
 * its *own* bundled Node.js binary, entirely independent of whatever `node`
 * happens to be on $PATH when this build script runs — the two commonly
 * drift to different NODE_MODULE_VERSION ABIs (e.g. building with a locally
 * installed Node 20 while the running VS Code Server ships Node 24). A
 * better-sqlite3 binary built for the wrong one fails at runtime with an
 * opaque "Module did not self-register" / NODE_MODULE_VERSION mismatch
 * error. Find the Node binary of a currently-running VS Code Server
 * instance (if any) so its ABI can be checked/matched below, by scanning
 * `~/.vscode-server/cli/servers/*` for a live `pid.txt` next to a `node`
 * binary — this layout is used by Remote-SSH/Tunnels on Linux and macOS.
 */
function findRunningVscodeServerNode() {
  const serversDir = path.join(os.homedir(), '.vscode-server', 'cli', 'servers');
  if (!fs.existsSync(serversDir)) return null;

  let best = null;
  for (const name of fs.readdirSync(serversDir)) {
    if (name.endsWith('.staging')) continue; // in-progress update, not a running instance
    const dir = path.join(serversDir, name);
    const nodeBin = path.join(dir, 'server', 'node');
    const pidFile = path.join(dir, 'pid.txt');
    if (!fs.existsSync(nodeBin) || !fs.existsSync(pidFile)) continue;

    const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!pid || !isPidAlive(pid)) continue;

    const mtimeMs = fs.statSync(nodeBin).mtimeMs;
    if (!best || mtimeMs > best.mtimeMs) best = { nodeBin, mtimeMs };
  }
  return best ? best.nodeBin : null;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Full Node.js version (e.g. "24.15.0") that a given `node` binary reports. */
function nodeVersionOf(nodeBin) {
  return execFileSync(nodeBin, ['-e', 'process.stdout.write(process.version.slice(1))']).toString().trim();
}

/** Whether `require()`-ing a native binding under a given `node` binary succeeds. */
function nativeBindingLoadsUnder(nodeBin, nativeBindingPath) {
  try {
    execFileSync(nodeBin, ['-e', `require(${JSON.stringify(nativeBindingPath)})`], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Determines the NODE_MODULE_VERSION (ABI) a compiled `.node` file was
 * built against, without needing a matching Node/Electron binary on hand.
 * Node's own native-module loader refuses a mismatched binary with an error
 * that names *both* ABIs involved, e.g.:
 *
 *   "The module ... was compiled against a different Node.js version using
 *   NODE_MODULE_VERSION 137. This version of Node.js requires
 *   NODE_MODULE_VERSION 115."
 *
 * — the first number is always the binary's own ABI, regardless of which
 * Node runs the check. If the check instead *succeeds* (no mismatch), the
 * binary's ABI is simply the checking runtime's own `process.versions.modules`.
 */
function detectAbi(nodeBin, nativeBindingPath) {
  try {
    execFileSync(nodeBin, ['-e', `require(${JSON.stringify(nativeBindingPath)})`], { stdio: 'pipe' });
    const abi = execFileSync(nodeBin, ['-e', 'process.stdout.write(process.versions.modules)']).toString().trim();
    return abi;
  } catch (err) {
    const stderr = String(err.stderr || err.message || '');
    const match = stderr.match(/NODE_MODULE_VERSION (\d+)/);
    if (!match) {
      throw new Error(`Could not determine ABI of ${nativeBindingPath}; unexpected error:\n${stderr}`);
    }
    return match[1];
  }
}

/**
 * Fetches better-sqlite3 prebuilds for every ABI this packaged .vsix should
 * support — VS Code's bundled Electron (desktop installs) plus a curated
 * set of plain Node.js versions (Remote-SSH/Tunnels/Codespaces/WSL, where
 * the extension host runs on VS Code Server's own Node, independent of
 * Electron) — and stores each as `better_sqlite3.abi<N>.node` in
 * `<dest>/build/Release/`, keyed by its actual detected ABI so
 * native-bootstrap.js can pick the right one at runtime. Skips a target
 * whose ABI turns out identical to one already fetched (harmless
 * duplicate work otherwise, since several Node majors can share an ABI).
 */
function fetchAbiPrebuilds(betterSqlite3Root, dest, platform, arch) {
  const releaseDir = path.join(dest, 'build', 'Release');
  fs.mkdirSync(releaseDir, { recursive: true });
  // copyRuntimePackage() may have carried over a previous local dev build's
  // plain `better_sqlite3.node` (from betterSqlite3Root's own build/
  // output) — remove it so native-bootstrap.js's "already resolved, nothing
  // to select" short-circuit never accidentally applies to a packaged
  // .vsix, which must always pick an ABI variant at runtime.
  fs.rmSync(path.join(releaseDir, 'better_sqlite3.node'), { force: true });
  const prebuildInstallBin = require.resolve('prebuild-install/bin.js', { paths: [betterSqlite3Root] });
  const seenAbis = new Set();
  const fetched = [];

  const targets = [
    { runtime: 'electron', version: VSCODE_ELECTRON_VERSION, label: `electron-v${VSCODE_ELECTRON_VERSION}` },
    ...BUNDLED_NODE_VERSIONS.map((v) => ({ runtime: 'node', version: v, label: `node-v${v}` })),
  ];

  for (const t of targets) {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'better-sqlite3-abi-'));
    try {
      fs.cpSync(path.join(betterSqlite3Root, 'package.json'), path.join(scratchDir, 'package.json'));
      let builtBinding;
      try {
        execFileSync(
          process.execPath,
          [prebuildInstallBin, '--runtime', t.runtime, '--target', t.version, '--platform', platform, '--arch', arch],
          { cwd: scratchDir, stdio: 'inherit' },
        );
        builtBinding = path.join(scratchDir, 'build', 'Release', 'better_sqlite3.node');
      } catch (err) {
        // No prebuilt asset published for this exact version yet (common
        // right after a new Node major ships). Only recoverable by
        // compiling from source when targeting the *current* host's own
        // platform/arch (node-gyp can't meaningfully cross-compile here),
        // and only for plain `node` targets (compiling against Electron's
        // headers needs @electron/rebuild, out of scope for this fallback).
        if (t.runtime !== 'node' || platform !== process.platform || arch !== process.arch) {
          console.log(
            `Skipping ${t.label} for ${platform}-${arch}: no prebuild available and can't compile from source ` +
              `for a non-host platform/arch or non-node runtime here. (${err.message})`,
          );
          continue;
        }
        console.log(`No prebuilt binary available for ${t.label} (${err.message}). Compiling from source instead...`);
        const compiled = compileNodeRuntimeBinary(betterSqlite3Root, t.version);
        try {
          builtBinding = path.join(scratchDir, 'build', 'Release', 'better_sqlite3.node');
          fs.mkdirSync(path.dirname(builtBinding), { recursive: true });
          fs.copyFileSync(compiled.builtBinding, builtBinding);
        } finally {
          fs.rmSync(compiled.buildDir, { recursive: true, force: true });
        }
      }
      assertValidNativeBinary(builtBinding, platform);
      const abi = detectAbi(process.execPath, builtBinding);
      if (seenAbis.has(abi)) {
        console.log(`Skipping ${t.label} prebuild for ${platform}-${arch}: ABI ${abi} already bundled.`);
        continue;
      }
      const finalPath = path.join(releaseDir, `better_sqlite3.abi${abi}.node`);
      fs.copyFileSync(builtBinding, finalPath);
      seenAbis.add(abi);
      fetched.push(`${t.label} (ABI ${abi})`);
      console.log(`Fetched better-sqlite3 ${t.label} prebuild for ${platform}-${arch} -> ABI ${abi}`);
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  }

  if (fetched.length === 0) {
    throw new Error(`Failed to fetch any better-sqlite3 prebuild for ${platform}-${arch}.`);
  }
  console.log(`Bundled ${fetched.length} better-sqlite3 ABI variant(s) for ${platform}-${arch}: ${fetched.join(', ')}`);
}

/** Copies the plain-CJS native-bootstrap.js (package.json's "main") into dist/ verbatim (no esbuild transform needed/wanted). */
function copyNativeBootstrap() {
  fs.copyFileSync(path.join(__dirname, 'src', 'native-bootstrap.js'), path.join(__dirname, 'dist', 'native-bootstrap.js'));
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
 *
 * `nodeBin` defaults to whatever Node is running this build script, but is
 * overridden to a detected VS Code Server Node binary when one is running
 * (see findRunningVscodeServerNode()) — that's the Node that will actually
 * load this binary, and may differ from the build-time Node.
 */
function verifyLocalBundleLoads(destNodeModules, nodeBin = process.execPath) {
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
  execFileSync(nodeBin, ['-e', script], { stdio: 'inherit' });
  console.log(`Verified the bundled better-sqlite3 native binding loads and works (under ${nodeBin}).`);
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

  // For the local dev path (no --vsce-target), this is the Node binary that
  // will actually load the bundled binary at runtime: a running VS Code
  // Server instance's own Node if one is detected (see
  // findRunningVscodeServerNode()), otherwise whatever Node is running this
  // build script.
  const verifyNodeBin = !vsceTarget ? findRunningVscodeServerNode() || process.execPath : null;

  if (vsceTarget) {
    const [platform, arch] = vsceTarget.split('-');
    if (!platform || !arch) {
      throw new Error(`--vsce-target must be "<platform>-<arch>" (e.g. "darwin-arm64"), got "${vsceTarget}"`);
    }
    // Bundle every ABI variant this .vsix should support (Electron desktop +
    // curated Node.js/VS Code Server versions) rather than just one, so the
    // package works whether VS Code loads it on Electron's bundled Node or
    // on Remote-SSH/Tunnels/Codespaces/WSL's plain Node.js. No single
    // `better_sqlite3.node` is written here — native-bootstrap.js (copied
    // into dist/ separately, see copyNativeBootstrap()) picks the right
    // `better_sqlite3.abi<N>.node` at runtime based on the actual ABI in use.
    fetchAbiPrebuilds(betterSqlite3Root, dest, platform, arch);
  } else {
    // Local dev build: normally just reuse whatever native binary is already
    // installed/built for the current machine (via pnpm's normal
    // install/rebuild step). But when developing through VS Code
    // Server (Remote-SSH/Tunnels/Codespaces), the process that actually
    // loads this binary is VS Code Server's *own* bundled Node — which
    // silently drifts out of sync with whatever `node` is on $PATH here.
    // Detect that mismatch and fetch a matching prebuilt binary instead of
    // shipping one that will fail with a NODE_MODULE_VERSION mismatch
    // ("Module did not self-register") at runtime.
    const nativeBinding = path.join(betterSqlite3Root, 'build', 'Release', 'better_sqlite3.node');
    if (!fs.existsSync(nativeBinding)) {
      throw new Error(
        `better-sqlite3 native binding not found at ${nativeBinding}. Run "pnpm rebuild better-sqlite3" first.`,
      );
    }

    if (verifyNodeBin !== process.execPath && !nativeBindingLoadsUnder(verifyNodeBin, nativeBinding)) {
      const serverNodeVersion = nodeVersionOf(verifyNodeBin);
      console.log(
        `Detected a running VS Code Server Node runtime (v${serverNodeVersion}) whose ABI doesn't match the ` +
          `locally-built better-sqlite3 binary. Fetching a prebuilt binary for that Node version instead...`,
      );
      const prebuildInstallBin = require.resolve('prebuild-install/bin.js', { paths: [betterSqlite3Root] });
      try {
        // Fetch into `dest` itself (dist/node_modules/better-sqlite3, which
        // copyRuntimePackage() already populated with package.json etc.) —
        // prebuild-install needs to run from a directory containing the
        // package's package.json to resolve the download URL.
        fetchNodeRuntimePrebuild(dest, prebuildInstallBin, serverNodeVersion, process.platform, process.arch);
        assertValidNativeBinary(nativeBindingDest, process.platform);
      } catch (err) {
        // No prebuilt binary published for this exact Node version yet
        // (common right after a new Node major ships) — fall back to
        // compiling from source against it.
        console.log(
          `No prebuilt binary available for Node v${serverNodeVersion} (${err.message}). Compiling ` +
            `better-sqlite3 from source against it instead...`,
        );
        const { builtBinding, buildDir } = compileNodeRuntimeBinary(betterSqlite3Root, serverNodeVersion);
        try {
          assertValidNativeBinary(builtBinding, process.platform);
          fs.copyFileSync(builtBinding, nativeBindingDest);
        } finally {
          fs.rmSync(buildDir, { recursive: true, force: true });
        }
      }
    } else {
      fs.copyFileSync(nativeBinding, nativeBindingDest);
    }
  }

  console.log(`Copied better-sqlite3 + bindings runtime files into ${path.relative(__dirname, destNodeModules)}`);

  if (verifyNodeBin) {
    verifyLocalBundleLoads(destNodeModules, verifyNodeBin);
  }
}

async function main() {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    copyBetterSqlite3Runtime();
    copyNativeBootstrap();
  } else {
    await esbuild.build(options);
    copyBetterSqlite3Runtime();
    copyNativeBootstrap();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

