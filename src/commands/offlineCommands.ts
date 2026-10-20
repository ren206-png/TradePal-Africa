import type { CommandContext } from "./commandRouter.js";
import { canMerchant, membershipRoleForLegacyMerchantRole } from "../auth/permissions.js";
import { isFeatureEnabled } from "../domain/featureFlags.js";
import { t } from "../i18n/index.js";
import { CODE_MINUTES, FLAG_OFFLINE_DRAFTS, issueConnectCode, offlineSwitchOn, revokeAllForMerchant } from "../offline/devices.js";

/**
 * `/connect [shared]` and `/disconnect`: link a phone for offline drafts. Behind the per-business `offlineDrafts` flag AND the platform
 * switch OFFLINE_DRAFTS_ENABLED; while either is off they answer exactly as any unknown command.
 */
export const OFFLINE_COMMANDS = new Set(["/connect", "/disconnect"]);

export async function handleOfflineCommand(ctx: CommandContext, command: string, args: string): Promise<string | null> {
  if (!OFFLINE_COMMANDS.has(command)) return null;
  if (!offlineSwitchOn() || !(await isFeatureEnabled(ctx.scopedPrisma, ctx.businessId, FLAG_OFFLINE_DRAFTS))) return null;
  const role = membershipRoleForLegacyMerchantRole(ctx.merchantRole);
  if (!canMerchant(role, "sales:create") && !canMerchant(role, "expenses:create")) return "You do not have permission to record sales or expenses.";
  if (command === "/disconnect") {
    await revokeAllForMerchant(ctx.prisma, ctx.merchantId);
    return t("device.revoked").text;
  }
  const shared = args.trim().toLowerCase() === "shared";
  const { code } = await issueConnectCode(ctx.prisma, { businessId: ctx.businessId, merchantId: ctx.merchantId, shared });
  const base = process.env["OFFLINE_PUBLIC_URL"] ?? "";
  return [
    t("device.code", { code, minutes: CODE_MINUTES }).text,
    base ? `Open ${base.replace(/\/$/, "")}/m/ on that phone and type the code.` : "Open the TradePal drafts page (/m/) on that phone and type the code.",
    shared ? "This is a shared phone: the session lasts 8 hours and drafts are deleted from the phone as soon as they are sent. Send /disconnect when you are done." : "Send /disconnect at any time to sign every connected phone out.",
  ].join("\n");
}
