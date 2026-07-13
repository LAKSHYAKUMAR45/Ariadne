#!/usr/bin/env node
// One-command build + global install for the Ariadne CLI.
//
//   pnpm run install:cli
//
// Builds @ariadne-dev/core and @ariadne-dev/cli, then `npm link`s the CLI
// package so the `ariadne` command is available globally.
import { log, ok, run, tryCapture, repoRoot } from './_lib.mjs';
import path from 'node:path';

log('Building @ariadne-dev/core and @ariadne-dev/cli');
run('pnpm --filter @ariadne-dev/core --filter @ariadne-dev/cli run build');

log('Linking the ariadne CLI globally (npm link)');
run('npm link', path.join(repoRoot, 'packages/cli'));

const version = tryCapture('ariadne --version');
const bin = tryCapture('command -v ariadne || which ariadne');
ok(`ariadne CLI installed${version ? ` (v${version})` : ''}${bin ? ` -> ${bin}` : ''}`);
console.log('\nTry it out:\n  ariadne task new "My first task"\n  ariadne status');
