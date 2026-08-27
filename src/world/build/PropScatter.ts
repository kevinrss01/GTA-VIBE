/**
 * Where the city's small parts actually go.
 *
 * Placement is entirely deterministic - every position comes from the plan or
 * from `hash2` of a world coordinate - so two builds of the same seed produce
 * byte-identical instance lists. Nothing is placed by eye and nothing is placed
 * blindly: every candidate is tested against `CityGround`, which is the same
 * authority the player walks on, so a prop can never end up inside a building,
 * in the bay, on a carriageway or hovering a hand's width above the pavement.
 *
 * The rules that matter, in order of how often they reject a candidate:
 *   1. never inside a building footprint (`isBuilt` with a 0.4 m margin),
 *   2. never on a carriageway or in water,
 *   3. base exactly on `CityGround.sample(x, z).y`,
 *   4. never closer to an existing prop than the two radii allow.
 *
 * Rule 2 also does the junction work for free: a junction's approach bands are
 * carriageway, so nothing lands in the middle of a crossing without a special
 * case for it.
 */

import { Matrix4, Vector3 } from 'three';

import { hash2 } from '../../core/rng';
import type { Rect } from '../../core/mathx';
import { CityGround } from '../CityGround';
import {
  corridorHalfWidth,
  type CityBlock,
  type CityPlan,
  type DistrictId,
  type Street,
} from '../CityPlan';
import { doorApproach, doorwayFor } from './doorway';
import { PROP_SPECS, POLE_CABLE_HEIGHT, POLE_CABLE_OFFSETS } from './PropLibrary';
import { arterialTreePits, cityCrossings, streetSpans, SurfaceBuffer } from './StreetBuilder';
import type { GeometrySink, PropKey } from './types';

// --- Placement rules, in metres. --------------------------------------------

const LAMP_SPACING = 32;
const LAMP_INSET = 0.8;
const LAMP_HEAD_HEIGHT = 4.0;
const POLE_SPACING = 40;
/**
 * A street carries poles when at least this share of the blocks beside it are
 * cannery or old quarter. Measured from the plan rather than hard-coded so a
 * change to the district grid moves the overhead lines with it.
 */
const POLE_DISTRICT_SHARE = 0.4;
const HYDRANT_SPACING = 70;
const BOLLARD_SPACING = 3.5;
const MOORING_SPACING = 12;
/** Promenade cross-section, measured back from the kerb line. */
const PROMENADE_GUARD_INSET = 4.2;
const PROMENADE_SEAT_INSET = 2.3;
/** Sag on a catenary span, and how many segments describe it. */
const CABLE_SAG = 0.6;
const CABLE_SEGMENTS = 8;
const CABLE_RADIUS = 0.028;
/** A prop needs this much clear ground beyond its own footprint. */
const CLEARANCE = 0.25;

/** Yaw that turns a prop's -Z front toward the road it stands beside. */
function facingRoad(street: Street, side: number): number {
  if (street.axis === 'x') return side > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
  return side > 0 ? 0 : Math.PI;
}

/** A point on a street's pavement, `inset` metres back from the kerb line. */
function pavementPoint(
  street: Street,
  along: number,
  side: number,
  inset: number,
): { x: number; z: number } {
  const across = (street.roadHalf + inset) * side;
  if (street.axis === 'x') return { x: street.position + across, z: along };
  return { x: along, z: street.position + across };
}

interface Placed {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
}

/**
 * Moves a position onto the nearest stretch of street the builder actually
 * draws. Junction footprints take up nearly half the length of this grid, so
 * stepping blindly at a fixed spacing would drop half the lamps in the city;
 * a lamp that would land in a junction belongs on the corner instead.
 */
function nudgeIntoSpan(
  spans: readonly { from: number; to: number }[],
  along: number,
  margin = 2.5,
  reach = 16,
): number | null {
  for (const span of spans) {
    if (along > span.from + margin && along < span.to - margin) return along;
  }
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const span of spans) {
    if (span.to - span.from < margin * 2) continue;
    const clamped = Math.min(Math.max(along, span.from + margin), span.to - margin);
    const distance = Math.abs(clamped - along);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = clamped;
    }
  }
  return bestDistance <= reach ? best : null;
}

