// Surrogate Explorer · app-medium.js — medium loading, stratigraphy and receiver records.
// Split from app.js; this remains a classic script so the public builder can version every file independently.
"use strict";

  function cellColors(medium, field) {
    const fam = app.family, nx = fam.grid.nx, nz = fam.grid.nz, size = nx * nz, spec = FIELDS[field];
    const mean = fam.normalizer.mean[spec.channel], std = fam.normalizer.std[spec.channel];
    const values = new Float32Array(size), mask = medium.subarray(3 * size, 4 * size);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < size; i++) {
      if (mask[i] < 0.5) continue;
      const v = medium[spec.channel * size + i] * std + mean;
      values[i] = v; if (v < lo) lo = v; if (v > hi) hi = v;
    }
    const cmap = spec.cmap(), lut = new Uint8Array(256 * 3);
    for (let k = 0; k < 256; k++) { const c = d3.rgb(cmap(k / 255)); lut[k * 3] = c.r; lut[k * 3 + 1] = c.g; lut[k * 3 + 2] = c.b; }
    const rgba = new Uint8Array((nx - 1) * (nz - 1) * 4), span = Math.max(hi - lo, 1e-9);
    for (let iz = 0; iz < nz - 1; iz++) for (let ix = 0; ix < nx - 1; ix++) {
      const node = iz * nx + ix, p = (iz * (nx - 1) + ix) * 4, k = Math.round((values[node] - lo) / span * 255) * 3;
      rgba[p] = lut[k]; rgba[p + 1] = lut[k + 1]; rgba[p + 2] = lut[k + 2]; rgba[p + 3] = 255;
    }
    return { mask, rgba, lo, hi, cmap };
  }

  // the layer of every grid node: its (vp, vs, rho), un-normalized, against the triples of the viewer's stratigraphy
  // (core/ElasticPSV2DStratigraphy, exported per medium); -1 in the air. Once per medium.
  function layerMap(medium) {
    if (medium.layerMap) return medium.layerMap;
    const fam = app.family, size = fam.grid.nx * fam.grid.nz, inp = medium.input, L = (medium.meta.strata || {}).layers || [];
    const val = (c, i) => inp[c * size + i] * fam.normalizer.std[c] + fam.normalizer.mean[c];
    const map = new Int8Array(size).fill(-1);
    for (let i = 0; i < size; i++) {
      if (inp[3 * size + i] < 0.5 || !L.length) continue;
      const v = [val(0, i), val(1, i), val(2, i)];
      let best = 0, bestD = Infinity;
      L.forEach((l, k) => { const d = Math.abs(v[0] - l.vp) / l.vp + Math.abs(v[1] - l.vs) / l.vs + Math.abs(v[2] - l.rho) / l.rho; if (d < bestD) { bestD = d; best = k; } });
      map[i] = best;
    }
    return (medium.layerMap = map);
  }
  // the picked layer stays in its colours, every other one fades toward the viewport (the viewer's selection look)
  function highlightLayer(rgba) {
    if (app.layer == null || app.layer < 0 || !(Story.chapter && Story.chapter.id === "medium")) return rgba;
    const fam = app.family, nx = fam.grid.nx, nz = fam.grid.nz, map = layerMap(app.medium), out = new Uint8Array(rgba);
    const bg = d3.rgb(themeTokens().viewport);
    for (let iz = 0; iz < nz - 1; iz++) for (let ix = 0; ix < nx - 1; ix++) {
      if (map[iz * nx + ix] === app.layer) continue;
      const p = (iz * (nx - 1) + ix) * 4;
      out[p] = out[p] * 0.28 + bg.r * 0.72; out[p + 1] = out[p + 1] * 0.28 + bg.g * 0.72; out[p + 2] = out[p + 2] * 0.28 + bg.b * 0.72;
    }
    return out;
  }
  // the medium chapter's two views: the layers taken apart (as the viewer's STRATIGRAPHY tab), or the block
  app.mediumView = "layers";
  function strataSpec() {
    const L = (app.medium.meta.strata || {}).layers || [], spec = FIELDS[app.field], key = ["vp", "vs", "rho"][spec.channel];
    const lo = app.base ? app.base.lo : 0, hi = app.base ? app.base.hi : 1;
    return { map: layerMap(app.medium), n: L.length, pick: app.layer, colors: L.map(l => app.base.cmap(Math.min(1, Math.max(0, (l[key] - lo) / Math.max(hi - lo, 1e-9))))) };
  }
  function applyMediumView() {
    const inMedium = Story.chapter && Story.chapter.id === "medium" && !Story.onCover;
    const layers = inMedium && app.mediumView === "layers" && app.medium && ((app.medium.meta.strata || {}).layers || []).length > 0;
    app.scene.setStrata(layers ? strataSpec() : null);
    if (layers && app.layer >= 0) app.scene.pickLayer(app.layer);
    document.querySelectorAll("[data-medium-view]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mediumView === app.mediumView)));
  }
  // the viewer's callout beside the picked layer: L<k> · WAVE & MESH, with the design target and the oversampling
  function calloutHtml(k) {
    const L = app.medium.meta.strata.layers[k], c = app.family.clock, wave = (L.sections.find(s => s[0] === "WAVE & MESH") || [null, []])[1];
    const nodes = parseFloat(((wave.find(r => r[0].startsWith("Nodes")) || [])[1] || "").replace(/,/g, "")), design = c.n_lambda;
    const rows = [["f<sub>max</sub>", `${c.fmax.toFixed(3)} Hz`], ...wave.filter(r => !r[0].startsWith("CFL")).map(r => [r[0], r[1]])];
    if (design && Number.isFinite(nodes)) rows.push(["Design target, slowest layer", `${design} nodes`], ["Oversampling vs design", `${(nodes / design).toFixed(2)}×`]);
    const cfl = wave.find(r => r[0] === "CFL"); if (cfl) rows.push(["CFL", cfl[1]]);
    return `<b>L${k + 1} · WAVE &amp; MESH</b><dl>${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("")}</dl>`;
  }
  function placeCallout() {
    const box = $("#strata-callout"), lead = $("#strata-leader");
    const on = app.stage === "block" && app.scene.strataOn && app.layer >= 0 && Story.chapter && Story.chapter.id === "medium" && !Story.onCover;
    box.hidden = lead.hidden = !on;
    if (!on) return;
    // beside the layer's east end if it fits before the panel, else beside its west end; the leader joins the two
    const w = box.offsetWidth, h = box.offsetHeight, GAP = 40, limit = Math.min(innerWidth, $("#panel").getBoundingClientRect().left) - 12;
    const east = app.scene.layerAnchor(app.layer), west = app.scene.layerAnchor(app.layer, true);
    const onRight = east.x + GAP + w <= limit || west.x - GAP - w < 8, a = onRight ? east : west;
    const x = onRight ? Math.min(a.x + GAP, limit - w) : a.x - GAP - w, y = Math.min(Math.max(a.y - h / 2, 70), innerHeight - h - 12);
    box.style.transform = `translate(${x}px, ${y}px)`;
    const from = onRight ? a.x : x + w, to = onRight ? x : a.x;
    lead.style.transform = `translate(${Math.min(from, to)}px, ${a.y}px)`; lead.style.width = `${Math.max(0, Math.abs(to - from))}px`;
  }
  function showLayer(k) {
    const L = ((app.medium.meta.strata || {}).layers || [])[k];
    app.layer = L ? k : -1;
    if (app.scene.strataOn) app.scene.pickLayer(app.layer);
    if (L) $("#strata-callout").innerHTML = calloutHtml(k);
    document.querySelectorAll("#layers tbody tr").forEach(tr => tr.classList.toggle("on", Number(tr.dataset.layer) === app.layer));
    paintField();
    // the full report goes in the panel, as the viewer's side panel holds it (a floating card would cover the layers)
    const report = $("#layer-report");
    report.hidden = !L;
    if (!L) return;
    const chips = L.chips.map(([text, warn]) => `<span class="tag${warn ? " warn" : ""}">${text}</span>`).join("");
    const sections = L.sections.map(([title, items]) => `<h4>${title}</h4><dl>${items.map(([key, value, tip]) =>
      `<dt${tip ? ` title="${tip.replace(/"/g, "&quot;")}"` : ""}>${key}</dt><dd>${value}</dd>`).join("")}</dl>`).join("");
    report.innerHTML = `<div class="layer-head"><b>${L.title}</b><span>${L.subtitle}</span><button type="button" class="step" data-action="layer-close" aria-label="Let the layer go">×</button></div>` +
      `<div class="tags">${chips}</div>${sections}<p class="note">The viewer's STRATIGRAPHY tab, word for word. Hover a name for its formula.</p>`;
    report.scrollIntoView({ block: "nearest" });
  }

  function paintField() {
    const painted = cellColors(app.medium.input, app.field), spec = FIELDS[app.field];
    app.base = painted;                                                // the solver chapter draws the wave over these colours
    if (app.site && app.site.cut.mode !== "none") feedSection();
    if (!(Story.chapter && Story.chapter.id === "solver" && app.wave)) app.scene.setMedium(painted.mask, highlightLayer(painted.rgba));
    if (app.scene.strataOn) app.scene.setStrata(strataSpec());          // the layers apart take the field's colours too
    else drawWaveFrame(Timeline.time);
    const ramp = `linear-gradient(to right, ${d3.range(0, 1.0001, 0.1).map(t => painted.cmap(t)).join(", ")})`;
    const fmt = v => Math.round(v).toLocaleString("en-US");
    $("#legend-ramp").style.background = ramp; $("#ramp").style.background = ramp;
    $("#legend-title").textContent = spec.label;
    $("#legend-range").textContent = `${fmt(painted.lo)}–${fmt(painted.hi)} ${spec.unit}`;
    $("#ramp-min").textContent = fmt(painted.lo); $("#ramp-max").textContent = `${fmt(painted.hi)} ${spec.unit}`;
    document.querySelectorAll("[data-field]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.field === app.field)));
    app.painted = { field: app.field, lo: painted.lo, hi: painted.hi };
  }

  const num = v => (Math.round(v) || 0).toLocaleString("en-US");     // || 0: never "-0"      // one number format everywhere: 1,478
  function stat(value, label) { return `<div class="stat"><b>${value}</b><span>${label}</span></div>`; }

  function describeMedium(meta) {
    const km = m => (m / 1000).toFixed(2);
    $("#layers tbody").innerHTML = meta.layers.map((l, k) => {
      const depth = l.bottom_m == null ? `below ${km(l.top_m)} km` : `${km(l.top_m)}–${km(l.bottom_m)} km`;
      return `<tr data-layer="${k}"><td>${k + 1}</td><td>${depth}</td><td>${num(l.vp)}</td><td>${num(l.vs)}</td>` +
             `<td>${num(l.rho)}</td><td>${l.nu == null ? "—" : l.nu.toFixed(3)}</td></tr>`;
    }).join("");
    const fam = app.family, c = fam.clock;
    $("#medium-stats").innerHTML = stat(meta.layer_count, "layers, the deepest down to the floor") + stat(`${num(meta.surface_vs)} m/s`, "Vs of the surface layer") +
      stat(meta.vs_contrast.toFixed(2), "Vs deepest / surface") +
      stat(`${fam.grid.nx} × ${fam.grid.nz}`, `grid, dx = ${fam.grid.dx.toFixed(1)} m`);
    // the viewer's MODEL summary (grid, fmax, dt, realized CFL), and the clock it implies
    const summary = (meta.strata || {}).summary || [];
    $("#medium-model").innerHTML = `<dl>${summary.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}` +
      `<dt>Time steps nt</dt><dd>${c.nt.toLocaleString("en-US")} (${c.duration.toFixed(2)} s)</dd>` +
      `<dt>Network clock</dt><dd>${c.nt_model} steps, dt × ${c.factor}</dd>` +
      `<dt>Stability</dt><dd>CFL ≤ 1 for every layer</dd></dl>`;
    app.layer = -1;
    const split = meta.split === "test" ? "test split · never seen in training" : `${meta.split} split`;
    $("#medium-note").textContent = `Seed ${meta.seed} · ${split}. Depths are each interface's mean depth below the top of ` +
      `the grid; the interfaces follow the terrain.`;
    document.querySelectorAll("#medium-chips .chip").forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.seed) === meta.seed)));
  }

  // one medium's files, fetched once (the statistics chapter reads all six without repainting the block)
  function mediumData(seed) {
    app.mediaCache = app.mediaCache || new Map();
    if (!app.mediaCache.has(seed)) app.mediaCache.set(seed, (async () => {
      const meta = await (await fetch(`data/media/${seed}.json`)).json();
      const [input, query, fdm] = await Promise.all([meta.files.medium, meta.files.query, meta.files.fdm].map(Infer.fetchFloats));
      const fam = app.family, nr = fam.receivers.x.length, nt = fam.clock.nt, np = fam.spectra.periods.length;
      return { seed, meta, input, query, fdm: { acc: fdm.subarray(0, nr * 2 * nt), sa: fdm.subarray(nr * 2 * nt, nr * 2 * nt + nr * 2 * np) }, net: null };
    })());
    return app.mediaCache.get(seed);
  }
  async function loadMedium(seed) {
    const entry = app.index.media.find(m => m.seed === seed) || app.index.media.find(m => m.seed === app.index.default);
    seed = entry.seed;
    app.medium = await mediumData(seed);
    const meta = app.medium.meta;
    app.seed = seed;
    if (app.layer >= 0) { app.layer = -1; $("#layer-report").hidden = true; }   // another medium, other layers
    paintField();
    describeMedium(meta);
    Story.setParams({ seed });
    return app.medium;
  }

  async function networkFor(medium) {
    if (medium.net) return medium.net;
    await app.networkReady;
    status(`Running the network on medium ${medium.seed}…`, null);
    await new Promise(r => setTimeout(r, 0));                          // let the status paint before the encoder blocks
    medium.net = await Infer.run(medium.seed, medium.input, medium.query);
    app.timings.encoder_ms = medium.net.encoder_ms; app.timings.decoder_ms = medium.net.decoder_ms;
    status(null);
    return medium.net;
  }

  // ---------------------------------------------------------------- receiver
  function reference(k) {
    const fam = app.family, nt = fam.clock.nt, np = fam.spectra.periods.length, f = app.medium.fdm;
    return { acceleration: [0, 1].map(c => f.acc.subarray((k * 2 + c) * nt, (k * 2 + c + 1) * nt)),
             sa_g: [0, 1].map(c => f.sa.subarray((k * 2 + c) * np, (k * 2 + c + 1) * np)) };
  }

  function showReceiver(k) {
    const fam = app.family, nr = fam.receivers.x.length;
    k = Math.max(0, Math.min(nr - 1, k));
    app.rx = k;
    app.scene.setSelected(k);
    Story.setParams({ rx: k + 1 });
    if (!app.medium || !app.medium.net) return;
    const start = performance.now();
    const rec = DSP.receiver(app.medium.net.velocity, k, fam), ref = reference(k), g = fam.spectra.g;
    const metrics = [0, 1].map(c => {
      const r = DSP.pearson(rec.acceleration[c], ref.acceleration[c]), fdmPga = DSP.peakAbs(ref.acceleration[c]) / g;
      return { r, pga: rec.pga_g[c], fdmPga, time: `PGA ${rec.pga_g[c].toFixed(3)} g · FDM ${fdmPga.toFixed(3)} g`, spectrum: "5 % damping" };
    });
    Records.render($("#records"), fam, rec, ref, metrics);
    $("#rx-name").textContent = fam.receivers.labels[k];
    $("#rx-place").textContent = `x = ${(fam.receivers.x[k] * fam.grid.dx / 1000).toFixed(2)} km along the section`;
    $("#rx-stats").innerHTML = stat(metrics[0].r.toFixed(2), "correlation a<sub>x</sub> with FDM") + stat(metrics[1].r.toFixed(2), "correlation a<sub>z</sub> with FDM") +
      stat(`${(app.medium.net.encoder_ms + app.medium.net.decoder_ms).toFixed(0)} ms`, Infer.live ? "network, all 39 receivers" : "network, all 39 receivers (measured offline)");
    $("#rx-prev").disabled = k === 0; $("#rx-next").disabled = k === nr - 1;
    // every receiver's Sa from the same forward pass (once per medium), all on one chart as the viewer draws them
    if (!app.medium.net.allSa) {
      const t0 = performance.now();
      app.medium.net.allSa = Array.from({ length: nr }, (_, j) => (j === k ? rec : DSP.receiver(app.medium.net.velocity, j, fam)).sa_g);
      app.timings.all_spectra_ms = performance.now() - t0;
    }
    const xs = fam.receivers.x.map(c => c * fam.grid.dx / 1000);
    Records.allSpectra($("#all-spectra"), fam, app.medium.net.allSa, k, xs, app.theme === "light", j => showReceiver(j));
    $("#all-ramp-min").textContent = `x = ${Math.min(...xs).toFixed(2)} km`; $("#all-ramp-max").textContent = `${Math.max(...xs).toFixed(2)} km`;
    app.metrics = metrics;
    app.lastRender = { rx: k, seed: app.seed, ms: performance.now() - start, at: performance.now() };
  }

  function selectReceiver(k) {
    if (Story.chapter && Story.chapter.id === "network") {           // the query is for this receiver: probe again
      app.rx = Math.max(0, Math.min(app.family.receivers.x.length - 1, k));
      app.scene.setSelected(app.rx); Story.setParams({ rx: app.rx + 1 }); networkContext(); return;
    }
    if (Story.chapter && Story.chapter.id === "stats") {             // the statistics follow the receiver, in place
      app.rx = Math.max(0, Math.min(app.family.receivers.x.length - 1, k));
      app.scene.setSelected(app.rx); Story.setParams({ rx: app.rx + 1 }); Stats.select(app.seed, app.rx); return;
    }
    if (Story.chapter && Story.chapter.id === "solver") {             // in the solver chapter a click picks the record to watch
      app.rx = Math.max(0, Math.min(app.family.receivers.x.length - 1, k));
      app.scene.setSelected(app.rx); Story.setParams({ rx: app.rx + 1 }); drawRecording(); return;
    }
    if (Story.chapter && Story.chapter.id !== "receiver") Story.go("receiver");
    showReceiver(k);
  }

  // ---------------------------------------------------------------- small d3 charts of the source and solver chapters
