// Surrogate Explorer · infer.js — the network in the browser (onnxruntime-web, WASM, one thread).
//
// The encoder runs once per medium; the query decoder then runs once for all 39 trained receivers (decision D1),
// about half a second in all, and the result is kept per medium. A click afterwards only pays for dsp.js.
// The models are the graphs web/tools/export_models.py writes (rewritten so WASM matches native onnxruntime).
//
// Two modes, one interface (load, run, probe):
//   * live: the network itself runs here (local copies of the page, with web/app/models/);
//   * precomputed: decision D2, the public page carries no model. run and probe read what export_precomputed.py had
//     the same graphs compute (data/net/), and onnxruntime is never loaded. build_public.py sets this mode; locally,
//     index.html?mode=precomputed#… tries it.
(function () {
  "use strict";
  const MODE = (window.EXPLORER_MODE || new URLSearchParams(location.search).get("mode")) === "precomputed" ? "precomputed" : "live";
  if (MODE === "live") {
    ort.env.wasm.numThreads = 1;                        // Threads need COOP/COEP, which GitHub Pages does not send
    ort.env.wasm.wasmPaths = new URL("vendor/ort/", location.href).href;
  }

  let family = null, sessions = null;
  const velocityBySeed = new Map();

  async function fetchWithProgress(url, onBytes) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    // content-length is only a progress hint: a server that compresses (GitHub Pages does) reports the compressed size
    const hint = Number(response.headers.get("content-length")) || 0;
    if (!response.body) { const buffer = new Uint8Array(await response.arrayBuffer()); onBytes(buffer.length, buffer.length); return buffer; }
    const reader = response.body.getReader(), chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); received += value.length; onBytes(received, Math.max(hint, received));
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    onBytes(received, received);
    return bytes;
  }

  async function fetchFloats(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const body = url.endsWith(".gz") ? new Response(response.body.pipeThrough(new DecompressionStream("gzip"))) : response;
    return new Float32Array(await body.arrayBuffer());
  }

  // ---------------------------------------------------------------- precomputed (export_precomputed.py)
  const pre = { index: null, manifests: new Map(), encoders: new Map() };
  async function gzBuffer(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  }
  // one array of a pack: float32 as stored, uint8/uint16 back to floats over their own range
  function unpack(buffer, e) {
    let data;
    if (e.dtype === "f32") data = new Float32Array(buffer.slice(e.offset, e.offset + 4 * e.count));
    else {
      const top = e.dtype === "u8" ? 255 : 65535, q = e.dtype === "u8" ? new Uint8Array(buffer, e.offset, e.count) : new Uint16Array(buffer, e.offset, e.count);
      const span = (e.hi - e.lo) / top; data = Float32Array.from(q, v => e.lo + v * span);
    }
    return { data, dims: e.dims, stats: e.stats, channel: e.channel };
  }
  function manifest(seed) {
    if (!pre.manifests.has(seed)) pre.manifests.set(seed, fetch(`data/net/${seed}.json`).then(r => { if (!r.ok) throw new Error(`data/net/${seed}.json: HTTP ${r.status}`); return r.json(); }));
    return pre.manifests.get(seed);
  }

  async function load(familyData, onProgress) {
    family = familyData;
    if (MODE === "precomputed") {
      if (!pre.index) pre.index = await fetch("data/net/index.json").then(r => { if (!r.ok) throw new Error("data/net/index.json: the precomputed answers are missing (python web/tools/export_precomputed.py)"); return r.json(); });
      if (onProgress) onProgress(1, 1);
      return { precomputed: true };
    }
    if (sessions) return sessions;
    const names = ["encoder", "decoder"], got = { encoder: 0, decoder: 0 }, totals = { encoder: 0, decoder: 0 };
    const report = () => onProgress && onProgress(got.encoder + got.decoder, totals.encoder + totals.decoder);
    const bytes = await Promise.all(names.map(name => fetchWithProgress(family.models[name], (n, total) => {
      got[name] = n; totals[name] = total; report();
    })));
    const options = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
    const encoder = await ort.InferenceSession.create(bytes[0], options);
    const decoder = await ort.InferenceSession.create(bytes[1], options);
    sessions = { encoder, decoder };
    return sessions;
  }

  function queryFeeds(table, n) {
    const names = family.inputs.query_names, widths = family.inputs.query_widths;
    const stride = widths.reduce((a, b) => a + b, 0), feeds = {};
    let offset = 0;
    names.forEach((name, k) => {
      const w = widths[k], data = new Float32Array(n * w);
      for (let q = 0; q < n; q++) for (let j = 0; j < w; j++) data[q * w + j] = table[q * stride + offset + j];
      feeds[name] = new ort.Tensor("float32", data, w === 1 ? [n] : [n, w]);
      offset += w;
    });
    return feeds;
  }

  // velocity [39, 2, 598] (normalized) of one medium; `medium` is the encoder input (Float32Array 4 x nz x nx)
  async function run(seed, medium, queryTable) {
    if (velocityBySeed.has(seed)) return velocityBySeed.get(seed);
    if (MODE === "precomputed") {
      const m = await manifest(seed), v = unpack(await gzBuffer(`data/net/${seed}.vel.bin.gz`), m.velocity);
      const result = { velocity: v.data, dims: v.dims, encoder_ms: m.timing.encoder_ms, decoder_ms: m.timing.decoder_ms, precomputed: true };
      velocityBySeed.set(seed, result);
      return result;
    }
    const n = queryTable.length / family.inputs.query_widths.reduce((a, b) => a + b, 0);
    const t0 = performance.now();
    // only the outputs this needs: the graphs also carry the network chapter's probes (export_models.py)
    const encoding = await sessions.encoder.run({ medium: new ort.Tensor("float32", medium, family.inputs.medium) }, family.encoding_names);
    const t1 = performance.now();
    const feeds = queryFeeds(queryTable, n);
    for (const name of family.encoding_names) feeds[name] = encoding[name];
    const out = (await sessions.decoder.run(feeds, [family.output]))[family.output];
    const result = { velocity: out.data, dims: out.dims, encoder_ms: t1 - t0, decoder_ms: performance.now() - t1 };
    velocityBySeed.set(seed, result);
    return result;
  }

  // the network chapter: every probe of the encoder for this medium, and of the decoder for ONE receiver (row q of the
  // query table), with the velocity; tensors as {data, dims}. The encoder's probe is kept per medium.
  const probeBySeed = new Map();
  async function probe(seed, medium, queryTable, q) {
    if (MODE === "precomputed") {                       // the encoder's maps carry only the channel the film draws
      const m = await manifest(seed);
      if (!pre.encoders.has(seed)) { pre.encoders.clear(); pre.encoders.set(seed, gzBuffer(`data/net/${seed}.enc.bin.gz`)); }
      const [encBuf, decBuf] = await Promise.all([pre.encoders.get(seed), gzBuffer(`data/net/${seed}/rx${q}.bin.gz`)]);
      const result = { encoder_ms: m.timing.encoder_ms, decoder_ms: m.timing.decoder_one_ms, precomputed: true };
      for (const [name, e] of Object.entries(m.encoder)) result[name] = unpack(encBuf, e);
      for (const [name, e] of Object.entries(m.decoder[q])) result[name] = unpack(decBuf, e);
      return result;
    }
    const enc = sessions.encoder.outputNames, dec = sessions.decoder.outputNames;
    if (!probeBySeed.has(seed)) {
      const t0 = performance.now();
      const out = await sessions.encoder.run({ medium: new ort.Tensor("float32", medium, family.inputs.medium) }, enc);
      probeBySeed.clear();                                            // one medium at a time: the maps are large
      probeBySeed.set(seed, { out, ms: performance.now() - t0 });
    }
    const { out: encoding, ms } = probeBySeed.get(seed), stride = family.inputs.query_widths.reduce((a, b) => a + b, 0);
    const feeds = queryFeeds(queryTable.subarray(q * stride, (q + 1) * stride), 1);
    for (const name of family.encoding_names) feeds[name] = encoding[name];
    const t1 = performance.now(), decoded = await sessions.decoder.run(feeds, dec);
    const pick = t => ({ data: t.data, dims: t.dims });
    const result = { encoder_ms: ms, decoder_ms: performance.now() - t1 };
    for (const name of enc) result[name.replace("probe_", "")] = pick(encoding[name]);
    for (const name of dec) result[name.replace("probe_", "")] = pick(decoded[name]);
    return result;
  }

  window.Infer = { load, run, probe, fetchFloats, cached: seed => velocityBySeed.get(seed), mode: MODE, live: MODE === "live",
                   get measuredOn() { return pre.index ? pre.index.measured_on : null; } };
})();
