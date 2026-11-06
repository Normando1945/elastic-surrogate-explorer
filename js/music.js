// Surrogate Explorer · music.js — "Filaments" by Scott Buckley (CC BY 4.0, www.scottbuckley.com.au), under the page.
//
// Quiet (as in the team's OSM Explorer), looped, fading in and out. Browsers refuse sound before the visitor's first
// gesture, so it starts with the first click or key (usually Start on the cover); the ♪ button (or M) turns it off and
// on, and the page remembers that choice. It pauses while the tab is hidden. The 4 MB file is only fetched to play.
(function () {
  "use strict";
  const SRC = "audio/filaments.mp3", VOLUME = 0.06, FADE_MS = 2500, KEY = "explorer-music";
  let audio = null, on = false, fade = 0;

  const wanted = () => { try { return localStorage.getItem(KEY) !== "off"; } catch (e) { return true; } };
  function remember(value) { try { localStorage.setItem(KEY, value ? "on" : "off"); } catch (e) { /* private mode */ } }
  function mark() {
    const b = document.getElementById("music-btn");
    if (b) { b.setAttribute("aria-pressed", String(on)); b.title = on ? "Music: on (M)" : "Music: off (M)"; }
  }
  function fadeTo(target, then) {
    clearInterval(fade);                                              // (a timer, not frames: it must finish in a hidden tab too)
    const from = audio.volume, t0 = performance.now();
    fade = setInterval(() => {
      const u = Math.min(1, (performance.now() - t0) / FADE_MS);
      audio.volume = from + (target - from) * u;
      if (u >= 1) { clearInterval(fade); if (then) then(); }
    }, 50);
  }
  function play() {
    if (!audio) { audio = new Audio(SRC); audio.loop = true; audio.volume = 0; }
    on = true; mark();
    return audio.play().then(() => fadeTo(VOLUME), error => { on = false; mark(); throw error; });
  }
  function stop() {
    on = false; mark();
    if (audio && !audio.paused) fadeTo(0, () => { if (!on) audio.pause(); });
  }
  function toggle() { if (on) { stop(); remember(false); } else { remember(true); play().catch(() => {}); } }

  function init() {
    const b = document.getElementById("music-btn");
    if (b) b.addEventListener("click", toggle);
    mark();
    document.addEventListener("keydown", e => {
      if (e.target.closest("input, select, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "m" || e.key === "M") { e.preventDefault(); toggle(); }
    });
    document.addEventListener("visibilitychange", () => {
      if (!audio || !on) return;
      if (document.hidden) audio.pause(); else audio.play().catch(() => {});
    });
    if (!wanted()) return;
    // the first gesture (not the ♪ button itself, which decides on its own)
    const first = e => {
      if (e.target.closest && e.target.closest("#music-btn")) return;
      if (e.type === "keydown" && (e.key === "m" || e.key === "M")) return;
      removeEventListener("pointerdown", first, true); removeEventListener("keydown", first, true);
      if (!on && wanted()) play().catch(() => {});
    };
    addEventListener("pointerdown", first, true); addEventListener("keydown", first, true);
  }

  window.Music = { init, toggle, get on() { return on; }, get playing() { return !!audio && !audio.paused; }, get volume() { return audio ? audio.volume : 0; } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
