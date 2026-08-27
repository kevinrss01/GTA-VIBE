/**
 * Ground queries for Meridian Bay.
 *
 * Everything that needs to know "how high is the ground here, and what is it
 * made of" goes through this one class: the player controller, prop scattering,
 * the footstep mixer, the placement validator and the tests. Having a single
 * authority is what keeps the rendered surface and the walkable surface from
 * drifting apart.
 *
 * The height model follows `elevation.ts`: streets take their height from their
 * own centreline so they are level across their width, pavements sit one kerb
 * above the carriageway they belong to, and block interiors are flat pads.
 */

import { clamp, rectContains, type Rect } from '../core/mathx';
import { hash2 } from '../core/rng';
import {
  blockSurfaceY,
  corridorHalfWidth,
  KERB_HEIGHT,
  type CityBlock,
  type CityPlan,
  type Parcel,
  type Street,
  type DistrictId,
} from './CityPlan';
import { groundElevation, landElevation, SEA_LEVEL, shorelineX, WORLD_BOUNDS } from './elevation';

export type SurfaceId =
  | 'asphalt'
  | 'pavement'
  | 'boardwalk'
  | 'plaza'
  | 'grass'
  | 'sand'
  | 'gravel'
  | 'water'
  | 'interior';

export interface GroundSample {
  /** Walkable surface height in metres. */
  readonly y: number;
  readonly surface: SurfaceId;
  /** True on a carriageway, so the footstep mixer can pick the right variant. */
  readonly onRoad: boolean;
}

const CELL = 24;

interface StreetHit {
  street: Street;
  /** Perpendicular offset from the centreline. */
  offset: number;
  centreY: number;
}

export class CityGround {
  private readonly plan: CityPlan;
  private readonly blockGrid = new Map<number, CityBlock[]>();
  private readonly parcelGrid = new Map<number, Parcel[]>();

  constructor(plan: CityPlan) {
    this.plan = plan;
    for (const block of plan.blocks) this.indexRect(this.blockGrid, block.rect, block);
    for (const parcel of plan.parcels) this.indexRect(this.parcelGrid, parcel.rect, parcel);
  }

