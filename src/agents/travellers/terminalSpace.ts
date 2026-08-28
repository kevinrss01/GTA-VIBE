/**
 * The walkable floor of the terminal, and the graph laid over it.
 *
 * Nothing here imports Three.js, so the whole navigable space can be built and
 * asserted in a unit test - the same split `crowd.ts` and `pavement.ts` keep
 * for the street.
 *
 * ## Why this is not the pavement graph
 *
 * `buildPavementGraph` derives its links from street pavements and crossings.
 * There is no parcel, no door and no floor anywhere in it, and
 * `tests/pedestrians.test.ts` asserts over thousands of samples that every
 * non-crossing link is on unbuilt ground with a pavement surface. The street
 * crowd therefore CANNOT be extended indoors: its corridor clamp is what keeps
 * it out of buildings, and removing that would put three hundred people
 * through the city's walls to get one of them into the terminal.
 *
 * So the terminal gets its own space. It is taken entirely as constructor
 * input - a walkable rectangle, the collider boxes the building already emits,
 * and the seat and queue anchors - because the building itself is authored by
 * another module and this one must not have to agree with it about anything
 * except numbers.
 *
 * ## Why a lattice and not an authored spine
 *
 * A hand-drawn concourse spine would be one line of code and would be wrong
 * the first time somebody moved a check-in desk. Instead a lattice is laid
 * over the walkable rectangle, every node that is inside furniture is dropped,
 * every link whose swept corridor touches furniture is dropped, and only the
 * largest connected component survives. The result is a spine, cross-links and
 * gate spurs when the furniture makes those shapes, and it stays correct when
 * the furniture moves.
 *
 * The concourse READS as a concourse because of how goals are picked - long
 * traverses between opposite ends and the queue tails, see `travellerSim.ts` -
 * not because the graph is drawn that way.
 */

import { clamp, insetRect, type Rect } from '../../core/mathx';
import type { ColliderBox } from '../../world/build/types';

/** Half a shoulder width, matching the street crowd's `PED_RADIUS`. */
export const TRAVELLER_RADIUS = 0.28;

/** A point on the floor and the direction somebody standing there faces. */
export interface FloorAnchor {
  readonly x: number;
  readonly z: number;
  /** Camera-convention heading: forward is `(-sin h, 0, -cos h)`. */
  readonly heading: number;
}

/**
 * One seat in the gate lounge.
 *
 * `y` is the world height of the seat PAD when the caller knows it. Left off,
 * the seated figure is placed with its feet on the floor, which is always
 * physically right; supplied, the figure's hips are lifted onto the pad
 * instead - clamped so its feet never leave the ground by more than
 * `SEAT_LIFT_LIMIT`, because a person hovering above a bench is worse than a
 * person perched slightly low on one.
 */
export interface SeatAnchor extends FloorAnchor {
  readonly y?: number | undefined;
}

/**
 * One queue.
 *
 * `x`/`z` is where the person AT THE HEAD stands - not the desk face - and
 * `heading` is the direction they face. The line extends backwards from there.
 */
export interface QueueAnchor extends FloorAnchor {
  readonly id?: string | undefined;
  /** How many people the line holds. Defaults to `DEFAULT_QUEUE_SLOTS`. */
  readonly slots?: number | undefined;
}

/**
 * Obstacle grid cell, in metres.
 *
 * Boxes are registered into every cell they overlap after being grown by
 * `MAX_QUERY_RADIUS`, so a query only ever has to look in the point's OWN
 * cell. That is what makes `resolve` a hash lookup and a short loop rather
 * than the nine-cell sweep the street's `ObstacleIndex` does.
 */
const CELL = 6;

/** The largest radius any query may pass. Baked into the registration grow. */
const MAX_QUERY_RADIUS = 1.2;

/** Obstacles whose top is below this above the floor are stepped over. */
const MIN_OBSTACLE_HEIGHT = 0.3;

/** Obstacles whose base is above this cannot be walked into. */
const REACH_ABOVE_FLOOR = 1.9;

/** Spacing of the samples `segmentBlocked` takes along a link, in metres. */
const SEGMENT_STEP = 0.3;

/**
 * A grid index over the terminal's collision boxes.
 *
 * Deliberately NOT `agents/obstacles.ts`: that one re-derives street furniture
 * from the city plan and knows nothing about a building interior. This takes
 * the boxes the caller already has.
 */
