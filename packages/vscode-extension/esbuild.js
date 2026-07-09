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

const watch = process.argv.includes('--watch');

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
  const nativeBinding = path.join(betterSqlite3Root, 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(nativeBinding)) {
    throw new Error(
      `better-sqlite3 native binding not found at ${nativeBinding}. Run "pnpm rebuild better-sqlite3" first.`,
    );
  }
  fs.mkdirSync(path.join(dest, 'build', 'Release'), { recursive: true });
  fs.copyFileSync(nativeBinding, path.join(dest, 'build', 'Release', 'better_sqlite3.node'));

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
