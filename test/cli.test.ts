import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { run, redactUrl, describeUrl } from "../src/cli.js";
import { applyPolicy, definePolicy } from "../src/policy.js";

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/pgrls_test";

const SCHEMA = "pgrls_cli";
const APP_ROLE = "pgrls_cli_app";
const APP_PASSWORD = "pgrls_cli_pw_s3cret";

function withUser(user: string, password: string): string {
  const url = new URL(DATABASE_URL);
  url.username = user;
  url.password = password;
  return url.toString();
}
const APP_URL = withUser(APP_ROLE, APP_PASSWORD);

let admin: Client;
let app: Client;

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
  app = new Client({ connectionString: APP_URL });
  await app.connect();
});

afterAll(async () => {
  await app.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`).catch(() => {});
  await app.end();
  await admin.end();
});

beforeEach(async () => {
  await app.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  await app.query(`CREATE SCHEMA ${SCHEMA}`);
  await app.query(`CREATE TABLE ${SCHEMA}.invoice (id serial PRIMARY KEY, org_id uuid NOT NULL)`);
});

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  all: string;
}

/** Runs the CLI with streams captured. `env` replaces process.env entirely. */
async function cli(args: string[], env: NodeJS.ProcessEnv = {}): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const code = await run(args, { NO_COLOR: "1", ...env });
    return { code, stdout, stderr, all: stdout + stderr };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

const audit = (...extra: string[]) => cli(["audit", APP_URL, "--schema", SCHEMA, ...extra]);

describe("usage", () => {
  it("--help exits 0 and documents the exit codes", async () => {
    const r = await cli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Exit codes");
    expect(r.stdout).toContain("DATABASE_URL");
  });

  it("--version prints a version", async () => {
    const r = await cli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("exits 2 with no command, and names the only one", async () => {
    const r = await cli([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("audit");
  });

  it("exits 2 on an unknown command", async () => {
    const r = await cli(["scan", APP_URL]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown command "scan"');
  });

  it("exits 2 with no URL anywhere, and points at DATABASE_URL", async () => {
    const r = await cli(["audit"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("DATABASE_URL");
  });

  it("takes the URL from DATABASE_URL when no argument is given", async () => {
    const r = await cli(["audit", "--schema", SCHEMA], { DATABASE_URL: APP_URL });
    expect(r.code).toBe(1); // the fixture table is unprotected
    expect(r.stdout).toContain("invoice");
  });
});

describe("the audit", () => {
  it("exits 1 and names the exposed table", async () => {
    const r = await audit();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`${SCHEMA}.invoice`);
    expect(r.stdout).toContain("row-level security is not enabled");
  });

  it("exits 0 once every table is protected, and says so", async () => {
    await applyPolicy(
      app,
      definePolicy({ schema: SCHEMA, name: "invoice" }, { tenantColumn: "org_id" }),
    );
    const r = await audit();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("all 1 tables are protected");
  });

  it("shows which role it ran as, in the header", async () => {
    const r = await audit();
    expect(r.stdout).toContain(`as ${APP_ROLE}`);
  });

  it("honours --exclude", async () => {
    const r = await audit("--exclude", "invoice");
    expect(r.code).toBe(0);
  });

  it("honours --allow-unforced", async () => {
    await applyPolicy(
      app,
      definePolicy({ schema: SCHEMA, name: "invoice" }, { tenantColumn: "org_id", force: false }),
    );
    expect((await audit()).code).toBe(1);
    expect((await audit("--allow-unforced")).code).toBe(0);
  });
});

describe("running as a superuser — the mistake everyone makes first", () => {
  it("refuses to pass, loudly, even when every table is protected", async () => {
    await applyPolicy(
      app,
      definePolicy({ schema: SCHEMA, name: "invoice" }, { tenantColumn: "org_id" }),
    );
    const r = await cli(["audit", DATABASE_URL, "--schema", SCHEMA]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("superuser");
    expect(r.stdout).toContain("policies do not apply");
    expect(r.stdout).toContain("Re-run as the role your");
  });

  it("passes only when told to accept that", async () => {
    await applyPolicy(
      app,
      definePolicy({ schema: SCHEMA, name: "invoice" }, { tenantColumn: "org_id" }),
    );
    const r = await cli(["audit", DATABASE_URL, "--schema", SCHEMA, "--allow-bypassing-role"]);
    expect(r.code).toBe(0);
  });
});

describe("--json", () => {
  it("emits the documented shape", async () => {
    const r = await audit("--json");
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout) as {
      version: number;
      ok: boolean;
      role: { name: string; bypasses: boolean };
      summary: { tables: number; unprotected: number; byProblem: Record<string, number> };
      unprotected: { table: string; problem: string }[];
    };
    expect(report.version).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.role.name).toBe(APP_ROLE);
    expect(report.role.bypasses).toBe(false);
    expect(report.summary).toEqual({
      tables: 1,
      unprotected: 1,
      byProblem: { "no-rls": 1, "not-forced": 0, "no-policies": 0 },
    });
    expect(report.unprotected[0]).toMatchObject({ table: "invoice", problem: "no-rls" });
  });
});

describe("the connection string never reaches a stream", () => {
  it("does not leak the password when the connection fails", async () => {
    // A database that does not exist fails on every auth mode — including a
    // local trust-auth cluster, where a wrong password would still connect.
    const url = new URL(withUser(APP_ROLE, "WRONG_PASSWORD_hunter2"));
    url.pathname = "/pgrls_no_such_database";
    const wrong = url.toString();
    const r = await cli(["audit", wrong, "--schema", SCHEMA]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("could not connect");
    // The whole point of this test:
    expect(r.all).not.toContain("hunter2");
    expect(r.all).not.toContain("WRONG_PASSWORD");
    expect(r.all).not.toContain(wrong);
  });

  it("does not print the password on success either", async () => {
    const r = await audit();
    expect(r.all).not.toContain(APP_PASSWORD);
  });

  it("redactUrl masks the password and nothing else", () => {
    expect(redactUrl("postgres://u:p%40ss@h:5432/db?sslmode=require")).toBe(
      "postgres://u:***@h:5432/db?sslmode=require",
    );
    expect(redactUrl("not a url")).toBe("<connection url>");
  });

  it("describeUrl names the database and user, never the password", () => {
    expect(describeUrl("postgres://alice:secret@db.example:5432/prod")).toEqual({
      database: "prod",
      user: "alice",
      host: "db.example",
    });
  });
});
