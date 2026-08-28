/**
 * The terminal's travellers, asserted without a renderer.
 *
 * These are the checks that would catch what a player notices first in an
 * indoor crowd: somebody walking through a check-in desk, somebody standing in
 * somebody else, a queue that stops moving, a seated figure beside its chair,
 * a suitcase drifting away from the person towing it, and feet that skate.
 *
 * The fixture is a plausible pier terminal built from the real `TERMINAL`
 * rectangle and `TERMINAL_FLOOR` in `world/airport/layout.ts` - desks on the
 * landside wall, security in the middle, a gate lounge on the airside - so the
 * geometry the assertions run against is the shape of the building the crowd
 * will actually be dropped into, not an empty box.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  HalfFloatType,
  InstancedMesh,
  RGBAFormat,
  UnsignedByteType,
} from 'three';

import { TERMINAL, TERMINAL_FLOOR } from '../src/world/airport/layout';
import type { ColliderBox } from '../src/world/build/types';
import { insetRect } from '../src/core/mathx';
import { VatClip, type PedestrianVatCharacter } from '../src/agents/PedestrianVat';
import {
  LUGGAGE_KINDS,
  LUGGAGE_SPECS,
  placeLuggage,
  placeSeated,
  SEAT_LIFT_LIMIT,
  SEATED_SPECS,
  TerminalCrowd,
  TRAVELLER_RADIUS,
  type PropPlacement,
  type QueueAnchor,
  type SeatAnchor,
} from '../src/agents/travellers';

/** The walkable floor: the building rectangle inset past its own walls. */
const REGION = insetRect(TERMINAL, 1.6);
const FLOOR = TERMINAL_FLOOR;

function box(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  height = 1.1,
): ColliderBox {
  return { minX, maxX, minZ, maxZ, bottom: FLOOR, top: FLOOR + height, solid: true };
}

/**
 * Terminal furniture: three check-in desks against the landside wall, two
 * security scanners mid-hall, a partition with one way past it, six structural
 * columns down the spine, and three benches in the gate lounge.
 */
const OBSTACLES: readonly ColliderBox[] = [
  box(157.5, 160.5, 369, 375),
  box(157.5, 160.5, 381, 387),
  box(157.5, 160.5, 393, 399),
  box(178, 182, 427.5, 430.5, 1.9),
  box(178, 182, 439.5, 442.5, 1.9),
  box(REGION.minX, 175, 460, 461.5, 2.6),
  ...[370, 400, 430, 460, 490, 520].map((z) => box(182.5, 183.4, z - 0.45, z + 0.45, 4)),
  ...[203, 205.6, 208.2].map((x) => box(x - 0.35, x + 0.35, 467.5, 473, 0.45)),
];

const QUEUES: readonly QueueAnchor[] = [
  // The head stands at the desk facing west; the line trails back east.
  { id: 'check-in', x: 163, z: 372, heading: Math.PI / 2, slots: 8 },
  // Security faces east into the scanner; the line trails back west.
  { id: 'security', x: 176, z: 429, heading: -Math.PI / 2, slots: 7 },
];

const SEATS: readonly SeatAnchor[] = [203, 205.6, 208.2].flatMap((x) =>
  Array.from({ length: 8 }, (_, i) => ({ x, z: 468 + i * 0.62, heading: Math.PI / 2 })),
);

function makeCrowd(seed = 20260827, count?: number): TerminalCrowd {
  return new TerminalCrowd({
    region: REGION,
    obstacles: OBSTACLES,
    seats: SEATS,
    queues: QUEUES,
    floorY: FLOOR,
    quality: 'high',
    seed,
    ...(count === undefined ? {} : { count }),
  });
}

interface Sample {
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  readonly walked: number;
  readonly speed: number;
  /** The instance matrix's own scales, which the pose has to be measured in. */
  readonly girth: number;
  readonly height: number;
}

interface RunResult {
  readonly minPairDistance: number;
  readonly worstOutsideRegion: number;
  readonly worstInsideObstacle: number;
  readonly served: readonly number[];
  /**
   * Longest one person spent at the HEAD of a line before being served, per
   * queue, in seconds. This - not the gap between two people being served - is
   * the anti-deadlock property: a desk with nobody at it is idle, not stuck.
   */
  readonly worstHeadWait: readonly number[];
  /** Mean and peak occupancy per queue, so an empty hall is still a failure. */
  readonly meanOccupancy: readonly number[];
  readonly peakOccupancy: readonly number[];
  readonly sawQueueing: boolean;
  readonly sawWalking: boolean;
  /** Frames on which a queue held an occupied slot behind an empty one. */
  readonly prefixViolations: number;
  /** Luggage kinds anybody in this run was carrying. */
  readonly luggageKinds: ReadonlySet<string>;
}

/**
 * Steps the crowd at a fixed rate and records what the assertions need.
 *
 * A fixed timestep is what makes every number below reproducible; the sim
 * clamps `dt` at 0.1 s, so 1/60 is well inside its own bounds.
 */
