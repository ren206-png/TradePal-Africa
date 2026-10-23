import type { TradePaymentMethod } from "@prisma/client";
import type { CommandContext } from "./commandRouter.js";
import { canMerchant, membershipRoleForLegacyMerchantRole, type MerchantPermission } from "../auth/permissions.js";
import { findVariantByText } from "../domain/catalog.js";
import { isFeatureEnabled } from "../domain/featureFlags.js";
import { formatMoney, InvalidAmountError, parseAmountToMinorUnits } from "../domain/money.js";
import { FLAG_STOREFRONT, StoreError } from "../domain/store/common.js";
import { EntitlementError } from "../domain/subscriptions/entitlements.js";
import {
  cancelStoreOrderBySeller, completeStoreOrder, confirmStoreOrder, decideCancellationRequest, dispatchStoreOrder, markDeliveryFailed, markStoreOrderReady,
} from "../domain/store/orders.js";
import { recordStorePayment, resolvePaymentException } from "../domain/store/payments.js";
import { decideRefund, issueStoreRefund, receiveReturn } from "../domain/store/refunds.js";
import { addDeliveryZone, ensureStorefront, listVariant, setZoneActive, unlistVariant, updateStorefront } from "../domain/store/storefront.js";
import { MARKETPLACE_CATEGORIES, disableMarketplace, enableMarketplace, marketplaceReadiness, publishMarketplaceListing, unpublishMarketplaceListing } from "../domain/marketplace.js";
import { fileAppeal, moderationStatusFor } from "../domain/moderation.js";
import { PaymentsError } from "../domain/merchantPayments/common.js";
import { payOutStoreRefund, refundHeldPayment } from "../domain/merchantPayments/storeRefunds.js";
import { CapabilityError } from "../payments/adapter.js";
import { MANUAL_COURIER_ID, MANUAL_COURIER_NAME } from "../couriers/adapter.js";
import { getCourierRegistry } from "../couriers/registry.js";
import { applyShipmentUpdate, cancelShipment, courierEnabledFor, createShipment, shipmentForOrder } from "../domain/store/shipments.js";
import { getAdapterRegistry } from "../payments/registry.js";

/**
 * The seller's WhatsApp commands for the consumer shop (expansion Phase 4): `/store ...`. One namespace, behind the `storefront`
 * flag (default OFF): while off, `handleStoreCommand` returns null and the router answers exactly as before ("Unrecognized
 * command"). (`/collect` already belongs to the quarantined pawaPay path, so nothing here reuses it.) Permissions come from the
 * matrix: `store:manage` (set-up), `store:fulfil` (move an order along), `store:refund` (cancellations, refunds, held payments).
 * Nothing here ever messages a shopper: the shopper sees status on their order page.
 */
export const STORE_COMMANDS = new Set(["/store"]);

const NOT_ALLOWED = "Only the owner or a manager can do that.";
const can = (ctx: CommandContext, p: MerchantPermission) => canMerchant(membershipRoleForLegacyMerchantRole(ctx.merchantRole), p);
const money = (ctx: CommandContext, v: bigint) => `${formatMoney(v, ctx.minorUnitExp)} ${ctx.currencyCode}`;
const idem = (ctx: CommandContext) => ctx.merchantId;

const USAGE = [
  "Your shop:",
  "/store - status and your shop link",
  "/store name <text> | slug <web address> | phone <number> | open | close",
  "/store pickup <where> | pickup off | delivery on|off | zone add <name> <fee> [min <amount>] | zone on|off <name> | returns <days|off>",
  "/store list <sku> | unlist <sku>",
  "Orders:",
  "/store orders | order <number> | confirm|ready <number> | dispatch <number> [delivery ref] | done <number> <code> [cash|momo|bank]",
  "/store done <number> nocode <reason> | cancel <number> <reason> | failed <number> <reason> | paid <number> <amount> [cash|momo|bank]",
  "Requests: /store requests | approve|deny <id> | refund approve <id> [amount] | refund deny <id> | refund received <id> | refund pay <id> [cash|momo|bank]",
  "/store payment <id> refund|reserve|apply | payments | cases | case <id> note <text>",
  "Marketplace: /store marketplace on|off|status | publish <sku> <category> | unpublish <sku> | categories | moderation | appeal <what happened>",
].join("\n");

const COURIER_USAGE = [
  "Couriers (delivery orders):",
  "/store couriers | track <number>",
  "/store dispatch <number> via <courier> [name <shown name>] [ref <tracking ref>] [url <https link>] [rider <name> <phone>]",
  "/store courier <number> picked | transit | delivered | returned | failed <reason> | cancel <reason>",
].join("\n");

