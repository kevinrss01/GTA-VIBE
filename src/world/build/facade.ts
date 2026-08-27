/**
 * The façade construction kit.
 *
 * Every building is written into one `MeshWriter` and flushed as a single
 * merged, indexed `BufferGeometry` per material key. That is the whole
 * performance story: ~120 buildings, each contributing a handful of geometries,
 * is what lets the chunker reach a few draw calls per chunk. Nothing here ever
 * creates a mesh, a material or a `BoxGeometry` per window - a window is nine
 * quads written straight into shared typed-array staging buffers.
 *
 * COORDINATES: one world unit is one metre. +X east, +Z south, +Y up. All
 * geometry produced here is already in world space.
 *
 * WINDING: quads are given as four corners counter-clockwise seen from the
 * front, so the face normal follows from `cross(b - a, d - a)`. Anything whose
 * orientation is awkward to reason about goes through `quadFacing`, which
 * flips the winding to match a requested normal instead of relying on the
 * caller to get handedness right.
 */

import { BufferAttribute, BufferGeometry } from 'three';

import type { Rect } from '../../core/mathx';
import type { MaterialKey } from '../../render/materials';
import type { Facing } from '../CityPlan';
import type { GeometrySink } from './types';

export type P3 = readonly [number, number, number];

/** Face selection bits for `MeshWriter.box`, in world axes. */
export const FACE = {
  PX: 1,
  NX: 2,
  PY: 4,
  NY: 8,
  PZ: 16,
  NZ: 32,
  ALL: 63,
  /** Everything but the underside; for anything sitting on another solid. */
  NO_BOTTOM: 63 & ~8,
  /** Vertical faces only; for a band stacked between two other bands. */
  SIDES: 1 | 2 | 16 | 32,
} as const;

interface Bucket {
  readonly position: number[];
  readonly normal: number[];
  readonly uv: number[];
  readonly index: number[];
}

/**
 * Accumulates world-space geometry per material key.
 *
 * UVs are planar-projected from world position along whichever axis the face
 * normal points down, at one texture unit per metre. That keeps texture scale
 * continuous across a whole terrace regardless of how the geometry was cut up,
 * which is what stops tiling from advertising the seams between buildings.
 */
export class MeshWriter {
  private readonly buckets = new Map<MaterialKey, Bucket>();
  private tris = 0;
  private lowX = Infinity;
  private highX = -Infinity;
  private lowY = Infinity;
  private highY = -Infinity;
  private lowZ = Infinity;
  private highZ = -Infinity;

  get triangles(): number {
    return this.tris;
  }

  get minX(): number {
    return this.lowX;
  }

  get maxX(): number {
    return this.highX;
  }

  get minY(): number {
    return this.lowY;
  }

  get maxY(): number {
    return this.highY;
  }

  get minZ(): number {
    return this.lowZ;
  }

  get maxZ(): number {
    return this.highZ;
  }

  private bucketFor(key: MaterialKey): Bucket {
    const existing = this.buckets.get(key);
    if (existing) return existing;
    const created: Bucket = { position: [], normal: [], uv: [], index: [] };
    this.buckets.set(key, created);
    return created;
  }

  private vertex(bucket: Bucket, p: P3, nx: number, ny: number, nz: number): void {
    const [x, y, z] = p;
    bucket.position.push(x, y, z);
    bucket.normal.push(nx, ny, nz);

    const ax = Math.abs(nx);
    const ay = Math.abs(ny);
    const az = Math.abs(nz);
    if (ay >= ax && ay >= az) bucket.uv.push(x, z);
    else if (ax >= az) bucket.uv.push(z, y);
    else bucket.uv.push(x, y);

    if (x < this.lowX) this.lowX = x;
    if (x > this.highX) this.highX = x;
    if (y < this.lowY) this.lowY = y;
    if (y > this.highY) this.highY = y;
    if (z < this.lowZ) this.lowZ = z;
    if (z > this.highZ) this.highZ = z;
  }

