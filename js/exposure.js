// Surrogate Explorer · exposure.js — Quito's exposure model (GEM TREQ, CC BY-SA 4.0): the data of the exposure chapter.
//
// Reads what exposure/ExposureWebExporter.py writes in data/exposure/ (nothing is fetched until the chapter asks):
//   exposure.json               classes (code, names, colour), branches, totals, coverage, dictionaries, byte layouts
//   buildings_exposure.bin.gz   per footprint of data/buildings/, in that file's order: cost [kUSD], night occupants x10,
//                               assets joined, and per attribute the dominant class (u8, 0 = none) in the four branches
//   hex_<size>.bin.gz           per hexagon: axial (q, r), totals, and per attribute / branch / metric a value per class
//   detail/<i>_<j>.json.gz      the joined assets of one 2 km chunk of footprints (a click on a building)
// A binary file is a row of typed arrays, widest first, each aligned to its own size: exposure.json gives the offsets.
// No DOM here: app-exposure.js draws the panel, site.js the buildings and the prisms.
(function () {
  "use strict";
  const TEX_W = 2048;                                                 // the class texture: one texel per building
  const TYPES = { u1: Uint8Array, u2: Uint16Array, u4: Uint32Array, i2: Int16Array, f4: Float32Array };
  const state = { meta: null, buildings: null, loading: null, missing: false, hex: new Map(), detail: new Map(), tex: new Map() };

  async function gz(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  }
  function unpack(buffer, layout) {
    const out = {};
    for (const it of layout) {
      const T = TYPES[it.dtype]; if (!T) throw new Error(`exposure: unknown dtype ${it.dtype}`);
      out[it.name] = new T(buffer, it.offset, it.shape.reduce((a, b) => a * b, 1));
    }
    return out;
  }

  // exposure.json and the per-footprint file; null (and `missing`) when this build has no exposure data
  function load() {
    if (state.loading) return state.loading;
    state.loading = (async () => {
      const r = await fetch("data/exposure/exposure.json").catch(() => null);
      if (!r || !r.ok) { state.missing = true; return null; }
      const meta = await r.json();
      state.buildings = unpack(await gz(meta.buildings.file), meta.buildings.layout);
      state.meta = meta;
      return meta;
    })();
    state.loading.catch(() => { state.loading = null; });
    return state.loading;
  }
  // one size of hexagons, with the axial -> local km centre of ExposureHexGrid (pointy top, anchored at the site origin)
  function hex(size) {
    if (!state.hex.has(size)) {
      const entry = state.meta.hex.find(h => h.size_m === size);
      const p = gz(entry.file).then(buffer => {
        const a = unpack(buffer, entry.layout), n = entry.count, R = size / Math.sqrt(3) / 1000;
        const x = new Float32Array(n), y = new Float32Array(n);
        for (let i = 0; i < n; i++) { x[i] = R * (Math.sqrt(3) * a.q[i] + Math.sqrt(3) / 2 * a.r[i]); y[i] = R * 1.5 * a.r[i]; }
        return { size, count: n, radiusKm: R, x, y, arrays: a, layout: entry.layout };
      });
      p.catch(() => state.hex.delete(size));
      state.hex.set(size, p);
    }
    return state.hex.get(size);
  }
  function detail(chunk) {
    if (!state.detail.has(chunk)) {
      const p = gz(`${state.meta.detail.dir}/${chunk}.json.gz`).then(b => JSON.parse(new TextDecoder().decode(b)));
      p.catch(() => state.detail.delete(chunk));
      state.detail.set(chunk, p);
    }
    return state.detail.get(chunk);
  }

  // ---------------------------------------------------------------- classes and colours
  const classes = attribute => state.meta.attributes[attribute].classes;
  const perBranch = attribute => state.meta.attributes[attribute].per_branch;
  const rgb = hex => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  // the class texture of one attribute: texel i = building i, RGBA = its class in br1..br4 (cached: 3.7 MB each)
  function indexTexture(attribute) {
    if (!state.tex.has(attribute)) {
      const src = state.buildings[attribute], n = src.length / 4, height = Math.ceil(n / TEX_W), data = new Uint8Array(TEX_W * height * 4);
      data.set(src);
      state.tex.set(attribute, { index: data, width: TEX_W, height });
    }
    return state.tex.get(attribute);
  }
  function palette(attribute) {                                      // texel k = class k's colour (k from 1)
    const data = new Uint8Array(32 * 4);
    classes(attribute).forEach((c, k) => data.set([...rgb(c.color), 255], 4 * (k + 1)));
    return data;
  }
  const classOf = (i, attribute, branch) => state.buildings[attribute][4 * i + branch];   // for the tests: the page's own reading
  // a hexagon file's table for (attribute, branch, metric): a typed array of count x classes
  function table(hx, attribute, branchKey, metric) {
    const key = `${attribute}.${perBranch(attribute) ? branchKey : "all"}.${metric}`;
    return hx.arrays[key];
  }
  const metricScale = (hx, metric) => (hx.layout.find(l => l.name === metric) || {}).scale || 1;
  // a hexagon's value of a metric, in its own units (count; USD; occupants)
  function value(hx, metric, i) {
    const a = hx.arrays[metric === "count" ? "n_assets" : metric];
    return a[i] / metricScale(hx, metric);
  }

  // ---------------------------------------------------------------- the taxonomy in words
  function taxonomyParts(t) {
    const [material, middle, height] = t.split("/"), cut = middle.lastIndexOf("+");
    return { material, llrs: middle.slice(0, cut), code: middle.slice(cut + 1), height };
  }
  function storeys(height) {
    const m = /^HEX:(\d+)$/.exec(height), r = /^HBET:(\d+)-(\d+)$/.exec(height);
    return m ? (m[1] === "1" ? "1 storey" : `${m[1]} storeys`) : r ? `${r[1]} to ${r[2]} storeys` : height;
  }
  function words(t) {
    const p = taxonomyParts(t), name = (attribute, code) => (classes(attribute).find(c => c.code === code) || { en: code }).en;
    return { codes: p, material: name("material", p.material), llrs: name("llrs", p.llrs), ductility: name("ductility", p.code), storeys: storeys(p.height) };
  }

  window.Exposure = {
    load, hex, detail, indexTexture, palette, classes, perBranch, classOf, table, value, words, storeys, rgb,
    get meta() { return state.meta; }, get buildings() { return state.buildings; }, get missing() { return state.missing; },
    get loadedHex() { return [...state.hex.keys()]; },
  };
})();
