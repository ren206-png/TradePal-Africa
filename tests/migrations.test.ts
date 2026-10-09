import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { SUPPORTED_COUNTRIES } from "../src/config/countries.js";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "prisma/migrations");

function migrationNames(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((n) => fs.statSync(path.join(MIGRATIONS_DIR, n)).isDirectory())
    .sort();
}
const sql = (name: string) => fs.readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");

describe("migrations (real SQL, applied in order to an empty Postgres)", () => {
  it("apply cleanly, and the Liberia/Gambia reference-data migration is idempotent and matches config/countries.ts", async () => {
    const db = new PGlite();
    for (const name of migrationNames()) await db.exec(sql(name));

    const refData = migrationNames().find((n) => n.endsWith("liberia_gambia_reference_data"));
    expect(refData).toBeDefined();
    // Running it again (e.g. on a database the seed already populated) must change nothing and not throw.
    await db.exec(sql(refData!));

    for (const code of ["LR", "GM"]) {
      const expected = SUPPORTED_COUNTRIES.find((c) => c.code === code)!;
      const { rows } = await db.query<{ name: string; callingCode: string; defaultCurrency: string; defaultTimezone: string; minorUnitExp: number; voiceEnabled: boolean; defaultLanguage: string }>(
        `select c."name", c."callingCode", c."defaultCurrency", c."defaultTimezone", cur."minorUnitExp", cfg."voiceEnabled", cfg."defaultLanguage"
           from "Country" c
           join "Currency" cur on cur."code" = c."defaultCurrency"
           join "CountryConfig" cfg on cfg."countryCode" = c."code"
          where c."code" = $1`,
        [code],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: expected.name,
        callingCode: expected.callingCode,
        defaultCurrency: expected.currency.code,
        defaultTimezone: expected.defaultTimezone,
        minorUnitExp: expected.currency.minorUnitExp,
        voiceEnabled: expected.voiceEnabled,
        defaultLanguage: expected.defaultLanguage,
      });
    }
    await db.close();
  }, 60_000);

  it("does not overwrite rows the seed already created", async () => {
    const db = new PGlite();
    const names = migrationNames();
    const refData = names.find((n) => n.endsWith("liberia_gambia_reference_data"))!;
    for (const name of names.filter((n) => n !== refData)) await db.exec(sql(name));
    // A database the seed already populated, with a deliberately different Liberia name.
    await db.exec(`
      insert into "Language" ("code","name") values ('en','English');
      insert into "Currency" ("code","name","minorUnitExp") values ('LRD','Seeded Liberian Dollar',2);
      insert into "Country" ("code","name","callingCode","defaultCurrency","defaultTimezone") values ('LR','Seeded Liberia','231','LRD','Africa/Monrovia');
      insert into "CountryConfig" ("id","countryCode","defaultLanguage","voiceEnabled","updatedAt") values ('seeded-id','LR','en',false,now());
    `);
    await db.exec(sql(refData));
    const { rows } = await db.query<{ name: string; n: number }>(
      `select c."name", (select count(*)::int from "CountryConfig" where "countryCode"='LR') as n from "Country" c where c."code"='LR'`,
    );
    expect(rows[0]).toEqual({ name: "Seeded Liberia", n: 1 });
    await db.close();
  }, 60_000);

  it("every supported country beyond the original four has its reference data created by a migration", async () => {
    // Country/Currency/CountryConfig rows used to come ONLY from prisma/seed.ts, which isn't re-run on
    // a live database — so adding a country to config/countries.ts without a migration left its
    // merchants unable to sign up (production's Liberia/Gambia outage). Nigeria, Kenya, Sierra Leone
    // and Ghana predate migrations-as-the-mechanism and were seeded; anything added after them must
    // come with a migration. Add a migration (not just a seed entry) for the next country.
    const SEEDED_ORIGINALS = new Set(["NG", "KE", "SL", "GH"]);
    const db = new PGlite();
    for (const name of migrationNames()) await db.exec(sql(name));
    for (const country of SUPPORTED_COUNTRIES.filter((c) => !SEEDED_ORIGINALS.has(c.code))) {
      const { rows } = await db.query(
        `select 1 from "Country" c join "CountryConfig" cfg on cfg."countryCode" = c."code" where c."code" = $1`,
        [country.code],
      );
      expect(rows, `no migration creates the Country/CountryConfig rows for ${country.name} (${country.code})`).toHaveLength(1);
    }
    await db.close();
  }, 60_000);
});
