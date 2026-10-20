/**
 * The offline page, its script and its service worker (expansion Phase 7), served as plain strings so they ship with the server and
 * need no build step. Rules the code below keeps (and `tests/offlineDrafts.test.ts` checks in the served text):
 *  - the service worker caches ONLY the two shell files; it never sees, stores or answers a /m/api/ request, so no financial body and no
 *    token can end up in a cache;
 *  - every value from the server or the person is written with textContent, never innerHTML;
 *  - a local draft is always labelled as NOT recorded; only the server confirming it makes it an entry;
 *  - logging out (or a 401) deletes the local database, the caches and the worker;
 *  - on a shared phone, local copies are deleted as soon as a sync succeeds.
 */
export const OFFLINE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TradePal drafts</title>
<style>body{font:16px system-ui,sans-serif;margin:0;padding:1rem;max-width:34rem}input,select,button{font:inherit;padding:.5rem;margin:.25rem 0;width:100%;box-sizing:border-box}
button{cursor:pointer}.card{border:1px solid #bbb;border-radius:.5rem;padding:.75rem;margin:.5rem 0}.muted{color:#555}.warn{color:#8a4b00}.err{color:#a00}.row{display:flex;gap:.5rem}.row>*{flex:1}</style>
</head><body>
<h1>Drafts</h1>
<p id="net" class="muted"></p>
<div id="login" hidden><p>On WhatsApp send <strong>/connect</strong> to TradePal, then type the 8-digit code here.</p>
<input id="code" inputmode="numeric" maxlength="8" autocomplete="one-time-code" aria-label="Connect code"><button id="go">Connect this phone</button></div>
<div id="app" hidden>
<div id="reportsBox" hidden><h2>Reports</h2>
<p class="muted">Bookkeeping reports. They are not tax filings and not profit statements; read the notes under each one.</p>
<select id="rname" aria-label="Report"><option value="sales">Sales</option><option value="cash-flow">Cash flow</option><option value="inventory-valuation">Stock value</option><option value="ar-aging">Money owed to you</option><option value="ap-aging">Money you owe</option><option value="gross-margin">Gross margin</option><option value="payment-reconciliation">Payments</option><option value="stock-discrepancies">Stock differences</option></select>
<div class="row"><input id="rfrom" type="date" aria-label="From"><input id="rto" type="date" aria-label="To"></div>
<div class="row"><button id="rview">View</button><button id="rcsv">Download CSV</button></div>
<div id="rout"></div></div>
<div id="draftsBox" hidden>
<p class="warn"><strong>A draft is not a recorded sale or expense.</strong> It only becomes one after you sync it and confirm it while online.</p>
<div class="card"><select id="kind" aria-label="Type"><option value="SALE">Sale</option><option value="EXPENSE">Expense</option></select>
<input id="amount" inputmode="decimal" placeholder="Amount" aria-label="Amount">
<select id="pay" aria-label="Payment"><option value="PAID">Paid</option><option value="CREDIT">On credit</option></select>
<input id="who" placeholder="Customer name (needed for credit)" aria-label="Customer">
<input id="what" placeholder="Note (optional)" aria-label="Note">
<button id="add">Save as draft on this phone</button></div>
<div class="row"><button id="sync">Send drafts to TradePal</button></div></div>
<div class="row"><button id="out">Disconnect this phone</button></div>
<p id="msg" class="muted" role="status"></p><div id="list"></div></div>
<script src="/m/app.js"></script></body></html>`;

export const OFFLINE_SCRIPT = String.raw`(function () {
  "use strict";
  var DB = "tradepal-drafts", db = null, meta = {}, serverRows = [];
  var $ = function (id) { return document.getElementById(id); };
  function say(t, cls) { var m = $("msg"); m.textContent = t; m.className = cls || "muted"; }
  function open() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("drafts", { keyPath: "clientId" }); r.result.createObjectStore("meta"); };
      r.onsuccess = function () { db = r.result; res(); }; r.onerror = function () { rej(r.error); };
    });
  }
  function tx(store, mode) { return db.transaction(store, mode).objectStore(store); }
  function p(req) { return new Promise(function (res, rej) { req.onsuccess = function () { res(req.result); }; req.onerror = function () { rej(req.error); }; }); }
  function getMeta(k) { return p(tx("meta", "readonly").get(k)); }
  function setMeta(k, v) { return p(tx("meta", "readwrite").put(v, k)); }
  function allLocal() { return p(tx("drafts", "readonly").getAll()); }
  function putLocal(d) { return p(tx("drafts", "readwrite").put(d)); }
  function delLocal(id) { return p(tx("drafts", "readwrite").delete(id)); }
  function api(path, body, method) {
    var h = { "Content-Type": "application/json" };
    if (meta.token) h["Authorization"] = "Bearer " + meta.token;
    return fetch("/m/api" + path, { method: method || (body ? "POST" : "GET"), headers: h, body: body ? JSON.stringify(body) : undefined, cache: "no-store" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (r.status === 401) { return wipe().then(function () { throw new Error("Please connect this phone again."); }); } return { ok: r.ok, status: r.status, body: j }; }); });
  }
  function wipe() {
    meta = {}; serverRows = [];
    return new Promise(function (res) { if (db) db.close(); var d = indexedDB.deleteDatabase(DB); d.onsuccess = d.onerror = d.onblocked = function () { res(); }; })
      .then(function () { return window.caches ? caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); }) : null; })
      .then(function () { return navigator.serviceWorker ? navigator.serviceWorker.getRegistrations().then(function (rs) { return Promise.all(rs.map(function (r) { return r.unregister(); })); }) : null; })
      .then(function () { return open(); }).then(show);
  }
  function minor(text) {
    var m = /^(\d{1,12})(?:[.,](\d{1,6}))?$/.exec(String(text).trim()); if (!m) return null;
    var exp = meta.exp || 2, frac = (m[2] || ""); if (frac.length > exp) return null;
    while (frac.length < exp) frac += "0"; return Number(m[1] + frac);
  }
  function money(n) { var exp = meta.exp || 2, s = String(n); while (s.length <= exp) s = "0" + s; return exp ? s.slice(0, -exp) + "." + s.slice(-exp) : s; }
  function line(parent, text, cls) { var e = document.createElement("div"); e.textContent = text; if (cls) e.className = cls; parent.appendChild(e); }
  function render(local) {
    var box = $("list"); box.textContent = "";
    local.forEach(function (d) {
      var c = document.createElement("div"); c.className = "card";
      line(c, "DRAFT, not recorded yet: " + d.kind.toLowerCase() + " of " + money(d.amountMinor) + " " + (meta.cur || ""), "warn");
      if (d.customerName) line(c, d.customerName, "muted"); if (d.description) line(c, d.description, "muted");
      var b = document.createElement("button"); b.textContent = "Remove from this phone";
      b.onclick = function () { delLocal(d.clientId).then(refresh); }; c.appendChild(b); box.appendChild(c);
    });
    serverRows.forEach(function (r) {
      var c = document.createElement("div"); c.className = "card"; var pl = r.payload || {};
      line(c, r.status === "CONFIRMED" ? "Recorded: " + String(pl.kind || "").toLowerCase() + " of " + money(pl.amountMinor || 0) : "On TradePal, waiting for you: " + String(pl.kind || "").toLowerCase() + " of " + money(pl.amountMinor || 0), r.status === "CONFIRMED" ? "muted" : "warn");
      (r.conflicts || []).forEach(function (k) { line(c, "Changed: " + k.detail, "err"); });
      if (r.status === "PENDING_REVIEW" || r.status === "CONFLICT") {
        var ok = document.createElement("button"); ok.textContent = r.status === "CONFLICT" ? "Accept the changes and record it" : "Confirm and record it";
        ok.onclick = function () { if (!navigator.onLine) { say("Connect to the internet to confirm.", "err"); return; } api("/drafts/" + r.id + "/confirm", { acceptConflicts: r.status === "CONFLICT" }).then(function (x) { say(x.ok ? "Recorded." : (x.body.error || "Could not record."), x.ok ? "muted" : "err"); return loadServer(); }).catch(function (e) { say(e.message, "err"); }); };
        var no = document.createElement("button"); no.textContent = "Discard"; no.onclick = function () { api("/drafts/" + r.id + "/discard", {}).then(loadServer); };
        c.appendChild(ok); c.appendChild(no);
      }
      box.appendChild(c);
    });
  }
  function refresh() { return allLocal().then(render); }
  function loadServer() { if (!meta.token || !navigator.onLine) return refresh(); return api("/drafts").then(function (x) { serverRows = (x.body.drafts || []).filter(function (r) { return r.status !== "DISCARDED"; }); return refresh(); }).catch(function (e) { say(e.message, "err"); }); }
  function show() {
    $("net").textContent = navigator.onLine ? "Online" : "Offline: drafts are kept on this phone until you reconnect.";
    getMeta("session").then(function (s) {
      meta = s || {}; $("login").hidden = !!meta.token; $("app").hidden = !meta.token;
      var f = meta.features || { drafts: true, reports: false };
      $("draftsBox").hidden = !meta.token || !f.drafts; $("reportsBox").hidden = !meta.token || !f.reports;
      if (meta.token && f.drafts) loadServer();
    });
  }
  $("go").onclick = function () {
    api("/session", { code: $("code").value.trim() }).then(function (x) {
      if (!x.ok) { say(x.body.error || "That code did not work.", "err"); return; }
      meta = { token: x.body.token, shared: !!x.body.shared, exp: x.body.minorUnitExp, cur: x.body.currencyCode, features: x.body.features };
      return setMeta("session", meta).then(show);
    }).catch(function (e) { say(e.message, "err"); });
  };
  $("add").onclick = function () {
    var a = minor($("amount").value); if (a === null || a <= 0) { say("Enter an amount like 1500 or 1500.50.", "err"); return; }
    var kind = $("kind").value, pay = kind === "SALE" ? $("pay").value : undefined, who = $("who").value.trim();
    if (pay === "CREDIT" && !who) { say("A sale on credit needs a customer name.", "err"); return; }
    var d = { clientId: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)), kind: kind, amountMinor: a, capturedAt: new Date().toISOString() };
    if (pay) d.paymentStatus = pay; if (who) d.customerName = who; if ($("what").value.trim()) d.description = $("what").value.trim();
    putLocal(d).then(function () { $("amount").value = ""; $("who").value = ""; $("what").value = ""; say("Saved as a draft on this phone. It is not recorded yet."); return refresh(); });
  };
  $("sync").onclick = function () {
    if (!navigator.onLine) { say("You are offline. Try again when you have a connection.", "err"); return; }
    allLocal().then(function (local) {
      if (!local.length) { say("Nothing to send."); return loadServer(); }
      return api("/drafts/sync", { drafts: local }).then(function (x) {
        if (!x.ok) { say(x.body.error || "Could not send.", "err"); return; }
        var done = (x.body.results || []).filter(function (r) { return r.status !== "REJECTED"; }).map(function (r) { return r.clientId; });
        var rejected = (x.body.results || []).filter(function (r) { return r.status === "REJECTED"; }).length;
        // kept on the phone only until the server has them; a shared phone never keeps a copy
        return Promise.all(done.map(delLocal)).then(function () { say("Sent " + done.length + " draft(s) to TradePal. Review them below." + (rejected ? " " + rejected + " could not be accepted and stay on this phone." : "")); return loadServer(); });
      });
    }).catch(function (e) { say(e.message, "err"); });
  };
  $("out").onclick = function () { (meta.token ? api("/logout", {}).catch(function () {}) : Promise.resolve()).then(wipe); };
  function reportQuery() { var f = $("rfrom").value, t = $("rto").value; return f && t ? "?from=" + f + "&to=" + t : ""; }
  function showReport(r) {
    var out = $("rout"); out.textContent = "";
    line(out, r.meta.title + " (" + r.meta.currencyCode + ", " + r.meta.timezone + ")", "muted");
    line(out, r.meta.basis, "muted");
    var d = r.data, rows = d.rows || d.days || d.attempts || d.buckets || [];
    if (d.totals) { Object.keys(d.totals).forEach(function (k) { line(out, k + ": " + (/Minor$/.test(k) ? money(Number(d.totals[k])) : d.totals[k])); }); }
    ["netSalesMinor", "costOfGoodsSoldMinor", "grossMarginMinor", "totalMinor"].forEach(function (k) { if (d[k] !== undefined && d[k] !== null) line(out, k.replace(/Minor$/, "") + ": " + money(Number(d[k]))); });
    line(out, rows.length + " row(s). Download the CSV for the full table.", "muted");
    r.meta.warnings.forEach(function (w) { line(out, "Note: " + w.message, "warn"); });
    line(out, r.meta.notice, "muted");
  }
  $("rview").onclick = function () {
    if (!navigator.onLine) { say("Reports need a connection.", "err"); return; }
    api("/reports/" + $("rname").value + reportQuery()).then(function (x) { if (!x.ok) { say(x.body.error || "Could not make the report.", "err"); return; } say(""); showReport(x.body); }).catch(function (e) { say(e.message, "err"); });
  };
  $("rcsv").onclick = function () {
    if (!navigator.onLine) { say("Reports need a connection.", "err"); return; }
    var h = { Authorization: "Bearer " + meta.token };
    fetch("/m/api/reports/" + $("rname").value + ".csv" + reportQuery(), { headers: h, cache: "no-store" }).then(function (r) {
      if (r.status === 401) return wipe().then(function () { throw new Error("Please connect this phone again."); });
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "Could not download."); });
      return r.blob().then(function (b) { var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "tradepal-" + $("rname").value + ".csv"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000); });
    }).catch(function (e) { say(e.message, "err"); });
  };
  window.addEventListener("online", show); window.addEventListener("offline", show);
  open().then(show);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/m/sw.js", { scope: "/m/" }).catch(function () {});
})();
`;

export const OFFLINE_SERVICE_WORKER = String.raw`"use strict";
// Caches only the page shell. It never touches /m/api/ (no tokens, no financial bodies, ever).
var CACHE = "tradepal-shell-v1";
var SHELL = ["/m/", "/m/app.js"];
self.addEventListener("install", function (e) { e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener("activate", function (e) { e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); })); });
self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || SHELL.indexOf(url.pathname) === -1) return;
  e.respondWith(fetch(e.request).then(function (r) { return r; }).catch(function () { return caches.match(e.request); }));
});
`;
