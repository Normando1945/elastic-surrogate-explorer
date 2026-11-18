// Surrogate Explorer · app-exposure.js — the exposure chapter: who and what stands on the relief (GEM TREQ, CC BY-SA 4.0).
// A classic script like the other app-*.js (the public builder versions each one). exposure.js reads the data, site.js
// draws it: the city coloured by class (Buildings) or prisms on hexagons (Hexagons). The view lives in the URL as
// xview / xattr / xbranch / xhex / xh / xstack, its own names, removed when the chapter is left.
"use strict";

  const EXPOSURE_LAYERS = { terrain: true, section: false, faults: false, planes: false, zones: false, urban: false, receivers: false, rupture: false, footprint: false };
  const EXPO_ATTRS = { material: "Material", llrs: "Lateral system", ductility: "Ductility", storeys: "Storeys", occupancy: "Occupancy" };
  const EXPO_METRICS = { count: "Buildings", cost: "Replacement cost", night: "Night occupants" };
  const EXPO_SIZES = [250, 500, 1000];
  const EXPO_ORDERED = new Set(["storeys", "ductility"]);                 // classes with an order of their own
  const EXPO_SCALE_KM = 3.0;                                          // the 99th-percentile column at ×1, km
  const EXPO_FOOT = [0.831, 0.820, 0.796];                           // the footing under a column: the clay walls' grey (#d4d1cb), not data
  // Height: a square root by default. The metrics are heavy-tailed (the median 250 m hexagon holds a tenth of the 99th
  // percentile, one holds 8 times it), so a linear column turned the city into a few needles over a flat carpet.
  const EXPO_HEIGHTS = { sqrt: v => Math.sqrt(v), linear: v => v };
  // the chapter opens on the author's view (2026-11-17): 250 m columns of buildings, stacked by storeys, √, ×1.5
  const EXPO_DEFAULT = { view: "hex", attr: "storeys", size: 250, metric: "count", stacked: true, height: "linear", base: "relief" };
  const EXPO_FLAT_EXAG = 0.02;                                       // "flat ground": the relief a sheet, the columns on one base
  const expo = { ...EXPO_DEFAULT, branch: 0, scale: 1.5, saved: null, exag: null, exagBefore: null,
                 palette: null, ok: false, hx: null, ground: new Map(), norm: 1, cardFor: null };
  const inExposure = () => !!(Story.chapter && Story.chapter.id === "exposure" && !Story.onCover);
  const usd = v => (v >= 1e9 ? `${(v / 1e9).toFixed(2)} bn USD` : v >= 1e6 ? `${(v / 1e6).toFixed(1)} M USD` : `${num(v / 1e3)} k USD`);
  const pct = (a, b) => `${(100 * a / Math.max(b, 1e-9)).toFixed(a / b < 0.01 ? 2 : 1)} %`;
  const branchKey = () => Exposure.meta.branches[expo.branch].key;
  const buildingsText = n => `${num(n)} building${Math.round(n) === 1 ? "" : "s"}`;

  function readExposureParams() {
    const p = Story.params;
    expo.view = p.get("xview") === "hex" || p.get("xview") === "buildings" ? p.get("xview") : EXPO_DEFAULT.view;
    expo.attr = EXPO_ATTRS[p.get("xattr")] ? p.get("xattr") : EXPO_DEFAULT.attr;
    const b = Number(p.get("xbranch")); if (b >= 1 && b <= 4) expo.branch = b - 1;
    const s = Number(p.get("xhex")); expo.size = EXPO_SIZES.includes(s) ? s : EXPO_DEFAULT.size;
    expo.metric = EXPO_METRICS[p.get("xh")] ? p.get("xh") : EXPO_DEFAULT.metric;
    expo.stacked = p.has("xstack") ? p.get("xstack") === "1" : EXPO_DEFAULT.stacked;
    expo.height = p.get("xscale") === "sqrt" || p.get("xscale") === "linear" ? p.get("xscale") : EXPO_DEFAULT.height;
    expo.base = p.get("xground") === "flat" ? "flat" : EXPO_DEFAULT.base;
  }
  function writeExposureParams() {
    const hex = expo.view === "hex";
    Story.setParams({ xview: expo.view, xattr: expo.attr, xbranch: expo.branch + 1, xhex: hex ? expo.size : null, xh: hex ? expo.metric : null, xstack: hex ? (expo.stacked ? 1 : 0) : null,
                     xscale: hex && expo.height !== EXPO_DEFAULT.height ? expo.height : null, xground: hex && expo.base === "flat" ? "flat" : null });
  }

  // ---------------------------------------------------------------- enter / leave
  async function enterExposure() {
    setStage("site"); setSection(false); hideCard(); app.site.clearLocation(); setOrbitButton(false);
    if (expo.saved === null) expo.saved = app.site.show.buildings;     // the visitor's own Buildings switch, given back on leaving
    // the chapter's ground: the clay model (Ambient occlusion) with white walls, so the classes' colours stand alone on it;
    // the visitor's palette and walls come back on leaving (the palette chips here still change it)
    if (expo.palette === null) { expo.palette = app.site.palette; app.site.setPalette("ao"); markPalette(); }
    app.site.setWallStyle("clay");
    // the relief at its true height (×1.0) here, the visitor's exaggeration back on leaving (the slider is in the panel)
    if (expo.exagBefore === null) { expo.exagBefore = app.site.exaggeration; if (Math.abs(expo.exagBefore - 1) > 1e-6) app.site.setExaggeration(1); syncExpoExag(); }
    app.site.setShow(EXPOSURE_LAYERS); app.site.setOpacity(1); markTools();
    readExposureParams(); markExposure();
    status("Loading the exposure model…", null);
    const meta = await Exposure.load().catch(error => { fail(error); return null; }).finally(() => status(null));
    if (!inExposure()) return;
    $("#expo-missing").hidden = !!meta; $("#expo-controls").hidden = !meta;
    if (!meta) { app.flight = app.site.flyTo("exposureHex", 2000); return; }
    // the colours belong to one build of the footprints: the page refuses another (exposure.json repeats its sha256)
    const footprints = await app.site.loadBuildings().catch(() => null);
    if (!inExposure()) return;
    expo.ok = !!footprints && footprints.sha256 === meta.footprints.sha256 && footprints.count === meta.footprints.count && app.site.exposureCapable;
    $("#expo-mismatch").hidden = expo.ok;
    describeExposure();
    await applyExposure(true);
  }
  function leaveExposure() {
    app.site.setExposure(null); app.site.setHexes(null); app.site.highlightBuilding(-1); expo.cardFor = null;
    hideCard(); $("#hover").hidden = true;
    app.site.setShow({ ...ALL_LAYERS, buildings: expo.saved ?? true }); expo.saved = null; markTools();
    app.site.setWallStyle("earth");
    if (expo.palette !== null) { app.site.setPalette(expo.palette); markPalette(); Story.setParams({ palette: expo.palette === "map" ? null : expo.palette }); expo.palette = null; }
    app.site.setHexFlat(false); expo.exag = null;                      // flat ground and the chapter's ×1.0 give the visitor's relief back
    if (expo.exagBefore !== null) { app.site.setExaggeration(expo.exagBefore); expo.exagBefore = null; syncExag(); }
    Story.setParams({ xview: null, xattr: null, xbranch: null, xhex: null, xh: null, xstack: null, xscale: null, xground: null });
  }

  // ---------------------------------------------------------------- the view
  async function applyExposure(fly = false) {
    if (!Exposure.meta || !inExposure()) return;
    writeExposureParams(); markExposure(); drawExposureLegend();
    applyGround(expo.view === "hex" && expo.base === "flat");
    if (expo.view === "buildings") {
      app.site.setHexes(null);
      app.site.setShow({ buildings: true }); markTools();
      if (expo.ok) app.site.setExposure({ ...Exposure.indexTexture(expo.attr), palette: Exposure.palette(expo.attr), branch: Exposure.perBranch(expo.attr) ? expo.branch : 0 });
      else app.site.setExposure(null);
      if (fly) app.flight = app.site.flyTo("exposure", 2200);
      return;
    }
    app.site.setExposure(null); app.site.highlightBuilding(-1); app.site.setShow({ buildings: false }); markTools();
    status(`Loading the ${expo.size} m hexagons…`, null);
    const hx = await Exposure.hex(expo.size).catch(error => { fail(error); return null; }).finally(() => status(null));
    if (!hx || !inExposure() || expo.view !== "hex" || hx.size !== expo.size) return;
    expo.hx = hx;
    app.site.setHexes(hexSpec(hx));
    describeHexes();
    if (fly) app.flight = app.site.flyTo("exposureHex", 2200);
  }
  // flat ground: the relief eases down to a sheet and the columns share one base; off, the visitor's relief comes back
  function applyGround(flat) {
    app.site.setHexFlat(flat);
    if (flat && expo.exag === null) {
      expo.exag = app.site.exaggeration;
      app.site.animateExaggeration(EXPO_FLAT_EXAG, 1200).then(syncExpoExag);
    } else if (!flat && expo.exag !== null) {
      const back = expo.exag; expo.exag = null;
      app.site.animateExaggeration(back, 1200).then(syncExpoExag);
    }
  }
  function syncExpoExag() {
    const v = app.site.exaggeration, flat = expo.exag !== null;
    $("#expo-exag").value = flat ? expo.exag.toFixed(1) : v.toFixed(1); $("#expo-exag").disabled = flat;
    $("#expo-exag-out").textContent = flat ? "flat" : `×${v.toFixed(1)}`;
    syncExag();
  }
  // the lowest and highest ground under each hexagon (its centre and six corners), m; NaN off the relief
  function hexGround(hx) {
    if (!expo.ground.has(hx.size)) {
      const lo = new Float32Array(hx.count), hi = new Float32Array(hx.count), r = hx.radiusKm;
      for (let i = 0; i < hx.count; i++) {
        let a = Infinity, b = -Infinity;
        for (let c = -1; c < 6; c++) {
          const t = Math.PI / 6 + c * Math.PI / 3, g = app.site.heightAt(hx.x[i] + (c < 0 ? 0 : r * Math.cos(t)), hx.y[i] + (c < 0 ? 0 : r * Math.sin(t)));
          if (Number.isFinite(g)) { a = Math.min(a, g); b = Math.max(b, g); }
        }
        lo[i] = Number.isFinite(a) ? a : NaN; hi[i] = Number.isFinite(b) ? b : NaN;
      }
      expo.ground.set(hx.size, { lo, hi });
    }
    return expo.ground.get(hx.size);
  }
  // the columns: height = the metric through EXPO_HEIGHTS (the 99th-percentile hexagon is EXPO_SCALE_KM at ×1), colour =
  // the dominant class by that metric, or the column cut in the classes' shares; under each, a white footing down the slope
  function hexSpec(hx) {
    const { lo, hi } = hexGround(hx), table = Exposure.table(hx, expo.attr, branchKey(), expo.metric), cls = Exposure.classes(expo.attr), K = cls.length;
    const colours = cls.map(c => Exposure.rgb(c.color).map(v => v / 255));
    const values = Float64Array.from({ length: hx.count }, (_, i) => Exposure.value(hx, expo.metric, i));
    const sorted = Float64Array.from(values).sort();
    expo.norm = sorted[Math.min(sorted.length - 1, Math.floor(0.99 * sorted.length))] || 1;
    const hex = [], from = [], to = [], rgb = [], foot = [], f = EXPO_HEIGHTS[expo.height];
    // stacked, the same order in every column: an ordered attribute in its own order (1 storey at the foot, towers on
    // top; non-ductile at the foot), a categorical one from the rarest class to the most common (the roof then shows
    // what most of the city is made of, as in the references)
    const counts = Exposure.meta.class_counts[expo.attr][Exposure.perBranch(expo.attr) ? branchKey() : "all"];
    const order = EXPO_ORDERED.has(expo.attr) ? [...Array(K).keys()] : [...Array(K).keys()].sort((a, b) => counts[a] - counts[b]);
    for (let i = 0; i < hx.count; i++) {
      if (!Number.isFinite(lo[i]) || !(values[i] > 0)) continue;
      const level = f(values[i] / expo.norm), row = table.subarray(i * K, i * K + K);
      let total = 0; for (let k = 0; k < K; k++) total += row[k];
      if (!total) continue;
      hex.push(i); from.push(0); to.push(0); rgb.push(...EXPO_FOOT); foot.push(1);
      if (expo.stacked) {
        let at = 0;
        for (const k of order) { if (!row[k]) continue; const top = at + level * row[k] / total; hex.push(i); from.push(at); to.push(top); rgb.push(...colours[k]); foot.push(0); at = top; }
      } else {
        let best = 0; for (let k = 1; k < K; k++) if (row[k] > row[best]) best = k;
        hex.push(i); from.push(0); to.push(level); rgb.push(...colours[best]); foot.push(0);
      }
    }
    return { x: hx.x, y: hx.y, lo, hi, radiusKm: hx.radiusKm * 0.93, scaleKm: EXPO_SCALE_KM * expo.scale,
             seg: { hex: Uint32Array.from(hex), from: Float32Array.from(from), to: Float32Array.from(to), rgb: Float32Array.from(rgb), foot: Uint8Array.from(foot) } };
  }

  // ---------------------------------------------------------------- the panel
  function describeExposure() {
    const m = Exposure.meta, t = m.totals, c = m.coverage;
    stats("#expo-stats", [[num(t.assets), "buildings in the model"], [usd(t.replacement_cost_usd), "to rebuild them (replacement cost)"],
                          [`${(t.night_occupants / 1e6).toFixed(2)} M`, "people inside at night"], [`${(t.built_area_m2 / 1e6).toFixed(0)} km²`, "built floor area"]]);
    $("#expo-branches").innerHTML = m.branches.map((b, k) => `<button type="button" class="chip" data-expo-branch="${k}" title="${b.label}">${b.key} · ${b.label}</button>`).join("");
    const r = c.rates;
    $("#expo-coverage").textContent = `The model's buildings are points (one per cadastral building); the map draws footprints. ` +
      `${(100 * r.inside).toFixed(1)} % of the points fall inside a footprint and ${(100 * r.near).toFixed(1)} % within ${c.tolerance_m} m of one; ` +
      `${num(c.footprints_with_assets)} footprints carry an asset and take its class (the largest by floor area where several share one), ` +
      `the other ${num(c.footprints_without_assets)} stay neutral. ${num(c.assets_outside_dem)} buildings of the north-western parishes lie beyond the relief and are not drawn; the hexagons count every building on it.`;
    markExposure();
  }
  function describeHexes() {
    const hx = expo.hx; if (!hx) return;
    const unit = { count: v => `${num(v)} buildings`, cost: usd, night: v => `${num(v)} people at night` }[expo.metric];
    $("#expo-hex-note").textContent = `${num(hx.count)} hexagons of ${expo.size} m (${(Math.sqrt(3) / 2 * expo.size ** 2 / 1e6).toFixed(3)} km² each). ` +
      `Height: ${EXPO_METRICS[expo.metric].toLowerCase()}, ${expo.height === "sqrt" ? "as its square root (a quarter of the value, half the height)" : "linear"}; ` +
      `${(EXPO_SCALE_KM * expo.scale).toFixed(1)} km of column is ${unit(expo.norm)} (the 99th percentile). ` +
      (expo.base === "flat" ? "Flat ground: the relief is flattened and every column starts from one common base. "
        : "Every column stands on the highest ground under its hexagon; the white footing below it is not data (Flat ground gives them one common base). ") +
      `Colour: ${expo.stacked ? "the column cut in the classes' shares of it" : "the class with the largest share of it"}.`;
  }
  function drawExposureLegend() {
    const m = Exposure.meta, cls = Exposure.classes(expo.attr), counts = m.class_counts[expo.attr][Exposure.perBranch(expo.attr) ? branchKey() : "all"];
    const total = counts.reduce((a, b) => a + b, 0);
    const items = cls.map((c, k) => counts[k] ? `<li><span class="sw block" style="--c: ${c.color}"></span><span>${c.en}</span><span class="n">${num(counts[k])} · ${pct(counts[k], total)}</span></li>` : "");
    if (expo.view === "buildings") items.push(`<li><span class="sw block neutral"></span><span>No asset joined</span><span class="n">${num(m.coverage.footprints_without_assets)} footprints</span></li>`);
    $("#expo-legend").innerHTML = items.join("");
    $("#expo-legend-note").textContent = `Buildings of the model per class in ${Exposure.perBranch(expo.attr) ? `branch ${branchKey()}` : "every branch (occupancy does not change between them)"}.`;
    $("#expo-branch-note").textContent = Exposure.perBranch(expo.attr) || expo.view === "hex" ? branchNote() : "Occupancy is the same in the four branches.";
  }
  function branchNote() {
    const key = branchKey(), m = Exposure.meta;
    const notes = { br1: "The reference classification of the cadastre's variables.",
                    br2: `Every building one storey off its cadastral height (a 1-storey building becomes 2): height is the cadastre's least reliable attribute. Repaired here: the ${num(m.br2_repair.repaired)} towers of 11–60 storeys that the published file turned into 1 storey keep their range.`,
                    br3: "Another reading of the seismic design level (ductility) from the same variables.",
                    br4: "Another reading of the material and lateral system (and ductility): masonry where the reference sees reinforced concrete." };
    return `${notes[key] || ""} TREQ keeps four exposure models, one per modelling hypothesis, and weighs them in its risk results.`;
  }
  function markExposure() {
    document.querySelectorAll("[data-expo-view]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.expoView === expo.view)));
    document.querySelectorAll("[data-expo-attr]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.expoAttr === expo.attr)));
    document.querySelectorAll("[data-expo-branch]").forEach(b => { b.setAttribute("aria-pressed", String(Number(b.dataset.expoBranch) === expo.branch));
      b.disabled = expo.view === "buildings" && Exposure.meta && !Exposure.perBranch(expo.attr); });
    document.querySelectorAll("[data-expo-size]").forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.expoSize) === expo.size)));
    document.querySelectorAll("[data-expo-metric]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.expoMetric === expo.metric)));
    document.querySelectorAll("[data-expo-stack]").forEach(b => b.setAttribute("aria-pressed", String((b.dataset.expoStack === "1") === expo.stacked)));
    document.querySelectorAll("[data-expo-height]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.expoHeight === expo.height)));
    document.querySelectorAll("[data-expo-ground]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.expoGround === expo.base)));
    $("#expo-hex-controls").hidden = expo.view !== "hex";
    syncExpoExag();
    $("#expo-scale").value = String(expo.scale); $("#expo-scale-out").textContent = `×${expo.scale.toFixed(2)}`;
  }

  // ---------------------------------------------------------------- cards and the hover
  function exposureCard(hit) {
    if (hit.kind === "hex") return exposureHexCard(hit.index);
    exposureBuildingCard(hit.index).catch(fail);
  }
  async function exposureBuildingCard(k) {
    const m = Exposure.meta, b = Exposure.buildings, ring = app.site.buildingRing(k);
    if (!ring) return;
    expo.cardFor = k; app.site.highlightBuilding(k);
    let a2 = 0; ring.ring.forEach((p, i) => { const q = ring.ring[(i + 1) % ring.ring.length]; a2 += p[0] * q[1] - q[0] * p[1]; });
    const footprint = [["Footprint", `${num(Math.abs(a2) * 5e5)} m²`], ["Height (Open Buildings 2.5D)", `${ring.height.toFixed(1)} m`], ["Position", latLon(...ring.centre)]];
    const zoom = `<div class="card-actions"><button type="button" class="action" data-card-building="${k}">⌖ Closer</button></div>`;
    if (!b.n_assets[k]) {
      showCard("Building · no asset", "Not in the exposure model", rows(footprint) +
        `<p class="note">No building of the TREQ model was joined to this footprint (inside it or within ${m.coverage.tolerance_m} m), so it is drawn neutral. ` +
        `The cadastre counts ${num(m.totals.assets)} buildings; the map draws ${num(m.footprints.count)} footprints.</p>` + zoom);
      return;
    }
    showCard("Building", "Reading its record…", `<p class="note">GEM TREQ exposure model</p>`);
    const d = await Exposure.detail(ring.chunk);
    if (expo.cardFor !== k || !inExposure()) return;
    const mine = d.building.map((v, i) => (v === k ? i : -1)).filter(i => i >= 0).sort((i, j) => d.area_m2[j] - d.area_m2[i]);
    const lead = mine[0], key = branchKey(), tax = br => m.taxonomies[d.taxonomy[br][lead]], w = Exposure.words(tax(key));
    const sum = f => mine.reduce((s, i) => s + d[f][i], 0), occ = Exposure.classes("occupancy")[d.occupancy[lead] - 1];
    const join = d.inside[lead] ? "inside the footprint" : `${d.distance_m[lead].toFixed(1)} m from it`;
    const across = `<table class="expo-branches" aria-label="This building in the four branches"><thead><tr><th>Branch</th><th>Class</th></tr></thead><tbody>${
      m.branches.map(br => { const x = Exposure.words(tax(br.key)); return `<tr${br.key === key ? ' class="on"' : ""}><td title="${br.label}">${br.key}</td><td>${x.material} · ${x.llrs} · ${x.ductility} · ${x.storeys}</td></tr>`; }).join("")}</tbody></table>`;
    const others = mine.length > 1 ? `<h4>${mine.length} buildings of the model on this footprint</h4><ul class="expo-assets">${mine.slice(0, 8).map(i => {
      const x = Exposure.words(m.taxonomies[d.taxonomy[key][i]]); return `<li><span>${d.id[i]}</span> ${x.material}, ${x.storeys} · ${num(d.area_m2[i])} m²</li>`; }).join("")}${mine.length > 8 ? `<li>… and ${mine.length - 8} more</li>` : ""}</ul>` : "";
    showCard(`Building · ${d.id[lead]}`, `${w.material} · ${w.storeys}`, rows([["Lateral system", w.llrs], ["Ductility", w.ductility], ["Occupancy", occ ? occ.en : "—"],
      ["Replacement cost", usd(sum("cost_usd"))], ["People inside at night", (Math.round(sum("night") * 10) / 10).toLocaleString("en-US")], ["Floor area", `${num(sum("area_m2"))} m²`],
      ["Barrio", m.barrios[d.barrio[lead]] || d.barrio[lead]], ["Parish", m.parroquias[d.parroquia[lead]] || d.parroquia[lead]], ["Zone", m.zonas[d.zona[lead]] || d.zona[lead]],
      ["Seismic microzone", m.microzones[d.microzone[lead]] === "noaf" ? "none (outside the microzonation)" : m.microzones[d.microzone[lead]]],
      ["Vulnerability class", m.vulnerability_classes[d.taxonomy[key][lead]]], ["Joined", join], ...footprint]) +
      `<h4>In the four branches</h4>${across}${others}` +
      `<p class="note">GEM TREQ exposure model (CC BY-SA 4.0), branch ${key}. The building's colour is the dominant ${EXPO_ATTRS[expo.attr].toLowerCase()} by floor area among the ${mine.length} joined to it.</p>` + zoom);
  }
  function exposureHexCard(k) {
    const hx = expo.hx; if (!hx) return;
    const cls = Exposure.classes(expo.attr), K = cls.length, key = branchKey(), at = (metric, i) => Exposure.value(hx, metric, i);
    const tab = metric => Exposure.table(hx, expo.attr, key, metric).subarray(k * K, k * K + K);
    const [cnt, cost, night] = ["count", "cost", "night"].map(tab), costScale = metric => (hx.layout.find(l => l.name.endsWith(`.${metric}`) && l.name.startsWith(`${expo.attr}.`)) || {}).scale || 1;
    const sc = costScale("cost"), sn = costScale("night"), n = at("count", k), c = at("cost", k), p = at("night", k);
    const lines = cls.map((cl, j) => (cnt[j] ? `<tr><td><span class="sw block" style="--c: ${cl.color}"></span>${cl.en}</td><td>${num(cnt[j])}</td><td>${pct(cost[j] / sc, c)}</td><td>${pct(night[j] / sn, p)}</td></tr>` : "")).join("");
    showCard(`Hexagon · ${expo.size} m`, buildingsText(n), rows([["Replacement cost", usd(c)], ["People inside at night", num(p)], ["Floor area", `${num(at("area", k))} m²`],
      ["Hexagon", `${(Math.sqrt(3) / 2 * expo.size ** 2 / 1e6).toFixed(3)} km²`], ["Centre", latLon(hx.x[k], hx.y[k])]]) +
      `<h4>${EXPO_ATTRS[expo.attr]}${Exposure.perBranch(expo.attr) ? ` · branch ${key}` : ""}</h4><table class="expo-hex" aria-label="Classes in this hexagon"><thead><tr><th>Class</th><th>Buildings</th><th>Cost</th><th>At night</th></tr></thead><tbody>${lines}</tbody></table>` +
      `<p class="note">Every building of the GEM TREQ model whose point falls in this hexagon, joined to a footprint or not.</p>`);
  }
  function exposureHexTip(k) {
    const hx = expo.hx; if (!hx) return "";
    return `${expo.size} m hexagon · ${buildingsText(Exposure.value(hx, "count", k))} · ${usd(Exposure.value(hx, "cost", k))} · ${num(Exposure.value(hx, "night", k))} people at night · click for its classes`;
  }

  // ---------------------------------------------------------------- controls
  function wireExposure() {
    const set = (change, rebuild = true) => { Object.assign(expo, change); if (rebuild) applyExposure(false).catch(fail); };
    document.querySelectorAll("[data-expo-view]").forEach(b => b.addEventListener("click", () => {
      if (b.dataset.expoView === expo.view) return;
      hideCard(); set({ view: b.dataset.expoView }); app.flight = app.site.flyTo(b.dataset.expoView === "hex" ? "exposureHex" : "exposure", 1800);
    }));
    document.querySelectorAll("[data-expo-attr]").forEach(b => b.addEventListener("click", () => set({ attr: b.dataset.expoAttr })));
    $("#expo-branches").addEventListener("click", e => { const b = e.target.closest("[data-expo-branch]"); if (b && !b.disabled) set({ branch: Number(b.dataset.expoBranch) }); });
    document.querySelectorAll("[data-expo-size]").forEach(b => b.addEventListener("click", () => { hideCard(); set({ size: Number(b.dataset.expoSize) }); }));
    document.querySelectorAll("[data-expo-metric]").forEach(b => b.addEventListener("click", () => set({ metric: b.dataset.expoMetric })));
    document.querySelectorAll("[data-expo-stack]").forEach(b => b.addEventListener("click", () => set({ stacked: b.dataset.expoStack === "1" })));
    document.querySelectorAll("[data-expo-height]").forEach(b => b.addEventListener("click", () => set({ height: b.dataset.expoHeight })));
    document.querySelectorAll("[data-expo-ground]").forEach(b => b.addEventListener("click", () => set({ base: b.dataset.expoGround })));
    $("#expo-scale").addEventListener("input", e => {
      expo.scale = Number(e.target.value); $("#expo-scale-out").textContent = `×${expo.scale.toFixed(2)}`;
      app.site.setHexScale(EXPO_SCALE_KM * expo.scale); describeHexes();
    });
    $("#expo-exag").addEventListener("input", e => { if (expo.exag === null) { app.site.setExaggeration(Number(e.target.value)); syncExpoExag(); } });
    $("#card").addEventListener("click", e => { const z = e.target.closest("[data-card-building]"); if (z) { setOrbitButton(false); app.flight = app.site.focusBuilding(Number(z.dataset.cardBuilding)); } });
  }