function run(crowd: TerminalCrowd, seconds: number, dt = 1 / 60): RunResult {
  const sim = crowd.sim;
  const inner = insetRect(REGION, TRAVELLER_RADIUS);
  const boxes = crowd.obstacleIndex;
  let minPairDistance = Infinity;
  let worstOutsideRegion = 0;
  let worstInsideObstacle = 0;
  let sawQueueing = false;
  let sawWalking = false;
  let prefixViolations = 0;
  const luggageKinds = new Set<string>();
  for (const t of sim.travellers) if (t.luggage) luggageKinds.add(t.luggage);
  const headOccupant = sim.queues.map(() => -1);
  const headHeld = sim.queues.map(() => 0);
  const worstHeadWait = sim.queues.map(() => 0);
  const occupancySum = sim.queues.map(() => 0);
  const peakOccupancy = sim.queues.map(() => 0);

  const steps = Math.round(seconds / dt);
  for (let step = 0; step < steps; step += 1) {
    sim.update(dt, undefined);

    for (let i = 0; i < sim.queues.length; i += 1) {
      const q = sim.queues[i];
      if (!q) continue;
      const head = q.slots[0] ?? -1;
      if (head !== headOccupant[i]) {
        worstHeadWait[i] = Math.max(worstHeadWait[i] ?? 0, headHeld[i] ?? 0);
        headOccupant[i] = head;
        headHeld[i] = 0;
      } else if (head >= 0) {
        headHeld[i] = (headHeld[i] ?? 0) + dt;
      }
      occupancySum[i] = (occupancySum[i] ?? 0) + q.occupied;
      peakOccupancy[i] = Math.max(peakOccupancy[i] ?? 0, q.occupied);
      // The occupied slots must always be a prefix: that invariant is what
      // makes "your slot index only ever goes down" true, and it is counted
      // rather than asserted here so the hot loop stays a hot loop.
      let seenGap = false;
      for (let s = 0; s < q.capacity; s += 1) {
        const occupant = q.slots[s] ?? -1;
        if (occupant < 0) seenGap = true;
        else if (seenGap) prefixViolations += 1;
      }
      if (q.occupied < 0 || q.occupied > q.capacity) prefixViolations += 1;
    }

    for (let i = 0; i < sim.travellers.length; i += 1) {
      const t = sim.travellers[i];
      if (!t) continue;
      if (t.state === 'queue') sawQueueing = true;
      if (t.state === 'walk' && t.speed > 0.4) sawWalking = true;
      worstOutsideRegion = Math.max(
        worstOutsideRegion,
        inner.minX - t.x,
        t.x - inner.maxX,
        inner.minZ - t.z,
        t.z - inner.maxZ,
      );
      worstInsideObstacle = Math.max(
        worstInsideObstacle,
        TRAVELLER_RADIUS - boxes.clearance(t.x, t.z),
      );
    }

    // Sampled rather than every frame: 1 300 pairs at 60 Hz for five minutes
    // is 23 million comparisons and finds nothing the fourth frame does not.
    if (step % 4 === 0) {
      for (let i = 0; i < sim.travellers.length; i += 1) {
        const a = sim.travellers[i];
        if (!a) continue;
        for (let j = i + 1; j < sim.travellers.length; j += 1) {
          const b = sim.travellers[j];
          if (!b) continue;
          const d = Math.hypot(a.x - b.x, a.z - b.z);
          if (d < minPairDistance) minPairDistance = d;
        }
      }
    }
  }

  return {
    minPairDistance,
    worstOutsideRegion,
    worstInsideObstacle,
    served: sim.queues.map((q) => q.served),
    worstHeadWait,
    meanOccupancy: occupancySum.map((sum) => sum / steps),
    peakOccupancy,
    sawQueueing,
    sawWalking,
    prefixViolations,
    luggageKinds,
  };
}

describe('the terminal floor', () => {
  const crowd = makeCrowd();

  it('finds a connected walkable graph inside the furnished hall', () => {
    const graph = crowd.graph;
    // 59 x 187 m at a 3 m pitch is roughly 20 x 63 lattice points; furniture
    // and the seat footprints take a fraction of them.
    expect(graph.count).toBeGreaterThan(700);

    // Every surviving node has to be genuinely clear of everything solid.
    for (let n = 0; n < graph.count; n += 1) {
      const clearance = crowd.obstacleIndex.clearance(graph.x[n] ?? 0, graph.z[n] ?? 0);
      expect(clearance, `node ${n} is ${clearance.toFixed(3)} m from furniture`).toBeGreaterThan(
        TRAVELLER_RADIUS,
      );
    }

    // And the whole graph is one piece, or somebody spawns in a pocket they
    // can never leave. `largestComponent` is what guarantees this; the test is
    // what proves the guarantee survives real furniture.
    const seen = new Uint8Array(graph.count);
    const stack = [0];
    seen[0] = 1;
    let reached = 1;
    while (stack.length > 0) {
      const node = stack.pop() as number;
      const start = graph.offsets[node] ?? 0;
      const end = graph.offsets[node + 1] ?? start;
      for (let i = start; i < end; i += 1) {
        const other = graph.links[i] ?? 0;
        if (seen[other]) continue;
        seen[other] = 1;
        reached += 1;
        stack.push(other);
      }
    }
    expect(reached).toBe(graph.count);
  });

  it('routes around a partition instead of through it', () => {
    // The partition spans the hall from the west wall to x = 175, so a node
    // just north of it and one just south must be joined by a path that goes
    // round the east end - never a straight line through the wall.
    const graph = crowd.graph;
    const from = graph.nearest(160, 456);
    const to = graph.nearest(160, 466);
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThanOrEqual(0);
    const path: number[] = [];
    expect(crowd.paths.find(from, to, path)).toBe(true);
    let longest = 0;
    let previous = from;
    for (const node of path) {
      const step = Math.hypot(
        (graph.x[node] ?? 0) - (graph.x[previous] ?? 0),
        (graph.z[node] ?? 0) - (graph.z[previous] ?? 0),
      );
      longest = Math.max(longest, step);
      previous = node;
    }
    // Every hop is one lattice pitch or its diagonal, so no hop jumps a wall.
    expect(longest).toBeLessThan(graph.spacing * Math.SQRT2 + 1e-3);
    // Ten metres apart in a straight line, but the detour is much longer.
    expect(path.length * graph.spacing).toBeGreaterThan(14);
  });
});

