// Surrogate Explorer · wave.js — the solver's wavefield on the front face, drawn as the 4.6 film draws it.
//
// ElasticForwardPassAnimator, chapter 0: v = snapshot / clip (98.5th percentile of |v| over the solid), clipped to ±1;
// the SIGNED palette over the medium's own colours with alpha |v|^0.45; the face lifted out of its plane by tanh(v) and
// shaded by that relief. The snapshots come from web/tools/export_wavefield.py: int8 of v, decimated x2 in space, so a
// cell of the full grid reads the snapshot cell (row >> 1, column >> 1).
(function () {
  "use strict";
  const SIGNED = ["#3B4B7A", "#9AA3BF", "#F4F4F5", "#F2B27A", "#C25A0B"];   // surrogate/ElasticConvolutionScanAnimator.SIGNED
  const ALPHA_GAMMA = 0.45, SHADE_GAIN = 0.55;
  let lut = null;

  function signedLut() {
    if (lut) return lut;
    const ramp = d3.piecewise(d3.interpolateRgb, SIGNED);                 // matplotlib's LinearSegmentedColormap: piecewise linear
    lut = new Uint8Array(255 * 3);                                        // index = q + 127, q in [-127, 127]
    for (let k = 0; k < 255; k++) { const c = d3.rgb(ramp(k / 254)); lut[k * 3] = c.r; lut[k * 3 + 1] = c.g; lut[k * 3 + 2] = c.b; }
    return lut;
  }

  async function load(entry, component) {
    const response = await fetch(entry.files[component]);
    if (!response.ok) throw new Error(`${entry.files[component]}: HTTP ${response.status}`);
    const buffer = await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    const [frames, rows, cols] = entry.shape;
    return { q: new Int8Array(buffer), frames, rows, cols, times: entry.times, decimate: entry.decimate };
  }

  function frameAt(wave, t) {                                             // last snapshot at or before t
    const times = wave.times;
    let lo = 0, hi = times.length - 1;
    if (t <= times[0]) return 0;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (times[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo;
  }

  // base: Uint8Array RGBA of the medium per cell ((nz-1) x (nx-1)); mask: Float32Array nz*nx; out.rgba same layout as base;
  // out.lift: Float32Array nz*nx, the out-of-plane offset of every node [m] (relief metres per unit tanh)
  function compose(wave, frame, base, mask, nx, nz, relief, out) {
    const table = signedLut(), q = wave.q, d = wave.decimate, rows = wave.rows, cols = wave.cols, off = frame * rows * cols;
    const rgba = out.rgba || (out.rgba = new Uint8Array(base.length)), lift = out.lift || (out.lift = new Float32Array(nx * nz));
    const tanhLut = out.tanhLut || (out.tanhLut = Float32Array.from({ length: 255 }, (_, k) => Math.tanh((k - 127) / 127)));
    const sample = (iz, ix) => q[off + Math.min(iz / d | 0, rows - 1) * cols + Math.min(ix / d | 0, cols - 1)];
    for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      lift[i] = mask[i] > 0.5 ? relief * tanhLut[sample(iz, ix) + 127] : 0;
    }
    for (let iz = 0; iz < nz - 1; iz++) for (let ix = 0; ix < nx - 1; ix++) {
      const p = (iz * (nx - 1) + ix) * 4, node = iz * nx + ix;
      if (mask[node] < 0.5) { rgba[p] = base[p]; rgba[p + 1] = base[p + 1]; rgba[p + 2] = base[p + 2]; rgba[p + 3] = 255; continue; }
      const v = sample(iz, ix), a = Math.pow(Math.abs(v) / 127, ALPHA_GAMMA), k = (v + 127) * 3;
      // relief shading: the slope of the lifted face along the section, lit from the left as in the film
      const slope = (lift[node + 1] - lift[node]) / Math.max(relief, 1e-9) + 0.5 * (lift[node + nx] - lift[node]) / Math.max(relief, 1e-9);
      const shade = Math.min(1.35, Math.max(0.65, 1 + SHADE_GAIN * slope));
      rgba[p] = Math.min(255, ((1 - a) * base[p] + a * table[k]) * shade);
      rgba[p + 1] = Math.min(255, ((1 - a) * base[p + 1] + a * table[k + 1]) * shade);
      rgba[p + 2] = Math.min(255, ((1 - a) * base[p + 2] + a * table[k + 2]) * shade);
      rgba[p + 3] = 255;
    }
    return out;
  }

  window.Wave = { load, frameAt, compose, SIGNED };
})();
