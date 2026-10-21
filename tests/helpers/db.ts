import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import pg from "pg";
import { PrismaClient } from "@prisma/client";

const SCHEMA_PATH = path.resolve(process.cwd(), "prisma/schema.prisma");

let cachedDdl: string | null = null;

function getDdl(): string {
  if (cachedDdl) return cachedDdl;
  cachedDdl = execSync(
    `npx prisma migrate diff --from-empty --to-schema-datamodel ${JSON.stringify(SCHEMA_PATH)} --script`,
    { encoding: "utf-8" },
  );
  return cachedDdl;
}

/**
 * The database-level protection (append-only triggers, delete protection, RLS policies) lives in a migration so
 * production gets it; the test DB is built from the schema, so tests apply that same SQL on top. It is ON by
 * default so every suite exercises application code against the real triggers; set TEST_DB_PROTECTION=0 to
 * compare against an unprotected database.
 */
/** Phase-1 migrations whose hand-written section (everything from the "-- =====" banner on) the test DB applies. */
export const HAND_WRITTEN_MIGRATIONS = [
  "20261020000100_phase1_db_protection",
  "20261020000200_phase1_shops_memberships",
  "20261020000300_phase1_outbox_inbox",
  "20261020000400_phase1_admin_core",
  "20261021000000_phase2_catalog_stock_journals",
  "20261022000000_phase3_trade_reorder_forecast",
  "20261023000000_phase4_storefront_orders_support",
  "20261024000000_phase5_payments_marketplace",
  "20261025000000_phase6_billing_entitlements",
  "20261026000000_phase7_messaging_consent_drafts",
  "20261027000000_phase8_reports_flag",
  "20261028000000_phase9_job_control",
] as const;
export function dbProtectionSql(): string {
  return HAND_WRITTEN_MIGRATIONS.map((name) => {
    const full = fs.readFileSync(path.resolve(process.cwd(), "prisma/migrations", name, "migration.sql"), "utf8");
    // Drop the generated DDL (the schema DDL already has those objects); keep the hand-written section.
    return full.slice(full.indexOf("-- ====="));
  }).join("\n");
}

export interface TestDb {
  prisma: PrismaClient;
  /**
   * The underlying in-process Postgres. Use it to PROVOKE a database error on purpose (a trigger or policy
   * rejection): through the socket the test server drops the connection after an error and Prisma's pool then
   * fails later statements, while calling the instance directly leaves everything usable.
   */
  db: PGlite;
  teardown: () => Promise<void>;
}

/**
 * Spins up an isolated PGlite instance exposed over the real Postgres wire
 * protocol, applies the full schema DDL (generated via `prisma migrate diff
 * --from-empty`, which needs no live DB connection), and returns a real
 * `@prisma/client` connected to it. The Prisma schema-engine (db push/migrate)
 * cannot talk to the PGlite socket, but the query-engine used by
 * `@prisma/client` can — see PHASE_0_FINDINGS.md spike notes.
 *
 * Port 0 asks the OS for a free ephemeral port: vitest runs each test file in
 * its own process/module registry, so a fixed port collides across files.
 */
export async function createTestDb(): Promise<TestDb> {
  if (process.env["TEST_PG_ADMIN_URL"]) return createRealPostgresTestDb(process.env["TEST_PG_ADMIN_URL"]);
  const db = new PGlite();
  const socketServer = new PGLiteSocketServer({ db, port: 0, host: "127.0.0.1", maxConnections: 10 });
  await socketServer.start();
  const port = socketServer.getServerConn().split(":").pop();

  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;

  const raw = new pg.Client({ connectionString: url });
  await raw.connect();
  await raw.query(getDdl());
  if (process.env["TEST_DB_PROTECTION"] !== "0") await raw.query(dbProtectionSql());
  await raw.end();

  const prisma = new PrismaClient({ datasourceUrl: url });

  const teardown = async () => {
    await prisma.$disconnect();
    await socketServer.stop();
    await db.close();
  };

  return { prisma, db, teardown };
}

/**
 * TEST SETUP ONLY: moves a Transaction's createdAt into the past (e.g. "last month's sale") for date-window tests.
 * Production code can never do this: the database rejects any UPDATE on Transaction. The trigger is disabled for
 * this one statement inside a transaction and re-enabled before it commits.
 */
export async function backdateTransaction(prisma: PrismaClient, transactionId: string, createdAt: Date): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE "Transaction" DISABLE TRIGGER USER');
    await tx.$executeRaw`UPDATE "Transaction" SET "createdAt" = ${createdAt} WHERE id = ${transactionId}`;
    await tx.$executeRawUnsafe('ALTER TABLE "Transaction" ENABLE TRIGGER USER');
  });
}

/**
 * Optional REAL Postgres mode: set TEST_PG_ADMIN_URL to a throw-away server (superuser URL, e.g. postgresql://postgres@127.0.0.1:54329/postgres).
 * Each call creates its own database there and drops it on teardown. The suite then runs against genuine Postgres (real locks, real
 * connection pool, real planner) instead of PGlite. `db` is a small adapter exposing the PGlite calls the tests use.
 * NEVER point this at a database that holds data you care about.
 */
async function createRealPostgresTestDb(adminUrl: string): Promise<TestDb> {
  const host = new URL(adminUrl).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("TEST_PG_ADMIN_URL must be a local server");
  const name = `t_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  const types = { getTypeParser: (oid: number, fmt?: "text" | "binary") => (oid === 20 ? (v: string) => Number(v) : pg.types.getTypeParser(oid, fmt as "text")) };
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  const raw = new pg.Client({ connectionString: url, types: types as never });
  await raw.connect();
  await raw.query(getDdl());
  if (process.env["TEST_DB_PROTECTION"] !== "0") await raw.query(dbProtectionSql());
  const adapter = {
    query: async (text: string, params?: unknown[]) => {
      const r = await raw.query(text, params as never[]);
      return { rows: r.rows, affectedRows: r.rowCount ?? 0, fields: r.fields };
    },
    exec: async (text: string) => {
      await raw.query(text);
    },
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      await raw.query("BEGIN");
      try {
        const out = await fn({ query: adapter.query, exec: adapter.exec, rollback: async () => { await raw.query("ROLLBACK"); } });
        await raw.query("COMMIT").catch(() => undefined);
        return out;
      } catch (e) {
        await raw.query("ROLLBACK").catch(() => undefined);
        throw e;
      }
    },
    close: async () => undefined,
  };
  const prisma = new PrismaClient({ datasourceUrl: url });
  const teardown = async () => {
    await prisma.$disconnect();
    await raw.end().catch(() => undefined);
    const a = new pg.Client({ connectionString: adminUrl });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await a.end();
  };
  return { prisma, db: adapter as unknown as PGlite, teardown };
}
