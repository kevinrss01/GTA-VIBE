#!/usr/bin/env node
/**
 * Renders frames of a baked pedestrian VAT to a PNG contact sheet.
 *
 * WHY THIS EXISTS. `bake-pedestrian-vat.mjs` reports numbers; numbers do not
 * show a leg fused to a torso, a T-pose that never became an idle, or a
 * character standing 20 mm inside the pavement. The provider's own preview
 * shows the SOURCE mesh, not what the runtime will draw - by the time the clip
 * has been retargeted, ramped, re-anchored and packed into a texture, the only
 * honest picture is one drawn from the shipped `.bin` itself.
 *
 * It deliberately does not use a renderer. Reading the same three files the
 * game reads and rasterising them here means the picture cannot be right for a
 * reason the game does not share, and it runs in CI or over ssh.
 *
 * Shading is a fixed headlight plus a little ambient, from the baked NORMAL
 * texture, so a normal that was packed wrong shows up as a black or flat
 * figure. The albedo is not sampled: colour would hide silhouette faults,
 * which are the ones worth catching.
 *
 *   node tools/render-pedestrian-vat.mjs ped-e --clip walk --frames 8 \
 *        --out /tmp/ped-e-walk.png
 *   node tools/render-pedestrian-vat.mjs ped-e --clip idle --frames 1 \
 *        --view side --out /tmp/ped-e-idle-side.png
 *
 * Several ids, comma separated, put one character per column at the same
 * scale, which is how a new face is checked against the shipped crowd:
 *
 *   node tools/render-pedestrian-vat.mjs ped-a,ped-b,ped-e --clip idle \
 *        --out /tmp/roster.png
 *
 * A GROUND LINE is drawn at y = 0 in rig units, because "are the feet on the
 * floor" is the question this tool is most often asked.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// --- arguments ---------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    dir: 'public/models/pedestrians',
    clip: 'idle',
    frames: 1,
    view: 'front',
    cell: 320,
    out: null,
    id: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${token} needs a value`);
      i += 1;
      return value;
    };
    if (token === '--clip') args.clip = next();
    else if (token === '--frames') args.frames = Number(next());
    else if (token === '--view') args.view = next();
    else if (token === '--cell') args.cell = Number(next());
    else if (token === '--out') args.out = next();
    else if (token === '--dir') args.dir = next();
    else if (!token.startsWith('--')) args.id = token;
    else throw new Error(`unknown argument ${token}`);
  }
  if (!args.id) throw new Error('an id is required, e.g. ped-e');
  if (!args.out) args.out = `${args.id}-${args.clip}.png`;
  if (!['front', 'side', 'both'].includes(args.view)) {
    throw new Error(`--view wants front, side or both, got ${args.view}`);
  }
  return args;
}

// --- half float --------------------------------------------------------------

/** IEEE 754 binary16 -> Number. The bake packs positions as raw halves. */
function fromHalf(bits) {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa ? NaN : sign * Infinity;
  return sign * (mantissa + 1024) * 2 ** (exponent - 25);
}

