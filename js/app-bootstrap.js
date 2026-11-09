// Surrogate Explorer · app-bootstrap.js — startup, DOM wiring and public control surface.
// Split from app.js; this remains a classic script so the public builder can version every file independently.
"use strict";

  async function loadMesh(site) {
    const response = await fetch(site.mesh.file);
    const buffer = await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    const rows = site.mesh.rows, cols = site.mesh.cols, nz = rows * cols * 2;
    return { rows, cols, z: new Int16Array(buffer.slice(0, nz)), x: new Float32Array(buffer.slice(nz, nz + cols * 4)),
             y: new Float32Array(buffer.slice(nz + cols * 4, nz + cols * 4 + rows * 4)), pixelRows: site.mesh.pixel_rows, pixelCols: site.mesh.pixel_cols };
  }
  function loadImages(site) {
    const one = src => new Promise((resolve, reject) => { const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error(`${src} did not load`)); im.src = src; });
    return Promise.all([one(site.dem.hillshade), one(site.dem.elevation), one(site.dem.curvature)])
      .then(([hillshade, elevation, curvature]) => ({ hillshade, elevation, curvature }));
  }

  // ---------------------------------------------------------------- start
  function webglAvailable() {
    try { const c = document.createElement("canvas"); return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl"))); }
    catch (e) { return false; }
  }
  async function start() {
    const initial = Story.init(chapters, {
      // the cover: the grazing look across the Andes, the horizon level, turning slowly (Orbit)
      cover: on => { updateInset(); if (on && app.earth) { setStage("earth"); app.flight = app.earth.flyTo("cover", 0); } applyOrbit(); },
      fold: folded => setTimeout(() => { updateInset(); if (!folded) redrawPanel(); }, 0),
      change: () => { $("#dock").hidden = true; $("#tools-btn").setAttribute("aria-expanded", "false"); requestAnimationFrame(() => { updateInset(); placeFloats(); }); },   // the play bar comes and goes with the chapter; the dock belongs to the map you left
      orbit: toggleOrbit,
      params: p => applyParams(p),
      escape: () => { if (!$("#qr").hidden) { $("#qr").hidden = true; return true; } if (!$("#card").hidden) { hideCard(); return true; } if (!$("#dock").hidden) { $("#dock").hidden = true; placeFloats(); return true; } return false; },
    });
    const p = initial.params;
    if (!Infer.live) document.querySelectorAll("[data-pre]").forEach(e => { e.innerHTML = e.dataset.pre; });   // D2: the public page says what it does
    applyTheme(p.get("theme") || storedTheme() || "dark", !p.get("theme"));
    if (p.get("field") && FIELDS[p.get("field")]) app.field = p.get("field");
    if (p.get("depth")) app.depth = Number(p.get("depth"));
    if (p.get("rx")) app.rx = Math.max(0, Number(p.get("rx")) - 1);
    if (!webglAvailable()) {                                           // review 6: say what is missing, not "something went wrong"
      $("#cover-start").textContent = "WebGL needed";
      $("#cover-load").innerHTML = "This page draws its scenes with <b>WebGL</b>, and this browser has it turned off or unavailable. " +
        "Turn on hardware acceleration (in Chrome: Settings → System) or open the page in another browser.";
      $("#cover-load").classList.add("warn");
      return;
    }

    const [family, index, siteData] = await Promise.all([fetch("data/family.json").then(r => r.json()), fetch("data/media/index.json").then(r => r.json()),
                                                          fetch("data/site/site.json").then(r => r.json())]);
    siteData.family = family;
    app.family = family; app.index = index; app.siteData = siteData;
    const [mesh, images] = await Promise.all([loadMesh(siteData), loadImages(siteData)]);
    app.waveIndex = await fetch("data/wave/index.json").then(r => (r.ok ? r.json() : null)).catch(() => null);
    $("#wave-chips").innerHTML = app.waveIndex ? app.waveIndex.media.map(m => `<button type="button" class="chip" data-seed="${m.seed}">Seed ${m.seed}</button>`).join("")
                                               : `<span class="note">No replay exported (python web/tools/export_wavefield.py).</span>`;
    $("#wave-ramp").style.background = `linear-gradient(to right, ${Wave.SIGNED.join(", ")})`;
    $("#segment").textContent = `${family.terrain.city} · section segment ${family.terrain.segment_number} · ` +
      `${(family.terrain.segment_length_m / 1000).toFixed(1)} × ${((family.grid.nz - 1) * family.grid.dz / 1000).toFixed(1)} km`;
    $("#cover-figures").textContent = `1,000 layered media · ${family.receivers.x.length} receivers · ` +
      `${(family.n_parameters / 1e6).toFixed(1)} M parameters · ${Infer.live ? "runs in your browser" : "the network's own predictions"}`;
    $("#credits-model").textContent = `${family.model_class}, ${(family.n_parameters / 1e6).toFixed(1)} M parameters, epoch ${family.epoch}, ` +
      `trained on ${family.split_counts.train} media of ${family.h5_name}. ${Infer.live ? "In this page it runs on your machine (onnxruntime-web, WASM)." : "In this public page its predictions for the six test media were computed beforehand with onnxruntime; the trained weights are not published."}`;
    $("#medium-chips").innerHTML = [...index.media].sort((a, b) => a.seed - b.seed).map(m => `<button type="button" class="chip" data-seed="${m.seed}" title="${m.layer_count} layers · Vs contrast ${m.vs_contrast.toFixed(2)}">Seed ${m.seed}</button>`).join("");
    $("#depth-chips").innerHTML = DEPTHS.map(d => `<button type="button" class="chip" data-depth="${d.m}">${d.label}</button>`).join("");
    markDepth();

    app.scene = SectionScene.create($("#scene"), family, themeTokens());
    app.scene.onPick = (k, direct) => {
      const id = Story.chapter && Story.chapter.id;
      if (direct || id === "receiver" || id === "solver") selectReceiver(k);
    };
    app.scene.onFrame = onFrame;
    app.scene.onLayerPick = k => showLayer(k === app.layer ? -1 : k);   // the layers apart: a solid, or beside them to let go
    app.scene.onFacePick = cell => {                                   // the medium chapter: a click on the face is a layer
      if (!(Story.chapter && Story.chapter.id === "medium")) return false;
      const k = layerMap(app.medium)[cell.iz * family.grid.nx + cell.ix];
      showLayer(k === app.layer ? -1 : k);                             // the same layer again lets it go
      return true;
    };
    app.scene.onHover = (k, at) => {
      const tip = $("#hover");
      if (k < 0 || (k === app.rx && Story.chapter && Story.chapter.id === "receiver")) { tip.hidden = true; return; }
      tip.hidden = false; tip.textContent = `${family.receivers.labels[k]} · ${(family.receivers.x[k] * family.grid.dx / 1000).toFixed(2)} km`;
      tip.style.transform = `translate(${at.x + 12}px, ${at.y - 12}px)`;
    };
    if (isFinite(app.depth)) app.scene.setFloor(app.depth);
    app.earth = Earth.create($("#earth-stage"), siteData);
    app.earth.onSun = markSun; markSun();
    app.earth.paint().catch(fail);                                     // NASA's imagery, a few MB, behind the cover
    app.site = Site.create($("#site-stage"), siteData, mesh, images);
    app.earth.setPatch(patchCanvas(images), siteData.dem.x_range_km, siteData.dem.y_range_km);
    app.site.setTheme(app.theme);
    if (p.get("palette") && Site.PALETTES.includes(p.get("palette"))) app.site.setPalette(p.get("palette"));
    app.site.onFrame = onSiteFrame;
    app.site.onPick = hit => cardFor(hit);
    app.site.onHover = (hit, at) => {
      const tip = $("#hover");
      if (!hit || !at) { tip.hidden = true; return; }
      const f = app.family, [hx, hy] = siteData.model.hypocentre_xy_km;
      if (hit.kind === "receiver") { const q = app.site.receiverXY(hit.k); tip.textContent = `${f.receivers.labels[hit.k]} · ${Math.hypot(q[0] - hx, q[1] - hy).toFixed(1)} km from the epicentre · click for its record`; }
      else tip.textContent = "Epicentre of the model's earthquake · click for the rupture";
      tip.hidden = false; tip.style.transform = `translate(${at.x + 12}px, ${at.y - 12}px)`;
    };
    describeSite();
    githubCodes();
    updateInset();
    app.globe = Globe.create($("#globe"));

    // the network loads while the cover is up
    const t0 = performance.now();
    app.networkReady = Infer.load(family, (got, total) => {
      $("#cover-load").textContent = got < total ? `Loading the network · ${(got / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB` : "Network ready";
    }).then(s => { app.timings.models_ms = performance.now() - t0; $("#cover-load").textContent = Infer.live ? "Network ready · runs in this browser" : "Network results ready"; return s; });
    app.networkReady.catch(fail);

    await loadMedium(Number(p.get("seed")) || index.default);
    const wish = Story.ready();                                        // a chapter asked for while loading (a hash, Enter) wins
    if (wish) Story.go(wish[0], { ...wish[1], force: true });
    else if (initial.start === "cover") { setStage("earth"); Story.showCover(); }
    else Story.go(chapters.some(c => c.id === initial.start) ? initial.start : chapters[0].id, { force: true });
    if (!Story.onCover && Story.chapter.id === "receiver") await networkFor(app.medium);
    app.ready = true;
  }

  function markDepth() {
    document.querySelectorAll("#depth-chips .chip").forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.depth) === app.depth)));
  }
  function toggleOrbit() { setOrbitButton(!orbitWanted()); }
  function setOrbitButton(on) { $("#orbit-btn").setAttribute("aria-pressed", String(!!on)); applyOrbit(); }

  // ---------------------------------------------------------------- controls
  function wire() {
    $("#theme-btn").addEventListener("click", () => { applyTheme(app.theme === "dark" ? "light" : "dark"); Story.setParams({ theme: app.theme }); });
    $("#orbit-btn").addEventListener("click", toggleOrbit);
    $("#medium-chips").addEventListener("click", e => {
      const b = e.target.closest("[data-seed]"); if (!b) return;
      loadMedium(Number(b.dataset.seed)).then(m => (Story.chapter && Story.chapter.id === "receiver" ? networkFor(m).then(() => showReceiver(app.rx)) : null)).catch(fail);
    });
    document.querySelectorAll("[data-field]").forEach(b => b.addEventListener("click", () => { app.field = b.dataset.field; paintField(); Story.setParams({ field: app.field }); }));
    document.querySelectorAll("[data-medium-view]").forEach(b => b.addEventListener("click", () => { app.mediumView = b.dataset.mediumView; applyMediumView(); }));
    $("#layer-report").addEventListener("click", e => { if (e.target.closest("[data-action=layer-close]")) showLayer(-1); });
    $("#depth-chips").addEventListener("click", e => {
      const b = e.target.closest("[data-depth]"); if (!b) return;
      if (app.mediumView === "layers") { app.mediumView = "block"; applyMediumView(); }   // the depth cut is the block's
      app.depth = Number(b.dataset.depth); app.scene.setFloor(app.depth); markDepth();
      Story.setParams({ depth: isFinite(app.depth) ? app.depth : null });
    });
    $("#exag").addEventListener("input", e => { app.site.setExaggeration(Number(e.target.value)); syncExag(); });
    $("#opacity").addEventListener("input", e => { app.userOpacity = Number(e.target.value); app.site.setOpacity(app.userOpacity); markTools(); });
    $("#section-switch").addEventListener("click", () => setSection(!app.site.sectionOn));
    $("#buildings-switch").addEventListener("click", () => { app.site.setShow({ buildings: !app.site.show.buildings }); markTools(); });
    document.querySelectorAll("[data-palette]").forEach(b => b.addEventListener("click", () => { app.site.setPalette(b.dataset.palette); markPalette(); Story.setParams({ palette: b.dataset.palette }); }));
    $("#tools-btn").addEventListener("click", () => { const open = $("#dock").hidden; $("#dock").hidden = !open; $("#tools-btn").setAttribute("aria-expanded", String(open)); if (open) markTools(); placeFloats(); });
    $("#card-title").addEventListener("click", () => $("#card").classList.toggle("folded"));       // as the SRF Explorer: the title folds
    $("#site-labels").addEventListener("click", e => { if (e.target.closest("[data-id=segment]")) cardFor({ kind: "segment" }); });
    $("#layers").addEventListener("click", e => { const tr = e.target.closest("[data-layer]"); if (tr) showLayer(Number(tr.dataset.layer) === app.layer ? -1 : Number(tr.dataset.layer)); });
    $("#quake-table").addEventListener("click", e => { const tr = e.target.closest("[data-rx]"); if (tr) cardFor({ kind: "receiver", k: Number(tr.dataset.rx) }); });
    // any interaction with the scene, the panel or a card pauses the tour (story.js shows a toast)
    document.addEventListener("pointerdown", e => { if (e.target.closest(".stage, #panel-body, #card, #dock, #timeline")) Story.pauseTour(); }, true);
    // taking the camera by hand stops the orbit (the button says so); the button turns it on again
    document.addEventListener("pointerdown", e => { if (e.target.closest(".stage") && orbitWanted()) setOrbitButton(false); }, true);
    document.querySelectorAll("[data-cut]").forEach(b => b.addEventListener("click", () => {      // a new mode turns the camera to its face
      setCut(b.dataset.cut); app.flight = app.site.flyTo(b.dataset.cut === "none" ? "faults" : "cut", 1600);
    }));
    $("#cut-pos").addEventListener("input", e => setCut(app.site.cut.mode, Number(e.target.value)));
    document.querySelectorAll("[data-show]").forEach(b => b.addEventListener("click", () => { app.site.setShow({ [b.dataset.show]: !app.site.show[b.dataset.show] }); markTools(); }));
    document.querySelectorAll("[data-fly]").forEach(b => b.addEventListener("click", () => (b.dataset.fly === "north" ? app.site.northUp()
      : b.dataset.fly === "site" ? flySite(app.rx)
      : (b.dataset.fly === "quake" && setCut("south", app.site.sectionY), app.site.flyTo(b.dataset.fly)))));   // the rupture lives in A–B: open it
    $("#qr-btn").addEventListener("click", () => ($("#qr").hidden ? showQr() : ($("#qr").hidden = true)));
    $("#qr-close").addEventListener("click", () => ($("#qr").hidden = true));
    $("#card-close").addEventListener("click", hideCard);
    $("#card-fold").addEventListener("click", () => $("#card").classList.toggle("folded"));
    $("#card").addEventListener("click", e => {
      const go = e.target.closest("[data-card-go]"), rec = e.target.closest("[data-card-receiver]"), site = e.target.closest("[data-card-site]");
      if (site) flySite(Number(site.dataset.cardSite));
      if (go) { hideCard(); Story.go(go.dataset.cardGo); }
      if (rec) { hideCard(); app.select(Number(rec.dataset.cardReceiver)); }
    });
    $("#fault-table").addEventListener("click", e => {
      const tr = e.target.closest("[data-fault]"); if (!tr) return;
      const k = Number(tr.dataset.fault);
      cardFor({ kind: "fault", fault: app.siteData.faults[k] });
      setOrbitButton(false);                                            // a turning camera never settles on the fault
      app.flight = app.site.flyTo(app.site.faultView(k), 1800);
    });
    $("#compass").addEventListener("click", () => { if (app.stage === "site") app.site.northUp(); else if (app.stage === "block") app.scene.frame(); });
    document.querySelectorAll("[data-comp]").forEach(b => b.addEventListener("click", async () => {
      app.waveComp = b.dataset.comp;
      document.querySelectorAll("[data-comp]").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
      if (Story.chapter && Story.chapter.id === "solver") { app.wave = await waveFor(app.seed, app.waveComp); waveLegend(); drawWaveFrame(Timeline.time); }
    }));
    $("#wave-chips").addEventListener("click", async e => {
      const b = e.target.closest("[data-seed]"); if (!b || Number(b.dataset.seed) === app.seed) return;
      const t = Timeline.time;
      await loadMedium(Number(b.dataset.seed));
      app.wave = await waveFor(app.seed, app.waveComp);
      $("#solver-note").hidden = true;
      describeSolver(app.wave.entry); waveLegend(); drawRecording(); Timeline.seek(t);
    });
    document.querySelectorAll("[data-action=fly-earth]").forEach(b => b.addEventListener("click", () => { app.flight = app.earth.flyTo(b.dataset.view, 2400); }));
    document.querySelectorAll("[data-sun]").forEach(b => b.addEventListener("click", () => { if (app.earth) { app.earth.setSun(b.dataset.sun); markSun(); } }));
    document.querySelectorAll("[data-finale-comp]").forEach(b => b.addEventListener("click", () => { app.finaleComp = b.dataset.finaleComp; paintFinale(); }));
    for (const id of Object.values(STAGE_IDS)) for (const ev of ["pointerdown", "wheel"])
      $(id).addEventListener(ev, () => { clearTimeout(hintTimer); document.body.classList.add("hint-dim"); }, { passive: true });
    document.querySelector("[data-action=into-block]").addEventListener("click", () => Story.next());
    $("#rx-prev").addEventListener("click", () => showReceiver(app.rx - 1));
    $("#nw-prev").addEventListener("click", () => selectReceiver(app.rx - 1));
    $("#nw-next").addEventListener("click", () => selectReceiver(app.rx + 1));
    $("#rx-next").addEventListener("click", () => showReceiver(app.rx + 1));
    document.addEventListener("keydown", e => {
      if (!app.ready || Story.onCover || e.target.closest("input, select, textarea")) return;
      const id = Story.chapter && Story.chapter.id;                    // [ ] step receivers where receivers are what you read
      if ((e.key === "[" || e.key === "]") && (id === "receiver" || id === "solver" || id === "stats" || id === "network")) { e.preventDefault(); selectReceiver(app.rx + (e.key === "]" ? 1 : -1)); }
    });
    let timer = null;
    addEventListener("resize", () => { clearTimeout(timer); timer = setTimeout(() => { updateInset(); redrawPanel(); placeFloats(); }, 120); });
  }

  // the panel's charts are drawn at the panel's size: redraw them when it changes (resize, unfolding)
  function redrawPanel() {
    const id = Story.chapter && Story.chapter.id;
    if (!id || Story.onCover || document.body.classList.contains("panel-folded")) return;
    if (id === "quake") { drawProfiles(); if (app.medium) drawQuakeRecord(); }
    else if (id === "source") { drawSourceCharts(); sourceTime(Timeline.time); }
    else if (id === "solver" && app.wave) drawRecording();
    else if (id === "receiver") showReceiver(app.rx);
    else if (id === "stats" && Stats.ready) Stats.render();
  }

  // a hash typed by hand: apply its view before story.js enters the chapter
  function applyParams(p) {
    if (p.get("theme")) applyTheme(p.get("theme"));
    if (p.get("field") && FIELDS[p.get("field")]) app.field = p.get("field");
    app.depth = p.get("depth") ? Number(p.get("depth")) : Infinity;
    app.scene.setFloor(app.depth); markDepth();
    if (p.get("rx")) app.rx = Math.max(0, Math.min(app.family.receivers.x.length - 1, Number(p.get("rx")) - 1));
    const seed = Number(p.get("seed"));
    const after = () => (Story.chapter && Story.chapter.id === "receiver" ? networkFor(app.medium).then(() => showReceiver(app.rx)) : null);
    if (seed && seed !== app.seed) loadMedium(seed).then(after).catch(fail); else { paintField(); after(); }
  }

  Timeline.init();
  app.select = k => selectReceiver(k);
  app.go = id => Story.go(id);
  app.loadMedium = seed => loadMedium(seed).then(m => networkFor(m)).then(() => showReceiver(app.rx));
  wire();
  start().catch(fail);
