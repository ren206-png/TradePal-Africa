import { defineConfig } from "vitest/config";

/**
 * Phase 17 gap closure: prior to this file existing, `npx vitest run` at the
 * repo root had no config at all, so Vitest fell back to its default include
 * glob (`**\/*.{test,spec}.*`) with no scoping. That was harmless while the
 * only test files lived under `tests/`, but once `admin-frontend/` grew its
 * own test suite (Phase 17, item 4 — vitest + jsdom + testing-library), the
 * root run started picking up admin-frontend's test files too and executing
 * them under Vitest's default `node` environment instead of admin-frontend's
 * own `jsdom` environment (configured in admin-frontend/vite.config.ts).
 * Result: spurious `ReferenceError: localStorage is not defined` failures for
 * every admin-frontend test when run from the root.
 *
 * admin-frontend is a separate app (its own package.json, its own
 * node_modules, its own vite.config.ts test block) and is intentionally not
 * part of the root pnpm workspace. Its tests are meant to be run via
 * `cd admin-frontend && npm test`, not from the root. Scoping the root
 * suite's `include` to `tests/**` (matching this project's actual test
 * layout) restores that separation explicitly instead of relying on
 * incidental glob behavior.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
