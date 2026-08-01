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
  // TradePal Africa's real Cloud API number (+1 825-823-9920), registered
  // under the TradePal Africa WhatsApp Business Account and matching
  // production's WHATSAPP_PHONE_NUMBER_ID env var. The Meta app that owns it
  // switched from Development to Live mode on 2026-07-24, so it's no longer
  // subject to the recipient-allowlist restriction test-mode numbers have —
  // any visitor can message it and get a reply. (Previously this pointed at
  // Meta's free Cloud API test number, +1 555-154-3856, which was under a
  // separate, still-Development-mode app — CTA clicks would have silently
  // gone nowhere. 14123341362 is a third, unrelated number still registered
  // to the regular WhatsApp Business mobile app rather than Cloud API, so
  // messages to it never reach this backend at all.)
  whatsappNumber: "18258239920",
  supportedCountries: ["Nigeria", "Kenya", "Ghana", "Sierra Leone", "Liberia", "Gambia"],
} as const;

export const whatsappCtaHref = (prefilledMessage = "Hi TradePal, I'd like to set up my shop."): string =>
  `https://wa.me/${SITE.whatsappNumber}?text=${encodeURIComponent(prefilledMessage)}`;
