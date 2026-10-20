import type { CommandContext } from "./commandRouter.js";
import { canMerchant, membershipRoleForLegacyMerchantRole, type MerchantPermission } from "../auth/permissions.js";
import { findVariantByText } from "../domain/catalog.js";
import { isFeatureEnabled } from "../domain/featureFlags.js";
import { formatMoney } from "../domain/money.js";
import { PriceError } from "../domain/pricing.js";
import { acceptSuggestion, dismissSuggestion, generateReorderSuggestions, listOpenSuggestions, setReorderRule } from "../domain/reorder.js";
import { forecastForLive } from "../domain/forecast.js";
import { StockError } from "../domain/stock.js";
import { TradeError } from "../domain/trade/common.js";
import { receiveShipment, shipOrder } from "../domain/trade/fulfilment.js";
import { deliverTradeEvents } from "../domain/trade/handlers.js";
import { acceptSalesOrder, submitPurchaseOrder } from "../domain/trade/orders.js";

/**
 * WhatsApp commands for reorder suggestions and B2B orders (expansion Phase 3). Each is behind its feature flag (default OFF):
 * while off, `handleTradeCommand` returns null and the router answers exactly as before. Permissions come from the matrix.
 * Partial receipts with damaged or short units, quotes and payments are available through the services and the admin
 * console in this phase; the commands below cover the everyday path (suggest, send, accept, ship, receive whole shipments).
 */
export const TRADE_COMMANDS = new Set(["/reorder", "/orders", "/sendorder", "/acceptorder", "/shiporder", "/receiveorder"]);
export const FLAG_REORDER = "reorderRules";
export const FLAG_TRADE_ORDERS = "tradeOrders";

const NOT_ALLOWED = "Only the owner or a manager can do that.";
const can = (ctx: CommandContext, p: MerchantPermission) => canMerchant(membershipRoleForLegacyMerchantRole(ctx.merchantRole), p);
const on = (ctx: CommandContext, flag: string) => isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, flag);
const money = (ctx: CommandContext, v: bigint) => `${formatMoney(v, ctx.minorUnitExp)} ${ctx.currencyCode}`;

export async function handleTradeCommand(ctx: CommandContext, command: string, args: string): Promise<string | null> {
  if (command === "/reorder") return (await on(ctx, FLAG_REORDER)) ? handleReorder(ctx, args) : null;
  if (!(await on(ctx, FLAG_TRADE_ORDERS))) return null;
  try {
    switch (command) {
      case "/orders": return await handleOrders(ctx);
      case "/sendorder": return await handleSendOrder(ctx, args);
      case "/acceptorder": return await handleAcceptOrder(ctx, args);
      case "/shiporder": return await handleShipOrder(ctx, args);
      case "/receiveorder": return await handleReceiveOrder(ctx, args);
      default: return null;
    }
  } catch (error) {
    if (error instanceof TradeError || error instanceof StockError || error instanceof PriceError) return error.message;
    throw error;
  }
}

async function findOrder(ctx: CommandContext, ref: string) {
  const reference = ref.trim().toUpperCase();
  if (!reference) return null;
  return ctx.scopedPrisma.tradeOrder.findFirst({ where: { reference }, include: { lines: { orderBy: { lineNo: "asc" } } } });
}

// ------------------------------------------------------------------------------------------ /reorder