  /** Adds one quad. Corners run counter-clockwise seen from the front face. */
  quad(key: MaterialKey, a: P3, b: P3, c: P3, d: P3): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    // A collapsed quad would contribute NaN normals; drop it instead.
    if (!(length > 1e-9)) return;
    nx /= length;
    ny /= length;
    nz /= length;

    const bucket = this.bucketFor(key);
    const base = bucket.position.length / 3;
    this.vertex(bucket, a, nx, ny, nz);
    this.vertex(bucket, b, nx, ny, nz);
    this.vertex(bucket, c, nx, ny, nz);
    this.vertex(bucket, d, nx, ny, nz);
    bucket.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.tris += 2;
  }

  /** Adds one quad, flipping the winding so its normal points roughly along `n`. */
  quadFacing(key: MaterialKey, a: P3, b: P3, c: P3, d: P3, n: P3): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const vz = d[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * n[0] + ny * n[1] + nz * n[2] < 0) this.quad(key, a, d, c, b);
    else this.quad(key, a, b, c, d);
  }

  /** Adds one triangle, flipping the winding so its normal points roughly along `n`. */
  triFacing(key: MaterialKey, a: P3, b: P3, c: P3, n: P3): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (!(length > 1e-9)) return;
    const flip = nx * n[0] + ny * n[1] + nz * n[2] < 0;
    nx /= length;
    ny /= length;
    nz /= length;
    if (flip) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }

    const bucket = this.bucketFor(key);
    const base = bucket.position.length / 3;
    this.vertex(bucket, a, nx, ny, nz);
    this.vertex(bucket, flip ? c : b, nx, ny, nz);
    this.vertex(bucket, flip ? b : c, nx, ny, nz);
    bucket.index.push(base, base + 1, base + 2);
    this.tris += 1;
  }

  /** Adds an axis-aligned box. `faces` selects which of the six sides to emit. */
  box(
    key: MaterialKey,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    faces: number = FACE.ALL,
  ): void {
    const ax = Math.min(x0, x1);
    const bx = Math.max(x0, x1);
    const ay = Math.min(y0, y1);
    const by = Math.max(y0, y1);
    const az = Math.min(z0, z1);
    const bz = Math.max(z0, z1);
    if (bx - ax < 1e-6 || by - ay < 1e-6 || bz - az < 1e-6) return;

    if (faces & FACE.PX) this.quad(key, [bx, ay, bz], [bx, ay, az], [bx, by, az], [bx, by, bz]);
    if (faces & FACE.NX) this.quad(key, [ax, ay, az], [ax, ay, bz], [ax, by, bz], [ax, by, az]);
    if (faces & FACE.PY) this.quad(key, [ax, by, bz], [bx, by, bz], [bx, by, az], [ax, by, az]);
    if (faces & FACE.NY) this.quad(key, [ax, ay, az], [bx, ay, az], [bx, ay, bz], [ax, ay, bz]);
    if (faces & FACE.PZ) this.quad(key, [ax, ay, bz], [bx, ay, bz], [bx, by, bz], [ax, by, bz]);
    if (faces & FACE.NZ) this.quad(key, [bx, ay, az], [ax, ay, az], [ax, by, az], [bx, by, az]);
  }

  /** A vertical open-ended prism: downpipes, columns, masts. */
  tube(
    key: MaterialKey,
    cx: number,
    cz: number,
    y0: number,
    y1: number,
    radius: number,
    sides: number,
    capTop = false,
  ): void {
    if (sides < 3 || radius <= 0 || y1 - y0 < 1e-6) return;
    const step = (Math.PI * 2) / sides;
    for (let i = 0; i < sides; i += 1) {
      const a0 = i * step;
      const a1 = (i + 1) * step;
      const x0 = cx + Math.cos(a0) * radius;
      const z0 = cz + Math.sin(a0) * radius;
      const x1 = cx + Math.cos(a1) * radius;
      const z1 = cz + Math.sin(a1) * radius;
      this.quadFacing(
        key,
        [x0, y0, z0],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z0],
        [Math.cos((a0 + a1) * 0.5), 0, Math.sin((a0 + a1) * 0.5)],
      );
    }
    if (capTop) {
      for (let i = 0; i < sides; i += 1) {
        const a0 = i * step;
        const a1 = (i + 1) * step;
        this.triFacing(
          key,
          [cx, y1, cz],
          [cx + Math.cos(a0) * radius, y1, cz + Math.sin(a0) * radius],
          [cx + Math.cos(a1) * radius, y1, cz + Math.sin(a1) * radius],
          [0, 1, 0],
        );
      }
    }
  }

  /** Hands every non-empty bucket to the sink as one indexed geometry. */
  flush(sink: GeometrySink): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.index.length === 0) continue;
      const vertexCount = bucket.position.length / 3;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(bucket.position), 3));
      geometry.setAttribute('normal', new BufferAttribute(new Float32Array(bucket.normal), 3));
      geometry.setAttribute('uv', new BufferAttribute(new Float32Array(bucket.uv), 2));
      geometry.setIndex(
        new BufferAttribute(
          vertexCount > 65535 ? new Uint32Array(bucket.index) : new Uint16Array(bucket.index),
          1,
        ),
      );
      geometry.computeBoundingSphere();
      sink.add(key, geometry);
    }
    this.buckets.clear();
  }
}

