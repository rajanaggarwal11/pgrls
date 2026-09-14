# pgrls

## 0.2.0

### Minor Changes

- [`d2ca28a`](https://github.com/rajanaggarwal11/pgrls/commit/d2ca28ae11e12de0cc090cc7c17cd42686ba207a) Thanks [@rajanaggarwal11](https://github.com/rajanaggarwal11)! - **`npx pgrls audit`** — the coverage audit as a command, for CI and for the shell. Reads `DATABASE_URL` or a URL argument, inspects the schemas you name, skips the tables you exclude, and exits `0` when every table is protected, `1` when something is exposed or the role bypasses RLS and cannot tell, `2` when it could not run. `--json` is a stable shape (`version: 1`). The URL is redacted in every message. `pg` is an optional dependency — the CLI says so when it is missing rather than crashing.

  **`pgrls/postgres-js`** — `fromPostgresJs(sql)` and `withPostgresJs(sql, tenant, fn)` for postgres.js, built on `sql.reserve()` so the tenant is set on one real connection and released with it, never on the pool.

  **`docs/rls-traps.md`** — the three traps that make RLS silently do nothing (owner bypass, superuser bypass, `''::uuid`), each reproduced in psql so you can watch them happen.

  Also: a GitHub Action, [`rajanaggarwal11/pgrls-action`](https://github.com/rajanaggarwal11/pgrls-action), runs the audit on every pull request and writes the unprotected tables to the job summary.

## 0.1.0

First release.

- **Policies beside the table.** `definePolicy` / `rls` resolve a tenant policy;
  `policySql` emits idempotent statements for your migration.
- **`withTenant`** scopes a transaction to a tenant with `set_config(…, true)`, so
  the setting cannot outlive the request on a pooled connection.
- **`assertFullRlsCoverage`** asks Postgres whether every table is protected and
  names the ones that are not.

Three defaults that exist because the alternative fails silently:

- `FORCE ROW LEVEL SECURITY` is on by default. `ENABLE` alone does not apply to the
  table's owner, and most applications connect as the owner of their own tables.
- The audit reads the role it runs as and refuses a green report over a superuser or
  `BYPASSRLS` connection, because RLS is never applied to such a role.
- The policy predicate is `nullif(current_setting(setting, true), '')::type`. A custom
  setting reverts to `''` rather than vanishing, and `''::uuid` raises — so without the
  `nullif` an unscoped query crashes instead of returning nothing.

Driver-agnostic: the core needs one `query` method. `drizzle-orm` is an optional peer
used only by `pgrls/drizzle`.