/**
 * Holds the ground authority, the spacing index and the sink, so every
 * placement rule below is a few lines of intent rather than a pile of checks.
 */
class Scatter {
  readonly ground: CityGround;
  private readonly sink: GeometrySink;
  private readonly matrix = new Matrix4();
  private readonly cells = new Map<number, Placed[]>();
  private count = 0;

  constructor(plan: CityPlan, sink: GeometrySink) {
    this.ground = new CityGround(plan);
    this.sink = sink;
  }

  get placed(): number {
    return this.count;
  }

  private static cellKey(x: number, z: number): number {
    return (Math.floor(x / 6) + 512) * 4096 + (Math.floor(z / 6) + 512);
  }

  private clear(x: number, z: number, radius: number): boolean {
    const cx = Math.floor(x / 6);
    const cz = Math.floor(z / 6);
    for (let i = -1; i <= 1; i += 1) {
      for (let j = -1; j <= 1; j += 1) {
        const bucket = this.cells.get(Scatter.cellKey((cx + i) * 6, (cz + j) * 6));
        if (!bucket) continue;
        for (const other of bucket) {
          if (Math.hypot(other.x - x, other.z - z) < other.radius + radius) return false;
        }
      }
    }
    return true;
  }

  /**
   * Marks ground as taken without putting anything on it. Used to protect
   * doorways, which every scatter rule must route around.
   */
  reserve(x: number, z: number, radius: number): void {
    this.remember(x, z, radius);
  }

  private remember(x: number, z: number, radius: number): void {
    const key = Scatter.cellKey(x, z);
    const bucket = this.cells.get(key);
    if (bucket) bucket.push({ x, z, radius });
    else this.cells.set(key, [{ x, z, radius }]);
  }

  /** True where a prop may stand at all: dry, outdoor, off the carriageway. */
  usable(x: number, z: number): boolean {
    if (!this.ground.isInBounds(x, z)) return false;
    const sample = this.ground.sample(x, z);
    if (sample.onRoad || sample.surface === 'water') return false;
    return !this.ground.isBuilt(x, z, 0.4);
  }

  /**
   * Places one prop. Returns false - without emitting anything - if the ground
   * refuses it, which is what lets the rules below scan optimistically.
   */
  place(prop: PropKey, x: number, z: number, yaw: number): boolean {
    const spec = PROP_SPECS[prop];
    const radius = Math.max(spec.width, spec.depth) * 0.5;
    // Trees and lamps are checked on their trunk, not their canopy.
    const footprint = spec.collider
      ? Math.max(spec.collider.halfX, spec.collider.halfZ)
      : radius;
    if (!this.usable(x, z)) return false;
    if (!this.clear(x, z, footprint + CLEARANCE)) return false;

    const y = this.ground.sample(x, z).y;
    this.matrix.makeRotationY(yaw);
    this.matrix.setPosition(x, y, z);
    this.sink.instance(prop, this.matrix);
    this.remember(x, z, footprint + CLEARANCE);
    this.count += 1;

    const collider = spec.collider;
    if (collider) {
      // Rotated axis-aligned extent of the collision box.
      const cos = Math.abs(Math.cos(yaw));
      const sin = Math.abs(Math.sin(yaw));
      const ex = collider.halfX * cos + collider.halfZ * sin;
      const ez = collider.halfX * sin + collider.halfZ * cos;
      this.sink.collider({
        minX: x - ex,
        maxX: x + ex,
        minZ: z - ez,
        maxZ: z + ez,
        bottom: y,
        top: y + collider.top,
        solid: true,
      });
    }
    return true;
  }

  /** Places a lamp and asks the renderer for its warm pool of light. */
  placeLamp(x: number, z: number, yaw: number): boolean {
    if (!this.place('streetLamp', x, z, yaw)) return false;
    this.sink.light({
      x,
      y: this.ground.sample(x, z).y + LAMP_HEAD_HEIGHT,
      z,
      color: 0xffb86b,
      intensity: 2.2,
      distance: 16,
      priority: 3,
    });
    return true;
  }
}

// ---------------------------------------------------------------------------
// District and street classification
// ---------------------------------------------------------------------------

