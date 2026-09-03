/* ------------------------------------------------------------------
   In-browser handwriting recognition for the answer box.

   Everything runs on the device: TensorFlow.js (loaded lazily the first
   time the pad is opened) plus a small CNN trained on EMNIST digits +
   letters and synthetic math operators. No network calls once the model
   file is cached.

   The recogniser takes the raw ink from <WritePad> (a list of strokes,
   each a list of [x, y] points in 0..1 canvas space), splits it into
   left-to-right glyphs, normalises each the way EMNIST/MNIST expects
   (ink cropped, scaled into a 20px box, centred by centre-of-mass in a
   28px frame) and classifies them one by one.
------------------------------------------------------------------ */

// class index -> character. MUST match tools/train-hwr.mjs.
export const HWR_CHARS = [
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
  "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
  "a", "b", "d", "e", "f", "g", "h", "n", "q", "r", "t",
  "+", "-", "=", "(", ")", ".", ",", "/",
];

let _tf = null;
let _model = null;
let _loading = null;

async function ensureModel() {
  if (_model) return { tf: _tf, model: _model };
  if (_loading) return _loading;
  _loading = (async () => {
    const tf = await import("@tensorflow/tfjs");
    try { await tf.setBackend("webgl"); } catch (e) { await tf.setBackend("cpu"); }
    await tf.ready();
    const model = await tf.loadLayersModel("/hwr/model.json");
    // one warm-up pass so the first real call isn't slow
    tf.tidy(() => model.predict(tf.zeros([1, 28, 28, 1])));
    _tf = tf; _model = model;
    return { tf, model };
  })();
  return _loading;
}

// Is a stroke list plausibly writable? (something was drawn)
export function hasInk(strokes) {
  return Array.isArray(strokes) && strokes.some((s) => Array.isArray(s) && s.length > 0);
}

// ---- geometry helpers -------------------------------------------------
function strokeBox(s) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of s) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

// Group strokes into glyphs, left to right. Strokes whose x-spans overlap
// (or nearly touch) belong to the same character — that keeps "=", "x",
// "4", "5", "+" etc. together. A gap wider than ~55% of a typical glyph
// becomes a space.
function segment(strokes) {
  const items = strokes
    .filter((s) => s && s.length)
    .map((s) => ({ s, b: strokeBox(s) }))
    .sort((a, b) => a.b.minX - b.b.minX);
  const glyphs = [];
  for (const it of items) {
    const g = glyphs[glyphs.length - 1];
    // merge into the current glyph only if this stroke really shares its
    // horizontal space (a multi-stroke char like 4, +, =, x, t) — not just
    // sits next to it, so "3" and "0" written close together stay apart
    let merge = false;
    if (g) {
      const w = it.b.maxX - it.b.minX, gw = g.maxX - g.minX;
      const overlap = Math.min(g.maxX, it.b.maxX) - Math.max(g.minX, it.b.minX);
      merge = overlap > 0.34 * Math.min(w, gw);
    }
    if (merge) {
      g.strokes.push(it.s);
      g.minX = Math.min(g.minX, it.b.minX);
      g.maxX = Math.max(g.maxX, it.b.maxX);
      g.minY = Math.min(g.minY, it.b.minY);
      g.maxY = Math.max(g.maxY, it.b.maxY);
    } else {
      glyphs.push({ strokes: [it.s], minX: it.b.minX, maxX: it.b.maxX, minY: it.b.minY, maxY: it.b.maxY });
    }
  }
  const widths = glyphs.map((g) => g.maxX - g.minX).filter((w) => w > 0.01).sort((a, b) => a - b);
  const typW = widths.length ? widths[Math.floor(widths.length / 2)] : 0.1;
  for (let i = 1; i < glyphs.length; i++) {
    glyphs[i].spaceBefore = glyphs[i].minX - glyphs[i - 1].maxX > typW * 0.55;
  }
  return glyphs;
}

// class indices allowed when the answer is a plain number
const NUM_IDX = HWR_CHARS.map((c, i) => (/[0-9]/.test(c) || c === "-" || c === "." || c === "," || c === "/" ? i : -1)).filter((i) => i >= 0);

