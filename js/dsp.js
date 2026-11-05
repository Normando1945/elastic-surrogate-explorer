// Surrogate Explorer · dsp.js — the post-processing of ElasticSurrogateInference.predict, in the browser.
//
// The network returns normalized velocity on the model clock (598 samples, dt_model = 8 dt). predict() turns it into
// what an engineer reads; this file does the same, in float64, step for step:
//   1. velocity [m/s] = sigma_v * upsample_x8(normalized)       ElasticNormalizer.inverse_velocity + ElasticTraceResampler.upsample
//      upsample = scipy.signal.resample_poly(x, 8, 1, window=("kaiser", 8)) cut to nt, which with zero padding is the
//      convolution y[m] = sum_k x[k] h[m - 8k + 80] with the 161 taps exported in family.json (export_family.py
//      checks that identity against scipy to 1e-16);
//   2. acceleration = np.gradient(velocity, dt, edge_order=2)     ElasticWavePhysics.gradient_edge2
//   3. Sa(T) = peak |a_g + a_rel| of a 5 % damped oscillator     ElasticSpectra.response_spectrum (Newmark, gamma = 1/2)
//      per period, divided by g.
// web/tests/test_dsp_parity.py checks all three against Python.
(function () {
  "use strict";

  function upsample(x, offset, length, fir, nt, scale) {
    // x[offset .. offset+length) on the model clock -> Float64Array(nt) on the solver clock, times `scale`
    const h = fir.taps, q = fir.factor, half = fir.half_len, y = new Float64Array(nt);
    for (let m = 0; m < nt; m++) {
      const kLo = Math.max(0, Math.ceil((m - half) / q)), kHi = Math.min(length - 1, Math.floor((m + half) / q));
      let s = 0;
      for (let k = kLo; k <= kHi; k++) s += x[offset + k] * h[m - q * k + half];
      y[m] = s * scale;
    }
    return y;
  }

  function gradient(y, dt) {
    // np.gradient(y, dt, edge_order=2) on a uniform clock
    const n = y.length, d = new Float64Array(n), two = 2 * dt;
    d[0] = (-3 * y[0] + 4 * y[1] - y[2]) / two;
    for (let i = 1; i < n - 1; i++) d[i] = (y[i + 1] - y[i - 1]) / two;
    d[n - 1] = (3 * y[n - 1] - 4 * y[n - 2] + y[n - 3]) / two;
    return d;
  }

  function responseSpectrum(acc, dt, periods, damping) {
    // ElasticSpectra.response_spectrum, one trace: same recurrence, same start (x = v = 0, a = -acc[0], peak = 0)
    const out = new Float64Array(periods.length), n = acc.length;
    for (let p = 0; p < periods.length; p++) {
      const w = 2 * Math.PI / periods[p], k = w * w, c = 2 * damping * w, inv = 1 / (1 + 0.5 * c * dt), half = 0.5 * dt * dt;
      let x = 0, v = 0, a = -acc[0], peak = 0;
      for (let i = 1; i < n; i++) {
        const g = acc[i];
        x = x + dt * v + half * a;
        const a1 = inv * (-g - k * x - c * (v + dt * 0.5 * a));
        v = v + dt * (0.5 * a + 0.5 * a1);
        a = a1;
        const total = Math.abs(g + a1);
        if (total > peak) peak = total;
      }
      out[p] = peak;
    }
    return out;
  }

  function peakAbs(y) { let m = 0; for (let i = 0; i < y.length; i++) { const v = Math.abs(y[i]); if (v > m) m = v; } return m; }

  function pearson(a, b) {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
    return sab / Math.max(Math.sqrt(saa * sbb), 1e-30);
  }

  // One receiver q of the decoder output velocity [Q, 2, T] (normalized): velocity, acceleration, PGA and Sa per component.
  function receiver(velocity, q, family) {
    const T = family.clock.nt_model, nt = family.clock.nt, dt = family.clock.dt, g = family.spectra.g;
    const out = { velocity: [], acceleration: [], pga_g: [], sa_g: [] };
    for (let c = 0; c < 2; c++) {
      const v = upsample(velocity, (q * 2 + c) * T, T, family.fir, nt, family.normalizer.sigma_v);
      const a = gradient(v, dt);
      const sa = responseSpectrum(a, dt, family.spectra.periods, family.spectra.damping);
      for (let p = 0; p < sa.length; p++) sa[p] /= g;
      out.velocity.push(v); out.acceleration.push(a); out.pga_g.push(peakAbs(a) / g); out.sa_g.push(sa);
    }
    return out;
  }

  // ---------------------------------------------------------------- the intensity measures (web/tools/intensity.py, line for line)
  // every integral is the cumulative trapezoid from zero; D5–95 interpolates the crossings of the cumulative a²
  function cumulative(y, dt) {
    const n = y.length, out = new Float64Array(n);
    for (let i = 1; i < n; i++) out[i] = out[i - 1] + 0.5 * dt * (y[i] + y[i - 1]);
    return out;
  }
  function crossing(cum, level, dt) {
    let i = 0; while (i < cum.length && cum[i] < level) i++;           // np.searchsorted(cum, level, side="left")
    if (i <= 0) return 0;
    if (i >= cum.length) return (cum.length - 1) * dt;
    const lo = cum[i - 1], hi = cum[i];
    return (i - 1 + (level - lo) / (hi > lo ? hi - lo : 1)) * dt;
  }
  // a [m/s²] -> { v, d, and the period-free measures }; Sa and Sd come from atPeriod (they change with the slider)
  function measures(acc, dt, g) {
    const a = Float64Array.from(acc), v = cumulative(a, dt), d = cumulative(v, dt), sq = new Float64Array(a.length), ab = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) { sq[i] = a[i] * a[i]; ab[i] = Math.abs(a[i]); }
    const a2 = cumulative(sq, dt), total = a2[a2.length - 1];
    return { a, v, d, PGA: peakAbs(a) / g, PGV: peakAbs(v), PGD: peakAbs(d), Arias: Math.PI / (2 * g) * total, CAV: cumulative(ab, dt)[a.length - 1],
             D5_95: total > 0 ? crossing(a2, 0.95 * total, dt) - crossing(a2, 0.05 * total, dt) : 0 };
  }
  function atPeriod(acc, dt, T, g, damping) {
    const sa = responseSpectrum(acc, dt, [T], damping)[0] / g;
    return { Sa: sa, Sd: sa * g * Math.pow(T / (2 * Math.PI), 2) * 100 };
  }

  window.DSP = { upsample, gradient, responseSpectrum, peakAbs, pearson, receiver, cumulative, measures, atPeriod };
})();
