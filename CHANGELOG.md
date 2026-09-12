# pgrls

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
