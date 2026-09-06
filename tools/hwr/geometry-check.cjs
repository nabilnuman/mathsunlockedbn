// Sanity-checks the pure-geometry heuristics in lib/handwriting.js
// (decimal point / superscript / segmentation) against synthetic ink.
// Run: node tools/hwr/geometry-check.cjs
const { readFileSync } = require("fs");
const path = require("path");
const src = readFileSync(path.join(__dirname, "..", "..", "lib", "handwriting.js"), "utf8");
function grab(name) {
  const re = new RegExp("function " + name + "\\s*\\([^)]*\\)\\s*\\{");
  const m = re.exec(src); if (!m) throw new Error("no " + name);
  let i = m.index + m[0].length, depth = 1;
  while (depth > 0) { const c = src[i++]; if (c === "{") depth++; else if (c === "}") depth--; }
  return src.slice(m.index, i);
}
const code = [grab("strokeBox"), grab("segment"), grab("markSuperscripts"), grab("markTinyDots")].join("\n");
const { segment, markSuperscripts, markTinyDots } =
  new Function(code + "\n return { segment, markSuperscripts, markTinyDots };")();

// realistic strokes: a full-height digit spans y 0.20..0.80 (h=0.60),
// width ~0.22. line(pts) just returns densified polyline.
const line = (pts, n = 20) => {
  const out = [];
  for (let s = 0; s < pts.length - 1; s++)
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([pts[s][0] + (pts[s + 1][0] - pts[s][0]) * t, pts[s][1] + (pts[s + 1][1] - pts[s][1]) * t]);
    }
  return out;
};
// digit glyphs at left edge x
const D = {
  "1": (x) => [line([[x + 0.02, 0.30], [x + 0.11, 0.20], [x + 0.11, 0.80]]), line([[x, 0.80], [x + 0.22, 0.80]])],
  "5": (x) => [line([[x + 0.20, 0.20], [x + 0.02, 0.20], [x + 0.02, 0.48], [x + 0.14, 0.44]]),
               line([[x + 0.14, 0.44], [x + 0.21, 0.56], [x + 0.16, 0.74], [x + 0.02, 0.78], [x, 0.68]])],
  "0": (x) => [line([[x + 0.11, 0.20], [x + 0.20, 0.35], [x + 0.20, 0.65], [x + 0.11, 0.80], [x + 0.02, 0.65], [x + 0.02, 0.35], [x + 0.11, 0.20]])],
  "2": (x) => [line([[x + 0.02, 0.30], [x + 0.11, 0.20], [x + 0.20, 0.30], [x + 0.04, 0.62], [x + 0.02, 0.80]]), line([[x + 0.02, 0.80], [x + 0.22, 0.80]])],
  "4": (x) => [line([[x + 0.14, 0.20], [x + 0.02, 0.58], [x + 0.22, 0.58]]), line([[x + 0.15, 0.20], [x + 0.15, 0.80]])],
};
const dot = (cx, cy) => line([[cx - 0.018, cy], [cx + 0.018, cy + 0.006], [cx + 0.012, cy - 0.014], [cx - 0.016, cy - 0.006], [cx - 0.018, cy]]);
const tap = (cx, cy) => [[cx, cy]];                      // single-point stroke
const tap2 = (cx, cy) => [[cx, cy], [cx + 0.004, cy + 0.003]]; // 2-point dab
const minus = (cx) => [line([[cx - 0.10, 0.50], [cx + 0.10, 0.50]])];

const glyphChars = (strokes) => {
  const gs = segment(strokes); markTinyDots(gs); markSuperscripts(gs);
  return gs.map((g) => `${g.strokes.length}s${g.tiny ? "·tiny" : ""}${g.tinyDot ? "·DOT" : ""}${g.sup ? "·SUP" : ""}`);
};
// small raised digit: half height, sits high
const sup3 = (x) => [line([[x + 0.02, 0.12], [x + 0.10, 0.06], [x + 0.06, 0.16], [x + 0.11, 0.20], [x + 0.04, 0.28]])];

const T = [
  ["1 · 5   (mid dot)", [...D["1"](0.20), dot(0.50, 0.50), ...D["5"](0.60)], "1 dot 5, dot in middle"],
  ["0 . 5   (low dot)", [...D["0"](0.20), dot(0.47, 0.78), ...D["5"](0.58)], "0 dot 5"],
  ["1 5     (no dot)", [...D["1"](0.20), ...D["5"](0.55)], "no dot glyph"],
  ["- 5     (neg)", [...minus(0.22), ...D["5"](0.45)], "minus must NOT be DOT"],
  ["4       (multi-stroke digit)", [...D["4"](0.35)], "no false tiny/DOT"],
  ["1 2 5", [...D["1"](0.12), ...D["2"](0.42), ...D["5"](0.72)], "no false DOT"],
  ["2 . 5", [...D["2"](0.18), dot(0.48, 0.62), ...D["5"](0.60)], "dot in middle"],
  ["1 . 2 5", [...D["1"](0.12), dot(0.40, 0.55), ...D["2"](0.48), ...D["5"](0.74)], "dot then two digits"],
  ["2 ^3  (power)", [...D["2"](0.20), ...sup3(0.46)], "raised 3 = SUP, not DOT"],
  ["x ^2  small power", [...D["1"](0.20), line([[0.46, 0.20], [0.56, 0.14], [0.50, 0.24], [0.56, 0.30], [0.48, 0.36]])], "small raised 2 = SUP not DOT"],
  ["1 TAP 5  (single point, mid)", [...D["1"](0.20), tap(0.50, 0.55), ...D["5"](0.60)], "single-tap dot = DOT"],
  ["1 TAP 5  (single point, low)", [...D["1"](0.20), tap(0.50, 0.76), ...D["5"](0.60)], "single-tap dot = DOT"],
  ["0 dab 5  (2-point)", [...D["0"](0.20), tap2(0.47, 0.6), ...D["5"](0.58)], "2-point dab = DOT"],
];
for (const [label, strokes, note] of T)
  console.log(label.padEnd(30), "=>", glyphChars(strokes).join("  "), "   //", note);
