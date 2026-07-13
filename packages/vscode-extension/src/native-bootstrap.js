// Runs *before* anything else in the extension, as the package.json "main"
// entry point — deliberately a small plain CommonJS file (not run through
// esbuild's bundle) so it executes ahead of the top-level
// `import { findWorkspaceRoot } from '@ariadne-dev/core'` in extension.ts,
// which is what actually pulls in better-sqlite3's native binding.
//
// Why this exists: the same .vsix must work whether VS Code loads the
// extension host on Electron's bundled Node (plain desktop install) or on
// VS Code Server's own plain Node.js (Remote-SSH/Tunnels/Codespaces/WSL) —
// and those two runtimes commonly have different NODE_MODULE_VERSION ABIs,
// even at the same nominal VS Code version. A better-sqlite3 binary built
// for one fails to load under the other with an opaque "Module did not
// self-register" / NODE_MODULE_VERSION mismatch error.
//
// esbuild.js's packaging step (see fetchAbiPrebuilds()) bundles one
// better-sqlite3 native binary *per ABI* it could plausibly run under,
// named `better_sqlite3.abi<N>.node`. This bootstrap picks the one matching
// the ABI of whatever process is actually running right now
// (`process.versions.modules`) and copies it into place as the plain
// `better_sqlite3.node` filename that the `bindings` package (used by
// better-sqlite3's lib/database.js) looks for — before anything requires
// better-sqlite3 for the first time.
const fs = require('fs');
const path = require('path');

function selectNativeBinding() {
  const abi = process.versions.modules;
  const releaseDir = path.join(__dirname, 'node_modules', 'better-sqlite3', 'build', 'Release');
  const target = path.join(releaseDir, 'better_sqlite3.node');
  const candidate = path.join(releaseDir, `better_sqlite3.abi${abi}.node`);

  if (fs.existsSync(target)) {
    // Local dev build (esbuild.js run without --vsce-target): only one
    // binary was ever fetched/built, already verified against this exact
    // machine's runtime — nothing to select between.
    return;
  }

  if (!fs.existsSync(candidate)) {
    const available = fs.existsSync(releaseDir)
      ? fs.readdirSync(releaseDir).filter((f) => f.startsWith('better_sqlite3.abi'))
      : [];
    throw new Error(
      `Ariadne: no bundled better-sqlite3 native binding for this runtime's NODE_MODULE_VERSION (${abi}). ` +
        `Bundled ABIs: ${available.length ? available.join(', ') : '(none found)'}. ` +
        `This VS Code/Node combination isn't covered by the packaged .vsix yet — see esbuild.js's ABI_TARGETS.`,
    );
  }

  fs.copyFileSync(candidate, target);
}

selectNativeBinding();

module.exports = require('./extension.bundle.js');
