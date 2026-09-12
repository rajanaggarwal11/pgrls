import { describe, expect, it } from "vitest";
import {
  definePolicy,
  dropPolicySql,
  policySql,
  predicateSql,
  quoteIdent,
  quoteLiteral,
} from "../src/policy.js";
import { formatCoverage } from "../src/coverage.js";

const spec = (over: Parameters<typeof definePolicy>[1] = { tenantColumn: "org_id" }) =>
  definePolicy("invoice", over);

describe("quoteIdent", () => {
  it("quotes a plain identifier", () => {
    expect(quoteIdent("org_id")).toBe('"org_id"');
  });

  it("refuses anything that is not one", () => {
    // Identifiers cannot be bind parameters, so they are interpolated — which is
    // exactly why nothing surprising may pass through here.
    for (const bad of ['a"b', "a;b", "drop table x", "a-b", "", "1abc", "a b"]) {
      expect(() => quoteIdent(bad), bad).toThrow(/not a plain SQL identifier/);
    }
  });
});

describe("quoteLiteral", () => {
  it("doubles embedded quotes", () => {
    expect(quoteLiteral("it's")).toBe("'it''s'");
  });
});

describe("definePolicy", () => {
  it("defaults schema, policy name, setting, cast, command and force", () => {
    const s = spec();
    expect(s.table).toEqual({ schema: "public", name: "invoice" });
    expect(s.policyName).toBe("invoice_tenant_isolation");
    expect(s.setting).toBe("pgrls.tenant");
    expect(s.castTo).toBe("uuid");
    expect(s.command).toBe("ALL");
    expect(s.force).toBe(true);
    expect(s.roles).toEqual(["PUBLIC"]);
  });

  it("rejects a setting outside a namespace", () => {
    // Postgres will not accept `SET tenant = …`; catching it here beats catching
    // it during a migration.
    expect(() => spec({ tenantColumn: "org_id", setting: "tenant" })).toThrow(/dotted name/);
  });

  it("rejects a table or column that is not an identifier", () => {
    expect(() => definePolicy("in voice", { tenantColumn: "org_id" })).toThrow();
    expect(() => definePolicy("invoice", { tenantColumn: "org id" })).toThrow();
  });
});

describe("predicateSql", () => {
  it("compares the column to the setting, cast to the column's type", () => {
    expect(predicateSql(spec())).toBe(
      `"org_id" = nullif(current_setting('pgrls.tenant', true), '')::uuid`,
    );
  });

  it("uses missing_ok so an unset tenant is NULL, not an error", () => {
    // NULL makes the predicate NULL, which RLS treats as false: no rows rather
    // than every row.
    expect(predicateSql(spec())).toContain(", true)");
  });

  it("nullifs the empty string, or an unscoped query raises instead of denying", () => {
    // A custom setting that has been set once reverts to '' rather than vanishing,
    // and ''::uuid raises. Without the nullif this is a crash, not a denial.
    expect(predicateSql(spec())).toContain("nullif(");
  });
});

describe("policySql", () => {
  it("enables, forces, drops and recreates — in that order", () => {
    const sql = policySql(spec());
    expect(sql[0]).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql[1]).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(sql[2]).toMatch(/DROP POLICY IF EXISTS/);
    expect(sql[3]).toMatch(/CREATE POLICY/);
  });

  it("is re-runnable, because CREATE POLICY has no OR REPLACE", () => {
    expect(policySql(spec()).join("\n")).toContain("DROP POLICY IF EXISTS");
  });

  it("emits NO FORCE when force is off", () => {
    expect(policySql(spec({ tenantColumn: "org_id", force: false }))[1]).toMatch(/NO FORCE/);
  });

  it("gives ALL both USING and WITH CHECK", () => {
    const create = policySql(spec())[3]!;
    expect(create).toContain("USING (");
    expect(create).toContain("WITH CHECK (");
  });

  it("gives INSERT only WITH CHECK", () => {
    // Postgres rejects USING on an INSERT policy.
    const create = policySql(spec({ tenantColumn: "org_id", command: "INSERT" }))[3]!;
    expect(create).not.toContain("USING (");
    expect(create).toContain("WITH CHECK (");
  });

  it("gives SELECT and DELETE only USING", () => {
    for (const command of ["SELECT", "DELETE"] as const) {
      const create = policySql(spec({ tenantColumn: "org_id", command }))[3]!;
      expect(create, command).toContain("USING (");
      expect(create, command).not.toContain("WITH CHECK (");
    }
  });

  it("qualifies the table and honours a custom schema", () => {
    const sql = policySql(definePolicy("invoice", { tenantColumn: "org_id", schema: "billing" }));
    expect(sql[0]).toContain('"billing"."invoice"');
  });

  it("quotes named roles but leaves PUBLIC bare", () => {
    const create = policySql(spec({ tenantColumn: "org_id", roles: ["app_user"] }))[3]!;
    expect(create).toContain('TO "app_user"');
    expect(policySql(spec())[3]!).toContain("TO PUBLIC");
  });
});

describe("dropPolicySql", () => {
  it("removes the policy and stands the table down", () => {
    const sql = dropPolicySql(spec()).join("\n");
    expect(sql).toContain("DROP POLICY IF EXISTS");
    expect(sql).toContain("NO FORCE ROW LEVEL SECURITY");
    expect(sql).toContain("DISABLE ROW LEVEL SECURITY");
  });
});

const SAFE_ROLE = { name: "app", superuser: false, bypassRls: false, bypasses: false };

describe("formatCoverage", () => {
  it("says so plainly when everything is protected", () => {
    expect(
      formatCoverage({
        role: SAFE_ROLE,
        rows: [{} as never, {} as never],
        unprotected: [],
        ok: true,
      }),
    ).toBe("pgrls: all 2 tables are protected.");
  });

  it("names each offender on its own line", () => {
    const message = formatCoverage({
      role: SAFE_ROLE,
      rows: [{} as never, {} as never],
      ok: false,
      unprotected: [
        {
          schema: "public",
          table: "audit_log",
          rlsEnabled: false,
          rlsForced: false,
          policyCount: 0,
          problem: "no-rls",
          reason: "row-level security is not enabled",
        },
      ],
    });
    expect(message).toContain("1 of 2 tables are not protected");
    expect(message).toContain("public.audit_log");
  });
});
