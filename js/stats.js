// Surrogate Explorer · stats.js — the records, by the numbers: the station card of the team's SRF Explorer, here the
// network against the finite-difference simulation (d3 7.9.0, SVG).
//
// Per record (receiver k, component c, medium): the eight intensity measures of dsp.js (PGA, PGV, PGD, Arias, CAV,
// D5–95, and Sa, Sd at the period of the slider). Then their spread: over the six test media at one receiver (median,
// 16–84 %, beta = std ln IM, max/min), the median spectrum and beta(T), every record against hypocentral distance, the
// measure along the section, and eta², the share of the variance of ln IM that the medium and the receiver's place
// explain. Last, the whole test split from Python (web/tools/export_stats.py). app.js feeds the media and the geometry.
(function () {
  "use strict";
  const IMS = [["PGA", "PGA", "g"], ["PGV", "PGV", "m/s"], ["PGD", "PGD", "m"], ["Arias", "IA (Arias)", "m/s"], ["CAV", "CAV", "m/s"],
               ["D5_95", "D5–95", "s"], ["Sa", "Sa(T)", "g"], ["Sd", "Sd(T)", "cm"]];
  const QTY = { a: ["acceleration", "a [m/s²]"], v: ["velocity", "v [m/s]"], d: ["displacement", "d [m]"] };
  const $ = s => document.querySelector(s);
  const fmt = v => (Number.isFinite(v) ? d3.format(".3~g")(v) : "—");
  const S = { family: null, geo: null, test: null, media: new Map(), seed: null, rx: 0, comp: 0, qty: "a", im: "PGA", T: 1, spec: "Sa",
              onPick: null, onMedium: null };

  // ---------------------------------------------------------------- data
  // get(k, c) -> { netAcc, fdmAcc (Float32Array, m/s²), netSa, fdmSa (g, the family's periods) }
  function addMedium(seed, get) {
    const f = S.family, n = f.receivers.x.length, dt = f.clock.dt, g = f.spectra.g, recs = [];
    const keep = m => ({ PGA: m.PGA, PGV: m.PGV, PGD: m.PGD, Arias: m.Arias, CAV: m.CAV, D5_95: m.D5_95 });
    for (let k = 0; k < n; k++) recs.push([0, 1].map(c => {
      const r = get(k, c);
      return { net: { ...keep(DSP.measures(r.netAcc, dt, g)), sa: r.netSa, acc: r.netAcc }, fdm: { ...keep(DSP.measures(r.fdmAcc, dt, g)), sa: r.fdmSa, acc: r.fdmAcc } };
    }));
    S.media.set(seed, { recs, T: null });
  }
  function ensureT() {                                                // Sa and Sd at the slider's period, every record of every medium
    const f = S.family;
    for (const md of S.media.values()) {
      if (md.T === S.T) continue;
      for (const pair of md.recs) for (const r of pair) for (const side of [r.net, r.fdm]) Object.assign(side, DSP.atPeriod(side.acc, f.clock.dt, S.T, f.spectra.g, f.spectra.damping));
      md.T = S.T;
    }
  }
  const seeds = () => [...S.media.keys()];
  const rec = (seed, k, c = S.comp) => S.media.get(seed).recs[k][c];
  function lnStats(values) {
    const v = values.filter(x => x > 0), n = v.length;
    if (!n) return null;
    const l = v.map(Math.log), mu = d3.mean(l), b = n > 1 ? d3.deviation(l) : 0;
    return { n, med: Math.exp(mu), beta: b, lo: Math.exp(mu - b), hi: Math.exp(mu + b), min: d3.min(v), max: d3.max(v) };
  }
  const specOf = (side, T) => (S.spec === "Sa" ? side.sa : side.sa.map((s, p) => s * S.family.spectra.g * Math.pow(S.family.spectra.periods[p] / (2 * Math.PI), 2) * 100));
  const imLabel = (im = S.im) => { const it = IMS.find(q => q[0] === im); return (im === "Sa" || im === "Sd" ? `${im}(${fmt(S.T)} s)` : it[1]) + ` [${it[2]}]`; };

  // ---------------------------------------------------------------- charts
  function frame(svgNode, spec) {
    const svg = d3.select(svgNode), width = svgNode.clientWidth || 420, height = svgNode.clientHeight || 170;
    const m = { top: spec.legend ? 24 : 12, right: 12, bottom: 36, left: 54 }, w = width - m.left - m.right, h = height - m.top - m.bottom;
    svg.attr("viewBox", `0 0 ${width} ${height}`).selectAll("*").remove();
    const g = svg.append("g").attr("transform", `translate(${m.left},${m.top})`);
    const x = (spec.logX ? d3.scaleLog() : d3.scaleLinear()).domain(spec.x).range([0, w]);
    const y = (spec.logY ? d3.scaleLog() : d3.scaleLinear()).domain(spec.y).range([h, 0]);
    if (!spec.logY) y.nice();
    if (spec.shadeBelow) g.append("rect").attr("class", "band-shade").attr("x", 0).attr("y", 0).attr("height", h).attr("width", Math.max(0, x(Math.max(spec.shadeBelow, spec.x[0]))));
    g.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(4).tickSize(-w).tickFormat(""));
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(spec.logX ? d3.axisBottom(x).ticks(5, "~g") : d3.axisBottom(x).ticks(6));
    g.append("g").attr("class", "axis").call(spec.logY ? d3.axisLeft(y).ticks(4, "~g") : d3.axisLeft(y).ticks(4).tickFormat(d3.format("~g")));
    g.append("text").attr("class", "axis-label").attr("x", w).attr("y", h + 32).attr("text-anchor", "end").text(spec.xLabel);
    g.append("text").attr("class", "axis-label").attr("transform", `translate(${-m.left + 12},${h / 2}) rotate(-90)`).attr("text-anchor", "middle").text(spec.yLabel);
    if (spec.legend) g.append("text").attr("class", "legend-text").attr("x", w).attr("y", -10).attr("text-anchor", "end").text(spec.legend);
    return { g, x, y, w, h, m };
  }
  const extent = (vals, pad = 1.15) => { const v = vals.filter(x => x > 0); const lo = d3.min(v) || 1e-6, hi = d3.max(v) || 1; return [lo / pad, hi * pad]; };
  const cc = () => (S.comp ? "cz" : "cx");

  function drawRecord() {
    const f = S.family, r = rec(S.seed, S.rx), dt = f.clock.dt, g = f.spectra.g;
    const net = DSP.measures(r.net.acc, dt, g), fdm = DSP.measures(r.fdm.acc, dt, g), key = S.qty;
    const series = [fdm[key], net[key]], peak = Math.max(DSP.peakAbs(series[0]), DSP.peakAbs(series[1])) * 1.08 || 1;
    const ch = frame($("#st-record"), { x: [0, f.clock.duration], y: [-peak, peak], xLabel: "t [s]", yLabel: QTY[key][1] });
    const step = Math.max(1, Math.floor(series[0].length / 900));
    const line = a => d3.line()(d3.range(0, a.length, step).map(i => [ch.x(i * dt), ch.y(a[i])]));
    ch.g.append("path").attr("class", "trace fdm").attr("d", line(series[0]));
    ch.g.append("path").attr("class", `trace net ${cc()}`).attr("d", line(series[1]));
  }

  function drawImTable() {
    const r = rec(S.seed, S.rx);
    $("#st-ims").innerHTML = `<thead><tr><th>Measure</th><th>Simulation</th><th>Network</th><th>net / FDM</th><th>error</th></tr></thead><tbody>` +
      IMS.map(([k]) => {
        const a = r.fdm[k], b = r.net[k], q = b / a;
        return `<tr data-im="${k}" class="${k === S.im ? "on" : ""}"><td>${imLabel(k)}</td><td>${fmt(a)}</td><td>${fmt(b)}</td><td>${fmt(q)}</td>` +
               `<td class="${Math.abs(q - 1) > 0.25 ? "warn" : ""}">${(100 * (q - 1)).toFixed(1)} %</td></tr>`;
      }).join("") + "</tbody>";
  }

  function drawSpectrum() {
    const f = S.family, P = f.spectra.periods, r = rec(S.seed, S.rx), a = specOf(r.fdm), b = specOf(r.net);
    const ch = frame($("#st-spectrum"), { x: [P[0], P[P.length - 1]], y: [0, Math.max(d3.max(a), d3.max(b)) * 1.1], logX: true, xLabel: "T [s]",
                                          yLabel: S.spec === "Sa" ? "Sa [g]" : "Sd [cm]", shadeBelow: 1 / f.clock.fmax });
    const line = s => d3.line()(P.map((T, p) => [ch.x(T), ch.y(s[p])]));
    ch.g.append("path").attr("class", "trace fdm").attr("d", line(a));
    ch.g.append("path").attr("class", `trace net ${cc()}`).attr("d", line(b));
    ch.g.append("line").attr("class", "cursor").attr("x1", ch.x(S.T)).attr("x2", ch.x(S.T)).attr("y1", 0).attr("y2", ch.h);
  }

  // the spread of the chosen measure
  const val = (side, im = S.im) => side[im];
  function statRow(label, q, cls = "") {
    return q ? `<tr class="${cls}"><td>${label}</td><td>${q.n}</td><td>${fmt(q.med)}</td><td>${fmt(q.lo)}–${fmt(q.hi)}</td><td><b>${q.beta.toFixed(2)}</b></td><td>${fmt(q.max / q.min)}</td></tr>` : "";
  }
  function drawDispersion() {
    const ss = seeds(), k = S.rx, n = S.family.receivers.x.length;
    const overMedia = side => ss.map(sd => val(rec(sd, k)[side])), overRx = side => d3.range(n).map(j => val(rec(S.seed, j)[side]));
    const ratio = ss.map(sd => val(rec(sd, k).net) / val(rec(sd, k).fdm));
    $("#st-disp").innerHTML = `<thead><tr><th>${imLabel()}</th><th>n</th><th>median</th><th>16–84 %</th><th>β</th><th>max/min</th></tr></thead><tbody>` +
      statRow("Simulation · 6 media", lnStats(overMedia("fdm"))) + statRow("Network · 6 media", lnStats(overMedia("net")), "net") +
      statRow("net / FDM · 6 media", lnStats(ratio), "ratio") +
      statRow(`Simulation · 39 receivers, seed ${S.seed}`, lnStats(overRx("fdm"))) + statRow(`Network · 39 receivers, seed ${S.seed}`, lnStats(overRx("net")), "net") + "</tbody>";
  }
  function bandsOver(arrays) {                                        // per index: lnStats over the arrays (the media)
    return d3.range(arrays[0].length).map(p => lnStats(arrays.map(a => a[p])));
  }
  function drawMedianSpectrum() {
    const f = S.family, P = f.spectra.periods, ss = seeds();
    const fdm = bandsOver(ss.map(sd => specOf(rec(sd, S.rx).fdm))), net = bandsOver(ss.map(sd => specOf(rec(sd, S.rx).net)));
    const ch = frame($("#st-median"), { x: [P[0], P[P.length - 1]], y: [0, d3.max([...fdm, ...net], q => (q ? q.hi : 0)) * 1.08], logX: true, xLabel: "T [s]",
                                        yLabel: S.spec === "Sa" ? "Sa [g]" : "Sd [cm]", shadeBelow: 1 / f.clock.fmax });
    for (const [q, cls] of [[fdm, "fdm"], [net, `net ${cc()}`]]) {
      ch.g.append("path").attr("class", `st-band ${cls}`).attr("d", d3.area().x((_, p) => ch.x(P[p])).y0(d => ch.y(d.lo)).y1(d => ch.y(d.hi))(q));
      ch.g.append("path").attr("class", `trace ${cls}`).attr("d", d3.line().x((_, p) => ch.x(P[p])).y(d => ch.y(d.med))(q));
    }
  }
  function drawBeta() {
    const f = S.family, P = f.spectra.periods, ss = seeds();
    const fdm = bandsOver(ss.map(sd => rec(sd, S.rx).fdm.sa)), net = bandsOver(ss.map(sd => rec(sd, S.rx).net.sa));
    const ch = frame($("#st-beta"), { x: [P[0], P[P.length - 1]], y: [0, d3.max([...fdm, ...net], q => q.beta) * 1.15 || 1], logX: true, xLabel: "T [s]",
                                      yLabel: "β = std ln Sa", shadeBelow: 1 / f.clock.fmax });
    ch.g.append("path").attr("class", "trace fdm").attr("d", d3.line().x((_, p) => ch.x(P[p])).y(q => ch.y(q.beta))(fdm));
    ch.g.append("path").attr("class", `trace net ${cc()}`).attr("d", d3.line().x((_, p) => ch.x(P[p])).y(q => ch.y(q.beta))(net));
  }

  let scatterPts = [];
  function drawScatter() {
    const ss = seeds(), n = S.family.receivers.x.length, R = S.geo.rhyp, pts = [];
    for (const sd of ss) for (let k = 0; k < n; k++) for (const side of ["fdm", "net"]) pts.push({ sd, k, side, x: R[k], y: val(rec(sd, k)[side]) });
    const ch = frame($("#st-scatter"), { x: [d3.min(R) * 0.95, d3.max(R) * 1.03], y: extent(pts.map(p => p.y)), logY: true,
                                         xLabel: "hypocentral distance [km]", yLabel: imLabel() });
    const on = p => p.sd === S.seed;
    ch.g.selectAll("circle").data(pts.sort((a, b) => on(a) - on(b))).join("circle")
      .attr("cx", p => ch.x(p.x)).attr("cy", p => ch.y(p.y)).attr("r", p => (on(p) ? 3.2 : 2.4))
      .attr("class", p => `st-pt ${p.side === "net" ? "net " + cc() : "fdm"}${on(p) ? " on" : ""}`);
    const sel = pts.filter(p => p.sd === S.seed && p.k === S.rx);
    ch.g.selectAll("circle.sel").data(sel).join("circle").attr("class", "sel").attr("cx", p => ch.x(p.x)).attr("cy", p => ch.y(p.y)).attr("r", 7);
    scatterPts = pts.map(p => ({ ...p, px: ch.x(p.x) + ch.m.left, py: ch.y(p.y) + ch.m.top }));
  }
  function pickScatter(e) {
    const svg = $("#st-scatter"), box = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal, sx = vb.width / box.width;
    const px = (e.clientX - box.left) * sx, py = (e.clientY - box.top) * sx;
    let best = null, bd = 12 * sx;
    for (const p of scatterPts) { const d = Math.hypot(p.px - px, p.py - py); if (d < bd) { bd = d; best = p; } }
    if (best && S.onPick) S.onPick(best.sd, best.k);
  }

  function drawAlong() {
    const ss = seeds(), n = S.family.receivers.x.length, X = S.geo.along, Z = S.geo.elev;
    const fdm = d3.range(n).map(k => lnStats(ss.map(sd => val(rec(sd, k).fdm)))), net = d3.range(n).map(k => lnStats(ss.map(sd => val(rec(sd, k).net))));
    const lo = d3.min([...fdm, ...net], q => q.lo), hi = d3.max([...fdm, ...net], q => q.hi), span = Math.log(hi / lo) || 1;
    // the terrain takes the bottom quarter, under the bands: extend the log axis down by a third of its span
    const ch = frame($("#st-along"), { x: [X[0], X[n - 1]], y: [lo / Math.exp(span * 0.45), hi * 1.1], logY: true, xLabel: "distance along segment 3 [km]", yLabel: imLabel() });
    const zlo = d3.min(Z), zhi = d3.max(Z), ty = z => ch.h - (z - zlo) / Math.max(zhi - zlo, 1) * ch.h * 0.22;
    ch.g.append("path").attr("class", "st-terrain").attr("d", d3.area().x((_, k) => ch.x(X[k])).y0(ch.h).y1(z => ty(z))(Z));
    for (const [q, cls] of [[fdm, "fdm"], [net, `net ${cc()}`]]) {
      ch.g.append("path").attr("class", `st-band ${cls}`).attr("d", d3.area().x((_, k) => ch.x(X[k])).y0(d => ch.y(d.lo)).y1(d => ch.y(d.hi))(q));
      ch.g.append("path").attr("class", `trace ${cls}`).attr("d", d3.line().x((_, k) => ch.x(X[k])).y(d => ch.y(d.med))(q));
    }
    ch.g.append("line").attr("class", "cursor").attr("x1", ch.x(X[S.rx])).attr("x2", ch.x(X[S.rx])).attr("y1", 0).attr("y2", ch.h);
  }

  // eta²: how much of the variance of ln IM over the 6 x 39 table the medium explains, and the receiver's place
  function eta2(side) {
    const ss = seeds(), n = S.family.receivers.x.length, v = [];
    ss.forEach((sd, m) => { for (let k = 0; k < n; k++) { const x = val(rec(sd, k)[side]); if (x > 0) v.push([m, k, Math.log(x)]); } });
    const mu = d3.mean(v, q => q[2]), sst = d3.sum(v, q => (q[2] - mu) ** 2) || 1;
    const part = i => d3.sum(d3.rollups(v, l => l.length * (d3.mean(l, q => q[2]) - mu) ** 2, q => q[i]), d => d[1]) / sst;
    return { medium: part(0), receiver: part(1) };
  }
  function drawEta() {
    const pct = x => `${(100 * x).toFixed(0)} %`, rows = [["Simulation", eta2("fdm"), ""], ["Network", eta2("net"), "net"]];
    $("#st-eta").innerHTML = `<thead><tr><th>η² of ln ${imLabel()}</th><th>the medium</th><th>the receiver's place</th><th>neither (interaction)</th></tr></thead><tbody>` +
      rows.map(([l, e, cls]) => `<tr class="${cls}"><td>${l}</td><td>${pct(e.medium)}</td><td>${pct(e.receiver)}</td><td>${pct(Math.max(0, 1 - e.medium - e.receiver))}</td></tr>`).join("") + "</tbody>";
  }

  function testKey() {                                                // the test split's row for the chosen measure
    if (S.im !== "Sa" && S.im !== "Sd") return S.im;
    const Ts = [0.2, 0.5, 1, 2], T = Ts.reduce((a, b) => (Math.abs(Math.log(b / S.T)) < Math.abs(Math.log(a / S.T)) ? b : a));
    return `${S.im}(${T} s)`;
  }
  function drawTest() {
    const t = S.test;
    if (!t) { $("#st-test-note").textContent = "No test-split summary exported (python web/tools/export_stats.py)."; $("#st-test").innerHTML = ""; return; }
    const comp = S.comp ? "z" : "x", w = t.waveform_corr[comp], on = testKey();
    $("#st-test-note").textContent = `${t.media} test media × ${t.receivers} receivers, component ${comp}, the network in PyTorch against the stored ` +
      `simulations. Waveform correlation of a(t): median ${w.p50.toFixed(2)} (16–84 %: ${w.p16.toFixed(2)}–${w.p84.toFixed(2)}).`;
    $("#st-test").innerHTML = `<thead><tr><th>Measure</th><th>median FDM</th><th>median net</th><th>net / FDM</th><th>σ ln</th><th>ρ ln</th><th>within ×2</th></tr></thead><tbody>` +
      Object.entries(t.ims).map(([k, q]) => {
        const s = q[comp];
        return `<tr class="${k === on ? "on" : ""}"><td>${k.replace("D5_95", "D5–95")} [${q.unit}]</td><td>${fmt(s.median_fdm)}</td><td>${fmt(s.median_net)}</td>` +
               `<td>${s.bias.toFixed(3)}</td><td>${s.sigma.toFixed(3)}</td><td>${s.rho.toFixed(3)}</td><td>${(100 * s.within2).toFixed(0)} %</td></tr>`;
      }).join("") + "</tbody>";
    const P = t.spectral.periods, sp = t.spectral[comp], f = S.family;
    const band = P.map((_, p) => [sp.bias[p] * Math.exp(-sp.sigma[p]), sp.bias[p] * Math.exp(sp.sigma[p])]);
    const ch = frame($("#st-test-spec"), { x: [P[0], P[P.length - 1]], y: [Math.min(0.5, d3.min(band, b => b[0])), Math.max(2, d3.max(band, b => b[1]))], logX: true, logY: true,
                                           xLabel: "T [s]", yLabel: "net / FDM of Sa", legend: "median ratio and its ±1σ band, all test records", shadeBelow: 1 / f.clock.fmax });
    ch.g.append("line").attr("class", "st-one").attr("x1", 0).attr("x2", ch.w).attr("y1", ch.y(1)).attr("y2", ch.y(1));
    ch.g.append("path").attr("class", `st-band net ${cc()}`).attr("d", d3.area().x((_, p) => ch.x(P[p])).y0(b => ch.y(b[0])).y1(b => ch.y(b[1]))(band));
    ch.g.append("path").attr("class", `trace net ${cc()}`).attr("d", d3.line().x((_, p) => ch.x(P[p])).y(b => ch.y(b))(sp.bias));
  }

  // ---------------------------------------------------------------- the whole card
  function render() {
    if (!S.media.has(S.seed)) return;
    ensureT();
    const f = S.family;
    $("#st-rx-name").textContent = f.receivers.labels[S.rx];
    $("#st-rx-place").innerHTML = `x = ${S.geo.along[S.rx].toFixed(2)} km along segment 3 · R<sub>hyp</sub> ${S.geo.rhyp[S.rx].toFixed(2)} km · seed ${S.seed}`;
    $("#st-prev").disabled = S.rx === 0; $("#st-next").disabled = S.rx === f.receivers.x.length - 1;
    const mark = (sel, v) => document.querySelectorAll(`${sel} [data-v]`).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === String(v))));
    mark("#st-media", S.seed); mark("#st-comp", S.comp); mark("#st-qty", S.qty); mark("#st-im", S.im); mark("#st-spec", S.spec);
    $("#st-T-out").textContent = `${S.T.toFixed(2)} s`;
    document.querySelectorAll(".st-key").forEach(k => { k.classList.toggle("cx", !S.comp); k.classList.toggle("cz", !!S.comp); });   // the key wears the component's colour
    drawRecord(); drawImTable(); drawSpectrum(); drawDispersion(); drawMedianSpectrum(); drawBeta(); drawScatter(); drawAlong(); drawEta(); drawTest();
    S.rendered = performance.now();
  }
  let pending = false;
  const soon = () => { if (!pending) { pending = true; requestAnimationFrame(() => { pending = false; render(); }); } };

  function init({ family, geo, test, media, onPick, onMedium }) {
    Object.assign(S, { family, geo, test, onPick, onMedium });
    const P = family.spectra.periods, Tmin = P[0], Tmax = P[P.length - 1];
    const toT = v => Tmin * Math.pow(Tmax / Tmin, v / 1000), fromT = T => Math.round(1000 * Math.log(T / Tmin) / Math.log(Tmax / Tmin));
    S.setT = T => { S.T = Math.min(Tmax, Math.max(Tmin, T)); $("#st-T").value = fromT(S.T); soon(); };
    $("#st-media").innerHTML = media.map(sd => `<button type="button" class="chip small" data-v="${sd}">Seed ${sd}</button>`).join("");
    $("#st-im").innerHTML = IMS.map(([k, l]) => `<button type="button" class="chip small" data-v="${k}">${l}</button>`).join("");
    $("#st-T-chips").innerHTML = [0.2, 0.5, 1, 2].filter(T => T >= Tmin && T <= Tmax).map(T => `<button type="button" class="chip small" data-t="${T}">${T} s</button>`).join("");
    const chips = (sel, fn) => $(sel).addEventListener("click", e => { const b = e.target.closest("[data-v]"); if (b) fn(b.dataset.v); });
    chips("#st-media", v => S.onMedium && S.onMedium(Number(v)));
    chips("#st-comp", v => { S.comp = Number(v); soon(); });
    chips("#st-qty", v => { S.qty = v; soon(); });
    chips("#st-im", v => { S.im = v; soon(); });
    chips("#st-spec", v => { S.spec = v; soon(); });
    $("#st-ims").addEventListener("click", e => { const tr = e.target.closest("[data-im]"); if (tr) { S.im = tr.dataset.im; soon(); } });
    $("#st-T").addEventListener("input", e => { S.T = toT(Number(e.target.value)); soon(); });
    $("#st-T-chips").addEventListener("click", e => { const b = e.target.closest("[data-t]"); if (b) { if (S.im !== "Sa" && S.im !== "Sd") S.im = "Sa"; S.setT(Number(b.dataset.t)); } });
    $("#st-scatter").addEventListener("click", pickScatter);
    $("#st-prev").addEventListener("click", () => S.onPick && S.onPick(S.seed, S.rx - 1));
    $("#st-next").addEventListener("click", () => S.onPick && S.onPick(S.seed, S.rx + 1));
    S.setT(1);
  }

  window.Stats = {
    init, addMedium, render: soon, renderNow: render,
    has: seed => S.media.has(seed), get ready() { return S.media.size > 0; },
    select(seed, k) { S.seed = seed; S.rx = k; soon(); },
    get state() { return { seed: S.seed, rx: S.rx, comp: S.comp, qty: S.qty, im: S.im, T: S.T, spec: S.spec, media: S.media.size, rendered: S.rendered }; },
    set(values) { Object.assign(S, values); if (values.T) S.setT(values.T); soon(); },
    record: (seed, k, c) => { const r = rec(seed, k, c); ensureT(); return { net: { ...r.net, acc: undefined, sa: undefined }, fdm: { ...r.fdm, acc: undefined, sa: undefined } }; },   // for the tests
    eta2, lnStats,
  };
})();
