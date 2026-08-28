/**
 * The airport's surfaces, checked without a renderer.
 *
 * ## The defect these exist for
 *
 * The terminal floor rendered as flickering grey and white bands that changed
 * as the camera moved. Two independent causes, both of them a depth-buffer
 * problem rather than a lighting one:
 *
 *  1. `buildTerminalShell` emitted the plinth as one box whose TOP face was at
 *     exactly `TERMINAL_FLOOR`, and `buildTerminalInterior` laid the interior
 *     floor slab with its top face at exactly `TERMINAL_FLOOR` too, entirely
 *     inside it. Two coplanar, fully overlapping surfaces give the depth test
 *     nothing to choose between, so which one wins is decided by floating
 *     point noise, per pixel, and changes with the camera.
 *  2. The floor bands and the walking line were emitted 4 mm above the floor.
 *     The camera is `PerspectiveCamera(62, 1, 0.1, 1200)`, so on a 24-bit
 *     depth buffer the smallest resolvable step at range z is about
 *     `z^2 * (f - n) / (f * n * 2^24)` = `z^2 * 6.0e-7` metres - 3.8 mm at
 *     80 m. The building is 190 m long, so the far half of every band was
 *     inside the buffer's own resolution.
 *
 * ## What is asserted
 *
 * Not "the floor slab is not coplanar with the plinth", which would pass the
 * moment somebody reintroduced the same mistake anywhere else. The tests below
 * take every triangle the airport emits, keep the upward-facing ones, and
 * check the whole set pairwise:
 *
 *  - no two overlapping horizontal surfaces may be coplanar at all;
 *  - no two overlapping horizontal surfaces may be closer than
 *    `MIN_SURFACE_SEPARATION`.
 *
 * Only UPWARD faces are compared with upward faces. Materials are `FrontSide`,
 * so an upward face and a downward face in the same plane never both survive
 * back-face culling and cannot fight; a counter top resting exactly on the
 * carcass below it is correct construction, not a defect.
 *
 * Overlap is measured as real polygon area, not as bounding boxes. Two
 * triangles of the same quad share an edge and a cylinder cap is a fan of
 * triangles round one vertex; both have overlapping bounds and zero shared
 * area, and calling either a defect would make the test useless.
 */

import { describe, expect, it } from 'vitest';
import { BufferGeometry, Matrix4 } from 'three';

import { insetRect } from '../src/core/mathx';
import type { MaterialKey } from '../src/render/materials';
import { BoxIndex, buildTerminalGraph, TerminalPaths } from '../src/agents/travellers';
import type {
  ColliderBox,
  GeometrySink,
  InteractionPoint,
  LightRequest,
  PropKey,
} from '../src/world/build/types';
import {
  buildAirfieldLighting,
  buildAirportSignage,
  buildHangars,
  buildTerminalShell,
  buildTower,
} from '../src/world/airport/buildings';
import { TERMINAL, TERMINAL_FLOOR } from '../src/world/airport/layout';
import {
  BAGGAGE_Z,
  BENCH_BACK_X,
  BENCH_BLOCK_Z,
  CONCOURSE_SPINE,
  GATE_SEATS,
  SEAT_PAD_HEIGHT,
  SECURITY_LANES,
  SECURITY_LANE_HALF,
  SECURITY_Z,
  TERMINAL_QUEUES,
} from '../src/world/airport/plan';
import {
  buildTerminalInterior,
  MIN_SURFACE_SEPARATION,
  terminalModelAnchors,
} from '../src/world/airport/terminal';
import { TERMINAL_DOORS, doorCentre, doorNormal } from '../src/world/airport/buildings';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/**
 * A sink that KEEPS geometry.
 *
 * `RecordingSink` reduces each geometry to a bounding box and disposes it,
 * which is right for the placement checks it was written for and useless here:
 * `WorldBatch` merges every box of one material into a single geometry, so a
 * bounding box says only that the terminal is terminal-shaped.
 */
class KeepSink implements GeometrySink {
  readonly parts: { key: MaterialKey; geometry: BufferGeometry }[] = [];
  readonly colliders: ColliderBox[] = [];
  readonly lights: LightRequest[] = [];
  readonly interactions: InteractionPoint[] = [];

  add(key: MaterialKey, geometry: BufferGeometry): void {
    this.parts.push({ key, geometry });
  }

  instance(_prop: PropKey, _matrix: Matrix4): void {
    /* the airport interior places no props */
  }

  collider(box: ColliderBox): void {
    this.colliders.push(box);
  }

