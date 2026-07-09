/**
 * Shared domain types for Ariadne's core store. These mirror the SQLite
 * schema in schema.ts (see docs/03-DATA-MODEL.md).
 */

export type TaskStatus = 'active' | 'paused' | 'done' | 'archived';
export type CheckpointLevel = 'micro' | 'session' | 'milestone';
export type FileRole = 'edited' | 'read' | 'created' | 'deleted';
export type TodoStatus = 'pending' | 'done' | 'blocked';

export interface Task {
  id: string;
  title: string;
  goal: string | null;
  status: TaskStatus;
  parentTaskId: string | null;
  branch: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewTask {
  title: string;
  goal?: string | null;
  status?: TaskStatus;
  parentTaskId?: string | null;
  branch?: string | null;
}

export interface Checkpoint {
  id: string;
  taskId: string;
  parentCheckpointId: string | null;
  level: CheckpointLevel;
  summary: string;
  createdAt: string;
}

export interface NewCheckpoint {
  taskId: string;
  parentCheckpointId?: string | null;
  level: CheckpointLevel;
  summary: string;
}

export interface TaskFile {
  taskId: string;
  path: string;
  role: FileRole;
  lastTouched: string;
}

export interface Commit {
  sha: string;
  taskId: string;
  checkpointId: string | null;
  message: string | null;
  createdAt: string;
}

export interface NewCommit {
  sha: string;
  taskId: string;
  checkpointId?: string | null;
  message?: string | null;
}

export interface Decision {
  id: string;
  taskId: string;
  checkpointId: string | null;
  text: string;
  rationale: string | null;
  supersedesId: string | null;
  createdAt: string;
}

export interface NewDecision {
  taskId: string;
  checkpointId?: string | null;
  text: string;
  rationale?: string | null;
  supersedesId?: string | null;
}

export interface Todo {
  id: string;
  taskId: string;
  text: string;
  status: TodoStatus;
  sourceCheckpointId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewTodo {
  taskId: string;
  text: string;
  status?: TodoStatus;
  sourceCheckpointId?: string | null;
}

export interface Command {
  id: string;
  taskId: string;
  cmdRedacted: string;
  exitCode: number | null;
  summary: string | null;
  createdAt: string;
}

export interface NewCommand {
  taskId: string;
  cmdRedacted: string;
  exitCode?: number | null;
  summary?: string | null;
}

export interface TaskError {
  id: string;
  taskId: string;
  message: string;
  resolved: boolean;
  resolution: string | null;
  createdAt: string;
}

export interface NewTaskError {
  taskId: string;
  message: string;
  resolved?: boolean;
  resolution?: string | null;
}

export interface OpenQuestion {
  id: string;
  taskId: string;
  text: string;
  resolved: boolean;
  createdAt: string;
}

export interface NewOpenQuestion {
  taskId: string;
  text: string;
  resolved?: boolean;
}
