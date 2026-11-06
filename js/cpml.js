// Surrogate Explorer · cpml.js — the absorbing boundary, measured (data/cpml/, made by web/tools/export_cpml.py).
//
// The stage: three films of the same earthquake, side by side at the same metres per pixel: rigid edges (no absorbing
// layer) and the dataset's 20-cell CPML with its strips drawn (left, right, bottom; the top is the free surface), the
// vertical velocity in a diverging palette whose middle IS the panel's background (a zero crossing fades into it, it
// does not draw a dark line), amplitudes compressed as |v|^0.55 so the late, weak waves still read; and what those 20
// cells reflect (their run minus a 64-cell reference) as a magnitude on a log scale. Each frame is drawn at the grid's
// (decimated) size, then scaled to the screen with bilinear smoothing. The panel: the layer's profiles d, kappa, alpha cell by cell,
// the energy left in the domain, the residual for every thickness of the sweep, the error at each receiver, the table.
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const PANELS = [
    { key: "rigid", title: "Rigid edges", sub: "no absorbing layer: everything comes back" },
    { key: "cpml20", title: "CPML, 20 cells", sub: "the dataset's boundary: the wave leaves" },
    { key: "residual", title: "What the 20 cells reflect", sub: "their run minus a 64-cell reference" },
  ];
  const GAMMA = 0.75, LOG_DECADES = 1.6;                               // amplitude compression; the residual's log range (int8: ~42 dB)
  let M = null, loading = null, films = null, canvases = {}, built = false, luts = null, lastFrame = -1;

  // q in [-127, 127] -> colour, per theme: signed (the two films) and magnitude on a log scale (the residual)
  function tables() {
    const neutral = css("--plot") || "#242427", key = neutral + document.documentElement.dataset.theme;
    if (luts && luts.key === key) return luts;
    const dark = document.documentElement.dataset.theme !== "light";
    const neg = d3.interpolateRgbBasis(dark ? [neutral, "#4f78d0", "#b3cbff"] : [neutral, "#8ea8dc", "#2a4c97"]);
    const pos = d3.interpolateRgbBasis(dark ? [neutral, "#dc7a2c", "#ffcf9a"] : [neutral, "#f2b27a", "#b4500c"]);
    // the residual: only its stronger half takes colour, the rest stays the background (it is 1/19,000 of the films)
    const mag = d3.interpolateRgbBasis(dark ? [neutral, neutral, neutral, "#6a5a9e", "#c06c8c", "#f2a865"] : [neutral, neutral, neutral, "#c8bfe4", "#c7789a", "#c4651f"]);
    const signed = new Uint8Array(255 * 3), log = new Uint8Array(255 * 3);
    for (let k = 0; k < 255; k++) {
      const q = k - 127, u = Math.pow(Math.abs(q) / 127, GAMMA), c = d3.rgb(q < 0 ? neg(u) : pos(u));
      const m = q === 0 ? 0 : Math.max(0, (Math.log10(Math.abs(q) / 127) + LOG_DECADES) / LOG_DECADES), l = d3.rgb(mag(m));
      signed.set([c.r, c.g, c.b], k * 3); log.set([l.r, l.g, l.b], k * 3);
    }
    return (luts = { key, signed, log });
  }
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  async function load() {
    if (!loading) loading = fetch("data/cpml/metrics.json").then(r => (r.ok ? r.json() : null)).catch(() => null).then(m => (M = m));
    return loading;
  }
  async function loadFilms() {
    if (films) return films;
    const out = {};
    for (const p of PANELS) {
      const f = M.films[p.key];
      out[p.key] = await Wave.load({ files: { vz: f.file }, shape: f.shape, times: M.times, decimate: M.decimate }, "vz");
    }
    return (films = out);
  }

  // ---------------------------------------------------------------- the stage: three canvases
  function build() {
    if (built) return;
    built = true;
    const box = $("#cp-films"), nx = M.params.physical[1];
    box.innerHTML = "";
    for (const p of PANELS) {
      const f = M.films[p.key], [, rows, cols] = f.shape;
      const fig = document.createElement("figure"); fig.className = `cp-film cp-${p.key}`; fig.style.flex = `${cols} 1 0`;
      const gain = p.key === "residual" ? ` · |difference|, log scale; full colour = 1/${d3.format(",")(Math.round(M.films.residual.gain / 100) * 100)} of the films' scale` : "";
      fig.innerHTML = `<figcaption><b>${p.title}</b><span>${p.sub}${gain}</span></figcaption><div class="cp-wrap"><canvas width="${cols}" height="${rows}"></canvas></div>`;
      if (f.strips) {                                                  // the layer itself: left, right and bottom strips
        const sx = (f.strips / M.decimate) / cols * 100, sz = (f.strips / M.decimate) / rows * 100;
        fig.querySelector(".cp-wrap").insertAdjacentHTML("beforeend",
          `<i class="cp-strip" style="left:0;top:0;bottom:0;width:${sx}%"></i><i class="cp-strip" style="right:0;top:0;bottom:0;width:${sx}%"></i>` +
          `<i class="cp-strip" style="left:0;right:0;bottom:0;height:${sz}%"></i><em class="cp-tag" style="left:${sx / 2}%">CPML</em><em class="cp-tag" style="left:${100 - sx / 2}%">CPML</em>`);
      }
      box.appendChild(fig);
      const small = document.createElement("canvas"); small.width = cols; small.height = rows;
      canvases[p.key] = { el: fig.querySelector("canvas"), small, sctx: small.getContext("2d"), rows, cols, pad: f.strips ? f.strips : 0, nx, log: p.key === "residual" };
    }
  }
  function paint(t) {
    if (!films) return;
    const frame = Wave.frameAt(films.cpml20, t);
    if (frame === lastFrame) return;
    lastFrame = frame;
    const T = tables(), surf = M.surface_rows, d = M.decimate, dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const p of PANELS) {
      const w = films[p.key], c = canvases[p.key], table = c.log ? T.log : T.signed;
      const img = c.sctx.createImageData(c.cols, c.rows), px = img.data, off = frame * w.rows * w.cols;
      for (let r = 0; r < c.rows; r++) for (let j = 0; j < c.cols; j++) {
        const col = Math.min(c.nx - 1, Math.max(0, j * d - c.pad)), i = (r * c.cols + j) * 4;
        if (r * d < surf[col]) { px[i + 3] = 0; continue; }             // the air above the stair-step surface
        const k = (w.q[off + r * w.cols + j] + 127) * 3;
        px[i] = table[k]; px[i + 1] = table[k + 1]; px[i + 2] = table[k + 2]; px[i + 3] = 255;
      }
      c.sctx.putImageData(img, 0, 0);
      // to the screen: the display canvas at its CSS size x the pixel ratio, filled with a smoothed (bilinear) copy
      const W = Math.max(c.cols, Math.round((c.el.clientWidth || c.cols) * dpr)), H = Math.round(W * c.rows / c.cols);
      if (c.el.width !== W || c.el.height !== H) { c.el.width = W; c.el.height = H; }
      const ctx = c.el.getContext("2d"); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
      ctx.clearRect(0, 0, W, H); ctx.drawImage(c.small, 0, 0, W, H);
    }
  }

  // ---------------------------------------------------------------- the panel: numbers, profiles, curves, table
  function frame(svgNode, spec) {                                      // the statistics chapter's frame (stats.js), smaller margins
    const svg = d3.select(svgNode), width = svgNode.clientWidth || 420, height = svgNode.clientHeight || 170;
    const m = { top: 12, right: spec.right || 30, bottom: 36, left: 54 }, w = width - m.left - m.right, h = height - m.top - m.bottom;
    svg.attr("viewBox", `0 0 ${width} ${height}`).selectAll("*").remove();
    const g = svg.append("g").attr("transform", `translate(${m.left},${m.top})`);
    const x = d3.scaleLinear().domain(spec.x).range([0, w]);
    const y = (spec.logY ? d3.scaleLog() : d3.scaleLinear()).domain(spec.y).range([h, 0]);
    g.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(4).tickSize(-w).tickFormat(""));
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(6));
    g.append("g").attr("class", "axis").call(spec.logY ? d3.axisLeft(y).ticks(4, spec.yFormat || "~e") : d3.axisLeft(y).ticks(4).tickFormat(d3.format("~g")));
    g.append("text").attr("class", "axis-label").attr("x", w).attr("y", h + 32).attr("text-anchor", "end").text(spec.xLabel);
    g.append("text").attr("class", "axis-label").attr("transform", `translate(${-m.left + 12},${h / 2}) rotate(-90)`).attr("text-anchor", "middle").text(spec.yLabel);
    return { g, x, y, w, h };
  }
  const endLabel = (ch, xs, ys, text, cls) => ch.g.append("text").attr("class", `cp-end ${cls}`).attr("x", ch.x(xs) + 4).attr("y", ch.y(ys) + 3).text(text);

  function drawProfiles() {
    const p = M.profile, n = p.distance.length, cells = d3.range(n).map(i => i + 0.5), P = M.params;
    const ch = frame($("#cp-profile"), { x: [0, n], y: [0, 1.05], xLabel: "cells into the layer, from the model's edge outward", yLabel: "share of its maximum" });
    // d and kappa share one shape, (xi/L)^N, so they are one curve here; alpha falls the other way
    const series = [[`d / d₀ = (κ − 1) / (κ_max − 1) = (ξ/L)^${P.order}`, p.damping.map(v => v / P.d0), "cp-d"], ["α / α_max = 1 − ξ/L", p.alpha.map(v => v / P.alpha_max), "cp-a"]];
    for (const [name, ys, cls] of series) {
      ch.g.append("path").attr("class", `cp-line ${cls}`).attr("d", d3.line()(cells.map((x, i) => [ch.x(x), ch.y(ys[i])])));
      const i = cls === "cp-a" ? 1 : n - 1;
      ch.g.append("text").attr("class", `cp-end ${cls}`).attr("x", ch.x(cells[i]) + (cls === "cp-a" ? 6 : -4)).attr("y", ch.y(ys[i]) - 8)
        .attr("text-anchor", cls === "cp-a" ? "start" : "end").text(name);
    }
  }
  function drawEnergy() {
    const t = M.times, T = t[t.length - 1], E = M.energy;
    const lo = Math.max(1e-5, d3.min(E.ref64.filter(v => v > 0)) / 2);
    const ch = frame($("#cp-energy"), { x: [0, T], y: [lo, 1.5], logY: true, xLabel: "simulated time [s]", yLabel: "kinetic energy / peak" });
    const line = ys => d3.line()(t.map((x, i) => [ch.x(x), ch.y(Math.max(lo, ys[i]))]));
    for (const [key, cls, label] of [["rigid", "cp-rigid", "rigid edges"], ["cpml20", "cp-20", "CPML 20"], ["ref64", "cp-ref", "CPML 64"]]) {
      ch.g.append("path").attr("class", `cp-line ${cls}`).attr("d", line(E[key]));
      endLabel(ch, T * 0.7, Math.max(lo, E[key][Math.round(t.length * 0.7)]), label, cls);
    }
  }
  function drawResidual() {
    const t = M.times, T = t[t.length - 1], R = M.residual;
    const keys = Object.keys(R).filter(k => k.startsWith("cpml")).sort((a, b) => +a.slice(4) - +b.slice(4));
    // the floor: low enough for the thickest layer's reflection, once the wave has reached it (the first second is ~0)
    const start = t.findIndex(x => x > 1.0), thin = R[keys[keys.length - 1]].slice(start).filter(v => v > 0);
    const lo = Math.max(1e-16, (d3.quantile(thin.sort(d3.ascending), 0.1) || 1e-12) / 3), hi = Math.max(...R.rigid) * 3;
    const ch = frame($("#cp-residual"), { x: [0, T], y: [lo, hi], logY: true, right: 58, xLabel: "simulated time [s]", yLabel: "reflected energy / peak" });
    const line = ys => d3.line()(t.map((x, i) => [ch.x(x), ch.y(Math.max(lo, ys[i]))]));
    ch.g.append("path").attr("class", "cp-line cp-rigid").attr("d", line(R.rigid));
    for (const k of keys) ch.g.append("path").attr("class", `cp-line ${k === "cpml20" ? "cp-20" : "cp-sweep"}`).attr("d", line(R[k]));
    // the labels at the right end, pushed apart so they never overlap (12 px)
    const tail = ys => d3.median(ys.slice(-8).map(v => Math.max(lo, v)));
    const labels = [["rigid", tail(R.rigid), "cp-rigid"], ...keys.map(k => [`${k.slice(4)} cells`, tail(R[k]), k === "cpml20" ? "cp-20" : "cp-sweep"])]
      .map(([text, v, cls]) => ({ text, cls, y: ch.y(v) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 12);
    for (const l of labels) ch.g.append("text").attr("class", `cp-end ${l.cls}`).attr("x", ch.w + 4).attr("y", Math.min(ch.h + 8, l.y) + 3).text(l.text);
  }
  function drawReceivers() {
    const x = M.receiver_x_km, a = M.per_receiver_db.cpml20, b = M.per_receiver_db.rigid;
    const ys = [...a, ...b], ch = frame($("#cp-rx"), { x: [0, Math.max(...x) + 0.1], y: [Math.min(...ys) - 5, Math.max(5, Math.max(...ys) + 5)],
      xLabel: "receiver, km along segment 3", yLabel: "error vs reference [dB]", right: 74 });
    for (const [vals, cls, label] of [[b, "cp-rigid", "rigid edges"], [a, "cp-20", "CPML 20"]]) {
      ch.g.append("path").attr("class", `cp-line ${cls}`).attr("d", d3.line()(x.map((v, i) => [ch.x(v), ch.y(vals[i])])));
      ch.g.selectAll(null).data(vals).join("circle").attr("class", `cp-dot ${cls}`).attr("r", 2.2).attr("cx", (v, i) => ch.x(x[i])).attr("cy", v => ch.y(v));
      endLabel(ch, x[x.length - 1], vals[vals.length - 1], label, cls);
    }
  }
  function fillNumbers() {
    const P = M.params, s20 = M.sweep.find(s => s.cells === 20), fmt = d3.format(",");
    const set = (id, v) => { const el = $(id); if (el) el.innerHTML = v; };
    set("#cp-L", `${P.thickness_m.toFixed(0)} m`); set("#cp-N", P.order); set("#cp-R", "10<sup>−8</sup>"); set("#cp-kmax", P.kappa_max);
    set("#cp-amax", `π·${P.f0.toFixed(1)} Hz = ${P.alpha_max.toFixed(1)} s<sup>−1</sup>`); set("#cp-vp", `${fmt(Math.round(P.vp_reference))} m/s`);
    set("#cp-d0", `${P.d0.toFixed(1)} s<sup>−1</sup>`);
    const stat = (v, l) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
    $("#cpml-stats").innerHTML = [
      stat(`${P.cells} cells`, `${P.thickness_m.toFixed(0)} m on the left, right and bottom; none on top (the free surface)`),
      stat(`${s20.median_db.toFixed(0)} dB`, `median error at the 39 receivers against a 64-cell reference (worst ${s20.worst_db.toFixed(0)} dB)`),
      stat(`+${s20.extra_cells_pct.toFixed(0)} %`, `cells to compute (${fmt(P.computational[0] * P.computational[1])} instead of ${fmt(P.physical[0] * P.physical[1])})`),
      stat(fmt(s20.memory_values), "convolution memories carried every step"),
    ].join("");
    $("#cp-table tbody").innerHTML = M.sweep.map(s => `<tr class="${s.cells === 20 ? "on" : ""}"><td>${s.cells || "rigid"}</td><td>+${s.extra_cells_pct.toFixed(0)} %</td>` +
      `<td>${fmt(s.memory_values)}</td><td>${Math.round(s.seconds)}</td><td>${s.median_db.toFixed(1)}</td><td>${s.worst_db.toFixed(1)}</td><td>${s.late_energy_pct < 0.01 ? s.late_energy_pct.toExponential(1) : s.late_energy_pct.toFixed(2)} %</td></tr>`).join("");
    set("#cp-check", `The 20-cell run reproduces the dataset's stored traces of seed ${M.seed} to ${M.replay_error.toExponential(0)} of the peak.`);
  }
  function drawPanel() { if (!M) return; fillNumbers(); drawProfiles(); drawEnergy(); drawResidual(); drawReceivers(); }

  async function show() {
    if (!(await load())) return false;
    build();
    await loadFilms();
    lastFrame = -1;
    requestAnimationFrame(drawPanel);
    return true;
  }
  window.CPML = { load, show, draw: t => paint(t), redraw: () => { lastFrame = -1; drawPanel(); }, get metrics() { return M; }, get ready() { return !!films; } };
})();
