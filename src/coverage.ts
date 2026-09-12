import type {
  AuditRole,
  CoverageOptions,
  CoverageProblem,
  CoverageReport,
  CoverageRow,
  SqlExecutor,
  UnprotectedTable,
} from "./types.js";

/**
 * Ordinary and partitioned tables in the given schemas, with what Postgres knows
 * about their protection. Views, matviews, sequences and foreign tables are out:
 * RLS does not apply to them.
 */
const COVERAGE_SQL = `
  SELECT n.nspname                                            AS schema,
         c.relname                                            AS table,
         c.relrowsecurity                                     AS rls_enabled,
         c.relforcerowsecurity                                AS rls_forced,
         (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policy_count
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p')
     AND n.nspname = ANY($1::text[])
   ORDER BY n.nspname, c.relname
`;

const ROLE_SQL = `
  SELECT current_user::text AS name,
         rolsuper            AS superuser,
         rolbypassrls        AS bypass_rls
    FROM pg_roles
   WHERE rolname = current_user
`;

/** Who we are, and whether that makes the rest of the audit meaningless. */
export async function auditRole(client: SqlExecutor): Promise<AuditRole> {
  const { rows } = await client.query<{
    name: string;
    superuser: boolean;
    bypass_rls: boolean;
  }>(ROLE_SQL);
  const row = rows[0];
  const superuser = row?.superuser ?? false;
  const bypassRls = row?.bypass_rls ?? false;
  return {
    name: row?.name ?? "unknown",
    superuser,
    bypassRls,
    bypasses: superuser || bypassRls,
  };
}

interface RawRow {
  schema: string;
  table: string;
  rls_enabled: boolean;
  rls_forced: boolean;
  policy_count: number;
}

/** Worst first: exposed data beats a table that is merely misconfigured shut. */
const SEVERITY: Record<CoverageProblem, number> = {
  "no-rls": 0,
  "not-forced": 1,
  "no-policies": 2,
};

function classify(row: CoverageRow, allowUnforced: boolean): UnprotectedTable | undefined {
  if (!row.rlsEnabled) {
    return {
      ...row,
      problem: "no-rls",
      reason: "row-level security is not enabled — every row is readable by any role",
    };
  }
  if (!row.rlsForced && !allowUnforced) {
    return {
      ...row,
      problem: "not-forced",
      reason:
        "RLS is enabled but not FORCED — the table owner bypasses it, " +
        "and most applications connect as the owner of their own tables",
    };
  }
  if (row.policyCount === 0) {
    return {
      ...row,
      problem: "no-policies",
      reason: "RLS is enabled with no policy — every query against this table returns nothing",
    };
  }
  return undefined;
}

/** Reads the protection state of every table, without judging it. */
export async function rlsCoverage(
  client: SqlExecutor,
  options: CoverageOptions = {},
): Promise<CoverageReport> {
  const schemas = options.schemas ?? ["public"];
  const excluded = new Set(options.exclude ?? []);

  const role = await auditRole(client);
  const { rows: raw } = await client.query<RawRow>(COVERAGE_SQL, [schemas]);

  const rows: CoverageRow[] = raw
    .map((r) => ({
      schema: r.schema,
      table: r.table,
      rlsEnabled: r.rls_enabled,
      rlsForced: r.rls_forced,
      policyCount: Number(r.policy_count),
    }))
    .filter((r) => !excluded.has(r.table) && !excluded.has(`${r.schema}.${r.table}`));

  const unprotected = rows
    .map((row) => classify(row, options.allowUnforced ?? false))
    .filter((x): x is UnprotectedTable => x !== undefined)
    .sort(
      (a, b) =>
        SEVERITY[a.problem] - SEVERITY[b.problem] ||
        `${a.schema}.${a.table}`.localeCompare(`${b.schema}.${b.table}`),
    );

  const roleInvalidates = role.bypasses && !(options.allowBypassingRole ?? false);
  return { role, rows, unprotected, ok: unprotected.length === 0 && !roleInvalidates };
}

/** Thrown by `assertFullRlsCoverage`. Carries the report so a reporter can use it. */
export class RlsCoverageError extends Error {
  readonly report: CoverageReport;

  constructor(report: CoverageReport) {
    super(formatCoverage(report));
    this.name = "RlsCoverageError";
    this.report = report;
  }
}

/** The failure message. Written to be read in CI output, where nobody is debugging. */
export function formatCoverage(report: CoverageReport): string {
  if (report.ok) {
    return `pgrls: all ${report.rows.length} tables are protected.`;
  }

  // The role check comes first: if the connection ignores policies, nothing below
  // it is evidence of anything.
  const preamble: string[] = [];
  if (report.role.bypasses) {
    const why = report.role.superuser ? "a superuser" : "a role with BYPASSRLS";
    preamble.push(
      `pgrls: this audit ran as ${JSON.stringify(report.role.name)}, ${why}.`,
      "",
      "  Row-level security is never applied to such a role, so every table below",
      "  reports as protected whether it is or not. Re-run as the role your",
      "  application actually connects with, or pass allowBypassingRole to accept",
      "  a report that proves nothing about this connection.",
      "",
    );
    if (report.unprotected.length === 0) return preamble.join("\n");
  }

  const width = Math.max(...report.unprotected.map((t) => `${t.schema}.${t.table}`.length));
  const lines = report.unprotected.map(
    (t) => `  ✗ ${`${t.schema}.${t.table}`.padEnd(width)}  ${t.reason}`,
  );

  return [
    ...preamble,
    `pgrls: ${report.unprotected.length} of ${report.rows.length} tables are not protected.`,
    "",
    ...lines,
    "",
  ].join("\n");
}

/**
 * Fails if any table is unprotected. One line in a test suite, and the thing this
 * library exists for:
 *
 * ```ts
 * test("every table is protected", async () => {
 *   await assertFullRlsCoverage(client);
 * });
 * ```
 *
 * It asks Postgres rather than reading your schema file, so it sees what actually
 * shipped — including the table someone added in a migration and forgot to write
 * a policy for, which is the one that matters.
 */
export async function assertFullRlsCoverage(
  client: SqlExecutor,
  options: CoverageOptions = {},
): Promise<CoverageReport> {
  const report = await rlsCoverage(client, options);
  if (!report.ok) throw new RlsCoverageError(report);
  return report;
}