/** Reads `via manual name Gokada ref AB12 url https://... rider Tunde 0803...` into its parts. Returns null when the text has no keyword at all (a plain delivery reference). */
export function parseDispatchWords(words: string[]): { via?: string; name?: string; ref?: string; url?: string; riderName?: string; riderPhone?: string } | null {
  const KEYS = new Set(["via", "name", "ref", "url", "rider"]);
  if (!words.some((w, i) => i === 0 && KEYS.has(w.toLowerCase()))) return null;
  const out: Record<string, string> = {};
  let key: string | null = null;
  for (const w of words) {
    if (KEYS.has(w.toLowerCase())) { key = w.toLowerCase(); out[key] = ""; continue; }
    if (key) out[key] = (out[key] ? out[key] + " " : "") + w;
  }
  const result: { via?: string; name?: string; ref?: string; url?: string; riderName?: string; riderPhone?: string } = {};
  if (out["via"]) result.via = out["via"].split(/\s+/)[0]!;
  if (out["name"]) result.name = out["name"];
  if (out["ref"]) result.ref = out["ref"];
  if (out["url"]) result.url = out["url"].split(/\s+/)[0]!;
  if (out["rider"]) {
    // the phone number is the trailing run of number-like words ("0803 111 2222"); everything before it is the rider's name
    const parts = out["rider"].split(/\s+/);
    let i = parts.length;
    while (i > 0 && /^\+?[0-9-]+$/.test(parts[i - 1]!)) i--;
    const digits = parts.slice(i).join("").replace(/\D/g, "");
    if (i < parts.length && digits.length >= 8 && digits.length <= 15) {
      result.riderPhone = parts.slice(i).join(" ");
      const name = parts.slice(0, i).join(" ");
      if (name) result.riderName = name;
    } else result.riderName = out["rider"];
  }
  return result;
}

function methodOf(word: string | undefined): TradePaymentMethod {
  const w = (word ?? "").toLowerCase();
  return w === "momo" ? "MOBILE_MONEY" : w === "bank" ? "BANK" : "CASH";
}

export async function handleStoreCommand(ctx: CommandContext, command: string, args: string): Promise<string | null> {
  if (command !== "/store") return null;
  if (!(await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, FLAG_STOREFRONT))) return null;
  try {
    return await dispatch(ctx, args.trim());
  } catch (error) {
    if (error instanceof StoreError || error instanceof InvalidAmountError || error instanceof PaymentsError || error instanceof EntitlementError) return error.message;
    if (error instanceof CapabilityError) return "Your payment provider cannot send this refund from here. Refund the buyer another way, then ask TradePal support to record it.";
    throw error;
  }
}

async function findOrder(ctx: CommandContext, ref: string | undefined) {
  const reference = (ref ?? "").trim().toUpperCase();
  if (!reference) return null;
  return ctx.scopedPrisma.storeOrder.findFirst({ where: { reference }, include: { lines: true } });
}

