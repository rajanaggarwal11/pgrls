# Three ways Postgres row-level security looks correct and isn't

Row-level security is the right answer to tenant isolation. The database enforces it, so a forgotten `WHERE org_id = $1` stops being a data breach. The trouble is that RLS has three failure modes that all look like success — the policy exists, the predicate is right, `SELECT` returns sensible rows in development — and none of them show up in your tests, your types, or your code review.

Each one below is reproduced in `psql` so you can watch it happen. Each fix is one line. Each is a default in [pgrls](https://github.com/rajanaggarwal11/pgrls), and the audit it ships catches all three.

---

## 1. The table's owner bypasses every policy

**The symptom:** RLS is enabled, a policy is in place, and your application still sees every tenant's rows.

**The mechanism:** `ENABLE ROW LEVEL SECURITY` does not apply to the table's _owner_. That is documented, deliberate, and almost universally missed — because most applications connect as the role that ran the migrations, which is the role that owns the tables. So the policy is real, the predicate is correct, and it protects nothing from the one connection that matters.

**Reproduce it:**

```sql
-- As a plain role that will own the table. Not a superuser.
CREATE TABLE invoice (id serial PRIMARY KEY, org_id uuid NOT NULL, total int NOT NULL);
INSERT INTO invoice (org_id, total) VALUES
  ('11111111-1111-1111-1111-111111111111', 100),
  ('22222222-2222-2222-2222-222222222222', 999);

ALTER TABLE invoice ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON invoice
  USING (org_id = current_setting('app.tenant', true)::uuid);

-- No tenant is set. This should return nothing.
SELECT count(*) FROM invoice;
--  count
-- -------
--      2       ← both tenants. The owner is exempt.
```

**The fix:**

```sql
ALTER TABLE invoice FORCE ROW LEVEL SECURITY;

SELECT count(*) FROM invoice;
--  count
-- -------
--      0       ← now the policy applies to the owner too.
```

`FORCE` is what closes it. There is no good reason to leave it off on a tenant table, which is why pgrls turns it on by default and its audit reports an unforced table as unprotected.

**What still bypasses it:** superusers, and any role with `BYPASSRLS`. Which is trap 2.

---

## 2. Your audit passes because it ran as a superuser

**The symptom:** you wrote a check that every table has RLS enabled and a policy. It passes. You are still leaking data.

**The mechanism:** nothing — not `ENABLE`, not `FORCE`, not any policy — applies to a superuser or to a role with the `BYPASSRLS` attribute. They see every row of every table, always. So if your application connects with elevated credentials (very common in early-stage systems, where `postgres` is the only role anyone made), every policy you wrote is decorative. And worse: if you _audit_ over that connection, the audit certifies a database it cannot actually see.

**Reproduce it:**

```sql
-- As a superuser, with the FORCE'd table from above:
SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
--  rolsuper | rolbypassrls
-- ----------+--------------
--  t        | t

SELECT count(*) FROM invoice;
--  count
-- -------
--      2       ← FORCE did nothing. Policies never apply here.
```

**The fix** is not in SQL; it is operational. Your application must connect as a role that is `NOSUPERUSER NOBYPASSRLS`, and so must anything that claims to verify isolation:

```sql
CREATE ROLE app LOGIN PASSWORD '…' NOSUPERUSER NOBYPASSRLS;
GRANT SELECT, INSERT, UPDATE, DELETE ON invoice TO app;
```

Then check it, every time, before trusting a green audit:

```sql
SELECT rolsuper OR rolbypassrls AS bypasses_rls
  FROM pg_roles WHERE rolname = current_user;
-- must be false, or nothing else you measured means anything
```

This is why pgrls's `assertFullRlsCoverage` reads the role it is running as and **refuses to return a passing report** over a connection that bypasses policies. A green result gathered as a superuser is not evidence of anything, and silently handing one back would be the most dangerous thing the library could do.

---

## 3. An unset tenant raises instead of denying

**The symptom:** the first request on a connection works. The second one crashes with `invalid input syntax for type uuid: ""`.

**The mechanism:** the obvious predicate is `org_id = current_setting('app.tenant', true)::uuid`. The `true` means "return NULL if the setting was never set", and `org_id = NULL` is NULL, which RLS treats as false — so an unscoped connection sees nothing. Good. That is the fail-closed behaviour you want.

But a custom setting that has been set _once_ on a connection — say, inside a transaction with `set_config(…, true)` — does not go back to "never set" when the transaction ends. It reverts to the **empty string**. And `''::uuid` is not NULL; it is an error. On a pooled connection, every request after the first one that touched the setting blows up.

**Reproduce it:**

```sql
-- Fresh connection: the setting has never existed.
SELECT current_setting('app.tenant', true) IS NULL;
--  ?column?
-- ----------
--  t

-- Set it inside a transaction, transaction-local, then let the transaction end.
BEGIN;
SELECT set_config('app.tenant', '11111111-1111-1111-1111-111111111111', true);
COMMIT;

-- It is no longer NULL. It is ''.
SELECT current_setting('app.tenant', true) IS NULL,
       current_setting('app.tenant', true) = '';
--  ?column? | ?column?
-- ----------+----------
--  f        | t

-- And so the naive predicate no longer denies. It raises.
SELECT current_setting('app.tenant', true)::uuid;
-- ERROR:  invalid input syntax for type uuid: ""
```

**The fix:**

```sql
CREATE POLICY tenant ON invoice
  USING (org_id = nullif(current_setting('app.tenant', true), '')::uuid);
```

`nullif(…, '')` turns the empty string back into NULL, NULL cast to `uuid` is NULL, and the predicate denies instead of crashing. pgrls emits exactly this predicate; two of its integration tests failed on the naive version before it did.

---

## Putting it together

The reason these three are dangerous is that each one is invisible from inside the application. The policy is there. The rows look right in development, where you are probably the owner or a superuser and never notice. The crash in trap 3 only appears under a connection pool. And a home-grown coverage check happily passes trap 2 while running as the very role it should be refusing.

The posture that works:

1. **`FORCE ROW LEVEL SECURITY` on every tenant table**, no exceptions.
2. **Connect as a role that cannot bypass RLS**, and make your audit refuse to run as anything else.
3. **`nullif(…, '')` in every predicate that casts a setting.**
4. **Ask the database, not your schema file**, which tables are actually protected — because the table someone added in a migration last Tuesday is the one that matters.

```ts
import { assertFullRlsCoverage } from "pgrls";

test("every table is protected", async () => {
  await assertFullRlsCoverage(client); // refuses if `client` is a superuser
});
```

That one assertion, run as the application's role, catches all three.
