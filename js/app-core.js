// Surrogate Explorer · app-core.js — shared application state, theme and scene stages.
// Split from app.js; this remains a classic script so the public builder can version every file independently.
"use strict";

  const FIELDS = {
    vp: { label: "Vp", unit: "m/s", channel: 0, cmap: () => d3.interpolateViridis },
    vs: { label: "Vs", unit: "m/s", channel: 1, cmap: () => d3.interpolateViridis },
    rho: { label: "ρ", unit: "kg/m³", channel: 2, cmap: () => d3.interpolateCividis },
  };
  const DEPTHS = [{ m: Infinity, label: "Full · 6 km" }, { m: 2000, label: "Top 2 km" }, { m: 1000, label: "Top 1 km" }];
  const $ = sel => document.querySelector(sel);
  const app = { userOpacity: 1, ready: false, family: null, index: null, medium: null, seed: null, rx: 19, field: "vs", depth: Infinity, waveComp: "vz",
                theme: "dark", timings: {}, errors: [], lastRender: null, networkReady: null, labelSize: new Map() };
  window.__app = app;

  // ---------------------------------------------------------------- theme
  function themeTokens() {
    const css = getComputedStyle(document.documentElement), get = n => css.getPropertyValue(n).trim();
    return { viewport: get("--view"), accent: get("--accent"), ink: get("--ink") };
  }
  function storedTheme() { try { return localStorage.getItem("explorer-theme"); } catch (e) { return null; } }
  function applyTheme(name, persist = true) {
    app.theme = name === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = app.theme;
    if (persist) { try { localStorage.setItem("explorer-theme", app.theme); } catch (e) { /* private mode */ } }
    if (app.scene) app.scene.setTheme(themeTokens());
    if (app.globe) app.globe.redraw();
    if (app.earth) app.earth.paint().catch(fail);
    if (app.site) app.site.setTheme(app.theme);
    if (typeof Network !== "undefined") Network.setTheme(app.theme);
    if (app.medium && Story.chapter && Story.chapter.id === "receiver") showReceiver(app.rx);
    if (Story.chapter && Story.chapter.id === "cpml" && CPML.ready) { CPML.redraw(); CPML.draw(Timeline.time || 0); }
  }

  // ---------------------------------------------------------------- status
  function status(text, fraction) {
    $("#status").hidden = !text;
    $("#status-text").textContent = text || "";
    $("#status-track").hidden = fraction == null;
    $("#status-bar").style.width = fraction == null ? "0" : `${Math.round(fraction * 100)}%`;
  }
  function fail(error) {
    console.error(error);
    app.errors.push(String(error && error.message || error));
    status(`Something went wrong: ${error.message || error}`, null);
  }

  // ---------------------------------------------------------------- layout: tell the stages what the panels cover
  function updateInset() {
    if (!app.scene) return;
    const W = innerWidth, H = innerHeight, panel = $("#panel").getBoundingClientRect(), top = $(".top").getBoundingClientRect();
    const narrow = W <= 860, bar = document.body.classList.contains("has-timeline") ? $("#timeline").getBoundingClientRect() : null;
    // what covers the bottom: the play bar when it is up, else the panel (phone) or the corner globe (a narrow desktop)
    const lowest = Math.min(narrow ? panel.top : H - 24, bar ? bar.top - 4 : H);
    const corner = !narrow && W - panel.left + 8 > W * 0.42 ? 180 : 0;
    // the cover keeps the chapters' inset (its panel is only transparent there): the Earth's cover pose is framed for it,
    // so Start's pull-back to the whole Earth starts without a jump
    const inset = narrow ? { left: 0, right: 0, top: top.bottom + 8, bottom: H - lowest + 8 }
      : { left: 0, right: document.body.classList.contains("panel-folded") ? 0 : W - panel.left + 8, top: top.bottom + 40, bottom: Math.max(H - lowest + 8, corner) };
    app.scene.setInset(inset);
    if (typeof Network !== "undefined") Network.setInset(inset);         // the film's scene frames the free area too
    for (const stage of [app.earth, app.site]) if (stage) stage.setInset(inset);
  }

  // the Earth's sunlight: the story's afternoon or now; the note says where the sun stands overhead and when
  function markSun() {
    if (!app.earth) return;
    const s = app.earth.sun, t = new Date(s.instant), deg = (v, p, n) => `${Math.abs(v).toFixed(1)}° ${v >= 0 ? p : n}`;
    document.querySelectorAll("[data-sun]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.sun === s.mode)));
    const when = s.mode === "now" ? `now, ${t.toISOString().slice(11, 16)} UTC` : "15:37 in Quito on an August afternoon";
    $("#sun-note").textContent = `The sun is overhead at ${deg(s.lat, "N", "S")}, ${deg(s.lon, "E", "W")}: ${when}.`;
  }

  // ---------------------------------------------------------------- stages: Earth, Quito, the block (cross-faded)
  const STAGE_IDS = { earth: "#earth-stage", site: "#site-stage", block: "#scene", net: "#net-stage", cpml: "#cpml-stage" };
  function setStage(name) {
    if (app.stage === name) return;
    app.stage = name;
    for (const [key, id] of Object.entries(STAGE_IDS)) $(id).classList.toggle("on", key === name);
    if (app.earth) app.earth.setActive(name === "earth");
    if (app.site) app.site.setActive(name === "site");
    $("#site-labels").classList.toggle("off", name !== "site");
    $("#hover").hidden = true;                                         // nothing of the previous stage stays on screen
    if (name !== "site") { $("#minimap").hidden = true; $("#globe").hidden = name === "net" || name === "cpml"; hideCard(); $("#dock").hidden = true; $("#tools-btn").setAttribute("aria-expanded", "false"); }   // the film needs its corner
    if (name !== "block") $("#rx-label").hidden = true;
    document.body.dataset.stage = name;
    wakeHint();
    applyOrbit();
  }
  // the controls' hint: full for a few seconds on each new stage, then faint (the first drag or wheel dims it at once)
  let hintTimer = 0;
  function wakeHint() {
    document.body.classList.remove("hint-dim"); clearTimeout(hintTimer);
    hintTimer = setTimeout(() => document.body.classList.add("hint-dim"), 7000);
  }
  function orbitWanted() { return $("#orbit-btn").getAttribute("aria-pressed") === "true"; }
  // a visitor who asked the system for less motion gets no camera that turns by itself (the Orbit button still works)
  const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  function autoOrbit() { if (!calm()) setOrbitButton(true); }
  function applyOrbit() {
    const on = orbitWanted() || (Story.onCover && !calm());
    if (app.scene) app.scene.setOrbit(on && app.stage === "block");
    if (app.site) app.site.setOrbit(on && app.stage === "site");
    if (app.earth) app.earth.setOrbit(on && app.stage === "earth");
  }

  // ---------------------------------------------------------------- medium
