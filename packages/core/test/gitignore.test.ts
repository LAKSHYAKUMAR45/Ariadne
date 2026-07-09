import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ensureGitignored } from '../src/gitignore.js';

describe('ensureGitignored', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-gitignore-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('creates a .gitignore with .ariadne/ if none exists', () => {
    ensureGitignored(root);
    const contents = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(contents).toContain('.ariadne/');
  });

  it('appends .ariadne/ to an existing .gitignore that lacks it', () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\ndist/\n', 'utf8');
    ensureGitignored(root);
    const contents = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(contents).toContain('node_modules/');
    expect(contents).toContain('dist/');
    expect(contents).toContain('.ariadne/');
  });

  it('does not duplicate the entry if .ariadne/ is already ignored', () => {
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.ariadne/\n', 'utf8');
    ensureGitignored(root);
    const contents = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(contents.match(/\.ariadne\/?/g)?.length).toBe(1);
  });

  it('recognizes variant forms already covering .ariadne (no trailing slash, leading slash)', () => {
    for (const variant of ['.ariadne', '/.ariadne', '/.ariadne/']) {
      const variantRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ariadne-gitignore-variant-'));
      try {
        fs.writeFileSync(path.join(variantRoot, '.gitignore'), `${variant}\n`, 'utf8');
        ensureGitignored(variantRoot);
        const contents = fs.readFileSync(path.join(variantRoot, '.gitignore'), 'utf8');
        expect(contents.trim()).toBe(variant);
      } finally {
        fs.rmSync(variantRoot, { recursive: true, force: true });
      }
    }
  });

  it('is idempotent across repeated calls', () => {
    ensureGitignored(root);
    ensureGitignored(root);
    ensureGitignored(root);
    const contents = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(contents.match(/\.ariadne\/?/g)?.length).toBe(1);
  });

  it('does not throw if the workspace root does not exist', () => {
    expect(() => ensureGitignored(path.join(root, 'nonexistent-nested', 'deep'))).not.toThrow();
  });
});
