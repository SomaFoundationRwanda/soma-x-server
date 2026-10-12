import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export function createDb(databaseUrl: string): { db: Db; pool: pg.Pool } {
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
    pool.on('error', err => console.error('[db] idle client error', err));
    return { db: drizzle(pool, { schema }), pool };
}
