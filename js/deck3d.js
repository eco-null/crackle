// 3D turntable rendered with three.js. Real-world scale in centimetres: 45×35 cm plinth,
// 12" record (30.5 cm) with a 10 cm label, 23 cm tonearm. Physically based materials,
// a soft studio environment for reflections, one warm key light with soft shadows.
//
// The record surface is generated data, not a photo: a tangential anisotropy map makes the
// grooves throw the two radial highlight wedges a real record shows under a lamp, and roughness
// and normal maps carry track gaps, lead-in, run-out and the rolled edge.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// CC0 assets from Poly Haven, loaded from its CDN (CORS enabled). The deck renders with the
// built-in reflection room and photo textures until they arrive.
const PH = 'https://dl.polyhaven.org/file/ph-assets';
const HDRI = `${PH}/HDRIs/hdr/1k/brown_photostudio_02_1k.hdr`;
const pbrUrls = (id) => ({
  map: `${PH}/Textures/jpg/2k/${id}/${id}_diff_2k.jpg`,
  normal: `${PH}/Textures/jpg/2k/${id}/${id}_nor_gl_2k.jpg`,
  rough: `${PH}/Textures/jpg/2k/${id}/${id}_rough_2k.jpg`,
});
import { asset, METALS } from './materials.js';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---------- geometry constants (cm) ----------
const PL = { w: 45, d: 35, h: 5.6, y0: 1.4 };            // plinth
const TOP = PL.y0 + PL.h;                                 // plinth top surface
const C = { x: -5, z: 0 };                                // spindle
const PLATTER = { r: 15.6, h: 1.9, y: TOP + .3 };
const MAT_Y = PLATTER.y + PLATTER.h;                      // top of platter
const MAT_T = .3;
const REC = { r: 15.24, t: .19, label: 5, hole: .36 };
const REC_Y = MAT_Y + MAT_T;                              // underside of record
const REC_TOP = REC_Y + REC.t;
const PIV = { x: 13.6, z: -11.2 };
const ARM_Y = REC_TOP + 1.6;                              // tube height
const ARM_L = 23;                                         // pivot → stylus
const R_LEADIN = 14.75, R_RUNOUT = 6.4;

// arm sweep angle a (deg): 0 = at rest pointing to the front, grows toward the spindle
const stylusAt = (a) => {
  const r = a * Math.PI / 180;
  return { x: PIV.x - ARM_L * Math.sin(r), z: PIV.z + ARM_L * Math.cos(r) };
};
const radiusAt = (a) => { const s = stylusAt(a); return Math.hypot(s.x - C.x, s.z - C.z); };
function angleForRadius(r) {
  let lo = 0, hi = 120;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (radiusAt(m) > r) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
const A_LEADIN = angleForRadius(R_LEADIN);
const A_RUNOUT = angleForRadius(R_RUNOUT);
const REST = 0;

const approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const smooth = (t) => t * t * (3 - 2 * t);
const KNOB_MIN = 2.36, KNOB_MAX = -2.36;                    // knob angle at volume 0 and 1 (rad)

// ---------- generated textures ----------
function dataTex(w, h, data, { srgb = false, repeat = false } = {}) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

function noise1d(seed) {
  const n = 512, v = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) { s = (s * 16807) % 2147483647; v[i] = s / 2147483647; }
  return (x) => {
    const i = Math.floor(x), f = x - i, a = v[((i % n) + n) % n], b = v[(((i + 1) % n) + n) % n];
    return a + (b - a) * smooth(f);
  };
}

// Record surface maps: normal (rolled edge, track-gap steps), roughness, tangential anisotropy.
function recordMaps(size) {
  const N = 4096;                                    // radial profile resolution
  const h = new Float32Array(N), rough = new Float32Array(N), an = new Float32Array(N);
  const n1 = noise1d(7), n2 = noise1d(19);
  const gaps = [13.45, 12.1, 10.85, 9.4, 8.2, 7.2];
  for (let i = 0; i < N; i++) {
    const r = (i / (N - 1)) * REC.r;
    let height = 0, ro, a;
    if (r < REC.label + .25) { ro = .45; a = 0; }                            // under the label
    else if (r < R_RUNOUT - .1) { ro = .17; a = .25; height = -.0006; }        // run-out, smooth
    else if (r < R_LEADIN) {
      const gap = gaps.reduce((m, g) => Math.min(m, Math.abs(r - g)), 9);
      const inGap = smooth(Math.max(0, Math.min(1, (gap - .05) / .06)));
      ro = .2 + .14 * inGap + .05 * (n1(r * 9) - .5) + .03 * (n2(r * 37) - .5);
      a = .2 + .8 * inGap;
      height = -.0012 * inGap + .00025 * (n2(r * 23) - .5);
    } else if (r < REC.r - .32) { ro = .2; a = .35; }                          // lead-in land
    else {                                                                       // rolled edge bead
      const t = (r - (REC.r - .32)) / .32;
      height = .006 * Math.sin(t * Math.PI) - .01 * t * t; ro = .26; a = .1;
    }
    h[i] = height; rough[i] = ro; an[i] = a;
  }
  const nrm = new Uint8Array(size * size * 4), rgh = new Uint8Array(size * size * 4), ani = new Uint8Array(size * size * 4);
  const c = size / 2, k = REC.r / c;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + .5 - c, dy = y + .5 - c, rp = Math.hypot(dx, dy) || 1;
      const r = rp * k, i = Math.min(N - 2, Math.max(1, Math.round(r / REC.r * (N - 1))));
      const slope = (h[i + 1] - h[i - 1]) / (2 * REC.r / (N - 1));         // dh/dr
      const ux = dx / rp, uy = dy / rp;
      let nx = -slope * ux * 4, ny = -slope * uy * 4, nz = 1;
      const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
      const o = (y * size + x) * 4;
      nrm[o] = (nx * .5 + .5) * 255; nrm[o + 1] = (ny * .5 + .5) * 255; nrm[o + 2] = (nz * .5 + .5) * 255; nrm[o + 3] = 255;
      const ro = Math.max(0, Math.min(1, rough[i])) * 255;
      rgh[o] = ro; rgh[o + 1] = ro; rgh[o + 2] = ro; rgh[o + 3] = 255;
      // tangential direction (-uy, ux) in tangent space, strength in blue
      ani[o] = (-uy * .5 + .5) * 255; ani[o + 1] = (ux * .5 + .5) * 255; ani[o + 2] = an[i] * 255; ani[o + 3] = 255;
    }
  }
  return { normal: dataTex(size, size, nrm), roughness: dataTex(size, size, rgh), aniso: dataTex(size, size, ani) };
}

// Circular brushing for machined round tops (knob, platter chamfer).
function circularAniso(size) {
  const d = new Uint8Array(size * size * 4), c = size / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x + .5 - c, dy = y + .5 - c, r = Math.hypot(dx, dy) || 1, o = (y * size + x) * 4;
    d[o] = (-dy / r * .5 + .5) * 255; d[o + 1] = (dx / r * .5 + .5) * 255; d[o + 2] = 255; d[o + 3] = 255;
  }
  return dataTex(size, size, d);
}

// Knurling as a tangent-space normal map that repeats around a cylinder.
function knurlNormal() {
  const w = 256, hgt = 64, d = new Uint8Array(w * hgt * 4);
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
    const sx = Math.sin((x / w) * Math.PI * 2 * 48 + y / hgt * Math.PI * 2 * 3);
    const sy = Math.sin((x / w) * Math.PI * 2 * 48 - y / hgt * Math.PI * 2 * 3);
    let nx = (sx + sy) * .35, ny = (sx - sy) * .12, nz = 1; const l = Math.hypot(nx, ny, nz);
    const o = (y * w + x) * 4;
    d[o] = (nx / l * .5 + .5) * 255; d[o + 1] = (ny / l * .5 + .5) * 255; d[o + 2] = (nz / l * .5 + .5) * 255; d[o + 3] = 255;
  }
  return dataTex(w, hgt, d, { repeat: true });
}

// Strobe dots around the platter rim (color map: light metal with darker raised dots, two rows).
function strobeMap() {
  const cv = document.createElement('canvas'); cv.width = 4096; cv.height = 64;
  const g = cv.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 4096, 64);
  g.fillStyle = 'rgba(0,0,0,.08)'; g.fillRect(0, 30, 4096, 2);
  for (const [rowY, count] of [[16, 183], [46, 180]]) {
    for (let i = 0; i < count; i++) {
      const x = (i + .5) * 4096 / count;
      const grad = g.createRadialGradient(x - 2, rowY - 2, 1, x, rowY, 7);
      grad.addColorStop(0, '#5a5a5a'); grad.addColorStop(.7, '#2a2a2a'); grad.addColorStop(1, 'rgba(40,40,40,0)');
      g.fillStyle = grad; g.beginPath(); g.arc(x, rowY, 7, 0, Math.PI * 2); g.fill();
    }
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping;
  return t;
}

// Soft contact shadow under the plinth.
// A blurred footprint of the plinth on the floor. The canvas keeps a margin of three blur radii on
// every side so the blur reaches zero before the edge; a cut-off blur ends in a hard grey line.
const SHADOW_CM_PER_PX = 45 / 372;                       // the 372 px rectangle is the 45 cm plinth
function contactShadow(blur = 26, grow = 0) {
  const pad = grow + blur * 3, w = 372 + pad * 2, h = 268 + pad * 2;
  const cv = document.createElement('canvas'); cv.width = Math.ceil(w); cv.height = Math.ceil(h);
  const g = cv.getContext('2d');
  g.filter = `blur(${blur}px)`; g.fillStyle = 'rgba(0,0,0,.9)';
  g.beginPath(); g.roundRect(pad - grow, pad - grow, 372 + grow * 2, 268 + grow * 2, 30 + grow); g.fill();
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  t.userData.size = [cv.width * SHADOW_CM_PER_PX, cv.height * SHADOW_CM_PER_PX];
  return t;
}

// ---------- room-matched lighting ----------
const srgbToLinear = (v) => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
const chroma = (c) => { const m = Math.max(c[0], c[1], c[2], 1e-4); return new THREE.Color(c[0] / m, c[1] / m, c[2] / m); };

// Reads a room photo the way a lighting designer would: the room's overall tint and brightness, and
// the colour, side and height of its strongest light (window, lamp, fire): the brightest 4 % of pixels.
function analyseRoom(img) {
  const W = 64, H = 36, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d'); g.drawImage(img, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data, px = [], sum = [0, 0, 0];
  for (let i = 0; i < d.length; i += 4) {
    const c = [srgbToLinear(d[i]), srgbToLinear(d[i + 1]), srgbToLinear(d[i + 2])];
    const l = .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
    px.push({ c, l, x: (i / 4) % W / (W - 1), y: Math.floor(i / 4 / W) / (H - 1) });
    sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2];
  }
  px.sort((a, b) => b.l - a.l);
  const top = px.slice(0, Math.round(px.length * .04)), bc = [0, 0, 0];
  let bx = 0, by = 0, bl = 0;
  for (const p of top) { bc[0] += p.c[0] * p.l; bc[1] += p.c[1] * p.l; bc[2] += p.c[2] * p.l; bx += p.x * p.l; by += p.y * p.l; bl += p.l; }
  const n = px.length, mean = [sum[0] / n, sum[1] / n, sum[2] / n];
  const brightness = .2126 * mean[0] + .7152 * mean[1] + .0722 * mean[2];
  return { ambient: chroma(mean), light: chroma(bc), side: bx / bl, height: by / bl, brightness, peak: bl / top.length };
}

