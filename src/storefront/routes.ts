import express, { Router, type NextFunction, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { asyncHandler } from "../admin/asyncHandler.js";
import { InMemoryLoginRateLimiter, type LoginRateLimiter } from "../admin/rateLimiter.js";
import { addToBasket, basketView, setLineQuantity } from "../domain/store/basket.js";
import { StoreError, loadPublicStorefront, loadPublicStorefrontById, simulatedPaymentsAllowed } from "../domain/store/common.js";
import { openSupportCase, PARTY_LABEL } from "../domain/store/cases.js";
import {
  cancelStoreOrderByBuyer, checkoutBasket, publicOrderView, resolveOrderByToken, type PublicOrderView, type SellerCheckoutInput,
} from "../domain/store/orders.js";
import { requestRefund } from "../domain/store/refunds.js";
import { publicCatalog } from "../domain/store/storefront.js";
import { getTenantScopedClient } from "../db/tenantScope.js";
import { esc, money, notFoundPage, page } from "./html.js";
import { receiveSimulatorCallback, simulateSuccessfulPayment } from "../payments/simulator.js";

/**
 * The public storefront (expansion Phase 4): server-rendered HTML, no JavaScript. Security posture:
 *  - a shopper's only credentials are unguessable tokens (a secret basket cookie, or a secret order link); never an order
 *    number, an id or a phone number;
 *  - state-changing posts need the cookie (SameSite=Lax, HttpOnly) or the secret link, AND pass an Origin check;
 *  - every dynamic value is HTML-escaped; request bodies are small, validated with zod and length-limited;
 *  - per-client rate limits on every form and read;
 *  - pages carrying a secret are `no-store`, `noindex` and send no referrer.
 */
export interface StorefrontOptions {
  /** Allow the "pay online" choice at all (also needs the seller's flag and a non-production environment). */
  simulatorSecret?: string;
  limiters?: { read?: LoginRateLimiter; write?: LoginRateLimiter; order?: LoginRateLimiter };
  secureCookies?: boolean;
  now?: () => Date;
}

const BASKET_COOKIE = "tp_basket";
const PLACED_COOKIE = "tp_placed";
const MAX_PLACED = 20;

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res: Response, name: string, value: string, maxAgeSeconds: number, secure: boolean): void {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

function privateHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  res.setHeader("Referrer-Policy", "no-referrer");
}

const text = (max: number) => z.string().trim().max(max);
const checkoutSchema = z.object({ buyerName: text(80), buyerPhone: text(30), buyerNote: text(500).optional(), consent: z.string().optional() });

