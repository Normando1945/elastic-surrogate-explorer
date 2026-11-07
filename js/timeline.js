// Surrogate Explorer · timeline.js — the play bar under the scene, for the chapters that animate something in time.
//
// Timeline.use({duration, onTime, label, speeds, speed, loop}) takes the bar over for one chapter; Timeline.release()
// hides it. Space plays and pauses while it is shown. onTime(t) is called on every frame while playing and on scrubbing.
(function () {
  "use strict";
  const $ = s => document.querySelector(s);
  const state = { spec: null, t: 0, playing: false, speed: 1, last: 0, raf: null, touched: false };

  function fmt(t) { return `${t.toFixed(2)} s`; }
  function paint() {
    const s = state.spec; if (!s) return;
    $("#tl-slider").value = String(Math.round(state.t / s.duration * 1000));
    $("#tl-time").textContent = fmt(state.t);
    $("#tl-play").textContent = state.playing ? "❚❚" : "▶";
    $("#tl-play").setAttribute("aria-label", state.playing ? "Pause" : "Play");
  }
  function seek(t, notify = true) {
    const s = state.spec; if (!s) return;
    state.t = Math.min(Math.max(t, 0), s.duration);
    paint();
    if (notify) s.onTime(state.t);
  }
  function tick(now) {
    if (!state.playing) return;
    const dt = Math.min((now - state.last) / 1000, 0.1) * state.speed;
    state.last = now;
    let t = state.t + dt;
    if (t >= state.spec.duration) {
      if (state.spec.loop) t = 0; else { seek(state.spec.duration); pause(); return; }
    }
    seek(t);
    state.raf = requestAnimationFrame(tick);
  }
  function play() {
    if (!state.spec || state.playing) return;
    if (state.t >= state.spec.duration - 1e-6) seek(0);
    state.playing = true; state.last = performance.now(); paint();
    state.raf = requestAnimationFrame(tick);
  }
  function pause() { state.playing = false; cancelAnimationFrame(state.raf); state.touched = true; paint(); }
  // a chapter starts its bar by itself a moment after it opens, unless the visitor (or a test) already played or paused it
  // nothing plays by itself for a visitor who asked the system for less motion: ▶ is one click away
  function autoplay(stillHere, ms) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    setTimeout(() => { if (state.spec && !state.touched && stillHere()) play(); }, ms);
  }

  function use(spec) {
    pause();
    state.spec = { loop: false, speeds: [1], label: "time", ...spec };
    state.speed = spec.speed || state.spec.speeds[0];
    $("#tl-label").textContent = state.spec.label;
    $("#tl-max").textContent = fmt(state.spec.duration);
    $("#tl-speed").innerHTML = state.spec.speeds.length > 1
      ? state.spec.speeds.map(v => `<button type="button" class="chip small" data-speed="${v}" aria-pressed="${v === state.speed}">${v}×</button>`).join("") : "";
    $("#timeline").hidden = false;
    document.body.classList.add("has-timeline");
    state.touched = false;
    seek(spec.start ?? 0);
  }
  function release() { pause(); state.spec = null; $("#timeline").hidden = true; document.body.classList.remove("has-timeline"); }

  function init() {
    $("#tl-play").addEventListener("click", () => { state.playing ? pause() : play(); state.touched = true; });
    $("#tl-slider").addEventListener("input", e => { pause(); seek(Number(e.target.value) / 1000 * state.spec.duration); });
    $("#tl-speed").addEventListener("click", e => {
      const b = e.target.closest("[data-speed]"); if (!b) return;
      state.speed = Number(b.dataset.speed);
      $("#tl-speed").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    });
    document.addEventListener("keydown", e => {
      if (!state.spec || e.key !== " " || e.target.closest("input, select, textarea")) return;
      e.preventDefault();                                              // a focused button must not be "pressed" by Space
      if (e.target.closest("button")) e.target.blur();
      state.playing ? pause() : play();
      state.touched = true;
    });
  }

  window.Timeline = { init, use, release, play, pause, seek, autoplay,
                      get time() { return state.t; }, get playing() { return state.playing; }, get active() { return !!state.spec; } };
})();