// ---------------------------------------------------------------------------
// Sides
// ---------------------------------------------------------------------------

/**
 * One elevation of a rectangular footprint, described in "along / up / out"
 * coordinates so a façade routine never has to know which world axis it is on.
 */
export interface Side {
  readonly facing: Facing;
  /** The world axis the wall runs along. */
  readonly runAxis: 'x' | 'z';
  /** Constant coordinate of the wall plane, on the perpendicular axis. */
  readonly plane: number;
  /** Sign of the outward normal along the perpendicular axis. */
  readonly outward: 1 | -1;
  readonly start: number;
  readonly end: number;
}

export function sideOf(rect: Rect, facing: Facing): Side {
  switch (facing) {
    case 'north':
      return { facing, runAxis: 'x', plane: rect.minZ, outward: -1, start: rect.minX, end: rect.maxX };
    case 'south':
      return { facing, runAxis: 'x', plane: rect.maxZ, outward: 1, start: rect.minX, end: rect.maxX };
    case 'west':
      return { facing, runAxis: 'z', plane: rect.minX, outward: -1, start: rect.minZ, end: rect.maxZ };
    case 'east':
      return { facing, runAxis: 'z', plane: rect.maxX, outward: 1, start: rect.minZ, end: rect.maxZ };
  }
}

export const ALL_FACINGS: readonly Facing[] = ['north', 'east', 'south', 'west'];

export function sidesOf(rect: Rect): readonly Side[] {
  return ALL_FACINGS.map((facing) => sideOf(rect, facing));
}

export function opposite(facing: Facing): Facing {
  switch (facing) {
    case 'north':
      return 'south';
    case 'south':
      return 'north';
    case 'west':
      return 'east';
    case 'east':
      return 'west';
  }
}

export function sideSpan(side: Side): number {
  return side.end - side.start;
}

/** World point on a side, `out` metres outward from its plane. */
export function sidePoint(side: Side, along: number, y: number, out: number): P3 {
  const perpendicular = side.plane + side.outward * out;
  return side.runAxis === 'x' ? [along, y, perpendicular] : [perpendicular, y, along];
}

/** Outward normal of a side. */
export function sideNormal(side: Side): P3 {
  return side.runAxis === 'x' ? [0, 0, side.outward] : [side.outward, 0, 0];
}

