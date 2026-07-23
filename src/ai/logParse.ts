import { Prisma, type FinalAction, type PrismaClient } from "@prisma/client";
import type { AiParseResult } from "./parse.js";

export interface RecordAiParseLogInput {
  businessId?: string;
  whatsappMessageId?: string;
  rawInput: string;
  result: AiParseResult;
  finalAction: FinalAction;
  resultingTransactionId?: string;
}

/**
 * Every parse is logged, success or failure (schema comment on
 * `AiParseLog`) — takes a plain, unscoped `PrismaClient` rather than a
 * TenantScopedClient because a parse can happen before onboarding
 * completes, when there is no business to scope to yet.
 */
export async function recordAiParseLog(prisma: PrismaClient, input: RecordAiParseLogInput) {
  return prisma.aiParseLog.create({
    data: {
      businessId: input.businessId ?? null,
      whatsappMessageId: input.whatsappMessageId ?? null,
      rawInput: input.rawInput,
      rawModelOutput: input.result.rawModelOutput as Prisma.InputJsonValue,
      intent: input.result.parsed?.intent ?? "UNKNOWN",
      confidenceScore: input.result.parsed?.confidence ?? 0,
      confidenceTier: input.result.confidenceTier,
      validationPassed: input.result.validationPassed,
      validationErrors: (input.result.validationErrors as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
      finalAction: input.finalAction,
      resultingTransactionId: input.resultingTransactionId ?? null,
    },
  });
}
