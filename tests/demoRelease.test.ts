import { describe, expect, it } from "vitest";
import { runReleaseDemo } from "../scripts/demoRelease.js";

/** The release demo is part of the test suite: if any piece stops working together, this fails. */
describe("release demo: wholesaler -> retailer -> consumer -> simulator payment -> fulfilment -> reports, plus subscription and every admin panel", () => {
  it("runs end to end on one database, the numbers add up, and every panel is populated", async () => {
    const lines: string[] = [];
    const r = await runReleaseDemo((l) => lines.push(l));

    // trade: 3 cartons of 24 = 72 pieces bought for 6,600.00; the wholesaler booked it as revenue
    expect(r.trade).toMatchObject({ orderTotalMinor: 660_000n, wholesalerRevenueMinor: 660_000n });
    // consumer: 72 bought, 5 + 2 sold, the cancelled one never left stock
    expect(r.retailerBooks.stockUnits).toBe(72 - 5 - 2);
    expect(r.consumer).toMatchObject({ onlineOrderStatus: "COMPLETED", onlineOrderPaidMinor: 75_000n, cashOrderStatus: "COMPLETED", lateOnlinePaymentHeld: true });
    // books: revenue only at hand-over (7 pieces at 150.00), cost at the stock's own average cost (7 x 91.67 rounded to whole minor units)
    expect(r.retailerBooks.salesMinor).toBe(105_000n);
    expect(r.retailerBooks.cogsMinor).toBe(7n * 9_167n);
    expect(r.retailerBooks.cashMinor).toBe(30_000n);
    // the provider holds 900.00: Amaka's 750.00 and the late shopper's 150.00 (held as an exception, not revenue)
    expect(r.retailerBooks.providerClearingMinor).toBe(90_000n);

    // reports agree with the books and carry their warnings
    expect(r.retailerReports["sales"]!.text).toContain("Net sales: 1050.00 NGN");
    expect(r.retailerReports["gross-margin"]!.text).toContain("Cost of goods sold: 641.69 NGN");
    expect(r.retailerReports["gross-margin"]!.warnings).toContain("NOT_PROFIT");
    expect(r.retailerReports["inventory-valuation"]!.text).toContain("(65 units)");
    // the held late payment is reported as held, not as applied
    expect(r.retailerReports["payment-reconciliation"]!.text).toContain("applied: 750.00 NGN");
    expect(r.retailerReports["payment-reconciliation"]!.warnings).toContain("HELD_PAYMENTS");
    for (const rep of Object.values(r.retailerReports)) expect(rep.csvBytes).toBeGreaterThan(100);

    // subscription through the FAKE pawaPay: exact payment grants 30 days, a short one grants nothing
    expect(r.subscription).toMatchObject({ state: "ACTIVE", periodDays: 30, invoiceStatus: "PAID", paidMinor: 500_000n, billingExceptions: 1 });
    expect(r.forecast.scoredWeeks).toBe(4);
    expect(r.forecast.improvementBps!).toBeGreaterThan(2_000);

    // section 18: every panel is populated by the demo's data
    expect(r.panels.filter((p) => !p.populated)).toEqual([]);
    expect(r.panels.length).toBeGreaterThanOrEqual(18);

    const out = lines.join("\n");
    expect(out).toContain("SUPPRESSED (TEMPLATE_NOT_APPROVED)");
    expect(out).toContain("in-memory FAKE");
    expect(out).toContain("SIMULATED provider");
  }, 240_000);
});
