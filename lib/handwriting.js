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
const NUM_IDX_SET = new Set(NUM_IDX);

// A handful of classic digit look-alikes ("2" vs "Z", "1" vs a bare
// vertical stroke read as "(", ")" or "t"…) that this ~86%-accurate
// model sometimes swaps. Never applied blind — only nudges a glyph from
// the look-alike to the digit when the digit was genuinely a close
// runner-up for THAT glyph specifically, and the rest of this ink reads
// as mostly digits (so a real "(x+y)" or "(5)" — where parens actually
// belong and aren't outnumbered by digits — is left alone).
const CONFUSABLE_TO_DIGIT = { Z: "2", O: "0", D: "0", S: "5", B: "8", G: "6", I: "1", "(": "1", ")": "1", t: "1" };

// ---- powers (superscripts) and fraction bars --------------------------
// Neither is a trained character class — both are read from the *shape*
// of the ink (how big/high a glyph is, or how a stroke sits relative to
// what's above and below it) and turned into the `^(...)` / `(...)/(...)`
// syntax the answer parser already understands, same as if it were typed.

function overlapsX(a, b) {
  return Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
}

// Flag glyphs that are clearly smaller than their neighbours and sit
// above the writing line — a handwritten power, e.g. the small raised
// "3" in "2³". Mutates `glyphs`, setting `.sup = true` where it applies.
function markSuperscripts(glyphs) {
  if (glyphs.length < 2) return;
  const heights = glyphs.map((g) => g.maxY - g.minY).filter((h) => h > 0.005);
  if (!heights.length) return;
  const sorted = [...heights].sort((a, b) => a - b);
  const typH = sorted[Math.floor(sorted.length / 2)];
  const normal = glyphs.filter((g) => (g.maxY - g.minY) >= typH * 0.62);
  if (!normal.length) return; // everything is small — nothing for a power to sit on
  const baseline = normal.reduce((s, g) => s + g.maxY, 0) / normal.length;
  for (const g of glyphs) {
    const h = g.maxY - g.minY;
    g.sup = h > 0.005 && h < typH * 0.62 && g.maxY < baseline - typH * 0.18;
  }
}

// A stroke's height, ignoring a small hook/flourish right at either end
// (a hand-drawn line very often lifts up or dips down exactly where the
// pen landed or lifted) — the 10th-90th percentile of its y-values, so
// one wayward point at the very tip doesn't make an otherwise-flat bar
// fail the flatness test.
function trimmedHeight(s) {
  const ys = s.map(([, y]) => y).sort((a, b) => a - b);
  const lo = ys[Math.floor(ys.length * 0.1)];
  const hi = ys[Math.min(ys.length - 1, Math.ceil(ys.length * 0.9) - 1)];
  return Math.max(0, hi - lo);
}

// Look for a single stroke that reads as a fraction bar: flat, and with
// other ink sitting both above AND below it at the same horizontal
// position. That last part is what tells a bar apart from a "-" or "=",
// which never have ink stacked both above and below them at once.
function detectFractionBar(strokes) {
  const items = strokes.filter((s) => s && s.length).map((s) => ({ s, b: strokeBox(s) }));
  if (items.length < 3) return null; // need a bar + at least one glyph above + one below
  let best = null;
  for (const cand of items) {
    const w = cand.b.maxX - cand.b.minX, h = trimmedHeight(cand.s);
    if (w < 0.05 || h > w * 0.35) continue; // too short, or not flat enough
    const midY = (cand.b.minY + cand.b.maxY) / 2;
    let hasAbove = false, hasBelow = false;
    for (const o of items) {
      if (o === cand) continue;
      const ow = o.b.maxX - o.b.minX;
      if (overlapsX(o.b, cand.b) < 0.25 * Math.min(ow, w)) continue;
      if (o.b.maxY <= midY) hasAbove = true;
      else if (o.b.minY >= midY) hasBelow = true;
    }
    if (hasAbove && hasBelow && (!best || w > best.w)) best = { stroke: cand.s, box: cand.b, w };
  }
  return best;
}

// Split every other stroke into what sits above the bar (numerator),
// below it (denominator), or to either side (outside the fraction).
function splitByBar(strokes, bar) {
  const b = bar.box, midY = (b.minY + b.maxY) / 2, midX = (b.minX + b.maxX) / 2;
  const above = [], below = [], outsideBefore = [], outsideAfter = [];
  for (const s of strokes) {
    if (s === bar.stroke) continue;
    const sb = strokeBox(s);
    const near = overlapsX(sb, b) >= 0.15 * Math.min(sb.maxX - sb.minX, b.maxX - b.minX);
    if (near && sb.maxY <= midY) above.push(s);
    else if (near && sb.minY >= midY) below.push(s);
    else ((sb.minX + sb.maxX) / 2 < midX ? outsideBefore : outsideAfter).push(s);
  }
  return { above, below, outsideBefore, outsideAfter };
}

