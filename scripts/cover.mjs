// Generates cover.png (800x534) for gladys-pglab: plain Node, no dependency.
// A relay board (a green circuit board with its processor and two rows of
// relays) linked by MQTT to the three things it gives here: a lamp, a
// shutter and the temperature of the board, on a dark green to teal
// gradient (no brand logo).
// Usage: node scripts/cover.mjs cover.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 800;
const H = 534;
const px = Buffer.alloc(W * H * 3);
const set = (x, y, [r, g, b], a = 1) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = px[i] * (1 - a) + r * a;
  px[i + 1] = px[i + 1] * (1 - a) + g * a;
  px[i + 2] = px[i + 2] * (1 - a) + b * a;
};
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const t = (x / W + y / H) / 2;
    set(x, y, [16 + 10 * t, 60 + 70 * t, 60 + 70 * t]);
  }
}
const white = [255, 255, 255];
const dark = [24, 34, 58];
const amber = [255, 196, 70];
const green = [90, 220, 150];
const red = [240, 100, 80];
const disc = (cx, cy, r, color, alpha = 1) => {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y += 1) {
    for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x += 1) {
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const box = (x0, y0, x1, y1, r, color, alpha = 1) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      const a = Math.max(0, Math.min(1, r - Math.hypot(x - cx, y - cy) + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};
const line = (x0, y0, x1, y1, width, color, alpha = 1) => {
  const minX = Math.floor(Math.min(x0, x1) - width);
  const maxX = Math.ceil(Math.max(x0, x1) + width);
  const minY = Math.floor(Math.min(y0, y1) - width);
  const maxY = Math.ceil(Math.max(y0, y1) + width);
  const len2 = (x1 - x0) ** 2 + (y1 - y0) ** 2 || 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = Math.max(0, Math.min(1, ((x - x0) * (x1 - x0) + (y - y0) * (y1 - y0)) / len2));
      const d = Math.hypot(x - (x0 + t * (x1 - x0)), y - (y0 + t * (y1 - y0)));
      const a = Math.max(0, Math.min(1, width / 2 - d + 0.5));
      if (a > 0) set(x, y, color, a * alpha);
    }
  }
};

disc(400, 267, 270, white, 0.05);

// The board: a circuit board, its processor and two rows of four relays.
const pcb = [30, 120, 80];
const relay = [40, 90, 200];
box(60, 90, 360, 444, 18, pcb);
box(70, 100, 350, 434, 12, [40, 140, 95]);
box(150, 120, 270, 190, 8, dark);
for (let i = 0; i < 6; i += 1) {
  line(160 + i * 20, 112, 160 + i * 20, 120, 4, [220, 220, 220]);
  line(160 + i * 20, 190, 160 + i * 20, 198, 4, [220, 220, 220]);
}
for (let row = 0; row < 2; row += 1) {
  for (let col = 0; col < 4; col += 1) {
    const x = 90 + col * 64;
    const y = 225 + row * 105;
    box(x, y, x + 52, y + 80, 6, relay);
    box(x + 8, y + 10, x + 44, y + 30, 3, [90, 140, 230]);
    disc(x + 26, y + 60, 6, (row + col) % 2 ? green : amber);
  }
}
for (let i = 0; i < 10; i += 1) disc(95 + i * 27, 420, 5, [210, 190, 120]);

// The MQTT links from the board to the three things.
const links = [
  [360, 160, 520, 130],
  [360, 267, 520, 267],
  [360, 380, 520, 405],
];
for (const [x0, y0, x1, y1] of links) {
  line(x0, y0, x1, y1, 6, white, 0.5);
  for (let t = 0.25; t < 1; t += 0.25) disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 5, white, 0.9);
}

// A lamp (bulb and rays).
disc(600, 120, 46, amber);
box(582, 160, 618, 190, 6, white);
for (let k = 0; k < 8; k += 1) {
  const angle = (k * Math.PI) / 4;
  line(
    600 + Math.cos(angle) * 58,
    120 + Math.sin(angle) * 58,
    600 + Math.cos(angle) * 74,
    120 + Math.sin(angle) * 74,
    6,
    amber,
  );
}

// A shutter (a window with its slats half down).
box(530, 215, 700, 325, 10, white);
box(542, 227, 688, 313, 4, [160, 200, 240]);
for (let k = 0; k < 5; k += 1) box(542, 227 + k * 10, 688, 234 + k * 10, 2, [120, 130, 150]);

// A thermometer (the temperature of the board).
box(598, 345, 632, 440, 17, white);
disc(615, 445, 26, white);
box(607, 380, 623, 440, 8, red);
disc(615, 445, 18, red);
for (let k = 0; k < 4; k += 1) line(640, 360 + k * 18, 656, 360 + k * 18, 4, white, 0.8);

// PNG encoding.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y += 1) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(process.argv[2] ?? 'cover.png', png);
console.log('cover', png.length, 'bytes');
