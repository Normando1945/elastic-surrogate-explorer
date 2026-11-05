// Surrogate Explorer · globe.js — the locator globe in the corner (d3 orthographic projection on a canvas).
//
// Land and borders: Natural Earth 1:110m via world-atlas 2.0.2 (vendor/world/, TopoJSON read with topojson-client).
// Quito sits at the centre with a ring, and the section A–B is drawn when the globe is zoomed in far enough to see it.
(function () {
  "use strict";
  const QUITO = [-78.48, -0.18];
  let world = null;

  async function loadWorld() {
    if (world) return world;
    const [land, countries] = await Promise.all(["vendor/world/land-110m.json", "vendor/world/countries-110m.json"].map(u => fetch(u).then(r => r.json())));
    world = { land: topojson.feature(land, land.objects.land), borders: topojson.mesh(countries, countries.objects.countries, (a, b) => a !== b),
              ecuador: topojson.feature(countries, countries.objects.countries).features.find(f => f.properties.name === "Ecuador") };
    return world;
  }

  function create(canvas, options = {}) {
    const state = { rotate: [-QUITO[0] + 12, -QUITO[1] + 12, 0], theme: null, pulse: 0, section: options.section || null };
    const ctx = canvas.getContext("2d");

    function colors() {
      const css = getComputedStyle(document.documentElement), get = n => css.getPropertyValue(n).trim();
      return { sea: get("--globe-sea"), land: get("--globe-land"), line: get("--globe-line"), accent: get("--accent"), ink: get("--fg") };
    }

    function draw() {
      if (!world) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2), size = canvas.clientWidth;
      if (canvas.width !== Math.round(size * dpr)) { canvas.width = canvas.height = Math.round(size * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const c = colors(), r = size / 2 - 1;
      const projection = d3.geoOrthographic().translate([size / 2, size / 2]).scale(r).rotate(state.rotate).clipAngle(90);
      const path = d3.geoPath(projection, ctx);
      ctx.clearRect(0, 0, size, size);
      ctx.beginPath(); path({ type: "Sphere" }); ctx.fillStyle = c.sea; ctx.fill();
      ctx.beginPath(); path(d3.geoGraticule10()); ctx.strokeStyle = c.line; ctx.globalAlpha = 0.35; ctx.lineWidth = 0.5; ctx.stroke(); ctx.globalAlpha = 1;
      ctx.beginPath(); path(world.land); ctx.fillStyle = c.land; ctx.fill();
      ctx.beginPath(); path(world.borders); ctx.strokeStyle = c.line; ctx.lineWidth = 0.6; ctx.stroke();
      if (world.ecuador) { ctx.beginPath(); path(world.ecuador); ctx.strokeStyle = c.accent; ctx.lineWidth = 1.2; ctx.stroke(); }
      const p = projection(QUITO);
      if (p) {
        const pulse = 5 + 7 * (0.5 + 0.5 * Math.sin(state.pulse));
        ctx.beginPath(); ctx.arc(p[0], p[1], pulse, 0, 2 * Math.PI); ctx.strokeStyle = c.accent; ctx.globalAlpha = 0.55; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.globalAlpha = 1; ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, 2 * Math.PI); ctx.fillStyle = c.accent; ctx.fill();
      }
      ctx.beginPath(); path({ type: "Sphere" }); ctx.strokeStyle = c.line; ctx.lineWidth = 1; ctx.stroke();
    }

    let raf = null;
    function tick() { state.pulse += 0.06; draw(); raf = requestAnimationFrame(tick); }
    loadWorld().then(() => { draw(); if (!matchMedia("(prefers-reduced-motion: reduce)").matches) tick(); });
    return { redraw: draw, stop: () => cancelAnimationFrame(raf), get ready() { return !!world; } };
  }

  window.Globe = { create, loadWorld, QUITO };
})();