/** Direction of increasing `along`, as a world vector. */
export function sideAlongAxis(side: Side): P3 {
  return side.runAxis === 'x' ? [1, 0, 0] : [0, 0, 1];
}

/** A side shifted outward, e.g. the front plane of a projecting bay. */
export function shiftSide(side: Side, out: number, start = side.start, end = side.end): Side {
  return { ...side, plane: side.plane + side.outward * out, start, end };
}

/** Face bits for `sideBox`, expressed in the side's own frame. */
export const SF = {
  FRONT: 1,
  BACK: 2,
  TOP: 4,
  BOTTOM: 8,
  START: 16,
  END: 32,
  ALL: 63,
  NO_BACK: 63 & ~2,
  /** Everything the street can see of a band that dies into the wall. */
  BAND: 1 | 4 | 8 | 16 | 32,
} as const;

function worldFaces(side: Side, flags: number): number {
  let out = 0;
  const positive = side.outward > 0;
  if (side.runAxis === 'x') {
    if (flags & SF.FRONT) out |= positive ? FACE.PZ : FACE.NZ;
    if (flags & SF.BACK) out |= positive ? FACE.NZ : FACE.PZ;
    if (flags & SF.START) out |= FACE.NX;
    if (flags & SF.END) out |= FACE.PX;
  } else {
    if (flags & SF.FRONT) out |= positive ? FACE.PX : FACE.NX;
    if (flags & SF.BACK) out |= positive ? FACE.NX : FACE.PX;
    if (flags & SF.START) out |= FACE.NZ;
    if (flags & SF.END) out |= FACE.PZ;
  }
  if (flags & SF.TOP) out |= FACE.PY;
  if (flags & SF.BOTTOM) out |= FACE.NY;
  return out;
}

/** A box described in a side's frame: along `a0..a1`, up `y0..y1`, out `out0..out1`. */
export function sideBox(
  writer: MeshWriter,
  key: MaterialKey,
  side: Side,
  a0: number,
  a1: number,
  y0: number,
  y1: number,
  out0: number,
  out1: number,
  flags: number = SF.ALL,
): void {
  const p0 = side.plane + side.outward * out0;
  const p1 = side.plane + side.outward * out1;
  const faces = worldFaces(side, flags);
  if (side.runAxis === 'x') writer.box(key, a0, y0, p0, a1, y1, p1, faces);
  else writer.box(key, p0, y0, a0, p1, y1, a1, faces);
}

/** A flat rectangle on a side plane, facing outward. */
export function sideQuad(
  writer: MeshWriter,
  key: MaterialKey,
  side: Side,
  a0: number,
  a1: number,
  y0: number,
  y1: number,
  out: number,
): void {
  if (a1 - a0 < 1e-5 || y1 - y0 < 1e-5) return;
  writer.quadFacing(
    key,
    sidePoint(side, a0, y0, out),
    sidePoint(side, a1, y0, out),
    sidePoint(side, a1, y1, out),
    sidePoint(side, a0, y1, out),
    sideNormal(side),
  );
}

// ---------------------------------------------------------------------------
// Punched walls
// ---------------------------------------------------------------------------

/** A rectangular hole in a wall panel, in the side's along/up frame. */
export interface Opening {
  /** Centre of the hole along the wall run. */
  readonly along: number;
  readonly half: number;
  readonly y0: number;
  readonly y1: number;
}

export function openingAt(along: number, width: number, y0: number, y1: number): Opening {
  return { along, half: width * 0.5, y0, y1 };
}

/**
 * A flat wall with real holes in it.
 *
 * The panel is sliced into horizontal strips at every opening edge, and each
 * strip is emitted as the run of solid wall left between the openings that
 * cross it. Openings may sit at different heights and different sizes, which is
 * what lets a ground floor carry a shopfront, a door and a vent in one pass.
 */
