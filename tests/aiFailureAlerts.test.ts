import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import type { PrismaClient } from "@prisma/client";
import { createTestDb, type TestDb } from "./helpers/db.js";
import { classifyAiProviderFailure } from "../src/ai/failureClass.js";
import { DeepSeekHttpError } from "../src/ai/deepseekProvider.js";
import { reportIncident, resetAlertDedupeForTests, setAlertDeliveryRecorder, verifyAlertChannel, type AlertEmailDeps } from "../src/monitoring/alerts.js";
import { alertChannelStatus, installAlertDeliveryRecorder } from "../src/monitoring/alertRecorder.js";

vi.setConfig({ testTimeout: 60_000 });

let testDb: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb();
  prisma = testDb.prisma;
}, 60_000);
afterAll(async () => {
  await testDb.teardown();
});
beforeEach(async () => {
  resetAlertDedupeForTests();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  installAlertDeliveryRecorder(prisma);
  base = await prisma.alertDelivery.count();
});
afterEach(() => {
  setAlertDeliveryRecorder(null);
  vi.restoreAllMocks();
});

const ok = (id = "email-1") => new Response(JSON.stringify({ id }), { status: 200 });
const deps = (fetchImpl: typeof fetch): AlertEmailDeps => ({ apiKey: "k", from: "alerts@tradepal.africa", to: ["ren@example.com"], fetchImpl });
let base = 0;
/** Rows written by the current test only (the table is append-only, so earlier tests' rows stay). */
// A real Postgres can stamp two quick inserts with the same millisecond; tests that read rows back in order pause between them.
const tick = () => new Promise((r) => setTimeout(r, 3));
const rows = async () => (await prisma.alertDelivery.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).slice(base);

describe("classifying an AI provider failure (scenario 26)", () => {
  const apiError = (status: number, type = "invalid_request_error", message = "x") => new Anthropic.APIError(status, { type: "error", error: { type, message } }, "e", new Headers());

  it("gives billing and authentication their own title per provider", () => {
    const titles = [
      classifyAiProviderFailure(new DeepSeekHttpError(402, "Insufficient Balance"))?.title,
      classifyAiProviderFailure(new DeepSeekHttpError(401, "bad key"))?.title,
      classifyAiProviderFailure(apiError(400, "invalid_request_error", "Your credit balance is too low"))?.title,
      classifyAiProviderFailure(apiError(401, "authentication_error"))?.title,
    ];
    expect(titles).toEqual([
      "AI provider billing failure (DeepSeek)",
      "AI provider authentication failure (DeepSeek)",
      "AI provider billing failure (Anthropic)",
      "AI provider authentication failure (Anthropic)",
    ]);
    expect(new Set(titles).size).toBe(4);
  });

  it("treats 403 as authentication, and leaves transient failures to the generic path", () => {
    expect(classifyAiProviderFailure(new DeepSeekHttpError(403, "forbidden"))?.kind).toBe("AUTH");
    for (const e of [new DeepSeekHttpError(500, "upstream"), new DeepSeekHttpError(429, "slow down"), apiError(529, "overloaded_error"), apiError(400, "invalid_request_error", "bad json"), new Error("boom"), new TypeError("fetch failed")]) {
      expect(classifyAiProviderFailure(e)).toBeNull();
    }
  });
});

describe("alerts that are verified to deliver", () => {
  it("records every delivery with the email service's message id", async () => {
    const f = vi.fn().mockResolvedValue(ok("msg-42"));
    await reportIncident(deps(f), { service: "worker", title: "AI provider billing failure (DeepSeek)", detail: "d" });
    const [r] = await rows();
    expect(r).toMatchObject({ status: "DELIVERED", kind: "INCIDENT", channel: "EMAIL", providerMessageId: "msg-42", httpStatus: 200, title: "AI provider billing failure (DeepSeek)" });
  });

  it("records a refusal, and a refused send does not use up the dedupe window: the next occurrence tries again", async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response("invalid api key", { status: 403 })).mockResolvedValueOnce(ok("msg-2"));
    const incident = { service: "worker", title: "AI provider authentication failure (DeepSeek)", detail: "d" };
    await reportIncident(deps(f), incident);
    await tick();
    await reportIncident(deps(f), incident);
    await reportIncident(deps(f), incident); // delivered already: this one is deduped
    expect(f).toHaveBeenCalledTimes(2);
    const r = await rows();
    expect(r.map((x) => x.status)).toEqual(["FAILED", "DELIVERED"]);
    expect(r[0]).toMatchObject({ httpStatus: 403, error: "invalid api key" });
  });

  it("records a network failure, and says so when no alert channel is configured at all", async () => {
    await reportIncident(deps(vi.fn().mockRejectedValue(new TypeError("fetch failed"))), { service: "worker", title: "T1", detail: "d" });
    await tick();
    await reportIncident(undefined, { service: "worker", title: "T2", detail: "d" });
    await reportIncident(undefined, { service: "worker", title: "T2", detail: "again" }); // once per window
    const r = await rows();
    expect(r.map((x) => [x.title, x.status])).toEqual([["T1", "FAILED"], ["T2", "FAILED"]]);
    expect(r[0]!.error).toContain("fetch failed");
    expect(r[1]!.error).toContain("No alert channel is configured");
  });

  it("a channel check proves the channel now and is recorded as a check", async () => {
    const good = await verifyAlertChannel(deps(vi.fn().mockResolvedValue(ok("chk-1"))));
    expect(good).toMatchObject({ delivered: true, providerMessageId: "chk-1" });
    await tick();
    const bad = await verifyAlertChannel(deps(vi.fn().mockResolvedValue(new Response("nope", { status: 401 }))));
    expect(bad.delivered).toBe(false);
    await tick();
    const none = await verifyAlertChannel(undefined);
    expect(none.delivered).toBe(false);
    expect((await rows()).map((x) => [x.kind, x.status])).toEqual([["CHANNEL_CHECK", "DELIVERED"], ["CHANNEL_CHECK", "FAILED"], ["CHANNEL_CHECK", "FAILED"]]);
  });

  it("flags the channel as needing attention when nothing was proven recently or the latest attempt failed", async () => {
    await testDb.db.query(`SELECT 1`);
    const before = await alertChannelStatus(prisma, new Date(Date.now() + 30 * 86_400_000));
    expect(before.needsAttention).toBe(true); // far in the future: nothing is "recent"
    const s = await alertChannelStatus(prisma);
    expect(s.failedLast7Days).toBeGreaterThan(0);
    expect(s.lastDeliveredAt).not.toBeNull();
    expect(s.needsAttention).toBe(true); // the most recent attempt (the last check above) failed
    await verifyAlertChannel(deps(vi.fn().mockResolvedValue(ok("chk-2"))));
    expect((await alertChannelStatus(prisma)).needsAttention).toBe(false);
  });

  it("delivery records are append-only", async () => {
    await expect(testDb.db.query(`UPDATE "AlertDelivery" SET "status"='DELIVERED'`)).rejects.toThrow(/append-only/);
    await expect(testDb.db.query(`DELETE FROM "AlertDelivery"`)).rejects.toThrow(/append-only/);
  });
});
