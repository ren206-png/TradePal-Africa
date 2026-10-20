import { describe, expect, it } from "vitest";
import { runDemo } from "../scripts/demoWholesale.js";

describe("demo: wholesaler -> retailer with the simulator, and shadow forecast scores", () => {
  it("runs end to end and the numbers add up", async () => {
    const lines: string[] = [];
    const r = await runDemo((l) => lines.push(l));
    expect(r.suggestion).toMatchObject({ method: "TIER1_FIXED", suggestedBaseQty: 60 });
    expect(r.order).toMatchObject({ totalMinor: 660_000n, acceptance: "ACCEPTED" });
    expect(r.wholesaler).toMatchObject({
      revenueMinor: 660_000n, cogsMinor: 576_000n, grossMarginMinor: 84_000n, // 72 cans x 8,000 cost
      receivableMinor: 0n, providerClearingMinor: 660_000n, stock: 128,
    });
    expect(r.retailer.stock).toBe(72);
    expect(r.retailer.payableMinor).toBe(0n); // paid
    expect(r.retailer.inventoryMinor).toBe(660_000n);
    expect(r.invoicePaid).toBe(true);
    expect(r.forecast.scoredWeeks).toBe(4);
    expect(r.forecast.improvementBps!).toBeGreaterThan(2_000);
    expect(lines.join("\n")).toContain('"status":"duplicate"');
  }, 120_000);
});
