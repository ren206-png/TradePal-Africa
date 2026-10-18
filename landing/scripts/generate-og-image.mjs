// One-off script: renders a simple branded 1200x630 OG image to public/og-image.png.
// Run with `node scripts/generate-og-image.mjs` whenever the design/copy changes.
// Matches the "Market Ledger" look of the site: cream paper, forest ink, saffron, woven-cloth border.
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, "..", "public", "og-image.png");

// One 36x18 woven tile (same motif as the site's .weave band), repeated across the bottom edge.
const tile = (x) => `
  <g transform="translate(${x},0)">
    <path d="M18 2 27 9 18 16 9 9Z" fill="#e9a21b"/>
    <path d="M18 5.5 22.5 9 18 12.5 13.5 9Z" fill="#b5441f"/>
    <path d="M0 0 6 0 3 5Z M30 0 36 0 33 5Z M0 18 6 18 3 13Z M30 18 36 18 33 13Z" fill="#2f7d5b"/>
    <circle cx="18" cy="9" r="1.2" fill="#f7f1e5"/>
  </g>`;
const weave = Array.from({ length: 34 }, (_, i) => tile(i * 36)).join("");

const svg = `
<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#f7f1e5"/>
  <g stroke="#0f2a22" stroke-opacity="0.06" stroke-width="1">
    ${Array.from({ length: 15 }, (_, i) => `<line x1="0" y1="${40 * (i + 1)}" x2="1200" y2="${40 * (i + 1)}"/>`).join("")}
  </g>
  <circle cx="1060" cy="150" r="260" fill="#e9a21b" fill-opacity="0.18"/>

  <!-- logo mark -->
  <g transform="translate(80,76) scale(2.2)">
    <rect width="36" height="36" rx="10" fill="#0f2a22"/>
    <path d="M9.5 7.5h17a3.5 3.5 0 0 1 3.5 3.5v10a3.5 3.5 0 0 1-3.5 3.5H18l-6 4.5V24.5H9.5A3.5 3.5 0 0 1 6 21V11a3.5 3.5 0 0 1 3.5-3.5Z" fill="#f7f1e5"/>
    <rect x="11.5" y="11.6" width="12" height="2.8" rx="1" fill="#0f2a22"/>
    <rect x="16" y="11.6" width="2.8" height="9.8" rx="1" fill="#0f2a22"/>
    <circle cx="24.2" cy="20.6" r="2.2" fill="#e9a21b"/>
  </g>
  <text x="178" y="136" font-family="Georgia, 'Times New Roman', serif" font-size="46" font-weight="700" fill="#0f2a22">TradePal</text>
  <text x="404" y="132" font-family="Helvetica, Arial, sans-serif" font-size="17" font-weight="700" letter-spacing="4" fill="#b5441f">AFRICA</text>

  <text x="80" y="300" font-family="Georgia, 'Times New Roman', serif" font-size="84" font-weight="700" fill="#0f2a22">Run your shop's books</text>
  <text x="80" y="392" font-family="Georgia, 'Times New Roman', serif" font-size="84" font-style="italic" fill="#24493c">inside WhatsApp.</text>
  <path d="M84 410 C220 398 330 418 470 406 S700 400 770 408" fill="none" stroke="#e9a21b" stroke-width="9" stroke-linecap="round"/>

  <text x="80" y="498" font-family="Helvetica, Arial, sans-serif" font-size="28" fill="#0f2a22" fill-opacity="0.72">No app to download. No training required.</text>

  <rect y="594" width="1200" height="36" fill="#0f2a22"/>
  <g transform="translate(0,603)">${weave}</g>
</svg>
`;

await sharp(Buffer.from(svg)).png().toFile(outPath);
console.log("Wrote", outPath);
