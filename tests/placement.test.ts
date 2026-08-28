/**
 * Whole-world placement audit.
 *
 * This is the test that would have caught a building sunk into the hill, a
 * street lamp floating over the pavement, or a door nobody can reach. It builds
 * the entire city through a recording sink - no WebGL involved - and runs every
 * automated check over the result.
 */

import { describe, expect, it } from 'vitest';

import { CollisionWorld, STEP_HEIGHT } from '../src/player/Collision';
import { SAME_FLOOR_TOLERANCE } from '../src/player/Interaction';
import {
  BODY_HEIGHT,
  BODY_RADIUS,
  FIXED_STEP,
  RUN_SPEED,
  WALK_SPEED,
  resolveVerticalStep,
} from '../src/player/FirstPersonController';
import { CityGround } from '../src/world/CityGround';
import { getCityPlan, type Parcel } from '../src/world/CityPlan';
import { buildEnvironment } from '../src/world/Environment';
import { buildBuilding } from '../src/world/build/BuildingFactory';
import { buildInterior } from '../src/world/build/InteriorBuilder';
import { doorOutsideY, doorwayFor } from '../src/world/build/doorway';
import { makeRoom } from '../src/world/build/interiorProps';
import { scatterStreetProps } from '../src/world/build/PropScatter';
import {
  buildBlockGround,
  buildIntersections,
  buildStreet,
} from '../src/world/build/StreetBuilder';
import type { InteractionPoint } from '../src/world/build/types';
import {
  RecordingSink,
  auditWorld,
  formatAudit,
  validateDoors,
  validateGrounding,
  validateProps,
} from '../src/world/validate';

const plan = getCityPlan();
const ground = new CityGround(plan);

/** Builds the whole city once and shares it across the assertions below. */
const sink = new RecordingSink();
for (const street of plan.streets) buildStreet(street, plan, sink);
buildIntersections(plan, sink);
for (const block of plan.blocks) buildBlockGround(block, plan, sink);
for (const parcel of plan.parcels) buildBuilding(parcel, sink);
for (const parcel of plan.parcels) if (parcel.enterable) buildInterior(parcel, sink);
scatterStreetProps(plan, sink);
buildEnvironment(sink, ground);