/** Which districts a street runs through, sampled from the blocks beside it. */
function streetDistricts(street: Street, ground: CityGround): Map<DistrictId, number> {
  const tally = new Map<DistrictId, number>();
  const half = corridorHalfWidth(street) + 2.5;
  for (let along = street.from; along <= street.to; along += 8) {
    for (const side of [-1, 1]) {
      const point = street.axis === 'x'
        ? { x: street.position + half * side, z: along }
        : { x: along, z: street.position + half * side };
      const block = ground.blockAt(point.x, point.z);
      if (!block) continue;
      tally.set(block.district, (tally.get(block.district) ?? 0) + 1);
    }
  }
  return tally;
}

function districtShare(tally: Map<DistrictId, number>, districts: readonly DistrictId[]): number {
  let total = 0;
  let hits = 0;
  for (const [district, count] of tally) {
    total += count;
    if (districts.includes(district)) hits += count;
  }
  return total === 0 ? 0 : hits / total;
}

// ---------------------------------------------------------------------------
// Catenary cables
// ---------------------------------------------------------------------------

/**
 * A sagging cable between two poles, built as a closed three-sided extrusion so
 * it reads from any angle without paying for a double-sided material. This is
 * the single highest-payoff prop detail in the brief: it breaks empty sky and
 * gives the street a foreground overlap wherever the player looks up.
 */
function cable(
  buffer: SurfaceBuffer,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): void {
  const direction = new Vector3(bx - ax, by - ay, bz - az).normalize();
  const right = new Vector3().crossVectors(direction, new Vector3(0, 1, 0));
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  right.normalize();
  const up = new Vector3().crossVectors(right, direction).normalize();

  const angles = [Math.PI * 0.5, Math.PI * 7 / 6, Math.PI * 11 / 6];
  const ring = (t: number): { x: number; y: number; z: number }[] => {
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    const y = ay + (by - ay) * t - CABLE_SAG * 4 * t * (1 - t);
    return angles.map((angle) => ({
      x: x + (right.x * Math.cos(angle) + up.x * Math.sin(angle)) * CABLE_RADIUS,
      y: y + (right.y * Math.cos(angle) + up.y * Math.sin(angle)) * CABLE_RADIUS,
      z: z + (right.z * Math.cos(angle) + up.z * Math.sin(angle)) * CABLE_RADIUS,
    }));
  };

  let previous = ring(0);
  for (let i = 1; i <= CABLE_SEGMENTS; i += 1) {
    const current = ring(i / CABLE_SEGMENTS);
    for (let k = 0; k < 3; k += 1) {
      const p0 = previous[k] as { x: number; y: number; z: number };
      const p1 = previous[(k + 1) % 3] as { x: number; y: number; z: number };
      const c0 = current[k] as { x: number; y: number; z: number };
      const c1 = current[(k + 1) % 3] as { x: number; y: number; z: number };
      buffer.quad('metalDark', p0.x, p0.y, p0.z, c0.x, c0.y, c0.z, c1.x, c1.y, c1.z, p1.x, p1.y, p1.z);
    }
    previous = current;
  }
}

// ---------------------------------------------------------------------------
// Placement rules
// ---------------------------------------------------------------------------

/** Lamps: both sides of the arterials and the promenade, staggered elsewhere. */
function scatterLamps(scatter: Scatter, plan: CityPlan): void {
  for (const street of plan.streets) {
    const bothSides = street.kind === 'arterial' || street.kind === 'promenade';
    const spans = streetSpans(street, plan);
    let index = 0;
    const first = Math.ceil(street.from / LAMP_SPACING) * LAMP_SPACING;
    for (let step = first; step < street.to; step += LAMP_SPACING) {
      const along = nudgeIntoSpan(spans, step);
      index += 1;
      if (along === null) continue;
      const sides = bothSides ? [-1, 1] : [index % 2 === 0 ? 1 : -1];
      for (const side of sides) {
        const point = pavementPoint(street, along, side, LAMP_INSET);
        scatter.placeLamp(point.x, point.z, facingRoad(street, side));
      }
    }
  }
}

