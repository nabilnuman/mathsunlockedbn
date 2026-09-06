// Builds the PWA / favicon icons from the brand logo.
// Source: the "MATHS UNLOCKED" + open-padlock mark on a cream ground.
// Run: node tools/make-icons.cjs  ->  public/icon-192.png, icon-512.png, apple-touch-icon.png, logo.png
const Jimp = require("jimp");
const path = require("path");

const SRC = process.argv[2] || path.join(__dirname, "logo-source.jpg");
const OUT = path.join(__dirname, "..", "public");

// tight artwork bbox in the source (from tools/analyze-logo.cjs) + a little margin
const ART = { x: 120, y: 858, w: 882, h: 500 };
const CREAM = { r: 252, g: 250, b: 241 };
const ARTWIDTH_FRAC = 0.72; // artwork spans this fraction of the icon width

(async () => {
  const src = await Jimp.read(SRC);

  const art = src.clone().crop(ART.x, ART.y, ART.w, ART.h);
  // flush anything that's near-white (cream ground / corners) or near-black
  // (stray letterbox) to one flat cream; keep the teal + its soft edges.
  art.scan(0, 0, art.bitmap.width, art.bitmap.height, function (x, y, idx) {
    const r = this.bitmap.data[idx], g = this.bitmap.data[idx + 1], b = this.bitmap.data[idx + 2];
    const lum = 0.3 * r + 0.59 * g + 0.11 * b;
    if (lum > 243 || lum < 26) {
      this.bitmap.data[idx] = CREAM.r;
      this.bitmap.data[idx + 1] = CREAM.g;
      this.bitmap.data[idx + 2] = CREAM.b;
      this.bitmap.data[idx + 3] = 255;
    }
  });

  const build = (canvas) => {
    const bg = new Jimp(canvas, canvas, Jimp.rgbaToInt(CREAM.r, CREAM.g, CREAM.b, 255));
    const w = Math.round(canvas * ARTWIDTH_FRAC);
    const h = Math.round(w * (ART.h / ART.w));
    const piece = art.clone().resize(w, h, Jimp.RESIZE_BICUBIC);
    bg.composite(piece, Math.round((canvas - w) / 2), Math.round((canvas - h) / 2));
    return bg;
  };

  await build(768).writeAsync(path.join(OUT, "logo.png"));
  await build(192).writeAsync(path.join(OUT, "icon-192.png"));
  await build(512).writeAsync(path.join(OUT, "icon-512.png"));
  await build(180).writeAsync(path.join(OUT, "apple-touch-icon.png"));

  // transparent-background version of just the wordmark, for on-page use
  const mark = src.clone().crop(ART.x, ART.y, ART.w, ART.h);
  mark.scan(0, 0, mark.bitmap.width, mark.bitmap.height, function (x, y, idx) {
    const r = this.bitmap.data[idx], g = this.bitmap.data[idx + 1], b = this.bitmap.data[idx + 2];
    const lum = 0.3 * r + 0.59 * g + 0.11 * b;
    // opaque where it's teal ink, fading to transparent over the cream ground
    const a = Math.max(0, Math.min(1, (238 - lum) / 70));
    this.bitmap.data[idx + 3] = lum < 26 ? 0 : Math.round(a * 255);
  });
  await mark.resize(880, Jimp.AUTO).writeAsync(path.join(OUT, "logo-mark.png"));

  console.log("wrote public/{logo,icon-192,icon-512,apple-touch-icon,logo-mark}.png");
})();
