import { getTableConfig } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core";
import { definePolicy } from "./policy.js";
import type { PolicySpec, TableRef, TenantPolicyOptions } from "./types.js";

/**
 * The schema and name Postgres knows a Drizzle table by.
 *
 * Drizzle leaves `schema` undefined for the default schema rather than saying
 * "public", so it is filled in here — every query in this library qualifies its
 * table names, and an undefined schema would silently target the wrong one.
 */
export function tableRef(table: PgTable): TableRef {
  const config = getTableConfig(table);
  return { schema: config.schema ?? "public", name: config.name };
}

/**
 * Declares tenant isolation for a Drizzle table, so the policy lives beside the
 * table it protects and travels with it in review:
 *
 * ```ts
 * export const invoice = pgTable("invoice", { … });
 * export const invoicePolicy = rls(invoice, { tenantColumn: "org_id" });
 * ```
 *
 * The `tenantColumn` is the **database** column name, not the TypeScript key,
 * because that is what the generated SQL has to reference.
 */
export function rls(table: PgTable, options: TenantPolicyOptions): PolicySpec {
  return definePolicy(tableRef(table), options);
}

export { policySql, dropPolicySql, applyPolicy } from "./policy.js";
export type { PolicySpec, TenantPolicyOptions } from "./types.js";
