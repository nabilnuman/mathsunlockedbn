const Jimp = require("jimp");
const path = require("path");
const SRC = process.argv[2] || path.join(__dirname, "logo-source.jpg");
(async () => {
  const img = await Jimp.read(SRC);
  const { width: W, height: H, data } = img.bitmap;
  let ix0 = W, iy0 = H, ix1 = 0, iy1 = 0;         // teal artwork
  let cx0 = W, cy0 = H, cx1 = 0, cy1 = 0;         // any non-black (the white card / circle)
  const at = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = at(x, y);
    const lum = 0.3 * r + 0.59 * g + 0.11 * b;
    if (lum > 40) { if (x < cx0) cx0 = x; if (x > cx1) cx1 = x; if (y < cy0) cy0 = y; if (y > cy1) cy1 = y; }
    const teal = r < 175 && g > 120 && b > 110 && g - r > 18 && b - r > 5;
    if (teal) { if (x < ix0) ix0 = x; if (x > ix1) ix1 = x; if (y < iy0) iy0 = y; if (y > iy1) iy1 = y; }
  }
  console.log("image", W, H);
  console.log("non-black box  x", cx0, cx1, " y", cy0, cy1, ` (${cx1 - cx0}x${cy1 - cy0})`);
  console.log("teal art box   x", ix0, ix1, " y", iy0, iy1, ` (${ix1 - ix0}x${iy1 - iy0})`);
  // sample the cream background near the circle centre-left
  const [sr, sg, sb] = at(Math.round((ix0 + ix1) / 2), Math.round(iy0 - (iy1 - iy0) * 0.4));
  console.log("cream sample near art top:", sr, sg, sb);
  const [wr, wg, wb] = at(5, Math.round(H / 2));
  console.log("corner sample (outside circle):", wr, wg, wb);
})();
