// Surrogate Explorer · app-chapters.js — network, finale, CPML and statistics chapters.
// Split from app.js; this remains a classic script so the public builder can version every file independently.
"use strict";

  async function diveFromEarth() {
    app.labelHold = true; app.siteSeen = true;
    app.site.setExaggeration(1.5); syncExag();
    const landing = app.earth.fromSite(app.site.pose("approach"), app.site.lensHalf);
    await (app.flight = app.earth.flyTo(landing, 3800));
    if (!(Story.chapter && Story.chapter.id === "quito") || Story.onCover) { app.labelHold = false; return; }
    document.body.classList.add("quick-fade");
    // the ground lands flat, as the globe showed it, and rises at once (ease-out: most of the height in the first second),
    // walls and all: they stretch with the relief every frame, so nothing pops when it ends
    app.site.setShow(LIFT_LAYERS); app.site.setOpacity(app.userOpacity);
    app.site.flyTo("approach", 0); app.site.previewExaggeration(0.03);
    setStage("site");
    setTimeout(() => document.body.classList.remove("quick-fade"), 450);
    await new Promise(r => setTimeout(r, 360));                        // hold the matched frame through the 0.35 s cross-fade
    if (!(Story.chapter && Story.chapter.id === "quito") || Story.onCover) { app.labelHold = false; return; }
    const rise = app.site.animateExaggeration(1.5, 2600, "out").then(() => { app.site.setShow(ALL_LAYERS); syncExag(); markTools(); });
    app.flight = app.site.flyTo("region", 2800);
    await Promise.all([rise, app.flight]);
    app.labelHold = false;
    if (Story.chapter && Story.chapter.id === "quito") autoOrbit();
  }

  // ---------------------------------------------------------------- the network chapter (network.js draws it)
  async function enterNetwork() {
    Network.attach($("#net-stage")); Network.setTheme(app.theme);
    if (!app.networkInit) { app.networkInit = true; Network.init(app.family); }
    Network.reset();
    Timeline.use({ duration: Network.TOTAL, label: "the forward pass", speeds: [0.5, 1, 2], speed: 1, onTime: Network.onTime });
    updateInset();
    Timeline.seek(0.01);
    await networkContext();
    if (!(Story.chapter && Story.chapter.id === "network")) return;
    const m = app.medium, net = await networkFor(m);
    Network.setGather(m.seed, net.velocity, m.fdm.acc, `${(net.encoder_ms + net.decoder_ms).toFixed(0)} ms (encoder ${net.encoder_ms.toFixed(0)} ms, decoder ${net.decoder_ms.toFixed(0)} ms)`);
    Timeline.autoplay(() => Story.chapter && Story.chapter.id === "network" && !Story.onCover, 800);
  }
  async function networkContext() {
    await app.networkReady;
    const m = app.medium, f = app.family;
    $("#nw-seed").textContent = m.seed; $("#nw-rx").textContent = f.receivers.labels[app.rx];
    $("#nw-prev").disabled = app.rx === 0; $("#nw-next").disabled = app.rx === f.receivers.x.length - 1;
    const wave = app.waveIndex && app.waveIndex.media.some(e => e.seed === m.seed) ? (await waveFor(m.seed, "vz")).data : null;   // chapter 0 plays it
    await Network.setContext({ seed: m.seed, input: m.input, query: m.query, rx: app.rx, fdmAcc: m.fdm.acc, wave });
  }

  // ---------------------------------------------------------------- the statistics chapter (stats.js draws it)
  function receiverGeometry() {                                       // along segment 3, R_hyp and elevation of each receiver
    const f = app.family, s = app.siteData, seg = s.segment, m = s.model, [hx, hy] = m.hypocentre_xy_km;
    const out = { along: [], rhyp: [], elev: [] };
    f.receivers.x.forEach((col, k) => {
      const d = col * f.grid.dx / 1000, x = seg.xy_km[0][0] + seg.along[0] * d, y = seg.xy_km[0][1] + seg.along[1] * d;
      const z = app.site.receiverElevation(k), repi = Math.hypot(x - hx, y - hy);
      out.along.push(d); out.elev.push(z); out.rhyp.push(Math.hypot(repi, (z - m.hypocentre_z_m) / 1000));
    });
    return out;
  }
  // ---------------------------------------------------------------- the finale: the result in place
  const FINALE_CORR = [0.5, 1.0];                                     // the colour scale of the correlation, fixed (not stretched to the data)
  const finaleColour = v => d3.interpolateViridis(Math.min(1, Math.max(0, (v - FINALE_CORR[0]) / (FINALE_CORR[1] - FINALE_CORR[0]))));
  async function enterFinale() {
    if (app.testset === undefined) app.testset = await fetch("data/stats/testset.json").then(r => (r.ok ? r.json() : null)).catch(() => null);
    paintFinale();
    if (app.medium && !app.medium.net) { await networkFor(app.medium).catch(() => null); if (Story.chapter && Story.chapter.id === "credits") paintFinale(); }
  }
  function paintFinale() {
    const t = app.testset, c = app.finaleComp || "x";
    document.querySelectorAll("[data-finale-comp]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.finaleComp === c)));
    if (!t || !t.along) { app.site.setResults(null); $("#finale-stats").innerHTML = ""; return; }
    const a = t.along, pga = a.pga_fdm_g[c], corr = a.waveform_corr[c], top = Math.max(...a.pga_fdm_g.x, ...a.pga_fdm_g.z);
    if (Story.chapter && Story.chapter.id === "credits") app.site.setResults({ height_km: pga.map(v => 2.6 * v / top), color: corr.map(finaleColour) });
    const P = t.ims.PGA[c], w = t.waveform_corr[c], run = app.waveIndex && app.waveIndex.media && app.waveIndex.media[0];
    // like for like (review 6): the simulation and the network both on a CPU; the GPU figure apart, and said so
    const net = app.medium && app.medium.net, cpu = net ? net.encoder_ms + net.decoder_ms : null, gpu = t.timing && t.timing.device !== "cpu";
    const speed = run && cpu ? [[`${Math.round(run.run_seconds)} s → ${Math.round(cpu)} ms`,
      `one simulation (Python) → one forward pass for all 39 receivers (${Infer.live ? "this browser" : "onnxruntime, one thread"}), both on a CPU`]] : [];
    if (run && t.timing && gpu) speed.push([`${Math.round(t.timing.predict_s_median * 1000)} ms`, "the same forward pass on a GPU (PyTorch, offline)"]);
    stats("#finale-stats", [[w.p50.toFixed(2), `median correlation of the network's ${c} records with the simulation's, ${t.media} test media`],
      [`×${P.bias.toFixed(2)}`, `typical factor of the network's PGA<sub>${c}</sub> (σ<sub>ln</sub> ${P.sigma.toFixed(2)})`],
      [`${(100 * P.within2).toFixed(2)} %`, `of ${P.n.toLocaleString("en")} PGA<sub>${c}</sub> values within a factor of 2`], ...speed]);
    $("#finale-pga").textContent = `${Math.min(...pga).toFixed(2)}–${Math.max(...pga).toFixed(2)} g`;
    $("#finale-ramp").style.background = `linear-gradient(90deg, ${d3.range(0, 1.0001, 0.125).map(u => finaleColour(FINALE_CORR[0] + u * (FINALE_CORR[1] - FINALE_CORR[0]))).join(", ")})`;
  }

  // ---------------------------------------------------------------- the absorbing boundary (cpml.js, data/cpml/)
  async function enterCpml() {
    status("Loading the three films of the absorbing boundary…", null);
    const ok = await CPML.show().finally(() => status(null));
    $("#cpml-missing").hidden = !!ok;
    if (!ok || !Story.chapter || Story.chapter.id !== "cpml") return;
    const m = CPML.metrics;
    $("#cp-seed").textContent = m.seed;
    Timeline.use({ duration: m.times[m.times.length - 1], label: "simulated time", speeds: [0.25, 0.5, 1], speed: 0.5, onTime: t => CPML.draw(t) });
    updateInset();
    CPML.draw(0);
    Timeline.autoplay(() => Story.chapter && Story.chapter.id === "cpml", 500);
  }

  async function enterStats() {
    const seeds = [...app.index.media].map(m => m.seed).sort((a, b) => a - b);
    if (!app.statsInit) {
      app.statsInit = true;
      const test = await fetch("data/stats/testset.json").then(r => (r.ok ? r.json() : null)).catch(() => null);
      Stats.init({ family: app.family, geo: receiverGeometry(), test, media: seeds,
                   onPick: (seed, k) => pickStats(seed, k), onMedium: seed => pickStats(seed, app.rx) });
    }
    // the network on all six media (each once: infer.js keeps the velocity), then their records
    for (const [j, seed] of seeds.entries()) {
      if (Stats.has(seed)) continue;
      const m = await mediumData(seed);
      status(`Running the network on the six test media · ${j + 1} of ${seeds.length}…`, j / seeds.length);
      await new Promise(r => setTimeout(r, 0));
      const net = await networkFor(m), cache = new Map(), f = app.family, nt = f.clock.nt, np = f.spectra.periods.length;
      Stats.addMedium(seed, (k, c) => {
        if (!cache.has(k)) cache.set(k, DSP.receiver(net.velocity, k, f));
        const r = cache.get(k);
        return { netAcc: Float32Array.from(r.acceleration[c]), netSa: r.sa_g[c], fdmAcc: m.fdm.acc.subarray((k * 2 + c) * nt, (k * 2 + c + 1) * nt),
                 fdmSa: m.fdm.sa.subarray((k * 2 + c) * np, (k * 2 + c + 1) * np) };
      });
    }
    status(null);
    if (Story.chapter && Story.chapter.id === "stats") Stats.select(app.seed, app.rx);
  }
  function pickStats(seed, k) {                                       // a point, a chip or ‹ ›: that medium (repainted) and receiver
    k = Math.max(0, Math.min(app.family.receivers.x.length - 1, k));
    const then = () => selectReceiver(k);
    if (seed !== app.seed) loadMedium(seed).then(then).catch(fail); else then();
  }

  // ---------------------------------------------------------------- chapters
  const chapters = [
    { id: "earth", title: "Quito, on the globe",
      // the whole Earth, Quito facing us: from the cover the camera pulls back from the horizon to the disc, turning
      enter() { setStage("earth"); app.flight = app.earth.flyTo("far", 3000); autoOrbit(); } },
    { id: "quito", title: "Quito and its faults",
      enter() {
        const fromEarth = app.stage === "earth";
        setSection(false);
        app.site.setShow(ALL_LAYERS);
        app.site.setOpacity(app.userOpacity); markTools(); markPalette();
        if (fromEarth) { diveFromEarth().catch(fail); return; }       // the globe dives into the relief
        setStage("site");
        if (!app.siteSeen) { app.site.setExaggeration(1.5); app.site.flyTo("approach", 0); }
        app.siteSeen = true; syncExag();
        app.flight = app.site.flyTo("region", 2400);                    // the whole district, turning slowly (Orbit on here)
        autoOrbit();
      },
      leave() {
        // Coordinate searches and their SARA-distance links are a Quito-map interaction, not part of the A–B model.
        // Drop that transient state before the cut/other chapters take over the same WebGL scene.
        app.site.clearLocation();
        hideCard(); app.site.clearHalo(); setOrbitButton(false); app.labelHold = false;
      } },
    { id: "quake", title: "One earthquake, one plane", dwell: 16000,
      // (the former "Section A–B and segment 3" lives here now: its profiles in the panel, its ×1.5 -> ×1 on the way in)
      enter() {
        setStage("site"); setSection(true); app.site.setOpacity(0.35); markTools();
        if (Math.abs(app.site.exaggeration - 1) > 1e-6) app.site.animateExaggeration(1, 1600).then(syncExag);   // the true height: the plane the wave lives in
        Timeline.use({ duration: 6, label: "simulated time", onTime: () => {} }); updateInset();   // reserve the bar before framing
        app.flight = app.site.flyTo("quake", 2400);
        requestAnimationFrame(drawProfiles);
        enterQuake().catch(fail);
      },
      leave() { leaveQuake(); hideCard(); app.site.setOpacity(app.userOpacity); markTools(); } },
    { id: "medium", title: "The medium: one of 1,000", enter() { setStage("block"); app.scene.setSelected(-1); app.layer = -1; applyMediumView(); },
      leave() { if (app.layer >= 0) showLayer(-1); app.scene.setStrata(null); placeCallout(); } },
    { id: "source", title: "The source: a kinematic rupture",
      enter() {
        setStage("block"); wholeDepth(); app.scene.setSelected(-1); app.scene.setSourceView(true); app.scene.setSourceFx(true);
        describeSource(); requestAnimationFrame(drawSourceCharts);
        const plan = rupturePlan();                                     // the bar runs until the last copy of the Ricker has gone by
        Timeline.use({ duration: Math.round((plan.end + 2 * app.family.source.t0 + 0.1) * 10) / 10, label: "rupture time", speeds: [0.25, 0.5, 1], speed: 0.5, onTime: sourceTime });
        Timeline.autoplay(() => Story.chapter && Story.chapter.id === "source", 600);
      },
      leave() { Timeline.release(); app.scene.setRuptureTime(null); app.scene.setSourceFx(false); app.scene.setSourceView(false); $("#front-label").hidden = true; } },
    { id: "solver", title: "The solver: one simulation, the whole wavefield", dwell: 16000,
      enter() { setStage("block"); wholeDepth(); app.scene.setSelected(app.rx); app.scene.setSourceView(true); enterSolver().catch(fail); },
      leave: () => leaveSolver() },
    { id: "cpml", title: "The edges that are not there: CPML", dwell: 16000,
      enter() { setStage("cpml"); enterCpml().catch(fail); },
      leave() { Timeline.release(); } },
    { id: "network", title: "The network, step by step", dwell: 30000,
      enter() { setStage("net"); enterNetwork().catch(fail); },
      leave() { Timeline.release(); } },
    { id: "receiver", title: "One receiver: network against simulation", wide: true,
      enter() {
        setStage("block");
        app.scene.setSelected(app.rx);
        networkFor(app.medium).then(() => showReceiver(app.rx)).catch(fail);
      } },
    { id: "stats", title: "The records, by the numbers", wide: true,
      enter() { setStage("block"); app.scene.setSelected(app.rx); enterStats().catch(fail); } },
    { id: "credits", title: "The result, in place · credits",
      // review 5 (Abell): the relief alone looked lonely; the finale puts Quito, its faults and the result together. Each
      // receiver of segment 3 becomes a column: height, the simulation's median PGA; colour, the network's correlation
      enter() {
        setStage("site"); setSection(false); hideCard(); app.site.setOpacity(1);
        app.site.setShow({ ...ALL_LAYERS, receivers: false, planes: false, footprint: false });
        app.flight = app.site.flyTo("finale", 2400); autoOrbit();
        // three seconds on the columns, then the camera pulls back to the whole district, still turning (unless the
        // visitor has taken the camera or left)
        const flight = app.flight;
        flight.then(() => {
          clearTimeout(app.finaleTimer);
          app.finaleTimer = setTimeout(() => {
            if (app.flight === flight && Story.chapter && Story.chapter.id === "credits" && !Story.onCover && orbitWanted()) app.flight = app.site.glideTo("region", 5000);
          }, 3000);
        });
        enterFinale().catch(fail);
      },
      leave() { clearTimeout(app.finaleTimer); app.site.setResults(null); setOrbitButton(false); app.site.setShow(ALL_LAYERS); app.site.setOpacity(app.userOpacity); markTools(); } },
  ];
  function syncExag() { const v = app.site.exaggeration; $("#exag").value = v.toFixed(1); $("#exag-out").textContent = `×${v.toFixed(1)}`; }

  // ---------------------------------------------------------------- the map's data: mesh (int16 heights) and the two baked images
