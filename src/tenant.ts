import type { SqlExecutor } from "./types.js";

export interface WithTenantOptions {
  /** The session setting to write. Must match the policies. Defaults to `pgrls.tenant`. */
  setting?: string;
}

/**
 * Runs `fn` inside a transaction with the tenant set, and clears it on the way out.
 *
 * The tenant is written with `set_config(name, value, true)` rather than
 * `SET LOCAL`. Two reasons, both load-bearing:
 *
 *  - `SET LOCAL` takes no bind parameters, so the tenant id would have to be
 *    interpolated into SQL. `set_config` is an ordinary function call, so the id
 *    travels as a parameter and cannot be anything but a value.
 *  - the third argument makes it *local to the transaction*. On a pooled
 *    connection a session-level setting outlives the request that set it, and the
 *    next borrower of that connection inherits someone else's tenant. That is the
 *    worst bug this library could have, so the API makes it unreachable: there is
 *    no way to set a tenant outside a transaction.
 *
 * The callback receives the same executor. Every query it makes is inside the
 * transaction, and therefore inside the tenant.
 */
export async function withTenant<T>(
  client: SqlExecutor,
  tenantId: string,
  fn: (tx: SqlExecutor) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> {
  const setting = options.setting ?? "pgrls.tenant";

  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config($1, $2, true)", [setting, tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    // A failed ROLLBACK must not mask the error that caused it.
    try {
      await client.query("ROLLBACK");
    } catch {
      /* the original error is the one worth reporting */
    }
    throw error;
  }
}

/**
 * Reads back the tenant Postgres currently sees. Returns null when none is set.
 *
 * Mostly useful in tests, and in the assertion that a connection really is
 * scoped before it is handed to application code.
 */
export async function currentTenant(
  client: SqlExecutor,
  options: WithTenantOptions = {},
): Promise<string | null> {
  const setting = options.setting ?? "pgrls.tenant";
  const { rows } = await client.query<{ tenant: string | null }>(
    "SELECT nullif(current_setting($1, true), '') AS tenant",
    [setting],
  );
  return rows[0]?.tenant ?? null;
}
