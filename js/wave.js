// Surrogate Explorer · wave.js — the solver's wavefield on the front face, drawn as the 4.6 film draws it.
//
// ElasticForwardPassAnimator, chapter 0: v = snapshot / clip (98.5th percentile of |v| over the solid), clipped to ±1;
// the SIGNED palette over the medium's own colours with alpha |v|^0.45; the face lifted out of its plane by tanh(v) and
// shaded by that relief. The snapshots come from web/tools/export_wavefield.py: int8 of v, decimated x2 in space, so a
// cell of the full grid reads the snapshot cell (row >> 1, column >> 1).
(function () {
  "use strict";
  const SIGNED = ["#3B4B7A", "#9AA3BF", "#F4F4F5", "#F2B27A", "#C25A0B"];   // surrogate/ElasticConvolutionScanAnimator.SIGNED
  const ALPHA_GAMMA = 0.45, ALPHA_FLOOR = 0.06, SHADE_GAIN = 0.55, SHADE_FLOOR = 0.04, SHADE_FULL = 0.22;   // |v| / clip: no relief below, all of it above
  let lut = null;

  // The colour the wave blends toward. The film's SIGNED palette has a white middle: over a coloured medium, a weak wave
  // (alpha |v|^0.45 is already ~0.3 at 8 % of the clip) washed the rock toward white, and every zero crossing of the
  // coda, left unwashed, drew a dark line, so the late field read as contour lines all over the face. Here each sign
  // runs from its own light tint to its deep end (SIGNED's outer stops), so a crossing is a change of hue, not a line.
  function signedLut() {
    if (lut) return lut;
    const neg = d3.interpolateRgb(SIGNED[1], SIGNED[0]), pos = d3.interpolateRgb(SIGNED[3], SIGNED[4]);
    lut = new Uint8Array(255 * 3);                                        // index = q + 127, q in [-127, 127]
    for (let k = 0; k < 255; k++) {
      const q = k - 127, c = d3.rgb(q < 0 ? neg(-q / 127) : pos(q / 127));
      lut[k * 3] = c.r; lut[k * 3 + 1] = c.g; lut[k * 3 + 2] = c.b;
    }
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
  // Two things keep the film's look and drop two artefacts of the int8, x2 snapshots: v is interpolated (bilinear) between
  // the snapshot's samples instead of read nearest, so the face has no 2x2 blocks; and the relief's shading is weighted by
  // the wave's own amplitude (SHADE_FLOOR..SHADE_FULL of the clip), so where the wave is weak the quantisation's one-level
  // steps no longer draw contour lines over the whole face. The colour (alpha |v|^0.45) is untouched: the weak coda shows.
  function compose(wave, frame, base, mask, nx, nz, relief, out) {
    const table = signedLut(), q = wave.q, d = wave.decimate, rows = wave.rows, cols = wave.cols, off = frame * rows * cols;
    const rgba = out.rgba || (out.rgba = new Uint8Array(base.length)), lift = out.lift || (out.lift = new Float32Array(nx * nz));
    const vals = out.vals || (out.vals = new Float32Array(nx * nz));
    const at = (r, c) => q[off + Math.min(r, rows - 1) * cols + Math.min(c, cols - 1)];
    for (let iz = 0; iz < nz; iz++) {
      const fr = Math.min(iz / d, rows - 1), r0 = fr | 0, wr = fr - r0;
      for (let ix = 0; ix < nx; ix++) {
        const i = iz * nx + ix;
        if (mask[i] < 0.5) { vals[i] = 0; lift[i] = 0; continue; }
        const fc = Math.min(ix / d, cols - 1), c0 = fc | 0, wc = fc - c0;
        const v = (at(r0, c0) * (1 - wc) + at(r0, c0 + 1) * wc) * (1 - wr) + (at(r0 + 1, c0) * (1 - wc) + at(r0 + 1, c0 + 1) * wc) * wr;
        vals[i] = v; lift[i] = relief * Math.tanh(v / 127);
      }
    }
    const inv = 1 / Math.max(relief, 1e-9);
    for (let iz = 0; iz < nz - 1; iz++) for (let ix = 0; ix < nx - 1; ix++) {
      const p = (iz * (nx - 1) + ix) * 4, node = iz * nx + ix;
      if (mask[node] < 0.5) { rgba[p] = base[p]; rgba[p + 1] = base[p + 1]; rgba[p + 2] = base[p + 2]; rgba[p + 3] = 255; continue; }
      // alpha |v|^0.45, eased to zero under ALPHA_FLOOR of the clip: the faintest coda no longer tints the whole face
      const v = vals[node], m = Math.abs(v) / 127, e = Math.min(1, m / ALPHA_FLOOR), a = Math.pow(m, ALPHA_GAMMA) * e * e * (3 - 2 * e), k = (Math.round(v) + 127) * 3;
      // relief shading: the slope of the lifted face along the section, lit from the left as in the film, where the wave is
      const slope = (lift[node + 1] - lift[node]) * inv + 0.5 * (lift[node + nx] - lift[node]) * inv;
      const u = Math.min(1, Math.max(0, (m - SHADE_FLOOR) / (SHADE_FULL - SHADE_FLOOR))), w = u * u * (3 - 2 * u);
      const shade = Math.min(1.35, Math.max(0.65, 1 + SHADE_GAIN * slope * w));
      rgba[p] = Math.min(255, ((1 - a) * base[p] + a * table[k]) * shade);
      rgba[p + 1] = Math.min(255, ((1 - a) * base[p + 1] + a * table[k + 1]) * shade);
      rgba[p + 2] = Math.min(255, ((1 - a) * base[p + 2] + a * table[k + 2]) * shade);
      rgba[p + 3] = 255;
    }
    return out;
  }

  // the legends: each sign from its light tint to its deep end, meeting at zero (where the face shows the rock itself)
  const LEGEND = `linear-gradient(to right, ${SIGNED[0]}, ${SIGNED[1]} 49.6%, ${SIGNED[3]} 50.4%, ${SIGNED[4]})`;
  window.Wave = { load, frameAt, compose, SIGNED, LEGEND };
})();
