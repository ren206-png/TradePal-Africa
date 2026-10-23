import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";

/**
 * An in-memory stand-in for the pawaPay v2 HTTP API, injected through `PawaPayDeps.fetchImpl`. It follows the documented shapes
 * (deposits, refunds, active configuration, availability, public keys) so the billing code is exercised end to end. It is OUR reading of
 * pawaPay's documentation, not a recording of the real service: nothing here proves compatibility with the sandbox.
 */
interface Deposit { depositId: string; amount: string; currency: string; provider: string; phone: string; status: string; providerTransactionId: string; refunds: string[] }
interface Refund { refundId: string; depositId: string; amount: string; currency: string; status: string }

export class PawaPayFake {
  deposits = new Map<string, Deposit>();
  refunds = new Map<string, Refund>();
  outage = false;
  companyName = "TradePal Test Ltd";
  availability: "OPERATIONAL" | "DELAYED" | "CLOSED" = "OPERATIONAL";
  decimals: "NONE" | "TWO_PLACES" = "TWO_PLACES";
  calls: string[] = [];
  /** `drop`: the call is not recorded and the caller sees a network error. `lose`: it IS recorded but the caller sees a network error. */
  nextInitiate: "ok" | "drop" | "lose" | "reject" = "ok";
  nextRefund: "ok" | "reject" | "lose" = "ok";
  refundFinal: "COMPLETED" | "FAILED" | "PROCESSING" = "COMPLETED";
  keyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  keyId = "HTTP_EC_P256_KEY:1";
  publicKeys = true;

  readonly fetchImpl = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^\/v2/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    this.calls.push(`${method} ${path}`);
    if (this.outage) throw new TypeError("fetch failed");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

