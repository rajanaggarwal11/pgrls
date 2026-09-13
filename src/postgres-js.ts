import type { Sql } from "postgres";
import type { SqlExecutor } from "./types.js";

/**
 * A pgrls executor over ONE reserved postgres.js connection.
 *
 * postgres.js pools by default, and a pool is not a connection. `withTenant`
 * runs `BEGIN`, then `set_config(…, true)`, then your callback's queries, and
 * expects all of them to land on the same connection. Over a naive adapter that
 * calls `sql.unsafe` on the pool, `BEGIN` goes to one connection and the next
 * query may go to another — the tenant is set somewhere nobody reads it, and
 * the policies quietly return nothing. No error. An empty result.
 *
 * `sql.reserve()` pins a single connection for the lifetime of this executor,
 * which is what makes a transaction a transaction. Release it when you are done,
 * or use `withPostgresJs`, which does that for you.
 */
export interface ReservedExecutor extends SqlExecutor {
  /** Hands the connection back to the pool. Call it in a `finally`. */
  release(): void;
}

export async function fromPostgresJs(sql: Sql): Promise<ReservedExecutor> {
  const conn = await sql.reserve();
  return {
    async query<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
      // postgres.js returns an array-like RowList; pgrls wants a plain array.
      const rows = await conn.unsafe(text, params as unknown as Parameters<typeof conn.unsafe>[1]);
      return { rows: Array.from(rows) as unknown as T[] };
    },
    release() {
      conn.release();
    },
  };
}

/**
 * Reserves a connection, runs `fn` on it, and releases it whatever happens.
 *
 * ```ts
 * await withPostgresJs(sql, (db) => assertFullRlsCoverage(db));
 * await withPostgresJs(sql, (db) => withTenant(db, orgId, (tx) => tx.query(…)));
 * ```
 */
export async function withPostgresJs<T>(sql: Sql, fn: (db: SqlExecutor) => Promise<T>): Promise<T> {
  const db = await fromPostgresJs(sql);
  try {
    return await fn(db);
  } finally {
    db.release();
  }
}