/** Poles and their cables, on the cannery and old-quarter streets only. */
function scatterPoles(scatter: Scatter, plan: CityPlan, buffer: SurfaceBuffer): void {
  for (const street of plan.streets) {
    if (street.kind === 'arterial' || street.kind === 'promenade') continue;
    const tally = streetDistricts(street, scatter.ground);
    if (districtShare(tally, ['cannery', 'oldQuarter']) < POLE_DISTRICT_SHARE) continue;

    // The crossarm has to sit square to the run, not to the prop's default front.
    const yaw = street.axis === 'x' ? 0 : -Math.PI * 0.5;
    const side = hash2(street.position, street.from, 81) < 0.5 ? 1 : -1;
    const inset = Math.max(0.7, street.sidewalk - 0.8);
    const spans = streetSpans(street, plan);

    // Poles are stepped along the whole street, not span by span: a line
    // carries straight over a junction, which is exactly why the sag reads.
    let previous: { x: number; z: number; y: number } | null = null;
    const first = Math.ceil(street.from / POLE_SPACING) * POLE_SPACING;
    for (let along = first; along < street.to; along += POLE_SPACING) {
      if (!spans.some((span) => along > span.from + 1 && along < span.to - 1)) continue;
      const point = pavementPoint(street, along, side, inset);
      if (!scatter.place('utilityPole', point.x, point.z, yaw)) continue;
      const y = scatter.ground.sample(point.x, point.z).y;
      if (previous && Math.hypot(point.x - previous.x, point.z - previous.z) < POLE_SPACING * 2.4) {
        for (const offset of POLE_CABLE_OFFSETS) {
          // Local +X of the pole maps to (cos yaw, 0, -sin yaw).
          const dx = offset * Math.cos(yaw);
          const dz = -offset * Math.sin(yaw);
          cable(
            buffer,
            previous.x + dx,
            previous.y + POLE_CABLE_HEIGHT,
            previous.z + dz,
            point.x + dx,
            y + POLE_CABLE_HEIGHT,
            point.z + dz,
          );
        }
      }
      previous = { x: point.x, z: point.z, y };
    }
  }
}

/** Hydrants and junction signage: the two rules that touch every street. */
/** Metres between bus shelters on an arterial. About one a block. */
const SHELTER_SPACING = 90;
/** Hard caps, because these two are pure decoration and cost real triangles. */
const MAX_KIOSKS = 8;
const MAX_NEWS_STANDS = 6;

