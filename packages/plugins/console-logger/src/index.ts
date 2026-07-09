import type { AriadnePlugin } from '@ariadne-dev/core';

/**
 * Reference plugin: subscribes to every Ariadne lifecycle event and logs a
 * one-line, human-readable message to the console. Real plugins (Jira sync,
 * GitHub Issues sync, Slack notifications, Obsidian export, an LLM
 * summarizer, ...) follow the same shape — implement `activate` and return
 * the subset of hooks you care about.
 *
 * Usage:
 * ```ts
 * import { PluginRegistry } from '@ariadne-dev/core';
 * import { consoleLoggerPlugin } from '@ariadne-dev/plugin-console-logger';
 *
 * const registry = new PluginRegistry({ workspaceRoot });
 * registry.register(consoleLoggerPlugin);
 * await registry.emit('checkpoint.created', { task, checkpoint });
 * ```
 */
export const consoleLoggerPlugin: AriadnePlugin = {
  name: 'console-logger',
  version: '0.1.0',
  activate: () => ({
    'checkpoint.created': ({ task, checkpoint }) => {
      console.log(`[ariadne] checkpoint (${checkpoint.level}) on "${task.title}": ${checkpoint.summary}`);
    },
    'task.statusChanged': ({ task, previousStatus, status }) => {
      console.log(`[ariadne] task "${task.title}" status: ${previousStatus} -> ${status}`);
    },
    'todo.added': ({ task, todo }) => {
      console.log(`[ariadne] todo added to "${task.title}": ${todo.text}`);
    },
    'decision.added': ({ task, decision }) => {
      console.log(`[ariadne] decision recorded on "${task.title}": ${decision.text}`);
    },
    'error.added': ({ task, error }) => {
      console.log(`[ariadne] error recorded on "${task.title}": ${error.message}`);
    },
    'question.added': ({ task, question }) => {
      console.log(`[ariadne] open question on "${task.title}": ${question.text}`);
    },
  }),
};