// Turn a run of already-classified glyphs into text: spaces between
// separate characters, `^( … )` around a run flagged as a superscript.
function glyphsToString(glyphs, numberMode) {
  let out = "", supOpen = false;
  glyphs.forEach((g, i) => {
    if (g.sup && !supOpen) { out += "^("; supOpen = true; }
    else if (!g.sup && supOpen) { out += ")"; supOpen = false; }
    else if (i > 0 && g.spaceBefore && !numberMode && !g.sup) {
      // A number written against a following letter is implicit
      // multiplication ("9x", never "9 x") — keep it tight even when the
      // pen left a natural gap before the (often taller) variable.
      const prevCh = glyphs[i - 1].ch;
      const isCoefficient = /[0-9]/.test(prevCh) && /[A-Za-z]/.test(g.ch);
      if (!isCoefficient) out += " ";
    }
    out += g.ch;
  });
  if (supOpen) out += ")";
  return out.trim();
}

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
   string — plain text for an ordinary line, or `(num)/(den)` around a
   handwritten fraction bar, with `^(...)` wherever a power was written
   small and raised. Never throws — returns "" on failure. */
export async function recognizeHandwriting(ink) {
  try {
    if (!hasInk(ink && ink.strokes)) return "";
    const aspect = (ink.height || 1) / (ink.width || 1);
    const numberMode = ink.mode === "number";

    const bar = detectFractionBar(ink.strokes);
    // Every stroke group that needs its own left-to-right glyph run —
    // "flat" when there's no fraction, otherwise before/num/den/after
    // (any of which may end up empty).
    const groups = bar
      ? (() => {
          const { above, below, outsideBefore, outsideAfter } = splitByBar(ink.strokes, bar);
          return [
            { role: "before", strokes: outsideBefore },
            { role: "num", strokes: above },
            { role: "den", strokes: below },
            { role: "after", strokes: outsideAfter },
          ];
        })()
      : [{ role: "flat", strokes: ink.strokes }];

    // One flat, tagged glyph list so the model only runs once.
    const tagged = [];
    for (const grp of groups) {
      const gs = segment(grp.strokes);
      markSuperscripts(gs);
      gs.forEach((g) => tagged.push({ g, role: grp.role }));
    }
    if (!tagged.length) return "";

    const { tf, model } = await ensureModel();
    const batch = new Float32Array(tagged.length * 28 * 28);
    tagged.forEach((t, i) => batch.set(rasterGlyph(t.g, aspect), i * 28 * 28));
    // Whatever sits above or below a fraction bar is always a number —
    // never a letter, never internally spaced — even when the answer as
    // a whole is free-form text (e.g. its `answer` string carries display
    // markup, so the number-mode regex never matches even for a plain
    // fraction like "1/125"). A bare "1" is otherwise genuinely ambiguous
    // with "l"/"("/")"/"t", and a wide gap after one only reads as a new
    // number, never a continuation of it — both need the same tight,
    // digits-only treatment num/den always get, regardless of the overall
    // answer's mode.
    const tightRole = (role) => numberMode || role === "num" || role === "den";
    const digitMask = new Float32Array(HWR_CHARS.length);
    NUM_IDX.forEach((i) => { digitMask[i] = 1; });
    const openMask = new Float32Array(HWR_CHARS.length).fill(1);
    const maskData = new Float32Array(tagged.length * HWR_CHARS.length);
    tagged.forEach((t, i) => {
      maskData.set(tightRole(t.role) ? digitMask : openMask, i * HWR_CHARS.length);
    });
    // Per-glyph class probabilities (not just the top pick) so a classic
    // look-alike swap can be second-guessed against its actual runner-up.
    const probs = tf.tidy(() => {
      const x = tf.tensor4d(batch, [tagged.length, 28, 28, 1]);
      return model.predict(x).mul(tf.tensor2d(maskData, [tagged.length, HWR_CHARS.length])).arraySync();
    });
    // Two passes: first find every glyph that's either a plain digit or a
    // *candidate* (its top pick is a confusable look-alike with a
    // genuinely close digit runner-up) — a candidate doesn't count either
    // way yet, since two ambiguous glyphs next to each other ("10" both
    // misread) shouldn't cancel out each other's support. Then, only if
    // there's at least one glyph that's unambiguously already a digit and
    // the *solid* (non-candidate) non-digit glyphs don't outnumber it —
    // i.e. this doesn't look like a deliberately non-numeric answer —
    // every candidate flips to its digit reading together.
    let certainDigits = 0, soundOthers = 0;
    const info = probs.map((row) => {
      let top = 0;
      for (let k = 1; k < row.length; k++) if (row[k] > row[top]) top = k;
      const ch = HWR_CHARS[top] ?? "";
      const digitAlt = CONFUSABLE_TO_DIGIT[ch];
      const altIdx = digitAlt ? HWR_CHARS.indexOf(digitAlt) : -1;
      const candidate = altIdx >= 0 && row[altIdx] >= row[top] * 0.35;
      if (NUM_IDX_SET.has(top)) certainDigits++;
      else if (!candidate) soundOthers++;
      return { top, altIdx: candidate ? altIdx : -1 };
    });
    const flipCandidates = certainDigits >= 1 && certainDigits >= soundOthers;
    tagged.forEach((t, i) => {
      const { top, altIdx } = info[i];
      t.g.ch = HWR_CHARS[flipCandidates && altIdx >= 0 ? altIdx : top] ?? "";
    });

    const render = (role) => glyphsToString(tagged.filter((t) => t.role === role).map((t) => t.g), tightRole(role));

    if (!bar) return render("flat");
    const num = render("num"), den = render("den");
    if (!num && !den) return (render("before") + render("after")).trim(); // bar false-positive, nothing above/below
    return (render("before") + `(${num || "0"})/(${den || "1"})` + render("after")).trim();
  } catch (e) {
    return "";
  }
}
