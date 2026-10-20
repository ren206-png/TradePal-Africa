import type { PaymentSubjectType, PrismaClient } from "@prisma/client";
import { AdapterRegistry } from "../../src/payments/adapter.js";
import { SimulatorAdapter } from "../../src/payments/simulatorAdapter.js";
import { setAdapterRegistry } from "../../src/payments/registry.js";
import { processInbox } from "../../src/domain/callbackInbox.js";
import { buildTradeCallbackHandlers } from "../../src/domain/trade/handlers.js";
import { createPaymentIntent, ensureSimulatorConnection, startPaymentAttempt } from "../../src/domain/merchantPayments/intents.js";
import { receiveProviderCallback } from "../../src/domain/merchantPayments/outcomes.js";

export const SIM_SECRET = "simulator-secret-for-tests-only";

/** A registry with the simulator in it, installed process-wide, and the environment switch the simulator needs. */
export function simulatorWorld(prisma: PrismaClient) {
  process.env["STOREFRONT_SIMULATOR_ENABLED"] = "true";
  const sim = new SimulatorAdapter(prisma, SIM_SECRET);
  const registry = new AdapterRegistry().register(sim);
  setAdapterRegistry(registry);
  return { sim, registry };
}

export async function startPayment(
  prisma: PrismaClient, registry: AdapterRegistry,
  input: { businessId: string; subjectType: PaymentSubjectType; subjectId: string; amountMinor?: bigint; now?: Date },
) {
  await ensureSimulatorConnection(prisma, input.businessId);
  const intent = await createPaymentIntent(prisma, input);
  const started = await startPaymentAttempt(prisma, registry, { businessId: input.businessId, intentId: intent.id, provider: "simulator", ...(input.now ? { now: input.now } : {}) });
  return { intent, attempt: started.attempt, reused: started.reused };
}

/** Delivers a provider's signed callback to our edge. */
export const deliverCallback = (prisma: PrismaClient, registry: AdapterRegistry, cb: { body: string; headers: Record<string, string> }) =>
  receiveProviderCallback(prisma, registry, "simulator", cb.body, cb.headers);

/** Runs the inbox until it is empty (as the sweep would). */
export async function drainInbox(prisma: PrismaClient, rounds = 4): Promise<void> {
  const handlers = buildTradeCallbackHandlers(prisma);
  for (let i = 0; i < rounds; i++) {
    const r = await processInbox(prisma, handlers, { limit: 100 });
    if (r.claimed === 0) return;
  }
}
