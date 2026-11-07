// Surrogate Explorer · network.js — the forward pass of the network, as surrogate/ElasticForwardPassAnimator.py films it
// (the 4.6 forward_pass.mp4), but live: the medium on screen, the receiver you pick, the tensors this browser computes.
//
// A port of the animator, piece for piece (three.js r128 instead of PyVista):
//   * _layout: one scene along x (the flow), y the width, z up; front faces look towards -x. The medium is a 9-unit slab,
//     each encoder stage a block whose face shows one channel and whose thickness grows with log2(channels), drawn with
//     sheet lines; every vector a strip of cubes, one per value, in the SIGNED palette (blue < 0, light 0, orange > 0);
//   * every element appears in its chapter's window (on = [chapter, u0, u1]) and may leave (off); what a chapter does not
//     use is dimmed to DIM (FOCUS keeps what it builds on), so the history stays on screen, quiet;
//   * an orthographic camera travels between the film's key poses (each frames a region: fit()), the scale geometric,
//     with a slow ±3° sway;
//   * the chapters' motion: the medium's four sheets slide apart, the trained 5×5×4 kernel sweeps the medium and its raw
//     sums fill the stem face and bend into the activation, the receiver drops and its column runs through every scale,
//     FiLM recolours g and ℓ, the decoder grows 38 -> 608 and the traces unroll, the gather is swept;
//   * the 2-D panels: the FDM recording of chapter 0, the decoder's prediction against the FDM in chapter 10, the gathers
//     FDM | network | difference of chapter 11; the captions are the film's.
// The tensors come from Infer.probe (web/tools/onnx_web_compat.PROBES), checked against PyTorch by test_network_probe.py.
(function () {
  "use strict";
  const CHAPTERS = [
    ["solver", "0 · The data: one FDM simulation", 15], ["input", "1 · Input: the medium as a 4-channel tensor", 6],
    ["stem", "2 · Stem: the first convolution", 11], ["encoder", "3 · Encoder: f4 → f8 → f16", 7],
    ["global", "4 · Global latent g", 7], ["sources", "5 · Source features src", 7],
    ["query", "6 · The receiver query: local + path + src → ℓ", 12], ["receiver", "7 · Receiver embedding c", 8],
    ["film", "8 · FiLM: c modulates g and ℓ", 9], ["fusion", "9 · Fusion → h", 6],
    ["decoder", "10 · Temporal decoder → Vx, Vz", 21], ["gather", "11 · Every receiver → the shot gather", 13], ["overview", "The whole forward pass", 11]];
  const NCH = CHAPTERS.length - 1;
  const START = CHAPTERS.reduce((a, c, k) => (a.push(k ? a[k - 1] + CHAPTERS[k - 1][2] : 0), a), []);
  const TOTAL = START[NCH] + CHAPTERS[NCH][2];
  const FOCUS = { 5: [[1, 2, 3], []], 6: [[1, 2, 3], ["src"]], 7: [[], ["receiver_mark"]], 8: [[], ["g", "l", "c"]],
                  9: [[], ["g_film", "l_film", "c"]], 10: [[], ["h"]], 11: [[], []] };
  const DIM = 0.16, P = 0.09, N_PATH_BANDS = 4;
  const THEMES = {
    light: { bg: "#FFFFFF", fg: "#1C1C1E", muted: "#6E6E73", rule: "#DEDEE0", accent: "#D9731A", teal: "#2A8C8C", body: "#EFEFEF", trace: "#C8C8CC", box: "#FBE3CC" },
    dark: { bg: "#2E2E31", fg: "#F2F2F4", muted: "#B4B4B8", rule: "#4A4A4E", accent: "#F08A2E", teal: "#4FB3B3", body: "#48484C", trace: "#6E6E73", box: "#5A4232" } };
  const SIGNED = d3.piecewise(d3.interpolateRgb, ["#3B4B7A", "#9AA3BF", "#F4F4F5", "#F2B27A", "#C25A0B"]);   // ElasticConvolutionScanAnimator
  const POSITIVE = d3.piecewise(d3.interpolateRgb, ["#F4F4F5", "#F2B27A", "#D9731A", "#5A2A05"]);
  const MAGMA = t => d3.interpolateMagma(t), GREYS = t => d3.interpolateGreys(t);
  const MEDIUM_CHANNELS = ["Vp", "Vs", "ρ", "solid mask"];
  const DIR0 = (() => { const v = [-1.0, -1.25, 0.85], n = Math.hypot(...v); return v.map(x => x / n); })();
  const $ = s => document.querySelector(s);
  const seg = (u, a, b) => Math.min(1, Math.max(0, (u - a) / (b - a)));
  const ease = x => x * x * (3 - 2 * x);
  const V = (x, y, z) => new THREE.Vector3(x, z, -y);                 // film (x flow, y width, z up) -> three (y up)
  const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const N = { family: null, stage: null, theme: "dark", ctx: null, probe: null, gather: null, T: 0, inset: { left: 0, right: 0, top: 0, bottom: 0 }, ch: null, key: null };

  // ---------------------------------------------------------------- colours and numbers
  const lutCache = new Map();
  function lut(fn) { if (!lutCache.has(fn)) { const t = new Uint8Array(256 * 3); for (let k = 0; k < 256; k++) { const c = d3.rgb(fn(k / 255)); t.set([c.r, c.g, c.b], 3 * k); } lutCache.set(fn, t); } return lutCache.get(fn); }
  const hexRgb = h => { const c = d3.rgb(h); return [c.r, c.g, c.b]; };
  function colorize(values, fn, lo, hi, nanColor) {                    // (n) -> Uint8Array(n*3); NaN -> nanColor
    const t = lut(fn), n = values.length, out = new Uint8Array(n * 3), nan = hexRgb(nanColor), span = Math.max(hi - lo, 1e-12);
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (!Number.isFinite(v)) { out.set(nan, 3 * i); continue; }
      const k = Math.round(Math.min(1, Math.max(0, (v - lo) / span)) * 255) * 3; out[3 * i] = t[k]; out[3 * i + 1] = t[k + 1]; out[3 * i + 2] = t[k + 2];
    }
    return out;
  }
  function percentile(values, q) { const v = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.max(0, Math.round(q / 100 * (v.length - 1))))] : 0; }
  function signedLimit(arrays, q = 98) { const all = []; for (const a of arrays) for (const v of a) if (Number.isFinite(v)) all.push(Math.abs(v)); const p = percentile(all, q); return p > 0 ? p : 1; }
  const stripShape = n => { const rows = n <= 128 ? 4 : n <= 768 ? 8 : 16; return [rows, Math.ceil(n / rows)]; };
  const fmt = (v, d = 2) => (Math.abs(v) < 0.5 * Math.pow(10, -d) ? (0).toFixed(d) : v.toFixed(d));
  const sub = s => s.replace(/_([A-Za-z0-9ℓγβ])/g, "<sub>$1</sub>");

  // ---------------------------------------------------------------- the renderer (built once)
  let renderer, scene, camera, overlay, labelsBox, panel2d, titleEl, captionEl, sun;
  function attach(stage) {
    if (renderer) return;
    N.stage = stage; stage.innerHTML = "";
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    stage.appendChild(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    scene.add(new THREE.AmbientLight(0xffffff, 0.62));
    sun = new THREE.DirectionalLight(0xffffff, 0.55); scene.add(sun);
    overlay = document.createElement("div"); overlay.className = "nw-overlay"; stage.appendChild(overlay);
    labelsBox = document.createElement("div"); labelsBox.className = "nw-labels"; overlay.appendChild(labelsBox);
    panel2d = document.createElement("div"); panel2d.className = "nw-panel2d"; overlay.appendChild(panel2d);
    titleEl = document.createElement("div"); titleEl.className = "nw-stage-title"; overlay.appendChild(titleEl);
    captionEl = document.createElement("div"); captionEl.className = "nw-stage-caption"; overlay.appendChild(captionEl);
    new ResizeObserver(() => { resize(); computeKeys(); draw(); }).observe(stage);
    resize();
  }
  function resize() {
    if (!renderer) return;
    const w = N.stage.clientWidth, h = N.stage.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); renderer.domElement.style.width = w + "px"; renderer.domElement.style.height = h + "px";
    const ins = N.inset;
    Object.assign(overlay.style, { left: `${ins.left}px`, right: `${ins.right}px`, top: `${ins.top}px`, bottom: `${ins.bottom}px` });
  }
  function setInset(values) { N.inset = { ...N.inset, ...values }; resize(); computeKeys(); draw(); }
  function setTheme(name) { N.theme = name === "light" ? "light" : "dark"; if (N.probe && N.gather && N.gather.seed === N.ctx.seed) build(); }
  const th = () => THEMES[N.theme];

  // ---------------------------------------------------------------- the scene, rebuilt for a medium and receiver
  let objs = [], labels = [], dyn = [], regions = {}, parts = {}, camKeys = [], L = null, t = null;
  function clear() {
    for (const o of objs) { scene.remove(o.obj); o.obj.traverse(x => { if (x.geometry) x.geometry.dispose(); if (x.material) (Array.isArray(x.material) ? x.material : [x.material]).forEach(m => { if (m.map) m.map.dispose(); m.dispose(); }); }); }
    objs = []; labels = []; dyn = []; regions = {}; parts = {}; camKeys = []; labelsBox.innerHTML = "";
  }
  function add(obj, on, off = null, tag = null, base = 1) {
    const mats = []; obj.traverse(x => { if (x.material) (Array.isArray(x.material) ? x.material : [x.material]).forEach(m => { m.transparent = true; mats.push(m); }); });
    objs.push({ obj, on, off, tag, base, mats }); scene.add(obj); return obj;
  }
  function region(name, ...boxes) {
    parts[name] = boxes.map(b => Array.from(b));
    const bs = parts[name];
    regions[name] = [Math.min(...bs.map(b => b[0])), Math.max(...bs.map(b => b[1])), Math.min(...bs.map(b => b[2])), Math.max(...bs.map(b => b[3])), Math.min(...bs.map(b => b[4])), Math.max(...bs.map(b => b[5]))];
  }
  function label(text, pos, on, off = null, size = 22, color = null, anchor = "mm", bold = false, tag = null) {
    const el = document.createElement("span"); el.className = `nw-label a-${anchor}${bold ? " b" : ""}`; el.style.display = "none"; labelsBox.appendChild(el);
    labels.push({ el, text, pos: typeof pos === "function" ? pos : () => pos, on, off, size, color: color || th().fg, tag, last: null });
  }
  const basic = (color, extra = {}) => new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, ...extra });
  const lit = (color, extra = {}) => new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, ...extra });
  function rect(x, yc, zc, w, h, color) {
    const p = [V(x, yc + w / 2, zc + h / 2), V(x, yc - w / 2, zc + h / 2), V(x, yc - w / 2, zc - h / 2), V(x, yc + w / 2, zc - h / 2), V(x, yc + w / 2, zc + h / 2)];
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(p), new THREE.LineBasicMaterial({ color }));
  }
  function image(rgb, shape, x, yc, zc, w, h, on, off = null, outline = true, tag = null) {
    const [nr, nc] = shape, cv = document.createElement("canvas"); cv.width = nc; cv.height = nr;
    const ctx = cv.getContext("2d"), img = ctx.createImageData(nc, nr), tex = new THREE.CanvasTexture(cv);
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.LinearFilter;
    const paint = data => { for (let i = 0; i < nr * nc; i++) { img.data[4 * i] = data[3 * i]; img.data[4 * i + 1] = data[3 * i + 1]; img.data[4 * i + 2] = data[3 * i + 2]; img.data[4 * i + 3] = 255; } ctx.putImageData(img, 0, 0); tex.needsUpdate = true; };
    paint(rgb);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), basic(0xffffff, { map: tex }));
    mesh.rotation.y = -Math.PI / 2; mesh.position.copy(V(x, yc, zc));
    const g = new THREE.Group(); g.add(mesh);
    if (outline) g.add(rect(x - 0.003, yc, zc, w, h, th().fg));
    add(g, on, off, tag);
    return { group: g, paint };
  }
  function line(points, color, on, off = null, tag = null) { return add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.map(p => V(...p))), new THREE.LineBasicMaterial({ color })), on, off, tag); }
  function orient(m, a, d) { m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize()); }
  function tube(p0, p1, r, color, on, off = null, tag = null, base = 1) {
    const a = V(...p0), b = V(...p1), d = b.clone().sub(a), m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 10, 1, true), basic(color));
    m.position.copy(a).addScaledVector(d, 0.5); orient(m, a, d); return add(m, on, off, tag, base);
  }
  function arrow(p0, p1, color, on, off = null, r = 0.035) {
    const a = V(...p0), b = V(...p1), d = b.clone().sub(a), n = d.length(), head = Math.min(0.32, 0.4 * n), u = d.clone().normalize(), g = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(r, r, Math.max(n - head, 1e-3), 10, 1, true), basic(color)); shaft.position.copy(a).addScaledVector(u, (n - head) / 2); orient(shaft, a, u);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(3 * r, head, 16), basic(color)); tip.position.copy(a).addScaledVector(u, n - head / 2); orient(tip, a, u);
    g.add(shaft, tip); return add(g, on, off);
  }
  function sphere(c, r, color, on, off = null) { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), lit(color)); m.position.copy(V(...c)); return add(m, on, off); }
  function cone(c, h, r, color, on, off = null, tag = null) {     // a triangular pyramid pointing down, as the film's receivers
    const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 3), lit(color)); m.rotation.x = Math.PI; m.position.copy(V(...c)); return add(m, on, off, tag);
  }
  function block(name, x0, w, h, thick, nLines, on) {
    const g = new THREE.Group(), geo = new THREE.BoxGeometry(thick, h, w), at = V(x0 + thick / 2, 0, 0);
    const body = new THREE.Mesh(geo, lit(th().body)); body.position.copy(at); g.add(body);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: th().fg })); edges.position.copy(at); g.add(edges);
    const pts = [];
    for (let k = 1; k < nLines; k++) { const xk = x0 + thick * k / nLines; pts.push(V(xk, w / 2, h / 2), V(xk, -w / 2, h / 2), V(xk, -w / 2, h / 2), V(xk, -w / 2, -h / 2)); }
    if (pts.length) g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: th().muted })));
    add(g, on);
    region(name, [x0, x0 + thick, -w / 2, w / 2, -h / 2, h / 2]);
    return g;
  }
  // a vector as cubes, one per value (rows x cols), saturated at its 92nd percentile so both signs read at a glance
  function strip(values, x, yc, zc, on, off = null, lim = null, name = null, rows = null) {
    const v = Array.from(values), [r, c] = rows ? [rows, Math.ceil(v.length / rows)] : stripShape(v.length);
    lim = lim ?? signedLimit([v], 92);
    const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.86 * P, 0.86 * P, 0.86 * P), lit(0xffffff), v.length), m = new THREE.Matrix4(), col = new THREE.Color();
    const paint = vals => { const rgb = colorize(vals, SIGNED, -lim, lim, th().bg); for (let i = 0; i < v.length; i++) mesh.setColorAt(i, col.setRGB(rgb[3 * i] / 255, rgb[3 * i + 1] / 255, rgb[3 * i + 2] / 255)); if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true; };
    v.forEach((_, i) => { m.setPosition(V(x, yc + (c - 1) / 2 * P - (i % c) * P, zc + (r - 1) / 2 * P - Math.floor(i / c) * P)); mesh.setMatrixAt(i, m); });
    paint(v);
    add(mesh, on, off, name);
    const box = [x - P, x + P, yc - c * P / 2, yc + c * P / 2, zc - r * P / 2, zc + r * P / 2];
    if (name) region(name, box);
    return { mesh, box, lim, recolor: paint };
  }

  // ---------------------------------------------------------------- layout (the film's _layout)
  function layout() {
    const fam = N.family, [, , nz, nx] = fam.inputs.medium, aspect = nz / nx, Hm = 9, net = fam.network, out = { aspect, Hm };
    out.medium = [0, Hm / aspect, Hm, 0.54];
    let x = 0.54 + 3.0;
    [["stem", 0.8], ["f4", 0.62], ["f8", 0.48], ["f16", 0.37]].forEach(([name, f], k) => {
      const h = Hm * f, C = net.widths[k], thick = Math.max(0.4, 0.35 * Math.log2(Math.max(C, 2)) - 0.9);
      out[name] = [x, h / aspect, h, thick]; x += thick + 2.8;
    });
    const [x16, , , t16] = out.f16;
    out.XP = x16 + t16 + 3.6; out.XG = out.XP + 4.4; out.XL = out.XG + 7.0; out.ZG = Hm * 0.36; out.ZS = -Hm * 0.36; out.ZR = -Hm / 2 - 3.6;
    out.XF = out.XL + 4.4; out.XC = out.XF + 7.0; out.XD = out.XC + 11.0; out.WD = 14.0; out.XT = out.XD + 2.4 * net.n_up + 5.0; out.XGt = out.XT + 5.0;
    return out;
  }
  function onFace(p, name, dx = -0.02) {                            // input cell (x, z) -> the front face of block `name`
    const [, , nz, nx] = N.family.inputs.medium, [x0, w, h] = L[name];
    return [x0 + dx, w / 2 - (p[0] + 0.5) / nx * w, h / 2 - (p[1] + 0.5) / nz * h];
  }

  // ---------------------------------------------------------------- the tensors of one medium and receiver
  function tensors() {
    const fam = N.family, net = fam.network, Q = N.probe, ctx = N.ctx, [, , nz, nx] = fam.inputs.medium, size = nz * nx;
    const stride = fam.inputs.query_widths.reduce((a, b) => a + b, 0), row = ctx.query.subarray(ctx.rx * stride, (ctx.rx + 1) * stride);
    const lin = Q.l_in.data, n4 = net.widths[1], n8 = net.widths[2], n16 = net.widths[3], K = net.path_points, cen = net.source_points[1], rp = [row[0], row[1]];
    const out = {
      medium: [0, 1, 2, 3].map(q => ctx.input.subarray(q * size, (q + 1) * size)), nz, nx,
      // (a precomputed map carries only the channel the film draws: its data is that one channel already)
      ch: (tt, c) => { const [, , H, W] = tt.dims, off = tt.data.length === H * W ? 0 : c * H * W; return { data: tt.data.subarray(off, off + H * W), H, W }; },
      receiver_xz: rp, coords_norm: [row[2], row[3]], t_bound: row[stride - 1],
      pooled_mean: Q.pooled.data.subarray(0, n16), pooled_max: Q.pooled.data.subarray(n16, 2 * n16),
      src_samples: d3.range(net.source_points.length).map(q => Q.src_in.data.subarray(q * n16, (q + 1) * n16)),
      local_f4: lin.subarray(0, n4), local_f8: lin.subarray(n4, n4 + n8), local_f16: lin.subarray(n4 + n8, n4 + n8 + n16),
      path_points: d3.range(K).map(k => [cen[0] + (rp[0] - cen[0]) * k / (K - 1), cen[1] + (rp[1] - cen[1]) * k / (K - 1)]),
      path_matrix: Q.path_proj.data, path: Q.path.data, g: Q.g.data, src: Q.src.data, l: Q.l.data, c: Q.c.data,
      fourier: Q.fourier.data, static: Q.query_in.data.subarray(Q.fourier.data.length, Q.fourier.data.length + net.n_static), receiver_in: Q.query_in.data,
      gamma_g: Q.film_g.data.subarray(0, net.latent_dim), beta_g: Q.film_g.data.subarray(net.latent_dim), g_film: Q.g_mod.data,
      gamma_l: Q.film_l.data.subarray(0, net.latent_dim), beta_l: Q.film_l.data.subarray(net.latent_dim), l_film: Q.l_mod.data, h: Q.h.data,
      seq0: { data: Q.seq.data, rows: net.decoder_channels, cols: net.length0 },
      ups: [0, 1, 2, 3].map(i => ({ data: Q["up" + i].data, rows: Q["up" + i].dims[1], cols: Q["up" + i].dims[2] })),
      out: [0, 1].map(c => Q.velocity.data.subarray(c * fam.clock.nt_model, (c + 1) * fam.clock.nt_model)),
    };
    out.concat = Float32Array.from([...out.g_film, ...out.l_film, ...out.c]);
    return out;
  }
  // the FDM on the network's own clock and scale: acceleration integrated, every factor-th sample, divided by sigma_v
  function fdmNormalized(fdmAcc, k) {
    const fam = N.family, nt = fam.clock.nt, f = fam.clock.factor, T = fam.clock.nt_model, s = fam.normalizer.sigma_v;
    return [0, 1].map(c => { const v = DSP.cumulative(fdmAcc.subarray((k * 2 + c) * nt, (k * 2 + c + 1) * nt), fam.clock.dt); return Float32Array.from({ length: T }, (_, i) => v[Math.min(nt - 1, i * f)] / s); });
  }

  // ---------------------------------------------------------------- the build (the film's _build, chapter by chapter)
  function build() {
    clear();
    L = layout(); t = tensors();
    const fam = N.family, net = fam.network, T_ = th(), bg = T_.bg, dx = fam.grid.dx, { nz, nx } = t;
    const [, Wm, Hm] = L.medium, solid = t.medium[3], solidAt = i => solid[i] > 0.5, rx = N.ctx.rx, rxName = fam.receivers.labels[rx];
    const solidOn = (str, W) => i => { const r = Math.floor(i / W), c = i % W; return solid[Math.min(nz - 1, str * r) * nx + Math.min(nx - 1, str * c)] > 0.5; };

    // ---- 0. the solver: where the training data come from
    const vpGrey = (() => {
      const v = t.medium[0], s = [], c0 = hexRgb(T_.body), c1 = hexRgb(T_.muted), out = new Uint8Array(nz * nx * 3), bgc = hexRgb(bg);
      for (let i = 0; i < nz * nx; i++) if (solidAt(i)) s.push(v[i]);
      const lo = percentile(s, 1), hi = percentile(s, 99);
      for (let i = 0; i < nz * nx; i++) {
        if (!solidAt(i)) { out.set(bgc, 3 * i); continue; }
        const sh = Math.min(1, Math.max(0, (v[i] - lo) / Math.max(hi - lo, 1e-12)));
        for (let q = 0; q < 3; q++) out[3 * i + q] = (1 - 0.75 * sh) * c0[q] + 0.75 * sh * c1[q];
      }
      return out;
    })();
    const sheet = image(vpGrey, [nz, nx], -0.03, 0, 0, Wm, Hm, [0, 0, 0.08], [1, 0, 0.15]);
    fam.receivers.x.forEach((x, k) => { if (k !== rx) cone(add3(onFace([x, fam.receivers.z[k]], "medium", -0.06), [0, 0, 0.2]), 0.26, 0.11, T_.muted, [0, 0.06, 0.12], [1, 0, 0.15]); });
    label(`${fam.receivers.x.length} receivers on the surface`, add3(onFace([fam.receivers.x[0], fam.receivers.z[0]], "medium"), [0, 0, 0.75]), [0, 0.08, 0.14], [1, 0, 0.1], 26, T_.muted, "lm");
    const pR = onFace(t.receiver_xz, "medium", -0.06);
    cone(add3(pR, [0, 0, 0.3]), 0.5, 0.24, T_.teal, [0, 0.1, 0.14], [1, 0, 0.15]);
    label(`receiver ${rxName}`, add3(pR, [0, 0, 1.25]), [0, 0.1, 0.14], [1, 0, 0.1], 28, T_.teal, "mm", true);
    const rup = fam.rupture, rupCenters = rup.x.map((x, i) => onFace([x, rup.z[i]], "medium", -0.07));
    const rupMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.11, 0.11, 0.11), lit(0xffffff), rupCenters.length), mm = new THREE.Matrix4(), cc = new THREE.Color();
    rupCenters.forEach((c, i) => { mm.setPosition(V(...c)); rupMesh.setMatrixAt(i, mm); rupMesh.setColorAt(i, cc.set(T_.muted)); });
    add(rupMesh, [0, 0.08, 0.14], [1, 0, 0.15]);
    label(`rupture: ${rup.x.length} point sources`, add3(rupCenters[rupCenters.length - 1], [0, -0.25, -0.15]), [0, 0.1, 0.16], [1, 0, 0.1], 26, T_.accent, "lm", true);
    const hyp = onFace(fam.source.hypocenter, "medium", -0.08);
    sphere(hyp, 0.15, T_.accent, [0, 0.1, 0.16], [1, 0, 0.15]);
    label("hypocenter", add3(hyp, [0, 0.45, 0]), [0, 0.1, 0.16], [1, 0, 0.1], 26, T_.accent, "rm");
    for (let km = 0; km <= Math.floor(nx * dx / 1000); km++) { const y = Wm / 2 - km * 1000 / dx / nx * Wm; line([[-0.03, y, -Hm / 2], [-0.03, y, -Hm / 2 - 0.15]], T_.muted, [0, 0.04, 0.1], [1, 0, 0.15]); label(km ? String(km) : "0 km", [-0.03, y, -Hm / 2 - 0.5], [0, 0.04, 0.1], [1, 0, 0.1], 25, T_.muted); }
    for (let km = 1; km <= Math.floor(nz * dx / 1000); km++) { const z = Hm / 2 - km * 1000 / dx / nz * Hm; line([[-0.03, Wm / 2, z], [-0.03, Wm / 2 + 0.15, z]], T_.muted, [0, 0.04, 0.1], [1, 0, 0.15]); label(km === 1 ? "1 km deep" : String(km), [-0.03, Wm / 2 + 0.3, z], [0, 0.04, 0.1], [1, 0, 0.1], 25, T_.muted, "rm"); }
    const PLAY0 = 0.16, PLAY1 = 0.84, tEnd = fam.clock.duration;
    const simTime = T => (Math.floor(T) === 0 ? tEnd * seg(T - Math.floor(T), PLAY0, PLAY1) : tEnd);
    N.simTime = simTime;
    const wave = N.ctx.wave;                                         // the replayed wavefield, when this medium has one
    if (wave) {
      const base = new Uint8Array((nx - 1) * (nz - 1) * 4), rgb = new Uint8Array(nz * nx * 3), comp = {};
      for (let iz = 0; iz < nz - 1; iz++) for (let ix = 0; ix < nx - 1; ix++) { const p = (iz * (nx - 1) + ix) * 4, q = (iz * nx + ix) * 3; base[p] = vpGrey[q]; base[p + 1] = vpGrey[q + 1]; base[p + 2] = vpGrey[q + 2]; base[p + 3] = 255; }
      let last = "";
      dyn.push(T => {
        const ch = Math.floor(T), u = T - ch;
        if (ch !== 0) { if (last !== "rest") { sheet.paint(vpGrey); last = "rest"; } return; }
        const frame = Wave.frameAt(wave, simTime(T)), fade = 1 - ease(seg(u, 0.9, 0.99)), key = `${frame}:${fade.toFixed(2)}`;
        if (key === last) return; last = key;
        Wave.compose(wave, frame, base, solid, nx, nz, 1, comp);
        for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
          const q = (iz * nx + ix) * 3, p = (Math.min(iz, nz - 2) * (nx - 1) + Math.min(ix, nx - 2)) * 4;
          for (let k = 0; k < 3; k++) rgb[q + k] = (1 - fade) * vpGrey[q + k] + fade * comp.rgba[p + k];
        }
        sheet.paint(rgb);
      });
    }
    let lastLit = -1;
    dyn.push(T => {                                                   // the rupture lights as its front passes
      const ts = Math.floor(T) === 0 ? simTime(T) : -1, n = rup.activation_s.filter(a => ts > 0 && a <= ts).length;
      if (n === lastLit) return; lastLit = n;
      rup.activation_s.forEach((a, i) => rupMesh.setColorAt(i, cc.set(ts > 0 && a <= ts ? T_.accent : T_.muted)));
      rupMesh.instanceColor.needsUpdate = true;
    });
    region("solver", [-0.1, 0.54, -Wm / 2 - 0.9, Wm / 2 + 1.6, -Hm / 2 - 0.8, Hm / 2 + 1.5]);

    // ---- 1. the medium: four sheets, Vp Vs ρ in magma with the air left out, the mask in greys
    const planes = [];
    for (let q = 0; q < 4; q++) {
      let rgb;
      if (q < 3) { const v = t.medium[q], s = []; for (let i = 0; i < nz * nx; i++) if (solidAt(i)) s.push(v[i]); rgb = colorize(Float32Array.from(v, (x, i) => (solidAt(i) ? x : NaN)), MAGMA, percentile(s, 1), percentile(s, 99), bg); }
      else rgb = colorize(Float32Array.from(solid, m => 1 - m), GREYS, -0.15, 1.6, bg);
      planes.push(image(rgb, [nz, nx], 0.18 * q, 0, 0, Wm, Hm, [1, 0.06 + 0.07 * q, 0.16 + 0.07 * q]));
    }
    const explode = T => (T >= 2 || T < 1 ? 0 : 3.2 * (1 - ease(seg(T - 1, 0.55, 0.85))));
    dyn.push(T => { const d = explode(T); planes.forEach((pl, q) => pl.group.position.set(q * d, 0, 0)); });
    MEDIUM_CHANNELS.forEach((name, q) => label(name, T => [0.18 * q + q * explode(T), -Wm / 2 + 0.7, -Hm / 2 - 0.45], [1, 0.06 + 0.07 * q, 0.16 + 0.07 * q], [1, 0.52, 0.6], 28, null, "mm", true));
    label(`medium tensor (4, ${nz}, ${nx})`, [0.3, 0, Hm / 2 + 0.8], [1, 0.85, 0.95], [2, 0, 0.15], 28, null, "mm", true);
    region("medium", [0, 0.54, -Wm / 2, Wm / 2, -Hm / 2, Hm / 2]);
    region("medium_exploded", [0, 0.54 + 3 * 3.2, -Wm / 2, Wm / 2, -Hm / 2 - 0.8, Hm / 2 + 1.0]);

    // ---- 2. stem: the trained kernel scans the medium
    const [xs, ws, hs, ts] = L.stem, K = net.stem_kernel, S = net.stem_stride, chS = N.ch.stem;
    block("stem", xs, ws, hs, ts, 8, [2, 0, 0.06]);
    const conv = t.ch(N.probe.stem_conv, chS), act = t.ch(N.probe.stem, chS), hC = conv.H, wC = conv.W, solidS = solidOn(S, wC);
    const convS = Float32Array.from(conv.data, (v, i) => (solidS(i) ? v : NaN)), actS = Float32Array.from(act.data, (v, i) => (solidS(i) ? v : NaN));
    const vmax = signedLimit([convS], 99.5);
    const rgbRaw = colorize(convS, SIGNED, -vmax, vmax, bg), rgbAct = colorize(actS, POSITIVE, percentile(actS, 1), percentile(actS, 99), bg), blank = new Uint8Array(hC * wC * 3);
    for (let i = 0; i < hC * wC; i++) blank.set(hexRgb(bg), 3 * i);
    const stemFace = image(blank, [hC, wC], xs - 0.004, 0, 0, ws, hs, [2, 0, 0.06], null, false);
    const cw = Wm / nx, chh = Hm / nz, ow = ws / wC, oh = hs / hC;
    const kern = add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(0.62, K * chh, K * cw)), new THREE.LineBasicMaterial({ color: T_.accent })), [2, 0.06, 0.1], [2, 0.9, 0.97]);
    const cellBox = add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(0, ow / 2, oh / 2), V(0, -ow / 2, oh / 2), V(0, -ow / 2, -oh / 2), V(0, ow / 2, -oh / 2), V(0, ow / 2, oh / 2)]), new THREE.LineBasicMaterial({ color: T_.accent })), [2, 0.06, 0.1], [2, 0.9, 0.97]);
    const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    add(new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: T_.accent })), [2, 0.06, 0.1], [2, 0.9, 0.97]);
    const jMid = Math.floor(wC / 2); let i0 = 0; while (i0 < hC - 1 && !solidS(i0 * wC + jMid)) i0++;
    const cells = d3.range(6).map(q => [Math.min(hC - 1, i0 + 4 + 3 * q), jMid]);  // down the middle column, under the surface
    const win = (i, j) => ({ row0: S * i - Math.floor(K / 2), col0: S * j - Math.floor(K / 2) });
    const w0 = win(...cells[3]), zc0 = Hm / 2 - (w0.row0 + K / 2) * chh, yc0 = Wm / 2 - (w0.col0 + K / 2) * cw;
    const W8 = net.stem_weight[chS], wmax = Math.max(...W8.flat(3).map(Math.abs)), ksz = 0.3, ky = yc0 + 0.45, kz = zc0 + 0.35;
    for (let q = 0; q < 4; q++) image(colorize(W8[q].flat(), SIGNED, -wmax, wmax, bg), [K, K], -1.0 + 0.16 * q, ky, kz, ksz, ksz, [2, 0.04, 0.12], [2, 0.42, 0.5]);
    label(`trained kernel · stem channel ${chS + 1} of ${net.widths[0]} · ${K}×${K} × 4 sheets`, [-1.2, ky, kz + ksz / 2 + 0.55], [2, 0.04, 0.12], [2, 0.42, 0.5], 25, null, "mm", true);
    label("sheets, front to back: " + MEDIUM_CHANNELS.join(" · "), [-1.2, ky, kz - ksz / 2 - 0.2], [2, 0.04, 0.12], [2, 0.42, 0.5], 23, T_.muted);
    const DETAIL_END = 0.42;
    const stemState = T => {
      const ch = Math.floor(T), u = T - ch;
      if (ch > 2 || ch === 0) return [hC - 1, wC - 1, -1, 1];
      if (ch < 2) return [cells[0][0], cells[0][1], 0, 0];
      if (u < DETAIL_END) { const q = Math.max(0, Math.min(cells.length - 1, Math.floor((u - 0.1) / (DETAIL_END - 0.1) * cells.length))); return [cells[q][0], cells[q][1], -(q + 1) - 1000, 0]; }
      const p = ease(seg(u, 0.45, 0.78)), n = Math.floor(p * hC * wC), k = Math.min(n, hC * wC - 1);
      return [Math.floor(k / wC), k % wC, n, ease(seg(u, 0.8, 0.92))];
    };
    const stemRGB = new Uint8Array(hC * wC * 3);
    let lastStem = "";
    dyn.push(T => {
      const [i, j, n, bend] = stemState(T), key = `${n},${bend.toFixed(2)}`;
      if (key !== lastStem) {
        lastStem = key;
        if (n === -1 || bend > 0) for (let q = 0; q < stemRGB.length; q++) stemRGB[q] = (1 - bend) * rgbRaw[q] + bend * rgbAct[q];
        else { stemRGB.set(blank); if (n <= -1000) for (let q = 0; q < -n - 1000; q++) { const [ii, jj] = cells[q], p = 3 * (ii * wC + jj); stemRGB.set(rgbRaw.subarray(p, p + 3), p); } else if (n > 0) stemRGB.set(rgbRaw.subarray(0, 3 * n)); }
        stemFace.paint(stemRGB);
      }
      const w = win(i, j), top = [0, Wm / 2 - w.col0 * cw, Hm / 2 - w.row0 * chh], oc = [xs - 0.01, ws / 2 - (j + 0.5) * ow, hs / 2 - (i + 0.5) * oh];
      kern.position.copy(V(top[0] + 0.27, top[1] - K * cw / 2, top[2] - K * chh / 2));
      cellBox.position.copy(V(...oc));
      rayGeo.setFromPoints([V(top[0] + 0.6, top[1] - K * cw / 2, top[2] - K * chh / 2), V(...oc)]);
    });
    label(T => { const [i, j] = stemState(T), raw = conv.data[i * wC + j], v = Math.abs(raw) < 5e-4 ? 0 : raw; return `y[${i}, ${j}] = Σ weight × input = ${v >= 0 ? "+" : "−"}${fmt(Math.abs(v), 3)}`; },
          T => (T - Math.floor(T) < DETAIL_END ? [-0.6, yc0 + 0.3, zc0 - 0.45] : [xs + ts / 2, 0, hs / 2 + 0.8]), [2, 0.1, 0.14], [2, 0.78, 0.8], 28, T_.accent, "mm", true);
    label(`stem: ${net.widths[0]} ch · ${act.H}×${act.W} · stride ${S}`, [xs + ts / 2, -ws / 2, -hs / 2 - 0.5], [2, 0, 0.06], [4, 0, 0.1], 26, null, "mm", true);
    label("GroupNorm + GELU: the raw sums bend into the activation", [xs + ts / 2, 0, hs / 2 + 0.8], [2, 0.8, 0.84], [3, 0, 0.1], 28, T_.accent, "mm", true);
    region("stem_detail", [-1.0, 0.6, yc0 - 0.4, ky + ksz / 2, zc0 - 0.6, kz + ksz / 2 + 0.6]);
    region("stem_all", regions.medium, regions.stem);

    // ---- 3. encoder
    const rf = net.receptive_fields;
    ["f4", "f8", "f16"].forEach((name, q) => {
      const [xb, wb, hb, tb] = L[name], on = [3, 0.1 + 0.25 * q, 0.28 + 0.25 * q], C = net.widths[q + 1];
      block(name, xb, wb, hb, tb, 8 + 3 * q, on);
      const mp = t.ch(N.probe[name], N.ch[name]), sol = solidOn([4, 8, 16][q], mp.W), vals = Float32Array.from(mp.data, (v, i) => (sol(i) ? v : NaN));
      image(colorize(vals, POSITIVE, percentile(vals, 1), percentile(vals, 99), bg), [mp.H, mp.W], xb - 0.004, 0, 0, wb, hb, on, null, false);
      label(name, [xb + tb / 2, -wb / 2, -hb / 2 - 0.4], on, [7, 0, 0.1], 28, null, "mm", true);
      label(`${C} ch · ${mp.H}×${mp.W} · sees ${rf[name]} cells ≈ ${Math.round(rf[name] * dx).toLocaleString("en-US")} m`, [xb + tb / 2, -wb / 2, -hb / 2 - 0.95], on, [4, 0, 0.1], 25, T_.muted);
      const prev = L[q === 0 ? "stem" : ["f4", "f8"][q - 1]];
      label(["Conv 5×5 /2 + 1 ResBlock", "Conv 3×3 /2 + 1 ResBlock", "Conv 3×3 /2 + 2 ResBlocks"][q], [(prev[0] + prev[3] + xb) / 2, 0, Math.max(prev[2], hb) / 2 + 0.6], on, [4, 0, 0.1], 25, T_.accent);
    });
    region("encoder", regions.stem, regions.f4, regions.f8, regions.f16);
    const [x16, w16, h16, t16] = L.f16;

    // ---- 4. global latent
    const { XP, XG, ZG, ZS } = L, f16d = N.probe.f16.dims, sol16 = solidOn(16, f16d[3]), n16c = f16d[2] * f16d[3];
    const airRgb = new Uint8Array(n16c * 3), grey = hexRgb(T_.muted), bgc = hexRgb(bg);
    let anyAir = false; for (let i = 0; i < n16c; i++) { const air = !sol16(i); anyAir = anyAir || air; airRgb.set(air ? grey : bgc, 3 * i); }
    if (anyAir) {
      image(airRgb, [f16d[2], f16d[3]], x16 - 0.012, 0, 0, w16, h16, [4, 0.05, 0.2], [5, 0, 0.2], false);
      label("air cells left out", [x16, w16 / 2 + 0.2, h16 / 2 + 0.4], [4, 0.05, 0.2], [5, 0, 0.1], 25, T_.muted, "rm");
    }
    const sMean = strip(t.pooled_mean, XP, 0, ZG + 0.55, [4, 0.25, 0.4]), sMax = strip(t.pooled_max, XP, 0, ZG - 0.55, [4, 0.25, 0.4]);
    label(`mean over solid cells (${t.pooled_mean.length})`, [XP, sMean.box[3] + 0.2, ZG + 0.55], [4, 0.25, 0.4], [5, 0, 0.1], 25, null, "rm");
    label(`max over solid cells (${t.pooled_max.length})`, [XP, sMax.box[3] + 0.2, ZG - 0.55], [4, 0.25, 0.4], [5, 0, 0.1], 25, null, "rm");
    for (const zp of [ZG + 0.55, ZG - 0.55]) arrow([x16 + t16 + 0.2, 0, h16 / 2 * 0.6], [XP - 0.2, 0, zp], T_.muted, [4, 0.18, 0.3]);
    arrow([XP + 0.2, 0, ZG], [XG - 0.2, 0, ZG], T_.muted, [4, 0.5, 0.6]);
    label("Linear · GELU · LayerNorm", [(XP + XG) / 2, 0, ZG + 1.3], [4, 0.5, 0.6], [5, 0, 0.1], 25, T_.accent);
    const sG = strip(t.g, XG, 0, ZG, [4, 0.6, 0.78], null, null, "g");
    label(`g (${t.g.length})`, [XG, sG.box[2] - 0.25, ZG], [4, 0.6, 0.78], [9, 0, 0.1], 28, null, "lm", true, "g");
    region("global", regions.f16, regions.g, sMean.box, sMax.box);

    // ---- 5. source features
    const sp = net.source_points, names = ["hypocenter", "centroid", ...d3.range(sp.length - 2).map(q => `rupture point ${q + 1}`)], srcBoxes = [];
    line(rup.x.map((x, i) => onFace([x, rup.z[i]], "f16", -0.03)), T_.fg, [5, 0.05, 0.15], [6, 0, 0.2]);
    sp.forEach((p, q) => {
      const wp = onFace(p, "f16", -0.04), z = ZS + 1.0 - 0.6 * q, on = [5, 0.45 + 0.04 * q, 0.55 + 0.04 * q];
      sphere(wp, q < 2 ? 0.08 : 0.06, T_.accent, [5, 0.1 + 0.05 * q, 0.16 + 0.05 * q]);
      tube(wp, [XP - 0.2, 0, z], 0.012, T_.accent, [5, 0.42 + 0.04 * q, 0.5 + 0.04 * q], null, null, 0.7);
      const s = strip(t.src_samples[q], XP, 0, z, on, null, null, null, 4); srcBoxes.push(s.box);
      label(names[q], [XP, s.box[2] - 0.2, z], on, [6, 0, 0.1], 25, null, "lm");
    });
    arrow([XP + 0.2, 0, ZS - 0.4], [XG - 0.2, 0, ZS], T_.muted, [5, 0.78, 0.86]);
    label("concat · Linear · GELU · LayerNorm", [(XP + XG) / 2, 0, ZS + 0.9], [5, 0.78, 0.86], [6, 0, 0.1], 25, T_.accent);
    const sSrc = strip(t.src, XG, 0, ZS, [5, 0.84, 0.96], null, null, "src");
    label(`src (${t.src.length})`, [XG, sSrc.box[2] - 0.25, ZS], [5, 0.84, 0.96], [7, 0, 0.1], 28, null, "lm", true, "src");
    region("sources", regions.f16, regions.src, ...srcBoxes);

    // ---- 6. the receiver query
    const rp = t.receiver_xz, onPts = Object.fromEntries(["medium", "stem", "f4", "f8", "f16"].map(n => [n, onFace(rp, n)]));
    const tri = cone([0, 0, 0], 0.55, 0.28, T_.teal, [6, 0, 0.08], null, "receiver_mark");
    dyn.push(T => { const ch = Math.floor(T), u = T - ch, drop = ch > 6 || ch === 0 || ch === NCH ? 1 : ch === 6 ? ease(seg(u, 0, 0.12)) : 0; tri.position.copy(V(...add3(onPts.medium, [0.3, 0, 0.3 + 2.0 * (1 - drop)]))); });
    const rayPts = ["medium", "stem", "f4", "f8", "f16"].map(n => onPts[n]);
    for (let k = 1; k < rayPts.length; k++) tube(rayPts[k - 1], rayPts[k], 0.03, T_.teal, [6, 0.1, 0.2]);
    label(`receiver ${rxName} of ${fam.receivers.x.length} · x = ${(rp[0] * dx / 1000).toFixed(2)} km`, add3(onPts.medium, [0, 0, 1.6]), [6, 0.03, 0.1], [7, 0, 0.1], 24, T_.teal, "mm", true);
    const lboxes = [];
    ["f4", "f8", "f16"].forEach((name, q) => {
      const [xb, , hb, tb] = L[name], p = onPts[name], top = [xb + tb / 2, p[1], hb / 2 + 1.2], on = [6, 0.18 + 0.05 * q, 0.28 + 0.05 * q];
      tube(p, [top[0], top[1], top[2] - 0.3], 0.02, T_.teal, on);
      const v = t[`local_${name}`], s = strip(v, top[0], top[1], top[2], on); lboxes.push(s.box);
      label(`${name} under the receiver · ${v.length}`, [top[0], top[1], s.box[5] + 0.3], on, [6, 0.66, 0.74], 25);
    });
    t.path_points.forEach((p, q) => sphere(onFace(p, "f16", -0.05), 0.045, T_.accent, [6, 0.4 + 0.012 * q, 0.41 + 0.012 * q]));
    line([onFace(t.path_points[0], "f16", -0.05), onFace(t.path_points[t.path_points.length - 1], "f16", -0.05)], T_.accent, [6, 0.4, 0.6]);
    label(`path: ${t.path_points.length} points, centroid → receiver, read on f16`, [x16, -w16 / 2 - 0.2, -h16 / 2 - 1.0], [6, 0.42, 0.5], [6, 0.72, 0.78], 26, T_.accent, "lm", true);
    const Kp = net.path_points, pm = new Float32Array(64 * Kp);           // (K, 64) -> (64, K)
    for (let k = 0; k < Kp; k++) for (let c = 0; c < 64; c++) pm[c * Kp + k] = t.path_matrix[k * 64 + c];
    const pl = signedLimit([pm]), pw = 2.2, ph = 1.6;
    image(colorize(pm, SIGNED, -pl, pl, bg), [64, Kp], XP, 0, 0, pw, ph, [6, 0.62, 0.7]);
    tube(onFace(t.path_points[Kp - 1], "f16", -0.05), [XP - 0.05, 0, 0], 0.015, T_.accent, [6, 0.6, 0.66]);
    label(`path features: ${Kp} points × 64`, [XP, 0, -ph / 2 - 0.35], [6, 0.62, 0.7], [7, 0, 0.1], 25);
    const xpv = XP + 2.3;
    arrow([XP + 0.1, 0, 0], [xpv - 0.25, 0, 0], T_.muted, [6, 0.7, 0.75]);
    label("Conv1d × 2 · Linear", [(XP + xpv) / 2, 0, 0.5], [6, 0.7, 0.75], [7, 0, 0.1], 25, T_.accent);
    const sPath = strip(t.path, xpv, 0, 0, [6, 0.74, 0.8]);
    label(`path (${t.path.length})`, [xpv, 0, sPath.box[4] - 0.3], [6, 0.74, 0.8], [7, 0, 0.1], 25);
    const { XL } = L;
    for (const p0 of [[xpv + 0.2, 0, 0], [XG + 0.2, 0, ZS + 0.2]]) arrow(p0, [XL - 0.25, 0, 0.1], T_.muted, [6, 0.84, 0.9]);
    for (const b of lboxes) arrow([b[1] + 0.1, (b[2] + b[3]) / 2, b[5]], [XL - 0.25, 0, 0.3], T_.muted, [6, 0.84, 0.9], null, 0.018);
    label(`concat [local · path · src] (${t.local_f4.length + t.local_f8.length + t.local_f16.length + t.path.length + t.src.length}) → Linear · GELU · LN`, [XL, 0, 1.5], [6, 0.86, 0.92], [7, 0, 0.1], 25, T_.accent);
    const sL = strip(t.l, XL, 0, 0, [6, 0.9, 0.98], null, null, "l");
    label(`ℓ (${t.l.length})`, [XL, sL.box[2] - 0.25, 0], [6, 0.9, 0.98], [9, 0, 0.1], 28, null, "lm", true, "l");
    region("query_wide", regions.medium, regions.f16, ...lboxes);
    region("query_path", [x16 - 0.2, x16 + t16, -w16 / 2 - 3.2, w16 / 2, -h16 / 2 - 1.3, h16 / 2]);
    region("query_right", [XP - 0.5, XP + 0.5, -pw / 2, pw / 2, -ph / 2, ph / 2], regions.l, sPath.box, regions.src);

    // ---- 7. receiver embedding
    const { ZR } = L, xr = t.coords_norm[0], freqs = net.fourier_frequencies;
    const bands = d3.range(N_PATH_BANDS).map(q => Math.round(q * (freqs.length - 1) / (N_PATH_BANDS - 1))), ys = u => 3.0 - 6.0 * u;
    bands.forEach((b, q) => {
      const z0 = ZR + 1.2 - 1.15 * q, fr = freqs[b], on = [7, 0.08 + 0.08 * q, 0.16 + 0.08 * q];
      line(d3.range(0, 1.0001, 1 / 300).map(s => [XP, ys(s), z0 + 0.4 * Math.sin(2 * Math.PI * fr * s)]), T_.muted, on);
      sphere([XP, ys(xr), z0 + 0.4 * Math.sin(2 * Math.PI * fr * xr)], 0.1, T_.teal, on);
      label(`sin(2π · ${fr.toFixed(2)} · x)`, [XP, 3.3, z0], on, [8, 0, 0.1], 25, T_.muted, "rm");
    });
    label(`x_r = x / (nx − 1) = ${xr.toFixed(3)}`, [XP, 3.3, ZR + 2.2], [7, 0.05, 0.12], [8, 0, 0.1], 26, T_.teal, "rm", true);
    label(`… ${freqs.length} bands, sin and cos, for x and z`, [XP, 0, ZR + 0.7 - 1.15 * N_PATH_BANDS], [7, 0.4, 0.5], [8, 0, 0.1], 25, T_.muted);
    const sF = strip(t.fourier, XG, 0, ZR + 1.0, [7, 0.45, 0.55]);
    label(`Fourier features (${t.fourier.length})`, [XG, sF.box[2] - 0.2, ZR + 1.0], [7, 0.45, 0.55], [8, 0, 0.1], 25, null, "lm");
    const sS = strip(t.static, XG, 0, ZR, [7, 0.5, 0.6], null, null, null, 1);
    label(`site descriptors (${t.static.length})`, [XG, sS.box[2] - 0.2, ZR], [7, 0.5, 0.6], [8, 0, 0.1], 25, null, "lm");
    const sT = strip([t.receiver_in[t.receiver_in.length - 1]], XG, 0, ZR - 1.0, [7, 0.55, 0.65], null, 1.0, null, 1);
    label(`t_b = ${t.t_bound.toFixed(2)} s: earliest possible P arrival`, [XG, sT.box[2] - 0.2, ZR - 1.0], [7, 0.55, 0.65], [8, 0, 0.1], 25, null, "lm");
    arrow([XG + 0.2, 0, ZR], [XL - 0.25, 0, ZR], T_.muted, [7, 0.65, 0.72]);
    label("MLP: 2 × (Linear · GELU · LN)", [(XG + XL) / 2, 0, ZR + 0.5], [7, 0.65, 0.72], [8, 0, 0.1], 25, T_.accent);
    const sC = strip(t.c, XL, 0, ZR, [7, 0.72, 0.85], null, null, "c");
    label(`c (${t.c.length})`, [XL, sC.box[2] - 0.25, ZR], [7, 0.72, 0.85], [10, 0, 0.1], 28, null, "lm", true, "c");
    region("receiver", [XP, XP, -3.4, 3.4, ZR - 4.0, ZR + 2.3], regions.c, sF.box, sS.box, sT.box);

    // ---- 8. FiLM
    const { XF } = L, trunk = XF - 1.0, fboxes = [], filmStrips = [];
    tube([XL + 0.4, 0, ZR], [trunk, 0, ZR], 0.03, T_.teal, [8, 0.02, 0.08]);
    tube([trunk, 0, ZR], [trunk, 0, ZG + 1.9], 0.03, T_.teal, [8, 0.04, 0.1]);
    [["g", ZG, XG, 0.0], ["l", 0.0, XL, 0.42]].forEach(([nm, z, xsrc, t0]) => {
      const sym = nm === "g" ? "g" : "ℓ", on = [8, t0 + 0.08, t0 + 0.16], gam = t[`gamma_${nm}`], bet = t[`beta_${nm}`];
      for (const zt of [z + 0.95, z + 1.85]) arrow([trunk, 0, zt], [XF - 0.25, 0, zt], T_.teal, on, null, 0.025);
      const sGa = strip(gam, XF, 0, z + 0.95, on), sBe = strip(bet, XF, 0, z + 1.85, on);
      label(`γ_${sym}(c) (${gam.length})`, [XF, sGa.box[2] - 0.2, z + 0.95], on, [9, 0, 0.1], 25, null, "lm");
      label(`β_${sym}(c) (${bet.length})`, [XF, sBe.box[2] - 0.2, z + 1.85], on, [9, 0, 0.1], 25, null, "lm");
      arrow([xsrc + 0.25, 0, z], [XF + 3.4, 0, z], T_.muted, [8, t0 + 0.16, t0 + 0.22]);
      const v0 = t[nm], v1 = t[`${nm}_film`], lim = signedLimit([v0, v1]);
      const sM = strip(v0, XF + 3.6, 0, z, [8, t0 + 0.2, t0 + 0.26], null, lim, `${nm}_film`);
      fboxes.push(sGa.box, sBe.box); filmStrips.push({ s: sM, v0, v1, t0, last: -1 });
      label(`${sym}' = ${sym} · (1 + γ_${sym}) + β_${sym}`, [XF + 3.6, sM.box[2] - 0.7, z], [8, t0 + 0.2, t0 + 0.3], [9, 0.08, 0.16], 26, null, "lm", true, `${nm}_film`);
    });
    dyn.push(T => {
      const ch = Math.floor(T), u = T - ch;
      for (const f of filmStrips) {
        const e = ch > 8 || ch === 0 || ch === NCH ? 1 : ch === 8 ? ease(seg(u, f.t0 + 0.26, f.t0 + 0.44)) : 0;
        if (Math.abs(e - f.last) < 0.01) continue; f.last = e;
        f.s.recolor(Float32Array.from(f.v0, (a, i) => (1 - e) * a + e * f.v1[i]));
      }
    });
    region("film", regions.g_film, regions.l_film, regions.c, ...fboxes, [trunk, trunk, 0, 0, ZR * 0.35, ZG]);

    // ---- 9. fusion
    const { XC } = L, zc = ZG / 2, bgf = regions.g_film, blf = regions.l_film;
    for (const p0 of [[bgf[1] + 0.1, 0, ZG], [blf[1] + 0.1, 0, 0], [trunk, 0, ZR]]) arrow(p0, [XC - 0.25, 0, zc], T_.muted, [9, 0.08, 0.22]);
    const sCat = strip(t.concat, XC, 0, zc, [9, 0.2, 0.36]);
    label(`[g' · ℓ' · c] (${t.concat.length})`, [XC, 0, sCat.box[4] - 0.3], [9, 0.2, 0.36], [10, 0, 0.1], 25);
    const bxs = [];
    [[`Linear ${t.concat.length}→${net.fusion_dim} · GELU`, XC + 2.4], ["Residual MLP × 2", XC + 5.0]].forEach(([txt, xa], q) => {
      const on = [9, 0.4 + 0.14 * q, 0.52 + 0.14 * q], geo = new THREE.BoxGeometry(1.5, 1.4, 3.2), g = new THREE.Group(), at = V(xa + 0.75, 0, zc);
      const b = new THREE.Mesh(geo, lit(T_.box)); b.position.copy(at); g.add(b);
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: T_.accent })); e.position.copy(at); g.add(e);
      add(g, on); label(txt, [xa + 0.75, 0, zc + 1.2], on, [10, 0, 0.1], 25, T_.accent); bxs.push([xa, xa + 1.5, -1.6, 1.6, zc - 0.7, zc + 0.7]);
    });
    for (const [xa, xb] of [[XC + 0.2, XC + 2.35], [XC + 3.95, XC + 4.95], [XC + 6.55, XC + 8.0]]) arrow([xa, 0, zc], [xb, 0, zc], T_.muted, [9, 0.4, 0.8]);
    const XH = XC + 8.3, sH = strip(t.h, XH, 0, zc, [9, 0.78, 0.92], null, null, "h");
    label(`h (${t.h.length})`, [XH, sH.box[2] - 0.25, zc], [9, 0.78, 0.92], [11, 0, 0.1], 28, null, "lm", true, "h");
    region("fusion", sCat.box, ...bxs, regions.h);

    // ---- 10. decoder
    const { XD, WD } = L, zd = zc, seqs = [t.seq0, ...t.ups], wBase = WD / Math.pow(2, net.n_up), dboxes = [];
    arrow([XH + 0.2, 0, zd], [XD - 0.25, 0, zd], T_.muted, [10, 0.03, 0.08]);
    seqs.forEach((A, q) => {
      const t0 = 0.06 + 0.06 * q, on = [10, t0, t0 + 0.05], xq = XD + 2.4 * q, wq = wBase * Math.pow(2, q), hq = 1.8;
      block(`dec${q}`, xq, wq, hq, 0.45, 5, on).position.copy(V(0, 0, zd));
      const r = regions[`dec${q}`]; regions[`dec${q}`] = [r[0], r[1], r[2], r[3], r[4] + zd, r[5] + zd]; parts[`dec${q}`] = [regions[`dec${q}`]];
      const l0 = signedLimit([A.data]), rgb = q === 0 ? colorize(A.data, SIGNED, -l0, l0, bg) : colorize(A.data, POSITIVE, percentile(A.data, 1), percentile(A.data, 99), bg);
      image(rgb, [A.rows, A.cols], xq - 0.004, 0, zd, wq, hq, on, null, false);
      label(`${A.rows} × ${A.cols}`, [xq + 0.2, -wq / 2 - 0.25, zd - hq / 2 - 0.3], on, [11, 0, 0.1], 25, null, "lm");
      if (q) arrow([xq - 1.9, 0, zd], [xq - 0.2, 0, zd], T_.muted, on, null, 0.03);
      dboxes.push(regions[`dec${q}`]);
    });
    const { XT } = L, out = t.out, tgt = N.ctx.fdmNorm, nT = out[0].length;
    const amp = 0.9 / Math.max(...[0, 1].map(c => Math.max(DSP.peakAbs(out[c]), DSP.peakAbs(tgt[c]))), 1e-9);
    const ty = d3.range(nT).map(i => WD / 2 - i / nT * WD), traces = [];
    [[zd + 1.3, "Vx"], [zd - 1.0, "Vz"]].forEach(([zt, nm], c) => {
      add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ty.map((y, i) => V(XT + 0.03, y, zt + amp * tgt[c][i]))), new THREE.LineBasicMaterial({ color: T_.trace })), [10, 0.44, 0.48]);
      const geo = new THREE.BufferGeometry().setFromPoints(ty.map((y, i) => V(XT, y, zt + amp * out[c][i])));
      add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: T_.accent })), [10, 0.46, 0.48]); traces.push(geo);
      label(nm, [XT, WD / 2 + 0.4, zt], [10, 0.44, 0.48], [11, 0, 0.1], 28, null, "rm", true);
    });
    dyn.push(T => { const ch = Math.floor(T), u = T - ch, e = ch > 10 || ch === NCH ? 1 : ch === 10 ? ease(seg(u, 0.47, 0.6)) : 0; const n = Math.max(2, Math.floor(e * nT)); traces.forEach(g => g.setDrawRange(0, n)); });
    const yb = WD / 2 - t.t_bound / fam.clock.dt_model / nT * WD;
    line([[XT - 0.01, yb, zd - 2.0], [XT - 0.01, yb, zd + 2.4]], T_.teal, [10, 0.46, 0.5]);
    label("t_b", [XT, yb, zd + 2.7], [10, 0.46, 0.5], [11, 0, 0.1], 25, T_.teal);
    arrow([dboxes[dboxes.length - 1][1] + 0.2, 0, zd], [XT - 0.25, 0, zd], T_.muted, [10, 0.4, 0.45]);
    label(`Conv1d head → 2 × ${nT} samples (${(nT * fam.clock.dt_model).toFixed(1)} s)`, [XT, WD / 2 - 0.3, zd - 2.4], [10, 0.4, 0.45], [11, 0, 0.1], 25, T_.accent, "lm");
    region("decoder_a", ...dboxes.slice(0, Math.max(1, dboxes.length - 2)));
    region("decoder_b", ...dboxes);
    region("decoder_c", ...dboxes, [XT, XT, -WD / 2, WD / 2, zd - 2.0, zd + 2.7]);

    // ---- 11. every receiver -> the shot gather
    const { XGt } = L, G = N.gather.net, Gt = N.gather.fdm, R = G.length, GW = 9.0, GH = 7.0, ZT = zd + 8.0, gboxes = [];
    [[GW / 2 + 2.0, "Vx"], [-GW / 2 - 2.0, "Vz"]].forEach(([yc, nm], c) => {
      const vmaxC = Math.max(...G.map(g => DSP.peakAbs(g[c])), ...Gt.map(g => DSP.peakAbs(g[c])), 1e-9), tz = d3.range(nT).map(i => ZT + GH / 2 - i / nT * GH), spc = GW / R;
      const gray = [], fg = [];                                       // one LineSegments per kind: 78 lines, two draw calls
      for (let r = 0; r < R; r++) {
        const y0 = yc + GW / 2 - (r + 0.5) * spc;
        for (let i = 1; i < nT; i++) {
          gray.push(V(XGt + 0.02, y0 + 1.6 * spc * Gt[r][c][i - 1] / vmaxC, tz[i - 1]), V(XGt + 0.02, y0 + 1.6 * spc * Gt[r][c][i] / vmaxC, tz[i]));
          if (r !== rx) fg.push(V(XGt, y0 + 1.6 * spc * G[r][c][i - 1] / vmaxC, tz[i - 1]), V(XGt, y0 + 1.6 * spc * G[r][c][i] / vmaxC, tz[i]));
        }
      }
      add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gray), new THREE.LineBasicMaterial({ color: T_.trace })), [11, 0, 0.08]);
      add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(fg), new THREE.LineBasicMaterial({ color: T_.fg })), [11, 0.06, 0.3]);
      const yr = yc + GW / 2 - (rx + 0.5) * spc;
      line(d3.range(nT).map(i => [XGt - 0.01, yr + 1.6 * spc * G[rx][c][i] / vmaxC, tz[i]]), T_.accent, [11, 0.06, 0.3]);
      add(rect(XGt + 0.05, yc, ZT, GW + 0.4, GH + 0.3, T_.rule), [11, 0, 0.08]);
      label(`${nm} · ${R} receivers`, [XGt, yc, ZT + GH / 2 + 0.7], [11, 0, 0.08], null, 28, null, "mm", true);
      gboxes.push([XGt, XGt, yc - GW / 2, yc + GW / 2, ZT - GH / 2, ZT + GH / 2 + 1.0]);
    });
    const mark = cone([0, 0, 0], 0.4, 0.2, T_.teal, [11, 0.05, 0.08], [11, 0.32, 0.36]);
    dyn.push(T => { const ch = Math.floor(T), u = T - ch, e = ch === 11 ? ease(seg(u, 0.06, 0.3)) : 1, r = Math.min(Math.floor(e * R), R - 1); mark.position.copy(V(XGt - 0.05, GW / 2 + 2.0 + GW / 2 - (r + 0.5) * GW / R, ZT + GH / 2 + 0.25)); });
    region("gather", ...gboxes);
    region("all", ...["medium", "encoder", "g", "src", "receiver", "film", "fusion", "decoder_c", "gather"].flatMap(n => parts[n]));

    N.keys = [[0.0, "solver", 1.3, 0.44, -38], [0.14, "solver", 1.04, 0.44, -38], [0.97, "solver", 1.04, 0.44, -38], [1.3, "medium_exploded", 1.1], [1.6, "medium_exploded", 1.1], [1.95, "medium", 1.25],
      [2.06, "stem_all", 1.08], [2.12, "stem_detail", 1.05], [2.42, "stem_detail", 1.05], [2.5, "stem_all", 1.08], [2.97, "stem_all", 1.08],
      [3.3, "encoder", 1.08], [3.97, "encoder", 1.08], [4.3, "global", 1.1], [4.97, "global", 1.1], [5.3, "sources", 1.1],
      [5.97, "sources", 1.1], [6.2, "query_wide", 1.34], [6.36, "query_wide", 1.34], [6.45, "query_path", 1.3],
      [6.62, "query_path", 1.3], [6.78, "query_right", 1.2], [6.97, "query_right", 1.2], [7.3, "receiver", 1.12],
      [7.97, "receiver", 1.12], [8.3, "film", 1.1], [8.97, "film", 1.1], [9.3, "fusion", 1.12], [9.97, "fusion", 1.12],
      [10.2, "decoder_a", 1.15], [10.36, "decoder_b", 1.1], [10.46, "decoder_c", 1.08], [10.97, "decoder_c", 1.08],
      [11.3, "gather", 1.12], [11.97, "gather", 1.12], [12.3, "all", 1.05], [13.0, "all", 1.05]];
    computeKeys();
    panels();
    draw();
  }

  // ---------------------------------------------------------------- the camera (fit, keys, sway)
  function viewDir(yaw) { const a = yaw * Math.PI / 180, [x, y, z] = DIR0; return [Math.cos(a) * x - Math.sin(a) * y, Math.sin(a) * x + Math.cos(a) * y, z]; }
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const n = Math.hypot(...a); return a.map(x => x / n); };
  function fit(name, margin = 1.12, shift = 0, yaw = 0) {
    const D = viewDir(yaw), boxes = name === "all" ? parts[name] : [regions[name]], corners = [];
    for (const b of boxes) for (const x of b.slice(0, 2)) for (const y of b.slice(2, 4)) for (const z of b.slice(4)) corners.push([x, y, z]);
    const up = norm([-D[2] * D[0], -D[2] * D[1], 1 - D[2] * D[2]]), right = cross(D.map(v => -v), up);
    const pr = corners.map(c => dot(c, right)), pu = corners.map(c => dot(c, up));
    const [top, bottom] = name === "all" ? [250, 50] : [130, 85], free = (1080 - top - bottom) / 1080;
    const w = N.stage.clientWidth - N.inset.left - N.inset.right, h = N.stage.clientHeight - N.inset.top - N.inset.bottom, aspect = Math.max(w, 1) / Math.max(h, 1);
    const half = Math.max((Math.max(...pu) - Math.min(...pu)) / 2 / free, (Math.max(...pr) - Math.min(...pr)) / 2 / aspect / (1 - shift)) * margin;
    const mean = corners.reduce((s, c) => [s[0] + c[0] / corners.length, s[1] + c[1] / corners.length, s[2] + c[2] / corners.length], [0, 0, 0]);
    const cR = (Math.max(...pr) + Math.min(...pr)) / 2 + shift * half * aspect, cU = (Math.max(...pu) + Math.min(...pu)) / 2, dm = dot(D, mean);
    return { center: [0, 1, 2].map(i => right[i] * cR + up[i] * cU + D[i] * dm + up[i] * (top - bottom) / 1080 * half), half, yaw };
  }
  function computeKeys() { if (N.keys && Object.keys(regions).length && N.stage && N.stage.clientWidth) camKeys = N.keys.map(k => ({ T: k[0], ...fit(k[1], k[2], k[3] || 0, k[4] || 0) })); }
  function keyAt(T) {
    let i = 0; while (i < camKeys.length - 2 && camKeys[i + 1].T <= T) i++;
    const a = camKeys[i], b = camKeys[i + 1], e = ease(seg(T, a.T, b.T));
    return { center: a.center.map((v, k) => (1 - e) * v + e * b.center[k]), half: Math.exp((1 - e) * Math.log(a.half) + e * Math.log(b.half)), yaw: (1 - e) * a.yaw + e * b.yaw };
  }
  function placeCamera(T) {
    const { center, half, yaw } = keyAt(T), D = viewDir(yaw + 3.0 * Math.sin(2 * Math.PI * T / 9.0));
    const W = N.stage.clientWidth, H = N.stage.clientHeight, ins = N.inset, freeH = Math.max(H - ins.top - ins.bottom, 1), full = half * H / freeH;
    camera.left = -full * W / H; camera.right = full * W / H; camera.top = full; camera.bottom = -full;
    camera.position.copy(V(center[0] + 200 * D[0], center[1] + 200 * D[1], center[2] + 200 * D[2]));
    camera.up.set(0, 1, 0); camera.lookAt(V(...center));
    camera.setViewOffset(W, H, (ins.right - ins.left) / 2, (ins.bottom - ins.top) / 2, W, H); camera.updateProjectionMatrix();
    sun.position.copy(camera.position).add(new THREE.Vector3(-40, 80, 30));
  }

  // ---------------------------------------------------------------- visibility (the film's visibility, focus and dimming)
  function visibility(T, on, off) {
    const ch = Math.floor(T), u = T - ch;
    if (!on) return 1;
    if (ch === NCH) return off ? 0 : ease(seg(u, 0, 0.4));
    let a = ch < on[0] ? 0 : ch === on[0] ? ease(seg(u, on[1], on[2])) : 1;
    if (off) a = ch > off[0] ? 0 : ch === off[0] ? a * (1 - ease(seg(u, off[1], off[2]))) : a;
    return a;
  }
  function focus(ch, on, tag) { if (!(ch in FOCUS) || !on || on[0] >= ch) return 1; const [kc, kt] = FOCUS[ch]; return kc.includes(on[0]) || kt.includes(tag) ? 1 : DIM; }
  function dimming(T, on, tag) { const ch = Math.floor(T), u = T - ch, prev = ch > 0 ? focus(ch - 1, on, tag) : 1; return prev + (focus(ch, on, tag) - prev) * ease(seg(u, 0, 0.15)); }

  // ---------------------------------------------------------------- one frame at time T
  function draw() {
    if (!renderer || !camKeys.length) return;
    const T = N.T;
    for (const f of dyn) f(T);
    for (const o of objs) {
      const a = visibility(T, o.on, o.off) * dimming(T, o.on, o.tag) * o.base;
      o.obj.visible = a > 0.01;
      for (const m of o.mats) { m.opacity = a; m.depthWrite = a > 0.95; }
    }
    placeCamera(T);
    renderer.render(scene, camera);
    const W = renderer.domElement.clientWidth, H = renderer.domElement.clientHeight, ins = N.inset, scale = Math.max(0.45, (H - ins.top - ins.bottom) / 1080);
    for (const l of labels) {
      const a = visibility(T, l.on, l.off) * dimming(T, l.on, l.tag);
      if (a <= 0.01) { if (l.el.style.display !== "none") l.el.style.display = "none"; continue; }
      const text = typeof l.text === "function" ? l.text(T) : l.text;
      if (text !== l.last) { l.el.innerHTML = sub(text); l.last = text; }
      const p = V(...l.pos(T)).project(camera), x = (p.x + 1) / 2 * W - ins.left, y = (1 - p.y) / 2 * H - ins.top;
      Object.assign(l.el.style, { display: "", opacity: a, color: l.color, fontSize: `${Math.max(9, l.size * scale * 0.9).toFixed(1)}px`, transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)` });
    }
    const ch = Math.floor(T);
    titleEl.textContent = CHAPTERS[ch][1]; captionEl.innerHTML = sub(caption(ch, T - ch));
    panelsAt(T);
  }

  // ---------------------------------------------------------------- the 2-D panels of chapters 0, 10 and 11
  let pSolver = null, pDecoder = null, pGather = null;
  function panels() {
    panel2d.innerHTML = "";
    const T_ = th(), fam = N.family, k = N.ctx.rx, dt = fam.clock.dt, nt = fam.clock.nt, name = fam.receivers.labels[k];
    const mk = cls => { const d = document.createElement("div"); d.className = `nw-p ${cls}`; panel2d.appendChild(d); return d; };
    pSolver = mk("solver");                                          // chapter 0: the FDM recording, growing with the clock
    const vel = [0, 1].map(c => DSP.cumulative(N.ctx.fdmAcc.subarray((k * 2 + c) * nt, (k * 2 + c + 1) * nt), dt));
    pSolver.innerHTML = `<h4 style="color:${T_.teal}">receiver ${name}: the FDM recording</h4>`;
    pSolver.chart = plot(pSolver, vel.map((v, c) => ({ name: c ? "Vz" : "Vx", series: [{ t: d3.range(nt).map(i => i * dt), y: v, color: T_.muted, width: 2 }] })), fam.clock.duration);
    pDecoder = mk("decoder");                                        // chapter 10: the prediction against the FDM, in m/s
    const s = fam.normalizer.sigma_v, out = t.out.map(v => Float32Array.from(v, x => x * s)), tgt = N.ctx.fdmNorm.map(v => Float32Array.from(v, x => x * s)), tt = d3.range(out[0].length).map(i => i * fam.clock.dt_model);
    const cor = [0, 1].map(c => DSP.pearson(out[c], tgt[c]));
    pDecoder.innerHTML = `<h4>receiver ${name}: the network (<span style="color:${T_.accent}">orange</span>) against the FDM solver (grey)</h4>`;
    plot(pDecoder, [0, 1].map(c => ({ name: c ? "Vz" : "Vx", series: [{ t: tt, y: tgt[c], color: T_.trace, width: 4 }, { t: tt, y: out[c], color: T_.accent, width: 2 }] })), tt[tt.length - 1] + tt[1], [t.t_bound, "t_b: earliest possible P arrival"]);
    pDecoder.insertAdjacentHTML("beforeend", `<p class="nw-p-foot" style="color:${T_.accent}">seed ${N.ctx.seed} · correlation with the FDM: Vx ${cor[0].toFixed(2)} · Vz ${cor[1].toFixed(2)}</p>`);
    N.corr = cor;
    pGather = mk("gather");                                          // chapter 11: FDM | network | difference
    gatherPanel(pGather);
  }
  function plot(parent, rows, tMax, mark) {
    const T_ = th(), svgW = 900, rh = 120, gap = 18, m = { l: 90, r: 16, t: 8, b: 40 }, H = m.t + rows.length * rh + (rows.length - 1) * gap + m.b;
    const svg = d3.select(parent).append("svg").attr("viewBox", `0 0 ${svgW} ${H}`).attr("class", "nw-plot");
    const x = d3.scaleLinear().domain([0, tMax]).range([m.l, svgW - m.r]), curves = [];
    rows.forEach((row, i) => {
      const top = m.t + i * (rh + gap), lim = 1.05 * Math.max(...row.series.map(s => DSP.peakAbs(s.y)), 1e-12), y = d3.scaleLinear().domain([-lim, lim]).range([top + rh, top]);
      svg.append("rect").attr("x", m.l).attr("y", top).attr("width", svgW - m.l - m.r).attr("height", rh).attr("fill", "none").attr("stroke", T_.rule);
      svg.append("line").attr("x1", m.l).attr("x2", svgW - m.r).attr("y1", top + rh / 2).attr("y2", top + rh / 2).attr("stroke", T_.rule);
      svg.append("text").attr("x", m.l - 12).attr("y", top + rh / 2 - 4).attr("text-anchor", "end").attr("fill", T_.fg).attr("font-weight", 700).attr("font-size", 20).text(row.name);
      svg.append("text").attr("x", m.l - 12).attr("y", top + rh / 2 + 16).attr("text-anchor", "end").attr("fill", T_.muted).attr("font-size", 12).text(`±${lim.toPrecision(2)} m/s`);
      for (const s of row.series) {
        const step = Math.max(1, Math.floor(s.y.length / 900)), pts = d3.range(0, s.y.length, step).map(j => [x(s.t[j]), y(s.y[j])]);
        curves.push({ path: svg.append("path").attr("d", d3.line()(pts)).attr("fill", "none").attr("stroke", s.color).attr("stroke-width", s.width), pts });
      }
    });
    const bottom = m.t + rows.length * rh + (rows.length - 1) * gap;
    const ax = svg.append("g").attr("transform", `translate(0,${bottom})`).call(d3.axisBottom(x).ticks(6));
    ax.selectAll("text").attr("fill", T_.muted).attr("font-size", 12); ax.selectAll("line,path").attr("stroke", T_.muted);
    svg.append("text").attr("x", svgW - m.r).attr("y", bottom + 34).attr("text-anchor", "end").attr("fill", T_.muted).attr("font-size", 13).text("time (s)");
    if (mark) { const xm = x(mark[0]); svg.append("line").attr("x1", xm).attr("x2", xm).attr("y1", m.t).attr("y2", bottom).attr("stroke", T_.teal).attr("stroke-width", 2); svg.append("text").attr("x", xm + 6).attr("y", m.t + 14).attr("fill", T_.teal).attr("font-size", 13).attr("font-weight", 700).text(mark[1]); }
    const now = svg.append("line").attr("y1", m.t).attr("y2", bottom).attr("stroke", T_.accent).attr("stroke-width", 2).attr("opacity", 0.6);
    return { x, curves, now };
  }
  function gatherPanel(el) {
    const T_ = th(), fam = N.family, G = N.gather.net, Gt = N.gather.fdm, R = G.length, nT = G[0][0].length, s = fam.normalizer.sigma_v;
    const cols = [["FDM solver", Gt], ["network", G], ["difference (same scale)", G.map((g, r) => g.map((v, c) => Float32Array.from(v, (x, i) => x - Gt[r][c][i])))]];
    const cor = [0, 1].map(c => d3.mean(d3.range(R), r => DSP.pearson(G[r][c], Gt[r][c])));
    el.innerHTML = `<h4>all ${R} receivers · across: receiver position, down: time</h4><div class="nw-gather-grid"></div>
      <p class="nw-p-foot" style="color:${T_.accent}">seed ${N.ctx.seed}, all ${R} receivers: correlation with the FDM Vx ${cor[0].toFixed(2)} · Vz ${cor[1].toFixed(2)}</p>`;
    const grid = el.querySelector(".nw-gather-grid");
    [0, 1].forEach(c => {
      const vals = []; for (const g of Gt) for (const v of g[c]) vals.push(Math.abs(v));
      const lim = percentile(vals, 99.5) || 1;
      grid.insertAdjacentHTML("beforeend", `<div class="nw-g-name">${c ? "Vz" : "Vx"}</div>`);
      cols.forEach(([title, data]) => {
        const cv = document.createElement("canvas"); cv.width = R; cv.height = nT;
        const ctx = cv.getContext("2d"), img = ctx.createImageData(R, nT), flat = new Float32Array(R * nT);
        for (let i = 0; i < nT; i++) for (let r = 0; r < R; r++) flat[i * R + r] = data[r][c][i];
        const rgb = colorize(flat, SIGNED, -lim, lim, T_.bg);
        for (let q = 0; q < R * nT; q++) { img.data[4 * q] = rgb[3 * q]; img.data[4 * q + 1] = rgb[3 * q + 1]; img.data[4 * q + 2] = rgb[3 * q + 2]; img.data[4 * q + 3] = 255; }
        ctx.putImageData(img, 0, 0);
        const fig = document.createElement("figure"); fig.className = "nw-g-fig";
        if (c === 0) fig.innerHTML = `<figcaption style="color:${title === "network" ? T_.accent : T_.fg}">${title}</figcaption>`;
        fig.appendChild(cv); grid.appendChild(fig);
      });
      grid.insertAdjacentHTML("beforeend", `<div class="nw-g-bar"><span>+${(lim * s).toFixed(2)}</span><i></i><span>−${(lim * s).toFixed(2)} m/s</span></div>`);
    });
  }
  function panelsAt(T) {
    if (!pSolver) return;
    const ch = Math.floor(T), u = T - ch;
    const aS = ch === 0 ? ease(seg(u, 0.12, 0.18)) : 0, aD = ch === 10 ? ease(seg(u, 0.62, 0.67)) : ch === 11 ? 1 - ease(seg(u, 0, 0.06)) : 0, aG = ch === 11 ? ease(seg(u, 0.4, 0.46)) : 0;
    for (const [p, a] of [[pSolver, aS], [pDecoder, aD], [pGather, aG]]) { p.style.opacity = a; p.style.visibility = a > 0.01 ? "visible" : "hidden"; }
    if (aS > 0.01 && N.simTime) {                                     // the recording draws up to the simulation clock
      const c = pSolver.chart, xn = c.x(N.simTime(T));
      for (const cur of c.curves) { const n = d3.bisector(p => p[0]).right(cur.pts, xn); cur.path.attr("d", n > 1 ? d3.line()(cur.pts.slice(0, n)) : null); }
      c.now.attr("x1", xn).attr("x2", xn);
    }
  }

  // ---------------------------------------------------------------- captions (the film's)
  function caption(k, u) {
    const fam = N.family, net = fam.network, ctx = N.ctx || {};
    const solver = `the FDM solver: ${fam.clock.nt.toLocaleString("en-US")} steps of ${(fam.clock.dt * 1000).toFixed(2)} ms · each receiver records Vx and Vz, the particle velocity`;
    return [
      u < 0.16 ? `one random layered medium (seed ${ctx.seed}), from the test split · Vp in greys` : u < 0.88 ? solver : "repeated for every medium of the family: these recordings are what the network learns to predict",
      "the input is the medium (Vp, Vs, ρ, solid mask, normalized as in training); the receiver enters in chapter 6, the rupture never changes",
      `Conv2d 4 → ${net.widths[0]}, ${net.stem_kernel}×${net.stem_kernel}, stride ${net.stem_stride}: every output cell is one window sum; then GroupNorm + GELU`,
      "each stage halves the map and widens the channels · darker orange = stronger activation",
      "mean and max of f16 over the solid cells → one vector for the whole medium · one cube per value: orange > 0, blue < 0",
      `the rupture is the same for every medium of the family: f16 read at ${net.source_points.length} of its points (hypocenter, centroid, ${net.source_points.length - 2} along the rupture) → src`,
      "features under the receiver on f4, f8 and f16  +  the path from the rupture centroid  +  src  →  ℓ",
      "where the receiver is (Fourier features), what kind of site, the earliest possible P arrival  →  c",
      "the medium summary g and the receiver's local reading ℓ, each rescaled and shifted by its own γ(c), β(c)",
      "[g' · ℓ' · c] → Linear → residual MLP blocks → h: everything the decoder knows about this medium and this receiver",
      u < 0.64 ? `${net.length0} → ${net.length0 * Math.pow(2, net.n_up)} samples; each block: ×2 upsample · clock [t/T, (t − t_b)/T] · 2 × Conv1d k7 · FiLM from h` : "the same two traces, unrolled in seconds: network (orange) over the FDM recording (grey)",
      `the encoder ran once for the medium; each of the ${fam.receivers.x.length} receivers is one cheap query: ${ctx.timing || "—"} for all of them ${Infer.live ? "in this browser" : "(measured offline)"}`,
      "the whole forward pass at a glance: one encoder pass for the medium, one cheap query per receiver",
    ][k];
  }

  // ---------------------------------------------------------------- the panel: what each chapter does, in depth, and its numbers
  // The prose follows the deck's section 05 (slides 47–59, the Jornadas copy); the numbers are read live from the tensors
  // this browser has just computed (Infer.probe), so they are this medium's and this receiver's, not a slide's.
  const dimsOf = name => (N.probe && N.probe[name] ? Array.from(N.probe[name].dims).slice(1) : null);
  const shapeOf = name => { const d = dimsOf(name); return d ? d.map(v => v.toLocaleString("en-US")).join(" × ") : "—"; };
  const sizeOf = name => { const d = dimsOf(name); return d ? d.reduce((a, b) => a * b, 1).toLocaleString("en-US") : "—"; };
  function spanOf(name) {
    const t = N.probe && N.probe[name]; if (!t) return "—";
    if (t.stats) return `${fmt(t.stats.lo)} … ${fmt(t.stats.hi)} · rms ${fmt(t.stats.rms)}`;   // precomputed: the whole tensor's
    let lo = Infinity, hi = -Infinity, s2 = 0; for (const v of t.data) { if (v < lo) lo = v; if (v > hi) hi = v; s2 += v * v; }
    return `${fmt(lo)} … ${fmt(hi)} · rms ${fmt(Math.sqrt(s2 / t.data.length))}`;
  }
  const tile = (v, l) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`;
  function explain(k) {
    const fam = N.family, net = fam.network, c = fam.clock, nr = fam.receivers.x.length, ctx = N.ctx || {}, rf = net.receptive_fields, dx = fam.grid.dx;
    const km = cells => `${(cells * dx / 1000).toFixed(2)} km`;
    const E = [
      [`<p>The network never sees the wavefield. What it learns from is what the 39 receivers on the surface record: the
         particle velocity V<sub>x</sub>, V<sub>z</sub>, for 1,000 media run through this same solver. Before training each record is
         <b>decimated ×8</b>: a zero-phase Kaiser filter first removes everything above 49.8 Hz (the band 0–20 Hz passes
         untouched), then one sample in 8 is kept. That is the network's clock.</p>`,
       [[`${c.nt.toLocaleString("en-US")} → ${c.nt_model}`, "samples, solver → network"], [`${(c.dt * 1000).toFixed(3)} → ${(c.dt_model * 1000).toFixed(2)} ms`, "time step"],
        [`${nr} × 2 × ${c.nt_model}`, `numbers per medium (${(nr * 2 * c.nt_model).toLocaleString("en-US")})`], [`${c.duration.toFixed(2)} s`, "of shaking per record"]]],
      [`<p>The medium enters as a <b>tensor</b>, a stack of four maps on the ${fam.grid.nz} × ${fam.grid.nx} grid: V<sub>p</sub>, V<sub>s</sub>
         and ρ, each normalized with the mean μ and standard deviation σ of the solid cells of the 799 training media, and
         the <b>solid mask</b>. The air above the terrain is set to 0, the mean: on its own that would read as an average rock,
         so the fourth channel tells the network where the ground is. The maps are padded to 432 × 288 by copying the last
         row and column, because zeros would create a false impedance contrast at the border.</p>`,
       [[`4 × ${fam.grid.nz} × ${fam.grid.nx}`, "channels × rows × columns"],
        [`${(4 * fam.grid.nz * fam.grid.nx).toLocaleString("en-US")}`, "numbers in"],
        [`${Math.round(fam.normalizer.mean[0]).toLocaleString("en-US")} ± ${Math.round(fam.normalizer.std[0])} m/s`, "V<sub>p</sub>: μ ± σ of training"],
        [`${Math.round(fam.normalizer.mean[1]).toLocaleString("en-US")} ± ${Math.round(fam.normalizer.std[1])} m/s`, "V<sub>s</sub>: μ ± σ of training"]]],
      [`<p>The <b>stem</b> is the first convolution: ${net.widths[0]} learned ${net.stem_kernel}×${net.stem_kernel} kernels, each a weighted sum over a
         ${net.stem_kernel}×${net.stem_kernel} window of the four input maps, plus a bias, taken every other cell (stride ${net.stem_stride}, so
         the map halves). <b>GroupNorm</b> then rescales groups of channels to a common size and <b>GELU</b>, a smooth ramp, keeps
         the positive part. Each output cell sees ${rf.stem} cells of the medium, ${Math.round(rf.stem * dx)} m: enough for an interface, not
         yet for a layer.</p>`,
       [[shapeOf("stem"), "channels × map (on the padded grid)"], [`${(4 * net.widths[0] * net.stem_kernel ** 2 + net.widths[0]).toLocaleString("en-US")}`, "weights + biases of the convolution"],
        [`${Math.round(rf.stem * dx)} m`, "what one cell sees"], [spanOf("stem"), "activation range, here"]]],
      [`<p>Three more stages, each a pair of residual convolution blocks that <b>halves the map and doubles the channels</b>.
         Their outputs are named by how much they shrink the grid: <b>f4</b>, <b>f8</b>, <b>f16</b>. A deeper map is coarser but each of
         its cells summarizes a wider piece of the medium, from a few hundred metres to most of the section. All three are
         kept: the receiver reads them later. The encoder holds 3.15 M parameters, 26 % of the network, 84 % of them in
         the last stage, and it runs <b>once per medium</b>.</p>`,
       [[shapeOf("f4"), `f4 · sees ${km(rf.f4)}`], [shapeOf("f8"), `f8 · sees ${km(rf.f8)}`], [shapeOf("f16"), `f16 · sees ${km(rf.f16)}`],
        [`${N.probe ? N.probe.encoder_ms.toFixed(0) : "—"} ms`, Infer.live ? "encoder, this browser" : "encoder (measured offline)"]]],
      [`<p><b>g</b> is one vector for the whole medium: the mean and the maximum of every f16 channel over the solid cells only,
         side by side. It says how stiff and how contrasted the medium is, but not where anything is: position comes back
         through the receiver's own readings.</p>`,
       [[shapeOf("pooled"), "[mean | max] of f16"], [`${net.latent_dim}`, "numbers in g"], [spanOf("pooled"), "range, this medium"]]],
      [`<p>The rupture is the same in every sample, so it is <b>never an input</b>. What changes is the medium around it, and
         that is what the network reads: f16 at six fixed points of the rupture, the hypocentre, the force-weighted centroid
         and the four subsources where the cumulative force share reaches 12.5, 37.5, 62.5 and 87.5 %. Each reading
         summarizes about 3 km. The six vectors, side by side, go through Linear → GELU → LayerNorm into <b>src</b>. The
         consequence: the trained network is an operator for this rupture only, as a fixed load case in a structure.</p>`,
       [[shapeOf("src_in"), "f16 at the 6 points, flattened"], [`${net.source_dim}`, "numbers in src"], [spanOf("src_in"), "range of the readings"]]],
      [`<p>Now the receiver. Its <b>local</b> reading is f4, f8 and f16 right under it (64 + 128 + 256 = 448 numbers, from 420 m to
         3 km around it). The <b>path</b> is what the wave crosses: f16 sampled at ${net.path_points} points on the straight line from the
         rupture centroid to the receiver, projected 256 → 64, convolved along the path (two Conv1d, kernel 3: a short filter of three samples slid along it) and flattened
         in order, so the network knows whether a feature sits near the source or near the receiver. [local | path | src] →
         <b>ℓ</b>. Limitation: a straight line, while real rays bend with depth and surface waves travel along the surface.</p>`,
       [[shapeOf("path_proj"), "path: points × channels"], [shapeOf("l_in"), "[local 448 | path 256 | src 768]"], [shapeOf("l"), "ℓ"], [spanOf("l"), "ℓ, range"]]],
      [`<p><b>c</b> says where the receiver is and what kind of site it is, in 75 numbers. Its two coordinates become 66 numbers of
         <b>Fourier features</b> (sines and cosines of 16 frequencies on each axis, plus the coordinates): a smooth network learns
         slow variations easily and fast ones badly, and given the sines it only has to combine them. Eight <b>static
         features</b> describe the site, and <b>t<sub>b</sub></b> is the earliest possible P arrival from any subsource (a straight-ray bound
         with the medium's fastest V<sub>p</sub>), used three times: as an input, as a clock and in the loss. A small MLP, 43,520
         parameters, turns the 75 into c.</p>`,
       [[shapeOf("query_in"), "numbers per receiver"], [shapeOf("fourier"), "Fourier features"], [shapeOf("c"), "c"], [spanOf("c"), "c, range"]]],
      [`<p><b>FiLM</b> (feature-wise linear modulation): c produces a scale γ and a shift β for every number of g and of ℓ,
         g′ = γ<sub>g</sub>(c) ⊙ g + β<sub>g</sub>(c), and the same for ℓ. The medium's summary is the same for all 39 receivers; FiLM makes
         each receiver read it differently. Here γ and β are this receiver's. In plain words: where the receiver stands turns
         each of the medium's dials up or down.</p>`,
       [[shapeOf("film_g"), "[γ | β] for g"], [shapeOf("film_l"), "[γ | β] for ℓ"], [spanOf("g_mod"), "g′, range"], [spanOf("l_mod"), "ℓ′, range"]]],
      [`<p>The <b>fusion</b> puts g′ (512), ℓ′ (512) and c (256) side by side, 1,280 numbers, then a Linear layer 1,280 → 768 and two
         residual MLP blocks give <b>h</b>: everything the decoder knows about this medium and this receiver. c also goes in
         unmodulated, so the receiver's information reaches the fusion even while the FiLMs are still near the identity. With
         3.35 M parameters it is the largest block of the network. There is no attention: receiver and medium meet only
         through sampling at fixed points and FiLM.</p>`,
       [[shapeOf("h"), "numbers in h"], ["3.35 M", "parameters of the fusion"], [spanOf("h"), "h, range"]]],
      [`<p>The <b>temporal decoder</b> unfolds h into time. A Linear layer (1.87 M parameters, the second largest) turns h into a
         short sequence of ${net.length0} steps × ${net.decoder_channels} channels; ${net.n_up} blocks each double its length (×2 upsample, a clock
         [t/T, (t − t<sub>b</sub>)/T], two Conv1d with kernel 7 and a FiLM from h), ${net.length0} → ${net.length0 * 2 ** net.n_up}, cut to ${c.nt_model}. The last
         layer gives V<sub>x</sub> and V<sub>z</sub> on the network's clock; the page then upsamples them to the solver's clock and
         differentiates them into acceleration, as the repository's own pipeline does.</p>`,
       [[`${net.length0} × ${net.decoder_channels}`, `first sequence (${sizeOf("seq")} numbers from h)`], [shapeOf("up3"), "after the 4 blocks"], [N.corr ? `${fmt(N.corr[0])} / ${fmt(N.corr[1])}` : "—", "correlation V<sub>x</sub> / V<sub>z</sub> with the FDM, here"],
        [`${N.probe ? N.probe.decoder_ms.toFixed(0) : "—"} ms`, "decoder, one receiver"]]],
      [`<p>The encoder ran once for the medium; each receiver is one cheap pass of the decoder. That is why the network is
         asked as a <b>query</b>: one dense output of 39 × 2 × 598 numbers would have cost 35.9 M weights, three times the whole
         network, and as a query the same weights learn from all 31,161 training traces, not 799 per receiver. Below, all
         39 records of this medium: FDM, network, and their difference.</p>`,
       [[ctx.timing || "—", `all ${nr} receivers, ${Infer.live ? "this browser" : "measured offline"}`], [`${nr}`, "decoder queries, one encoder pass"], ["31,161", "training traces (799 media × 39)"]]],
      [`<p>The whole forward pass: <b>${(fam.n_parameters / 1e6).toFixed(2)} M parameters</b>, 38 % of them read the medium (once per medium) and
         62 % work per receiver. On the validation media the median correlation with the FDM is
         ${fmt(fam.val_metrics.median_corr_vx)} in V<sub>x</sub> and ${fmt(fam.val_metrics.median_corr_vz)} in V<sub>z</sub>. One simulation of the solver takes about two minutes on a
         CPU; the network answers for every receiver in a fraction of a second, also on a CPU${Infer.live ? ", here in your browser" : ""}.</p>`,
       [[`${(fam.n_parameters / 1e6).toFixed(2)} M`, "parameters"], [`${fmt(fam.val_metrics.median_corr_vx)} / ${fmt(fam.val_metrics.median_corr_vz)}`, "median correlation V<sub>x</sub> / V<sub>z</sub>, validation"],
        [ctx.timing || "—", Infer.live ? "all receivers, this browser" : "all receivers (measured offline)"]]],
    ];
    return E[k];
  }
  function renderExplain(k) {
    const box = $("#nw-explain"), stats = $("#nw-metrics");
    if (!box || !N.family) return;
    const key = `${k}:${N.key}:${!!N.probe}:${N.ctx && N.ctx.timing}:${N.corr ? 1 : 0}`;
    if (key === N.explained) return;
    N.explained = key;
    const [html, items] = explain(k);
    box.innerHTML = html; stats.innerHTML = items.map(([v, l]) => tile(v, l)).join("");
  }

  // ---------------------------------------------------------------- inputs from app.js, and the play bar
  function chooseChannels() {                                       // the channel with the most structure, as the film picks
    const pick = tt => { if (tt.channel != null) return tt.channel;    // precomputed: export_precomputed.py chose it the same way
      const [, C, H, W] = tt.dims; let best = 0, bv = -1; for (let c = 0; c < C; c++) { let s = 0, s2 = 0; const off = c * H * W; for (let i = 0; i < H * W; i++) { const v = tt.data[off + i]; s += v; s2 += v * v; } const v = s2 / (H * W) - (s / (H * W)) ** 2; if (v > bv) { bv = v; best = c; } } return best; };
    N.ch = { stem: pick(N.probe.stem), f4: pick(N.probe.f4), f8: pick(N.probe.f8), f16: pick(N.probe.f16) };
  }
  async function setContext(ctx) {                                   // {seed, input, query, rx, fdmAcc, wave}
    N.ctx = { ...(N.ctx || {}), ...ctx };
    const key = `${ctx.seed}:${ctx.rx}`;
    if (key === N.key && N.probe) return;
    N.key = key; N.probe = null; if (titleEl) titleEl.textContent = "Running the network…";
    const probe = await Infer.probe(ctx.seed, ctx.input, ctx.query, ctx.rx);
    if (N.key !== key) return;
    N.probe = probe; N.ctx.fdmNorm = fdmNormalized(ctx.fdmAcc, ctx.rx);
    chooseChannels();
    if (N.gather && N.gather.seed === ctx.seed) build();
    renderExplain(Math.floor(N.T));                                   // the panel's numbers are this receiver's now
  }
  function setGather(seed, velocity, fdmAcc, timing) {               // all 39 records of the medium, on the network's clock
    const fam = N.family, n = fam.receivers.x.length, T = fam.clock.nt_model;
    N.gather = { seed, net: d3.range(n).map(k => [0, 1].map(c => velocity.subarray((k * 2 + c) * T, (k * 2 + c + 1) * T))), fdm: d3.range(n).map(k => fdmNormalized(fdmAcc, k)) };
    if (N.ctx) N.ctx.timing = timing;
    if (N.probe && N.ctx.seed === seed) build();
    renderExplain(Math.floor(N.T));
  }
  function onTime(seconds) {
    let k = NCH; while (k > 0 && seconds < START[k]) k--;
    N.T = Math.min(NCH + 0.999, k + Math.min(0.999, (seconds - START[k]) / CHAPTERS[k][2]));
    document.querySelectorAll("#nw-steps [data-k]").forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.k) === k)));
    const title = $("#nw-title"); if (title) title.textContent = CHAPTERS[k][1];
    renderExplain(k);
    draw();
  }
  function init(family) {
    N.family = family;
    $("#nw-steps").innerHTML = CHAPTERS.map((c, k) => `<button type="button" class="chip small" data-k="${k}" title="${c[1]}">${k === NCH ? "∑" : k}</button>`).join("");
    $("#nw-steps").addEventListener("click", e => { const b = e.target.closest("[data-k]"); if (b) Timeline.seek(START[Number(b.dataset.k)] + 0.01); });
  }

  window.Network = {
    init, attach, setInset, setTheme, setContext, setGather, onTime, show: k => Timeline.seek(START[k] + 0.01), seekT: T => { const k = Math.floor(T); Timeline.seek(START[k] + (T - k) * CHAPTERS[k][2]); },
    CHAPTERS, TOTAL, get chapter() { return Math.floor(N.T); }, get T() { return N.T; }, get probe() { return N.probe; }, get gatherSeed() { return N.gather && N.gather.seed; },
    get built() { return camKeys.length > 0 && !!N.probe; }, get objects() { return objs.length; }, get corr() { return N.corr; },
    labelsShown: () => labels.filter(l => l.el.style.display !== "none").length,
    reset() { N.key = null; N.gather = null; camKeys = []; },
  };
})();
