// Surrogate Explorer · app.js — the data, the scene and the chapters, wired together.
//
// The scene is created once and every chapter re-uses it (story.js does the navigation). The network loads in the
// background while the cover is up; the chapters that need it wait for it.
// window.__app exposes the page to the tests (web/tests/test_page.py).
(function () {
  "use strict";
  const FIELDS = {
    vp: { label: "Vp", unit: "m/s", channel: 0, cmap: () => d3.interpolateViridis },
    vs: { label: "Vs", unit: "m/s", channel: 1, cmap: () => d3.interpolateViridis },
    rho: { label: "ρ", unit: "kg/m³", channel: 2, cmap: () => d3.interpolateCividis },
  };
  const DEPTHS = [{ m: Infinity, label: "Full · 6 km" }, { m: 2000, label: "Top 2 km" }, { m: 1000, label: "Top 1 km" }];
  const $ = sel => document.querySelector(sel);
  const app = { userOpacity: 1, ready: false, family: null, index: null, medium: null, seed: null, rx: 19, field: "vs", depth: Infinity, waveComp: "vz",
                theme: "dark", timings: {}, errors: [], lastRender: null, networkReady: null, labelSize: new Map() };
  window.__app = app;

  // ---------------------------------------------------------------- theme
  function themeTokens() {
    const css = getComputedStyle(document.documentElement), get = n => css.getPropertyValue(n).trim();
    return { viewport: get("--view"), accent: get("--accent"), ink: get("--ink") };
  }
  function storedTheme() { try { return localStorage.getItem("explorer-theme"); } catch (e) { return null; } }
  function applyTheme(name, persist = true) {
    app.theme = name === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = app.theme;
    if (persist) { try { localStorage.setItem("explorer-theme", app.theme); } catch (e) { /* private mode */ } }
    if (app.scene) app.scene.setTheme(themeTokens());
    if (app.globe) app.globe.redraw();
    if (app.earth) app.earth.paint().catch(fail);
    if (app.site) app.site.setTheme(app.theme);
    if (typeof Network !== "undefined") Network.setTheme(app.theme);
    if (app.medium && Story.chapter && Story.chapter.id === "receiver") showReceiver(app.rx);
    if (Story.chapter && Story.chapter.id === "cpml" && CPML.ready) { CPML.redraw(); CPML.draw(Timeline.time || 0); }
  }

  // ---------------------------------------------------------------- status
  function status(text, fraction) {
    $("#status").hidden = !text;
    $("#status-text").textContent = text || "";
    $("#status-track").hidden = fraction == null;
    $("#status-bar").style.width = fraction == null ? "0" : `${Math.round(fraction * 100)}%`;
  }
  function fail(error) {
    console.error(error);
    app.errors.push(String(error && error.message || error));
    status(`Something went wrong: ${error.message || error}`, null);
  }

  // ---------------------------------------------------------------- layout: tell the stages what the panels cover
  function updateInset() {
    if (!app.scene) return;
    const W = innerWidth, H = innerHeight, panel = $("#panel").getBoundingClientRect(), top = $(".top").getBoundingClientRect();
    const narrow = W <= 860, onCover = Story.onCover, bar = document.body.classList.contains("has-timeline") ? $("#timeline").getBoundingClientRect() : null;
    // what covers the bottom: the play bar when it is up, else the panel (phone) or the corner globe (a narrow desktop)
    const lowest = Math.min(narrow ? panel.top : H - 24, bar ? bar.top - 4 : H);
    const corner = !narrow && W - panel.left + 8 > W * 0.42 ? 180 : 0;
    const inset = onCover ? { left: 0, right: 0, top: 0, bottom: 0 }
      : narrow ? { left: 0, right: 0, top: top.bottom + 8, bottom: H - lowest + 8 }
      : { left: 0, right: document.body.classList.contains("panel-folded") ? 0 : W - panel.left + 8, top: top.bottom + 40, bottom: Math.max(H - lowest + 8, corner) };
    app.scene.setInset(inset);
    if (typeof Network !== "undefined") Network.setInset(inset);         // the film's scene frames the free area too
    for (const stage of [app.earth, app.site]) if (stage) stage.setInset(inset);
  }

  // the Earth's sunlight: the story's afternoon or now; the note says where the sun stands overhead and when
  function markSun() {
    if (!app.earth) return;
    const s = app.earth.sun, t = new Date(s.instant), deg = (v, p, n) => `${Math.abs(v).toFixed(1)}° ${v >= 0 ? p : n}`;
    document.querySelectorAll("[data-sun]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.sun === s.mode)));
    const when = s.mode === "now" ? `now, ${t.toISOString().slice(11, 16)} UTC` : "15:37 in Quito on an August afternoon";
    $("#sun-note").textContent = `The sun is overhead at ${deg(s.lat, "N", "S")}, ${deg(s.lon, "E", "W")}: ${when}.`;
  }

  // ---------------------------------------------------------------- stages: Earth, Quito, the block (cross-faded)
  const STAGE_IDS = { earth: "#earth-stage", site: "#site-stage", block: "#scene", net: "#net-stage", cpml: "#cpml-stage" };
  function setStage(name) {
    if (app.stage === name) return;
    app.stage = name;
    for (const [key, id] of Object.entries(STAGE_IDS)) $(id).classList.toggle("on", key === name);
    if (app.earth) app.earth.setActive(name === "earth");
    if (app.site) app.site.setActive(name === "site");
    $("#site-labels").classList.toggle("off", name !== "site");
    $("#hover").hidden = true;                                         // nothing of the previous stage stays on screen
    if (name !== "site") { $("#minimap").hidden = true; $("#globe").hidden = name === "net" || name === "cpml"; hideCard(); $("#dock").hidden = true; $("#tools-btn").setAttribute("aria-expanded", "false"); }   // the film needs its corner
    if (name !== "block") $("#rx-label").hidden = true;
    document.body.dataset.stage = name;
    wakeHint();
    applyOrbit();
  }
  // the controls' hint: full for a few seconds on each new stage, then faint (the first drag or wheel dims it at once)
  let hintTimer = 0;
  function wakeHint() {
    document.body.classList.remove("hint-dim"); clearTimeout(hintTimer);
    hintTimer = setTimeout(() => document.body.classList.add("hint-dim"), 7000);
  }
  function orbitWanted() { return $("#orbit-btn").getAttribute("aria-pressed") === "true"; }
  function applyOrbit() {
    const on = orbitWanted() || Story.onCover;
    if (app.scene) app.scene.setOrbit(on && app.stage === "block");
    if (app.site) app.site.setOrbit(on && app.stage === "site");
    if (app.earth) app.earth.setOrbit(on && app.stage === "earth");
  }

  // ---------------------------------------------------------------- medium
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
  function frameChart(svgNode, spec) {
    const svg = d3.select(svgNode), width = svgNode.clientWidth || 420, height = svgNode.clientHeight || 170;
    const m = { top: spec.legend ? 24 : 12, right: 12, bottom: 36, left: 50 }, w = width - m.left - m.right, h = height - m.top - m.bottom;
    svg.attr("viewBox", `0 0 ${width} ${height}`).selectAll("*").remove();
    const g = svg.append("g").attr("transform", `translate(${m.left},${m.top})`);
    const x = d3.scaleLinear().domain(spec.xDomain).range([0, w]), y = d3.scaleLinear().domain(spec.yDomain).range([h, 0]).nice();
    g.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(4).tickSize(-w).tickFormat(""));
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(6));
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat(d3.format("~g")));
    g.append("text").attr("class", "axis-label").attr("x", w).attr("y", h + 32).attr("text-anchor", "end").text(spec.xLabel);
    g.append("text").attr("class", "axis-label").attr("transform", `translate(${-m.left + 12},${h / 2}) rotate(-90)`).attr("text-anchor", "middle").text(spec.yLabel);
    // the legend sits above the plot, where the time cursor (y from 0 to h) never crosses it
    if (spec.legend) g.append("text").attr("class", "legend-text").attr("x", w).attr("y", -10).attr("text-anchor", "end").text(spec.legend);
    return { g, x, y, w, h };
  }
  function cursorOn(chart, t) {
    chart.cursor = chart.cursor || chart.g.append("line").attr("class", "cursor").attr("y1", 0).attr("y2", chart.h);
    const px = chart.x(Math.min(Math.max(t, chart.x.domain()[0]), chart.x.domain()[1]));
    chart.cursor.attr("x1", px).attr("x2", px);
    if (chart.future) chart.future.attr("x", px).attr("width", Math.max(0, chart.w - px));
  }

  // ---------------------------------------------------------------- the source
  // the rupture as the deck's slide 23 reads it: s along the fault from the hypocentre, ŵ_k, τ_k, and the order the
  // front reaches the subsources in (k = 1 is the hypocentre)
  function rupturePlan() {
    const f = app.family, r = f.rupture, [hx, hz] = f.source.hypocenter, dx = f.grid.dx, dz = f.grid.dz;
    const along = r.x.map((x, i) => Math.hypot((x - hx) * dx, (r.z[i] - hz) * dz) / 1000);
    const order = r.activation_s.map((a, k) => k).sort((i, j) => r.activation_s[i] - r.activation_s[j]);
    // local rupture speed between subsources four apart in activation order (closer ones are a cell or two apart and the
    // stored times are rounded: too noisy); it lands within a few % of the generator's own 1050–1780 m/s
    const speed = [];
    for (let j = 4; j < order.length; j++) {
      const a = order[j - 4], b = order[j], dt = r.activation_s[b] - r.activation_s[a];
      if (dt > 1e-6) speed.push(Math.abs(along[b] - along[a]) * 1000 / dt);
    }
    const xs = r.x.map(i => i * dx), zs = r.z.map(i => i * dz), k0 = order[0], k1 = order[order.length - 1];
    const dip = Math.atan2(Math.abs(zs[k1] - zs[k0]), Math.abs(xs[k1] - xs[k0])) * 180 / Math.PI;
    const dipDir = (xs[k1] - xs[k0]) * (zs[k1] - zs[k0]) > 0 ? "east" : "west";   // the section runs west -> east
    return { along, act: r.activation_s, w: r.weights, order, end: Math.max(...r.activation_s), speed, dip, dipDir, length: Math.max(...along) };
  }
  function describeSource() {
    const f = app.family, dz = f.grid.dz, plan = rupturePlan(), F = f.source.force_amplitude_n_per_m;
    const [lo, hi] = d3.extent(plan.speed), hypoDepth = f.source.hypocenter[1] * dz - Math.min(...f.surface_index) * dz;
    const sci = v => { const e = Math.floor(Math.log10(v)); return `${(v / 10 ** e).toFixed(3)} × 10<sup>${e}</sup>`; };
    stats("#source-stats", [[`${num(plan.length * 1000)} m`, "fault length, blind"], [`${plan.dip.toFixed(0)}°`, `dip, down to the ${plan.dipDir}`],
      [`${(hypoDepth / 1000).toFixed(1)} km`, "hypocentre under the surface"], [`${f.rupture.x.length}`, "subsources, one Ricker each"],
      [`≈ ${num(Math.round(lo / 50) * 50)}–${num(Math.round(hi / 50) * 50)} m/s`, "rupture speed, down-dip"], [`${plan.end.toFixed(2)} s`, "rupture duration"],
      [F ? `${sci(F)} N/m` : "fixed", "F, force amplitude, set once"], ["nothing", "changes per sample: geometry, τ<sub>k</sub> and F are fixed"]]);
  }
  const ricker = (t, f0, t0) => { const a = Math.PI * f0 * (t - t0); return (1 - 2 * a * a) * Math.exp(-a * a); };
  function drawSourceCharts() {
    const f = app.family, f0 = f.source.f0, t0 = f.source.t0, plan = rupturePlan(), wMax = Math.max(...plan.w), n = plan.order.length;
    const T = Math.round((plan.end + 2 * t0 + 0.1) * 10) / 10;
    // 1 · the cascade: 45 copies of one Ricker, each shifted by τ_k and scaled by ŵ_k, top (k = 1, the hypocentre) to bottom
    const cc = frameChart($("#cascade-chart"), { xDomain: [0, T], yDomain: [n + 1.5, -0.5], xLabel: "t [s]", yLabel: "subsource k (1 = hypocentre)",
                                                legend: "45 copies of one Ricker, delayed by τ_k, scaled by ŵ_k" });
    const ts = d3.range(0, T + 1e-9, 0.005), amp = 2.6;
    const clip = `cascade-clip-${Date.now()}`;
    cc.g.append("clipPath").attr("id", clip).append("rect").attr("x", 0).attr("y", -20).attr("height", cc.h + 40).attr("width", 0);
    const lines = cc.g.append("g").attr("clip-path", `url(#${clip})`);
    plan.order.forEach((k, j) => {
      const s = plan.w[k] / wMax * amp, tau = plan.act[k];
      lines.append("path").attr("class", "cascade").attr("d", d3.line().x(t => cc.x(t)).y(t => cc.y(j + 1 - s * ricker(t - tau, f0, t0)))(ts.filter(t => t >= tau - 0.02 && t <= tau + 2 * t0 + 0.05)));
    });
    cc.reveal = cc.g.select(`#${clip} rect`);
    // 2 · the share of the force along the fault (Eshelby: elliptical, zero at both tips)
    const wc = frameChart($("#weights-chart"), { xDomain: [0, plan.length * 1.03], yDomain: [0, wMax * 100 * 1.12], xLabel: "distance along the fault s [km]", yLabel: "ŵ_k [%]" });
    const bars = wc.g.selectAll("line.wbar").data(plan.order).join("line").attr("class", "wbar")
      .attr("x1", k => wc.x(plan.along[k])).attr("x2", k => wc.x(plan.along[k])).attr("y1", wc.h).attr("y2", k => wc.y(plan.w[k] * 100));
    // 3 · when the front reaches each point: τ_k, against a front at the mean speed (dashed)
    const vMean = plan.length * 1000 / plan.end;
    const ac = frameChart($("#activation-chart"), { xDomain: [0, plan.length * 1.03], yDomain: [0, plan.end * 1.08], xLabel: "distance along the fault s [km]", yLabel: "τ_k [s]",
                                                    legend: `dashed: a uniform ${num(Math.round(vMean / 10) * 10)} m/s front` });
    ac.g.append("path").attr("class", "uniform").attr("d", d3.line()([[ac.x(0), ac.y(0)], [ac.x(plan.length), ac.y(plan.length * 1000 / vMean)]]));
    ac.g.append("path").attr("class", "terrain").attr("d", d3.line().x(k => ac.x(plan.along[k])).y(k => ac.y(plan.act[k]))(plan.order));
    const dots = ac.g.selectAll("circle").data(plan.order).join("circle").attr("class", "act")
      .attr("cx", k => ac.x(plan.along[k])).attr("cy", k => ac.y(plan.act[k])).attr("r", k => 1.6 + 3.4 * plan.w[k] / wMax);
    ac.front = ac.g.append("line").attr("class", "cursor").attr("x1", 0).attr("x2", ac.w);   // time runs up this chart
    // 4 · the pulse itself
    const rs = d3.range(0, 2 * t0 + 1e-9, 0.004);
    const rc = frameChart($("#ricker-chart"), { xDomain: [0, 2 * t0], yDomain: [-0.5, 1.05], xLabel: "t − τ_k [s]", yLabel: "r(t)" });
    rc.g.append("path").attr("class", "trace-z").attr("d", d3.line().x(t => rc.x(t)).y(t => rc.y(ricker(t, f0, t0)))(rs));
    app.sourceCharts = { cc, wc, ac, bars, dots, plan };
  }
  function sourceTime(t) {
    app.scene.setRuptureTime(t);
    const s = app.sourceCharts;
    if (!s) return;
    s.cc.reveal.attr("width", Math.max(0, s.cc.x(Math.min(t, s.cc.x.domain()[1]))));
    cursorOn(s.cc, t);
    s.bars.attr("class", k => (s.plan.act[k] <= t ? "wbar on" : "wbar"));
    s.dots.attr("class", k => (s.plan.act[k] <= t ? "act on" : "act"));
    const y = s.ac.y(Math.min(t, s.ac.y.domain()[1])); s.ac.front.attr("y1", y).attr("y2", y);
  }

  // ---------------------------------------------------------------- the solver's wavefield
  async function waveFor(seed, comp) {
    const entry = app.waveIndex && app.waveIndex.media.find(m => m.seed === seed);
    if (!entry) return null;
    app.waveCache = app.waveCache || {};
    const key = `${seed}.${comp}`;
    if (!app.waveCache[key]) { status(`Loading the wavefield of seed ${seed} (${comp})…`, null); app.waveCache[key] = await Wave.load(entry, comp); status(null); }
    return { entry, data: app.waveCache[key] };
  }
  function drawWaveFrame(t) {
    if (!app.wave || !app.base) return;
    const f = app.family, nx = f.grid.nx, nz = f.grid.nz, frame = Wave.frameAt(app.wave.data, t);
    app.waveOut = Wave.compose(app.wave.data, frame, app.base.rgba, app.base.mask, nx, nz, 0.035 * app.scene.floor, app.waveOut || {});
    app.scene.setMedium(app.base.mask, app.waveOut.rgba);
    app.scene.setLift(app.waveOut.lift);
    app.scene.setRuptureTime(t);
    app.waveFrame = frame;
    if (app.recordChart) cursorOn(app.recordChart, t);
  }
  const RECORD_LEGEND = "FDM · horizontal (blue), vertical (red)";
  function drawRecording() {
    if (!app.medium) return;
    const f = app.family, nt = f.clock.nt, dt = f.clock.dt, k = app.rx, acc = app.medium.fdm.acc;
    const ax = acc.subarray((k * 2) * nt, (k * 2 + 1) * nt), az = acc.subarray((k * 2 + 1) * nt, (k * 2 + 2) * nt);
    const peak = Math.max(DSP.peakAbs(ax), DSP.peakAbs(az)) * 1.08;
    const chart = frameChart($("#recording-chart"), { xDomain: [0, f.clock.duration], yDomain: [-peak, peak], xLabel: "t [s]", yLabel: "a [m/s²]", legend: RECORD_LEGEND });
    const step = 3, pts = a => d3.range(0, nt, step).map(i => [i * dt, a[i]]), line = d3.line().x(d => chart.x(d[0])).y(d => chart.y(d[1]));
    chart.g.append("path").attr("class", "trace-x").attr("d", line(pts(ax)));
    chart.g.append("path").attr("class", "trace-z").attr("d", line(pts(az)));
    chart.future = chart.g.append("rect").attr("class", "future").attr("y", 0).attr("height", chart.h);
    app.recordChart = chart;
    $("#recording-title").textContent = `What ${f.receivers.labels[k]} records`;
    cursorOn(chart, Timeline.time);
  }
  function describeSolver(entry) {
    const f = app.family, solid = app.base ? app.base.mask.reduce((s, v) => s + (v > 0.5 ? 1 : 0), 0) : 0;
    stats("#solver-stats", [[`${f.grid.nx} × ${f.grid.nz}`, `cells, ${solid.toLocaleString("en-US")} of them solid`],
      [`${f.clock.nt.toLocaleString("en-US")}`, `time steps of ${(f.clock.dt * 1000).toFixed(3)} ms`],
      [`${entry ? entry.frames : "—"}`, "snapshots shown, every 20 steps"], [`${entry ? Math.round(entry.run_seconds) : "—"} s`, "CPU for this replay (Python)"]]);
    document.querySelectorAll("#wave-chips .chip").forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.seed) === app.seed)));
  }
  function waveLegend() {
    if (!app.wave) return;
    const comp = app.waveComp, clip = app.wave.entry.clip[comp];
    $("#legend-title").innerHTML = comp === "vz" ? "v<sub>z</sub>" : "v<sub>x</sub>";
    $("#legend-ramp").style.background = `linear-gradient(to right, ${Wave.SIGNED.join(", ")})`;
    $("#legend-range").textContent = `±${clip.toFixed(3)} m/s`;
    $("#wave-range").textContent = `±${clip.toFixed(3)} m/s`;
  }
  async function enterSolver() {
    const ids = app.waveIndex ? app.waveIndex.media.map(m => m.seed) : [];
    if (!ids.length) { describeSolver(null); return; }
    const asked = app.seed;
    if (!ids.includes(app.seed)) { app.seedBefore = app.seed; await loadMedium(ids[0]); }
    $("#solver-note").hidden = asked === app.seed;
    $("#solver-note").textContent = `Seed ${asked} has no stored replay, so this chapter shows seed ${app.seed}; pick another above.`;
    app.wave = await waveFor(app.seed, app.waveComp);
    if (!(Story.chapter && Story.chapter.id === "solver")) return;     // left while loading
    Story.setParams({ rx: app.rx + 1 });
    describeSolver(app.wave.entry);
    waveLegend();
    drawRecording();
    Timeline.use({ duration: app.wave.entry.times[app.wave.entry.times.length - 1], label: "simulated time", speeds: [0.25, 0.5, 1], speed: 0.5,
                   onTime: drawWaveFrame });
    updateInset();                                                     // the play bar arrived after the chapter's own layout pass
    Timeline.autoplay(() => Story.chapter && Story.chapter.id === "solver", 500);
  }
  function leaveSolver() {
    Timeline.release(); restoreSeed();
    app.wave = null;
    app.scene.setLift(null); app.scene.setRuptureTime(null); app.scene.setSourceView(false);
    if (app.medium) paintField();                                      // the medium's own colours and legend, from scratch
  }
  // the rupture lies 2.5–4.8 km deep: the source and solver chapters always show the whole depth
  function wholeDepth() {
    if (!isFinite(app.depth)) return;
    app.depth = Infinity; app.scene.setFloor(Infinity); markDepth(); Story.setParams({ depth: null });
  }

  // ---------------------------------------------------------------- overlays that follow the camera
  function niceLength(metres) {
    const p = Math.pow(10, Math.floor(Math.log10(metres))), m = metres / p;
    return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
  }
  function navAids(info) {
    const length = niceLength(120 * info.metresPerPx);
    $("#scalebar").style.width = `${length / info.metresPerPx}px`;
    $("#scalebar-label").textContent = length >= 1000 ? `${length / 1000} km` : `${length} m`;
    $("#needle").setAttribute("transform", `rotate(${info.northDeg.toFixed(1)})`);
  }
  function onFrame() {
    if (app.stage !== "block") return;
    const label = $("#rx-label"), inChapter = Story.chapter && Story.chapter.id === "receiver" && !Story.onCover;
    if (inChapter) {
      const s = app.scene.labelScreen(app.rx);
      label.hidden = false; label.textContent = app.family.receivers.labels[app.rx];
      label.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -100%)`;
    } else label.hidden = true;
    placeCallout();
    // the source chapter: the front's label rides with it, as in the deck's GIF ("rupture front: 1 715 m down-dip")
    const front = Story.chapter && Story.chapter.id === "source" && !Story.onCover ? app.scene.frontInfo() : null, fl = $("#front-label");
    fl.hidden = !front;
    if (front) { fl.textContent = `t = ${Timeline.time.toFixed(2)} s · front ${num(front.along_m)} m down-dip`; fl.style.transform = `translate(${front.screen.x + 18}px, ${front.screen.y}px) translate(0, -50%)`; }
    navAids(app.scene.overlayInfo());
  }
  function onSiteFrame() {
    if (app.stage !== "site") return;
    $("#rx-label").hidden = true;
    const box = $("#site-labels"), info = app.site.overlayInfo();
    box.classList.toggle("hold", !!app.labelHold);                    // the dive: no labels until the ground has risen
    const zonesOn = Story.chapter && Story.chapter.id === "quito" && info.distance > 14 && app.site.show.zones;
    // A21: no label under the top bar, the panel, a card, the dock, the play bar or the corner, and none on another.
    // labels() comes in priority order (A, B, the segment, the fault, the zones); a label that collides above its anchor
    // tries below it, then hides. All the rectangles are read before any label moves.
    const pad = 3, taken = [".top", "#panel", "#card", "#dock", "#timeline", "#globe", "#minimap"].map(s => $(s)).filter(e => e && !e.hidden)
      .map(e => e.getBoundingClientRect()).filter(r => r.width && r.height).map(r => [r.left, r.top, r.right, r.bottom]);
    const free = b => b[0] >= 0 && b[1] >= 0 && b[2] <= innerWidth && b[3] <= innerHeight &&
      !taken.some(t => b[0] < t[2] + pad && b[2] > t[0] - pad && b[1] < t[3] + pad && b[3] > t[1] - pad);
    const placed = [];
    const live = new Set();
    for (const l of app.site.labels()) {
      live.add(l.id);
      let el = box.querySelector(`[data-id="${l.id}"]`);
      if (!el) { el = document.createElement("span"); el.dataset.id = l.id; el.className = l.cls || ""; box.appendChild(el); }
      if (el.textContent !== l.text) { el.textContent = l.text; app.labelSize.delete(l.id); }
      const shown = l.rx ? app.site.show.receivers && (info.distance < RX_LABELS_KM || l.k === app.rx && app.site.halo === l.k) : l.trace ? app.site.show.planes
        : l.id === "fault" ? app.site.show.faults : l.id === "segment" || l.id === "A" || l.id === "B" ? app.site.show.section : !l.zone || zonesOn;
      let at = null;
      if (l.text && l.screen.visible && shown) {
        if (!app.labelSize.has(l.id)) app.labelSize.set(l.id, [el.offsetWidth, el.offsetHeight]);
        const [w, h] = app.labelSize.get(l.id), { x, y } = l.screen;
        for (const [top, shift] of [[y - h, "-100%"], [y + 6, "6px"]]) {
          const b = [x - w / 2, top, x + w / 2, top + h];
          if (free(b)) { at = shift; taken.push(b); placed.push(l.id); break; }
        }
        if (at) el.style.transform = `translate(${x}px, ${y}px) translate(-50%, ${at})`;
      }
      el.style.visibility = at ? "visible" : "hidden";
    }
    // a label that left the list (a fault trace once its cut is gone) must not stay where it last was
    for (const el of box.children) if (!live.has(el.dataset.id)) el.style.visibility = "hidden";
    app.labelsPlaced = placed;                                         // for the tests
    navAids(info);
    // the corner: the globe from afar, a mini-map once the camera is close (as the SRF Explorer does)
    const mini = info.distance < 40;
    $("#minimap").hidden = !mini; $("#globe").hidden = mini;
    if (mini) app.site.drawMiniMap($("#minimap"));
  }

  // ---------------------------------------------------------------- the map's panels
  function stats(id, items) { $(id).innerHTML = items.map(([v, l]) => stat(v, l)).join(""); }
  const latLon = (x, y) => {                                         // local km -> degrees (UTM at the equator: a metre is a metre)
    const [lon0, lat0] = app.siteData.origin_lon_lat;
    const lat = lat0 + y / 110.574, lon = lon0 + x / (111.320 * Math.cos(lat0 * Math.PI / 180));
    return `${Math.abs(lat).toFixed(4)}° ${lat < 0 ? "S" : "N"}, ${Math.abs(lon).toFixed(4)}° ${lon < 0 ? "W" : "E"}`;
  };
  function describeSite() {
    const s = app.siteData, seg = s.segment, f = app.family;
    const mid = [(seg.start_lon_lat[0] + seg.end_lon_lat[0]) / 2, (seg.start_lon_lat[1] + seg.end_lon_lat[1]) / 2];
    stats("#earth-stats", [[`${Math.abs(mid[1]).toFixed(3)}° S, ${Math.abs(mid[0]).toFixed(3)}° W`, "segment 3, centre"], [`${s.section.length_km.toFixed(1)} km`, "section A–B, west to east"],
                           [`${(seg.length_m / 1000).toFixed(1)} km`, "segment 3, the model's width"]]);
    const e = s.dem.elevation_range_m, w = s.dem.x_range_km[1] - s.dem.x_range_km[0], h = s.dem.y_range_km[1] - s.dem.y_range_km[0];
    stats("#quito-stats", [[`${w.toFixed(0)} × ${h.toFixed(0)} km`, "relief shown (DMQ polygon)"], [`${num(e[0])}–${num(e[1])} m`, "elevation a.s.l."],
                           [`${s.dem.pixel_m[0].toFixed(0)} m`, "Copernicus GLO-30 pixel"], [`${s.zones.length}`, "administrative zones"]]);
    $("#fault-table tbody").innerHTML = s.faults.map((fl, k) => `<tr data-fault="${k}"><td>${fl.id}</td><td>${fl.dip}° ${fl.dip_dir}</td>` +
      `<td>${fl.slip_rate_mm_yr ?? "—"}</td><td>${fl.magnitudes[1] ?? "—"}</td><td>${(+fl.length_km).toFixed(1)} km</td></tr>`).join("");
    if (s.faults[0]) $("#fault-name").textContent = s.faults[0].name;
    markPalette();
    const rows = f.surface_index, stepMax = Math.max(...rows);
    stats("#segment-stats", [[`${(seg.length_m / 1000).toFixed(1)} km`, "segment 3"], [`${Math.round(seg.relief_m)} m`, "relief along it"],
                             [`${f.grid.nx} columns`, `dx = ${f.grid.dx.toFixed(2)} m`], [`0–${stepMax} rows`, "the staircase surface"]]);
    const m = s.model, [ehx, ehy] = m.hypocentre_xy_km;
    $("#quake-table tbody").innerHTML = f.receivers.labels.map((lab, k) => {
      const d = f.receivers.x[k] * f.grid.dx / 1000, x = seg.xy_km[0][0] + seg.along[0] * d, y = seg.xy_km[0][1] + seg.along[1] * d;
      const repi = Math.hypot(x - ehx, y - ehy), rhyp = Math.hypot(repi, ((app.site ? app.site.heightAt(x, y) : m.epicentre_z_m) - m.hypocentre_z_m) / 1000);
      return `<tr data-rx="${k}"><td>${lab}</td><td>${d.toFixed(2)}</td><td>${repi.toFixed(2)}</td><td>${rhyp.toFixed(2)}</td></tr>`;
    }).join("");
    stats("#quake-stats", [[`${((m.top_elevation_m - m.hypocentre_z_m) / 1000).toFixed(2)} km`, "hypocentre under the grid's top"],
                           [`${num(m.epicentre_z_m)} m`, "epicentre elevation a.s.l."], [`${f.rupture.x.length}`, "point sources, in the section plane"],
                           [`${(m.depth_m / 1000).toFixed(1)} km`, "depth of the model"]]);
  }
  function markPalette() {
    const name = app.site ? app.site.palette : "map";
    document.querySelectorAll("[data-palette]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.palette === name)));
    $("#elev-ramp").style.background = Site.gradient(name);
    // the legend's ends: what the palette colours (the elevation; the open sky; the curvature, in 1/km at its clip)
    const e = app.siteData.dem.elevation_range_m, k = app.siteData.dem.curvature_clip_per_km;
    const ends = { ao: ["enclosed", "open sky"], curvature: [`valley −${k.toFixed(1)}/km`, `ridge +${k.toFixed(1)}/km`] }[name] || [`${num(e[0])} m`, `${num(e[1])} m`];
    $("#elev-min").textContent = ends[0]; $("#elev-max").textContent = ends[1];
    $("#palette-note").textContent = PALETTE_NOTES[name] || "";
  }
  const PALETTE_NOTES = {
    ao: "Ambient occlusion: a clay model lit only by the open sky above each point; ravines and the deep valleys go dark, open ground and crests stay pale. No sun.",
    curvature: "Curvature of the relief over ~150 m: ridges and spurs (convex) focus seismic waves and shake more; valleys and ravines (concave) spread them. One of the shapes behind topographic site effects.",
  };
  function markTools() {
    const sh = app.site.show;
    document.querySelectorAll("[data-show]").forEach(b => b.setAttribute("aria-pressed", String(!!sh[b.dataset.show])));
    const cut = app.site.cut, onAB = cut.mode === "south" && cut.off === app.site.sectionY;
    document.querySelectorAll("[data-cut]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.cut === cut.mode)));
    $("#section-switch").setAttribute("aria-checked", String(onAB));
    $("#buildings-switch").setAttribute("aria-checked", String(!!sh.buildings));
    // the position slider: north–south for South, west–east for East, an elevation for Top (none for None and Quadrant)
    const pos = $("#cut-pos"), out = $("#cut-pos-out");
    pos.disabled = !cut.range; $("#cut-pos-row").classList.toggle("off", !cut.range);
    if (cut.range) { pos.min = cut.range[0]; pos.max = cut.range[1]; pos.step = cut.mode === "top" ? 10 : 0.05; pos.value = cut.off; }
    out.textContent = cut.mode === "south" ? (onAB ? "on A–B" : `${Math.abs(cut.off - app.site.sectionY).toFixed(2)} km ${cut.off > app.site.sectionY ? "north" : "south"} of A–B`)
      : cut.mode === "east" ? (d => `${Math.abs(d).toFixed(2)} km ${d < 0 ? "west" : "east"} of A`)(cut.off - app.siteData.section.xy_km[0][0]) : cut.mode === "top" ? `${num(cut.off)} m a.s.l.` : "—";
    $("#opacity").value = String(app.userOpacity); $("#opacity-out").textContent = `${Math.round(app.userOpacity * 100)} %`;
  }
  function feedSection(rgba) {                                       // the block's medium (or a wave frame) in the section plane
    if (!app.site || !app.base) return;
    app.site.setSectionMedium(rgba || app.base.rgba, app.family.grid.nx, app.family.grid.nz, app.base.mask);
  }
  function setSection(on) { setCut(on ? "south" : "none", app.site.sectionY); }
  // B1: None, Quadrant, East, South (A–B at its home position) or Top; the faces show depth, and the medium where a face is A–B
  function setCut(mode, off) {
    app.site.setCut(mode, off); feedSection(); app.site.setMediumOn(mode !== "none");
    document.body.classList.toggle("section-on", mode !== "none"); markTools();
  }
  // the Tools dock under the top bar, the card under the dock (the top bar wraps on a phone)
  function placeFloats() {
    const top = $(".top").getBoundingClientRect().bottom + 8, dock = $("#dock");
    dock.style.top = `${top}px`;
    if (innerWidth > 860) $("#card").style.top = `${dock.hidden ? top : dock.getBoundingClientRect().bottom + 8}px`; else $("#card").style.top = "";
  }

  // ---------------------------------------------------------------- cards: everything on the map answers a click
  function showCard(kicker, title, html) {
    $("#card-kicker").textContent = kicker; $("#card-title").innerHTML = title; $("#card-body").innerHTML = html;
    // on a phone the card opens folded (its title; a tap unfolds it), so the map stays reachable
    $("#card").hidden = false; $("#card").classList.toggle("folded", innerWidth <= 860); placeFloats(); markFault(-1);   // a fault card marks its own
  }
  // "⌖ Site": down to one receiver, with a halo around its pin (the card stays, its title folded out of the way)
  function flySite(k) {
    if (!app.site || app.stage !== "site") return;
    app.rx = k; Story.setParams({ rx: k + 1 });
    app.flight = app.site.flyToReceiver(k);
  }
  const RX_LABELS_KM = 7;                                            // the 39 names show once the camera is this close
  // B7: a QR code of this very view (the URL carries chapter, medium, receiver, field, depth and theme)
  function showQr() {
    const url = location.href, qr = qrcode(0, "M");
    qr.addData(url); qr.make();
    $("#qr-code").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    $("#qr-link").textContent = url; $("#qr-link").href = url;
    $("#qr").hidden = false;
  }
  // the credits: under each portrait, a QR code of that person's GitHub (made here, by the same vendored qrcode as ▦)
  function githubCodes() {
    document.querySelectorAll("[data-github]").forEach(fig => {
      const url = fig.dataset.github, qr = qrcode(0, "M"); qr.addData(url); qr.make();
      const a = document.createElement("a"); a.className = "gh-qr"; a.href = url; a.target = "_blank"; a.rel = "noopener";
      a.title = url.replace("https://", ""); a.setAttribute("aria-label", `GitHub: ${url.replace("https://github.com/", "")}`);
      a.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true }) + `<span>${url.replace("https://github.com/", "@")}</span>`;
      fig.appendChild(a);
    });
  }
  function hideCard() { $("#card").hidden = true; markFault(-1); }
  // the fault a card describes: its row in the table and its trace on the map (A15)
  function markFault(k) {
    document.querySelectorAll("#fault-table tbody tr").forEach(tr => tr.classList.toggle("on", Number(tr.dataset.fault) === k));
    if (app.site) app.site.setHighlight(k);
  }
  const rows = items => `<dl>${items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const zoneAt = (x, y) => (app.siteData.zones.find(z => z.rings.some(r => pointInRing(x, y, r))) || {}).name;
  function distToLine(x, y, line) {
    let best = Infinity;
    for (let k = 1; k < line.length; k++) {
      const [ax, ay] = line[k - 1], [bx, by] = line[k], dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
    return best;
  }
  function recordSvg(k) {                                            // a_x, a_z of receiver k (FDM, this medium)
    const f = app.family, nt = f.clock.nt, dt = f.clock.dt, acc = app.medium.fdm.acc;
    const ax = acc.subarray((k * 2) * nt, (k * 2 + 1) * nt), az = acc.subarray((k * 2 + 1) * nt, (k * 2 + 2) * nt);
    // the caption on top and t [s] under the y labels: nothing shares the row of the time ticks
    const peak = Math.max(DSP.peakAbs(ax), DSP.peakAbs(az)) * 1.08 || 1, W = 390, H = 150, m = { l: 44, r: 8, t: 22, b: 20 };
    const x = d3.scaleLinear().domain([0, f.clock.duration]).range([m.l, W - m.r]), y = d3.scaleLinear().domain([-peak, peak]).range([H - m.b, m.t]);
    const line = a => d3.line()(d3.range(0, nt, 4).map(i => [x(i * dt), y(a[i])]));
    return `<svg class="chart" viewBox="0 0 ${W} ${H}"><g class="grid">${y.ticks(4).map(v => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"></line>`).join("")}</g>
      <path class="trace-x" d="${line(ax)}"></path><path class="trace-z" d="${line(az)}"></path>
      ${y.ticks(4).map(v => `<text class="axis-label" x="${m.l - 6}" y="${y(v) + 3}" text-anchor="end">${d3.format("~g")(v)}</text>`).join("")}
      ${x.ticks(6).map(v => `<text class="axis-label" x="${x(v)}" y="${H - m.b + 14}" text-anchor="middle">${v}</text>`).join("")}
      <text class="axis-label" x="${m.l - 6}" y="${H - m.b + 14}" text-anchor="end">t [s]</text>
      <text class="legend-text" x="${W - m.r}" y="12" text-anchor="end">a [m/s²] · ${RECORD_LEGEND}</text></svg>`;
  }
  function cardFor(hit) {
    const s = app.siteData, m = s.model, f = app.family, [hx, hy] = m.hypocentre_xy_km;
    if (!hit) { hideCard(); return; }
    if (hit.kind === "terrain") {
      const zone = zoneAt(hit.x, hit.y);
      showCard("Terrain", `${num(hit.elev)} m a.s.l.`, rows([["Zone", zone ? zone : "outside the DMQ zones"], ["Distance to segment 3", `${distToLine(hit.x, hit.y, s.segment.xy_km).toFixed(2)} km`],
        ["Distance to the epicentre", `${Math.hypot(hit.x - hx, hit.y - hy).toFixed(2)} km`], ["Position", latLon(hit.x, hit.y)], ["x, y (local)", `${hit.x.toFixed(2)}, ${hit.y.toFixed(2)} km`]]) +
        `<p class="note">Copernicus GLO-30, ${s.dem.pixel_m[0].toFixed(0)} m pixels; mesh every ${s.mesh.stride} pixels.</p>`);
    } else if (hit.kind === "fault" || hit.kind === "plane") {
      const fl = hit.fault;
      showCard(hit.kind === "plane" ? "Fault plane" : "Fault trace", `${fl.name} · ${fl.id}`, rows([["Type", fl.type], ["Dip", `${fl.dip}° towards ${fl.dip_dir}`],
        ["Seismogenic depth", `${fl.depth_km[0]}–${fl.depth_km[1]} km`], ["Slip rate", `${fl.slip_rate_mm_yr} mm/yr`], ["Magnitudes", `${fl.magnitudes[0]}–${fl.magnitudes[1]}`],
        ["Trace length", `${(+fl.length_km).toFixed(1)} km`]]) +
        `<p class="note">${fl.source}. Context only: the solver never uses it (its rupture is parametric). The plane is drawn down to the model's floor.</p>`);
      markFault(s.faults.indexOf(fl));
    } else if (hit.kind === "segment") {
      const from = s.segments[s.segment.number - 1].from_km;
      showCard("Section A–B", `Segment ${s.segment.number}`, rows([["Length", `${(s.segment.length_m / 1000).toFixed(1)} km`], ["Relief along it", `${Math.round(s.segment.relief_m)} m`],
        ["Grid", `${f.grid.nx} × ${f.grid.nz} cells, dx = ${f.grid.dx.toFixed(2)} m`], ["From A", `${from}–${from + s.segment.length_m / 1000} km`]]) +
        `<button type="button" class="action go-next" data-card-go="medium">Into the block ›</button>`);
    } else if (hit.kind === "receiver") {
      const k = hit.k, p = app.site.receiverXY(k), z = app.site.receiverElevation(k), repi = Math.hypot(p[0] - hx, p[1] - hy), rhyp = Math.hypot(repi, (z - m.hypocentre_z_m) / 1000);
      const acc = app.medium.fdm.acc, nt = f.clock.nt, g = f.spectra.g;
      app.site.setSelected(k); app.rx = k; Story.setParams({ rx: k + 1 });
      showCard("Receiver", f.receivers.labels[k], rows([["Along segment 3", `${(f.receivers.x[k] * f.grid.dx / 1000).toFixed(2)} km`], ["Elevation", `${num(z)} m a.s.l.`],
        ["Epicentral distance", `${repi.toFixed(2)} km`], ["Hypocentral distance", `${rhyp.toFixed(2)} km`],
        ["PGA horizontal (FDM)", `${(DSP.peakAbs(acc.subarray(k * 2 * nt, (k * 2 + 1) * nt)) / g).toFixed(3)} g`],
        ["PGA vertical (FDM)", `${(DSP.peakAbs(acc.subarray((k * 2 + 1) * nt, (k * 2 + 2) * nt)) / g).toFixed(3)} g`]]) +
        recordSvg(k) + `<div class="card-actions"><button type="button" class="action" data-card-site="${k}">⌖ Site</button>` +
        `<button type="button" class="action go-next" data-card-receiver="${k}">Its records from the network ›</button></div>`);
      if (Story.chapter && Story.chapter.id === "quake") drawQuakeRecord();
    } else if (hit.kind === "epicentre" || hit.kind === "hypocentre") {
      const r = f.rupture, len = Math.hypot((Math.max(...r.x) - Math.min(...r.x)) * f.grid.dx, (Math.max(...r.z) - Math.min(...r.z)) * f.grid.dz) / 1000;
      showCard("The model's earthquake", hit.kind === "epicentre" ? "Epicentre" : "Hypocentre", rows([["Position", latLon(hx, hy)], ["Epicentre elevation", `${num(m.epicentre_z_m)} m a.s.l.`],
        ["Hypocentre", `${((m.top_elevation_m - m.hypocentre_z_m) / 1000).toFixed(2)} km under the grid's top`], ["Rupture", `${r.x.length} point sources, ${len.toFixed(1)} km, ${Math.max(...r.activation_s).toFixed(1)} s`],
        ["Source", `vertical forces, Ricker f₀ = ${f.source.f0} Hz`]]) + `<p class="note">Parametric and fixed: the same earthquake in all 1,000 media. It lies in the section plane, because the solver is 2D.</p>`);
    } else if (hit.kind === "section") {
      // any face of a cut; only the A–B plane carries the model (within a metre of it: the quadrant's south face is A–B too)
      const sec = s.segment.xy_km, onAB = Math.abs(hit.y - app.site.sectionY) < 0.001, inSeg = onAB && hit.x >= sec[0][0] && hit.x <= sec[sec.length - 1][0];
      const below = (app.site.heightAt(hit.x, hit.y) - hit.elev) / 1000;
      const items = [["Depth below the terrain", `${below.toFixed(2)} km`], ["Elevation", `${num(hit.elev)} m a.s.l.`],
                     onAB ? ["Along A–B", `${(hit.x - s.section.xy_km[0][0]).toFixed(2)} km from A`] : ["Position", latLon(hit.x, hit.y)]];
      let note = onAB ? "Outside segment 3 the model has no medium: the colours here are depth only."
        : "A face of the cut, coloured by depth under the terrain. The model's medium exists only in the A–B plane (the section, or the quadrant's south face).";
      if (inSeg && app.medium) {
        const ix = Math.round((hit.x - sec[0][0]) * 1000 / f.grid.dx), iz = Math.round((m.top_elevation_m - hit.elev) / f.grid.dz), nx = f.grid.nx, nz = f.grid.nz;
        if (ix >= 0 && ix < nx && iz >= 0 && iz < nz) {
          const i = iz * nx + ix, size = nx * nz, inp = app.medium.input, val = c => inp[c * size + i] * f.normalizer.std[c] + f.normalizer.mean[c];
          if (inp[3 * size + i] > 0.5) { items.push(["Vp", `${num(val(0))} m/s`], ["Vs", `${num(val(1))} m/s`], ["ρ", `${num(val(2))} kg/m³`], ["Grid cell", `column ${ix}, row ${iz}`]); note = `Medium of seed ${app.seed}, exactly as the network reads it.`; }
          else note = "Air above the model's free surface.";
        }
      }
      showCard(onAB ? "Crustal section" : "Cut", inSeg ? `Inside the model · seed ${app.seed}` : onAB ? "Section A–B" : `${below.toFixed(2)} km deep`, rows(items) + `<p class="note">${note}</p>`);
    }
  }

  // ---------------------------------------------------------------- the model's earthquake and the prologue, on the play bar
  function quakeLevels(t) {
    const f = app.family, nt = f.clock.nt, i = Math.min(nt - 1, Math.max(0, Math.round(t / f.clock.dt))), acc = app.medium.fdm.acc, n = f.receivers.x.length;
    if (!app.quakePeak) app.quakePeak = Array.from({ length: n }, (_, k) => DSP.peakAbs(acc.subarray(k * 2 * nt, (k * 2 + 2) * nt)) || 1);
    return Float32Array.from({ length: n }, (_, k) => Math.hypot(acc[k * 2 * nt + i], acc[(k * 2 + 1) * nt + i]) / app.quakePeak[k]);
  }
  function quakeTime(t) {
    app.site.setRuptureTime(t);
    app.site.setShake(quakeLevels(t));
    if (app.wave) {
      const f = app.family, out = Wave.compose(app.wave.data, Wave.frameAt(app.wave.data, t), app.base.rgba, app.base.mask, f.grid.nx, f.grid.nz, 0, app.quakeOut || {});
      app.quakeOut = out; feedSection(out.rgba);
    }
    if (app.quakeChart) cursorOn(app.quakeChart, t);
  }
  function drawQuakeRecord() {
    const f = app.family, nt = f.clock.nt, dt = f.clock.dt, k = app.rx, acc = app.medium.fdm.acc;
    const ax = acc.subarray((k * 2) * nt, (k * 2 + 1) * nt), az = acc.subarray((k * 2 + 1) * nt, (k * 2 + 2) * nt), peak = Math.max(DSP.peakAbs(ax), DSP.peakAbs(az)) * 1.08;
    const chart = frameChart($("#quake-chart"), { xDomain: [0, f.clock.duration], yDomain: [-peak, peak], xLabel: "t [s]", yLabel: "a [m/s²]", legend: RECORD_LEGEND });
    const pts = a => d3.range(0, nt, 3).map(i => [i * dt, a[i]]), line = d3.line().x(d => chart.x(d[0])).y(d => chart.y(d[1]));
    chart.g.append("path").attr("class", "trace-x").attr("d", line(pts(ax))); chart.g.append("path").attr("class", "trace-z").attr("d", line(pts(az)));
    chart.future = chart.g.append("rect").attr("class", "future").attr("y", 0).attr("height", chart.h);
    app.quakeChart = chart; $("#quake-rx").textContent = String(k + 1);
    cursorOn(chart, Timeline.active ? Timeline.time : 0);
  }
  async function enterQuake() {
    const ids = app.waveIndex ? app.waveIndex.media.map(mm => mm.seed) : [];
    const asked = app.seed;
    if (ids.length && !ids.includes(app.seed)) { app.seedBefore = app.seed; await loadMedium(ids[0]); }
    $("#quake-note").hidden = asked === app.seed;
    $("#quake-note").textContent = `Seed ${asked} has no stored replay; this chapter shows seed ${app.seed}.`;
    app.wave = ids.length ? await waveFor(app.seed, "vz") : null;
    if (!(Story.chapter && Story.chapter.id === "quake")) return;
    app.quakePeak = null; app.site.setSelected(app.rx);
    cardFor({ kind: "receiver", k: app.rx });                          // the receiver's card is open from the start (it draws the panel's record too)
    const duration = app.wave ? app.wave.entry.times[app.wave.entry.times.length - 1] : app.family.clock.duration;
    Timeline.use({ duration, label: "simulated time", speeds: [0.25, 0.5, 1], speed: 0.5, onTime: quakeTime });
    updateInset();
    Timeline.autoplay(() => Story.chapter && Story.chapter.id === "quake", 1600);
  }
  function restoreSeed() { if (app.seedBefore) { const s = app.seedBefore; app.seedBefore = null; loadMedium(s).catch(fail); } }
  function leaveQuake() {
    Timeline.release(); app.wave = null; restoreSeed();
    app.site.setRuptureTime(null); app.site.setShake(null); app.site.setSelected(-1); feedSection();
  }
  function profileChart(svgNode, spec) {
    const svg = d3.select(svgNode), width = svgNode.clientWidth || 420, height = svgNode.clientHeight || 170;
    const m = { top: 14, right: 12, bottom: 36, left: 50 }, w = width - m.left - m.right, h = height - m.top - m.bottom;
    svg.attr("viewBox", `0 0 ${width} ${height}`).selectAll("*").remove();
    const g = svg.append("g").attr("transform", `translate(${m.left},${m.top})`);
    const x = d3.scaleLinear().domain(spec.xDomain).range([0, w]), y = d3.scaleLinear().domain(spec.yDomain).range([h, 0]).nice();
    (spec.bands || []).forEach(b => {
      g.append("rect").attr("class", `seg${b.on ? " on" : b.number % 2 ? "" : " alt"}`).attr("x", x(b.from)).attr("width", Math.max(0, x(b.to) - x(b.from))).attr("y", 0).attr("height", h);
      g.append("text").attr("class", `seg-label${b.on ? " on" : ""}`).attr("x", (x(b.from) + x(b.to)) / 2).attr("y", 11).text(b.label);
    });
    g.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(4).tickSize(-w).tickFormat(""));
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(6));
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat(d3.format("~d")));
    g.append("text").attr("class", "axis-label").attr("x", w).attr("y", h + 32).attr("text-anchor", "end").text(spec.xLabel);
    g.append("text").attr("class", "axis-label").attr("transform", `translate(${-m.left + 12},${h / 2}) rotate(-90)`).attr("text-anchor", "middle").text(spec.yLabel);
    const line = d3.line().defined(d => Number.isFinite(d[1])).x(d => x(d[0])).y(d => y(d[1]));
    for (const s of spec.series) g.append("path").attr("class", s.cls).attr("d", (s.step ? line.curve(d3.curveStepAfter) : line.curve(d3.curveLinear))(s.points));
    (spec.legend || []).forEach((l, k) => g.append("text").attr("class", "legend-text").attr("x", w - 4).attr("y", 10 + 13 * k).attr("text-anchor", "end").text(l));
  }

  function drawProfiles() {
    const s = app.siteData, f = app.family, sec = s.section, n = sec.xy_km.length;
    const a = sec.xy_km[0], dist = sec.xy_km.map(p => Math.hypot(p[0] - a[0], p[1] - a[1]));
    const finite = sec.elevation_m.filter(Number.isFinite);
    profileChart($("#profile-section"), {
      xDomain: [0, dist[n - 1]], yDomain: [Math.min(...finite) - 40, Math.max(...finite) + 60], xLabel: "distance from A [km]", yLabel: "elevation [m]",
      bands: s.segments.map(g => ({ from: g.from_km, to: g.from_km + g.length_m / 1000, label: String(g.number), number: g.number, on: g.number === s.segment.number })),
      series: [{ cls: "terrain", points: dist.map((d, k) => [d, sec.elevation_m[k]]) },
               { cls: "terrain on", points: s.segment.distance_m.map((d, k) => [s.segments[s.segment.number - 1].from_km + d / 1000, s.segment.elevation_m[k]]) }],
    });
    const top = f.terrain.top_elevation_m, stairs = f.surface_index.map((r, c) => [c * f.grid.dx / 1000, top - r * f.grid.dz]);
    const segE = s.segment.elevation_m;
    profileChart($("#profile-segment"), {
      xDomain: [0, s.segment.length_m / 1000], yDomain: [Math.min(...segE, ...stairs.map(p => p[1])) - 20, top + 30],
      xLabel: "distance along segment 3 [km]", yLabel: "elevation [m]",
      series: [{ cls: "stairs", step: true, points: stairs }, { cls: "terrain on thin", points: s.segment.distance_m.map((d, k) => [d / 1000, segE[k]]) }],   // the DEM on top
      legend: ["blue: grid surface (whole rows)", "orange: terrain (DEM)"],
    });
  }

  // ---------------------------------------------------------------- the opening: from the globe into the relief
  const ALL_LAYERS = { terrain: true, section: true, faults: true, planes: true, zones: true, urban: true, receivers: true, rupture: true, footprint: true };
  const LIFT_LAYERS = { section: false, faults: false, planes: false, zones: false, urban: false, receivers: false, rupture: false, footprint: false };
  const BARE_RELIEF = { ...LIFT_LAYERS, terrain: true };
  // the district's relief as the globe shows it: the map palette, the hillshade, the baked sun and sky (half resolution)
  function patchCanvas(images, palette = "map") {
    const w = Math.round(images.hillshade.width / 2), h = Math.round(images.hillshade.height / 2);
    const read = img => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.drawImage(img, 0, 0, w, h); return g.getImageData(0, 0, w, h).data; };
    const shade = read(images.hillshade), esk = read(images.elevation), ramp = Site.ramp(palette), lut = d3.range(256).map(k => d3.rgb(ramp(k / 255)));
    const out = document.createElement("canvas"); out.width = w; out.height = h;
    const g = out.getContext("2d"), img = g.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const p = 4 * i, c = lut[esk[p]], s = 0.42 + 0.70 * shade[p] / 255, sun = esk[p + 1] / 255, sky = 0.55 + 0.45 * esk[p + 2] / 255;
      const tint = [0.62 + 0.38 * sun, 0.66 + 0.34 * sun, 0.80 + 0.20 * sun];
      img.data[p] = Math.min(255, c.r * s * tint[0] * sky); img.data[p + 1] = Math.min(255, c.g * s * tint[1] * sky); img.data[p + 2] = Math.min(255, c.b * s * tint[2] * sky); img.data[p + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return out;
  }
  // the dive: the globe's camera flies down (log distance) onto the very pose the map stage starts from, the stages swap in
  // a third of a second (the patch on the globe and the relief coincide), and the relief rises from flat to ×1.5 while the
  // map flies out to the whole district; the layers and labels come once the ground has risen
  async function diveFromEarth() {
    app.labelHold = true; app.siteSeen = true;
    app.site.setExaggeration(1.5); syncExag();
    const landing = app.earth.fromSite(app.site.pose("approach"), app.site.lensHalf);
    await (app.flight = app.earth.flyTo(landing, 3800));
    if (!(Story.chapter && Story.chapter.id === "quito") || Story.onCover) { app.labelHold = false; return; }
    document.body.classList.add("quick-fade");
    // the ground lands flat, as the globe showed it, and rises at once (ease-out: most of the height in the first second),
    // walls and all: they stretch with the relief every frame, so nothing pops when it ends
    app.site.setShow(LIFT_LAYERS); app.site.setOpacity(app.userOpacity);
    app.site.flyTo("approach", 0); app.site.previewExaggeration(0.03);
    setStage("site");
    setTimeout(() => document.body.classList.remove("quick-fade"), 450);
    await new Promise(r => setTimeout(r, 360));                        // hold the matched frame through the 0.35 s cross-fade
    if (!(Story.chapter && Story.chapter.id === "quito") || Story.onCover) { app.labelHold = false; return; }
    const rise = app.site.animateExaggeration(1.5, 2600, "out").then(() => { app.site.setShow(ALL_LAYERS); syncExag(); markTools(); });
    app.flight = app.site.flyTo("region", 2800);
    await Promise.all([rise, app.flight]);
    app.labelHold = false;
    if (Story.chapter && Story.chapter.id === "quito") setOrbitButton(true);
  }

  // ---------------------------------------------------------------- the network chapter (network.js draws it)
  async function enterNetwork() {
    Network.attach($("#net-stage")); Network.setTheme(app.theme);
    if (!app.networkInit) { app.networkInit = true; Network.init(app.family); }
    Network.reset();
    Timeline.use({ duration: Network.TOTAL, label: "the forward pass", speeds: [0.5, 1, 2], speed: 1, onTime: Network.onTime });
    updateInset();
    Timeline.seek(0.01);
    await networkContext();
    if (!(Story.chapter && Story.chapter.id === "network")) return;
    const m = app.medium, net = await networkFor(m);
    Network.setGather(m.seed, net.velocity, m.fdm.acc, `${(net.encoder_ms + net.decoder_ms).toFixed(0)} ms (encoder ${net.encoder_ms.toFixed(0)} ms, decoder ${net.decoder_ms.toFixed(0)} ms)`);
    Timeline.autoplay(() => Story.chapter && Story.chapter.id === "network" && !Story.onCover, 800);
  }
  async function networkContext() {
    await app.networkReady;
    const m = app.medium, f = app.family;
    $("#nw-seed").textContent = m.seed; $("#nw-rx").textContent = f.receivers.labels[app.rx];
    $("#nw-prev").disabled = app.rx === 0; $("#nw-next").disabled = app.rx === f.receivers.x.length - 1;
    const wave = app.waveIndex && app.waveIndex.media.some(e => e.seed === m.seed) ? (await waveFor(m.seed, "vz")).data : null;   // chapter 0 plays it
    await Network.setContext({ seed: m.seed, input: m.input, query: m.query, rx: app.rx, fdmAcc: m.fdm.acc, wave });
  }

  // ---------------------------------------------------------------- the statistics chapter (stats.js draws it)
  function receiverGeometry() {                                       // along segment 3, R_hyp and elevation of each receiver
    const f = app.family, s = app.siteData, seg = s.segment, m = s.model, [hx, hy] = m.hypocentre_xy_km;
    const out = { along: [], rhyp: [], elev: [] };
    f.receivers.x.forEach((col, k) => {
      const d = col * f.grid.dx / 1000, x = seg.xy_km[0][0] + seg.along[0] * d, y = seg.xy_km[0][1] + seg.along[1] * d;
      const z = app.site.receiverElevation(k), repi = Math.hypot(x - hx, y - hy);
      out.along.push(d); out.elev.push(z); out.rhyp.push(Math.hypot(repi, (z - m.hypocentre_z_m) / 1000));
    });
    return out;
  }
  // ---------------------------------------------------------------- the finale: the result in place
  const FINALE_CORR = [0.5, 1.0];                                     // the colour scale of the correlation, fixed (not stretched to the data)
  const finaleColour = v => d3.interpolateViridis(Math.min(1, Math.max(0, (v - FINALE_CORR[0]) / (FINALE_CORR[1] - FINALE_CORR[0]))));
  async function enterFinale() {
    if (app.testset === undefined) app.testset = await fetch("data/stats/testset.json").then(r => (r.ok ? r.json() : null)).catch(() => null);
    paintFinale();
  }
  function paintFinale() {
    const t = app.testset, c = app.finaleComp || "x";
    document.querySelectorAll("[data-finale-comp]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.finaleComp === c)));
    if (!t || !t.along) { app.site.setResults(null); $("#finale-stats").innerHTML = ""; return; }
    const a = t.along, pga = a.pga_fdm_g[c], corr = a.waveform_corr[c], top = Math.max(...a.pga_fdm_g.x, ...a.pga_fdm_g.z);
    if (Story.chapter && Story.chapter.id === "credits") app.site.setResults({ height_km: pga.map(v => 2.6 * v / top), color: corr.map(finaleColour) });
    const P = t.ims.PGA[c], w = t.waveform_corr[c], run = app.waveIndex && app.waveIndex.media && app.waveIndex.media[0];
    const speed = run && t.timing ? [[`${Math.round(run.run_seconds)} s → ${Math.round(t.timing.predict_s_median * 1000)} ms`,
      `one simulation (Python, CPU) → one forward pass for all 39 receivers (PyTorch, ${t.timing.device === "cpu" ? "CPU" : "GPU"})`]] : [];
    stats("#finale-stats", [[w.p50.toFixed(2), `median correlation of the network's ${c} records with the simulation's, ${t.media} test media`],
      [`×${P.bias.toFixed(2)}`, `typical factor of the network's PGA<sub>${c}</sub> (σ<sub>ln</sub> ${P.sigma.toFixed(2)})`],
      [`${(100 * P.within2).toFixed(2)} %`, `of ${P.n.toLocaleString("en")} PGA<sub>${c}</sub> values within a factor of 2`], ...speed]);
    $("#finale-pga").textContent = `${Math.min(...pga).toFixed(2)}–${Math.max(...pga).toFixed(2)} g`;
    $("#finale-ramp").style.background = `linear-gradient(90deg, ${d3.range(0, 1.0001, 0.125).map(u => finaleColour(FINALE_CORR[0] + u * (FINALE_CORR[1] - FINALE_CORR[0]))).join(", ")})`;
  }

  // ---------------------------------------------------------------- the absorbing boundary (cpml.js, data/cpml/)
  async function enterCpml() {
    status("Loading the three films of the absorbing boundary…", null);
    const ok = await CPML.show().finally(() => status(null));
    $("#cpml-missing").hidden = !!ok;
    if (!ok || !Story.chapter || Story.chapter.id !== "cpml") return;
    const m = CPML.metrics;
    $("#cp-seed").textContent = m.seed;
    Timeline.use({ duration: m.times[m.times.length - 1], label: "simulated time", speeds: [0.25, 0.5, 1], speed: 0.5, onTime: t => CPML.draw(t) });
    updateInset();
    CPML.draw(0);
    Timeline.autoplay(() => Story.chapter && Story.chapter.id === "cpml", 500);
  }

  async function enterStats() {
    const seeds = [...app.index.media].map(m => m.seed).sort((a, b) => a - b);
    if (!app.statsInit) {
      app.statsInit = true;
      const test = await fetch("data/stats/testset.json").then(r => (r.ok ? r.json() : null)).catch(() => null);
      Stats.init({ family: app.family, geo: receiverGeometry(), test, media: seeds,
                   onPick: (seed, k) => pickStats(seed, k), onMedium: seed => pickStats(seed, app.rx) });
    }
    // the network on all six media (each once: infer.js keeps the velocity), then their records
    for (const [j, seed] of seeds.entries()) {
      if (Stats.has(seed)) continue;
      const m = await mediumData(seed);
      status(`Running the network on the six test media · ${j + 1} of ${seeds.length}…`, j / seeds.length);
      await new Promise(r => setTimeout(r, 0));
      const net = await networkFor(m), cache = new Map(), f = app.family, nt = f.clock.nt, np = f.spectra.periods.length;
      Stats.addMedium(seed, (k, c) => {
        if (!cache.has(k)) cache.set(k, DSP.receiver(net.velocity, k, f));
        const r = cache.get(k);
        return { netAcc: Float32Array.from(r.acceleration[c]), netSa: r.sa_g[c], fdmAcc: m.fdm.acc.subarray((k * 2 + c) * nt, (k * 2 + c + 1) * nt),
                 fdmSa: m.fdm.sa.subarray((k * 2 + c) * np, (k * 2 + c + 1) * np) };
      });
    }
    status(null);
    if (Story.chapter && Story.chapter.id === "stats") Stats.select(app.seed, app.rx);
  }
  function pickStats(seed, k) {                                       // a point, a chip or ‹ ›: that medium (repainted) and receiver
    k = Math.max(0, Math.min(app.family.receivers.x.length - 1, k));
    const then = () => selectReceiver(k);
    if (seed !== app.seed) loadMedium(seed).then(then).catch(fail); else then();
  }

  // ---------------------------------------------------------------- chapters
  const chapters = [
    { id: "earth", title: "Quito, on the globe",
      enter() { setStage("earth"); app.flight = app.earth.flyTo("far", Story.onCover ? 0 : 1600); } },   // the whole Earth, Quito facing us
    { id: "quito", title: "Quito and its faults",
      enter() {
        const fromEarth = app.stage === "earth";
        setSection(false);
        app.site.setShow(ALL_LAYERS);
        app.site.setOpacity(app.userOpacity); markTools(); markPalette();
        if (fromEarth) { diveFromEarth().catch(fail); return; }       // the globe dives into the relief
        setStage("site");
        if (!app.siteSeen) { app.site.setExaggeration(1.5); app.site.flyTo("approach", 0); }
        app.siteSeen = true; syncExag();
        app.flight = app.site.flyTo("region", 2400);                    // the whole district, turning slowly (Orbit on here)
        setOrbitButton(true);
      },
      leave() { hideCard(); app.site.clearHalo(); setOrbitButton(false); app.labelHold = false; } },
    { id: "quake", title: "One earthquake, one plane", dwell: 16000,
      // (the former "Section A–B and segment 3" lives here now: its profiles in the panel, its ×1.5 -> ×1 on the way in)
      enter() {
        setStage("site"); setSection(true); app.site.setOpacity(0.35); markTools();
        if (Math.abs(app.site.exaggeration - 1) > 1e-6) app.site.animateExaggeration(1, 1600).then(syncExag);   // the true height: the plane the wave lives in
        Timeline.use({ duration: 6, label: "simulated time", onTime: () => {} }); updateInset();   // reserve the bar before framing
        app.flight = app.site.flyTo("quake", 2400);
        requestAnimationFrame(drawProfiles);
        enterQuake().catch(fail);
      },
      leave() { leaveQuake(); hideCard(); app.site.setOpacity(app.userOpacity); markTools(); } },
    { id: "medium", title: "The medium: one of 1,000", enter() { setStage("block"); app.scene.setSelected(-1); app.layer = -1; applyMediumView(); },
      leave() { if (app.layer >= 0) showLayer(-1); app.scene.setStrata(null); placeCallout(); } },
    { id: "source", title: "The source: a kinematic rupture",
      enter() {
        setStage("block"); wholeDepth(); app.scene.setSelected(-1); app.scene.setSourceView(true); app.scene.setSourceFx(true);
        describeSource(); requestAnimationFrame(drawSourceCharts);
        const plan = rupturePlan();                                     // the bar runs until the last copy of the Ricker has gone by
        Timeline.use({ duration: Math.round((plan.end + 2 * app.family.source.t0 + 0.1) * 10) / 10, label: "rupture time", speeds: [0.25, 0.5, 1], speed: 0.5, onTime: sourceTime });
        Timeline.autoplay(() => Story.chapter && Story.chapter.id === "source", 600);
      },
      leave() { Timeline.release(); app.scene.setRuptureTime(null); app.scene.setSourceFx(false); app.scene.setSourceView(false); $("#front-label").hidden = true; } },
    { id: "solver", title: "The solver: one simulation, the whole wavefield", dwell: 16000,
      enter() { setStage("block"); wholeDepth(); app.scene.setSelected(app.rx); app.scene.setSourceView(true); enterSolver().catch(fail); },
      leave: () => leaveSolver() },
    { id: "cpml", title: "The edges that are not there: CPML", dwell: 16000,
      enter() { setStage("cpml"); enterCpml().catch(fail); },
      leave() { Timeline.release(); } },
    { id: "network", title: "The network, step by step", dwell: 30000,
      enter() { setStage("net"); enterNetwork().catch(fail); },
      leave() { Timeline.release(); } },
    { id: "receiver", title: "One receiver: network against simulation", wide: true,
      enter() {
        setStage("block");
        app.scene.setSelected(app.rx);
        networkFor(app.medium).then(() => showReceiver(app.rx)).catch(fail);
      } },
    { id: "stats", title: "The records, by the numbers", wide: true,
      enter() { setStage("block"); app.scene.setSelected(app.rx); enterStats().catch(fail); } },
    { id: "credits", title: "The result, in place · credits",
      // review 5 (Abell): the relief alone looked lonely; the finale puts Quito, its faults and the result together. Each
      // receiver of segment 3 becomes a column: height, the simulation's median PGA; colour, the network's correlation
      enter() {
        setStage("site"); setSection(false); hideCard(); app.site.setOpacity(1);
        app.site.setShow({ ...ALL_LAYERS, receivers: false, planes: false, footprint: false });
        app.flight = app.site.flyTo("finale", 2400); setOrbitButton(true);
        enterFinale().catch(fail);
      },
      leave() { app.site.setResults(null); setOrbitButton(false); app.site.setShow(ALL_LAYERS); app.site.setOpacity(app.userOpacity); markTools(); } },
  ];
  function syncExag() { const v = app.site.exaggeration; $("#exag").value = v.toFixed(1); $("#exag-out").textContent = `×${v.toFixed(1)}`; }

  // ---------------------------------------------------------------- the map's data: mesh (int16 heights) and the two baked images
  async function loadMesh(site) {
    const response = await fetch(site.mesh.file);
    const buffer = await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    const rows = site.mesh.rows, cols = site.mesh.cols, nz = rows * cols * 2;
    return { rows, cols, z: new Int16Array(buffer.slice(0, nz)), x: new Float32Array(buffer.slice(nz, nz + cols * 4)),
             y: new Float32Array(buffer.slice(nz + cols * 4, nz + cols * 4 + rows * 4)), pixelRows: site.mesh.pixel_rows, pixelCols: site.mesh.pixel_cols };
  }
  function loadImages(site) {
    const one = src => new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error(`${src} did not load`)); im.src = src; });
    return Promise.all([one(site.dem.hillshade), one(site.dem.elevation), one(site.dem.curvature)])
      .then(([hillshade, elevation, curvature]) => ({ hillshade, elevation, curvature }));
  }

  // ---------------------------------------------------------------- start
  async function start() {
    const initial = Story.init(chapters, {
      cover: on => { if (on && app.earth) setStage("earth"); applyOrbit(); updateInset(); },
      fold: folded => setTimeout(() => { updateInset(); if (!folded) redrawPanel(); }, 0),
      change: () => { $("#dock").hidden = true; $("#tools-btn").setAttribute("aria-expanded", "false"); requestAnimationFrame(() => { updateInset(); placeFloats(); }); },   // the play bar comes and goes with the chapter; the dock belongs to the map you left
      orbit: toggleOrbit,
      params: p => applyParams(p),
      escape: () => { if (!$("#qr").hidden) { $("#qr").hidden = true; return true; } if (!$("#card").hidden) { hideCard(); return true; } if (!$("#dock").hidden) { $("#dock").hidden = true; placeFloats(); return true; } return false; },
    });
    const p = initial.params;
    if (!Infer.live) document.querySelectorAll("[data-pre]").forEach(e => { e.innerHTML = e.dataset.pre; });   // D2: the public page says what it does
    applyTheme(p.get("theme") || storedTheme() || "dark", !p.get("theme"));
    if (p.get("field") && FIELDS[p.get("field")]) app.field = p.get("field");
    if (p.get("depth")) app.depth = Number(p.get("depth"));
    if (p.get("rx")) app.rx = Math.max(0, Number(p.get("rx")) - 1);

    const [family, index, siteData] = await Promise.all([fetch("data/family.json").then(r => r.json()), fetch("data/media/index.json").then(r => r.json()),
                                                          fetch("data/site/site.json").then(r => r.json())]);
    siteData.family = family;
    app.family = family; app.index = index; app.siteData = siteData;
    const [mesh, images] = await Promise.all([loadMesh(siteData), loadImages(siteData)]);
    app.waveIndex = await fetch("data/wave/index.json").then(r => (r.ok ? r.json() : null)).catch(() => null);
    $("#wave-chips").innerHTML = app.waveIndex ? app.waveIndex.media.map(m => `<button type="button" class="chip" data-seed="${m.seed}">Seed ${m.seed}</button>`).join("")
                                               : `<span class="note">No replay exported (python web/tools/export_wavefield.py).</span>`;
    $("#wave-ramp").style.background = `linear-gradient(to right, ${Wave.SIGNED.join(", ")})`;
    $("#segment").textContent = `${family.terrain.city} · section segment ${family.terrain.segment_number} · ` +
      `${(family.terrain.segment_length_m / 1000).toFixed(1)} × ${((family.grid.nz - 1) * family.grid.dz / 1000).toFixed(1)} km`;
    $("#cover-figures").textContent = `1,000 layered media · ${family.receivers.x.length} receivers · ` +
      `${(family.n_parameters / 1e6).toFixed(1)} M parameters · ${Infer.live ? "runs in your browser" : "the network's own predictions"}`;
    $("#credits-model").textContent = `${family.model_class}, ${(family.n_parameters / 1e6).toFixed(1)} M parameters, epoch ${family.epoch}, ` +
      `trained on ${family.split_counts.train} media of ${family.h5_name}. ${Infer.live ? "In this page it runs on your machine (onnxruntime-web, WASM)." : "In this public page its predictions for the six test media were computed beforehand with onnxruntime; the trained weights are not published."}`;
    $("#medium-chips").innerHTML = [...index.media].sort((a, b) => a.seed - b.seed).map(m => `<button type="button" class="chip" data-seed="${m.seed}" title="${m.layer_count} layers · Vs contrast ${m.vs_contrast.toFixed(2)}">Seed ${m.seed}</button>`).join("");
    $("#depth-chips").innerHTML = DEPTHS.map(d => `<button type="button" class="chip" data-depth="${d.m}">${d.label}</button>`).join("");
    markDepth();

    app.scene = SectionScene.create($("#scene"), family, themeTokens());
    app.scene.onPick = (k, direct) => {
      const id = Story.chapter && Story.chapter.id;
      if (direct || id === "receiver" || id === "solver") selectReceiver(k);
    };
    app.scene.onFrame = onFrame;
    app.scene.onLayerPick = k => showLayer(k === app.layer ? -1 : k);   // the layers apart: a solid, or beside them to let go
    app.scene.onFacePick = cell => {                                   // the medium chapter: a click on the face is a layer
      if (!(Story.chapter && Story.chapter.id === "medium")) return false;
      const k = layerMap(app.medium)[cell.iz * family.grid.nx + cell.ix];
      showLayer(k === app.layer ? -1 : k);                             // the same layer again lets it go
      return true;
    };
    app.scene.onHover = (k, at) => {
      const tip = $("#hover");
      if (k < 0 || (k === app.rx && Story.chapter && Story.chapter.id === "receiver")) { tip.hidden = true; return; }
      tip.hidden = false; tip.textContent = `${family.receivers.labels[k]} · ${(family.receivers.x[k] * family.grid.dx / 1000).toFixed(2)} km`;
      tip.style.transform = `translate(${at.x + 12}px, ${at.y - 12}px)`;
    };
    if (isFinite(app.depth)) app.scene.setFloor(app.depth);
    app.earth = Earth.create($("#earth-stage"), siteData);
    app.earth.onSun = markSun; markSun();
    app.earth.paint().catch(fail);                                     // NASA's imagery, a few MB, behind the cover
    app.site = Site.create($("#site-stage"), siteData, mesh, images);
    app.earth.setPatch(patchCanvas(images), siteData.dem.x_range_km, siteData.dem.y_range_km);
    app.site.setTheme(app.theme);
    if (p.get("palette") && Site.PALETTES.includes(p.get("palette"))) app.site.setPalette(p.get("palette"));
    app.site.onFrame = onSiteFrame;
    app.site.onPick = hit => cardFor(hit);
    app.site.onHover = (hit, at) => {
      const tip = $("#hover");
      if (!hit || !at) { tip.hidden = true; return; }
      const f = app.family, [hx, hy] = siteData.model.hypocentre_xy_km;
      if (hit.kind === "receiver") { const q = app.site.receiverXY(hit.k); tip.textContent = `${f.receivers.labels[hit.k]} · ${Math.hypot(q[0] - hx, q[1] - hy).toFixed(1)} km from the epicentre · click for its record`; }
      else tip.textContent = "Epicentre of the model's earthquake · click for the rupture";
      tip.hidden = false; tip.style.transform = `translate(${at.x + 12}px, ${at.y - 12}px)`;
    };
    describeSite();
    githubCodes();
    updateInset();
    app.globe = Globe.create($("#globe"));

    // the network loads while the cover is up
    const t0 = performance.now();
    app.networkReady = Infer.load(family, (got, total) => {
      $("#cover-load").textContent = got < total ? `Loading the network · ${(got / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB` : "Network ready";
    }).then(s => { app.timings.models_ms = performance.now() - t0; $("#cover-load").textContent = Infer.live ? "Network ready · runs in this browser" : "Network results ready"; return s; });
    app.networkReady.catch(fail);

    await loadMedium(Number(p.get("seed")) || index.default);
    if (initial.start === "cover") { setStage("earth"); Story.showCover(); }
    else Story.go(chapters.some(c => c.id === initial.start) ? initial.start : chapters[0].id, { force: true });
    if (!Story.onCover && Story.chapter.id === "receiver") await networkFor(app.medium);
    app.ready = true;
  }

  function markDepth() {
    document.querySelectorAll("#depth-chips .chip").forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.depth) === app.depth)));
  }
  function toggleOrbit() { setOrbitButton(!orbitWanted()); }
  function setOrbitButton(on) { $("#orbit-btn").setAttribute("aria-pressed", String(!!on)); applyOrbit(); }

  // ---------------------------------------------------------------- controls
  function wire() {
    $("#theme-btn").addEventListener("click", () => { applyTheme(app.theme === "dark" ? "light" : "dark"); Story.setParams({ theme: app.theme }); });
    $("#orbit-btn").addEventListener("click", toggleOrbit);
    $("#medium-chips").addEventListener("click", e => {
      const b = e.target.closest("[data-seed]"); if (!b) return;
      loadMedium(Number(b.dataset.seed)).then(m => (Story.chapter && Story.chapter.id === "receiver" ? networkFor(m).then(() => showReceiver(app.rx)) : null)).catch(fail);
    });
    document.querySelectorAll("[data-field]").forEach(b => b.addEventListener("click", () => { app.field = b.dataset.field; paintField(); Story.setParams({ field: app.field }); }));
    document.querySelectorAll("[data-medium-view]").forEach(b => b.addEventListener("click", () => { app.mediumView = b.dataset.mediumView; applyMediumView(); }));
    $("#layer-report").addEventListener("click", e => { if (e.target.closest("[data-action=layer-close]")) showLayer(-1); });
    $("#depth-chips").addEventListener("click", e => {
      const b = e.target.closest("[data-depth]"); if (!b) return;
      if (app.mediumView === "layers") { app.mediumView = "block"; applyMediumView(); }   // the depth cut is the block's
      app.depth = Number(b.dataset.depth); app.scene.setFloor(app.depth); markDepth();
      Story.setParams({ depth: isFinite(app.depth) ? app.depth : null });
    });
    $("#exag").addEventListener("input", e => { app.site.setExaggeration(Number(e.target.value)); syncExag(); });
    $("#opacity").addEventListener("input", e => { app.userOpacity = Number(e.target.value); app.site.setOpacity(app.userOpacity); markTools(); });
    $("#section-switch").addEventListener("click", () => setSection(!app.site.sectionOn));
    $("#buildings-switch").addEventListener("click", () => { app.site.setShow({ buildings: !app.site.show.buildings }); markTools(); });
    document.querySelectorAll("[data-palette]").forEach(b => b.addEventListener("click", () => { app.site.setPalette(b.dataset.palette); markPalette(); Story.setParams({ palette: b.dataset.palette }); }));
    $("#tools-btn").addEventListener("click", () => { const open = $("#dock").hidden; $("#dock").hidden = !open; $("#tools-btn").setAttribute("aria-expanded", String(open)); if (open) markTools(); placeFloats(); });
    $("#card-title").addEventListener("click", () => $("#card").classList.toggle("folded"));       // as the SRF Explorer: the title folds
    $("#site-labels").addEventListener("click", e => { if (e.target.closest("[data-id=segment]")) cardFor({ kind: "segment" }); });
    $("#layers").addEventListener("click", e => { const tr = e.target.closest("[data-layer]"); if (tr) showLayer(Number(tr.dataset.layer) === app.layer ? -1 : Number(tr.dataset.layer)); });
    $("#quake-table").addEventListener("click", e => { const tr = e.target.closest("[data-rx]"); if (tr) cardFor({ kind: "receiver", k: Number(tr.dataset.rx) }); });
    // any interaction with the scene, the panel or a card pauses the tour (story.js shows a toast)
    document.addEventListener("pointerdown", e => { if (e.target.closest(".stage, #panel-body, #card, #dock, #timeline")) Story.pauseTour(); }, true);
    // taking the camera by hand stops the orbit (the button says so); the button turns it on again
    document.addEventListener("pointerdown", e => { if (e.target.closest(".stage") && orbitWanted()) setOrbitButton(false); }, true);
    document.querySelectorAll("[data-cut]").forEach(b => b.addEventListener("click", () => {      // a new mode turns the camera to its face
      setCut(b.dataset.cut); app.flight = app.site.flyTo(b.dataset.cut === "none" ? "faults" : "cut", 1600);
    }));
    $("#cut-pos").addEventListener("input", e => setCut(app.site.cut.mode, Number(e.target.value)));
    document.querySelectorAll("[data-show]").forEach(b => b.addEventListener("click", () => { app.site.setShow({ [b.dataset.show]: !app.site.show[b.dataset.show] }); markTools(); }));
    document.querySelectorAll("[data-fly]").forEach(b => b.addEventListener("click", () => (b.dataset.fly === "north" ? app.site.northUp()
      : b.dataset.fly === "site" ? flySite(app.rx)
      : (b.dataset.fly === "quake" && setCut("south", app.site.sectionY), app.site.flyTo(b.dataset.fly)))));   // the rupture lives in A–B: open it
    $("#qr-btn").addEventListener("click", () => ($("#qr").hidden ? showQr() : ($("#qr").hidden = true)));
    $("#qr-close").addEventListener("click", () => ($("#qr").hidden = true));
    $("#card-close").addEventListener("click", hideCard);
    $("#card-fold").addEventListener("click", () => $("#card").classList.toggle("folded"));
    $("#card").addEventListener("click", e => {
      const go = e.target.closest("[data-card-go]"), rec = e.target.closest("[data-card-receiver]"), site = e.target.closest("[data-card-site]");
      if (site) flySite(Number(site.dataset.cardSite));
      if (go) { hideCard(); Story.go(go.dataset.cardGo); }
      if (rec) { hideCard(); app.select(Number(rec.dataset.cardReceiver)); }
    });
    $("#fault-table").addEventListener("click", e => {
      const tr = e.target.closest("[data-fault]"); if (!tr) return;
      const k = Number(tr.dataset.fault);
      cardFor({ kind: "fault", fault: app.siteData.faults[k] });
      setOrbitButton(false);                                            // a turning camera never settles on the fault
      app.flight = app.site.flyTo(app.site.faultView(k), 1800);
    });
    $("#compass").addEventListener("click", () => { if (app.stage === "site") app.site.northUp(); else if (app.stage === "block") app.scene.frame(); });
    document.querySelectorAll("[data-comp]").forEach(b => b.addEventListener("click", async () => {
      app.waveComp = b.dataset.comp;
      document.querySelectorAll("[data-comp]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
      if (Story.chapter && Story.chapter.id === "solver") { app.wave = await waveFor(app.seed, app.waveComp); waveLegend(); drawWaveFrame(Timeline.time); }
    }));
    $("#wave-chips").addEventListener("click", async e => {
      const b = e.target.closest("[data-seed]"); if (!b || Number(b.dataset.seed) === app.seed) return;
      const t = Timeline.time;
      await loadMedium(Number(b.dataset.seed));
      app.wave = await waveFor(app.seed, app.waveComp);
      $("#solver-note").hidden = true;
      describeSolver(app.wave.entry); waveLegend(); drawRecording(); Timeline.seek(t);
    });
    document.querySelectorAll("[data-action=fly-earth]").forEach(b => b.addEventListener("click", () => { app.flight = app.earth.flyTo(b.dataset.view, 2400); }));
    document.querySelectorAll("[data-sun]").forEach(b => b.addEventListener("click", () => { if (app.earth) { app.earth.setSun(b.dataset.sun); markSun(); } }));
    document.querySelectorAll("[data-finale-comp]").forEach(b => b.addEventListener("click", () => { app.finaleComp = b.dataset.finaleComp; paintFinale(); }));
    for (const id of Object.values(STAGE_IDS)) for (const ev of ["pointerdown", "wheel"])
      $(id).addEventListener(ev, () => { clearTimeout(hintTimer); document.body.classList.add("hint-dim"); }, { passive: true });
    document.querySelector("[data-action=into-block]").addEventListener("click", () => Story.next());
    $("#rx-prev").addEventListener("click", () => showReceiver(app.rx - 1));
    $("#nw-prev").addEventListener("click", () => selectReceiver(app.rx - 1));
    $("#nw-next").addEventListener("click", () => selectReceiver(app.rx + 1));
    $("#rx-next").addEventListener("click", () => showReceiver(app.rx + 1));
    document.addEventListener("keydown", e => {
      if (!app.ready || Story.onCover || e.target.closest("input, select, textarea")) return;
      const id = Story.chapter && Story.chapter.id;                    // [ ] step receivers where receivers are what you read
      if ((e.key === "[" || e.key === "]") && (id === "receiver" || id === "solver" || id === "stats" || id === "network")) { e.preventDefault(); selectReceiver(app.rx + (e.key === "]" ? 1 : -1)); }
    });
    let timer = null;
    addEventListener("resize", () => { clearTimeout(timer); timer = setTimeout(() => { updateInset(); redrawPanel(); placeFloats(); }, 120); });
  }

  // the panel's charts are drawn at the panel's size: redraw them when it changes (resize, unfolding)
  function redrawPanel() {
    const id = Story.chapter && Story.chapter.id;
    if (!id || Story.onCover || document.body.classList.contains("panel-folded")) return;
    if (id === "quake") { drawProfiles(); if (app.medium) drawQuakeRecord(); }
    else if (id === "source") { drawSourceCharts(); sourceTime(Timeline.time); }
    else if (id === "solver" && app.wave) drawRecording();
    else if (id === "receiver") showReceiver(app.rx);
    else if (id === "stats" && Stats.ready) Stats.render();
  }

  // a hash typed by hand: apply its view before story.js enters the chapter
  function applyParams(p) {
    if (p.get("theme")) applyTheme(p.get("theme"));
    if (p.get("field") && FIELDS[p.get("field")]) app.field = p.get("field");
    app.depth = p.get("depth") ? Number(p.get("depth")) : Infinity;
    app.scene.setFloor(app.depth); markDepth();
    if (p.get("rx")) app.rx = Math.max(0, Math.min(app.family.receivers.x.length - 1, Number(p.get("rx")) - 1));
    const seed = Number(p.get("seed"));
    const after = () => (Story.chapter && Story.chapter.id === "receiver" ? networkFor(app.medium).then(() => showReceiver(app.rx)) : null);
    if (seed && seed !== app.seed) loadMedium(seed).then(after).catch(fail); else { paintField(); after(); }
  }

  Timeline.init();
  app.select = k => selectReceiver(k);
  app.go = id => Story.go(id);
  app.loadMedium = seed => loadMedium(seed).then(m => networkFor(m)).then(() => showReceiver(app.rx));
  wire();
  start().catch(fail);
})();