export class BoxIndex {
  readonly boxes: readonly ColliderBox[];
  private readonly cells = new Map<number, ColliderBox[]>();

  /**
   * @param boxes   every collider the terminal emitted; filtered here.
   * @param region  the walkable footprint, used to reject irrelevant boxes.
   * @param floorY  the interior floor level.
   */
  constructor(boxes: readonly ColliderBox[], region: Rect, floorY: number) {
    const kept: ColliderBox[] = [];
    for (const box of boxes) {
      if (!box.solid) continue;
      // Height band: a person walks into a desk and under a hanging sign.
      if (box.top < floorY + MIN_OBSTACLE_HEIGHT) continue;
      if (box.bottom > floorY + REACH_ABOVE_FLOOR) continue;
      if (box.maxX < region.minX || box.minX > region.maxX) continue;
      if (box.maxZ < region.minZ || box.minZ > region.maxZ) continue;
      // A box that CONTAINS the whole walkable region is the building shell,
      // not a thing inside it. Keeping it would leave the graph empty and the
      // terminal deserted, which is a far worse failure than ignoring a wall
      // the walkable region is already inset from.
      if (
        box.minX <= region.minX &&
        box.maxX >= region.maxX &&
        box.minZ <= region.minZ &&
        box.maxZ >= region.maxZ
      ) {
        continue;
      }
      kept.push(box);
    }
    this.boxes = kept;

    for (const box of kept) {
      const x0 = Math.floor((box.minX - MAX_QUERY_RADIUS) / CELL);
      const x1 = Math.floor((box.maxX + MAX_QUERY_RADIUS) / CELL);
      const z0 = Math.floor((box.minZ - MAX_QUERY_RADIUS) / CELL);
      const z1 = Math.floor((box.maxZ + MAX_QUERY_RADIUS) / CELL);
      for (let cx = x0; cx <= x1; cx += 1) {
        for (let cz = z0; cz <= z1; cz += 1) {
          const key = BoxIndex.key(cx, cz);
          const bucket = this.cells.get(key);
          if (bucket) bucket.push(box);
          else this.cells.set(key, [box]);
        }
      }
    }
  }

  get count(): number {
    return this.boxes.length;
  }

  private static key(cx: number, cz: number): number {
    return cx * 73856093 + cz * 19349663;
  }

  private bucket(x: number, z: number): ColliderBox[] | undefined {
    return this.cells.get(BoxIndex.key(Math.floor(x / CELL), Math.floor(z / CELL)));
  }

  /** True when a disc of `radius` at (x, z) touches any obstacle. */
  blocked(x: number, z: number, radius: number): boolean {
    const bucket = this.bucket(x, z);
    if (!bucket) return false;
    for (const box of bucket) {
      const px = clamp(x, box.minX, box.maxX);
      const pz = clamp(z, box.minZ, box.maxZ);
      const dx = x - px;
      const dz = z - pz;
      if (dx * dx + dz * dz < radius * radius) return true;
    }
    return false;
  }

  /** Distance from (x, z) to the nearest obstacle face. Negative inside one. */
  clearance(x: number, z: number): number {
    const bucket = this.bucket(x, z);
    if (!bucket) return MAX_QUERY_RADIUS;
    let best = MAX_QUERY_RADIUS;
    for (const box of bucket) {
      const px = clamp(x, box.minX, box.maxX);
      const pz = clamp(z, box.minZ, box.maxZ);
      const dx = x - px;
      const dz = z - pz;
      if (dx !== 0 || dz !== 0) {
        best = Math.min(best, Math.hypot(dx, dz));
        continue;
      }
      // Inside: the signed distance is the shortest way out, negated.
      const out = Math.min(x - box.minX, box.maxX - x, z - box.minZ, box.maxZ - z);
      best = Math.min(best, -out);
    }
    return best;
  }

