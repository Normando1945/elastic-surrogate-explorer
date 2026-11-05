// Surrogate Explorer · records.js — the four panels of one receiver (d3 7.9.0, SVG).
//
// a_x(t) and a_z(t) side by side on ONE amplitude scale, Sa_x(T) and Sa_z(T) side by side on one Sa scale, so the two
// components of a pair compare by eye. Network in its component's colour (tab:blue / tab:red, as the viewer), the
// stored FDM record dashed in the ink colour. Periods below 1/fmax, where the band of the simulation ends, are shaded.
(function () {
  "use strict";
  const COMPONENTS = ["x", "z"];
  const MARGIN = { top: 22, right: 10, bottom: 38, left: 50 };
  const TIME_POINTS = 1200;                              // traces are drawn decimated by peak-preserving min/max pairs

  function minMaxDecimate(t, y, points) {
    const n = y.length, bucket = Math.max(1, Math.floor(n / (points / 2))), out = [];
    for (let s = 0; s < n; s += bucket) {
      let lo = s, hi = s;
      for (let i = s; i < Math.min(s + bucket, n); i++) { if (y[i] < y[lo]) lo = i; if (y[i] > y[hi]) hi = i; }
      if (lo < hi) out.push([t[lo], y[lo]], [t[hi], y[hi]]); else out.push([t[hi], y[hi]], [t[lo], y[lo]]);
    }
    return out;
  }

  // "Sa_x [g]" -> Sa with a real subscript x, then " [g]" (SVG text has no <sub>: a lowered, smaller tspan)
  function subscripted(text, label) {
    const m = /^(.*?)_(\w)(.*)$/.exec(label);
    if (!m) { text.text(label); return; }
    text.text(null);
    text.append("tspan").text(m[1]);
    text.append("tspan").attr("baseline-shift", "sub").attr("font-size", "80%").text(m[2]);
    text.append("tspan").text(m[3]);
  }

  function panel(svgNode, spec) {
    const svg = d3.select(svgNode);
    const width = svgNode.clientWidth || 360, height = svgNode.clientHeight || 220;
    svg.attr("viewBox", `0 0 ${width} ${height}`).selectAll("*").remove();
    const w = width - MARGIN.left - MARGIN.right, h = height - MARGIN.top - MARGIN.bottom;
    const g = svg.append("g").attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);
    const x = (spec.logX ? d3.scaleLog() : d3.scaleLinear()).domain(spec.xDomain).range([0, w]);
    const y = d3.scaleLinear().domain(spec.yDomain).range([h, 0]).nice();
    if (spec.shadeBelow) {
      g.append("rect").attr("class", "band-shade").attr("x", 0).attr("y", 0).attr("height", h)
        .attr("width", Math.max(0, x(Math.max(spec.shadeBelow, spec.xDomain[0])) - x(spec.xDomain[0])));
    }
    g.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(5).tickSize(-w).tickFormat(""));
    if (!spec.logX) g.append("line").attr("class", "zero").attr("x1", 0).attr("x2", w).attr("y1", y(0)).attr("y2", y(0));
    const xAxis = spec.logX ? d3.axisBottom(x).ticks(5, "~g") : d3.axisBottom(x).ticks(6);
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(xAxis);
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat(d3.format("~g")));
    g.append("text").attr("class", "axis-label").attr("x", w).attr("y", h + 34).attr("text-anchor", "end").text(spec.xLabel);   // below the tick labels
    g.append("text").attr("class", "axis-label").attr("transform", `translate(${-MARGIN.left + 12},${h / 2}) rotate(-90)`)
      .attr("text-anchor", "middle").call(subscripted, spec.yLabel);  // vertical, so the top line is the title's alone
    const line = d3.line().x(d => x(d[0])).y(d => y(d[1]));
    if (spec.reference) g.append("path").attr("class", "trace fdm").attr("d", line(spec.reference));
    g.append("path").attr("class", `trace net c${spec.component}`).attr("d", line(spec.network));
    g.append("text").attr("class", "panel-title").attr("x", w).attr("y", -10).attr("text-anchor", "end").text(spec.title);
  }

  function render(container, family, rec, ref, metrics) {
    // rec: DSP.receiver output; ref: {acceleration: [ax, az], sa_g: [sx, sz]} or null; metrics: per-component text
    const nt = family.clock.nt, dt = family.clock.dt, t = Float64Array.from({ length: nt }, (_, i) => i * dt);
    const periods = family.spectra.periods;
    let aMax = 0, sMax = 0;
    for (let c = 0; c < 2; c++) {
      aMax = Math.max(aMax, DSP.peakAbs(rec.acceleration[c]), ref ? DSP.peakAbs(ref.acceleration[c]) : 0);
      sMax = Math.max(sMax, ...rec.sa_g[c], ...(ref ? ref.sa_g[c] : [0]));
    }
    COMPONENTS.forEach((name, c) => {
      panel(container.querySelector(`svg[data-panel="a${name}"]`), {
        component: name, title: metrics[c].time, xLabel: "t [s]", yLabel: `a_${name} [m/s²]`,
        xDomain: [0, family.clock.duration], yDomain: [-aMax * 1.05, aMax * 1.05],
        network: minMaxDecimate(t, rec.acceleration[c], TIME_POINTS),
        reference: ref ? minMaxDecimate(t, ref.acceleration[c], TIME_POINTS) : null,
      });
      panel(container.querySelector(`svg[data-panel="sa${name}"]`), {
        component: name, title: metrics[c].spectrum, xLabel: "T [s]", yLabel: `Sa_${name} [g]`, logX: true,
        xDomain: [periods[0], periods[periods.length - 1]], yDomain: [0, sMax * 1.08], shadeBelow: family.spectra.reliable_from_s,
        network: Array.from(rec.sa_g[c], (v, p) => [periods[p], v]),
        reference: ref ? Array.from(ref.sa_g[c], (v, p) => [periods[p], v]) : null,
      });
    });
  }

  // All the receivers at once, as the viewer's surrogate tab draws them: one thin line per receiver in Sa_x and Sa_z,
  // coloured by its position along the section (plasma; its pale end cut in the light theme, where it would vanish),
  // the selected one thick in the ink colour, the band below 1/fmax shaded. A click on a line picks that receiver.
  function allSpectra(container, family, sa, k, positions, light, onPick) {
    const periods = family.spectra.periods, lo = Math.min(...positions), hi = Math.max(...positions, lo + 1e-3);
    const cut = light ? 0.85 : 1, color = x => d3.interpolatePlasma(cut * (x - lo) / (hi - lo));
    let sMax = 0;
    for (const s of sa) sMax = Math.max(sMax, ...s[0], ...s[1]);
    COMPONENTS.forEach((name, c) => {
      const svgNode = container.querySelector(`svg[data-panel="all-${name}"]`), svg = d3.select(svgNode);
      const width = svgNode.clientWidth || 360, height = svgNode.clientHeight || 220;
      svg.attr("viewBox", `0 0 ${width} ${height}`).selectAll("*").remove();
      const w = width - MARGIN.left - MARGIN.right, h = height - MARGIN.top - MARGIN.bottom;
      const g = svg.append("g").attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);
      const x = d3.scaleLog().domain([periods[0], periods[periods.length - 1]]).range([0, w]), y = d3.scaleLinear().domain([0, sMax * 1.08]).range([h, 0]).nice();
      g.append("rect").attr("class", "band-shade").attr("x", 0).attr("y", 0).attr("height", h).attr("width", Math.max(0, x(family.spectra.reliable_from_s) - x(periods[0])));
      g.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(5).tickSize(-w).tickFormat(""));
      g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(5, "~g"));
      g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5).tickFormat(d3.format("~g")));
      g.append("text").attr("class", "axis-label").attr("x", w).attr("y", h + 34).attr("text-anchor", "end").text("T [s]");
      g.append("text").attr("class", "axis-label").attr("transform", `translate(${-MARGIN.left + 12},${h / 2}) rotate(-90)`).attr("text-anchor", "middle").call(subscripted, `Sa_${name} [g]`);
      const line = d3.line().x((v, p) => x(periods[p])).y(v => y(v));
      sa.forEach((s, j) => {
        if (j === k) return;
        g.append("path").attr("class", "trace all").attr("d", line(s[c])).attr("stroke", color(positions[j]))
          .on("click", () => onPick && onPick(j)).append("title").text(`${family.receivers.labels[j]} · x = ${positions[j].toFixed(2)} km`);
      });
      g.append("path").attr("class", "trace all on").attr("d", line(sa[k][c])).append("title").text(family.receivers.labels[k]);
      g.append("text").attr("class", "panel-title").attr("x", w).attr("y", -10).attr("text-anchor", "end").text(`all ${sa.length} receivers · ${family.receivers.labels[k]} thick`);
    });
    const ramp = container.parentNode.querySelector(".all-ramp");
    if (ramp) ramp.style.background = `linear-gradient(to right, ${d3.range(0, 1.0001, 0.1).map(u => d3.interpolatePlasma(cut * u)).join(", ")})`;
  }

  window.Records = { render, allSpectra };
})();
