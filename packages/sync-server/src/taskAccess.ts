import type { Pool } from 'pg';
import { ApiError } from './errors.js';

export function inaccessibleTaskError(taskId: string): ApiError {
  return new ApiError(404, 'task_not_found', `No task with remoteId ${taskId}`);
}

export async function requireTeamTask(
  pool: Pool,
  teamId: string,
  taskId: string,
): Promise<void> {
  const { rows } = await pool.query(
    'SELECT 1 FROM tasks WHERE id = $1 AND team_id = $2',
    [taskId, teamId],
  );

  if (rows.length === 0) {
    throw inaccessibleTaskError(taskId);
  }
}
