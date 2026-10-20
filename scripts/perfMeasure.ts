/**
 * Repeatable page measurements against a running `scripts/perfServer.ts`. Reports, for each page: status, bytes as sent, bytes if
 * gzip-compressed (computed), median and p95 server time to first byte and total over N runs, and what that many bytes cost on three
 * reference connections (COMPUTED from the byte count: not a network measurement). It does NOT measure rendering time, CPU-bound work on a
 * low-end phone, or a real throttled link: say so wherever the numbers are quoted.
 *
 *   npx tsx scripts/perfMeasure.ts http://127.0.0.1:4173 [token]
 */
import { gzipSync } from "node:zlib";

const base = process.argv[2];
const token = process.argv[3];
if (!base) { console.error("Usage: npx tsx scripts/perfMeasure.ts <base-url> [phone-token]"); process.exit(2); }
const N = Number(process.env["RUNS"] ?? 15);
const LINKS = [["2G (50 kbit/s)", 50_000], ["slow 3G (400 kbit/s)", 400_000], ["3G (1.6 Mbit/s)", 1_600_000]] as const;

interface Page { name: string; path: string; auth?: boolean }
const pages: Page[] = [
  { name: "shop page (30 products)", path: "/shop/perf-shop" },
  { name: "basket (empty)", path: "/basket" },
  { name: "phone page (HTML)", path: "/m/" },
  { name: "phone page script", path: "/m/app.js" },
  { name: "phone service worker", path: "/m/sw.js" },
  { name: "report: sales, this month (JSON)", path: "/m/api/reports/sales?period=month", auth: true },
  { name: "report: sales (CSV)", path: "/m/api/reports/sales.csv?period=month", auth: true },
  { name: "report: inventory valuation (JSON)", path: "/m/api/reports/inventory-valuation", auth: true },
];

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
const rows: string[] = [];
for (const p of pages) {
  const ttfb: number[] = [];
  const total: number[] = [];
  let bytes = 0, gz = 0, status = 0, wireBytes = 0, encoding = "none";
  for (let i = 0; i < N + 1; i++) {
    const t0 = performance.now();
    const res = await fetch(base + p.path, { headers: { "Accept-Encoding": "gzip", ...(p.auth && token ? { Authorization: `Bearer ${token}` } : {}) } });
    const first = performance.now();
    const body = Buffer.from(await res.arrayBuffer());
    const end = performance.now();
    if (i === 0) { bytes = body.length; gz = gzipSync(body).length; status = res.status; wireBytes = Number(res.headers.get("content-length") ?? 0) || bytes; encoding = res.headers.get("content-encoding") ?? "none"; continue; } // the first run warms caches
    ttfb.push(first - t0);
    total.push(end - t0);
  }
  const secs = (b: number, bps: number) => ((b * 8) / bps).toFixed(1);
  rows.push(`| ${p.name} | ${status} | ${(bytes / 1024).toFixed(1)} | ${(wireBytes / 1024).toFixed(1)} (${encoding}) | ${pct(ttfb, 50).toFixed(0)} / ${pct(ttfb, 95).toFixed(0)} | ${pct(total, 50).toFixed(0)} | ${LINKS.map(([, bps]) => `${secs(wireBytes, bps)}s`).join(" / ")} |`);
}
console.log(`| Page | Status | KB uncompressed | KB on the wire (as served) | TTFB ms (median / p95) | Total ms (median) | Transfer time of the bytes on the wire, ${LINKS.map(([n]) => n).join(" / ")} (computed) |`);
console.log("|---|---|---|---|---|---|---|");
console.log(rows.join("\n"));
console.log(`\nRuns per page: ${N} after one warm-up. Server and client on one machine, in-process Postgres (PGlite): TTFB here is NOT what a phone on a mobile network sees.`);
