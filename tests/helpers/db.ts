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
