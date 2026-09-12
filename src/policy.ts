import type { PolicySpec, TableRef, TenantPolicyOptions } from "./types.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Quotes an identifier, and refuses anything that is not one.
 *
 * Identifiers cannot be parameterised in Postgres, so they are interpolated —
 * which means every one of them is validated first. A table or column name that
 * reaches here from user input and is not a plain identifier is a bug worth
 * failing loudly on rather than escaping quietly.
 */
export function quoteIdent(value: string): string {
  if (!IDENT.test(value)) {
    throw new Error(
      `pgrls: ${JSON.stringify(value)} is not a plain SQL identifier. ` +
        `Identifiers are interpolated into DDL and cannot be parameterised, so only ` +
        `[A-Za-z_][A-Za-z0-9_$]* is accepted.`,
    );
  }
  return `"${value}"`;
}

/** Quotes a string literal for DDL, where a bind parameter is not allowed. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const DEFAULT_SETTING = "pgrls.tenant";

function checkSetting(setting: string): string {
  // Postgres only accepts custom settings inside a namespace: `SET LOCAL tenant`
  // is a syntax error, `SET LOCAL app.tenant` is not.
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(setting)) {
    throw new Error(
      `pgrls: setting ${JSON.stringify(setting)} must be a lower-case, dotted name ` +
        `such as "pgrls.tenant" — Postgres rejects custom settings outside a namespace.`,
    );
  }
  return setting;
}

function checkType(castTo: string): string {
  if (!/^[a-z_][a-z0-9_ ]*$/i.test(castTo)) {
    throw new Error(`pgrls: ${JSON.stringify(castTo)} is not a plain type name.`);
  }
  return castTo;
}

export function qualified(table: TableRef): string {
  return `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
}

/** Resolves the options into the full spec, applying every default. */
export function definePolicy(table: string | TableRef, options: TenantPolicyOptions): PolicySpec {
  const ref: TableRef =
    typeof table === "string"
      ? { schema: options.schema ?? "public", name: table }
      : { schema: options.schema ?? table.schema ?? "public", name: table.name };

  // Validate now, so a bad name fails where it was written rather than at migrate time.
  quoteIdent(ref.schema);
  quoteIdent(ref.name);
  quoteIdent(options.tenantColumn);

  return {
    table: ref,
    policyName: options.policyName ?? `${ref.name}_tenant_isolation`,
    tenantColumn: options.tenantColumn,
    setting: checkSetting(options.setting ?? DEFAULT_SETTING),
    castTo: checkType(options.castTo ?? "uuid"),
    command: options.command ?? "ALL",
    force: options.force ?? true,
    roles: options.roles ?? ["PUBLIC"],
  };
}

/**
 * The predicate both `USING` and `WITH CHECK` share.
 *
 * Three things have to line up for this to fail closed:
 *
 *  - `current_setting(…, true)` returns NULL instead of raising when the setting
 *    was never set at all;
 *  - `nullif(…, '')` turns the **empty string** into NULL. This is the one that
 *    bites: once a custom setting has been set inside a transaction and that
 *    transaction ends, the setting does not go away — it reverts to `''`. Casting
 *    `''` to uuid raises `invalid input syntax for type uuid: ""`, so without the
 *    nullif an unscoped query errors rather than returning nothing, and every
 *    second request on a pooled connection blows up;
 *  - `column = NULL` is NULL, which RLS reads as "no".
 *
 * The result is that a connection with no tenant sees an empty table, which is the
 * only safe answer.
 */
export function predicateSql(spec: PolicySpec): string {
  const setting = quoteLiteral(spec.setting);
  return (
    `${quoteIdent(spec.tenantColumn)} = ` +
    `nullif(current_setting(${setting}, true), '')::${spec.castTo}`
  );
}

/**
 * `ENABLE ROW LEVEL SECURITY` alone does nothing for the table's owner, and for
 * anyone with BYPASSRLS. Most applications connect as the owner of their own
 * tables, so a policy that looks correct protects nothing in production. `FORCE`
 * is what closes that, and it is why `force` defaults to true.
 */
export function forceSql(spec: PolicySpec): string[] {
  return spec.force
    ? [`ALTER TABLE ${qualified(spec.table)} FORCE ROW LEVEL SECURITY;`]
    : [`ALTER TABLE ${qualified(spec.table)} NO FORCE ROW LEVEL SECURITY;`];
}

/**
 * The statements that install a policy, in order.
 *
 * Idempotent by construction: the policy is dropped if it exists and recreated, so
 * the same migration can be re-run and a changed predicate actually takes effect.
 * `CREATE POLICY` has no `OR REPLACE`.
 */
export function policySql(spec: PolicySpec): string[] {
  const table = qualified(spec.table);
  const predicate = predicateSql(spec);
  const roles = spec.roles.map((r) => (r.toUpperCase() === "PUBLIC" ? "PUBLIC" : quoteIdent(r)));

  // INSERT accepts WITH CHECK and rejects USING; SELECT and DELETE are the reverse.
  const clauses: string[] = [];
  if (spec.command !== "INSERT") clauses.push(`  USING (${predicate})`);
  if (spec.command === "ALL" || spec.command === "INSERT" || spec.command === "UPDATE") {
    clauses.push(`  WITH CHECK (${predicate})`);
  }

  return [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`,
    ...forceSql(spec),
    `DROP POLICY IF EXISTS ${quoteIdent(spec.policyName)} ON ${table};`,
    `CREATE POLICY ${quoteIdent(spec.policyName)} ON ${table}\n` +
      `  AS PERMISSIVE\n` +
      `  FOR ${spec.command}\n` +
      `  TO ${roles.join(", ")}\n` +
      clauses.join("\n") +
      `;`,
  ];
}

/** The statements that remove a policy and stand the table down. */
export function dropPolicySql(spec: PolicySpec): string[] {
  const table = qualified(spec.table);
  return [
    `DROP POLICY IF EXISTS ${quoteIdent(spec.policyName)} ON ${table};`,
    `ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`,
  ];
}

/** Runs the policy statements against a client, in one transaction. */
export async function applyPolicy(
  client: { query: (text: string) => Promise<unknown> },
  spec: PolicySpec,
): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const statement of policySql(spec)) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
