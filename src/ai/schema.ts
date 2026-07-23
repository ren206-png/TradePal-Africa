import { z } from "zod";

const BaseFields = {
  confidence: z.number().min(0).max(1),
};

const TransactionItemSchema = z.object({
  itemName: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPriceMinor: z.number().int().nonnegative(),
});

export const ParsedSaleSchema = z.object({
  intent: z.literal("SALE"),
  ...BaseFields,
  amountMinor: z.number().int().nonnegative(),
  paymentStatus: z.enum(["PAID", "CREDIT", "PARTIAL"]),
  customerName: z.string().min(1).optional(),
  items: z.array(TransactionItemSchema).optional(),
});

export const ParsedPurchaseSchema = z.object({
  intent: z.literal("PURCHASE"),
  ...BaseFields,
  amountMinor: z.number().int().nonnegative(),
  supplierName: z.string().min(1).optional(),
  items: z.array(TransactionItemSchema).optional(),
});

export const ParsedPaymentReceivedSchema = z.object({
  intent: z.literal("PAYMENT_RECEIVED"),
  ...BaseFields,
  amountMinor: z.number().int().nonnegative(),
  customerName: z.string().min(1),
});

export const ParsedExpenseSchema = z.object({
  intent: z.literal("EXPENSE"),
  ...BaseFields,
  amountMinor: z.number().int().nonnegative(),
  description: z.string().min(1).optional(),
});

export const ParsedDebtNoteSchema = z.object({
  intent: z.literal("DEBT_NOTE"),
  ...BaseFields,
  amountMinor: z.number().int().nonnegative(),
  customerName: z.string().min(1),
});

export const ParsedStockAdjustmentSchema = z.object({
  intent: z.literal("STOCK_ADJUSTMENT"),
  ...BaseFields,
  itemName: z.string().min(1),
  quantityDelta: z.number().int(),
});

export const ParsedQuerySchema = z.object({
  intent: z.literal("QUERY"),
  ...BaseFields,
});

export const ParsedGreetingSchema = z.object({
  intent: z.literal("GREETING"),
  ...BaseFields,
});

export const ParsedUnknownSchema = z.object({
  intent: z.literal("UNKNOWN"),
  ...BaseFields,
});

export const ParsedIntentSchema = z.discriminatedUnion("intent", [
  ParsedSaleSchema,
  ParsedPurchaseSchema,
  ParsedPaymentReceivedSchema,
  ParsedExpenseSchema,
  ParsedDebtNoteSchema,
  ParsedStockAdjustmentSchema,
  ParsedQuerySchema,
  ParsedGreetingSchema,
  ParsedUnknownSchema,
]);

export type ParsedIntent = z.infer<typeof ParsedIntentSchema>;

/** Intents that, on success, produce a ledger transaction rather than just a reply. */
export const TRANSACTION_INTENTS = new Set([
  "SALE",
  "PURCHASE",
  "PAYMENT_RECEIVED",
  "EXPENSE",
  "DEBT_NOTE",
  "STOCK_ADJUSTMENT",
]);
