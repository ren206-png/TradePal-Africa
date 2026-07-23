// One-off script: renders a simple branded 1200x630 OG image to public/og-image.png.
// Run with `node scripts/generate-og-image.mjs` whenever the design/copy changes.
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, "..", "public", "og-image.png");

const svg = `
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f766e" />
      <stop offset="100%" stop-color="#0d9488" />
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)" />
  <rect x="80" y="80" width="88" height="88" rx="20" fill="white" />
  <text x="104" y="146" font-family="Arial, sans-serif" font-size="56" font-weight="700" fill="#0d9488">T</text>
  <text x="80" y="300" font-family="Arial, sans-serif" font-size="72" font-weight="800" fill="white">TradePal Africa</text>
  <text x="80" y="370" font-family="Arial, sans-serif" font-size="34" fill="#ccfbf1">Run your shop's books right inside WhatsApp</text>
  <text x="80" y="540" font-family="Arial, sans-serif" font-size="26" fill="#99f6e4">No app to download. No training required.</text>
</svg>
`;

await sharp(Buffer.from(svg)).png().toFile(outPath);
console.log("Wrote", outPath);
