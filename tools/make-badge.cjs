/* Android notification "badge" icon — the small status-bar glyph.
   Android uses ONLY the alpha channel and tints it, so this MUST be a
   white-on-transparent silhouette (a full-colour PNG shows as a white
   box). This draws the MathsUnlocked open-padlock mark at 96x96.
   Run:  node tools/make-badge.cjs   → writes public/badge-96.png       */
const Jimp = require("jimp");

const S = 96;
const WHITE = 0xffffffff;

// rounded-rectangle test
function inRR(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const nx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const ny = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  return (x - nx) ** 2 + (y - ny) ** 2 <= r * r;
}

Jimp.create(S, S, 0x00000000).then((img) => {
  // body of the lock
  const B = { x0: 20, y0: 46, x1: 76, y1: 90, r: 10 };
  // shackle: open loop above the body. Left leg drops into the body; the
  // right end floats free — that's the "unlocked" look.
  const scx = 48, scy = 42, ri = 12, ro = 20;
  const leg = { x0: 26, y0: 32, x1: 36, y1: 50 };   // left leg into the body
  const stub = { x0: 60, y0: 24, x1: 70, y1: 38 };  // right leg — short & lifted

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - scx, dy = y - scy, d = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx); // negative = above centre
      const onArc = d >= ri && d <= ro && ang <= -0.12 && ang >= -Math.PI + 0.12;
      const onLeg = x >= leg.x0 && x <= leg.x1 && y >= leg.y0 && y <= leg.y1;
      const onStub = x >= stub.x0 && x <= stub.x1 && y >= stub.y0 && y <= stub.y1;
      const onBody = inRR(x, y, B.x0, B.y0, B.x1, B.y1, B.r);

      let on = onArc || onLeg || onStub || onBody;

      // keyhole knocked out of the body
      const kx = 48, ky = 66;
      const hole =
        (x - kx) ** 2 + (y - ky) ** 2 <= 30 ||
        (Math.abs(x - kx) <= 2.6 && y >= ky && y <= ky + 15);
      if (hole) on = false;

      if (on) img.setPixelColor(WHITE, x, y);
    }
  }
  return img.writeAsync("public/badge-96.png");
}).then(() => console.log("wrote public/badge-96.png"));
