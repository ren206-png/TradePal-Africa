import { execSync } from "node:child_process";
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
    `npx prisma migrate diff --from-empty --to-schema-datamodel ${SCHEMA_PATH} --script`,
    { encoding: "utf-8" },
  );
  return cachedDdl;
}

export interface TestDb {
  prisma: PrismaClient;
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
  await raw.end();

  const prisma = new PrismaClient({ datasourceUrl: url });

  const teardown = async () => {
    await prisma.$disconnect();
    await socketServer.stop();
    await db.close();
  };

  return { prisma, teardown };
}