// The photo is the wall behind the deck, so it becomes the reflection environment: it fills the
// hemisphere away from the viewer (its mirror image the other half), its edge rows stretch into
// ceiling and floor, and an inverse tone curve gives windows, lamps and fire back their real intensity.
function roomEnvironment(img, pmrem) {
  const W = 512, H = 256, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const y0 = Math.round(H * .18), ph = Math.round(H * .6);
  g.drawImage(img, 0, y0, W / 2, ph);
  g.save(); g.translate(W, 0); g.scale(-1, 1); g.drawImage(img, 0, y0, W / 2, ph); g.restore();
  g.drawImage(cv, 0, y0 + 1, W, 2, 0, 0, W, y0);
  g.drawImage(cv, 0, y0 + ph - 3, W, 2, 0, y0 + ph, W, H - y0 - ph);
  const soft = document.createElement('canvas'); soft.width = W; soft.height = H;
  const sg = soft.getContext('2d'); sg.filter = 'blur(3px)'; sg.drawImage(cv, 0, 0);
  const d = sg.getImageData(0, 0, W, H).data, data = new Uint16Array(W * H * 4), half = THREE.DataUtils.toHalfFloat;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = ((H - 1 - y) * W + x) * 4, o = (y * W + x) * 4;      // DataTexture rows run bottom-up
      const r = srgbToLinear(d[i]), gr = srgbToLinear(d[i + 1]), b = srgbToLinear(d[i + 2]);
      // walls stay as photographed (a little under, so black vinyl stays black); only the light
      // sources are expanded, up to 8x, which is what makes chrome and lacquer read as lit by them
      const l = .2126 * r + .7152 * gr + .0722 * b, e = Math.max(0, Math.min(1, (l - .45) / .5));
      // ceiling and floor are darker than the lit wall: fade the stretched rows away from the photo
      const fy = y < y0 ? .22 + .5 * (y / y0) : y >= y0 + ph ? .3 + .4 * (1 - (y - y0 - ph) / (H - y0 - ph)) : 1;
      const k = .7 * fy * (1 + 7 * e * e * (3 - 2 * e));
      data[o] = half(r * k); data[o + 1] = half(gr * k); data[o + 2] = half(b * k); data[o + 3] = half(1);
    }
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.LinearSRGBColorSpace;
  t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
  const env = pmrem.fromEquirectangular(t).texture;
  t.dispose();
  return env;
}

// the studio rig the deck was lit with before rooms had a say; also the plain backdrop's
const STUDIO_RIG = {
  key: new THREE.Color('#fff1df'), keyI: 1.9, keyPos: new THREE.Vector3(-48, 62, 30),
  rim: new THREE.Color('#dfe8ff'), rimI: .55, rimPos: new THREE.Vector3(40, 45, -50),
  box: new THREE.Color('#fff4e6'), boxI: 4.2, env: .9, flicker: 0,
};
const cloneRig = (r) => ({ ...r, key: r.key.clone(), keyPos: r.keyPos.clone(), rim: r.rim.clone(), rimPos: r.rimPos.clone(), box: r.box.clone() });

// Warm, contrasty room used only for reflections: dark walls, a big softbox overhead,
// a window strip on the left and a small lamp behind. Metals need this contrast to read as metal.
function reflectionRoom() {
  const scene = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(60, 30, 60), new THREE.MeshBasicMaterial({ color: '#2b241e', side: THREE.BackSide }));
  room.position.y = 10;
  scene.add(room);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshBasicMaterial({ color: '#16120f' }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -4.9; scene.add(floor);
  const panel = (w, h, color, pos, look) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
    m.position.set(...pos); m.lookAt(...look); scene.add(m);
  };
  panel(22, 14, new THREE.Color('#fff2e0').multiplyScalar(5), [-4, 24.8, 4], [-4, 0, 4]);      // softbox
  panel(3, 16, new THREE.Color('#e8eefc').multiplyScalar(2.2), [-29.8, 8, 0], [0, 8, 0]);      // window strip
  panel(26, 2.5, new THREE.Color('#ffe2bc').multiplyScalar(1.4), [0, 4, -29.8], [0, 4, 0]);    // low warm band behind
  panel(4, 4, new THREE.Color('#ffc98a').multiplyScalar(3), [22, 12, -22], [0, 0, 0]);         // lamp
  return scene;
}

// Linear brushing for flat machined parts: rougher streaks along u, with a faint normal ripple.
function brushedMaps() {
  const W = 512, H = 512, rgh = new Uint8Array(W * H * 4), nrm = new Uint8Array(W * H * 4);
  let s = 9;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const row = new Float32Array(H);
  for (let y = 0; y < H; y++) row[y] = rnd();
  for (let y = 0; y < H; y++) {
    const a = row[y], b = row[(y + 1) % H], c = row[(y + H - 1) % H];
    for (let x = 0; x < W; x++) {
      const streak = .55 * a + .25 * b + .2 * c + (rnd() - .5) * .12;
      const r = Math.max(0, Math.min(1, .62 + (streak - .5) * .55)) * 255;
      const o = (y * W + x) * 4;
      rgh[o] = r; rgh[o + 1] = r; rgh[o + 2] = r; rgh[o + 3] = 255;
      const ny = (b - c) * .35, l = Math.hypot(ny, 1);
      nrm[o] = 128; nrm[o + 1] = (ny / l * .5 + .5) * 255; nrm[o + 2] = (1 / l * .5 + .5) * 255; nrm[o + 3] = 255;
    }
  }
  return { rough: dataTex(W, H, rgh, { repeat: true }), normal: dataTex(W, H, nrm, { repeat: true }) };
}

// Fine swirl marks and hairline scratches in a clear coat (values multiply clearcoatRoughness).
function scratchMap() {
  const S = 1024, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = 'rgb(150,150,150)'; g.fillRect(0, 0, S, S);
  let s = 21;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  g.lineCap = 'round';
  for (let i = 0; i < 520; i++) {
    const x = rnd() * S, y = rnd() * S, r = 40 + rnd() * 260, a = rnd() * Math.PI * 2, len = .1 + rnd() * .5;
    g.strokeStyle = `rgba(255,255,255,${.12 + rnd() * .3})`; g.lineWidth = .6 + rnd() * .9;
    g.beginPath(); g.arc(x, y, r, a, a + len); g.stroke();
  }
  for (let i = 0; i < 70; i++) {
    const x = rnd() * S, y = rnd() * S, a = rnd() * Math.PI, l = 20 + rnd() * 120;
    g.strokeStyle = `rgba(255,255,255,${.25 + rnd() * .35})`; g.lineWidth = .7;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// Silkscreen / engraving text: white glyphs on transparent, tinted by the material colour.
function textTexture(text, { px = 64, weight = 600, spacing = .18, w = 512, h = 128 } = {}) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `${weight} ${px}px "Inter", "Segoe UI", sans-serif`;
  if ('letterSpacing' in g) g.letterSpacing = `${spacing * px}px`;
  g.fillText(text, w / 2, h / 2 + 2);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

// Counterweight scale: ticks every 0.25 g with longer marks and numbers each gram.
function scaleRingTexture() {
  const cv = document.createElement('canvas'); cv.width = 2048; cv.height = 96;
  const g = cv.getContext('2d');
  g.fillStyle = '#141414'; g.fillRect(0, 0, 2048, 96);
  g.fillStyle = '#e9e4da'; g.textAlign = 'center'; g.font = '600 26px "Inter", sans-serif';
  for (let i = 0; i < 80; i++) {
    const x = (i + .5) * 2048 / 80, big = i % 4 === 0;
    g.fillRect(x - 1.5, 0, 3, big ? 34 : 18);
    if (big) g.fillText(String((i / 4) % 10), x, 70);
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping;
  return t;
}

const easeInOutCubic = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const quintic = (t) => t * t * t * (t * (6 * t - 15) + 10);           // minimum-jerk profile
const travelTime = (d) => Math.max(.7, Math.min(3.2, .5 + Math.abs(d) / 16));
const easeOutBack = (t, k = 1.4) => 1 + (k + 1) * Math.pow(t - 1, 3) + k * Math.pow(t - 1, 2);

// ---------- label printing ----------
// Uncoated label paper: warm off-white with fine fibre noise.
const paperImg = (() => {
  const S = 1024, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#ece5d6'; g.fillRect(0, 0, S, S);
  const img = g.getImageData(0, 0, S, S), d = img.data;
  let s = 5;
  for (let i = 0; i < d.length; i += 4) {
    s = (s * 16807) % 2147483647;
    const n = (s / 2147483647 - .5) * 10;
    d[i] += n; d[i + 1] += n; d[i + 2] += n * .9;
  }
  g.putImageData(img, 0, 0);
  g.globalAlpha = .05; g.strokeStyle = '#7a6a55';
  for (let i = 0; i < 900; i++) {
    s = (s * 16807) % 2147483647; const x = (s / 2147483647) * S;
    s = (s * 16807) % 2147483647; const y = (s / 2147483647) * S;
    s = (s * 16807) % 2147483647; const a = (s / 2147483647) * Math.PI;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * 9, y + Math.sin(a) * 9); g.stroke();
  }
  g.globalAlpha = 1;
  return cv;
})();
const imageCache = new Map();
function loadImage(url) {
  if (!url) return Promise.resolve(null);
  if (!imageCache.has(url)) {
    imageCache.set(url, new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img.naturalWidth > 120 ? img : null);
      img.onerror = () => resolve(null);
      img.src = url;
    }));
  }
  return imageCache.get(url);
}

function drawCover(g, img, x, y, s) {
  const iw = img.naturalWidth, ih = img.naturalHeight, side = Math.min(iw, ih);
  g.drawImage(img, (iw - side) / 2, (ih - side) / 2, side, side, x, y, s, s);
}

function arcText(g, text, r, centerAngle, size, weight, color, inward) {
  g.save();
  g.font = `${weight} ${size}px "JetBrains Mono", "Cascadia Mono", monospace`;
  g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
  const chars = [...text]; const spacing = size * .72;
  const total = (chars.length - 1) * spacing / r;
  chars.forEach((ch, i) => {
    const a = inward ? centerAngle + total / 2 - i * spacing / r : centerAngle - total / 2 + i * spacing / r;
    g.save(); g.rotate(a); g.translate(0, inward ? r : -r); g.rotate(inward ? Math.PI : 0);
    g.fillText(ch, 0, 0); g.restore();
  });
  g.restore();
}

// Returns { texture, color, img }; color is the cover's average color (album pressing, room light).
async function printLabel({ art, artFallback, title, artist, rpm }) {
  const S = 1024, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const img = (await loadImage(art)) || (await loadImage(artFallback));
  g.save(); g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2); g.clip();
  g.drawImage(paperImg, 0, 0, S, S);
  let color = null;
  if (img) {
    g.filter = 'saturate(.92) contrast(.96)';
    drawCover(g, img, 0, 0, S);
    g.filter = 'none';
    g.globalCompositeOperation = 'multiply'; g.globalAlpha = .5;            // ink soaked into paper
    g.drawImage(paperImg, 0, 0, S, S);
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    const s = document.createElement('canvas'); s.width = s.height = 8;
    const sg = s.getContext('2d'); drawCover(sg, img, 0, 0, 8);
    const px = sg.getImageData(0, 0, 8, 8).data; let r = 0, gg = 0, b = 0;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; }
    color = `rgb(${Math.round(r / 64)}, ${Math.round(gg / 64)}, ${Math.round(b / 64)})`;
  } else {
    g.translate(S / 2, S / 2);
    arcText(g, (title || 'side a').toLowerCase().slice(0, 30), 330, 0, 36, 600, 'rgba(36,30,24,.86)', false);
    arcText(g, (artist || '').toLowerCase().slice(0, 34), 350, Math.PI, 26, 500, 'rgba(36,30,24,.55)', true);
    g.font = '600 30px "JetBrains Mono", monospace'; g.fillStyle = 'rgba(30,26,22,.7)'; g.textAlign = 'center';
    g.fillText(rpm === 45 ? '45 rpm' : rpm === 78 ? '78 rpm' : '33⅓ rpm', 0, 200);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
  // stamper ring, pressing edge and spindle hole
  g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.13)'; g.beginPath(); g.arc(S / 2, S / 2, S * .36, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 2; g.strokeStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.arc(S / 2, S / 2, S * .363, 0, Math.PI * 2); g.stroke();
  const edge = g.createRadialGradient(S / 2, S / 2, S * .42, S / 2, S / 2, S / 2);
  edge.addColorStop(0, 'rgba(0,0,0,0)'); edge.addColorStop(1, 'rgba(0,0,0,.32)');
  g.fillStyle = edge; g.fillRect(0, 0, S, S);
  g.restore();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return { texture: t, color, img };
}

