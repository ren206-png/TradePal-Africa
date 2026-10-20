import type { PrismaClient } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { reverseTransaction, TransactionAlreadyReversedError } from "../domain/ledger.js";
import { asyncHandler } from "./asyncHandler.js";
import { correlationIdOf } from "./adminAudit.js";
import type { AuthenticatedAdminRequest } from "./authMiddleware.js";
import { csvNumber, csvRow, csvText } from "./csv.js";
import { paginate, parsePaginationParams } from "./pagination.js";
import { recordPlatformAudit, requirePlatformPermission, requireStepUp, requireSupportAccess } from "./platformGuards.js";

/**
 * Admin transactions and orders panel (expansion Phase 2, §18): view sales/purchases/payments, stock movements and
 * journals per organization with provenance and status; void a transaction by REVERSING it (never delete); export.
 * Reads are behind `admin:view_merchant_financials` and, when `adminSupportAccessRequired` is on, a recorded reason.
 * Nothing here has a delete: a "void" is a new reversal row, a balanced reversal journal and reversed stock.
 */
const EXPORT_ROW_CAP = 10_000;
const TX_TYPES = ["SALE", "PURCHASE", "PAYMENT_RECEIVED", "EXPENSE", "DEBT_NOTE", "STOCK_ADJUSTMENT"] as const;
const reverseBodySchema = z.object({ reason: z.string().trim().min(10, "Give a reason of at least 10 characters.").max(300) });

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function createAdminTransactionsRouter(prisma: PrismaClient, jwtSecret: string): Router {
  const router = Router();
  const gate = requireSupportAccess(prisma, "Transaction");

  async function businessOr404(id: string) {
    return prisma.business.findUnique({ where: { id }, select: { id: true, name: true, currencyCode: true } });
  }

  router.get(
    "/businesses/:id/transactions",
    requirePlatformPermission("admin:view_merchant_financials"),
    gate,
    asyncHandler(async (req, res) => {
      const businessId = req.params["id"] as string;
      if (!(await businessOr404(businessId))) {
        res.status(404).json({ error: "Business not found." });
        return;
      }
      const pagination = parsePaginationParams(req.query as Record<string, unknown>);
      const type = typeof req.query["type"] === "string" && (TX_TYPES as readonly string[]).includes(req.query["type"]) ? (req.query["type"] as (typeof TX_TYPES)[number]) : undefined;
      const from = parseDate(req.query["from"]);
      const to = parseDate(req.query["to"]);
      const rows = await prisma.transaction.findMany({
        where: { businessId, ...(type ? { type } : {}), ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}) },
        orderBy: { createdAt: "desc" },
        take: pagination.take + 1,
        skip: pagination.skip,
        include: { _count: { select: { items: true } }, reversedBy: { select: { id: true } }, customer: { select: { name: true } }, supplier: { select: { name: true } } },
      });
      const { items, pagination: meta } = paginate(rows, pagination);
      const entries = await prisma.journalEntry.findMany({
        where: { businessId, idempotencyKey: { in: items.map((t) => `txn:${t.id}`) } },
        select: { id: true, idempotencyKey: true },
      });
      const journalOf = new Map(entries.map((e) => [e.idempotencyKey, e.id]));
      res.json({
        transactions: items.map((t) => ({
          id: t.id,
          type: t.type,
          amountMinor: t.amountMinor.toString(),
          currencyCode: t.currencyCode,
          paymentStatus: t.paymentStatus,
          description: t.description,
          counterparty: t.customer?.name ?? t.supplier?.name ?? null,
          createdAt: t.createdAt,
          itemCount: t._count.items,
          // POSTED = live, REVERSED = voided by a later reversal row, REVERSAL = is itself the reversal.
          status: t.reversalOfTransactionId ? "REVERSAL" : t.reversedBy ? "REVERSED" : "POSTED",
          reversalOfTransactionId: t.reversalOfTransactionId,
          reversedByTransactionId: t.reversedBy?.id ?? null,
          provenance: { label: "MERCHANT_ENTERED", channel: t.whatsappMessageId ? "WHATSAPP" : "OTHER", reference: t.whatsappMessageId },
          journalEntryId: journalOf.get(`txn:${t.id}`) ?? null,
        })),
        pagination: meta,
      });
    }),
  );

  router.get(
    "/businesses/:id/transactions/:txnId",
    requirePlatformPermission("admin:view_merchant_financials"),
    gate,
    asyncHandler(async (req, res) => {
      const businessId = req.params["id"] as string;
      const t = await prisma.transaction.findFirst({
        where: { id: req.params["txnId"] as string, businessId },
        include: { items: true, reversedBy: { select: { id: true } }, inventoryMovements: true, customer: { select: { name: true } }, supplier: { select: { name: true } } },
      });
      if (!t) {
        res.status(404).json({ error: "Transaction not found." });
        return;
      }
      const entry = await prisma.journalEntry.findFirst({ where: { businessId, idempotencyKey: `txn:${t.id}` }, include: { lines: { include: { account: { select: { code: true, name: true } } } } } });
      res.json({
        transaction: {
          id: t.id, type: t.type, amountMinor: t.amountMinor.toString(), currencyCode: t.currencyCode, paymentStatus: t.paymentStatus,
          description: t.description, rawMerchantText: t.rawMerchantText, whatsappMessageId: t.whatsappMessageId, createdAt: t.createdAt,
          counterparty: t.customer?.name ?? t.supplier?.name ?? null,
          status: t.reversalOfTransactionId ? "REVERSAL" : t.reversedBy ? "REVERSED" : "POSTED",
          reversalOfTransactionId: t.reversalOfTransactionId, reversedByTransactionId: t.reversedBy?.id ?? null,
          items: t.items.map((i) => ({ itemName: i.itemName, quantity: i.quantity, unitPriceMinor: i.unitPriceMinor.toString(), lineTotalMinor: i.lineTotalMinor.toString() })),
          stockMovements: t.inventoryMovements.map((m) => ({ id: m.id, quantityDelta: m.quantityDelta, source: m.source, createdAt: m.createdAt })),
        },
        journal: entry
          ? { id: entry.id, kind: entry.kind, provenance: entry.provenance, lines: entry.lines.map((l) => ({ account: `${l.account.code} ${l.account.name}`, debitMinor: l.debitMinor.toString(), creditMinor: l.creditMinor.toString() })) }
          : null,
      });
    }),
  );

  router.get(
    "/businesses/:id/stock-movements",
    requirePlatformPermission("admin:view_merchant_financials"),
    gate,
    asyncHandler(async (req, res) => {
      const businessId = req.params["id"] as string;
      if (!(await businessOr404(businessId))) {
        res.status(404).json({ error: "Business not found." });
        return;
      }
      const pagination = parsePaginationParams(req.query as Record<string, unknown>);
      if (req.query["log"] === "legacy") {
        const rows = await prisma.inventoryMovement.findMany({
          where: { businessId }, orderBy: { createdAt: "desc" }, take: pagination.take + 1, skip: pagination.skip, include: { inventoryItem: { select: { name: true } } },
        });
        const { items, pagination: meta } = paginate(rows, pagination);
        res.json({
          log: "legacy",
          movements: items.map((m) => ({ id: m.id, item: m.inventoryItem.name, quantityDelta: m.quantityDelta, source: m.source, transactionId: m.transactionId, createdAt: m.createdAt })),
          pagination: meta,
        });
        return;
      }
      const rows = await prisma.stockMovement.findMany({
        where: { businessId }, orderBy: { createdAt: "desc" }, take: pagination.take + 1, skip: pagination.skip,
        include: { variant: { select: { sku: true, product: { select: { name: true } } } }, shop: { select: { name: true } } },
      });
      const { items, pagination: meta } = paginate(rows, pagination);
      res.json({
        log: "v2",
        movements: items.map((m) => ({
          id: m.id, kind: m.kind, sku: m.variant.sku, product: m.variant.product.name, shop: m.shop.name,
          onHandDelta: m.onHandDelta, damagedDelta: m.damagedDelta, inTransitDelta: m.inTransitDelta,
          // cost is merchant-private but this is the owner/operator support view, behind support access
          costMinor: m.costMinor?.toString() ?? null, costIncomplete: m.costIncomplete,
          provenance: m.provenance, source: m.sourceType ? `${m.sourceType}:${m.sourceId ?? ""}` : null,
          reversalOfMovementId: m.reversalOfMovementId, occurredAt: m.occurredAt, createdAt: m.createdAt,
        })),
        pagination: meta,
      });
    }),
  );

  router.get(
    "/businesses/:id/journals",
    requirePlatformPermission("admin:view_merchant_financials"),
    gate,
    asyncHandler(async (req, res) => {
      const businessId = req.params["id"] as string;
      if (!(await businessOr404(businessId))) {
        res.status(404).json({ error: "Business not found." });
        return;
      }
      const pagination = parsePaginationParams(req.query as Record<string, unknown>);
      const rows = await prisma.journalEntry.findMany({
        where: { businessId }, orderBy: { occurredAt: "desc" }, take: pagination.take + 1, skip: pagination.skip,
        include: { lines: { include: { account: { select: { code: true, name: true } } } }, reversedBy: { select: { id: true } } },
      });
      const { items, pagination: meta } = paginate(rows, pagination);
      res.json({
        journals: items.map((e) => ({
          id: e.id, kind: e.kind, currencyCode: e.currencyCode, memo: e.memo, provenance: e.provenance, evidenceRef: e.evidenceRef,
          source: e.sourceType ? `${e.sourceType}:${e.sourceId ?? ""}` : null, occurredAt: e.occurredAt, postedAt: e.postedAt,
          status: e.reversalOfEntryId ? "REVERSAL" : e.reversedBy ? "REVERSED" : "POSTED",
          lines: e.lines.map((l) => ({ account: `${l.account.code} ${l.account.name}`, debitMinor: l.debitMinor.toString(), creditMinor: l.creditMinor.toString() })),
        })),
        pagination: meta,
      });
    }),
  );

  // Expansion Phase 3: B2B documents of one business, as that business holds them (its own rows only).
  router.get(
    "/businesses/:id/trade-orders",
    requirePlatformPermission("admin:view_merchant_financials"),
    gate,
    asyncHandler(async (req, res) => {
      const businessId = req.params["id"] as string;
      if (!(await businessOr404(businessId))) {
        res.status(404).json({ error: "Business not found." });
        return;
      }
      const pagination = parsePaginationParams(req.query as Record<string, unknown>);
      const rows = await prisma.tradeOrder.findMany({
        where: { businessId }, orderBy: { createdAt: "desc" }, take: pagination.take + 1, skip: pagination.skip,
        include: { lines: { orderBy: { lineNo: "asc" } }, shipments: { select: { number: true, status: true } } },
      });
      const partners = await prisma.tradePartner.findMany({ where: { businessId, id: { in: rows.map((r) => r.partnerId) } }, select: { id: true, name: true, linkStatus: true } });
      const { items, pagination: meta } = paginate(rows, pagination);
      res.json({
        orders: items.map((o) => {
          const p = partners.find((x) => x.id === o.partnerId);
          return {
            id: o.id, reference: o.reference, side: o.side, partner: p?.name ?? null, linked: p?.linkStatus === "LINKED", acceptance: o.acceptance, movement: o.movement,
            totalMinor: o.totalMinor.toString(), currencyCode: o.currencyCode, validUntil: o.validUntil, acceptedAt: o.acceptedAt, createdAt: o.createdAt, counterpartOrderId: o.counterpartOrderId,
            lines: o.lines.map((l) => ({ lineNo: l.lineNo, sku: l.sku, unit: l.unit, quantity: l.quantity, baseQuantity: l.baseQuantity, shippedBase: l.shippedBase, receivedBase: l.receivedBase, unitPriceMinor: l.unitPriceMinor.toString(), lineTotalMinor: l.lineTotalMinor.toString() })),
            shipments: o.shipments,
          };
        }),
        pagination: meta,
      });
    }),
  );

  router.get(
    "/businesses/:id/trade-invoices",
    requirePlatformPermission("admin:view_merchant_financials"),
    gate,
    asyncHandler(async (req, res) => {
      const businessId = req.params["id"] as string;
      if (!(await businessOr404(businessId))) {
        res.status(404).json({ error: "Business not found." });
        return;
      }
      const pagination = parsePaginationParams(req.query as Record<string, unknown>);
      const rows = await prisma.tradeInvoice.findMany({
        where: { businessId }, orderBy: { issuedAt: "desc" }, take: pagination.take + 1, skip: pagination.skip,
        include: { payments: { orderBy: { createdAt: "asc" } }, credits: true, order: { select: { reference: true } } },
      });
      const { items, pagination: meta } = paginate(rows, pagination);
      const now = new Date();
      res.json({
        invoices: items.map((i) => {
          const outstanding = i.totalMinor - i.creditedMinor - i.paidMinor;
          return {
            id: i.id, number: i.number, externalNumber: i.externalNumber, side: i.side, order: i.order.reference, totalMinor: i.totalMinor.toString(), creditedMinor: i.creditedMinor.toString(),
            paidMinor: i.paidMinor.toString(), outstandingMinor: outstanding.toString(), currencyCode: i.currencyCode, dueDate: i.dueDate, issuedAt: i.issuedAt,
            paymentStatus: outstanding === 0n ? "PAID" : i.paidMinor > 0n ? "PARTIALLY_PAID" : "UNPAID", overdue: outstanding > 0n && i.dueDate !== null && i.dueDate < now,
            payments: i.payments.map((p) => ({ id: p.id, direction: p.direction, amountMinor: p.amountMinor.toString(), method: p.method, evidence: p.evidence, state: p.state, reference: p.reference, provider: p.provider, reason: p.reason, createdAt: p.createdAt })),
            creditNotes: i.credits.map((c) => ({ number: c.number, amountMinor: c.amountMinor.toString(), reason: c.reason })),
          };
        }),
        pagination: meta,
      });
    }),
  );

  // Void = reverse. Creates a reversal transaction, reverses the stock it moved and (flag on) a balanced reversal journal.
  router.post(
    "/businesses/:id/transactions/:txnId/reverse",
    requirePlatformPermission("admin:reverse_transaction"),
    requireStepUp(prisma, jwtSecret, "admin:reverse_transaction"),
    gate,
    asyncHandler(async (req, res) => {
      const admin = (req as AuthenticatedAdminRequest).adminUser!;
      const parsed = reverseBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body.", details: parsed.error.issues });
        return;
      }
      const businessId = req.params["id"] as string;
      const txnId = req.params["txnId"] as string;
      const original = await prisma.transaction.findFirst({ where: { id: txnId, businessId } });
      if (!original) {
        res.status(404).json({ error: "Transaction not found." });
        return;
      }
      try {
        const reversal = await reverseTransaction(getTenantScopedClient(prisma, businessId), txnId, `Voided by TradePal support: ${parsed.data.reason}`);
        await recordPlatformAudit(prisma, {
          adminUserId: admin.adminUserId,
          businessId,
          action: "admin.transaction.reversed",
          entityType: "Transaction",
          entityId: txnId,
          correlationId: correlationIdOf(res),
          metadata: { reason: parsed.data.reason, reversalTransactionId: reversal.id, amountMinor: original.amountMinor.toString(), type: original.type },
        });
        res.status(201).json({ reversal: { id: reversal.id, reversalOfTransactionId: txnId, amountMinor: reversal.amountMinor.toString() } });
      } catch (error) {
        if (error instanceof TransactionAlreadyReversedError) {
          res.status(409).json({ error: error.message, code: "ALREADY_REVERSED" });
          return;
        }
        throw error;
      }
    }),
  );

  // Formula-safe CSV export. Audited (who exported what, how many rows).
  router.get(
    "/businesses/:id/transactions.csv",
    requirePlatformPermission("admin:view_merchant_financials"),
    gate,
    asyncHandler(async (req, res) => {
      const admin = (req as AuthenticatedAdminRequest).adminUser!;
      const businessId = req.params["id"] as string;
      if (!(await businessOr404(businessId))) {
        res.status(404).json({ error: "Business not found." });
        return;
      }
      const from = parseDate(req.query["from"]);
      const to = parseDate(req.query["to"]);
      const rows = await prisma.transaction.findMany({
        where: { businessId, ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } } : {}) },
        orderBy: { createdAt: "asc" },
        take: EXPORT_ROW_CAP + 1,
        include: { reversedBy: { select: { id: true } }, customer: { select: { name: true } }, supplier: { select: { name: true } } },
      });
      const truncated = rows.length > EXPORT_ROW_CAP;
      const out = rows.slice(0, EXPORT_ROW_CAP);
      const lines = [
        csvRow(["id", "created_at", "type", "status", "amount_minor", "currency", "payment_status", "counterparty", "description", "reversal_of", "provenance", "reference"].map(csvText)),
        ...out.map((t) =>
          csvRow([
            csvText(t.id), csvText(t.createdAt.toISOString()), csvText(t.type), csvText(t.reversalOfTransactionId ? "REVERSAL" : t.reversedBy ? "REVERSED" : "POSTED"),
            csvNumber(t.amountMinor), csvText(t.currencyCode), csvText(t.paymentStatus), csvText(t.customer?.name ?? t.supplier?.name ?? ""), csvText(t.description ?? ""),
            csvText(t.reversalOfTransactionId ?? ""), csvText("MERCHANT_ENTERED"), csvText(t.whatsappMessageId ?? ""),
          ]),
        ),
      ];
      await recordPlatformAudit(prisma, {
        adminUserId: admin.adminUserId, businessId, action: "admin.transactions.exported", entityType: "Business", entityId: businessId,
        correlationId: correlationIdOf(res), metadata: { rows: out.length, truncated, ...(from ? { from: from.toISOString() } : {}), ...(to ? { to: to.toISOString() } : {}) },
      });
      res
        .status(200)
        .set("Content-Type", "text/csv; charset=utf-8")
        .set("Content-Disposition", `attachment; filename="transactions-${businessId.slice(0, 8)}.csv"`)
        .set("X-Export-Truncated", truncated ? "true" : "false")
        .send(lines.join("\r\n") + "\r\n");
    }),
  );

  return router;
}
