import type { PrismaClient } from "@prisma/client";
import { AdapterRegistry } from "./adapter.js";
import { SimulatorAdapter } from "./simulatorAdapter.js";
import { simulatedPaymentsAllowed } from "../domain/store/common.js";

/**
 * Which providers this process can talk to. In production the registry is EMPTY until a real adapter is added by a reviewed change
 * (no provider is established; see docs/expansion/merchant-provider-matrix.md). The simulator joins only when it is allowed
 * (NODE_ENV is not production AND STOREFRONT_SIMULATOR_ENABLED=true) and a secret is configured.
 */
export function buildAdapterRegistry(prisma: PrismaClient, env: NodeJS.ProcessEnv = process.env): AdapterRegistry {
  const registry = new AdapterRegistry();
  const secret = env["PAYMENT_SIMULATOR_SECRET"];
  if (secret && simulatedPaymentsAllowed(env)) registry.register(new SimulatorAdapter(prisma, secret));
  return registry;
}

let current: AdapterRegistry | null = null;

/** The process-wide registry (set by the server at start, or by a test). Built lazily from the environment if nothing set one. */
export function getAdapterRegistry(prisma: PrismaClient): AdapterRegistry {
  if (!current) current = buildAdapterRegistry(prisma);
  return current;
}

export function setAdapterRegistry(registry: AdapterRegistry | null): void {
  current = registry;
}
