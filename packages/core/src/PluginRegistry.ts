import type { Checkpoint, Decision, OpenQuestion, Task, TaskError, TaskStatus, Todo } from './types.js';

/**
 * Ariadne plugin platform (Phase 5, docs/04-ROADMAP.md §5): a minimal,
 * dependency-free event-bus so third-party plugins (Jira/GitHub Issues/
 * Linear/Slack sync, Obsidian export, local-LLM summarization, etc.) can
 * observe task lifecycle events without core needing to know about any of
 * them. This is intentionally *not* wired into the CLI/MCP server/VS Code
 * extension yet — those call sites deciding when/whether to construct a
 * `PluginRegistry` and call `emit(...)` is a separate, call-site-by-call-site
 * change. This module only establishes the interface and in-process
 * dispatcher.
 *
 * Design notes:
 * - Events are fire-and-forget and best-effort: a plugin hook may return a
 *   Promise, but `emit` does not block callers waiting on plugin work, and a
 *   throwing/rejecting plugin never breaks core behavior or other plugins
 *   (see `emit`'s try/catch-per-hook loop).
 * - Plugins are plain objects (`AriadnePlugin`), not classes, so they're
 *   trivial to define, test, and tree-shake — see
 *   `packages/plugins/console-logger` for the reference implementation.
 */

/** The discrete lifecycle moments a plugin can observe. */
export interface AriadnePluginEvents {
  'checkpoint.created': { task: Task; checkpoint: Checkpoint };
  'task.statusChanged': { task: Task; previousStatus: TaskStatus; status: TaskStatus };
  'todo.added': { task: Task; todo: Todo };
  'decision.added': { task: Task; decision: Decision };
  'error.added': { task: Task; error: TaskError };
  'question.added': { task: Task; question: OpenQuestion };
}

export type AriadneEventName = keyof AriadnePluginEvents;

/** A single plugin's set of event handlers. All handlers are optional. */
export type PluginHooks = {
  [K in AriadneEventName]?: (payload: AriadnePluginEvents[K]) => void | Promise<void>;
};

/**
 * Context passed to a plugin's `activate` function. `workspaceRoot` lets a
 * plugin locate/read its own config (e.g. `.ariadne/plugins/<name>.json`)
 * without core needing a generic config-loading mechanism yet.
 */
export interface AriadnePluginContext {
  workspaceRoot: string;
}

/**
 * The unit third-party code implements. `activate` is called once when the
 * plugin is registered and returns the hooks it wants to subscribe to (or
 * nothing, if the plugin has no event-based behavior — e.g. a pure
 * summarizer plugin used directly by `CheckpointEngine` rather than via
 * events).
 */
export interface AriadnePlugin {
  name: string;
  version?: string;
  activate: (context: AriadnePluginContext) => PluginHooks | void;
}

/**
 * In-process registry: holds activated plugins' hooks and dispatches
 * `emit(...)` calls to every plugin that subscribed to that event name.
 */
export class PluginRegistry {
  private readonly hooksByEvent: Map<AriadneEventName, Array<{ pluginName: string; hook: (payload: never) => void | Promise<void> }>> =
    new Map();
  private readonly registered: AriadnePlugin[] = [];

  constructor(private readonly context: AriadnePluginContext) {}

  /** Activates a plugin and subscribes any hooks it returns. Idempotent per plugin name. */
  register(plugin: AriadnePlugin): void {
    if (this.registered.some((p) => p.name === plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered.`);
    }
    const hooks = plugin.activate(this.context) ?? {};
    for (const [eventName, hook] of Object.entries(hooks) as Array<[AriadneEventName, (payload: never) => void | Promise<void>]>) {
      const list = this.hooksByEvent.get(eventName) ?? [];
      list.push({ pluginName: plugin.name, hook });
      this.hooksByEvent.set(eventName, list);
    }
    this.registered.push(plugin);
  }

  /** Names of all currently registered plugins, in registration order. */
  listPlugins(): string[] {
    return this.registered.map((p) => p.name);
  }

  /**
   * Dispatches `payload` to every plugin subscribed to `eventName`. Each
   * hook is invoked independently; a synchronous throw or rejected Promise
   * from one plugin is swallowed (surfaced only via the returned settled
   * results) so a single misbehaving plugin can't break core behavior or
   * other plugins.
   */
  async emit<K extends AriadneEventName>(
    eventName: K,
    payload: AriadnePluginEvents[K],
  ): Promise<Array<{ pluginName: string; error?: unknown }>> {
    const subscribers = this.hooksByEvent.get(eventName) ?? [];
    const results = await Promise.allSettled(
      subscribers.map(({ hook }) => Promise.resolve().then(() => hook(payload as never))),
    );
    return results.map((result, i) => ({
      pluginName: subscribers[i].pluginName,
      error: result.status === 'rejected' ? result.reason : undefined,
    }));
  }
}