describe('travellers', () => {
  const crowd = makeCrowd();
  const result = run(crowd, 300);

  it('keeps everybody inside the walkable floor', () => {
    expect(
      result.worstOutsideRegion,
      `worst was ${(result.worstOutsideRegion * 1000).toFixed(1)} mm outside`,
    ).toBeLessThanOrEqual(1e-6);
  });

  it('never lets anybody stand inside the furniture', () => {
    // The resolve pass is the LAST thing to touch a position each frame, so
    // this is an exact constraint rather than a soft one: a shoulder's worth
    // of body may never be inside a desk, a scanner, a column or a bench.
    expect(
      result.worstInsideObstacle,
      `worst intrusion ${(result.worstInsideObstacle * 1000).toFixed(1)} mm`,
    ).toBeLessThan(0.01);
  });

  it('never lets two people stand in the same place', () => {
    // The positional pass targets 2 * TRAVELLER_RADIUS = 0.56 m. It runs after
    // the furniture push, so a person wedged into a corner can be squeezed a
    // little under that; a tenth of a shoulder is the tolerance.
    expect(
      result.minPairDistance,
      `closest pair was ${result.minPairDistance.toFixed(3)} m`,
    ).toBeGreaterThan(TRAVELLER_RADIUS * 1.9);
  });

  it('has people both walking and queueing', () => {
    expect(result.sawWalking).toBe(true);
    expect(result.sawQueueing).toBe(true);
    const stats = crowd.sim.stats;
    // The shipped 'high' population. Raised from 52 when the terminal was
    // measured reading as deserted; see `TerminalCrowd`'s `POPULATION`.
    expect(stats.population).toBe(78);
    expect(stats.walking + stats.queueing + stats.paused).toBe(stats.population);
    // A search that fails is a goal in another pocket of the graph. With one
    // connected component there should be none at all.
    expect(stats.failedSearches).toBe(0);
    expect(stats.searches).toBeGreaterThan(50);
  });

  it('advances both queues and never deadlocks', () => {
    for (let i = 0; i < QUEUES.length; i += 1) {
      const served = result.served[i] ?? 0;
      // Five minutes at four to nine seconds a head is 33 to 75 people.
      expect(served, `queue ${i} served ${served}`).toBeGreaterThan(28);
      // Nobody at the head of a line waits longer than one service interval,
      // whatever they or anybody else are doing. That is the whole
      // anti-deadlock argument, measured rather than asserted: the service
      // timer is unconditional, so a slot index can only ever go down.
      expect(
        result.worstHeadWait[i] ?? 0,
        `queue ${i} held its head for ${(result.worstHeadWait[i] ?? 0).toFixed(2)} s`,
      ).toBeLessThan(9.1);
      // And the lines are actually lines. A desk is sometimes idle at a quiet
      // regional field, which is right, but a hall where nobody ever queues
      // would pass every assertion above.
      expect(
        result.meanOccupancy[i] ?? 0,
        `queue ${i} averaged ${(result.meanOccupancy[i] ?? 0).toFixed(2)} people`,
      ).toBeGreaterThan(1.5);
      expect(result.peakOccupancy[i] ?? 0).toBeGreaterThanOrEqual(4);
    }
    expect(result.prefixViolations).toBe(0);
  });

  it('is identical for the same seed and different for another', () => {
    const a = makeCrowd(4242);
    const b = makeCrowd(4242);
    const c = makeCrowd(4243);
    for (let step = 0; step < 1200; step += 1) {
      a.sim.update(1 / 60, undefined);
      b.sim.update(1 / 60, undefined);
      c.sim.update(1 / 60, undefined);
    }
    let differsFromC = 0;
    for (let i = 0; i < a.sim.travellers.length; i += 1) {
      const pa = a.sim.travellers[i];
      const pb = b.sim.travellers[i];
      const pc = c.sim.travellers[i];
      if (!pa || !pb || !pc) continue;
      expect(pa.x).toBe(pb.x);
      expect(pa.z).toBe(pb.z);
      expect(pa.heading).toBe(pb.heading);
      expect(pa.walked).toBe(pb.walked);
      if (Math.hypot(pa.x - pc.x, pa.z - pc.z) > 1) differsFromC += 1;
    }
    expect(differsFromC).toBeGreaterThan(a.sim.travellers.length * 0.5);
    a.dispose();
    b.dispose();
    c.dispose();
  });
});

describe('a long run', () => {
  it('holds every invariant for ten minutes, at three seeds and half the frame rate', () => {
    // A THIRTY hertz step as well as the sixty the other tests use: the
    // constraints are positional, so they have to survive twice the distance
    // covered between two resolves.
    for (const seed of [1, 2, 3]) {
      const crowd = makeCrowd(seed);
      const result = run(crowd, 600, 1 / 30);
      expect(result.worstOutsideRegion, `seed ${seed}`).toBeLessThanOrEqual(1e-6);
      expect(result.worstInsideObstacle, `seed ${seed}`).toBeLessThan(0.01);
      expect(result.minPairDistance, `seed ${seed}`).toBeGreaterThan(TRAVELLER_RADIUS * 1.9);
      expect(result.prefixViolations, `seed ${seed}`).toBe(0);
      for (let i = 0; i < QUEUES.length; i += 1) {
        expect(result.worstHeadWait[i] ?? 0, `seed ${seed} queue ${i}`).toBeLessThan(9.2);
        expect(result.served[i] ?? 0, `seed ${seed} queue ${i}`).toBeGreaterThan(50);
      }
      crowd.dispose();
    }
  });

  it('puts all three kinds of luggage in the hall across a few seeds', () => {
    const seen = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5]) {
      const crowd = makeCrowd(seed);
      for (const t of crowd.sim.travellers) if (t.luggage) seen.add(t.luggage);
      crowd.dispose();
    }
    for (const kind of LUGGAGE_KINDS) expect([...seen]).toContain(kind);
  });
});