/** Short ids ("#a1b2c3") for requests; found by prefix inside this business only. */
const shortId = (id: string) => id.slice(0, 6);
const cleanId = (s: string | undefined) => (s ?? "").replace(/^#/, "").toLowerCase();

async function dispatch(ctx: CommandContext, args: string): Promise<string> {
  const [sub = "", ...rest] = args.split(/\s+/).filter(Boolean);
  const tail = rest.join(" ");
  switch (sub.toLowerCase()) {
    case "": return status(ctx);
    case "help": return (await courierEnabledFor(ctx.scopedPrisma, ctx.businessId)) ? `${USAGE}\n${COURIER_USAGE}` : USAGE;
    case "couriers": case "track": case "courier":
      if (!(await courierEnabledFor(ctx.scopedPrisma, ctx.businessId))) return `I don't know "/store ${sub}".\n\n${USAGE}`;
      if (!can(ctx, "store:fulfil")) return NOT_ALLOWED;
      return courierCommand(ctx, sub.toLowerCase(), rest);
    case "orders": return listOrders(ctx);
    case "order": return showOrder(ctx, rest[0]);
    case "requests": return listRequests(ctx);
    case "cases": return listCases(ctx);
    case "payments": return listPayments(ctx);
    case "categories": return `Marketplace categories: ${MARKETPLACE_CATEGORIES.join(", ")}.`;
    case "moderation": return moderationView(ctx);
    case "name": case "slug": case "phone": case "open": case "close": case "pickup": case "delivery": case "zone": case "returns": case "list": case "unlist":
      if (!can(ctx, "store:manage")) return NOT_ALLOWED;
      return setup(ctx, sub.toLowerCase(), tail);
    case "confirm": case "ready": case "dispatch": case "done": case "cancel": case "failed": case "paid":
      if (!can(ctx, "store:fulfil")) return NOT_ALLOWED;
      return fulfil(ctx, sub.toLowerCase(), rest);
    case "approve": case "deny": case "refund": case "payment":
      if (!can(ctx, "store:refund")) return NOT_ALLOWED;
      return decide(ctx, sub.toLowerCase(), rest);
    case "marketplace": case "publish": case "unpublish":
      if (!can(ctx, "store:manage")) return NOT_ALLOWED;
      return marketplace(ctx, sub.toLowerCase(), tail);
    case "appeal":
      if (!can(ctx, "store:manage")) return NOT_ALLOWED;
      await fileAppeal(ctx.prisma, { businessId: ctx.businessId, text: tail });
      return "Your appeal was sent. A person at TradePal will review it and the decision is recorded. Send /store moderation to see where it stands.";
    case "case": return caseNote(ctx, rest);
    default: return `I don't know "/store ${sub}".\n\n${USAGE}`;
  }
}

// ------------------------------------------------------------------------------------------ status

async function status(ctx: CommandContext): Promise<string> {
  const sf = await ctx.scopedPrisma.storefront.findFirst({ where: {} });
  if (!sf) return ["You have no online shop yet.", "Set one up: /store name <your shop name>, /store phone <number>, /store pickup <where>, /store list <sku>, then /store open.", "", USAGE].join("\n");
  const listed = await ctx.scopedPrisma.listing.count({ where: { status: "ACTIVE" } });
  const active = await ctx.scopedPrisma.storeOrder.count({ where: { status: { in: ["PLACED", "CONFIRMED", "READY", "OUT_FOR_DELIVERY"] } } });
  const needs = await ctx.scopedPrisma.storeOrder.count({ where: { status: "PLACED" } });
  const requests = (await ctx.scopedPrisma.storeCancellationRequest.count({ where: { status: "REQUESTED" } })) + (await ctx.scopedPrisma.storeRefundRequest.count({ where: { status: { in: ["REQUESTED", "APPROVED", "GOODS_RECEIVED"] } } })) + (await ctx.scopedPrisma.paymentException.count({ where: { status: "OPEN" } }));
  const base = process.env["STOREFRONT_PUBLIC_URL"]?.replace(/\/+$/, "");
  return [
    `${sf.title}: your shop is ${sf.enabled ? "OPEN" : "CLOSED"}.`,
    `Link: ${base ? `${base}/shop/${sf.slug}` : `/shop/${sf.slug} (set STOREFRONT_PUBLIC_URL to show the full address)`}`,
    `${listed} product(s) listed. ${active} active order(s), ${needs} waiting for you to confirm, ${requests} request(s) to look at (/store requests).`,
    "Send /store help for everything you can do.",
  ].join("\n");
}

// ------------------------------------------------------------------------------------------- set-up

async function setup(ctx: CommandContext, sub: string, tail: string): Promise<string> {
  const biz = ctx.businessId;
  await ensureStorefront(ctx.prisma, biz);
  switch (sub) {
    case "name": {
      if (!tail) return "Say the name: /store name <your shop name>";
      await updateStorefront(ctx.prisma, biz, { title: tail });
      return `Shop name set to "${tail}".`;
    }
    case "slug": {
      if (!tail) return "Say the web address, e.g. /store slug ade-foods";
      const sf = await updateStorefront(ctx.prisma, biz, { slug: tail.toLowerCase() });
      return `Your shop address is now /shop/${sf.slug}. Anyone with an old link will no longer find you.`;
    }
    case "phone": {
      if (!tail) return "Give the number shoppers can call: /store phone 08031234567";
      await updateStorefront(ctx.prisma, biz, { supportPhone: tail });
      return `Shoppers will see ${tail} as your contact number.`;
    }
    case "open": {
      await updateStorefront(ctx.prisma, biz, { enabled: true });
      return "Your shop is OPEN. Shoppers can now find it with your link.";
    }
    case "close": {
      await updateStorefront(ctx.prisma, biz, { enabled: false });
      return "Your shop is CLOSED. Orders already placed carry on; nobody can place new ones.";
    }
    case "pickup": {
      if (tail.toLowerCase() === "off") {
        await updateStorefront(ctx.prisma, biz, { pickupEnabled: false });
        return "Pickup is off.";
      }
      if (!tail) return "Say where shoppers collect: /store pickup <place> (or /store pickup off)";
      await updateStorefront(ctx.prisma, biz, { pickupEnabled: true, pickupLocation: tail });
      return `Pickup is on. Shoppers collect at: ${tail}`;
    }
    case "delivery": {
      const turnOn = tail.toLowerCase() === "on";
      if (!turnOn && tail.toLowerCase() !== "off") return "Say /store delivery on or /store delivery off. Add areas with /store zone add <name> <fee>.";
      await updateStorefront(ctx.prisma, biz, { deliveryEnabled: turnOn });
      return turnOn ? "Delivery is on. Make sure you have at least one area: /store zone add <name> <fee>." : "Delivery is off.";
    }
    case "zone": {
      const m = /^(add|on|off)\s+(.+)$/i.exec(tail);
      if (!m) return "Use /store zone add <name> <fee> [min <amount>], or /store zone on|off <name>.";
      const action = m[1]!.toLowerCase();
      if (action !== "add") {
        await setZoneActive(ctx.prisma, biz, m[2]!.trim(), action === "on");
        return `Delivery area "${m[2]!.trim()}" is ${action}.`;
      }
      const z = /^(.+?)\s+(\d[\d,]*(?:\.\d+)?)(?:\s+min\s+(\d[\d,]*(?:\.\d+)?))?$/i.exec(m[2]!.trim());
      if (!z) return "Use /store zone add <name> <fee> [min <amount>], e.g. /store zone add Ikeja 500 min 5000";
      const fee = parseAmountToMinorUnits(z[2]!, ctx.minorUnitExp);
      const min = z[3] ? parseAmountToMinorUnits(z[3], ctx.minorUnitExp) : undefined;
      await addDeliveryZone(ctx.prisma, biz, { name: z[1]!.trim(), feeMinor: fee, ...(min !== undefined ? { minOrderMinor: min } : {}) });
      return `Delivery area "${z[1]!.trim()}" added: fee ${money(ctx, fee)}${min !== undefined ? `, minimum order ${money(ctx, min)}` : ""}.`;
    }
    case "returns": {
      if (tail.toLowerCase() === "off") {
        await updateStorefront(ctx.prisma, biz, { returnWindowDays: null });
        return "You accept no returns or refund requests after hand-over.";
      }
      const days = Number(tail);
      if (!Number.isInteger(days) || days < 1 || days > 90) return "Say how many days a shopper has after hand-over (1 to 90): /store returns 7, or /store returns off.";
      await updateStorefront(ctx.prisma, biz, { returnWindowDays: days });
      return `Shoppers can ask for a return or refund for ${days} day(s) after hand-over.`;
    }
    case "list":
    case "unlist": {
      const v = await findVariantByText(ctx.scopedPrisma, tail);
      if (!v) return `I can't find a product "${tail}". See /products.`;
      if (sub === "list") {
        await listVariant(ctx.prisma, biz, v.id);
        return `${v.sku} is listed in your shop at your retail price. Change the price with /setprice or your price list.`;
      }
      await unlistVariant(ctx.prisma, biz, v.id);
      return `${v.sku} is no longer shown in your shop.`;
    }
    default: return USAGE;
  }
}

// -------------------------------------------------------------------------------------------- orders

const ACTIVE = ["PLACED", "CONFIRMED", "READY", "OUT_FOR_DELIVERY"] as const;
const label = (s: string) => s.toLowerCase().replace(/_/g, " ");

async function listOrders(ctx: CommandContext): Promise<string> {
  const orders = await ctx.scopedPrisma.storeOrder.findMany({ where: { status: { in: [...ACTIVE] } }, orderBy: { createdAt: "asc" }, take: 15 });
  if (orders.length === 0) return "No active shop orders.";
  const next = (o: { status: string; fulfilment: string }) => (o.status === "PLACED" ? "confirm it" : o.status === "CONFIRMED" ? "get it ready" : o.status === "READY" ? (o.fulfilment === "PICKUP" ? "hand over with the code" : "dispatch it") : "hand over with the code");
  const jobs = new Map<string, { status: string; courierName: string }>();
  if (await courierEnabledFor(ctx.scopedPrisma, ctx.businessId)) {
    for (const j of await ctx.scopedPrisma.deliveryShipment.findMany({ where: { orderId: { in: orders.map((o) => o.id) } }, orderBy: { createdAt: "asc" } })) jobs.set(j.orderId, j);
  }
  const courierNote = (o: { id: string }) => { const j = jobs.get(o.id); return j ? `, courier ${j.courierName}: ${j.status.toLowerCase().replace(/_/g, " ")}${j.status === "FAILED" ? " (act: /store failed or rebook)" : ""}` : ""; };
  return ["Shop orders:", ...orders.map((o) => `${o.reference} ${o.buyerName}: ${money(ctx, o.totalMinor)}, ${label(o.fulfilment)}, ${label(o.status)}${o.paidMinor >= o.totalMinor ? ", paid" : o.paymentMethod === "ONLINE_SIMULATED" ? ", UNPAID online" : ", pay on handover"}${courierNote(o)} <- ${next(o)}`)].join("\n");
}

async function showOrder(ctx: CommandContext, ref: string | undefined): Promise<string> {
  const o = await findOrder(ctx, ref);
  if (!o) return `I can't find shop order "${ref ?? ""}". Send /store orders.`;
  const lines = o.lines.map((l) => `- ${l.quantity} x ${l.unit} ${l.description}: ${money(ctx, l.lineTotalMinor)}`);
  const addr = [o.landmark, o.addressLine, o.deliveryZoneName].filter(Boolean).join(", ");
  return [
    `${o.reference}: ${label(o.status)}, ${label(o.fulfilment)}. Buyer: ${o.buyerName}, ${o.buyerPhone}.`,
    ...lines,
    `Items ${money(ctx, o.subtotalMinor)}${o.deliveryFeeMinor > 0n ? ` + delivery ${money(ctx, o.deliveryFeeMinor)}` : ""} = ${money(ctx, o.totalMinor)}. Paid ${money(ctx, o.paidMinor)}${o.refundedMinor > 0n ? `, refunded ${money(ctx, o.refundedMinor)}` : ""}.`,
    ...(addr ? [`Deliver to: ${addr}`] : []),
    ...(o.buyerNote ? [`Note: ${o.buyerNote}`] : []),
  ].join("\n");
}

async function fulfil(ctx: CommandContext, sub: string, rest: string[]): Promise<string> {
  const ref = rest[0];
  const o = await findOrder(ctx, ref);
  if (!o) return `I can't find shop order "${ref ?? ""}". Send /store orders.`;
  const common = { businessId: ctx.businessId, orderId: o.id, actor: idem(ctx) };
  const text = rest.slice(1).join(" ").trim();
  switch (sub) {
    case "confirm":
      await confirmStoreOrder(ctx.prisma, common);
      return `Confirmed ${o.reference}. The goods are held for the buyer, who now sees their handover code. Prepare it, then /store ready ${o.reference}.`;
    case "ready":
      await markStoreOrderReady(ctx.prisma, common);
      return o.fulfilment === "PICKUP" ? `${o.reference} is ready for collection. When the buyer comes: /store done ${o.reference} <their 6-digit code>.` : `${o.reference} is ready. When it leaves: /store dispatch ${o.reference} [delivery ref].`;
    case "dispatch": {
      const words = rest.slice(1);
      const parsed = parseDispatchWords(words);
      if (parsed || /^via\b/i.test(text)) {
        if (!(await courierEnabledFor(ctx.scopedPrisma, ctx.businessId))) return "Courier tracking is not switched on for your shop. Dispatch it with just a delivery reference: /store dispatch " + o.reference + " <delivery ref>.";
        if (!parsed?.via) return `Say which courier: /store dispatch ${o.reference} via manual ... (see /store couriers).`;
        const r = await createShipment(ctx.prisma, getCourierRegistry(), {
          businessId: ctx.businessId, orderId: o.id, courier: parsed.via, actor: idem(ctx),
          ...(parsed.name ? { courierName: parsed.name } : {}), ...(parsed.ref ? { trackingRef: parsed.ref } : {}), ...(parsed.url ? { trackingUrl: parsed.url } : {}),
          ...(parsed.riderName ? { riderName: parsed.riderName } : {}), ...(parsed.riderPhone ? { riderPhone: parsed.riderPhone } : {}),
        });
        const s = r.shipment;
        return [
          r.dispatched ? `${o.reference} is out for delivery with ${s.courierName}; the stock has left your shelves.` : `${s.courierName} is now tracking ${o.reference}.`,
          ...(s.trackingRef ? [`Tracking: ${s.trackingRef}`] : []), ...(s.riderName ? [`Rider: ${s.riderName}${s.riderPhone ? ` ${s.riderPhone}` : ""}`] : []),
          `The buyer sees the courier and its status on their order page. A courier saying "delivered" does not finish the order: on hand-over, /store done ${o.reference} <their code>.`,
        ].join("\n");
      }
      await dispatchStoreOrder(ctx.prisma, { ...common, ...(text ? { deliveryRef: text.slice(0, 60) } : {}) });
      return `${o.reference} is out for delivery; the stock has left your shelves. On hand-over: /store done ${o.reference} <their code>.`;
    }
    case "done": {
      const second = rest[1];
      const noCode = second?.toLowerCase() === "nocode";
      const methodWord = noCode ? undefined : rest[2];
      const reason = noCode ? rest.slice(2).join(" ").trim() : "";
      if (!second) return `Give the buyer's 6-digit code: /store done ${o.reference} <code> [cash|momo|bank]`;
      if (noCode && o.fulfilment === "PICKUP") return "A pickup can only be completed with the buyer's code.";
      if (noCode && reason.length < 5) return `Say why there is no code: /store done ${o.reference} nocode <reason>`;
      const unpaid = o.totalMinor - o.paidMinor;
      const done = await completeStoreOrder(ctx.prisma, {
        ...common, ...(noCode ? { withoutCodeReason: reason } : { code: second }),
        ...(o.paymentMethod === "PAY_ON_COLLECTION" && unpaid > 0n ? { collect: { method: methodOf(methodWord) } } : {}),
      });
      return `Done: ${done.reference} handed over${unpaid > 0n && o.paymentMethod === "PAY_ON_COLLECTION" ? `; ${money(ctx, unpaid)} collected` : ""}. The sale is now in your books.`;
    }
    case "cancel":
      if (text.length < 3) return `Say why: /store cancel ${o.reference} <reason>`;
      await cancelStoreOrderBySeller(ctx.prisma, { ...common, reason: text });
      return `Cancelled ${o.reference}. The held stock is released${o.paidMinor > 0n ? `; ${money(ctx, o.paidMinor)} was paid, so refund it: /store requests` : ""}.`;
    case "failed":
      if (text.length < 3) return `Say what happened: /store failed ${o.reference} <reason>`;
      await markDeliveryFailed(ctx.prisma, { ...common, reason: text });
      return `Marked the delivery of ${o.reference} as failed; the goods are back in stock and the order is cancelled.`;
    case "paid": {
      const amount = rest[1];
      if (!amount) return `How much did the buyer pay? /store paid ${o.reference} <amount> [cash|momo|bank]`;
      const p = await recordStorePayment(ctx.prisma, { businessId: ctx.businessId, orderId: o.id, amountMinor: parseAmountToMinorUnits(amount, ctx.minorUnitExp), method: methodOf(rest[2]), actor: idem(ctx) });
      return `Recorded ${money(ctx, p.amountMinor)} against ${o.reference}.`;
    }
    default: return USAGE;
  }
}

// ---------------------------------------------------------------------------------------- couriers

const STATUS_WORDS: Record<string, "PICKED_UP" | "IN_TRANSIT" | "DELIVERED" | "RETURNED" | "FAILED" | "CANCELLED"> = {
  picked: "PICKED_UP", pickedup: "PICKED_UP", transit: "IN_TRANSIT", onway: "IN_TRANSIT", delivered: "DELIVERED", returned: "RETURNED", failed: "FAILED", cancel: "CANCELLED",
};

async function courierCommand(ctx: CommandContext, sub: string, rest: string[]): Promise<string> {
  const registry = getCourierRegistry();
  if (sub === "couriers") {
    return [
      "Couriers you can use:",
      `manual - ${MANUAL_COURIER_NAME}: you record who is delivering and update its status with /store courier. Use "name <text>" to show a name like Gokada.`,
      ...registry.list().map((a) => `${a.id} - ${a.displayName}${a.capabilities.callbacks ? " (reports its own status)" : ""}`),
    ].join("\n");
  }
  const ref = rest[0];
  const o = await findOrder(ctx, ref);
  if (!o) return `I can't find shop order "${ref ?? ""}". Send /store orders.`;
  const view = await shipmentForOrder(ctx.scopedPrisma, o.id);
  if (sub === "track") {
    if (!view) return `${o.reference} has no courier recorded. Use /store dispatch ${o.reference} via manual ...`;
    return [
      `${o.reference}: ${view.courierName}, ${view.statusLabel}.`,
      ...(view.trackingRef ? [`Tracking: ${view.trackingRef}`] : []), ...(view.trackingUrl ? [`Link: ${view.trackingUrl}`] : []), ...(view.riderName ? [`Rider: ${view.riderName}${view.riderPhone ? ` ${view.riderPhone}` : ""}`] : []),
      ...(view.failureReason ? [`Problem: ${view.failureReason}`] : []),
      "History:", ...view.history.slice(-6).map((h) => `- ${h.at.toISOString().slice(0, 16).replace("T", " ")} ${h.label}${h.detail ? ` (${h.detail})` : ""} [${h.source.toLowerCase()}]`),
    ].join("\n");
  }
  // /store courier <number> <word> [reason]
  const word = (rest[1] ?? "").toLowerCase();
  const status = STATUS_WORDS[word];
  if (!status) return `Say what happened: /store courier ${o.reference} picked | transit | delivered | returned | failed <reason> | cancel <reason>`;
  const reason = rest.slice(2).join(" ").trim();
  if (!view) return `${o.reference} has no courier recorded. Use /store dispatch ${o.reference} via manual ...`;
  if (status === "CANCELLED") {
    if (reason.length < 3) return `Say why: /store courier ${o.reference} cancel <reason>`;
    await cancelShipment(ctx.prisma, registry, { businessId: ctx.businessId, orderId: o.id, reason, actor: idem(ctx) });
    return `The courier job for ${o.reference} is cancelled. The order is still out for delivery: book another courier with /store dispatch ${o.reference} via ..., or /store failed ${o.reference} <reason>.`;
  }
  const r = await applyShipmentUpdate(ctx.prisma, { businessId: ctx.businessId, shipmentId: view.id, status, source: "SELLER", ...(reason ? { reason } : {}) });
  if (!r.applied) return `Nothing changed: the job is already "${r.shipment.status.toLowerCase().replace(/_/g, " ")}".`;
  if (status === "DELIVERED") return `Noted: ${view.courierName} says ${o.reference} was delivered. To finish the order, take the buyer's 6-digit code: /store done ${o.reference} <code>.`;
  if (status === "FAILED") return `Noted: delivery of ${o.reference} failed (${reason}). If it will not be tried again: /store failed ${o.reference} <reason> puts the goods back in stock and cancels the order.`;
  return `Noted: ${o.reference} is now "${status.toLowerCase().replace(/_/g, " ")}". The buyer sees it on their order page.`;
}

// ---------------------------------------------------------------------------------------- requests

async function listRequests(ctx: CommandContext): Promise<string> {
  const lines: string[] = [];
  const cancels = await ctx.scopedPrisma.storeCancellationRequest.findMany({ where: { status: "REQUESTED" }, orderBy: { createdAt: "asc" }, take: 10, include: { order: true } });
  for (const c of cancels) lines.push(`#${shortId(c.id)} CANCEL ${c.order.reference}: "${c.reason}" -> /store approve ${shortId(c.id)} or /store deny ${shortId(c.id)}`);
  const refunds = await ctx.scopedPrisma.storeRefundRequest.findMany({ where: { status: { in: ["REQUESTED", "APPROVED", "GOODS_RECEIVED"] } }, orderBy: { createdAt: "asc" }, take: 10, include: { order: true } });
  for (const r of refunds) {
    const next = r.status === "REQUESTED" ? `/store refund approve ${shortId(r.id)} [amount] or deny` : r.status === "APPROVED" ? (r.kind === "RETURN" ? `when the goods are back: /store refund received ${shortId(r.id)}` : `/store refund pay ${shortId(r.id)} [cash|momo|bank]`) : `/store refund pay ${shortId(r.id)} [cash|momo|bank]`;
    lines.push(`#${shortId(r.id)} ${r.kind === "RETURN" ? "RETURN" : "REFUND"} ${r.order.reference} (${label(r.status)}): "${r.reason}" -> ${next}`);
  }
  const ex = await ctx.scopedPrisma.paymentException.findMany({ where: { status: "OPEN" }, orderBy: { createdAt: "asc" }, take: 10, include: { order: true } });
  for (const e of ex) {
    const opts = e.type === "LATE_SUCCESS" ? "refund|reserve" : e.type === "UNDERPAYMENT" ? "refund|apply" : "refund";
    lines.push(`#${shortId(e.id)} PAYMENT ${e.order.reference}: ${label(e.type)} of ${money(ctx, e.amountMinor)} is being held -> /store payment ${shortId(e.id)} ${opts}`);
  }
  return lines.length ? ["Waiting for you:", ...lines].join("\n") : "Nothing waiting for you.";
}

async function decide(ctx: CommandContext, sub: string, rest: string[]): Promise<string> {
  const actor = idem(ctx);
  if (sub === "approve" || sub === "deny") {
    const found = await ctx.scopedPrisma.storeCancellationRequest.findFirst({ where: { id: { startsWith: cleanId(rest[0]) }, status: "REQUESTED" } });
    if (!found || cleanId(rest[0]).length < 4) return "I can't find that cancellation request. Send /store requests.";
    await decideCancellationRequest(ctx.prisma, { businessId: ctx.businessId, requestId: found.id, approve: sub === "approve", actor });
    return sub === "approve" ? "Cancellation approved: the order is cancelled and the held stock released." : "Cancellation request declined; the order carries on.";
  }
  if (sub === "payment") {
    const e = cleanId(rest[0]).length >= 4 ? await ctx.scopedPrisma.paymentException.findFirst({ where: { id: { startsWith: cleanId(rest[0]) }, status: "OPEN" } }) : null;
    if (!e) return "I can't find that held payment. Send /store requests.";
    const word = (rest[1] ?? "").toLowerCase();
    const action = word === "refund" ? "REFUND" : word === "reserve" ? "RE_RESERVE" : word === "apply" ? "APPLY" : null;
    if (!action) return `Say what to do: /store payment ${shortId(e.id)} refund|reserve|apply`;
    if (action === "REFUND") {
      const out = await refundHeldPayment(ctx.prisma, getAdapterRegistry(ctx.prisma), { businessId: ctx.businessId, exceptionId: e.id, actor });
      if (out.via === "PROVIDER") return out.refund.status === "SUCCEEDED" ? "The held payment was sent back through the payment provider and recorded." : out.refund.status === "PENDING" ? "The refund was sent to the payment provider. It will be recorded when the provider confirms." : `The payment provider could not send the refund (${out.refund.failureReason ?? "no reason given"}). The payment is still held.`;
      return `Done: ${label(e.type)} resolved by refund. Order ${out.orderReference} updated.`;
    }
    const r = await resolvePaymentException(ctx.prisma, { businessId: ctx.businessId, exceptionId: e.id, action, refundMethod: "MOBILE_MONEY", actor });
    return `Done: ${label(r.exception.type)} resolved by ${word}. Order ${r.order.reference} is now ${label(r.order.status)}.`;
  }
  // refund ...
  const action = (rest[0] ?? "").toLowerCase();
  const id = cleanId(rest[1]);
  const req = id.length >= 4 ? await ctx.scopedPrisma.storeRefundRequest.findFirst({ where: { id: { startsWith: id } }, include: { lines: true } }) : null;
  if (!req) return "I can't find that refund request. Send /store requests.";
  switch (action) {
    case "approve": {
      const amt = rest[2] ? parseAmountToMinorUnits(rest[2], ctx.minorUnitExp) : undefined;
      const r = await decideRefund(ctx.prisma, { businessId: ctx.businessId, requestId: req.id, approve: true, ...(amt !== undefined ? { approvedAmountMinor: amt } : {}), actor });
      return r.kind === "RETURN" ? "Approved. When the goods are back, send /store refund received " + shortId(r.id) + "." : `Approved a refund of ${money(ctx, r.approvedAmountMinor ?? 0n)}. Pay it out: /store refund pay ${shortId(r.id)} [cash|momo|bank].`;
    }
    case "deny":
      await decideRefund(ctx.prisma, { businessId: ctx.businessId, requestId: req.id, approve: false, actor });
      return "Request declined.";
    case "received": {
      const r = await receiveReturn(ctx.prisma, { businessId: ctx.businessId, requestId: req.id, accepted: req.lines.map((l) => ({ orderLineId: l.orderLineId, quantityBase: l.quantityBase })), actor });
      return `Goods back in stock. Refund due: ${money(ctx, r.approvedAmountMinor ?? 0n)}. Pay it out: /store refund pay ${shortId(r.id)} [cash|momo|bank].`;
    }
    case "pay": {
      const out = await payOutStoreRefund(ctx.prisma, getAdapterRegistry(ctx.prisma), { businessId: ctx.businessId, orderId: req.orderId, requestId: req.id, manualMethod: methodOf(rest[2]), actor });
      if (out.via === "MANUAL") return `Refund of ${money(ctx, out.payment.amountMinor)} recorded. Make sure the money actually reaches the buyer.`;
      if (out.replayed && out.refund.status === "SUCCEEDED") return "That refund was already sent and recorded. Nothing more to do.";
      return out.refund.status === "SUCCEEDED"
        ? `Refund of ${money(ctx, out.refund.amountMinor)} sent back through the payment provider and recorded.`
        : out.refund.status === "PENDING"
          ? `Refund of ${money(ctx, out.refund.amountMinor)} sent to the payment provider. It will be recorded when the provider confirms.`
          : `The payment provider could not send the refund (${out.refund.failureReason ?? "no reason given"}). It is NOT recorded. TradePal support can see it; try again later with /store refund pay ${shortId(req.id)}.`;
    }
    default: return USAGE;
  }
}

// ------------------------------------------------------------------------------------------- cases

async function listCases(ctx: CommandContext): Promise<string> {
  const cases = await ctx.scopedPrisma.supportCase.findMany({ where: { status: { not: "CLOSED" }, handledBy: "SELLER" }, orderBy: { createdAt: "asc" }, take: 10, include: { order: true } });
  if (cases.length === 0) return "No open problems reported by shoppers.";
  return ["Problems reported by shoppers (yours to sort out):", ...cases.map((c) => `#${shortId(c.id)} ${label(c.type)}${c.order ? ` on ${c.order.reference}` : ""}: "${c.summary.slice(0, 120)}"${c.contactPhone ? ` Call ${c.contactName ?? "the buyer"} on ${c.contactPhone}.` : ""}`), "Reply with /store case <id> note <what you did>. If it is not sorted, TradePal support can step in."].join("\n");
}

async function caseNote(ctx: CommandContext, rest: string[]): Promise<string> {
  const id = cleanId(rest[0]);
  const c = id.length >= 4 ? await ctx.scopedPrisma.supportCase.findFirst({ where: { id: { startsWith: id }, status: { not: "CLOSED" } } }) : null;
  if (!c) return "I can't find that open problem. Send /store cases.";
  const body = rest.slice(2).join(" ").trim();
  if ((rest[1] ?? "").toLowerCase() !== "note" || body.length < 3) return `Use /store case ${shortId(c.id)} note <what you did>.`;
  await ctx.scopedPrisma.supportCaseNote.create({ data: { businessId: ctx.businessId, caseId: c.id, authorType: "SELLER", authorId: ctx.merchantId, body: body.slice(0, 1_000) } });
  return "Note added to the case.";
}

// ------------------------------------------------------------------------------------- marketplace

async function marketplace(ctx: CommandContext, sub: string, tail: string): Promise<string> {
  const biz = ctx.businessId;
  if (sub === "marketplace") {
    const word = tail.toLowerCase();
    if (word === "on") {
      await enableMarketplace(ctx.prisma, biz);
      return "You are on the marketplace. Shoppers in your country can now find your published items. Everything is sold and delivered by you; TradePal only shows it.";
    }
    if (word === "off") {
      await disableMarketplace(ctx.prisma, biz);
      return "You are off the marketplace. Your own shop link still works.";
    }
    const sf = await ctx.scopedPrisma.storefront.findFirst({ where: {} });
    const r = await marketplaceReadiness(ctx.prisma, biz);
    const published = await ctx.scopedPrisma.listing.count({ where: { channel: "MARKETPLACE", status: "ACTIVE" } });
    return [`Marketplace: ${sf?.marketplaceStatus ?? "OFF"}. ${published} item(s) published.`, ...(sf?.marketplaceNote ? [`Note: ${sf.marketplaceNote}`] : []), r.ready ? "You are ready: /store marketplace on" : `Not ready: ${r.missing.join("; ")}.`].join("\n");
  }
  const [skuWord, ...catWords] = tail.split(/\s+/).filter(Boolean);
  const v = skuWord ? await findVariantByText(ctx.scopedPrisma, skuWord) : null;
  if (!v) return `I can't find a product "${skuWord ?? ""}". See /products.`;
  if (sub === "unpublish") {
    await unpublishMarketplaceListing(ctx.prisma, biz, v.id);
    return `${v.sku} is no longer on the marketplace.`;
  }
  if (catWords.length === 0) return `Say the category: /store publish ${v.sku} <category>. See /store categories.`;
  const r = await publishMarketplaceListing(ctx.prisma, biz, v.id, catWords.join(" "));
  return `${v.sku} is published on the marketplace under "${r.category}". It shows once you switch the marketplace on (/store marketplace on).`;
}

async function moderationView(ctx: CommandContext): Promise<string> {
  const m = await moderationStatusFor(ctx.prisma, ctx.businessId);
  const lines = [`Marketplace status: ${m.marketplaceStatus}${m.note ? ` (${m.note})` : ""}.`];
  for (const u of m.unpublished) lines.push(`Unpublished by a moderator: ${u.sku}${u.reason ? ` - ${u.reason}` : ""}.`);
  for (const a of m.appeals) lines.push(`Appeal (${a.createdAt.toISOString().slice(0, 10)}): ${a.status.toLowerCase()}${a.decisionNote ? ` - ${a.decisionNote}` : ""}.`);
  if (lines.length === 1 && m.marketplaceStatus !== "SUSPENDED") lines.push("No moderation decisions about you.");
  else if (m.unpublished.length > 0 || m.marketplaceStatus === "SUSPENDED") lines.push("If you think this is wrong: /store appeal <what happened>.");
  return lines.join("\n");
}

// ----------------------------------------------------------------------------------------- payments

async function listPayments(ctx: CommandContext): Promise<string> {
  const attempts = await ctx.scopedPrisma.paymentAttempt.findMany({ orderBy: { createdAt: "desc" }, take: 8, include: { intent: true } });
  if (attempts.length === 0) return "No online payments yet.";
  const lines = attempts.map((a) => `${a.intent.reference}: ${money(ctx, a.amountMinor)} - ${a.status === "PENDING" ? "waiting for the buyer/provider" : a.status === "UNKNOWN" ? "NOT CONFIRMED (checking with the provider)" : a.status.toLowerCase()}${a.status === "SUCCEEDED" ? `, ${a.settledAt ? "paid out to you" : "collected by the provider, not paid out yet"}` : ""}`);
  return ["Recent online payments:", ...lines, "A payment counts only when the provider confirms it."].join("\n");
}
