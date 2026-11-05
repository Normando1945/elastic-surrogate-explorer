// Surrogate Explorer · story.js — the chapters around the one scene: navigation, progress, menu, tour, cover, the URL.
//
// A chapter is {id, title, enter(), leave()} plus a <section class="chapter" data-chapter="id"> in the panel.
// The URL is "#<chapter>?<view params>" (#receiver?seed=81&rx=20&theme=dark); no hash, or #cover, is the cover.
// Keys: ← → chapters · T tour · O orbit · H fold the panel · F full screen · Esc the cover.
(function () {
  "use strict";
  const TOUR_DWELL_MS = 11000;
  const ALIASES = { segment: "quake" };                              // chapters merged since: their old links still land
  const $ = s => document.querySelector(s);
  const state = { chapters: [], index: -1, params: new URLSearchParams(), cover: true, tourTimer: null, hooks: {} };

  function parseHash() {
    const raw = decodeURIComponent(location.hash.slice(1));
    if (!raw) return { id: "cover", params: new URLSearchParams() };
    const [head, query = ""] = raw.split("?");
    if (head.includes("=")) return { id: null, params: new URLSearchParams(head) };   // the pilot's links: #seed=81&rx=20
    return { id: ALIASES[head] || head, params: new URLSearchParams(query) };
  }
  function writeHash() {
    const id = state.cover ? "cover" : state.chapters[state.index].id, query = state.params.toString();
    history.replaceState(null, "", `#${id}${query ? "?" + query : ""}`);
  }

  function renderChrome() {
    $("#progress").innerHTML = state.chapters.map((c, k) => `<button type="button" data-k="${k}" title="${c.title}" aria-label="${c.title}"></button>`).join("");
    $("#progress").querySelectorAll("button").forEach(b => b.addEventListener("click", () => { stopTour(); go(Number(b.dataset.k)); }));
    $("#chapter-menu").innerHTML = state.chapters.map((c, k) =>
      `<li><button type="button" data-k="${k}"><span class="n">${k + 1}</span>${c.title}</button></li>`).join("");
    $("#chapter-menu").querySelectorAll("button").forEach(b => b.addEventListener("click", () => { stopTour(); toggleMenu(false); go(Number(b.dataset.k)); }));
  }

  function mark() {
    const k = state.index;
    $("#progress").querySelectorAll("button").forEach((b, j) => { b.classList.toggle("done", j < k); b.classList.toggle("on", j === k); });
    $("#chapter-menu").querySelectorAll("button").forEach((b, j) => b.setAttribute("aria-current", String(j === k)));
    document.querySelectorAll(".chapter").forEach(s => { s.hidden = s.dataset.chapter !== state.chapters[k].id; });
    document.body.classList.toggle("wide-panel", !!state.chapters[k].wide);   // chart-heavy chapters get a wider panel
    $("#panel-title").textContent = state.chapters[k].title;
    $("#prev").disabled = k === 0;
    const next = state.chapters[k + 1];
    $("#next").title = next ? next.title : "Cover";
    $("#panel-body").scrollTop = 0;
  }

  function go(target, opts = {}) {
    const k = typeof target === "number" ? target : state.chapters.findIndex(c => c.id === target);
    if (k < 0 || k >= state.chapters.length) return;
    hideCover(true);
    // back from the cover the chapter was left (showCover called its leave), so it is entered again even if it is the same
    if (k === state.index && !opts.force && !state.left) return;
    const leaving = state.chapters[state.index];
    if (leaving && leaving.leave && !state.left) leaving.leave();
    state.left = false;
    state.index = k;
    mark();
    const chapter = state.chapters[k];
    if (chapter.enter) chapter.enter(opts);
    writeHash();
    if (state.hooks.change) state.hooks.change(chapter);
  }
  const next = () => (state.index + 1 < state.chapters.length ? go(state.index + 1) : showCover());
  const prev = () => go(Math.max(0, state.index - 1));

  function showCover() {
    stopTour();
    toggleMenu(false);
    const current = state.chapters[state.index];
    if (current && current.leave && !state.left && !state.cover) { current.leave(); }
    if (current) state.left = true;                                     // Start enters it again, whatever it left on screen
    state.cover = true;
    $("#cover").hidden = false; document.body.classList.add("on-cover");
    writeHash();
    if (state.hooks.cover) state.hooks.cover(true);
    setTimeout(() => $("#cover-start").focus({ preventScroll: true }), 50);   // on a phone, keep the title in view
  }
  function hideCover(silent) {
    if (!state.cover) return;
    state.cover = false;
    $("#cover").hidden = true; document.body.classList.remove("on-cover");
    if (state.hooks.cover) state.hooks.cover(false);
    if (!silent) writeHash();
  }

  function toggleMenu(open) {
    const menu = $("#menu"), on = open ?? menu.hidden;
    menu.hidden = !on; $("#menu-btn").setAttribute("aria-expanded", String(on));
  }

  function startTour() {
    stopTour();
    $("#tour-btn").classList.add("on"); $("#tour-btn").setAttribute("aria-pressed", "true");
    go(0, { force: true });                                           // the tour is the whole story, from its first chapter
    const step = () => {
      state.tourTimer = setTimeout(() => {
        if (state.index + 1 >= state.chapters.length) { stopTour(); return; }
        go(state.index + 1);
        step();
      }, dwell(state.chapters[state.index]));
    };
    step();
  }
  // how long the tour stays: the time to read the chapter's prose (5 s + 240 ms a word, 9–24 s, as the SRF Explorer
  // does), and never less than an animated chapter asks for
  function dwell(chapter) {
    const section = document.querySelector(`.chapter[data-chapter="${chapter.id}"]`);
    const words = section ? [...section.querySelectorAll("p")].reduce((n, p) => n + p.textContent.split(/\s+/).filter(Boolean).length, 0) : 0;
    const reading = words ? Math.min(24000, Math.max(9000, 5000 + 240 * words)) : TOUR_DWELL_MS;
    return Math.max(reading, chapter.dwell || 0);
  }
  function stopTour() {
    clearTimeout(state.tourTimer); state.tourTimer = null;
    $("#tour-btn").classList.remove("on"); $("#tour-btn").setAttribute("aria-pressed", "false");
  }
  const touring = () => state.tourTimer !== null;
  // any interaction of the visitor pauses the tour, and says so (as the SRF Explorer does)
  function pauseTour() {
    if (!touring()) return;
    stopTour();
    const t = $("#toast"); if (!t) return;
    t.textContent = "Tour paused · ▶ Tour to continue"; t.hidden = false;
    clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }

  function fold(on) {
    const folded = on ?? !document.body.classList.contains("panel-folded");
    document.body.classList.toggle("panel-folded", folded);
    $("#fold").setAttribute("aria-expanded", String(!folded));
    $("#fold").textContent = folded ? "▾" : "▴";
    if (state.hooks.fold) state.hooks.fold(folded);
  }

  function fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
  }

  function init(chapters, hooks) {
    state.chapters = chapters; state.hooks = hooks || {};
    renderChrome();
    $("#prev").addEventListener("click", () => { stopTour(); prev(); });
    $("#next").addEventListener("click", () => { stopTour(); next(); });
    $("#fold").addEventListener("click", () => fold());
    $("#menu-btn").addEventListener("click", () => toggleMenu());
    $("#tour-btn").addEventListener("click", () => (touring() ? stopTour() : startTour()));
    $("#cover-btn").addEventListener("click", showCover);
    $("#cover-start").addEventListener("click", () => go(state.index < 0 ? 0 : state.index, { force: state.index < 0 }));
    // a hash typed or pasted by hand (replaceState, which the page uses itself, never fires this)
    addEventListener("hashchange", () => {
      const { id, params } = parseHash();
      // a typo (#quitto?…) changes nothing: the page keeps its chapter and view, and the URL shows them again
      if (id !== "cover" && id !== null && !state.chapters.some(c => c.id === id)) { writeHash(); return; }
      state.params = params;
      if (state.hooks.params) state.hooks.params(params);
      if (id === "cover") showCover(); else go(id === null ? "receiver" : id, { force: true });
    });
    $("#fs-btn").addEventListener("click", fullscreen);
    document.addEventListener("click", e => { if (!$("#menu").hidden && !e.target.closest("#menu, #menu-btn")) toggleMenu(false); });
    document.addEventListener("keydown", e => {
      if (e.target.closest("input, select, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
      if (state.cover) {
        if (e.key === "Enter" || e.key === "ArrowRight") { e.preventDefault(); go(state.index < 0 ? 0 : state.index, { force: state.index < 0 }); }
        return;
      }
      // Esc closes what floats first (the menu, then whatever the page reports through hooks.escape), then the cover
      const escape = () => (!$("#menu").hidden ? toggleMenu(false) : state.hooks.escape && state.hooks.escape() ? null : showCover());
      const keys = { ArrowRight: () => { stopTour(); next(); }, ArrowLeft: () => { stopTour(); prev(); }, t: () => (touring() ? stopTour() : startTour()),
                     h: () => fold(), f: fullscreen, Escape: escape, o: () => state.hooks.orbit && state.hooks.orbit() };
      const action = keys[e.key] || keys[e.key.toLowerCase()];
      if (action) { e.preventDefault(); action(); }
    });
    const { id, params } = parseHash();
    state.params = params;
    if (id === null) return { start: "receiver", params };          // an old pilot link opens its receiver
    return { start: id, params };
  }

  window.Story = {
    init, go, next, prev, showCover, hideCover, startTour, stopTour, pauseTour, fold, dwell,
    get chapter() { return state.chapters[state.index]; }, get onCover() { return state.cover; }, get touring() { return touring(); },
    get params() { return state.params; },
    setParams(values) { for (const [k, v] of Object.entries(values)) { if (v === null || v === undefined) state.params.delete(k); else state.params.set(k, v); } writeHash(); },
  };
})();
