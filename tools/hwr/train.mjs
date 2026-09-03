import fs from "fs";
import * as tf from "@tensorflow/tfjs";
import { setWasmPaths } from "@tensorflow/tfjs-backend-wasm";

setWasmPaths("./node_modules/@tensorflow/tfjs-backend-wasm/dist/");
await import("@tensorflow/tfjs-backend-wasm");
await tf.setBackend("wasm");
await tf.ready();
console.log("backend:", tf.getBackend());

const G = "./gzip";
const CHARS = [
  "0","1","2","3","4","5","6","7","8","9",
  "A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z",
  "a","b","d","e","f","g","h","n","q","r","t",
  "+","-","=","(",")",".",",","/",
];
const NCLASS = CHARS.length;               // 55
const EM_CLASSES = 47;

// ---------- idx readers ----------
function readIdxImages(p) {
  const buf = fs.readFileSync(p);
  const n = buf.readUInt32BE(4), rows = buf.readUInt32BE(8), cols = buf.readUInt32BE(12);
  const data = new Uint8Array(buf.buffer, buf.byteOffset + 16, n * rows * cols);
  return { n, rows, cols, data };
}
function readIdxLabels(p) {
  const buf = fs.readFileSync(p);
  const n = buf.readUInt32BE(4);
  return new Uint8Array(buf.buffer, buf.byteOffset + 8, n);
}

// EMNIST images are stored transposed — fix to upright 28x28 float 0..1
function emnistUpright(src, off) {
  const out = new Float32Array(784);
  for (let r = 0; r < 28; r++) for (let c = 0; c < 28; c++) out[r * 28 + c] = src[off + c * 28 + r] / 255;
  return out;
}

// Normalise any 28x28 float image the SAME way lib/handwriting.js does at
// inference time: crop to ink, scale longest side to 20px, centre by
// centre-of-mass in a 28px frame. Everything the model sees goes through
// this so train/test/inference distributions match.
function norm28(img) {
  let x0 = 28, x1 = -1, y0 = 28, y1 = -1;
  for (let y = 0; y < 28; y++) for (let x = 0; x < 28; x++) if (img[y * 28 + x] > 0.08) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < x0) return img;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, sc = 20 / Math.max(bw, bh);
  const dw = Math.max(1, Math.round(bw * sc)), dh = Math.max(1, Math.round(bh * sc));
  const small = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) { let mx = 0; const a=Math.floor(x0+x/sc),b=Math.max(a+1,Math.ceil(x0+(x+1)/sc)),cc=Math.floor(y0+y/sc),dd=Math.max(cc+1,Math.ceil(y0+(y+1)/sc)); for(let sy=cc;sy<dd&&sy<28;sy++)for(let sx=a;sx<b&&sx<28;sx++){const v=img[sy*28+sx];if(v>mx)mx=v;} small[y*dw+x]=mx; }
  let m = 0, cx = 0, cy = 0;
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) { const v = small[y * dw + x]; m += v; cx += v * x; cy += v * y; }
  cx = m ? cx / m : dw / 2; cy = m ? cy / m : dh / 2;
  const out = new Float32Array(784);
  const ox = Math.max(0, Math.min(28 - dw, Math.round(14 - cx))), oy = Math.max(0, Math.min(28 - dh, Math.round(14 - cy)));
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) { const tx = x + ox, ty = y + oy; if (tx >= 0 && ty >= 0 && tx < 28 && ty < 28) out[ty * 28 + tx] = small[y * dw + x]; }
  return out;
}

// ---------- synthetic operator glyphs ----------
const jitter = (v, s) => v + (Math.random() * 2 - 1) * s;
function opStrokes(ch) {
  const a = () => jitter(0.16, 0.04), b = () => jitter(0.84, 0.04);
  const line = (x0, y0, x1, y1) => { const o = []; const N = 24; for (let i = 0; i <= N; i++) o.push([x0 + (x1 - x0) * i / N, y0 + (y1 - y0) * i / N]); return o; };
  const arc = (cx, dir) => { const o = []; for (let i = 0; i <= 24; i++) { const t = -0.9 + 1.8 * i / 24; o.push([cx + dir * 0.20 * Math.cos(t * 1.3), 0.5 + 0.42 * Math.sin(t * 1.3)]); } return o; };
  switch (ch) {
    case "+": return [line(a(), 0.5, b(), 0.5), line(0.5, jitter(0.18, 0.04), 0.5, jitter(0.82, 0.04))];
    case "-": return [line(a(), 0.5, b(), 0.5)];
    case "=": return [line(a(), jitter(0.38, 0.03), b(), jitter(0.38, 0.03)), line(a(), jitter(0.62, 0.03), b(), jitter(0.62, 0.03))];
    case "(": return [arc(jitter(0.62, 0.05), -1)];
    case ")": return [arc(jitter(0.38, 0.05), 1)];
    case ".": return [line(jitter(0.5, 0.03), jitter(0.78, 0.03), jitter(0.5, 0.03) + 0.02, jitter(0.78, 0.03) + 0.02)];
    case ",": return [[...line(jitter(0.52, 0.03), 0.72, jitter(0.52, 0.03), 0.78), ...line(jitter(0.52, 0.03), 0.78, jitter(0.44, 0.03), 0.92)]];
    case "/": return [line(jitter(0.74, 0.05), jitter(0.16, 0.04), jitter(0.26, 0.05), jitter(0.84, 0.04))];
  }
  return [line(0.2, 0.5, 0.8, 0.5)];
}

