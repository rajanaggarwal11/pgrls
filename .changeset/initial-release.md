---
"pgrls": minor
---

First release.

Tenant policies declared beside the table and emitted as idempotent SQL, `withTenant` for transaction-scoped tenant context that cannot leak across a connection pool, and `assertFullRlsCoverage` — one assertion that asks Postgres whether every table is protected and names the ones that are not.

The audit checks the role it runs as and refuses to return a green report over a superuser or `BYPASSRLS` connection, because RLS is never applied to such a role and a passing report gathered there proves nothing.
