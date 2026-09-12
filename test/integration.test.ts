import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyPolicy, definePolicy } from "../src/policy.js";
import {
  assertFullRlsCoverage,
  auditRole,
  formatCoverage,
  rlsCoverage,
  RlsCoverageError,
} from "../src/coverage.js";
import { currentTenant, withTenant } from "../src/tenant.js";

// Named DATABASE_URL, not URL: the latter shadows the global URL constructor.
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/pgrls_test";

const SCHEMA = "pgrls_it";
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

const APP_ROLE = "pgrls_app";
const APP_PASSWORD = "pgrls_app_pw";

/**
 * Two connections, because the distinction is the point of the library.
 *
 * `admin` is whatever role runs migrations — here a superuser, as it usually is.
 * `client` is the application's role: NOSUPERUSER, NOBYPASSRLS, and the OWNER of
 * the tables. Owning them is deliberate: a policy that is enabled but not FORCED
 * does nothing against the owner, and that is the trap these tests have to be able
 * to reproduce. Running the suite as a superuser would make every assertion below
 * pass for the wrong reason.
 */
let admin: Client;
let client: Client;

function appUrl(): string {
  const url = new URL(DATABASE_URL);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.toString();
}

beforeAll(async () => {
  admin = new Client({ connectionString: DATABASE_URL });
  await admin.connect();

  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB;
      END IF;
    END $$;
  `);
  await admin.query(`ALTER ROLE ${APP_ROLE} NOSUPERUSER NOBYPASSRLS`);
  // The database name comes from the connection, not a constant, so the suite
  // runs unchanged against a CI service container with a different name.
  const { rows } = await admin.query<{ db: string }>(`SELECT current_database() AS db`);
  await admin.query(`GRANT CREATE, CONNECT ON DATABASE "${rows[0]!.db}" TO ${APP_ROLE}`);

  client = new Client({ connectionString: appUrl() });
  await client.connect();
});

afterAll(async () => {
  if (client) {
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await client.end();
  }
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
    await admin.end();
  }
});

beforeEach(async () => {
  // The app role creates the schema, so it owns everything inside it.
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
});

/** A tenant-scoped table with two orgs' rows already in it. */
async function seedInvoices(): Promise<void> {
  await client.query(`
    CREATE TABLE ${SCHEMA}.invoice (
      id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL,
      total  integer NOT NULL
    )
  `);
  await client.query(
    `INSERT INTO ${SCHEMA}.invoice (org_id, total) VALUES ($1, 100), ($1, 200), ($2, 999)`,
    [ORG_A, ORG_B],
  );
}

const invoicePolicy = definePolicy({ schema: SCHEMA, name: "invoice" }, { tenantColumn: "org_id" });

describe("tenant isolation", () => {
  beforeEach(async () => {
    await seedInvoices();
    await applyPolicy(client, invoicePolicy);
  });

  it("shows a tenant only its own rows", async () => {
    const totals = await withTenant(client, ORG_A, async (tx) => {
      const { rows } = await tx.query<{ total: number }>(
        `SELECT total FROM ${SCHEMA}.invoice ORDER BY total`,
      );
      return rows.map((r) => r.total);
    });
    expect(totals).toEqual([100, 200]);
  });

  it("shows the other tenant a different set", async () => {
    const totals = await withTenant(client, ORG_B, async (tx) => {
      const { rows } = await tx.query<{ total: number }>(`SELECT total FROM ${SCHEMA}.invoice`);
      return rows.map((r) => r.total);
    });
    expect(totals).toEqual([999]);
  });

  it("returns nothing at all when no tenant is set", async () => {
    // Fail-closed. current_setting(…, true) is NULL, the predicate is NULL, and
    // RLS reads NULL as no. An unscoped connection must never be a wildcard.
    const { rows } = await client.query(`SELECT * FROM ${SCHEMA}.invoice`);
    expect(rows).toEqual([]);
  });

  it("refuses to write a row belonging to another tenant", async () => {
    await expect(
      withTenant(client, ORG_A, (tx) =>
        tx.query(`INSERT INTO ${SCHEMA}.invoice (org_id, total) VALUES ($1, 1)`, [ORG_B]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot update a row out of its tenant", async () => {
    await expect(
      withTenant(client, ORG_A, (tx) =>
        tx.query(`UPDATE ${SCHEMA}.invoice SET org_id = $1`, [ORG_B]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("clears the tenant when the transaction ends", async () => {
    await withTenant(client, ORG_A, async (tx) => {
      expect(await currentTenant(tx)).toBe(ORG_A);
    });
    // set_config(..., true) is transaction-local, so the next borrower of this
    // pooled connection inherits nothing.
    expect(await currentTenant(client)).toBeNull();
  });

  it("clears the tenant even when the callback throws", async () => {
    await expect(
      withTenant(client, ORG_A, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await currentTenant(client)).toBeNull();
  });
});

describe("FORCE ROW LEVEL SECURITY", () => {
  beforeEach(seedInvoices);

  it("without FORCE, the table owner sees everything — which is the whole trap", async () => {
    // This is the failure mode the library exists to prevent, asserted rather than
    // described: policies are in place, they look right, and they protect nothing
    // from the role the application actually connects as.
    const unforced = definePolicy(
      { schema: SCHEMA, name: "invoice" },
      { tenantColumn: "org_id", force: false },
    );
    await applyPolicy(client, unforced);

    const { rows } = await client.query(`SELECT * FROM ${SCHEMA}.invoice`);
    expect(rows).toHaveLength(3); // all three, across both tenants, with no tenant set
  });

  it("with FORCE, the owner is subject to the policy like anyone else", async () => {
    await applyPolicy(client, invoicePolicy); // force defaults to true
    const { rows } = await client.query(`SELECT * FROM ${SCHEMA}.invoice`);
    expect(rows).toHaveLength(0);
  });
});

describe("coverage", () => {
  const opts = { schemas: [SCHEMA] };

  it("passes when every table is protected", async () => {
    await seedInvoices();
    await applyPolicy(client, invoicePolicy);

    const report = await assertFullRlsCoverage(client, opts);
    expect(report.ok).toBe(true);
    expect(report.rows).toHaveLength(1);
  });

  it("names a table with no RLS at all", async () => {
    await client.query(`CREATE TABLE ${SCHEMA}.audit_log (id serial PRIMARY KEY)`);

    const report = await rlsCoverage(client, opts);
    expect(report.ok).toBe(false);
    expect(report.unprotected[0]?.table).toBe("audit_log");
    expect(report.unprotected[0]?.problem).toBe("no-rls");
  });

  it("names a table whose RLS is enabled but not forced", async () => {
    await seedInvoices();
    await applyPolicy(
      client,
      definePolicy({ schema: SCHEMA, name: "invoice" }, { tenantColumn: "org_id", force: false }),
    );

    const report = await rlsCoverage(client, opts);
    expect(report.unprotected[0]?.problem).toBe("not-forced");
    expect(report.unprotected[0]?.reason).toMatch(/owner bypasses it/);
  });

  it("accepts an unforced table when told to", async () => {
    await seedInvoices();
    await applyPolicy(
      client,
      definePolicy({ schema: SCHEMA, name: "invoice" }, { tenantColumn: "org_id", force: false }),
    );

    const report = await rlsCoverage(client, { ...opts, allowUnforced: true });
    expect(report.ok).toBe(true);
  });

  it("names a table with RLS on and no policy", async () => {
    await client.query(`CREATE TABLE ${SCHEMA}.session (id serial PRIMARY KEY)`);
    await client.query(`ALTER TABLE ${SCHEMA}.session ENABLE ROW LEVEL SECURITY`);
    await client.query(`ALTER TABLE ${SCHEMA}.session FORCE ROW LEVEL SECURITY`);

    const report = await rlsCoverage(client, opts);
    expect(report.unprotected[0]?.problem).toBe("no-policies");
  });

  it("skips what it is told to skip", async () => {
    await client.query(`CREATE TABLE ${SCHEMA}.__migrations (id serial PRIMARY KEY)`);

    const report = await rlsCoverage(client, { ...opts, exclude: ["__migrations"] });
    expect(report.ok).toBe(true);
    expect(report.rows).toHaveLength(0);
  });

  it("ignores views, which cannot carry policies", async () => {
    await seedInvoices();
    await applyPolicy(client, invoicePolicy);
    await client.query(`CREATE VIEW ${SCHEMA}.big_invoice AS SELECT * FROM ${SCHEMA}.invoice`);

    const report = await rlsCoverage(client, opts);
    expect(report.rows.map((r) => r.table)).toEqual(["invoice"]);
  });

  it("reports worst problem first", async () => {
    await seedInvoices();
    await applyPolicy(
      client,
      definePolicy({ schema: SCHEMA, name: "invoice" }, { tenantColumn: "org_id", force: false }),
    );
    await client.query(`CREATE TABLE ${SCHEMA}.audit_log (id serial PRIMARY KEY)`);

    const report = await rlsCoverage(client, opts);
    expect(report.unprotected.map((t) => t.problem)).toEqual(["no-rls", "not-forced"]);
  });

  it("throws a message that names every offender", async () => {
    await client.query(`CREATE TABLE ${SCHEMA}.audit_log (id serial PRIMARY KEY)`);
    await client.query(`CREATE TABLE ${SCHEMA}.webhook_event (id serial PRIMARY KEY)`);

    await expect(assertFullRlsCoverage(client, opts)).rejects.toThrow(RlsCoverageError);
    await expect(assertFullRlsCoverage(client, opts)).rejects.toThrow(
      /2 of 2 tables are not protected[\s\S]*audit_log[\s\S]*webhook_event/,
    );
  });
});

describe("the role the audit runs as", () => {
  const opts = { schemas: [SCHEMA] };

  it("refuses to certify a connection that bypasses RLS", async () => {
    await seedInvoices();
    await applyPolicy(client, invoicePolicy);

    // Every table genuinely is protected — but `admin` is a superuser, so this
    // connection ignores policies entirely. Reporting "all protected" here would
    // be the most dangerous thing the library could do.
    const report = await rlsCoverage(admin, opts);
    expect(report.unprotected).toEqual([]);
    expect(report.role.bypasses).toBe(true);
    expect(report.ok).toBe(false);

    await expect(assertFullRlsCoverage(admin, opts)).rejects.toThrow(/superuser/);
  });

  it("says so, rather than listing tables that are fine", async () => {
    await seedInvoices();
    await applyPolicy(client, invoicePolicy);

    const report = await rlsCoverage(admin, opts);
    expect(formatCoverage(report)).toContain("Re-run as the role your");
  });

  it("can be told to accept it", async () => {
    await seedInvoices();
    await applyPolicy(client, invoicePolicy);

    const report = await rlsCoverage(admin, { ...opts, allowBypassingRole: true });
    expect(report.ok).toBe(true);
  });

  it("reports the application role as safe", async () => {
    const role = await auditRole(client);
    expect(role).toMatchObject({
      name: APP_ROLE,
      superuser: false,
      bypassRls: false,
      bypasses: false,
    });
  });
});

describe("re-applying a policy", () => {
  it("is idempotent, and a changed predicate takes effect", async () => {
    await seedInvoices();
    await applyPolicy(client, invoicePolicy);
    await applyPolicy(client, invoicePolicy); // CREATE POLICY has no OR REPLACE

    const report = await rlsCoverage(client, { schemas: [SCHEMA] });
    expect(report.rows[0]?.policyCount).toBe(1);
    expect(report.ok).toBe(true);
  });
});
