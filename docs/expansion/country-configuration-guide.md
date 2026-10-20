# Country configuration guide and local-review dependencies

## How a country is configured

Single source: the `Country`, `Currency`, `Language` and `CountryConfig` tables (read through `config/countryRegistry.ts`, which falls back to the static list in `config/countries.ts` if the database cannot be read). A country carries: ISO code, name, calling code, currency (ISO code, name, minor-unit exponent), default IANA timezone, default language, and `voiceEnabled`. Launch countries today: **Nigeria, Kenya, Sierra Leone, Ghana, Liberia, Gambia**. A person messaging from any other country gets one fixed "not available" reply.

## To add a country (every step is a reviewed change; nothing here is automatic)

1. Add the ISO currency and country rows with a migration (idempotent insert, like `20260821000000_liberia_gambia_reference_data`) and the matching entry in `config/countries.ts`.
2. Decide `voiceEnabled` (default false until a speech vendor's support for the local language is confirmed).
3. Decide the **local-review items** below with someone who knows the country; record the answer in `decisions.md`.
4. Add the country's mobile-money providers to the matrix (`merchant-provider-matrix.md`) as UNKNOWN until verified; add pawaPay billing only if pawaPay lists the country (`src/pawapay/countries.ts` maps Sierra Leone, Liberia and Gambia; only Sierra Leone has been audited and tested, against an in-memory fake), with a `BillingSwitch` row OFF.
5. Prepare WhatsApp template wording in the local language only through a reviewer (see `localization.md`); until then English.
6. Add a test row (reference-data test) so the migration and the static list cannot drift.

## What is NOT configured per country (and must not be assumed)

Tax rates, VAT/withholding rules, thresholds, exemptions, council or market-trader rules, receipt/invoice legal formats, consumer-protection and refund law, data-protection registration, and lending/debt-collection law. **None is hardcoded; unconfigured tax is not zero tax;** reports are bookkeeping reports and say so.

## Local-review dependencies (a person with local knowledge must confirm before relying on the feature in that country)

| Area | What needs local review | Today |
|---|---|---|
| Currency | Denominations in circulation and any redenomination (Sierra Leone's new Leone vs old Leone); the minor-unit exponent; how people write amounts | SLE exponent 2; **no conversion** between old and new; a message naming old Leones is refused and the person is asked to re-enter |
| Language | Whether English is the right default; Krio, Pidgin, Sheng, Wolof, Twi, Hausa, Yoruba, Igbo, Swahili, French | English only; other locales registered MISSING, no text invented |
| Voice | Speech-to-text quality for local speech | on for NG/KE/GH, off for SL/LR/GM (unverified) |
| Mobile money | Which providers customers and merchants actually use; limits; fees; refund support; settlement model | merchant provider UNKNOWN everywhere; pawaPay billing audited for SL (Orange) only |
| Messaging | WhatsApp template approval by Meta; local opt-in norms | no template submitted |
| Consumer protection | Refund/return rights, delivery promises, cooling-off | seller-set return window; `refund-cancellation-rules.md` |
| Data protection | Registration, consent wording, retention, cross-border transfer | consent wording versioned; privacy page drafted; no registration done |
| Tax and invoices | VAT/withholding, e-invoicing, receipts | none; export infrastructure only |
| Lending and collections | Rules on reminders and credit | no automated collection or lending messages exist |
| Marketplace | Prohibited items by country, seller identity rules | a fixed report-reason list; moderation by hand |
| Time and calendar | Public holidays, trading hours (shop "closes" are manual) | timezone per business; none of the six observe DST |
| Phone numbers | Trunk-prefix and numbering rules | shopper number normalised with the seller's calling code; a test-number workaround exists for Meta's free number |

Owners of each review: not assigned. This is an owner action (see `handoff.md`).
