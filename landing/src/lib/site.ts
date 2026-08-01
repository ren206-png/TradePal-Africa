/**
 * Single source of truth for site-wide marketing copy/config, so the same
 * name/description/CTA link isn't hand-typed differently across every
 * component and layout.
 *
 * NOTE: `whatsappNumber` is a placeholder. Swap it for the real WhatsApp
 * Business number (digits only, with country code, no "+" — e.g.
 * "2348012345678") before this site goes live; every CTA button on the page
 * links through `whatsappCtaHref`, so updating it here updates the whole site.
 */
export const SITE = {
  name: "TradePal Africa",
  url: "https://tradepalafrica.com",
  description:
    "TradePal Africa turns the WhatsApp you already use into a bookkeeping, stock, and payment-collection tool for your shop — no app to download, no training required.",
  whatsappNumber: "14123341362", // temporary placeholder — swap for the real business number later
  supportedCountries: ["Nigeria", "Kenya", "Ghana", "Sierra Leone", "Liberia", "Gambia"],
} as const;

export const whatsappCtaHref = (prefilledMessage = "Hi TradePal, I'd like to set up my shop."): string =>
  `https://wa.me/${SITE.whatsappNumber}?text=${encodeURIComponent(prefilledMessage)}`;
