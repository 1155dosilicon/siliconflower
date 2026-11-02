// Generates resources/icon.ico from the flower of the interface (src/gui/server.ts).
// Run it only if the drawing changes: `bun run scripts/make-icon.ts`; the result is committed.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Rgb = [number, number, number];
const PETALS: Rgb = [0xe7, 0x7f, 0xb3];
const CENTER: Rgb = [0xf7, 0xd7, 0x74];
const VIEW_BOX = 32;
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SUBSAMPLES = 4;

const circles: { x: number; y: number; r: number; color: Rgb }[] = [
  { x: 16, y: 7, r: 6, color: PETALS },
  { x: 25, y: 13, r: 6, color: PETALS },
  { x: 21, y: 24, r: 6, color: PETALS },
  { x: 11, y: 24, r: 6, color: PETALS },
  { x: 7, y: 13, r: 6, color: PETALS },
  { x: 16, y: 16, r: 8, color: PETALS }, // closes the gaps between the petals
  { x: 16, y: 16, r: 4, color: CENTER },
];

function colorAt(x: number, y: number): Rgb | undefined {
  let found: Rgb | undefined;
  for (const c of circles) {
    if ((x - c.x) ** 2 + (y - c.y) ** 2 <= c.r ** 2) found = c.color;
  }
  return found;
}

function rasterize(size: number): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let [r, g, b, hits] = [0, 0, 0, 0];
      for (let sy = 0; sy < SUBSAMPLES; sy++) {
        for (let sx = 0; sx < SUBSAMPLES; sx++) {
          const color = colorAt(
            ((px + (sx + 0.5) / SUBSAMPLES) / size) * VIEW_BOX,
            ((py + (sy + 0.5) / SUBSAMPLES) / size) * VIEW_BOX
          );
          if (!color) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          hits++;
        }
      }
      if (!hits) continue;
      const i = (py * size + px) * 4;
      rgba[i] = Math.round(r / hits);
      rgba[i + 1] = Math.round(g / hits);
      rgba[i + 2] = Math.round(b / hits);
      rgba[i + 3] = Math.round((hits / SUBSAMPLES ** 2) * 255);
    }
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits per channel
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function ico(images: { size: number; data: Buffer }[]): Buffer {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size; // 0 means 256 in this format
    entry[1] = size === 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([head, ...entries, ...images.map((image) => image.data)]);
}

const out = join(import.meta.dir, "..", "resources");
mkdirSync(out, { recursive: true });
const images = SIZES.map((size) => ({ size, data: png(size, rasterize(size)) }));
writeFileSync(join(out, "icon.ico"), ico(images));
// Only to look at it: the build uses the .ico.
writeFileSync(join(out, "icon.png"), images.at(-1)!.data);
