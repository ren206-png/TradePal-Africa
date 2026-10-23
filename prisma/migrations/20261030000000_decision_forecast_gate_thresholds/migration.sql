-- Decision OPEN-6 (2026-10-20): promotion thresholds for demand forecasting. A merchant becomes eligible only after 8 scored weeks AND a forecast
-- error at least 15% (1,500 basis points) lower than the simple Tier 1 rule on THAT merchant's own data. Opening a merchant's gate remains a
-- separate, audited owner action per merchant; this only sets the minimums. Does nothing if the owner already set values.
INSERT INTO "ForecastGateConfig" ("id", "minScoredWeeks", "minImprovementBps", "updatedBy")
VALUES (1, 8, 1500, 'decision-2026-10-20')
ON CONFLICT ("id") DO NOTHING;
