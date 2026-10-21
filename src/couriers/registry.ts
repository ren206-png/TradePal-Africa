import { CourierRegistry } from "./adapter.js";
import { SimulatorCourier } from "./simulatorCourier.js";

/** The platform switch for couriers (the per-business flag `storeCourier` is separate). */
export const couriersEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env["COURIERS_ENABLED"] === "true";
/** The pretend courier exists only outside production and only when asked for. */
export const courierSimulatorAllowed = (env: NodeJS.ProcessEnv = process.env): boolean => env["NODE_ENV"] !== "production" && env["COURIER_SIMULATOR_ENABLED"] === "true";

/**
 * Which couriers this process can talk to. In production the registry is EMPTY until a real adapter is added by a reviewed change: no
 * courier has been chosen. The built-in `manual` courier is not in the registry (it needs no integration).
 */
export function buildCourierRegistry(env: NodeJS.ProcessEnv = process.env): CourierRegistry {
  const registry = new CourierRegistry();
  const secret = env["COURIER_SIMULATOR_SECRET"];
  if (secret && courierSimulatorAllowed(env)) registry.register(new SimulatorCourier(secret));
  return registry;
}

let current: CourierRegistry | null = null;
export function getCourierRegistry(): CourierRegistry {
  if (!current) current = buildCourierRegistry();
  return current;
}
export function setCourierRegistry(registry: CourierRegistry | null): void {
  current = registry;
}
