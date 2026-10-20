import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

/**
 * Guards hand-written and generated migrations against drifting from prisma/schema.prisma: a database built by
 * applying every migration in order must have exactly the same tables, columns, types, nullability, enums and
 * indexes as one built straight from the schema. (Enum members are compared as sets: ALTER TYPE ... ADD VALUE
 * appends, so label order legitimately differs and Prisma never depends on it.) (The test suites build their databases from the schema, so
 * without this a migration that forgets a column would pass every other test and fail only in production.)
 */
const MIGRATIONS_DIR = path.resolve(process.cwd(), "prisma/migrations");
/** Objects the migrations create that Prisma's datamodel cannot express (partial indexes). */
const MIGRATION_ONLY_INDEXES = new Set(["Shop.Shop_one_default_per_business", "ReorderSuggestion.ReorderSuggestion_one_open_per_method", "PaymentAttempt.PaymentAttempt_one_active_per_intent", "BillingAttempt.BillingAttempt_one_active_per_invoice"]);
const SCHEMA_PATH = path.resolve(process.cwd(), "prisma/schema.prisma");

async function shape(db: PGlite) {
  const columns = await db.query<{ t: string }>(
    `SELECT table_name || '.' || column_name || ' ' || udt_name || ' ' || is_nullable AS t
       FROM information_schema.columns WHERE table_schema = 'public' ORDER BY 1`,
  );
  const enums = await db.query<{ t: string }>(
    `SELECT t.typname || ':' || string_agg(e.enumlabel, ',' ORDER BY e.enumlabel) AS t
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname ORDER BY 1`,
  );
  const indexes = await db.query<{ t: string }>(
    `SELECT tablename || '.' || indexname AS t FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1`,
  );
  const constraints = await db.query<{ t: string }>(
    `SELECT conrelid::regclass::text || '.' || conname || ' ' || contype::text AS t
       FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1`,
  );
  return {
    columns: columns.rows.map((r) => r.t),
    enums: enums.rows.map((r) => r.t),
    indexes: indexes.rows.map((r) => r.t),
    constraints: constraints.rows.map((r) => r.t),
  };
}

describe("migrations match prisma/schema.prisma", () => {
  it("applying every migration in order yields the same schema as building from the datamodel", async () => {
    const fromSchema = new PGlite();
    await fromSchema.exec(
      execSync(`npx prisma migrate diff --from-empty --to-schema-datamodel ${JSON.stringify(SCHEMA_PATH)} --script`, { encoding: "utf-8" }),
    );

    const fromMigrations = new PGlite();
    const names = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((n) => fs.statSync(path.join(MIGRATIONS_DIR, n)).isDirectory())
      .sort();
    for (const name of names) await fromMigrations.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8"));

    const a = await shape(fromSchema);
    const b = await shape(fromMigrations);
    expect(b.columns).toEqual(a.columns);
    expect(b.enums).toEqual(a.enums);
    expect(b.indexes.filter((i) => !MIGRATION_ONLY_INDEXES.has(i))).toEqual(a.indexes);
    for (const only of MIGRATION_ONLY_INDEXES) expect(b.indexes).toContain(only);
    // Hand-written CHECK ('c') and constraint-trigger ('t') constraints exist only in the migrations (Prisma cannot express them).
    const handWritten = (c: string) => / [ct]$/.test(c);
    expect(b.constraints.filter((c) => !handWritten(c))).toEqual(a.constraints);
    expect(b.constraints.filter(handWritten).length).toBeGreaterThan(0);

    await fromSchema.close();
    await fromMigrations.close();
  }, 120_000);
});
