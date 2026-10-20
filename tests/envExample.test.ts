import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Configuration examples without secrets (section 22): every environment variable the code reads is documented in `.env.example`, and none carries a value. */
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe(".env.example", () => {
  const example = readFileSync(join(process.cwd(), ".env.example"), "utf8");
  const names = new Set<string>();
  for (const file of walk(join(process.cwd(), "src"))) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:process\.env|\benv)\[\s*"([A-Z][A-Z0-9_]{3,})"\s*\]|requireEnv\(\s*"([A-Z][A-Z0-9_]{3,})"\s*\)/g)) names.add(m[1] ?? m[2]!);
  }
  const OPTIONAL_PLATFORM = new Set(["NODE_ENV"]);

  it("documents every environment variable the code reads", () => {
    const missing = [...names].filter((n) => !OPTIONAL_PLATFORM.has(n) && !new RegExp(`^#?\\s*${n}=`, "m").test(example));
    expect(missing).toEqual([]);
    expect(names.size).toBeGreaterThan(40);
  });

  it("carries no secret: no key, token, secret, pepper or hash has a value, and the only password is the local Docker development default", () => {
    const filled = example.split("\n").filter((l) => /^[A-Z][A-Z0-9_]+=\S/.test(l));
    const secretish = filled.filter((l) => /^[A-Z0-9_]*(KEY|TOKEN|SECRET|PEPPER|HASH)[A-Z0-9_]*=/.test(l));
    expect(secretish).toEqual([]);
    expect(filled.filter((l) => l.startsWith("POSTGRES_PASSWORD=") && l !== "POSTGRES_PASSWORD=tradepal")).toEqual([]);
    // everything that is filled in is a local development default
    expect(filled.every((l) => /(localhost|tradepal|=false|=memory|=3000)/.test(l))).toBe(true);
  });

  it("every expansion switch is documented as OFF/unset by default", () => {
    for (const n of ["STOREFRONT_ENABLED", "STOREFRONT_SIMULATOR_ENABLED", "CONSUMER_MESSAGING_ENABLED", "OFFLINE_DRAFTS_ENABLED", "REPORTS_WEB_ENABLED", "PAWAPAY_BILLING_PRODUCTION_ACTIVATED", "MARKETPLACE_ENABLED"]) {
      expect(example).toMatch(new RegExp(`^${n}=\\s*$`, "m"));
    }
  });
});
