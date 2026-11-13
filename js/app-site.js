// Surrogate Explorer · app-site.js — Quito site, earthquake and profile chapters.
// Split from app.js; this remains a classic script so the public builder can version every file independently.
"use strict";

  function wholeDepth() {
    if (!isFinite(app.depth)) return;
    app.depth = Infinity; app.scene.setFloor(Infinity); markDepth(); Story.setParams({ depth: null });
  }

  // ---------------------------------------------------------------- overlays that follow the camera
  function niceLength(metres) {
    const p = Math.pow(10, Math.floor(Math.log10(metres))), m = metres / p;
    return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
  }
  function navAids(info) {
    const length = niceLength(120 * info.metresPerPx);
    $("#scalebar").style.width = `${length / info.metresPerPx}px`;
    $("#scalebar-label").textContent = length >= 1000 ? `${length / 1000} km` : `${length} m`;
    $("#needle").setAttribute("transform", `rotate(${info.northDeg.toFixed(1)})`);
  }
  function onFrame() {
    if (app.stage !== "block") return;
    const label = $("#rx-label"), inChapter = Story.chapter && Story.chapter.id === "receiver" && !Story.onCover;
    if (inChapter) {
      const s = app.scene.labelScreen(app.rx);
      label.hidden = false; label.textContent = app.family.receivers.labels[app.rx];
      label.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -100%)`;
    } else label.hidden = true;
    placeCallout();
    // the source chapter: the front's label rides with it, as in the deck's GIF ("rupture front: 1 715 m down-dip")
    const front = Story.chapter && Story.chapter.id === "source" && !Story.onCover ? app.scene.frontInfo() : null, fl = $("#front-label");
    fl.hidden = !front;
    if (front) { fl.textContent = `t = ${Timeline.time.toFixed(2)} s · front ${num(front.along_m)} m down-dip`; fl.style.transform = `translate(${front.screen.x + 18}px, ${front.screen.y}px) translate(0, -50%)`; }
    navAids(app.scene.overlayInfo());
  }
  function onSiteFrame() {
    if (app.stage !== "site") return;
    $("#rx-label").hidden = true;
    const box = $("#site-labels"), info = app.site.overlayInfo();
    box.classList.toggle("hold", !!app.labelHold);                    // the dive: no labels until the ground has risen
    const zonesOn = Story.chapter && Story.chapter.id === "quito" && info.distance > 14 && app.site.show.zones;
    // A21: no label under the top bar, the panel, a card, the dock, the play bar or the corner, and none on another.
    // labels() comes in priority order (A, B, the segment, the fault, the zones); a label that collides above its anchor
    // tries below it, then hides. All the rectangles are read before any label moves.
    const pad = 3, taken = [".top", "#panel", "#card", "#dock", "#timeline", "#globe", "#minimap"].map(s => $(s)).filter(e => e && !e.hidden)
      .map(e => e.getBoundingClientRect()).filter(r => r.width && r.height).map(r => [r.left, r.top, r.right, r.bottom]);
    const free = b => b[0] >= 0 && b[1] >= 0 && b[2] <= innerWidth && b[3] <= innerHeight &&
      !taken.some(t => b[0] < t[2] + pad && b[2] > t[0] - pad && b[1] < t[3] + pad && b[3] > t[1] - pad);
    const placed = [];
    const live = new Set();
    for (const l of app.site.labels()) {
      live.add(l.id);
      let el = box.querySelector(`[data-id="${l.id}"]`);
      if (!el) { el = document.createElement("span"); el.dataset.id = l.id; el.className = l.cls || ""; box.appendChild(el); }
      if (el.textContent !== l.text) { el.textContent = l.text; app.labelSize.delete(l.id); }
      const shown = l.rx ? app.site.show.receivers && (info.distance < RX_LABELS_KM || l.k === app.rx && app.site.halo === l.k) : l.trace ? app.site.show.planes
        : l.id === "fault" ? app.site.show.faults : l.id === "segment" || l.id === "A" || l.id === "B" ? app.site.show.section : !l.zone || zonesOn;
      let at = null;
      if (l.text && l.screen.visible && shown) {
        if (!app.labelSize.has(l.id)) app.labelSize.set(l.id, [el.offsetWidth, el.offsetHeight]);
        const [w, h] = app.labelSize.get(l.id), { x, y } = l.screen;
        for (const [top, shift] of [[y - h, "-100%"], [y + 6, "6px"]]) {
          const b = [x - w / 2, top, x + w / 2, top + h];
          if (free(b)) { at = shift; taken.push(b); placed.push(l.id); break; }
        }
        if (at) el.style.transform = `translate(${x}px, ${y}px) translate(-50%, ${at})`;
      }
      el.style.visibility = at ? "visible" : "hidden";
    }
    // a label that left the list (a fault trace once its cut is gone) must not stay where it last was
    for (const el of box.children) if (!live.has(el.dataset.id)) el.style.visibility = "hidden";
    app.labelsPlaced = placed;                                         // for the tests
    navAids(info);
    // the corner: the globe from afar, a mini-map once the camera is close (as the SRF Explorer does)
    const mini = info.distance < 40;
    $("#minimap").hidden = !mini; $("#globe").hidden = mini;
    if (mini) app.site.drawMiniMap($("#minimap"));
  }

  // ---------------------------------------------------------------- the map's panels
  function stats(id, items) { $(id).innerHTML = items.map(([v, l]) => stat(v, l)).join(""); }
  const latLon = (x, y) => {                                         // local km -> degrees (UTM at the equator: a metre is a metre)
    const [lon0, lat0] = app.siteData.origin_lon_lat;
    const lat = lat0 + y / 110.574, lon = lon0 + x / (111.320 * Math.cos(lat0 * Math.PI / 180));
    return `${Math.abs(lat).toFixed(4)}° ${lat < 0 ? "S" : "N"}, ${Math.abs(lon).toFixed(4)}° ${lon < 0 ? "W" : "E"}`;
  };
  function describeSite() {
    const s = app.siteData, seg = s.segment, f = app.family;
    const mid = [(seg.start_lon_lat[0] + seg.end_lon_lat[0]) / 2, (seg.start_lon_lat[1] + seg.end_lon_lat[1]) / 2];
    stats("#earth-stats", [[`${Math.abs(mid[1]).toFixed(3)}° S, ${Math.abs(mid[0]).toFixed(3)}° W`, "segment 3, centre"], [`${s.section.length_km.toFixed(1)} km`, "section A–B, west to east"],
                           [`${(seg.length_m / 1000).toFixed(1)} km`, "segment 3, the model's width"]]);
    const e = s.dem.elevation_range_m, w = s.dem.x_range_km[1] - s.dem.x_range_km[0], h = s.dem.y_range_km[1] - s.dem.y_range_km[0];
    stats("#quito-stats", [[`${w.toFixed(0)} × ${h.toFixed(0)} km`, "relief shown (DMQ polygon)"], [`${num(e[0])}–${num(e[1])} m`, "elevation a.s.l."],
                           [`${s.dem.pixel_m[0].toFixed(0)} m`, "Copernicus GLO-30 pixel"], [`${s.zones.length}`, "administrative zones"]]);
    $("#fault-table tbody").innerHTML = s.faults.map((fl, k) => `<tr data-fault="${k}"><td>${fl.id}</td><td>${fl.dip}° ${fl.dip_dir}</td>` +
      `<td>${fl.slip_rate_mm_yr ?? "—"}</td><td>${fl.magnitudes[1] ?? "—"}</td><td>${(+fl.length_km).toFixed(1)} km</td></tr>`).join("");
    if (s.faults[0]) $("#fault-name").textContent = s.faults[0].name;
    setupLocationFinder();
    markPalette();
    const rows = f.surface_index, stepMax = Math.max(...rows);
    stats("#segment-stats", [[`${(seg.length_m / 1000).toFixed(1)} km`, "segment 3"], [`${Math.round(seg.relief_m)} m`, "relief along it"],
                             [`${f.grid.nx} columns`, `dx = ${f.grid.dx.toFixed(2)} m`], [`0–${stepMax} rows`, "the staircase surface"]]);
    const m = s.model, [ehx, ehy] = m.hypocentre_xy_km;
    $("#quake-table tbody").innerHTML = f.receivers.labels.map((lab, k) => {
      const d = f.receivers.x[k] * f.grid.dx / 1000, x = seg.xy_km[0][0] + seg.along[0] * d, y = seg.xy_km[0][1] + seg.along[1] * d;
      const repi = Math.hypot(x - ehx, y - ehy), rhyp = Math.hypot(repi, ((app.site ? app.site.heightAt(x, y) : m.epicentre_z_m) - m.hypocentre_z_m) / 1000);
      return `<tr data-rx="${k}"><td>${lab}</td><td>${d.toFixed(2)}</td><td>${repi.toFixed(2)}</td><td>${rhyp.toFixed(2)}</td></tr>`;
    }).join("");
    stats("#quake-stats", [[`${((m.top_elevation_m - m.hypocentre_z_m) / 1000).toFixed(2)} km`, "hypocentre under the grid's top"],
                           [`${num(m.epicentre_z_m)} m`, "epicentre elevation a.s.l."], [`${f.rupture.x.length}`, "point sources, in the section plane"],
                           [`${(m.depth_m / 1000).toFixed(1)} km`, "depth of the model"]]);
  }
  function markPalette() {
    const name = app.site ? app.site.palette : "map";
    document.querySelectorAll("[data-palette]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.palette === name)));
    $("#elev-ramp").style.background = Site.gradient(name);
    // the legend's ends: what the palette colours (the elevation; the open sky; the curvature, in 1/km at its clip)
    const e = app.siteData.dem.elevation_range_m, k = app.siteData.dem.curvature_clip_per_km;
    const ends = { ao: ["enclosed", "open sky"], curvature: [`valley −${k.toFixed(1)}/km`, `ridge +${k.toFixed(1)}/km`] }[name] || [`${num(e[0])} m`, `${num(e[1])} m`];
    $("#elev-min").textContent = ends[0]; $("#elev-max").textContent = ends[1];
    $("#palette-note").textContent = PALETTE_NOTES[name] || "";
  }
  const PALETTE_NOTES = {
    ao: "Ambient occlusion: a clay model lit only by the open sky above each point; ravines and the deep valleys go dark, open ground and crests stay pale. No sun.",
    curvature: "Curvature of the relief over ~150 m: ridges and spurs (convex) focus seismic waves and shake more; valleys and ravines (concave) spread them. One of the shapes behind topographic site effects.",
  };
  function markTools() {
    const sh = app.site.show;
    document.querySelectorAll("[data-show]").forEach(b => b.setAttribute("aria-pressed", String(!!sh[b.dataset.show])));
    const cut = app.site.cut, onAB = cut.mode === "south" && cut.off === app.site.sectionY;
    document.querySelectorAll("[data-cut]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.cut === cut.mode)));
    $("#section-switch").setAttribute("aria-checked", String(onAB));
    $("#buildings-switch").setAttribute("aria-checked", String(!!sh.buildings));
    // the position slider: north–south for South, west–east for East, an elevation for Top (none for None and Quadrant)
    const pos = $("#cut-pos"), out = $("#cut-pos-out");
    pos.disabled = !cut.range; $("#cut-pos-row").classList.toggle("off", !cut.range);
    if (cut.range) { pos.min = cut.range[0]; pos.max = cut.range[1]; pos.step = cut.mode === "top" ? 10 : 0.05; pos.value = cut.off; }
    out.textContent = cut.mode === "south" ? (onAB ? "on A–B" : `${Math.abs(cut.off - app.site.sectionY).toFixed(2)} km ${cut.off > app.site.sectionY ? "north" : "south"} of A–B`)
      : cut.mode === "east" ? (d => `${Math.abs(d).toFixed(2)} km ${d < 0 ? "west" : "east"} of A`)(cut.off - app.siteData.section.xy_km[0][0]) : cut.mode === "top" ? `${num(cut.off)} m a.s.l.` : "—";
    $("#opacity").value = String(app.userOpacity); $("#opacity-out").textContent = `${Math.round(app.userOpacity * 100)} %`;
  }
  function feedSection(rgba) {                                       // the block's medium (or a wave frame) in the section plane
    if (!app.site || !app.base) return;
    app.site.setSectionMedium(rgba || app.base.rgba, app.family.grid.nx, app.family.grid.nz, app.base.mask);
  }
  function setSection(on) { setCut(on ? "south" : "none", app.site.sectionY); }
  // B1: None, Quadrant, East, South (A–B at its home position) or Top; the faces show depth, and the medium where a face is A–B
  function setCut(mode, off) {
    app.site.setCut(mode, off); feedSection(); app.site.setMediumOn(mode !== "none");
    document.body.classList.toggle("section-on", mode !== "none"); markTools();
  }
  // the Tools dock under the top bar, the card under the dock (the top bar wraps on a phone)
  function placeFloats() {
    const top = $(".top").getBoundingClientRect().bottom + 8, dock = $("#dock");
    dock.style.top = `${top}px`;
    if (innerWidth > 860) $("#card").style.top = `${dock.hidden ? top : dock.getBoundingClientRect().bottom + 8}px`; else $("#card").style.top = "";
  }

  // ---------------------------------------------------------------- cards: everything on the map answers a click
  function showCard(kicker, title, html) {
    $("#card-kicker").textContent = kicker; $("#card-title").innerHTML = title; $("#card-body").innerHTML = html;
    // on a phone the card opens folded (its title; a tap unfolds it), so the map stays reachable
    $("#card").hidden = false; $("#card").classList.toggle("folded", innerWidth <= 860); placeFloats(); markFault(-1);   // a fault card marks its own
  }
  // "⌖ Site": down to one receiver, with a halo around its pin (the card stays, its title folded out of the way)
  function flySite(k) {
    if (!app.site || app.stage !== "site") return;
    app.rx = k; Story.setParams({ rx: k + 1 });
    app.flight = app.site.flyToReceiver(k);
  }
  const RX_LABELS_KM = 7;                                            // the 39 names show once the camera is this close
  // B7: a QR code of this very view (the URL carries chapter, medium, receiver, field, depth and theme)
  function showQr() {
    const url = location.href, qr = qrcode(0, "M");
    qr.addData(url); qr.make();
    $("#qr-code").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    $("#qr-link").textContent = url; $("#qr-link").href = url;
    $("#qr").hidden = false;
  }
  // the credits: under each portrait, a QR code of that person's GitHub (made here, by the same vendored qrcode as ▦)
  function githubCodes() {
    document.querySelectorAll("[data-github]").forEach(fig => {
      const url = fig.dataset.github, qr = qrcode(0, "M"); qr.addData(url); qr.make();
      const a = document.createElement("a"); a.className = "gh-qr"; a.href = url; a.target = "_blank"; a.rel = "noopener";
      a.title = url.replace("https://", ""); a.setAttribute("aria-label", `GitHub: ${url.replace("https://github.com/", "")}`);
      a.innerHTML = qr.createSvgTag({ cellSize: 3, margin: 2, scalable: true }) + `<span>${url.replace("https://github.com/", "@")}</span>`;
      fig.appendChild(a);
    });
  }
  function hideCard() { $("#card").hidden = true; markFault(-1); }
  // the fault a card describes: its row in the table and its trace on the map (A15)
  function markFault(k) {
    document.querySelectorAll("#fault-table tbody tr").forEach(tr => tr.classList.toggle("on", Number(tr.dataset.fault) === k));
    if (app.site) app.site.setHighlight(k);
  }
  const rows = items => `<dl>${items.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  const zoneAt = (x, y) => (app.siteData.zones.find(z => z.rings.some(r => pointInRing(x, y, r))) || {}).name;
  function nearestOnLine(x, y, line) {
    let best = { distance: Infinity, x: NaN, y: NaN };
    for (let k = 1; k < line.length; k++) {
      const [ax, ay] = line[k - 1], [bx, by] = line[k], dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const px = ax + t * dx, py = ay + t * dy, distance = Math.hypot(x - px, y - py);
      if (distance < best.distance) best = { distance, x: px, y: py };
    }
    return best;
  }
  const distToLine = (x, y, line) => nearestOnLine(x, y, line).distance;
  // WGS84 input -> the local east/north kilometres used by the DEM and the SARA fault traces. This intentionally
  // mirrors latLon() above: the scene is a local map, not a global geodesic engine.
  function localKm(lon, lat) {
    const [lon0, lat0] = app.siteData.origin_lon_lat;
    return [(lon - lon0) * 111.320 * Math.cos(lat0 * Math.PI / 180), (lat - lat0) * 110.574];
  }
  // Representative points of the actual Overture footprints that feed the 3-D city --
  // not approximate neighbourhood pins. The marker therefore lands on each named building.
  const QUITO_PLACES = [
    ["Palacio de Carondelet", -78.5116838, -0.2205621], ["Basílica del Voto Nacional", -78.5142215, -0.2153271], ["Edificio IQON", -78.4809742, -0.1790779],
    ["Casa de la Cultura Ecuatoriana", -78.4953883, -0.2101100], ["Capilla del Hombre", -78.4694694, -0.1907611], ["Hotel Quito", -78.4798503, -0.2016630],
    ["Terminal Terrestre Quitumbe", -78.5563262, -0.2957130], ["Museo de Calderón · Casa Parroquial", -78.4300118, -0.0543938],
    ["Terminal de pasajeros · Aeropuerto Mariscal Sucre", -78.3601907, -0.1245316], ["Museo Monumento Mitad del Mundo", -78.4558202, -0.0020809],
  ];
  function locationStatus(text, warn = false) {
    const el = $("#location-status"); el.textContent = text; el.hidden = !text; el.classList.toggle("warn", warn);
  }
  function locatePlace(lon, lat, name = "Selected location") {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) { locationStatus("Enter a valid longitude and latitude in decimal degrees.", true); return; }
    const [x, y] = localKm(lon, lat), b = app.site.terrainBounds();
    // The DEM is continuous inside this four-edge topographic polygon. heightAt is the final guard for any future
    // masked terrain export, so an accepted query always has real Copernicus elevation under its marker.
    if (x < b.west || x > b.east || y < b.south || y > b.north || !Number.isFinite(app.site.heightAt(x, y))) {
      app.site.setLocationFaultLinks([]);
      app.site.clearLocationBuilding();
      locationStatus("This coordinate is outside the Copernicus topographic polygon loaded for this Quito map. Choose a point inside the displayed relief.", true);
      $("#location-result").hidden = true; return;
    }
    const point = app.site.locate(x, y);
    app.site.highlightLocationBuilding(x, y);
    const faults = app.siteData.faults.map((fault, k) => ({ fault, k, ...nearestOnLine(x, y, fault.trace_xy_km) })).sort((a, b) => a.distance - b.distance);
    const nearest = faults[0], zone = zoneAt(x, y);
    app.site.setLocationFaultLinks(faults.map((f, i) => ({ from: [x, y], to: [f.x, f.y], nearest: i === 0 })));
    const faultRows = `<table aria-label="Distance from this place to every mapped SARA fault trace"><thead><tr><th>Fault trace</th><th>Distance</th></tr></thead><tbody>${faults.map(({ fault, distance }) => `<tr><td>${fault.id}</td><td>${distance.toFixed(2)} km</td></tr>`).join("")}</tbody></table>`;
    const summary = rows([["Elevation", `${num(point.elevation_m)} m a.s.l.`], ["Administrative zone", zone || "outside the DMQ zones"], ["Coordinates", latLon(x, y)], ["Nearest SARA trace", `${nearest.fault.id} · ${nearest.distance.toFixed(2)} km`]]);
    $("#location-result").innerHTML = `<b>${name}</b>${summary}${faultRows}`;
    $("#location-result").hidden = false;
    showCard("Located coordinate", name, summary + faultRows);
    markFault(nearest.k);                                             // showCard clears a preceding map selection; the query owns this emphasis.
    locationStatus(`Mapped ${name}; ${nearest.fault.id} is the nearest SARA trace (${nearest.distance.toFixed(2)} km).`);
  }
  function setupLocationFinder() {
    const select = $("#location-presets");
    select.insertAdjacentHTML("beforeend", QUITO_PLACES.map(([name, lon, lat], k) => `<option value="${k}">${name}</option>`).join(""));
    select.addEventListener("change", () => {
      const p = QUITO_PLACES[Number(select.value)]; if (!p) return;
      const [name, lon, lat] = p; $("#location-lon").value = lon; $("#location-lat").value = lat; locatePlace(lon, lat, name);
    });
    $("#location-form").addEventListener("submit", e => { e.preventDefault(); locatePlace(Number($("#location-lon").value), Number($("#location-lat").value)); });
  }
  function recordSvg(k) {                                            // a_x, a_z of receiver k (FDM, this medium)
    const f = app.family, nt = f.clock.nt, dt = f.clock.dt, acc = app.medium.fdm.acc;
    const ax = acc.subarray((k * 2) * nt, (k * 2 + 1) * nt), az = acc.subarray((k * 2 + 1) * nt, (k * 2 + 2) * nt);
    // the caption on top and t [s] under the y labels: nothing shares the row of the time ticks
    const peak = Math.max(DSP.peakAbs(ax), DSP.peakAbs(az)) * 1.08 || 1, W = 390, H = 150, m = { l: 44, r: 8, t: 22, b: 20 };
    const x = d3.scaleLinear().domain([0, f.clock.duration]).range([m.l, W - m.r]), y = d3.scaleLinear().domain([-peak, peak]).range([H - m.b, m.t]);
    const line = a => d3.line()(d3.range(0, nt, 4).map(i => [x(i * dt), y(a[i])]));
    return `<svg class="chart" viewBox="0 0 ${W} ${H}"><g class="grid">${y.ticks(4).map(v => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"></line>`).join("")}</g>
      <path class="trace-x" d="${line(ax)}"></path><path class="trace-z" d="${line(az)}"></path>
      ${y.ticks(4).map(v => `<text class="axis-label" x="${m.l - 6}" y="${y(v) + 3}" text-anchor="end">${d3.format("~g")(v)}</text>`).join("")}
      ${x.ticks(6).map(v => `<text class="axis-label" x="${x(v)}" y="${H - m.b + 14}" text-anchor="middle">${v}</text>`).join("")}
      <text class="axis-label" x="${m.l - 6}" y="${H - m.b + 14}" text-anchor="end">t [s]</text>
      <text class="legend-text" x="${W - m.r}" y="12" text-anchor="end">a [m/s²] · ${RECORD_LEGEND}</text></svg>`;
  }
  function cardFor(hit) {
    const s = app.siteData, m = s.model, f = app.family, [hx, hy] = m.hypocentre_xy_km;
    if (!hit) { hideCard(); return; }
    if (hit.kind === "terrain") {
      const zone = zoneAt(hit.x, hit.y);
      showCard("Terrain", `${num(hit.elev)} m a.s.l.`, rows([["Zone", zone ? zone : "outside the DMQ zones"], ["Distance to segment 3", `${distToLine(hit.x, hit.y, s.segment.xy_km).toFixed(2)} km`],
        ["Distance to the epicentre", `${Math.hypot(hit.x - hx, hit.y - hy).toFixed(2)} km`], ["Position", latLon(hit.x, hit.y)], ["x, y (local)", `${hit.x.toFixed(2)}, ${hit.y.toFixed(2)} km`]]) +
        `<p class="note">Copernicus GLO-30, ${s.dem.pixel_m[0].toFixed(0)} m pixels; mesh every ${s.mesh.stride} pixels.</p>`);
    } else if (hit.kind === "fault" || hit.kind === "plane") {
      const fl = hit.fault;
      app.site.clearLocation();
      showCard(hit.kind === "plane" ? "Fault plane" : "Fault trace", `${fl.name} · ${fl.id}`, rows([["Type", fl.type], ["Dip", `${fl.dip}° towards ${fl.dip_dir}`],
        ["Seismogenic depth", `${fl.depth_km[0]}–${fl.depth_km[1]} km`], ["Slip rate", `${fl.slip_rate_mm_yr} mm/yr`], ["Magnitudes", `${fl.magnitudes[0]}–${fl.magnitudes[1]}`],
        ["Trace length", `${(+fl.length_km).toFixed(1)} km`]]) +
        `<p class="note">${fl.source}. Context only: the solver never uses it (its rupture is parametric). The plane is drawn down to the model's floor.</p>`);
      markFault(s.faults.indexOf(fl));
    } else if (hit.kind === "segment") {
      const from = s.segments[s.segment.number - 1].from_km;
      showCard("Section A–B", `Segment ${s.segment.number}`, rows([["Length", `${(s.segment.length_m / 1000).toFixed(1)} km`], ["Relief along it", `${Math.round(s.segment.relief_m)} m`],
        ["Grid", `${f.grid.nx} × ${f.grid.nz} cells, dx = ${f.grid.dx.toFixed(2)} m`], ["From A", `${from}–${from + s.segment.length_m / 1000} km`]]) +
        `<button type="button" class="action go-next" data-card-go="medium">Into the block ›</button>`);
    } else if (hit.kind === "receiver") {
      const k = hit.k, p = app.site.receiverXY(k), z = app.site.receiverElevation(k), repi = Math.hypot(p[0] - hx, p[1] - hy), rhyp = Math.hypot(repi, (z - m.hypocentre_z_m) / 1000);
      const acc = app.medium.fdm.acc, nt = f.clock.nt, g = f.spectra.g;
      app.site.setSelected(k); app.rx = k; Story.setParams({ rx: k + 1 });
      showCard("Receiver", f.receivers.labels[k], rows([["Along segment 3", `${(f.receivers.x[k] * f.grid.dx / 1000).toFixed(2)} km`], ["Elevation", `${num(z)} m a.s.l.`],
        ["Epicentral distance", `${repi.toFixed(2)} km`], ["Hypocentral distance", `${rhyp.toFixed(2)} km`],
        ["PGA horizontal (FDM)", `${(DSP.peakAbs(acc.subarray(k * 2 * nt, (k * 2 + 1) * nt)) / g).toFixed(3)} g`],
        ["PGA vertical (FDM)", `${(DSP.peakAbs(acc.subarray((k * 2 + 1) * nt, (k * 2 + 2) * nt)) / g).toFixed(3)} g`]]) +
        recordSvg(k) + `<div class="card-actions"><button type="button" class="action" data-card-site="${k}">⌖ Site</button>` +
        `<button type="button" class="action go-next" data-card-receiver="${k}">Its records from the network ›</button></div>`);
      if (Story.chapter && Story.chapter.id === "quake") drawQuakeRecord();
    } else if (hit.kind === "epicentre" || hit.kind === "hypocentre") {
      const r = f.rupture, len = Math.hypot((Math.max(...r.x) - Math.min(...r.x)) * f.grid.dx, (Math.max(...r.z) - Math.min(...r.z)) * f.grid.dz) / 1000;
      showCard("The model's earthquake", hit.kind === "epicentre" ? "Epicentre" : "Hypocentre", rows([["Position", latLon(hx, hy)], ["Epicentre elevation", `${num(m.epicentre_z_m)} m a.s.l.`],
        ["Hypocentre", `${((m.top_elevation_m - m.hypocentre_z_m) / 1000).toFixed(2)} km under the grid's top`], ["Rupture", `${r.x.length} point sources, ${len.toFixed(1)} km, ${Math.max(...r.activation_s).toFixed(1)} s`],
        ["Source", `vertical forces, Ricker f₀ = ${f.source.f0} Hz`]]) + `<p class="note">Parametric and fixed: the same earthquake in all 1,000 media. It lies in the section plane, because the solver is 2D.</p>`);
    } else if (hit.kind === "section") {
      // any face of a cut; only the A–B plane carries the model (within a metre of it: the quadrant's south face is A–B too)
      const sec = s.segment.xy_km, onAB = Math.abs(hit.y - app.site.sectionY) < 0.001, inSeg = onAB && hit.x >= sec[0][0] && hit.x <= sec[sec.length - 1][0];
      const below = (app.site.heightAt(hit.x, hit.y) - hit.elev) / 1000;
      const items = [["Depth below the terrain", `${below.toFixed(2)} km`], ["Elevation", `${num(hit.elev)} m a.s.l.`],
                     onAB ? ["Along A–B", `${(hit.x - s.section.xy_km[0][0]).toFixed(2)} km from A`] : ["Position", latLon(hit.x, hit.y)]];
      let note = onAB ? "Outside segment 3 the model has no medium: the colours here are depth only."
        : "A face of the cut, coloured by depth under the terrain. The model's medium exists only in the A–B plane (the section, or the quadrant's south face).";
      if (inSeg && app.medium) {
        const ix = Math.round((hit.x - sec[0][0]) * 1000 / f.grid.dx), iz = Math.round((m.top_elevation_m - hit.elev) / f.grid.dz), nx = f.grid.nx, nz = f.grid.nz;
        if (ix >= 0 && ix < nx && iz >= 0 && iz < nz) {
          const i = iz * nx + ix, size = nx * nz, inp = app.medium.input, val = c => inp[c * size + i] * f.normalizer.std[c] + f.normalizer.mean[c];
          if (inp[3 * size + i] > 0.5) { items.push(["Vp", `${num(val(0))} m/s`], ["Vs", `${num(val(1))} m/s`], ["ρ", `${num(val(2))} kg/m³`], ["Grid cell", `column ${ix}, row ${iz}`]); note = `Medium of seed ${app.seed}, exactly as the network reads it.`; }
          else note = "Air above the model's free surface.";
        }
      }
      showCard(onAB ? "Crustal section" : "Cut", inSeg ? `Inside the model · seed ${app.seed}` : onAB ? "Section A–B" : `${below.toFixed(2)} km deep`, rows(items) + `<p class="note">${note}</p>`);
    }
  }

  // ---------------------------------------------------------------- the model's earthquake and the prologue, on the play bar
  function quakeLevels(t) {
    const f = app.family, nt = f.clock.nt, i = Math.min(nt - 1, Math.max(0, Math.round(t / f.clock.dt))), acc = app.medium.fdm.acc, n = f.receivers.x.length;
    if (!app.quakePeak) app.quakePeak = Array.from({ length: n }, (_, k) => DSP.peakAbs(acc.subarray(k * 2 * nt, (k * 2 + 2) * nt)) || 1);
    return Float32Array.from({ length: n }, (_, k) => Math.hypot(acc[k * 2 * nt + i], acc[(k * 2 + 1) * nt + i]) / app.quakePeak[k]);
  }
  function quakeTime(t) {
    app.site.setRuptureTime(t);
    app.site.setShake(quakeLevels(t));
    if (app.wave) {
      const f = app.family, out = Wave.compose(app.wave.data, Wave.frameAt(app.wave.data, t), app.base.rgba, app.base.mask, f.grid.nx, f.grid.nz, 0, app.quakeOut || {});
      app.quakeOut = out; feedSection(out.rgba);
    }
    if (app.quakeChart) cursorOn(app.quakeChart, t);
  }
  function drawQuakeRecord() {
    const f = app.family, nt = f.clock.nt, dt = f.clock.dt, k = app.rx, acc = app.medium.fdm.acc;
    const ax = acc.subarray((k * 2) * nt, (k * 2 + 1) * nt), az = acc.subarray((k * 2 + 1) * nt, (k * 2 + 2) * nt), peak = Math.max(DSP.peakAbs(ax), DSP.peakAbs(az)) * 1.08;
    const chart = frameChart($("#quake-chart"), { xDomain: [0, f.clock.duration], yDomain: [-peak, peak], xLabel: "t [s]", yLabel: "a [m/s²]", legend: RECORD_LEGEND });
    const pts = a => d3.range(0, nt, 3).map(i => [i * dt, a[i]]), line = d3.line().x(d => chart.x(d[0])).y(d => chart.y(d[1]));
    chart.g.append("path").attr("class", "trace-x").attr("d", line(pts(ax))); chart.g.append("path").attr("class", "trace-z").attr("d", line(pts(az)));
    chart.future = chart.g.append("rect").attr("class", "future").attr("y", 0).attr("height", chart.h);
    app.quakeChart = chart; $("#quake-rx").textContent = String(k + 1);
    cursorOn(chart, Timeline.active ? Timeline.time : 0);
  }
  async function enterQuake() {
    const ids = app.waveIndex ? app.waveIndex.media.map(mm => mm.seed) : [];
    const asked = app.seed;
    if (ids.length && !ids.includes(app.seed)) { app.seedBefore = app.seed; await loadMedium(ids[0]); }
    $("#quake-note").hidden = asked === app.seed;
    $("#quake-note").textContent = `Seed ${asked} has no stored replay; this chapter shows seed ${app.seed}.`;
    app.wave = ids.length ? await waveFor(app.seed, "vz") : null;
    if (!(Story.chapter && Story.chapter.id === "quake")) return;
    app.quakePeak = null; app.site.setSelected(app.rx);
    cardFor({ kind: "receiver", k: app.rx });                          // the receiver's card is open from the start (it draws the panel's record too)
    const duration = app.wave ? app.wave.entry.times[app.wave.entry.times.length - 1] : app.family.clock.duration;
    Timeline.use({ duration, label: "simulated time", speeds: [0.25, 0.5, 1], speed: 0.5, onTime: quakeTime });
    updateInset();
    Timeline.autoplay(() => Story.chapter && Story.chapter.id === "quake", 1600);
  }
  function restoreSeed() { if (app.seedBefore) { const s = app.seedBefore; app.seedBefore = null; loadMedium(s).catch(fail); } }
  function leaveQuake() {
    Timeline.release(); app.wave = null; restoreSeed();
    app.site.setRuptureTime(null); app.site.setShake(null); app.site.setSelected(-1); feedSection();
  }
  function profileChart(svgNode, spec) {
    const svg = d3.select(svgNode), width = svgNode.clientWidth || 420, height = svgNode.clientHeight || 170;
    const m = { top: 14, right: 12, bottom: 36, left: 50 }, w = width - m.left - m.right, h = height - m.top - m.bottom;
    svg.attr("viewBox", `0 0 ${width} ${height}`).selectAll("*").remove();
    const g = svg.append("g").attr("transform", `translate(${m.left},${m.top})`);
    const x = d3.scaleLinear().domain(spec.xDomain).range([0, w]), y = d3.scaleLinear().domain(spec.yDomain).range([h, 0]).nice();
    (spec.bands || []).forEach(b => {
      g.append("rect").attr("class", `seg${b.on ? " on" : b.number % 2 ? "" : " alt"}`).attr("x", x(b.from)).attr("width", Math.max(0, x(b.to) - x(b.from))).attr("y", 0).attr("height", h);
      g.append("text").attr("class", `seg-label${b.on ? " on" : ""}`).attr("x", (x(b.from) + x(b.to)) / 2).attr("y", 11).text(b.label);
    });
    g.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(4).tickSize(-w).tickFormat(""));
    g.append("g").attr("class", "axis").attr("transform", `translate(0,${h})`).call(d3.axisBottom(x).ticks(6));
    g.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(4).tickFormat(d3.format("~d")));
    g.append("text").attr("class", "axis-label").attr("x", w).attr("y", h + 32).attr("text-anchor", "end").text(spec.xLabel);
    g.append("text").attr("class", "axis-label").attr("transform", `translate(${-m.left + 12},${h / 2}) rotate(-90)`).attr("text-anchor", "middle").text(spec.yLabel);
    const line = d3.line().defined(d => Number.isFinite(d[1])).x(d => x(d[0])).y(d => y(d[1]));
    for (const s of spec.series) g.append("path").attr("class", s.cls).attr("d", (s.step ? line.curve(d3.curveStepAfter) : line.curve(d3.curveLinear))(s.points));
    (spec.legend || []).forEach((l, k) => g.append("text").attr("class", "legend-text").attr("x", w - 4).attr("y", 10 + 13 * k).attr("text-anchor", "end").text(l));
  }

  function drawProfiles() {
    const s = app.siteData, f = app.family, sec = s.section, n = sec.xy_km.length;
    const a = sec.xy_km[0], dist = sec.xy_km.map(p => Math.hypot(p[0] - a[0], p[1] - a[1]));
    const finite = sec.elevation_m.filter(Number.isFinite);
    profileChart($("#profile-section"), {
      xDomain: [0, dist[n - 1]], yDomain: [Math.min(...finite) - 40, Math.max(...finite) + 60], xLabel: "distance from A [km]", yLabel: "elevation [m]",
      bands: s.segments.map(g => ({ from: g.from_km, to: g.from_km + g.length_m / 1000, label: String(g.number), number: g.number, on: g.number === s.segment.number })),
      series: [{ cls: "terrain", points: dist.map((d, k) => [d, sec.elevation_m[k]]) },
               { cls: "terrain on", points: s.segment.distance_m.map((d, k) => [s.segments[s.segment.number - 1].from_km + d / 1000, s.segment.elevation_m[k]]) }],
    });
    const top = f.terrain.top_elevation_m, stairs = f.surface_index.map((r, c) => [c * f.grid.dx / 1000, top - r * f.grid.dz]);
    const segE = s.segment.elevation_m;
    profileChart($("#profile-segment"), {
      xDomain: [0, s.segment.length_m / 1000], yDomain: [Math.min(...segE, ...stairs.map(p => p[1])) - 20, top + 30],
      xLabel: "distance along segment 3 [km]", yLabel: "elevation [m]",
      series: [{ cls: "stairs", step: true, points: stairs }, { cls: "terrain on thin", points: s.segment.distance_m.map((d, k) => [d / 1000, segE[k]]) }],   // the DEM on top
      legend: ["blue: grid surface (whole rows)", "orange: terrain (DEM)"],
    });
  }

  // ---------------------------------------------------------------- the opening: from the globe into the relief
  const ALL_LAYERS = { terrain: true, section: true, faults: true, planes: true, zones: true, urban: true, receivers: true, rupture: true, footprint: true };
  const LIFT_LAYERS = { section: false, faults: false, planes: false, zones: false, urban: false, receivers: false, rupture: false, footprint: false };
  const BARE_RELIEF = { ...LIFT_LAYERS, terrain: true };
  // the district's relief as the globe shows it: the map palette, the hillshade, the baked sun and sky (half resolution)
  function patchCanvas(images, palette = "map") {
    const w = Math.round(images.hillshade.width / 2), h = Math.round(images.hillshade.height / 2);
    const read = img => { const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); g.drawImage(img, 0, 0, w, h); return g.getImageData(0, 0, w, h).data; };
    const shade = read(images.hillshade), esk = read(images.elevation), ramp = Site.ramp(palette), lut = d3.range(256).map(k => d3.rgb(ramp(k / 255)));
    const out = document.createElement("canvas"); out.width = w; out.height = h;
    const g = out.getContext("2d"), img = g.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const p = 4 * i, c = lut[esk[p]], s = 0.42 + 0.70 * shade[p] / 255, sun = esk[p + 1] / 255, sky = 0.55 + 0.45 * esk[p + 2] / 255;
      const tint = [0.62 + 0.38 * sun, 0.66 + 0.34 * sun, 0.80 + 0.20 * sun];
      img.data[p] = Math.min(255, c.r * s * tint[0] * sky); img.data[p + 1] = Math.min(255, c.g * s * tint[1] * sky); img.data[p + 2] = Math.min(255, c.b * s * tint[2] * sky); img.data[p + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return out;
  }
  // the dive: the globe's camera flies down (log distance) onto the very pose the map stage starts from, the stages swap in
  // a third of a second (the patch on the globe and the relief coincide), and the relief rises from flat to ×1.5 while the
  // map flies out to the whole district; the layers and labels come once the ground has risen