// rasterise strokes (0..1) into 28x28 float, MNIST-style (20px box, CoM centred)
function raster(strokes) {
  const GRID = 160;
  const cell = new Float32Array(GRID * GRID);
  const R = 4 + Math.floor(Math.random() * 5);
  const stamp = (px, py) => {
    const cx = Math.round(px * (GRID - 1)), cy = Math.round(py * (GRID - 1));
    for (let dx = -R; dx <= R; dx++) for (let dy = -R; dy <= R; dy++) {
      const d = Math.hypot(dx, dy); if (d > R) continue;
      const ix = cx + dx, iy = cy + dy;
      if (ix < 0 || iy < 0 || ix >= GRID || iy >= GRID) continue;
      const v = Math.max(0, 1 - d / (R + 0.5));
      if (v > cell[iy * GRID + ix]) cell[iy * GRID + ix] = v;
    }
  };
  // random affine
  const rot = (Math.random() * 2 - 1) * 0.22, scl = 0.8 + Math.random() * 0.4;
  const tx = (Math.random() * 2 - 1) * 0.06, ty = (Math.random() * 2 - 1) * 0.06;
  const xf = ([x, y]) => {
    let X = (x - 0.5) * scl, Y = (y - 0.5) * scl;
    const c = Math.cos(rot), s = Math.sin(rot);
    return [0.5 + X * c - Y * s + tx, 0.5 + X * s + Y * c + ty];
  };
  for (const st of strokes) {
    for (let i = 0; i < st.length; i++) {
      const p = xf(st[i]);
      if (i > 0) { const q = xf(st[i - 1]); const n = Math.ceil(Math.hypot(p[0] - q[0], p[1] - q[1]) * GRID); for (let k = 0; k <= n; k++) stamp(q[0] + (p[0] - q[0]) * k / n, q[1] + (p[1] - q[1]) * k / n); }
      else stamp(p[0], p[1]);
    }
  }
  // crop
  let x0 = GRID, x1 = 0, y0 = GRID, y1 = 0;
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) if (cell[y * GRID + x] > 0.1) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < x0) return new Float32Array(784);
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, sc = 20 / Math.max(bw, bh);
  const dw = Math.max(1, Math.round(bw * sc)), dh = Math.max(1, Math.round(bh * sc));
  const small = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) { let mx = 0; const a=Math.floor(x0+x/sc),b=Math.ceil(x0+(x+1)/sc),cc=Math.floor(y0+y/sc),dd=Math.ceil(y0+(y+1)/sc); for(let sy=cc;sy<dd&&sy<GRID;sy++)for(let sx=a;sx<b&&sx<GRID;sx++){const v=cell[sy*GRID+sx];if(v>mx)mx=v;} small[y*dw+x]=mx; }
  let m = 0, cx = 0, cy = 0;
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) { const v = small[y * dw + x]; m += v; cx += v * x; cy += v * y; }
  cx = m ? cx / m : dw / 2; cy = m ? cy / m : dh / 2;
  const out = new Float32Array(784);
  const ox = Math.max(0, Math.min(28 - dw, Math.round(14 - cx))), oy = Math.max(0, Math.min(28 - dh, Math.round(14 - cy)));
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) { const tx2 = x + ox, ty2 = y + oy; if (tx2 >= 0 && ty2 >= 0 && tx2 < 28 && ty2 < 28) out[ty2 * 28 + tx2] = small[y * dw + x]; }
  return out;
}

// light augmentation of an existing 28x28 float image
function augment(img) {
  const rot = (Math.random() * 2 - 1) * 0.18, scl = 0.88 + Math.random() * 0.24;
  const tx = (Math.random() * 2 - 1) * 2.2, ty = (Math.random() * 2 - 1) * 2.2;
  const c = Math.cos(rot), s = Math.sin(rot);
  const out = new Float32Array(784);
  for (let y = 0; y < 28; y++) for (let x = 0; x < 28; x++) {
    const dx = (x - 14 - tx) / scl, dy = (y - 14 - ty) / scl;
    const sx = 14 + dx * c + dy * s, sy = 14 - dx * s + dy * c;
    const ix = Math.round(sx), iy = Math.round(sy);
    if (ix >= 0 && iy >= 0 && ix < 28 && iy < 28) out[y * 28 + x] = img[iy * 28 + ix];
  }
  return out;
}

