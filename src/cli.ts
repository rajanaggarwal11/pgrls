#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { formatCoverage, rlsCoverage } from "./coverage.js";
import type { CoverageReport, SqlExecutor } from "./types.js";

/** 0 protected · 1 something is exposed (or the role can't tell) · 2 could not run. */
const EXIT_OK = 0;
const EXIT_FINDINGS = 1;
const EXIT_ERROR = 2;

const bold = (s: string) => `[1m${s}[22m`;
const red = (s: string) => `[31m${s}[39m`;
const green = (s: string) => `[32m${s}[39m`;
const dim = (s: string) => `[2m${s}[22m`;
const plain = (s: string) => s;
const useColor = () =>
  !process.env.NO_COLOR && process.env.FORCE_COLOR !== "0" && process.stdout.isTTY;

function version(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const HELP = `
pgrls — Postgres row-level security you can actually verify

Usage
  pgrls audit [<connection-url>] [options]

  The URL may also come from DATABASE_URL, which keeps it out of your shell
  history. Run it as the role your APPLICATION connects with — not a superuser.
  A superuser cannot see policies and the audit will say so rather than pass.

Options
  --schema <name>           Schema to inspect; repeatable. Default: public
  --exclude <table>         Table to skip, as name or schema.name; repeatable
  --allow-unforced          Count a table with RLS enabled but not FORCED as protected
  --allow-bypassing-role    Accept a report gathered as a superuser / BYPASSRLS role
  --json                    Machine-readable output (stable shape, version 1)
  -v, --version             Print the version
  -h, --help                Print this

Exit codes
  0  every table is protected
  1  something is exposed, or the role bypasses RLS and cannot tell
  2  could not run — no URL, bad option, no driver, connection failed

Examples
  DATABASE_URL=postgres://app@db/prod npx pgrls audit
  npx pgrls audit --schema public --schema billing --exclude __drizzle_migrations
  npx pgrls audit --json > rls-report.json
`;

/**
 * The connection URL with the password removed. This is the ONLY form of the
 * URL that may ever be written to a stream — including inside error messages
 * from a failed connection, which is exactly when someone is most likely to
 * paste the output somewhere.
 */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return "<connection url>";
  }
}

