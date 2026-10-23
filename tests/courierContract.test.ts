import { SimulatorCourier } from "../src/couriers/simulatorCourier.js";
import { describeCourierContract } from "./helpers/courierContract.js";

const SECRET = "courier-simulator-secret-for-tests";

describeCourierContract("simulator courier", () => {
  const adapter = new SimulatorCourier(SECRET);
  return {
    adapter,
    signedCallback: (id, status, eventId) => adapter.advance(id, status, { eventId }),
    forgedCallback: (id) => adapter.advance(id, "DELIVERED", { eventId: "evt-forged", secret: "not-the-secret" }),
    staleCallback: (id) => adapter.advance(id, "DELIVERED", { eventId: "evt-stale", timestamp: Math.floor(Date.now() / 1000) - 3600 }),
    tamper: (s) => ({ body: Buffer.from(s.body.toString().replace("PICKED_UP", "DELIVERED")), headers: s.headers }),
  };
});