function scatterStreetFurniture(scatter: Scatter, plan: CityPlan): void {
  for (const street of plan.streets) {
    const spans = streetSpans(street, plan);
    const first = Math.ceil(street.from / HYDRANT_SPACING) * HYDRANT_SPACING;
    for (let step = first; step < street.to; step += HYDRANT_SPACING) {
      const along = nudgeIntoSpan(spans, step, 2.5, 26);
      if (along === null) continue;
      const side = hash2(street.position, step, 83) < 0.5 ? 1 : -1;
      const point = pavementPoint(street, along, side, 0.7);
      scatter.place('hydrant', point.x, point.z, facingRoad(street, side));
    }
  }

  /*
   * Bus shelters, on the arterials only and well apart.
   *
   * A shelter is by far the biggest thing that stands on a pavement, so the
   * rules are tighter than for anything else here: arterial streets only
   * (their footways are the widest), a long spacing so a street never reads as
   * a bus station, and `scatter.place` does the rest - it already refuses a
   * position that overlaps another prop or that falls inside a doorway
   * reservation.
   */
  for (const street of plan.streets) {
    if (street.kind !== 'arterial') continue;
    const spans = streetSpans(street, plan);
    const first = Math.ceil(street.from / SHELTER_SPACING) * SHELTER_SPACING;
    for (let step = first; step < street.to; step += SHELTER_SPACING) {
      const along = nudgeIntoSpan(spans, step, 6, 20);
      if (along === null) continue;
      const side = hash2(street.position, step, 131) < 0.5 ? 1 : -1;
      // Held back from the kerb by half the shelter's own depth plus a margin,
      // so the roof does not oversail the carriageway.
      const point = pavementPoint(street, along, side, 1.15);
      scatter.place('busShelter', point.x, point.z, facingRoad(street, side));
    }
  }

  /*
   * A phone kiosk and a news stand near a junction, which is where somebody
   * would actually stop at one. Both are placed on the pavement well back from
   * the corner itself: a crossing is the one piece of footway that must stay
   * open, and `ObstacleIndex.blocksCorridor` measures exactly that.
   */
  let kiosks = 0;
  let stands = 0;
  for (const crossing of cityCrossings(plan)) {
    const arterial = crossing.xs.kind === 'arterial' || crossing.zs.kind === 'arterial';
    if (!arterial) continue;
    const roll = hash2(crossing.x, crossing.z, 149);
    const sx = roll < 0.5 ? -1 : 1;
    const sz = hash2(crossing.x, crossing.z, 151) < 0.5 ? -1 : 1;
    const x = crossing.x + (crossing.xs.roadHalf + 4.2) * sx;
    const z = crossing.z + (crossing.zs.roadHalf + 4.2) * sz;
    const yaw = crossing.xs.axis === 'x' ? (sx > 0 ? Math.PI * 0.5 : -Math.PI * 0.5) : 0;
    if (kiosks <= stands && kiosks < MAX_KIOSKS) {
      if (scatter.place('phoneKiosk', x, z, yaw)) kiosks += 1;
    } else if (stands < MAX_NEWS_STANDS) {
      if (scatter.place('newsStand', x, z, yaw)) stands += 1;
    }
  }

  for (const crossing of cityCrossings(plan)) {
    // One sign per junction, on the corner the approaching driver reads first,
    // plus a second on the opposite corner at the busier junctions.
    const corners: readonly (readonly [number, number])[] = [
      [-1, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
    ];
    const wanted = crossing.xs.kind === 'arterial' || crossing.zs.kind === 'arterial' ? 2 : 1;
    let done = 0;
    for (const [sx, sz] of corners) {
      if (done >= wanted) break;
      const x = crossing.x + (crossing.xs.roadHalf + 1.1) * sx;
      const z = crossing.z + (crossing.zs.roadHalf + 1.1) * sz;
      const yaw = crossing.xs.axis === 'x' ? (sx > 0 ? Math.PI * 0.5 : -Math.PI * 0.5) : 0;
      if (scatter.place('trafficSign', x, z, yaw)) done += 1;
    }
  }
}

/** The promenade: bollards at the deck edge, seating, palms and mooring irons. */
function scatterPromenade(scatter: Scatter, plan: CityPlan): void {
  const promenade = plan.streets.find((street) => street.kind === 'promenade');
  if (!promenade) return;
  const seaward = -1; // the bay is west of the harbour walk
  const outer = promenade.roadHalf + promenade.sidewalk;

  // Mooring irons sit on the seawall coping, right at the outer edge.
  for (let along = promenade.from + 8; along < promenade.to - 8; along += MOORING_SPACING) {
    const across = -(outer - 0.7);
    const point = promenade.axis === 'x'
      ? { x: promenade.position + across, z: along }
      : { x: along, z: promenade.position + across };
    scatter.place('mooringBollard', point.x, point.z, 0);
  }

  // A guard line of bollards a stride inboard of them.
  for (let along = promenade.from + 4; along < promenade.to - 4; along += BOLLARD_SPACING) {
    const point = pavementPoint(promenade, along, seaward, PROMENADE_GUARD_INSET);
    scatter.place('bollard', point.x, point.z, 0);
  }

  for (let along = promenade.from + 12; along < promenade.to - 12; along += 18) {
    const yaw = facingRoad(promenade, seaward) + Math.PI; // seats look at the water
    const bench = pavementPoint(promenade, along, seaward, PROMENADE_SEAT_INSET);
    scatter.place('bench', bench.x, bench.z, yaw);
    const bin = pavementPoint(promenade, along + 3.4, seaward, PROMENADE_SEAT_INSET);
    scatter.place('litterBin', bin.x, bin.z, yaw);
    const planter = pavementPoint(promenade, along + 9, seaward, PROMENADE_SEAT_INSET);
    scatter.place('planter', planter.x, planter.z, 0);
  }

  // Palms in clumps of two to four, never on a cadence.
  for (let along = promenade.from + 10; along < promenade.to - 10; along += 13) {
    const seed = hash2(promenade.position, along, 91);
    if (seed > 0.84) continue; // gaps matter as much as the clumps
    const count = 2 + Math.floor(hash2(along, promenade.position, 92) * 3);
    for (let i = 0; i < count; i += 1) {
      const jitterAlong = along + (hash2(along + i, i * 3.1, 93) - 0.5) * 7;
      const inset = 1.2 + hash2(i, along, 94) * 1.4;
      const point = pavementPoint(promenade, jitterAlong, seaward, inset);
      scatter.place('palmTree', point.x, point.z, hash2(point.x, point.z, 95) * Math.PI * 2);
    }
  }

  // The landward walk gets the everyday furniture rather than the view.
  for (let along = promenade.from + 20; along < promenade.to - 20; along += 26) {
    const point = pavementPoint(promenade, along, 1, 1.4);
    scatter.place('litterBin', point.x, point.z, facingRoad(promenade, 1));
    const planter = pavementPoint(promenade, along + 11, 1, 1.6);
    scatter.place('planter', planter.x, planter.z, 0);
  }
}

/** Blocks that are not built on carry the city's public furniture. */
function scatterOpenBlocks(scatter: Scatter, plan: CityPlan): void {
  for (const block of plan.blocks) {
    if (block.kind === 'plaza') scatterPlaza(scatter, block);
    else if (block.kind === 'park') scatterPark(scatter, block);
  }
}

function scatterPlaza(scatter: Scatter, block: CityBlock): void {
  const { rect } = block;
  // Bollards around the plaza edge, keeping vehicles off it.
  for (let x = rect.minX + 1.0; x < rect.maxX - 1.0; x += 4) {
    scatter.place('bollard', x, rect.minZ + 0.9, 0);
    scatter.place('bollard', x, rect.maxZ - 0.9, 0);
  }
  for (let z = rect.minZ + 4.0; z < rect.maxZ - 1.0; z += 4) {
    scatter.place('bollard', rect.minX + 0.9, z, 0);
    scatter.place('bollard', rect.maxX - 0.9, z, 0);
  }

  const cx = (rect.minX + rect.maxX) * 0.5;
  const cz = (rect.minZ + rect.maxZ) * 0.5;
  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * Math.PI * 2;
    const radius = Math.min(rect.maxX - rect.minX, rect.maxZ - rect.minZ) * 0.3;
    const x = cx + Math.cos(angle) * radius;
    const z = cz + Math.sin(angle) * radius;
    scatter.place(i % 2 === 0 ? 'bench' : 'planter', x, z, angle + Math.PI * 0.5);
  }
  for (let i = 0; i < 3; i += 1) {
    const seed = hash2(rect.minX + i, rect.minZ, 101);
    const bx = rect.minX + 4 + seed * (rect.maxX - rect.minX - 8);
    const bz = rect.minZ + 4 + hash2(rect.minZ + i, rect.maxX, 102) * (rect.maxZ - rect.minZ - 8);
    const count = 2 + Math.floor(hash2(bx, bz, 103) * 3);
    for (let k = 0; k < count; k += 1) {
      scatter.place(
        'palmTree',
        bx + (hash2(bx + k, k, 104) - 0.5) * 6,
        bz + (hash2(bz + k, k, 105) - 0.5) * 6,
        hash2(k, bx, 106) * Math.PI * 2,
      );
    }
  }
  scatter.place('litterBin', cx + 4.5, cz - 4.5, 0);
  scatter.place('litterBin', cx - 4.5, cz + 4.5, 0);
}

