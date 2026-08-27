/**
 * Street surfaces: carriageway, kerb, gutter, pavement, markings and the
 * ground inside every block.
 *
 * THE GROUND CONTRACT. `CityGround.sample()` is the walkable surface and this
 * module draws what the player sees, so the two have to agree exactly or the
 * player floats and sinks. `sample()` reduces to two rules inside the grid:
 *
 *     carriageway  y = landElevation(x, z)
 *     everything else (pavement, kerb top, block interior)
 *                  y = landElevation(x, z) + KERB_HEIGHT
 *
 * Nothing is flattened, so every quad here takes its corner heights from
 * `landElevation` directly and the surface follows the terrain by construction.
 * The only deliberate departures are the 0.012 m lift under road markings, the
 * 0.15 m kerb riser itself, and the dropped-kerb ramps at crossings - all of
 * them inside a 0.55 m band of the kerb line, which is where `sample()` is
 * discontinuous anyway.
 *
 * THE INTERSECTION RULE. A street never draws across a junction. For every
 * crossing street it removes that street's corridor from its own run, and
 * `buildIntersections` draws each junction footprint exactly once. The two
 * decompositions are complementary by construction - the interval a street
 * removes is precisely the region the junction adds - so there is no hole to
 * fall through and no double-drawn quad to z-fight.
 */

import { BufferAttribute, BufferGeometry, Matrix4 } from 'three';

import { hash2 } from '../../core/rng';
import type { MaterialKey } from '../../render/materials';
import {
  blockAprons,
  blockSurfaceY,
  corridorHalfWidth,
  courtyardSurfaceAt,
  KERB_HEIGHT,
  type CityBlock,
  type CityPlan,
  type Street,
} from '../CityPlan';
import { landElevation } from '../elevation';
import type { GeometrySink } from './types';

// --- Street grammar, in metres. Values come from docs/art-direction.md. ------

/** Carriageway tessellation along the run. */
const RUN_STEP = 4;
/** Pavement slab module. Scored concrete panels are 1.5 m square. */
const PANEL = 1.5;
/** Boardwalk plank group pitch; planks run across the walk. */
const PLANK = 0.75;
/** Gutter channel alongside the kerb, in a darker asphalt. */
const GUTTER = 0.3;
/** Width of the kerb stone's top face. */
const KERB_BAND = 0.16;
/** Road markings are painted this far above the asphalt they sit on. */
const MARKING_LIFT = 0.012;
/** Dropped-kerb apron: how far the ramp reaches back into the gutter. */
const KERB_RAMP = 0.5;
/** Polished wheel paths: 0.9 m wide, centred 0.9 m either side of the lane axis. */
const WHEEL_INNER = 0.45;
const WHEEL_OUTER = 1.35;
/** Dash geometry: 3 m painted, 9 m gap, 0.12 m wide. */
const DASH_LENGTH = 3;
const DASH_PITCH = 12;
const DASH_HALF_WIDTH = 0.06;
/** Double yellow: two 0.10 m lines with a 0.10 m gap. */
const YELLOW_INNER = 0.05;
const YELLOW_OUTER = 0.15;
/** Zebra bars are 0.6 m wide at 0.6 m gaps; stop bars are 0.6 m deep. */
const ZEBRA_BAR = 0.6;
const ZEBRA_PITCH = 1.2;
const STOP_BAR = 0.6;
/** Kerb inlets sit in the gutter every 40-60 m. */
const DRAIN_MIN_GAP = 40;
const DRAIN_GAP_RANGE = 20;
/** Street trees on the arterials, in gravel pits set into the pavement. */
const TREE_PIT_SPACING = 21;

const EPS = 1e-6;

// ---------------------------------------------------------------------------
// Geometry accumulation
// ---------------------------------------------------------------------------

interface KeyBuffer {
  readonly position: number[];
  readonly normal: number[];
  readonly uv: number[];
  readonly index: number[];
}

/**
 * Batches quads by material key so a whole street leaves the builder as a
 * handful of geometries rather than thousands. Shared with `PropScatter`,
 * which needs the same primitive for catenary cables.
 */
export class SurfaceBuffer {
  private readonly byKey = new Map<MaterialKey, KeyBuffer>();

  private bufferFor(key: MaterialKey): KeyBuffer {
    const existing = this.byKey.get(key);
    if (existing) return existing;
    const created: KeyBuffer = { position: [], normal: [], uv: [], index: [] };
    this.byKey.set(key, created);
    return created;
  }

  /** Adds a quad a-b-c-d. Winding decides the facing; normals are flat. */
  quad(
    key: MaterialKey,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
    dx: number,
    dy: number,
    dz: number,
  ): void {
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = dx - ax;
    const vy = dy - ay;
    const vz = dz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length > EPS) {
      nx /= length;
      ny /= length;
      nz /= length;
    } else {
      nx = 0;
      ny = 1;
      nz = 0;
    }

    const buffer = this.bufferFor(key);
    const base = buffer.position.length / 3;
    buffer.position.push(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz);
    for (let i = 0; i < 4; i += 1) buffer.normal.push(nx, ny, nz);
    // World-space planar UVs keep any future tiling texture continuous across
    // quads of different sizes without an unwrap step.
    buffer.uv.push(ax, az, bx, bz, cx, cz, dx, dz);
    buffer.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /**
   * An upward-facing quad over the world rect, with each corner sampled from
   * the terrain so the surface follows the ground.
   */
  top(key: MaterialKey, x0: number, z0: number, x1: number, z1: number, lift: number): void {
    this.quad(
      key,
      x0,
      landElevation(x0, z0) + lift,
      z0,
      x0,
      landElevation(x0, z1) + lift,
      z1,
      x1,
      landElevation(x1, z1) + lift,
      z1,
      x1,
      landElevation(x1, z0) + lift,
      z0,
    );
  }

