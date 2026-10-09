import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestErrorHandler } from "../src/monitoring/requestErrorHandler.js";

vi.mock("../src/monitoring/alerts.js", () => ({ reportIncident: vi.fn(async () => {}) }));
import { reportIncident } from "../src/monitoring/alerts.js";

function buildApp() {
  const app = express();
  app.use(express.json({ limit: "1kb" }));
  app.post("/echo", (req, res) => {
    res.json(req.body);
  });
  app.get("/boom", () => {
    throw new Error("secret internal detail");
  });
  app.use(createRequestErrorHandler(undefined, "test"));
  return app;
}

describe("createRequestErrorHandler", () => {
  beforeEach(() => {
    vi.mocked(reportIncident).mockClear();
  });

  it("answers malformed JSON with 400 and does not raise an incident", async () => {
    const res = await request(buildApp()).post("/echo").set("content-type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid request." });
    expect(reportIncident).not.toHaveBeenCalled();
  });

  it("answers an oversized body with 413 and does not raise an incident", async () => {
    const res = await request(buildApp())
      .post("/echo")
      .set("content-type", "application/json")
      .send(JSON.stringify({ blob: "x".repeat(5000) }));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "Payload too large." });
    expect(reportIncident).not.toHaveBeenCalled();
  });

  it("still reports an unexpected error as an incident and answers 500 without leaking detail", async () => {
    const res = await request(buildApp()).get("/boom");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error." });
    expect(JSON.stringify(res.body)).not.toContain("secret internal detail");
    expect(reportIncident).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportIncident).mock.calls[0]?.[1]).toMatchObject({ service: "test", title: "Unhandled request error" });
  });
});
