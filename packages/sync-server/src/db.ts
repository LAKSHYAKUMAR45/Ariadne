import { Pool } from 'pg';

/** Creates a pg connection pool for the given database URL. */
export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl });
}