async function handleReorder(ctx: CommandContext, args: string): Promise<string> {
  const text = args.trim();
  const rule = /^rule\s+(\S+)\s+(fixed|cover)\s+(\d+)\s+(\d+)$/i.exec(text);
  if (rule) {
    if (!can(ctx, "inventory:adjust")) return NOT_ALLOWED;
    const variant = await findVariantByText(ctx.scopedPrisma, rule[1] as string);
    if (!variant) return `I can't find a product "${rule[1]}". See /products.`;
    const shop = await ctx.scopedPrisma.shop.findFirst({ where: { isDefault: true } });
    if (!shop) return "Set up your shop first.";
    const a = Number(rule[3]);
    const b = Number(rule[4]);
    try {
      await setReorderRule(ctx.scopedPrisma, {
        businessId: ctx.businessId, shopId: shop.id, variantId: variant.id,
        ...(rule[2]!.toLowerCase() === "fixed" ? { mode: "FIXED" as const, reorderPoint: a, reorderQuantity: b } : { mode: "DAYS_OF_COVER" as const, targetCoverDays: a, windowDays: b }),
      });
    } catch (error) {
      if (error instanceof TradeError) return error.message;
      throw error;
    }
    return rule[2]!.toLowerCase() === "fixed"
      ? `OK: I'll suggest ${b} ${variant.baseUnit} of ${variant.sku} when what you have drops to ${a} or less.`
      : `OK: I'll suggest an order for ${variant.sku} to keep ${a} days of stock, judged on your sales over the last ${b} days.`;
  }

  const accept = /^accept\s+(\d+)(?:\s+(.+?))?(?:\s+sku\s+(\S+))?$/i.exec(text);
  const dismiss = /^dismiss\s+(\d+)$/i.exec(text);
  if (accept || dismiss) {
    if (!can(ctx, "trade:buy")) return NOT_ALLOWED;
    const open = await listOpenSuggestions(ctx.scopedPrisma);
    const n = Number((accept ?? dismiss)![1]);
    const s = open[n - 1];
    if (!s) return `There is no suggestion number ${n}. Send /reorder to see the list.`;
    if (dismiss) {
      await dismissSuggestion(ctx.scopedPrisma, { suggestionId: s.id, actor: ctx.merchantId });
      return `Dismissed the suggestion for ${s.sku}.`;
    }
    let partnerId: string | undefined;
    if (accept![2]) {
      const partner = await ctx.scopedPrisma.tradePartner.findFirst({ where: { normalizedName: accept![2]!.trim().toLowerCase().replace(/\s+/g, " ") } });
      if (!partner) return `I don't know a supplier called "${accept![2]}". Add one first.`;
      partnerId = partner.id;
    }
    try {
      const order = await acceptSuggestion(ctx.prisma, { businessId: ctx.businessId, suggestionId: s.id, actor: ctx.merchantId, ...(partnerId ? { partnerId } : {}), ...(accept![3] ? { supplierSku: accept![3] } : {}) });
      return [`Draft order ${order.reference} created for ${order.lines.map((l) => `${l.quantity} ${l.unit} of ${l.sku}`).join(", ")}.`, "It has NOT been sent or paid. Check it, then send it with /sendorder " + order.reference + "."].join("\n");
    } catch (error) {
      if (error instanceof TradeError) return error.message;
      throw error;
    }
  }

  await generateReorderSuggestions(ctx.prisma, { businessId: ctx.businessId }, forecastForLive);
  const open = await listOpenSuggestions(ctx.scopedPrisma);
  if (open.length === 0) return 'Nothing to reorder right now. Set a rule per product: /reorder rule <sku> fixed <reorder at> <order qty>  or  /reorder rule <sku> cover <days> <sales window days>';
  const lines = open.map((s, i) => `${i + 1}. ${s.sku}: order ${s.suggestedBaseQty} ${s.unit}\n   ${s.arithmetic}`);
  return ["Suggested reorders (nothing is ordered until you say so):", ...lines, "", "Reply /reorder accept <number> [supplier] [sku <supplier's code>] to make a draft order, or /reorder dismiss <number>."].join("\n");
}

// -------------------------------------------------------------------------------------------- orders

async function handleOrders(ctx: CommandContext): Promise<string> {
  const orders = await ctx.scopedPrisma.tradeOrder.findMany({ orderBy: { createdAt: "desc" }, take: 10 });
  if (orders.length === 0) return "No orders yet.";
  const partners = await ctx.scopedPrisma.tradePartner.findMany({ where: { id: { in: orders.map((o) => o.partnerId) } } });
  const lines = orders.map((o) => {
    const who = partners.find((p) => p.id === o.partnerId)?.name ?? "?";
    const dir = o.side === "BUY" ? `buying from ${who}` : `selling to ${who}`;
    const needs = o.side === "SELL" && o.acceptance === "REQUESTED" ? "  <- needs your decision" : o.side === "BUY" && o.acceptance === "DRAFT" ? "  <- draft, not sent" : "";
    return `${o.reference} ${dir}: ${money(ctx, o.totalMinor)}, ${o.acceptance.toLowerCase()}${o.acceptance === "ACCEPTED" ? `, goods ${o.movement.toLowerCase().replace(/_/g, " ")}` : ""}${needs}`;
  });
  return ["Your recent orders:", ...lines].join("\n");
}

