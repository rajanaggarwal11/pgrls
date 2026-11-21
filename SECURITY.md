# Security policy

## Supported versions

The latest published minor version receives fixes. This project is pre-1.0, so older minors are not backported.

## Reporting a vulnerability

Please report privately through GitHub's [security advisory form](https://github.com/rajanaggarwal11/pgrls/security/advisories/new) rather than opening a public issue.

You should get an acknowledgement within 72 hours and an assessment within a week.

## Scope

`pgrls` runs SQL against the database you give it: `applyPolicy` executes the policy DDL it generates, `withTenant` sets a transaction-local setting, and the coverage audit (in a test or through `npx pgrls audit`) only reads the system catalogs. It makes no network requests other than that connection and spawns no processes.

The things most worth reporting:

- Any way for a table, column, policy, role or setting name to change the SQL that `definePolicy` or `applyPolicy` generates beyond what it names.
- A tenant id set by `withTenant` that survives its transaction, so a later borrower of the same pooled connection inherits it.
- A table that the audit reports as protected while some role in the database can read across tenants.
- Credentials from a connection URL appearing in audit output or errors.
