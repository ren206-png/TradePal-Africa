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
import { EntitlementError } from "../domain/subscriptions/entitlements.js";
import { receiveShipment, shipOrder } from "../domain/trade/fulfilment.js";
import { deliverTradeEvents } from "../domain/trade/handlers.js";
import { acceptSalesOrder, submitPurchaseOrder } from "../domain/trade/orders.js";
import { InvalidAmountError, parseAmountToMinorUnits } from "../domain/money.js";
import { CatalogError, normalizeKey, setVariantStatus } from "../domain/catalog.js";
import { addPriceRule, createPriceList } from "../domain/pricing.js";
import { acceptLink, createPartner, inviteLink, revokeLink, setPartnerTerms, shareWholesaleList } from "../domain/trade/partners.js";
import { confirmPayment, recordPayment, rejectPayment } from "../domain/trade/payments.js";
import { invoicePaymentView } from "../domain/trade/fulfilment.js";

/**
 * WhatsApp commands for reorder suggestions and B2B orders (expansion Phase 3). Each is behind its feature flag (default OFF):
 * while off, `handleTradeCommand` returns null and the router answers exactly as before. Permissions come from the matrix.
 * Partial receipts with damaged or short units, quotes and payments are available through the services and the admin
 * console in this phase; the commands below cover the everyday path (suggest, send, accept, ship, receive whole shipments).
 */
export const TRADE_COMMANDS = new Set([
  "/reorder", "/orders", "/sendorder", "/acceptorder", "/shiporder", "/receiveorder",
  "/partners", "/partner", "/join", "/wholesale", "/publish", "/unpublish", "/invoices", "/payinvoice", "/confirmpayment", "/rejectpayment",
]);
export const FLAG_REORDER = "reorderRules";
export const FLAG_TRADE_ORDERS = "tradeOrders";

const NOT_ALLOWED = "Only the owner or a manager can do that.";
const can = (ctx: CommandContext, p: MerchantPermission) => canMerchant(membershipRoleForLegacyMerchantRole(ctx.merchantRole), p);
const on = (ctx: CommandContext, flag: string) => isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, flag);
const money = (ctx: CommandContext, v: bigint) => `${formatMoney(v, ctx.minorUnitExp)} ${ctx.currencyCode}`;

