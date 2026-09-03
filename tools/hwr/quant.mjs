import fs from "fs";
const dir = process.argv[2] || "./out", outDir = process.argv[3] || "./out-q";
fs.mkdirSync(outDir, { recursive: true });
const mj = JSON.parse(fs.readFileSync(`${dir}/model.json`));
const raw = fs.readFileSync(`${dir}/weights.bin`);
const specs = mj.weightsManifest[0].weights;
let off = 0;
const outParts = [];
for (const s of specs) {
  const n = s.shape.reduce((a, b) => a * b, 1);
  const f = new Float32Array(raw.buffer, raw.byteOffset + off, n);
  off += n * 4;
  let mn = Infinity, mx = -Infinity;
  for (const v of f) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const scale = (mx - mn) / 255 || 1;
  const q = Buffer.alloc(n);
  for (let i = 0; i < n; i++) q[i] = Math.max(0, Math.min(255, Math.round((f[i] - mn) / scale)));
  s.quantization = { dtype: "uint8", scale, min: mn };
  outParts.push(q);
}
fs.writeFileSync(`${outDir}/weights.bin`, Buffer.concat(outParts));
fs.writeFileSync(`${outDir}/model.json`, JSON.stringify(mj));
console.log("quantized:", raw.length, "->", Buffer.concat(outParts).length, "bytes");