// Rasterise one glyph's strokes into a 28x28 Float32Array (0..1), using
// the standard EMNIST/MNIST normalisation.
function rasterGlyph(glyph, aspect) {
  const GRID = 160;          // work at a comfortable resolution first
  const cell = new Float32Array(GRID * GRID);
  const w = Math.max(glyph.maxX - glyph.minX, 1e-4);
  const h = Math.max((glyph.maxY - glyph.minY) * aspect, 1e-4);
  const scale = 1 / Math.max(w, h);
  const offX = (1 - w * scale) / 2;
  const offY = (1 - h * scale) / 2;
  const put = (px, py, v) => {
    const ix = Math.round(px * (GRID - 1));
    const iy = Math.round(py * (GRID - 1));
    if (ix < 0 || iy < 0 || ix >= GRID || iy >= GRID) return;
    const idx = iy * GRID + ix;
    if (v > cell[idx]) cell[idx] = v;
  };
  const R = 7; // pen radius in grid cells (matches EMNIST stroke weight after scaling)
  const stamp = (px, py) => {
    for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) {
      const d = Math.hypot(dx, dy);
      if (d > R) continue;
      put(px + dx / (GRID - 1), py + dy / (GRID - 1), Math.max(0, 1 - d / R));
    }
  };
  for (const s of glyph.strokes) {
    for (let i = 0; i < s.length; i++) {
      const nx = offX + (s[i][0] - glyph.minX) * scale;
      const ny = offY + (s[i][1] - glyph.minY) * aspect * scale;
      if (i > 0) {
        const px0 = offX + (s[i - 1][0] - glyph.minX) * scale;
        const py0 = offY + (s[i - 1][1] - glyph.minY) * aspect * scale;
        const steps = Math.ceil(Math.hypot(nx - px0, ny - py0) * GRID);
        for (let k = 0; k <= steps; k++) stamp(px0 + (nx - px0) * k / steps, py0 + (ny - py0) * k / steps);
      } else {
        stamp(nx, ny);
      }
    }
  }
  // crop to ink, scale longest side to 20, centre by centre-of-mass in 28
  let bx0 = GRID, bx1 = 0, by0 = GRID, by1 = 0;
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
    if (cell[y * GRID + x] > 0.08) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
  }
  if (bx1 < bx0) return new Float32Array(28 * 28);
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  const target = 20;
  const sc = target / Math.max(bw, bh);
  const dw = Math.max(1, Math.round(bw * sc)), dh = Math.max(1, Math.round(bh * sc));
  const small = new Float32Array(dw * dh);
  // max-pool the source box for each target pixel so thin strokes (a "2"
  // base, a minus sign) aren't skipped when shrinking
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const sx0 = Math.floor(bx0 + x / sc), sx1 = Math.ceil(bx0 + (x + 1) / sc);
    const sy0 = Math.floor(by0 + y / sc), sy1 = Math.ceil(by0 + (y + 1) / sc);
    let mx = 0;
    for (let sy = sy0; sy < sy1 && sy < GRID; sy++) for (let sx = sx0; sx < sx1 && sx < GRID; sx++) {
      const v = cell[sy * GRID + sx]; if (v > mx) mx = v;
    }
    small[y * dw + x] = mx;
  }
  // centre of mass
  let m = 0, cx = 0, cy = 0;
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) { const v = small[y * dw + x]; m += v; cx += v * x; cy += v * y; }
  cx = m ? cx / m : dw / 2; cy = m ? cy / m : dh / 2;
  const out = new Float32Array(28 * 28);
  // centre-of-mass placement, clamped so a lop-sided glyph never spills
  // off the 28px frame (a light-bottomed "2" was losing its base)
  const ox = Math.max(0, Math.min(28 - dw, Math.round(14 - cx)));
  const oy = Math.max(0, Math.min(28 - dh, Math.round(14 - cy)));
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    const tx = x + ox, ty = y + oy;
    if (tx >= 0 && ty >= 0 && tx < 28 && ty < 28) out[ty * 28 + tx] = small[y * dw + x];
  }
  return out;
}

/* Recognise ink. `ink` = { strokes, width, height } where strokes is a
   list of strokes, each a list of [x, y] in 0..1. Returns a best-guess
   string. Never throws — returns "" on failure. */
export async function recognizeHandwriting(ink) {
  try {
    if (!hasInk(ink && ink.strokes)) return "";
    const { tf, model } = await ensureModel();
    const aspect = (ink.height || 1) / (ink.width || 1);
    const glyphs = segment(ink.strokes);
    if (!glyphs.length) return "";
    const batch = new Float32Array(glyphs.length * 28 * 28);
    glyphs.forEach((g, i) => batch.set(rasterGlyph(g, aspect), i * 28 * 28));
    const numberMode = ink.mode === "number";
    const chars = tf.tidy(() => {
      const x = tf.tensor4d(batch, [glyphs.length, 28, 28, 1]);
      let p = model.predict(x);
      if (numberMode) {
        const mask = new Float32Array(HWR_CHARS.length);
        NUM_IDX.forEach((i) => { mask[i] = 1; });
        p = p.mul(tf.tensor1d(mask));
      }
      return p.argMax(1).arraySync();
    });
    let outStr = "";
    chars.forEach((c, i) => {
      if (i > 0 && glyphs[i].spaceBefore && !numberMode) outStr += " ";
      outStr += HWR_CHARS[c] ?? "";
    });
    return outStr.trim();
  } catch (e) {
    return "";
  }
}