function scatterPark(scatter: Scatter, block: CityBlock): void {
  const { rect } = block;
  // A jittered lattice, thinned by hash, so the planting clumps and gaps.
  for (let x = rect.minX + 2.0; x < rect.maxX - 2.0; x += 4.2) {
    for (let z = rect.minZ + 2.0; z < rect.maxZ - 2.0; z += 4.2) {
      const jx = x + (hash2(x, z, 111) - 0.5) * 3.0;
      const jz = z + (hash2(z, x, 112) - 0.5) * 3.0;
      const roll = hash2(jx, jz, 113);
      if (roll > 0.78) continue;
      // Keep the gravel paths walkable.
      if (scatter.ground.sample(jx, jz).surface !== 'grass') continue;
      const prop: PropKey = roll < 0.34 ? 'broadleafTree' : roll < 0.72 ? 'shrub' : 'palmTree';
      scatter.place(prop, jx, jz, hash2(jx, jz, 114) * Math.PI * 2);
    }
  }
  // Benches and bins facing the main path.
  for (let z = rect.minZ + 6; z < rect.maxZ - 6; z += 14) {
    scatter.place('bench', rect.minX + 15.6, z, Math.PI * 0.5);
    scatter.place('bench', rect.minX + 10.4, z + 7, -Math.PI * 0.5);
    scatter.place('litterBin', rect.minX + 15.6, z + 2.4, 0);
  }
}

