// Surrogate Explorer · scene.js — the section block in three.js (r128), as the viewer's isometric view draws it.
//
// Axes: X = distance along the section [m], Y = -depth [m] (up), Z = distance behind the section line [m]:
// Z = 0 is the back of the block, Z = thickness is the front face, where the 2D medium is.
//   * lid: the Copernicus swath of family.json (export_family.py), painted by its own normals against the viewer's
//     synthetic sun with the viewer's tan ramp (_LID_RELIEF_*), unlit, so it reads the same as in the desktop app;
//   * walls and floor: the body colour toned per face (_WALL_SHADES of the isometric view);
//   * front face: the medium itself, one quad per grid cell whose four corners are solid, coloured by the node at
//     its upper left (same rule as the viewer), from a DataTexture so switching vp / vs / rho is a texture upload;
//   * the rupture subsources (white) and the 39 trained receivers (accent), on the front face's plane;
//   * the block's world, as the map's: a transparent canvas over the stage's pool of light (style.css), a soft contact
//     shadow on the ground, walls lit by the lid's own sun, and on the front face a soft occlusion under every layer
//     interface (setFaceShade), so the medium reads as rock in a block and not as a flat picture.
(function () {
  "use strict";
  const BODY = [0xC4, 0xA4, 0x84].map(v => v / 255);                 // _SOLID_BODY_COLOR
  const SUN = normalize([-0.83, 0.23, -0.51]);                        // _LID_RELIEF_SUN, domain axes (x, y back->front, z down)
  const RELIEF_DARK = 0.24, RELIEF_LIGHT = 0.88, RELIEF_GAMMA = 1.25; // _LID_RELIEF_*
  // the walls, lit by the lid's own sun (SUN): sky light plus the sun on the faces turned to it, so the west wall (the
  // one the default view sees) reads lit and the east and back ones in shade; _WALL_SHADES was one tone for both sides
  const wallTone = n => 0.5 + 0.45 * Math.max(0, n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2]);
  const WALL = { back: wallTone([0, -1, 0]), west: wallTone([-1, 0, 0]), east: wallTone([1, 0, 0]), floor: 0.55 };
  const LIFT_CELLS = 1.5;                                             // markers stand this far in front of the front face
  const PICK_PX = 18;                                                 // a click this close to a receiver selects it

  function normalize(v) { const n = Math.hypot(...v); return v.map(x => x / n); }

  function circleTexture() {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.beginPath(); g.arc(32, 32, 28, 0, 2 * Math.PI); g.fill();
    return new THREE.CanvasTexture(c);
  }

  function create(container, family, theme) {
    const nx = family.grid.nx, nz = family.grid.nz, dx = family.grid.dx, dz = family.grid.dz;
    const lid = family.terrain.lid_z_m, layers = lid.length, thickness = family.terrain.thickness_m;
    const width = (nx - 1) * dx, fullDepth = (nz - 1) * dz, frontZ = thickness, liftZ = thickness + LIFT_CELLS * dx;
    const recX = family.receivers.x.map(i => i * dx), recY = family.receivers.z.map(k => -k * dz);

    // alpha: the stage's CSS pool of light (style.css, #scene) shows behind the block, as behind the map's
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e5, 1e5);
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.12; controls.screenSpacePanning = true;
    controls.minPolarAngle = 0.15; controls.maxPolarAngle = Math.PI / 2 + 0.05;
    const circle = circleTexture();

    const state = { floor: fullDepth, mask: null, texture: null, selected: -1, hover: -1, onPick: null, onHover: null,
                    ruptureTime: null, ruptureIdx: [], hypocenter: null, showHypocenter: false, lift: null, onTop: false,
                    group: new THREE.Group(), markers: null, selectedMarker: null, leader: null, rupture: null, front: null, lidMesh: null };
    scene.add(state.group);

    // ---------------------------------------------------------------- lid and walls
    function lidMesh(floor) {
      const pos = new Float32Array(layers * nx * 3), col = new Float32Array(layers * nx * 3);
      const zOf = j => j / (layers - 1) * thickness;
      const depth = (j, i) => Math.min(lid[j][i], floor);
      for (let j = 0; j < layers; j++) for (let i = 0; i < nx; i++) {
        const p = (j * nx + i) * 3;
        pos[p] = i * dx; pos[p + 1] = -depth(j, i); pos[p + 2] = zOf(j);
        // normal of the depth field z(x, y): (dz/dx, dz/dy, -1) in domain axes (z down), normalized
        const i0 = Math.max(i - 1, 0), i1 = Math.min(i + 1, nx - 1), j0 = Math.max(j - 1, 0), j1 = Math.min(j + 1, layers - 1);
        const gx = (depth(j, i1) - depth(j, i0)) / ((i1 - i0) * dx), gy = (depth(j1, i) - depth(j0, i)) / (zOf(j1) - zOf(j0));
        const n = normalize([gx, gy, -1]);
        const shade = Math.pow(Math.max(0, n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2]), RELIEF_GAMMA);
        const tone = RELIEF_DARK + (RELIEF_LIGHT - RELIEF_DARK) * shade;
        col[p] = BODY[0] * tone; col[p + 1] = BODY[1] * tone; col[p + 2] = BODY[2] * tone;
      }
      const idx = [];
      for (let j = 0; j < layers - 1; j++) for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, b = a + 1, c = a + nx + 1, d = a + nx;
        idx.push(a, c, b, a, d, c);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      geo.setIndex(idx);
      return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    }

    function ruled(top, bottom, tone) {
      // two polylines of equal length -> a strip of quads
      const n = top.length, pos = new Float32Array(n * 2 * 3), idx = [];
      for (let k = 0; k < n; k++) { pos.set(top[k], k * 3); pos.set(bottom[k], (n + k) * 3); }
      for (let k = 0; k < n - 1; k++) idx.push(k, k + 1, n + k + 1, k, n + k + 1, n + k);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); geo.setIndex(idx);
      // a wall fades from a light rim under the lid to a darker foot, as the map's block does
      const col = new Float32Array(n * 2 * 3), hi = 1.12 * tone, lo = 0.62 * tone;
      for (let k = 0; k < n; k++) { col.set([BODY[0] * hi, BODY[1] * hi, BODY[2] * hi], k * 3); col.set([BODY[0] * lo, BODY[1] * lo, BODY[2] * lo], (n + k) * 3); }
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    }

    function walls(floor) {
      const group = new THREE.Group(), cut = v => -Math.min(v, floor);
      const xs = Array.from({ length: nx }, (_, i) => i * dx), zs = Array.from({ length: layers }, (_, j) => j / (layers - 1) * thickness);
      group.add(ruled(xs.map((x, i) => [x, cut(lid[0][i]), 0]), xs.map(x => [x, -floor, 0]), WALL.back));
      group.add(ruled(zs.map((z, j) => [0, cut(lid[j][0]), z]), zs.map(z => [0, -floor, z]), WALL.west));
      group.add(ruled(zs.map((z, j) => [width, cut(lid[j][nx - 1]), z]), zs.map(z => [width, -floor, z]), WALL.east));
      group.add(ruled([[0, -floor, 0], [width, -floor, 0]], [[0, -floor, thickness], [width, -floor, thickness]], WALL.floor));
      return group;
    }

    // ---------------------------------------------------------------- the ground: a soft contact shadow
    // A blurred dark rectangle on the ground under the block (or under the lowest layer when they are apart), thrown a
    // little toward the front and the east, away from the lid's sun: the block sits on something, it does not float.
    const shadowTex = (() => {
      const cv = document.createElement("canvas"); cv.width = cv.height = 256;
      const g = cv.getContext("2d"); g.filter = "blur(20px)"; g.fillStyle = "rgba(0,0,0,0.85)"; g.fillRect(50, 50, 156, 156);
      return new THREE.CanvasTexture(cv);
    })();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
                                  new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
    ground.renderOrder = -1; scene.add(ground);
    function placeGround(bottom) {                                     // bottom: the lowest y of what stands [m]
      const w = width * 1.3, d = thickness + 0.55 * width;
      ground.scale.set(w, 1, d);
      ground.position.set(width / 2 + 0.05 * width, bottom - 4, thickness / 2 + 0.16 * width);
      ground.material.opacity = theme.dark ? 0.85 : 0.42;
      requestRender();
    }

    // the front face's occlusion (aoMap, one value per cell; 1 = open): setFaceShade() gives it, white until then
    let shadeTex = null;
    function faceShade() {
      if (!shadeTex) {
        shadeTex = new THREE.DataTexture(new Uint8Array((nx - 1) * (nz - 1) * 4).fill(255), nx - 1, nz - 1, THREE.RGBAFormat);
        shadeTex.magFilter = shadeTex.minFilter = THREE.LinearFilter; shadeTex.generateMipmaps = false; shadeTex.needsUpdate = true;
      }
      return shadeTex;
    }
    function setFaceShade(shade) {                                      // Uint8Array (nz-1)*(nx-1), 255 = open; null = none
      const t = faceShade(), d = t.image.data;
      for (let i = 0, n = (nx - 1) * (nz - 1); i < n; i++) { const v = shade ? shade[i] : 255; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; }
      t.needsUpdate = true; requestRender();
    }

    // ---------------------------------------------------------------- front face (the medium)
    function frontMesh(floor) {
      const pos = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2);
      for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const p = k * nx + i;
        pos[p * 3] = i * dx; pos[p * 3 + 1] = -k * dz; pos[p * 3 + 2] = frontZ;
        uv[p * 2] = i / (nx - 1); uv[p * 2 + 1] = k / (nz - 1);
      }
      const m = state.mask, idx = [];
      const solid = (k, i) => m[k * nx + i] > 0.5;
      for (let k = 0; k < nz - 1; k++) {
        if ((k + 1) * dz > floor + 1e-6) break;
        for (let i = 0; i < nx - 1; i++) {
          if (!(solid(k, i) && solid(k + 1, i) && solid(k, i + 1) && solid(k + 1, i + 1))) continue;
          const a = k * nx + i;
          idx.push(a, a + nx, a + 1, a + 1, a + nx, a + nx + 1);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2)); geo.setAttribute("uv2", new THREE.BufferAttribute(uv, 2));   // aoMap reads uv2
      geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
      return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: state.texture, aoMap: faceShade(), aoMapIntensity: 1, side: THREE.DoubleSide }));
    }

    // the markers keep a fixed size on screen; on a narrow stage (a phone) the block is a few hundred pixels wide and the
    // 39 receivers would merge into one orange bar, so every marker shrinks with the stage (review 6)
    const markerScale = () => Math.min(1, Math.max(0.4, container.clientWidth / 1000));
    function points(xs, ys, z, size, color, colors) {
      size *= markerScale();
      const pos = new Float32Array(xs.length * 3);
      xs.forEach((x, k) => { pos[k * 3] = x; pos[k * 3 + 1] = ys[k]; pos[k * 3 + 2] = z; });
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      if (colors) geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const mat = new THREE.PointsMaterial({ size: size * renderer.getPixelRatio(), sizeAttenuation: false, map: circle,
                                             color: colors ? 0xffffff : color, vertexColors: !!colors, transparent: true, alphaTest: 0.5,
                                             depthTest: !state.onTop });
      const p = new THREE.Points(geo, mat);
      if (state.onTop) p.renderOrder = 10;
      return p;
    }

    // the rupture: white subsources; with a time set, the ones the rupture front has reached are lit in the accent
    function paintRupture() {
      if (!state.rupture) return;
      const col = state.rupture.geometry.attributes.color, lit = new THREE.Color(theme.accent), dim = new THREE.Color(theme.ink);
      state.ruptureIdx.forEach((i, k) => {
        const on = state.ruptureTime === null || family.rupture.activation_s[i] <= state.ruptureTime;
        const c = state.ruptureTime === null ? new THREE.Color(0xffffff) : on ? lit : dim.clone().multiplyScalar(0.55);
        col.setXYZ(k, c.r, c.g, c.b);
      });
      col.needsUpdate = true;
    }

    function rebuild() {
      for (const child of [...state.group.children]) { state.group.remove(child); child.traverse(o => { o.geometry && o.geometry.dispose(); }); }
      const floor = state.floor;
      state.lidMesh = lidMesh(floor); state.group.add(state.lidMesh);
      if (!st.on) placeGround(-floor);
      state.group.add(walls(floor));
      if (state.mask) { state.front = frontMesh(floor); state.group.add(state.front); }
      const keep = family.rupture.z.map((k, i) => k * dz <= floor ? i : -1).filter(i => i >= 0);
      state.ruptureIdx = keep;
      state.rupture = points(keep.map(i => family.rupture.x[i] * dx), keep.map(i => -family.rupture.z[i] * dz), liftZ, 5, null,
                             new Float32Array(keep.length * 3).fill(1));
      state.group.add(state.rupture);
      paintRupture();
      const [hx, hz] = family.source.hypocenter;
      state.hypocenter = hz * dz <= floor ? points([hx * dx], [-hz * dz], liftZ + 2, 12, new THREE.Color(theme.accent)) : null;
      if (state.hypocenter) { state.hypocenter.visible = state.showHypocenter; state.group.add(state.hypocenter); }
      if (state.lift) applyLift();
      state.rupture.visible = !fx.on;                                  // the source chapter draws its own, sized by weight
      if (fx.on) buildFx();
      drawMarkers();
    }

    // ---------------------------------------------------------------- the source chapter: the rupture drawn to be read
    // As the deck's slide 23 and its GIF: every subsource a disc sized by its share of the force ŵ_k (Eshelby, zero at the
    // tips), lit when the front reaches it at τ_k; each one, once lit, sends out a ring in the section plane (its copy of
    // the Ricker, leaving), and a wide ring rides the front down-dip. The camera frames the fault, not the whole block.
    const RING_S = 0.55, RING_V = 2200;                                // a ring lives 0.55 s and grows at 2.2 km/s (about Vs)
    const fx = { on: false, group: null, dots: [], rings: [], front: null, order: null };
    function buildFx() {
      if (fx.group) { state.group.remove(fx.group); fx.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }
      fx.group = new THREE.Group(); fx.dots = []; fx.rings = [];
      const r = family.rupture, wMax = Math.max(...r.weights), z = liftZ + 3, accent = new THREE.Color(theme.accent);
      r.x.forEach((xi, k) => {
        const x = xi * dx, y = -r.z[k] * dz, rad = 9 + 30 * r.weights[k] / wMax;
        const dot = new THREE.Mesh(new THREE.CircleGeometry(rad, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthTest: false }));
        dot.position.set(x, y, z); dot.renderOrder = 12; fx.group.add(dot); fx.dots.push(dot);
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.93, 1, 64), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0, depthTest: false, side: THREE.DoubleSide }));
        ring.position.set(x, y, z - 1); ring.renderOrder = 11; ring.visible = false; fx.group.add(ring); fx.rings.push(ring);
      });
      fx.front = new THREE.Mesh(new THREE.RingGeometry(46, 64, 48), new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.95, depthTest: false }));
      fx.front.position.z = z + 1; fx.front.renderOrder = 13; fx.group.add(fx.front);
      fx.order = r.activation_s.map((a, k) => k).sort((i, j) => r.activation_s[i] - r.activation_s[j]);
      state.group.add(fx.group); paintFx();
    }
    // where the front is at time t: between the last subsource it reached and the next one, in activation order
    function frontAt(t) {
      const r = family.rupture, o = fx.order, a = k => r.activation_s[k], p = k => new THREE.Vector3(r.x[k] * dx, -r.z[k] * dz, 0);
      if (t <= a(o[0])) return p(o[0]);
      for (let j = 1; j < o.length; j++) if (t < a(o[j])) return p(o[j - 1]).lerp(p(o[j]), (t - a(o[j - 1])) / Math.max(a(o[j]) - a(o[j - 1]), 1e-9));
      return p(o[o.length - 1]);
    }
    function paintFx() {
      if (!fx.group) return;
      const t = state.ruptureTime, r = family.rupture, wMax = Math.max(...r.weights);
      const lit = new THREE.Color(theme.accent), dim = new THREE.Color(theme.ink).lerp(new THREE.Color(theme.viewport), 0.45), white = new THREE.Color(0xffffff);   // a quiet grey in both themes
      r.activation_s.forEach((a, k) => {
        const on = t !== null && a <= t, age = t === null ? -1 : t - a;
        fx.dots[k].material.color.copy(t === null ? white : on ? lit : dim);
        const ring = fx.rings[k], show = on && age < RING_S;
        ring.visible = show;
        if (show) { const R = Math.max(1, RING_V * age); ring.scale.set(R, R, 1); ring.material.opacity = 0.85 * (0.25 + 0.75 * r.weights[k] / wMax) * (1 - age / RING_S); }
      });
      const end = Math.max(...r.activation_s);
      fx.front.visible = t !== null && t <= end + 0.15;
      if (fx.front.visible) { const f = frontAt(t); fx.front.position.x = f.x; fx.front.position.y = f.y; }
      requestRender();
    }
    function setSourceFx(on) {
      fx.on = !!on;
      if (state.rupture) state.rupture.visible = !fx.on;
      if (fx.on) buildFx(); else if (fx.group) { state.group.remove(fx.group); fx.group = null; }
      // the camera keeps the solver's pose, the whole block: the fault runs from 2.5 to 4.8 km deep, so a close-up on it cut
      // the block at the top bar and the floor, and showed the west wall edge-on; the same pose also carries the eye from
      // the rupture straight into the wave it makes in the next chapter
      state.focus = null;
      frame();
    }
    // ---------------------------------------------------------------- the medium chapter: the layers taken apart
    // As the viewer's STRATIGRAPHY tab (and the deck): every layer a solid of its own, extruded through the block's
    // thickness and pulled down by a gap, coloured by the chosen field; a click picks one (orange outline, the others
    // faded) and the page hangs its WAVE & MESH callout on it. Interfaces come from the layer of every grid node, smoothed
    // over 7 columns for the eye (the solver's staircase is a cell high and reads as noise at this scale).
    const st = { on: false, group: null, meshes: [], outline: null, iface: null, gap: 0, pick: -1, n: 0 };
    function strataInterfaces(map, n) {
      const iface = Array.from({ length: n + 1 }, () => new Float32Array(nx));   // rows: iface[k] = top of layer k
      for (let i = 0; i < nx; i++) {
        const lo = new Int32Array(n).fill(-1), hi = new Int32Array(n).fill(-1); let first = -1;
        for (let r = 0; r < nz; r++) { const k = map[r * nx + i]; if (k < 0) continue; if (first < 0) first = r; if (lo[k] < 0) lo[k] = r; hi[k] = r; }
        let cur = first < 0 ? 0 : first;
        iface[0][i] = cur;
        for (let k = 0; k < n; k++) { if (lo[k] >= 0) cur = Math.min(nz - 1, hi[k] + 1); iface[k + 1][i] = cur; }   // a pinched-out layer collapses onto its interface
      }
      const W = 3;
      const smooth = a => Float32Array.from(a, (_, i) => { let s = 0, c = 0; for (let j = Math.max(0, i - W); j <= Math.min(nx - 1, i + W); j++) { s += a[j]; c++; } return s / c; });
      const out = iface.map(smooth);
      for (let k = 1; k <= n; k++) for (let i = 0; i < nx; i++) out[k][i] = Math.max(out[k][i], out[k - 1][i]);   // never upside down
      return out;
    }
    // Each solid is lit, not flat: the top face runs from a lit front edge (a rim of light where it meets the front) to
    // a back in the shade of the slab above it, the front face is a touch brighter under its top than at its foot, and
    // the two ends take the lid's sun like the block's walls. Colours per vertex, so the shading is smooth.
    function layerSolid(k, color) {
      const top = st.iface[k], bot = st.iface[k + 1], dy = -k * st.gap, T = frontZ, pos = [], col = [];
      const c = new THREE.Color(color), tone = f => c.clone().multiplyScalar(f);
      // a quad with one tone per corner (a, b, cc, d)
      const quad = (a, b, cc, d, ta, tb = ta, tc = tb, td = ta) => {
        pos.push(...a, ...b, ...cc, ...a, ...cc, ...d);
        for (const t of [ta, tb, tc, ta, tc, td]) col.push(t.r, t.g, t.b);
      };
      const P = (i, rows, z) => [i * dx, -rows[i] * dz + dy, z];
      const shaded = k > 0, rim = tone(1.22), upBack = tone(shaded ? 0.68 : 0.92), upFront = tone(shaded ? 1.08 : 1.14);
      const frontTop = tone(1.04), frontFoot = tone(0.9), back = tone(0.62), down = tone(0.55);
      const ends = [tone(wallTone([-1, 0, 0]) * 1.05), tone(wallTone([1, 0, 0]) * 1.05)];
      const R = Math.max(0.035 * T, 8);                                // the rim: a thin band of the top face along the front edge
      for (let i = 0; i < nx - 1; i++) {
        quad(P(i, top, T), P(i, bot, T), P(i + 1, bot, T), P(i + 1, top, T), frontTop, frontFoot, frontFoot, frontTop);
        quad(P(i, top, 0), P(i + 1, top, 0), P(i + 1, bot, 0), P(i, bot, 0), back);
        quad(P(i, top, 0), P(i, top, T - R), P(i + 1, top, T - R), P(i + 1, top, 0), upBack, upFront, upFront, upBack);
        quad(P(i, top, T - R), P(i, top, T), P(i + 1, top, T), P(i + 1, top, T - R), upFront, rim, rim, upFront);
        quad(P(i, bot, 0), P(i + 1, bot, 0), P(i + 1, bot, T), P(i, bot, T), down);
      }
      [0, nx - 1].forEach((i, e) => quad(P(i, top, 0), P(i, bot, 0), P(i, bot, T), P(i, top, T), ends[e]));
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 1 }));
      m.userData.k = k; return m;
    }
    // the picked layer's outline: ribbons with a real width (WebGL draws lines one pixel wide), along the front face's
    // perimeter in its own plane, and along the top edge behind it
    function outlineOf(k) {
      const top = st.iface[k], bot = st.iface[k + 1], dy = -k * st.gap, T = frontZ + 2, hw = 0.0042 * (fullDepth + (st.n - 1) * st.gap), pos = [];
      const P = (i, rows) => [i * dx, -rows[i] * dz + dy];
      const ribbon = (pts, z, flat) => {                               // flat: offset in z (a band lying on the top surface)
        for (let j = 1; j < pts.length; j++) {
          const [ax, ay] = pts[j - 1], [bx, by] = pts[j], L = Math.hypot(bx - ax, by - ay) || 1;
          const [nx_, ny_] = flat ? [0, 0] : [-(by - ay) / L * hw, (bx - ax) / L * hw], nz_ = flat ? hw * 3 : 0;
          const q = [[ax - nx_, ay - ny_, z - nz_], [bx - nx_, by - ny_, z - nz_], [bx + nx_, by + ny_, z + nz_], [ax + nx_, ay + ny_, z + nz_]];
          pos.push(...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3]);
        }
      };
      const topLine = Array.from({ length: nx }, (_, i) => P(i, top)), botLine = Array.from({ length: nx }, (_, i) => P(i, bot));
      ribbon(topLine, T); ribbon(botLine, T); ribbon([P(0, top), P(0, bot)], T); ribbon([P(nx - 1, top), P(nx - 1, bot)], T);
      ribbon(topLine, -2, true);
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: new THREE.Color(theme.accent), side: THREE.DoubleSide, depthTest: false }));
      m.renderOrder = 20; return m;
    }
    function setStrata(spec) {                                          // {map, n, colors} to show, null to go back to the block
      if (st.group) { scene.remove(st.group); st.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); st.group = null; }
      st.on = !!spec; state.group.visible = !st.on;
      if (st.on) {
        st.n = spec.n; st.gap = 0.07 * fullDepth; st.iface = strataInterfaces(spec.map, spec.n);
        st.group = new THREE.Group(); st.meshes = [];
        for (let k = 0; k < spec.n; k++) { const m = layerSolid(k, spec.colors[k]); st.meshes.push(m); st.group.add(m); }
        // the receivers on the top layer, the rupture through the layers it crosses, each subsource carried with its layer
        st.group.add(points(recX, recY, liftZ, 7, new THREE.Color(theme.accent)));
        const r = family.rupture, ly = r.x.map((x, i) => Math.max(0, spec.map[r.z[i] * nx + x]));
        st.group.add(points(r.x.map(x => x * dx), r.z.map((z, i) => -z * dz - ly[i] * st.gap), liftZ, 4, new THREE.Color(theme.ink)));
        scene.add(st.group);
        state.focus = { x0: 0, x1: width, y0: 0.04 * width, y1: -(fullDepth + (spec.n - 1) * st.gap), free: true };
        placeGround(-(fullDepth + (spec.n - 1) * st.gap));
        pickLayer(spec.pick != null && spec.pick < spec.n ? spec.pick : -1);
      } else { st.pick = -1; state.focus = null; placeGround(-state.floor); }
      frame();
    }
    function pickLayer(k) {
      st.pick = k;
      if (!st.group) return;
      if (st.outline) { st.group.remove(st.outline); st.outline.geometry.dispose(); st.outline.material.dispose(); st.outline = null; }
      st.meshes.forEach((m, j) => { m.material.opacity = k < 0 || j === k ? 1 : 0.22; m.material.depthWrite = k < 0 || j === k; m.renderOrder = j === k ? 2 : 1; });
      if (k >= 0) { st.outline = outlineOf(k); st.group.add(st.outline); }
      requestRender();
    }
    // where the callout hangs: the middle of the layer's east end, on the front face; and a point well inside its front face
    function layerAnchor(k, west = false) {
      const i = west ? 0 : nx - 1, mid = (st.iface[k][i] + st.iface[k + 1][i]) / 2;
      return screenOf(new THREE.Vector3(i * dx, -mid * dz - k * st.gap, frontZ));
    }
    function layerScreen(k) {
      let best = 0; for (let i = 0; i < nx; i++) if (st.iface[k + 1][i] - st.iface[k][i] > st.iface[k + 1][best] - st.iface[k][best]) best = i;   // the thickest column
      const mid = (st.iface[k][best] + st.iface[k + 1][best]) / 2;
      return screenOf(new THREE.Vector3(best * dx, -mid * dz - k * st.gap, frontZ));
    }

    // the front, for the page's label: where on screen, how far down-dip from the hypocentre [m]
    function frontInfo() {
      if (!fx.front || !fx.front.visible) return null;
      const [hx, hz] = family.source.hypocenter, p = fx.front.position;
      return { screen: screenOf(new THREE.Vector3(p.x, p.y, liftZ)), along_m: Math.hypot(p.x - hx * dx, -p.y - hz * dz) };
    }

    // the wave lifts the front face out of its plane (towards the viewer for v > 0), as the film and the 0.2 viewer do
    function applyLift() {
      if (!state.front) return;
      const pos = state.front.geometry.attributes.position, lift = state.lift;
      for (let i = 0; i < nx * nz; i++) pos.array[i * 3 + 2] = frontZ + (lift ? lift[i] : 0);
      pos.needsUpdate = true;
    }

    // ---------------------------------------------------------------- receivers
    function leaderTop(k) { return Math.max(...lid.map(row => -row[family.receivers.x[k]])) + 0.06 * width; }

    function drawMarkers() {
      for (const o of [state.markers, state.selectedMarker, state.leader]) if (o) { state.group.remove(o); o.geometry.dispose(); }
      const accent = new THREE.Color(theme.accent);
      state.markers = points(recX, recY, liftZ, 8, accent);
      state.group.add(state.markers);
      state.selectedMarker = state.leader = null;
      const k = state.selected;
      if (k >= 0) {
        state.selectedMarker = points([recX[k]], [recY[k]], liftZ + 1, 15, new THREE.Color(theme.ink));
        state.group.add(state.selectedMarker);
        const top = leaderTop(k);
        const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(recX[k], recY[k], liftZ), new THREE.Vector3(recX[k], top, liftZ)]);
        state.leader = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(theme.ink) }));
        state.group.add(state.leader);
      }
      requestRender();
    }

    // ---------------------------------------------------------------- camera
    // inset: the screen the panels cover, {left, right, top, bottom} in CSS px. The block is framed in what is left, and
    // the frustum is shifted so the orbit centre stays in the middle of that free area.
    const view = { dir: normalize([-0.45, 0.42, 1.0]), margin: 1.1, inset: { left: 0, right: 0, top: 0, bottom: 0 } };
    function boxCorners() {
      const c = [], f = state.focus;
      const xs = f ? [f.x0, f.x1] : [0, width], ys = f ? [f.y0, f.free ? f.y1 : Math.max(f.y1, -state.floor)] : [0.04 * width, -state.floor];   // free: the layers apart reach below the floor
      for (const x of xs) for (const y of ys) for (const z of [0, liftZ]) c.push(new THREE.Vector3(x, y, z));
      return c;
    }
    function fitFrustum(corners) {
      camera.updateMatrixWorld();
      const inv = camera.matrixWorldInverse, pts = corners.map(p => p.clone().applyMatrix4(inv));
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
      const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
      const W = Math.max(container.clientWidth, 1), H = Math.max(container.clientHeight, 1), ins = view.inset;
      const freeW = Math.max(W - ins.left - ins.right, 80), freeH = Math.max(H - ins.top - ins.bottom, 80);
      const unitsPerPx = Math.max(h / freeH, w / freeW) * view.margin;               // world units per CSS pixel
      const halfW = unitsPerPx * W / 2, halfH = unitsPerPx * H / 2;
      // the orbit centre (view x = y = 0) must land in the middle of the free area
      const cx = unitsPerPx * (W / 2 - (ins.left + freeW / 2)), cy = unitsPerPx * ((ins.top + freeH / 2) - H / 2);
      camera.left = cx - halfW; camera.right = cx + halfW; camera.top = cy + halfH; camera.bottom = cy - halfH;
      camera.zoom = 1; camera.updateProjectionMatrix();
    }
    function frame() {
      const corners = boxCorners(), target = new THREE.Vector3();       // The box centre: a box projects symmetrically about it
      corners.forEach(p => target.add(p)); target.multiplyScalar(1 / corners.length);
      camera.position.copy(target).add(new THREE.Vector3(...view.dir).multiplyScalar(2e4));
      camera.up.set(0, 1, 0); camera.lookAt(target); controls.target.copy(target);
      fitFrustum(corners); controls.update(); requestRender();
    }
    function setInset(inset) { view.inset = { ...view.inset, ...inset }; frame(); }
    // the view cube (viewcube.js): turn the camera about its target to look along `d` (target -> camera), keeping the
    // zoom; a rotation (slerp), so a half turn never passes through a zero direction
    const viewDir = () => camera.position.clone().sub(controls.target).normalize();
    function setViewDir(d, ms = 900) {
      const from = viewDir(), to = d.clone().normalize(), r = camera.position.distanceTo(controls.target), t0 = performance.now();
      const q = new THREE.Quaternion().setFromUnitVectors(from, to), qt = new THREE.Quaternion();
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      return new Promise(resolve => {
        const step = () => {
          const u = reduce ? 1 : Math.min(1, (performance.now() - t0) / ms), e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
          qt.identity().slerp(q, e);
          camera.position.copy(controls.target).addScaledVector(from.clone().applyQuaternion(qt), r);
          camera.up.set(0, 1, 0); camera.lookAt(controls.target); controls.update(); requestRender();
          if (u < 1) requestAnimationFrame(step); else resolve();
        };
        step();
      });
    }
    function setOrbit(on) { controls.autoRotate = !!on; controls.autoRotateSpeed = 0.55; requestRender(); }

    // what the overlays need each frame: metres per CSS pixel on the view plane, and where north points on screen
    // (the section runs west -> east along X; the swath was sampled on the north side, so north is -Z)
    function overlayInfo() {
      const H = Math.max(container.clientHeight, 1);
      const metresPerPx = (camera.top - camera.bottom) / camera.zoom / H;
      const t = controls.target.clone(), a = screenOf(t), b = screenOf(t.clone().add(new THREE.Vector3(0, 0, -1000)));
      return { metresPerPx, northDeg: Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI };
    }

    function resize() {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = w + "px"; renderer.domElement.style.height = h + "px";
      const k = markerScale();
      if (state.lidMesh && Math.abs(k - (state.markerK || k)) > 0.05) rebuild();   // the markers follow the stage's width
      state.markerK = k;
      frame();
    }

    // ---------------------------------------------------------------- picking
    function screenOf(v) {
      const p = v.clone().project(camera), rect = renderer.domElement.getBoundingClientRect();
      return { x: (p.x + 1) / 2 * rect.width, y: (1 - p.y) / 2 * rect.height };
    }
    function receiverScreen(k) { return screenOf(new THREE.Vector3(recX[k], recY[k], liftZ)); }
    function labelScreen(k) { return screenOf(new THREE.Vector3(recX[k], leaderTop(k), liftZ)); }
    function nearestReceiver(px, py) {
      let best = -1, bestD = Infinity;
      for (let k = 0; k < recX.length; k++) { const s = receiverScreen(k), d = Math.hypot(s.x - px, s.y - py); if (d < bestD) { bestD = d; best = k; } }
      if (bestD <= PICK_PX) return { k: best, direct: true };
      // elsewhere on the block: the receiver nearest along the section to the point hit (decision D1: no free points)
      const rect = renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(px / rect.width * 2 - 1, 1 - py / rect.height * 2), camera);
      const hits = ray.intersectObjects([state.front, state.lidMesh].filter(Boolean));
      if (!hits.length) return { k: -1, direct: false };
      const x = hits[0].point.x;
      let k = 0;
      for (let j = 1; j < recX.length; j++) if (Math.abs(recX[j] - x) < Math.abs(recX[k] - x)) k = j;
      return { k, direct: false };                                   // a click on the block, nearest along the section
    }
    let down = null;
    renderer.domElement.addEventListener("pointerdown", e => { down = { x: e.offsetX, y: e.offsetY }; });
    renderer.domElement.addEventListener("pointerup", e => {
      if (!down || Math.hypot(e.offsetX - down.x, e.offsetY - down.y) > 4) { down = null; return; }   // an orbit, not a click
      down = null;
      const hit = nearestReceiver(e.offsetX, e.offsetY);
      // the layers apart: a click on a solid picks that layer, a click beside them lets it go
      if (st.on && !hit.direct) {
        const rect = renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2(e.offsetX / rect.width * 2 - 1, 1 - e.offsetY / rect.height * 2), camera);
        const first = ray.intersectObjects(st.meshes).find(h => st.pick < 0 || h.object.userData.k === st.pick || h.object.material.opacity > 0.5) || ray.intersectObjects(st.meshes)[0];
        if (state.onLayerPick) state.onLayerPick(first ? first.object.userData.k : -1);
        return;
      }
      // a click on the front face, not on a receiver: the grid cell under it (the medium chapter reads its layer)
      if (!hit.direct && state.onFacePick && state.front) {
        const rect = renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2(e.offsetX / rect.width * 2 - 1, 1 - e.offsetY / rect.height * 2), camera);
        const face = ray.intersectObject(state.front)[0];
        const cell = face && { ix: Math.min(nx - 1, Math.max(0, Math.round(face.point.x / dx))), iz: Math.min(nz - 1, Math.max(0, Math.round(-face.point.y / dz))) };
        if (cell && state.onFacePick(cell)) return;                   // handled (true) only where the chapter wants layers
      }
      if (hit.k >= 0 && state.onPick) state.onPick(hit.k, hit.direct);
    });
    renderer.domElement.addEventListener("pointerleave", () => {        // off the canvas (onto a panel): no tooltip left behind
      if (state.hover !== -1) { state.hover = -1; state.onHover && state.onHover(-1, null); }
    });
    renderer.domElement.addEventListener("pointermove", e => {
      if (e.buttons) return;
      let best = -1, bestD = Infinity;
      for (let k = 0; k < recX.length; k++) { const s = receiverScreen(k), d = Math.hypot(s.x - e.offsetX, s.y - e.offsetY); if (d < bestD) { bestD = d; best = k; } }
      const k = bestD <= PICK_PX ? best : -1;
      renderer.domElement.style.cursor = k >= 0 ? "pointer" : "grab";
      if (k !== state.hover) { state.hover = k; state.onHover && state.onHover(k, k >= 0 ? receiverScreen(k) : null); }
    });

    // ---------------------------------------------------------------- rendering
    let pending = false;
    function requestRender() { if (!pending) { pending = true; requestAnimationFrame(renderNow); } }
    function renderNow() {
      pending = false;
      const moving = controls.update();
      renderer.render(scene, camera);
      if (state.onFrame) state.onFrame();
      if (moving || controls.autoRotate) requestRender();
    }
    controls.addEventListener("change", requestRender);
    new ResizeObserver(resize).observe(container);

    // no scene background: the canvas is transparent over the stage's CSS pool of light; the ground's shadow is
    // deeper on the dark theme, as the map's
    function setTheme(t) {
      const v = new THREE.Color(t.viewport);
      theme = { ...t, dark: 0.2126 * v.r + 0.7152 * v.g + 0.0722 * v.b < 0.5 };
      scene.background = null; placeGround(st.on ? -(fullDepth + (st.n - 1) * st.gap) : -state.floor);
      paintRupture(); paintFx(); drawMarkers();
    }

    // the source and solver chapters: time on the rupture, the lifted face, markers drawn over a face that moves
    function setRuptureTime(t) { state.ruptureTime = t; paintRupture(); paintFx(); requestRender(); }
    function setLift(lift) { state.lift = lift; applyLift(); requestRender(); }
    function setSourceView(on) {
      if (state.onTop === !!on && state.showHypocenter === !!on) return;
      state.onTop = !!on; state.showHypocenter = !!on; rebuild();
    }

    function setMedium(mask, rgba) {
      // mask: Float32Array nz*nx (1 solid, 0 air); rgba: Uint8Array (nz-1)*(nx-1)*4, the colour of each cell
      if (!state.texture) {
        // a copy: the texture owns its pixels, so writing a wave frame into it can never touch the caller's medium colours
        state.texture = new THREE.DataTexture(new Uint8Array(rgba), nx - 1, nz - 1, THREE.RGBAFormat);
        state.texture.magFilter = state.texture.minFilter = THREE.NearestFilter;
        state.texture.generateMipmaps = false;
      } else {
        state.texture.image.data.set(rgba);
      }
      state.texture.needsUpdate = true;
      if (!state.mask) { state.mask = mask; rebuild(); }
      requestRender();
    }

    function setFloor(depth) { state.floor = Math.min(depth, fullDepth); rebuild(); frame(); }
    function setSelected(k) { state.selected = k; drawMarkers(); }

    setTheme(theme);
    rebuild();
    resize();
    return {
      setMedium, setTheme, setFloor, setSelected, frame, setViewDir, viewDir, receiverScreen, labelScreen, requestRender, setInset, setOrbit, overlayInfo,
      setRuptureTime, setLift, setSourceView, setSourceFx, frontInfo, setFaceShade,
      get orbiting() { return controls.autoRotate; },
      get facePixels() { return state.texture ? state.texture.image.data : null; },   // for the tests
      set onPick(fn) { state.onPick = fn; }, set onHover(fn) { state.onHover = fn; }, set onFrame(fn) { state.onFrame = fn; },
      set onFacePick(fn) { state.onFacePick = fn; }, set onLayerPick(fn) { state.onLayerPick = fn; },
      setStrata, pickLayer, layerAnchor, layerScreen, get strataOn() { return st.on; },
      cellScreen: (ix, iz) => screenOf(new THREE.Vector3(ix * dx, -iz * dz, frontZ)),   // for the tests
      get floor() { return state.floor; }, fullDepth, canvas: renderer.domElement,
    };
  }

  window.SectionScene = { create };
})();
