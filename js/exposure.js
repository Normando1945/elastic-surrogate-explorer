// Surrogate Explorer · exposure.js — Quito's exposure model (GEM TREQ, CC BY-SA 4.0): the data of the exposure chapter.
//
// Reads what exposure/ExposureWebExporter.py writes in data/exposure/ (nothing is fetched until the chapter asks):
//   exposure.json               classes (code, names, colour), the cuts of the continuous attributes (cost and night
//                               occupants), branches, totals, coverage, dictionaries, byte layouts
//   buildings_exposure.bin.gz   per footprint of data/buildings/, in that file's order: cost [kUSD], night occupants x10,
//                               assets joined, and per attribute the dominant class (u8, 0 = none) in the four branches
//   hex_<size>.bin.gz           per hexagon: axial (q, r) and totals (assets, cost, night occupants, floor area)
//   hex_<size>_<attr>.bin.gz    the same hexagons by one attribute: per branch / metric a value per class (on demand)
//   areas_<level>.bin.gz        zones / parishes / barrios: a raster of unit index + 1 on the DEM's pixel grid, and per
//                               unit its ID, totals, area, a point inside it and its composition by every attribute
//   detail/<i>_<j>.json.gz      the joined assets of one 2 km chunk of footprints (a click on a building)
// A binary file is a row of typed arrays, widest first, each aligned to its own size: exposure.json gives the offsets.
// No DOM here: app-exposure.js draws the panel, site.js the buildings and the prisms.
(function () {
  "use strict";
  const TEX_W = 2048;                                                 // the class texture: one texel per building
  const TYPES = { u1: Uint8Array, u2: Uint16Array, u4: Uint32Array, i2: Int16Array, f4: Float32Array };
  const state = { meta: null, buildings: null, loading: null, missing: false, hex: new Map(), hexAttr: new Map(), areas: new Map(), detail: new Map(), tex: new Map(), counts: new Map() };

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
  // one size of hexagons, with the axial -> local km centre of ExposureHexGrid (pointy top, anchored at the site origin);
  // with an attribute, its composition file too (merged into the same arrays: each file is fetched once)
  function hex(size, attribute = null) {
    if (!state.hex.has(size)) {
      const entry = state.meta.hex.find(h => h.size_m === size);
      const p = gz(entry.file).then(buffer => {
        const a = unpack(buffer, entry.layout), n = entry.count, R = size / Math.sqrt(3) / 1000;
        const x = new Float32Array(n), y = new Float32Array(n);
        for (let i = 0; i < n; i++) { x[i] = R * (Math.sqrt(3) * a.q[i] + Math.sqrt(3) / 2 * a.r[i]); y[i] = R * 1.5 * a.r[i]; }
        return { size, count: n, radiusKm: R, x, y, arrays: a, layout: [...entry.layout] };
      });
      p.catch(() => state.hex.delete(size));
      state.hex.set(size, p);
    }
    const base = state.hex.get(size);
    if (!attribute || continuous(attribute)) return base;
    const key = `${size}.${attribute}`;
    if (!state.hexAttr.has(key)) {
      const entry = state.meta.hex.find(h => h.size_m === size).attributes[attribute];
      const p = Promise.all([base, gz(entry.file)]).then(([hx, buffer]) => { Object.assign(hx.arrays, unpack(buffer, entry.layout)); hx.layout.push(...entry.layout); return hx; });
      p.catch(() => state.hexAttr.delete(key));
      state.hexAttr.set(key, p);
    }
    return state.hexAttr.get(key);
  }
  // one level of administrative units (zona, parroquia, barrio): the raster, every unit's sums, and the raster as an
  // RGBA texture for the relief (unit index + 1 in R + 256 G)
  const levels = () => (state.meta && state.meta.areas) || [];
  // the units' outlines for the extruded view: [unit] -> [{ outer: [[x, y] km ...], holes: [...] }] (int16 steps of quantum_m)
  function outlines(a, entry) {
    const shapes = Array.from({ length: entry.count }, () => []);
    if (!a.part_unit) return shapes;
    const q = (entry.layout.find(l => l.name === "ring_xy") || {}).quantum_m / 1000 || 0.002;
    let ring = 0, v = 0;
    for (let p = 0; p < a.part_unit.length; p++) {
      const rings = [];
      for (let r = 0; r < a.part_rings[p]; r++, ring++) {
        const n = a.ring_len[ring], pts = new Array(n); let x = 0, y = 0;
        for (let i = 0; i < n; i++, v++) { x += a.ring_xy[2 * v]; y += a.ring_xy[2 * v + 1]; pts[i] = [x * q, y * q]; }
        rings.push(pts);
      }
      shapes[a.part_unit[p]].push({ outer: rings[0], holes: rings.slice(1) });
    }
    return shapes;
  }
  function areas(level) {
    if (!state.areas.has(level)) {
      const entry = levels().find(a => a.level === level);
      const p = gz(entry.file).then(buffer => {
        const a = unpack(buffer, entry.layout), n = entry.rows * entry.cols, index = new Uint8Array(4 * n);
        for (let i = 0; i < n; i++) { const v = a.raster[i]; index[4 * i] = v & 255; index[4 * i + 1] = v >> 8; index[4 * i + 3] = 255; }
        const dict = { zona: state.meta.zonas, parroquia: state.meta.parroquias, barrio: state.meta.barrios }[level] || {};
        const names = Array.from(a.id, (id, k) => dict[String(id)] || entry.names[k]);
        return { level, count: entry.count, rows: entry.rows, cols: entry.cols, arrays: a, layout: entry.layout, names, index, entry,
                 x: a.x, y: a.y, shapes: outlines(a, entry) };
      });
      p.catch(() => state.areas.delete(level));
      state.areas.set(level, p);
    }
    return state.areas.get(level);
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
  // an attribute is a set of classes (material ... occupancy, from the taxonomy) or a value cut into classes (cost and
  // night occupants: `continuous`, the same in the four branches)
  const continuous = attribute => !!(state.meta.continuous && state.meta.continuous[attribute]);
  const spec = attribute => (continuous(attribute) ? state.meta.continuous : state.meta.attributes)[attribute];
  const classes = attribute => spec(attribute).classes;
  const perBranch = attribute => !!spec(attribute).per_branch;
  const rgb = hex => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  // the class (1-based) a value falls in: the number of lower bounds at or below it (ExposureTaxonomy.continuous_class)
  function binOf(attribute, v) {
    const lower = state.meta.continuous[attribute].lower; let k = 0;
    while (k < lower.length && v >= lower[k]) k++;
    return k;
  }
  // a footprint's value of a continuous attribute: the sum over the assets joined to it, in its own units (USD; occupants)
  const scaleOf = name => (state.meta.buildings.layout.find(l => l.name === name) || {}).scale || 1;
  const footprintValue = (i, attribute) => state.buildings[attribute][i] / scaleOf(attribute);
  const classOf = (i, attribute, branch) => (continuous(attribute) ? (state.buildings.n_assets[i] ? binOf(attribute, footprintValue(i, attribute)) : 0)
                                                                    : state.buildings[attribute][4 * i + branch]);   // for the tests: the page's own reading
  // the class texture of one attribute: texel i = building i, RGBA = its class in br1..br4 (cached: 3.7 MB each); a
  // continuous attribute has one class in every channel
  function indexTexture(attribute) {
    if (!state.tex.has(attribute)) {
      const n = state.buildings.n_assets.length, height = Math.ceil(n / TEX_W), data = new Uint8Array(TEX_W * height * 4);
      if (continuous(attribute)) for (let i = 0; i < n; i++) data.fill(classOf(i, attribute, 0), 4 * i, 4 * i + 4);
      else data.set(state.buildings[attribute]);
      state.tex.set(attribute, { index: data, width: TEX_W, height });
    }
    return state.tex.get(attribute);
  }
  // footprints per class of a continuous attribute (what the Buildings view paints; class 1 first)
  function footprintCounts(attribute) {
    if (!state.counts.has(attribute)) {
      const t = indexTexture(attribute).index, out = new Array(classes(attribute).length).fill(0);
      for (let i = 0, n = state.buildings.n_assets.length; i < n; i++) if (t[4 * i]) out[t[4 * i] - 1]++;
      state.counts.set(attribute, out);
    }
    return state.counts.get(attribute);
  }
  function palette(attribute) {                                      // texel k = class k's colour (k from 1)
    const data = new Uint8Array(32 * 4);
    classes(attribute).forEach((c, k) => data.set([...rgb(c.color), 255], 4 * (k + 1)));
    return data;
  }
  // a hexagon file's table for (attribute, branch, metric): a typed array of count x classes
  function table(hx, attribute, branchKey, metric) {
    const key = `${attribute}.${perBranch(attribute) ? branchKey : "all"}.${metric}`;
    return hx.arrays[key];
  }
  const metricScale = (hx, metric) => (hx.layout.find(l => l.name === metric) || {}).scale || 1;
  // a hexagon's (or a unit's) value of a metric, in its own units (count; USD; occupants; m²)
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
    load, hex, areas, levels, detail, indexTexture, palette, classes, perBranch, continuous, binOf, footprintValue, footprintCounts, classOf, table, value, words, storeys, rgb,
    get meta() { return state.meta; }, get buildings() { return state.buildings; }, get missing() { return state.missing; },
    get loadedHex() { return [...state.hex.keys()]; },
  };
})();
