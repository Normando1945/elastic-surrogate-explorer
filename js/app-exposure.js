// Surrogate Explorer · app-exposure.js — the exposure chapter: who and what stands on the relief (GEM TREQ, CC BY-SA 4.0).
// A classic script like the other app-*.js (the public builder versions each one). exposure.js reads the data, site.js
// draws it: the city coloured by class (Buildings), prisms on hexagons (Hexagons), or the zones / parishes / barrios
// painted on the relief (Areas). The view lives in the URL as xview / xattr / xbranch / xhex / xh / xstack / xlevel,
// its own names, removed when the chapter is left.
"use strict";

  const EXPOSURE_LAYERS = { terrain: true, section: false, faults: false, planes: false, zones: false, urban: false, receivers: false, rupture: false, footprint: false };
  const EXPO_ATTRS = { material: "Material", llrs: "Lateral system", ductility: "Ductility", storeys: "Storeys", occupancy: "Occupancy",
                       vulnerability: "Vulnerability class",
                       cost: "Replacement cost", night: "People at night" };   // the last two values, cut into classes (Exposure.continuous)
  const EXPO_METRICS = { count: "Buildings", cost: "Replacement cost", night: "People at night", area: "Floor area" };   // the chips' names
  const EXPO_LEVELS = { zona: ["Zones", "Zone"], parroquia: ["Parishes", "Parish"], barrio: ["Barrios", "Barrio"] };   // GEM TREQ's polygons, by ID
  const EXPO_SIZES = [250, 500, 1000];
  const EXPO_ORDERED = new Set(["storeys", "ductility"]);                 // classes with an order of their own
  const EXPO_SCALE_KM = 3.0;                                          // the 99th-percentile column at ×1, km
  const EXPO_FOOT = [0.831, 0.820, 0.796];                           // the footing under a column: the clay walls' grey (#d4d1cb), not data
  // Height: a square root by default. The metrics are heavy-tailed (the median 250 m hexagon holds a tenth of the 99th
  // percentile, one holds 8 times it), so a linear column turned the city into a few needles over a flat carpet.
  const EXPO_HEIGHTS = { sqrt: v => Math.sqrt(v), linear: v => v };
  // the chapter opens on the author's view (2026-11-19): 250 m columns of floor area, stacked by storeys, linear, ×1.5, on
  // the relief. Areas keep their own metric, height and colour mode (the hexagons keep theirs); they open on the author's
  // view of 2026-11-19: barrios extruded by their people at night per km², each prism stacked by class (storeys) as the
  // hexagons are, close to the city
  const EXPO_DEFAULT = { view: "hex", attr: "storeys", size: 250, metric: "area", stacked: true, height: "linear", base: "relief", level: "barrio",
                         amode: "extruded", ametric: "night", aheight: "density", acolour: "stack" };
  const EXPO_ACOLOURS = ["stack", "attr", "ramp"];                     // stacked by class, the dominant class, the height's ramp
  // Areas, extruded (after the user's reference, 2026-11-18): every unit a prism on a flat base, its height the metric per
  // km² (or its total), cut in the classes' shares of that metric (or in its dominant class, or on a ramp of the height)
  const AREA_SCALE_KM = 3.0;                                          // the 99th-percentile unit at ×1, km
  const AREA_RAMP = ["#D6E8F5", "#B4CDEE", "#97AEE6", "#8F93DA", "#9F80C9", "#B872AE", "#CC5F84", "#D2464A"];
  const EXPO_FLAT_EXAG = 0.02;                                       // "flat ground": the relief a sheet, the columns on one base
  const expo = { ...EXPO_DEFAULT, branch: 0, scale: 1.5, saved: null, exag: null, exagBefore: null,
                 palette: null, ok: false, hx: null, ar: null, ground: new Map(), norm: 1, cardFor: null, hexFor: null, areaFor: null,
                 ascale: 1, anorm: 1, abreaks: [], shadows: true };
  const inExposure = () => !!(Story.chapter && Story.chapter.id === "exposure" && !Story.onCover);
  const usd = v => (v >= 1e9 ? `${(v / 1e9).toFixed(2)} bn USD` : v >= 1e6 ? `${(v / 1e6).toFixed(1)} M USD` : `${num(v / 1e3)} k USD`);
  const pct = (a, b) => `${(100 * a / Math.max(b, 1e-9)).toFixed(a / b < 0.01 ? 2 : 1)} %`;
  const branchKey = () => Exposure.meta.branches[expo.branch].key;
  const buildingsText = n => `${num(n)} building${Math.round(n) === 1 ? "" : "s"}`;

  function readExposureParams() {
    const p = Story.params;
    expo.view = ["hex", "buildings", "areas"].includes(p.get("xview")) ? p.get("xview") : EXPO_DEFAULT.view;
    expo.level = EXPO_LEVELS[p.get("xlevel")] ? p.get("xlevel") : EXPO_DEFAULT.level;
    expo.amode = p.get("xamode") === "draped" ? "draped" : EXPO_DEFAULT.amode;
    expo.ametric = EXPO_METRICS[p.get("xam")] ? p.get("xam") : EXPO_DEFAULT.ametric;
    expo.aheight = ["total", "density"].includes(p.get("xaheight")) ? p.get("xaheight") : EXPO_DEFAULT.aheight;
    expo.acolour = EXPO_ACOLOURS.includes(p.get("xacolour")) ? p.get("xacolour") : EXPO_DEFAULT.acolour;
    expo.attr = EXPO_ATTRS[p.get("xattr")] ? p.get("xattr") : EXPO_DEFAULT.attr;
    const b = Number(p.get("xbranch")); if (b >= 1 && b <= 4) expo.branch = b - 1;
    const s = Number(p.get("xhex")); expo.size = EXPO_SIZES.includes(s) ? s : EXPO_DEFAULT.size;
    expo.metric = EXPO_METRICS[p.get("xh")] ? p.get("xh") : EXPO_DEFAULT.metric;
    expo.stacked = p.has("xstack") ? p.get("xstack") === "1" : EXPO_DEFAULT.stacked;
    expo.height = p.get("xscale") === "sqrt" || p.get("xscale") === "linear" ? p.get("xscale") : EXPO_DEFAULT.height;
    expo.base = p.get("xground") === "flat" ? "flat" : EXPO_DEFAULT.base;
  }
  function writeExposureParams() {
    const hex = expo.view === "hex", areas = expo.view === "areas";
    Story.setParams({ xview: expo.view, xattr: expo.attr, xbranch: expo.branch + 1, xhex: hex ? expo.size : null, xh: hex ? expo.metric : null, xam: areas && expo.ametric !== EXPO_DEFAULT.ametric ? expo.ametric : null, xstack: hex ? (expo.stacked ? 1 : 0) : null,
                     xscale: hex && expo.height !== EXPO_DEFAULT.height ? expo.height : null, xground: hex && expo.base === "flat" ? "flat" : null, xlevel: areas ? expo.level : null,
                     xamode: areas && expo.amode !== EXPO_DEFAULT.amode ? expo.amode : null, xaheight: areas && expo.aheight !== EXPO_DEFAULT.aheight ? expo.aheight : null,
                     xacolour: areas && expo.acolour !== EXPO_DEFAULT.acolour ? expo.acolour : null });
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
    app.site.setExposure(null); app.site.setHexes(null); app.site.setAreas(null); app.site.highlightBuilding(-1); expo.cardFor = null; expo.hexFor = null; expo.areaFor = null; expo.ar = null;
    hideCard(); $("#hover").hidden = true;
    app.site.setShow({ ...ALL_LAYERS, buildings: expo.saved ?? true }); expo.saved = null; markTools();
    app.site.setWallStyle("earth");
    if (expo.palette !== null) { app.site.setPalette(expo.palette); markPalette(); Story.setParams({ palette: expo.palette === "map" ? null : expo.palette }); expo.palette = null; }
    app.site.setHexFlat(false); expo.exag = null;                      // flat ground and the chapter's ×1.0 give the visitor's relief back
    if (expo.exagBefore !== null) { app.site.setExaggeration(expo.exagBefore); expo.exagBefore = null; syncExag(); }
    Story.setParams({ xview: null, xattr: null, xbranch: null, xhex: null, xh: null, xstack: null, xscale: null, xground: null, xlevel: null,
                      xamode: null, xam: null, xaheight: null, xacolour: null });
  }

  // ---------------------------------------------------------------- the view
  async function applyExposure(fly = false) {
    if (!Exposure.meta || !inExposure()) return;
    writeExposureParams(); markExposure(); drawExposureLegend();
    applyGround((expo.view === "hex" && expo.base === "flat") || (expo.view === "areas" && expo.amode === "extruded"));
    if (expo.view !== "areas" && expo.ar) { app.site.setAreas(null); expo.ar = null; expo.areaFor = null; }
    if (expo.view === "areas") return applyAreas(fly);
    if (expo.view === "buildings") {
      app.site.setHexes(null);
      app.site.setShow({ buildings: true }); markTools();
      if (expo.ok) app.site.setExposure({ ...Exposure.indexTexture(expo.attr), palette: Exposure.palette(expo.attr), branch: Exposure.perBranch(expo.attr) ? expo.branch : 0 });
      else app.site.setExposure(null);
      if (expo.cardFor !== null && !$("#card").hidden) exposureBuildingCard(expo.cardFor).catch(fail);   // the open card follows the colour
      if (fly) app.flight = app.site.flyTo("exposure", 2200);
      return;
    }
    app.site.setExposure(null); app.site.highlightBuilding(-1); app.site.setShow({ buildings: false }); markTools();
    status(`Loading the ${expo.size} m hexagons…`, null);
    const attr = expo.attr, hx = await Exposure.hex(expo.size, attr).catch(error => { fail(error); return null; }).finally(() => status(null));
    if (!hx || !inExposure() || expo.view !== "hex" || hx.size !== expo.size || attr !== expo.attr) return;
    expo.hx = hx;
    app.site.setHexes(hexSpec(hx));
    describeHexes(); if (Exposure.continuous(expo.attr)) drawValueLegend();
    if (expo.hexFor !== null && !$("#card").hidden) exposureHexCard(expo.hexFor);   // the open card follows the colour
    if (fly) app.flight = app.site.flyTo("exposureHex", 2200);
  }
  // Areas: the units of one level painted on the relief, each in its dominant class (weighted by the metric) or its value
  // per building; their borders drawn; the buildings and the columns off
  async function applyAreas(fly) {
    app.site.setExposure(null); app.site.setHexes(null); app.site.highlightBuilding(-1); app.site.setShow({ buildings: false }); markTools();
    const level = expo.level;
    status(`Loading the ${EXPO_LEVELS[level][0].toLowerCase()}…`, null);
    const ar = await Exposure.areas(level).catch(error => { fail(error); return null; }).finally(() => status(null));
    if (!ar || !inExposure() || expo.view !== "areas" || expo.level !== level) return;
    const draped = expo.amode === "draped";
    if (expo.ar !== ar || expo.arDraped !== draped) {               // the raster stays in both modes (the unit under a point)
      app.site.setAreas({ index: ar.index, raster: ar.arrays.raster, cols: ar.cols, rows: ar.rows, level, draped });
      if (expo.ar !== ar) expo.areaFor = null;
      expo.ar = ar; expo.arDraped = draped;
    }
    if (draped) app.site.setAreaColours(areaColours(ar));
    else app.site.setHexes(areaSpec(ar));
    describeAreas(); drawExposureLegend();
    if (expo.areaFor !== null && !$("#card").hidden) exposureAreaCard(expo.areaFor);   // the open card follows the colour
    if (fly) app.flight = app.site.flyTo("exposureAreas", 2200);
  }
  // a unit's class: the class holding the largest share of the metric (attributes), or its value per building (values)
  function areaClass(ar, i) {
    const n = Exposure.value(ar, "count", i); if (!(n > 0)) return 0;
    if (Exposure.continuous(expo.attr)) return Exposure.binOf(expo.attr, Exposure.value(ar, expo.attr, i) / n);
    const K = Exposure.classes(expo.attr).length, row = Exposure.table(ar, expo.attr, branchKey(), expo.ametric).subarray(i * K, i * K + K);
    let best = 0; for (let k = 1; k < K; k++) if (row[k] > row[best]) best = k;
    return row[best] > 0 ? best + 1 : 0;
  }
  function areaColours(ar) {                                           // texel i + 1 = unit i's colour (the raster's value)
    const data = new Uint8Array(2048 * 4), cls = Exposure.classes(expo.attr);
    for (let i = 0; i < ar.count; i++) { const k = areaClass(ar, i); if (k) data.set([...Exposure.rgb(cls[k - 1].color), 255], 4 * (i + 1)); }
    return data;
  }
  // extruded: a unit's height value (the metric per km² of the unit, or its total), its ramp class, and the prisms
  const areaValue = (ar, i) => { const v = Exposure.value(ar, expo.ametric, i); return expo.aheight === "density" ? v / Math.max(ar.arrays.area_km2[i], 1e-6) : v; };
  const rampClass = v => { let k = 0; while (k < expo.abreaks.length && v >= expo.abreaks[k]) k++; return k + 1; };
  const round2 = v => { if (!(v > 0)) return 0; const e = 10 ** (Math.floor(Math.log10(v)) - 1); return Math.round(v / e) * e; };
  function areaSpec(ar) {
    const n = ar.count, values = Float64Array.from({ length: n }, (_, i) => areaValue(ar, i));
    const drawn = Array.from(values).filter((v, i) => v > 0 && ar.shapes[i].length).sort((a, b) => a - b);
    expo.anorm = drawn[Math.floor(0.99 * (drawn.length - 1))] || 1;
    // eight classes at the octiles, rounded to two figures (the legend's numbers)
    expo.abreaks = [...new Set([1, 2, 3, 4, 5, 6, 7].map(k => round2(drawn[Math.floor(k / 8 * (drawn.length - 1))])))].filter(v => v > 0);
    const cls = Exposure.classes(expo.attr), K = cls.length, hex = [], from = [], to = [], rgb = [];
    const colours = cls.map(c => Exposure.rgb(c.color).map(v => v / 255));
    // stacked: the prism cut in the classes' shares of the unit's metric (per km² or in total, the shares are the same),
    // in the hexagons' order; a value (cost, people per building) has no classes to stack and keeps one colour
    const stacked = areaStacked(), table = stacked ? Exposure.table(ar, expo.attr, branchKey(), expo.ametric) : null, order = stacked ? stackOrder() : null;
    for (let i = 0; i < n; i++) {
      if (!(values[i] > 0) || !ar.shapes[i].length) continue;
      const level = values[i] / expo.anorm;
      if (stacked) {
        const row = table.subarray(i * K, i * K + K);
        let total = 0; for (let k = 0; k < K; k++) total += row[k];
        if (!total) continue;
        let at = 0;
        for (const k of order) { if (!row[k]) continue; const top = at + level * row[k] / total; hex.push(i); from.push(at); to.push(top); rgb.push(...colours[k]); at = top; }
        continue;
      }
      let colour;
      if (expo.acolour === "ramp") colour = Exposure.rgb(AREA_RAMP[Math.min(rampClass(values[i]), AREA_RAMP.length) - 1]).map(v => v / 255);
      else { const k = areaClass(ar, i); if (!k) continue; colour = colours[k - 1]; }
      hex.push(i); from.push(0); to.push(level); rgb.push(...colour);
    }
    const topKm = app.siteData.dem.elevation_range_m[1] / 1000, S = hex.length;
    return { kind: "area", shapes: ar.shapes, lo: new Float32Array(n), hi: new Float32Array(n).fill(topKm * 1000), top: topKm,
             scaleKm: AREA_SCALE_KM * expo.ascale, seg: { hex: Uint32Array.from(hex), from: Float32Array.from(from), to: Float32Array.from(to), rgb: Float32Array.from(rgb), foot: new Uint8Array(S) } };
  }
  // the areas stack only extruded, by a class (not a value)
  const areaStacked = () => expo.amode === "extruded" && expo.acolour === "stack" && !Exposure.continuous(expo.attr);
  const areaUnit = () => ({ count: "buildings", cost: "USD", night: "people", area: "m² of floor" })[expo.ametric];
  const areaNumber = v => (expo.ametric === "cost" ? usd(v) : `${num(v)} ${areaUnit()}`);
  function drawRampLegend() {
    const ar = expo.ar, b = expo.abreaks, per = expo.aheight === "density" ? " per km²" : "", counts = new Array(b.length + 1).fill(0);
    if (ar) for (let i = 0; i < ar.count; i++) { const v = areaValue(ar, i); if (v > 0 && ar.shapes[i].length) counts[rampClass(v) - 1]++; }
    const label = k => (k === 0 ? `under ${areaNumber(b[0])}` : k === b.length ? `${areaNumber(b[k - 1])} or more` : `${areaNumber(b[k - 1])} to ${areaNumber(b[k])}`);
    $("#expo-legend").innerHTML = counts.map((c, k) => `<li><span class="sw block" style="--c: ${AREA_RAMP[Math.min(k, AREA_RAMP.length - 1)]}"></span><span>${label(k)}${per}</span><span class="n">${num(c)}</span></li>`).join("");
    $("#expo-legend-note").textContent = `${EXPO_LEVELS[expo.level][0]} by ${EXPO_METRICS[expo.ametric].toLowerCase()}${per}: the height and the colour say the same. ` +
      `Pick a class or a value under Colour by to colour the prisms by it instead.`;
    $("#expo-branch-note").textContent = branchNote();
  }
  function describeAreas() {
    const ar = expo.ar; if (!ar) return;
    const e = ar.entry, [plural] = EXPO_LEVELS[ar.level], value = Exposure.continuous(expo.attr);
    $("#expo-area-note").textContent = `${num(e.count)} ${plural.toLowerCase()} (GEM TREQ's polygons), ${num(e.drawn)} of them on the relief the map draws. ` +
      `The buildings are summed by the unit's ID in the cadastre, not by where their points fall` +
      (e.assets_without_unit ? `; ${num(e.assets_without_unit)} carry an ID without a polygon. ` : ". ") +
      (expo.amode === "extruded" ? `Height: the unit's ${EXPO_METRICS[expo.ametric].toLowerCase()}${expo.aheight === "density" ? " per km² (so a large rural parish does not win by its size)" : ", in total"}; ` +
        `${(AREA_SCALE_KM * expo.ascale).toFixed(1)} km of prism is ${areaNumber(expo.anorm)}${expo.aheight === "density" ? " per km²" : ""} (the 99th percentile), on a flat base. ` : "") +
      (expo.amode === "extruded" && expo.acolour === "ramp" ? "Colour: the same value, on a ramp."
        : value ? `Colour: the ${EXPO_ATTRS[expo.attr].toLowerCase()} per building in each unit.`
        : areaStacked() ? `Colour: the prism cut in the classes' shares of the unit's ${EXPO_METRICS[expo.ametric].toLowerCase()}.`
        : `Colour: the class with the largest share of the unit's ${EXPO_METRICS[expo.ametric].toLowerCase()}.`);
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
    const { lo, hi } = hexGround(hx), cls = Exposure.classes(expo.attr), K = cls.length;
    const colours = cls.map(c => Exposure.rgb(c.color).map(v => v / 255));
    const values = Float64Array.from({ length: hx.count }, (_, i) => Exposure.value(hx, expo.metric, i));
    const sorted = Float64Array.from(values).sort();
    expo.norm = sorted[Math.min(sorted.length - 1, Math.floor(0.99 * sorted.length))] || 1;
    const hex = [], from = [], to = [], rgb = [], foot = [], f = EXPO_HEIGHTS[expo.height];
    if (Exposure.continuous(expo.attr)) {                              // a value: one colour per column, its mean per building
      for (let i = 0; i < hx.count; i++) {
        if (!Number.isFinite(lo[i]) || !(values[i] > 0)) continue;
        const k = hexClass(hx, i); if (!k) continue;
        hex.push(i, i); from.push(0, 0); to.push(0, f(values[i] / expo.norm)); rgb.push(...EXPO_FOOT, ...colours[k - 1]); foot.push(1, 0);
      }
      return hexResult(hx, lo, hi, hex, from, to, rgb, foot);
    }
    const table = Exposure.table(hx, expo.attr, branchKey(), expo.metric), order = stackOrder();
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
    return hexResult(hx, lo, hi, hex, from, to, rgb, foot);
  }
  // stacked, the same order in every column or prism: an ordered attribute in its own order (1 storey at the foot, towers
  // on top; non-ductile at the foot), a categorical one from the rarest class to the most common (the roof then shows
  // what most of the city is made of, as in the references)
  function stackOrder() {
    const K = Exposure.classes(expo.attr).length, counts = Exposure.meta.class_counts[expo.attr][Exposure.perBranch(expo.attr) ? branchKey() : "all"];
    return EXPO_ORDERED.has(expo.attr) ? [...Array(K).keys()] : [...Array(K).keys()].sort((a, b) => counts[a] - counts[b]);
  }
  function hexResult(hx, lo, hi, hex, from, to, rgb, foot) {
    // each hexagon's six neighbours' mean top (levels; none = 0): its walls darken where they rise above it
    const tops = new Float32Array(hx.count), index = new Map(), nb = new Float32Array(hx.count), { q, r } = hx.arrays;
    for (let s = 0; s < hex.length; s++) tops[hex[s]] = Math.max(tops[hex[s]], to[s]);
    for (let i = 0; i < hx.count; i++) index.set(q[i] * 65536 + r[i], i);
    const around = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
    for (let i = 0; i < hx.count; i++) {
      let sum = 0; for (const [dq, dr] of around) { const j = index.get((q[i] + dq) * 65536 + r[i] + dr); if (j !== undefined) sum += tops[j]; }
      nb[i] = sum / 6;
    }
    return { kind: "hex", nb, x: hx.x, y: hx.y, lo, hi, radiusKm: hx.radiusKm * 0.93, scaleKm: EXPO_SCALE_KM * expo.scale,
             seg: { hex: Uint32Array.from(hex), from: Float32Array.from(from), to: Float32Array.from(to), rgb: Float32Array.from(rgb), foot: Uint8Array.from(foot) } };
  }
  // a hexagon's mean per building of the continuous attribute (cost USD, night occupants), and its class (0 = empty)
  const hexMean = (hx, i) => Exposure.value(hx, expo.attr, i) / Math.max(Exposure.value(hx, "count", i), 1);
  const hexClass = (hx, i) => (Exposure.value(hx, "count", i) > 0 ? Exposure.binOf(expo.attr, hexMean(hx, i)) : 0);

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
    // the same, zone by zone: the join is even (73-85 % inside) except where a zone leaves the relief
    const zones = Object.entries(c.by_zone_percent).filter(([z]) => z !== "all").sort((a, b) => b[1].assets - a[1].assets), tol = `<= ${c.tolerance_m} m`;
    const off = c.outside_dem_by_zone || {}, row = (z, r, out) => `<tr${r.inside < 50 ? ' class="low"' : ""}><td>${z === "all" ? "<b>District</b>" : z.toLowerCase()}</td><td>${num(r.assets)}</td><td>${r.inside.toFixed(1)} %</td><td>${(r[tol] ?? NaN).toFixed(1)} %</td><td>${num(out)}</td></tr>`;
    $("#expo-zones").innerHTML = `<thead><tr><th>Zone</th><th>Buildings</th><th>Inside</th><th>≤ ${c.tolerance_m} m</th><th>Off the relief</th></tr></thead><tbody>` +
      zones.map(([z, r]) => row(z, r, off[z] || 0)).join("") + row("all", c.by_zone_percent.all, c.assets_outside_dem) + "</tbody>";
    markExposure();
  }
  function describeHexes() {
    const hx = expo.hx; if (!hx) return;
    const unit = { count: v => `${num(v)} buildings`, cost: usd, night: v => `${num(v)} people at night`, area: v => `${num(v)} m² of floor` }[expo.metric];
    $("#expo-hex-note").textContent = `${num(hx.count)} hexagons of ${expo.size} m (${(Math.sqrt(3) / 2 * expo.size ** 2 / 1e6).toFixed(3)} km² each). ` +
      `Height: ${EXPO_METRICS[expo.metric].toLowerCase()}, ${expo.height === "sqrt" ? "as its square root (a quarter of the value, half the height)" : "linear"}; ` +
      `${(EXPO_SCALE_KM * expo.scale).toFixed(1)} km of column is ${unit(expo.norm)} (the 99th percentile). ` +
      (expo.base === "flat" ? "Flat ground: the relief is flattened and every column starts from one common base. "
        : "Every column stands on the highest ground under its hexagon; the white footing below it is not data (Base: Flat ground gives them one common base). ") +
      (Exposure.continuous(expo.attr) ? `Colour: the ${EXPO_ATTRS[expo.attr].toLowerCase()} per building in the hexagon (its total over its buildings).`
        : `Colour: ${expo.stacked ? "the column cut in the classes' shares of it" : "the class with the largest share of it"}.`);
  }
  function drawExposureLegend() {
    if (expo.view === "areas" && expo.amode === "extruded" && expo.acolour === "ramp") return drawRampLegend();
    if (Exposure.continuous(expo.attr)) return drawValueLegend();
    const m = Exposure.meta, cls = Exposure.classes(expo.attr), counts = m.class_counts[expo.attr][Exposure.perBranch(expo.attr) ? branchKey() : "all"];
    const total = counts.reduce((a, b) => a + b, 0);
    const items = cls.map((c, k) => counts[k] ? `<li><span class="sw block" style="--c: ${c.color}"></span><span>${c.en}</span><span class="n">${num(counts[k])} · ${pct(counts[k], total)}</span></li>` : "");
    if (expo.view === "buildings") items.push(`<li><span class="sw block neutral"></span><span>No asset joined</span><span class="n">${num(m.coverage.footprints_without_assets)} footprints</span></li>`);
    $("#expo-legend").innerHTML = items.join("");
    $("#expo-legend-note").textContent = `Buildings of the model per class in ${Exposure.perBranch(expo.attr) ? `branch ${branchKey()}` : "every branch (occupancy does not change between them)"}.`;
    $("#expo-branch-note").textContent = Exposure.perBranch(expo.attr) || expo.view !== "buildings" ? branchNote() : "Occupancy is the same in the four branches.";
  }
  // a value's legend: what is painted, counted as it is painted (footprints in Buildings, hexagons in Hexagons)
  function drawValueLegend() {
    const m = Exposure.meta, cls = Exposure.classes(expo.attr), hexes = expo.view === "hex", areas = expo.view === "areas", what = EXPO_ATTRS[expo.attr].toLowerCase();
    let counts = Exposure.footprintCounts(expo.attr);
    if (hexes || areas) {
      counts = new Array(cls.length).fill(0);
      if (hexes && expo.hx && expo.hx.size === expo.size) for (let i = 0; i < expo.hx.count; i++) { const k = hexClass(expo.hx, i); if (k) counts[k - 1]++; }
      if (areas && expo.ar && expo.ar.level === expo.level) for (let i = 0; i < expo.ar.count; i++) { const k = areaClass(expo.ar, i); if (k) counts[k - 1]++; }
    }
    const total = counts.reduce((a, b) => a + b, 0);
    const items = cls.map((c, k) => `<li><span class="sw block" style="--c: ${c.color}"></span><span>${c.en}</span><span class="n">${total ? `${num(counts[k])} · ${pct(counts[k], total)}` : ""}</span></li>`);
    if (!hexes && !areas) items.push(`<li><span class="sw block neutral"></span><span>No asset joined</span><span class="n">${num(m.coverage.footprints_without_assets)} footprints</span></li>`);
    $("#expo-legend").innerHTML = items.join("");
    $("#expo-legend-note").textContent = hexes
      ? `Hexagons per class of ${what} per building: each hexagon's total over the buildings of the model in it. The height is the measure chosen under Hexagons.`
      : areas ? `${EXPO_LEVELS[expo.level][0]} per class of ${what} per building: each unit's total over the buildings of the model in it.`
      : `Footprints per class of ${what}: the buildings of the model joined to each footprint, summed where several share one (the card lists them).`;
    $("#expo-branch-note").textContent = `${EXPO_ATTRS[expo.attr]} is the same in the four branches: they change the classification, not the cost or the people.`;
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
      b.disabled = !!Exposure.meta && ((expo.view === "buildings" && !Exposure.perBranch(expo.attr)) || Exposure.continuous(expo.attr)); });
    document.querySelectorAll("[data-expo-size]").forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.expoSize) === expo.size)));
    document.querySelectorAll("[data-expo-metric]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.expoMetric === expo.metric)));
    document.querySelectorAll("[data-expo-ametric]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.expoAmetric === expo.ametric)));
    const value = !!Exposure.meta && Exposure.continuous(expo.attr);    // a value has no classes to stack: one colour per column
    document.querySelectorAll("[data-expo-stack]").forEach(b => { b.setAttribute("aria-pressed", String(!value && (b.dataset.expoStack === "1") === expo.stacked)); b.disabled = value; });
    document.querySelectorAll("[data-expo-height]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.expoHeight === expo.height)));
    document.querySelectorAll("[data-expo-ground]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.expoGround === expo.base)));
    $("#expo-hex-controls").hidden = expo.view !== "hex";
    $("#expo-area-controls").hidden = expo.view !== "areas";
    const extruded = expo.amode === "extruded", ramp = expo.view === "areas" && extruded && expo.acolour === "ramp";
    document.querySelectorAll("[data-expo-amode]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.expoAmode === expo.amode)));
    document.querySelectorAll("[data-expo-aheight]").forEach(b => { b.setAttribute("aria-pressed", String(b.dataset.expoAheight === expo.aheight)); b.disabled = !extruded; });
    // a value (cost, people per building) has no classes: Stacked and Dominant both stand down for its one colour, as the
    // hexagons' do; the ramp stays
    document.querySelectorAll("[data-expo-acolour]").forEach(b => { const classed = b.dataset.expoAcolour !== "ramp";
      b.setAttribute("aria-pressed", String(b.dataset.expoAcolour === expo.acolour && !(classed && value))); b.disabled = !extruded || (classed && value); });
    if (ramp) document.querySelectorAll("[data-expo-attr]").forEach(b => b.setAttribute("aria-pressed", "false"));
    document.querySelectorAll("#expo-colour-rows .ctl").forEach(r => r.classList.toggle("dim", ramp));   // said, not hidden: a click there colours by it
    $("#expo-ascale").disabled = !extruded; $("#expo-ascale").value = String(expo.ascale); $("#expo-ascale-out").textContent = `×${expo.ascale.toFixed(2)}`;
    document.querySelectorAll("[data-expo-shadows]").forEach(b => b.setAttribute("aria-pressed", String((b.dataset.expoShadows === "1") === expo.shadows)));
    document.querySelectorAll("[data-expo-level]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.expoLevel === expo.level)));
    const levels = Exposure.meta ? Exposure.levels().map(a => a.level) : [];
    document.querySelectorAll("[data-expo-level]").forEach(b => { b.disabled = !!Exposure.meta && !levels.includes(b.dataset.expoLevel); });
    document.querySelectorAll("[data-expo-view=areas]").forEach(b => { b.disabled = !!Exposure.meta && !levels.length; });
    syncExpoExag();
    $("#expo-scale").value = String(expo.scale); $("#expo-scale-out").textContent = `×${expo.scale.toFixed(2)}`;
  }

  // ---------------------------------------------------------------- cards and the hover
  function exposureCard(hit) {
    if (hit.kind === "hex") return exposureHexCard(hit.index);
    if (hit.kind === "area") return exposureAreaCard(hit.index);
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
      ["Vulnerability class", m.vulnerability_classes[d.taxonomy[key][lead]]], ["GEM taxonomy", `<code>${tax(key)}</code>`],
      ...(d.rc_sqrm ? [["Unit replacement cost", `${num(d.rc_sqrm[lead])} USD/m²`]] : []), ["Joined", join], ...footprint]) +
      `<h4>In the four branches</h4>${across}${others}` +
      `<p class="note">GEM TREQ exposure model (CC BY-SA 4.0), branch ${key}. The building's colour is ${Exposure.continuous(expo.attr)
        ? `its ${EXPO_ATTRS[expo.attr].toLowerCase()}, summed over the ${mine.length} joined to it`
        : `the dominant ${EXPO_ATTRS[expo.attr].toLowerCase()} by floor area among the ${mine.length} joined to it`}.</p>` + zoom);
  }
  function exposureHexCard(k) {
    const hx = expo.hx; if (!hx) return;
    app.site.highlightBuilding(-1); app.site.highlightHex(k); expo.hexFor = k;   // the column turns the pin's orange, as a picked building
    if (Exposure.continuous(expo.attr)) return exposureHexValueCard(hx, k);
    const at = metric => Exposure.value(hx, metric, k);
    showCard(`Hexagon · ${expo.size} m`, buildingsText(at("count")), rows([["Replacement cost", usd(at("cost"))], ["People inside at night", num(at("night"))], ["Floor area", `${num(at("area"))} m²`],
      ["Hexagon", `${(Math.sqrt(3) / 2 * expo.size ** 2 / 1e6).toFixed(3)} km²`], ["Centre", latLon(hx.x[k], hx.y[k])]]) +
      compositionTable(hx, k, "Classes in this hexagon") +
      `<p class="note">Every building of the GEM TREQ model whose point falls in this hexagon, joined to a footprint or not.</p>`);
  }
  // a cell's (hexagon's or unit's) classes: buildings, and the shares of cost, people at night and floor area
  function compositionTable(cells, k, label) {
    const cls = Exposure.classes(expo.attr), K = cls.length, key = branchKey(), at = metric => Exposure.value(cells, metric, k);
    const tab = metric => Exposure.table(cells, expo.attr, key, metric).subarray(k * K, k * K + K);
    const scale = metric => (cells.layout.find(l => l.name === `${expo.attr}.${Exposure.perBranch(expo.attr) ? key : "all"}.${metric}`) || {}).scale || 1;
    const [cnt, cost, night, area] = ["count", "cost", "night", "area"].map(tab);
    const lines = cls.map((cl, j) => (cnt[j] ? `<tr><td><span class="sw block" style="--c: ${cl.color}"></span>${cl.en}</td><td>${num(cnt[j])}</td><td>${pct(cost[j] / scale("cost"), at("cost"))}</td>` +
      `<td>${pct(night[j] / scale("night"), at("night"))}</td><td>${pct(area[j], at("area"))}</td></tr>` : "")).join("");
    return `<h4>${EXPO_ATTRS[expo.attr]}${Exposure.perBranch(expo.attr) ? ` · branch ${key}` : ""}</h4><table class="expo-hex" aria-label="${label}"><thead><tr><th>Class</th><th>Buildings</th><th>Cost</th><th>At night</th><th>Floor</th></tr></thead><tbody>${lines}</tbody></table>`;
  }
  function exposureAreaCard(k) {
    const ar = expo.ar; if (!ar) return;
    app.site.highlightArea(k); expo.areaFor = k;
    const at = metric => Exposure.value(ar, metric, k), n = at("count"), km2 = ar.arrays.area_km2[k], [, one] = EXPO_LEVELS[ar.level];
    const per = (v, d = 0) => (n ? (Math.round(v / n * 10 ** d) / 10 ** d).toLocaleString("en-US") : "—");
    const value = Exposure.continuous(expo.attr), cl = value ? Exposure.classes(expo.attr)[areaClass(ar, k) - 1] : null;
    showCard(`${one} · ${ar.names[k]}`, buildingsText(n), rows([["Replacement cost", usd(at("cost"))], ["… per building", n ? usd(at("cost") / n) : "—"],
      ["People inside at night", num(at("night"))], ["… per building", per(at("night"), 1)], ["Floor area", `${num(at("area"))} m²`],
      ["Area", `${km2.toFixed(km2 < 1 ? 3 : 1)} km²`], ["Buildings per km²", num(n / Math.max(km2, 1e-9))], ["People at night per km²", num(at("night") / Math.max(km2, 1e-9))],
      ["ID in the cadastre", String(ar.arrays.id[k])]]) +
      (!n ? `<p class="note">No building of the model carries this unit's ID.</p>`
          : value ? `<h4>${EXPO_ATTRS[expo.attr]} per building</h4><p><span class="sw block" style="--c: ${cl ? cl.color : "transparent"}"></span>${cl ? cl.en : "—"}</p>`
          : compositionTable(ar, k, `Classes in this ${one.toLowerCase()}`)) +
      `<p class="note">The GEM TREQ buildings carrying this ${one.toLowerCase()}'s ID in the cadastre; its outline is GEM TREQ's polygon (CC BY-SA 4.0).</p>`);
  }
  // the pointer over a building of the Buildings view: its class in what the city is coloured by
  function exposureBuildingTip(k) {
    const b = Exposure.buildings; if (!b || !Exposure.meta) return "";
    if (!b.n_assets[k]) return "Building · not in the exposure model";
    const c = Exposure.classOf(k, expo.attr, Exposure.perBranch(expo.attr) ? expo.branch : 0), cl = c ? Exposure.classes(expo.attr)[c - 1] : null;
    return `Building · ${cl ? cl.en : "—"}${b.n_assets[k] > 1 ? ` · ${b.n_assets[k]} of the model on it` : ""} · click for its record`;
  }
  function exposureAreaTip(k) {
    const ar = expo.ar; if (!ar) return "";
    return `${EXPO_LEVELS[ar.level][1]} · ${ar.names[k]} · ${buildingsText(Exposure.value(ar, "count", k))} · ${usd(Exposure.value(ar, "cost", k))} · click for its classes`;
  }
  function exposureHexValueCard(hx, k) {
    const at = metric => Exposure.value(hx, metric, k), n = at("count"), c = at("cost"), p = at("night"), cl = Exposure.classes(expo.attr)[hexClass(hx, k) - 1];
    showCard(`Hexagon · ${expo.size} m`, buildingsText(n), rows([["Replacement cost", usd(c)], ["… per building", usd(c / Math.max(n, 1))],
      ["People inside at night", num(p)], ["… per building", (Math.round(10 * p / Math.max(n, 1)) / 10).toLocaleString("en-US")], ["Floor area", `${num(at("area"))} m²`],
      ["Hexagon", `${(Math.sqrt(3) / 2 * expo.size ** 2 / 1e6).toFixed(3)} km²`], ["Centre", latLon(hx.x[k], hx.y[k])]]) +
      `<h4>${EXPO_ATTRS[expo.attr]} per building</h4><p><span class="sw block" style="--c: ${cl ? cl.color : "transparent"}"></span>${cl ? cl.en : "—"}</p>` +
      `<p class="note">Every building of the GEM TREQ model whose point falls in this hexagon, joined to a footprint or not.</p>`);
  }
  function exposureHexTip(k) {
    const hx = expo.hx; if (!hx) return "";
    return `${expo.size} m hexagon · ${buildingsText(Exposure.value(hx, "count", k))} · ${usd(Exposure.value(hx, "cost", k))} · ${num(Exposure.value(hx, "night", k))} people at night · click for its classes`;
  }

  // ---------------------------------------------------------------- the sheet: the view as one image (2026-11-19)
  // 1, across the top: the view as it is, with its numbers and its legend; 2 and 3, below: a zoom on the most and on the
  // least exposed sector of the city, by the measure the view raises. A sector is a circle 2 km across, one around each
  // 250 m hexagon's centre (whatever the view: the same sectors for buildings, hexagons and areas), its value the measure
  // inside it per km². A single cell would not do: a hexagon with seven buildings, or a rural barrio with two houses,
  // would always be one of the two. The least is sought among the sectors with at least the median number of buildings,
  // apart from the most. That is exposure, not risk, and the sheet says so. GEM's credit (CC BY-SA asks for it) and the
  // author's mark close 3.
  const SHEET = { w: 3200, h: 1800, gap: 12, top: 1090, sectorKm: 1.0 };
  const SHEET_WORDS = { count: "buildings", cost: "", night: "people at night", area: "m² of floor" };
  const sheetMetric = () => (expo.view === "hex" ? expo.metric : expo.ametric);
  async function sheetSectors() {
    const metric = sheetMetric(), classed = !Exposure.continuous(expo.attr);
    const hx = await Exposure.hex(250, classed ? expo.attr : null), { lo: ground } = hexGround(hx), n = hx.count, R = SHEET.sectorKm, R2 = R * R;
    const grid = new Map(), cell = (i, j) => i * 100003 + j;          // 1 km buckets: a sector's cells lie in 3 x 3 of them
    for (let k = 0; k < n; k++) if (Number.isFinite(ground[k])) {
      const g = cell(Math.floor(hx.x[k] / R), Math.floor(hx.y[k] / R)); if (!grid.has(g)) grid.set(g, []); grid.get(g).push(k);
    }
    const members = c => {
      const out = [], ci = Math.floor(hx.x[c] / R), cj = Math.floor(hx.y[c] / R);
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const k of grid.get(cell(ci + di, cj + dj)) || [])
        if ((hx.x[k] - hx.x[c]) ** 2 + (hx.y[k] - hx.y[c]) ** 2 <= R2) out.push(k);
      return out;
    };
    const value = new Float64Array(n), count = new Float64Array(n), ok = [], area = Math.PI * R2;
    for (let c = 0; c < n; c++) {
      if (!Number.isFinite(ground[c])) continue;
      let v = 0, m = 0; for (const k of members(c)) { v += Exposure.value(hx, metric, k); m += Exposure.value(hx, "count", k); }
      value[c] = v / area; count[c] = m; if (m > 0 && v > 0) ok.push(c);
    }
    const sorted = ok.map(c => count[c]).sort((a, b) => a - b), floor = sorted[Math.floor((sorted.length - 1) / 2)] || 0;
    let hi = -1, lo = -1;
    for (const c of ok) if (hi < 0 || value[c] > value[hi]) hi = c;
    for (const c of ok) if (count[c] >= floor && Math.hypot(hx.x[c] - hx.x[hi], hx.y[c] - hx.y[hi]) > 2 * R && (lo < 0 || value[c] < value[lo])) lo = c;
    return { hx, metric, value, count, members, hi, lo, floor, among: ok.length };
  }
  // the unit of an administrative level under a point [km] (its raster, as the relief's shader reads it); -1 none
  function sheetUnitAt(ar, x, y) {
    const d = app.siteData.dem, c = Math.round((x - d.x_range_km[0]) / (d.x_range_km[1] - d.x_range_km[0]) * (ar.cols - 1));
    const r = Math.round((d.y_range_km[1] - y) / (d.y_range_km[1] - d.y_range_km[0]) * (ar.rows - 1));
    return c < 0 || r < 0 || c >= ar.cols || r >= ar.rows ? -1 : ar.arrays.raster[r * ar.cols + c] - 1;
  }
  // from the view's own heading, but at least 62° above the horizon (at the view's grazing angle the prisms in front hid
  // the sector). The circle on the ground is the subject: framed whole with its surroundings, a little right of and below
  // the middle (62 %, 60 %), clear of the caption in the top left (the frame's middle moves the other way along the
  // camera's own right and up); the tallest prisms may leave the frame at the top, as context. Framing them whole made
  // the circle a small ring at the bottom of a forest of columns.
  function sheetZoom(x, y, base, aspect) {
    const ground = app.site.groundPoint(x, y), D = 2 * SHEET.sectorKm, half = app.site.lensHalf;
    const flat = Math.hypot(base.dir.x, base.dir.z) || 1, el = Math.max(Math.asin(Math.min(1, Math.max(0, base.dir.y))), 62 * Math.PI / 180);
    const dir = new THREE.Vector3(base.dir.x / flat * Math.cos(el), Math.sin(el), base.dir.z / flat * Math.cos(el));
    const d = Math.max(D * 1.9 / (2 * half * aspect), D * Math.sin(el) * 2.1 / (2 * half));
    const right = new THREE.Vector3(0, 1, 0).cross(dir).normalize(), up = dir.clone().cross(right).normalize(), Wv = 2 * half * d * aspect, Hv = 2 * half * d;
    return { target: ground.clone().addScaledVector(right, -0.12 * Wv).addScaledVector(up, 0.10 * Hv), dir, d };
  }
  // text on the sheet: lines wrapped to a width; measured first (draw = false), then drawn
  function sheetText(g, x, y, width, items, draw) {
    let at = y;
    for (const it of items) {
      g.font = `${it.w || 400} ${it.s}px ${SHEET.font}`; g.fillStyle = it.c || "#e8e8ec";
      at += it.gap || 0;
      const words = String(it.t).split(" "), lines = [];
      let line = "";
      for (const word of words) { const next = line ? `${line} ${word}` : word; if (line && g.measureText(next).width > width) { lines.push(line); line = word; } else line = next; }
      if (line) lines.push(line);
      for (const l of lines) { at += it.s * 1.28; if (draw) g.fillText(l, x, at - it.s * 0.3); }
    }
    return at - y;
  }
  function sheetCard(g, x, y, width, items, pad) {
    const h = sheetText(g, x + pad, y + pad, width - 2 * pad, items, false) + 2 * pad;
    g.fillStyle = "rgba(10, 13, 19, 0.80)"; g.strokeStyle = "rgba(255, 255, 255, 0.14)"; g.lineWidth = 2;
    g.beginPath(); g.roundRect(x, y, width, h, 16); g.fill(); g.stroke();
    sheetText(g, x + pad, y + pad, width - 2 * pad, items, true);
    return h;
  }
  function sheetBadge(g, n, x, y, r = 28) {
    g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI); g.fillStyle = "rgba(10, 13, 19, 0.92)"; g.fill();
    g.lineWidth = 5; g.strokeStyle = "#f0a050"; g.stroke();
    g.fillStyle = "#ffffff"; g.font = `700 ${Math.round(r * 1.15)}px ${SHEET.font}`; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(String(n), x, y + 2); g.textAlign = "start"; g.textBaseline = "alphabetic";
  }
  // a marker over a point of panel 1: a dot on the point, a leader up, the number on top
  function sheetMarker(g, n, [x, y], dy = 110) {
    g.strokeStyle = "rgba(255, 255, 255, 0.9)"; g.lineWidth = 4; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - dy + 28); g.stroke();
    g.beginPath(); g.arc(x, y, 8, 0, 2 * Math.PI); g.fillStyle = "#f0a050"; g.fill(); g.lineWidth = 3; g.strokeStyle = "#ffffff"; g.stroke();
    sheetBadge(g, n, x, y - dy);
  }
  // a sector's circle on the relief, projected (over everything: it is drawn on the image, not in the scene)
  function sheetCircle(g, shot, x, y, dx, dy, width) {
    const pts = Array.from({ length: 121 }, (_, k) => { const t = k / 120 * 2 * Math.PI; return shot.toPx(app.site.groundPoint(x + SHEET.sectorKm * Math.cos(t), y + SHEET.sectorKm * Math.sin(t))); });
    g.save(); g.translate(dx, dy); g.lineJoin = "round";
    for (const [w, colour] of [[2.2 * width, "rgba(10, 13, 19, 0.75)"], [width, "#f0a050"]]) {
      g.lineWidth = w; g.strokeStyle = colour; g.beginPath(); pts.forEach(([px, py], k) => (k ? g.lineTo(px, py) : g.moveTo(px, py))); g.stroke();
    }
    g.restore();
  }
  function sheetGround(g, x, y, w, h) {                              // the stage's own ground (style.css: #site-stage)
    const view = getComputedStyle(document.documentElement).getPropertyValue("--view").trim(), hex = /^#[0-9a-f]{6}$/i.test(view) ? view : "#2b2b2d";
    const rgb = hex.slice(1).match(/../g).map(v => parseInt(v, 16)), mix = (t, to) => `rgb(${rgb.map(v => Math.round(v + (to - v) * t)).join(",")})`;
    const grad = g.createRadialGradient(x + 0.42 * w, y + 0.38 * h, 0, x + 0.42 * w, y + 0.38 * h, 1.2 * Math.max(w, h));
    grad.addColorStop(0, mix(0.07, 255)); grad.addColorStop(0.62, hex); grad.addColorStop(1, mix(0.18, 0));
    g.fillStyle = grad; g.fillRect(x, y, w, h);
  }
  const sheetLogo = () => new Promise(resolve => {                    // the author's mark, tinted light (it is a grey mask)
    const img = new Image(); img.onload = () => {
      const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const g = c.getContext("2d"); g.drawImage(img, 0, 0); g.globalCompositeOperation = "source-in"; g.fillStyle = "#e4e4e8"; g.fillRect(0, 0, c.width, c.height);
      resolve(c);
    };
    img.onerror = () => resolve(null); img.src = "img/ladruno.png";
  });
  function sheetName() {
    const tag = expo.view === "hex" ? `hexagons-${expo.size}m_${expo.metric}`
      : expo.view === "areas" ? `${expo.level}_${expo.ametric}${expo.aheight === "density" ? "-per-km2" : ""}_${expo.amode}_${expo.acolour}` : `buildings_${expo.ametric}`;
    return `quito_exposure_${tag}_${expo.attr}_${branchKey()}_${new Date().toISOString().slice(0, 10)}.png`;
  }
  async function saveSheet() {
    const button = $("#expo-sheet");
    if (button.disabled || !Exposure.meta || !inExposure() || (expo.view === "hex" && !expo.hx) || (expo.view === "areas" && !expo.ar)) return;
    button.disabled = true; status("Drawing the sheet…", null);
    try {
      SHEET.font = getComputedStyle(document.body).fontFamily;
      const s = await sheetSectors(), hx = s.hx;
      const has = level => Exposure.levels().some(a => a.level === level);
      const [barrios, parishes] = await Promise.all(["barrio", "parroquia"].map(l => (has(l) ? Exposure.areas(l) : null)));
      if (!inExposure() || s.hi < 0 || s.lo < 0) return;
      const { w: W, h: H, gap: G, top: H1 } = SHEET, H2 = H - H1 - G, W2 = (W - G) / 2;
      const base = app.site.viewPose(W / H1), logo = sheetLogo(), centres = [s.hi, s.lo].map(c => [hx.x[c], hx.y[c]]);
      const shots = await app.site.stills([{ w: W, h: H1, pose: base }, ...centres.map(([x, y]) => ({ w: W2, h: H2, pose: sheetZoom(x, y, base, W2 / H2) }))]);
      const c = document.createElement("canvas"); c.width = W; c.height = H;
      const g = c.getContext("2d");
      g.fillStyle = "#0a0d13"; g.fillRect(0, 0, W, H);
      const at = [[0, 0], [0, H1 + G], [W2 + G, H1 + G]];
      shots.forEach((shot, k) => { sheetGround(g, at[k][0], at[k][1], shot.canvas.width, shot.canvas.height); g.drawImage(shot.canvas, at[k][0], at[k][1]); });
      const clipTo = (k, draw) => { g.save(); g.beginPath(); g.rect(at[k][0], at[k][1], shots[k].canvas.width, shots[k].canvas.height); g.clip(); draw(); g.restore(); };
      centres.forEach(([x, y], k) => { clipTo(0, () => sheetCircle(g, shots[0], x, y, 0, 0, 5)); clipTo(k + 1, () => sheetCircle(g, shots[k + 1], x, y, ...at[k + 1], 7)); });
      // 1: what the view is, the model's totals, the legend as the panel draws it, how 2 and 3 were chosen
      const t = Exposure.meta.totals, measure = EXPO_METRICS[s.metric].toLowerCase(), per = expo.view !== "hex" && expo.aheight === "density" ? " per km²" : "";
      const value = Exposure.continuous(expo.attr), ramp = expo.view === "areas" && expo.amode === "extruded" && expo.acolour === "ramp";
      const title = expo.view === "hex" ? `${expo.size} m hexagons · ${EXPO_METRICS[expo.metric].toLowerCase()}` : expo.view === "areas" ? `${EXPO_LEVELS[expo.level][0]} · ${measure}${per}` : `Buildings · ${EXPO_ATTRS[expo.attr].toLowerCase()}`;
      const colour = ramp ? "the height's own ramp" : value ? `${EXPO_ATTRS[expo.attr].toLowerCase()} per building`
        : `${EXPO_ATTRS[expo.attr].toLowerCase()}, ${expo.view === "buildings" ? "each building's class" : (expo.view === "hex" ? expo.stacked : areaStacked()) ? "stacked by class" : "the dominant class"}`;
      const legend = [...document.querySelectorAll("#expo-legend li")].slice(0, 12).map(li => {
        const sw = li.querySelector(".sw"), sp = li.querySelectorAll("span");
        return { sw: sw.classList.contains("neutral") ? "#c2bfb9" : sw.style.getPropertyValue("--c").trim(), t: sp[1] ? sp[1].textContent : "", n: sp[2] ? sp[2].textContent : "" };
      });
      const marks = centres.map(([x, y], k) => {
        const p = shots[0].toPx(app.site.groundPoint(x, y));
        return { n: k + 2, at: p, inside: p[0] > 40 && p[0] < W - 40 && p[1] > 150 && p[1] < H1 - 10 };
      }), off = marks.filter(m => !m.inside).map(m => "②③"[m.n - 2]);   // said, so a missing number is not a mistake
      const items = [{ t: "QUITO · EXPOSURE MODEL (GEM TREQ)", s: 19, w: 700, c: "#f0a050" }, { t: title, s: 34, w: 700, c: "#ffffff", gap: 4 },
        { t: `Colour: ${colour}${value ? "" : ` · branch ${branchKey()}`}`, s: 20, c: "#c9ccd3", gap: 4 },
        { t: `${num(t.assets)} buildings · ${usd(t.replacement_cost_usd)} to rebuild · ${(t.night_occupants / 1e6).toFixed(2)} M people at night · ${(t.built_area_m2 / 1e6).toFixed(0)} km² of floor`, s: 18, c: "#aeb2bb", gap: 2 }];
      const note = { t: `② the most and ③ the least exposed sectors of the city by ${measure} per km² (circles 2 km across, one around each 250 m hexagon); ` +
        `③ among the ${num(s.among)} with at least ${num(s.floor)} buildings (the median), away from ②. Exposure, not risk.` +
        (off.length ? ` ${off.join(" and ")} lie${off.length > 1 ? "" : "s"} beyond this view.` : ""), s: 17, c: "#aeb2bb" };
      const cardW = 780, cardX = 32, cardY = 32, pad = 26, rowH = 28;
      const headH = sheetText(g, 0, 0, cardW - 2 * pad, items, false), noteH = sheetText(g, 0, 0, cardW - 2 * pad, [note], false);
      const cardH = 2 * pad + headH + 12 + legend.length * rowH + 6 + noteH;
      g.fillStyle = "rgba(10, 13, 19, 0.80)"; g.strokeStyle = "rgba(255, 255, 255, 0.14)"; g.lineWidth = 2;
      g.beginPath(); g.roundRect(cardX, cardY, cardW, cardH, 16); g.fill(); g.stroke();
      sheetText(g, cardX + pad, cardY + pad, cardW - 2 * pad, items, true);
      let ly = cardY + pad + headH + 12;
      for (const it of legend) {
        g.fillStyle = it.sw || "#888"; g.beginPath(); g.roundRect(cardX + pad, ly + 5, 18, 18, 4); g.fill();
        g.font = `400 19px ${SHEET.font}`; g.fillStyle = "#e8e8ec"; g.fillText(it.t, cardX + pad + 30, ly + 21);
        g.font = `400 16px ui-monospace, monospace`; g.fillStyle = "#aeb2bb"; g.textAlign = "right"; g.fillText(it.n, cardX + cardW - pad, ly + 21); g.textAlign = "start";
        ly += rowH;
      }
      sheetText(g, cardX + pad, ly + 6, cardW - 2 * pad, [note], true);
      marks.forEach(m => { if (m.inside) clipTo(0, () => sheetMarker(g, m.n, m.at)); });   // over everything (a sector may lie under the card)
      // 2 and 3: the sector, its value, its sums and its leading classes; named by the barrio and parish at its centre
      const table = value ? null : Exposure.table(hx, expo.attr, branchKey(), s.metric), cls = Exposure.classes(expo.attr), K = cls.length;
      const sheetSums = [];
      [s.hi, s.lo].forEach((cc, k) => {
        const [x, y] = centres[k], [x0, y0] = at[k + 1], cells = s.members(cc), sum = metric => cells.reduce((a, i) => a + Exposure.value(hx, metric, i), 0);
        const b = barrios ? sheetUnitAt(barrios, x, y) : -1, p = parishes ? sheetUnitAt(parishes, x, y) : -1, v = s.value[cc];
        const where = b >= 0 ? `Around ${barrios.names[b]}` : `Around ${latLon(x, y)}`;
        const lines = [{ t: `${k ? "LEAST" : "MOST"} EXPOSED SECTOR · 2 KM ACROSS`, s: 20, w: 700, c: "#f0a050" },
          { t: where, s: 32, w: 700, c: "#ffffff", gap: 2 },
          { t: `${p >= 0 ? `Parish ${parishes.names[p]} · ` : ""}${latLon(x, y)}`, s: 19, c: "#aeb2bb", gap: 2 },
          { t: `${s.metric === "cost" ? usd(v) : `${num(v)} ${SHEET_WORDS[s.metric]}`} per km²`, s: 26, w: 600, c: "#ffd2a0", gap: 4 },
          { t: `${num(sum("count"))} buildings · ${num(sum("night"))} people at night · ${usd(sum("cost"))} · ${num(sum("area"))} m² of floor (in the circle)`, s: 19, c: "#c9ccd3", gap: 4 }];
        if (table) {
          const row = new Float64Array(K); for (const i of cells) for (let j = 0; j < K; j++) row[j] += table[i * K + j];
          const total = row.reduce((a, q) => a + q, 0), lead = [...Array(K).keys()].filter(j => row[j] > 0).sort((a, q) => row[q] - row[a]).slice(0, 3);
          if (total > 0) lines.push({ t: `${EXPO_ATTRS[expo.attr]} by ${measure}: ${lead.map(j => `${cls[j].en} ${Math.round(100 * row[j] / total)} %`).join(" · ")}`, s: 19, c: "#c9ccd3", gap: 2 });
        }
        sheetCard(g, x0 + 24, y0 + 24, 860, lines, 22);
        sheetBadge(g, k + 2, x0 + W2 - 54, y0 + 54, 32);
        sheetSums.push(sum("count"));
      });
      // the credit (CC BY-SA) and the author's mark, at the foot of 3
      const mark = await logo, fy = H - 34;
      const band = g.createLinearGradient(0, H - 120, 0, H);
      band.addColorStop(0, "rgba(10, 13, 19, 0)"); band.addColorStop(0.45, "rgba(10, 13, 19, 0.78)"); band.addColorStop(1, "rgba(10, 13, 19, 0.88)");
      g.fillStyle = band; g.fillRect(at[2][0], H - 120, W2, 120);
      g.font = `400 20px ${SHEET.font}`; g.fillStyle = "#c9ccd3";
      g.fillText("Exposure: GEM TREQ exposure model of Quito, report D2.6.1 (Calderón et al. 2022), CC BY-SA 4.0 · Surrogate Explorer, C. Celi", at[2][0] + 28, fy);
      g.fillText(`Branch ${branchKey()} · ${new Date().toISOString().slice(0, 10)}`, at[2][0] + 28, fy - 28);
      // the stage's signature (index.html .signature): the seal, the author's name under it, right-aligned, about half its height
      const lh = 44, nameY = H - 24;
      if (mark) { const lw = mark.width * lh / mark.height; g.drawImage(mark, W - 36 - lw, nameY - 28 - lh, lw, lh); }
      g.font = `500 21px ${SHEET.font}`; g.fillStyle = "#c9ccd3"; g.textAlign = "right"; g.fillText("MSc. Carlos A. Celi", W - 36, nameY); g.textAlign = "start";
      const name = sheetName(), blob = await new Promise(r => c.toBlob(r, "image/png"));
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      expo.sheet = { name, width: W, height: H, metric: s.metric, hi: s.hi, lo: s.lo, floor: s.floor, among: s.among, values: [s.value[s.hi], s.value[s.lo]], buildings: sheetSums, card: [cardW, cardH] };
    } catch (error) { fail(error); } finally { button.disabled = false; status(null); }
  }

  // ---------------------------------------------------------------- controls
  function wireExposure() {
    $("#expo-sheet").addEventListener("click", () => saveSheet());
    const set = (change, rebuild = true) => { Object.assign(expo, change); if (rebuild) applyExposure(false).catch(fail); };
    document.querySelectorAll("[data-expo-view]").forEach(b => b.addEventListener("click", () => {
      if (b.dataset.expoView === expo.view) return;
      hideCard(); set({ view: b.dataset.expoView }); app.flight = app.site.flyTo({ buildings: "exposure", hex: "exposureHex", areas: "exposureAreas" }[b.dataset.expoView], 1800);
    }));
    document.querySelectorAll("[data-expo-level]").forEach(b => b.addEventListener("click", () => { if (b.dataset.expoLevel !== expo.level) { hideCard(); set({ level: b.dataset.expoLevel }); } }));
    // in the extruded areas on the height's ramp, an attribute colours the prisms by it again, stacked (the ramp chip gives
    // the height's colour back); stacked or dominant, the prisms keep their mode
    document.querySelectorAll("[data-expo-attr]").forEach(b => b.addEventListener("click", () => set({ attr: b.dataset.expoAttr, ...(expo.view === "areas" && expo.acolour === "ramp" ? { acolour: "stack" } : {}) })));
    document.querySelectorAll("[data-expo-amode]").forEach(b => b.addEventListener("click", () => { if (b.dataset.expoAmode !== expo.amode) { hideCard(); set({ amode: b.dataset.expoAmode }); } }));
    document.querySelectorAll("[data-expo-aheight]").forEach(b => b.addEventListener("click", () => set({ aheight: b.dataset.expoAheight })));
    document.querySelectorAll("[data-expo-acolour]").forEach(b => b.addEventListener("click", () => set({ acolour: b.dataset.expoAcolour })));
    document.querySelectorAll("[data-expo-shadows]").forEach(b => b.addEventListener("click", () => { expo.shadows = b.dataset.expoShadows === "1"; app.site.setShadows(expo.shadows); markExposure(); }));
    $("#expo-ascale").addEventListener("input", e => {
      expo.ascale = Number(e.target.value); $("#expo-ascale-out").textContent = `×${expo.ascale.toFixed(2)}`;
      if (expo.view === "areas" && expo.amode === "extruded") { app.site.setHexScale(AREA_SCALE_KM * expo.ascale); describeAreas(); }
    });
    $("#expo-branches").addEventListener("click", e => { const b = e.target.closest("[data-expo-branch]"); if (b && !b.disabled) set({ branch: Number(b.dataset.expoBranch) }); });
    document.querySelectorAll("[data-expo-size]").forEach(b => b.addEventListener("click", () => { hideCard(); set({ size: Number(b.dataset.expoSize) }); }));
    document.querySelectorAll("[data-expo-metric]").forEach(b => b.addEventListener("click", () => set({ metric: b.dataset.expoMetric })));
    document.querySelectorAll("[data-expo-ametric]").forEach(b => b.addEventListener("click", () => set({ ametric: b.dataset.expoAmetric })));
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