export async function handleTradeCommand(ctx: CommandContext, command: string, args: string): Promise<string | null> {
  if (command === "/reorder") return (await on(ctx, FLAG_REORDER)) ? handleReorder(ctx, args) : null;
  if (["/wholesale", "/publish", "/unpublish"].includes(command)) {
    if (!(await on(ctx, "catalogV2"))) return null;
    try {
      return command === "/wholesale" ? await handleWholesale(ctx, args) : await handlePublish(ctx, args, command === "/publish");
    } catch (error) {
      if (error instanceof CatalogError || error instanceof PriceError || error instanceof InvalidAmountError) return error.message;
      throw error;
    }
  }
  if (!(await on(ctx, FLAG_TRADE_ORDERS))) return null;
  try {
    switch (command) {
      case "/partners": return await handlePartners(ctx);
      case "/partner": return await handlePartner(ctx, args);
      case "/join": return await handleJoin(ctx, args);
      case "/invoices": return await handleInvoices(ctx);
      case "/payinvoice": return await handlePayInvoice(ctx, args);
      case "/confirmpayment": return await handleConfirmPayment(ctx, args);
      case "/rejectpayment": return await handleRejectPayment(ctx, args);
      case "/orders": return await handleOrders(ctx);
      case "/sendorder": return await handleSendOrder(ctx, args);
      case "/acceptorder": return await handleAcceptOrder(ctx, args);
      case "/shiporder": return await handleShipOrder(ctx, args);
      case "/receiveorder": return await handleReceiveOrder(ctx, args);
      default: return null;
    }
  } catch (error) {
    if (error instanceof TradeError || error instanceof StockError || error instanceof PriceError || error instanceof InvalidAmountError || error instanceof EntitlementError) return error.message;
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
      if (error instanceof TradeError || error instanceof EntitlementError) return error.message;
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

// ----------------------------------------------------------------------------- partners and links

async function findPartner(ctx: CommandContext, name: string) {
  return ctx.scopedPrisma.tradePartner.findFirst({ where: { normalizedName: normalizeKey(name) } });
}

async function handlePartners(ctx: CommandContext): Promise<string> {
  const partners = await ctx.scopedPrisma.tradePartner.findMany({ orderBy: { name: "asc" } });
  if (partners.length === 0) return "No trade partners yet. Add one: /partner add supplier <name>";
  return [
    "Your trade partners:",
    ...partners.map((p) => {
      const terms = [p.paymentTermsDays !== null ? `${p.paymentTermsDays}-day terms` : "", p.creditLimitMinor !== null ? `limit ${money(ctx, p.creditLimitMinor)}` : ""].filter(Boolean).join(", ");
      return `${p.name} (${p.role.toLowerCase()}): ${p.linkStatus === "LINKED" ? "on TradePal, linked" : p.linkStatus === "INVITED" ? "invitation sent" : p.linkStatus === "REVOKED" ? "link ended" : "not linked"}${terms ? `; ${terms}` : ""}`;
    }),
  ].join("\n");
}

async function handlePartner(ctx: CommandContext, args: string): Promise<string> {
  if (!can(ctx, "trade:partners")) return NOT_ALLOWED;
  const text = args.trim();
  const add = /^add\s+(supplier|customer|both)\s+(.+)$/i.exec(text);
  if (add) {
    const p = await createPartner(ctx.scopedPrisma, { businessId: ctx.businessId, name: add[2] as string, role: (add[1] as string).toUpperCase() as "SUPPLIER" | "CUSTOMER" | "BOTH" });
    return `Added ${p.name} as a ${p.role.toLowerCase()}. If they use TradePal too, link up: /partner invite ${p.name}`;
  }
  const invite = /^invite\s+(.+)$/i.exec(text);
  if (invite) {
    const p = await findPartner(ctx, invite[1] as string);
    if (!p) return `I don't know a partner called "${invite[1]}". Add them first.`;
    const { token } = await inviteLink(ctx.prisma, { inviterBusinessId: ctx.businessId, partnerId: p.id, createdBy: ctx.merchantId });
    return [`Invitation ready for ${p.name}. TradePal does not message them: send them this yourself.`, "", `Ask them to send, from their own TradePal WhatsApp number:`, `/join ${token}`, "", "It works once and expires in 7 days."].join("\n");
  }
  const terms = /^terms\s+(.+?)((?:\s+(?:days|limit|overdue)\s+\S+)+)$/i.exec(text);
  if (terms) {
    const p = await findPartner(ctx, terms[1] as string);
    if (!p) return `I don't know a partner called "${terms[1]}".`;
    const data: { paymentTermsDays?: number; creditLimitMinor?: bigint; blockWhenOverdueDays?: number } = {};
    for (const m of (terms[2] as string).matchAll(/(days|limit|overdue)\s+(\S+)/gi)) {
      const key = (m[1] as string).toLowerCase();
      if (key === "limit") data.creditLimitMinor = parseAmountToMinorUnits(m[2] as string, ctx.minorUnitExp);
      else {
        const n = Number(m[2]);
        if (!Number.isInteger(n) || n < 0) return `"${m[2]}" is not a number of days.`;
        if (key === "days") data.paymentTermsDays = n;
        else data.blockWhenOverdueDays = n;
      }
    }
    await setPartnerTerms(ctx.scopedPrisma, p.id, data);
    return `Updated ${p.name}: ${[data.paymentTermsDays !== undefined ? `${data.paymentTermsDays}-day payment terms` : "", data.creditLimitMinor !== undefined ? `credit limit ${money(ctx, data.creditLimitMinor)}` : "", data.blockWhenOverdueDays !== undefined ? `block new orders when ${data.blockWhenOverdueDays} days overdue` : ""].filter(Boolean).join(", ")}. These are your own rules; TradePal does not lend or score anyone.`;
  }
  const share = /^share\s+(.+)$/i.exec(text);
  if (share) {
    const p = await findPartner(ctx, share[1] as string);
    if (!p || p.linkStatus !== "LINKED" || !p.linkId) return `${share[1]} is not linked on TradePal yet.`;
    const list = await ctx.scopedPrisma.priceList.findFirst({ where: { kind: "WHOLESALE", name: "Wholesale", status: "ACTIVE" } });
    if (!list) return "You have no wholesale prices yet. Add some: /wholesale <sku> <price> [per <pack>] [from <qty>]";
    await shareWholesaleList(ctx.prisma, { businessId: ctx.businessId, priceListId: list.id, linkId: p.linkId });
    return `${p.name} can now see the items you have published with your wholesale prices. They never see your costs or stock.`;
  }
  const unlink = /^unlink\s+(.+)$/i.exec(text);
  if (unlink) {
    const p = await findPartner(ctx, unlink[1] as string);
    if (!p?.linkId) return `${unlink[1]} is not linked.`;
    await revokeLink(ctx.prisma, { businessId: ctx.businessId, linkId: p.linkId, by: ctx.merchantId });
    return `Link with ${p.name} ended. New orders stop; orders you already agreed carry on.`;
  }
  return "Usage:\n/partner add supplier|customer|both <name>\n/partner invite <name>\n/partner share <name>\n/partner terms <name> days <n> limit <amount> overdue <n>\n/partner unlink <name>";
}

async function handleJoin(ctx: CommandContext, args: string): Promise<string> {
  if (!can(ctx, "trade:partners")) return NOT_ALLOWED;
  const token = args.trim();
  if (!token) return "Usage: /join <invitation code>";
  const link = await acceptLink(ctx.prisma, { inviteeBusinessId: ctx.businessId, token, acceptedBy: ctx.merchantId });
  const partner = await ctx.scopedPrisma.tradePartner.findFirst({ where: { linkId: link.id } });
  return `You are now linked with ${partner?.name ?? "that business"}. They choose what to share with you; you choose what to share with them.`;
}

// ---------------------------------------------------------------------- wholesale prices, publishing

async function handleWholesale(ctx: CommandContext, args: string): Promise<string> {
  if (!can(ctx, "prices:manage")) return NOT_ALLOWED;
  const m = /^(\S+)\s+(\S+)(?:\s+per\s+(\S+))?(?:\s+from\s+(\d+))?$/i.exec(args.trim());
  if (!m) return 'Usage: /wholesale <sku> <price> [per <pack>] [from <quantity>]\nExample: "/wholesale COLA330 2200 per carton from 5"';
  const variant = await findVariantByText(ctx.scopedPrisma, m[1] as string);
  if (!variant) return `I can't find a product "${m[1]}". See /products.`;
  const price = parseAmountToMinorUnits(m[2] as string, ctx.minorUnitExp);
  const list =
    (await ctx.scopedPrisma.priceList.findFirst({ where: { kind: "WHOLESALE", name: "Wholesale", status: "ACTIVE" } })) ??
    (await createPriceList(ctx.scopedPrisma, { businessId: ctx.businessId, name: "Wholesale", kind: "WHOLESALE", currencyCode: ctx.currencyCode }));
  await addPriceRule(ctx.scopedPrisma, { businessId: ctx.businessId, priceListId: list.id, variantId: variant.id, unitPriceMinor: price, ...(m[3] ? { unit: m[3] } : {}), ...(m[4] ? { minQuantity: Number(m[4]) } : {}) });
  return `Wholesale price saved: ${variant.sku} at ${money(ctx, price)} per ${m[3] ?? variant.baseUnit}${m[4] ? ` from ${m[4]}` : ""}.${variant.status === "PUBLISHED" ? "" : ` It is not visible to partners until you publish it: /publish ${variant.sku}`}`;
}

async function handlePublish(ctx: CommandContext, args: string, publish: boolean): Promise<string> {
  if (!can(ctx, "prices:manage")) return NOT_ALLOWED;
  const variant = await findVariantByText(ctx.scopedPrisma, args.trim());
  if (!variant) return `I can't find a product "${args.trim()}". See /products.`;
  await setVariantStatus(ctx.scopedPrisma, variant.id, publish ? "PUBLISHED" : "DRAFT");
  return publish ? `${variant.sku} is now published: partners you share your wholesale list with can see it.` : `${variant.sku} is no longer shown to partners.`;
}

// ------------------------------------------------------------------------------- invoices, payments

async function handleInvoices(ctx: CommandContext): Promise<string> {
  const invoices = await ctx.scopedPrisma.tradeInvoice.findMany({ orderBy: { issuedAt: "desc" }, take: 10 });
  if (invoices.length === 0) return "No trade invoices yet.";
  const proposals = await ctx.scopedPrisma.tradePayment.count({ where: { state: "PROPOSED" } });
  const lines = invoices.map((i) => {
    const v = invoicePaymentView(i);
    return `${i.number}${i.externalNumber ? ` (supplier ${i.externalNumber})` : ""} ${i.side === "SELL" ? "owed to you" : "you owe"}: total ${money(ctx, i.totalMinor)}, outstanding ${money(ctx, v.outstandingMinor)}, ${v.paymentStatus.toLowerCase().replace("_", " ")}${v.overdue ? ` (${v.overdueDays} days overdue)` : ""}`;
  });
  return [ "Your trade invoices:", ...lines, ...(proposals > 0 ? ["", `${proposals} payment(s) reported by the other business are waiting for you: /confirmpayment`] : []) ].join("\n");
}

async function handlePayInvoice(ctx: CommandContext, args: string): Promise<string> {
  if (!can(ctx, "trade:payments")) return NOT_ALLOWED;
  const m = /^(\S+)\s+(\S+)(?:\s+(cash|momo|bank))?$/i.exec(args.trim());
  if (!m) return 'Usage: /payinvoice <invoice number> <amount> [cash|momo|bank]\nExample: "/payinvoice BILL-000001 2000 cash"';
  const invoice = await ctx.scopedPrisma.tradeInvoice.findFirst({ where: { number: (m[1] as string).toUpperCase() } });
  if (!invoice) return "I can't find that invoice. Send /invoices to see yours.";
  const method = ((m[3] ?? "").toLowerCase() === "momo" ? "MOBILE_MONEY" : (m[3] ?? "").toLowerCase() === "bank" ? "BANK" : (m[3] ?? "").toLowerCase() === "cash" ? "CASH" : "OTHER") as "CASH" | "MOBILE_MONEY" | "BANK" | "OTHER";
  const amount = parseAmountToMinorUnits(m[2] as string, ctx.minorUnitExp);
  await recordPayment(ctx.prisma, { businessId: ctx.businessId, invoiceId: invoice.id, amountMinor: amount, method, actor: ctx.merchantId });
  await deliverTradeEvents(ctx.prisma);
  return invoice.side === "SELL"
    ? `Recorded ${money(ctx, amount)} received on ${invoice.number}. The other business is asked to confirm it.`
    : `Recorded your payment of ${money(ctx, amount)} on ${invoice.number}. The supplier is asked to confirm they received it; until they do it is only your record.`;
}

async function handleConfirmPayment(ctx: CommandContext, args: string): Promise<string> {
  if (!can(ctx, "trade:payments")) return NOT_ALLOWED;
  const open = await ctx.scopedPrisma.tradePayment.findMany({ where: { state: "PROPOSED" }, orderBy: { createdAt: "asc" } });
  const n = Number(args.trim());
  if (!args.trim()) {
    if (open.length === 0) return "No payments are waiting for your confirmation.";
    const invs = await ctx.scopedPrisma.tradeInvoice.findMany({ where: { id: { in: open.map((p) => p.invoiceId) } } });
    return ["Payments reported by the other business (they count only once you confirm):", ...open.map((p, i) => `${i + 1}. ${money(ctx, p.amountMinor)} on ${invs.find((x) => x.id === p.invoiceId)?.number} via ${p.method.toLowerCase().replace("_", " ")}${p.reference ? `, ref ${p.reference}` : ""}`), "", "Reply /confirmpayment <number>, or /rejectpayment <number> <reason>."].join("\n");
  }
  const p = Number.isInteger(n) ? open[n - 1] : undefined;
  if (!p) return `There is no waiting payment number ${args.trim()}.`;
  await confirmPayment(ctx.prisma, { businessId: ctx.businessId, paymentId: p.id, actor: ctx.merchantId });
  await deliverTradeEvents(ctx.prisma);
  return `Confirmed ${money(ctx, p.amountMinor)}. The invoice is updated.`;
}

async function handleRejectPayment(ctx: CommandContext, args: string): Promise<string> {
  if (!can(ctx, "trade:payments")) return NOT_ALLOWED;
  const m = /^(\d+)\s+(.+)$/.exec(args.trim());
  if (!m) return "Usage: /rejectpayment <number> <reason>";
  const open = await ctx.scopedPrisma.tradePayment.findMany({ where: { state: "PROPOSED" }, orderBy: { createdAt: "asc" } });
  const p = open[Number(m[1]) - 1];
  if (!p) return `There is no waiting payment number ${m[1]}.`;
  await rejectPayment(ctx.prisma, { businessId: ctx.businessId, paymentId: p.id, reason: m[2] as string, actor: ctx.merchantId });
  await deliverTradeEvents(ctx.prisma);
  return "Rejected. The other business is told it was not confirmed.";
}
