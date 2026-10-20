import type { CommandContext } from "./commandRouter.js";
import { canMerchant, membershipRoleForLegacyMerchantRole, type MerchantPermission } from "../auth/permissions.js";
import { CatalogError, addPackConversion, adoptLegacyInventory, createProduct, createVariant, findVariantByText, listCatalog, toBaseQuantity } from "../domain/catalog.js";
import { DailyCloseError, closeDay, localDateString, previewDailyClose, type DailyCloseSummary } from "../domain/dailyClose.js";
import { isFeatureEnabled } from "../domain/featureFlags.js";
import { InvalidAmountError, formatMoney, parseAmountToMinorUnits } from "../domain/money.js";
import { divRoundHalfUp } from "../domain/rounding.js";
import { ensureDefaultShopFor } from "../domain/shops.js";
import { handleStoreCommand, STORE_COMMANDS } from "./storeCommands.js";
import { handleTradeCommand, TRADE_COMMANDS } from "./tradeCommands.js";
import { StockError, approveStockCount, cancelStockCount, getStockLevel, openStockCount, postAdoptionOpening, receiveStock, recordCountLine, setCountLineReason } from "../domain/stock.js";

/**
 * Merchant WhatsApp commands for the Phase 2 capabilities. Every one is behind a feature flag (default OFF); while the
 * flag is off `handleOperationsCommand` returns null and the router answers exactly as it always did (including the
 * "Unrecognized command" text), so existing behaviour is unchanged. Permissions come from the permission matrix, never
 * from role-name comparisons.
 */
export const OPERATIONS_COMMANDS = new Set(["/close", "/products", "/addproduct", "/pack", "/receive", "/count", "/adopt", ...TRADE_COMMANDS, ...STORE_COMMANDS]);

export const FLAG_DAILY_CLOSE = "dailyClose";
export const FLAG_CATALOG = "catalogV2";
export const FLAG_STOCK_V2 = "stockV2";
export const FLAG_JOURNALS = "accountingJournals";

const NOT_ALLOWED = "Only the owner or a manager can do that.";

function allowed(ctx: CommandContext, permission: MerchantPermission): boolean {
  return canMerchant(membershipRoleForLegacyMerchantRole(ctx.merchantRole), permission);
}

async function on(ctx: CommandContext, flag: string): Promise<boolean> {
  return isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, flag);
}

function money(ctx: CommandContext, v: bigint): string {
  return `${formatMoney(v, ctx.minorUnitExp)} ${ctx.currencyCode}`;
}

const idem = (ctx: CommandContext, what: string): { idempotencyKey: string } | Record<string, never> =>
  ctx.whatsappMessageId ? { idempotencyKey: `wamid:${ctx.whatsappMessageId}:${what}` } : {};

const actor = (ctx: CommandContext) => ({ type: "MERCHANT" as const, id: ctx.merchantId });

export async function handleOperationsCommand(ctx: CommandContext, command: string, args: string): Promise<string | null> {
  switch (command) {
    case "/close":
      return (await on(ctx, FLAG_DAILY_CLOSE)) ? handleClose(ctx, args) : null;
    case "/products":
    case "/addproduct":
    case "/pack":
    case "/adopt":
      if (!(await on(ctx, FLAG_CATALOG))) return null;
      return command === "/products" ? handleProducts(ctx, args) : command === "/addproduct" ? handleAddProduct(ctx, args) : command === "/pack" ? handlePack(ctx, args) : handleAdopt(ctx);
    case "/receive":
    case "/count":
      if (!(await on(ctx, FLAG_STOCK_V2))) return null;
      return command === "/receive" ? handleReceive(ctx, args) : handleCount(ctx, args);
    case "/store":
      return handleStoreCommand(ctx, command, args);
    default:
      return handleTradeCommand(ctx, command, args);
  }
}

// ------------------------------------------------------------------------------------------ /close

