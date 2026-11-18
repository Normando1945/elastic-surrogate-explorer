// Surrogate Explorer · viewcube.js — a view cube for the 3D stages, after Revit's ViewCube.
//
// A small cube in the top-right corner of the free area turns with the stage's camera. Its faces (TOP, BOTTOM, FRONT,
// BACK, LEFT, RIGHT), its 12 edges and 8 corners are 26 views: a click turns the camera to look from there, keeping
// its target and distance. The compass ring under it (N, E, S, W) turns to that side at the present elevation, and the
// house goes back to the chapter's own view. The stages share one convention: X east, Y up, Z south, so FRONT is the
// south face (the map's usual side), RIGHT the east, BACK the north, LEFT the west.
//
// A stage plugs in as a provider: { dir(): Vector3 (target -> camera, unit), go(dir: Vector3), home() }; none hides
// the cube (the globe, the network's scripted film, the CPML films).
(function () {
  "use strict";
  const SIZE = 118;                                                  // the canvas [CSS px]
  const EDGE = 0.16;                                                 // the band of a face that means its edge or corner
  const FACES = [                                                    // BoxGeometry's material order: +X, -X, +Y, -Y, +Z, -Z
    { label: "RIGHT", v: [1, 0, 0] }, { label: "LEFT", v: [-1, 0, 0] }, { label: "TOP", v: [0, 1, 0] },
    { label: "BOTTOM", v: [0, -1, 0] }, { label: "FRONT", v: [0, 0, 1] }, { label: "BACK", v: [0, 0, -1] }];
  const COMPASS = [["N", [0, 0, -1]], ["E", [1, 0, 0]], ["S", [0, 0, 1]], ["W", [-1, 0, 0]]];
  const THEMES = { dark: { face: "#d9d6d0", ink: "#3a3a3e", edge: "#9a978f", ring: "#cfccc6", ringInk: "#2c2c30", hi: "#4f8fe6" },
                   light: { face: "#eeece8", ink: "#45454a", edge: "#a9a69f", ring: "#d8d5cf", ringInk: "#35353a", hi: "#3f7fd6" } };

  function faceTexture(label, th) {
    const c = document.createElement("canvas"); c.width = c.height = 128;
    const g = c.getContext("2d");
    g.fillStyle = th.face; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = th.edge; g.lineWidth = 6; g.strokeRect(3, 3, 122, 122);
    g.fillStyle = th.ink; g.font = `600 ${label.length > 5 ? 21 : 24}px system-ui, -apple-system, Segoe UI, sans-serif`;
    g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(label, 64, 66);
    const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t;
  }
  function letterTexture(letter, th) {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d");
    g.fillStyle = th.ringInk; g.font = "800 46px system-ui, -apple-system, Segoe UI, sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(letter, 32, 34);
    return new THREE.CanvasTexture(c);
  }

  function create(host) {
    const box = document.createElement("div"); box.className = "viewcube"; box.hidden = true;
    box.innerHTML = `<button type="button" class="vc-home" title="Back to this chapter's view" aria-label="Back to this chapter's view">⌂</button>`;
    host.appendChild(box);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setSize(SIZE, SIZE);
    renderer.domElement.setAttribute("aria-label", "View cube: click a face, an edge or a corner to look from there");
    box.appendChild(renderer.domElement);
    const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1.1, 1.1, 1.1, -1.1, 0.1, 20);
    scene.add(new THREE.AmbientLight(0xffffff, 0.78)); const sun = new THREE.DirectionalLight(0xffffff, 0.4); sun.position.set(-1, 2, 1.5); scene.add(sun);
    const state = { provider: null, theme: "dark", hover: null, last: new THREE.Vector3(), raf: 0, cube: null, ring: null, letters: [] };

    // ---------------------------------------------------------------- the model
    const hiMat = new THREE.MeshBasicMaterial({ color: THEMES.dark.hi, transparent: true, opacity: 0.75, depthTest: true });
    const hi = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), hiMat); hi.visible = false; scene.add(hi);
    function build() {
      const th = THEMES[state.theme];
      for (const o of [state.cube, state.ring, ...state.letters]) if (o) { scene.remove(o); o.geometry.dispose(); [].concat(o.material).forEach(m => { if (m.map) m.map.dispose(); m.dispose(); }); }
      state.cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), FACES.map(f => new THREE.MeshLambertMaterial({ map: faceTexture(f.label, th) })));
      scene.add(state.cube);
      state.ring = new THREE.Mesh(new THREE.RingGeometry(0.74, 0.9, 64), new THREE.MeshBasicMaterial({ color: th.ring, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
      state.ring.rotation.x = -Math.PI / 2; state.ring.position.y = -0.52; scene.add(state.ring);
      state.letters = COMPASS.map(([letter, v]) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.34), new THREE.MeshBasicMaterial({ map: letterTexture(letter, th), transparent: true, side: THREE.DoubleSide }));
        m.rotation.x = -Math.PI / 2; m.position.set(v[0] * 0.82, -0.51, v[2] * 0.82); m.userData.compass = new THREE.Vector3(...v);
        scene.add(m); return m;
      });
      hiMat.color.set(th.hi);
    }
    build();

    // the region under a point of the cube's surface: a face, an edge or a corner, as a vector in {-1, 0, 1}^3
    function region(p) {
      const v = [p.x, p.y, p.z].map(c => (Math.abs(c) > 0.5 - EDGE ? Math.sign(c) : 0));
      return v.some(Boolean) ? new THREE.Vector3(...v) : null;
    }
    function highlight(v) {
      state.hover = v;
      hi.visible = !!(v && !v.compass);
      if (hi.visible) {                                              // a slab just proud of the face, edge or corner
        const s = [v.x, v.y, v.z].map(c => (c ? EDGE + 0.012 : 1 - 2 * EDGE)), c = [v.x, v.y, v.z].map(k => k * (0.5 - EDGE / 2 + 0.006));
        hi.scale.set(...s); hi.position.set(...c);
      }
      state.letters.forEach(m => (m.material.opacity = v && v.compass && v.equals(m.userData.compass) ? 1 : 0.8));
      renderer.domElement.style.cursor = v ? "pointer" : "default";
      draw();
    }
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    function hit(e) {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const h = ray.intersectObjects([state.cube, ...state.letters], false)[0];
      if (!h) return null;
      if (h.object.userData.compass) { const v = h.object.userData.compass.clone(); v.compass = true; return v; }
      return region(h.point);
    }

    // ---------------------------------------------------------------- following the stage's camera
    function draw() {
      if (!state.provider) return;
      const d = state.provider.dir();
      camera.position.copy(d).multiplyScalar(5); camera.up.set(0, 1, 0); camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      state.last.copy(d);
    }
    function loop() {
      state.raf = requestAnimationFrame(loop);
      if (!state.provider || box.hidden) return;
      if (state.provider.dir().distanceToSquared(state.last) > 1e-9) draw();
    }
    // a click: the camera looks from there (a compass letter: from that side, at the present elevation)
    function look(v) {
      if (!state.provider || !v) return;
      let d;
      if (v.compass) {
        const el = Math.asin(Math.max(-1, Math.min(1, state.provider.dir().y)));
        d = new THREE.Vector3(v.x * Math.cos(el), Math.sin(el), v.z * Math.cos(el));
      } else d = new THREE.Vector3(v.x, v.y, v.z).normalize();
      if (Math.abs(d.y) > 0.999) d.set(0, Math.sign(d.y), 0.002).normalize();   // straight up or down: keep north up the screen
      state.provider.go(d);
    }
    renderer.domElement.addEventListener("pointermove", e => { const v = hit(e); if (!(v && state.hover && v.equals(state.hover) && !!v.compass === !!state.hover.compass)) highlight(v); });
    renderer.domElement.addEventListener("pointerleave", () => highlight(null));
    renderer.domElement.addEventListener("click", e => look(hit(e)));
    box.querySelector(".vc-home").addEventListener("click", () => state.provider && state.provider.home());

    return {
      // provider or null (hides the cube)
      attach(provider) { state.provider = provider || null; box.hidden = !provider; if (provider) { draw(); if (!state.raf) loop(); } },
      setTheme(name) { state.theme = name === "light" ? "light" : "dark"; build(); draw(); },
      place({ top, right }) { box.style.top = `${Math.round(top)}px`; box.style.right = `${Math.round(right)}px`; },
      look: v => look(Object.assign(new THREE.Vector3(...v), v.compass ? { compass: true } : {})),   // for the tests
      get shown() { return !box.hidden; }, element: box, canvas: renderer.domElement,
    };
  }

  window.ViewCube = { create };
})();