describe('the gate lounge', () => {
  const crowd = makeCrowd();

  it('sits people on real seats, and only where they fit', () => {
    const plans = crowd.seating;
    expect(plans.length).toBeGreaterThan(8);
    expect(plans.length).toBeLessThanOrEqual(SEATS.length);

    for (const plan of plans) {
      expect(SEATS).toContain(plan.anchor);
      expect(plan.stature).toBeGreaterThan(1.2);
      expect(plan.stature).toBeLessThan(1.4);
    }
    // Every seat is used at most once.
    expect(new Set(plans.map((plan) => plan.anchor)).size).toBe(plans.length);

    // And no two sitters overlap. The seats are on a 0.62 m pitch, so two of
    // the narrow pose fit side by side (0.53 m across) and the wide leaning
    // one (0.79 m) only fits where a neighbour is empty.
    for (let i = 0; i < plans.length; i += 1) {
      const a = plans[i];
      if (!a) continue;
      const specA = SEATED_SPECS[a.model];
      for (let j = i + 1; j < plans.length; j += 1) {
        const b = plans[j];
        if (!b) continue;
        const specB = SEATED_SPECS[b.model];
        const dx = a.anchor.x - b.anchor.x;
        const dz = a.anchor.z - b.anchor.z;
        const right = { x: Math.cos(a.anchor.heading), z: -Math.sin(a.anchor.heading) };
        const forward = { x: -Math.sin(a.anchor.heading), z: -Math.cos(a.anchor.heading) };
        const lateral = Math.abs(dx * right.x + dz * right.z);
        const along = Math.abs(dx * forward.x + dz * forward.z);
        const width = (specA.widthFraction * a.stature + specB.widthFraction * b.stature) / 2;
        const depth = (specA.depthFraction * a.stature + specB.depthFraction * b.stature) / 2;
        expect(
          lateral >= width || along >= depth,
          `${a.model} at ${a.anchor.z} overlaps ${b.model} at ${b.anchor.z}`,
        ).toBe(true);
      }
    }
  });

  it('places a seated figure on its own anchor, facing the right way', () => {
    const plan = crowd.seating[0];
    expect(plan).toBeDefined();
    if (!plan) return;
    const spec = SEATED_SPECS[plan.model];
    const out: PropPlacement = { x: 0, y: 0, z: 0, yaw: 0 };

    placeSeated(spec, plan.anchor, FLOOR, plan.stature, undefined, out);
    expect(out.x).toBe(plan.anchor.x);
    expect(out.z).toBe(plan.anchor.z);
    // Feet on the floor when the caller does not say where the pad is.
    expect(out.y).toBe(FLOOR);
    // The model faces its own +X, so it needs a quarter turn onto the heading.
    // Check it the same way the shader will: rotate the model's forward axis.
    const forwardX = Math.cos(out.yaw) * 1 + Math.sin(out.yaw) * 0;
    const forwardZ = -Math.sin(out.yaw) * 1 + Math.cos(out.yaw) * 0;
    expect(forwardX).toBeCloseTo(-Math.sin(plan.anchor.heading), 6);
    expect(forwardZ).toBeCloseTo(-Math.cos(plan.anchor.heading), 6);

    // With a pad height the figure is lifted onto it, but never so far that
    // its feet leave the ground by more than the limit.
    const padded = { ...plan.anchor, y: FLOOR + 0.44 };
    placeSeated(spec, padded, FLOOR, plan.stature, padded.y, out);
    expect(out.y).toBeGreaterThanOrEqual(FLOOR);
    expect(out.y).toBeLessThanOrEqual(FLOOR + SEAT_LIFT_LIMIT + 1e-9);

    // A pad LOWER than the pose's own hips drops the figure onto it, with no
    // limit: sitting slightly sunk into a bench is invisible, hovering is not.
    const low = { ...plan.anchor, y: FLOOR + 0.2 };
    placeSeated(spec, low, FLOOR, plan.stature, low.y, out);
    expect(out.y).toBeLessThan(FLOOR);
  });

  it('reports the pad height a bench should be built at', () => {
    const stats = crowd.stats;
    const a = SEATED_SPECS['seated-a'];
    expect(stats.impliedSeatPadY).toBeCloseTo(FLOOR + a.padFraction * a.stature, 6);
    // A bench, not a bar stool.
    expect(stats.impliedSeatPadY - FLOOR).toBeGreaterThan(0.3);
    expect(stats.impliedSeatPadY - FLOOR).toBeLessThan(0.5);
  });
});

