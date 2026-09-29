import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export function isPathWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertExistingPathWithinRoot(root: string, target: string, label: string): string {
  const canonicalRoot = realpathSync(root);
  const canonicalTarget = realpathSync(target);
  if (!isPathWithinRoot(canonicalRoot, canonicalTarget)) {
    throw new Error(`${label} must stay within the workspace`);
  }
  return canonicalTarget;
}

export function assertNoSymlinkComponents(root: string, target: string, label: string): void {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  try {
    if (lstatSync(absoluteRoot).isSymbolicLink()) {
      throw new Error(`${label} must not traverse symbolic links`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  if (!isPathWithinRoot(absoluteRoot, absoluteTarget)) {
    throw new Error(`${label} must stay within the output root`);
  }

  const relative = path.relative(absoluteRoot, absoluteTarget);
  let current = absoluteRoot;
  for (const component of relative ? relative.split(path.sep) : []) {
    current = path.join(current, component);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`${label} must not traverse symbolic links`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}