describe('world placement audit', () => {
  it('produces a complete world', () => {
    expect(sink.geometries.length).toBeGreaterThan(200);
    expect(sink.colliders.length).toBeGreaterThan(150);
    expect(sink.instances.length).toBeGreaterThan(300);
    expect(sink.interactions.length).toBeGreaterThanOrEqual(5);
  });

  it('has no buried or floating buildings', () => {
    const issues = validateGrounding(plan, ground).filter((i) => i.severity === 'error');
    expect(
      issues.map((i) => `${i.kind} ${i.subject}: ${i.message}`).join('\n'),
    ).toBe('');
  });

  it('sits every prop on the ground and out of the water', () => {
    const issues = validateProps(ground, sink.instances, plan).filter((i) => i.severity === 'error');
    // Report the worst few rather than a wall of text.
    expect(
      issues
        .slice(0, 8)
        .map((i) => `${i.kind} ${i.subject} @ ${i.x.toFixed(1)},${i.z.toFixed(1)}: ${i.message}`)
        .join('\n'),
    ).toBe('');
  });

  it('leaves every enterable building reachable', () => {
    const issues = validateDoors(plan, ground, sink.interactions).filter(
      (i) => i.severity === 'error',
    );
    expect(issues.map((i) => `${i.kind} ${i.subject}: ${i.message}`).join('\n')).toBe('');
  });

  it('emits only finite geometry', () => {
    const bad = sink.geometries.filter((g) => !g.finite);
    expect(bad.map((g) => g.key).join(', ')).toBe('');
  });

  it('passes the full audit without errors', () => {
    const result = auditWorld(plan, ground, sink);
    expect(formatAudit(result)).not.toContain('[error]');
  });

  it('stays inside the rendering budget', () => {
    // Measured budget for a compact city that must hold 60 FPS on a laptop.
    expect(sink.triangles).toBeLessThan(1_100_000);
    expect(sink.instances.length).toBeLessThan(4_000);
    expect(sink.lights.length).toBeLessThan(400);
  });

  it('keeps buildings out of the carriageway', () => {
    // Building geometry may oversail the pavement a little for a cornice or a
    // balcony, but must never reach the road itself.
    for (const street of plan.streets) {
      const half = street.roadHalf;
      for (const parcel of plan.parcels) {
        const nearMin = street.axis === 'x' ? parcel.rect.minX : parcel.rect.minZ;
        const nearMax = street.axis === 'x' ? parcel.rect.maxX : parcel.rect.maxZ;
        const alongMin = street.axis === 'x' ? parcel.rect.minZ : parcel.rect.minX;
        const alongMax = street.axis === 'x' ? parcel.rect.maxZ : parcel.rect.maxX;
        if (alongMax < street.from || alongMin > street.to) continue;
        expect(
          nearMin < street.position + half && nearMax > street.position - half,
          `${parcel.id} overlaps the carriageway of ${street.id}`,
        ).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Entrances
// ---------------------------------------------------------------------------

/**
 * Walking a player through every front door, headlessly.
 *
 * The city that comes out of the recording sink above is exactly the city the
 * game builds, so the collision world built from it behaves exactly like the
 * one the player walks around in. That is what lets these checks catch the
 * failure that started this suite: a door target that lands the player inside
 * the building's own mass collider, where the controller's stuck rescue lifted
 * them a step every fixed tick until they popped out on the roof.
 *
 * Vertical resolution is the controller's own `resolveVerticalStep`, not a copy
 * of it. Only the horizontal plumbing is restated here, in the same order
 * `FirstPersonController.step` runs it.
 */
const collision = new CollisionWorld(sink.colliders);
const enterable = plan.parcels.filter((parcel) => parcel.enterable);
const doorsById = new Map<string, InteractionPoint>(
  sink.interactions.filter((point) => point.kind === 'door').map((point) => [point.id, point]),
);

interface Walker {
  x: number;
  y: number;
  z: number;
  verticalVelocity: number;
  /** Lowest and highest the feet ever went during the run. */
  minY: number;
  maxY: number;
}

/** Mirrors `FirstPersonController.placeOnFloor`: the aim resolved against the world. */
function placeOnFloor(x: number, z: number, aimY: number): Walker {
  const terrain = ground.sample(x, z).y;
  const y = collision.supportAt(x, z, aimY, terrain).y;
  return { x, y, z, verticalVelocity: 0, minY: y, maxY: y };
}

/** One fixed step: move, keep in bounds and out of the water, then resolve height. */
function step(walker: Walker, dx: number, dz: number): void {
  const moved = collision.move(walker.x, walker.z, dx, dz, walker.y, BODY_HEIGHT, BODY_RADIUS);
  const sample = ground.sample(moved.x, moved.z);
  const swimming = sample.surface === 'water' && ground.waterDepth(moved.x, moved.z) > 0.55;
  if (!swimming && ground.isInBounds(moved.x, moved.z)) {
    walker.x = moved.x;
    walker.z = moved.z;
    walker.y = moved.feetY;
  }
  const here = ground.sample(walker.x, walker.z);
  const support = collision.supportAt(walker.x, walker.z, walker.y, here.y);
  const vertical = resolveVerticalStep(
    collision,
    walker.x,
    walker.z,
    walker.y,
    walker.verticalVelocity,
    support.y,
    FIXED_STEP,
  );
  walker.y = vertical.y;
  walker.verticalVelocity = vertical.verticalVelocity;
  walker.minY = Math.min(walker.minY, walker.y);
  walker.maxY = Math.max(walker.maxY, walker.y);
}

/** Runs the walker for `seconds`, holding a heading (or standing still). */
function walk(walker: Walker, seconds: number, heading: number | null, speed = WALK_SPEED): Walker {
  const dx = heading === null ? 0 : -Math.sin(heading) * speed * FIXED_STEP;
  const dz = heading === null ? 0 : -Math.cos(heading) * speed * FIXED_STEP;
  const steps = Math.round(seconds / FIXED_STEP);
  for (let i = 0; i < steps; i += 1) step(walker, dx, dz);
  return walker;
}

function roofY(parcel: Parcel): number {
  return parcel.groundY + parcel.groundStoreyHeight + (parcel.storeys - 1) * parcel.storeyHeight;
}

function entryDoor(parcel: Parcel): InteractionPoint {
  const door = doorsById.get(`door-${parcel.id}`);
  if (!door?.target) throw new Error(`${parcel.id} has no entry door`);
  return door;
}

function exitDoor(parcel: Parcel): InteractionPoint {
  const door = doorsById.get(`interior-exit-${parcel.id}`);
  if (!door?.target) throw new Error(`${parcel.id} has no way out`);
  return door;
}

/** Floor of the room actually built for this parcel. */
function interiorFloorY(parcel: Parcel): number {
  const kind = parcel.interiorKind;
  if (!kind) throw new Error(`${parcel.id} has no interior`);
  return makeRoom(parcel, kind).floorY;
}

function interiorCeilY(parcel: Parcel): number {
  const kind = parcel.interiorKind;
  if (!kind) throw new Error(`${parcel.id} has no interior`);
  return makeRoom(parcel, kind).ceilY;
}

describe('entrances', () => {
  it('gives every enterable parcel a door in and a door out', () => {
    expect(enterable.length).toBeGreaterThanOrEqual(5);
    for (const parcel of enterable) {
      expect(entryDoor(parcel).target, `${parcel.id} entry`).toBeDefined();
      expect(exitDoor(parcel).target, `${parcel.id} exit`).toBeDefined();
    }
  });

  it('aims every door target at the interior floor, never the roof or the footing', () => {
    for (const parcel of enterable) {
      const target = entryDoor(parcel).target;
      if (!target) continue;
      const floor = interiorFloorY(parcel);

      expect(target.y, `${parcel.id} target height`).toBeCloseTo(floor, 2);
      expect(target.y, `${parcel.id} target is below its plinth`).toBeGreaterThan(parcel.baseY);
      expect(
        roofY(parcel) - target.y,
        `${parcel.id} target is on or near the roof`,
      ).toBeGreaterThan(2);
      // And the landing really is inside the building, not on the pavement.
      expect(target.x, `${parcel.id} landing x`).toBeGreaterThan(parcel.rect.minX);
      expect(target.x, `${parcel.id} landing x`).toBeLessThan(parcel.rect.maxX);
      expect(target.z, `${parcel.id} landing z`).toBeGreaterThan(parcel.rect.minZ);
      expect(target.z, `${parcel.id} landing z`).toBeLessThan(parcel.rect.maxZ);
    }
  });

  it('puts the player on the interior floor and leaves them there', () => {
    for (const parcel of enterable) {
      const target = entryDoor(parcel).target;
      if (!target) continue;
      const floor = interiorFloorY(parcel);

      const walker = placeOnFloor(target.x, target.z, target.y);
      expect(walker.y, `${parcel.id} lands off its floor`).toBeCloseTo(floor, 2);
      expect(
        collision.isStuck(walker.x, walker.z, walker.y, BODY_HEIGHT, BODY_RADIUS),
        `${parcel.id} lands inside a collider`,
      ).toBe(false);

      // Five seconds of standing still. Anything that moves here is a collider
      // conflict resolving itself against the player.
      walk(walker, 5, null);
      expect(walker.minY, `${parcel.id} sank after entering`).toBeCloseTo(floor, 2);
      expect(walker.maxY, `${parcel.id} rose after entering`).toBeCloseTo(floor, 2);
    }
  });

  it('lets the player walk the interior without leaving the building', () => {
    for (const parcel of enterable) {
      const target = entryDoor(parcel).target;
      if (!target) continue;
      const floor = interiorFloorY(parcel);
      const ceiling = interiorCeilY(parcel);

      // Sixteen headings, four seconds each, walking and running. Whatever the
      // player bumps into, they must stay in the room they entered.
      for (let i = 0; i < 16; i += 1) {
        const heading = (i * Math.PI * 2) / 16;
        const walker = placeOnFloor(target.x, target.z, target.y);
        walk(walker, 4, heading, i % 2 === 0 ? WALK_SPEED : RUN_SPEED);

        // Strictly stronger than "above the plinth": the floor slab is the
        // lowest thing in an interior, so falling below it at all is a hole.
        expect(
          walker.minY,
          `${parcel.id} fell through its floor heading ${i}`,
        ).toBeGreaterThanOrEqual(floor - 0.05);
        // Upper levels are fair game; the roof is not. A walkable level always
        // leaves standing room under the ceiling.
        expect(
          walker.maxY,
          `${parcel.id} climbed out of its room heading ${i}`,
        ).toBeLessThanOrEqual(ceiling - 1.5);
        expect(
          roofY(parcel) - walker.maxY,
          `${parcel.id} reached its roof heading ${i}`,
        ).toBeGreaterThan(1);
      }
    }
  });

  it('walks the player clear of the doorway on the way in', () => {
    for (const parcel of enterable) {
      const target = entryDoor(parcel).target;
      if (!target) continue;
      const walker = placeOnFloor(target.x, target.z, target.y);
      const startX = walker.x;
      const startZ = walker.z;
      // The door heading looks straight into the building.
      walk(walker, 2, target.heading);
      expect(
        Math.hypot(walker.x - startX, walker.z - startZ),
        `${parcel.id} cannot be walked into`,
      ).toBeGreaterThan(1.2);
    }
  });

  it('reaches every level the interior builds', () => {
    // Any walkable platform an interior emits well above its floor is a level
    // the player is meant to get to: the workshop's mezzanine office, the
    // stairhall's gallery. A flight nobody can climb is a modelling error.
    for (const parcel of enterable) {
      const floor = interiorFloorY(parcel);
      const decks = sink.colliders.filter(
        (box) =>
          !box.solid &&
          box.top > floor + 1.5 &&
          box.minX >= parcel.rect.minX - 0.3 &&
          box.maxX <= parcel.rect.maxX + 0.3 &&
          box.minZ >= parcel.rect.minZ - 0.3 &&
          box.maxZ <= parcel.rect.maxZ + 0.3,
      );
      if (decks.length === 0) continue;

      const highest = decks.reduce((best, box) => (box.top > best.top ? box : best));
      const target = entryDoor(parcel).target;
      if (!target) continue;
      const reached = reachable(parcel, target.x, target.z, target.y);
      expect(
        reached.highest,
        `${parcel.id} builds a deck at ${highest.top.toFixed(2)}m the player cannot climb to`,
      ).toBeGreaterThan(highest.top - STEP_HEIGHT);
    }
  });

  it('leaves the whole ground floor open to walk around', () => {
    for (const parcel of enterable) {
      const target = entryDoor(parcel).target;
      if (!target) continue;
      const floor = interiorFloorY(parcel);
      const reached = reachable(parcel, target.x, target.z, target.y);
      const footprint =
        (parcel.rect.maxX - parcel.rect.minX) * (parcel.rect.maxZ - parcel.rect.minZ);
      // Fittings, counters and stalls take their share; what is left has to be
      // a room the player can move around in rather than a slot behind a door.
      expect(
        reached.area / footprint,
        `${parcel.id} only opens ${((reached.area / footprint) * 100).toFixed(0)}% of its floor`,
      ).toBeGreaterThan(0.3);
      expect(reached.lowest, `${parcel.id} has a hole in its floor`).toBeGreaterThanOrEqual(
        floor - 0.02,
      );
    }
  });

  it('drops the player back on the pavement on the way out', () => {
    for (const parcel of enterable) {
      const target = exitDoor(parcel).target;
      if (!target) continue;
      const door = doorwayFor(parcel);

      // The emitted target is the outdoor level, and it agrees with the ground.
      expect(target.y, `${parcel.id} exit height`).toBeCloseTo(doorOutsideY(parcel, door), 6);
      const outside = ground.sample(target.x, target.z);
      expect(target.y, `${parcel.id} exits away from the pavement`).toBeCloseTo(outside.y, 1);
      expect(ground.isBuilt(target.x, target.z), `${parcel.id} exits into a building`).toBe(false);

      const walker = placeOnFloor(target.x, target.z, target.y);
      expect(walker.y, `${parcel.id} exit lands off the pavement`).toBeCloseTo(outside.y, 2);
      expect(
        collision.isStuck(walker.x, walker.z, walker.y, BODY_HEIGHT, BODY_RADIUS),
        `${parcel.id} exit lands inside a collider`,
      ).toBe(false);

      walk(walker, 5, null);
      // No fall, no launch: the exit is where the player already stands.
      expect(walker.maxY - walker.minY, `${parcel.id} moved after exiting`).toBeLessThan(0.05);
      expect(walker.y, `${parcel.id} exit settles off the pavement`).toBeCloseTo(outside.y, 2);
    }
  });

  it('lands the player inside the prompt at the other end of every door', () => {
    // The round trip has to close: standing where a door puts you, the prompt
    // that takes you back must be in range and on your floor. Otherwise a
    // building is a trap or an exit is a one-way drop.
    for (const parcel of enterable) {
      const entry = entryDoor(parcel);
      const exit = exitDoor(parcel);
      if (!entry.target || !exit.target) continue;

      const inside = placeOnFloor(entry.target.x, entry.target.z, entry.target.y);
      expect(
        Math.hypot(inside.x - exit.x, inside.z - exit.z),
        `${parcel.id} lands out of reach of its own way out`,
      ).toBeLessThan(exit.radius);
      expect(
        Math.abs(exit.y - inside.y),
        `${parcel.id} way out reads as a different floor`,
      ).toBeLessThan(SAME_FLOOR_TOLERANCE);

      const outside = placeOnFloor(exit.target.x, exit.target.z, exit.target.y);
      expect(
        Math.hypot(outside.x - entry.x, outside.z - entry.z),
        `${parcel.id} exits out of reach of its own front door`,
      ).toBeLessThan(entry.radius);
      expect(
        Math.abs(entry.y - outside.y),
        `${parcel.id} front door reads as a different floor from the pavement`,
      ).toBeLessThan(SAME_FLOOR_TOLERANCE);
      // Entering is a step up over the threshold, never a step down into one.
      expect(entry.target.y, `${parcel.id} threshold falls inward`).toBeGreaterThan(exit.target.y);
    }
  });
});

/**
 * Flood fill of everywhere the player can walk from the landing.
 *
 * Cells are stepped between with the real collision primitives at the real
 * per-step distance, so a wall the controller would stop at stops the fill too.
 * A cell is tracked per height band, because a stair passes over floor the
 * player can also walk along and one height per cell would lose the flight
 * halfway up.
 */
function reachable(
  parcel: Parcel,
  startX: number,
  startZ: number,
  aimY: number,
): { area: number; highest: number; lowest: number } {
  const CELL = 0.5;
  /** Height quantum for the level a cell was reached on. Under a stair's rise
   *  per cell, or climbing merges back into the floor it passes over. */
  const BAND = 0.2;
  const key = (walker: Walker): number =>
    ((Math.round(walker.x / CELL) + 512) * 4096 + Math.round(walker.z / CELL) + 512) * 512 +
    Math.round(walker.y / BAND);
  const floorKey = (walker: Walker): number =>
    (Math.round(walker.x / CELL) + 512) * 4096 + Math.round(walker.z / CELL) + 512;

  const start = placeOnFloor(startX, startZ, aimY);
  const seen = new Set<number>([key(start)]);
  const footprint = new Set<number>([floorKey(start)]);
  const queue: Walker[] = [start];

  let highest = start.y;
  let lowest = start.y;
  const reach = 1.2;

  while (queue.length > 0) {
    const from = queue.pop();
    if (!from) break;
    for (const [dx, dz] of [
      [CELL, 0],
      [-CELL, 0],
      [0, CELL],
      [0, -CELL],
    ] as const) {
      const goalX = from.x + dx;
      const goalZ = from.z + dz;
      if (goalX < parcel.rect.minX - reach || goalX > parcel.rect.maxX + reach) continue;
      if (goalZ < parcel.rect.minZ - reach || goalZ > parcel.rect.maxZ + reach) continue;

      // Walk there at the real per-step distance rather than teleporting, so a
      // thin wall between the two cells is not tunnelled through.
      const walker: Walker = { ...from };
      const substeps = Math.ceil(CELL / (RUN_SPEED * FIXED_STEP));
      for (let i = 0; i < substeps; i += 1) step(walker, dx / substeps, dz / substeps);
      if (Math.hypot(walker.x - goalX, walker.z - goalZ) > CELL * 0.4) continue;

      const cell = key(walker);
      if (seen.has(cell)) continue;
      seen.add(cell);
      footprint.add(floorKey(walker));

      highest = Math.max(highest, walker.y);
      lowest = Math.min(lowest, walker.y);
      queue.push(walker);
    }
  }

  return { area: footprint.size * CELL * CELL, highest, lowest };
}


/*
 * BEING TRAPPED IN GEOMETRY IS NOT A RECOVERABLE STATE, so the resolver has to
 * be able to get out of it.
 *
 * The original rescue lifts a settled, stuck body by half a step and only if
 * that single lift frees it. That frees somebody clipped into a kerb, which is
 * what it was written for, and it cannot free somebody wedged against something
 * a whole storey tall: one half-step leaves them stuck, the guard correctly
 * refuses the move, and every following frame refuses it again.
 *
 * Note `blocked()` waives any box whose XZ footprint CONTAINS the body - that
 * waiver is what stops a player being wedged inside a building's mass collider
 * - so a stuck body is always one clipped into an edge, which is what these
 * fixtures build.
 *
 * Both original guards still have to hold: each exists to stop the rescue
 * becoming a worse bug than the one it fixes.
 */
describe('getting out of geometry', () => {
  /** A wall the body at the origin is clipped into, not contained by. */
  const wall = (bottom: number, top: number) =>
    new CollisionWorld([
      { minX: 0.2, maxX: 50, minZ: -50, maxZ: 50, bottom, top, solid: true },
    ]);

  it('frees a body clipped into something a half-step cannot clear', () => {
    const world = wall(-1, 3);
    expect(world.isStuck(0, 0, 0, BODY_HEIGHT, BODY_RADIUS)).toBe(true);
    expect(world.isStuck(0, 0, STEP_HEIGHT * 0.5, BODY_HEIGHT, BODY_RADIUS)).toBe(true);

    const step = resolveVerticalStep(world, 0, 0, 0, 0, 0, FIXED_STEP);
    expect(step.y).toBeGreaterThanOrEqual(3);
    expect(world.isStuck(0, 0, step.y, BODY_HEIGHT, BODY_RADIUS)).toBe(false);
  });

  it('still refuses to move a body it cannot actually free', () => {
    // Taller than the search: nothing frees it, so it must not be carried
    // upward one bounded step per frame for ever.
    const world = wall(-1, 500);
    const step = resolveVerticalStep(world, 0, 0, 0, 0, 0, FIXED_STEP);
    expect(step.y).toBe(0);
  });

  it('still leaves a falling body alone', () => {
    // Not settled: above its support with somewhere to fall. The rescue must
    // not fight gravity here - that is what made brushing a fitting bob.
    const world = wall(-1, 3);
    const step = resolveVerticalStep(world, 0, 0, 10, 0, 0, FIXED_STEP);
    expect(step.settled).toBe(false);
    expect(step.y).toBeLessThan(10);
  });

  it('leaves a body standing in the open exactly where it is', () => {
    const world = new CollisionWorld([]);
    const step = resolveVerticalStep(world, 0, 0, 5, 0, 5, FIXED_STEP);
    expect(step.y).toBe(5);
    expect(step.grounded).toBe(true);
  });
});
