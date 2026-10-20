# Requirement traceability (Phases 1-2)

Status vocabulary: implemented / locally tested / sandbox verified / partner approved / production configured / production activated. Nothing here is above "locally tested". Rows for later phases are added as they are built.

| Requirement (master prompt) | Code | Tests | Status |
|---|---|---|---|
| 5/G5 pawaPay only for subscriptions | `domain/paymentPurpose.ts`, guarded initiators, `/collect` `/paylink` locked | `purposeBoundary.test.ts` | locally tested |
| 7/G7 separate subscription vs merchant money | purpose enum on `Invoice`/`PaymentRequest` | same | locally tested |
| 6 tenancy, memberships, permissions | `auth/permissions.ts`, `domain/memberships.ts`, Shop/Membership | `permissions.test.ts`, `memberships.test.ts` | locally tested |
| 7 invariant 1 integer minor units | BigInt everywhere; `rounding.ts` | `catalogPricing.test.ts` (rounding), accounting tests | locally tested |
| 7 invariant 4 rounding/allocation, totals agree | `domain/rounding.ts`, `pricing.ts` | `catalogPricing.test.ts` | locally tested (document-level totals arrive with orders in Phase 3/4) |
| 7 invariant 5 balanced journals | `domain/accounting.ts` + deferred DB trigger | `accounting.test.ts` | locally tested |
| 7 invariant 6 corrections by reversal | `reverseJournalEntry`, `reverseStockMovement`, `reverseTransaction` | `accounting.test.ts`, `stockV2.test.ts`, `adminTransactions.test.ts` | locally tested |
| 7 invariant 7 provenance | `Provenance` on journals and stock movements | `accounting.test.ts`, `catalogPricing.test.ts` | locally tested |
| 7 invariant 8 opening balances labelled, nothing fabricated | `postOpeningBalance`, `adoptLegacyInventory`, legacy "not recorded" accounts | `accounting.test.ts`, `catalogPricing.test.ts` | locally tested |
| 7 invariant 9 DB-enforced under concurrency | triggers/CHECKs/row locks | `dbProtection.test.ts`, `stockV2.test.ts` | locally tested (PGlite; real interleaving unverified) |
| 8 catalog, units, packs, aliases | `domain/catalog.ts` | `catalogPricing.test.ts` | locally tested |
| 8 retail/wholesale lists, breaks, validity | `domain/pricing.ts` | `catalogPricing.test.ts` | locally tested |
| 8 one stock system, buckets, reservations with expiry | `domain/stock.ts` | `stockV2.test.ts` | locally tested |
| 8 counts with approved adjustments, transfers with dispatch/receipt | same | same | locally tested |
| 8 costing, incomplete-cost labelling | same | same | locally tested |
| 8 PO does not increase stock; confirmed receipt does | `receiveStock` is the only stock-in | n/a until POs exist (Phase 3) | implemented |
| 11 balanced postings, daily close | `accounting.ts`, `dailyClose.ts` | `accounting.test.ts`, `dailyClose.test.ts` | locally tested |
| 11 statement import, SMS-as-proposal | existing `MobileMoneyAlert` flow unchanged | existing tests | partial (pre-existing; import UI not in Phase 2) |
| 18 admin: transactions panel view/void/export | `admin/adminTransactions.ts`, frontend `TransactionsPage` | `adminTransactions.test.ts`, `TransactionsPage.test.tsx` | locally tested |
| 18 admin: step-up, support access, audit with correlation id | `admin/platformGuards.ts`, `adminAudit.ts` | `platformAdmin.test.ts`, `adminTransactions.test.ts` | locally tested (flags off by default) |
| 18 delete rules, 29 hard delete rejected in DB | triggers | `dbProtection.test.ts`, `stockV2.test.ts`, `accounting.test.ts` | locally tested |
| 20 scenario 2 last units, no oversell | `reserveStock` | `stockV2.test.ts` | locally tested |
| 20 scenario 3 pack conversion + wholesale minimum exact | catalog + pricing | `catalogPricing.test.ts` | locally tested |
| 20 scenario 4 credit/partial, no duplicated revenue | `postSale`, `postDebtCollection` | `accounting.test.ts` | locally tested |
| 20 scenario 5 cash/wallet/fee/refund/withdrawal/purchase + daily close | posting rules, `dailyClose.ts` | `accounting.test.ts`, `dailyClose.test.ts` | locally tested |
| 20 scenario 25 flags off = unchanged | flag-gated hooks; commands return null | `operationsCommands.test.ts` + the full pre-existing suite | locally tested |
| 20 scenario 28/30 admin audit, void keeps original | `adminAudit.ts`, void route | `adminTransactions.test.ts` | locally tested |
