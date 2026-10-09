-- Liberia and Gambia reference data.
--
-- config/countries.ts lists both as supported, but Country/Currency/CountryConfig rows are only
-- ever created by prisma/seed.ts, which was not re-run when the two countries were added. In
-- production a first message from a +231 or +220 number therefore failed on a foreign key
-- (Business_countryCode_fkey) and the merchant got no reply at all. Idempotent (ON CONFLICT DO
-- NOTHING), so it is safe on a database the seed has already populated and on re-runs.
-- Values mirror config/countries.ts exactly.

INSERT INTO "Language" ("code", "name")
VALUES ('en', 'English')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "Currency" ("code", "name", "minorUnitExp")
VALUES
  ('LRD', 'Liberian Dollar', 2),
  ('GMD', 'Gambian Dalasi', 2)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "Country" ("code", "name", "callingCode", "defaultCurrency", "defaultTimezone")
VALUES
  ('LR', 'Liberia', '231', 'LRD', 'Africa/Monrovia'),
  ('GM', 'Gambia', '220', 'GMD', 'Africa/Banjul')
ON CONFLICT ("code") DO NOTHING;

-- CountryConfig.id's uuid default lives in Prisma, not in the database, so it is supplied here.
INSERT INTO "CountryConfig" ("id", "countryCode", "defaultLanguage", "voiceEnabled", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'LR', 'en', false, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'GM', 'en', false, CURRENT_TIMESTAMP)
ON CONFLICT ("countryCode") DO NOTHING;