  /**
   * Shortest displacement that takes a disc of `radius` clear, into `out`.
   *
   * Unlike the street's version this handles a point ALREADY INSIDE a box by
   * leaving through its nearest face rather than by stepping `radius` away
   * from the box centre. The difference does not matter for a bollard and
   * matters a great deal for an eight-metre check-in desk, where stepping
   * `radius` off the centre leaves you still inside the desk.
   */
  resolve(x: number, z: number, radius: number, out: { x: number; z: number }): boolean {
    out.x = 0;
    out.z = 0;
    const bucket = this.bucket(x, z);
    if (!bucket) return false;
    let hit = false;
    for (const box of bucket) {
      const px = clamp(x, box.minX, box.maxX);
      const pz = clamp(z, box.minZ, box.maxZ);
      const dx = x - px;
      const dz = z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 > 1e-12) {
        if (d2 >= radius * radius) continue;
        hit = true;
        const d = Math.sqrt(d2);
        out.x += (dx / d) * (radius - d);
        out.z += (dz / d) * (radius - d);
        continue;
      }
      hit = true;
      const west = x - box.minX;
      const east = box.maxX - x;
      const north = z - box.minZ;
      const south = box.maxZ - z;
      const shortest = Math.min(west, east, north, south);
      if (shortest === west) out.x -= west + radius;
      else if (shortest === east) out.x += east + radius;
      else if (shortest === north) out.z -= north + radius;
      else out.z += south + radius;
    }
    return hit;
  }

  /**
   * True when a disc of `radius` cannot be swept from a to b.
   *
   * Sampled rather than solved. Consecutive samples are `SEGMENT_STEP` apart
   * and the discs overlap, so the union covers the capsule to an effective
   * radius of `sqrt(r^2 - (step/2)^2)` - 0.529 m at the 0.55 m clearance the
   * graph uses. Solving it exactly would cost more code than the 2 cm of
   * conservatism is worth.
   */
  segmentBlocked(ax: number, az: number, bx: number, bz: number, radius: number): boolean {
    const dx = bx - ax;
    const dz = bz - az;
    const length = Math.hypot(dx, dz);
    const steps = Math.max(1, Math.ceil(length / SEGMENT_STEP));
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      if (this.blocked(ax + dx * t, az + dz * t, radius)) return true;
    }
    return false;
  }
}

/** An undirected graph of walkable points, stored compressed-row. */
export interface TerminalGraph {
  readonly x: Float32Array;
  readonly z: Float32Array;
  /** `links[offsets[n] .. offsets[n + 1])` are node n's neighbours. */
  readonly offsets: Int32Array;
  readonly links: Int32Array;
  readonly count: number;
  readonly spacing: number;
  /** The node nearest a point, or -1 when the graph is empty. */
  nearest(x: number, z: number): number;
}

export interface TerminalGraphOptions {
  readonly region: Rect;
  readonly obstacles: BoxIndex;
  /** Lattice pitch in metres. Smaller finds narrower gaps and costs more. */
  readonly spacing?: number | undefined;
  /** How far a node must stay from the walkable region's edge. */
  readonly margin?: number | undefined;
  /** Clearance a node and a link must have from furniture. */
  readonly clearance?: number | undefined;
}

const DEFAULT_SPACING = 3;
const DEFAULT_MARGIN = 0.9;
/**
 * Clearance the graph demands, in metres.
 *
 * A shoulder (0.28) plus half a metre of elbow room. Tighter routes people
 * through gaps they then spend the whole crossing being pushed out of; looser
 * closes the aisle between two rows of seating, which is the one place a
 * terminal actually needs people to walk.
 */
const DEFAULT_CLEARANCE = TRAVELLER_RADIUS + 0.27;

/**
 * Lays a lattice over the walkable region and keeps what is actually walkable.
 *
 * Eight-connected: the diagonals cost one more clearance test per node and buy
 * paths that cut corners the way a person does instead of turning two right
 * angles across an empty concourse.
 */