export function punchedPanel(
  writer: MeshWriter,
  key: MaterialKey,
  side: Side,
  a0: number,
  a1: number,
  y0: number,
  y1: number,
  out: number,
  openings: readonly Opening[],
): void {
  if (a1 - a0 < 1e-5 || y1 - y0 < 1e-5) return;

  const levels: number[] = [y0, y1];
  for (const hole of openings) {
    if (hole.y0 > y0 + 1e-4 && hole.y0 < y1 - 1e-4) levels.push(hole.y0);
    if (hole.y1 > y0 + 1e-4 && hole.y1 < y1 - 1e-4) levels.push(hole.y1);
  }
  levels.sort((p, q) => p - q);

  for (let i = 0; i < levels.length - 1; i += 1) {
    const stripLow = levels[i] ?? y0;
    const stripHigh = levels[i + 1] ?? y1;
    if (stripHigh - stripLow < 1e-4) continue;
    const mid = (stripLow + stripHigh) * 0.5;

    const cuts: { from: number; to: number }[] = [];
    for (const hole of openings) {
      if (hole.y0 >= mid || hole.y1 <= mid) continue;
      const from = hole.along - hole.half;
      const to = hole.along + hole.half;
      if (to <= a0 + 1e-4 || from >= a1 - 1e-4) continue;
      cuts.push({ from, to });
    }
    cuts.sort((p, q) => p.from - q.from);

    let cursor = a0;
    for (const cut of cuts) {
      if (cut.to <= cursor) continue;
      if (cut.from - cursor > 1e-4) sideQuad(writer, key, side, cursor, cut.from, stripLow, stripHigh, out);
      cursor = Math.max(cursor, cut.to);
      if (cursor >= a1) break;
    }
    if (a1 - cursor > 1e-4) sideQuad(writer, key, side, cursor, a1, stripLow, stripHigh, out);
  }
}

/**
 * The inside faces of an opening: two jambs, a head and optionally a sill.
 * They are what makes a window read as a hole punched through a wall of real
 * thickness rather than a rectangle painted onto it.
 */
export function revealFor(
  writer: MeshWriter,
  key: MaterialKey,
  side: Side,
  hole: Opening,
  out: number,
  depth: number,
  withSill = true,
): void {
  const a0 = hole.along - hole.half;
  const a1 = hole.along + hole.half;
  const back = out - depth;
  const along = sideAlongAxis(side);
  const inward: P3 = [along[0], 0, along[2]];
  const outward: P3 = [-along[0], 0, -along[2]];

  // Jambs face each other across the opening.
  writer.quadFacing(
    key,
    sidePoint(side, a0, hole.y0, out),
    sidePoint(side, a0, hole.y0, back),
    sidePoint(side, a0, hole.y1, back),
    sidePoint(side, a0, hole.y1, out),
    inward,
  );
  writer.quadFacing(
    key,
    sidePoint(side, a1, hole.y0, out),
    sidePoint(side, a1, hole.y0, back),
    sidePoint(side, a1, hole.y1, back),
    sidePoint(side, a1, hole.y1, out),
    outward,
  );
  // Head, seen from below.
  writer.quadFacing(
    key,
    sidePoint(side, a0, hole.y1, out),
    sidePoint(side, a1, hole.y1, out),
    sidePoint(side, a1, hole.y1, back),
    sidePoint(side, a0, hole.y1, back),
    [0, -1, 0],
  );
  if (withSill) {
    writer.quadFacing(
      key,
      sidePoint(side, a0, hole.y0, out),
      sidePoint(side, a1, hole.y0, out),
      sidePoint(side, a1, hole.y0, back),
      sidePoint(side, a0, hole.y0, back),
      [0, 1, 0],
    );
  }
}

export interface WindowStyle {
  readonly glass: MaterialKey;
  readonly frame: MaterialKey;
  /** How far the glazing sits behind the wall face. */
  readonly reveal: number;
  /** Width of the frame members. */
  readonly bar: number;
  /** Material lining the reveal; usually the wall itself. */
  readonly lining: MaterialKey;
}

