import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildDeepSeekDepsFromEnv } from "../src/config/deepseekEnv.js";
import { DEFAULT_DEEPSEEK_MODEL_KEY } from "../src/ai/modelRegistry.js";

const ENV_KEYS = ["DEEPSEEK_API_KEY", "AI_DEEPSEEK_MODEL"] as const;

describe("buildDeepSeekDepsFromEnv", () => {
  let originalValues: Record<string, string | undefined>;

  beforeEach(() => {
    originalValues = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalValues[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("returns undefined when DEEPSEEK_API_KEY is unset — mirrors every other build*DepsFromEnv() optional bundle", () => {
    expect(buildDeepSeekDepsFromEnv()).toBeUndefined();
  });

  it("returns the pinned default model key when AI_DEEPSEEK_MODEL is unset", () => {
    process.env["DEEPSEEK_API_KEY"] = "sk-test";
    expect(buildDeepSeekDepsFromEnv()).toEqual({ apiKey: "sk-test", modelKey: DEFAULT_DEEPSEEK_MODEL_KEY });
  });

  it("uses an explicit AI_DEEPSEEK_MODEL when it resolves to a real registry entry", () => {
    process.env["DEEPSEEK_API_KEY"] = "sk-test";
    process.env["AI_DEEPSEEK_MODEL"] = "deepseek-v4-flash-2026-06-snapshot";
    expect(buildDeepSeekDepsFromEnv()).toEqual({ apiKey: "sk-test", modelKey: "deepseek-v4-flash-2026-06-snapshot" });
  });

  it("returns undefined — not a silent fallback to the default — when AI_DEEPSEEK_MODEL is set but unrecognized", () => {
    process.env["DEEPSEEK_API_KEY"] = "sk-test";
    process.env["AI_DEEPSEEK_MODEL"] = "deepseek-v4-flash"; // the moving alias D-3 explicitly rejects, not a registry key
    expect(buildDeepSeekDepsFromEnv()).toBeUndefined();
  });
});
