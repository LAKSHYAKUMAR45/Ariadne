import { EventEmitter } from 'node:events';
import { watch, type FSWatcher, promises as fs } from 'node:fs';
import path from 'node:path';
import { scanKnowledgeSources } from './KnowledgeSourceScanner.js';
import type { SourceCandidate } from './KnowledgeSourceScanner.js';
import type { SourcePolicy } from './SourcePolicy.js';

export type KnowledgeSourceWatchEventType = 'created' | 'changed' | 'deleted' | 'renamed';

export interface KnowledgeSourceWatchEvent {
  type: KnowledgeSourceWatchEventType;
  path: string;
  absolutePath: string;
  directory: string;
  previousPath?: string;
}

export interface KnowledgeSourceWatcherOptions {
  debounceMs?: number;
}

interface WatchedSource {
  candidate: SourceCandidate;
  identity: string;
  modifiedAtMs: number;
}

const DEFAULT_DEBOUNCE_MS = 100;

/**
 * Watches a source root without making filesystem failures fatal to callers.
 * Subscribe to the named lifecycle events and `error` before calling start().
 */
export class KnowledgeSourceWatcher extends EventEmitter {
  private readonly debounceMs: number;
  private readonly directoryWatchers = new Map<string, FSWatcher>();
  private readonly sources = new Map<string, WatchedSource>();
  private debounceTimer: NodeJS.Timeout | undefined;
  private started = false;

  public constructor(
    private readonly root: string,
    private readonly policy: SourcePolicy,
    options: KnowledgeSourceWatcherOptions = {},
  ) {
    super();
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  public async start(): Promise<void> {
    if (this.started) return;

    try {
      await this.refreshSnapshot();
      await this.refreshDirectoryWatchers();
      this.started = true;
    } catch (error) {
      this.stop();
      this.reportError(error);
    }
  }

  public stop(): void {
    this.started = false;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    for (const watcher of this.directoryWatchers.values()) watcher.close();
    this.directoryWatchers.clear();
  }

  private async refreshSnapshot(): Promise<void> {
    const snapshot = await this.createSnapshot();
    this.sources.clear();
    for (const [sourcePath, source] of snapshot) this.sources.set(sourcePath, source);
  }

  private async reconcile(): Promise<void> {
    if (!this.started) return;
    try {
      const current = await this.createSnapshot();
      const removed = [...this.sources.entries()].filter(([sourcePath]) => !current.has(sourcePath));
      const added = [...current.entries()].filter(([sourcePath]) => !this.sources.has(sourcePath));
      const renamedOldPaths = new Set<string>();
      const renamedNewPaths = new Set<string>();

      for (const [oldPath, oldSource] of removed) {
        const renamed = added.find(
          ([newPath, newSource]) =>
            !renamedNewPaths.has(newPath) && oldSource.identity === newSource.identity,
        );
        if (!renamed) continue;
        const [newPath, newSource] = renamed;
        renamedOldPaths.add(oldPath);
        renamedNewPaths.add(newPath);
        this.emitSource('renamed', newSource.candidate, oldPath);
      }

      for (const [sourcePath, source] of added) {
        if (!renamedNewPaths.has(sourcePath)) this.emitSource('created', source.candidate);
      }
      for (const [sourcePath, source] of removed) {
        if (!renamedOldPaths.has(sourcePath)) this.emitSource('deleted', source.candidate);
      }
      for (const [sourcePath, source] of current) {
        const previous = this.sources.get(sourcePath);
        if (
          previous &&
          (previous.modifiedAtMs !== source.modifiedAtMs || previous.candidate.size !== source.candidate.size)
        ) {
          this.emitSource('changed', source.candidate);
        }
      }

      this.sources.clear();
      for (const [sourcePath, source] of current) this.sources.set(sourcePath, source);
      await this.refreshDirectoryWatchers();
    } catch (error) {
      this.reportError(error);
    }
  }

  private async createSnapshot(): Promise<Map<string, WatchedSource>> {
    const candidates = await scanKnowledgeSources(this.root, this.policy);
    const snapshot = new Map<string, WatchedSource>();
    for (const candidate of candidates) {
      const stats = await fs.stat(candidate.absolutePath);
      snapshot.set(candidate.path, {
        candidate,
        identity: `${stats.dev}:${stats.ino}`,
        modifiedAtMs: stats.mtimeMs,
      });
    }
    return snapshot;
  }

  private async refreshDirectoryWatchers(): Promise<void> {
    const root = path.resolve(this.root);
    const directories = await this.listDirectories(root);
    for (const directory of directories) {
      if (this.directoryWatchers.has(directory)) continue;
      const watcher = watch(directory, () => this.scheduleReconcile());
      watcher.on('error', (error) => this.reportError(error));
      this.directoryWatchers.set(directory, watcher);
    }
    for (const [directory, watcher] of this.directoryWatchers) {
      if (!directories.has(directory)) {
        watcher.close();
        this.directoryWatchers.delete(directory);
      }
    }
  }

  private async listDirectories(root: string): Promise<Set<string>> {
    const directories = new Set<string>([root]);
    const visit = async (directory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = path.join(directory, entry.name);
        directories.add(child);
        await visit(child);
      }
    };
    await visit(root);
    return directories;
  }

  private scheduleReconcile(): void {
    if (!this.started) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      void this.reconcile();
    }, this.debounceMs);
  }

  private emitSource(
    type: KnowledgeSourceWatchEventType,
    candidate: SourceCandidate,
    previousPath?: string,
  ): void {
    this.emit(type, {
      type,
      path: candidate.path,
      absolutePath: candidate.absolutePath,
      directory: candidate.directory,
      ...(previousPath ? { previousPath } : {}),
    } satisfies KnowledgeSourceWatchEvent);
  }

  private reportError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (this.listenerCount('error') > 0) this.emit('error', normalized);
  }
}