/** Trees along the residential ridge streets, and tree pits on the arterials. */
function scatterStreetTrees(scatter: Scatter, plan: CityPlan): void {
  for (const street of plan.streets) {
    for (const pit of arterialTreePits(street, plan)) {
      scatter.place('broadleafTree', pit.x, pit.z, hash2(pit.x, pit.z, 121) * Math.PI * 2);
    }

    if (street.kind !== 'secondary') continue;
    const tally = streetDistricts(street, scatter.ground);
    if (districtShare(tally, ['ridge']) < 0.45) continue;
    const inset = Math.max(0.9, street.sidewalk - 1.1);
    for (const span of streetSpans(street, plan)) {
      for (let along = Math.ceil(span.from / 13) * 13; along < span.to; along += 13) {
        if (along < span.from) continue;
        const side = hash2(street.position, along, 122) < 0.5 ? 1 : -1;
        const point = pavementPoint(street, along, side, inset);
        const prop: PropKey = hash2(point.x, point.z, 123) < 0.7 ? 'broadleafTree' : 'shrub';
        scatter.place(prop, point.x, point.z, hash2(point.z, point.x, 124) * Math.PI * 2);
      }
    }
  }
}

/** Café spill-out and news boxes outside the harbourside and old-quarter shops. */
function scatterShopfronts(scatter: Scatter, plan: CityPlan): void {
  const wanted: readonly DistrictId[] = ['harbourside', 'oldQuarter'];
  for (const parcel of plan.parcels) {
    if (!wanted.includes(parcel.district)) continue;
    const street = plan.streets.find((s) => s.id === parcel.frontStreetId);
    if (!street) continue;

    const centreX = (parcel.rect.minX + parcel.rect.maxX) * 0.5;
    const centreZ = (parcel.rect.minZ + parcel.rect.maxZ) * 0.5;
    const along = street.axis === 'x' ? centreZ : centreX;
    const near = street.axis === 'x' ? centreX : centreZ;
    const side = near > street.position ? 1 : -1;
    // Furniture belongs against the building line, not out at the kerb.
    const inset = Math.max(0.8, street.sidewalk - 1.1);
    const yaw = facingRoad(street, side);

    const roll = hash2(parcel.rect.minX, parcel.rect.minZ, 131);
    if (roll < 0.34) {
      const table = pavementPoint(street, along, side, inset);
      if (scatter.place('cafeTable', table.x, table.z, yaw)) {
        // Chairs sit a clear stride off the table so neither pushes the other
        // out through the spacing check.
        for (const offset of [-1.15, 1.15]) {
          const chair = pavementPoint(street, along + offset, side, inset);
          scatter.place('cafeChair', chair.x, chair.z, yaw + (offset > 0 ? 1 : -1) * Math.PI * 0.5);
        }
      }
      const second = pavementPoint(street, along + 3.4, side, inset);
      if (scatter.place('cafeTable', second.x, second.z, yaw)) {
        const chair = pavementPoint(street, along + 3.4 + 1.15, side, inset);
        scatter.place('cafeChair', chair.x, chair.z, yaw + Math.PI * 0.5);
      }
    } else if (roll < 0.5) {
      const box = pavementPoint(street, along, side, Math.max(0.7, inset - 0.4));
      scatter.place('newsBox', box.x, box.z, yaw);
    } else if (roll < 0.62) {
      const bin = pavementPoint(street, along, side, inset);
      scatter.place('litterBin', bin.x, bin.z, yaw);
    }
  }
}