  /**
   * A vertical strip from A to B. The face is wound so its normal is
   * `(-dz, 0, dx)` for direction `(dx, dz)`, i.e. 90 degrees to the left of
   * travel - which is how every kerb in this module chooses its facing.
   */
  riser(
    key: MaterialKey,
    xA: number,
    zA: number,
    xB: number,
    zB: number,
    liftLow: number,
    liftHigh: number,
  ): void {
    const yA = landElevation(xA, zA);
    const yB = landElevation(xB, zB);
    this.quad(
      key,
      xA,
      yA + liftLow,
      zA,
      xB,
      yB + liftLow,
      zB,
      xB,
      yB + liftHigh,
      zB,
      xA,
      yA + liftHigh,
      zA,
    );
  }

  get empty(): boolean {
    return this.byKey.size === 0;
  }

  /** Hands every batch to the sink as one geometry per material key. */
  flush(sink: GeometrySink): void {
    for (const [key, buffer] of this.byKey) {
      if (buffer.index.length === 0) continue;
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(buffer.position), 3));
      geometry.setAttribute('normal', new BufferAttribute(new Float32Array(buffer.normal), 3));
      geometry.setAttribute('uv', new BufferAttribute(new Float32Array(buffer.uv), 2));
      const vertices = buffer.position.length / 3;
      const index =
        vertices > 65535 ? new Uint32Array(buffer.index) : new Uint16Array(buffer.index);
      geometry.setIndex(new BufferAttribute(index, 1));
      sink.add(key, geometry);
    }
    this.byKey.clear();
  }
}

/**
 * Splits `[lo, hi]` at every hard break inside it, then subdivides each
 * resulting span so no cell is longer than `step`. Hard breaks are material
 * boundaries - lane edges, kerb lines, alley walls - so putting them in the
 * list is what stops a surface change ever falling inside a quad.
 */
function breaks(
  lo: number,
  hi: number,
  hard: readonly number[],
  step: number | ((mid: number) => number),
): number[] {
  if (hi - lo <= EPS) return [];
  const marks = [lo, hi];
  for (const value of hard) {
    if (value > lo + EPS && value < hi - EPS) marks.push(value);
  }
  marks.sort((a, b) => a - b);

  const out: number[] = [marks[0] as number];
  for (let i = 1; i < marks.length; i += 1) {
    const a = out[out.length - 1] as number;
    const b = marks[i] as number;
    if (b - a <= EPS) continue;
    // A per-span step lets a junction tessellate its carriageway coarsely and
    // its pavement corners on the slab module, in one pass.
    const size = typeof step === 'number' ? step : step((a + b) * 0.5);
    const count = Math.max(1, Math.ceil((b - a) / size - EPS));
    for (let k = 1; k <= count; k += 1) out.push(a + ((b - a) * k) / count);
  }
  return out;
}

/** What a cell is made of. `lift` is added to the terrain height. */
interface CellSurface {
  readonly key: MaterialKey;
  readonly lift: number;
}

/** Fills a world-space rect grid, asking `classify` about each cell's centre. */
function fillGrid(
  buffer: SurfaceBuffer,
  xBreaks: readonly number[],
  zBreaks: readonly number[],
  classify: (x: number, z: number) => CellSurface | null,
): void {
  for (let i = 1; i < xBreaks.length; i += 1) {
    const x0 = xBreaks[i - 1] as number;
    const x1 = xBreaks[i] as number;
    const xc = (x0 + x1) * 0.5;
    for (let j = 1; j < zBreaks.length; j += 1) {
      const z0 = zBreaks[j - 1] as number;
      const z1 = zBreaks[j] as number;
      const cell = classify(xc, (z0 + z1) * 0.5);
      if (cell) buffer.top(cell.key, x0, z0, x1, z1, cell.lift);
    }
  }
}

// ---------------------------------------------------------------------------
// Street frame helpers
//
// A street is described in (across, along) coordinates: `across` is the signed
// perpendicular offset from the centreline, `along` runs from `from` to `to`.
// Every cell is still an axis-aligned world rect, so these two helpers convert
// a cell's bounds into world min/max without any winding special cases.
// ---------------------------------------------------------------------------

interface WorldRect {
  readonly x0: number;
  readonly z0: number;
  readonly x1: number;
  readonly z1: number;
}

function cellRect(street: Street, a0: number, a1: number, l0: number, l1: number): WorldRect {
  if (street.axis === 'x') {
    return { x0: street.position + a0, x1: street.position + a1, z0: l0, z1: l1 };
  }
  return { x0: l0, x1: l1, z0: street.position + a0, z1: street.position + a1 };
}

function laneWidth(street: Street): number {
  return (street.roadHalf * 2) / street.lanes;
}

/** Streets of the other axis that actually meet this one. */
function crossingStreets(street: Street, plan: CityPlan): Street[] {
  const out: Street[] = [];
  for (const other of plan.streets) {
    if (other.axis === street.axis) continue;
    if (other.position < street.from - EPS || other.position > street.to + EPS) continue;
    if (street.position < other.from - EPS || street.position > other.to + EPS) continue;
    out.push(other);
  }
  out.sort((a, b) => a.position - b.position);
  return out;
}

/**
 * The stretches of a street that the street itself draws: its full run minus
 * every junction footprint. Junction footprints are clipped to this street's
 * own run, which is what makes them line up with `buildIntersections`.
 */
