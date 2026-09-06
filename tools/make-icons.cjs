// Generates the PWA icons (no image deps — writes PNG by hand).
// Run: node tools/make-icons.cjs   → public/icon-192.png, icon-512.png, apple-touch-icon.png
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const crcTable = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const tb = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
    return Buffer.concat([len, tb, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4, d = y * stride + 1 + x * 4;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2]; raw[d + 3] = rgba[s + 3];
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

// distance from point p to segment ab
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function drawIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  const S = size / 512;
  // radical "√" strokes, in 512-space
  const strokes = [
    [138, 300, 205, 384, 30],   // short tick
    [205, 384, 330, 150, 30],   // long rise
    [318, 150, 414, 150, 28],   // top bar
  ];
  const bg = [18, 51, 90];      // #12335A navy
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    let ink = 0;
    const X = x / S, Y = y / S;
    for (const [ax, ay, bx, by, w] of strokes) {
      const d = distSeg(X, Y, ax, ay, bx, by);
      const a = Math.max(0, Math.min(1, (w / 2 + 1.2 - d) / 2.4)); // soft edge
      if (a > ink) ink = a;
    }
    rgba[i] = Math.round(bg[0] * (1 - ink) + 255 * ink);
    rgba[i + 1] = Math.round(bg[1] * (1 - ink) + 255 * ink);
    rgba[i + 2] = Math.round(bg[2] * (1 - ink) + 255 * ink);
    rgba[i + 3] = 255;
  }
  return encodePng(size, size, rgba);
}

const out = path.join(__dirname, "..", "public");
fs.writeFileSync(path.join(out, "icon-192.png"), drawIcon(192));
fs.writeFileSync(path.join(out, "icon-512.png"), drawIcon(512));
fs.writeFileSync(path.join(out, "apple-touch-icon.png"), drawIcon(180));
console.log("wrote public/icon-192.png, icon-512.png, apple-touch-icon.png");