// ---------- record color maps for patterned pressings ----------
function pressingMap(v, img) {
  const S = 1024, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
  if (v.kind === 'picture' && img) {
    drawCover(g, img, 0, 0, S);
  } else if (v.kind === 'marble') {
    const [a, b, c] = v.colors;
    g.fillStyle = a; g.fillRect(0, 0, S, S);
    let s = 3;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    g.filter = 'blur(6px)';
    for (let i = 0; i < 140; i++) {
      g.strokeStyle = [b, c, a][i % 3]; g.globalAlpha = .35 + rnd() * .5; g.lineWidth = 6 + rnd() * 40;
      g.beginPath(); let x = rnd() * S, y = rnd() * S; g.moveTo(x, y);
      for (let k = 0; k < 6; k++) { x += (rnd() - .5) * 360; y += (rnd() - .5) * 360; g.quadraticCurveTo(x + (rnd() - .5) * 200, y + (rnd() - .5) * 200, x, y); }
      g.stroke();
    }
    g.filter = 'none'; g.globalAlpha = 1;
  } else if (v.kind === 'splatter') {
    g.fillStyle = v.color; g.fillRect(0, 0, S, S);
    let s = 11;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 260; i++) {
      g.fillStyle = v.colors[i % v.colors.length]; g.globalAlpha = .85;
      const x = rnd() * S, y = rnd() * S, r = Math.pow(rnd(), 3) * 26 + 2;
      g.beginPath(); g.ellipse(x, y, r, r * (.6 + rnd() * .6), rnd() * 3, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
  } else {
    return null;
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------- the deck ----------
export class Turntable {
  constructor(canvas, { onStartStop, onSpeed, onSeek } = {}) {
    this.canvas = canvas;
    this.onStartStop = onStartStop;
    this.onSpeed = onSpeed;
    this.onSeek = onSeek;
    // inputs set by the app
    this.wantSpin = false;
    this.loaded = false;
    this.progress = 0;
    this.rpm = 33.333;
    this.speedSetting = '33';
    this.pitch = 0;
    this.lamp = true;
    this.volume = .8;                     // 0..1, shown by the knob; the app owns the real level
    this.zoom = this.zoomTarget = 1;      // focus-mode wheel zoom
    this.showcase = this.showcaseTarget = 0; // three-quarter turn while the look sheets are open
    // simulated state
    this.platterAngle = 0;
    this.platterVel = 0;
    this.armAngle = REST;
    this.lift = 0;
    this.pausedFor = 0;
    this.travelling = false;
    this.lidOpen = 1;                // 1 = lid away, 0 = closed over the deck
    this.lidClosed = false;
    this.recordLift = 0;             // record swap animation 0..1
    this.swapping = false;
    this.dragArm = null;
    this.pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    this.region = null; this.regionTarget = null;
    this.drift = { x: 0, y: 0 };

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.renderer.shadowMap.autoUpdate = true;     // gated per light in loop(): each map is redrawn only when needed
    this.maxAniso = this.renderer.capabilities.getMaxAnisotropy();

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(reflectionRoom(), .02).texture;
    this.scene.environmentIntensity = 1;
    this.pmrem = pmrem;
    this.roomEnvs = new Map();
    new RGBELoader().load(HDRI, (hdr) => {
      hdr.mapping = THREE.EquirectangularReflectionMapping;
      this.studioEnv = pmrem.fromEquirectangular(hdr).texture;
      hdr.dispose();
      this.hdriReady = true;
      if (!this.roomEnv) this.useEnvironment(this.studioEnv, -1.1);   // brightest window upper left, like the key
    });

    this.camera = new THREE.PerspectiveCamera(24, 1, 30, 900);
    // post: multisampled HDR target, ground-truth ambient occlusion, then tone mapping and sRGB output
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.ao = new GTAOPass(this.scene, this.camera, 1, 1);
    this.ao.updateGtaoMaterial({ radius: 2.2, distanceExponent: 1.4, thickness: 1.2, scale: 1.15, samples: 16 });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 16 });
    this.ao.blendIntensity = .9;
    // ambient occlusion is a soft, low-frequency term: its normal pass, sampling and denoise run at half
    // resolution and are upsampled in the blend. A quarter of the pixels, the same look.
    const aoSize = this.ao.setSize.bind(this.ao);
    this.ao.setSize = (w, h) => aoSize(Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
    const hide = this.ao.overrideVisibility.bind(this.ao);
    // see-through helpers (shadow quads, the lamp beam) must not enter the AO depth/normal pass, or it
    // treats them as solid surfaces and greys out their whole rectangle
    this.ao.overrideVisibility = () => { hide(); for (const o of this.noAO) o.visible = false; };
    this.composer.addPass(this.ao);
    this.composer.addPass(new OutputPass());
    this.useComposer = true;
    this.texLoader = new THREE.TextureLoader();
    this.textures = new Map();

    this.buildLights();
    this.buildDeck();
    this.bindPointer();
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);

    this.last = performance.now();
    this.setRecord({});
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // Scanned wood set (colour, normal, roughness); swapped in once all three maps are decoded.
  loadPbr(b, id) {
    const urls = pbrUrls(b.pbr);
    const load = (url, srgb) => new Promise((res) => {
      if (this.textures.has(url)) return res(this.textures.get(url));
      this.texLoader.load(url, (t) => {
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.anisotropy = this.maxAniso;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.repeat.set(b.repeat || .5, b.repeat || .5);
        this.textures.set(url, t); res(t);
      }, undefined, () => res(null));
    });
    Promise.all([load(urls.map, true), load(urls.normal, false), load(urls.rough, false)]).then(([map, normal, rough]) => {
      if (this.materialId !== id || !map) return;
      const mat = this.bodyMat;
      mat.map = map; mat.normalMap = normal; mat.roughnessMap = rough;
      mat.normalScale.set(b.normal ?? 1, b.normal ?? 1);
      mat.roughness = b.roughness ?? 1;
      mat.color.set(b.pbrTint || '#ffffff');
      mat.bumpMap = null;
      mat.needsUpdate = true;
      this.pbrReady = id;
    });
  }

  tex(name, { srgb = true } = {}) {
    const key = `${name}|${srgb}`;
    if (!this.textures.has(key)) {
      const t = this.texLoader.load(asset(name));
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = this.maxAniso;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      this.textures.set(key, t);
    }
    return this.textures.get(key);
  }

  buildLights() {
    // a large overhead softbox gives the long, soft gradient reflections of studio product photography
    RectAreaLightUniformsLib.init();
    const box = new THREE.RectAreaLight('#fff4e6', 4.2, 70, 46);
    box.position.set(-18, 95, 22);
    box.lookAt(0, 0, 0);
    this.scene.add(box);
    this.softbox = box;
    const key = new THREE.DirectionalLight('#fff1df', 1.9);
    key.position.set(-48, 62, 30);
    key.target.position.set(0, 0, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -42, right: 42, top: 42, bottom: -42, near: 20, far: 220 });
    key.shadow.bias = -.0006;
    key.shadow.radius = 7;
    key.shadow.blurSamples = 16;
    key.shadow.normalBias = .03;
    this.scene.add(key, key.target);
    this.key = key;
    const rim = new THREE.DirectionalLight('#dfe8ff', .55);
    rim.position.set(40, 45, -50);
    this.scene.add(rim);

    // the stylus lamp: a small warm spot on a pop-up post, aimed at the needle
    this.lampLight = new THREE.SpotLight('#ffd2a1', 0, 70, .3, .8, 1.25);
    this.scene.add(this.lampLight, this.lampLight.target);
    this.rim = rim;
    this.rig = cloneRig(STUDIO_RIG);
    this.rigTarget = cloneRig(STUDIO_RIG);
  }

  useEnvironment(env, rotation = 0) {
    this.scene.environment = env;
    this.scene.environmentRotation.set(0, rotation, 0);
  }

  // Light the deck like the room behind it. room: { id, img (url or null), light: { flicker } }
  setRoom(room) {
    this.roomId = room.id;
    const flicker = room.light?.flicker || 0;
    if (!room.img) {
      this.roomEnv = null;
      if (this.studioEnv) this.useEnvironment(this.studioEnv, -1.1);
      Object.assign(this.rigTarget, cloneRig(STUDIO_RIG), { flicker });
      return;
    }
    const apply = ({ env, a }) => {
      if (this.roomId !== room.id) return;
      this.roomEnv = env;
      this.useEnvironment(env, 0);
      const white = new THREE.Color(1, 1, 1), B = Math.sqrt(a.brightness);
      Object.assign(this.rigTarget, {
        key: white.clone().lerp(a.light, .34),
        keyI: Math.max(1.25, Math.min(2.5, 1 + 2.6 * B)),
        keyPos: new THREE.Vector3(-58 + 116 * a.side, 52 + 18 * (1 - a.height), 26),
        rim: white.clone().lerp(a.light, .6),
        rimI: Math.max(.35, Math.min(1.3, .25 + a.peak * .9)),
        rimPos: new THREE.Vector3(-45 + 90 * a.side, 42, -55),
        box: white.clone().lerp(a.ambient, .38),
        boxI: Math.max(1.6, Math.min(5.2, 1.4 + 9 * a.brightness)),
        env: Math.max(.6, Math.min(.95, .5 + .7 * B)),
        flicker,
      });
    };
    const cached = this.roomEnvs.get(room.id);
    if (cached) { apply(cached); return; }
    const img = new Image();
    img.onload = () => {
      const v = { env: roomEnvironment(img, this.pmrem), a: analyseRoom(img) };
      this.roomEnvs.set(room.id, v);
      apply(v);
    };
    img.src = room.img;
  }

  // ease the light rig toward the room's; the key light also casts the deck's shadows
  stepRig(dt, calm) {
    const r = this.rig, t = this.rigTarget, k = calm ? 1 : 1 - Math.exp(-2.6 * dt);
    let moved = 0;
    for (const c of ['key', 'rim', 'box']) r[c].lerp(t[c], k);
    for (const v of ['keyPos', 'rimPos']) { moved += r[v].distanceTo(t[v]); r[v].lerp(t[v], k); }
    for (const n of ['keyI', 'rimI', 'boxI', 'env', 'flicker']) r[n] += (t[n] - r[n]) * k;
    if (moved > .05) this.shadowEpoch = (this.shadowEpoch || 0) + 1;
    // fire never burns steady: three slow, incommensurate waves, a few percent deep
    const ts = performance.now() / 1000;
    const fl = 1 + r.flicker * (.05 * Math.sin(ts * 7.3) + .035 * Math.sin(ts * 12.9 + 1.7) + .03 * Math.sin(ts * 2.3 + .4));
    this.key.color.copy(r.key); this.key.intensity = r.keyI * fl; this.key.position.copy(r.keyPos);
    this.rim.color.copy(r.rim); this.rim.intensity = r.rimI; this.rim.position.copy(r.rimPos);
    this.softbox.color.copy(r.box); this.softbox.intensity = r.boxI * (1 + (fl - 1) * .5);
    this.scene.environmentIntensity = r.env;
  }

  buildDeck() {
    const deck = new THREE.Group();
    this.scene.add(deck);
    this.deck = deck;
    const metal = this.metalMat = new THREE.MeshPhysicalMaterial({ metalness: 1, roughness: .22, color: '#e9e9ec' });
    this.metalMats = [metal];
    const chrome = new THREE.MeshPhysicalMaterial({ metalness: 1, roughness: .07, color: '#f2f2f4' });
    chrome.userData.rough = .07;
    this.metalMats.push(chrome);
    const darkSatin = new THREE.MeshPhysicalMaterial({ color: '#111112', roughness: .55, metalness: .2, clearcoat: .3, clearcoatRoughness: .4 });
    const rubber = new THREE.MeshPhysicalMaterial({ color: '#0e0e0f', roughness: .92 });
    const add = (mesh, parent = deck) => { mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh; };

    // the deck sits over a photograph, not a modelled floor: a hard cast shadow on an invisible plane
    // reads as a dark polygon there. Instead a soft penumbra, pushed away from the key light, plus a
    // tight contact shadow. Both fade out in every direction and cost two textured quads.
    this.noAO = this.noAO || [];
    const castMap = contactShadow(44, 16), contactMap = contactShadow();
    const cast = new THREE.Mesh(new THREE.PlaneGeometry(...castMap.userData.size), new THREE.MeshBasicMaterial({ map: castMap, transparent: true, opacity: .42, depthWrite: false }));
    cast.rotation.x = -Math.PI / 2; cast.position.set(3.4, .01, -1.2); this.scene.add(cast);
    const contact = new THREE.Mesh(new THREE.PlaneGeometry(...contactMap.userData.size), new THREE.MeshBasicMaterial({ map: contactMap, transparent: true, opacity: .68, depthWrite: false }));
    contact.rotation.x = -Math.PI / 2; contact.position.y = .02; this.scene.add(contact);
    this.noAO.push(cast, contact);

    // plinth on a recessed dark base, with isolation feet
    this.bodyMat = new THREE.MeshPhysicalMaterial({ color: '#ffffff' });
    this.plinth = add(new THREE.Mesh(new RoundedBoxGeometry(PL.w, PL.h, PL.d, 5, .9), this.bodyMat));
    this.plinth.position.y = PL.y0 + PL.h / 2;
    const base = add(new THREE.Mesh(new RoundedBoxGeometry(PL.w - 1.6, .9, PL.d - 1.6, 3, .3), darkSatin));
    base.position.y = PL.y0 - .2;
    for (const [x, z] of [[-18.5, 13], [18.5, 13], [-18.5, -13], [18.5, -13]]) {
      const foot = add(new THREE.Mesh(new THREE.CylinderGeometry(2.1, 2.3, .95, 64), rubber));
      foot.position.set(x, .48, z);
      const ring = add(new THREE.Mesh(new THREE.CylinderGeometry(2.15, 2.15, .18, 64), metal));
      ring.position.set(x, .98, z);
    }

    // platter: machined rim with strobe dots, chamfered top under the mat
    const pGroup = new THREE.Group();
    pGroup.position.set(C.x, PLATTER.y, C.z);
    deck.add(pGroup);
    this.platterGroup = pGroup;
    const strobe = strobeMap();
    this.rimMat = new THREE.MeshPhysicalMaterial({ metalness: 1, roughness: .26, color: '#e9e9ec', map: strobe, bumpMap: strobe, bumpScale: -1.2 });
    this.rimTopMat = new THREE.MeshPhysicalMaterial({ metalness: 1, roughness: .18, color: '#e9e9ec', anisotropy: .8, anisotropyMap: circularAniso(512) });
    this.metalMats.push(this.rimMat, this.rimTopMat);
    const rim = add(new THREE.Mesh(new THREE.CylinderGeometry(PLATTER.r, PLATTER.r - .25, PLATTER.h, 256, 1, true), this.rimMat), pGroup);
    rim.position.y = PLATTER.h / 2;
    const ptop = add(new THREE.Mesh(new THREE.RingGeometry(3, PLATTER.r, 256, 1), this.rimTopMat), pGroup);
    ptop.rotation.x = -Math.PI / 2; ptop.position.y = PLATTER.h;
    const well = add(new THREE.Mesh(new THREE.CylinderGeometry(PLATTER.r + .5, PLATTER.r + .5, .32, 128), darkSatin));
    well.position.set(C.x, TOP + .1, C.z);

    // mat
    this.matMat = new THREE.MeshPhysicalMaterial({ color: '#141414', roughness: .95 });
    const mat = add(new THREE.Mesh(new THREE.CylinderGeometry(15.15, 15.15, MAT_T, 192), this.matMat), pGroup);
    mat.position.y = PLATTER.h + MAT_T / 2;

    // record
    const maps = recordMaps(2048);
    for (const t of Object.values(maps)) t.anisotropy = this.maxAniso;
    this.recMat = new THREE.MeshPhysicalMaterial({
      color: '#0b0b0c', roughness: 1, roughnessMap: maps.roughness, normalMap: maps.normal,
      anisotropy: .9, anisotropyMap: maps.aniso, clearcoat: .2, clearcoatRoughness: .12, specularIntensity: .9,
    });
    this.recEdgeMat = new THREE.MeshPhysicalMaterial({ color: '#0b0b0c', roughness: .3, clearcoat: .2 });
    const rGroup = new THREE.Group();
    rGroup.position.set(C.x, REC_Y, C.z);
    deck.add(rGroup);
    this.recordGroup = rGroup;
    // the playing surface stops at the label edge, so label and vinyl never share a plane (no z-fighting)
    const rTop = add(new THREE.Mesh(new THREE.RingGeometry(REC.label - .02, REC.r, 384, 6), this.recMat), rGroup);
    rTop.rotation.x = -Math.PI / 2; rTop.position.y = REC.t;
    const rSide = add(new THREE.Mesh(new THREE.CylinderGeometry(REC.r, REC.r, REC.t, 384, 1, true), this.recEdgeMat), rGroup);
    rSide.position.y = REC.t / 2;
    this.labelMat = new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: .78, sheen: .25, sheenRoughness: .8, sheenColor: '#ffffff' });
    const label = add(new THREE.Mesh(new THREE.CircleGeometry(REC.label, 192), this.labelMat), rGroup);
    label.rotation.x = -Math.PI / 2; label.position.y = REC.t - .01;

    // spindle
    const spindle = add(new THREE.Mesh(new THREE.CylinderGeometry(REC.hole - .05, REC.hole - .05, 1.5, 48), chrome));
    spindle.position.set(C.x, REC_Y + .6, C.z);
    const cap = add(new THREE.Mesh(new THREE.SphereGeometry(REC.hole - .05, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), chrome));
    cap.position.set(C.x, REC_Y + 1.35, C.z);

    this.buildArm(add, chrome, darkSatin);
    this.buildControls(add, darkSatin);
    this.buildLid();
  }

  buildArm(add, chrome, darkSatin) {
    const metal = this.metalMat;
    const knurled = new THREE.MeshPhysicalMaterial({ metalness: 1, roughness: .3, color: '#e9e9ec', normalMap: knurlNormal(), normalScale: new THREE.Vector2(.8, .8) });
    knurled.userData.rough = .3;
    const br = brushedMaps();
    const brushed = new THREE.MeshPhysicalMaterial({ metalness: 1, roughness: 1, roughnessMap: br.rough, normalMap: br.normal, normalScale: new THREE.Vector2(.3, .3), anisotropy: .75, color: '#e9e9ec' });
    brushed.userData.brushed = true;
    this.metalMats.push(knurled, brushed);
    this.knurledMat = knurled; this.brushedMat = brushed;
    const rubber = new THREE.MeshPhysicalMaterial({ color: '#131313', roughness: .82 });
    this.rubberMat = rubber;
    const Y = new THREE.Vector3(0, 1, 0);

    // ---- fixed base: plate with a chrome trim ring, knurled height collar, chrome pillar
    const plate = add(new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.75, .45, 128), darkSatin));
    plate.position.set(PIV.x, TOP + .22, PIV.z);
    const trim = add(new THREE.Mesh(new THREE.TorusGeometry(3.08, .035, 8, 160), chrome));
    trim.rotation.x = Math.PI / 2; trim.position.set(PIV.x, TOP + .46, PIV.z);
    const collar = add(new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.3, .9, 128, 1, true), knurled));
    collar.position.set(PIV.x, TOP + .9, PIV.z);
    const collarTop = add(new THREE.Mesh(new THREE.CylinderGeometry(1.95, 2.3, .22, 128), metal));
    collarTop.position.set(PIV.x, TOP + 1.46, PIV.z);
    const pillarH = ARM_Y - TOP - 1.4;
    const pillar = add(new THREE.Mesh(new THREE.CylinderGeometry(.95, .95, pillarH, 64), chrome));
    pillar.position.set(PIV.x, TOP + 1.4 + pillarH / 2 - .3, PIV.z);
    // anti-skate dial
    const skate = add(new THREE.Mesh(new THREE.CylinderGeometry(.75, .75, .7, 64, 1, true), knurled));
    skate.position.set(PIV.x - 2.75, TOP + 1.55, PIV.z - 1.6);
    const skateTop = add(new THREE.Mesh(new THREE.CircleGeometry(.75, 64), brushed));
    skateTop.rotation.x = -Math.PI / 2; skateTop.position.set(PIV.x - 2.75, TOP + 1.905, PIV.z - 1.6);
    // cue lever on the base
    const cueGroup = new THREE.Group();
    cueGroup.position.set(PIV.x + 2.9, TOP + .9, PIV.z + 1.2);
    this.deck.add(cueGroup);
    add(new THREE.Mesh(new THREE.CylinderGeometry(.35, .35, 1.4, 32), metal), cueGroup).position.y = .4;
    const lever = add(new THREE.Mesh(new RoundedBoxGeometry(2.6, .3, .3, 3, .12), chrome), cueGroup);
    lever.position.set(1.1, 1.05, 0);
    const leverKnob = add(new THREE.Mesh(new THREE.SphereGeometry(.34, 32, 16), darkSatin), cueGroup);
    leverKnob.position.set(2.45, 1.05, 0);
    this.cueGroup = cueGroup;
    // cue platform: a rubber-topped bar under the tube that rises to lift the arm
    const cueA = 26 * Math.PI / 180, cueR = 4.4;
    const cp = { x: PIV.x - cueR * Math.sin(cueA), z: PIV.z + cueR * Math.cos(cueA) };
    const cpost = add(new THREE.Mesh(new THREE.CylinderGeometry(.26, .3, ARM_Y - TOP - .9, 32), chrome));
    cpost.position.set(cp.x, TOP + (ARM_Y - TOP - .9) / 2, cp.z);
    const cueBar = add(new THREE.Mesh(new RoundedBoxGeometry(3.4, .2, .46, 3, .09), rubber));
    cueBar.position.set(cp.x, ARM_Y - .82, cp.z);
    cueBar.rotation.y = -cueA;
    this.cueBar = cueBar; this.cueR = cueR;

    // ---- moving arm: yaw around the pillar, pitch for the lift; local +x runs from pivot to stylus
    const yaw = new THREE.Group();
    yaw.position.set(PIV.x, ARM_Y, PIV.z);
    this.deck.add(yaw);
    const pitch = new THREE.Group();
    yaw.add(pitch);
    this.armYaw = yaw; this.armPitch = pitch;
    const arm = (m, parent = pitch) => add(m, parent);

    // gimbal housing with bearing caps
    arm(new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.55, 1.5, 96), brushed)).position.y = -.1;
    arm(new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.55, .35, 96), chrome)).position.y = .82;
    arm(new THREE.Mesh(new THREE.CylinderGeometry(.42, .42, .12, 48), darkSatin)).position.y = 1.02;
    for (const z of [-1.62, 1.62]) {
      const yoke = arm(new THREE.Mesh(new THREE.CylinderGeometry(.42, .42, .6, 48), chrome));
      yoke.rotation.x = Math.PI / 2; yoke.position.set(0, 0, z);
      const cap = arm(new THREE.Mesh(new THREE.CylinderGeometry(.22, .22, .08, 24), darkSatin));
      cap.rotation.x = Math.PI / 2; cap.position.set(0, 0, z * 1.2);
    }
    // rear stub, counterweight with a printed scale ring, end faces
    const stub = arm(new THREE.Mesh(new THREE.CylinderGeometry(.34, .34, 5.6, 48), chrome));
    stub.rotation.z = Math.PI / 2; stub.position.set(-3.5, 0, 0);
    const weight = arm(new THREE.Mesh(new THREE.CylinderGeometry(1.45, 1.45, 2.4, 128, 1, true), knurled));
    weight.rotation.z = Math.PI / 2; weight.position.set(-5.7, 0, 0);
    const scale = arm(new THREE.Mesh(new THREE.CylinderGeometry(1.47, 1.47, .55, 128, 1, true),
      new THREE.MeshPhysicalMaterial({ map: scaleRingTexture(), roughness: .45, clearcoat: .6, clearcoatRoughness: .2 })));
    scale.rotation.z = Math.PI / 2; scale.position.set(-4.22, 0, 0);
    for (const [x, r0, r1, dir] of [[-3.95, .4, 1.47, 1], [-6.9, .5, 1.45, -1]]) {
      const face = arm(new THREE.Mesh(new THREE.RingGeometry(r0, r1, 96), metal));
      face.rotation.y = Math.PI / 2 * dir; face.position.set(x, 0, 0);
    }

    // headshell: placed so the stylus tip is exactly ARM_L ahead of the pivot, offset angle 22°
    const OFF = 22 * Math.PI / 180;
    const head = new THREE.Group();
    head.position.set(ARM_L, REC_TOP - ARM_Y, 0);
    head.rotation.y = OFF;
    pitch.add(head);
    // shell plate: tapered outline with two mounting slots, bevelled, brushed
    const shape = new THREE.Shape();
    shape.moveTo(.2, -.72); shape.quadraticCurveTo(.46, 0, .2, .72);
    shape.lineTo(-4.15, .6); shape.quadraticCurveTo(-4.45, .58, -4.45, .36);
    shape.lineTo(-4.45, -.36); shape.quadraticCurveTo(-4.45, -.58, -4.15, -.6); shape.lineTo(.2, -.72);
    for (const y of [-.46, .46]) {
      const slot = new THREE.Path();
      slot.moveTo(-1.15, y - .1); slot.lineTo(-2.65, y - .1);
      slot.absarc(-2.65, y, .1, -Math.PI / 2, Math.PI / 2, true);
      slot.lineTo(-1.15, y + .1);
      slot.absarc(-1.15, y, .1, Math.PI / 2, -Math.PI / 2, true);
      shape.holes.push(slot);
    }
    const shellGeo = new THREE.ExtrudeGeometry(shape, { depth: .24, bevelEnabled: true, bevelThickness: .045, bevelSize: .045, bevelSegments: 3, curveSegments: 32 });
    const shell = arm(new THREE.Mesh(shellGeo, brushed), head);
    shell.rotation.x = -Math.PI / 2; shell.position.y = 1.1;
    // finger lift
    const liftCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-1.5, 1.3, .62), new THREE.Vector3(-.9, 1.42, 1.25), new THREE.Vector3(-.2, 1.85, 1.8), new THREE.Vector3(.35, 2.35, 1.95),
    ]);
    arm(new THREE.Mesh(new THREE.TubeGeometry(liftCurve, 48, .085, 16, false), brushed), head);
    arm(new THREE.Mesh(new THREE.SphereGeometry(.12, 24, 12), brushed), head).position.set(.35, 2.35, 1.95);
    // cartridge: glossy black body, gold mounting face, stylus holder, cantilever and diamond
    const cartMat = new THREE.MeshPhysicalMaterial({ color: '#0b0b0c', roughness: .32, clearcoat: .9, clearcoatRoughness: .08 });
    arm(new THREE.Mesh(new RoundedBoxGeometry(2.05, .8, 1.3, 4, .12), cartMat), head).position.set(-1.52, .66, 0);
    const accent = new THREE.MeshPhysicalMaterial({ color: '#c9a45c', metalness: 1, roughness: .25 });
    this.cartAccent = accent;
    arm(new THREE.Mesh(new RoundedBoxGeometry(.06, .56, 1.08, 2, .02), accent), head).position.set(-.48, .62, 0);
    arm(new THREE.Mesh(new RoundedBoxGeometry(.5, .32, .62, 3, .08), new THREE.MeshPhysicalMaterial({ color: '#3a3a3e', roughness: .5 })), head).position.set(-.3, .3, 0);
    const from = new THREE.Vector3(-.36, .2, 0), tip = new THREE.Vector3(0, .02, 0);
    const cant = arm(new THREE.Mesh(new THREE.CylinderGeometry(.018, .03, from.distanceTo(tip), 12), chrome), head);
    cant.position.copy(from).add(tip).multiplyScalar(.5);
    cant.quaternion.setFromUnitVectors(Y, tip.clone().sub(from).normalize());
    const diamond = arm(new THREE.Mesh(new THREE.ConeGeometry(.03, .07, 8), new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0, metalness: .2, clearcoat: 1 })), head);
    diamond.position.set(0, .035, 0); diamond.rotation.z = Math.PI;
    // mounting screws in the slots
    for (const z of [-.46, .46]) {
      const screw = arm(new THREE.Mesh(new THREE.CylinderGeometry(.17, .17, .1, 32), chrome), head);
      screw.position.set(-1.95, 1.43, -z);
      const cut = arm(new THREE.Mesh(new THREE.BoxGeometry(.26, .03, .04), darkSatin), head);
      cut.position.set(-1.95, 1.485, -z); cut.rotation.y = .6;
    }
    // tonearm leads: four coloured wires from the cartridge pins to the headshell connector
    ['#c62828', '#2e7d32', '#1f4fa0', '#e8e6e0'].forEach((c, i) => {
      const zp = (i % 2 ? .22 : -.22), yp = i < 2 ? .78 : .48;
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-2.56, yp, zp), new THREE.Vector3(-2.95, yp - .08, zp * 1.25),
        new THREE.Vector3(-3.6, .95, zp * .9), new THREE.Vector3(-4.2, 1.02, zp * .5),
      ]);
      arm(new THREE.Mesh(new THREE.TubeGeometry(curve, 24, .04, 8, false), new THREE.MeshPhysicalMaterial({ color: c, roughness: .35, clearcoat: .5 })), head);
      const pin = arm(new THREE.Mesh(new THREE.CylinderGeometry(.05, .05, .14, 12), new THREE.MeshPhysicalMaterial({ color: '#d4b26a', metalness: 1, roughness: .3 })), head);
      pin.rotation.z = Math.PI / 2; pin.position.set(-2.55, yp, zp);
    });
    // connector collar between headshell and tube, then the S-shaped tube
    const back = new THREE.Vector3(-4.5, 1.22, 0).applyAxisAngle(Y, OFF).add(head.position);
    const collar2 = arm(new THREE.Mesh(new THREE.CylinderGeometry(.48, .48, .9, 48, 1, true), knurled));
    collar2.position.copy(back); collar2.rotation.set(0, OFF, Math.PI / 2);
    const tubeEnd = back.clone().add(new THREE.Vector3(-.45, 0, 0).applyAxisAngle(Y, OFF));
    const ringA = arm(new THREE.Mesh(new THREE.TorusGeometry(.48, .05, 8, 48), chrome));
    ringA.position.copy(tubeEnd); ringA.rotation.set(0, OFF + Math.PI / 2, 0);
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(1.4, 0, 0), new THREE.Vector3(7, 0, 0), new THREE.Vector3(12, 0, -.15),
      new THREE.Vector3(15.5, 0, .7), new THREE.Vector3(tubeEnd.x - 1.4, tubeEnd.y * .7, tubeEnd.z - .3), tubeEnd,
    ], false, 'catmullrom', .5);
    arm(new THREE.Mesh(new THREE.TubeGeometry(path, 240, .38, 40, false), chrome));

    // ---- arm rest: post, rubber cradle and spring clip, placed where the S-tube really passes when
    // parked (the tube is curved, so that is not on the straight pivot-to-stylus line)
    let tp = path.getPoint(0);
    for (let k = 0; k <= 400; k++) { const q = path.getPoint(k / 400); if (Math.abs(q.x - 14.6) < Math.abs(tp.x - 14.6)) tp = q; }
    const parkPitch = .6 * Math.PI / 180;                          // pitch off the record (see step)
    const tubeY = ARM_Y + tp.x * Math.sin(parkPitch) + tp.y * Math.cos(parkPitch);
    const restAt = { x: PIV.x - tp.z, z: PIV.z + tp.x };            // local → world at REST (yaw −90°)
    // a rubber saddle with a round notch the tube drops into; the arm lifts ~0.9 cm on the cue before it
    // swings, which clears the saddle's cheeks (they rise 0.5 cm above the tube's underside)
    const base = tubeY - .93;                                     // the bevelled notch bottom meets the tube
    add(new THREE.Mesh(new THREE.CylinderGeometry(.36, .46, base - TOP, 32), metal)).position.set(restAt.x, TOP + (base - TOP) / 2, restAt.z);
    add(new THREE.Mesh(new THREE.CylinderGeometry(.5, .4, .12, 32), metal)).position.set(restAt.x, base - .02, restAt.z);
    const saddleShape = new THREE.Shape();
    saddleShape.moveTo(-.72, 0); saddleShape.lineTo(.72, 0); saddleShape.lineTo(.72, .88); saddleShape.lineTo(.45, .88);
    saddleShape.absarc(0, .9, .45, -.04, -Math.PI + .04, true);
    saddleShape.lineTo(-.72, .88); saddleShape.lineTo(-.72, 0);
    const saddleGeo = new THREE.ExtrudeGeometry(saddleShape, { depth: .7, bevelEnabled: true, bevelThickness: .06, bevelSize: .06, bevelSegments: 3, curveSegments: 24 });
    saddleGeo.translate(0, 0, -.35);
    const saddle = add(new THREE.Mesh(saddleGeo, rubber));
    saddle.position.set(restAt.x, base + .04, restAt.z);

    // pickable proxy for dragging the arm
    const grab = new THREE.Mesh(new THREE.BoxGeometry(ARM_L + 2, 3, 3), new THREE.MeshBasicMaterial({ visible: false }));
    grab.position.set(ARM_L / 2, 0, 0); grab.userData.act = 'arm';
    pitch.add(grab);
    this.armGrab = grab;
  }

  // printed label lying on a surface; colour comes from the material so it can follow the finish
  decal(text, w, h, opts, parent, pos, silk) {
    const mat = new THREE.MeshStandardMaterial({ map: textTexture(text, opts), transparent: true, roughness: .55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    m.rotation.x = -Math.PI / 2; m.position.set(...pos); m.renderOrder = 2;
    parent.add(m);
    (silk ? this.silkMats : this.engraveMats).push(mat);
    return m;
  }

  ledDome(x, z, y = TOP) {
    const bezel = new THREE.Mesh(new THREE.CylinderGeometry(.27, .3, .08, 32), this.darkSatin);
    bezel.position.set(x, y + .04, z); bezel.receiveShadow = true; this.deck.add(bezel);
    const mat = new THREE.MeshPhysicalMaterial({ color: '#2a140c', roughness: .12, clearcoat: 1, clearcoatRoughness: .05, emissive: '#000000' });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(.2, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat);
    dome.scale.y = .6; dome.position.set(x, y + .08, z); this.deck.add(dome);
    return mat;
  }

  buildControls(add, darkSatin) {
    const brushed = this.brushedMat;
    this.darkSatin = darkSatin;
    this.silkMats = []; this.engraveMats = [];
    this.pickables = [this.armGrab];
    const button = (w, d, x, z, act, label) => {
      const g = new THREE.Group();
      g.position.set(x, TOP, z);
      this.deck.add(g);
      const well = add(new THREE.Mesh(new RoundedBoxGeometry(w + .45, .22, d + .45, 3, .1), darkSatin), g);
      well.position.y = .05;
      const cap = add(new THREE.Mesh(new RoundedBoxGeometry(w, .5, d, 5, .15), brushed), g);
      cap.position.y = .4; cap.userData.act = act; cap.userData.rest = .4;
      const long = label.length > 3, lw = long ? w * .82 : w * .62;
      this.decal(label, lw, long ? lw / 4 : lw / 2, { px: long ? 54 : 120, weight: 600, spacing: long ? .22 : .08, h: long ? 128 : 256 }, cap, [0, .252, 0], false);
      this.pickables.push(cap);
      g.userData.cap = cap;
      return g;
    };
    this.startBtn = button(5.2, 2.6, -18.6, 14.9, 'start', 'START · STOP');
    this.speed33 = button(2.3, 1.3, 14.9, 15.6, '33', '33');
    this.speed45 = button(2.3, 1.3, 17.7, 15.6, '45', '45');
    this.speed78 = button(2.3, 1.3, 20.5, 15.6, '78', '78');
    this.leds = {};
    for (const [k, g] of [['33', this.speed33], ['45', this.speed45], ['78', this.speed78]]) this.leds[k] = this.ledDome(g.position.x, g.position.z - 1.4);
    this.decal('SPEED', 3.2, .8, { px: 56, weight: 600, spacing: .3 }, this.deck, [17.7, TOP + .005, 13.55], true);

    // volume knob: knurled skirt, brushed circular top, white index; its sweep runs from 7 to 5 o'clock
    const kg = new THREE.Group();
    kg.position.set(19.9, TOP, 10.4);
    this.deck.add(kg);
    add(new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.6, .14, 96), darkSatin), kg).position.y = .07;
    const kside = add(new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.4, 1.1, 128, 1, true), this.knurledMat), kg);
    kside.position.y = .65;
    const ktopMat = new THREE.MeshPhysicalMaterial({ metalness: 1, roughness: .2, color: '#e9e9ec', anisotropy: .9, anisotropyMap: circularAniso(256) });
    this.metalMats.push(ktopMat);
    const ktop = add(new THREE.Mesh(new THREE.CircleGeometry(1.35, 128), ktopMat), kg);
    ktop.rotation.x = -Math.PI / 2; ktop.position.y = 1.2;
    const index = add(new THREE.Mesh(new THREE.BoxGeometry(.1, .02, .65), new THREE.MeshStandardMaterial({ color: '#f1ede4', roughness: .5 })), kg);
    index.position.set(0, 1.21, -.8);
    this.knob = kg;
    for (const m of [kside, ktop]) { m.userData.act = 'volume'; this.pickables.push(m); }
    // printed scale around it: eleven ticks, the last one longer
    for (let i = 0; i <= 10; i++) {
      const th = KNOB_MIN - i / 10 * (KNOB_MIN - KNOB_MAX), r = 1.88;
      const tick = new THREE.Mesh(new THREE.PlaneGeometry(.07, i === 10 ? .42 : .26), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .6, transparent: true, polygonOffset: true, polygonOffsetFactor: -2 }));
      tick.rotation.set(-Math.PI / 2, 0, th);
      tick.position.set(19.9 - r * Math.sin(th), TOP + .006, 10.4 - r * Math.cos(th));
      this.deck.add(tick); this.silkMats.push(tick.material);
    }
    this.leds.power = this.ledDome(17.15, 10.4);
    this.decal('VOLUME', 2.8, .65, { px: 56, weight: 600, spacing: .3 }, this.deck, [19.9, TOP + .005, 12.75], true);

    // pitch fader: slot, printed scale, brushed cap with a centre line, zero LED
    const slot = add(new THREE.Mesh(new RoundedBoxGeometry(.7, .2, 10, 2, .1), new THREE.MeshStandardMaterial({ color: '#050505', roughness: .9 })));
    slot.position.set(19.9, TOP + .02, 1.6);
    for (let i = -4; i <= 4; i++) {
      const tick = new THREE.Mesh(new THREE.PlaneGeometry(i === 0 ? .9 : .5, .07), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: .6, transparent: true, polygonOffset: true, polygonOffsetFactor: -2 }));
      tick.rotation.x = -Math.PI / 2; tick.position.set(18.75 - (i === 0 ? .2 : 0), TOP + .006, 1.6 + i * 1.1);
      this.deck.add(tick); this.silkMats.push(tick.material);
    }
    this.decal('PITCH', 2.6, .65, { px: 56, weight: 600, spacing: .3 }, this.deck, [19.9, TOP + .005, -4.35], true);
    const fader = add(new THREE.Mesh(new RoundedBoxGeometry(1.9, .9, 1.25, 4, .2), brushed));
    fader.position.set(19.9, TOP + .55, 1.6);
    const groove = new THREE.Mesh(new THREE.BoxGeometry(1.7, .02, .07), darkSatin);
    groove.position.y = .455; fader.add(groove);
    fader.userData.act = 'pitch';
    this.pickables.push(fader);
    this.fader = fader;
    this.leds.zero = this.ledDome(21.25, 1.6);

    // stylus lamp: a pop-up post at the front left with a small hooded head. It rakes a warm,
    // V-shaped pool across the grooves toward the needle and throws the arm's shadow away from it.
    const LAMP = { x: -19.6, z: 9.6 };
    const collar = add(new THREE.Mesh(new THREE.CylinderGeometry(.62, .62, .5, 48, 1, true), this.knurledMat));
    collar.position.set(LAMP.x, TOP + .25, LAMP.z);
    const collarTop = add(new THREE.Mesh(new THREE.RingGeometry(.36, .62, 48).rotateX(-Math.PI / 2), this.metalMat));
    collarTop.position.set(LAMP.x, TOP + .5, LAMP.z);
    const post = new THREE.Group();
    post.position.set(LAMP.x, TOP, LAMP.z);
    this.deck.add(post);
    this.lampPost = post;
    add(new THREE.Mesh(new THREE.CylinderGeometry(.3, .34, 6.4, 32), this.metalMat), post).position.y = 3.2;
    const head = new THREE.Group();
    head.position.y = 6.5;
    post.add(head);
    this.lampHead = head;
    add(new THREE.Mesh(new THREE.SphereGeometry(.4, 32, 16), this.knurledMat), head);           // knuckle
    const shell = add(new THREE.Mesh(new THREE.CylinderGeometry(.5, .6, 1.9, 48, 1, true).rotateX(Math.PI / 2), this.metalMat), head);
    shell.position.z = .35;
    const cap = add(new THREE.Mesh(new THREE.SphereGeometry(.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(-Math.PI / 2), this.metalMat), head);
    cap.position.z = -.6;
    const bezel = add(new THREE.Mesh(new THREE.TorusGeometry(.58, .06, 12, 48), this.metalMat), head);
    bezel.position.z = 1.3;
    const bulbMat = new THREE.MeshPhysicalMaterial({ color: '#2a2420', roughness: .08, clearcoat: 1, emissive: '#ffd2a1', emissiveIntensity: 0 });
    const lens = new THREE.Mesh(new THREE.CircleGeometry(.54, 48), bulbMat);
    lens.position.z = 1.28;
    head.add(lens);
    this.bulbMat = bulbMat;
    this.lampLens = lens;
    for (const m of [collar, shell, lens, cap]) { m.userData.act = 'lamp'; this.pickables.push(m); }
    // the lamp sits at the light's origin: its own parts must not shadow the beam
    post.traverse((o) => { o.castShadow = false; });

    this.lampLight.castShadow = true;
    this.lampLight.shadow.mapSize.set(1024, 1024);
    Object.assign(this.lampLight.shadow.camera, { near: .5, far: 70 });
    this.lampLight.shadow.bias = -.0004;
    this.lampLight.shadow.normalBias = .02;
    this.lampLight.shadow.radius = 4;
    this.lampLight.shadow.blurSamples = 12;

    // the beam itself, faintly visible in the air: an open cone with view-dependent density
    const coneGeo = new THREE.ConeGeometry(1, 1, 64, 1, true).translate(0, -.5, 0).rotateX(-Math.PI / 2);
    this.beamMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color('#ffcf98') }, uStrength: { value: 0 } },
      vertexShader: `varying float vT; varying vec3 vN; varying vec3 vV;
        void main() { vT = position.z; vec4 mv = modelViewMatrix * vec4(position, 1.); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uColor; uniform float uStrength; varying float vT; varying vec3 vN; varying vec3 vV;
        void main() {
          float facing = abs(dot(normalize(vN), normalize(vV)));
          float a = uStrength * pow(facing, 1.8) * smoothstep(0., .18, vT) * (1. - smoothstep(.62, 1., vT)) * (1.15 - .6 * vT);
          gl_FragColor = vec4(uColor * a, a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.beam = new THREE.Mesh(coneGeo, this.beamMat);
    this.beam.renderOrder = 5;
    this.beam.visible = false;
    this.scene.add(this.beam);
    this.noAO.push(this.beam);
    // dust drifting through the light: only drawn inside the cone, so it costs nothing elsewhere
    const N = 70, pos = new Float32Array(N * 3), seed = new Float32Array(N * 4);
    for (let k = 0; k < N; k++) seed.set([Math.random() * Math.PI * 2, Math.sqrt(Math.random()) * .85, .15 + Math.random() * .8, Math.random()], k * 4);
    const dustGeo = new THREE.BufferGeometry();
    dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    dustGeo.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    this.dustMat = new THREE.ShaderMaterial({
      uniforms: { uStrength: { value: 0 }, uPx: { value: 1 }, uTime: { value: 0 } },
      vertexShader: `attribute vec4 seed; uniform float uPx; uniform float uTime; varying float vA;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.);
          float edge = 1. - seed.y / .85;
          vA = (.35 + .65 * edge) * smoothstep(.12, .3, position.z) * (1. - smoothstep(.75, .98, position.z)) * (.6 + .4 * sin(uTime * (.6 + seed.w) + seed.w * 40.));
          gl_PointSize = uPx * (1.4 + seed.w * 1.6);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform float uStrength; varying float vA;
        void main() { float d = length(gl_PointCoord - .5); float a = uStrength * vA * smoothstep(.5, .1, d); gl_FragColor = vec4(vec3(1., .86, .68) * a, a); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.dust = new THREE.Points(dustGeo, this.dustMat);
    this.dust.frustumCulled = false;
    this.beam.add(this.dust);
    // strobe lamp glows the rim dots when the platter runs
    this.strobeLight = new THREE.PointLight('#ff7a3a', 0, 3.2, 2);
    this.strobeLight.position.set(C.x - 11.6, PLATTER.y + .9, C.z + 11.6);
    this.scene.add(this.strobeLight);
  }

  // Dust cover: one rounded acrylic hood (5 mm wall), hinged at the back. Smoked acrylic reflects
  // the studio and gets denser toward grazing angles, so its edges and corners catch the light.
  buildLid() {
    const W = PL.w + .6, D = PL.d + .5, H = 9.5, t = .5;
    const open = (geo) => {               // drop the bottom faces: an open hood, not a closed box
      const pos = geo.attributes.position, nrm = geo.attributes.normal, idx = [];
      for (let i = 0; i < pos.count; i += 3) {
        if (nrm.getY(i) < -.95 && nrm.getY(i + 1) < -.95 && nrm.getY(i + 2) < -.95) continue;
        idx.push(i, i + 1, i + 2);
      }
      geo.setIndex(idx);
      return geo;
    };
    const acrylic = (side, opacity) => new THREE.MeshPhysicalMaterial({
      color: '#1d1c1b', roughness: .02, metalness: 0, transparent: true, opacity, side, depthWrite: false,
      clearcoat: 1, clearcoatRoughness: .01, specularIntensity: 1, ior: 1.49, envMapIntensity: 1.3,
    });
    const outerMat = acrylic(THREE.FrontSide, .2), innerMat = acrylic(THREE.BackSide, .14);
    const lid = new THREE.Group();
    lid.position.set(0, TOP + .02, -PL.d / 2 - .15);
    this.deck.add(lid);
    const o = new THREE.Mesh(open(new RoundedBoxGeometry(W, H, D, 6, 1.1)), outerMat);
    o.position.set(0, H / 2, D / 2); o.renderOrder = 6;
    const inner = new THREE.Mesh(open(new RoundedBoxGeometry(W - 2 * t, H - t, D - 2 * t, 6, .7)), innerMat);
    inner.position.set(0, (H - t) / 2, D / 2); inner.renderOrder = 5;
    lid.add(inner, o);
    // hinges: dark sockets on the plinth back and their leaves on the hood
    for (const x of [-14, 14]) {
      const socket = new THREE.Mesh(new RoundedBoxGeometry(3.2, .9, 1.4, 3, .2), this.darkSatin);
      socket.position.set(x, TOP + .3, -PL.d / 2 + .1); socket.castShadow = true; this.deck.add(socket);
      const leaf = new THREE.Mesh(new RoundedBoxGeometry(2.6, .25, 2.2, 3, .1), this.darkSatin);
      leaf.position.set(x, H - .1, 1.1); lid.add(leaf);
      this.lidLeaves = (this.lidLeaves || []).concat(leaf);
    }
    this.lid = lid;
    this.lidMats = [outerMat, innerMat];
    this.lidVel = 0;
  }

  // ---------- inputs from the app ----------
  setSpeed(rpm) {
    this.rpm = rpm === 45 ? 45 : rpm === 78 ? 78 : 33.333;
    this.speedSetting = rpm === 45 ? '45' : rpm === 78 ? '78' : '33';
  }

  setLid(closed) { this.lidClosed = closed; this.shadowEpoch = (this.shadowEpoch || 0) + 1; }

  setRegion(rect, instant = false) {
    if (!this.region || instant) { this.region = { ...rect }; this.regionAnim = null; return; }
    this.regionAnim = { from: { ...this.region }, to: { ...rect }, t: 0 };
  }

  applyMaterial(m, vinyl) {
    this.materialId = m.id;
    const b = m.body, mat = this.bodyMat;
    mat.map = b.tex ? this.tex(b.tex) : null;
    mat.bumpMap = b.tex && b.bump ? this.tex(b.tex, { srgb: false }) : null;
    mat.bumpScale = b.bump || 0;
    mat.normalMap = null; mat.roughnessMap = null;
    if (b.pbr) this.loadPbr(b, m.id);
    mat.color.set(b.tex ? (b.tint || '#ffffff') : b.color);
    mat.roughness = b.roughness ?? .5;
    mat.metalness = b.metalness || 0;
    mat.clearcoat = b.clearcoat || 0;
    mat.clearcoatRoughness = b.clearcoatRoughness ?? .2;
    mat.anisotropy = b.brushed ? .7 : 0;
    mat.needsUpdate = true;
    const metal = METALS[m.metal] || METALS.silver;
    for (const mm of this.metalMats) {
      mm.color.set(metal.color);
      mm.roughness = mm.userData.brushed ? .55 : mm.userData.rough ?? metal.roughness;
    }
    // engraved labels on the hardware and silkscreen on the body pick an ink that reads on them
    const darkMetal = m.metal === 'black' || m.metal === 'gunmetal';
    for (const em of this.engraveMats) { em.color.set(darkMetal ? '#e9e5dd' : '#2a2622'); em.opacity = darkMetal ? .8 : .7; }
    for (const sm of this.silkMats) { sm.color.set(b.light ? '#2a2622' : '#ece7dd'); sm.opacity = b.light ? .65 : .7; }
    this.cartAccent.color.set(m.metal === 'brass' ? '#d6b06a' : '#c9a45c');
    // clear-coated bodies carry fine swirl marks, visible only in the highlights
    mat.clearcoatRoughnessMap = mat.clearcoat > 0 ? (this.scratches || (this.scratches = scratchMap())) : null;
    this.matMat.map = m.mat === 'rubber' ? null : this.tex(m.mat);
    this.matMat.color.set(m.mat === 'rubber' ? '#121212' : m.mat === 'cork' ? '#c8a27a' : '#5a5a5c');
    this.matMat.roughness = m.mat === 'rubber' ? .88 : 1;
    this.matMat.sheen = m.mat === 'felt' ? 1 : 0;
    this.matMat.sheenRoughness = .9; this.matMat.sheenColor.set('#8a8a8a');
    this.matMat.needsUpdate = true;
    this.led = new THREE.Color(m.led);
    this.applyVinyl(vinyl);
  }

  applyVinyl(v) {
    this.shadowEpoch = (this.shadowEpoch || 0) + 1;
    this.vinyl = v;
    const m = this.recMat;
    m.map?.dispose?.();
    m.map = pressingMap(v, this.labelImg);
    if (v.kind === 'album') m.color.set(this.albumColor || '#8a5a3a');
    else if (v.kind === 'picture') m.color.set(m.map ? '#ffffff' : '#0b0b0c');
    else if (m.map) m.color.set('#ffffff');
    else m.color.set(v.color);
    const translucent = v.kind === 'translucent' || v.kind === 'album';
    m.transparent = translucent;
    m.opacity = translucent ? v.opacity : 1;
    m.anisotropy = v.kind === 'picture' ? .25 : .9;
    m.clearcoat = v.kind === 'picture' ? .8 : .2;
    m.needsUpdate = true;
    this.recEdgeMat.color.copy(m.color);
    this.recEdgeMat.transparent = translucent; this.recEdgeMat.opacity = m.opacity;
    this.recEdgeMat.needsUpdate = true;
  }

  // New album: arm parks, the record lifts off, the new one (label printed with the cover) drops on.
  setRecord({ key = '', title = '', artist = '', art = '', artFallback = '' }) {
    if (this.recordKey !== undefined && key === this.recordKey) return;
    this.recordKey = key;
    const token = (this.recordToken = (this.recordToken || 0) + 1);
    const first = this.labelSet === undefined;
    this.labelSet = true;
    const rpm = this.speedSetting === '45' ? 45 : this.speedSetting === '78' ? 78 : 33;
    printLabel({ art, artFallback, title, artist, rpm }).then(async (lbl) => {
      if (token !== this.recordToken) return;
      const apply = () => {
        this.labelMat.map?.dispose();
        lbl.texture.anisotropy = this.maxAniso;
        this.labelMat.map = lbl.texture;
        this.labelMat.needsUpdate = true;
        this.labelImg = lbl.img; this.albumColor = lbl.color;
        if (this.vinyl) this.applyVinyl(this.vinyl);
        this.onLabel?.(lbl.color);
      };
      if (first || reduceMotion.matches) { apply(); return; }
      this.swapping = true;
      await new Promise((res) => { const chk = () => (this.armAngle < REST + 1 && this.lift < .5) ? res() : setTimeout(chk, 60); chk(); });
      if (token !== this.recordToken) return;
      this.recordSwap = { t: 0, applied: false, apply };
    });
  }

  // ---------- pointer: buttons, arm drag, pitch drag, parallax ----------
  bindPointer() {
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const aim = (e) => {
      const r = this.canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
    };
    const pick = (e) => { aim(e); const hit = ray.intersectObjects(this.pickables, false)[0]; return hit ? hit.object : null; };
    const armPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -ARM_Y);
    const armAngleAt = (e) => {
      aim(e);
      const p = new THREE.Vector3();
      if (!ray.ray.intersectPlane(armPlane, p)) return null;
      const ang = Math.atan2(-(p.x - PIV.x), p.z - PIV.z) * 180 / Math.PI;   // same convention as stylusAt
      return Math.max(REST, Math.min(A_RUNOUT + 3, ang));
    };
    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      if (e.pointerType === 'mouse') { this.pointer.tx = (e.clientX - r.left) / r.width - .5; this.pointer.ty = (e.clientY - r.top) / r.height - .5; }
      if (this.dragArm) { const a = armAngleAt(e); if (a != null) this.dragArm.angle = a; return; }
      if (this.dragVol) {
        const d = this.dragVol, v = Math.max(0, Math.min(1, d.start + ((d.y - e.clientY) + (e.clientX - d.x)) / 170));
        if (v !== this.volume) { this.volume = v; this.onVolume?.(v); }
        return;
      }
      if (this.dragPitch) {
        const v = this.dragPitch.start + (e.clientY - this.dragPitch.y) / 14;
        this.pitch = Math.abs(v) < .4 ? 0 : Math.max(-8, Math.min(8, v));
        return;
      }
      this.canvas.style.cursor = pick(e) ? 'pointer' : '';
    });
    this.canvas.addEventListener('pointerdown', (e) => {
      const obj = pick(e);
      if (!obj) return;
      const act = obj.userData.act;
      if (act === 'arm') {
        this.canvas.setPointerCapture(e.pointerId);
        this.dragArm = { angle: this.armAngle };
        this.canvas.style.cursor = 'grabbing';
      } else if (act === 'pitch') {
        this.canvas.setPointerCapture(e.pointerId);
        this.dragPitch = { y: e.clientY, start: this.pitch };
      } else if (act === 'volume') {
        this.canvas.setPointerCapture(e.pointerId);
        this.dragVol = { x: e.clientX, y: e.clientY, start: this.volume };
      } else {
        this.pressAnim(act);
        if (act === 'start') this.onStartStop?.();
        else if (act === 'lamp') this.lamp = !this.lamp;
        else { this.setSpeed(+act); this.onSpeed?.(+act); }
      }
    });
    // the wheel over the knob turns it (and does not reach the focus-mode zoom)
    this.canvas.addEventListener('wheel', (e) => {
      if (pick(e)?.userData.act !== 'volume') return;
      e.preventDefault(); e.stopImmediatePropagation();
      const v = Math.max(0, Math.min(1, this.volume - Math.sign(e.deltaY) * .04));
      if (v !== this.volume) { this.volume = v; this.onVolume?.(v); }
    }, { passive: false });
    const end = () => {
      this.dragPitch = null;
      this.dragVol = null;
      if (!this.dragArm) return;
      const a = this.dragArm.angle;
      this.dragArm = null;
      this.canvas.style.cursor = '';
      if (a > A_LEADIN - 1.5 && this.loaded) {
        const r = radiusAt(Math.min(a, A_RUNOUT));
        const p = Math.max(0, Math.min(1, (R_LEADIN - r) / (R_LEADIN - R_RUNOUT)));
        this.progress = p;
        this.onSeek?.(p);
      }
    };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);
    this.canvas.addEventListener('pointerleave', () => { this.pointer.tx = 0; this.pointer.ty = 0; });
  }

  pressAnim(act) {
    const g = { start: this.startBtn, 33: this.speed33, 45: this.speed45, 78: this.speed78 }[act];
    if (g) this.pressing = { cap: g.userData.cap, t: 0 };
  }

  // ---------- layout and camera ----------
  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
    this.composer?.setSize(w, h);
    this.size = { w, h };
  }

  setZoom(z) { this.zoomTarget = Math.max(.85, Math.min(3.2, z)); }
  setShowcase(on) { this.showcaseTarget = on ? 1 : 0; }

  placeCamera() {
    const { w: W, h: H } = this.size || { w: 1, h: 1 };
    const reg = this.region || { x: 0, y: 0, w: W, h: H };
    const fov = this.camera.fov * Math.PI / 180;
    // framing radius of the deck in cm; narrow or portrait regions need room for the deck's width
    const R = 22.5 * Math.max(1, Math.min(1.55, 1.35 / Math.max(.1, reg.w / reg.h)));
    const dist = R * H / (Math.max(1, Math.min(reg.w, reg.h)) * Math.tan(fov / 2)) * (1 + .16 * (1 - easeOutCubic(this.intro ?? 1))) / this.zoom;
    // the camera sits slightly right of the deck, so the deck turns toward the panel on the left
    // opening shot: a slow dolly in from a little higher and wider
    const e = easeOutCubic(this.intro ?? 1), introK = 1 - e;
    // zooming in drifts the aim from the deck's centre to the record and needle, and lowers the eye
    const zk = smooth(Math.max(0, Math.min(1, (this.zoom - 1) / 1.6))), sc = this.showcase;
    const el = (52 + introK * 7 + this.pointer.y * -3 + this.drift.y - zk * 9 - sc * 5) * Math.PI / 180;
    const az = (11 + introK * 7 + this.pointer.x * 5 + this.drift.x + sc * 13) * Math.PI / 180;
    const st = stylusAt(this.armAngle);
    const target = (this.camTarget || (this.camTarget = new THREE.Vector3())).set(
      zk * ((C.x + st.x) / 2), 6 + zk * (REC_TOP - 6), 1.5 + zk * ((C.z + st.z) / 2 - 1.5));
    this.camera.position.set(
      target.x + dist * Math.sin(az) * Math.cos(el),
      target.y + dist * Math.sin(el),
      target.z + dist * Math.cos(az) * Math.cos(el),
    );
    this.camera.lookAt(target);
    this.camera.aspect = W / H;
    this.camera.near = Math.max(6, dist * .3);   // tight near plane keeps the label free of z-fighting
    this.camera.setViewOffset(W, H, W / 2 - (reg.x + reg.w / 2), H / 2 - (reg.y + reg.h / 2), W, H);
    this.camera.updateProjectionMatrix();
  }

  loop(now) {
    const dt = Math.min(.1, (now - this.last) / 1000);
    this.last = now;
    requestAnimationFrame(this.loop);
    // At most 60 frames a second, whatever the display refresh: a 144 Hz monitor would otherwise draw
    // the full scene 144 times a second for motion that 60 already shows smoothly. A still scene (record
    // stopped, nothing settling) only drifts very slowly, so it gets 30.
    this.held = (this.held || 0) + dt;
    this.budget = (this.budget || 0) + dt;
    const interval = this.busy ? 1 / 60 : 1 / 30;
    if (this.budget < interval * .9) return;
    this.budget = Math.max(0, Math.min(interval, this.budget - interval));   // keep the cadence, bank at most a frame
    const step = Math.min(.1, this.held);
    this.held = 0;
    this.step(step);
    // Shadows are redrawn per light. The key light's large map follows shadowsDirty() (casters that
    // actually moved). The stylus lamp sits low and close, so its long shadow of the arm magnifies the
    // arm's slow tracking and its once-per-turn sway: its small map is redrawn every frame the arm moves.
    const key = this.key.shadow, lamp = this.lampLight.shadow;
    key.autoUpdate = lamp.autoUpdate = false;
    if (this.shadowsDirty()) key.needsUpdate = lamp.needsUpdate = true;
    const arm = [this.armYaw.rotation.y, this.armPitch.rotation.z, this.lampLight.target.position.x, this.lampLight.target.position.z, this.lampLight.position.y];
    if (this.lampLevel > .003 && (!this.armSig || arm.some((v, i) => Math.abs(v - this.armSig[i]) > 1e-7))) lamp.needsUpdate = true;
    this.armSig = arm;
    this.render();
    if (!document.hidden && !this.noAdapt && this.busy) this.adapt(step);
  }

  // The deck's casters are the arm, lid, record (during a change), lamp post, knob, fader and buttons.
  // The platter and record spin about their own axis, so their shadows do not change while playing.
  shadowsDirty() {
    const cap = this.pressing ? this.pressing.cap.position.y : 0;
    const now = [this.armAngle, this.lift * 40, this.lidOpen * 60, this.recordGroup.position.y * 4, this.lampUp * 40, this.knob.rotation.y * 20, this.fader.position.z * 4, cap * 10, (this.lampAim?.x || 0) * 4, (this.lampAim?.z || 0) * 4, this.shadowEpoch || 0];
    const last = this.shadowSig;
    if (last && now.every((v, i) => Math.abs(v - last[i]) < .02)) return false;
    this.shadowSig = now;
    return true;
  }

  render() {
    this.placeCamera();
    if (this.useComposer) this.composer.render(); else this.renderer.render(this.scene, this.camera);
  }

  // Keep TVs smooth: if frames run slow for a few seconds, lower resolution, then drop the AO pass.
  adapt(dt) {
    this.frameAvg = this.frameAvg == null ? dt : this.frameAvg * .97 + dt * .03;
    this.adaptT = (this.adaptT || 0) + dt;
    if (this.adaptT < 4 || this.frameAvg < 1 / 34) return;
    this.adaptT = 0;
    const pr = this.renderer.getPixelRatio();
    if (pr > 1) { this.renderer.setPixelRatio(Math.max(1, pr - .5)); this.resize(); }
    else if (this.useComposer) this.useComposer = false;
  }

  // ---------- simulation ----------
  step(dt) {
    const calm = reduceMotion.matches;
    this.intro = calm ? 1 : Math.min(1, (this.intro || 0) + dt / 2.4);

    // platter: torque-limited start and an electronic brake, both without a jerk at either end
    const spinning = this.wantSpin && this.loaded && !this.swapping;
    const targetVel = spinning ? this.rpm * 6 * (1 + this.pitch / 100) : 0;
    const err = targetVel - this.platterVel;
    const wantAcc = Math.max(-170, Math.min(380, err * 7));
    this.platterAcc = approach(this.platterAcc || 0, wantAcc, 14, dt);
    this.platterVel += this.platterAcc * dt;
    if ((err > 0 && this.platterVel > targetVel) || (err < 0 && this.platterVel < targetVel)) { this.platterVel = targetVel; this.platterAcc = 0; }
    this.platterAngle = (this.platterAngle + this.platterVel * dt) % 360;
    const rot = -this.platterAngle * Math.PI / 180;                    // clockwise seen from above
    this.platterGroup.rotation.y = rot;
    this.recordGroup.rotation.y = rot;

    // tonearm. Small continuous changes are groove tracking with the stylus down. Anything larger
    // is a move: cue up, travel on a minimum-jerk curve, settle, then a slow hydraulic descent.
    this.pausedFor = spinning ? 0 : this.pausedFor + dt;
    let target = REST, wantDown = false;
    if (spinning && this.platterVel > targetVel * .8) {
      const p = Number.isFinite(this.progress) ? Math.max(0, Math.min(1, this.progress)) : 0;
      target = angleForRadius(R_LEADIN - (R_LEADIN - R_RUNOUT) * p);
      wantDown = true;
    } else if (this.loaded && !spinning && !this.swapping && this.pausedFor < 45 && this.armAngle > REST + 5) {
      target = this.armAngle;
    }
    if (this.swapping) { target = REST; wantDown = false; }
    if (this.dragArm) {
      this.armMove = null;
      this.lift = approach(this.lift, 1, 10, dt);
      this.armAngle = approach(this.armAngle, this.dragArm.angle, 12, dt);
    } else {
      let mv = this.armMove;
      if (mv && Math.abs(mv.to - target) > .3) {
        if (mv.phase === 'travel') mv = this.armMove = { phase: 'travel', from: this.armAngle, to: target, t: 0, T: travelTime(target - this.armAngle) };
        else mv.to = target;
      }
      // Only a real jump (a seek, a new song, parking) is a cue-lift move. Streaming sources report the
      // position every few seconds with small corrections; those are absorbed in the groove, stylus down.
      const gap = Math.abs(target - this.armAngle), down = this.lift < .05;
      if (!mv && gap > (down && wantDown ? 1.2 : .15)) mv = this.armMove = { phase: 'lift', to: target };
      if (mv) {
        if (mv.phase === 'lift') {
          this.lift = approach(this.lift, 1, 9, dt);
          if (this.lift > .985) Object.assign(mv, { phase: 'travel', from: this.armAngle, t: 0, T: travelTime(mv.to - this.armAngle) });
        } else if (mv.phase === 'travel') {
          mv.t += dt;
          const k = Math.min(1, mv.t / mv.T);
          this.armAngle = mv.from + (mv.to - mv.from) * quintic(k);
          if (k >= 1) Object.assign(mv, { phase: 'settle', t: 0 });
        } else {
          mv.t += dt;
          if (mv.t > .25) this.armMove = null;
        }
      } else {
        this.armAngle = approach(this.armAngle, target, down && wantDown && gap > .02 ? 1.6 : 8, dt);
        const up = wantDown ? 0 : (this.armAngle > REST + 5 ? 1 : 0);
        this.lift = up > this.lift ? approach(this.lift, up, 9, dt) : approach(this.lift, up, 2.4, dt);
      }
    }
    // a pressed record is never perfectly flat or centred: the arm sways gently once per turn
    const onRecord = radiusAt(this.armAngle) < REC.r + .4;
    const sway = onRecord && this.platterVel > 1 && !calm ? (1 - this.lift) * Math.min(1, this.platterVel / 150) : 0;
    const th = this.platterAngle * Math.PI / 180;
    this.armYaw.rotation.y = -(90 + this.armAngle + sway * .06 * Math.sin(th)) * Math.PI / 180;
    this.armPitch.rotation.z = (this.lift * 3.4 + (onRecord ? 0 : .6) + sway * .035 * Math.sin(2 * th + 1)) * Math.PI / 180;
    this.cueGroup.rotation.z = this.lift * .5;
    this.cueBar.position.y = ARM_Y - .82 + this.lift * (.31 + this.cueR * Math.sin(3.4 * Math.PI / 180));

    // record change: lift and slide off, swap, set down with a soft landing
    let L = 0, bounce = 0;
    if (this.recordSwap) {
      const s = this.recordSwap, up = .85, down = 1.15;
      s.t += dt;
      if (s.t < up) L = easeInOutCubic(s.t / up);
      else {
        if (!s.applied) { s.apply(); s.applied = true; }
        const k = Math.min(1, (s.t - up) / down);
        L = 1 - easeOutCubic(k);
        const land = s.t - up - down;
        if (land > 0) bounce = .05 * Math.exp(-14 * land) * Math.sin(32 * land);
      }
      if (s.t > up + down + .35) { this.recordSwap = null; this.swapping = false; }
    }
    this.recordGroup.position.set(C.x + L * 3.5, REC_Y + L * 8.5 + bounce, C.z - L * 5);
    this.recordGroup.rotation.x = L * .1;
    this.recordGroup.rotation.z = -L * .04;

    // buttons: quick press, springy release
    if (this.pressing) {
      const p = this.pressing, cap = p.cap;
      p.t += dt;
      const down = .08, upT = .26;
      if (p.t < down) cap.position.y = cap.userData.rest - .2 * easeOutCubic(p.t / down);
      else cap.position.y = cap.userData.rest - .2 * (1 - easeOutBack(Math.min(1, (p.t - down) / upT)));
      if (p.t >= down + upT) { cap.position.y = cap.userData.rest; this.pressing = null; }
    }

    // lights and indicators fade like filament and phosphor, not like switches
    const running = this.platterVel > 1;
    const led = this.led || new THREE.Color('#ffcf9a');
    // critically damped springs for the lamp post, knob, fader and lid
    const spring = (key, x, target, k) => {
      const v = this[key] || 0, a = (target - x) * k - 2 * Math.sqrt(k) * v;
      this[key] = v + a * dt;
      return x + this[key] * dt;
    };
    this.stepRig(dt, calm);
    // stylus lamp: pops up on a spring, swings to the needle, then the filament warms up
    this.lampUp = Math.max(0, Math.min(1.08, spring('lampVel', this.lampUp ?? 1, this.lamp ? 1 : 0, 70)));
    // retracted, the head rests just above its collar (collar top .5 + shell radius .6), level
    this.lampPost.position.y = TOP - (1 - this.lampUp) * 5.3;
    const lampOn = this.lamp && this.lampUp > .9;          // a stylus lamp is a switch, not tied to playback
    this.lampLevel = approach(this.lampLevel || 0, lampOn ? 1 : 0, lampOn ? 2.2 : 5, dt);
    const s = stylusAt(Math.max(this.armAngle, A_LEADIN));   // parked, it lights the record's edge
    const aim = this.lampAim || (this.lampAim = new THREE.Vector3(s.x, REC_TOP, s.z));
    aim.x = approach(aim.x, s.x - .6, 4, dt); aim.z = approach(aim.z, s.z + .4, 4, dt); aim.y = REC_TOP;
    const look = this.lampLook || (this.lampLook = new THREE.Vector3());
    const headY = this.lampPost.position.y + 6.5, up = Math.max(0, Math.min(1, this.lampUp));
    look.set(aim.x, headY + (REC_TOP - headY) * up * up, aim.z);
    this.lampHead.lookAt(look);
    const lens = this.lampLens.getWorldPosition(this.lampPos || (this.lampPos = new THREE.Vector3()));
    this.lampLight.position.copy(lens);
    this.lampLight.target.position.copy(aim);
    const warm = this.lampLevel * this.lampLevel * (3 - 2 * this.lampLevel);   // filament: slow start
    this.lampLight.intensity = warm * 1100;
    this.bulbMat.emissiveIntensity = warm * 4.5;
    const show = warm > .003;
    this.beam.visible = show;
    if (show) {
      const L = lens.distanceTo(aim) * 1.04, rad = L * Math.tan(this.lampLight.angle * .85);
      this.beam.position.copy(lens);
      this.beam.scale.set(rad, rad, L);
      this.beam.lookAt(aim);
      this.beamMat.uniforms.uStrength.value = warm * .1;
      this.dustMat.uniforms.uStrength.value = warm * .9;
      this.dustMat.uniforms.uPx.value = this.renderer.getPixelRatio();
      this.dustMat.uniforms.uTime.value += dt;
      const seed = this.dust.geometry.attributes.seed.array, p = this.dust.geometry.attributes.position.array;
      for (let k = 0; k < p.length / 3; k++) {
        if (!calm) {
          seed[k * 4] += dt * (.05 + seed[k * 4 + 3] * .08);
          seed[k * 4 + 2] += dt * (.004 + seed[k * 4 + 3] * .006);
          if (seed[k * 4 + 2] > .96) seed[k * 4 + 2] = .14;
        }
        const a = seed[k * 4], f = seed[k * 4 + 1], t = seed[k * 4 + 2], w = Math.sin(a * 3 + seed[k * 4 + 3] * 9) * .08;
        p[k * 3] = Math.cos(a) * (f + w) * t; p[k * 3 + 1] = Math.sin(a) * (f - w) * t; p[k * 3 + 2] = t;
      }
      this.dust.geometry.attributes.position.needsUpdate = true;
    }
    this.strobeLevel = approach(this.strobeLevel || 0, running ? 1 : 0, 4, dt);
    this.strobeLight.intensity = this.strobeLevel * 6;
    this.ledLevel = this.ledLevel || {};
    const setLed = (k, on, color = led) => {
      this.ledLevel[k] = approach(this.ledLevel[k] || 0, on ? 1 : 0, 10, dt);
      this.leds[k].emissive.copy(color);
      this.leds[k].emissiveIntensity = this.ledLevel[k] * 3.2;
    };
    for (const k of ['33', '45', '78']) setLed(k, this.loaded && this.speedSetting === k);
    setLed('power', this.loaded);
    setLed('zero', this.loaded && this.pitch === 0, this.zeroColor || (this.zeroColor = new THREE.Color('#5be08f')));

    // knob, fader and lid move on critically damped springs
    this.knob.rotation.y = spring('knobVel', this.knob.rotation.y, KNOB_MIN + this.volume * (KNOB_MAX - KNOB_MIN), 90);
    this.fader.position.z = spring('faderVel', this.fader.position.z, 1.6 + this.pitch / 8 * 4.4, 220);
    this.lidOpen = Math.max(0, Math.min(1, spring('lidVel', this.lidOpen, this.lidClosed ? 0 : 1, 9)));
    this.lid.rotation.x = -this.lidOpen * 1.45;
    const fade = 1 - smooth(Math.max(0, (this.lidOpen - .55) / .45));
    this.lidMats[0].opacity = .2 * fade; this.lidMats[1].opacity = .14 * fade;
    for (const leaf of this.lidLeaves) leaf.visible = fade > .02;
    this.lid.visible = fade > .002;

    // camera motion: pointer parallax and a very slow drift (also keeps OLED pixels moving)
    const still = calm || this.followPointer === false || this.dragArm;
    this.pointer.x = approach(this.pointer.x, still ? 0 : this.pointer.tx, 2.5, dt);
    this.pointer.y = approach(this.pointer.y, still ? 0 : this.pointer.ty, 2.5, dt);
    const tSec = performance.now() / 1000;
    this.drift.x = calm ? 0 : Math.sin(tSec / 47) * .8;
    this.drift.y = calm ? 0 : Math.sin(tSec / 61) * .5;
    this.zoom1 = approach(this.zoom1 ?? 1, this.zoomTarget, 9, dt);
    this.zoom = calm ? this.zoomTarget : approach(this.zoom, this.zoom1, 9, dt);
    this.show1 = approach(this.show1 || 0, this.showcaseTarget, 3.2, dt);
    this.showcase = calm ? this.showcaseTarget : approach(this.showcase, this.show1, 3.2, dt);
    if (this.regionAnim) {
      const a = this.regionAnim;
      a.t += dt;
      const k = calm ? 1 : easeInOutCubic(Math.min(1, a.t / .9));
      for (const key of ['x', 'y', 'w', 'h']) this.region[key] = a.from[key] + (a.to[key] - a.from[key]) * k;
      if (k >= 1) this.regionAnim = null;
    }

    // full frame rate while anything moves faster than the camera drift; see loop()
    const moving = [this.armAngle, this.lift, this.lidOpen, this.knob.rotation.y, this.fader.position.z, this.lampUp, this.lampLevel, this.zoom, this.showcase, this.pointer.x, this.pointer.y];
    const prev = this.movingPrev;
    this.movingPrev = moving;
    this.busy = this.platterVel > .3 || !!this.recordSwap || !!this.regionAnim || !!this.pressing || !!this.dragArm || !!this.dragPitch || !!this.dragVol
      || this.intro < 1 || !prev || moving.some((v, i) => Math.abs(v - prev[i]) > 1e-4);
  }
}
