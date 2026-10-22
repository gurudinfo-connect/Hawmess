import { Pool, types } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

// node-postgres returns NUMERIC / BIGINT (COUNT) as strings by default; parse them centrally.
types.setTypeParser(1700, (val: string) => parseFloat(val)); // NUMERIC
types.setTypeParser(1082, (val: string) => val); // DATE stays 'YYYY-MM-DD' (no timezone shifting)
types.setTypeParser(20, (val: string) => parseInt(val, 10)); // BIGINT (e.g. COUNT(*))

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://hawmess_tickets:4264caba53d154f2e17542e514119a0bef49eee86ce2487f@localhost:5433/hawmess_tickets',
  max: 10,
});

// Helper to run a query
export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

// Helper to run inside a transaction. Caller gets a client with query() bound.
export async function withTransaction<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