export function buildTerminalGraph(options: TerminalGraphOptions): TerminalGraph {
  const spacing = options.spacing ?? DEFAULT_SPACING;
  const clearance = options.clearance ?? DEFAULT_CLEARANCE;
  const inner = insetRect(options.region, options.margin ?? DEFAULT_MARGIN);
  const width = inner.maxX - inner.minX;
  const depth = inner.maxZ - inner.minZ;

  const columns = width > 0 ? Math.floor(width / spacing) + 1 : 0;
  const rows = depth > 0 ? Math.floor(depth / spacing) + 1 : 0;
  if (columns <= 0 || rows <= 0) return emptyGraph(spacing);

  // Centre the lattice in the region so the aisle it leaves at each edge is
  // the same width; an off-centre lattice puts everybody against one wall.
  const originX = inner.minX + (width - (columns - 1) * spacing) * 0.5;
  const originZ = inner.minZ + (depth - (rows - 1) * spacing) * 0.5;

  // -1 where the lattice point is unusable, otherwise the compacted index.
  const cellIndex = new Int32Array(columns * rows).fill(-1);
  const px: number[] = [];
  const pz: number[] = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const x = originX + c * spacing;
      const z = originZ + r * spacing;
      if (options.obstacles.blocked(x, z, clearance)) continue;
      cellIndex[r * columns + c] = px.length;
      px.push(x);
      pz.push(z);
    }
  }
  if (px.length === 0) return emptyGraph(spacing);

  // Half the neighbourhood; each accepted pair is added in both directions.
  const forward: readonly (readonly [number, number])[] = [
    [1, 0],
    [0, 1],
    [1, 1],
    [-1, 1],
  ];
  const adjacency: number[][] = Array.from({ length: px.length }, () => []);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < columns; c += 1) {
      const a = cellIndex[r * columns + c] ?? -1;
      if (a < 0) continue;
      for (const step of forward) {
        const c2 = c + step[0];
        const r2 = r + step[1];
        if (c2 < 0 || c2 >= columns || r2 < 0 || r2 >= rows) continue;
        const b = cellIndex[r2 * columns + c2] ?? -1;
        if (b < 0) continue;
        const ax = px[a] ?? 0;
        const az = pz[a] ?? 0;
        const bx = px[b] ?? 0;
        const bz = pz[b] ?? 0;
        if (options.obstacles.segmentBlocked(ax, az, bx, bz, clearance)) continue;
        (adjacency[a] as number[]).push(b);
        (adjacency[b] as number[]).push(a);
      }
    }
  }

  const keep = largestComponent(adjacency);
  return compress(px, pz, adjacency, keep, spacing);
}

function emptyGraph(spacing: number): TerminalGraph {
  return {
    x: new Float32Array(0),
    z: new Float32Array(0),
    offsets: new Int32Array(1),
    links: new Int32Array(0),
    count: 0,
    spacing,
    nearest: () => -1,
  };
}

/**
 * The biggest connected set of nodes.
 *
 * A pocket behind a check-in desk that is reachable only by walking through
 * the desk is not walkable floor, and an agent that spawned in one would be
 * stranded there for the whole session.
 */
function largestComponent(adjacency: readonly (readonly number[])[]): Uint8Array {
  const label = new Int32Array(adjacency.length).fill(-1);
  const stack: number[] = [];
  let best = -1;
  let bestSize = 0;
  let next = 0;
  for (let seed = 0; seed < adjacency.length; seed += 1) {
    if (label[seed] !== -1) continue;
    const id = next;
    next += 1;
    let size = 0;
    stack.length = 0;
    stack.push(seed);
    label[seed] = id;
    while (stack.length > 0) {
      const node = stack.pop() as number;
      size += 1;
      for (const other of adjacency[node] ?? []) {
        if (label[other] !== -1) continue;
        label[other] = id;
        stack.push(other);
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = id;
    }
  }
  const keep = new Uint8Array(adjacency.length);
  for (let i = 0; i < adjacency.length; i += 1) keep[i] = label[i] === best ? 1 : 0;
  return keep;
}

/** Compacts the surviving nodes into the compressed-row form and indexes them. */
function compress(
  px: readonly number[],
  pz: readonly number[],
  adjacency: readonly (readonly number[])[],
  keep: Uint8Array,
  spacing: number,
): TerminalGraph {
  const remap = new Int32Array(px.length).fill(-1);
  let count = 0;
  for (let i = 0; i < px.length; i += 1) if (keep[i]) remap[i] = count++;
  if (count === 0) return emptyGraph(spacing);

  const x = new Float32Array(count);
  const z = new Float32Array(count);
  const offsets = new Int32Array(count + 1);
  const flat: number[] = [];
  for (let i = 0; i < px.length; i += 1) {
    const n = remap[i] ?? -1;
    if (n < 0) continue;
    x[n] = px[i] ?? 0;
    z[n] = pz[i] ?? 0;
    offsets[n] = flat.length;
    for (const other of adjacency[i] ?? []) {
      const m = remap[other] ?? -1;
      if (m >= 0) flat.push(m);
    }
  }
  offsets[count] = flat.length;
  // `offsets` was written in compacted order, so it is already monotone; the
  // final entry closes the last row.
  const links = Int32Array.from(flat);

  // A bucket grid over the surviving nodes, for `nearest`. Two lattice pitches
  // per cell keeps the average bucket to a handful of nodes.
  const bucketSize = Math.max(spacing * 2, 1);
  const buckets = new Map<number, number[]>();
  const key = (cx: number, cz: number): number => cx * 73856093 + cz * 19349663;
  for (let n = 0; n < count; n += 1) {
    const k = key(Math.floor((x[n] ?? 0) / bucketSize), Math.floor((z[n] ?? 0) / bucketSize));
    const bucket = buckets.get(k);
    if (bucket) bucket.push(n);
    else buckets.set(k, [n]);
  }

  const nearest = (qx: number, qz: number): number => {
    const cx = Math.floor(qx / bucketSize);
    const cz = Math.floor(qz / bucketSize);
    for (let ring = 1; ring <= 40; ring += 1) {
      let best = -1;
      let bestD2 = Infinity;
      for (let i = -ring; i <= ring; i += 1) {
        for (let j = -ring; j <= ring; j += 1) {
          // Only the new shell each ring; the inner ones were searched already.
          if (ring > 1 && Math.abs(i) < ring && Math.abs(j) < ring) continue;
          const bucket = buckets.get(key(cx + i, cz + j));
          if (!bucket) continue;
          for (const n of bucket) {
            const dx = (x[n] ?? 0) - qx;
            const dz = (z[n] ?? 0) - qz;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD2) {
              bestD2 = d2;
              best = n;
            }
          }
        }
      }
      // One more ring than the first hit, because a node in the next shell can
      // still be nearer than one in the corner of this shell.
      if (best >= 0 && bestD2 <= (ring * bucketSize) ** 2) return best;
      if (best >= 0 && ring >= 2) return best;
    }
    return -1;
  };

  return { x, z, offsets, links, count, spacing, nearest };
}

