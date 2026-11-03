// Generates build/icon.png + build/icons/*.png (256x256) with no image deps:
// supersampled shapes rasterised to RGBA, written as PNG via zlib.
// The mark is the sidebar wordmark: a backslash with two ticks (reads as an S), on a solid rounded tile.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const S = 256;
const SS = 4; // supersampling per axis

// The glyph in a 24-unit box (same path as the app's sidebar mark), mapped to the tile.
const K = 11.5;
const map = ([x, y]) => [128 + (x - 12) * K, 128 + (y - 12) * K];
const SEGMENTS = [
  [[18, 18], [6, 6]],
  [[17.5, 7.5], [11.5, 7.5]],
  [[12.5, 16.5], [6.5, 16.5]],
].map(([a, b]) => [map(a), map(b)]);
const STROKE = 1.6 * K; // radius of the round-capped strokes

const distToSegment = (px, py, [[ax, ay], [bx, by]]) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const inTile = (x, y, r = 58) => {
  const cx = Math.min(Math.max(x, r), S - r), cy = Math.min(Math.max(y, r), S - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

function render(tile, glyph) {
  const px = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let bg = 0, fg = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
      if (!inTile(fx, fy)) continue;
      bg++;
      if (SEGMENTS.some((s) => distToSegment(fx, fy, s) <= STROKE)) fg++;
    }
    const n = SS * SS, a = bg / n, f = bg ? fg / bg : 0;
    const i = (y * S + x) * 4;
    for (let c = 0; c < 3; c++) px[i + c] = Math.round(tile[c] * (1 - f) + glyph[c] * f);
    px[i + 3] = Math.round(a * 255);
  }
  const raw = Buffer.alloc((S * 4 + 1) * S);
  for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ids are stored in settings, so they stay; the colours are the new palette.
const VARIANTS = {
  mono: { tile: [245, 245, 247], glyph: [0, 0, 0] }, // white tile (default)
  red: { tile: [255, 69, 58], glyph: [255, 255, 255] }, // ember
  teal: { tile: [90, 216, 198], glyph: [0, 0, 0] }, // mint
  gold: { tile: [255, 214, 10], glyph: [0, 0, 0] }, // amber
};
mkdirSync('build/icons', { recursive: true });
// .ico with the 256px PNG embedded (valid since Windows Vista). Shortcuts and the taskbar need .ico files.
const ico = (png) => {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(1, 4); // one image
  head.writeUInt8(0, 6); // width 256
  head.writeUInt8(0, 7); // height 256
  head.writeUInt16LE(1, 10); // planes
  head.writeUInt16LE(32, 12); // bits per pixel
  head.writeUInt32LE(png.length, 14);
  head.writeUInt32LE(22, 18); // image offset
  return Buffer.concat([head, png]);
};
for (const [name, v] of Object.entries(VARIANTS)) {
  const png = render(v.tile, v.glyph);
  writeFileSync(`build/icons/${name}.png`, png);
  writeFileSync(`build/icons/${name}.ico`, ico(png));
}
writeFileSync('build/icon.png', render(VARIANTS.mono.tile, VARIANTS.mono.glyph));
console.log('icons written:', Object.keys(VARIANTS).join(', '));
