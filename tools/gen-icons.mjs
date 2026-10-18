// tools/gen-icons.mjs — one-shot icon generator for Twitter Country Filter.
// Pure Node, ESM, `zlib` only. Renders a 128×128 flag glyph, nearest-neighbor
// downscales to 48 and 16, and hand-encodes PNG (IHDR/IDAT/IEND, CRC32).
// Outputs: icons/icon128.png, icons/icon48.png, icons/icon16.png

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const S = 128; // master canvas size
const R = 24; // rounded-square corner radius

const BG = [0x1d, 0x9b, 0xf0]; // #1D9BF0
const WHITE = [0xff, 0xff, 0xff];

// --- drawing ---------------------------------------------------------------

function inRoundedSquare(x, y) {
  if (x < 0 || y < 0 || x >= S || y >= S) return false;
  let dx, dy;
  if (x < R && y < R) {
    dx = x - R;
    dy = y - R; // top-left, quarter-circle centered at (R, R)
  } else if (x >= S - R && y < R) {
    dx = x - (S - R);
    dy = y - R; // top-right
  } else if (x < R && y >= S - R) {
    dx = x - R;
    dy = y - (S - R); // bottom-left
  } else if (x >= S - R && y >= S - R) {
    dx = x - (S - R);
    dy = y - (S - R); // bottom-right
  } else {
    return true; // central cross region: inside the box, outside the corner squares
  }
  return dx * dx + dy * dy <= R * R;
}

function inRect(x, y, rx, ry, w, h) {
  return x >= rx && x < rx + w && y >= ry && y < ry + h;
}

function renderMaster() {
  const buf = new Uint8Array(S * S * 4); // transparent by default
  const setPx = (x, y, rgb) => {
    const i = (y * S + x) * 4;
    buf[i] = rgb[0];
    buf[i + 1] = rgb[1];
    buf[i + 2] = rgb[2];
    buf[i + 3] = 255;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!inRoundedSquare(x, y)) continue;
      if (inRect(x, y, 42, 28, 8, 72)) setPx(x, y, WHITE); // pole
      else if (inRect(x, y, 50, 48, 52, 12)) setPx(x, y, BG); // stripe (inside flag rect)
      else if (inRect(x, y, 50, 28, 52, 36)) setPx(x, y, WHITE); // flag
      else setPx(x, y, BG);
    }
  }
  return buf;
}

function downscale(src, srcSize, dstSize) {
  const buf = new Uint8Array(dstSize * dstSize * 4);
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      const sx = Math.floor((x * srcSize) / dstSize);
      const sy = Math.floor((y * srcSize) / dstSize);
      const si = (sy * srcSize + sx) * 4;
      const di = (y * dstSize + x) * 4;
      buf.set(src.subarray(si, si + 4), di);
    }
  }
  return buf;
}

// --- PNG encoding ----------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); // width
  ihdr.writeUInt32BE(size, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter type 0 (None)
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(
      raw,
      y * (size * 4 + 1) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- main ------------------------------------------------------------------

const outDir = join(here, '..', 'icons');
mkdirSync(outDir, { recursive: true });

const master = renderMaster();

const targets = [
  [128, master],
  [48, downscale(master, S, 48)],
  [16, downscale(master, S, 16)],
];

for (const [size, buf] of targets) {
  const file = join(outDir, `icon${size}.png`);
  writeFileSync(file, encodePng(buf, size));
  console.log(`wrote ${file} (${buf.length} bytes RGBA → ${size}×${size} PNG)`);
}
