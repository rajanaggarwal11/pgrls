import { Client } from "pg";
import postgres from "postgres";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyPolicy, definePolicy } from "../src/policy.js";
import { assertFullRlsCoverage } from "../src/coverage.js";
import { currentTenant, withTenant } from "../src/tenant.js";
import { fromPostgresJs, withPostgresJs } from "../src/postgres-js.js";
import type { SqlExecutor } from "../src/types.js";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/pgrls_test";

const SCHEMA = "pgrls_pjs";
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

// A non-superuser that owns the table, so RLS actually applies to it.
const APP_ROLE = "pgrls_pjs_app";
const APP_PASSWORD = "pgrls_pjs_pw";

let admin: Client;
/** A postgres.js POOL of two connections, as the application role. */
let sql: Sql;

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
        CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$;
  `);
  const { rows } = await admin.query<{ db: string }>(`SELECT current_database() AS db`);
  await admin.query(`GRANT CREATE, CONNECT ON DATABASE "${rows[0]!.db}" TO ${APP_ROLE}`);

  // max: 2 is load-bearing for the "a pool is not a connection" test below.
  sql = postgres(appUrl(), { max: 2 });
});

afterAll(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  await sql.end();
  await admin.end();
});

beforeEach(async () => {
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await sql.unsafe(`CREATE SCHEMA ${SCHEMA}`);
  await sql.unsafe(`
    CREATE TABLE ${SCHEMA}.invoice (
      id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL,
      total  integer NOT NULL
    )
  `);
  await sql.unsafe(
    `INSERT INTO ${SCHEMA}.invoice (org_id, total) VALUES ($1, 100), ($1, 200), ($2, 999)`,
    [ORG_A, ORG_B],
  );
  await withPostgresJs(sql, (db) =>
    applyPolicy(db, definePolicy({ schema: SCHEMA, name: "invoice" }, { tenantColumn: "org_id" })),
  );
});

describe("fromPostgresJs", () => {
  it("scopes a tenant across every query in the callback", async () => {
    const totals = await withPostgresJs(sql, (db) =>
      withTenant(db, ORG_A, async (tx) => {
        // Two separate queries. Both must see the tenant, which only holds if
        // they ran on the connection that set it.
        expect(await currentTenant(tx)).toBe(ORG_A);
        const { rows } = await tx.query<{ total: number }>(
          `SELECT total FROM ${SCHEMA}.invoice ORDER BY total`,
        );
        return rows.map((r) => r.total);
      }),
    );
    expect(totals).toEqual([100, 200]);
  });

  it("returns nothing when no tenant is set — fail closed, through this adapter too", async () => {
    const { rows } = await withPostgresJs(sql, (db) => db.query(`SELECT * FROM ${SCHEMA}.invoice`));
    expect(rows).toEqual([]);
  });

  it("runs the coverage audit, including its array parameter", async () => {
    // COVERAGE_SQL binds `$1::text[]`; this proves postgres.js marshals it.
    const report = await withPostgresJs(sql, (db) =>
      assertFullRlsCoverage(db, { schemas: [SCHEMA] }),
    );
    expect(report.ok).toBe(true);
    expect(report.rows.map((r) => r.table)).toEqual(["invoice"]);
  });

  it("releases the connection even when the callback throws", async () => {
    await expect(
      withPostgresJs(sql, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // If the reservation leaked, a pool of two would now have one connection;
    // reserving two more would hang. Reserve two and release them to prove not.
    const a = await fromPostgresJs(sql);
    const b = await fromPostgresJs(sql);
    a.release();
    b.release();
  });
});

describe("why the connection is reserved — a pool is not a connection", () => {
  it("over the raw pool, a setting made on one connection is invisible on the other", async () => {
    // The naive adapter everyone writes first: sql.unsafe straight at the pool.
    const naive: SqlExecutor = {
      async query<T>(text: string, params: readonly unknown[] = []) {
        const rows = await sql.unsafe(text, params as never);
        return { rows: Array.from(rows) as unknown as T[] };
      },
    };

    // Session-level, so it outlives the statement — the strongest possible case
    // for the naive adapter. It still fails.
    await naive.query(`SELECT set_config('pgrls.tenant', $1, false)`, [ORG_A]);

    // Two concurrent reads on a pool of two: the pool must use both connections,
    // and the setting exists on exactly one of them.
    const [x, y] = await Promise.all([currentTenant(naive), currentTenant(naive)]);
    const seen = [x, y].filter((v) => v === ORG_A).length;
    expect(seen).toBe(1);

    // Clean up the session-level setting on whichever connection holds it.
    await Promise.all([
      naive.query(`SELECT set_config('pgrls.tenant', '', false)`),
      naive.query(`SELECT set_config('pgrls.tenant', '', false)`),
    ]);
  });

  it("over a reserved connection, the same two reads both see it", async () => {
    await withPostgresJs(sql, async (db) => {
      await db.query(`SELECT set_config('pgrls.tenant', $1, false)`, [ORG_A]);
      const [x, y] = await Promise.all([currentTenant(db), currentTenant(db)]);
      expect(x).toBe(ORG_A);
      expect(y).toBe(ORG_A);
      await db.query(`SELECT set_config('pgrls.tenant', '', false)`);
    });
  });
});
