/**
 * Static things on the pavement that a pedestrian has to walk around.
 *
 * Rather than guess where the street furniture is, this replays the real
 * `scatterStreetProps` pass into a sink that keeps only the collision boxes and
 * throws the geometry away. Placement is deterministic, so the boxes here are
 * byte-for-byte the ones the player collides with: the same lamp posts, trees,
 * bins, benches, hydrants and poles, in the same places.
 *
 * Boxes are filtered to the ones a walking person could actually hit. A roof
 * vent four storeys up emits a collider too, and steering around it would make
 * the street below look haunted.
 *
 * The index is a uniform grid because every query is "what is near this point"
 * with a fixed small radius, which is the one case where a grid beats anything
 * cleverer.
 */

import type { BufferGeometry, Matrix4 } from 'three';

import type { CityGround } from '../world/CityGround';
import type { CityPlan } from '../world/CityPlan';
import { scatterStreetProps } from '../world/build/PropScatter';
import { linkPoint, type PavementLink } from './pavement';
import type {
  ColliderBox,
  GeometrySink,
  InteractionPoint,
  LightRequest,
  PropKey,
} from '../world/build/types';

/** An axis-aligned obstacle footprint, already known to be at street level. */
export interface Obstacle {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

const CELL = 8;

/** Highest obstacle base a pedestrian can still walk into, above local ground. */
const REACH_ABOVE_GROUND = 1.1;
/** Obstacles shorter than this are stepped over rather than walked around. */
const MIN_HEIGHT = 0.25;

/** Spacing of the cross-sections `blocksCorridor` tests, in metres. */
const CORRIDOR_ALONG_STEP = 0.25;
/** Spacing of the lateral offsets tried inside one cross-section, in metres. */
const CORRIDOR_LATERAL_STEP = 0.1;

class ColliderSink implements GeometrySink {
  readonly boxes: ColliderBox[] = [];

  add(_key: unknown, geometry: BufferGeometry): void {
    // The sink owns what it is handed. Nothing here needs the geometry, and
    // leaving it undisposed would leak a few hundred buffers on every build.
    geometry.dispose();
  }

  instance(_prop: PropKey, _matrix: Matrix4): void {
    // Props with a footprint also emit a collider, which is the record we want.
  }

  collider(box: ColliderBox): void {
    this.boxes.push(box);
  }

  light(_request: LightRequest): void {
    /* the crowd does not light the street */
  }

  interaction(_point: InteractionPoint): void {
    /* nor does it open doors */
  }
}

export class ObstacleIndex {
  private readonly cells = new Map<number, Obstacle[]>();
  private readonly all: Obstacle[] = [];
  private static readonly empty: readonly Obstacle[] = [];

  constructor(plan: CityPlan, ground: CityGround, extra?: readonly ColliderBox[]) {
    const boxes: readonly ColliderBox[] = extra ?? ObstacleIndex.harvest(plan);
    for (const box of boxes) {
      if (box.top - box.bottom < MIN_HEIGHT) continue;
      if (!box.solid) continue;
      const cx = (box.minX + box.maxX) * 0.5;
      const cz = (box.minZ + box.maxZ) * 0.5;
      // Anything whose base is above head height is not in anyone's way.
      if (box.bottom > ground.sample(cx, cz).y + REACH_ABOVE_GROUND) continue;
      const obstacle: Obstacle = {
        minX: box.minX,
        maxX: box.maxX,
        minZ: box.minZ,
        maxZ: box.maxZ,
      };
      this.all.push(obstacle);
      this.insert(obstacle);
    }
  }

  private static harvest(plan: CityPlan): readonly ColliderBox[] {
    const sink = new ColliderSink();
    scatterStreetProps(plan, sink);
    return sink.boxes;
  }

  get count(): number {
    return this.all.length;
  }

  private static key(cx: number, cz: number): number {
    return (cx + 512) * 4096 + (cz + 512);
  }

