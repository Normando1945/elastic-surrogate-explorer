// Surrogate Explorer · app-solver.js — source, wavefield and solver chapter.
// Split from app.js; this remains a classic script so the public builder can version every file independently.
"use strict";

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