// custom disk save (plain tfjs has no file:// handler)
async function saveModel(model, dir) {
  fs.mkdirSync(dir, { recursive: true });
  await model.save(tf.io.withSaveHandler(async (a) => {
    const wPath = "weights.bin";
    fs.writeFileSync(`${dir}/model.json`, JSON.stringify({
      modelTopology: a.modelTopology,
      format: a.format, generatedBy: a.generatedBy, convertedBy: a.convertedBy,
      weightsManifest: [{ paths: [wPath], weights: a.weightSpecs }],
    }));
    fs.writeFileSync(`${dir}/${wPath}`, Buffer.from(a.weightData));
    return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: "JSON" } };
  }));
}

// ---------- assemble dataset (one contiguous buffer, no per-sample allocs) ----------
const MAX_PER_CLASS = 1600;  // subsample EMNIST for training speed
function build(split) {
  const t0 = Date.now();
  const imgs = readIdxImages(`${G}/emnist-balanced-${split}-images-idx3-ubyte`);
  const labs = readIdxLabels(`${G}/emnist-balanced-${split}-labels-idx1-ubyte`);
  const augProb = split === "train" ? 0.5 : 0;
  const perOp = split === "train" ? 1800 : 400;
  const cap = imgs.n * 2 + perOp * (NCLASS - EM_CLASSES) + 8;
  const flat = new Float32Array(cap * 784);
  const lab = new Int32Array(cap);
  let N = 0;
  const push = (arr, y) => { flat.set(arr, N * 784); lab[N] = y; N++; };
  const seen = new Int32Array(NCLASS);
  for (let i = 0; i < imgs.n; i++) {
    if (split === "train" && seen[labs[i]] >= MAX_PER_CLASS) continue;
    seen[labs[i]]++;
    const up = norm28(emnistUpright(imgs.data, i * 784));
    push(up, labs[i]);
    if (Math.random() < augProb) push(norm28(augment(up)), labs[i]);
  }
  console.log(`  ${split}: emnist ${N} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  for (let cls = EM_CLASSES; cls < NCLASS; cls++) {
    const ch = CHARS[cls];
    for (let k = 0; k < perOp; k++) push(raster(opStrokes(ch)), cls);
  }
  // Fisher-Yates over rows, swapping the 784-float blocks in place
  const tmp = new Float32Array(784);
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    tmp.set(flat.subarray(i * 784, i * 784 + 784));
    flat.copyWithin(i * 784, j * 784, j * 784 + 784);
    flat.set(tmp, j * 784);
    const t = lab[i]; lab[i] = lab[j]; lab[j] = t;
  }
  const x = tf.tensor4d(flat.subarray(0, N * 784), [N, 28, 28, 1]);
  const y = tf.oneHot(tf.tensor1d(lab.subarray(0, N), "int32"), NCLASS);
  console.log(`  ${split}: ${N} samples ready (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  return { x, y, N };
}

const test = build("test");
const train = build("train");

const model = tf.sequential();
model.add(tf.layers.flatten({ inputShape: [28, 28, 1] }));
model.add(tf.layers.dense({ units: 640, activation: "relu" }));
model.add(tf.layers.dropout({ rate: 0.35 }));
model.add(tf.layers.dense({ units: 256, activation: "relu" }));
model.add(tf.layers.dropout({ rate: 0.3 }));
model.add(tf.layers.dense({ units: NCLASS, activation: "softmax" }));
model.compile({ optimizer: tf.train.adam(0.001), loss: "categoricalCrossentropy", metrics: ["accuracy"] });
model.summary();

let bt = Date.now(), best = 0;
await model.fit(train.x, train.y, {
  epochs: 9, batchSize: 384, validationData: [test.x, test.y], shuffle: true,
  callbacks: {
    onBatchEnd: (b) => { if (b % 100 === 0) console.log(`  batch ${b}  (+${((Date.now() - bt) / 1000).toFixed(0)}s)`); },
    onEpochEnd: async (e, l) => {
      console.log(`epoch ${e + 1}  loss ${l.loss.toFixed(4)}  acc ${l.acc.toFixed(4)}  val_acc ${l.val_acc.toFixed(4)}`);
      bt = Date.now();
      if (l.val_acc >= best) {
        best = l.val_acc;
        await saveModel(model, "./out");
        fs.writeFileSync("./out/chars.json", JSON.stringify(CHARS));
        console.log(`  >> saved (best val_acc ${best.toFixed(4)})`);
      }
    },
  },
});
console.log("done; best val_acc", best.toFixed(4));