  private insert(obstacle: Obstacle): void {
    const x0 = Math.floor(obstacle.minX / CELL);
    const x1 = Math.floor(obstacle.maxX / CELL);
    const z0 = Math.floor(obstacle.minZ / CELL);
    const z1 = Math.floor(obstacle.maxZ / CELL);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cz = z0; cz <= z1; cz += 1) {
        const key = ObstacleIndex.key(cx, cz);
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(obstacle);
        else this.cells.set(key, [obstacle]);
      }
    }
  }

  /** Obstacles in the cell containing the point. Never allocates. */
  cellAt(x: number, z: number): readonly Obstacle[] {
    return this.cells.get(ObstacleIndex.key(Math.floor(x / CELL), Math.floor(z / CELL))) ??
      ObstacleIndex.empty;
  }

  /**
   * True when street furniture leaves nowhere at all to walk along a link.
   *
   * The scatter has no idea where the pedestrian routes run, so it can and does
   * put a planter across the middle of one: `j:harbour-walk:cooper-street:n` is
   * a 2.28 m crossing with a 0.8 m planter over its centre and a bollard beside
   * it, and between them they close it completely. Anyone who commits to that
   * crossing is stranded on a carriageway until something rescues them, so the
   * router has to know not to offer it.
   *
   * Sampled rather than solved: a cross-section every `CORRIDOR_ALONG_STEP`,
   * and inside each one the lateral offsets from the centre outward until one
   * is clear. That early exit is what makes it affordable - an unobstructed
   * cross-section costs a single query - so scanning the whole city's pavement
   * is a few milliseconds at boot instead of a hundred.
   *
   * The sampling can only be wrong in two bounded ways: it can miss a blockage
   * shorter than a quarter of a metre along the link, and it can call a
   * corridor closed when the only gap in it is under a tenth of a metre wide,
   * which is not a gap a person fits through anyway.
   */
  blocksCorridor(link: PavementLink, radius: number): boolean {
    const steps = Math.max(2, Math.ceil(link.length / CORRIDOR_ALONG_STEP));
    const slots = Math.max(1, Math.ceil(link.halfWidth / CORRIDOR_LATERAL_STEP));
    for (let i = 0; i <= steps; i += 1) {
      const along = (i / steps) * link.length;
      let clear = false;
      // Centre first, then outward in pairs: the common case exits at once.
      for (let s = 0; s <= slots && !clear; s += 1) {
        for (let sign = 1; sign >= -1; sign -= 2) {
          const lateral = ((sign * s) / slots) * link.halfWidth;
          linkPoint(link, along, lateral, ObstacleIndex.probe);
          if (
            !this.resolve(
              ObstacleIndex.probe.x,
              ObstacleIndex.probe.z,
              radius,
              ObstacleIndex.probePush,
            )
          ) {
            clear = true;
            break;
          }
          if (s === 0) break;
        }
      }
      if (!clear) return true;
    }
    return false;
  }

  private static readonly probe = { x: 0, z: 0 };
  private static readonly probePush = { x: 0, z: 0 };

  /**
   * Shortest push that takes a disc of `radius` at (x, z) clear of everything
   * nearby, written into `out` as a displacement. Returns true if it pushed.
   *
   * The cell size is larger than any obstacle plus any pedestrian, so testing
   * the point's own cell and its eight neighbours cannot miss a contact.
   */
  resolve(x: number, z: number, radius: number, out: { x: number; z: number }): boolean {
    out.x = 0;
    out.z = 0;
    let hit = false;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let i = -1; i <= 1; i += 1) {
      for (let j = -1; j <= 1; j += 1) {
        const bucket = this.cells.get(ObstacleIndex.key(cx + i, cz + j));
        if (!bucket) continue;
        for (const box of bucket) {
          const px = x < box.minX ? box.minX : x > box.maxX ? box.maxX : x;
          const pz = z < box.minZ ? box.minZ : z > box.maxZ ? box.maxZ : z;
          const dx = x - px;
          const dz = z - pz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= radius * radius) continue;
          hit = true;
          if (d2 > 1e-6) {
            const d = Math.sqrt(d2);
            out.x += (dx / d) * (radius - d);
            out.z += (dz / d) * (radius - d);
          } else {
            // Dead centre of a box: leave along the shallower axis.
            const toX = x - (box.minX + box.maxX) * 0.5;
            const toZ = z - (box.minZ + box.maxZ) * 0.5;
            if (Math.abs(toX) > Math.abs(toZ)) out.x += toX >= 0 ? radius : -radius;
            else out.z += toZ >= 0 ? radius : -radius;
          }
        }
      }
    }
    return hit;
  }
}