describe('luggage', () => {
  const out: PropPlacement = { x: 0, y: 0, z: 0, yaw: 0 };

  it('rides in the carrier’s own frame through a full turn', () => {
    for (const kind of LUGGAGE_KINDS) {
      const spec = LUGGAGE_SPECS[kind];
      for (const girth of [0.88, 1.0, 1.18]) {
        for (const height of [1.54, 1.75, 1.92]) {
          const carrier = { x: 172.5, z: 431.25, heading: 0, height, girth };
          let previousYaw = Number.NaN;
          for (let i = 0; i < 64; i += 1) {
            const heading = (i / 64) * Math.PI * 2 - Math.PI;
            const turning = { ...carrier, heading };
            placeLuggage(spec, turning, FLOOR, 0.4, out);

            // Rotate the world offset back into the carrier's frame. It must
            // be the authored offset scaled by girth, exactly, at every angle:
            // that is what stops a case drifting off a wide traveller.
            const dx = out.x - carrier.x;
            const dz = out.z - carrier.z;
            const c = Math.cos(heading);
            const s = Math.sin(heading);
            const right = dx * c - dz * s;
            const back = dx * s + dz * c;
            expect(right).toBeCloseTo(spec.offset.right * girth, 10);
            expect(back).toBeCloseTo(spec.offset.back * girth, 10);
            expect(Math.hypot(dx, dz)).toBeCloseTo(
              Math.hypot(spec.offset.right, spec.offset.back) * girth,
              10,
            );
            // The piece turns with its carrier, one to one.
            if (Number.isFinite(previousYaw)) {
              expect(out.yaw - previousYaw).toBeCloseTo((Math.PI * 2) / 64, 10);
            }
            previousYaw = out.yaw;
          }
        }
      }
    }
  });

  it('stands a wheeled case on the floor and hangs a bag from the hand', () => {
    const short = { x: 0, z: 0, heading: 0.7, height: 1.54, girth: 0.88 };
    const tall = { x: 0, z: 0, heading: 0.7, height: 1.92, girth: 1.18 };

    // A suitcase is a floor-standing object: its owner's height cannot lift it
    // off the ground, and its wheels are on the floor for everybody.
    placeLuggage(LUGGAGE_SPECS.suitcase, short, FLOOR, 1.02, out);
    expect(out.y).toBe(FLOOR);
    placeLuggage(LUGGAGE_SPECS.suitcase, tall, FLOOR, 1.02, out);
    expect(out.y).toBe(FLOOR);

    // A duffel hangs, so it DOES rise with its owner.
    placeLuggage(LUGGAGE_SPECS.duffel, short, FLOOR, 0.375, out);
    const low = out.y;
    placeLuggage(LUGGAGE_SPECS.duffel, tall, FLOOR, 0.375, out);
    expect(out.y).toBeGreaterThan(low);
    expect(out.y - FLOOR).toBeCloseTo(
      tall.height * LUGGAGE_SPECS.duffel.offset.grip - 0.05 - 0.375,
      10,
    );
    // Never through the floor, whatever the caller asks for.
    placeLuggage(LUGGAGE_SPECS.duffel, short, FLOOR, 4, out);
    expect(out.y).toBe(FLOOR);
  });

  it('puts the wheeled case behind its owner and the trolley in front', () => {
    // Forward is (-sin h, -cos h). A case must be on the far side of that.
    for (const heading of [0, 1.1, -2.4, Math.PI]) {
      const carrier = { x: 5, z: -3, heading, height: 1.75, girth: 1 };
      const forwardX = -Math.sin(heading);
      const forwardZ = -Math.cos(heading);

      placeLuggage(LUGGAGE_SPECS.suitcase, carrier, FLOOR, 1.02, out);
      expect((out.x - carrier.x) * forwardX + (out.z - carrier.z) * forwardZ).toBeLessThan(-0.4);

      placeLuggage(LUGGAGE_SPECS.trolley, carrier, FLOOR, 1, out);
      expect((out.x - carrier.x) * forwardX + (out.z - carrier.z) * forwardZ).toBeGreaterThan(0.6);
    }
  });
});