export function streetSpans(street: Street, plan: CityPlan): { from: number; to: number }[] {
  const blocked: { from: number; to: number }[] = [];
  for (const other of crossingStreets(street, plan)) {
    const half = corridorHalfWidth(other);
    const from = Math.max(street.from, other.position - half);
    const to = Math.min(street.to, other.position + half);
    if (to - from > EPS) blocked.push({ from, to });
  }
  blocked.sort((a, b) => a.from - b.from);

  const spans: { from: number; to: number }[] = [];
  let cursor = street.from;
  for (const block of blocked) {
    if (block.from - cursor > EPS) spans.push({ from: cursor, to: block.from });
    cursor = Math.max(cursor, block.to);
  }
  if (street.to - cursor > EPS) spans.push({ from: cursor, to: street.to });
  return spans;
}

// ---------------------------------------------------------------------------
// Carriageway wear
// ---------------------------------------------------------------------------

/** True inside one of a lane's two polished wheel paths. */
function onWheelPath(street: Street, across: number): boolean {
  const width = laneWidth(street);
  const inLane = (across + street.roadHalf) % width;
  const fromAxis = Math.abs(inLane - width * 0.5);
  return fromAxis > WHEEL_INNER - EPS && fromAxis < WHEEL_OUTER + EPS;
}

interface Patch {
  readonly from: number;
  readonly to: number;
  readonly acrossFrom: number;
  readonly acrossTo: number;
}

/**
 * Irregular repair patches, roughly one 1.5-4 m patch per 30 m of lane. Each
 * patch snaps to lane boundaries across the road so it never lands half inside
 * a cell, and its ends are fed back into the along-breaks so it reads as a cut
 * rather than a stretch of tessellation.
 */
function repairPatches(street: Street): Patch[] {
  const patches: Patch[] = [];
  const width = laneWidth(street);
  for (let lane = 0; lane < street.lanes; lane += 1) {
    const laneLo = -street.roadHalf + lane * width;
    const laneHi = laneLo + width;
    const laneMid = (laneLo + laneHi) * 0.5;
    for (let start = street.from; start < street.to; start += 30) {
      const seed = hash2(street.position + lane * 3.7, start, 23);
      if (seed > 0.86) continue; // an occasional stretch of lane escapes unpatched
      const from = start + seed * 24;
      const to = from + 1.5 + hash2(start, street.position + lane, 24) * 2.5;
      if (to > street.to) continue;
      const half = hash2(from, laneMid, 25);
      patches.push({
        from,
        to,
        acrossFrom: half < 0.34 ? laneMid : laneLo,
        acrossTo: half > 0.66 ? laneMid : laneHi,
      });
    }
  }
  return patches;
}