export function createStorefrontRouter(prisma: PrismaClient, options: StorefrontOptions = {}): Router {
  const router = Router();
  const read = options.limiters?.read ?? new InMemoryLoginRateLimiter(300, 60_000);
  const write = options.limiters?.write ?? new InMemoryLoginRateLimiter(120, 10 * 60_000);
  const orderLimiter = options.limiters?.order ?? new InMemoryLoginRateLimiter(10, 60 * 60_000);
  const clock = options.now ?? (() => new Date());
  const secure = options.secureCookies ?? process.env["NODE_ENV"] === "production";
  const allowOnline = () => Boolean(options.simulatorSecret) && simulatedPaymentsAllowed();

  router.use(express.urlencoded({ extended: false, limit: "20kb", parameterLimit: 200 }));

  // The label keeps read, write and order counters apart even when they share one backing store (Redis).
  const limit = (kind: LoginRateLimiter, label: string) =>
    asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
      const r = await kind.consume(`store:${label}:${req.ip ?? "?"}`);
      if (!r.allowed) {
        res.status(429).set("Retry-After", String(r.retryAfterSeconds)).type("html").send(page("Slow down", `<h1>Too many requests</h1><p>Please wait a moment and try again.</p>`));
        return;
      }
      next();
    });

  // Origin check for every form post: a browser sends Origin on cross-site posts, and it must match this host.
  router.use((req, res, next) => {
    if (req.method === "POST") {
      const origin = req.headers.origin;
      if (origin) {
        let host: string | null = null;
        try {
          host = new URL(origin).host;
        } catch {
          host = null;
        }
        if (host !== req.headers.host) {
          res.status(403).type("html").send(page("Not allowed", `<h1>That request was not allowed</h1>`));
          return;
        }
      }
    }
    next();
  });

  // ------------------------------------------------------------------------------- catalog

  router.get("/shop/:slug", limit(read, "read"), asyncHandler(async (req, res) => {
    const sf = await loadPublicStorefront(prisma, req.params["slug"] as string);
    if (!sf) {
      res.status(404).type("html").send(notFoundPage());
      return;
    }
    const q = typeof req.query["q"] === "string" ? req.query["q"].slice(0, 60) : "";
    const pageNo = Math.max(1, Math.min(200, Number(req.query["page"]) || 1));
    const cat = await publicCatalog(prisma, sf.businessId, { q, take: 30, skip: (pageNo - 1) * 30, at: clock() });
    const items = cat.items.map((it) => `<div class="card"><strong>${esc(it.name)}</strong>${it.variantName ? ` <span class="muted">${esc(it.variantName)}</span>` : ""}
      ${it.imageUrl ? `<div><img src="${esc(it.imageUrl)}" alt="${esc(it.name)}" loading="lazy" width="96" height="96"></div>` : ""}
      <p><span class="badge">${it.availability === "IN_STOCK" ? "In stock" : it.availability === "LOW_STOCK" ? "Only a few left" : "Out of stock"}</span></p>
      ${it.availability === "OUT_OF_STOCK" ? "" : `<form method="post" action="/shop/${esc(sf.slug)}/add">
        <input type="hidden" name="variantId" value="${esc(it.variantId)}">
        <label for="u-${esc(it.variantId)}">Size</label>
        <select id="u-${esc(it.variantId)}" name="unit">${it.options.map((o) => `<option value="${esc(o.unit)}"${o.available ? "" : " disabled"}>${esc(o.label)} - ${money(o.unitPriceMinor, cat.minorUnitExp, cat.currencyCode)}${o.minQuantity > 1 ? ` (from ${o.minQuantity})` : ""}${o.available ? "" : " (not enough in stock)"}</option>`).join("")}</select>
        <label for="q-${esc(it.variantId)}">Quantity</label>
        <input id="q-${esc(it.variantId)}" name="quantity" type="number" inputmode="numeric" min="1" max="999" value="${Math.max(1, ...it.options.map((o) => o.minQuantity).slice(0, 1))}" required>
        <p><button type="submit">Add to basket</button></p></form>`}</div>`).join("");
    const body = `<h1>${esc(sf.title)}</h1>${sf.about ? `<p>${esc(sf.about)}</p>` : ""}
      <p class="muted">${sf.pickupEnabled ? `Pickup: ${esc(sf.pickupLocation ?? "")}. ` : ""}${sf.deliveryEnabled ? "Delivery available (fee shown at checkout). " : ""}Questions: ${esc(sf.supportPhone ?? "")}</p>
      <form method="get" action="/shop/${esc(sf.slug)}"><label for="q">Search this shop</label><input id="q" name="q" value="${esc(q)}" maxlength="60"><p><button type="submit" class="secondary">Search</button> <a class="btn secondary" href="/basket">Basket</a></p></form>
      ${items || "<p>Nothing to show.</p>"}
      ${cat.hasMore ? `<p><a href="/shop/${esc(sf.slug)}?q=${encodeURIComponent(q)}&amp;page=${pageNo + 1}">More items</a></p>` : ""}
      ${sf.termsText ? `<h2>Shop terms</h2><p class="muted">${esc(sf.termsText)}</p>` : ""}
      <p class="muted">Sold by ${esc(sf.title)}. The seller is responsible for the goods and for delivery.</p>`;
    res.type("html").send(page(sf.title, body));
  }));

  // ------------------------------------------------------------------------------- basket

  router.post("/shop/:slug/add", limit(write, "write"), asyncHandler(async (req, res) => {
    const sf = await loadPublicStorefront(prisma, req.params["slug"] as string);
    if (!sf) {
      res.status(404).type("html").send(notFoundPage());
      return;
    }
    const parsed = z.object({ variantId: text(80), unit: text(40), quantity: z.coerce.number().int() }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).type("html").send(page("Check your choice", `<h1>Please check your choice</h1><p><a href="/shop/${esc(sf.slug)}">Back to the shop</a></p>`));
      return;
    }
    try {
      const { token } = await addToBasket(prisma, { token: cookies(req)[BASKET_COOKIE] ?? null, businessId: sf.businessId, variantId: parsed.data.variantId, unit: parsed.data.unit, quantity: parsed.data.quantity, now: clock() });
      setCookie(res, BASKET_COOKIE, token, 7 * 86_400, secure);
      res.redirect(303, "/basket");
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      res.status(422).type("html").send(page("Could not add", `<h1>Could not add that</h1><p class="err">${esc(error.message)}</p><p><a href="/shop/${esc(sf.slug)}">Back to the shop</a></p>`));
    }
  }));

  router.post("/basket/update", limit(write, "write"), asyncHandler(async (req, res) => {
    privateHeaders(res);
    const parsed = z.object({ lineId: text(80), quantity: z.coerce.number().int() }).safeParse(req.body);
    const token = cookies(req)[BASKET_COOKIE];
    if (parsed.success && token) {
      try {
        await setLineQuantity(prisma, token, parsed.data.lineId, parsed.data.quantity, clock());
      } catch (error) {
        if (!(error instanceof StoreError)) throw error;
      }
    }
    res.redirect(303, "/basket");
  }));

  router.get("/basket", limit(read, "read"), asyncHandler(async (req, res) => {
    privateHeaders(res);
    const view = await basketView(prisma, cookies(req)[BASKET_COOKIE], { allowOnlinePayment: allowOnline(), now: clock() });
    if (view.empty) {
      res.type("html").send(page("Your basket", `<h1>Your basket is empty</h1><p>Open a shop link to start. <a href="/orders">Your orders</a></p>`));
      return;
    }
    const sections = view.sellers.map((s) => {
      const lines = s.lines.map((l) => `<tr><td>${esc(l.name)}<br><span class="muted">${esc(l.unit)}</span>${l.problem ? `<br><span class="err">${esc(l.problem)}</span>` : ""}</td>
        <td class="n"><form method="post" action="/basket/update" class="row"><input type="hidden" name="lineId" value="${esc(l.lineId)}"><label class="muted" for="q-${esc(l.lineId)}">Qty</label>
        <input id="q-${esc(l.lineId)}" name="quantity" type="number" min="0" max="999" value="${l.quantity}" style="width:5rem"><button class="secondary" type="submit">Update</button></form></td>
        <td class="n">${l.lineTotalMinor === null ? "-" : money(l.lineTotalMinor, s.minorUnitExp, s.currencyCode)}</td></tr>`).join("");
      const id = esc(s.businessId);
      return `<div class="card"><h2>${esc(s.sellerName)}</h2><table><tbody>${lines}</tbody></table>
        <p><strong>Items: ${money(s.subtotalMinor, s.minorUnitExp, s.currencyCode)}</strong></p>
        ${s.checkoutReady ? `<fieldset class="card"><legend>How do you want to get this order?</legend>
          ${s.pickupEnabled ? `<label><input type="radio" name="fulfil_${id}" value="PICKUP" checked> Collect it: ${esc(s.pickupLocation ?? "")}</label>` : ""}
          ${s.deliveryEnabled ? `<label><input type="radio" name="fulfil_${id}" value="DELIVERY"${s.pickupEnabled ? "" : " checked"}> Deliver it to me (fee added below)</label>
            <label for="zone_${id}">Delivery area</label><select id="zone_${id}" name="zone_${id}">${s.zones.map((z) => `<option value="${esc(z.id)}">${esc(z.name)} - fee ${money(z.feeMinor, s.minorUnitExp, s.currencyCode)}${z.minOrderMinor ? ` (minimum order ${money(z.minOrderMinor, s.minorUnitExp, s.currencyCode)})` : ""}</option>`).join("")}</select>
            <label for="landmark_${id}">Landmark or address for delivery</label><input id="landmark_${id}" name="landmark_${id}" maxlength="200">` : ""}
          <label for="pay_${id}">Payment</label><select id="pay_${id}" name="pay_${id}"><option value="PAY_ON_COLLECTION">Pay the seller when you collect or receive it</option>${s.paymentMethods.includes("ONLINE_SIMULATED") ? `<option value="ONLINE_SIMULATED">Pay online (TEST ONLY: no real money)</option>` : ""}</select>
          <input type="hidden" name="seller" value="${id}"></fieldset>` : `<p class="err">This part of your basket cannot be ordered yet. Fix the items marked above.</p>`}</div>`;
    }).join("");
    const ready = view.sellers.some((s) => s.checkoutReady);
    res.type("html").send(page("Your basket", `<h1>Your basket</h1><p class="muted">Each seller prepares and charges for their own order. Nothing is pooled.</p>
      <form method="post" action="/basket/checkout">${sections}
      ${ready ? `<div class="card"><h2>Your details</h2><label for="buyerName">Your name</label><input id="buyerName" name="buyerName" maxlength="80" required autocomplete="name">
        <label for="buyerPhone">Phone number the seller can call</label><input id="buyerPhone" name="buyerPhone" inputmode="tel" maxlength="30" required autocomplete="tel">
        <label for="buyerNote">Note for the seller (optional)</label><textarea id="buyerNote" name="buyerNote" maxlength="500" rows="2"></textarea>
        <label><input type="checkbox" name="consent" value="yes"> The seller may contact me about this order</label>
        <p><button type="submit">Place order${view.sellers.length > 1 ? "s" : ""}</button></p></div>` : ""}</form><p><a href="/orders">Your orders</a></p>`));
  }));

  router.post("/basket/checkout", limit(orderLimiter, "order"), asyncHandler(async (req, res) => {
    privateHeaders(res);
    const token = cookies(req)[BASKET_COOKIE];
    const parsed = checkoutSchema.safeParse(req.body);
    if (!token || !parsed.success) {
      res.status(400).type("html").send(page("Check your details", `<h1>Please check your details</h1><p><a href="/basket">Back to your basket</a></p>`));
      return;
    }
    const body = req.body as Record<string, string | string[] | undefined>;
    const sellerIds = ([] as string[]).concat(body["seller"] ?? []).filter((x) => typeof x === "string");
    const sellers: SellerCheckoutInput[] = sellerIds.map((id) => ({
      businessId: id,
      fulfilment: body[`fulfil_${id}`] === "DELIVERY" ? "DELIVERY" : "PICKUP",
      paymentMethod: body[`pay_${id}`] === "ONLINE_SIMULATED" ? "ONLINE_SIMULATED" : "PAY_ON_COLLECTION",
      ...(typeof body[`zone_${id}`] === "string" ? { zoneId: String(body[`zone_${id}`]).slice(0, 80) } : {}),
      address: { landmark: String(body[`landmark_${id}`] ?? "").slice(0, 200) },
    }));
    try {
      const result = await checkoutBasket(prisma, {
        basketToken: token, allowOnline: allowOnline(), now: clock(), sellers,
        buyer: { name: parsed.data.buyerName, phone: parsed.data.buyerPhone, ...(parsed.data.buyerNote ? { note: parsed.data.buyerNote } : {}), contactConsent: parsed.data.consent === "yes" },
      });
      if (result.alreadyPlaced) {
        res.redirect(303, "/orders");
        return;
      }
      if (result.nextBasketToken) setCookie(res, BASKET_COOKIE, result.nextBasketToken, 7 * 86_400, secure);
      const placedTokens = (cookies(req)[PLACED_COOKIE] ?? "").split(",").filter(Boolean);
      const rows: string[] = [];
      for (const o of result.outcomes) {
        if (o.ok) {
          placedTokens.push(o.accessToken);
          const sf = await loadPublicStorefrontById(prisma, o.businessId);
          rows.push(`<div class="card"><strong>${esc(sf?.title ?? "Seller")}</strong>: order <strong>${esc(o.order.reference)}</strong> placed. <a href="/order/${esc(o.accessToken)}">Track this order</a></div>`);
        } else {
          rows.push(`<div class="card warn"><strong>Not placed.</strong> ${esc(o.error)}</div>`);
        }
      }
      setCookie(res, PLACED_COOKIE, placedTokens.slice(-MAX_PLACED).join(","), 90 * 86_400, secure);
      res.type("html").send(page("Order placed", `<h1>${result.outcomes.some((o) => o.ok) ? "Thank you" : "We could not place your order"}</h1>${rows.join("")}
        <p class="muted">Keep these links: each one is the only way to see that order. Orders are separate: each seller confirms, prepares and charges for their own.</p>${result.nextBasketToken ? `<p><a class="btn" href="/basket">Back to what is left in your basket</a></p>` : ""}`));
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      res.status(422).type("html").send(page("Could not order", `<h1>We could not place your order</h1><p class="err">${esc(error.message)}</p><p><a href="/basket">Back to your basket</a></p>`));
    }
  }));

  router.get("/orders", limit(read, "read"), asyncHandler(async (req, res) => {
    privateHeaders(res);
    const tokens = (cookies(req)[PLACED_COOKIE] ?? "").split(",").filter(Boolean).slice(-MAX_PLACED);
    const rows: string[] = [];
    for (const t of tokens.reverse()) {
      const ref = await resolveOrderByToken(prisma, t, clock());
      if (!ref) continue;
      const v = await publicOrderView(prisma, ref.businessId, ref.orderId, clock());
      rows.push(`<div class="card"><a href="/order/${esc(t)}"><strong>${esc(v.reference)}</strong></a> from ${esc(v.seller.name)} <span class="badge">${esc(v.status.replace(/_/g, " ").toLowerCase())}</span><br>${money(v.totalMinor, v.minorUnitExp, v.currencyCode)}</div>`);
    }
    res.type("html").send(page("Your orders", `<h1>Your orders</h1>${rows.join("") || "<p>No orders on this device yet.</p>"}`));
  }));

  // ------------------------------------------------------------------------------- order page

  const withOrder = (handler: (ctx: { req: Request; res: Response; businessId: string; orderId: string; token: string }) => Promise<void>) =>
    asyncHandler(async (req, res) => {
      privateHeaders(res);
      const token = req.params["token"] as string;
      const ref = await resolveOrderByToken(prisma, token, clock());
      if (!ref) {
        res.status(404).type("html").send(notFoundPage());
        return;
      }
      await handler({ req, res, businessId: ref.businessId, orderId: ref.orderId, token });
    });

  const orderPage = (v: PublicOrderView, token: string, flash = "") => {
    const m = (x: bigint) => money(x, v.minorUnitExp, v.currencyCode);
    const steps = v.timeline.map((t) => `<li>${esc(t.label)} <span class="muted">${esc(t.at.toISOString().slice(0, 16).replace("T", " "))} UTC</span></li>`).join("");
    const items = v.items.map((i) => `<tr><td>${esc(i.description)} <span class="muted">${i.quantity} x ${esc(i.unit)}</span></td><td class="n">${m(i.lineTotalMinor)}</td></tr>`).join("");
    const payNote = v.paymentMethod === "PAY_ON_COLLECTION" ? "Pay the seller when you collect or receive your order." : v.paidMinor >= v.totalMinor ? "Paid." : "Waiting for payment.";
    return page(`Order ${v.reference}`, `<h1>Order ${esc(v.reference)}</h1>${flash ? `<p class="card warn">${esc(flash)}</p>` : ""}
      <p><span class="badge">${esc(v.status.replace(/_/g, " ").toLowerCase())}</span> from <strong>${esc(v.seller.name)}</strong>${v.seller.supportPhone ? `, phone ${esc(v.seller.supportPhone)}` : ""}</p>
      ${v.paymentUnderReview ? `<p class="card warn">We are checking a payment on this order. The seller will contact you.</p>` : ""}
      <h2>What happens next</h2><ul>${steps}</ul>
      ${v.collection ? `<p><strong>Collect at:</strong> ${esc(v.collection.location ?? "")}${v.collection.instructions ? `<br>${esc(v.collection.instructions)}` : ""}</p>` : ""}
      ${v.delivery ? `<p><strong>Delivery to:</strong> ${esc(v.delivery.landmark ?? v.delivery.address ?? "")} (${esc(v.delivery.zone ?? "")})${v.delivery.reference ? `<br>Delivery reference: ${esc(v.delivery.reference)}` : ""}</p>` : ""}
      ${["CONFIRMED", "READY", "OUT_FOR_DELIVERY"].includes(v.status) ? `<div class="card"><strong>Your handover code: ${esc(v.pickupCode)}</strong><br><span class="muted">Give it to the seller when you ${v.fulfilment === "PICKUP" ? "collect" : "receive"} your order. Do not share it any other way.</span></div>` : ""}
      <h2>Items</h2><table><tbody>${items}<tr><td>Items total</td><td class="n">${m(v.subtotalMinor)}</td></tr>${v.deliveryFeeMinor > 0n ? `<tr><td>Delivery fee</td><td class="n">${m(v.deliveryFeeMinor)}</td></tr>` : ""}<tr><th>Total</th><th class="n">${m(v.totalMinor)}</th></tr></tbody></table>
      <p>${esc(payNote)}${v.refundedMinor > 0n ? ` Refunded so far: ${m(v.refundedMinor)}.` : ""}</p>
      ${v.actions.pay && allowOnline() ? `<form method="post" action="/order/${esc(token)}/pay"><button type="submit">Pay now (TEST ONLY: no real money moves)</button></form>` : ""}
      ${v.actions.cancel !== "NONE" ? `<h2>Cancel</h2><p class="muted">${esc(v.actions.cancelMessage)}</p><form method="post" action="/order/${esc(token)}/cancel"><label for="creason">Reason${v.actions.cancel === "REQUEST" ? "" : " (optional)"}</label><input id="creason" name="reason" maxlength="300"${v.actions.cancel === "REQUEST" ? " required" : ""}><p><button class="secondary" type="submit">${v.actions.cancel === "IMMEDIATE" ? "Cancel my order" : "Ask to cancel"}</button></p></form>` : `<p class="muted">${esc(v.actions.cancelMessage)}</p>`}
      ${v.requests.cancellations.map((c) => `<p class="muted">Cancellation request: ${esc(c.status.toLowerCase())}</p>`).join("")}
      <h2>Return or refund</h2><p class="muted">${esc(v.actions.refund.message)}</p>
      ${v.actions.refund.allowed ? `<form method="post" action="/order/${esc(token)}/refund"><label for="rk">What do you need?</label><select id="rk" name="kind"><option value="REFUND_ONLY">A refund (no return)</option><option value="RETURN">Return everything and get a refund</option></select>
        <label for="rr">What is wrong?</label><textarea id="rr" name="reason" rows="2" maxlength="500" required></textarea><label for="ra">Amount you are asking for (refund only)</label><input id="ra" name="amount" inputmode="decimal" maxlength="20"><p><button type="submit" class="secondary">Send request</button></p></form><p class="muted">A request is not a refund: the seller decides.</p>` : ""}
      ${v.requests.refunds.map((r) => `<p class="muted">Refund request: ${esc(r.status.toLowerCase().replace(/_/g, " "))}</p>`).join("")}
      <h2>Report a problem</h2><form method="post" action="/order/${esc(token)}/problem"><label for="pt">Type</label><select id="pt" name="type"><option value="DELIVERY">Delivery</option><option value="PRODUCT_COMPLAINT">The goods</option><option value="PAYMENT_DISPUTE">A payment</option><option value="OTHER">Something else</option></select>
        <label for="ps">Tell us what happened</label><textarea id="ps" name="summary" rows="3" maxlength="1000" required></textarea><p><button type="submit" class="secondary">Send</button></p></form>
      <p><a href="/order/${esc(token)}/receipt">Receipt</a> &middot; <a href="/orders">Your orders</a></p>${v.terms ? `<p class="muted">Seller terms: ${esc(v.terms)}</p>` : ""}`);
  };

  router.get("/order/:token", limit(read, "read"), withOrder(async ({ req, res, businessId, orderId, token }) => {
    const v = await publicOrderView(prisma, businessId, orderId, clock());
    res.type("html").send(orderPage(v, token, typeof req.query["m"] === "string" ? req.query["m"].slice(0, 200) : ""));
  }));

  router.get("/order/:token/receipt", limit(read, "read"), withOrder(async ({ res, businessId, orderId }) => {
    const v = await publicOrderView(prisma, businessId, orderId, clock());
    const m = (x: bigint) => money(x, v.minorUnitExp, v.currencyCode);
    const rows = v.items.map((i) => `<tr><td>${esc(i.description)}</td><td>${i.quantity} x ${esc(i.unit)}</td><td class="n">${m(i.unitPriceMinor)}</td><td class="n">${m(i.lineTotalMinor)}</td></tr>`).join("");
    res.type("html").send(page(`Receipt ${v.reference}`, `<h1>Receipt ${esc(v.reference)}</h1><p>Seller: <strong>${esc(v.seller.name)}</strong>${v.seller.supportPhone ? ` (${esc(v.seller.supportPhone)})` : ""}</p>
      <table><thead><tr><th>Item</th><th>Qty</th><th class="n">Price</th><th class="n">Total</th></tr></thead><tbody>${rows}</tbody></table>
      <p>Items: ${m(v.subtotalMinor)}${v.deliveryFeeMinor > 0n ? `<br>Delivery: ${m(v.deliveryFeeMinor)}` : ""}<br><strong>Total: ${m(v.totalMinor)}</strong><br>Paid: ${m(v.paidMinor)}${v.refundedMinor > 0n ? `<br>Refunded: ${m(v.refundedMinor)}` : ""}</p>
      <p class="muted">Status: ${esc(v.status.replace(/_/g, " ").toLowerCase())}. This receipt is the seller's record of your order.</p>`));
  }));

  const back = (res: Response, token: string, message: string) => res.redirect(303, `/order/${encodeURIComponent(token)}?m=${encodeURIComponent(message)}`);

  router.post("/order/:token/cancel", limit(write, "write"), withOrder(async ({ req, res, businessId, orderId, token }) => {
    const parsed = z.object({ reason: text(300).optional() }).safeParse(req.body);
    try {
      const r = await cancelStoreOrderByBuyer(prisma, { businessId, orderId, ...(parsed.success && parsed.data.reason ? { reason: parsed.data.reason } : {}), now: clock() });
      back(res, token, r.outcome === "CANCELLED" ? "Your order is cancelled." : "Your cancellation request was sent. The seller will decide.");
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      back(res, token, error.message);
    }
  }));

  router.post("/order/:token/refund", limit(write, "write"), withOrder(async ({ req, res, businessId, orderId, token }) => {
    const parsed = z.object({ kind: z.enum(["RETURN", "REFUND_ONLY"]), reason: text(500), amount: text(20).optional() }).safeParse(req.body);
    if (!parsed.success) return back(res, token, "Please tell the seller what is wrong.");
    try {
      const scoped = getTenantScopedClient(prisma, businessId);
      const order = await scoped.storeOrder.findUniqueOrThrow({ where: { id: orderId }, include: { lines: true } });
      const business = await prisma.business.findUniqueOrThrow({ where: { id: businessId }, include: { currency: true } });
      const { parseAmountToMinorUnits } = await import("../domain/money.js");
      await requestRefund(prisma, {
        businessId, orderId, kind: parsed.data.kind, reason: parsed.data.reason, now: clock(),
        ...(parsed.data.kind === "RETURN" ? { lines: order.lines.map((l) => ({ orderLineId: l.id, quantityBase: l.baseQuantity - l.returnedBase })).filter((l) => l.quantityBase > 0) } : { requestedAmountMinor: parseAmountToMinorUnits(parsed.data.amount ?? "0", business.currency.minorUnitExp) }),
      });
      back(res, token, "Your request was sent to the seller. A request is not a refund: the seller decides.");
    } catch (error) {
      if (error instanceof StoreError) return back(res, token, error.message);
      if (error instanceof Error && error.name === "InvalidAmountError") return back(res, token, error.message);
      throw error;
    }
  }));

  router.post("/order/:token/problem", limit(write, "write"), withOrder(async ({ req, res, businessId, orderId, token }) => {
    const parsed = z.object({ type: z.enum(["DELIVERY", "PRODUCT_COMPLAINT", "PAYMENT_DISPUTE", "OTHER"]), summary: text(1000) }).safeParse(req.body);
    if (!parsed.success) return back(res, token, "Please describe the problem.");
    try {
      const scoped = getTenantScopedClient(prisma, businessId);
      const order = await scoped.storeOrder.findUniqueOrThrow({ where: { id: orderId } });
      const c = await openSupportCase(prisma, { businessId, orderId, type: parsed.data.type, openedBy: "CONSUMER", summary: parsed.data.summary, contactName: order.buyerName, contactPhone: order.buyerPhone });
      back(res, token, `We recorded your report. ${PARTY_LABEL[c.handledBy][0]!.toUpperCase()}${PARTY_LABEL[c.handledBy].slice(1)} will deal with it. If you do not hear back, TradePal support can step in.`);
    } catch (error) {
      if (error instanceof StoreError) return back(res, token, error.message);
      throw error;
    }
  }));

  // Test-money checkout. Disabled in production and unless a simulator secret is configured. It builds a SIGNED callback exactly
  // as a provider would and sends it through the same durable inbox, so nothing about it bypasses the real path.
  router.post("/order/:token/pay", limit(write, "write"), withOrder(async ({ res, businessId, orderId, token }) => {
    if (!allowOnline() || !options.simulatorSecret) return back(res, token, "Online payment is not available.");
    const scoped = getTenantScopedClient(prisma, businessId);
    const order = await scoped.storeOrder.findUniqueOrThrow({ where: { id: orderId } });
    if (order.paymentMethod !== "ONLINE_SIMULATED" || order.paidMinor >= order.totalMinor) return back(res, token, "Nothing to pay.");
    const evt = simulateSuccessfulPayment({
      secret: options.simulatorSecret, externalId: `sim-${order.id.slice(0, 8)}-${Date.now().toString(36)}`, sellerBusinessId: businessId, storeOrderId: order.id,
      amountMinor: order.totalMinor - order.paidMinor, currencyCode: order.currencyCode,
    });
    await receiveSimulatorCallback(prisma, evt.body, evt.signature, options.simulatorSecret);
    back(res, token, "Test payment sent. It will show on your order in a moment.");
  }));

  return router;
}