describe('the walk cycle', () => {
  it('is driven by distance covered, in the units the matrix scales by', () => {
    const crowd = makeCrowd(99);
    const sim = crowd.sim;
    const before = sim.travellers.map((t) => ({ x: t.x, z: t.z, walked: t.walked }));
    // Frames on which somebody did not move at all. A clock-driven cycle would
    // still advance on those, and a person standing in a line would be
    // pedalling on the spot.
    let frozenFrames = 0;
    let frozenAdvances = 0;

    for (let step = 0; step < 900; step += 1) {
      for (let i = 0; i < sim.travellers.length; i += 1) {
        const t = sim.travellers[i];
        const mark = before[i];
        if (!t || !mark) continue;
        mark.x = t.x;
        mark.z = t.z;
        mark.walked = t.walked;
      }
      sim.update(1 / 60, undefined);

      for (let i = 0; i < sim.travellers.length; i += 1) {
        const t = sim.travellers[i];
        const mark = before[i];
        if (!t || !mark) continue;
        const dx = t.x - mark.x;
        const dz = t.z - mark.z;
        const forward = -dx * Math.sin(t.heading) - dz * Math.cos(t.heading);
        // Backwards or sideways displacement - a shove from a neighbour, a
        // push out of a desk - must not turn the legs. Only forward progress
        // does, and it is divided by GIRTH, because the instance matrix scales
        // the rig horizontally by girth and vertically by height. Dividing by
        // the wrong one runs the cycle 1.7 times too fast; `PedestrianSystem`
        // measured that as 130 mm of foot slide per footfall.
        const expected = forward > 0 ? forward / Math.max(0.4, t.look.girth) : 0;
        expect(t.walked - mark.walked).toBeCloseTo(expected, 9);
        if (dx === 0 && dz === 0) {
          frozenFrames += 1;
          if (t.walked !== mark.walked) frozenAdvances += 1;
        }
      }
    }

    // Somebody standing in a line does shuffle forward when it moves - that is
    // the whole point of a queue - so the check is not "a queuer never moves".
    // It is that a person who did not move did not animate either.
    expect(frozenFrames, 'nobody ever stood still').toBeGreaterThan(500);
    expect(frozenAdvances).toBe(0);
    crowd.dispose();
  });

  it('holds a planted foot still on the floor while the body walks over it', () => {
    // The same measurement `tests/pedestrianVat.test.ts` makes on the bake, but
    // in WORLD metres and through this system's own trace: the phase comes
    // from `walked`, and the pose is scaled by the traveller's girth and
    // height exactly as `TerminalCrowd` writes the instance matrix.
    const character = loadBake('ped-a');
    const walk = new VatClip(clipOf(character.meta, 'walk'));

    const crowd = makeCrowd(7);
    const sim = crowd.sim;
    // Follow whoever ends up covering the most ground.
    const traces: Sample[][] = sim.travellers.map(() => []);
    for (let step = 0; step < 3600; step += 1) {
      sim.update(1 / 60, undefined);
      for (let i = 0; i < sim.travellers.length; i += 1) {
        const t = sim.travellers[i];
        const trace = traces[i];
        if (!t || !trace) continue;
        trace.push({
          x: t.x,
          z: t.z,
          heading: t.heading,
          walked: t.walked,
          speed: t.speed,
          girth: t.look.girth,
          height: t.look.height,
        });
      }
    }
    crowd.dispose();

    const straight = longestStraightRun(traces, 150);
    expect(straight.length, 'no straight walk long enough to measure').toBeGreaterThan(70);

    const first = straight[0];
    expect(first).toBeDefined();
    if (!first) return;
    // The traveller's OWN scales. Measuring with anybody else's would report
    // the mismatch between two people rather than a foot sliding.
    const girth = first.girth;
    const height = first.height;
    const heading = first.heading;
    const sh = Math.sin(heading);
    const ch = Math.cos(heading);

    // The sole: the lowest eighty vertices of the clip's first frame.
    const sorted: { v: number; y: number }[] = [];
    for (let v = 0; v < character.meta.vertexCount; v += 1) {
      sorted.push({ v, y: character.at(v, walk.column)[1] });
    }
    sorted.sort((a, b) => a.y - b.y);
    const feet = sorted.slice(0, 80).map((entry) => entry.v);

    // Along-travel position of a pose point is -poseZ * girth, whatever the
    // heading, because the rig's own forward IS -Z: the rotation cancels.
    const along: number[][] = [];
    const lift: number[][] = [];
    for (const sample of straight) {
      const body = -sample.x * sh - sample.z * ch;
      const column = walk.column + walk.phaseFor(sample.walked) * walk.frames;
      const a: number[] = [];
      const y: number[] = [];
      for (const v of feet) {
        const p = character.at(v, column);
        a.push(body - p[2] * girth);
        y.push(p[1] * height);
      }
      along.push(a);
      lift.push(y);
    }

    const excursions: number[] = [];
    const steps = straight.length;
    // How many frames one loop of the clip takes at this traveller's pace. A
    // contact run has to be a fraction of that, or it has merged two separate
    // footfalls and would report a whole stride as slide. Same 8-to-45 per
    // cent window `tests/pedestrianVat.test.ts` uses on the bake itself.
    const loops =
      ((straight[steps - 1]?.walked ?? 0) - (first.walked ?? 0)) / walk.travelPerCycle;
    const perLoop = loops > 0.5 ? steps / loops : steps;
    for (let k = 0; k < feet.length; k += 1) {
      let ground = Infinity;
      for (let step = 0; step < steps; step += 1) ground = Math.min(ground, lift[step]?.[k] ?? 0);
      let contact: number[] = [];
      const flush = (): void => {
        if (contact.length >= perLoop * 0.08 && contact.length <= perLoop * 0.45) {
          excursions.push(Math.max(...contact) - Math.min(...contact));
        }
        contact = [];
      };
      for (let step = 0; step < steps; step += 1) {
        // 0.008 rig units, the bake tool's own contact band, times height.
        if ((lift[step]?.[k] ?? 1) < ground + 0.008 * height) contact.push(along[step]?.[k] ?? 0);
        else flush();
      }
      flush();
    }

    expect(excursions.length, 'no footfall was long enough to measure').toBeGreaterThan(40);
    excursions.sort((a, b) => a - b);
    const at = (q: number): number =>
      excursions[Math.min(excursions.length - 1, Math.floor(excursions.length * q))] ?? 0;

    // Real metres on the floor, not rig units: the pose's own forward offset
    // is scaled by GIRTH, which is what the instance matrix does to it, so
    // this is the slide a player would see rather than the bake's.
    //
    // Measured on the shipped ped-a bake through this system's own trace:
    // 288 footfalls, p50 31 mm, p90 118 mm. The procedural crowd this whole
    // pipeline replaced measured 283 mm median in the browser, and the bake's
    // own test puts these characters at 17 to 103 mm median in rig units - so
    // the terminal adds no slide of its own, which is the thing being pinned.
    // The tail is not skating: it is sole vertices that never truly plant,
    // caught by their own lowest point during a swing.
    expect(at(0.5), `median slide ${(at(0.5) * 1000).toFixed(0)} mm`).toBeLessThan(0.09);
    expect(at(0.9), `p90 slide ${(at(0.9) * 1000).toFixed(0)} mm`).toBeLessThan(0.18);
  });
});

/**
 * A baked character with no bake behind it.
 *
 * `TerminalCrowd` takes `characters` so a caller can hand it the crowd's
 * already-downloaded copies instead of paying for a second set; here it is
 * what lets the RENDER path - the instance matrices, the animation buffer,
 * the draw-call count - be asserted with no network and no GPU.
 */
