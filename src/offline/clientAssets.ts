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
<style>body{font:16px system-ui,sans-serif;margin:0;padding:1rem;max-width:34rem}label{display:block;margin:.25rem 0}label span{display:block;font-size:.85rem;color:#555}.changed{border-color:#8a4b00;background:#fff8ee}.thumb{display:inline-block;margin:.25rem;text-align:center}.thumb img{width:84px;height:84px;object-fit:cover;border:1px solid #bbb}.ok{color:#075}input[type=checkbox]{width:auto;margin:.25rem .5rem .25rem 0}label.chk{display:flex;align-items:center}input,select,button{font:inherit;padding:.5rem;margin:.25rem 0;width:100%;box-sizing:border-box}
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
<div id="catalogBox" hidden><h2>Products</h2>
<p class="muted">Change prices, the shop listing and details for many products at once. Nothing is saved until you have reviewed it.</p>
<div class="row"><button id="cload">Load my products</button><button id="ccsv">Download CSV</button></div>
<p id="cmsg" class="muted" role="status"></p>
<input id="csearch" placeholder="Search products" aria-label="Search products" hidden>
<div id="clist"></div>
<div class="row"><button id="creview" hidden>Review my changes</button></div>
<details><summary>Or change many products with a CSV file</summary>
<p class="muted">Download the CSV, change it in a spreadsheet, then choose it here. Leave a cell empty to keep it as it is; write CLEAR to remove a value.</p>
<input id="cfile" type="file" accept=".csv,text/csv" aria-label="CSV file"><button id="cpreview">Review the CSV</button></details>
<div id="cplan"></div></div>
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
  // Local drafts are always shown, even when the server cannot be reached (a phone can report "online" with no working connection).
  function loadServer() { if (!meta.token || !navigator.onLine) return refresh(); return api("/drafts").then(function (x) { serverRows = (x.body.drafts || []).filter(function (r) { return r.status !== "DISCARDED"; }); return refresh(); }).catch(function (e) { say(e.message === "Failed to fetch" ? "Cannot reach TradePal right now. Your drafts are safe on this phone." : e.message, "err"); return refresh(); }); }
  function show() {
    $("net").textContent = navigator.onLine ? "Online" : "Offline: drafts are kept on this phone until you reconnect.";
    getMeta("session").then(function (s) {
      meta = s || {}; $("login").hidden = !!meta.token; $("app").hidden = !meta.token;
      var f = meta.features || { drafts: true, reports: false, catalog: false };
      $("draftsBox").hidden = !meta.token || !f.drafts; $("reportsBox").hidden = !meta.token || !f.reports; $("catalogBox").hidden = !meta.token || !f.catalog;
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
  // Disconnecting deletes everything on the phone, including drafts that were never sent, so it asks first when any exist.
  $("out").onclick = function () {
    allLocal().then(function (local) {
      if (local.length && !window.confirm(local.length + " draft(s) have not been sent to TradePal and will be DELETED from this phone. Disconnect anyway?")) return;
      return (meta.token ? api("/logout", {}).catch(function () {}) : Promise.resolve()).then(wipe);
    });
  };
  function reportQuery() { var f = $("rfrom").value, t = $("rto").value; return f && t ? "?from=" + f + "&to=" + t : ""; }
  function showReport(r) {
    var out = $("rout"); out.textContent = "";
    line(out, r.meta.title + " (" + r.meta.currencyCode + ", " + r.meta.timezone + ")", "muted");
    line(out, r.meta.basis, "muted");
    var d = r.data, rows = d.rows || d.days || d.attempts || d.buckets || [];
    function label(k) { return k.replace(/Minor$/, "").replace(/([A-Z])/g, " $1").toLowerCase().replace(/^./, function (c) { return c.toUpperCase(); }); }
    if (d.totals) { Object.keys(d.totals).forEach(function (k) { line(out, label(k) + ": " + (/Minor$/.test(k) ? money(Number(d.totals[k])) : d.totals[k])); }); }
    ["netSalesMinor", "costOfGoodsSoldMinor", "grossMarginMinor", "totalMinor"].forEach(function (k) { if (d[k] !== undefined && d[k] !== null) line(out, label(k) + ": " + money(Number(d[k]))); });
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

  // ---- products: bulk edit, CSV and photos (needs a connection; nothing is kept on the phone)
  function csay(t, cls) { var m = $("cmsg"); m.textContent = t; m.className = cls || "muted"; }
  var cat = { rows: [], edits: {}, batchId: null, csv: null, can: {}, cur: "" };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
  function newId() { return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9-]/g, ""); }
  function editCount() { return Object.keys(cat.edits).length; }
  function resetReview() { cat.batchId = null; cat.csv = null; $("cplan").textContent = ""; var n = editCount(); $("creview").hidden = !n; $("creview").textContent = "Review " + n + " change(s)"; }
  function setEdit(row, field, value, original) {
    var e = cat.edits[row.sku] || (cat.edits[row.sku] = {});
    if (JSON.stringify(value) === JSON.stringify(original)) delete e[field]; else e[field] = value;
    if (!Object.keys(e).length) delete cat.edits[row.sku];
    resetReview();
  }
  function lab(text, ctrl) { var l = el("label"); l.appendChild(el("span", "", text)); l.appendChild(ctrl); return l; }
  function textInput(value, onChange, mode) { var i = el("input"); i.value = value; if (mode) i.inputMode = mode; i.oninput = function () { onChange(i.value, i); }; return i; }
  function renderCatalog() {
    var box = $("clist"), q = $("csearch").value.trim().toLowerCase(); box.textContent = "";
    var shown = cat.rows.filter(function (r) { return !q || (r.sku + " " + r.productName + " " + r.variantName).toLowerCase().indexOf(q) !== -1; });
    shown.slice(0, 100).forEach(function (r) {
      var c = el("div", "card" + (cat.edits[r.sku] ? " changed" : ""));
      c.appendChild(el("strong", "", r.productName + (r.variantName && r.variantName !== r.productName ? " - " + r.variantName : "")));
      c.appendChild(el("div", "muted", r.sku + " - sold by the " + r.baseUnit));
      var mark = function () { c.className = "card" + (cat.edits[r.sku] ? " changed" : ""); };
      var price = textInput(r.retailPrice || "", function (v) { setEdit(r, "retailPrice", v.trim() === "" ? null : v.trim(), r.retailPrice); mark(); }, "decimal"); price.disabled = !cat.can.edit;
      c.appendChild(lab("Price (" + cat.cur + ")", price));
      var listed = el("input"); listed.type = "checkbox"; listed.checked = r.listed; listed.disabled = !cat.can.list;
      listed.onchange = function () { setEdit(r, "listed", listed.checked, r.listed); mark(); };
      var ll = el("label", "chk"); ll.appendChild(listed); ll.appendChild(document.createTextNode(" On the shop")); c.appendChild(ll);
      var low = textInput(r.lowStockThreshold === null ? "" : String(r.lowStockThreshold), function (v) { var t = v.trim(); setEdit(r, "lowStockThreshold", t === "" ? null : /^\d{1,7}$/.test(t) ? Number(t) : t, r.lowStockThreshold); mark(); }, "numeric"); low.disabled = !cat.can.edit;
      c.appendChild(lab("Warn me when stock is at or below", low));
      var st = el("select"); ["DRAFT", "PUBLISHED", "ARCHIVED"].forEach(function (s) { var o = el("option", "", s); o.value = s; if (s === r.status) o.selected = true; st.appendChild(o); });
      st.disabled = !cat.can.edit; st.onchange = function () { setEdit(r, "status", st.value, r.status); mark(); }; c.appendChild(lab("Status", st));
      var nm = textInput(r.productName, function (v) { setEdit(r, "productName", v.trim(), r.productName); mark(); }); nm.disabled = !cat.can.edit; c.appendChild(lab("Product name", nm));
      var pb = el("button", "", "Photos (" + r.photos + ")"); var panel = el("div"); pb.onclick = function () { if (panel.firstChild) { panel.textContent = ""; return; } photoPanel(r, panel, pb); }; c.appendChild(pb); c.appendChild(panel);
      box.appendChild(c);
    });
    if (shown.length > 100) line(box, "Showing 100 of " + shown.length + ". Search to narrow it down.", "muted");
    if (!shown.length) line(box, cat.rows.length ? "No product matches." : "No products yet.", "muted");
  }
  function loadCatalog(keep) {
    return api("/catalog").then(function (x) {
      if (!x.ok) { csay(x.body.error || "Could not load your products.", "err"); return; }
      cat.rows = x.body.rows; cat.cur = x.body.currencyCode; cat.can = x.body.can || {}; cat.edits = {}; resetReview(); $("csearch").hidden = false; renderCatalog();
      if (x.body.truncated) csay("Showing the first " + x.body.rows.length + " of " + x.body.total + " products. Use the CSV for the rest.", "muted"); else if (!keep) csay("");
    }).catch(function (e) { csay(e.message, "err"); });
  }
  function showPlan(plan, apply) {
    var box = $("cplan"); box.textContent = ""; var shown = 0;
    plan.rows.forEach(function (r) {
      if (r.action === "NOOP") return; shown++;
      var c = el("div", "card"); line(c, r.sku + (r.action === "ERROR" ? ": PROBLEM, not saved" : r.action === "CREATE" ? ": NEW product" : ": change"), r.action === "ERROR" ? "err" : "");
      r.changes.forEach(function (t) { line(c, t, "muted"); }); r.errors.forEach(function (t) { line(c, t, "err"); }); r.warnings.forEach(function (t) { line(c, t, "warn"); }); box.appendChild(c);
    });
    var k = plan.counts; line(box, k.create + " new, " + k.update + " changed, " + k.noop + " unchanged, " + k.error + " with a problem.", k.error ? "err" : "muted");
    if (!shown) line(box, "Nothing would change.", "muted");
    if (plan.canApply) { var b = el("button", "", "Save " + (k.create + k.update) + " change(s) now"); b.onclick = apply; box.appendChild(b); }
    else if (k.error) line(box, "Fix the problems and review again. Nothing is saved while any row has a problem.", "warn");
  }
  function review(body, applyBody) {
    if (!navigator.onLine) { csay("You need a connection to save product changes.", "err"); return; }
    api("/catalog/preview", body).then(function (x) {
      if (!x.ok && !(x.body && x.body.plan)) { csay(x.body.error || "Could not review the changes.", "err"); return; }
      cat.batchId = cat.batchId || newId(); csay("");
      showPlan(x.body.plan || { rows: [], counts: { create: 0, update: 0, noop: 0, error: 1 }, canApply: false }, function () {
        api("/catalog/apply", Object.assign({ batchId: cat.batchId }, applyBody)).then(function (y) {
          if (!y.ok) { if (y.body.plan) showPlan(y.body.plan, function () {}); csay(y.body.error || "Could not save.", "err"); return; }
          csay((y.body.replayed ? "Already saved. " : "Saved. ") + y.body.created + " new, " + y.body.updated + " changed.", "ok"); cat.edits = {}; return loadCatalog(true).then(function () { $("cplan").textContent = ""; });
        }).catch(function (e) { csay(e.message === "Failed to fetch" ? "Could not reach TradePal. Press Save again: it will not be saved twice." : e.message, "err"); });
      });
    }).catch(function (e) { csay(e.message, "err"); });
  }
  function rowsFromEdits() { return Object.keys(cat.edits).map(function (sku) { var r = cat.rows.filter(function (x) { return x.sku === sku; })[0]; return Object.assign({ sku: sku, rev: r.rev }, cat.edits[sku]); }); }
  $("cload").onclick = loadCatalog; $("csearch").oninput = renderCatalog;
  $("creview").onclick = function () {
    var rows = rowsFromEdits(), bad = rows.filter(function (r) { return typeof r.lowStockThreshold === "string"; })[0];
    if (bad) { csay(bad.sku + ": the warning level must be a whole number, like 5.", "err"); return; }
    review({ rows: rows }, { rows: rows });
  };
  $("cpreview").onclick = function () {
    var f = $("cfile").files[0]; if (!f) { csay("Choose a CSV file first.", "err"); return; }
    if (f.size > 250000) { csay("That file is too big. Use at most 200 products at a time.", "err"); return; }
    var rd = new FileReader(); rd.onload = function () { cat.csv = String(rd.result); cat.batchId = null; review({ csv: cat.csv }, { csv: cat.csv }); }; rd.onerror = function () { csay("Could not read that file.", "err"); }; rd.readAsText(f);
  };
  $("ccsv").onclick = function () {
    if (!navigator.onLine) { csay("You need a connection to download.", "err"); return; }
    fetch("/m/api/catalog.csv", { headers: { Authorization: "Bearer " + meta.token }, cache: "no-store" }).then(function (r) {
      if (r.status === 401) return wipe().then(function () { throw new Error("Please connect this phone again."); });
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || "Could not download."); });
      return r.blob().then(function (b) { var a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = "tradepal-products.csv"; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000); });
    }).catch(function (e) { csay(e.message, "err"); });
  };
  // photos: shrink on the phone first (about 1000 px, JPEG), so an upload is small even on a slow connection
  function shrink(file) {
    return new Promise(function (res, rej) {
      var url = URL.createObjectURL(file), im = new Image();
      im.onload = function () {
        var k = Math.min(1, 1000 / Math.max(im.naturalWidth, im.naturalHeight)), cv = document.createElement("canvas");
        cv.width = Math.max(50, Math.round(im.naturalWidth * k)); cv.height = Math.max(50, Math.round(im.naturalHeight * k));
        cv.getContext("2d").drawImage(im, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url);
        var q = 0.8; (function next() { cv.toBlob(function (b) { if (!b) rej(new Error("Could not prepare the photo.")); else if (b.size > 380 * 1024 && q > 0.4) { q -= 0.15; next(); } else res(b); }, "image/jpeg", q); })();
      };
      im.onerror = function () { URL.revokeObjectURL(url); rej(new Error("This phone cannot read that file as a photo.")); }; im.src = url;
    });
  }
  function photoPanel(r, panel, btn) {
    panel.textContent = "";
    var grid = el("div"); panel.appendChild(grid);
    var add = el("input"); add.type = "file"; add.accept = "image/*"; add.setAttribute("aria-label", "Add a photo of " + r.productName);
    var note = el("div", "muted"); panel.appendChild(lab("Add a photo", add)); panel.appendChild(note);
    function reload() {
      grid.textContent = "";
      return api("/catalog/photos/" + r.productId).then(function (x) {
        if (!x.ok) { note.textContent = x.body.error || "Could not load photos."; return; }
        btn.textContent = "Photos (" + x.body.photos.length + ")";
        x.body.photos.forEach(function (p, i) {
          var t = el("div", "thumb"), im = el("img"); im.alt = r.productName + " photo " + (i + 1); t.appendChild(im);
          fetch("/m/api/catalog/photo/" + p.id, { headers: { Authorization: "Bearer " + meta.token } }).then(function (rr) { return rr.blob(); }).then(function (b) { im.src = URL.createObjectURL(b); }).catch(function () {});
          if (i === 0) t.appendChild(el("div", "muted", "Main photo"));
          else { var m = el("button", "", "Make main"); m.onclick = function () { api("/catalog/photo/" + p.id + "/main", {}).then(reload); }; t.appendChild(m); }
          var d = el("button", "", "Remove"); d.onclick = function () { if (window.confirm("Remove this photo?")) api("/catalog/photo/" + p.id, undefined, "DELETE").then(reload); }; t.appendChild(d);
          grid.appendChild(t);
        });
        if (!x.body.photos.length) note.textContent = "No photos yet. Shoppers see the first photo next to the product.";
      });
    }
    add.onchange = function () {
      var f = add.files[0]; if (!f) return; if (!navigator.onLine) { note.textContent = "You need a connection to add a photo."; return; }
      note.textContent = "Preparing the photo...";
      shrink(f).then(function (blob) {
        note.textContent = "Sending...";
        return fetch("/m/api/catalog/photos/" + r.productId, { method: "POST", headers: { Authorization: "Bearer " + meta.token, "Content-Type": "image/jpeg" }, body: blob, cache: "no-store" });
      }).then(function (resp) { return resp.json().catch(function () { return {}; }).then(function (j) { if (resp.status === 401) return wipe(); note.textContent = resp.ok ? (resp.status === 200 ? "That photo was already there." : "Photo added.") : (j.error || "Could not add the photo."); add.value = ""; return reload(); }); })
        .catch(function (e) { note.textContent = e.message; });
    };
    reload();
  }
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