/**
 * Breadth-first paths over the graph.
 *
 * Breadth-first rather than A*: every link is one lattice pitch (or its
 * diagonal), the graph is a few thousand nodes, and a path is asked for about
 * three times a second across the whole population. A priority queue would be
 * more code for a cost that does not appear in the profile.
 *
 * The visited marks are stamped with a generation counter so a search never
 * has to clear an array it did not touch.
 */
export class TerminalPaths {
  private readonly graph: TerminalGraph;
  private readonly stamp: Int32Array;
  private readonly parent: Int32Array;
  private readonly frontier: Int32Array;
  private generation = 0;
  /** Nodes expanded by the last `find`, for the perf overlay. */
  expanded = 0;

  constructor(graph: TerminalGraph) {
    this.graph = graph;
    this.stamp = new Int32Array(graph.count);
    this.parent = new Int32Array(graph.count);
    this.frontier = new Int32Array(graph.count);
  }

  /**
   * Fills `out` with the node indices from `from` to `to`, `from` excluded.
   * Returns false when the two are not connected, which the caller treats as
   * "pick a different goal" rather than as an error.
   */
  find(from: number, to: number, out: number[]): boolean {
    out.length = 0;
    this.expanded = 0;
    const graph = this.graph;
    if (from < 0 || to < 0 || from >= graph.count || to >= graph.count) return false;
    if (from === to) return true;

    this.generation += 1;
    const mark = this.generation;
    const stamp = this.stamp;
    const parent = this.parent;
    const frontier = this.frontier;
    stamp[from] = mark;
    parent[from] = -1;
    frontier[0] = from;
    let head = 0;
    let tail = 1;
    let found = false;

    while (head < tail) {
      const node = frontier[head] ?? 0;
      head += 1;
      this.expanded += 1;
      const start = graph.offsets[node] ?? 0;
      const end = graph.offsets[node + 1] ?? start;
      for (let i = start; i < end; i += 1) {
        const other = graph.links[i] ?? 0;
        if (stamp[other] === mark) continue;
        stamp[other] = mark;
        parent[other] = node;
        if (other === to) {
          found = true;
          head = tail;
          break;
        }
        frontier[tail] = other;
        tail += 1;
      }
    }
    if (!found) return false;

    for (let node = to; node !== from && node >= 0; node = parent[node] ?? -1) out.push(node);
    out.reverse();
    return true;
  }
}
