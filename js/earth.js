// Surrogate Explorer · earth.js — the first stage: the Earth, then the flight down to Quito (three.js r128).
//
// The globe is NASA's imagery (vendor/earth/, made by tools/export_earth.py from GIBS): Blue Marble Next Generation by
// day (no shading baked in), the 2016 Black Marble city lights by night, one real day of VIIRS clouds, and the ASTER
// elevation with a land mask, all equirectangular as three.js's sphere UVs expect, plus a 650 m crop around Quito
// (DETAIL_BOX, colour and relief) that takes over during the dive.
//
// One shader lights it the way a photograph from space looks, in linear light with a filmic (ACES) tone curve:
//   * the sun is either fixed (Quito at 15:37 on an August afternoon: the terminator crosses the Atlantic, so the far
//     view shows day over the Andes and the lights of the night side) or the real one, now (setSun);
//   * the relief is lit by that sun (a normal from the elevation's slopes, exaggerated as every globe is), so the Andes
//     cast their light and shade from wherever the sun stands;
//   * the clouds drift (westward in the trade winds, eastward in the westerlies), are lit a little past the terminator,
//     hide the city lights and drop their shadow on the ground, offset away from the sun;
//   * the sea is a mirror with Fresnel: a sharp glint and a broad sheen where it reflects the sun;
//   * the air is single Rayleigh scattering in closed form: the ground is dimmed and reddened by the air it is seen and
//     lit through (exp(-tau * airmass), long paths at the limb and the terminator), and the air adds its own blue light,
//     orange where the sunlight reaching it has crossed a long path; a thin additive shell carries it past the limb, with
//     a Mie lobe when the sun is behind the Earth.
// Behind it, a sky of stars and a faint Milky Way along the real galactic plane. Ecuador is outlined in the accent on a
// small canvas over the crop, and Quito carries a pulsing marker. flyTo(view) moves the camera between named views.
(function () {
  "use strict";
  const RADIUS = 1;
  const DETAIL_BOX = [-84, -6, -72, 6];                           // lon_min, lat_min, lon_max, lat_max (= export_earth.py)
  const FIXED_SUN = Date.UTC(2026, 7, 13, 20, 37);                 // 15:37 in Quito: the sun overhead at (-128°, 14.5°)
  const ATMOSPHERE = 1.035;                                        // the glow's outer radius, in Earth radii
  const RAD = Math.PI / 180;

  // the sun's place for an instant (the Astronomical Almanac's low-precision formulas, ~0.01°): the point where it is
  // overhead, and the sidereal time that turns the sky
  function sunAt(ms) {
    const d = (ms - Date.UTC(2000, 0, 1, 12)) / 86400000;          // days from J2000.0
    const g = (357.529 + 0.98560028 * d) * RAD, q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD, e = (23.439 - 0.00000036 * d) * RAD;
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / RAD, dec = Math.asin(Math.sin(e) * Math.sin(L)) / RAD;
    const gmst = ((280.46061837 + 360.98564736629 * d) % 360 + 360) % 360;
    return { lon: ((ra - gmst + 540) % 360 + 360) % 360 - 180, lat: dec, gmst };
  }

  // shared by the globe and the air: the optical depth of a vertical path through the air (Rayleigh, plus a little haze
  // so the red is not all lost) and the airmass of a slanted one, finite at the horizon
  const AIR_GLSL = `
    const vec3 TAU = vec3(0.060, 0.125, 0.270);
    float airmass(float mu) { return 1.0 / (max(mu, 0.0) + 0.032 * exp(-6.0 * max(mu, 0.0))); }
    vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
    vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
    vec3 toScreen(vec3 c) { return pow(aces(c), vec3(1.0 / 2.2)); }`;

  const GLOBE_VERTEX = `
    varying vec2 vUv; varying vec3 vN;
    void main() { vUv = uv; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const GLOBE_FRAGMENT = `
    uniform sampler2D dayMap, nightMap, detailMap, overlayMap, cloudMap, reliefMap, detailReliefMap;
    uniform vec4 box; uniform vec3 sunDir, camDir, fadeColor; uniform float fade, cloudAmt, cloudTime, exposure;
    varying vec2 vUv; varying vec3 vN;
    const float PI = 3.14159265;
    const float H_UNIT = 8848.0 / 6371000.0;                         // relief.jpg's full scale, in Earth radii
    const float GAIN = 10.0, DETAIL_GAIN = 4.0;                       // relief exaggeration: the whole Earth, the crop
    ${AIR_GLSL}
    float height(sampler2D map, vec2 uv) { float e = texture2D(map, uv).r; return e * e * H_UNIT; }
    // the slope east and north (rise over run, both in Earth radii) from four taps one texel apart; span is the map's share
    // of the whole longitude and latitude range
    vec2 slope(sampler2D map, vec2 uv, vec2 texel, vec2 span, float cosLat) {
      float dx = height(map, uv + vec2(texel.x, 0.0)) - height(map, uv - vec2(texel.x, 0.0));
      float dy = height(map, uv + vec2(0.0, texel.y)) - height(map, uv - vec2(0.0, texel.y));
      return vec2(dx / (2.0 * texel.x * span.x * 2.0 * PI * max(cosLat, 0.05)), dy / (2.0 * texel.y * span.y * PI));
    }
    void main() {
      // the crop around Quito, faded in over its outer 6 % so its edge never shows (sampled everywhere: no branch, no
      // broken mip derivatives at the box's border)
      vec2 d = (vUv - box.xy) / (box.zw - box.xy), dc = clamp(d, 0.0, 1.0);
      float inside = step(0.0, d.x) * step(d.x, 1.0) * step(0.0, d.y) * step(d.y, 1.0);
      float edge = min(min(d.x, 1.0 - d.x), min(d.y, 1.0 - d.y)), wD = inside * smoothstep(0.0, 0.06, edge);
      vec3 day = mix(texture2D(dayMap, vUv).rgb, texture2D(detailMap, dc).rgb, wD);
      vec4 ov = texture2D(overlayMap, dc) * inside;                  // premultiplied

      // the local frame: up, east, north; and the relief's normal in it
      vec3 n = normalize(vN);
      float lat = (vUv.y - 0.5) * PI, cosLat = cos(lat);
      vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), n) + vec3(1e-5, 0.0, 0.0)), north = cross(n, east);
      float land = mix(texture2D(reliefMap, vUv).g, texture2D(detailReliefMap, dc).g, wD);
      vec2 s = mix(GAIN * slope(reliefMap, vUv, vec2(1.0 / 4096.0, 1.0 / 2048.0), vec2(1.0), cosLat),
                   DETAIL_GAIN * slope(detailReliefMap, dc, vec2(1.0 / 2048.0), box.zw - box.xy, cosLat), wD);
      s *= smoothstep(0.1, 0.6, land) * (1.0 - smoothstep(1.28, 1.40, abs(lat)));   // the sea is flat; no relief near the poles
      vec3 nb = normalize(n - s.x * east - s.y * north);

      float mu = dot(n, sunDir), muv = max(dot(n, camDir), 0.0);
      // the air's colour cast relative to the zenith path (Blue Marble is already the ground as seen from overhead)
      vec3 sunGround = exp(-TAU * (airmass(mu) - 1.0)) * smoothstep(-0.02, 0.05, mu);   // the sunlight that reaches the ground
      vec3 viewT = exp(-TAU * (airmass(muv) - 1.0));                                     // what the air lets through to the eye

      // clouds: drifting with latitude, their shadow cast away from the sun from ~12 km up
      float drift = mix(-1.0, 1.0, smoothstep(0.35, 0.60, abs(lat)));
      vec2 cuv = vec2(vUv.x + drift * cloudTime, vUv.y);
      float cloud = smoothstep(0.06, 0.95, texture2D(cloudMap, cuv).r) * cloudAmt;   // no veil of faint haze
      vec2 toSun = vec2(dot(sunDir, east), dot(sunDir, north)) * 0.0019 / max(mu, 0.2);
      float shade = texture2D(cloudMap, cuv + vec2(toSun.x / (2.0 * PI * max(cosLat, 0.05)), toSun.y / PI)).r * cloudAmt;

      vec3 ground = toLinear(day) * max(dot(nb, sunDir), 0.0) * sunGround * (1.0 - 0.6 * shade);
      // the sea: a sharp glint and a broad sheen, with Fresnel
      vec3 h = normalize(sunDir + camDir);
      float nh = max(dot(n, h), 0.0), fres = 0.02 + 0.98 * pow(1.0 - max(dot(h, camDir), 0.0), 5.0);
      ground += (1.0 - land) * sunGround * (pow(nh, 600.0) * 0.9 + pow(nh, 45.0) * 0.035) * (0.6 + 2.0 * fres) * max(mu, 0.0) * (1.0 - shade);
      // the cloud tops catch the sun a little past the terminator
      vec3 cloudLit = vec3(0.80) * exp(-TAU * (airmass(mu + 0.04) - 1.0)) * smoothstep(-0.07, 0.25, mu + 0.04) * (0.25 + 0.75 * max(mu + 0.04, 0.0));
      vec3 surface = mix(ground, cloudLit, cloud);

      // the night side: the city lights (luminance above 0.22 in Black Marble; the moonlit land sits near 0.14 and the
      // polar no-data band at 0.20), warmed to street lighting, over a faint trace of the land; the clouds hide them
      vec3 night = texture2D(nightMap, vUv).rgb;
      float lum = dot(night, vec3(0.30, 0.59, 0.11)), dark = 1.0 - smoothstep(-0.12, 0.10, mu);
      vec3 lights = (toLinear(night * smoothstep(0.22, 0.60, lum)) * vec3(2.6, 2.0, 1.3) + toLinear(night) * 0.05) * dark * (1.0 - 0.85 * cloud);

      // the air between the ground and the eye: its own light, lit by the sun through the air above this point
      float cosT = dot(sunDir, camDir);
      vec3 airSun = exp(-TAU * 0.5 * (airmass(mu + 0.06) - 1.0)) * smoothstep(-0.20, 0.10, mu);
      // (the ground's dark greens and the sea are a few % in linear light: a full zenith veil would turn them both navy,
      // so the veil starts thin overhead and thickens toward the limb, as in the photographs)
      vec3 inscatter = (1.0 - exp(-TAU * (airmass(muv) - 0.92))) * airSun * 0.75 * (1.0 + cosT * cosT) * 0.30;

      vec3 col = toScreen(((surface + lights) * viewT + inscatter) * exposure);
      col = col * (1.0 - ov.a) + ov.rgb;
      gl_FragColor = vec4(mix(col, fadeColor, fade), 1.0);            // the landing: the world gives way to the map's ground
    }`;
  const AIR_VERTEX = `
    varying vec3 vN; varying float vZ;
    void main() { vN = normalize(mat3(modelMatrix) * normal); vZ = normalize(normalMatrix * normal).z; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
  const AIR_FRAGMENT = `
    uniform vec3 sunDir, camDir; uniform float zMax, fade, exposure;
    varying vec3 vN; varying float vZ;
    ${AIR_GLSL}
    void main() {
      // the far half of the shell (BackSide), seen past the limb: |n.z| runs from zMax at the limb to 0 at the edge
      float t = pow(clamp(-vZ / zMax, 0.0, 1.0), 2.4), mu = dot(normalize(vN), sunDir);
      vec3 airSun = exp(-TAU * 0.5 * (airmass(mu + 0.06) - 1.0)) * smoothstep(-0.12, 0.10, mu);
      float c = dot(-sunDir, camDir), g = 0.72;                      // forward scattering: the sun behind the Earth
      float mie = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * c, 1.5) * 0.010;
      vec3 light = airSun * (vec3(0.30, 0.56, 1.00) * 0.75 * (1.0 + c * c) * 0.38 + mie);
      gl_FragColor = vec4(toScreen(light * t * exposure) * (1.0 - fade), 1.0);
    }`;
  // the Milky Way: a soft band about the galactic plane (its pole and centre from the sidereal time), brighter toward
  // the centre and cut by dark lanes; drawn on a screen quad through the stars' fixed lens
  const SKY_VERTEX = `
    varying vec2 vP;
    void main() { vP = position.xy; gl_Position = vec4(position.xy, 0.9999, 1.0); }`;
  const SKY_FRAGMENT = `
    uniform vec3 galPole, galCentre; uniform float aspect, focal, fade;
    varying vec2 vP;
    float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float noise(vec3 x) {
      vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
                 mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
    }
    float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int k = 0; k < 5; k++) { s += a * noise(p); p *= 2.03; a *= 0.5; } return s; }
    void main() {
      vec3 dv = normalize(vec3(vP.x * aspect / focal, vP.y / focal, -1.0));
      vec3 dir = normalize((vec4(dv, 0.0) * viewMatrix).xyz);          // view -> world: the rotation's transpose
      float b = asin(clamp(dot(dir, galPole), -1.0, 1.0));
      float core = 0.35 + 0.65 * pow(max(dot(dir, galCentre), 0.0), 3.0);
      float band = exp(-pow(b / 0.20, 2.0)) * core * (0.55 + 0.9 * fbm(dir * 7.0));
      float lanes = 1.0 - 0.75 * exp(-pow((b + 0.015) / 0.035, 2.0)) * smoothstep(0.35, 0.75, fbm(dir * 11.0 + 3.1));
      vec3 col = vec3(0.80, 0.82, 0.95) * band * lanes * 0.055;
      gl_FragColor = vec4(col * (1.0 - fade), 1.0);
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
    const sunDir = new THREE.Vector3(), camDir = new THREE.Vector3();
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);   // until the imagery arrives
    blank.needsUpdate = true;
    const uv = (lon, lat) => [(lon + 180) / 360, (lat + 90) / 180];
    // fade: 0 in space, 1 at the end of the dive, where the world around the relief has become the map's ground colour
    const fade = { value: 0 }, fadeColor = { value: new THREE.Color(0x2b2b2d) }, SPACE = new THREE.Color(0x03050a);
    const exposure = { value: 1.5 }, cloudAmt = { value: 1 }, cloudTime = { value: 0 };
    const globeMaterial = new THREE.ShaderMaterial({
      vertexShader: GLOBE_VERTEX, fragmentShader: GLOBE_FRAGMENT,
      uniforms: { dayMap: { value: blank }, nightMap: { value: blank }, detailMap: { value: blank }, overlayMap: { value: blank },
                  cloudMap: { value: blank }, reliefMap: { value: blank }, detailReliefMap: { value: blank },
                  box: { value: new THREE.Vector4(...uv(DETAIL_BOX[0], DETAIL_BOX[1]), ...uv(DETAIL_BOX[2], DETAIL_BOX[3])) },
                  sunDir: { value: sunDir }, camDir: { value: camDir }, fade, fadeColor, exposure, cloudAmt, cloudTime },
    });
    const globe = new THREE.Mesh(new THREE.SphereGeometry(RADIUS, 160, 112), globeMaterial);
    globe.visible = false;                                            // shown with its day texture, never as a black ball
    scene.add(globe);
    const air = new THREE.Mesh(new THREE.SphereGeometry(RADIUS * ATMOSPHERE, 96, 64), new THREE.ShaderMaterial({
      vertexShader: AIR_VERTEX, fragmentShader: AIR_FRAGMENT, side: THREE.BackSide, blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false,
      uniforms: { sunDir: { value: sunDir }, camDir: { value: camDir }, zMax: { value: Math.sqrt(1 - 1 / (ATMOSPHERE * ATMOSPHERE)) }, fade, exposure },
    }));
    air.visible = false; scene.add(air);

    // the sun: fixed (the story's afternoon) or now; the sky turns with the sidereal time of the same instant
    const galPole = new THREE.Vector3(), galCentre = new THREE.Vector3();
    let sunMode = "fixed", sunInstant = FIXED_SUN, sunStamp = 0;
    function placeSun(ms) {
      const s = sunAt(ms);
      sunInstant = ms; sunDir.copy(lonLatToVector(s.lon, s.lat)).normalize();
      // the galactic north pole (RA 192.86°, Dec 27.13°) and centre (RA 266.40°, Dec -28.94°), J2000, at that instant
      galPole.copy(lonLatToVector(192.8595 - s.gmst, 27.1283)).normalize();
      galCentre.copy(lonLatToVector(266.4051 - s.gmst, -28.9362)).normalize();
      return s;
    }
    placeSun(FIXED_SUN);

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
    const sky = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT, depthTest: false, depthWrite: false,
      uniforms: { galPole: { value: galPole }, galCentre: { value: galCentre }, aspect: starUniforms.aspect, focal: starUniforms.focal, fade },
    }));
    sky.frustumCulled = false; sky.renderOrder = -2; scene.add(sky);   // under the stars

    const quito = lonLatToVector(site.origin_lon_lat[0], site.origin_lon_lat[1]);
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.009, 16, 12), new THREE.MeshBasicMaterial({ color: 0xe58a2b }));
    marker.position.copy(quito); scene.add(marker);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.016, 0.022, 48), new THREE.MeshBasicMaterial({ color: 0xe58a2b, transparent: true, side: THREE.DoubleSide }));
    ring.position.copy(quito.clone().multiplyScalar(1.002)); ring.lookAt(quito.clone().multiplyScalar(2)); scene.add(ring);

    // ---------------------------------------------------------------- imagery (once) and Ecuador's outline (per theme)
    const imagery = { day: false, night: false, detail: false, clouds: false, relief: false, relief_detail: false };
    const UNIFORM = { day: "dayMap", night: "nightMap", detail: "detailMap", clouds: "cloudMap", relief: "reliefMap", relief_detail: "detailReliefMap" };
    let loading = null;
    function loadImagery() {
      if (loading) return loading;
      const loader = new THREE.TextureLoader();
      const one = name => new Promise((resolve, reject) => loader.load(`vendor/earth/${name}.jpg`, texture => {
        texture.anisotropy = anisotropy;
        if (name === "clouds") { texture.wrapS = THREE.RepeatWrapping; texture.needsUpdate = true; }   // they drift across the date line
        if (name.startsWith("relief")) texture.anisotropy = 1;      // data; its mipmaps keep the far view's slopes from sparkling
        globeMaterial.uniforms[UNIFORM[name]].value = texture; imagery[name] = true;
        if (name === "day") { globe.visible = air.visible = true; }
        requestRender(); resolve();
      }, undefined, () => reject(new Error(`the globe's ${name} imagery did not load (vendor/earth/${name}.jpg)`))));
      return (loading = Promise.all(Object.keys(UNIFORM).map(one)));
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
      if (sunMode === "now" && now - sunStamp > 5000) { sunStamp = now; placeSun(Date.now()); if (state.onSun) state.onSun(); }
      // the clouds drift ~0.35° a minute, and clear away on the way down to Quito (from 2.0 to 0.6 of the 32° lens distance:
      // the near view still has them, and they are gone before their 10 km texels are magnified)
      cloudTime.value = (now / 1000) * 1.6e-5 % 1;
      const dist = 1 / camera.zoom;
      cloudAmt.value = Math.min(1, Math.max(0, (Math.log(dist) - Math.log(0.6)) / Math.log(2.0 / 0.6)));
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
    const state = { onFrame: null, onSun: null };

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
      // "fixed": the story's afternoon; "now": the real sun of this instant, kept up to date while the stage runs
      setSun(mode) { sunMode = mode === "now" ? "now" : "fixed"; sunStamp = performance.now(); placeSun(sunMode === "now" ? Date.now() : FIXED_SUN); requestRender(); },
      get sun() { const s = sunAt(sunInstant); return { mode: sunMode, instant: sunInstant, lon: s.lon, lat: s.lat }; },
      set onSun(fn) { state.onSun = fn; },
      quitoScreen: () => screenOf(quito),
      screenOfKm: (x, y) => { controls.update(); camera.updateMatrixWorld(); const [lon, lat] = kmToLonLat(x, y); return screenOf(lonLatToVector(lon, lat)); },   // the hand-off test
      get imagery() { return { ...imagery }; },
      set onFrame(fn) { state.onFrame = fn; },
      canvas: renderer.domElement,
    };
  }

  window.Earth = { create, lonLatToVector };
})();