function fakeCharacter(id: string): PedestrianVatCharacter {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(9), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(6), 2));
  geometry.setAttribute('aVid', new BufferAttribute(new Float32Array(3), 1));
  geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));
  const position = new DataTexture(new Uint16Array(4), 1, 1, RGBAFormat, HalfFloatType);
  const normal = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat, UnsignedByteType);
  // The real ped-a numbers: 48 frames, 2.33 s, 1.582 rig units of travel.
  const walk = new VatClip({
    name: 'walk',
    column: 0,
    frames: 48,
    duration: 2.33,
    travelPerCycle: 1.582,
    travel: Array.from({ length: 49 }, (_, i) => (i / 48) * 1.582),
    slip: 0,
  });
  const idle = new VatClip({
    name: 'idle',
    column: 49,
    frames: 20,
    duration: 2,
    travelPerCycle: 0,
    travel: new Array(21).fill(0),
    slip: 0,
  });
  return {
    id,
    geometry,
    position,
    normal,
    albedo: null,
    walk,
    idle,
    action: null,
    triangles: 2900,
    vertices: 3,
    bytes: 0,
    dispose(): void {
      geometry.dispose();
      position.dispose();
      normal.dispose();
    },
  };
}

describe('the rendered instances', () => {
  it('stands everybody on the floor, upright, at their own build', async () => {
    // Characters supplied by a caller are matched BY ID now that the street
    // and terminal rosters are different lists, so the test names the roster
    // it is standing up rather than relying on array order.
    const roster = ['ped-a', 'ped-b', 'ped-c', 'ped-d'];
    const owned = roster.map(fakeCharacter);
    const crowd = new TerminalCrowd({
      region: REGION,
      obstacles: OBSTACLES,
      seats: SEATS,
      queues: QUEUES,
      floorY: FLOOR,
      quality: 'high',
      seed: 5150,
      roster,
      characters: owned,
      // Nothing can be fetched from a unit test, so the prop models are
      // exercised through their failure branch: a terminal with no luggage
      // and no seated figures still has to run.
      baseUrl: 'file:///nowhere/',
    });
    await crowd.load();
    expect(crowd.stats.characters).toBe(4);
    expect(crowd.stats.missing.length).toBeGreaterThan(0);

    for (let step = 0; step < 300; step += 1) {
      crowd.update(1 / 60, { x: 183, z: 450, time: step / 60 });
    }

    const meshes = crowd.group.children.filter(
      (child): child is InstancedMesh =>
        child instanceof InstancedMesh && child.name.startsWith('traveller-ped-'),
    );
    expect(meshes).toHaveLength(4);

    let drawn = 0;
    for (const mesh of meshes) {
      const m = mesh.instanceMatrix.array as Float32Array;
      for (let n = 0; n < mesh.count; n += 1) {
        const o = n * 16;
        drawn += 1;
        // Grounded. The buffer is float32, so the floor comes back a
        // hundred-millionth of a metre light; a traveller a centimetre under
        // it is the single most visible thing that can go wrong indoors.
        expect(m[o + 13]).toBeCloseTo(FLOOR, 5);
        // A pure Y rotation with a diagonal scale: no shear anywhere. A
        // sheared or collapsed matrix is what a bind pose looks like on the
        // screen, and it cannot survive this.
        for (const slot of [1, 3, 4, 6, 7, 9, 11]) expect(m[o + slot]).toBe(0);
        expect(m[o + 15]).toBe(1);
        // Height and girth are the ranges `appearance.makeLook` draws from.
        const height = m[o + 5] ?? 0;
        expect(height).toBeGreaterThanOrEqual(1.54);
        expect(height).toBeLessThanOrEqual(1.92);
        const girth = Math.hypot(m[o] ?? 0, m[o + 2] ?? 0);
        expect(girth).toBeGreaterThan(0.87);
        expect(girth).toBeLessThan(1.19);
        // Columns 0 and 2 are the same rotation, scaled the same way.
        expect(Math.hypot(m[o + 8] ?? 0, m[o + 10] ?? 0)).toBeCloseTo(girth, 6);
        // And it is somebody who actually exists, where they actually are.
        const here = crowd.sim.travellers.some(
          (t) => Math.abs(t.x - (m[o + 12] ?? 0)) < 1e-4 && Math.abs(t.z - (m[o + 14] ?? 0)) < 1e-4,
        );
        expect(here).toBe(true);
      }

      const anim = mesh.geometry.getAttribute('iAnim');
      for (let n = 0; n < mesh.count; n += 1) {
        expect(anim.getX(n)).toBeGreaterThanOrEqual(0);
        expect(anim.getX(n)).toBeLessThan(1);
        expect(anim.getY(n)).toBeGreaterThanOrEqual(0);
        expect(anim.getY(n)).toBeLessThan(1);
        expect(anim.getZ(n)).toBeGreaterThanOrEqual(0);
        expect(anim.getZ(n)).toBeLessThanOrEqual(1);
        // The civilian bakes carry no action clip, so the blend must be zero
        // or the shader fetches a pose that is not there.
        expect(anim.getW(n)).toBe(0);
      }
    }

    expect(drawn).toBe(crowd.stats.rendered);
    expect(drawn).toBeGreaterThan(30);
    // Four characters, no luggage and no seated model: four draw calls.
    expect(crowd.stats.drawCalls).toBe(4);
    expect(crowd.stats.triangles).toBe(drawn * 2900);

    // Disposal must not take the caller's characters with it.
    crowd.dispose();
    expect(owned[0]?.geometry.getAttribute('position')).toBeDefined();
    for (const character of owned) character.dispose();
  });
});

