import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportIncident, resetAlertDedupeForTests, type AlertEmailDeps } from "../src/monitoring/alerts.js";

describe("reportIncident", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetAlertDedupeForTests();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("always logs to console, even with no email deps configured", async () => {
    await reportIncident(undefined, { service: "worker", title: "Job failed", detail: "boom" });

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("worker: Job failed — boom"));
  });

  it("never throws when the deps are missing", async () => {
    await expect(
      reportIncident(undefined, { service: "worker", title: "Job failed", detail: "boom" }),
    ).resolves.toBeUndefined();
  });

  it("sends an email via the Resend API when deps are configured", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    const deps: AlertEmailDeps = { apiKey: "key-1", from: "alerts@tradepal.africa", to: ["ren@example.com"], fetchImpl };

    await reportIncident(deps, { service: "worker", title: "Job failed", detail: "boom" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers).toMatchObject({ Authorization: "Bearer key-1" });
    const body = JSON.parse(init.body as string);
    expect(body.from).toBe("alerts@tradepal.africa");
    expect(body.to).toEqual(["ren@example.com"]);
    expect(body.subject).toContain("Job failed");
    expect(body.text).toBe("boom");
  });

  it("dedupes identical incidents (same service+title) within the 15-minute window", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    const deps: AlertEmailDeps = { apiKey: "key-1", from: "alerts@tradepal.africa", to: ["ren@example.com"], fetchImpl };

    await reportIncident(deps, { service: "worker", title: "Job failed", detail: "first occurrence" });
    await reportIncident(deps, { service: "worker", title: "Job failed", detail: "second occurrence" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not dedupe across different services or different titles", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "email-1" }), { status: 200 }));
    const deps: AlertEmailDeps = { apiKey: "key-1", from: "alerts@tradepal.africa", to: ["ren@example.com"], fetchImpl };

    await reportIncident(deps, { service: "worker", title: "Job failed", detail: "d1" });
    await reportIncident(deps, { service: "server", title: "Job failed", detail: "d2" });
    await reportIncident(deps, { service: "worker", title: "Different problem", detail: "d3" });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("swallows a non-2xx Resend response without throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    const deps: AlertEmailDeps = { apiKey: "key-1", from: "alerts@tradepal.africa", to: ["ren@example.com"], fetchImpl };

    await expect(
      reportIncident(deps, { service: "worker", title: "Job failed", detail: "boom" }),
    ).resolves.toBeUndefined();
  });

  it("swallows a thrown/rejected fetch without throwing", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network blip"));
    const deps: AlertEmailDeps = { apiKey: "key-1", from: "alerts@tradepal.africa", to: ["ren@example.com"], fetchImpl };

    await expect(
      reportIncident(deps, { service: "worker", title: "Job failed", detail: "boom" }),
    ).resolves.toBeUndefined();
  });
});