function describePreview(ctx: CommandContext, s: DailyCloseSummary): string {
  const lines = [
    `Day ${s.businessDate}`,
    `Cash expected in the drawer: ${money(ctx, s.expectedCashMinor)}`,
    `  (started with ${money(ctx, s.openingCashMinor)})`,
    "",
    `Cash sales: ${money(ctx, s.salesCashMinor)}`,
    `Mobile money sales: ${money(ctx, s.salesMobileMoneyMinor)}`,
  ];
  if (s.salesBankMinor !== 0n) lines.push(`Bank sales: ${money(ctx, s.salesBankMinor)}`);
  if (s.salesUnspecifiedMinor !== 0n) lines.push(`Sales where you did not say how they were paid: ${money(ctx, s.salesUnspecifiedMinor)}`);
  lines.push(`Sold on credit: ${money(ctx, s.creditSalesMinor)}`);
  if (s.collectionsCashMinor + s.collectionsOtherMinor !== 0n) lines.push(`Debts collected: ${money(ctx, s.collectionsCashMinor + s.collectionsOtherMinor)}`);
  if (s.refundsMinor !== 0n) lines.push(`Refunds: ${money(ctx, s.refundsMinor)}`);
  if (s.feesMinor !== 0n) lines.push(`Fees: ${money(ctx, s.feesMinor)}`);
  if (s.expensesMinor !== 0n) lines.push(`Expenses: ${money(ctx, s.expensesMinor)}`);
  if (s.stockPurchasesMinor !== 0n) lines.push(`Stock bought: ${money(ctx, s.stockPurchasesMinor)}`);
  if (s.ownerWithdrawalsMinor !== 0n) lines.push(`Owner withdrawals: ${money(ctx, s.ownerWithdrawalsMinor)}`);
  if (s.wallet.confirmed.count + s.wallet.unmatched.count > 0) {
    lines.push("", `Mobile money alerts: ${s.wallet.confirmed.count} matched (${money(ctx, s.wallet.confirmed.amountMinor)}), ${s.wallet.unmatched.count} not matched yet (${money(ctx, s.wallet.unmatched.amountMinor)})`);
  }
  if (s.unspecifiedReceiptsMinor !== 0n) {
    lines.push("", `Note: ${money(ctx, s.unspecifiedReceiptsMinor)} was logged without saying cash or mobile money. It is NOT counted as cash above.`);
  }
  return lines.join("\n");
}

