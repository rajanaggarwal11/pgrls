# pgrls

**Postgres row-level security you can actually verify.** Policies declared beside the table, tenant context that can't leak across a connection pool, and one test that asks Postgres whether every table is really protected — and names the ones that aren't.

[![CI](https://github.com/rajanaggarwal11/pgrls/actions/workflows/ci.yml/badge.svg)](https://github.com/rajanaggarwal11/pgrls/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pgrls.svg)](https://www.npmjs.com/package/pgrls)
[![license](https://img.shields.io/npm/l/pgrls.svg)](./LICENSE)

```ts
test("every table is protected", async () => {
  await assertFullRlsCoverage(client);
});
```

```
pgrls: 3 of 14 tables are not protected.

  ✗ public.audit_log      row-level security is not enabled — every row is readable by any role
  ✗ public.webhook_event  RLS is enabled but not FORCED — the table owner bypasses it, and most
                          applications connect as the owner of their own tables
  ✗ public.session        RLS is enabled with no policy — every query against this table returns nothing
```

Run that against a multi-tenant database you didn't write and see what comes back.

Or skip the test file entirely and point the CLI at a database:

```bash
DATABASE_URL=postgres://app@db.internal/prod npx pgrls audit
```

```
pgrls audit · prod on db.internal as app

pgrls: 3 of 14 tables are not protected.

  ✗ public.audit_log  row-level security is not enabled — every row is readable by any role
  ✗ public.invoice    RLS is enabled but not FORCED — the table owner bypasses it, and most applications connect as the owner of their own tables
  ✗ public.session    RLS is enabled with no policy — every query against this table returns nothing
```

Exit `1` when something is exposed, `0` when nothing is, `2` when it couldn't run — so it drops straight into CI. `--json` for a stable machine-readable report, `--schema` and `--exclude` (both repeatable) to scope it. The connection string is never written to any stream, including inside error messages; prefer `DATABASE_URL` over an argument so it stays out of your shell history.

**Run it as the role your application connects with.** A superuser cannot see policies, and rather than pass, the audit says so in the header and exits `1`. `pg` is an optional dependency so `npx pgrls audit` works with nothing else installed; a project that already has `postgres` (postgres.js) is used as-is.

## Why this exists

RLS is the right answer for tenant isolation: the database enforces it, so a forgotten `WHERE org_id = $1` stops being a data breach. The problem is that RLS has three failure modes that all look like success, and none of them show up in your tests, your types, or your code review.

**1. The owner bypasses it.** `ENABLE ROW LEVEL SECURITY` does nothing to the table's owner. Most applications connect as the role that owns their tables, so the policy is real, the predicate is correct, and it protects nothing at all. `FORCE ROW LEVEL SECURITY` is what closes it, and `pgrls` turns it on by default.

**2. Superusers bypass it entirely.** No policy, and no amount of `FORCE`, applies to a superuser or a role with `BYPASSRLS`. This is why the coverage audit checks _who it is running as_ and refuses to return a green report over such a connection — a passing audit gathered as a superuser is not evidence of anything, and silently handing one back would be the most dangerous thing this library could do.

**3. An unset tenant can raise instead of denying.** The obvious predicate is `org_id = current_setting('app.tenant', true)::uuid`. Once a custom setting has been set inside a transaction and that transaction ends, it does not vanish — it reverts to the empty string. `''::uuid` raises `invalid input syntax for type uuid: ""`, so on a pooled connection every request after the first one crashes instead of returning nothing. `pgrls` wraps the setting in `nullif(…, '')`, so an unscoped query sees an empty table, which is the only safe answer.

None of this is exotic. All of it is easy to get wrong once and never notice.

Each trap is reproduced step by step, in `psql`, in [docs/rls-traps.md](./docs/rls-traps.md).

## Install

```bash
npm install pgrls
```

`drizzle-orm` is an optional peer dependency, needed only for `pgrls/drizzle`.

## The three pieces

### Policies live beside the table

```ts
import { pgTable, uuid, integer } from "drizzle-orm/pg-core";
import { rls } from "pgrls/drizzle";

export const invoice = pgTable("invoice", {
  id: uuid().primaryKey().defaultRandom(),
  orgId: uuid("org_id").notNull(),
  total: integer().notNull(),
});

export const invoicePolicy = rls(invoice, { tenantColumn: "org_id" });
```

`policySql(invoicePolicy)` gives you the statements to paste into a migration. They are idempotent — the policy is dropped and recreated, because `CREATE POLICY` has no `OR REPLACE` and a re-run migration must actually apply a changed predicate.

Not using Drizzle? `definePolicy("invoice", { tenantColumn: "org_id" })` takes a plain table name. Nothing in the core depends on an ORM.

### Tenant context is a transaction

```ts
import { withTenant } from "pgrls";

const invoices = await withTenant(client, orgId, async (tx) => {
  const { rows } = await tx.query("SELECT * FROM invoice");
  return rows;
});
```

The tenant is written with `set_config(name, value, true)`. The third argument makes it local to the transaction, so it cannot outlive the request that set it — on a pooled connection a session-level setting is inherited by whoever borrows that connection next, which is the worst bug this library could have. There is deliberately no API for setting a tenant outside a transaction.

Using a function call rather than `SET LOCAL` also means the tenant id travels as a bind parameter instead of being interpolated into SQL.

### One test that proves it

```ts
import { assertFullRlsCoverage } from "pgrls";

test("every table is protected", async () => {
  await assertFullRlsCoverage(client, {
    exclude: ["__drizzle_migrations"],
  });
});
```

It asks `pg_class` and `pg_policy` directly, so it sees what actually shipped — including the table someone added in a migration last Tuesday and forgot to write a policy for. That is the one that matters, and it is exactly the one a schema-file linter misses.

Run it as **the role your application connects with**, not as your migration superuser. The assertion will tell you if you get that wrong.

## API

| Export                                    | What it does                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `assertFullRlsCoverage(client, opts?)`    | Throws `RlsCoverageError` if any table is unprotected.                                                                    |
| `rlsCoverage(client, opts?)`              | The same audit as data, without throwing.                                                                                 |
| `auditRole(client)`                       | Who the connection is, and whether it bypasses RLS.                                                                       |
| `withTenant(client, id, fn, opts?)`       | Runs `fn` in a transaction scoped to a tenant.                                                                            |
| `currentTenant(client, opts?)`            | The tenant Postgres currently sees, or null.                                                                              |
| `definePolicy(table, opts)`               | Resolves a policy spec, applying defaults.                                                                                |
| `policySql(spec)` / `dropPolicySql(spec)` | The statements, for your migration.                                                                                       |
| `applyPolicy(client, spec)`               | Runs them, in one transaction.                                                                                            |
| `rls(table, opts)` — from `pgrls/drizzle` | `definePolicy` for a Drizzle table.                                                                                       |
| `npx pgrls audit [url]`                   | The coverage audit as a CLI. Exit 0/1/2, `--json`, `--schema`, `--exclude`, `--allow-unforced`, `--allow-bypassing-role`. |

**Coverage options:** `schemas` (default `["public"]`), `exclude` (names or `schema.name`), `allowUnforced`, `allowBypassingRole`. The last two exist so you can opt out deliberately; both default to the strict reading.

## postgres.js

```ts
import postgres from "postgres";
import { withPostgresJs } from "pgrls/postgres-js";

const sql = postgres(url);

await withPostgresJs(sql, (db) => assertFullRlsCoverage(db));
await withPostgresJs(sql, (db) => withTenant(db, orgId, (tx) => tx.query("SELECT …")));
```

The adapter **reserves one connection** for the duration of the callback, and that is the whole point of it. postgres.js pools by default, and a pool is not a connection: over a naive `sql.unsafe` adapter, `withTenant`'s `BEGIN` lands on one connection and your next query may land on another — the tenant is set where nobody reads it, and the policies quietly return nothing. No error; an empty result. There is a test that demonstrates exactly that against a two-connection pool, and one that shows the reserved adapter doesn't have the problem.

`postgres` is an optional peer dependency.

## Any driver

The core needs one method:

```ts
interface SqlExecutor {
  query<T>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}
```

That is `pg`'s shape. `postgres.js`, `slonik` and a Drizzle session each wrap to it in a few lines. This is deliberate — the tooling that exists today is tied to one hosting provider, and tenant isolation shouldn't be.

## What it deliberately does not do

- **It does not manage your migrations.** It emits SQL; where that SQL goes is your migration tool's business.
- **It does not invent a policy language.** One shape — a tenant column compared against a session setting — covers the overwhelming majority of multi-tenant applications. Anything more complicated is a hand-written policy, and `assertFullRlsCoverage` will still count it.
- **It does not read your schema file.** Every claim it makes comes from asking the running database.

## Requirements

Postgres 9.5 or newer, where row-level security landed. Node 22.13 or newer. CI runs the full suite against Postgres 14, 15, 16, 17 and 18 — those are the versions actually verified.

## License

[MIT](./LICENSE) © Rajan Aggarwal