describe('culling', () => {
  it('does no work at all while the player is elsewhere', () => {
    const crowd = makeCrowd(11);
    const sim = crowd.sim;
    const downtown = { x: 190, z: 40 };

    // The city ends 170 m north of the terminal. Nothing may move, nothing may
    // draw, and the group is switched off so Three.js does not even walk it.
    const before = sim.travellers.map((t) => ({ x: t.x, z: t.z, walked: t.walked }));
    for (let step = 0; step < 600; step += 1) {
      crowd.update(1 / 60, { ...downtown, time: step / 60 });
    }
    expect(crowd.stats.active).toBe(false);
    expect(crowd.stats.rendered).toBe(0);
    expect(crowd.stats.drawCalls).toBe(0);
    expect(crowd.group.visible).toBe(false);
    for (let i = 0; i < sim.travellers.length; i += 1) {
      const t = sim.travellers[i];
      const mark = before[i];
      if (!t || !mark) continue;
      expect(t.x).toBe(mark.x);
      expect(t.z).toBe(mark.z);
      expect(t.walked).toBe(mark.walked);
    }

    // Walk in and everything starts.
    for (let step = 0; step < 240; step += 1) {
      crowd.update(1 / 60, { x: 183, z: 450, time: step / 60 });
    }
    expect(crowd.stats.active).toBe(true);
    expect(crowd.group.visible).toBe(true);
    let moved = 0;
    for (let i = 0; i < sim.travellers.length; i += 1) {
      const t = sim.travellers[i];
      const mark = before[i];
      if (!t || !mark) continue;
      if (Math.hypot(t.x - mark.x, t.z - mark.z) > 0.1) moved += 1;
    }
    expect(moved).toBeGreaterThan(sim.travellers.length * 0.3);

    // And it stops again on the way out, with hysteresis: 60 m past the end
    // wall is inside the exit range and still running, 200 m out is not.
    crowd.update(1 / 60, { x: 183, z: 603, time: 3 });
    expect(crowd.stats.active).toBe(true);
    crowd.update(1 / 60, { x: 183, z: 760, time: 4 });
    expect(crowd.stats.active).toBe(false);
    crowd.dispose();
  });

  it('draws nothing before its characters arrive, and never throws', () => {
    // `load()` is never called here, so no character, no luggage model and no
    // seated model exists. The terminal must simply be empty rather than
    // broken - the same contract the street crowd and `Furnishings` keep.
    const crowd = makeCrowd(3);
    for (let step = 0; step < 120; step += 1) {
      crowd.update(1 / 60, { x: 183, z: 450, time: step / 60 });
    }
    expect(crowd.stats.active).toBe(true);
    expect(crowd.stats.characters).toBe(0);
    expect(crowd.stats.rendered).toBe(0);
    expect(crowd.stats.drawCalls).toBe(0);
    expect(crowd.stats.triangles).toBe(0);
    // The simulation still runs, so walking in as the download lands does not
    // show fifty people standing at their spawn points.
    expect(crowd.sim.stats.searches).toBeGreaterThan(0);
    crowd.dispose();
  });
});

/* ------------------------------------------------------------------ */
/* Reading the shipped bake, for the planted-foot measurement.         */
/* ------------------------------------------------------------------ */

interface BakeClip {
  name: string;
  column: number;
  frames: number;
  duration: number;
  travelPerCycle: number;
  travel: number[];
  slip: number;
}

interface BakeMeta {
  vertexCount: number;
  texture: { width: number; height: number };
  clips: BakeClip[];
  layout: Record<string, { offset: number; length: number }>;
}

function fromHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * (mantissa + 1024) * 2 ** (exponent - 25);
}

function loadBake(id: string): {
  meta: BakeMeta;
  at(vertex: number, column: number): [number, number, number];
} {
  const base = 'public/models/pedestrians';
  const meta = JSON.parse(readFileSync(`${base}/${id}.json`, 'utf8')) as BakeMeta;
  const bin = readFileSync(`${base}/${id}.bin`);
  const section = meta.layout.position;
  if (!section) throw new Error(`${id}: no position section`);
  const positions = new Uint16Array(
    bin.buffer.slice(
      bin.byteOffset + section.offset,
      bin.byteOffset + section.offset + section.length,
    ),
  );
  const width = meta.texture.width;
  return {
    meta,
    at(vertex: number, column: number): [number, number, number] {
      const low = Math.floor(column);
      const t = column - low;
      const a = (vertex * width + low) * 4;
      const b = (vertex * width + low + 1) * 4;
      const mix = (k: number): number =>
        fromHalf(positions[a + k] ?? 0) * (1 - t) + fromHalf(positions[b + k] ?? 0) * t;
      return [mix(0), mix(1), mix(2)];
    },
  };
}

function clipOf(meta: BakeMeta, name: string): BakeClip {
  const clip = meta.clips.find((entry) => entry.name === name);
  if (!clip) throw new Error(`no ${name} clip`);
  return clip;
}

/**
 * The longest stretch, across every traveller, of walking in a straight line.
 *
 * A turn rotates the feet, and measuring slide through one would report the
 * arc of the turn rather than a skating foot. Straight means the heading moved
 * by under half a degree over the whole run.
 */
function longestStraightRun(traces: readonly (readonly Sample[])[], want: number): Sample[] {
  let best: Sample[] = [];
  for (const trace of traces) {
    let run: Sample[] = [];
    for (const sample of trace) {
      const first = run[0];
      // Three degrees over the whole run. At 1.8 m of travel that is under a
      // millimetre of projection error, and a tighter bound finds no run at
      // all in a hall where fifty people are steering around each other.
      const straight =
        !first || (Math.abs(sample.heading - first.heading) < 0.05 && sample.speed > 0.7);
      if (straight && sample.speed > 0.7) {
        run.push(sample);
        if (run.length > best.length) best = run.slice();
        if (best.length >= want) return best;
      } else {
        run = sample.speed > 0.7 ? [sample] : [];
      }
    }
  }
  return best;
}