async function handleSendOrder(ctx: CommandContext, args: string): Promise<string> {
  if (!can(ctx, "trade:buy")) return NOT_ALLOWED;
  const order = await findOrder(ctx, args);
  if (!order || order.side !== "BUY") return "I can't find that purchase order. Send /orders to see yours.";
  if (order.lines.some((l) => l.unitPriceMinor <= 0n) && !(await ctx.scopedPrisma.tradePartner.findFirst({ where: { id: order.partnerId, linkStatus: "LINKED" } }))) {
    return "This order has no prices yet and its supplier is not on TradePal, so there is nothing to send. Confirm the supplier's price first.";
  }
  const sent = await submitPurchaseOrder(ctx.prisma, { businessId: ctx.businessId, orderId: order.id });
  await deliverTradeEvents(ctx.prisma);
  return `Sent ${sent.reference} to your supplier: ${money(ctx, sent.totalMinor)}. You'll see their answer under /orders.`;
}

async function handleAcceptOrder(ctx: CommandContext, args: string): Promise<string> {
  if (!can(ctx, "trade:sell")) return NOT_ALLOWED;
  const m = /^(\S+)(?:\s+override\s+(.+))?$/i.exec(args.trim());
  if (!m) return "Usage: /acceptorder <order number>";
  const order = await findOrder(ctx, m[1] as string);
  if (!order || order.side !== "SELL") return "I can't find that sales order. Send /orders to see yours.";
  if (m[2] && !can(ctx, "trade:credit_override")) return "Only the owner can go ahead against a credit block.";
  try {
    const accepted = await acceptSalesOrder(ctx.prisma, {
      businessId: ctx.businessId, orderId: order.id, actor: ctx.merchantId, ...(m[2] ? { creditOverride: { by: ctx.merchantId, reason: m[2].trim() } } : {}),
    });
    await deliverTradeEvents(ctx.prisma);
    return `Accepted ${accepted.reference}: ${money(ctx, accepted.totalMinor)}. The stock is now held for this customer.`;
  } catch (error) {
    if (error instanceof TradeError && error.code === "CREDIT_BLOCKED") return `${error.message}\nTo go ahead anyway (owner only): /acceptorder ${order.reference} override <reason>`;
    throw error;
  }
}

async function handleShipOrder(ctx: CommandContext, args: string): Promise<string> {
  if (!can(ctx, "trade:sell")) return NOT_ALLOWED;
  const order = await findOrder(ctx, args);
  if (!order || order.side !== "SELL") return "I can't find that sales order. Send /orders to see yours.";
  const lines = order.lines.filter((l) => l.baseQuantity - l.shippedBase > 0).map((l) => ({ orderLineId: l.id, baseQuantity: l.baseQuantity - l.shippedBase }));
  if (lines.length === 0) return `${order.reference} has already shipped in full.`;
  const { invoice } = await shipOrder(ctx.prisma, { businessId: ctx.businessId, orderId: order.id, lines, actor: ctx.merchantId });
  await deliverTradeEvents(ctx.prisma);
  return `Shipped ${order.reference} (everything not yet sent). Invoice ${invoice.number}: ${money(ctx, invoice.totalMinor)}${invoice.dueDate ? `, due ${invoice.dueDate.toISOString().slice(0, 10)}` : ""}.`;
}

async function handleReceiveOrder(ctx: CommandContext, args: string): Promise<string> {
  if (!can(ctx, "trade:buy")) return NOT_ALLOWED;
  const order = await findOrder(ctx, args);
  if (!order || order.side !== "BUY") return "I can't find that purchase order. Send /orders to see yours.";
  const shipments = await ctx.scopedPrisma.shipment.findMany({ where: { orderId: order.id, side: "BUY", status: { not: "RECEIVED" } }, include: { lines: true } });
  if (shipments.length === 0) return `Nothing is waiting to be received on ${order.reference}.`;
  let units = 0;
  for (const s of shipments) {
    const lines = s.lines.map((l) => ({ shipmentLineId: l.id, acceptedBase: l.baseQuantity - l.acceptedBase - l.damagedBase - l.shortBase })).filter((l) => l.acceptedBase > 0);
    if (lines.length === 0) continue;
    await receiveShipment(ctx.prisma, { businessId: ctx.businessId, shipmentId: s.id, lines, actor: ctx.merchantId });
    units += lines.reduce((n, l) => n + l.acceptedBase, 0);
  }
  await deliverTradeEvents(ctx.prisma);
  return `Received ${units} unit(s) from ${order.reference} into your stock. If something was damaged or missing, tell your supplier; recording it line by line is available in the admin tools for now.`;
}