/**
 * A complete window: reveal, frame ring and glazing. Nine quads, eighteen
 * triangles, and it holds up when the player stands two metres away.
 */
export function windowInsert(
  writer: MeshWriter,
  side: Side,
  hole: Opening,
  out: number,
  style: WindowStyle,
): void {
  if (hole.half <= 0.05 || hole.y1 - hole.y0 <= 0.1) return;
  revealFor(writer, style.lining, side, hole, out, style.reveal);

  const back = out - style.reveal;
  const a0 = hole.along - hole.half;
  const a1 = hole.along + hole.half;
  const bar = Math.min(style.bar, hole.half * 0.6, (hole.y1 - hole.y0) * 0.3);

  sideQuad(writer, style.frame, side, a0, a1, hole.y0, hole.y0 + bar, back);
  sideQuad(writer, style.frame, side, a0, a1, hole.y1 - bar, hole.y1, back);
  sideQuad(writer, style.frame, side, a0, a0 + bar, hole.y0 + bar, hole.y1 - bar, back);
  sideQuad(writer, style.frame, side, a1 - bar, a1, hole.y0 + bar, hole.y1 - bar, back);
  sideQuad(
    writer,
    style.glass,
    side,
    a0 + bar,
    a1 - bar,
    hole.y0 + bar,
    hole.y1 - bar,
    back - 0.03,
  );
}

// ---------------------------------------------------------------------------
// Rhythm
// ---------------------------------------------------------------------------

/**
 * Window centres along one elevation.
 *
 * Openings are spread evenly through the run rather than laid on an absolute
 * grid, so a 9 m and a 14 m frontage in the same terrace both come out looking
 * deliberate, and the same centres are reused on every storey so the building
 * lines up vertically the way a real one does.
 */
export function rhythm(span: number, module: number, margin: number, maxCount = 16): number[] {
  const usable = span - margin * 2;
  if (usable < module * 0.55) return span > 1.8 ? [span * 0.5] : [];
  const count = Math.min(maxCount, Math.max(1, Math.round(usable / module)));
  const pitch = usable / count;
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) out.push(margin + pitch * (i + 0.5));
  return out;
}

// ---------------------------------------------------------------------------
// Shared façade furniture
// ---------------------------------------------------------------------------

/** A projecting stone or concrete sill under a window. */
export function stoneSill(
  writer: MeshWriter,
  key: MaterialKey,
  side: Side,
  hole: Opening,
  out: number,
  projection = 0.09,
): void {
  sideBox(
    writer,
    key,
    side,
    hole.along - hole.half - 0.09,
    hole.along + hole.half + 0.09,
    hole.y0 - 0.1,
    hole.y0,
    -0.02,
    out + projection,
    SF.BAND,
  );
}

/** Timber shutters folded back against the wall either side of an opening. */
export function shutters(
  writer: MeshWriter,
  key: MaterialKey,
  side: Side,
  hole: Opening,
  out: number,
): void {
  const leaf = Math.min(0.42, hole.half * 0.85);
  sideBox(
    writer,
    key,
    side,
    hole.along - hole.half - leaf,
    hole.along - hole.half - 0.02,
    hole.y0 + 0.03,
    hole.y1 - 0.03,
    out,
    out + 0.05,
    SF.NO_BACK,
  );
  sideBox(
    writer,
    key,
    side,
    hole.along + hole.half + 0.02,
    hole.along + hole.half + leaf,
    hole.y0 + 0.03,
    hole.y1 - 0.03,
    out,
    out + 0.05,
    SF.NO_BACK,
  );
}

