/**
 * The minimum a database client has to expose. This is `pg`'s `Client`/`PoolClient`
 * shape, which `postgres.js`, `slonik` and a Drizzle session can all be wrapped to
 * match in a few lines — deliberately, so pgrls never depends on one driver.
 */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface TableRef {
  schema: string;
  name: string;
}

/** Which statements a policy covers. `ALL` is SELECT, INSERT, UPDATE and DELETE. */
export type PolicyCommand = "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE";

export interface TenantPolicyOptions {
  /** The column holding the tenant id, e.g. `org_id`. */
  tenantColumn: string;
  /** Defaults to `public`. */
  schema?: string;
  /** Defaults to `<table>_tenant_isolation`. */
  policyName?: string;
  /**
   * The session setting carrying the current tenant. Defaults to `pgrls.tenant`.
   * It must contain a dot — Postgres only allows custom settings inside a namespace.
   */
  setting?: string;
  /**
   * The type the setting is cast to before comparison. Defaults to `uuid`.
   * Settings are always text in Postgres, so this has to match the column's type.
   */
  castTo?: string;
  /** Defaults to `ALL`. */
  command?: PolicyCommand;
  /**
   * Whether to also `FORCE ROW LEVEL SECURITY`. Defaults to **true**, and you
   * almost certainly want it — see the note on `forceSql`.
   */
  force?: boolean;
  /**
   * Roles the policy applies to. Defaults to `PUBLIC`, which is every role that
   * is not exempt.
   */
  roles?: string[];
}

export interface PolicySpec {
  table: TableRef;
  policyName: string;
  tenantColumn: string;
  setting: string;
  castTo: string;
  command: PolicyCommand;
  force: boolean;
  roles: string[];
}

/** What Postgres reports about one table's protection. */
export interface CoverageRow {
  schema: string;
  table: string;
  /** `ALTER TABLE … ENABLE ROW LEVEL SECURITY` has been run. */
  rlsEnabled: boolean;
  /** `ALTER TABLE … FORCE ROW LEVEL SECURITY` has been run. */
  rlsForced: boolean;
  /** How many policies exist on the table. RLS with none denies everything. */
  policyCount: number;
}

/** Why a table counts as unprotected. Ordered worst-first. */
export type CoverageProblem = "no-rls" | "no-policies" | "not-forced";

export interface UnprotectedTable extends CoverageRow {
  problem: CoverageProblem;
  /** One line, stated so it can go straight into a test failure. */
  reason: string;
}

/**
 * The role the audit ran as. RLS is not applied to a superuser, nor to a role with
 * BYPASSRLS — no policy, and no amount of FORCE, changes that. So a report gathered
 * over such a connection describes tables that are protected *from somebody else*,
 * which is not what the caller asked.
 */
export interface AuditRole {
  name: string;
  superuser: boolean;
  bypassRls: boolean;
  /** True when this role ignores every policy in the database. */
  bypasses: boolean;
}

export interface CoverageReport {
  /** Who the audit ran as, and whether that invalidates it. */
  role: AuditRole;
  /** Every table considered, in schema then name order. */
  rows: CoverageRow[];
  /** The subset that failed, worst problem first. */
  unprotected: UnprotectedTable[];
  /** Convenience: `unprotected.length === 0`. */
  ok: boolean;
}

export interface CoverageOptions {
  /** Schemas to inspect. Defaults to `["public"]`. */
  schemas?: string[];
  /**
   * Tables to skip, as `name` or `schema.name`. Migration ledgers are the usual
   * case — `drizzle.__drizzle_migrations` is not tenant data.
   */
  exclude?: string[];
  /**
   * Treat a table with RLS enabled but not FORCED as protected. Defaults to false,
   * because an unforced table is wide open to its owner, which is how most
   * applications connect.
   */
  allowUnforced?: boolean;
  /**
   * Allow the audit to pass while running as a role that bypasses RLS. Defaults to
   * false: a green report gathered over a superuser connection is not evidence of
   * anything, and silently returning one is worse than failing.
   */
  allowBypassingRole?: boolean;
}
