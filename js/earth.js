// Surrogate Explorer · earth.js — the first stage: the Earth, then the flight down to Quito (three.js r128).
//
// The globe is NASA's imagery (vendor/earth/, made by tools/export_earth.py from GIBS): Blue Marble with shaded relief
// and bathymetry by day, the 2016 Black Marble city lights by night, both equirectangular as three.js's sphere UVs
// expect, and a 650 m crop around Quito (DETAIL_BOX) that takes over during the dive. One shader lights it with a fixed
// sun (the terminator crosses the Atlantic, so the far view shows day over the Andes and the lights of the night side),
// a glint on the water, and the blue rim of the atmosphere; a thin additive shell carries the glow past the limb and a
// sky of stars sits behind. Ecuador is outlined in the accent on a small canvas over the crop, and Quito carries a
// pulsing marker. flyTo(view) moves the camera between named views with an eased tween.
(function () {
  "use strict";
  const RADIUS = 1;
  const DETAIL_BOX = [-84, -6, -72, 6];                           // lon_min, lat_min, lon_max, lat_max (= export_earth.py)
  const SUBSOLAR = [-128, 14];                                     // where the sun is overhead: Quito in the afternoon, the Atlantic at dusk
  const ATMOSPHERE = 1.035;                                        // the glow's outer radius, in Earth radii

  const GLOBE_VERTEX = `
    varying vec2 vUv; varying vec3 vN;
    void main() { vUv = uv; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const GLOBE_FRAGMENT = `
    uniform sampler2D dayMap, nightMap, detailMap, overlayMap;
    uniform vec4 box; uniform vec3 sunDir, camDir, fadeColor; uniform float fade;
    varying vec2 vUv; varying vec3 vN;
    void main() {
      vec3 day = texture2D(dayMap, vUv).rgb;
      // the crop around Quito, faded in over its outer 6 % so its edge never shows (sampled everywhere: no branch, no
      // broken mip derivatives at the box's border)
      vec2 d = (vUv - box.xy) / (box.zw - box.xy), dc = clamp(d, 0.0, 1.0);
      float inside = step(0.0, d.x) * step(d.x, 1.0) * step(0.0, d.y) * step(d.y, 1.0);
      float edge = min(min(d.x, 1.0 - d.x), min(d.y, 1.0 - d.y));
      day = mix(day, texture2D(detailMap, dc).rgb, inside * smoothstep(0.0, 0.06, edge));
      vec4 ov = texture2D(overlayMap, dc) * inside;                  // premultiplied
      vec3 n = normalize(vN);
      float mu = dot(n, sunDir), dayAmt = smoothstep(-0.10, 0.16, mu);
      vec3 col = day * (0.03 + 1.32 * pow(max(mu, 0.0), 0.5));
      // the sea (blue clearly above red and green in Blue Marble) catches the sun in a small glint
      float water = smoothstep(0.035, 0.12, day.b - max(day.r, day.g));
      float glint = pow(max(dot(n, normalize(sunDir + camDir)), 0.0), 220.0) * water * dayAmt;
      col += glint * vec3(0.34, 0.32, 0.28);
      // the night side: the city lights (luminance above 0.22 in Black Marble; the moonlit land sits near 0.14 and the
      // polar no-data band at 0.20), warmed to street lighting, over a faint trace of the land
      vec3 night = texture2D(nightMap, vUv).rgb;
      float lum = dot(night, vec3(0.30, 0.59, 0.11));
      col += (night * smoothstep(0.22, 0.60, lum) * vec3(1.9, 1.65, 1.25) + night * 0.12) * (1.0 - dayAmt);
      // the atmosphere seen edge-on, brighter on the day side
      float rim = pow(1.0 - max(dot(n, camDir), 0.0), 2.6);
      col += vec3(0.30, 0.55, 1.00) * rim * (0.06 + 0.62 * smoothstep(-0.25, 0.5, mu));
      col = col * (1.0 - ov.a) + ov.rgb;
      gl_FragColor = vec4(mix(col, fadeColor, fade), 1.0);            // the landing: the world gives way to the map's ground
    }`;
  const AIR_VERTEX = `
    varying vec3 vN; varying float vZ;
    void main() { vN = normalize(mat3(modelMatrix) * normal); vZ = normalize(normalMatrix * normal).z; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const AIR_FRAGMENT = `
    uniform vec3 sunDir; uniform float zMax, fade;
    varying vec3 vN; varying float vZ;
    void main() {
      // the far half of the shell (BackSide), seen past the limb: |n.z| runs from zMax at the limb to 0 at the edge
      float t = clamp(-vZ / zMax, 0.0, 1.0), lit = smoothstep(-0.30, 0.45, dot(normalize(vN), sunDir));
      gl_FragColor = vec4(vec3(0.32, 0.58, 1.00) * pow(t, 1.7) * (0.10 + 0.80 * lit) * (1.0 - fade), 1.0);
    }`;
  // the stars: directions only, through a fixed 60° lens, so they turn with the camera but never zoom with it
  const STAR_VERTEX = `
    attribute float size, bright; uniform float aspect, focal, pixel, fade;
    varying float vB;
    void main() {
      vec3 d = (viewMatrix * vec4(position, 0.0)).xyz; vB = bright * (1.0 - fade);
      if (d.z > -0.05) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
      gl_Position = vec4(focal * d.x / -d.z / aspect, focal * d.y / -d.z, 0.0, 1.0); gl_PointSize = size * pixel;
    }`;
  const STAR_FRAGMENT = `
    varying float vB;
    void main() { float a = smoothstep(0.5, 0.1, length(gl_PointCoord - 0.5)) * vB; gl_FragColor = vec4(vec3(0.86, 0.90, 1.0), a); }`;

  function lonLatToVector(lon, lat, r = RADIUS) {
    // three.js SphereGeometry: phi from the -X axis around Y, theta from +Y; u = (lon + 180) / 360, v = (90 - lat) / 180
    const phi = (lon + 180) / 360 * 2 * Math.PI, theta = (90 - lat) / 180 * Math.PI;
    return new THREE.Vector3(-r * Math.cos(phi) * Math.sin(theta), r * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta));
  }

  function create(container, site) {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x03050a, 1);                              // space, in both themes
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    // orthographic, as every stage of the page: a pose is still "a 32° lens at distance d" (zoom = 1 / d), the camera
    // itself sits R_CAM out along its direction, outside the globe
    const HALF = Math.tan(16 * Math.PI / 180), R_CAM = 5;
    const camera = new THREE.OrthographicCamera(-HALF, HALF, HALF, -HALF, -10, 20);
    camera.zoom = 1 / 4.4;
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.1; controls.enablePan = false;
    controls.minZoom = 1 / 7; controls.maxZoom = 1 / 0.004; controls.rotateSpeed = 0.5;
    function place(position, target) {                               // a perspective pose -> direction, target and zoom
      const off = position.clone().sub(target), d = off.length();
      controls.target.copy(target); camera.position.copy(target).addScaledVector(off.normalize(), R_CAM);
      camera.zoom = 1 / d; camera.updateProjectionMatrix();
    }
    const anisotropy = renderer.capabilities.getMaxAnisotropy();
    const sunDir = lonLatToVector(SUBSOLAR[0], SUBSOLAR[1]).normalize(), camDir = new THREE.Vector3();
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);   // until the imagery arrives
    blank.needsUpdate = true;
    const uv = (lon, lat) => [(lon + 180) / 360, (lat + 90) / 180];
    // fade: 0 in space, 1 at the end of the dive, where the world around the relief has become the map's ground colour
    const fade = { value: 0 }, fadeColor = { value: new THREE.Color(0x2b2b2d) }, SPACE = new THREE.Color(0x03050a);
    const globeMaterial = new THREE.ShaderMaterial({
      vertexShader: GLOBE_VERTEX, fragmentShader: GLOBE_FRAGMENT,
      uniforms: { dayMap: { value: blank }, nightMap: { value: blank }, detailMap: { value: blank }, overlayMap: { value: blank },
                  box: { value: new THREE.Vector4(...uv(DETAIL_BOX[0], DETAIL_BOX[1]), ...uv(DETAIL_BOX[2], DETAIL_BOX[3])) },
                  sunDir: { value: sunDir }, camDir: { value: camDir }, fade, fadeColor },
    });
    const globe = new THREE.Mesh(new THREE.SphereGeometry(RADIUS, 128, 96), globeMaterial);
    globe.visible = false;                                            // shown with its day texture, never as a black ball
    scene.add(globe);
    const air = new THREE.Mesh(new THREE.SphereGeometry(RADIUS * ATMOSPHERE, 96, 64), new THREE.ShaderMaterial({
      vertexShader: AIR_VERTEX, fragmentShader: AIR_FRAGMENT, side: THREE.BackSide, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false,
      uniforms: { sunDir: { value: sunDir }, zMax: { value: Math.sqrt(1 - 1 / (ATMOSPHERE * ATMOSPHERE)) }, fade },
    }));
    air.visible = false; scene.add(air);

    const N_STARS = 2400, starPos = new Float32Array(3 * N_STARS), starSize = new Float32Array(N_STARS), starBright = new Float32Array(N_STARS);
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;   // the same sky on every load
    for (let i = 0; i < N_STARS; i++) {
      const z = 2 * rand() - 1, a = 2 * Math.PI * rand(), r = Math.sqrt(1 - z * z), m = Math.pow(rand(), 3.2);
      starPos.set([r * Math.cos(a), z, r * Math.sin(a)], 3 * i);
      starSize[i] = 1.1 + 2.0 * m; starBright[i] = 0.22 + 0.78 * m;
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    starGeometry.setAttribute("size", new THREE.BufferAttribute(starSize, 1));
    starGeometry.setAttribute("bright", new THREE.BufferAttribute(starBright, 1));
    const starUniforms = { aspect: { value: 1 }, focal: { value: 1 / Math.tan(Math.PI / 6) }, pixel: { value: renderer.getPixelRatio() }, fade };
    const stars = new THREE.Points(starGeometry, new THREE.ShaderMaterial({
      vertexShader: STAR_VERTEX, fragmentShader: STAR_FRAGMENT, uniforms: starUniforms,
      blending: THREE.AdditiveBlending, transparent: false, depthTest: false, depthWrite: false,   // opaque list, so renderOrder puts them first
    }));
    stars.frustumCulled = false; stars.renderOrder = -1;              // drawn first and without depth: the globe covers them
    scene.add(stars);

    const quito = lonLatToVector(site.origin_lon_lat[0], site.origin_lon_lat[1]);
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.009, 16, 12), new THREE.MeshBasicMaterial({ color: 0xe58a2b }));
    marker.position.copy(quito); scene.add(marker);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.016, 0.022, 48), new THREE.MeshBasicMaterial({ color: 0xe58a2b, transparent: true, side: THREE.DoubleSide }));
    ring.position.copy(quito.clone().multiplyScalar(1.002)); ring.lookAt(quito.clone().multiplyScalar(2)); scene.add(ring);

    // ---------------------------------------------------------------- imagery (once) and Ecuador's outline (per theme)
    const imagery = { day: false, night: false, detail: false };
    let loading = null;
    function loadImagery() {
      if (loading) return loading;
      const loader = new THREE.TextureLoader();
      const one = name => new Promise((resolve, reject) => loader.load(`vendor/earth/${name}.jpg`, texture => {
        texture.anisotropy = anisotropy; globeMaterial.uniforms[`${name}Map`].value = texture; imagery[name] = true;
        if (name === "day") { globe.visible = air.visible = true; }
        requestRender(); resolve();
      }, undefined, () => reject(new Error(`the globe's ${name} imagery did not load (vendor/earth/${name}.jpg)`))));
      return (loading = Promise.all(["day", "night", "detail"].map(one)));
    }
    const overlay = document.createElement("canvas"); overlay.width = overlay.height = 1024;
    const overlayTexture = new THREE.CanvasTexture(overlay);
    overlayTexture.premultiplyAlpha = true; overlayTexture.anisotropy = anisotropy;   // clean edges when it is filtered
    function paint() {
      const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      fadeColor.value.set(getComputedStyle(document.documentElement).getPropertyValue("--view").trim() || "#2b2b2d");   // the map stage's ground
      const g = overlay.getContext("2d"), w = overlay.width, [lon0, , lon1, lat1] = DETAIL_BOX;
      const k = w / ((lon1 - lon0) * Math.PI / 180);                 // the box is square in degrees, as the canvas
      const path = d3.geoPath(d3.geoEquirectangular().scale(k).translate([-k * lon0 * Math.PI / 180, k * lat1 * Math.PI / 180]), g);
      const outline = Globe.loadWorld().then(world => {
        g.clearRect(0, 0, w, w);
        if (world.ecuador) {
          g.beginPath(); path(world.ecuador); g.fillStyle = "rgba(229, 138, 43, .10)"; g.fill();
          g.lineJoin = "round"; g.strokeStyle = accent; g.lineWidth = 3.2; g.stroke();
        }
        overlayTexture.needsUpdate = true; globeMaterial.uniforms.overlayMap.value = overlayTexture; requestRender();
      });
      return Promise.all([loadImagery(), outline]);
    }

    // ---------------------------------------------------------------- views and the flight
    const VIEWS = {
      // far: the whole Earth, Quito facing us under a slightly northern sky; near: Quito centred, the north of South
      // America around it (1:110m coasts get coarse closer than this)
      far: { distance: 4.4, lift: 0.3, aim: 0.0 },
      near: { distance: 2.35, lift: 0.12, aim: 1.0 },
    };
    function poseFor(name) {                                          // {target, dir, d}: d is the 32° lens distance (zoom = 1 / d)
      const v = VIEWS[name], out = quito.clone().normalize();
      const dir = out.clone().add(new THREE.Vector3(0, v.lift, 0)).normalize();
      // aim 0 looks at the Earth's centre, aim 1 at Quito itself (so Quito sits in the middle of the free area)
      const position = dir.multiplyScalar(v.distance), target = quito.clone().multiplyScalar(v.aim);
      return { target, dir: position.clone().sub(target).normalize(), d: position.distanceTo(target) };
    }
    // east, north, up at a point of the globe (the frame the map stage is drawn in: X east, Y up, Z = -north)
    function enu(lon, lat) {
      const e = lonLatToVector(lon + 1e-4, lat).sub(lonLatToVector(lon - 1e-4, lat)).normalize();
      const n = lonLatToVector(lon, lat + 1e-4).sub(lonLatToVector(lon, lat - 1e-4)).normalize();
      return { e, n, u: lonLatToVector(lon, lat).normalize() };
    }
    const [lon0, lat0] = site.origin_lon_lat, frame = enu(lon0, lat0), EARTH_KM = 6371;
    const kmToLonLat = (x, y) => [lon0 + x / (111.320 * Math.cos(lat0 * Math.PI / 180)), lat0 + y / 110.574];
    // the map stage's pose (local km, its 34° lens) as the same view of the globe: target on the surface, the direction
    // turned from (east, up, -north) into the globe's axes, and the distance scaled so both frames show the same kilometres
    function fromSite(p, halfSite) {
      const [lon, lat] = kmToLonLat(p.target.x, -p.target.z), target = lonLatToVector(lon, lat, RADIUS * (1 + p.target.y / EARTH_KM));
      const dir = frame.e.clone().multiplyScalar(p.dir.x).add(frame.u.clone().multiplyScalar(p.dir.y)).add(frame.n.clone().multiplyScalar(-p.dir.z)).normalize();
      // the map's camera keeps the local vertical up (its OrbitControls), so the landing does too: with the Earth's axis up
      // instead, the relief came in turned by ~13° against the map it hands over to
      return { target, dir, d: p.d * halfSite / HALF / EARTH_KM, up: frame.u.clone() };
    }
    let tween = null, tweenDone = null;
    // a flight between poses: the target glides, the direction turns, the distance changes in LOG space (a dive from
    // 16 000 km to 90 km has to spend as long on each factor of ten)
    function flyTo(name, ms = 2400) {
      const to = typeof name === "string" ? poseFor(name) : name, here = controls.target.clone();
      const from = { target: here, dir: camera.position.clone().sub(here).normalize(), d: 1 / camera.zoom };
      const at = (target, dir, d) => place(target.clone().addScaledVector(dir, d), target);
      // the screen's "up" turns too: the Earth's axis for the named views, the local vertical for the landing (OrbitControls
      // reads camera.up only when it looks at the target, so it can change between frames)
      const up0 = camera.up.clone(), up1 = (to.up || AXIS).clone();
      landing = to.up ? to.d : null;                                   // only a landing fades the world out
      if (tween) { tween = null; if (tweenDone) tweenDone(); }        // a new pose ends the flight under way (it would override an instant one)
      if (ms <= 0) { camera.up.copy(up1); at(to.target, to.dir, to.d); controls.update(); requestRender(); return Promise.resolve(); }
      return new Promise(resolve => {
        const t0 = performance.now();
        tweenDone = resolve;
        tween = () => {
          const u = Math.min(1, (performance.now() - t0) / ms), e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
          const w = Math.pow(e, 0.6);                                  // the target arrives before the zoom ends
          camera.up.copy(up0).lerp(up1, e).normalize();
          at(from.target.clone().lerp(to.target, w), from.dir.clone().lerp(to.dir, e).normalize(), Math.exp(Math.log(from.d) * (1 - e) + Math.log(to.d) * e));
          if (u >= 1) { tween = null; tweenDone = null; resolve(); }
        };
        requestRender();
      });
    }

    // the relief of the district itself, pasted on the globe where it is (north up, its true size): the dive lands on it.
    // Two copies on one grid: a soft-edged one while the satellite imagery is around it, and a hard-edged one that takes
    // over as the world fades, so the last frame is the map's own block, edge for edge
    let patch = null, patchHard = null, landing = null;
    function setPatch(canvas, xRange, yRange) {
      for (const p of [patch, patchHard]) if (p) { scene.remove(p); p.material.map.dispose(); p.material.dispose(); }
      if (patch) patch.geometry.dispose();
      const n = 24, pos = [], uv = [], idx = [];
      for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
        const x = xRange[0] + (xRange[1] - xRange[0]) * i / n, y = yRange[1] - (yRange[1] - yRange[0]) * j / n;
        const [lon, lat] = kmToLonLat(x, y), v = lonLatToVector(lon, lat, RADIUS * 1.0004);
        pos.push(v.x, v.y, v.z); uv.push(i / n, 1 - j / n);
      }
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i; idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2); }
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
      // its border fades into the satellite imagery over 5 % of each side, so it lands as a sharper view, not a sticker
      const soft = document.createElement("canvas"); soft.width = canvas.width; soft.height = canvas.height;
      const s = soft.getContext("2d"), fw = 0.05 * canvas.width, fh = 0.05 * canvas.height, W = soft.width, H = soft.height;
      s.drawImage(canvas, 0, 0); s.globalCompositeOperation = "destination-out";
      for (const [x0, y0, x1, y1, rx, ry, rw, rh] of [[0, 0, fw, 0, 0, 0, fw, H], [W, 0, W - fw, 0, W - fw, 0, fw, H],
                                                       [0, 0, 0, fh, 0, 0, W, fh], [0, H, 0, H - fh, 0, H - fh, W, fh]]) {
        const ramp = s.createLinearGradient(x0, y0, x1, y1); ramp.addColorStop(0, "rgba(0,0,0,1)"); ramp.addColorStop(1, "rgba(0,0,0,0)");
        s.fillStyle = ramp; s.fillRect(rx, ry, rw, rh);
      }
      const tex = new THREE.CanvasTexture(soft); tex.anisotropy = anisotropy; tex.premultiplyAlpha = true;
      patch = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, transparent: true, depthWrite: false, premultipliedAlpha: true,
                                                               polygonOffset: true, polygonOffsetFactor: -2 }));
      const hard = new THREE.CanvasTexture(canvas); hard.anisotropy = anisotropy;
      patchHard = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: hard, side: THREE.DoubleSide, transparent: true, opacity: 0, depthWrite: false,
                                                                   polygonOffset: true, polygonOffsetFactor: -3 }));
      patchHard.renderOrder = 1;
      scene.add(patch, patchHard); requestRender();
    }

    // ---------------------------------------------------------------- rendering on demand
    let pending = false, active = false;
    function requestRender() { if (!pending && active) { pending = true; requestAnimationFrame(renderNow); } }
    // Orbit: the camera and its target turn about the Earth's own axis (+Y, pole to pole) through the centre, westward, so
    // the globe seems to spin eastward under a fixed sun and the terminator sweeps across it; OrbitControls' autoRotate
    // would turn about the target instead, which near Quito swings the Earth around the city
    const AXIS = new THREE.Vector3(0, 1, 0), ORBIT_RATE = 2 * Math.PI / 150;   // a turn every 150 s
    let orbit = false, lastFrame = performance.now();
    function renderNow() {
      pending = false;
      const now = performance.now(), step = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
      if (orbit && !tween) { const a = -ORBIT_RATE * step; camera.position.applyAxisAngle(AXIS, a); controls.target.applyAxisAngle(AXIS, a); }
      if (tween) tween();
      const moving = controls.update();
      camDir.copy(camera.position).sub(controls.target).normalize();   // orthographic: one view direction for the whole frame
      const pulse = 1 + 0.6 * (0.5 + 0.5 * Math.sin(performance.now() / 350));
      // the marker keeps its size on screen as the camera dives, and gives way to the relief patch below ~300 km
      const near = Math.min(1, (1 / camera.zoom) / 1.35), show = Math.min(1, Math.max(0, (near - 0.04) / 0.08));
      marker.scale.setScalar(near); marker.visible = show > 0.01;
      ring.scale.setScalar(pulse * near); ring.material.opacity = (1.15 - pulse / 1.6) * show; ring.visible = show > 0.01;
      // the landing's last stretch (from 5× to 1.25× its distance): the world around the relief turns to the map's ground
      const d = 1 / camera.zoom, u = landing ? Math.min(1, Math.max(0, (Math.log(landing * 5) - Math.log(d)) / Math.log(5 / 1.25))) : 0;
      fade.value = u * u * (3 - 2 * u);
      renderer.setClearColor(SPACE.clone().lerp(fadeColor.value, fade.value), 1);
      if (patchHard) patchHard.material.opacity = fade.value;
      renderer.render(scene, camera);
      if (state.onFrame) state.onFrame();
      if (moving || tween || active) requestRender();              // the marker pulses while the stage is on screen
    }
    controls.addEventListener("change", requestRender);
    const state = { onFrame: null };

    let inset = { left: 0, right: 0, top: 0, bottom: 0 };
    function resize() {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false); renderer.domElement.style.width = w + "px"; renderer.domElement.style.height = h + "px";
      camera.left = -HALF * w / h; camera.right = HALF * w / h;
      starUniforms.aspect.value = w / h; starUniforms.pixel.value = renderer.getPixelRatio();
      camera.setViewOffset(w, h, (inset.right - inset.left) / 2, (inset.bottom - inset.top) / 2, w, h);   // centre in the free area
      camera.updateProjectionMatrix(); requestRender();
    }
    new ResizeObserver(resize).observe(container);

    function screenOf(v) {
      const p = v.clone().project(camera), rect = renderer.domElement.getBoundingClientRect();
      return { x: (p.x + 1) / 2 * rect.width, y: (1 - p.y) / 2 * rect.height, visible: p.z < 1 && v.dot(camera.position.clone().sub(controls.target)) > 0 };   // the hemisphere facing us
    }

    flyTo("far", 0);
    resize();
    return {
      paint, flyTo, setPatch, fromSite,
      setActive(on) { active = on; if (on) { resize(); requestRender(); } },
      setInset(values) { inset = { ...inset, ...values }; resize(); },
      setOrbit(on) { orbit = !!on; lastFrame = performance.now(); requestRender(); },
      get orbiting() { return orbit; }, camera,
      quitoScreen: () => screenOf(quito),
      screenOfKm: (x, y) => { controls.update(); camera.updateMatrixWorld(); const [lon, lat] = kmToLonLat(x, y); return screenOf(lonLatToVector(lon, lat)); },   // the hand-off test
      get imagery() { return { ...imagery }; },
      set onFrame(fn) { state.onFrame = fn; },
      canvas: renderer.domElement,
    };
  }

  window.Earth = { create, lonLatToVector };
})();