/** A half-drawn blind sitting inside the reveal. */
export function blind(
  writer: MeshWriter,
  key: MaterialKey,
  side: Side,
  hole: Opening,
  out: number,
  reveal: number,
  drop: number,
): void {
  const top = hole.y1 - 0.05;
  const bottom = Math.max(hole.y0 + 0.1, top - (hole.y1 - hole.y0) * drop);
  sideQuad(writer, key, side, hole.along - hole.half + 0.06, hole.along + hole.half - 0.06, bottom, top, out - reveal + 0.02);
}

/**
 * A run of balusters between two rails. Used for balconies, stoops and fire
 * escapes; three balusters is enough to read as ironwork from the pavement and
 * cheap enough to afford on every balcony in the old quarter.
 */
export function balustrade(
  writer: MeshWriter,
  key: MaterialKey,
  side: Side,
  a0: number,
  a1: number,
  y0: number,
  out: number,
  height = 1.02,
  balusters = 3,
): void {
  const top = y0 + height;
  sideBox(writer, key, side, a0, a1, top - 0.07, top, out - 0.05, out + 0.03, SF.ALL);
  sideBox(writer, key, side, a0, a1, y0 + 0.06, y0 + 0.12, out - 0.04, out + 0.01, SF.ALL);
  const span = a1 - a0;
  for (let i = 0; i < balusters; i += 1) {
    const centre = a0 + (span * (i + 1)) / (balusters + 1);
    sideBox(
      writer,
      key,
      side,
      centre - 0.025,
      centre + 0.025,
      y0 + 0.1,
      top - 0.06,
      out - 0.035,
      out + 0.005,
      SF.FRONT | SF.BACK | SF.START | SF.END,
    );
  }
  // End posts carry the rail into the wall.
  sideBox(writer, key, side, a0, a0 + 0.06, y0, top, out - 0.05, out + 0.02, SF.NO_BACK);
  sideBox(writer, key, side, a1 - 0.06, a1, y0, top, out - 0.05, out + 0.02, SF.NO_BACK);
}

/** A canvas awning over a shopfront: sloping cloth, a valance and two cheeks. */
export function awning(
  writer: MeshWriter,
  key: MaterialKey,
  side: Side,
  a0: number,
  a1: number,
  yHigh: number,
  projection: number,
): void {
  const yLow = yHigh - 0.5;
  const outer = projection;
  const topBack = sidePoint(side, a0, yHigh, 0.02);
  const topBackEnd = sidePoint(side, a1, yHigh, 0.02);
  const frontEnd = sidePoint(side, a1, yLow, outer);
  const front = sidePoint(side, a0, yLow, outer);
  writer.quadFacing(key, topBack, topBackEnd, frontEnd, front, [0, 1, 0]);

  // Valance hanging off the front edge.
  const shifted = shiftSide(side, outer, a0, a1);
  sideQuad(writer, key, shifted, a0, a1, yLow - 0.28, yLow, 0);

  const normal = sideNormal(side);
  const cheek: P3 = [normal[0], 0, normal[2]];
  writer.triFacing(key, sidePoint(side, a0, yHigh, 0.02), sidePoint(side, a0, yLow, outer), sidePoint(side, a0, yLow, 0.02), cheek);
  writer.triFacing(key, sidePoint(side, a1, yHigh, 0.02), sidePoint(side, a1, yLow, outer), sidePoint(side, a1, yLow, 0.02), cheek);
}

/** A vertical downpipe on a party line, with two wall brackets. */
export function downpipe(
  writer: MeshWriter,
  key: MaterialKey,
  side: Side,
  along: number,
  y0: number,
  y1: number,
): void {
  const centre = sidePoint(side, along, 0, 0.08);
  writer.tube(key, centre[0], centre[2], y0, y1, 0.055, 6);
  for (const y of [y0 + (y1 - y0) * 0.32, y0 + (y1 - y0) * 0.72]) {
    sideBox(writer, key, side, along - 0.07, along + 0.07, y, y + 0.06, 0, 0.14, SF.NO_BACK);
  }
}