/** The database and user named by a URL, for the report header. Never the password. */
export function describeUrl(raw: string): { database: string; user: string; host: string } {
  try {
    const url = new URL(raw);
    return {
      database: url.pathname.replace(/^\//, "") || "?",
      user: decodeURIComponent(url.username) || "?",
      host: url.hostname || "?",
    };
  } catch {
    return { database: "?", user: "?", host: "?" };
  }
}

interface Connection {
  client: SqlExecutor;
  close(): Promise<void>;
}

/**
 * Connects with whichever driver is available. `pg` is an optional dependency
 * so `npx pgrls audit` works with nothing else installed; a project that already
 * has `postgres` (postgres.js) is used as-is.
 */
async function connect(url: string): Promise<Connection> {
  try {
    const { Client } = await import("pg");
    const client = new Client({ connectionString: url });
    await client.connect();
    return {
      client: {
        query: <T = Record<string, unknown>>(text: string, params?: readonly unknown[]) =>
          client.query(text, params as unknown[]) as unknown as Promise<{ rows: T[] }>,
      },
      close: () => client.end(),
    };
  } catch (error) {
    if (!isModuleNotFound(error, "pg")) throw error;
  }

  try {
    const postgres = (await import("postgres")).default;
    const { fromPostgresJs } = await import("./postgres-js.js");
    const sql = postgres(url, { max: 1 });
    const reserved = await fromPostgresJs(sql);
    return {
      client: reserved,
      close: async () => {
        reserved.release();
        await sql.end();
      },
    };
  } catch (error) {
    if (!isModuleNotFound(error, "postgres")) throw error;
  }

  throw new Error(
    "no Postgres driver found. Install one of:\n" +
      "  npm install pg\n" +
      "  npm install postgres\n" +
      "(pg is an optional dependency of pgrls and is normally installed with it)",
  );
}

function isModuleNotFound(error: unknown, name: string): boolean {
  const e = error as { code?: string; message?: string };
  return (
    (e?.code === "ERR_MODULE_NOT_FOUND" || e?.code === "MODULE_NOT_FOUND") &&
    (e.message ?? "").includes(name)
  );
}

function toJson(report: CoverageReport, where: ReturnType<typeof describeUrl>): string {
  return `${JSON.stringify(
    {
      version: 1,
      database: where.database,
      host: where.host,
      role: report.role,
      ok: report.ok,
      summary: {
        tables: report.rows.length,
        unprotected: report.unprotected.length,
        byProblem: {
          "no-rls": report.unprotected.filter((t) => t.problem === "no-rls").length,
          "not-forced": report.unprotected.filter((t) => t.problem === "not-forced").length,
          "no-policies": report.unprotected.filter((t) => t.problem === "no-policies").length,
        },
      },
      unprotected: report.unprotected,
      tables: report.rows,
    },
    null,
    2,
  )}\n`;
}

export async function run(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const c = useColor()
    ? { bold, red, green, dim }
    : { bold: plain, red: plain, green: plain, dim: plain };

  let values: Record<string, unknown>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: {
        schema: { type: "string", multiple: true },
        exclude: { type: "string", multiple: true },
        "allow-unforced": { type: "boolean", default: false },
        "allow-bypassing-role": { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        version: { type: "boolean", short: "v", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
    }));
  } catch (error) {
    process.stderr.write(`${c.red("✗")} ${(error as Error).message}\n${HELP}`);
    return EXIT_ERROR;
  }

  if (values.help) {
    process.stdout.write(HELP);
    return EXIT_OK;
  }
  if (values.version) {
    process.stdout.write(`${version()}\n`);
    return EXIT_OK;
  }

  const [command, urlArg] = positionals;
  if (command !== "audit") {
    process.stderr.write(
      `${c.red("✗")} ${command ? `unknown command "${command}"` : "no command given"}. The only command is: audit\n${HELP}`,
    );
    return EXIT_ERROR;
  }

  const url = urlArg ?? env.DATABASE_URL;
  if (!url) {
    process.stderr.write(
      `${c.red("✗")} no connection URL. Pass one as an argument, or set DATABASE_URL (preferred — it stays out of your shell history).\n`,
    );
    return EXIT_ERROR;
  }

  const where = describeUrl(url);
  const asJson = Boolean(values.json);

  let conn: Connection;
  try {
    conn = await connect(url);
  } catch (error) {
    // Whatever the driver said, the URL itself is never echoed.
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `${c.red("✗")} could not connect to ${where.database} on ${where.host} as ${where.user}: ${reason}\n`,
    );
    return EXIT_ERROR;
  }

  try {
    const report = await rlsCoverage(conn.client, {
      schemas: (values.schema as string[] | undefined) ?? ["public"],
      exclude: (values.exclude as string[] | undefined) ?? [],
      allowUnforced: Boolean(values["allow-unforced"]),
      allowBypassingRole: Boolean(values["allow-bypassing-role"]),
    });

    if (asJson) {
      process.stdout.write(toJson(report, where));
      return report.ok ? EXIT_OK : EXIT_FINDINGS;
    }

    const roleNote = report.role.bypasses
      ? c.red(
          `${report.role.name} (${report.role.superuser ? "superuser" : "BYPASSRLS"} — policies do not apply)`,
        )
      : c.green(report.role.name);
    process.stdout.write(
      `${c.bold("pgrls audit")} ${c.dim("·")} ${where.database} ${c.dim("on")} ${where.host} ${c.dim("as")} ${roleNote}\n\n`,
    );
    process.stdout.write(`${formatCoverage(report)}\n`);
    return report.ok ? EXIT_OK : EXIT_FINDINGS;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${c.red("✗")} audit failed: ${reason}\n`);
    return EXIT_ERROR;
  } finally {
    await conn.close().catch(() => {});
  }
}

/**
 * Resolved through realpath on both sides: npm installs a bin as a SYMLINK, so a
 * raw comparison of argv[1] against import.meta.url never matches and the CLI
 * silently does nothing. catalog-doctor 0.1.0 shipped exactly that.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  run().then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`✗ ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(EXIT_ERROR);
    },
  );
}
