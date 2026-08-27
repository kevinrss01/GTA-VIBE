/**
 * Where a building's front door goes.
 *
 * Both the façade builder (which must leave an opening) and the interior
 * builder (which must line up its floor and threshold with that opening) need
 * the same answer, so it lives here rather than in either of them.
 */

import { clamp } from '../../core/mathx';
import { createRng } from '../../core/rng';
import { KERB_HEIGHT, type Facing, type Parcel } from '../CityPlan';
import { landElevation } from '../elevation';

export interface Doorway {
  /** Centre of the opening, on the façade plane. */
  readonly x: number;
  readonly z: number;
  /** Threshold height: the finished floor level of the building. */
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly facing: Facing;
  /** Outward normal of the façade the door sits in. */
  readonly normalX: number;
  readonly normalZ: number;
}

const NORMALS: Readonly<Record<Facing, readonly [number, number]>> = {
  north: [0, -1],
  south: [0, 1],
  west: [-1, 0],
  east: [1, 0],
};

/**
 * Places the door on the parcel's front elevation, offset a little from centre
 * so a terrace of buildings does not read as a row of identical stamps.
 */
export function doorwayFor(parcel: Parcel): Doorway {
  const rng = createRng(parcel.seed ^ 0x5bf03635);
  const { rect, facing } = parcel;
  const [normalX, normalZ] = NORMALS[facing];

  const alongMin = facing === 'north' || facing === 'south' ? rect.minX : rect.minZ;
  const alongMax = facing === 'north' || facing === 'south' ? rect.maxX : rect.maxZ;
  const span = alongMax - alongMin;

  const width = Math.min(parcel.enterable ? 2.4 : 1.3, span * 0.34);
  const height = parcel.enterable ? 2.5 : 2.25;
  // Keep the opening at least a pier's width from either party wall.
  const margin = Math.max(1.1, width * 0.75);
  const along = alongMin + margin + rng.next() * Math.max(0, span - margin * 2);

  const facadeX = facing === 'west' ? rect.minX : facing === 'east' ? rect.maxX : along;
  const facadeZ = facing === 'north' ? rect.minZ : facing === 'south' ? rect.maxZ : along;

  return {
    x: facadeX,
    z: facadeZ,
    y: parcel.groundY,
    width,
    height,
    facing,
    normalX,
    normalZ,
  };
}

/** A point just outside the door, where the player stands to open it. */
export function doorApproach(door: Doorway, distance = 1.6): { x: number; z: number } {
  return { x: door.x + door.normalX * distance, z: door.z + door.normalZ * distance };
}

/** A point just inside the door, where the player lands after entering. */
export function doorLanding(door: Doorway, distance = 1.8): { x: number; z: number } {
  return { x: door.x - door.normalX * distance, z: door.z - door.normalZ * distance };
}

/**
 * Walkable height just outside the door - the level the player leaves onto.
 *
 * Everything immediately outside a front door is either pavement or a block
 * interior, and both of those sit one kerb above the continuous terrain. The
 * result is clamped into the plinth for the same reason the entrance steps are:
 * a threshold is never below the base course, and never above finished floor.
 *
 * This mirrors the `outsideY` the façade builder uses to foot its entrance
 * steps. `tests/interiors.test.ts` pins the two together, so the exit target and
 * the steps the player walks down can never drift apart.
 */
export function doorOutsideY(parcel: Parcel, door: Doorway, distance = 1.6): number {
  const approach = doorApproach(door, distance);
  return clamp(
    landElevation(approach.x, approach.z) + KERB_HEIGHT,
    parcel.baseY + 0.42,
    parcel.groundY - 0.02,
  );
}
