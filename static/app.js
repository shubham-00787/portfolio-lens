/* Portfolio Lens — client. Matching + holdings come from the backend; all exposure maths runs here
   so rebalancing (changing amounts / sliders) re-renders instantly with no network calls. */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);

  // ── state ──────────────────────────────────────────────
  let nextId = 1;
  const state = { rows: [], stocks: [], indexCache: new Map(), indices: [], sizeBuckets: null, benchKey: null, baseline: null, colorSlots: new Map(), sort: { k: "value", asc: false }, expanded: new Set(), lastCalc: null };
  const charts = {};

  let nextStockId = 1;
  function newStock(query = "", value = "", extra = {}) {
    return { id: nextStockId++, query, value, searchId: null, title: null, sector: null, isin: null, matchedQuery: null,
             alternatives: [], confidence: null, ...extra };
  }
  const DIRECT_ID = "__direct";

  function newRow(query = "", amount = "", extra = {}) {
    return { id: nextId++, query, amount, searchId: null, matchedQuery: null,
             alternatives: [], confidence: null, plan: "direct", scheme: null, loading: false, error: null, ...extra };
  }

  // ── formatting ─────────────────────────────────────────
  const nfIN = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
  function inr(v, compact = true) {
    if (!isFinite(v)) return "—";
    const a = Math.abs(v);
    if (compact && a >= 1e7) return "₹" + (v / 1e7).toFixed(2) + " Cr";
    if (compact && a >= 1e5) return "₹" + (v / 1e5).toFixed(2) + " L";
    return "₹" + nfIN.format(v);
  }
  const pct = (v, d = 2) => (isFinite(v) ? v.toFixed(d) + "%" : "—");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const labelW = (w) => (window.innerWidth < 600 ? Math.round(w * 0.6) : w); // category-axis label width
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  // Colour slots are assigned per scheme (largest amount first) when you hit Analyse, then frozen,
  // so rebalancing / filtering never repaints a fund. Funds beyond 8 share the neutral "Other" colour.
  const slotOf = (row) => state.colorSlots.get(row.scheme?.search_id ?? row.searchId) ?? 99;
  const fundColor = (row) => (slotOf(row) < 8 ? css(`--s${slotOf(row) + 1}`) : css("--other"));
  function assignColors() {
    const amt = new Map();
    for (const r of state.rows.filter((x) => x.scheme)) amt.set(r.scheme.search_id, (amt.get(r.scheme.search_id) || 0) + (+r.amount || 0));
    const direct = directTotal();
    if (direct > 0) amt.set(DIRECT_ID, direct);
    state.colorSlots = new Map([...amt.entries()].sort((a, b) => b[1] - a[1]).map(([id], i) => [id, i]));
  }
  const shortName = (n) => (n || "").replace(/\s+(Direct|Regular)\b.*$/i, "").replace(/\s+Fund$/i, "").replace(/ Fund\b/i, "");

  // ── privacy ────────────────────────────────────────────
  // Your funds, amounts and stocks live only in this page's memory. Nothing is written to browser
  // storage, and closing or refreshing the tab clears them. Only the theme and chosen index are remembered.
  // wipe portfolio data saved by older versions, and carry over UI preferences from the old app name
  try {
    localStorage.removeItem("mf-lens:v1");
    for (const k of ["theme", "bench"]) {
      const old = localStorage.getItem("mf-lens:" + k);
      if (old && !localStorage.getItem("portfolio-lens:" + k)) localStorage.setItem("portfolio-lens:" + k, old);
      localStorage.removeItem("mf-lens:" + k);
    }
  } catch (_) {}
  const hasInput = () => state.rows.some((r) => r.query.trim()) || state.stocks.some((s) => s.query.trim());
  window.addEventListener("beforeunload", (e) => { if (hasInput()) { e.preventDefault(); e.returnValue = ""; } });

  // ── parsing pasted lists ───────────────────────────────
  function parseLine(line) {
    const s = line.trim();
    if (!s) return null;
    const m = s.match(/^(.*?)(\s*[,\-–:=|\t]\s*|\s+)(?:rs\.?|₹|inr)?\s*([\d,]+(?:\.\d+)?)\s*(k|l|lac|lacs|lakh|lakhs|cr|crore)?\s*$/i);
    if (m) {
      const sep = m[2].trim();
      let n = parseFloat(m[3].replace(/,/g, ""));
      const unit = (m[4] || "").toLowerCase();
      if (unit === "k") n *= 1e3; else if (unit.startsWith("l")) n *= 1e5; else if (unit.startsWith("cr")) n *= 1e7;
      // "uti nifty 50" — a bare small number with no separator/unit is part of the name.
      if (sep || unit || n >= 1000) return { query: m[1].trim(), amount: String(Math.round(n)) };
    }
    return { query: s, amount: "" };
  }

  // ── API ────────────────────────────────────────────────
  async function api(path, opts) {
    const r = await fetch(path, opts);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  }
  function setStatus(msg, err = false) { const el = $("#status"); el.textContent = msg; el.classList.toggle("err", err); }

  async function analyse() {
    const btns = [$("#analyzeBtn"), $("#analyzeBtn2")];
    state.rows = state.rows.filter((r) => r.query.trim());
    state.stocks = state.stocks.filter((r) => r.query.trim());
    if (!state.rows.length && !state.stocks.length) { setStatus("Add at least one fund or stock.", true); state.rows = [newRow()]; renderRows(); return; }
    btns.forEach((b) => (b.disabled = true));
    try {
      const toMatch = state.rows.filter((r) => !r.searchId || r.matchedQuery !== r.query.trim());
      if (toMatch.length) {
        setStatus(`Matching ${toMatch.length} fund name${toMatch.length > 1 ? "s" : ""}…`);
        const res = await api("/api/match", { method: "POST", headers: { "Content-Type": "application/json" },
                                              body: JSON.stringify({ names: toMatch.map((r) => r.query) }) });
        toMatch.forEach((row, i) => applyMatch(row, res[i]));
        renderRows();
      }
      await Promise.all([fetchSchemes(), matchStocks()]);
      if (!state.rows.length) state.rows = [newRow()];
      const bad = state.rows.filter((r) => r.query.trim() && !r.scheme).length;
      const badS = state.stocks.filter((s) => s.query.trim() && !s.searchId).length;
      const msg = [bad ? `${bad} fund${bad > 1 ? "s" : ""}` : "", badS ? `${badS} stock${badS > 1 ? "s" : ""}` : ""].filter(Boolean).join(" and ");
      setStatus(msg ? `${msg} not included yet: no confident match. Pick the right one from the dropdown.` : "", !!msg);
      assignColors(); renderRows(); renderStocks();
      recompute();
    } catch (e) {
      setStatus("Something went wrong: " + e.message, true);
    } finally { btns.forEach((b) => (b.disabled = false)); }
  }

  function applyMatch(row, m) {
    row.matchedQuery = row.query.trim();
    row.alternatives = m?.alternatives || [];
    row.confidence = m?.confidence || "none";
    row.plan = m?.plan || "direct";
    const id = m?.best?.search_id || null;
    if (id !== row.searchId) row.scheme = null;
    row.searchId = id;
  }

  async function fetchSchemes() {
    const need = state.rows.filter((r) => r.searchId && (!r.scheme || r.scheme._for !== r.searchId));
    if (!need.length) return;
    setStatus(`Fetching holdings for ${need.length} fund${need.length > 1 ? "s" : ""}…`);
    need.forEach((r) => (r.loading = true));
    renderRows();
    await Promise.all(need.map(async (r) => {
      try {
        const s = await api(`/api/scheme/${encodeURIComponent(r.searchId)}?plan=${r.plan}`);
        s._for = r.searchId; r.scheme = s; r.error = null;
      } catch (e) { r.scheme = null; r.error = e.message; }
      r.loading = false;
    }));
    renderRows();
  }

  // ── input rows UI ──────────────────────────────────────
  function sliderMax() {
    const amts = state.rows.map((r) => +r.amount || 0);
    const m = Math.max(...amts, 0);
    return Math.max(100000, Math.ceil((m * 2) / 10000) * 10000);
  }

  function renderRows() {
    const box = $("#fundRows");
    const equal = $("#equalWeight").checked;
    const total = state.rows.reduce((a, r) => a + (+r.amount || 0), 0);
    const max = sliderMax();
    box.innerHTML = state.rows.map((r) => {
      const share = equal || !total ? (r.scheme ? 100 / Math.max(1, state.rows.filter((x) => x.scheme).length) : 0) : ((+r.amount || 0) / total) * 100;
      const opts = r.alternatives.length
        ? (r.searchId ? "" : `<option value="" selected disabled>No confident match. Pick one</option>`) + r.alternatives.map((a) => `<option value="${esc(a.search_id)}" ${a.search_id === r.searchId ? "selected" : ""}>${esc(a.title)}${a.score ? ` (${Math.round(a.score)})` : ""}</option>`).join("")
        : `<option value="">${r.query ? "Not matched yet" : "—"}</option>`;
      const meta = r.loading ? `<span class="muted">Loading holdings…</span>`
        : r.error ? `<span class="down">${esc(r.error)}</span>`
        : r.scheme ? `<span class="dot" style="background:${fundColor(r)}"></span><span>${esc(r.scheme.sub_category || r.scheme.category || "")}</span>
                      <span>· ${r.scheme.holdings.length} holdings</span>${r.confidence ? `<span class="conf ${r.confidence}">${r.confidence} match</span>` : ""}`
        : r.confidence ? `<span class="conf ${r.confidence}">${r.confidence} match</span>` : "";
      return `<div class="fund-row" data-id="${r.id}">
        <input type="text" class="q" value="${esc(r.query)}" placeholder="e.g. ppfas flexi cap" aria-label="Fund name" />
        <div class="match-cell"><select class="alt" aria-label="Matched fund" ${r.alternatives.length ? "" : "disabled"}>${opts}</select><div class="match-meta">${meta}</div></div>
        <input type="number" class="amt" min="0" step="any" inputmode="decimal" value="${esc(r.amount)}" placeholder="optional" aria-label="Amount invested" ${equal ? "disabled" : ""} />
        <div class="alloc"><input type="range" class="sl" min="0" max="${max}" step="1000" value="${+r.amount || 0}" ${equal ? "disabled" : ""} aria-label="Rebalance amount" /><span>${pct(share, 1)}</span></div>
        <button class="rm" title="Remove">✕</button>
      </div>`;
    }).join("");
  }

  function rowFromEl(el) { const id = +el.closest(".fund-row").dataset.id; return state.rows.find((r) => r.id === id); }
  let rafPending = false;
  function liveRecompute() {
    if (rafPending) return; rafPending = true;
    requestAnimationFrame(() => { rafPending = false; refreshAllocLabels(); if (!$("#results").classList.contains("hidden")) recompute(); });
  }
  function refreshAllocLabels() {
    const equal = $("#equalWeight").checked;
    const total = state.rows.reduce((a, r) => a + (+r.amount || 0), 0);
    const nLoaded = Math.max(1, state.rows.filter((x) => x.scheme).length);
    document.querySelectorAll("#fundRows .fund-row").forEach((el) => {
      const r = rowFromEl(el); if (!r) return;
      const share = equal || !total ? (r.scheme ? 100 / nLoaded : 0) : ((+r.amount || 0) / total) * 100;
      $(".alloc span", el).textContent = pct(share, 1);
    });
  }

  $("#fundRows").addEventListener("input", (e) => {
    const r = rowFromEl(e.target); if (!r) return;
    if (e.target.classList.contains("q")) { r.query = e.target.value; }
    else if (e.target.classList.contains("amt")) {
      r.amount = e.target.value;
      const sl = $(".sl", e.target.closest(".fund-row"));
      if (+r.amount > +sl.max) sl.max = sliderMax();
      sl.value = +r.amount || 0;
      liveRecompute();
    } else if (e.target.classList.contains("sl")) {
      r.amount = String(e.target.value);
      $(".amt", e.target.closest(".fund-row")).value = r.amount;
      liveRecompute();
    }
  });
  $("#fundRows").addEventListener("change", async (e) => {
    const r = rowFromEl(e.target); if (!r) return;
    if (e.target.classList.contains("alt")) {
      r.searchId = e.target.value; r.scheme = null; r.confidence = "high"; // user-confirmed
      await fetchSchemes(); assignColors(); renderRows(); recompute();
    } else if (e.target.classList.contains("sl")) { renderRows(); } // re-scale slider max after drag
  });
  $("#fundRows").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input")) analyse(); });
  $("#fundRows").addEventListener("click", (e) => {
    if (!e.target.classList.contains("rm")) return;
    const r = rowFromEl(e.target);
    state.rows = state.rows.filter((x) => x !== r);
    if (!state.rows.length) state.rows.push(newRow());
    renderRows();
    if (!$("#results").classList.contains("hidden")) recompute();
  });

  $("#addRowBtn").onclick = () => { state.rows.push(newRow()); renderRows(); $("#fundRows .fund-row:last-child .q").focus(); };
  $("#analyzeBtn").onclick = analyse;
  $("#equalWeight").onchange = () => { renderRows(); liveRecompute(); };
  $("#pasteBtn").onclick = () => { $("#pasteBox").classList.remove("hidden"); $("#pasteArea").focus(); };
  $("#pasteCancel").onclick = () => $("#pasteBox").classList.add("hidden");
  $("#pasteApply").onclick = () => {
    const parsed = $("#pasteArea").value.split(/\n+/).map(parseLine).filter(Boolean);
    state.rows = state.rows.filter((r) => r.query.trim()).concat(parsed.map((p) => newRow(p.query, p.amount)));
    $("#pasteArea").value = ""; $("#pasteBox").classList.add("hidden");
    renderRows(); analyse();
  };
  function resetBaseline() {
    state.baseline = null;
    $("#baselineBtn").textContent = "Set as baseline";
    $("#baselineTag").classList.add("hidden");
  }
  $("#clearBtn").onclick = () => {
    state.rows = [newRow()]; state.expanded.clear(); resetBaseline(); setStatus("");
    renderRows(); assignColors(); recompute();
  };
  $("#sampleBtn").onclick = () => {
    state.rows = [["ppfas flexi cap", 300000], ["hdfc midcap opportunities", 150000], ["quant small cap", 100000],
                  ["icici bluechip", 200000], ["mirae emerging bluechip", 150000], ["uti nifty 50 index", 100000]]
      .map(([q, a]) => newRow(q, String(a)));
    renderRows(); analyse();
  };

  // ── direct stocks ──────────────────────────────────────
  const directTotal = () => state.stocks.filter((s) => s.searchId).reduce((a, s) => a + (+s.value || 0), 0);

  async function matchStocks() {
    const todo = state.stocks.filter((s) => s.query.trim() && (!s.searchId || s.matchedQuery !== s.query.trim()));
    if (!todo.length) return;
    setStatus(`Matching ${todo.length} stock${todo.length > 1 ? "s" : ""}…`);
    const res = await api("/api/stocks/match", { method: "POST", headers: { "Content-Type": "application/json" },
                                                 body: JSON.stringify({ items: todo.map((s) => s.query) }) });
    todo.forEach((s, i) => applyStockMatch(s, res[i]));
    renderStocks();
  }
  function applyStockMatch(s, m) {
    s.matchedQuery = s.query.trim();
    s.alternatives = m?.alternatives || [];
    s.confidence = m?.confidence || "none";
    const b = m?.best;
    s.searchId = b?.search_id || null; s.title = b?.title || null; s.sector = b?.sector || "Other"; s.isin = b?.isin || null;
  }

  function renderStocks() {
    const box = $("#stockRows");
    box.innerHTML = state.stocks.map((s) => {
      const opts = s.alternatives.length
        ? (s.searchId ? "" : `<option value="" selected disabled>No confident match. Pick one</option>`) + s.alternatives.map((a) => `<option value="${esc(a.search_id)}" ${a.search_id === s.searchId ? "selected" : ""}>${esc(a.title)}${a.symbol ? ` · ${esc(a.symbol)}` : ""}</option>`).join("")
        : `<option value="">${s.query ? "Not matched yet" : "—"}</option>`;
      return `<div class="fund-row stk" data-sid="${s.id}">
        <input type="text" class="q" value="${esc(s.query)}" placeholder="e.g. tata power or an ISIN" aria-label="Stock name" />
        <div class="match-cell"><select class="alt" aria-label="Matched stock" ${s.alternatives.length ? "" : "disabled"}>${opts}</select>
          <div class="match-meta">${s.isin ? `<span>${esc(s.isin)}</span>` : ""}${s.confidence ? `<span class="conf ${s.confidence}">${s.confidence} match</span>` : ""}</div></div>
        <span class="sector-cell">${esc(s.sector || "")}</span>
        <input type="number" class="amt" min="0" step="any" inputmode="decimal" value="${esc(s.value)}" placeholder="value" aria-label="Current value" />
        <button class="rm" title="Remove">✕</button>
      </div>`;
    }).join("");
    const t = directTotal();
    $("#stockTotal").textContent = t ? `Direct stocks total: ${inr(t)}` : "";
  }
  const stockFromEl = (el) => state.stocks.find((s) => s.id === +el.closest(".fund-row").dataset.sid);
  $("#stockRows").addEventListener("input", (e) => {
    const s = stockFromEl(e.target); if (!s) return;
    if (e.target.classList.contains("q")) { s.query = e.target.value; }
    else if (e.target.classList.contains("amt")) {
      s.value = e.target.value;
      $("#stockTotal").textContent = directTotal() ? `Direct stocks total: ${inr(directTotal())}` : "";
      liveRecompute();
    }
  });
  $("#stockRows").addEventListener("change", async (e) => {
    const s = stockFromEl(e.target); if (!s || !e.target.classList.contains("alt")) return;
    const alt = s.alternatives.find((a) => a.search_id === e.target.value);
    if (!alt) return;
    // re-resolve the chosen alternative to get its sector
    try {
      const [m] = await api("/api/stocks/match", { method: "POST", headers: { "Content-Type": "application/json" },
                                                   body: JSON.stringify({ items: [alt.isin || alt.title] }) });
      const alts = s.alternatives;
      applyStockMatch(s, m); s.alternatives = alts; s.confidence = "high";
    } catch (err) {
      s.searchId = alt.search_id; s.title = alt.title; s.isin = alt.isin; s.sector = "Other"; s.confidence = "high";
      setStatus("Couldn't fetch that stock's sector, so it's shown as Other: " + err.message, true);
    }
    renderStocks(); assignColors(); recompute();
  });
  $("#stockRows").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.matches("input")) analyse(); });
  $("#stockRows").addEventListener("click", (e) => {
    if (!e.target.classList.contains("rm")) return;
    const s = stockFromEl(e.target);
    state.stocks = state.stocks.filter((x) => x !== s);
    renderStocks();
    if (!$("#results").classList.contains("hidden")) recompute();
  });
  $("#addStockBtn").onclick = () => { state.stocks.push(newStock()); renderStocks(); $("#stockRows .fund-row:last-child .q").focus(); };
  $("#stockPasteBtn").onclick = () => { $("#stockPasteBox").classList.remove("hidden"); $("#stockPasteArea").focus(); };
  $("#stockPasteCancel").onclick = () => $("#stockPasteBox").classList.add("hidden");
  $("#stockPasteApply").onclick = () => {
    const parsed = $("#stockPasteArea").value.split(/\n+/).map(parseLine).filter(Boolean);
    state.stocks = state.stocks.filter((s) => s.query.trim()).concat(parsed.map((p) => newStock(p.query, p.amount)));
    $("#stockPasteArea").value = ""; $("#stockPasteBox").classList.add("hidden");
    renderStocks(); analyse();
  };
  $("#stockClearBtn").onclick = () => { state.stocks = []; renderStocks(); assignColors(); recompute(); };
  $("#analyzeBtn2").onclick = analyse;

  // ── exposure maths ─────────────────────────────────────
  function calc() {
    const equal = $("#equalWeight").checked;
    // The same scheme can appear in several rows (one per folio on a CAS) — merge them into one fund.
    const merged = new Map();
    for (const r of state.rows.filter((x) => x.scheme)) {
      const m = merged.get(r.searchId);
      if (m) { m.amount += +r.amount || 0; m.folios++; }
      else merged.set(r.searchId, { id: r.id, scheme: r.scheme, amount: +r.amount || 0, folios: 1 });
    }
    const funds = [...merged.values()];
    const amountsGiven = funds.some((r) => r.amount > 0);
    const useEqual = (equal || !amountsGiven) && funds.length > 0;
    // Directly-held shares behave like one more "fund" whose holdings are your stocks. Only meaningful with ₹ amounts.
    const directRows = state.stocks.filter((s) => s.searchId && +s.value > 0);
    const directAmt = directRows.reduce((a, s) => a + +s.value, 0);
    if (directAmt > 0 && !useEqual) {
      const fundSector = new Map();
      for (const f of funds) for (const h of f.scheme.holdings) if (h.asset_class === "Equity") fundSector.set(h.key, h.sector);
      const byKey = new Map();
      for (const s of directRows) {
        const h = byKey.get(s.searchId) || { key: s.searchId, name: s.title, sector: fundSector.get(s.searchId) || s.sector || "Other", asset_class: "Equity", weight: 0 };
        h.weight += (+s.value / directAmt) * 100; byKey.set(s.searchId, h);
      }
      funds.push({ id: DIRECT_ID, direct: true, amount: directAmt, folios: directRows.length,
                   scheme: { search_id: DIRECT_ID, name: "Direct stocks", holdings: [...byKey.values()] } });
    }
    const weightOf = (r) => (useEqual ? 1 : r.amount);
    const total = funds.reduce((a, r) => a + weightOf(r), 0);
    const stocks = new Map();

    const add = (key, name, sector, asset, v, row) => {
      let s = stocks.get(key);
      if (!s) stocks.set(key, (s = { key, name, sector, asset, value: 0, contrib: new Map() }));
      s.value += v;
      s.contrib.set(row.id, (s.contrib.get(row.id) || 0) + v);
    };
    for (const r of funds) {
      const w = weightOf(r);
      if (!w) continue;
      let sumW = 0;
      for (const h of r.scheme.holdings) {
        sumW += h.weight;
        add(h.key, h.name, h.sector, h.asset_class, (w * h.weight) / 100, r);
      }
      const rest = 100 - sumW;
      if (rest > 0.5) add("__unreported", "Unreported / net current assets", "Unreported", "Other", (w * rest) / 100, r);
    }
    const list = [...stocks.values()].map((s) => ({ ...s, pct: total ? (s.value / total) * 100 : 0, nfunds: s.contrib.size - (s.contrib.has(DIRECT_ID) ? 1 : 0), direct: s.contrib.has(DIRECT_ID) }));
    for (const s of list) s.heldBy = [s.nfunds ? `${s.nfunds} fund${s.nfunds > 1 ? "s" : ""}` : "", s.direct ? "direct" : ""].filter(Boolean).join(" + ");
    return { funds, total, useEqual, money: !useEqual, list, directAmt: useEqual ? 0 : directAmt, directIgnored: useEqual && directAmt > 0 };
  }

  function recompute() {
    const c = calc();
    state.lastCalc = c;
    $("#results").classList.toggle("hidden", !c.funds.length);
    document.querySelectorAll(".needs-results").forEach((el) => el.classList.toggle("hidden", !c.funds.length));
    $("#hero").classList.toggle("hidden", !!c.funds.length);
    if (!c.funds.length) return;
    // baseline deltas (in % of portfolio, so they stay meaningful as the total changes)
    for (const s of c.list) s.delta = state.baseline ? s.pct - (state.baseline.get(s.key) || 0) : null;

    const asset = $("#assetFilter").value;
    const scoped = c.list.filter((s) => asset === "all" || s.asset === asset);
    const sectors = groupBy(scoped, (s) => s.sector);
    syncSectorFilter(sectors);
    const sector = $("#sectorFilter").value;
    const view = scoped.filter((s) => !sector || s.sector === sector);

    renderKpis(c);
    renderSectorChart(sectors, sector);
    renderTreemap(view);
    renderStockChart(view, c);
    renderOverlap(c);
    renderAssets(c);
    renderTable(view, c);
    renderFootnote(c);
    renderBenchmark(c);
  }

  function groupBy(list, fn) {
    const m = new Map();
    for (const s of list) {
      const k = fn(s); const g = m.get(k) || { name: k, value: 0, pct: 0, n: 0, delta: 0 };
      g.value += s.value; g.pct += s.pct; g.n++; g.delta += s.delta || 0; m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.pct - a.pct);
  }

  function syncSectorFilter(sectors) {
    const sel = $("#sectorFilter"); const cur = sel.value;
    sel.innerHTML = `<option value="">All sectors</option>` + sectors.map((s) => `<option ${s.name === cur ? "selected" : ""}>${esc(s.name)}</option>`).join("");
    if (cur && !sectors.some((s) => s.name === cur)) sel.value = "";
  }

  // ── KPIs ───────────────────────────────────────────────
  function kpiData(c) {
    const eq = c.list.filter((s) => s.asset === "Equity").sort((a, b) => b.pct - a.pct);
    const eqPct = eq.reduce((a, s) => a + s.pct, 0);
    const top10 = eq.slice(0, 10).reduce((a, s) => a + s.pct, 0);
    const topSector = groupBy(eq, (s) => s.sector)[0];
    const k = [
      [c.money ? "Total portfolio" : "Weighting", c.money ? inr(c.total) : "Equal", (() => {
        const mf = c.funds.filter((r) => !r.direct), nRows = state.rows.filter((r) => r.scheme).length;
        let t = mf.length ? `${mf.length} fund${mf.length !== 1 ? "s" : ""}` + (nRows > mf.length ? ` (${nRows} entries merged)` : "") : "";
        if (c.directAmt) t += mf.length ? ` + ${inr(c.directAmt)} direct stocks` : "Direct stocks only";
        if (c.directIgnored) t += " · direct stocks need ₹ amounts";
        return t; })()],
      ["Unique stocks", nfIN.format(eq.length), `${pct(eqPct, 1)} of portfolio in equity`],
      ["Top 10 stocks", pct(top10, 1), "of your whole portfolio"],
      ["Largest stock", eq[0] ? pct(eq[0].pct, 2) : "—", eq[0] ? esc(eq[0].name) + (c.money ? ` · ${inr(eq[0].value)}` : "") : ""],
      ["Largest sector", topSector ? pct(topSector.pct, 1) : "—", topSector ? esc(topSector.name) : ""],
    ];
    return k;
  }
  function renderKpis(c) {
    const k = kpiData(c);
    $("#kpis").innerHTML = k.map(([l, v, f]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="foot">${f}</div></div>`).join("");
  }

  // ── charts ─────────────────────────────────────────────
  function chart(id) {
    if (!charts[id]) { charts[id] = echarts.init(document.getElementById(id), null, { renderer: "canvas" }); }
    return charts[id];
  }
  function baseOpts() {
    return {
      textStyle: { fontFamily: "Inter, system-ui, sans-serif", color: css("--text-secondary"), fontSize: 12 },
      tooltip: { backgroundColor: css("--surface-1"), borderColor: css("--border"), textStyle: { color: css("--text-primary"), fontSize: 12 },
                 extraCssText: "box-shadow:0 4px 16px rgba(0,0,0,.12);border-radius:8px;" },
      animation: !state.exporting, animationDuration: 300, animationDurationUpdate: 250,
    };
  }
  const valLabel = (c, s) => (c.money ? `${inr(s.value)} · ${pct(s.pct)}` : pct(s.pct));
  const deltaTxt = (d) => (d == null ? "" : `<br/>Δ vs baseline: <b class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "+" : ""}${d.toFixed(2)} pp</b>`);

  function renderSectorChart(sectors, active) {
    const c = state.lastCalc;
    const data = sectors.slice().reverse();
    const ch = chart("sectorChart");
    ch.setOption({
      ...baseOpts(),
      grid: { left: 8, right: 70, top: 6, bottom: 6, containLabel: true },
      xAxis: { type: "value", axisLabel: { formatter: "{value}%", color: css("--text-muted"), hideOverlap: true }, splitLine: { lineStyle: { color: css("--grid") } } },
      yAxis: { type: "category", data: data.map((s) => s.name), axisTick: { show: false }, axisLine: { show: false },
               axisLabel: { color: css("--text-secondary"), width: labelW(150), overflow: "truncate" } },
      tooltip: { ...baseOpts().tooltip, trigger: "item",
                 formatter: (p) => { const s = data[p.dataIndex]; return `<b>${esc(s.name)}</b><br/>${valLabel(c, s)}<br/>${s.n} holdings${state.baseline ? deltaTxt(s.delta) : ""}`; } },
      series: [{ type: "bar", barMaxWidth: 18,
        data: data.map((s) => ({ value: +s.pct.toFixed(3),
          itemStyle: { color: css("--s1"), opacity: active && active !== s.name ? 0.3 : 1, borderRadius: [0, 4, 4, 0] } })),
        label: { show: true, position: "right", formatter: (p) => p.value.toFixed(1) + "%", color: css("--text-secondary"), fontSize: 11 } }],
    }, true);
    ch.off("click");
    ch.on("click", (p) => { const name = data[p.dataIndex].name; $("#sectorFilter").value = $("#sectorFilter").value === name ? "" : name; recompute(); });
  }

  function renderTreemap(view) {
    const c = state.lastCalc;
    const bySector = new Map();
    for (const s of view) {
      if (!bySector.has(s.sector)) bySector.set(s.sector, []);
      bySector.get(s.sector).push({ name: s.name, value: +s.pct.toFixed(4), _s: s });
    }
    const data = [...bySector.entries()].map(([name, children]) => ({ name, children }));
    chart("treemap").setOption({
      ...baseOpts(),
      tooltip: { ...baseOpts().tooltip, formatter: (p) => {
        const s = p.data._s;
        if (!s) return `<b>${esc(p.name)}</b><br/>${pct(p.value)}${c.money ? ` · ${inr((p.value / 100) * c.total)}` : ""}`;
        return `<b>${esc(s.name)}</b><br/>${esc(s.sector)}<br/>${valLabel(c, s)}<br/>via ${s.heldBy}${state.baseline ? deltaTxt(s.delta) : ""}`;
      } },
      series: [{
        type: "treemap", roam: false, nodeClick: "zoomToNode", width: "100%", height: "88%", top: 0,
        breadcrumb: { show: true, bottom: 0, itemStyle: { color: css("--surface-2"), borderColor: css("--border"), textStyle: { color: css("--text-secondary") } } },
        data,
        levels: [
          { itemStyle: { borderColor: css("--surface-1"), borderWidth: 3, gapWidth: 3 } },
          { colorMappingBy: "value", color: ["#b7d3f6", "#86b6ef", "#5598e7", "#2a78d6"],
            itemStyle: { borderColor: css("--surface-1"), borderWidth: 1, gapWidth: 1 },
            upperLabel: { show: true, height: 20, color: css("--text-primary"), backgroundColor: css("--surface-2"), fontWeight: 600, fontSize: 11 } },
        ],
        // Hide labels on tiles too small to read (they'd truncate to a single letter); hover still works.
        label: { show: true, color: "#0b0b0b", fontSize: 11, overflow: "truncate",
                 formatter: (p) => (p.value < 0.6 ? "" : `${p.name}\n${p.value.toFixed(2)}%`) },
        upperLabel: { show: true, height: 20 },
      }],
    }, true);
  }

  function renderStockChart(view, c) {
    const n = +$("#topN").value;
    const top = view.filter((s) => s.key !== "__unreported").sort((a, b) => b.pct - a.pct).slice(0, n);
    const rows = top.slice().reverse();
    const ordered = c.funds.slice().sort((a, b) => slotOf(a) - slotOf(b));
    const coloured = ordered.filter((r) => slotOf(r) < 8);
    const rest = ordered.filter((r) => slotOf(r) >= 8);
    const unit = c.total ? 100 / c.total : 0;
    const series = coloured.map((r) => ({
      name: shortName(r.scheme.name), type: "bar", stack: "x", barMaxWidth: 16,
      itemStyle: { color: fundColor(r), borderColor: css("--surface-1"), borderWidth: 1 },
      emphasis: { focus: "series" },
      data: rows.map((s) => +(((s.contrib.get(r.id) || 0) * unit)).toFixed(4)),
    }));
    if (rest.length) series.push({ name: `Other ${rest.length} funds`, type: "bar", stack: "x", itemStyle: { color: css("--other"), borderColor: css("--surface-1"), borderWidth: 1 },
      data: rows.map((s) => +rest.reduce((a, r) => a + (s.contrib.get(r.id) || 0) * unit, 0).toFixed(4)) });
    // total label on the end of each stack
    series.push({ type: "bar", stack: "x", silent: true, data: rows.map(() => 0), itemStyle: { color: "transparent" },
      label: { show: true, position: "right", color: css("--text-secondary"), fontSize: 11, formatter: (p) => pct(rows[p.dataIndex].pct) }, tooltip: { show: false } });

    // Height follows the bar count so labels never collide (Top 15 / 25 / 40).
    const el = document.getElementById("stockChart");
    const h = Math.max(260, rows.length * 24 + 60) + "px";
    if (el.style.height !== h) { el.style.height = h; chart("stockChart").resize(); }
    $("#topNote").textContent = top.length ? `Top ${top.length} = ${pct(top.reduce((a, s) => a + s.pct, 0), 1)} of portfolio` : "";
    chart("stockChart").setOption({
      ...baseOpts(),
      legend: { top: 0, type: "scroll", textStyle: { color: css("--text-secondary") }, icon: "roundRect", itemWidth: 12, itemHeight: 8,
                data: series.filter((s) => s.name).map((s) => s.name) },
      grid: { left: 8, right: 64, top: 34, bottom: 6, containLabel: true },
      xAxis: { type: "value", axisLabel: { formatter: "{value}%", color: css("--text-muted"), hideOverlap: true }, splitLine: { lineStyle: { color: css("--grid") } } },
      yAxis: { type: "category", data: rows.map((s) => s.name), axisTick: { show: false }, axisLine: { show: false },
               axisLabel: { color: css("--text-secondary"), width: labelW(190), overflow: "truncate" } },
      tooltip: { ...baseOpts().tooltip, trigger: "axis", axisPointer: { type: "shadow" }, formatter: (ps) => {
        const s = rows[ps[0].dataIndex];
        const parts = ps.filter((p) => p.seriesName && p.value > 0).sort((a, b) => b.value - a.value)
          .map((p) => `${p.marker}${esc(p.seriesName)}: ${pct(p.value)}${c.money ? ` · ${inr((p.value / 100) * c.total)}` : ""}`);
        return `<b>${esc(s.name)}</b> <span style="color:${css("--text-muted")}">${esc(s.sector)}</span><br/>Total: <b>${valLabel(c, s)}</b>${state.baseline ? deltaTxt(s.delta) : ""}<br/>${parts.join("<br/>")}`;
      } },
      series,
    }, true);
  }

  function renderOverlap(c) {
    const f = c.funds.filter((r) => !r.direct).sort((a, b) => slotOf(a) - slotOf(b));
    const maps = f.map((r) => { const m = new Map(); for (const h of r.scheme.holdings) if (h.asset_class === "Equity") m.set(h.key, (m.get(h.key) || 0) + h.weight); return m; });
    if (f.length < 2) {
      chart("overlapChart").setOption({ ...baseOpts(), title: { text: "Add two or more funds to see how much they overlap",
        left: "center", top: "middle", textStyle: { color: css("--text-muted"), fontSize: 13, fontWeight: 400 } } }, true);
      return;
    }
    const names = f.map((r) => shortName(r.scheme.name));
    const data = []; const common = [];
    for (let i = 0; i < f.length; i++) for (let j = 0; j < f.length; j++) {
      let ov = 0, n = 0;
      if (i === j) { ov = 100; n = maps[i].size; }
      else for (const [k, w] of maps[i]) { const w2 = maps[j].get(k); if (w2 != null) { ov += Math.min(w, w2); n++; } }
      data.push([j, i, +ov.toFixed(1)]); common.push(n);
    }
    chart("overlapChart").setOption({
      ...baseOpts(),
      grid: { left: 8, right: 8, top: 8, bottom: 8, containLabel: true },
      xAxis: { type: "category", data: names, axisLabel: { rotate: 30, color: css("--text-secondary"), width: labelW(110), overflow: "truncate", fontSize: 11 }, axisTick: { show: false }, splitArea: { show: false } },
      yAxis: { type: "category", data: names, inverse: true, axisLabel: { color: css("--text-secondary"), width: labelW(130), overflow: "truncate", fontSize: 11 }, axisTick: { show: false } },
      visualMap: { show: false, min: 0, max: 60, inRange: { color: ["#cde2fb", "#86b6ef", "#3987e5", "#1c5cab", "#0d366b"] } },
      tooltip: { ...baseOpts().tooltip, formatter: (p) => {
        const [x, y, v] = p.data.value || p.data; if (x === y) return `<b>${esc(names[x])}</b><br/>${common[p.dataIndex]} equity holdings`;
        return `<b>${esc(names[y])}</b> ↔ <b>${esc(names[x])}</b><br/>Overlap: <b>${v}%</b><br/>${common[p.dataIndex]} stocks in common`;
      } },
      series: [{ type: "heatmap", data: data.map((d) => (d[0] === d[1] ? { value: d, itemStyle: { color: css("--surface-2") }, label: { show: false } }
                                                         : { value: d, label: { show: f.length <= 12, color: d[2] >= 30 ? "#ffffff" : "#0b0b0b" } })),
        itemStyle: { borderColor: css("--surface-1"), borderWidth: 2, borderRadius: 4 },
        label: { show: f.length <= 12, fontSize: f.length > 8 ? 10 : 11,
                 formatter: (p) => (Array.isArray(p.data) ? p.data : p.data.value)[2] + "%",
               } }],
    }, true);
  }

  function renderAssets(c) {
    const a = groupBy(c.list, (s) => s.asset).filter((s) => s.pct >= 0.05).reverse();
    chart("assetChart").setOption({
      ...baseOpts(),
      grid: { left: 8, right: 70, top: 6, bottom: 6, containLabel: true },
      xAxis: { type: "value", max: 100, axisLabel: { formatter: "{value}%", color: css("--text-muted"), hideOverlap: true }, splitLine: { lineStyle: { color: css("--grid") } } },
      yAxis: { type: "category", data: a.map((s) => s.name), axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: css("--text-secondary") } },
      tooltip: { ...baseOpts().tooltip, formatter: (p) => { const s = a[p.dataIndex]; return `<b>${esc(s.name)}</b><br/>${valLabel(c, s)}<br/>${s.n} holdings`; } },
      series: [{ type: "bar", barMaxWidth: 18, data: a.map((s) => +s.pct.toFixed(3)), itemStyle: { color: css("--s1"), borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: "right", formatter: (p) => p.value.toFixed(1) + "%", color: css("--text-secondary"), fontSize: 11 } }],
    }, true);
  }

  // ── index comparison ───────────────────────────────────
  async function initBenchmarks() {
    try {
      state.indices = await api("/api/indices");
      let saved = null; try { saved = localStorage.getItem("portfolio-lens:bench"); } catch (_) {}
      state.benchKey = state.indices.some((i) => i.key === saved) ? saved : "nifty500";
      const groups = [...new Set(state.indices.map((i) => i.group))];
      $("#benchSelect").innerHTML = groups.map((g) => `<optgroup label="${esc(g)}">` +
        state.indices.filter((i) => i.group === g).map((i) => `<option value="${i.key}" ${i.key === state.benchKey ? "selected" : ""}>${esc(i.label)}</option>`).join("") +
        `</optgroup>`).join("");
      if (state.lastCalc) renderBenchmark(state.lastCalc); // analysis may have finished before the list arrived
    } catch (e) { $("#benchNote").textContent = "Couldn't load index list: " + e.message; }
  }
  $("#benchSelect").addEventListener("change", (e) => {
    state.benchKey = e.target.value; try { localStorage.setItem("portfolio-lens:bench", state.benchKey); } catch (_) {}
    if (state.lastCalc) renderBenchmark(state.lastCalc);
  });

  async function ensureBench(key) {
    if (!state.sizeBuckets) state.sizeBuckets = (await api("/api/size-buckets")).buckets;
    if (!state.indexCache.has(key)) state.indexCache.set(key, await api(`/api/index/${key}`));
    return state.indexCache.get(key);
  }

  let benchToken = 0;
  async function renderBenchmark(c) {
    if (!state.benchKey) return;
    const token = ++benchToken;
    let idx;
    try { idx = await ensureBench(state.benchKey); }
    catch (e) { $("#benchNote").textContent = "Couldn't load index: " + e.message; return; }
    if (token !== benchToken) return; // a newer render superseded this one

    // Your equity, normalised to 100% (cash/debt excluded so it's comparable with an all-equity index).
    const eq = c.list.filter((s) => s.asset === "Equity" && s.key !== "__unreported");
    const eqTot = eq.reduce((a, s) => a + s.pct, 0) || 1;
    const you = new Map(eq.map((s) => [s.key, { name: s.name, sector: s.sector, w: (s.pct / eqTot) * 100, heldBy: s.heldBy }]));
    const ix = new Map(idx.holdings.map((h) => [h.key, h]));

    let overlap = 0, inIndex = 0, held = 0;
    for (const [k, y] of you) { const h = ix.get(k); if (h) { overlap += Math.min(y.w, h.weight); inIndex += y.w; held++; } }
    const activeShare = 100 - overlap;

    const asOf = idx.as_of ? new Date(idx.as_of).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "";
    $("#benchNote").textContent = `Index weights from ${idx.proxy} (holdings as of ${asOf}). Your side is equity only, rescaled to 100%.`;
    const k = [
      ["Overlap with index", pct(overlap, 1), "share of your equity that matches the index's weights"],
      ["Different from index", pct(activeShare, 1), activeShare > 80 ? "very different from the index" : activeShare > 60 ? "clearly different from the index" : activeShare > 40 ? "partly follows the index" : "close to the index"],
      ["In index stocks", pct(inIndex, 1), `of your equity · you hold ${held} of its ${idx.holdings.length} stocks`],
    ];
    $("#benchKpis").innerHTML = k.map(([l, v, f]) => `<div class="kpi"><div class="label">${l}</div><div class="value">${v}</div><div class="foot">${f}</div></div>`).join("");

    // Size mix
    const buckets = ["Large", "Mid", "Small", "Outside top 500"];
    const bucketOf = (key) => state.sizeBuckets[key] || "Outside top 500";
    const sumBy = (entries) => { const o = Object.fromEntries(buckets.map((b) => [b, 0])); for (const [key, w] of entries) o[bucketOf(key)] += w; return o; };
    const ys = sumBy([...you].map(([key, y]) => [key, y.w]));
    const is = sumBy(idx.holdings.map((h) => [h.key, h.weight]));
    renderPairBars("sizeChart", buckets.map((b) => (b === "Outside top 500" ? "Outside top 500" : b + " cap")), buckets.map((b) => ys[b]), buckets.map((b) => is[b]), idx.label);

    // Sectors
    const secs = new Map();
    for (const y of you.values()) secs.set(y.sector, [(secs.get(y.sector)?.[0] || 0) + y.w, secs.get(y.sector)?.[1] || 0]);
    for (const h of idx.holdings) secs.set(h.sector, [secs.get(h.sector)?.[0] || 0, (secs.get(h.sector)?.[1] || 0) + h.weight]);
    const sl = [...secs.entries()].sort((a, b) => Math.max(b[1][0], b[1][1]) - Math.max(a[1][0], a[1][1]));
    renderPairBars("benchSectorChart", sl.map((x) => x[0]), sl.map((x) => x[1][0]), sl.map((x) => x[1][1]), idx.label);

    // Over / under
    const keys = new Set([...you.keys(), ...ix.keys()]);
    const diffs = [...keys].map((key) => {
      const y = you.get(key), h = ix.get(key);
      return { name: (y || h).name, sector: (y || h).sector, you: y?.w || 0, idx: h?.weight || 0, heldBy: y?.heldBy || "—" };
    }).map((d) => ({ ...d, d: d.you - d.idx }));
    const row = (d) => `<tr><td>${esc(d.name)}<div class="muted small">${esc(d.sector)} · ${esc(d.heldBy)}</div></td>
      <td class="num">${pct(d.you)}</td><td class="num">${pct(d.idx)}</td><td class="num ${d.d >= 0 ? "up" : "down"}">${d.d >= 0 ? "+" : ""}${d.d.toFixed(2)}</td></tr>`;
    const head = `<thead><tr><th>Stock</th><th class="num">You</th><th class="num">Index</th><th class="num">Δ pp</th></tr></thead>`;
    $("#overTable").innerHTML = head + "<tbody>" + diffs.slice().sort((a, b) => b.d - a.d).slice(0, 15).map(row).join("") + "</tbody>";
    $("#underTable").innerHTML = head + "<tbody>" + diffs.slice().sort((a, b) => a.d - b.d).slice(0, 15).map(row).join("") + "</tbody>";
  }

  function renderPairBars(id, cats, youVals, idxVals, idxLabel) {
    const c = [...cats].reverse(), y = [...youVals].reverse(), x = [...idxVals].reverse();
    const lab = (p) => (p.value >= 0.5 ? p.value.toFixed(1) + "%" : "");
    chart(id).setOption({
      ...baseOpts(),
      legend: { top: 0, data: ["You", idxLabel], textStyle: { color: css("--text-secondary") }, icon: "roundRect", itemWidth: 12, itemHeight: 8 },
      grid: { left: 8, right: 48, top: 28, bottom: 6, containLabel: true },
      xAxis: { type: "value", axisLabel: { formatter: "{value}%", color: css("--text-muted"), hideOverlap: true }, splitLine: { lineStyle: { color: css("--grid") } } },
      yAxis: { type: "category", data: c, axisTick: { show: false }, axisLine: { show: false }, axisLabel: { color: css("--text-secondary"), width: labelW(150), overflow: "truncate" } },
      tooltip: { ...baseOpts().tooltip, trigger: "axis", axisPointer: { type: "shadow" }, formatter: (ps) => {
        const i = ps[0].dataIndex, d = y[i] - x[i];
        return `<b>${esc(c[i])}</b><br/>You: <b>${pct(y[i], 1)}</b><br/>${esc(idxLabel)}: <b>${pct(x[i], 1)}</b><br/>Difference: <b class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "+" : ""}${d.toFixed(1)} pp</b>`;
      } },
      series: [
        { name: "You", type: "bar", barMaxWidth: 12, barGap: "20%", data: y.map((v) => +v.toFixed(2)), itemStyle: { color: css("--s1"), borderRadius: [0, 4, 4, 0] },
          label: { show: true, position: "right", formatter: lab, color: css("--text-secondary"), fontSize: 10 } },
        { name: idxLabel, type: "bar", barMaxWidth: 12, data: x.map((v) => +v.toFixed(2)), itemStyle: { color: css("--s2"), borderRadius: [0, 4, 4, 0] },
          label: { show: true, position: "right", formatter: lab, color: css("--text-secondary"), fontSize: 10 } },
      ],
    }, true);
  }

  // ── table ──────────────────────────────────────────────
  function renderTable(view, c) {
    const q = $("#tableSearch").value.trim().toLowerCase();
    const { k, asc } = state.sort;
    const rows = view.filter((s) => !q || s.name.toLowerCase().includes(q) || s.sector.toLowerCase().includes(q))
      .sort((a, b) => { const x = a[k], y = b[k]; const r = typeof x === "string" ? x.localeCompare(y) : (x ?? 0) - (y ?? 0); return asc ? r : -r; });
    document.querySelectorAll("#holdTable th").forEach((th) => { th.classList.toggle("sorted", th.dataset.k === k); th.classList.toggle("asc", th.dataset.k === k && asc); });
    document.querySelectorAll(".delta-col").forEach((el) => el.classList.toggle("hidden", !state.baseline));
    const byId = new Map(c.funds.map((r) => [r.id, r]));
    const html = rows.slice(0, 600).map((s) => {
      const open = state.expanded.has(s.key);
      const d = s.delta;
      let out = `<tr class="stock-row" data-k="${esc(s.key)}"><td>${open ? "▾" : "▸"} ${esc(s.name)}</td><td>${esc(s.sector)}</td>
        <td class="num">${c.money ? inr(s.value, false) : "—"}</td><td class="num">${pct(s.pct, 3)}</td>
        ${state.baseline ? `<td class="num ${d > 0.0005 ? "up" : d < -0.0005 ? "down" : ""}">${d >= 0 ? "+" : ""}${d.toFixed(3)} pp</td>` : ""}
        <td class="num">${s.heldBy}</td></tr>`;
      if (open) {
        const parts = [...s.contrib.entries()].sort((a, b) => b[1] - a[1]).map(([id, v]) => {
          const r = byId.get(id); const h = r.scheme.holdings.find((x) => x.key === s.key);
          return `<div class="contrib"><span class="dot" style="background:${fundColor(r)}"></span><b>${esc(shortName(r.scheme.name))}</b>
            ${r.direct ? "held directly" : `holds ${h ? pct(h.weight) : "—"} of fund`} → ${c.money ? inr(v) + " · " : ""}${pct((v / c.total) * 100, 3)} of your portfolio</div>`;
        }).join("");
        out += `<tr class="detail"><td colspan="${state.baseline ? 6 : 5}">${parts}</td></tr>`;
      }
      return out;
    }).join("");
    $("#holdTable tbody").innerHTML = html || `<tr><td colspan="6" class="muted">No holdings match.</td></tr>`;
  }
  $("#holdTable thead").addEventListener("click", (e) => {
    const k = e.target.closest("th")?.dataset.k; if (!k) return;
    state.sort = { k, asc: state.sort.k === k ? !state.sort.asc : k === "name" || k === "sector" };
    recompute();
  });
  $("#holdTable tbody").addEventListener("click", (e) => {
    const tr = e.target.closest("tr.stock-row"); if (!tr) return;
    const k = tr.dataset.k; state.expanded.has(k) ? state.expanded.delete(k) : state.expanded.add(k);
    recompute();
  });
  $("#tableSearch").addEventListener("input", () => recompute());
  ["#assetFilter", "#sectorFilter", "#topN"].forEach((s) => $(s).addEventListener("change", () => recompute()));
  $("#baselineBtn").onclick = () => {
    const c = state.lastCalc; if (!c) return;
    if (state.baseline) { state.baseline = null; $("#baselineBtn").textContent = "Set as baseline"; $("#baselineTag").classList.add("hidden"); }
    else { state.baseline = new Map(c.list.map((s) => [s.key, s.pct])); $("#baselineBtn").textContent = "Clear baseline"; $("#baselineTag").classList.remove("hidden"); }
    recompute();
  };

  function renderFootnote(c) {
    const dates = c.funds.map((r) => r.scheme.portfolio_date ? `${shortName(r.scheme.name)}: ${new Date(r.scheme.portfolio_date).toLocaleDateString("en-IN", { month: "short", year: "numeric" })}` : null).filter(Boolean);
    $("#footnote").textContent = `Holdings are the latest monthly disclosures (via Groww): ${dates.join(" · ")}. Exposure = amount in fund × stock's weight in that fund. ` +
      (c.money ? "" : "No amounts given, so funds are weighted equally. ") +
      "Your inputs stay in this tab only and are never saved. Not investment advice.";
  }

  // ── theme / resize ─────────────────────────────────────
  $("#themeToggle").onclick = () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("portfolio-lens:theme", root.dataset.theme); } catch (_) {}
    renderRows(); if (state.lastCalc) recompute();
  };
  try { const t = localStorage.getItem("portfolio-lens:theme"); if (t) document.documentElement.dataset.theme = t; } catch (_) {}
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (state.lastCalc) recompute(); });
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    Object.values(charts).forEach((c) => c.resize());
    // label widths depend on screen size, so redraw once resizing settles
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.lastCalc) recompute(); }, 200);
  });

  // ── PDF export ─────────────────────────────────────────
  // Built entirely in the browser: the page is re-rendered in the light theme, each section is
  // captured with html2canvas and laid out on A4 pages with jsPDF. Nothing is uploaded anywhere.
  const libs = {};
  function loadScript(src) {
    return (libs[src] ||= new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src; el.onload = resolve; el.onerror = () => { delete libs[src]; reject(new Error("couldn't load " + src)); };
      document.head.appendChild(el);
    }));
  }
  // two animation frames = layout + paint done; the timer fallback keeps export going if the tab is in the background
  const nextFrame = () => Promise.race([
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    new Promise((r) => setTimeout(r, 120)),
  ]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function buildPdfPages(c, idxLabel) {
    const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
    const k = kpiData(c);
    const brand = `<div class="pdf-brand"><span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/></svg></span>Portfolio Lens</div>`;
    const mf = c.funds.filter((f) => !f.direct).sort((a, b) => b.amount - a.amount);
    const fundRows = mf.map((f) => `<tr><td>${esc(shortName(f.scheme.name))}${f.folios > 1 ? ` <span style="color:#7c8595">(${f.folios} entries)</span>` : ""}</td>
      <td>${esc(f.scheme.sub_category || f.scheme.category || "")}</td>
      <td class="num">${c.money ? inr(f.amount, false) : "—"}</td><td class="num">${pct(c.money ? (f.amount / c.total) * 100 : 100 / mf.length, 1)}</td></tr>`).join("");
    const direct = state.stocks.filter((s) => s.searchId && +s.value > 0);
    const directRows = direct.map((s) => `<tr><td>${esc(s.title)}</td><td>${esc(s.sector || "")}</td><td class="num">${inr(+s.value, false)}</td>
      <td class="num">${c.money ? pct((+s.value / c.total) * 100, 1) : "—"}</td></tr>`).join("");
    const asset = $("#assetFilter").value === "all" ? "all assets" : "equity only";
    const sector = $("#sectorFilter").value || "all sectors";
    const cover = `<div class="pdf-page" id="pdfCover">${brand}
      <h1>Portfolio look-through report</h1>
      <div class="pdf-sub">Prepared ${today} · charts show ${esc(asset)}, ${esc(sector)} · compared with ${esc(idxLabel)}</div>
      <div class="pdf-kpis">${k.map(([l, v, f]) => `<div><span>${l}</span><b>${v}</b><small>${f}</small></div>`).join("")}</div>
      <h2>Mutual funds (${mf.length})</h2>
      <table><thead><tr><th>Fund</th><th>Category</th><th class="num">Amount</th><th class="num">Share</th></tr></thead><tbody>${fundRows || `<tr><td colspan="4">None</td></tr>`}</tbody></table>
      ${direct.length ? `<h2>Stocks held directly (${direct.length})</h2>
      <table><thead><tr><th>Stock</th><th>Sector</th><th class="num">Value</th><th class="num">Share</th></tr></thead><tbody>${directRows}</tbody></table>` : ""}
      <div class="pdf-disclaimer">Exposure = amount in each fund × the stock's weight in that fund, added across funds and direct holdings.
      Holdings are each fund's latest monthly disclosure, so they lag by up to a month. Data from public sources (Groww, AMFI via mfapi.in).
      This report is for information only and is not investment advice.</div></div>`;

    const top = c.list.filter((s) => s.key !== "__unreported").sort((a, b) => b.pct - a.pct).slice(0, 50);
    const holdings = `<div class="pdf-page" id="pdfHoldings"><h2 style="margin-top:0">Top 50 holdings (all assets)</h2>
      <table><thead><tr><th class="num">#</th><th>Holding</th><th>Sector</th><th class="num">Exposure</th><th class="num">% of portfolio</th><th class="num">Held by</th></tr></thead><tbody>
      ${top.map((s, i) => `<tr><td class="num">${i + 1}</td><td>${esc(s.name)}</td><td>${esc(s.sector)}</td><td class="num">${c.money ? inr(s.value, false) : "—"}</td>
        <td class="num">${pct(s.pct, 2)}</td><td class="num">${esc(s.heldBy)}</td></tr>`).join("")}</tbody></table></div>`;
    $("#pdfStage").innerHTML = cover + holdings;
  }

  async function exportPdf() {
    const c0 = state.lastCalc; if (!c0 || !c0.funds.length) return;
    const btns = [...document.querySelectorAll(".pdfBtn")];
    const labels = btns.map((b) => b.innerHTML);
    btns.forEach((b) => { b.disabled = true; b.innerHTML = `<span class="label-text">Preparing PDF…</span>`; });
    const root = document.documentElement, prevTheme = root.dataset.theme;
    try {
      await Promise.all([
        loadScript("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"),
        loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"),
      ]);
      // light theme, no animation, full-height tables for print
      state.exporting = true; root.dataset.theme = "light"; document.body.classList.add("exporting");
      recompute(); await renderBenchmark(state.lastCalc); await nextFrame(); await sleep(250);
      const c = state.lastCalc;
      const idx = state.indexCache.get(state.benchKey);
      buildPdfPages(c, idx ? idx.label : "the selected index");
      await document.fonts.ready; await nextFrame();

      const shot = (el) => window.html2canvas(el, { scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false,
                                                  windowWidth: Math.max(document.documentElement.clientWidth, 1100) });
      const sections = [
        [null, $("#pdfCover")],
        ["Sector exposure and stock map", $("#pdf-sectors")],
        ["Top stock exposures by source fund", $("#pdf-top")],
        [`Comparison with ${idx ? idx.label : "index"}`, $("#pdf-bench-top")],
        [`Stocks furthest from ${idx ? idx.label : "the index"}`, $("#pdf-bench-tables")],
        ["Fund overlap and asset mix", $("#pdf-overlap")],
        [null, $("#pdfHoldings")],
      ];

      const { jsPDF } = window.jspdf;
      const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
      const PW = 210, PH = 297, M = 12, TOP = 18, BOTTOM = 14, W = PW - 2 * M;
      let y = TOP, first = true;
      const newPage = () => { if (!first) pdf.addPage(); first = false; y = TOP; };
      newPage();
      for (const [title, el] of sections) {
        if (!el) continue;
        const canvas = await shot(el);
        const pxPerMm = canvas.width / W;
        const titleH = title ? 9 : 0;
        const fullH = canvas.height / pxPerMm;
        // Keep a section whole: if it doesn't fit in what's left of this page but would fit on a fresh
        // page, start a new page. Only sections taller than a whole page get split.
        const pageRoom = PH - BOTTOM - TOP;
        if (y > TOP && y + titleH + fullH > PH - BOTTOM && titleH + fullH <= pageRoom) newPage();
        if (el.id === "pdfCover" || el.id === "pdfHoldings") { if (y > TOP) newPage(); }
        if (title) {
          pdf.setFont("helvetica", "bold"); pdf.setFontSize(12.5); pdf.setTextColor(15, 23, 42);
          pdf.text(title, M, y + 5); y += titleH;
        }
        // Slightly taller than a page (≤ 10% over)? Shrink it to fit rather than spill a sliver onto a new page.
        if (fullH > PH - BOTTOM - y && fullH <= (PH - BOTTOM - y) * 1.1) {
          const h = PH - BOTTOM - y, w = W * (h / fullH);
          pdf.addImage(canvas.toDataURL("image/jpeg", 0.9), "JPEG", M + (W - w) / 2, y, w, h);
          y += h + 6;
          continue;
        }
        // slice genuinely tall captures across pages
        let srcY = 0;
        while (srcY < canvas.height) {
          if (PH - BOTTOM - y < 30) newPage(); // too little room left for a useful slice
          const room = PH - BOTTOM - y;
          const sliceH = Math.min(canvas.height - srcY, Math.floor(room * pxPerMm));
          const part = document.createElement("canvas");
          part.width = canvas.width; part.height = sliceH;
          part.getContext("2d").drawImage(canvas, 0, srcY, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
          pdf.addImage(part.toDataURL("image/jpeg", 0.9), "JPEG", M, y, W, sliceH / pxPerMm);
          y += sliceH / pxPerMm + 6; srcY += sliceH;
          if (srcY < canvas.height) newPage();
        }
      }
      // running header / footer
      const n = pdf.getNumberOfPages();
      const stamp = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
      for (let i = 1; i <= n; i++) {
        pdf.setPage(i);
        pdf.setFont("helvetica", "normal"); pdf.setFontSize(8.5); pdf.setTextColor(124, 133, 149);
        pdf.text("Portfolio Lens · Look-through report", M, 9);
        pdf.text(stamp, PW - M, 9, { align: "right" });
        pdf.setDrawColor(227, 231, 238); pdf.line(M, 11.5, PW - M, 11.5);
        pdf.text("For information only. Not investment advice.", M, PH - 6);
        pdf.text(`Page ${i} of ${n}`, PW - M, PH - 6, { align: "right" });
      }
      pdf.save(`portfolio-lens-analysis-${new Date().toISOString().slice(0, 10)}.pdf`);
      setStatus("");
    } catch (e) {
      setStatus("Couldn't create the PDF: " + e.message, true);
      alert("Couldn't create the PDF: " + e.message);
    } finally {
      state.exporting = false;
      if (prevTheme) root.dataset.theme = prevTheme; else delete root.dataset.theme;
      document.body.classList.remove("exporting");
      $("#pdfStage").innerHTML = ""; // don't leave a copy of the portfolio in the page
      recompute();
      btns.forEach((b, i) => { b.disabled = false; b.innerHTML = labels[i]; });
    }
  }
  document.querySelectorAll(".pdfBtn").forEach((b) => b.addEventListener("click", exportPdf));

  // ── boot ───────────────────────────────────────────────
  initBenchmarks();
  state.rows = [newRow()]; renderRows(); renderStocks();
})();