// --- PNG ---------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Minimal 8-bit RGB PNG. `rgb` is width * height * 3. */
function encodePng(rgb, width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(
      raw,
      y * (width * 3 + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- rasteriser --------------------------------------------------------------

/**
 * Orthographic, one cell of the sheet, z-buffered, flat per-vertex normals.
 *
 * The projection is fixed rather than fitted to the pose: every cell of every
 * sheet uses the same rig-unit window, so two characters or two frames can be
 * compared by laying the images side by side. `y` runs 0 at the feet to 1.15
 * at the top of the cell, `x` spans +/- 0.575 about the origin.
 */
const HALF_WIDTH = 0.575;
const TOP = 1.15;
const BOTTOM = -0.02;

function renderCell(positions, normals, index, cell, view) {
  const rgb = new Uint8Array(cell * cell * 3).fill(0xf2);
  const depth = new Float32Array(cell * cell).fill(Infinity);

  // Ground line at y = 0, drawn under the figure so a sunk foot covers it.
  const groundRow = Math.round(((TOP - 0) / (TOP - BOTTOM)) * cell);
  if (groundRow >= 0 && groundRow < cell) {
    for (let x = 0; x < cell; x += 1) {
      const o = (groundRow * cell + x) * 3;
      rgb[o] = 0xc8;
      rgb[o + 1] = 0xcc;
      rgb[o + 2] = 0xd2;
    }
  }

  // The bake authors the face toward -Z. The front view therefore stands the
  // camera at -Z looking along +Z, whose screen right is -X; the side view
  // stands it at +X looking along -X, whose screen right is -Z, so the face
  // points to the right of the image. `into` is depth: smaller is nearer.
  const project = (i) => {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const across = view === 'side' ? -z : -x;
    const into = view === 'side' ? -x : z;
    return {
      sx: ((across + HALF_WIDTH) / (2 * HALF_WIDTH)) * cell,
      sy: ((TOP - y) / (TOP - BOTTOM)) * cell,
      sz: into,
    };
  };

  const screen = new Array(positions.length / 3);
  for (let i = 0; i < screen.length; i += 1) screen[i] = project(i);

  const light = [0.35, 0.5, 0.79]; // over the viewer's right shoulder
  for (let t = 0; t < index.length; t += 3) {
    const a = index[t];
    const b = index[t + 1];
    const c = index[t + 2];
    const pa = screen[a];
    const pb = screen[b];
    const pc = screen[c];
    const area = (pb.sx - pa.sx) * (pc.sy - pa.sy) - (pb.sy - pa.sy) * (pc.sx - pa.sx);
    if (area === 0) continue;

    let shade = 0;
    for (const v of [a, b, c]) {
      const nx = normals[v * 3];
      const ny = normals[v * 3 + 1];
      const nz = normals[v * 3 + 2];
      // The light lives in the camera's frame, so it lands the same way in
      // both views: over the viewer's right shoulder, pointing at the subject.
      const lx = view === 'side' ? light[2] : -light[0];
      const lz = view === 'side' ? -light[0] : -light[2];
      shade += Math.max(0, nx * lx + ny * light[1] + nz * lz);
    }
    shade = 0.22 + 0.74 * (shade / 3);
    const value = Math.max(0, Math.min(255, Math.round(shade * 235)));

    const minX = Math.max(0, Math.floor(Math.min(pa.sx, pb.sx, pc.sx)));
    const maxX = Math.min(cell - 1, Math.ceil(Math.max(pa.sx, pb.sx, pc.sx)));
    const minY = Math.max(0, Math.floor(Math.min(pa.sy, pb.sy, pc.sy)));
    const maxY = Math.min(cell - 1, Math.ceil(Math.max(pa.sy, pb.sy, pc.sy)));
    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        const py = y + 0.5;
        let w0 = ((pb.sx - pa.sx) * (py - pa.sy) - (pb.sy - pa.sy) * (px - pa.sx)) / area;
        let w1 = ((pc.sx - pb.sx) * (py - pb.sy) - (pc.sy - pb.sy) * (px - pb.sx)) / area;
        let w2 = 1 - w0 - w1;
        // Barycentric order: w1 belongs to a, w0 to c, w2 to b.
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = pa.sz * w1 + pb.sz * w2 + pc.sz * w0;
        const slot = y * cell + x;
        if (z >= depth[slot]) continue;
        depth[slot] = z;
        const o = slot * 3;
        rgb[o] = value;
        rgb[o + 1] = value;
        rgb[o + 2] = value;
      }
    }
  }
  return rgb;
}

// --- main --------------------------------------------------------------------

/**
 * Every requested frame of one character, decoded out of its VAT.
 *
 * Frames are spread evenly across the clip rather than taken from its start,
 * so a six-frame sheet of a walk shows a whole gait cycle.
 */
function readFrames(args, id) {
  const meta = JSON.parse(fs.readFileSync(path.join(args.dir, `${id}.json`), 'utf8'));
  const bin = fs.readFileSync(path.join(args.dir, `${id}.bin`));

  const clip = meta.clips.find((entry) => entry.name === args.clip);
  if (!clip) {
    throw new Error(`${id} has no clip ${args.clip}; it has ${meta.clips.map((c) => c.name)}`);
  }

  const vertexCount = meta.vertexCount;
  const width = meta.texture.width;
  const indexBytes = meta.layout.index;
  const index =
    meta.indexType === 'uint16'
      ? new Uint16Array(bin.buffer, bin.byteOffset + indexBytes.offset, meta.indexCount)
      : new Uint32Array(bin.buffer, bin.byteOffset + indexBytes.offset, meta.indexCount);
  const posHalf = new Uint16Array(
    bin.buffer,
    bin.byteOffset + meta.layout.position.offset,
    (meta.layout.position.length / 2) | 0,
  );
  const nrmBytes = new Uint8Array(
    bin.buffer,
    bin.byteOffset + meta.layout.normal.offset,
    meta.layout.normal.length,
  );

  const frames = [];
  const count = Math.max(1, Math.min(args.frames, clip.frames));
  for (let f = 0; f < count; f += 1) {
    const column = clip.column + Math.round((f / count) * clip.frames);
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    for (let v = 0; v < vertexCount; v += 1) {
      const texel = (v * width + column) * 4;
      positions[v * 3] = fromHalf(posHalf[texel]);
      positions[v * 3 + 1] = fromHalf(posHalf[texel + 1]);
      positions[v * 3 + 2] = fromHalf(posHalf[texel + 2]);
      normals[v * 3] = (nrmBytes[texel] / 255) * 2 - 1;
      normals[v * 3 + 1] = (nrmBytes[texel + 1] / 255) * 2 - 1;
      normals[v * 3 + 2] = (nrmBytes[texel + 2] / 255) * 2 - 1;
    }
    frames.push({ positions, normals, column });
  }
  return { id, frames, index };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ids = args.id.split(',').map((value) => value.trim()).filter(Boolean);
  const characters = ids.map((id) => readFrames(args, id));

  const views = args.view === 'both' ? ['front', 'side'] : [args.view];
  const cell = args.cell;
  const columns = characters.reduce((total, character) => total + character.frames.length, 0);
  const sheetWidth = cell * columns;
  const sheetHeight = cell * views.length;
  const sheet = new Uint8Array(sheetWidth * sheetHeight * 3).fill(0xff);

  views.forEach((view, row) => {
    let col = 0;
    for (const character of characters) {
      for (const frame of character.frames) {
        const tile = renderCell(frame.positions, frame.normals, character.index, cell, view);
        for (let y = 0; y < cell; y += 1) {
          const src = y * cell * 3;
          const dst = ((row * cell + y) * sheetWidth + col * cell) * 3;
          sheet.set(tile.subarray(src, src + cell * 3), dst);
        }
        col += 1;
      }
    }
  });

  fs.writeFileSync(args.out, encodePng(sheet, sheetWidth, sheetHeight));

  // Feet-on-the-floor and height, from the same frames that were drawn.
  for (const character of characters) {
    let low = Infinity;
    let high = -Infinity;
    for (const frame of character.frames) {
      for (let i = 1; i < frame.positions.length; i += 3) {
        low = Math.min(low, frame.positions[i]);
        high = Math.max(high, frame.positions[i]);
      }
    }
    console.log(
      `${character.id} ${args.clip}: ${character.frames.length} frame(s), ${views.join('+')}; ` +
        `y ${low.toFixed(4)} .. ${high.toFixed(4)} rig units`,
    );
  }
  console.log(`-> ${args.out} (${sheetWidth} x ${sheetHeight})`);
}

main();