/** Service clutter down the alleys and across the cannery courtyards. */
function scatterServiceYards(scatter: Scatter, plan: CityPlan): void {
  const clutter: readonly PropKey[] = ['crate', 'pallet', 'dumpster', 'meterBox', 'crate', 'pallet'];

  for (const block of plan.blocks) {
    if (block.kind !== 'buildings') continue;
    const alley = block.alley;
    if (alley) placeAlleyClutter(scatter, alley.rect, clutter);

    // Courtyard clutter: a short scan of the block interior, which mostly
    // rejects against the buildings standing in it and keeps what is left.
    if (block.district !== 'cannery' && block.district !== 'oldQuarter') continue;
    for (let x = block.rect.minX + 2; x < block.rect.maxX - 2; x += 4.0) {
      for (let z = block.rect.minZ + 2; z < block.rect.maxZ - 2; z += 4.0) {
        const roll = hash2(x, z, 141);
        if (roll > 0.34) continue;
        const prop = clutter[Math.floor(hash2(z, x, 142) * clutter.length)] as PropKey;
        scatter.place(prop, x, z, hash2(x + z, x - z, 143) * Math.PI * 2);
      }
    }
  }
}

function placeAlleyClutter(scatter: Scatter, rect: Rect, clutter: readonly PropKey[]): void {
  const runsNorthSouth = rect.maxZ - rect.minZ > rect.maxX - rect.minX;
  const from = runsNorthSouth ? rect.minZ : rect.minX;
  const to = runsNorthSouth ? rect.maxZ : rect.maxX;
  for (let along = from + 3; along < to - 3; along += 4) {
    for (const side of [-1, 1]) {
      const roll = hash2(along, side * 7 + rect.minX, 151);
      if (roll > 0.62) continue;
      const wall = side > 0
        ? (runsNorthSouth ? rect.maxX : rect.maxZ) - 0.75
        : (runsNorthSouth ? rect.minX : rect.minZ) + 0.75;
      const x = runsNorthSouth ? wall : along;
      const z = runsNorthSouth ? along : wall;
      const prop = clutter[Math.floor(hash2(x, z, 152) * clutter.length)] as PropKey;
      // Clutter stands against the wall, so it faces the middle of the alley.
      const yaw = runsNorthSouth
        ? (side > 0 ? -Math.PI * 0.5 : Math.PI * 0.5)
        : (side > 0 ? 0 : Math.PI);
      scatter.place(prop, x, z, yaw);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Scatters every street prop in the city. Order matters: the rules that carry
 * the most meaning run first, so when two candidates compete for the same
 * ground the lamp keeps its spacing and the loose clutter moves.
 */
export function scatterStreetProps(plan: CityPlan, sink: GeometrySink): void {
  const scatter = new Scatter(plan, sink);
  const buffer = new SurfaceBuffer();

  // Reserve the doorways BEFORE anything is scattered.
  //
  // The placement rules only knew about ground, roads and other props, so a
  // news box landed 0.13 m in front of the cafe's front door - legal by every
  // rule it checked, and squarely in the one place the player has to stand.
  // Reserving the approach through the existing exclusion mechanism means
  // every later rule routes around it for free, and no rule has to remember.
  reserveDoorways(scatter, plan);

  scatterLamps(scatter, plan);
  scatterPoles(scatter, plan, buffer);
  scatterPromenade(scatter, plan);
  scatterOpenBlocks(scatter, plan);
  scatterStreetFurniture(scatter, plan);
  scatterStreetTrees(scatter, plan);
  scatterShopfronts(scatter, plan);
  scatterServiceYards(scatter, plan);

  buffer.flush(sink);
}

/**
 * Blocks prop placement across every entrance and the ground it is reached
 * from.
 *
 * The radius covers the threshold, the approach point the interaction system
 * uses, and a stride either side, so a player walking in at an angle is not
 * squeezed past a bollard.
 */
const DOOR_KEEP_OUT = 1.7;

function reserveDoorways(scatter: Scatter, plan: CityPlan): void {
  for (const parcel of plan.parcels) {
    if (!parcel.enterable) continue;
    const door = doorwayFor(parcel);
    scatter.reserve(door.x, door.z, DOOR_KEEP_OUT);
    const approach = doorApproach(door, 1.6);
    scatter.reserve(approach.x, approach.z, DOOR_KEEP_OUT);
  }
}