    if (method === "POST" && path === "/predict-provider") {
      const digits = String(body.phoneNumber).replace(/\D/g, "");
      if (!/^232\d{8}$/.test(digits)) return json(422, {});
      return json(200, { country: "SLE", provider: "ORANGE_SLE", phoneNumber: digits });
    }
    if (method === "GET" && path === "/active-conf") {
      return json(200, {
        companyName: this.companyName, signatureConfiguration: { signedRequestsOnly: false, signedCallbacks: true },
        countries: [{
          country: "SLE", prefix: "232", displayName: { en: "Sierra Leone" },
          providers: [{ provider: "ORANGE_SLE", displayName: "Orange Money", nameDisplayedToCustomer: "Orange", logo: "", currencies: [{ currency: "SLE", displayName: "Leone", operationTypes: { DEPOSIT: { status: "OPERATIONAL", decimalsInAmount: this.decimals, minAmount: "1", maxAmount: "100000", authType: "PROVIDER_AUTH" } } }] }],
        }],
      });
    }
    if (method === "GET" && path === "/availability") return json(200, [{ country: "SLE", providers: [{ provider: "ORANGE_SLE", operationTypes: [{ operationType: "DEPOSIT", status: this.availability }, { operationType: "REFUND", status: "OPERATIONAL" }] }] }]);
    if (method === "GET" && path === "/public-key/http") return this.publicKeys ? json(200, [{ id: this.keyId, key: this.keyPair.publicKey.export({ type: "spki", format: "pem" }).toString() }]) : json(500, {});
    if (method === "POST" && path === "/deposits") {
      if (this.nextInitiate === "drop") { this.nextInitiate = "ok"; throw new TypeError("fetch failed"); }
      if (this.nextInitiate === "reject") { this.nextInitiate = "ok"; return json(200, { depositId: body.depositId, status: "REJECTED", created: new Date().toISOString(), failureReason: { failureCode: "PAYER_NOT_FOUND", failureMessage: "x" } }); }
      if (this.deposits.has(body.depositId)) return json(200, { depositId: body.depositId, status: "DUPLICATE_IGNORED", created: new Date().toISOString() });
      this.deposits.set(body.depositId, { depositId: body.depositId, amount: body.amount, currency: body.currency, provider: body.payer.accountDetails.provider, phone: body.payer.accountDetails.phoneNumber, status: "ACCEPTED", providerTransactionId: `ptx-${this.deposits.size + 1}`, refunds: [] });
      if (this.nextInitiate === "lose") { this.nextInitiate = "ok"; throw new TypeError("fetch failed"); }
      return json(200, { depositId: body.depositId, status: "ACCEPTED", created: new Date().toISOString() });
    }
    const dep = /^\/deposits\/([^/]+)$/.exec(path);
    if (method === "GET" && dep) {
      const d = this.deposits.get(dep[1]!);
      return d ? json(200, { depositId: d.depositId, status: d.status, amount: d.amount, currency: d.currency, providerTransactionId: d.providerTransactionId }) : json(404, {});
    }
    if (method === "POST" && path === "/refunds") {
      if (this.nextRefund === "reject") { this.nextRefund = "ok"; return json(200, { refundId: body.refundId, status: "REJECTED", created: "", rejectionReason: { rejectionCode: "AMOUNT_TOO_LARGE", rejectionMessage: "too large" } }); }
      const d = this.deposits.get(body.depositId);
      if (!d || d.status !== "COMPLETED") return json(200, { refundId: body.refundId, status: "REJECTED", created: "", rejectionReason: { rejectionCode: "DEPOSIT_NOT_FOUND", rejectionMessage: "no" } });
      this.refunds.set(body.refundId, { refundId: body.refundId, depositId: body.depositId, amount: body.amount ?? d.amount, currency: body.currency ?? d.currency, status: this.refundFinal });
      if (this.nextRefund === "lose") { this.nextRefund = "ok"; throw new TypeError("fetch failed"); }
      return json(200, { refundId: body.refundId, status: "ACCEPTED", created: new Date().toISOString() });
    }
    const ref = /^\/refunds\/([^/]+)$/.exec(path);
    if (method === "GET" && ref) {
      const r = this.refunds.get(ref[1]!);
      return r ? json(200, { status: "FOUND", data: { refundId: r.refundId, status: r.status, amount: r.amount, currency: r.currency, ...(r.status === "FAILED" ? { failureReason: { failureCode: "RECIPIENT_NOT_FOUND", failureMessage: "x" } } : {}) } }) : json(200, { status: "NOT_FOUND" });
    }
    return json(404, {});
  }) as typeof fetch;

  // ---- test controls
  complete(depositId: string, over: { amount?: string; currency?: string } = {}) {
    const d = this.deposits.get(depositId)!;
    d.status = "COMPLETED";
    if (over.amount) d.amount = over.amount;
    if (over.currency) d.currency = over.currency;
  }
  fail(depositId: string) {
    this.deposits.get(depositId)!.status = "FAILED";
  }
  /** A signed callback exactly as RFC 9421 describes, produced by this fake's private key. */
  signedCallback(payload: Record<string, unknown>, opts: { authority: string; path: string; created?: number; expires?: number; keyId?: string } ) {
    const body = Buffer.from(JSON.stringify(payload));
    const created = opts.created ?? Math.floor(Date.now() / 1000) - 2;
    const expires = opts.expires ?? created + 60;
    const digest = `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
    const components = ["@method", "@authority", "@path", "signature-date", "content-digest", "content-type"];
    const headers: Record<string, string> = { "content-type": "application/json", "signature-date": new Date(created * 1000).toUTCString(), "content-digest": digest };
    const params = `(${components.map((c) => `"${c}"`).join(" ")});alg="ecdsa-p256-sha256";keyid="${opts.keyId ?? this.keyId}";created=${created};expires=${expires}`;
    const value = (c: string) => (c === "@method" ? "POST" : c === "@authority" ? opts.authority : c === "@path" ? opts.path : headers[c]!);
    const base = [...components.map((c) => `"${c}": ${value(c)}`), `"@signature-params": ${params}`].join("\n");
    const sig = cryptoSign("sha256", Buffer.from(base), { key: this.keyPair.privateKey, dsaEncoding: "ieee-p1363" });
    headers["signature-input"] = `sig-pp=${params}`;
    headers["signature"] = `sig-pp=:${sig.toString("base64")}:`;
    return { body, headers };
  }
}