  private indexRect<T>(grid: Map<number, T[]>, rect: Rect, item: T): void {
    const x0 = Math.floor(rect.minX / CELL);
    const x1 = Math.floor(rect.maxX / CELL);
    const z0 = Math.floor(rect.minZ / CELL);
    const z1 = Math.floor(rect.maxZ / CELL);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cz = z0; cz <= z1; cz += 1) {
        const key = CityGround.cellKey(cx, cz);
        const bucket = grid.get(key);
        if (bucket) bucket.push(item);
        else grid.set(key, [item]);
      }
    }
  }

  private static cellKey(cx: number, cz: number): number {
    return (cx + 512) * 4096 + (cz + 512);
  }

  private bucketAt<T>(grid: Map<number, T[]>, x: number, z: number): readonly T[] {
    return grid.get(CityGround.cellKey(Math.floor(x / CELL), Math.floor(z / CELL))) ?? [];
  }

  /** Streets whose corridor (carriageway plus pavements) contains the point. */
  private streetsAt(x: number, z: number): StreetHit[] {
    const hits: StreetHit[] = [];
    for (const street of this.plan.streets) {
      const along = street.axis === 'x' ? z : x;
      if (along < street.from || along > street.to) continue;
      const across = street.axis === 'x' ? x : z;
      const offset = across - street.position;
      if (Math.abs(offset) > corridorHalfWidth(street)) continue;
      // The carriageway follows the terrain rather than being flattened, so
      // the height is sampled at the point itself, not at the centreline.
      hits.push({ street, offset, centreY: landElevation(x, z) });
    }
    return hits;
  }

  private districtCellX = NaN;
  private districtCellZ = NaN;
  private districtCached: DistrictId | null = null;

  blockAt(x: number, z: number): CityBlock | null {
    for (const block of this.bucketAt(this.blockGrid, x, z)) {
      if (rectContains(block.rect, x, z)) return block;
    }
    return null;
  }

  /**
   * District at ANY point, including the street corridors between blocks.
   *
   * `blockAt` only answers inside a block rect, and that is nowhere the player
   * actually walks: every carriageway and pavement in the city falls between
   * blocks and came back `null`. Callers that defaulted that null to a fixed
   * district silently got that district for most of the map - which is how the
   * sea ambience ended up playing at full level on the east ridge, 370 m
   * inland. Falling back to the NEAREST block keeps the answer geographic.
   *
   * Memoised on a coarse cell because this runs every frame and the answer
   * cannot change within a few metres.
   */
  districtAt(x: number, z: number): DistrictId {
    const inside = this.blockAt(x, z);
    if (inside) return inside.district;

    const cellX = Math.floor(x / 8);
    const cellZ = Math.floor(z / 8);
    if (cellX === this.districtCellX && cellZ === this.districtCellZ && this.districtCached) {
      return this.districtCached;
    }

    let best: DistrictId = 'harbourside';
    let bestDistance = Infinity;
    for (const block of this.plan.blocks) {
      // Squared distance from the point to the block rectangle.
      const dx = Math.max(block.rect.minX - x, 0, x - block.rect.maxX);
      const dz = Math.max(block.rect.minZ - z, 0, z - block.rect.maxZ);
      const d = dx * dx + dz * dz;
      if (d < bestDistance) {
        bestDistance = d;
        best = block.district;
      }
    }
    this.districtCellX = cellX;
    this.districtCellZ = cellZ;
    this.districtCached = best;
    return best;
  }

  parcelAt(x: number, z: number, margin = 0): Parcel | null {
    for (const parcel of this.bucketAt(this.parcelGrid, x, z)) {
      if (rectContains(parcel.rect, x, z, margin)) return parcel;
    }
    return null;
  }

  /** True where a building stands, i.e. where the player cannot walk outdoors. */
  isBuilt(x: number, z: number, margin = 0): boolean {
    return this.parcelAt(x, z, margin) !== null;
  }

  /**
   * The main query. Returns the walkable height and the material underfoot.
   *
   * Precedence is street corridor, then block interior, then open terrain. A
   * point inside two corridors is an intersection and takes the mean of both
   * centrelines, which is what keeps junctions from creasing.
   */
  sample(x: number, z: number): GroundSample {
    const hits = this.streetsAt(x, z);

    if (hits.length > 0) {
      // On the carriageway of any street the point belongs to, the road wins.
      const roadHits = hits.filter((h) => Math.abs(h.offset) <= h.street.roadHalf);
      if (roadHits.length > 0) {
        let sum = 0;
        for (const hit of roadHits) sum += hit.centreY;
        return { y: sum / roadHits.length, surface: 'asphalt', onRoad: true };
      }

      // Otherwise it is a pavement. Use the nearest street's centreline so the
      // pavement follows the road it actually belongs to.
      let nearest = hits[0] as StreetHit;
      for (const hit of hits) {
        if (Math.abs(hit.offset) < Math.abs(nearest.offset)) nearest = hit;
      }
      return {
        y: nearest.centreY + KERB_HEIGHT,
        surface: nearest.street.boardwalk ? 'boardwalk' : 'pavement',
        onRoad: false,
      };
    }

    const block = this.blockAt(x, z);
    if (block) {
      // The block interior slopes with its four corner pavements, so it meets
      // every kerb around it without a step.
      const y = blockSurfaceY(block, x, z);
      if (block.kind === 'park') {
        // Paths cross the park; everything else is planted.
        const onPath = Math.abs(((x - block.rect.minX) % 26) - 13) < 1.9 || Math.abs(z + 32) < 2.2;
        return { y, surface: onPath ? 'gravel' : 'grass', onRoad: false };
      }
      if (block.kind === 'plaza') {
        return { y, surface: 'plaza', onRoad: false };
      }
      // Courtyards and service alleys behind the buildings.
      return { y, surface: 'gravel', onRoad: false };
    }

    // Outside the street grid: the waterfront, the beach and the outskirts.
    const y = groundElevation(x, z);
    if (y < SEA_LEVEL) return { y: SEA_LEVEL, surface: 'water', onRoad: false };
    const shore = shorelineX(z);
    if (x < shore + 9) return { y, surface: 'sand', onRoad: false };
    // Rough ground beyond the loop reads as scrub, with a little variation.
    return { y, surface: hash2(x * 0.25, z * 0.25, 7) < 0.6 ? 'grass' : 'gravel', onRoad: false };
  }

  /** Convenience wrapper for callers that only need the height. */
  heightAt(x: number, z: number): number {
    return this.sample(x, z).y;
  }

  /**
   * Whether a point is inside the playable area at all. Used to keep the player
   * from wandering into the bay or off the far side of the outskirts.
   */
  isInBounds(x: number, z: number): boolean {
    return (
      x > WORLD_BOUNDS.minX + 4 &&
      x < WORLD_BOUNDS.maxX - 4 &&
      z > WORLD_BOUNDS.minZ + 4 &&
      z < WORLD_BOUNDS.maxZ - 4
    );
  }

  /** Depth of water at a point; zero on land. Used to stop the player wading. */
  waterDepth(x: number, z: number): number {
    return clamp(SEA_LEVEL - groundElevation(x, z), 0, 20);
  }
}