function inPatch(patches: readonly Patch[], across: number, along: number): boolean {
  for (const patch of patches) {
    if (
      along > patch.from &&
      along < patch.to &&
      across > patch.acrossFrom &&
      across < patch.acrossTo
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Asphalt tone for one carriageway cell. Wear is carried by the material key
 * rather than by decal quads laid on top, so there is nothing to z-fight and
 * the whole road stays one merged geometry per tone.
 */
function carriagewayKey(
  street: Street,
  patches: readonly Patch[],
  across: number,
  along: number,
): MaterialKey {
  const wheel = onWheelPath(street, across);
  const patched = inPatch(patches, across, along);
  // A patch has to contrast with whatever it was cut into, so it inverts.
  if (patched) return wheel ? 'asphalt' : 'asphaltWorn';
  return wheel ? 'asphaltWorn' : 'asphalt';
}

// ---------------------------------------------------------------------------
// Pavement
// ---------------------------------------------------------------------------

/** Tree pits set into the pavement of the arterials, shared with PropScatter. */
export interface TreePit {
  readonly x: number;
  readonly z: number;
}

export function arterialTreePits(street: Street, plan: CityPlan): TreePit[] {
  if (street.kind !== 'arterial') return [];
  const pits: TreePit[] = [];
  const across = street.roadHalf + KERB_BAND + 0.85;
  for (const span of streetSpans(street, plan)) {
    const first = Math.ceil((span.from + 3) / TREE_PIT_SPACING) * TREE_PIT_SPACING;
    for (let along = first; along < span.to - 3; along += TREE_PIT_SPACING) {
      for (const side of [-1, 1]) {
        // Stagger the two sides so the avenue never reads as a ladder.
        const offset = side > 0 ? 0 : TREE_PIT_SPACING * 0.5;
        const at = along + offset;
        if (at < span.from + 3 || at > span.to - 3) continue;
        const rect = cellRect(street, across * side, across * side, at, at);
        pits.push({ x: rect.x0, z: rect.z0 });
      }
    }
  }
  return pits;
}

function pavementKey(street: Street, x: number, z: number, column: number, row: number): MaterialKey {
  if (street.boardwalk) {
    // Planks run across the walk, so the tone varies along the run only.
    return hash2(row, street.position, 61) < 0.22 ? 'timberDark' : 'boardwalk';
  }
  const worn = hash2(column + x * 0.001, row + z * 0.001, 62);
  return worn < 0.18 ? 'pavementDark' : 'pavement';
}

// ---------------------------------------------------------------------------
// buildStreet
// ---------------------------------------------------------------------------

/**
 * Draws one street: carriageway with wheel-path and repair wear, gutter
 * channels, kerb stones and risers, pavements in scored panels, lane markings
 * and gutter inlets. Junction footprints are left to `buildIntersections`.
 */
export function buildStreet(street: Street, plan: CityPlan, sink: GeometrySink): void {
  const buffer = new SurfaceBuffer();
  const spans = streetSpans(street, plan);
  const half = corridorHalfWidth(street);
  const road = street.roadHalf;
  const patches = repairPatches(street);

  // --- Across-section breaks: lane edges, lane axes, wheel paths, gutter, kerb.
  const hardAcross: number[] = [0, -road, road, -(road - GUTTER), road - GUTTER];
  const width = laneWidth(street);
  for (let i = 0; i <= street.lanes; i += 1) hardAcross.push(-road + i * width);
  for (let i = 0; i < street.lanes; i += 1) {
    const axis = -road + (i + 0.5) * width;
    hardAcross.push(axis);
    for (const delta of [-WHEEL_OUTER, -WHEEL_INNER, WHEEL_INNER, WHEEL_OUTER]) {
      const value = axis + delta;
      if (value > -road + GUTTER && value < road - GUTTER) hardAcross.push(value);
    }
  }
  const carriagewayAcross = breaks(-(road + KERB_BAND), road + KERB_BAND, hardAcross, RUN_STEP);

  // --- Pavement panel columns, one strip per side.
  const walkWidth = half - road - KERB_BAND;
  const columns = Math.max(1, Math.round(walkWidth / PANEL));
  const pits = arterialTreePits(street, plan);

  for (const span of spans) {
    // Repair-patch ends become along-breaks so a patch is a cut, not a tile.
    const hardAlong: number[] = [];
    for (const patch of patches) {
      if (patch.from > span.from && patch.from < span.to) hardAlong.push(patch.from);
      if (patch.to > span.from && patch.to < span.to) hardAlong.push(patch.to);
    }
    const roadAlong = breaks(span.from, span.to, hardAlong, RUN_STEP);

    // Carriageway, gutters and kerb stones.
    for (let i = 1; i < carriagewayAcross.length; i += 1) {
      const a0 = carriagewayAcross[i - 1] as number;
      const a1 = carriagewayAcross[i] as number;
      const ac = (a0 + a1) * 0.5;
      const absAcross = Math.abs(ac);
      for (let j = 1; j < roadAlong.length; j += 1) {
        const l0 = roadAlong[j - 1] as number;
        const l1 = roadAlong[j] as number;
        const rect = cellRect(street, a0, a1, l0, l1);
        if (absAcross > road) {
          buffer.top('kerb', rect.x0, rect.z0, rect.x1, rect.z1, KERB_HEIGHT);
        } else if (absAcross > road - GUTTER) {
          buffer.top('asphaltWorn', rect.x0, rect.z0, rect.x1, rect.z1, 0);
        } else {
          const key = carriagewayKey(street, patches, ac, (l0 + l1) * 0.5);
          buffer.top(key, rect.x0, rect.z0, rect.x1, rect.z1, 0);
        }
      }
    }

    // Kerb risers. Wound to face the carriageway on both sides.
    for (let j = 1; j < roadAlong.length; j += 1) {
      const l0 = roadAlong[j - 1] as number;
      const l1 = roadAlong[j] as number;
      const east = cellRect(street, road, road, l0, l1);
      const west = cellRect(street, -road, -road, l0, l1);
      if (street.axis === 'x') {
        buffer.riser('kerb', east.x0, east.z0, east.x1, east.z1, 0, KERB_HEIGHT);
        buffer.riser('kerb', west.x0, west.z1, west.x1, west.z0, 0, KERB_HEIGHT);
      } else {
        buffer.riser('kerb', east.x1, east.z0, east.x0, east.z1, 0, KERB_HEIGHT);
        buffer.riser('kerb', west.x0, west.z0, west.x1, west.z1, 0, KERB_HEIGHT);
      }
    }

    // Pavements, on their own finer panel grid.
    if (walkWidth > EPS) {
      const step = street.boardwalk ? PLANK : PANEL;
      const walkAlong = breaks(span.from, span.to, [], step);
      for (const side of [-1, 1]) {
        for (let c = 0; c < columns; c += 1) {
          const inner = (road + KERB_BAND + (walkWidth * c) / columns) * side;
          const outer = (road + KERB_BAND + (walkWidth * (c + 1)) / columns) * side;
          for (let j = 1; j < walkAlong.length; j += 1) {
            const l0 = walkAlong[j - 1] as number;
            const l1 = walkAlong[j] as number;
            const rect = cellRect(street, Math.min(inner, outer), Math.max(inner, outer), l0, l1);
            const key = pitInCell(pits, rect)
              ? 'gravel'
              : pavementKey(street, rect.x0, rect.z0, c * side, j);
            buffer.top(key, rect.x0, rect.z0, rect.x1, rect.z1, KERB_HEIGHT);
          }
        }
      }
    }
  }

  buildLaneMarkings(buffer, street, spans);
  buffer.flush(sink);
  placeDrains(street, spans, sink);
}

function pitInCell(pits: readonly TreePit[], rect: WorldRect): boolean {
  for (const pit of pits) {
    if (pit.x >= rect.x0 && pit.x <= rect.x1 && pit.z >= rect.z0 && pit.z <= rect.z1) return true;
  }
  return false;
}

/** Centre line, lane dividers. Stop bars and zebras belong to the junctions. */
function buildLaneMarkings(
  buffer: SurfaceBuffer,
  street: Street,
  spans: readonly { from: number; to: number }[],
): void {
  const arterial = street.kind === 'arterial';
  const width = laneWidth(street);

  for (const span of spans) {
    if (arterial) {
      // Double yellow: continuous, so it is tessellated with the run.
      const steps = breaks(span.from, span.to, [], RUN_STEP);
      for (const side of [-1, 1]) {
        for (let j = 1; j < steps.length; j += 1) {
          const l0 = steps[j - 1] as number;
          const l1 = steps[j] as number;
          const rect = cellRect(
            street,
            Math.min(YELLOW_INNER * side, YELLOW_OUTER * side),
            Math.max(YELLOW_INNER * side, YELLOW_OUTER * side),
            l0,
            l1,
          );
          buffer.top('roadPaintYellow', rect.x0, rect.z0, rect.x1, rect.z1, MARKING_LIFT);
        }
      }
    } else {
      dashedLine(buffer, street, span, 0);
    }

    // Interior lane boundaries other than the centre line.
    for (let i = 1; i < street.lanes; i += 1) {
      const across = -street.roadHalf + i * width;
      if (Math.abs(across) < EPS) continue;
      dashedLine(buffer, street, span, across);
    }
  }
}

function dashedLine(
  buffer: SurfaceBuffer,
  street: Street,
  span: { from: number; to: number },
  across: number,
): void {
  // Phase from the street's own origin so dashes stay put across spans.
  const first = Math.ceil((span.from - street.from) / DASH_PITCH) * DASH_PITCH + street.from;
  for (let at = first; at + DASH_LENGTH <= span.to; at += DASH_PITCH) {
    if (at < span.from) continue;
    const rect = cellRect(
      street,
      across - DASH_HALF_WIDTH,
      across + DASH_HALF_WIDTH,
      at,
      at + DASH_LENGTH,
    );
    buffer.top('roadPaint', rect.x0, rect.z0, rect.x1, rect.z1, MARKING_LIFT);
  }
}

/** Kerb inlets, one in each gutter, every 40-60 m along the run. */
function placeDrains(
  street: Street,
  spans: readonly { from: number; to: number }[],
  sink: GeometrySink,
): void {
  const matrix = new Matrix4();
  const across = street.roadHalf - GUTTER * 0.5;
  // The grate's long axis is X in prop space, so an x-axis street turns it.
  const yaw = street.axis === 'x' ? Math.PI * 0.5 : 0;
  let at = street.from + 14;
  while (at < street.to) {
    const gap = DRAIN_MIN_GAP + hash2(street.position, at, 31) * DRAIN_GAP_RANGE;
    if (spans.some((span) => at > span.from + 1.5 && at < span.to - 1.5)) {
      // Both gutters drain, so both get an inlet at every low point.
      for (const side of [-1, 1]) {
        const rect = cellRect(street, across * side, across * side, at, at);
        matrix.makeRotationY(yaw);
        matrix.setPosition(rect.x0, landElevation(rect.x0, rect.z0), rect.z0);
        sink.instance('drainGrate', matrix);
      }
    }
    at += gap;
  }
}

// ---------------------------------------------------------------------------
// buildIntersections
// ---------------------------------------------------------------------------

interface Junction {
  readonly xs: Street;
  readonly zs: Street;
  /** Corridor footprint of the x-axis street. */
  readonly xLo: number;
  readonly xHi: number;
  /** Corridor footprint of the z-axis street. */
  readonly zLo: number;
  readonly zHi: number;
  /** Footprint clipped to where the crossing street actually exists. */
  readonly xLoC: number;
  readonly xHiC: number;
  readonly zLoS: number;
  readonly zHiS: number;
  readonly crossings: boolean;
}

/** Where two corridors cross. Shared with the scatterer, which signs them. */
export interface Crossing {
  readonly x: number;
  readonly z: number;
  readonly xs: Street;
  readonly zs: Street;
}

export function cityCrossings(plan: CityPlan): Crossing[] {
  return junctionsOf(plan).map((junction) => ({
    x: junction.xs.position,
    z: junction.zs.position,
    xs: junction.xs,
    zs: junction.zs,
  }));
}

function junctionsOf(plan: CityPlan): Junction[] {
  const out: Junction[] = [];
  for (const xs of plan.streets) {
    if (xs.axis !== 'x') continue;
    for (const zs of crossingStreets(xs, plan)) {
      const halfX = corridorHalfWidth(xs);
      const halfZ = corridorHalfWidth(zs);
      const xLo = xs.position - halfX;
      const xHi = xs.position + halfX;
      const zLo = zs.position - halfZ;
      const zHi = zs.position + halfZ;
      out.push({
        xs,
        zs,
        xLo,
        xHi,
        zLo,
        zHi,
        xLoC: Math.max(xLo, zs.from),
        xHiC: Math.min(xHi, zs.to),
        zLoS: Math.max(zLo, xs.from),
        zHiS: Math.min(zHi, xs.to),
        // Every approach on an arterial or the promenade is marked; elsewhere
        // about half the junctions get a crossing, which is what stops the grid
        // reading as a uniformly signed lattice.
        crossings:
          xs.kind === 'arterial' ||
          zs.kind === 'arterial' ||
          xs.kind === 'promenade' ||
          hash2(xs.position, zs.position, 41) < 0.5,
      });
    }
  }
  return out;
}

/** Mirrors `CityGround.sample`: on a carriageway if either street says so. */
function onCarriageway(junction: Junction, x: number, z: number): boolean {
  const { xs, zs } = junction;
  const onX =
    Math.abs(x - xs.position) <= xs.roadHalf + EPS && z >= xs.from - EPS && z <= xs.to + EPS;
  if (onX) return true;
  return Math.abs(z - zs.position) <= zs.roadHalf + EPS && x >= zs.from - EPS && x <= zs.to + EPS;
}

/**
 * `CityGround` picks the nearest centreline to decide whether a pavement is
 * decking or slabs, so a junction corner has to make the same choice.
 */
function junctionWalkKey(junction: Junction, x: number, z: number): MaterialKey {
  const nearer =
    Math.abs(x - junction.xs.position) <= Math.abs(z - junction.zs.position)
      ? junction.xs
      : junction.zs;
  return pavementKey(nearer, x, z, Math.round(x / PANEL), Math.round(z / PANEL));
}

/** True on the kerb stone itself: the band just outside a carriageway edge. */
function onKerbBand(junction: Junction, x: number, z: number): boolean {
  const { xs, zs } = junction;
  const outX = Math.abs(x - xs.position) - xs.roadHalf;
  if (outX > 0 && outX < KERB_BAND && z >= xs.from - EPS && z <= xs.to + EPS) return true;
  const outZ = Math.abs(z - zs.position) - zs.roadHalf;
  return outZ > 0 && outZ < KERB_BAND && x >= zs.from - EPS && x <= zs.to + EPS;
}

/**
 * Fills every junction exactly once.
 *
 * The footprint is decomposed into three disjoint rectangles: the band the
 * x-axis street owns across its full corridor, plus the two stubs where the
 * z-axis street's corridor runs past the end of it. That decomposition is the
 * exact complement of the intervals `streetSpans` removes, so the union of
 * streets and junctions covers the grid with no hole and no overlap.
 */
export function buildIntersections(plan: CityPlan, sink: GeometrySink): void {
  const buffer = new SurfaceBuffer();

  for (const junction of junctionsOf(plan)) {
    const { xs, zs } = junction;
    const hardX = [
      xs.position - xs.roadHalf,
      xs.position + xs.roadHalf,
      xs.position - xs.roadHalf - KERB_BAND,
      xs.position + xs.roadHalf + KERB_BAND,
      zs.from,
      zs.to,
    ];
    const hardZ = [
      zs.position - zs.roadHalf,
      zs.position + zs.roadHalf,
      zs.position - zs.roadHalf - KERB_BAND,
      zs.position + zs.roadHalf + KERB_BAND,
      xs.from,
      xs.to,
    ];

    const regions: WorldRect[] = [
      { x0: junction.xLo, x1: junction.xHi, z0: junction.zLoS, z1: junction.zHiS },
    ];
    if (junction.zLoS - junction.zLo > EPS) {
      regions.push({ x0: junction.xLoC, x1: junction.xHiC, z0: junction.zLo, z1: junction.zLoS });
    }
    if (junction.zHi - junction.zHiS > EPS) {
      regions.push({ x0: junction.xLoC, x1: junction.xHiC, z0: junction.zHiS, z1: junction.zHi });
    }

    // Carriageway spans are tessellated on the road module, corner spans on the
    // slab module: a junction is mostly asphalt, and paying slab resolution for
    // all of it is where the triangle budget quietly disappears.
    const xStep = (mid: number): number =>
      Math.abs(mid - xs.position) < xs.roadHalf ? RUN_STEP : PANEL;
    const zStep = (mid: number): number =>
      Math.abs(mid - zs.position) < zs.roadHalf ? RUN_STEP : PANEL;

    for (const region of regions) {
      if (region.x1 - region.x0 <= EPS || region.z1 - region.z0 <= EPS) continue;
      const xBreaks = breaks(region.x0, region.x1, hardX, xStep);
      const zBreaks = breaks(region.z0, region.z1, hardZ, zStep);
      fillGrid(buffer, xBreaks, zBreaks, (x, z) => {
        if (onCarriageway(junction, x, z)) {
          // Junctions are the most driven-over asphalt in the city.
          return { key: hash2(x, z, 43) < 0.34 ? 'asphaltWorn' : 'asphalt', lift: 0 };
        }
        if (onKerbBand(junction, x, z)) return { key: 'kerb', lift: KERB_HEIGHT };
        return { key: junctionWalkKey(junction, x, z), lift: KERB_HEIGHT };
      });
    }

    buildJunctionKerbs(buffer, junction);
    buildJunctionMarkings(buffer, junction);
  }

  buffer.flush(sink);
}

/**
 * Kerb stones and risers around a junction. At a crossing the riser is
 * replaced by a flared apron that ramps out of the gutter, which is what a
 * dropped kerb actually looks like from the road.
 */
function buildJunctionKerbs(buffer: SurfaceBuffer, junction: Junction): void {
  const { xs, zs } = junction;

  // Kerb lines parallel to the x-axis street, i.e. running north-south.
  for (const side of [-1, 1]) {
    const x = xs.position + xs.roadHalf * side;
    if (x < junction.xLo - EPS || x > junction.xHi + EPS) continue;
    const crossesHere = x >= zs.from - EPS && x <= zs.to + EPS;
    for (const segment of subtract(
      junction.zLoS,
      junction.zHiS,
      crossesHere ? zs.position - zs.roadHalf : Number.NaN,
      crossesHere ? zs.position + zs.roadHalf : Number.NaN,
    )) {
      emitKerbRun(buffer, junction, x, segment.from, x, segment.to, side > 0 ? 1 : -1, 'x');
    }
  }

  // Kerb lines parallel to the z-axis street, i.e. running east-west.
  for (const side of [-1, 1]) {
    const z = zs.position + zs.roadHalf * side;
    if (z < junction.zLo - EPS || z > junction.zHi + EPS) continue;
    const crossesHere = z >= xs.from - EPS && z <= xs.to + EPS;
    for (const segment of subtract(
      junction.xLoC,
      junction.xHiC,
      crossesHere ? xs.position - xs.roadHalf : Number.NaN,
      crossesHere ? xs.position + xs.roadHalf : Number.NaN,
    )) {
      emitKerbRun(buffer, junction, segment.from, z, segment.to, z, side > 0 ? 1 : -1, 'z');
    }
  }
}

/** `[lo, hi]` minus `[cutLo, cutHi]`; NaN cuts remove nothing. */
function subtract(
  lo: number,
  hi: number,
  cutLo: number,
  cutHi: number,
): { from: number; to: number }[] {
  if (hi - lo <= EPS) return [];
  if (!Number.isFinite(cutLo) || !Number.isFinite(cutHi)) return [{ from: lo, to: hi }];
  const out: { from: number; to: number }[] = [];
  if (cutLo - lo > EPS) out.push({ from: lo, to: Math.min(cutLo, hi) });
  if (hi - cutHi > EPS) out.push({ from: Math.max(cutHi, lo), to: hi });
  return out.filter((segment) => segment.to - segment.from > EPS);
}

/**
 * One run of kerb along a junction edge. The kerb stone's top face is part of
 * the junction grid, so all this adds is the vertical element: a full riser, or
 * a flared apron where the kerb is dropped for a crossing.
 */
function emitKerbRun(
  buffer: SurfaceBuffer,
  junction: Junction,
  xA: number,
  zA: number,
  xB: number,
  zB: number,
  side: number,
  axis: 'x' | 'z',
): void {
  if (junction.crossings) {
    // Dropped kerb: a flared apron out of the gutter instead of a riser.
    const rampOffset = -KERB_RAMP * side;
    if (axis === 'x') {
      buffer.quad(
        'kerb',
        xA + rampOffset,
        landElevation(xA + rampOffset, zA) + 0.004,
        zA,
        xA + rampOffset,
        landElevation(xA + rampOffset, zB) + 0.004,
        zB,
        xA,
        landElevation(xA, zB) + KERB_HEIGHT,
        zB,
        xA,
        landElevation(xA, zA) + KERB_HEIGHT,
        zA,
      );
    } else {
      buffer.quad(
        'kerb',
        xA,
        landElevation(xA, zA + rampOffset) + 0.004,
        zA + rampOffset,
        xB,
        landElevation(xB, zA + rampOffset) + 0.004,
        zA + rampOffset,
        xB,
        landElevation(xB, zA) + KERB_HEIGHT,
        zA,
        xA,
        landElevation(xA, zA) + KERB_HEIGHT,
        zA,
      );
    }
    return;
  }

  // Full-height riser, wound to face the carriageway.
  if (axis === 'x') {
    if (side > 0) buffer.riser('kerb', xA, zA, xB, zB, 0, KERB_HEIGHT);
    else buffer.riser('kerb', xB, zB, xA, zA, 0, KERB_HEIGHT);
  } else if (side > 0) {
    buffer.riser('kerb', xB, zB, xA, zA, 0, KERB_HEIGHT);
  } else {
    buffer.riser('kerb', xA, zA, xB, zB, 0, KERB_HEIGHT);
  }
}

/** Stop bars on every approach, zebra crossings where the junction has them. */
function buildJunctionMarkings(buffer: SurfaceBuffer, junction: Junction): void {
  const { xs, zs } = junction;

  // Approaches on the x-axis street: bands north and south of the carriageway.
  approach(
    buffer,
    junction,
    { lo: junction.zLoS, hi: zs.position - zs.roadHalf },
    'z',
    xs.position - xs.roadHalf,
    xs.position + xs.roadHalf,
    xs.position - xs.roadHalf,
    xs.position,
  );
  approach(
    buffer,
    junction,
    { lo: zs.position + zs.roadHalf, hi: junction.zHiS },
    'z',
    xs.position - xs.roadHalf,
    xs.position + xs.roadHalf,
    xs.position,
    xs.position + xs.roadHalf,
  );
  // Approaches on the z-axis street: bands west and east of the carriageway.
  approach(
    buffer,
    junction,
    { lo: junction.xLoC, hi: xs.position - xs.roadHalf },
    'x',
    zs.position - zs.roadHalf,
    zs.position + zs.roadHalf,
    zs.position,
    zs.position + zs.roadHalf,
  );
  approach(
    buffer,
    junction,
    { lo: xs.position + xs.roadHalf, hi: junction.xHiC },
    'x',
    zs.position - zs.roadHalf,
    zs.position + zs.roadHalf,
    zs.position - zs.roadHalf,
    zs.position,
  );
}

/**
 * One approach. `band` is the strip between the junction mouth and the outer
 * edge of the corridor - exactly the width of the crossing street's pavement,
 * which is where a crossing belongs. `stopLo`/`stopHi` are the lanes actually
 * approaching, chosen for right-hand traffic.
 */
function approach(
  buffer: SurfaceBuffer,
  junction: Junction,
  band: { lo: number; hi: number },
  bandAxis: 'x' | 'z',
  crossLo: number,
  crossHi: number,
  stopLo: number,
  stopHi: number,
): void {
  const depth = band.hi - band.lo;
  if (depth < 0.9) return;
  // The band runs outward from the junction on one side and inward on the
  // other; `outward` is the end furthest from the junction centre, where the
  // stop bar goes.
  const centre = bandAxis === 'z' ? junction.zs.position : junction.xs.position;
  const outerFirst = Math.abs(band.lo - centre) > Math.abs(band.hi - centre);
  const outer = outerFirst ? band.lo : band.hi;
  const sign = outerFirst ? 1 : -1;

  const strip = (from: number, to: number, key: MaterialKey, lo: number, hi: number): void => {
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    if (bandAxis === 'z') buffer.top(key, lo, a, hi, b, MARKING_LIFT);
    else buffer.top(key, a, lo, b, hi, MARKING_LIFT);
  };

  const stopStart = outer + sign * 0.15;
  strip(stopStart, stopStart + sign * STOP_BAR, 'roadPaint', stopLo, stopHi);

  if (!junction.crossings) return;
  const zebraStart = outer + sign * (0.15 + STOP_BAR + 0.35);
  const available = depth - (0.15 + STOP_BAR + 0.35) - 0.2;
  if (available < 1.2) return;
  const zebraDepth = Math.min(available, 3.0);

  const span = crossHi - crossLo;
  const bars = Math.max(1, Math.floor((span + ZEBRA_BAR) / ZEBRA_PITCH));
  const used = bars * ZEBRA_PITCH - (ZEBRA_PITCH - ZEBRA_BAR);
  const start = crossLo + (span - used) * 0.5;
  for (let i = 0; i < bars; i += 1) {
    const lo = start + i * ZEBRA_PITCH;
    strip(zebraStart, zebraStart + sign * zebraDepth, 'roadPaint', lo, lo + ZEBRA_BAR);
  }
}

// ---------------------------------------------------------------------------
// buildBlockGround
// ---------------------------------------------------------------------------

/**
 * Fills a block's interior at `blockSurfaceY`: gravel courtyards with a paved
 * alley and service aprons, laid plaza stone, or park grass cut by the same
 * gravel paths `CityGround.sample` reports underfoot.
 */
export function buildBlockGround(block: CityBlock, _plan: CityPlan, sink: GeometrySink): void {
  // The airfield platform is a block only so `districtAt` has an answer out
  // there. Its ground belongs to the airport builder, which draws runway,
  // taxiway, apron and grass to their own survey.
  if (block.kind === 'airfield') return;
  const buffer = new SurfaceBuffer();
  const { rect } = block;
  const lift = (x: number, z: number): number => blockSurfaceY(block, x, z) - landElevation(x, z);

  if (block.kind === 'park') {
    buildParkGround(buffer, block, lift);
  } else if (block.kind === 'plaza') {
    buildPlazaGround(buffer, block, lift);
  } else {
    buildCourtyardGround(buffer, block, lift);
  }

  // Guard against an empty emit for a degenerate block.
  if (buffer.empty) {
    buffer.top('gravel', rect.minX, rect.minZ, rect.maxX, rect.maxZ, lift(rect.minX, rect.minZ));
  }
  buffer.flush(sink);
}

function buildCourtyardGround(
  buffer: SurfaceBuffer,
  block: CityBlock,
  lift: (x: number, z: number) => number,
): void {
  const { rect, alley } = block;
  const hardX = alley ? [alley.rect.minX, alley.rect.maxX] : [];
  const hardZ = alley ? [alley.rect.minZ, alley.rect.maxZ] : [];

  // The aprons come from `blockAprons`, which `CityGround.sample` also reads:
  // one table, so the tarmac drawn here is the tarmac heard underfoot.
  for (const apron of blockAprons(rect)) {
    hardX.push(apron.minX, apron.maxX);
    hardZ.push(apron.minZ, apron.maxZ);
  }

  const surfaceKeys: Readonly<Record<'pavement' | 'asphalt' | 'gravel', MaterialKey>> = {
    pavement: 'pavementDark',
    asphalt: 'asphaltWorn',
    gravel: 'gravel',
  };

  const xBreaks = breaks(rect.minX, rect.maxX, hardX, RUN_STEP);
  const zBreaks = breaks(rect.minZ, rect.maxZ, hardZ, RUN_STEP);
  fillGrid(buffer, xBreaks, zBreaks, (x, z) => ({
    key: surfaceKeys[courtyardSurfaceAt(block, x, z)],
    lift: lift(x, z),
  }));
}

function buildPlazaGround(
  buffer: SurfaceBuffer,
  block: CityBlock,
  lift: (x: number, z: number) => number,
): void {
  const { rect } = block;
  const cx = (rect.minX + rect.maxX) * 0.5;
  const cz = (rect.minZ + rect.maxZ) * 0.5;
  const step = 2.0;
  const xBreaks = breaks(rect.minX, rect.maxX, [cx], step);
  const zBreaks = breaks(rect.minZ, rect.maxZ, [cz], step);

  fillGrid(buffer, xBreaks, zBreaks, (x, z) => {
    // Concentric bands laid about the plaza centre, banded 2 m in and 2 m out.
    const ring = Math.max(Math.abs(x - cx), Math.abs(z - cz)) / 3.2;
    const band = Math.floor(ring);
    const key: MaterialKey =
      band % 4 === 3 ? 'pavement' : band % 2 === 0 ? 'plazaStone' : 'pavementDark';
    return { key, lift: lift(x, z) };
  });
}

/**
 * Park ground. The path rule is copied verbatim from `CityGround.sample` and
 * the grid is broken exactly on the path edges, so the gravel the player hears
 * underfoot is the gravel they can see.
 */
function buildParkGround(
  buffer: SurfaceBuffer,
  block: CityBlock,
  lift: (x: number, z: number) => number,
): void {
  const { rect } = block;
  const onPath = (x: number, z: number): boolean =>
    Math.abs(((x - rect.minX) % 26) - 13) < 1.9 || Math.abs(z + 32) < 2.2;

  const hardX: number[] = [];
  for (let k = 0; rect.minX + 11.1 + k * 26 < rect.maxX; k += 1) {
    hardX.push(rect.minX + 11.1 + k * 26, rect.minX + 14.9 + k * 26);
  }
  const hardZ = [-34.2, -29.8];

  const xBreaks = breaks(rect.minX, rect.maxX, hardX, RUN_STEP);
  const zBreaks = breaks(rect.minZ, rect.maxZ, hardZ, RUN_STEP);
  fillGrid(buffer, xBreaks, zBreaks, (x, z) => ({
    key: onPath(x, z) ? 'gravel' : 'grass',
    lift: lift(x, z),
  }));
}
