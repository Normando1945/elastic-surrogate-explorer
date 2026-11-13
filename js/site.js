// Surrogate Explorer · site.js — the map stage: Quito in 3D, its faults, the model's earthquake and the cut along A–B.
//
// Built the way the team's SRF Explorer (pxpalacios.com/apps/srf) builds its terrain, adapted to this project:
//   * one indexed mesh every 3 DEM pixels (~93 m) whose height lives in an attribute: the vertex shader multiplies it by
//     the exaggeration, so the relief slider costs nothing; the fragment shader colours it from two baked textures at
//     the DEM's own 31 m (a multidirectional hillshade and the elevation, export_site.py) through a palette lookup
//     texture, so a palette change is one texture upload; opacity is a uniform (depth writes off when translucent);
//   * thickness: walls down the four edges and a floor at the model's base (6 km under the grid's z = 0);
//   * the crustal section along A–B: a vertical plane whose top follows the terrain profile; the terrain, the fault
//     planes and the lines south of it are cut away. Under segment 3 it shows the very medium of the block (and, in the
//     earthquake chapter, the replayed wavefield): the 2D model lives in that plane and nowhere else;
//   * SARA fault traces (draped tubes) and their dipping planes (shader grid), the DMQ administrative zones, the urban
//     area, the 39 receivers as pins, the model's rupture with its hypocentre and epicentre;
//   * picking: pins and the epicentre in screen space, then a ray-march against the height field (the terrain), the
//     section plane and the fault planes; every hit has a card (app.js). Camera flights interpolate distance in log
//     space and arc up on long hops.
// Axes in km: X = east, Z = -north, Y = elevation (a.s.l.) x exaggeration.
(function () {
  "use strict";
  const PALETTES = {
    map: ["#e9e3d5", "#ddd0b6", "#c8b190", "#a89480", "#a7aeb8", "#d9dde2"],
    relief: ["#c4a484", "#c4a484"],
    elevation: null,                                                 // d3.interpolateMagma
    hypsometric: ["#4f7f52", "#93ad6a", "#d8c98d", "#b88d5b", "#8d7b6c", "#f1f1ee"],
    // a clay model lit only by the open sky (export_site.py's sky-view factor): enclosed ravines dark, open ground pale
    ao: ["#3c3d42", "#8d8b87", "#d4d1cb", "#f2f0ec"],
    // the relief's curvature at the hills' scale: valleys (concave) blue, flat ground neutral, ridges (convex) orange
    curvature: ["#2b5f9e", "#7fa6d2", "#e4e0d8", "#e7a46a", "#b4521a"],
  };
  // what each palette colours (the lookup's key): the elevation, the open sky, or the curvature
  const MODE = { ao: 1, curvature: 2 };
  // the district's air: extinction 0.012 /km at the lowest ground (a clear Andean day, ~300 km of visibility there),
  // thinning with a 2 km scale height, and never more than 35 % of the colour, so the relief keeps its contrast: the far
  // side of the district gets ~15-20 %, the eastern lowlands ~30 %, the near side almost nothing. With the Elevation
  // and Hypsometric palettes the colour is data, so the air stays fainter still
  const AIR = { sigma: 0.012, scaleHeight: 2.0, near: 0.1, cap: 0.35, dataStrength: 0.4, dark: 0x6b7484, light: 0xd2dde9 };
  const C = { section: 0xf2f2f4, segment: 0xe58a2b, fault: 0xd62728, faultOn: 0xffd23f, plane: 0xe2553a, urban: 0x3fb8e0, footprint: 0xe58a2b,
              pin: 0xe58a2b, hypo: 0xffffff, epi: 0xd62728 };

  class Polyline extends THREE.Curve {
    constructor(points) { super(); this.points = points; const d = [0]; for (let i = 1; i < points.length; i++) d.push(d[i - 1] + points[i].distanceTo(points[i - 1])); this.d = d; }
    getPoint(t, target = new THREE.Vector3()) {
      const s = t * this.d[this.d.length - 1];
      let i = 1; while (i < this.d.length - 1 && this.d[i] < s) i++;
      const span = this.d[i] - this.d[i - 1] || 1;
      return target.copy(this.points[i - 1]).lerp(this.points[i], (s - this.d[i - 1]) / span);
    }
  }

  function lutTexture(name) {
    const data = new Uint8Array(256 * 4);
    const ramp = name === "elevation" ? t => d3.interpolateMagma(0.12 + 0.83 * t) : d3.piecewise(d3.interpolateRgb, PALETTES[name]);
    for (let k = 0; k < 256; k++) { const c = d3.rgb(ramp(k / 255)); data.set([c.r, c.g, c.b, 255], k * 4); }
    const tex = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat); tex.needsUpdate = true;
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    return tex;
  }

  function create(container, site, mesh, images) {
    const R = mesh.rows, Cn = mesh.cols, n = R * Cn, H = mesh.z, X = mesh.x, Yn = mesh.y;      // H [m], X east [km], Yn north [km]
    const model = site.model, secY = site.segment.xy_km.reduce((s, p) => s + p[1], 0) / site.segment.xy_km.length;
    const baseM = model.top_elevation_m - model.depth_m;                                       // the model's floor, m a.s.l.
    const state = { exag: 1.5, alpha: 1, palette: "map", cut: { mode: "none", off: 0 }, show: { terrain: true, section: true, faults: true, planes: true, zones: true, urban: true, receivers: true, rupture: true, footprint: true,
                            buildings: true },   // the city is on from the start, on a phone too (the author tried it: 12 MB, ~200 MB of geometry)
                    inset: { left: 0, right: 0, top: 0, bottom: 0 }, onFrame: null, onPick: null, onHover: null, theme: "dark",
                    selected: -1, highlight: -1, ruptureTime: null, shake: null, grow: 1, mediumOn: false };

    // B9: a logarithmic depth buffer, so walls, faces and terrain never fight from 20 m to 160 km away (the custom
    // shaders below carry the logdepthbuf chunks)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.localClippingEnabled = true;
    container.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    // orthographic (as every stage of the page): a pose is "a 34° lens at distance d" with zoom = 1 / d, so views, fits,
    // flights and every distance-scaled overlay keep their meaning; the camera sits R_CAM out along its direction and the
    // depth range is wide on both sides, so nothing is ever clipped by the near plane
    const HALF = Math.tan(17 * Math.PI / 180), R_CAM = 100;
    const camera = new THREE.OrthographicCamera(-HALF, HALF, HALF, -HALF, -300, 500);
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08; controls.screenSpacePanning = false;
    controls.maxPolarAngle = Math.PI * 0.49; controls.minZoom = 1 / 160; controls.maxZoom = 1 / 0.6;
    const viewDist = () => 1 / camera.zoom;
    const viewDir = () => camera.position.clone().sub(controls.target).normalize();
    function place(target, dir, d) { controls.target.copy(target); camera.position.copy(target).addScaledVector(dir, R_CAM); camera.zoom = 1 / d; camera.updateProjectionMatrix(); }
    // a pose given as {position, target} (a perspective habit, e.g. the fault table's fly-to) becomes {target, dir, d}
    const asPose = v => (v.dir ? v : { target: v.target, dir: v.position.clone().sub(v.target).normalize(), d: v.position.distanceTo(v.target) });
    // B1: the cut is a set of three.js clipping planes shared by every clipped material (moving the slider moves the planes,
    // it never rebuilds a material); the quadrant removes the intersection of its two half-spaces
    const clipPlanes = [];
    const clipOpts = () => ({ clippingPlanes: clipPlanes, clipIntersection: state.cut.mode === "quadrant" });
    const LOGV = "#include <common>\n#include <logdepthbuf_pars_vertex>\n", LOGF = "#include <logdepthbuf_pars_fragment>\n";

    // ---------------------------------------------------------------- the relief (shader)
    const toY = m => m / 1000 * state.exag;
    const shadeTex = new THREE.Texture(images.hillshade); shadeTex.needsUpdate = true; shadeTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    const elevTex = new THREE.Texture(images.elevation); elevTex.needsUpdate = true;
    const curvTex = new THREE.Texture(images.curvature || images.hillshade); curvTex.needsUpdate = true;
    const terrainU = { uShade: { value: shadeTex }, uElev: { value: elevTex }, uCurv: { value: curvTex }, uMode: { value: MODE[state.palette] || 0 },
                       uLut: { value: lutTexture(state.palette) }, uExag: { value: state.exag },
                       uAlpha: { value: 1 }, uDark: { value: 0 },
                       // depth: the baked sun shadow (cool tint) and sky view (export_site.py)
                       uShadowTint: { value: new THREE.Color(0.62, 0.66, 0.80) }, uAoFloor: { value: 0.55 },
                       // the air: aerial perspective in real kilometres (see the fragment shader), set per frame and per theme
                       uAir: { value: new THREE.Vector4(AIR.sigma, site.dem.elevation_range_m[0] / 1000, AIR.scaleHeight, 1) },
                       uAirColor: { value: new THREE.Color(AIR.dark) }, uViewD: { value: 70 }, uRCam: { value: R_CAM },
                       uAirShape: { value: new THREE.Vector2(AIR.near, AIR.cap) } };
    const terrainMat = new THREE.ShaderMaterial({
      uniforms: terrainU, transparent: true, side: THREE.DoubleSide, clipping: true, ...clipOpts(),
      vertexShader: `${LOGV}#include <clipping_planes_pars_vertex>
        attribute float hz; uniform float uExag; varying vec2 vUv; varying vec3 vP; varying float vDepth;
        void main(){ vec3 p = position; p.y = hz * uExag; vP = p; vUv = uv; vec4 mvPosition = modelViewMatrix * vec4(p, 1.0); vDepth = -mvPosition.z; gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
          #include <clipping_planes_vertex>
        }`,
      fragmentShader: `${LOGF}#include <clipping_planes_pars_fragment>
        uniform sampler2D uShade, uElev, uCurv, uLut; uniform float uAlpha, uDark, uAoFloor, uExag, uViewD, uRCam, uMode; uniform vec3 uShadowTint, uAirColor;
        uniform vec4 uAir;                                            // extinction [1/km] at the lowest ground, its elevation [km], scale height [km], strength
        uniform vec2 uAirShape;                                       // share of the lens distance in front of the target, cap
        varying vec2 vUv; varying vec3 vP; varying float vDepth;
        void main(){
          #include <clipping_planes_fragment>
          #include <logdepthbuf_fragment>
          vec3 esk = texture2D(uElev, vUv).rgb;                       // elevation, sun, sky
          float s = texture2D(uShade, vUv).r;
          vec3 c;
          if (uMode > 1.5) {                                            // curvature: its colour, the hillshade for the form only
            c = texture2D(uLut, vec2(texture2D(uCurv, vUv).r, 0.5)).rgb * mix(0.70, 1.08, s);
          } else if (uMode > 0.5) {                                     // ambient occlusion: the open sky alone, no sun
            c = texture2D(uLut, vec2(esk.b, 0.5)).rgb;
          } else {
            c = texture2D(uLut, vec2(esk.r, 0.5)).rgb * mix(0.42, 1.12, s);
            c *= mix(uShadowTint, vec3(1.0), esk.g);                    // cast shadow, bluish as under an open sky
            c *= mix(uAoFloor, 1.0, esk.b);                             // hollows and ravines get less sky
          }
          c = mix(c, c * 0.86, uDark);
          // the air between the eye and the ground, in real kilometres: its density falls off with height (thick in the
          // valleys, thin on the peaks), and the path is the distance behind the point looked at plus a share of the lens
          // distance (an orthographic camera has no eye: this stands in for it). A 50 km district gets a veil toward its far
          // side; the 4 km block next door, almost none; that difference is the scale.
          float hKm = vP.y / max(uExag, 1e-3);
          float density = exp(-max(hKm - uAir.y, 0.0) / uAir.z);
          float path = max(0.0, uAirShape.x * uViewD + (vDepth - uRCam));
          c = mix(c, uAirColor, min(1.0 - exp(-uAir.x * density * path), uAirShape.y) * uAir.w);
          gl_FragColor = vec4(c, uAlpha);
        }`,
    });
    const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2), hz = new Float32Array(n);
    const pr = mesh.pixelRows, pc = mesh.pixelCols, dr = site.dem.rows - 1, dc = site.dem.cols - 1;
    for (let r = 0; r < R; r++) for (let c = 0; c < Cn; c++) {
      const i = r * Cn + c;
      pos[i * 3] = X[c]; pos[i * 3 + 1] = 0; pos[i * 3 + 2] = -Yn[r];
      uv[i * 2] = pc[c] / dc; uv[i * 2 + 1] = 1 - pr[r] / dr;                                   // the textures are DEM pixels: no reprojection
      hz[i] = H[i] / 1000;
    }
    const idx = new Uint32Array((R - 1) * (Cn - 1) * 6);
    let q = 0;
    for (let r = 0; r < R - 1; r++) for (let c = 0; c < Cn - 1; c++) { const a = r * Cn + c, b = a + 1, d = a + Cn, e = d + 1; idx.set([a, d, b, b, d, e], q); q += 6; }
    const tgeo = new THREE.BufferGeometry();
    tgeo.setAttribute("position", new THREE.BufferAttribute(pos, 3)); tgeo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    tgeo.setAttribute("hz", new THREE.BufferAttribute(hz, 1)); tgeo.setIndex(new THREE.BufferAttribute(idx, 1));
    tgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3((X[0] + X[Cn - 1]) / 2, 2, -(Yn[0] + Yn[R - 1]) / 2), 60);
    const terrain = new THREE.Mesh(tgeo, terrainMat); terrain.renderOrder = 1; scene.add(terrain);

    // height field lookups [m]: the mesh is regular in (east, north) to well under a metre of the UTM grid
    const x0 = X[0], dxk = (X[Cn - 1] - X[0]) / (Cn - 1), y0 = Yn[0], dyk = (Yn[R - 1] - Yn[0]) / (R - 1);
    function heightAt(x, y) {
      const fc = (x - x0) / dxk, fr = (y - y0) / dyk;
      if (fc < 0 || fr < 0 || fc > Cn - 1 || fr > R - 1) return NaN;
      const c = Math.min(Math.floor(fc), Cn - 2), r = Math.min(Math.floor(fr), R - 2), u = fc - c, v = fr - r, i = r * Cn + c;
      return (H[i] * (1 - u) + H[i + 1] * u) * (1 - v) + (H[i + Cn] * (1 - u) + H[i + Cn + 1] * u) * v;
    }

    // ---------------------------------------------------------------- the city: buildings (export_buildings.py)
    // Every footprint stands on the mesh: its walls go from below the lowest ground under it (a footing, so a slope never
    // shows a gap) to its height above the highest. The ground part follows the relief's exaggeration in the shader, the
    // height stays true, so the slider costs nothing. On by default (not on a phone): fetched once the map is on screen and
    // the camera has landed (never during the globe's dive or a flight, which it would make stutter), built 2 km chunk by
    // chunk around where the camera looks (a few milliseconds a frame, none while flying), seen from any distance (the
    // level of detail keeps only the footprints of about a pixel or more), rising from the ground each time it appears,
    // as a city does in Google Earth; chunks far from the view are released past BLD.maxVertices. Lit by the map's own
    // north-west sun, with flat faces from screen derivatives (no normals stored) and a darker foot where the walls meet the ground.
    const BLD = { footingM: 8, maxVertices: 7e6, wholeBelowM2: 60, budgetMs: 10, riseMs: 900 };
    // the city's colour against each palette ([night, day]): the ground it stands on decides it, so the city reads as
    // a model set on the relief, never in a colour that fights the map's own
    const BLD_COLOUR = {
      map: [0xdde3ea, 0xffffff],                                      // a cool white on the warm sand
      relief: [0xe6e8ec, 0xffffff],
      elevation: [0xe8e4dc, 0xf7f3ea],                                // a pale stone over the magma
      hypsometric: [0xf2ede2, 0xfffdf6],                              // a warm white over the greens
      ao: [0xc49a76, 0xc89c76],                                       // terracotta on the grey clay
      curvature: [0x6f7480, 0x7d828d],                                // a graphite on the pale flat ground
    };
    const cityColour = () => BLD_COLOUR[state.palette][state.theme === "dark" ? 0 : 1];
    const bldU = { uExag: terrainU.uExag, uAir: terrainU.uAir, uAirColor: terrainU.uAirColor, uViewD: terrainU.uViewD, uRCam: terrainU.uRCam,
                   uAirShape: terrainU.uAirShape, uColor: { value: new THREE.Color(cityColour()) }, uRise: { value: 0 }, uFade: { value: 1 },
                   // Indirect irradiance: a cool open sky and a warmer terrain bounce.  The contrast is deliberately
                   // carried by the city geometry so the DEM's baked sun/shadow/AO information stays untouched.
                   uSkyLight: { value: new THREE.Color(0.13, 0.25, 0.52) }, uGroundBounce: { value: new THREE.Color(0.18, 0.07, 0.015) },
                   uView: { value: new THREE.Vector3(0, 1, 0) },
                   uSun: { value: new THREE.Vector3(-Math.SQRT1_2 * Math.cos(0.61), Math.sin(0.61), -Math.SQRT1_2 * Math.cos(0.61)) } };   // NW, 35° up
    const bldMat = new THREE.ShaderMaterial({
      uniforms: bldU, side: THREE.DoubleSide, clipping: true, ...clipOpts(), extensions: { derivatives: true },
      vertexShader: `${LOGV}#include <clipping_planes_pars_vertex>
        attribute float h; uniform float uExag, uRise; varying vec3 vP; varying float vDepth, vH;
        void main(){ vec3 p = position; p.y = position.y * uExag + h * uRise / 1000.0; vP = p; vH = h;
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0); vDepth = -mvPosition.z; gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
          #include <clipping_planes_vertex>
        }`,
      fragmentShader: `${LOGF}#include <clipping_planes_pars_fragment>
        uniform vec3 uColor, uSun, uView, uAirColor, uSkyLight, uGroundBounce; uniform vec4 uAir; uniform vec2 uAirShape; uniform float uExag, uViewD, uRCam, uFade;
        varying vec3 vP; varying float vDepth, vH;
        void main(){
          #include <clipping_planes_fragment>
          #include <logdepthbuf_fragment>
          vec3 n = normalize(cross(dFdx(vP), dFdy(vP)));
          if (dot(n, uView) < 0.0) n = -n;                              // the face toward the camera
          // roofs take the open sky and the sun; walls a little sky and the sun on the faces that turn to it, so the
          // north-west faces read lit and the south-east ones in shade, as the relief's own hillshade
          float roof = smoothstep(0.85, 0.95, n.y);
          float sun = max(dot(n, uSun), 0.0);
          float light = mix(0.40 + 0.62 * sun, 0.80 + 0.30 * sun, roof);
          float foot = mix(mix(0.62, 1.0, smoothstep(0.0, 10.0, vH)), 1.0, roof);   // walls darken where they meet the ground
          vec3 c = uColor * light * foot;
          // Screen-friendly global illumination: its colour, rather than just its brightness, separates planes.
          // Upward faces see the cool sky; shaded walls pick up the warmer basin below.  Neither acts as a second sun.
          float skyIrradiance = mix(0.28, 1.0, max(n.y, 0.0));
          float shadedWall = (1.0 - roof) * (1.0 - sun);
          c += uSkyLight * (0.18 * skyIrradiance) + uGroundBounce * (0.14 * shadedWall);
          float hKm = vP.y / max(uExag, 1e-3);                            // the same air as the relief
          float density = exp(-max(hKm - uAir.y, 0.0) / uAir.z);
          float path = max(0.0, uAirShape.x * uViewD + (vDepth - uRCam));
          c = mix(c, uAirColor, min(1.0 - exp(-uAir.x * density * path), uAirShape.y) * uAir.w);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    const city = new THREE.Group(); city.visible = false; scene.add(city);
    let bld = null, bldLoading = null, riseFrom = null;
    const built = new Map();                                          // chunk index -> mesh
    function loadBuildings() {
      if (bldLoading) return bldLoading;
      bldLoading = (async () => {
        const meta = await (await fetch("data/buildings/buildings.json")).json();
        const response = await fetch(meta.file);
        if (!response.ok) throw new Error(`${meta.file}: HTTP ${response.status}`);
        const buffer = await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
        const n = meta.count, counts = new Uint8Array(buffer, 0, n);
        const hdm = new Uint16Array(buffer.slice(n, n + 2 * n)), steps = new Int16Array(buffer.slice(3 * n));
        bld = { meta, counts, hdm, steps };
        requestRender();
        return meta;
      })();
      bldLoading.catch(error => { console.error(error); bldLoading = null; });
      return bldLoading;
    }
    // floor [m²]: build only the buildings at least this large (from afar the rest would never be drawn; the chunk is
    // built again, whole or with a lower floor, when the view comes close enough to need them)
    function buildChunk(ch, floor = 0) {
      const { counts, hdm, steps, meta } = bld, q = meta.quantum_m;
      const pos = new Float32Array(ch.vertices * 6), hh = new Float32Array(ch.vertices * 2), ix = [];
      // the level of detail: the file lists a chunk's buildings largest first, so the first n are the ones that still
      // show from further away; area[b] and cum[b] (the index count up to b) let a frame draw just those
      const area = new Float32Array(ch.count), cum = new Uint32Array(ch.count + 1);
      let s = ch.first_vertex * 2, v = 0, n = ch.count;
      const xs = [], ys = [], gs = [];
      for (let b = ch.first; b < ch.first + ch.count; b++) {
        const m = counts[b], H = hdm[b] / 10;
        let x = ch.x0_km * 1000, y = ch.y0_km * 1000, gMin = Infinity, gMax = -Infinity;
        xs.length = ys.length = gs.length = 0;
        for (let k = 0; k < m; k++) {
          x += steps[s++] * q; y += steps[s++] * q;
          const g = heightAt(x / 1000, y / 1000);
          xs.push(x / 1000); ys.push(y / 1000); gs.push(g);
          if (g < gMin) gMin = g; if (g > gMax) gMax = g;
        }
        let a2 = 0;
        for (let k = 0; k < m; k++) { const k1 = (k + 1) % m; a2 += xs[k] * ys[k1] - xs[k1] * ys[k]; }
        area[b - ch.first] = Math.abs(a2) * 5e5;                          // km² -> m², halved
        if (area[b - ch.first] < floor) { n = b - ch.first; break; }      // the rest are smaller still
        if (!isFinite(gMin)) { v += 2 * m; cum[b - ch.first + 1] = ix.length; continue; }   // (outside the relief: kept as empty vertices)
        for (let k = 0; k < m; k++) {
          const lo = 3 * (v + k), hi = 3 * (v + m + k);
          pos[lo] = pos[hi] = xs[k]; pos[lo + 2] = pos[hi + 2] = -ys[k];
          pos[lo + 1] = gMin / 1000; hh[v + k] = -BLD.footingM;
          pos[hi + 1] = gMax / 1000; hh[v + m + k] = H;
        }
        for (let k = 0; k < m; k++) {
          const a = v + k, b2 = v + (k + 1) % m, c = a + m, d = b2 + m;
          ix.push(a, b2, d, a, d, c);
        }
        if (m === 4 || m === 3) { for (let k = 1; k < m - 1; k++) ix.push(v + m, v + m + k, v + m + k + 1); }
        else {
          const tri = THREE.ShapeUtils.triangulateShape(xs.map((px, k) => new THREE.Vector2(px, ys[k])), []);
          for (const t of tri) ix.push(v + m + t[0], v + m + t[1], v + m + t[2]);
        }
        v += 2 * m;
        cum[b - ch.first + 1] = ix.length;
      }
      const g = new THREE.BufferGeometry();
      const whole = n === ch.count;
      g.setAttribute("position", new THREE.BufferAttribute(whole ? pos : pos.slice(0, 3 * v), 3)); g.setAttribute("h", new THREE.BufferAttribute(whole ? hh : hh.slice(0, v), 1));
      g.setIndex(new THREE.BufferAttribute(new Uint32Array(ix), 1));
      // (the heights and the exaggeration live in the shader, so the stored bounds would be wrong: chunks are only built
      // around the view anyway)
      const mesh = new THREE.Mesh(g, bldMat); mesh.renderOrder = 1; mesh.frustumCulled = false;
      mesh.userData = { verts: v, used: 0, area: whole ? area : area.slice(0, n), cum: whole ? cum : cum.slice(0, n + 1), floor: whole ? 0 : floor };
      return mesh;
    }
    // per frame: fetch the city once the camera rests, build the chunks around the view (nearest first, within the budget,
    // not while flying), release far ones past the vertex budget; true while there is more to build
    const viewProj = new THREE.Matrix4(), corner = new THREE.Vector3();
    function chunkOnScreen(ch, size) {
      if (!ch.ground) {                                               // its relief, once: the lowest and highest of a 5 x 5 sample [km]
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
          const g = heightAt(ch.x0_km + size * i / 4, ch.y0_km + size * j / 4);
          if (Number.isFinite(g)) { lo = Math.min(lo, g); hi = Math.max(hi, g); }
        }
        ch.ground = Number.isFinite(lo) ? [lo / 1000 - 0.05, hi / 1000 + 0.05] : [0, 0];
      }
      const yLo = ch.ground[0] * state.exag, yHi = ch.ground[1] * state.exag + 0.15;   // + the tallest building
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let c = 0; c < 8; c++) {
        corner.set(ch.x0_km + (c & 1 ? size : 0), c & 2 ? yHi : yLo, -(ch.y0_km + (c & 4 ? size : 0))).applyMatrix4(viewProj);
        x0 = Math.min(x0, corner.x); x1 = Math.max(x1, corner.x); y0 = Math.min(y0, corner.y); y1 = Math.max(y1, corner.y);
      }
      return x1 > -1.1 && x0 < 1.1 && y1 > -1.1 && y0 < 1.1;
    }
    let lastCity = -1, cityBusy = false;                            // the frame's clock, for the tests' count of chunks in view; still building
    function updateCity(now) {
      lastCity = now;
      const flying = !!(flight || glide);
      if (state.show.buildings && !bld && !bldLoading && !flying) loadBuildings().then(requestRender, () => {});
      const want = !!(state.show.buildings && bld);
      if (want && !city.visible) { riseFrom = now; bldU.uRise.value = 0; }   // it rises from the ground each time it appears
      city.visible = want;
      if (!want) return false;
      if (riseFrom !== null) {
        const u = Math.min(1, (now - riseFrom) / BLD.riseMs); bldU.uRise.value = 1 - Math.pow(1 - u, 3);
        if (u >= 1) riseFrom = null;
      }
      bldU.uView.value.copy(camera.position).sub(controls.target).normalize();
      // the chunks on screen: each one's box (its ground, from the relief's lowest to highest point under it, up to the
      // tallest tower) projected through the camera, against the screen with a margin. (A circle around the target,
      // sized by the lens distance, missed the near and far ground of a grazing view: the city ended in a straight edge.)
      const { meta } = bld, t = controls.target, cx = t.x, cy = -t.z, size = meta.chunk_km;
      camera.updateMatrixWorld();
      viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      const order = [];
      meta.chunks.forEach((ch, k) => { if (chunkOnScreen(ch, size)) order.push([k, Math.hypot(ch.x0_km + size / 2 - cx, ch.y0_km + size / 2 - cy)]); });
      order.sort((a, b) => a[1] - b[1]);
      // the buildings whose footprint covers about a pixel at this distance are drawn (largest first: a binary search
      // for the cut); from a few km in, all of them. A chunk is built down to a quarter of that area (so the view can
      // come twice as close before it is built again), or whole once that would be most of it anyway
      const mPerPx = 2 * viewDist() * HALF * 1000 / Math.max(container.clientHeight, 1), minArea = (0.6 * mPerPx) ** 2;
      const floor = minArea < BLD.wholeBelowM2 ? 0 : minArea / 4;
      const t0 = performance.now();
      let more = false;
      for (const [k] of order) {
        let mesh = built.get(k);
        if (!mesh || mesh.userData.floor > minArea) {                 // missing, or missing buildings this view draws
          if (flight || performance.now() - t0 > BLD.budgetMs) more = true;
          else {
            if (mesh) { city.remove(mesh); mesh.geometry.dispose(); }
            mesh = buildChunk(meta.chunks[k], floor); built.set(k, mesh); city.add(mesh);
          }
        }
        if (mesh) mesh.userData.used = now;
      }
      built.forEach(m => {
        const { area, cum } = m.userData;
        let lo = 0, hi = area.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (area[mid] >= minArea) lo = mid + 1; else hi = mid; }
        m.geometry.setDrawRange(0, cum[lo]); m.visible = cum[lo] > 0 && m.userData.used === now;   // and only around the view
      });
      let total = 0; built.forEach(m => (total += m.userData.verts));
      if (total > BLD.maxVertices) {
        const old = [...built.entries()].sort((a, b) => a[1].userData.used - b[1].userData.used);
        for (const [k, m] of old) {
          if (total <= BLD.maxVertices * 0.8 || m.userData.used === now) break;
          city.remove(m); m.geometry.dispose(); built.delete(k); total -= m.userData.verts;
        }
      }
      return more || riseFrom !== null;
    }

    // ---------------------------------------------------------------- thickness: walls and floor
    const walls = new THREE.Group(); scene.add(walls);
    let shadowTex = null;
    function shadowTexture() {                                        // a blurred dark rectangle, alpha only
      if (shadowTex) return shadowTex;
      const cv = document.createElement("canvas"); cv.width = cv.height = 256;
      const g = cv.getContext("2d"); g.filter = "blur(18px)"; g.fillStyle = "rgba(0,0,0,0.85)"; g.fillRect(52, 52, 152, 152);
      shadowTex = new THREE.CanvasTexture(cv); return shadowTex;
    }
    let matcapTex = null;
    function matcap() {                                               // a lit sphere for MeshMatcapMaterial: pins and spheres get volume
      if (matcapTex) return matcapTex;
      const cv = document.createElement("canvas"); cv.width = cv.height = 128;
      const g = cv.getContext("2d"), grd = g.createRadialGradient(46, 40, 6, 64, 64, 64);
      grd.addColorStop(0, "#ffffff"); grd.addColorStop(0.45, "#d8d8d8"); grd.addColorStop(0.85, "#8a8a8a"); grd.addColorStop(1, "#5a5a5a");
      g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
      matcapTex = new THREE.CanvasTexture(cv); return matcapTex;
    }
    function buildWalls() {
      for (const o of [...walls.children]) { walls.remove(o); o.geometry.dispose(); o.material.dispose(); }
      const dark = state.theme === "dark", tone = dark ? [0x3a3127, 0x2f2820, 0x262019] : [0x9c8b77, 0x8b7a67, 0x7a6a58];
      // each wall fades from its tone under the terrain's edge (a light rim) to a dark foot, so the block has weight
      const edge = (cells, shade) => {
        const p = [], col = [], ix = [], top = new THREE.Color(shade).multiplyScalar(1.25), foot = new THREE.Color(shade).multiplyScalar(0.45);
        cells.forEach(([r, c], k) => {
          const i = r * Cn + c; p.push(X[c], toY(H[i]), -Yn[r], X[c], toY(baseM), -Yn[r]); col.push(top.r, top.g, top.b, foot.r, foot.g, foot.b);
          if (k) ix.push(2 * k - 2, 2 * k - 1, 2 * k, 2 * k, 2 * k - 1, 2 * k + 1);
        });
        const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3)); g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3)); g.setIndex(ix);
        walls.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, ...clipOpts() })));
      };
      // the walls and the floor take the terrain's opacity (a see-through relief keeps its sides, see-through too)
      edge(Array.from({ length: Cn }, (_, c) => [R - 1, c]), tone[0]);                          // south (front)
      edge(Array.from({ length: R }, (_, r) => [r, 0]), tone[1]);                               // west
      edge(Array.from({ length: R }, (_, r) => [r, Cn - 1]), tone[1]);                          // east
      edge(Array.from({ length: Cn }, (_, c) => [0, c]), tone[2]);                              // north
      const fg = new THREE.PlaneGeometry(X[Cn - 1] - X[0], Yn[0] - Yn[R - 1]); fg.rotateX(-Math.PI / 2);
      fg.translate((X[0] + X[Cn - 1]) / 2, toY(baseM), -(Yn[0] + Yn[R - 1]) / 2);
      walls.add(new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: new THREE.Color(tone[2]).multiplyScalar(0.5), side: THREE.DoubleSide, ...clipOpts() })));
      // a soft contact shadow under the floor, thrown to the south-east (the sun is in the north-west): the block sits, it does not float
      const sg = new THREE.PlaneGeometry((X[Cn - 1] - X[0]) * 1.5, (Yn[0] - Yn[R - 1]) * 1.5); sg.rotateX(-Math.PI / 2);
      sg.translate((X[0] + X[Cn - 1]) / 2 + 4, toY(baseM) - 0.4, -(Yn[0] + Yn[R - 1]) / 2 + 4);
      const ground = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: dark ? 0.9 : 0.55 }));
      ground.renderOrder = -1; ground.userData.shadow = true; ground.userData.opacity = ground.material.opacity; walls.add(ground);
      walls.userData.exag = state.exag; walls.scale.y = 1;
      wallAlpha();
    }
    // Every wall vertex sits at y = elevation × exaggeration, so the box built at one exaggeration is the box of another
    // scaled in y: the shader-only previews (the dive's rise, ×1.5 → ×1) stretch it every frame instead of leaving it flat
    // until the rebuild at the end, where it used to jump. The contact shadow fades in with the height.
    function stretchWalls() {
      const s = walls.userData.exag ? state.exag / walls.userData.exag : 1;
      walls.scale.y = s;
      for (const m of walls.children) if (m.userData.shadow) m.material.opacity = m.userData.opacity * Math.min(1, s);
    }
    function wallAlpha() {
      const a = state.alpha, see = a < 0.99;
      walls.visible = state.show.terrain;
      for (const m of walls.children) {
        if (m.userData.shadow) { m.visible = !see; continue; }       // a contact shadow under a glass block would be a smudge
        m.material.transparent = see; m.material.opacity = a; m.material.depthWrite = !see; m.material.needsUpdate = true;
      }
    }

    // ---------------------------------------------------------------- the faces of a cut (and the 2D model in the A–B plane)
    // Every face reads the relief's own heights (a float texture of the mesh nodes, filtered bilinearly as heightAt is), so
    // it ends exactly under the terrain; it is coloured by depth below the terrain with 1 km ticks. Where a face is the A–B
    // plane, under segment 3, it shows the very medium of the block (and, in the earthquake chapter, the replayed
    // wavefield): the 2D model lives in that plane and nowhere else.
    const hgt = new Float32Array(n * 4);
    for (let r = 0; r < R; r++) for (let c = 0; c < Cn; c++) hgt[((R - 1 - r) * Cn + c) * 4] = H[r * Cn + c] / 1000;   // texture row 0 = south
    const hgtTex = new THREE.DataTexture(hgt, Cn, R, THREE.RGBAFormat, THREE.FloatType);
    hgtTex.magFilter = hgtTex.minFilter = THREE.LinearFilter; hgtTex.needsUpdate = true;
    const segA = site.segment.xy_km[0], segB = site.segment.xy_km[site.segment.xy_km.length - 1];
    const blank = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat); blank.needsUpdate = true;
    const capU = { uHgt: { value: hgtTex }, uBox: { value: new THREE.Vector4(X[0], X[Cn - 1], Yn[R - 1], Yn[0]) }, uN: { value: new THREE.Vector2(Cn, R) },
                   uExag: { value: state.exag }, uSecY: { value: secY },
                   uMed: { value: blank }, uMedOn: { value: 0 }, uMa: { value: segA[0] }, uMb: { value: segB[0] },
                   uTop: { value: model.top_elevation_m / 1000 }, uDepth: { value: model.depth_m / 1000 }, uGrow: { value: 1 }, uDark: { value: 0 } };
    const capMat = new THREE.ShaderMaterial({
      uniforms: capU, side: THREE.DoubleSide,
      vertexShader: `${LOGV}varying vec3 vP; void main(){ vP = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vP, 1.0);
        #include <logdepthbuf_vertex>
        }`,
      fragmentShader: `${LOGF}uniform sampler2D uHgt, uMed; uniform vec4 uBox; uniform vec2 uN;
        uniform float uExag, uSecY, uMedOn, uMa, uMb, uTop, uDepth, uGrow, uDark; varying vec3 vP;
        void main(){
          #include <logdepthbuf_fragment>
          float north = -vP.z;
          vec2 g = vec2((vP.x - uBox.x) / (uBox.y - uBox.x), (north - uBox.z) / (uBox.w - uBox.z));   // 0–1 over the relief
          if (g.x < -0.001 || g.x > 1.001 || g.y < -0.001 || g.y > 1.001) discard;
          if (g.x > uGrow) discard;                                  // the prologue draws the section from A to B
          float top = texture2D(uHgt, (clamp(g, 0.0, 1.0) * (uN - 1.0) + 0.5) / uN).r * uExag;
          if (vP.y > top) discard;
          float elev = vP.y / uExag, below = top / uExag - elev;     // km a.s.l., km under the terrain
          vec3 c = mix(vec3(0.62, 0.55, 0.46), vec3(0.27, 0.28, 0.35), clamp(below / 6.0, 0.0, 1.0));
          float q = below; float f = abs(fract(q - 0.5) - 0.5) / fwidth(q);
          c = mix(c, c * 1.25, (1.0 - clamp(f, 0.0, 1.0)) * 0.45);          // 1 km ticks
          c = mix(c, c * (1.0 - 0.25 * uDark), 1.0);
          if (uMedOn > 0.5 && abs(north - uSecY) < 0.002 && fwidth(vP.z) < 1e-5 && vP.x >= uMa && vP.x <= uMb) {   // A–B itself, not a face crossing it
            vec2 mv = vec2((vP.x - uMa) / (uMb - uMa), (uTop - elev) / uDepth);
            if (mv.y >= 0.0 && mv.y <= 1.0) { vec4 m = texture2D(uMed, vec2(mv.x, mv.y)); if (m.a > 0.5) c = m.rgb; }
          }
          c = mix(vec3(0.96, 0.93, 0.86), c, smoothstep(0.0, 0.03 * uExag, top - vP.y));   // a light rim at the surface
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    // south: y = off (the A–B section when off = secY) · east: x = off · quadrant: x = qx and y = qy, each down to the other ·
    // top: a horizontal face at the cut's elevation. A unit plane, scaled and placed by placeCaps().
    const caps = {};
    for (const [name, turn] of [["south", null], ["east", "y"], ["qx", "y"], ["qy", null], ["top", "x"]]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), capMat);
      if (turn === "y") m.rotation.y = Math.PI / 2; if (turn === "x") m.rotation.x = -Math.PI / 2;
      m.visible = false; m.userData = { kind: "section" }; caps[name] = m; scene.add(m);
    }
    const quad = [segB[0] + 0.4, secY];                                // the quadrant's corner: its south face is A–B, all of segment 3
    function placeCaps() {
      const topY = toY(site.dem.elevation_range_m[1]) + 0.1, botY = toY(baseM), h = topY - botY, midY = (topY + botY) / 2;
      const xw = X[0], xe = X[Cn - 1], ys = Yn[R - 1], yn = Yn[0], { mode, off } = state.cut;
      for (const m of Object.values(caps)) m.visible = false;
      const put = (m, w, hh, x, y, z) => { m.scale.set(w, hh, 1); m.position.set(x, y, z); m.visible = true; };
      if (mode === "south") put(caps.south, xe - xw, h, (xw + xe) / 2, midY, -off);
      if (mode === "east") put(caps.east, yn - ys, h, off, midY, -(ys + yn) / 2);
      if (mode === "quadrant") { put(caps.qy, quad[0] - xw, h, (xw + quad[0]) / 2, midY, -quad[1]); put(caps.qx, quad[1] - ys, h, quad[0], midY, -(ys + quad[1]) / 2); }
      if (mode === "top") put(caps.top, xe - xw, yn - ys, (xw + xe) / 2, toY(off), -(ys + yn) / 2);
    }
    function setClip() {                                               // the planes keep n·p + c >= 0
      const { mode, off } = state.cut, P = (x, y, z, c) => new THREE.Plane(new THREE.Vector3(x, y, z), c);
      clipPlanes.length = 0;
      if (mode === "south") clipPlanes.push(P(0, 0, -1, -off));        // keeps north of y = off (z = -north)
      if (mode === "east") clipPlanes.push(P(-1, 0, 0, off));
      if (mode === "top") clipPlanes.push(P(0, -1, 0, toY(off)));
      if (mode === "quadrant") clipPlanes.push(P(1, 0, 0, -quad[0]), P(0, 0, -1, -quad[1]));
    }
    // a point of the scene that the cut removes (picking and the ray-march use it)
    // (tol [km] spares what lies on a face: the receivers and the rupture sit exactly on A–B)
    function isCut(p, tol = 0) {
      const { mode, off } = state.cut;
      return mode === "south" ? -p.z < off - tol : mode === "east" ? p.x > off + tol : mode === "top" ? p.y > toY(off) + tol
        : mode === "quadrant" ? p.x < quad[0] - tol && -p.z < quad[1] - tol : false;
    }
    // the slider's range per mode, and where each mode starts
    const CUT_RANGE = { south: [Yn[R - 1], Yn[0]], east: [X[0], X[Cn - 1]], top: site.dem.elevation_range_m };
    const cutDefault = mode => ({ south: secY, east: (segA[0] + segB[0]) / 2, top: 2800 })[mode] ?? 0;
    // the medium texture the block also shows: (nx-1) x (nz-1) cells, alpha 0 in the air (app.js hands it over)
    let medTex = null;
    function setSectionMedium(rgba, nx, nz, mask) {
      const data = new Uint8Array((nx - 1) * (nz - 1) * 4);
      for (let iz = 0; iz < nz - 1; iz++) for (let ix = 0; ix < nx - 1; ix++) {
        const p = (iz * (nx - 1) + ix) * 4;
        data[p] = rgba[p]; data[p + 1] = rgba[p + 1]; data[p + 2] = rgba[p + 2]; data[p + 3] = mask[iz * nx + ix] > 0.5 ? 255 : 0;
      }
      if (!medTex || medTex.image.width !== nx - 1) {
        medTex = new THREE.DataTexture(data, nx - 1, nz - 1, THREE.RGBAFormat); medTex.magFilter = medTex.minFilter = THREE.NearestFilter;
        medTex.flipY = false; capU.uMed.value = medTex;
      } else medTex.image.data.set(data);
      medTex.needsUpdate = true; requestRender();
    }

    // ---------------------------------------------------------------- vectors
    const overlays = new THREE.Group(); scene.add(overlays);
    const W = (x, y, zM, lift = 0) => new THREE.Vector3(x, toY(zM + lift), -y);
    const drape = (x, y, lift) => W(x, y, (heightAt(x, y) || site.dem.elevation_range_m[0]), lift);
    function densify(line, stepKm = 0.12) {
      const out = [];
      for (let k = 1; k < line.length; k++) {
        const a = line[k - 1], b = line[k], s = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / stepKm));
        for (let j = k > 1 ? 1 : 0; j <= s; j++) out.push([a[0] + (b[0] - a[0]) * j / s, a[1] + (b[1] - a[1]) * j / s]);
      }
      return out;
    }
    const inside = p => p[0] >= X[0] && p[0] <= X[Cn - 1] && p[1] <= Yn[0] && p[1] >= Yn[R - 1];
    // the stretches of a densified line that lie over the relief (a line that leaves and re-enters is two stretches,
    // never one chord floating across the gap)
    function stretches(points) {
      const out = []; let run = [];
      for (const p of points) { if (inside(p)) run.push(p); else if (run.length) { out.push(run); run = []; } }
      if (run.length) out.push(run);
      return out.filter(r => r.length > 1);
    }
    const longest = runs => runs.reduce((a, b) => (b.length > a.length ? b : a), []);
    // tubes keep their width on screen: the vertex shader pulls each ring toward the centre line as the camera closes in
    // (a TubeGeometry vertex is centre + normal * radius); uBoost widens the one fault the table picked
    const tubeScale = { value: 1 }, TUBE_FULL_KM = 24;
    // the pins and the halo shrink the same way below 10 km, so a close look at the segment is not a wall of orange balls
    let pinScale = 1;
    const pinTop = g => g.userData.base.clone().add(new THREE.Vector3(0, g.userData.stem * pinScale, 0));
    function tubeMaterial(color, opacity, radius) {
      const m = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, ...clipOpts() });
      m.userData.boost = { value: 1 };
      m.onBeforeCompile = sh => {
        Object.assign(sh.uniforms, { uTubeScale: tubeScale, uTubeR: { value: radius }, uBoost: m.userData.boost });
        sh.vertexShader = "uniform float uTubeScale, uTubeR, uBoost;\n" +
          sh.vertexShader.replace("#include <begin_vertex>", "vec3 transformed = position - normal * uTubeR * (1.0 - uTubeScale * uBoost);");
      };
      return m;
    }
    function tube(points, radius, color, opacity = 1, tag = null) {
      if (points.length < 2) { const m = new THREE.Mesh(new THREE.BufferGeometry(), tubeMaterial(color, opacity, radius)); m.visible = false; if (tag) m.userData = tag; overlays.add(m); return m; }
      const m = new THREE.Mesh(new THREE.TubeGeometry(new Polyline(points), Math.max(8, points.length * 2), radius, 6, false), tubeMaterial(color, opacity, radius));
      m.renderOrder = 3; if (tag) m.userData = tag; overlays.add(m); return m;
    }
    function lines(rings, color, opacity, lift) {
      const p = [];
      for (const ring of rings) for (const d of stretches(densify(ring, 0.25))) for (let k = 1; k < d.length; k++) { const a = drape(...d[k - 1], lift), b = drape(...d[k], lift); p.push(a.x, a.y, a.z, b.x, b.y, b.z); }
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
      const m = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, ...clipOpts() }));
      m.renderOrder = 2; overlays.add(m); return m;
    }
    const planeU = () => ({ uAlpha: { value: 0.55 }, uColor: { value: new THREE.Color(C.plane) } });
    function faultPlane(f) {
      // a strip between the trace's top and bottom edges, cut at the model's floor so it never pokes out of the block
      const p = f.plane, top = p.top_xy_km, bot = p.bottom_xy_km, n0 = top.length, pts = [], uvs = [], ix = [];
      // only the columns whose whole down-dip line stays over the relief: a plane must never float beside the block
      const keep = [];
      for (let k = 0; k < n0; k++) {                                  // test the point where the plane meets the model's floor
        const zt = p.top_z_m[k], zb = p.bottom_z_m[k], t = zb < baseM ? (zt - baseM) / (zt - zb) : 1;
        const cut = [top[k][0] + (bot[k][0] - top[k][0]) * t, top[k][1] + (bot[k][1] - top[k][1]) * t];
        if (inside(top[k]) && inside(cut)) keep.push(k);
      }
      if (keep.length < 2) { const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()); m.visible = false; m.userData = { kind: "plane", fault: f }; overlays.add(m); return m; }
      for (let j = 0; j < keep.length; j++) {
        const k = keep[j];
        const zt = p.top_z_m[k], zb = p.bottom_z_m[k], t = zb < baseM ? (zt - baseM) / (zt - zb) : 1;
        const bx = top[k][0] + (bot[k][0] - top[k][0]) * t, by = top[k][1] + (bot[k][1] - top[k][1]) * t, bz = zt + (zb - zt) * t;
        const a = W(top[k][0], top[k][1], zt), b = W(bx, by, bz);
        pts.push(a.x, a.y, a.z, b.x, b.y, b.z); uvs.push(k, 0, k, (zt - bz) / 1000);
        if (j) ix.push(2 * j - 2, 2 * j - 1, 2 * j, 2 * j, 2 * j - 1, 2 * j + 1);
      }
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3)); g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2)); g.setIndex(ix);
      const mat = new THREE.ShaderMaterial({ uniforms: planeU(), transparent: true, depthWrite: false, side: THREE.DoubleSide, ...clipOpts(), clipping: true,
        vertexShader: `${LOGV}#include <clipping_planes_pars_vertex>
          varying vec2 vUv; void main(){ vUv = uv; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
          #include <logdepthbuf_vertex>
          #include <clipping_planes_vertex>
          }`,
        fragmentShader: `${LOGF}#include <clipping_planes_pars_fragment>
          uniform float uAlpha; uniform vec3 uColor; varying vec2 vUv;
          void main(){
            #include <clipping_planes_fragment>
            #include <logdepthbuf_fragment>
            float q = vUv.y; float f = abs(fract(q - 0.5) - 0.5) / fwidth(q);    // a line every km of depth
            float g = 1.0 - clamp(f, 0.0, 1.0);
            gl_FragColor = vec4(mix(uColor, vec3(1.0), g * 0.6), uAlpha * (0.55 + 0.45 * g));
          }` });
      const m = new THREE.Mesh(g, mat); m.renderOrder = 2; m.userData = { kind: "plane", fault: f }; overlays.add(m); return m;
    }

    const groups = {};
    function buildOverlays() {
      for (const o of [...overlays.children]) { overlays.remove(o); o.geometry.dispose(); o.material.dispose(); }
      const dark = state.theme === "dark";
      groups.zones = lines(site.zones.flatMap(z => z.rings), dark ? 0xffffff : 0x334155, dark ? 0.32 : 0.42, 25);
      groups.urban = lines(site.urban.rings, C.urban, 0.9, 30);
      groups.faults = site.faults.map(f => tube(longest(stretches(densify(f.trace_xy_km))).map(p => drape(p[0], p[1], 35)), 0.06, C.fault, 1, { kind: "fault", fault: f }));
      groups.planes = site.faults.map(faultPlane);
      const sec = site.section.xy_km, cut = Math.max(2, Math.round(sec.length * state.grow));
      groups.section = tube(sec.slice(0, cut).map(p => drape(p[0], p[1], 45)), 0.045, C.section);
      groups.segment = tube(densify(site.segment.xy_km, 0.05).map(p => drape(p[0], p[1], 55)), 0.08, C.segment, 1, { kind: "segment" });
      const f = site.footprint_xy_km, pts = [], ix = [], along = 40, across = 8;
      for (let j = 0; j <= across; j++) for (let i = 0; i <= along; i++) {
        const u = i / along, v = j / across, x = f[0][0] + (f[1][0] - f[0][0]) * u + (f[3][0] - f[0][0]) * v, y = f[0][1] + (f[1][1] - f[0][1]) * u + (f[3][1] - f[0][1]) * v;
        pts.push(drape(x, y, 20));
      }
      for (let j = 0; j < across; j++) for (let i = 0; i < along; i++) { const a = j * (along + 1) + i; ix.push(a, a + 1, a + along + 2, a, a + along + 2, a + along + 1); }
      const sheet = new THREE.BufferGeometry().setFromPoints(pts); sheet.setIndex(ix);
      groups.footprint = new THREE.Mesh(sheet, new THREE.MeshBasicMaterial({ color: C.footprint, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false, ...clipOpts() }));
      groups.footprint.renderOrder = 2; overlays.add(groups.footprint);
      buildModel();
      buildCutTraces();
      paintFaults();
      applyShow();
    }

    // ---------------------------------------------------------------- B2: where each fault plane meets the cut's vertical faces
    // Each triangle of a plane strip is cut by the face; the pieces become a thin ribbon lying on the face (just on its open
    // side), and the fault's id labels the shallowest point. Rebuilt when the cut moves or the planes are rebuilt.
    const traces = new THREE.Group(); scene.add(traces);
    let traceLabels = [];
    function cutFaces() {                                              // axis, position, the open side, the extent along the other axis
      const { mode, off } = state.cut;
      if (mode === "south") return [{ axis: "y", at: off, open: new THREE.Vector3(0, 0, 1), lo: -Infinity, hi: Infinity }];
      if (mode === "east") return [{ axis: "x", at: off, open: new THREE.Vector3(1, 0, 0), lo: -Infinity, hi: Infinity }];
      if (mode === "quadrant") return [{ axis: "y", at: quad[1], open: new THREE.Vector3(0, 0, 1), lo: -Infinity, hi: quad[0] },
                                       { axis: "x", at: quad[0], open: new THREE.Vector3(-1, 0, 0), lo: -Infinity, hi: quad[1] }];
      return [];
    }
    function buildCutTraces() {
      for (const o of [...traces.children]) { traces.remove(o); o.geometry.dispose(); o.material.dispose(); }
      traceLabels = []; groups.traces = [];
      const faces = cutFaces();
      if (!faces.length) return;
      (groups.planes || []).forEach((m, k) => {
        const pos = m.geometry.getAttribute("position"), ix = m.geometry.getIndex();
        if (!pos || !ix) return;
        const P = j => new THREE.Vector3().fromBufferAttribute(pos, j), tri = [], half = 0.014;
        let best = null;
        for (const f of faces) {
          const along = v => (f.axis === "y" ? -v.z : v.x), across = v => (f.axis === "y" ? v.x : -v.z);
          for (let t = 0; t < ix.count; t += 3) {
            const v = [P(ix.getX(t)), P(ix.getX(t + 1)), P(ix.getX(t + 2))], d = v.map(p => along(p) - f.at), hits = [];
            for (let e = 0; e < 3; e++) { const a = d[e], b = d[(e + 1) % 3]; if ((a < 0) !== (b < 0)) hits.push(v[e].clone().lerp(v[(e + 1) % 3], a / (a - b))); }
            if (hits.length !== 2) continue;
            let [p, q] = hits; const cp = across(p), cq = across(q);
            if (Math.max(cp, cq) < f.lo || Math.min(cp, cq) > f.hi) continue;               // the quadrant's faces end at the corner
            const clampTo = (u, v, cu, cv) => { const lim = cu > f.hi ? f.hi : cu < f.lo ? f.lo : cu; return cu === lim ? u : u.clone().lerp(v, (cu - lim) / (cu - cv)); };
            [p, q] = [clampTo(p, q, cp, cq), clampTo(q, p, cq, cp)];
            const lift = f.open.clone().multiplyScalar(0.004), w = new THREE.Vector3().crossVectors(f.open, q.clone().sub(p)).normalize().multiplyScalar(half);
            const a = p.clone().add(lift), b = q.clone().add(lift);
            tri.push(a.clone().sub(w), a.clone().add(w), b.clone().add(w), a.clone().sub(w), b.clone().add(w), b.clone().sub(w));
            for (const c of [a, b]) if (!best || c.y > best.y) best = c;
          }
        }
        if (!tri.length) return;
        const g = new THREE.BufferGeometry().setFromPoints(tri);
        const r = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: C.fault, side: THREE.DoubleSide }));
        r.renderOrder = 5; r.userData = { kind: "plane", fault: site.faults[k] }; traces.add(r); groups.traces[k] = r;
        traceLabels.push({ id: `trace${k}`, text: site.faults[k].id, cls: "fault", at: best.clone().add(new THREE.Vector3(0, 0.05, 0)), trace: true });
      });
    }
    // the fault picked in the table (or on the map): its trace yellow and wider, its plane more opaque
    function paintFaults() {
      (groups.faults || []).forEach((m, k) => {
        const on = k === state.highlight;
        m.material.color.set(on ? C.faultOn : C.fault); m.material.userData.boost.value = on ? 1.8 : 1; m.renderOrder = on ? 4 : 3;
      });
      (groups.traces || []).forEach((m, k) => m && m.material.color.set(k === state.highlight ? C.faultOn : C.fault));
      (groups.planes || []).forEach((m, k) => { if (m.material.uniforms) m.material.uniforms.uAlpha.value = k === state.highlight ? 0.8 : 0.55; });
      requestRender();
    }

    // ---------------------------------------------------------------- the model: receivers, rupture, hypocentre, epicentre
    const model3d = new THREE.Group(); scene.add(model3d);
    const recXY = [], recZ = [];
    function buildModel() {
      for (const o of [...model3d.children]) { model3d.remove(o); o.traverse(x => { x.geometry && x.geometry.dispose(); x.material && x.material.dispose(); }); }
      const along = site.segment.along, a = segA, f = site.family;
      recXY.length = 0; recZ.length = 0;
      f.receivers.x.forEach(col => { const d = col * model.dx_m / 1000; const p = [a[0] + along[0] * d, a[1] + along[1] * d]; recXY.push(p); recZ.push(heightAt(p[0], p[1])); });
      groups.pins = recXY.map((p, k) => {
        const g = new THREE.Group(), stem = 0.16 * Math.max(1, state.exag), head = 0.045;
        const base = W(p[0], p[1], recZ[k], 0);                      // the pin grows from its base: scaling it keeps it planted
        const sm = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, stem, 6), new THREE.MeshBasicMaterial({ color: 0x2b2b2d }));
        sm.position.set(0, stem / 2, 0);
        const hm = new THREE.Mesh(new THREE.SphereGeometry(head, 16, 12), new THREE.MeshMatcapMaterial({ color: C.pin, matcap: matcap() }));
        hm.position.set(0, stem, 0);
        g.position.copy(base); g.scale.setScalar(pinScale);
        g.add(sm, hm); g.userData = { kind: "receiver", k, head: hm, base, stem };
        model3d.add(g); return g;
      });
      groups.rupture = new THREE.Group();
      const sub = model.rupture_xy_km.map((p, k) => W(p[0], p[1], model.rupture_z_m[k]));
      groups.ruptureDots = sub.map((v, k) => {
        const m = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 10), new THREE.MeshMatcapMaterial({ color: 0xffffff, matcap: matcap() }));
        m.position.copy(v); groups.rupture.add(m); return m;
      });
      const hp = model.hypocentre_xy_km, hv = W(hp[0], hp[1], model.hypocentre_z_m);
      groups.hypo = new THREE.Mesh(new THREE.SphereGeometry(0.075, 18, 12), new THREE.MeshMatcapMaterial({ color: C.hypo, matcap: matcap() }));
      groups.hypo.position.copy(hv); groups.hypo.userData = { kind: "hypocentre" }; groups.rupture.add(groups.hypo);
      const ev = W(hp[0], hp[1], model.epicentre_z_m, 30);
      const star = new THREE.Shape(); for (let k = 0; k < 10; k++) { const r = k % 2 ? 0.06 : 0.15, t = k / 10 * 2 * Math.PI - Math.PI / 2; star[k ? "lineTo" : "moveTo"](Math.cos(t) * r, Math.sin(t) * r); }
      const sg = new THREE.ShapeGeometry(star); sg.rotateX(-Math.PI / 2);
      groups.epi = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ color: C.epi, side: THREE.DoubleSide, depthTest: false })); groups.epi.renderOrder = 10;
      groups.epi.position.copy(ev); groups.epi.userData = { kind: "epicentre" }; groups.rupture.add(groups.epi);
      const leader = new THREE.BufferGeometry().setFromPoints([hv, ev]);
      groups.rupture.add(new THREE.Line(leader, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.08, gapSize: 0.06, transparent: true, opacity: 0.7 })).computeLineDistances());
      model3d.add(groups.rupture);
      paintModel();
      if (state.results) setResults(state.results);                   // the finale's columns follow the relief's exaggeration
    }
    function paintModel() {
      const lit = new THREE.Color(C.segment), off = new THREE.Color(0x8a8a90);
      (groups.ruptureDots || []).forEach((m, k) => m.material.color.copy(state.ruptureTime === null ? new THREE.Color(0xffffff)
        : site.family.rupture.activation_s[k] <= state.ruptureTime ? lit : off));
      (groups.pins || []).forEach((g, k) => {
        const level = state.shake ? state.shake[k] : 0, on = k === state.selected;
        g.userData.head.scale.setScalar((on ? 1.8 : 1) * (1 + 0.9 * level));
        g.userData.head.material.color.set(on ? 0xffffff : C.pin).lerp(new THREE.Color(0xffe2a0), Math.min(1, level));
      });
    }
    // the finale: one column per receiver, planted on the relief where the receiver is; its height and colour are data
    // (spec: { height_km: [39], color: [39 css colours] }, or null to take them away)
    const resultsGroup = new THREE.Group(); scene.add(resultsGroup);
    function setResults(spec) {
      for (const o of [...resultsGroup.children]) { resultsGroup.remove(o); o.geometry.dispose(); o.material.dispose(); }
      state.results = spec || null;
      if (spec) recXY.forEach((p, k) => {
        const h = Math.max(0.02, spec.height_km[k]);
        const m = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, h, 14), new THREE.MeshMatcapMaterial({ color: new THREE.Color(spec.color[k]), matcap: matcap() }));
        m.position.copy(W(p[0], p[1], recZ[k], 0)).add(new THREE.Vector3(0, h / 2, 0)); m.userData = { kind: "result", k };
        resultsGroup.add(m);
      });
      requestRender();
    }
    // "⌖ Site": a flight down to one receiver, with a halo on the ground around its pin
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.075, 0.105, 48), new THREE.MeshBasicMaterial({ color: C.pin, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthTest: false }));
    halo.rotation.x = -Math.PI / 2; halo.renderOrder = 11; halo.visible = false; scene.add(halo);
    function placeHalo(k) { halo.position.copy(W(recXY[k][0], recXY[k][1], recZ[k], 8)); halo.userData.k = k; halo.visible = true; }
    // A queried location belongs to the real SARA/context map, not to the A–B model.
    const locationMarker = new THREE.Group();
    const locationStem = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.28, 8), new THREE.MeshBasicMaterial({ color: 0xf2f2f4 }));
    const locationHead = new THREE.Mesh(new THREE.SphereGeometry(0.06, 18, 14), new THREE.MeshMatcapMaterial({ color: C.pin, matcap: matcap() }));
    const locationRing = new THREE.Mesh(new THREE.RingGeometry(0.11, 0.145, 48), new THREE.MeshBasicMaterial({ color: C.pin, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthTest: false }));
    locationStem.position.y = 0.14; locationHead.position.y = 0.30; locationRing.rotation.x = -Math.PI / 2;
    locationMarker.add(locationStem, locationHead, locationRing); locationMarker.renderOrder = 12; locationMarker.visible = false; scene.add(locationMarker);
    // A searched point only colours a building when it is actually inside an Overture footprint from the 3-D city.
    const locationBuilding = new THREE.Group(); locationBuilding.renderOrder = 10; locationBuilding.visible = false; scene.add(locationBuilding);
    function clearLocationBuilding() {
      for (const mesh of [...locationBuilding.children]) { locationBuilding.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
      locationBuilding.visible = false;
    }
    function ringContains(x, y, ring) {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i], [xj, yj] = ring[j];
        if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }
    function buildingAt(x, y) {
      if (!bld) return null;
      const { meta, counts, hdm, steps } = bld, size = meta.chunk_km, [ox, oy] = meta.origin_km, q = meta.quantum_m;
      const ci = Math.floor((x - ox) / size), cj = Math.floor((y - oy) / size);
      for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++) {
        const ch = meta.chunks.find(c => c.i === i && c.j === j); if (!ch) continue;
        let s = ch.first_vertex * 2;
        for (let k = ch.first; k < ch.first + ch.count; k++) {
          const ring = [], n = counts[k]; let px = ch.x0_km * 1000, py = ch.y0_km * 1000;
          for (let v = 0; v < n; v++) { px += steps[s++] * q; py += steps[s++] * q; ring.push([px / 1000, py / 1000]); }
          if (ringContains(x, y, ring)) return { ring, height: hdm[k] / 10 };
        }
      }
      return null;
    }
    function paintLocationBuilding(building) {
      clearLocationBuilding(); if (!building) return false;
      const ground = building.ring.map(p => heightAt(p[0], p[1])), low = Math.min(...ground), high = Math.max(...ground);
      if (!Number.isFinite(low) || !Number.isFinite(high)) return false;
      const pos = [], ix = [], n = building.ring.length, rise = bldU.uRise.value;
      // This is deliberately the city shader's geometry rule: only its ground follows exaggeration; the building's
      // height and footing remain true metres. Polygon offset makes the identical orange shell win the depth test.
      for (const [x, y] of building.ring) pos.push(x, toY(low) - BLD.footingM * rise / 1000, -y);
      for (const [x, y] of building.ring) pos.push(x, toY(high) + building.height * rise / 1000, -y);
      for (let k = 0; k < n; k++) { const a = k, b = (k + 1) % n, c = n + k, d = n + b; ix.push(a, b, d, a, d, c); }
      THREE.ShapeUtils.triangulateShape(building.ring.map(p => new THREE.Vector2(p[0], p[1])), []).forEach(t => ix.push(n + t[0], n + t[1], n + t[2]));
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geometry.setIndex(ix); geometry.computeVertexNormals();
      const material = new THREE.MeshBasicMaterial({ color: C.pin, transparent: true, opacity: 0.88, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      locationBuilding.add(new THREE.Mesh(geometry, material)); locationBuilding.userData.building = building; locationBuilding.visible = true; requestRender(); return true;
    }
    function highlightLocationBuilding(x, y) {
      locationBuilding.userData.query = [x, y];
      if (bld) return paintLocationBuilding(buildingAt(x, y));
      clearLocationBuilding(); loadBuildings().then(() => {
        const q = locationBuilding.userData.query;
        if (q && q[0] === x && q[1] === y) paintLocationBuilding(buildingAt(x, y));
      }, () => {});
      return false;
    }
    // The locator's distances become legible on the terrain itself: the moving dashes themselves reach the closest
    // point of a SARA trace.  They are rebuilt only when the queried location changes, never per frame.
    const locationLinks = new THREE.Group(); locationLinks.renderOrder = 11; locationLinks.visible = false; scene.add(locationLinks);
    const locationDashGeometry = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true), locationLinkMats = [], locationLinkPaths = [];
    const dashSample = (points, lengths, total, s) => {
      const at = Math.max(0, Math.min(total, s)); let i = 0;
      while (i < lengths.length - 1 && lengths[i + 1] < at) i++;
      const span = Math.max(lengths[i + 1] - lengths[i], 1e-6), u = (at - lengths[i]) / span;
      return points[i].clone().lerp(points[i + 1], u);
    };
    const placeDash = (mesh, a, b, radius) => {
      const axis = b.clone().sub(a), length = axis.length();
      mesh.visible = length > 1e-4;
      if (!mesh.visible) return;
      mesh.position.copy(a).add(b).multiplyScalar(0.5); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize());
      mesh.scale.set(radius, length, radius);
    };
    function setLocationFaultLinks(links) {
      for (const child of [...locationLinks.children]) locationLinks.remove(child);
      locationLinkMats.forEach(m => m.dispose()); locationLinkMats.length = locationLinkPaths.length = 0;
      for (const { from, to, nearest } of links) {
        const length = Math.hypot(to[0] - from[0], to[1] - from[1]), points = [];
        const steps = Math.max(2, Math.ceil(length / 0.14));
        for (let k = 0; k <= steps; k++) {
          const u = k / steps, x = from[0] + (to[0] - from[0]) * u, y = from[1] + (to[1] - from[1]) * u;
          points.push(drape(x, y, 36));
        }
        const lengths = [0]; for (let k = 1; k < points.length; k++) lengths.push(lengths[k - 1] + points[k].distanceTo(points[k - 1]));
        const total = lengths[lengths.length - 1], count = Math.max(7, Math.min(96, Math.ceil(total / 0.22))), dashLength = Math.min(0.16, total / count * 0.62) * 0.60;
        const material = new THREE.MeshBasicMaterial({ color: nearest ? C.faultOn : 0xff6355, transparent: true, opacity: nearest ? 1 : 0.84, depthTest: false, depthWrite: false });
        const dashes = new THREE.Group();
        for (let k = 0; k < count; k++) { const dash = new THREE.Mesh(locationDashGeometry, material); dash.userData.k = k; dashes.add(dash); }
        dashes.renderOrder = nearest ? 13 : 12; locationLinks.add(dashes); locationLinkMats.push(material);
        locationLinkPaths.push({ dashes, points, lengths, total, count, dashLength, phase: Math.random() * (total + dashLength) });
      }
      locationLinks.userData.links = links;
      locationLinks.visible = locationLinks.children.length > 0; requestRender();
    }
    function placeLocationMarker(x, y) {
      const elev = heightAt(x, y);
      if (!Number.isFinite(elev)) return null;
      locationMarker.position.copy(W(x, y, elev, 10)); locationMarker.userData = { x, y, elev }; locationMarker.visible = true;
      return elev;
    }
    function clearLocation() {
      locationMarker.visible = false; setLocationFaultLinks([]); clearLocationBuilding(); requestRender();
    }
    function locate(x, y) {
      const elev = placeLocationMarker(x, y);
      if (!Number.isFinite(elev)) return null;
      const dir = new THREE.Vector3(-0.38, 0.62, 1.0).normalize();
      // A searched address is a building-scale question.  Use the receiver-scale framing,
      // not the broad district view, so the chosen footprint is immediately inspectable.
      flyTo({ target: locationMarker.position.clone(), dir, d: 2.4 }, 1700);
      return { x, y, elevation_m: elev };
    }
    function flyToReceiver(k) {
      placeHalo(k); state.selected = k; paintModel();
      const base = halo.position.clone(), dir = new THREE.Vector3(-0.42, 0.62, 1).normalize();
      return flyTo({ target: base, dir, d: 2.4 }, 1800);
    }
    function applyShow() {
      const s = state.show;
      terrain.visible = s.terrain; wallAlpha();
      groups.zones.visible = s.zones; groups.urban.visible = s.urban; groups.footprint.visible = s.footprint;
      if (!s.buildings) city.visible = false;                           // (fetched by the frame loop, once the camera rests)
      groups.section.visible = groups.segment.visible = s.section;     // A–B and segment 3 (held back while the dive lands)
      groups.faults.forEach(m => (m.visible = s.faults)); groups.planes.forEach(m => (m.visible = s.planes)); traces.visible = s.planes;
      // the model's pieces are not clipped (they lie on A–B), but they leave with the part of the relief a cut removes
      (groups.pins || []).forEach(g => (g.visible = s.receivers && !isCut(g.userData.base, 0.01)));
      if (groups.rupture) groups.rupture.visible = s.rupture && !isCut(groups.hypo.position, 0.01) && !isCut(groups.epi.position, 0.01);
      requestRender();
    }

    // ---------------------------------------------------------------- settings
    function setExaggeration(v) {
      state.exag = v; terrainU.uExag.value = v; capU.uExag.value = v;
      setClip(); placeCaps(); buildWalls(); buildOverlays(); if (halo.visible) placeHalo(halo.userData.k);
      if (locationMarker.visible) placeLocationMarker(locationMarker.userData.x, locationMarker.userData.y);
      if (locationBuilding.visible) paintLocationBuilding(locationBuilding.userData.building);
      if (locationLinks.visible) setLocationFaultLinks(locationLinks.userData.links);
      requestRender();
    }
    function setPalette(name) {
      state.palette = name; terrainU.uMode.value = MODE[name] || 0; terrainU.uLut.value.dispose(); terrainU.uLut.value = lutTexture(name);
      bldU.uColor.value.set(cityColour()); requestRender();
    }
    function setOpacity(a) {
      state.alpha = a; terrainU.uAlpha.value = a; terrainMat.depthWrite = a > 0.99;
      wallAlpha(); requestRender();
    }
    // B1: the cut. A new mode rebuilds what clips (the planes' count, and the quadrant's intersection rule, change the
    // shaders); a new position only moves the planes and the faces. South snaps to A–B within 150 m, where the model is.
    function setCut(mode, off) {
      const same = mode === state.cut.mode;
      if (off == null) off = same ? state.cut.off : cutDefault(mode);
      if (mode === "south" && Math.abs(off - secY) < 0.15) off = secY;
      if (CUT_RANGE[mode]) off = Math.min(CUT_RANGE[mode][1], Math.max(CUT_RANGE[mode][0], off));
      state.cut = { mode, off };
      setClip(); placeCaps();
      if (!same) { terrainMat.clipIntersection = bldMat.clipIntersection = mode === "quadrant"; buildWalls(); buildOverlays(); } else { buildCutTraces(); paintFaults(); applyShow(); }
      requestRender();
    }
    const setSection = on => setCut(on ? "south" : "none", secY);
    // the A–B plane is on screen (south at secY, or the quadrant whose south face is A–B): the medium can show there
    const onSection = () => (state.cut.mode === "south" && state.cut.off === secY) || state.cut.mode === "quadrant";
    function setGrow(u) {                                             // the prologue draws A–B from A: only that tube is rebuilt
      state.grow = u; capU.uGrow.value = u;
      if (groups.section) { overlays.remove(groups.section); groups.section.geometry.dispose(); groups.section.material.dispose(); }
      const sec = site.section.xy_km, cut = Math.max(2, Math.round(sec.length * u));
      groups.section = tube(sec.slice(0, cut).map(p => drape(p[0], p[1], 45)), 0.045, C.section);
      groups.section.visible = state.show.section;
      requestRender();
    }
    // the shader-only exaggeration, for animations (overlays follow at the end with setExaggeration)
    function previewExaggeration(v) { state.exag = v; terrainU.uExag.value = v; capU.uExag.value = v; setClip(); placeCaps(); stretchWalls(); requestRender(); }
    function setMediumOn(on) { state.mediumOn = !!on; capU.uMedOn.value = on && medTex ? 1 : 0; requestRender(); }
    function setTheme(t) {
      state.theme = t; terrainU.uDark.value = t === "dark" ? 1 : 0; capU.uDark.value = terrainU.uDark.value;
      terrainU.uAirColor.value.set(t === "dark" ? AIR.dark : AIR.light);   // a dusk blue-grey, a pale daylight blue
      bldU.uColor.value.set(cityColour());
      bldU.uSkyLight.value.setRGB(...(t === "dark" ? [0.13, 0.25, 0.52] : [0.36, 0.58, 0.95]));
      bldU.uGroundBounce.value.setRGB(...(t === "dark" ? [0.18, 0.07, 0.015] : [0.72, 0.40, 0.13]));
      terrainU.uShadowTint.value.setRGB(...(t === "dark" ? [0.62, 0.66, 0.80] : [0.72, 0.76, 0.88])); terrainU.uAoFloor.value = t === "dark" ? 0.55 : 0.62;
      buildWalls(); buildOverlays(); requestRender();
    }

    // ---------------------------------------------------------------- camera: views and flights (log distance, arc on long hops)
    const segMid = [(segA[0] + segB[0]) / 2, (segA[1] + segB[1]) / 2];
    const VIEWS = {
      // the whole block, as the chapter opens: from the south-south-west, 25° above the horizon (38° looked down on it;
      // lower, the relief and the block's walls read as a landscape)
      region: () => ({ target: W(0, -1, 2600), dir: [-0.38, 0.499, 1.0], distance: 70, fit: [62, 12] }),
      // from the globe: high above the district, but already oblique (~45°, the region view's azimuth), so the relief is
      // seen rising and the block's sides growing; from straight above the rise was invisible and the 3D came in a jump
      approach: () => ({ target: W(0, -2, 2600), dir: [-0.34, 1.0, 1.0], distance: 150 }),
      faults: () => ({ target: W(segMid[0] - 2, segMid[1] - 3, 2700), dir: [-0.42, 0.62, 1.0], distance: 30 }),
      // the section from the terrain to the model's floor, framed whole (fit below)
      quake: () => ({ target: W(segMid[0], secY, (model.top_elevation_m + baseM) / 2), dir: [-0.42, 0.32, 1.0], distance: 12, fit: [5.2, (model.top_elevation_m - baseM) / 1000] }),
      segment: () => ({ target: W(segMid[0], secY, (model.top_elevation_m + baseM) / 2 + 600), dir: [-0.45, 0.45, 1.0], distance: 12, fit: [5.6, (model.top_elevation_m - baseM) / 1000 * 0.85] }),
      // the finale: from the south-west, the city and its faults in front, segment 3 and its columns behind them
      finale: () => ({ target: W(segMid[0] - 1.5, secY - 5, 2700), dir: [-0.55, 0.72, 1.0], distance: 23 }),
      // B1: in front of the cut's face (south and the quadrant from the south-west, east from the east, top from above)
      cut: () => {
        const { mode, off } = state.cut, mid = (model.top_elevation_m + baseM) / 2, deep = (model.top_elevation_m - baseM) / 1000;
        if (mode === "east") return { target: W(off, secY, mid), dir: [1.0, 0.45, 0.25], distance: 20, fit: [14, deep] };
        if (mode === "top") return { target: W(segMid[0], secY, off), dir: [-0.25, 1.6, 0.9], distance: 34 };
        if (mode === "south") return { target: W(segMid[0], off, mid), dir: [-0.3, 0.42, 1.0], distance: 20, fit: [14, deep] };
        if (mode === "quadrant") return { target: W(quad[0] - 1.5, quad[1] - 1.5, mid), dir: [-0.9, 0.55, 1.0], distance: 20, fit: [12, deep] };
        return VIEWS.faults();
      },
    };
    // a fault from the table: the stretch of its trace that is drawn (over the relief), framed whole from the south-west.
    // The midpoint of the full SARA trace could lie off the relief, and a fixed distance cut long faults short.
    function faultView(k) {
      const run = longest(stretches(densify(site.faults[k].trace_xy_km)));
      if (run.length < 2) return pose("faults");
      const mid = run[Math.floor(run.length / 2)], a = run[0], b = run[run.length - 1];
      const extent = Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]), 4);
      return { target: drape(mid[0], mid[1], 0), dir: new THREE.Vector3(-0.42, 0.62, 1.0).normalize(), d: extent * 0.62 / HALF };
    }
    function pose(name) {
      const v = VIEWS[name](), d = new THREE.Vector3(...v.dir).normalize(), ins = state.inset;
      const freeW = Math.max(container.clientWidth - ins.left - ins.right, 1), freeH = Math.max(container.clientHeight - ins.top - ins.bottom, 1);
      let dist = v.distance * Math.max(1, 1.5 / (freeW / freeH));
      if (v.fit) {                                                      // width w [km] and height h [km, before exaggeration] must fit
        const H = Math.max(container.clientHeight, 1), half = HALF / 1.25;   // 25 % margin for the oblique look
        dist = Math.max(dist, (v.fit[1] * state.exag / 2) / half * (H / freeH), (v.fit[0] / 2) / half * (H / freeW));
      }
      return { target: v.target, dir: d, d: dist };
    }
    let flight = null, current = "region";
    function flyTo(name, ms = 1800) {
      current = typeof name === "string" ? name : current;
      const to = asPose(typeof name === "string" ? pose(name) : name);
      if (flight) { const r = flight.resolve; flight = null; r(); }    // a new pose ends the flight under way (it would override an instant one)
      endGlide();
      if (ms <= 0) { place(to.target, to.dir, to.d); controls.update(); requestRender(); return Promise.resolve(); }
      const t0 = controls.target.clone(), d0 = viewDist(), d1 = to.d, sep = t0.distanceTo(to.target);
      const arc = sep > 4 * Math.max(d0, d1) ? Math.max(sep * 1.1, d0, d1) : 0;
      return new Promise(resolve => {
        flight = { dir0: viewDir(), t0, dir1: to.dir.clone(), t1: to.target, s: performance.now(), d: arc ? Math.max(ms, 4200) : ms, arc, d0, d1, resolve };
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) flight.d = 1;
        requestRender();
      });
    }
    function stepFlight(now) {
      const f = flight, u = Math.min(1, (now - f.s) / f.d), e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      const wa = Math.min(1, Math.max(0, (e - 0.2) / 0.6));
      const w = f.arc ? wa * wa * (3 - 2 * wa) : f.d0 === f.d1 ? e : Math.min(1, Math.max(0, (Math.exp(Math.log(f.d0) * (1 - e) + Math.log(f.d1) * e) - f.d0) / (f.d1 - f.d0)));
      const tgt = f.t0.clone().lerp(f.t1, w);
      const dir = f.dir0.clone().lerp(f.dir1, e); dir.y = Math.max(dir.y, 0.25); dir.normalize();
      const ld = Math.log(f.d0) * (1 - e) + Math.log(f.d1) * e, d = Math.exp(f.arc ? ld + (Math.log(f.arc) - ld) * Math.sin(Math.PI * e) : ld);
      place(tgt, dir, d);
      if (u >= 1) { const r = f.resolve; flight = null; r(); }
    }
    // a glide: the target and the distance of a named view, the direction left to whoever turns the camera (the orbit
    // keeps turning through it: the finale's pull-back to the whole district). Taking the camera by hand ends it.
    let glide = null;
    function endGlide() { if (glide) { const r = glide.resolve; glide = null; r(); } }
    function glideTo(name, ms = 4000) {
      const to = pose(name);
      if (flight) { const r = flight.resolve; flight = null; r(); }
      endGlide();
      return new Promise(resolve => {
        glide = { t0: controls.target.clone(), t1: to.target, d0: viewDist(), d1: to.d, s: performance.now(), d: ms, resolve };
        if (matchMedia("(prefers-reduced-motion: reduce)").matches) glide.d = 1;
        current = name; requestRender();
      });
    }
    function stepGlide(now) {
      const g = glide, u = Math.min(1, (now - g.s) / g.d), e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      place(g.t0.clone().lerp(g.t1, e), viewDir(), Math.exp(Math.log(g.d0) * (1 - e) + Math.log(g.d1) * e));
      if (u >= 1) endGlide();
    }
    controls.addEventListener("start", endGlide);
    function northUp() {
      const t = controls.target.clone(), el = Math.asin(Math.min(1, viewDir().y));
      return flyTo({ target: t, dir: new THREE.Vector3(0, Math.sin(el), Math.cos(el)), d: viewDist() }, 1200);
    }
    // the exaggeration as an animation (the film's ×1.5 -> ×1 before the cut; the dive's rise, which starts at once: "out")
    function animateExaggeration(to, ms = 1600, easing = "inOut") {
      const from = state.exag, t0 = performance.now();
      return new Promise(resolve => {
        const step = () => {
          const u = Math.min(1, (performance.now() - t0) / ms);
          const e = easing === "out" ? 1 - Math.pow(1 - u, 3) : u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
          terrainU.uExag.value = capU.uExag.value = state.exag = from + (to - from) * e;
          stretchWalls();
          if (u < 1) { requestRender(); requestAnimationFrame(step); } else { setExaggeration(to); resolve(); }
        };
        requestAnimationFrame(step);
      });
    }

    // ---------------------------------------------------------------- picking
    function screenOf(v) {
      camera.updateMatrixWorld();                                     // a pose set since the last frame counts already
      const p = v.clone().project(camera), rect = renderer.domElement.getBoundingClientRect();
      return { x: (p.x + 1) / 2 * rect.width, y: (1 - p.y) / 2 * rect.height, visible: p.z > -1 && p.z < 1 };
    }
    function ray(px, py) {
      const rect = renderer.domElement.getBoundingClientRect(), r = new THREE.Raycaster();
      r.setFromCamera(new THREE.Vector2(px / rect.width * 2 - 1, 1 - py / rect.height * 2), camera);
      return r;
    }
    function marchTerrain(r) {                                          // the height field, not the 280 k triangles
      // only where the ray is inside the relief's box (an orthographic ray starts far behind the camera)
      const o = r.ray.origin, d = r.ray.direction, box = new THREE.Box3(new THREE.Vector3(X[0], toY(site.dem.elevation_range_m[0]) - 0.01, -Yn[0]),
                                                                          new THREE.Vector3(X[Cn - 1], toY(site.dem.elevation_range_m[1]) + 0.01, -Yn[R - 1]));
      const enter = r.ray.intersectBox(box, new THREE.Vector3());
      if (!enter) return null;
      const t0 = box.containsPoint(o) ? 0 : o.distanceTo(enter), far = t0 + 2 * box.getSize(new THREE.Vector3()).length();
      let t = t0, step = Math.max(0.005, viewDist() / 400), prev = null;
      for (let k = 0; k < 4000 && t < far; k++) {
        const p = o.clone().addScaledVector(d, t), h = heightAt(p.x, -p.z);
        if (Number.isFinite(h) && p.y <= toY(h)) {
          let lo = prev ?? t0, hi = t;                                  // refine
          for (let j = 0; j < 20; j++) { const m = (lo + hi) / 2, q = o.clone().addScaledVector(d, m); (q.y <= toY(heightAt(q.x, -q.z) || -1e9) ? (hi = m) : (lo = m)); }
          const hit = o.clone().addScaledVector(d, hi);
          if (isCut(hit)) return null;                                  // cut away
          return { point: hit, distance: hi };
        }
        prev = t; t += step; step *= 1.004;
      }
      return null;
    }
    // pins and the epicentre in screen space, the way a finger finds them; crowded pins (39 along 4 km) reach less far,
    // so the segment line under them stays clickable. Hover and click share this rule.
    function screenPick(px, py) {
      let best = null, bestD = 16, reach = 16;
      if (state.show.receivers && groups.pins) {
        const sc = groups.pins.map(g => screenOf(pinTop(g)));
        let gap = Infinity; for (let k = 1; k < sc.length; k++) gap = Math.min(gap, Math.hypot(sc[k].x - sc[k - 1].x, sc[k].y - sc[k - 1].y));
        reach = Math.max(5, Math.min(16, gap * 0.45));
        sc.forEach((s, k) => { const d = Math.hypot(s.x - px, s.y - py); if (s.visible && d < Math.min(bestD, reach)) { bestD = d; best = { kind: "receiver", k }; } });
      }
      if (state.show.rupture && groups.epi) { const s = screenOf(groups.epi.position); const d = Math.hypot(s.x - px, s.y - py); if (d < Math.min(bestD + 2, 16)) best = { kind: "epicentre" }; }
      return best;
    }
    function pick(px, py) {
      const best = screenPick(px, py);
      if (best) return best;
      // 2. 3D hits: fault traces, segment, hypocentre, fault planes, section, terrain; the nearest wins
      const r = ray(px, py), cands = [];
      const objs = [...(state.show.faults ? groups.faults : []), groups.segment, ...(state.show.rupture ? [groups.hypo] : []), ...(state.show.planes ? groups.planes : [])];
      for (const h of r.intersectObjects(objs, false)) {
        if (isCut(h.point) && h.object.userData.kind !== "hypocentre") continue;
        cands.push({ ...h.object.userData, point: h.point, distance: h.distance });
      }
      for (const h of r.intersectObjects(Object.values(caps).filter(m => m.visible), false)) {     // a face of the cut, where it has rock
        if (h.point.y <= toY(heightAt(h.point.x, -h.point.z) || -1e9)) { cands.push({ kind: "section", point: h.point, distance: h.distance }); break; }
      }
      if (state.show.terrain) { const t = marchTerrain(r); if (t) cands.push({ kind: "terrain", point: t.point, distance: t.distance }); }
      cands.sort((a, b) => a.distance - b.distance);
      let c = cands[0];
      if (c && c.kind === "terrain" && state.alpha < 0.99 && cands[1]) c = cands[1];  // a see-through terrain does not block what is under it
      if (!c) return null;
      const p = c.point;
      return { ...c, x: p.x, y: -p.z, elev: p.y / state.exag * 1000 };
    }
    let down = null, hoverT = 0;
    renderer.domElement.addEventListener("pointerdown", e => { down = { x: e.offsetX, y: e.offsetY }; });
    renderer.domElement.addEventListener("pointerup", e => {
      if (!down || Math.hypot(e.offsetX - down.x, e.offsetY - down.y) > 5) { down = null; return; }
      down = null; const hit = pick(e.offsetX, e.offsetY); if (state.onPick) state.onPick(hit, { x: e.clientX, y: e.clientY });
    });
    renderer.domElement.addEventListener("pointermove", e => {
      if (e.buttons || performance.now() - hoverT < 60) return; hoverT = performance.now();
      const hit = screenPick(e.offsetX, e.offsetY);
      renderer.domElement.style.cursor = hit ? "pointer" : "grab";
      if (state.onHover) state.onHover(hit, { x: e.offsetX, y: e.offsetY });
    });
    renderer.domElement.addEventListener("pointerleave", () => state.onHover && state.onHover(null, null));

    // ---------------------------------------------------------------- render on demand
    let pending = false, active = false;
    function requestRender() { if (!pending && active) { pending = true; requestAnimationFrame(renderNow); } }
    function renderNow(now) {
      pending = false;
      if (flight) stepFlight(now || performance.now());
      else if (glide) stepGlide(now || performance.now());
      const moving = controls.update();
      const dist = viewDist();
      terrainU.uViewD.value = dist;
      terrainU.uAir.value.w = ["elevation", "hypsometric", "curvature", "ao"].includes(state.palette) ? AIR.dataStrength : 1;   // colour is data there
      tubeScale.value = Math.min(1, Math.max(0.12, dist / TUBE_FULL_KM));
      const ps = Math.min(1, Math.max(0.15, dist / 10));
      if (Math.abs(ps - pinScale) > 1e-3) { pinScale = ps; (groups.pins || []).forEach(g => g.scale.setScalar(ps)); halo.scale.setScalar(Math.max(0.3, ps)); }
      const clock = now || performance.now();
      if (locationMarker.visible) {
        const pulse = 0.5 + 0.5 * Math.sin(clock * 0.0035);
        locationMarker.scale.setScalar(Math.max(0.45, ps) * (1 + 0.018 * Math.sin(clock * 0.0035)));
        locationRing.scale.setScalar(1 + 0.16 * pulse); locationRing.material.opacity = 0.72 + 0.20 * (1 - pulse);
        locationHead.position.y = 0.30 + 0.004 * Math.sin(clock * 0.0035);
      }
      if (locationLinks.visible) {
        const radius = Math.min(0.050, Math.max(0.010, dist * 0.005)) * 0.70;
        locationLinkPaths.forEach(path => {
          const period = path.total + path.dashLength, shift = (path.phase + clock * 0.00011) % period;
          path.dashes.children.forEach(dash => {
            const start = (dash.userData.k / path.count * period + shift) % period;
            if (start >= path.total) { dash.visible = false; return; }
            placeDash(dash, dashSample(path.points, path.lengths, path.total, start), dashSample(path.points, path.lengths, path.total, Math.min(path.total, start + path.dashLength)), radius);
          });
        });
      }
      const building = cityBusy = updateCity(now || performance.now());
      renderer.render(scene, camera);
      if (state.onFrame) state.onFrame();
      if (moving || flight || glide || controls.autoRotate || building || locationLinks.visible) requestRender();
    }
    controls.addEventListener("change", requestRender);
    function applyOffset() {
      const w = container.clientWidth, h = container.clientHeight, ins = state.inset;
      camera.setViewOffset(w, h, (ins.right - ins.left) / 2, (ins.bottom - ins.top) / 2, w, h); camera.updateProjectionMatrix();
    }
    function resize() {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false); renderer.domElement.style.width = w + "px"; renderer.domElement.style.height = h + "px";
      camera.left = -HALF * w / h; camera.right = HALF * w / h; applyOffset(); requestRender();
    }
    new ResizeObserver(resize).observe(container);
    function overlayInfo() {
      const d = viewDist(), visibleKm = 2 * d * HALF;
      const t = controls.target, a = screenOf(t), b = screenOf(t.clone().add(new THREE.Vector3(0, 0, -1)));
      return { metresPerPx: visibleKm * 1000 / Math.max(container.clientHeight, 1), northDeg: Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI,
               distance: d, target: [t.x, -t.z], heading: Math.atan2(camera.position.x - t.x, camera.position.z - t.z) };
    }

    // the corner's mini-map once the camera is close: the hillshade, the section, the segment, the faults, where we look
    let thumb = null;
    function drawMiniMap(canvas) {
      const ctx = canvas.getContext("2d"), dpr = Math.min(devicePixelRatio || 1, 2), size = canvas.clientWidth;
      if (size < 20) return;                                            // hidden (a phone hides the corner)
      if (canvas.width !== Math.round(size * dpr)) canvas.width = canvas.height = Math.round(size * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, size, size);
      const info = overlayInfo(), half = Math.min(20, Math.max(3, info.distance * 0.7));
      const cx = info.target[0], cy = info.target[1], k = size / (2 * half), toPx = (x, y) => [size / 2 + (x - cx) * k, size / 2 - (y - cy) * k];
      if (!thumb) { thumb = document.createElement("canvas"); thumb.width = 512; thumb.height = Math.round(512 * site.dem.rows / site.dem.cols); thumb.getContext("2d").drawImage(images.hillshade, 0, 0, thumb.width, thumb.height); }
      const [ix0, iy0] = toPx(X[0], Yn[0]), [ix1, iy1] = toPx(X[Cn - 1], Yn[R - 1]);
      ctx.save(); ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2 - 1, 0, 2 * Math.PI); ctx.clip();
      ctx.fillStyle = "#777"; ctx.fillRect(0, 0, size, size); ctx.globalAlpha = 0.95; ctx.drawImage(thumb, ix0, iy0, ix1 - ix0, iy1 - iy0); ctx.globalAlpha = 1;
      const path = (pts, color, w) => { ctx.beginPath(); pts.forEach((p, j) => { const q = toPx(p[0], p[1]); j ? ctx.lineTo(...q) : ctx.moveTo(...q); }); ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke(); };
      site.faults.forEach(f => path(f.trace_xy_km, "#d62728", 1.6));
      path(site.section.xy_km, "#ffffff", 1.4); path(site.segment.xy_km, "#e58a2b", 3);
      const ep = toPx(...model.hypocentre_xy_km); ctx.fillStyle = "#d62728"; ctx.beginPath(); ctx.arc(ep[0], ep[1], 3, 0, 2 * Math.PI); ctx.fill();
      // where we look from: a wedge from the target toward the camera
      ctx.translate(size / 2, size / 2); ctx.rotate(-info.heading + Math.PI);
      ctx.fillStyle = "rgba(229,138,43,.35)"; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, size * 0.32, Math.PI / 2 - 0.35, Math.PI / 2 + 0.35); ctx.closePath(); ctx.fill();
      ctx.restore();
      ctx.strokeStyle = "rgba(255,255,255,.6)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2 - 1, 0, 2 * Math.PI); ctx.stroke();
    }

    // build
    setClip(); placeCaps(); buildWalls(); buildOverlays(); flyTo("region", 0); resize();
    return {
      flyTo, northUp, setExaggeration, previewExaggeration, animateExaggeration, setPalette, setOpacity, setSection, setGrow, setMediumOn, setSectionMedium, setTheme, overlayInfo, drawMiniMap, heightAt, locate, clearLocation, setLocationFaultLinks, highlightLocationBuilding, clearLocationBuilding,
      setShow(values) { Object.assign(state.show, values); applyShow(); }, get show() { return { ...state.show }; },
      glideTo, get gliding() { return !!glide; }, get distance() { return viewDist(); },
      loadBuildings,
      get city() { return { loaded: !!bld, visible: city.visible, chunks: built.size, meshes: city.children.length, count: bld ? bld.meta.count : 0,
                            triangles: city.children.reduce((s, m) => s + m.geometry.index.count / 3, 0),
                            drawn: city.children.reduce((s, m) => s + (m.visible ? Math.min(m.geometry.drawRange.count, m.geometry.index.count) / 3 : 0), 0),
                            shown: city.children.reduce((s, m) => s + (m.userData.used === lastCity ? m.geometry.index.count / 3 : 0), 0),
                            partial: city.children.filter(m => m.userData.floor > 0).length, colour: "#" + bldU.uColor.value.getHexString(), rise: bldU.uRise.value, busy: cityBusy || !!bldLoading && !bld }; },   // for the tests
      cityAt(x, y) {                                                  // the chunk under (x, y) [km] is built and drawn (for the tests)
        if (!bld) return false;
        const s = bld.meta.chunk_km, k = bld.meta.chunks.findIndex(ch => x >= ch.x0_km && x < ch.x0_km + s && y >= ch.y0_km && y < ch.y0_km + s), m = built.get(k);
        return k < 0 ? null : !!(m && m.visible && city.visible);       // (null: no building there at all)
      },
      setRuptureTime(t) { state.ruptureTime = t; paintModel(); requestRender(); },
      setShake(levels) { state.shake = levels; paintModel(); requestRender(); },
      setResults, resultsShown: () => resultsGroup.children.length,
      setSelected(k) { state.selected = k; if (k !== halo.userData.k) halo.visible = false; paintModel(); requestRender(); },
      setHighlight(k) { state.highlight = k; paintFaults(); }, get highlight() { return state.highlight; },
      get orbiting() { return controls.autoRotate; }, pickAt: (x, y) => pick(x, y),
      wallsState: () => ({ visible: walls.visible, opacity: (walls.children.find(m => !m.userData.shadow) || { material: { opacity: 0 } }).material.opacity }),   // for the tests
      get tubeScale() { return tubeScale.value; },                               // for the tests
      get exaggeration() { return state.exag; }, get opacity() { return state.alpha; }, get palette() { return state.palette; }, get sectionOn() { return state.cut.mode === "south"; },
      get cut() { return { ...state.cut, range: CUT_RANGE[state.cut.mode] || null, onSection: onSection() }; }, setCut,
      flyToReceiver, get halo() { return halo.visible ? halo.userData.k : -1; }, cutTraceCount: () => traces.children.length,
      capsShown: () => Object.keys(caps).filter(k => caps[k].visible), pinsShown: () => (groups.pins || []).filter(g => g.visible).length,   // for the tests
      get logDepth() { return renderer.capabilities.logarithmicDepthBuffer; }, get clipCount() { return clipPlanes.length; },
      receiverXY: k => recXY[k], receiverElevation: k => recZ[k], sectionY: secY,
      terrainBounds: () => ({ west: X[0], east: X[Cn - 1], south: Yn[R - 1], north: Yn[0] }),
      pinScreen: k => screenOf(pinTop(groups.pins[k])),                          // for the tests
      clearHalo() { halo.visible = false; halo.userData.k = undefined; requestRender(); },
      pose: name => pose(name), lensHalf: HALF, faultView,                       // the globe's dive lands on this pose
      screenOfKm: (x, y) => { camera.updateMatrixWorld(); return screenOf(W(x, y, heightAt(x, y) || model.top_elevation_m)); },   // the hand-off test (a stage off screen has not rendered its camera)
      // where to click, for the tests: the epicentre, the middle of fault k's trace, a point of the A–B face under segment 3
      epiScreen: () => screenOf(groups.epi.position),
      faultScreen: k => { const t = densify(site.faults[k].trace_xy_km).filter(inside); const p = t[Math.floor(t.length / 2)]; return screenOf(drape(p[0], p[1], 35)); },
      sectionScreen: () => screenOf(W(segMid[0], secY, (model.top_elevation_m + baseM) / 2)),
      labels: () => [
        { id: "A", text: "A", onAB: true, at: W(...site.section.xy_km[0], site.section.elevation_m[0], 260) },
        { id: "B", text: "B", onAB: true, at: W(...site.section.xy_km[site.section.xy_km.length - 1], site.section.elevation_m[site.section.xy_km.length - 1], 260) },
        ...rxLabels().filter(l => l.k === state.selected),             // the chosen receiver before everything it could hide under
        { id: "segment", text: `Segment ${site.segment.number}`, cls: "accent", onAB: true, at: W(...segMid, Math.max(...site.segment.elevation_m), 520) },
        { id: "fault", text: site.faults[0] ? site.faults[0].name : "", cls: "fault", at: faultLabelAt() },
        ...traceLabels,
        ...rxLabels().filter(l => l.k !== state.selected),
        ...site.zones.map((z, k) => ({ id: `zone${k}`, text: z.name, cls: "zone", at: zoneCentre(z), zone: true })),
      ].map(l => ({ ...l, screen: l.at && (l.trace || (l.onAB && onSection()) || !isCut(l.at, 0.01)) ? screenOf(l.at) : { visible: false } })),   // no label over what a cut removed
      setInset(values) { state.inset = { ...state.inset, ...values }; applyOffset(); requestRender(); },
      setActive(on) { active = on; if (on) { resize(); requestRender(); } },
      setOrbit(on) { controls.autoRotate = !!on; controls.autoRotateSpeed = 0.5; requestRender(); },
      set onFrame(fn) { state.onFrame = fn; }, set onPick(fn) { state.onPick = fn; }, set onHover(fn) { state.onHover = fn; },
      requestRender, canvas: renderer.domElement, camera,
    };

    // B3: the 39 receivers by name, over their pins (app.js shows them once the camera is close)
    function rxLabels() {
      return (groups.pins || []).map((g, k) => ({ id: `rx${k}`, k, text: site.family.receivers.labels[k], cls: "rx", at: pinTop(g).add(new THREE.Vector3(0, 0.05 * pinScale, 0)), rx: true }));
    }
    function faultLabelAt() {
      let best = null, bd = Infinity;
      for (const f of site.faults) for (const p of densify(f.trace_xy_km).filter(inside)) { const d = Math.hypot(p[0] - segMid[0], p[1] - segMid[1]); if (d < bd) { bd = d; best = p; } }
      return best ? drape(best[0], best[1], 380) : null;
    }
    function zoneCentre(z) {
      const ring = z.rings.reduce((a, b) => (b.length > a.length ? b : a));
      const c = ring.reduce((s, p) => [s[0] + p[0] / ring.length, s[1] + p[1] / ring.length], [0, 0]);
      return inside(c) ? drape(c[0], c[1], 300) : null;
    }
  }

  function gradient(name) {
    const ramp = name === "elevation" ? t => d3.interpolateMagma(0.12 + 0.83 * t) : d3.piecewise(d3.interpolateRgb, PALETTES[name]);
    return `linear-gradient(to right, ${d3.range(0, 1.0001, 0.1).map(ramp).join(", ")})`;
  }
  const ramp = name => (name === "elevation" ? t => d3.interpolateMagma(0.12 + 0.83 * t) : d3.piecewise(d3.interpolateRgb, PALETTES[name]));
  window.Site = { create, gradient, ramp, PALETTES: Object.keys(PALETTES) };
})();