  light(request: LightRequest): void {
    this.lights.push(request);
  }

  interaction(point: InteractionPoint): void {
    this.interactions.push(point);
  }

  get triangles(): number {
    let total = 0;
    for (const part of this.parts) {
      const index = part.geometry.index;
      const position = part.geometry.getAttribute('position');
      total += (index?.count ?? position.count) / 3;
    }
    return total;
  }
}

/** One (x, z) pair. A fixed tuple, so indexing it needs no guard. */
type Point = readonly [number, number];

interface Facet {
  readonly key: MaterialKey;
  readonly y: number;
  /** The triangle in plan, as three (x, z) pairs. */
  readonly points: readonly [Point, Point, Point];
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** How level a face must be to count as horizontal. */
const UP = 0.999;
/** Triangles smaller than this in plan are not a surface anybody can see. */
const MIN_AREA = 1e-4;

/** Every upward-facing triangle in a sink, in plan. */
function upwardFacets(sink: KeepSink): Facet[] {
  const out: Facet[] = [];
  for (const part of sink.parts) {
    const position = part.geometry.getAttribute('position');
    const normal = part.geometry.getAttribute('normal');
    const index = part.geometry.index;
    const count = index ? index.count : position.count;
    for (let i = 0; i < count; i += 3) {
      const a = index ? index.getX(i) : i;
      const b = index ? index.getX(i + 1) : i + 1;
      const c = index ? index.getX(i + 2) : i + 2;
      if (normal.getY(a) < UP || normal.getY(b) < UP || normal.getY(c) < UP) continue;
      const points: readonly [Point, Point, Point] = [
        [position.getX(a), position.getZ(a)],
        [position.getX(b), position.getZ(b)],
        [position.getX(c), position.getZ(c)],
      ];
      const area = Math.abs(
        (points[1][0] - points[0][0]) * (points[2][1] - points[0][1]) -
          (points[2][0] - points[0][0]) * (points[1][1] - points[0][1]),
      ) * 0.5;
      if (area < MIN_AREA) continue;
      const xs = points.map((p) => p[0]);
      const zs = points.map((p) => p[1]);
      out.push({
        key: part.key,
        y: (position.getY(a) + position.getY(b) + position.getY(c)) / 3,
        points,
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minZ: Math.min(...zs),
        maxZ: Math.max(...zs),
      });
    }
  }
  return out;
}

/**
 * Area shared by two triangles in plan.
 *
 * Sutherland-Hodgman: clip one triangle by the three half-planes of the other,
 * then take the shoelace area of what is left. Exact for convex polygons,
 * which triangles are, and it is what makes "these two share an edge" and
 * "these two are drawn on top of each other" different answers.
 */
function sharedArea(a: Facet, b: Facet): number {
  let polygon: Point[] = [...a.points];
  const [p0, p1, p2] = b.points;
  // Orient the clipper counter-clockwise so every inside test has one sign.
  const turn = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
  const clipper: readonly [Point, Point, Point] = turn >= 0 ? [p0, p1, p2] : [p0, p2, p1];

  for (let e = 0; e < 3 && polygon.length > 0; e += 1) {
    const from = clipper[e] as Point;
    const to = clipper[(e + 1) % 3] as Point;
    const ex = to[0] - from[0];
    const ez = to[1] - from[1];
    const side = (p: Point): number => ex * (p[1] - from[1]) - ez * (p[0] - from[0]);
    const next: Point[] = [];
    for (let i = 0; i < polygon.length; i += 1) {
      const current = polygon[i] as Point;
      const previous = polygon[(i + polygon.length - 1) % polygon.length] as Point;
      const currentIn = side(current) >= 0;
      const previousIn = side(previous) >= 0;
      if (currentIn !== previousIn) {
        const d = side(previous) - side(current);
        const t = Math.abs(d) < 1e-12 ? 0 : side(previous) / d;
        next.push([previous[0] + (current[0] - previous[0]) * t, previous[1] + (current[1] - previous[1]) * t]);
      }
      if (currentIn) next.push(current);
    }
    polygon = next;
  }

  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const p = polygon[i] as Point;
    const q = polygon[(i + 1) % polygon.length] as Point;
    area += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(area) * 0.5;
}

/**
 * The closest pair of overlapping upward surfaces, and how far apart they are.
 *
 * Bucketed by height first, because the only pairs that can fail are the ones
 * within `limit` of each other vertically, and then by a coarse plan grid so
 * that 190 m of building is not an O(n^2) sweep over every triangle in it.
 */
interface Conflict {
  readonly gap: number;
  readonly area: number;
  readonly a: Facet;
  readonly b: Facet;
}

function closestOverlaps(facets: readonly Facet[], limit: number): Conflict[] {
  const CELL = 4;
  const cells = new Map<string, Facet[]>();
  const keysFor = (facet: Facet): string[] => {
    const out: string[] = [];
    for (let cx = Math.floor(facet.minX / CELL); cx <= Math.floor(facet.maxX / CELL); cx += 1) {
      for (let cz = Math.floor(facet.minZ / CELL); cz <= Math.floor(facet.maxZ / CELL); cz += 1) {
        out.push(`${cx},${cz}`);
      }
    }
    return out;
  };

  const found = new Map<string, Conflict>();
  for (const facet of facets) {
    for (const key of keysFor(facet)) {
      const bucket = cells.get(key);
      if (!bucket) {
        cells.set(key, [facet]);
        continue;
      }
      for (const other of bucket) {
        const gap = Math.abs(other.y - facet.y);
        if (gap > limit) continue;
        if (facet.maxX <= other.minX || other.maxX <= facet.minX) continue;
        if (facet.maxZ <= other.minZ || other.maxZ <= facet.minZ) continue;
        const area = sharedArea(facet, other);
        if (area <= MIN_AREA) continue;
        // One entry per pair, however many grid cells they meet in.
        const id = `${facet.key}:${facet.minX.toFixed(2)},${facet.minZ.toFixed(2)},${facet.y.toFixed(4)}|${other.key}:${other.minX.toFixed(2)},${other.minZ.toFixed(2)},${other.y.toFixed(4)}`;
        if (!found.has(id)) found.set(id, { gap, area, a: facet, b: other });
      }
      bucket.push(facet);
    }
  }
  return [...found.values()].sort((p, q) => p.gap - q.gap || q.area - p.area);
}

function describeConflict(c: Conflict): string {
  return (
    `${c.a.key} at y=${c.a.y.toFixed(4)} and ${c.b.key} at y=${c.b.y.toFixed(4)} ` +
    `(gap ${(c.gap * 1000).toFixed(1)} mm) share ${c.area.toFixed(3)} m^2 near ` +
    `x=${((c.a.minX + c.a.maxX) / 2).toFixed(1)}, z=${((c.a.minZ + c.a.maxZ) / 2).toFixed(1)}`
  );
}

// ---------------------------------------------------------------------------
// The build, once
// ---------------------------------------------------------------------------

const interior = new KeepSink();
buildTerminalInterior(interior);

const airport = new KeepSink();
buildTerminalShell(airport);
buildTerminalInterior(airport);
buildTower(airport);
buildHangars(airport);
buildAirfieldLighting(airport);
buildAirportSignage(airport);

const facets = upwardFacets(airport);

describe('the terminal floor cannot z-fight', () => {
  it('emits a floor made of surfaces, not one surface with things on top of it', () => {
    // A real mosaic, not a slab: the floor is zoned into rooms and the bands
    // and the walking line are cut into it rather than laid over it.
    const floor = facets.filter(
      (f) =>
        Math.abs(f.y - TERMINAL_FLOOR) < 1e-6 &&
        f.minX >= TERMINAL.minX &&
        f.maxX <= TERMINAL.maxX &&
        f.minZ >= TERMINAL.minZ &&
        f.maxZ <= TERMINAL.maxZ,
    );
    expect(floor.length).toBeGreaterThan(40);
    const keys = new Set(floor.map((f) => f.key));
    expect(keys.size, `floor materials: ${[...keys].join(', ')}`).toBeGreaterThanOrEqual(5);
  });

  it('never draws two horizontal surfaces in the same plane over the same ground', () => {
    /*
     * The regression, stated as the CLASS of defect. This would have failed on
     * the plinth and the floor slab, on the floor bands before they were cut
     * into the floor, and on the ceiling step and the hall ceiling - all of
     * which were real, and none of which is the same line of code.
     */
    const coplanar = closestOverlaps(facets, 1e-6);
    expect(
      coplanar.slice(0, 6).map(describeConflict).join('\n'),
      `${coplanar.length} coplanar overlapping surfaces`,
    ).toBe('');
  });

  it('keeps every overlapping pair outside the depth buffer resolution', () => {
    /*
     * `MIN_SURFACE_SEPARATION` is 25 mm and it is derived, not chosen: the
     * depth step at the 200 m diagonal of this building is `200^2 * 6.0e-7`,
     * which is 24 mm. Anything closer than that is a coin flip somewhere in
     * the room.
     */
    const tooClose = closestOverlaps(facets, MIN_SURFACE_SEPARATION - 1e-9);
    expect(
      tooClose.slice(0, 6).map(describeConflict).join('\n'),
      `${tooClose.length} pairs closer than ${MIN_SURFACE_SEPARATION * 1000} mm`,
    ).toBe('');
  });

  it('derives that threshold from the camera it has to survive', () => {
    // near 0.1, far 1200, 24 bits - `Engine.ts`. Restated here so the number
    // above is checked rather than remembered.
    const step = (z: number): number => (z * z * (1200 - 0.1)) / (1200 * 0.1 * 2 ** 24);
    const diagonal = Math.hypot(TERMINAL.maxX - TERMINAL.minX, TERMINAL.maxZ - TERMINAL.minZ);
    expect(step(diagonal)).toBeGreaterThan(0.02);
    expect(MIN_SURFACE_SEPARATION).toBeGreaterThan(step(diagonal));
  });
});

describe('the floor everyone agrees on', () => {
  it('walks on the same level the builder draws and the crowd stands on', () => {
    const walkable = interior.colliders.filter(
      (box) =>
        !box.solid &&
        box.minX <= TERMINAL.minX + 0.01 &&
        box.maxX >= TERMINAL.maxX - 0.01 &&
        box.minZ <= TERMINAL.minZ + 0.01 &&
        box.maxZ >= TERMINAL.maxZ - 0.01,
    );
    expect(walkable.length, 'exactly one walkable floor collider').toBe(1);
    expect(walkable[0]?.top).toBeCloseTo(TERMINAL_FLOOR, 6);

    // The drawn floor is at the same height as the thing that carries it.
    const drawn = facets.filter(
      (f) => f.minX > TERMINAL.minX && f.maxX < TERMINAL.maxX && Math.abs(f.y - TERMINAL_FLOOR) < 1e-6,
    );
    expect(drawn.length).toBeGreaterThan(40);

    // And the seated figures the traveller crowd places sit on the pad the
    // bench builder emits, which is measured from the models themselves.
    const pads = facets.filter(
      (f) =>
        Math.abs(f.y - (TERMINAL_FLOOR + SEAT_PAD_HEIGHT)) < 1e-6 &&
        Math.abs(f.minX + f.maxX) / 2 > BENCH_BACK_X - 2 &&
        Math.abs(f.minX + f.maxX) / 2 < BENCH_BACK_X + 2,
    );
    expect(pads.length, 'no bench pad at SEAT_PAD_HEIGHT').toBeGreaterThan(0);
    for (const seat of GATE_SEATS) {
      const under = pads.some(
        (f) => seat.x >= f.minX - 0.01 && seat.x <= f.maxX + 0.01 && seat.z >= f.minZ - 0.01 && seat.z <= f.maxZ + 0.01,
      );
      expect(under, `no pad under the seat at ${seat.x}, ${seat.z}`).toBe(true);
    }
  });

  it('covers the whole interior with floor, leaving no hole to fall through', () => {
    const drawn = facets.filter((f) => Math.abs(f.y - TERMINAL_FLOOR) < 1e-6);
    for (let x = TERMINAL.minX + 1; x < TERMINAL.maxX; x += 2.5) {
      for (let z = TERMINAL.minZ + 1; z < TERMINAL.maxZ; z += 3.5) {
        const covered = drawn.some((f) => x >= f.minX && x <= f.maxX && z >= f.minZ && z <= f.maxZ);
        expect(covered, `no floor at ${x.toFixed(1)}, ${z.toFixed(1)}`).toBe(true);
      }
    }
  });
});

describe('the terminal stays walkable', () => {
  const region = insetRect(TERMINAL, 1.6);
  const index = new BoxIndex(interior.colliders, region, TERMINAL_FLOOR);
  const graph = buildTerminalGraph({ region, obstacles: index });

  it('leaves the concourse spine clear from the entrance to the baggage hall', () => {
    const blocking = index.boxes.filter(
      (box) =>
        box.maxX > CONCOURSE_SPINE.minX &&
        box.minX < CONCOURSE_SPINE.maxX &&
        box.maxZ > TERMINAL.minZ &&
        box.minZ < BAGGAGE_Z,
    );
    expect(
      blocking.slice(0, 4).map((b) => `${b.surface ?? 'box'} at x ${b.minX}..${b.maxX}, z ${b.minZ}..${b.maxZ}`).join('\n'),
    ).toBe('');
  });

  it('leaves every security lane its full width', () => {
    for (const lane of SECURITY_LANES) {
      const blocking = index.boxes.filter(
        (box) =>
          box.maxX > lane - SECURITY_LANE_HALF &&
          box.minX < lane + SECURITY_LANE_HALF &&
          box.maxZ > SECURITY_Z - 1.2 &&
          box.minZ < SECURITY_Z + 1.2,
      );
      expect(blocking.length, `lane ${lane} is obstructed`).toBe(0);
    }
  });

  it('leaves the approach to every door clear', () => {
    for (const door of TERMINAL_DOORS) {
      const centre = doorCentre(door);
      const normal = doorNormal(door);
      for (const reach of [1.2, 2.4, 3.6]) {
        const x = centre.x + normal.x * -reach;
        const z = centre.z + normal.z * -reach;
        expect(
          index.blocked(x, z, 0.55),
          `${door.id} is blocked ${reach} m inside the opening`,
        ).toBe(false);
      }
    }
  });

  it('leaves room in front of every published queue anchor', () => {
    for (const queue of TERMINAL_QUEUES) {
      const slots = queue.slots ?? 8;
      // The line runs BACKWARDS from the head: forward is (-sin h, 0, -cos h).
      const backX = Math.sin(queue.heading);
      const backZ = Math.cos(queue.heading);
      for (let k = 0; k < slots; k += 1) {
        const x = queue.x + backX * k * 0.92;
        const z = queue.z + backZ * k * 0.92;
        expect(index.blocked(x, z, 0.32), `queue slot ${k} at ${x.toFixed(1)}, ${z.toFixed(1)}`).toBe(
          false,
        );
      }
    }
  });

  it('connects the entrance, the gate lounge and the baggage hall on one graph', () => {
    expect(graph.count).toBeGreaterThan(400);
    const paths = new TerminalPaths(graph);
    const out: number[] = [];
    const at = (x: number, z: number): number => graph.nearest(x, z);
    const places: [string, number, number][] = [
      ['entrance', 183, TERMINAL.minZ + 4],
      ['check-in', 168, 380],
      ['security', 183, SECURITY_Z - 6],
      ['gate lounge', 184, BENCH_BLOCK_Z[1] ?? 472],
      ['gate 3', 203, 512],
      ['baggage', 183, BAGGAGE_Z + 8],
    ];
    for (let i = 1; i < places.length; i += 1) {
      const from = places[i - 1] as [string, number, number];
      const to = places[i] as [string, number, number];
      const a = at(from[1], from[2]);
      const b = at(to[1], to[2]);
      expect(a, `${from[0]} has no node`).toBeGreaterThanOrEqual(0);
      expect(b, `${to[0]} has no node`).toBeGreaterThanOrEqual(0);
      expect(paths.find(a, b, out), `no route from ${from[0]} to ${to[0]}`).toBe(true);
    }
  });
});

describe('the terminal stays inside its budget', () => {
  it('is the size the header claims', () => {
    // MEASURED, and the header is written from this number. It was 8,656 for
    // the first fit-out; the increase bought the soffits, the mezzanine, five
    // retail units, the check-in islands and the lighting scheme.
    expect(interior.triangles).toBeGreaterThan(12000);
    expect(interior.triangles, `${interior.triangles} triangles`).toBeLessThan(24000);
  });

  it('asks for no more light than the renderer can rank', () => {
    expect(interior.lights.length).toBeLessThanOrEqual(16);
    for (const light of interior.lights) {
      expect(light.priority, 'terminal lights must yield to the street').toBe(2);
    }
  });

  it('keeps every generated model inside the building and on the floor', () => {
    const anchors = terminalModelAnchors();
    expect(anchors.length).toBeGreaterThan(20);
    for (const anchor of anchors) {
      // On the floor, or on the reclaim belt at 0.79 m. Nothing floats.
      expect(anchor.y).toBeGreaterThanOrEqual(TERMINAL_FLOOR);
      expect(anchor.y, `${anchor.model} is ${anchor.y - TERMINAL_FLOOR} m up`).toBeLessThanOrEqual(
        TERMINAL_FLOOR + 0.8,
      );
      expect(anchor.x, `${anchor.model} is outside the west wall`).toBeGreaterThan(TERMINAL.minX);
      expect(anchor.x, `${anchor.model} is outside the east wall`).toBeLessThan(TERMINAL.maxX);
      expect(anchor.z).toBeGreaterThan(TERMINAL.minZ);
      expect(anchor.z).toBeLessThan(TERMINAL.maxZ);
    }
  });
});
