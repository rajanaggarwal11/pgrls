---
"pgrls": minor
---

**`npx pgrls audit`** — the coverage audit as a command, for CI and for the shell. Reads `DATABASE_URL` or a URL argument, inspects the schemas you name, skips the tables you exclude, and exits `0` when every table is protected, `1` when something is exposed or the role bypasses RLS and cannot tell, `2` when it could not run. `--json` is a stable shape (`version: 1`). The URL is redacted in every message. `pg` is an optional dependency — the CLI says so when it is missing rather than crashing.

**`pgrls/postgres-js`** — `fromPostgresJs(sql)` and `withPostgresJs(sql, tenant, fn)` for postgres.js, built on `sql.reserve()` so the tenant is set on one real connection and released with it, never on the pool.

**`docs/rls-traps.md`** — the three traps that make RLS silently do nothing (owner bypass, superuser bypass, `''::uuid`), each reproduced in psql so you can watch them happen.

Also: a GitHub Action, [`rajanaggarwal11/pgrls-action`](https://github.com/rajanaggarwal11/pgrls-action), runs the audit on every pull request and writes the unprotected tables to the job summary.