async function handleClose(ctx: CommandContext, args: string): Promise<string> {
  if (!allowed(ctx, "finance:close_day")) return NOT_ALLOWED;
  if (!(await on(ctx, FLAG_JOURNALS))) return "Closing the day needs accounting turned on for your account, which it isn't yet.";
  const now = new Date();
  let rest = args.trim();
  let businessDate = localDateString(now, ctx.timezone);
  const dateMatch = /^(\d{4}-\d{2}-\d{2})\b\s*(.*)$/.exec(rest);
  if (dateMatch) {
    businessDate = dateMatch[1] as string;
    rest = (dateMatch[2] as string).trim();
  }
  const input = { businessId: ctx.businessId, businessDate, currencyCode: ctx.currencyCode, timeZone: ctx.timezone };
  try {
    if (!rest) {
      const preview = await previewDailyClose(ctx.scopedPrisma, input, now);
      if (preview.existingClose) {
        const c = preview.existingClose;
        return `${businessDate} is already closed: expected ${money(ctx, c.expectedCashMinor)}, counted ${money(ctx, c.countedCashMinor)}, difference ${money(ctx, c.differenceMinor)}.`;
      }
      return [describePreview(ctx, preview), "", `Count the cash in your drawer, then reply: /close <amount>`].join("\n");
    }
    const space = rest.indexOf(" ");
    const amountText = space === -1 ? rest : rest.slice(0, space);
    const reason = space === -1 ? "" : rest.slice(space + 1).trim();
    const counted = parseAmountToMinorUnits(amountText, ctx.minorUnitExp);
    const result = await closeDay(
      ctx.scopedPrisma,
      { ...input, countedCashMinor: counted, closedBy: ctx.merchantId, ...(reason ? { note: reason, differenceReason: reason } : {}) },
      now,
    );
    const d = result.differenceMinor;
    const verdict = d === 0n ? "The count matches your records." : d < 0n ? `You are SHORT by ${money(ctx, -d)}.` : `You have ${money(ctx, d)} MORE than your records.`;
    return [`Day ${businessDate} closed.`, `Expected ${money(ctx, result.summary.expectedCashMinor)}, counted ${money(ctx, counted)}.`, verdict, ...(d !== 0n ? ["The difference was recorded with your reason."] : [])].join("\n");
  } catch (error) {
    if (error instanceof InvalidAmountError) return error.message;
    if (error instanceof DailyCloseError) {
      if (error.code === "REASON_REQUIRED") {
        return `${error.message}\nReply: /close ${rest.split(" ")[0]} <short reason>`;
      }
      return error.message;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------- catalog

async function handleProducts(ctx: CommandContext, args: string): Promise<string> {
  if (!allowed(ctx, "inventory:view")) return NOT_ALLOWED;
  const search = args.trim().toLowerCase();
  const all = await listCatalog(ctx.scopedPrisma);
  const rows = (search ? all.filter((v) => `${v.sku} ${v.productName} ${v.name}`.toLowerCase().includes(search)) : all).slice(0, 20);
  if (rows.length === 0) return search ? `No product matches "${args.trim()}".` : "No products yet. Add one: /addproduct <sku> <unit> <name>";
  const stockOn = await on(ctx, FLAG_STOCK_V2);
  const shop = stockOn ? await ensureDefaultShopFor(ctx.scopedPrisma, ctx.businessId) : null;
  const lines: string[] = [];
  for (const v of rows) {
    const packs = v.packs.length ? ` [${v.packs.map((p) => `1 ${p.name} = ${p.baseQuantity} ${v.baseUnit}`).join(", ")}]` : "";
    let stock = "";
    if (shop) {
      const l = await getStockLevel(ctx.scopedPrisma, shop.id, v.variantId);
      stock = ` - ${l.onHand} on hand${l.reserved ? `, ${l.available} available` : ""}`;
    }
    lines.push(`${v.sku}: ${v.productName}${v.name && v.name !== v.productName ? ` ${v.name}` : ""} (${v.baseUnit})${packs}${stock}`);
  }
  return ["Your products:", ...lines].join("\n");
}

async function handleAddProduct(ctx: CommandContext, args: string): Promise<string> {
  if (!allowed(ctx, "inventory:adjust")) return NOT_ALLOWED;
  const m = /^(\S+)\s+(\S+)\s+(.+)$/.exec(args.trim());
  if (!m) return 'Usage: /addproduct <sku> <unit> <name>\nExample: "/addproduct COLA330 can Coca Cola 330ml"';
  const [, sku, unit, name] = m as unknown as [string, string, string, string];
  try {
    const product = await createProduct(ctx.scopedPrisma, { businessId: ctx.businessId, name });
    const variant = await createVariant(ctx.scopedPrisma, { businessId: ctx.businessId, productId: product.id, sku, name, baseUnit: unit });
    return `Added ${variant.sku}: ${name} (counted in ${variant.baseUnit}).\nIf it comes in packs, say so: /pack ${variant.sku} <pack name> <how many ${variant.baseUnit}>`;
  } catch (error) {
    if (error instanceof CatalogError) return error.message;
    throw error;
  }
}

async function handlePack(ctx: CommandContext, args: string): Promise<string> {
  if (!allowed(ctx, "inventory:adjust")) return NOT_ALLOWED;
  const m = /^(\S+)\s+(.+?)\s+(\d+)$/.exec(args.trim());
  if (!m) return 'Usage: /pack <sku> <pack name> <how many in a pack>\nExample: "/pack COLA330 carton 24"';
  try {
    const variant = await findVariantByText(ctx.scopedPrisma, m[1] as string);
    if (!variant) return `I can't find a product "${m[1]}". See /products.`;
    const pack = await addPackConversion(ctx.scopedPrisma, ctx.businessId, variant.id, m[2] as string, Number(m[3]));
    return `OK: 1 ${pack.name} = ${pack.baseQuantity} ${variant.baseUnit} for ${variant.sku}.`;
  } catch (error) {
    if (error instanceof CatalogError) return error.message;
    throw error;
  }
}

async function handleAdopt(ctx: CommandContext): Promise<string> {
  if (ctx.merchantRole !== "OWNER" && !allowed(ctx, "business:manage")) return "Only the owner can do that.";
  const shop = await ensureDefaultShopFor(ctx.scopedPrisma, ctx.businessId);
  const stockOn = await on(ctx, FLAG_STOCK_V2);
  const r = await adoptLegacyInventory(
    ctx.scopedPrisma,
    { businessId: ctx.businessId, shopId: shop.id, currencyCode: ctx.currencyCode },
    async (variant, item) => (stockOn ? postAdoptionOpening(ctx.scopedPrisma, { businessId: ctx.businessId, shopId: shop.id, variantId: variant.id, item }) : false),
  );
  if (r.adopted === 0) return r.alreadyAdopted > 0 ? "All your stock items are already in your product list." : "You have no stock items to bring over yet.";
  return [
    `Brought ${r.adopted} stock item(s) into your product list.`,
    stockOn ? `Opening stock recorded for ${r.openingMovements}. No costs were guessed.` : "Stock quantities will start once stock v2 is on for your account.",
    r.priceRules > 0 ? `${r.priceRules} price(s) copied to your retail price list.` : "",
    "See them with /products.",
  ].filter(Boolean).join("\n");
}

// ------------------------------------------------------------------------------------- stock v2

async function handleReceive(ctx: CommandContext, args: string): Promise<string> {
  if (!allowed(ctx, "inventory:receive")) return NOT_ALLOWED;
  const usage = 'Usage: /receive <sku> <quantity> [pack name] [cost <price per that unit>]\nExample: "/receive COLA330 5 carton cost 2200"';
  const m = /^(\S+)\s+(\d+)(?:\s+(?!cost\b)(\S+))?(?:\s+cost\s+(\S+))?\s*$/i.exec(args.trim());
  if (!m) return usage;
  try {
    const variant = await findVariantByText(ctx.scopedPrisma, m[1] as string);
    if (!variant) return `I can't find a product "${m[1]}". See /products.`;
    const { baseQuantity, pack } = await toBaseQuantity(ctx.scopedPrisma, variant.id, m[3], Number(m[2]));
    let unitCostMinor: bigint | undefined;
    if (m[4]) {
      const perUnit = parseAmountToMinorUnits(m[4], ctx.minorUnitExp);
      unitCostMinor = pack ? divRoundHalfUp(perUnit, BigInt(pack.baseQuantity)) : perUnit; // cost is stored per BASE unit
    }
    const shop = await ensureDefaultShopFor(ctx.scopedPrisma, ctx.businessId);
    await receiveStock(ctx.scopedPrisma, {
      businessId: ctx.businessId, shopId: shop.id, variantId: variant.id, quantity: baseQuantity, actor: actor(ctx),
      ...(unitCostMinor !== undefined ? { unitCostMinor, currencyCode: ctx.currencyCode } : {}), ...idem(ctx, "receive"),
    });
    const lvl = await getStockLevel(ctx.scopedPrisma, shop.id, variant.id);
    return `Received ${m[2]} ${pack ? pack.name : variant.baseUnit}${pack ? ` (${baseQuantity} ${variant.baseUnit})` : ""} of ${variant.sku}. On hand now: ${lvl.onHand} ${variant.baseUnit}.${unitCostMinor === undefined ? " (No cost given, so no profit is worked out for these.)" : ""}`;
  } catch (error) {
    if (error instanceof CatalogError || error instanceof StockError) return error.message;
    if (error instanceof InvalidAmountError) return error.message;
    throw error;
  }
}

async function handleCount(ctx: CommandContext, args: string): Promise<string> {
  if (!allowed(ctx, "inventory:adjust")) return NOT_ALLOWED;
  const shop = await ensureDefaultShopFor(ctx.scopedPrisma, ctx.businessId);
  const open = await ctx.scopedPrisma.stockCount.findFirst({ where: { shopId: shop.id, status: "OPEN" }, orderBy: { createdAt: "desc" }, include: { lines: true } });
  const text = args.trim();
  try {
    if (/^approve$/i.test(text)) {
      if (!open) return "There is no open stock count. Start one with /count <sku> <how many you counted>.";
      const r = await approveStockCount(ctx.scopedPrisma, open.id, { id: ctx.merchantId }, ctx.currencyCode);
      return r.adjustments === 0 ? "Count approved. Everything matched, nothing to adjust." : `Count approved. ${r.adjustments} stock difference(s) recorded.`;
    }
    if (/^cancel$/i.test(text)) {
      if (!open) return "There is no open stock count.";
      await cancelStockCount(ctx.scopedPrisma, open.id);
      return "Stock count cancelled. Nothing was changed.";
    }
    if (!text) {
      if (!open || open.lines.length === 0) return 'Count your stock one product at a time: /count <sku> <how many>\nExample: "/count COLA330 18"';
      const lines: string[] = [];
      for (const l of open.lines) {
        const v = await ctx.scopedPrisma.productVariant.findUnique({ where: { id: l.variantId } });
        lines.push(`${v?.sku ?? l.variantId}: counted ${l.countedQty}, books said ${l.expectedQty}${l.discrepancy !== 0 ? ` (${l.discrepancy > 0 ? "+" : ""}${l.discrepancy}${l.reason ? `: ${l.reason}` : ", needs a reason"})` : ""}`);
      }
      return ["Open stock count:", ...lines, "", "Finish with /count approve, or /count cancel."].join("\n");
    }
    const m = /^(\S+)\s+(\d+)(?:\s+(.+))?$/.exec(text);
    if (!m) return 'Usage: /count <sku> <how many you counted> [reason if different]\nThen /count approve';
    const variant = await findVariantByText(ctx.scopedPrisma, m[1] as string);
    if (!variant) return `I can't find a product "${m[1]}". See /products.`;
    const count = open ?? (await openStockCount(ctx.scopedPrisma, { businessId: ctx.businessId, shopId: shop.id, openedBy: ctx.merchantId }));
    const line = await recordCountLine(ctx.scopedPrisma, { businessId: ctx.businessId, countId: count.id, variantId: variant.id, countedQty: Number(m[2]) });
    if (m[3] && line.discrepancy !== 0) await setCountLineReason(ctx.scopedPrisma, count.id, variant.id, m[3]);
    if (line.discrepancy === 0) return `${variant.sku}: ${line.countedQty} ${variant.baseUnit}, matches your books.`;
    const why = m[3] ? " Reason saved." : ` Add a reason: /count ${variant.sku} ${line.countedQty} <why>`;
    return `${variant.sku}: you counted ${line.countedQty}, books said ${line.expectedQty} (${line.discrepancy > 0 ? "+" : ""}${line.discrepancy}).${why}`;
  } catch (error) {
    if (error instanceof StockError) return error.message;
    throw error;
  }
}
