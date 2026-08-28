/**
 * Meridian Bay terrain profile.
 *
 * COORDINATES: one world unit is one metre. +X is east, +Z is south, +Y is up.
 * Sea level is exactly y = 0.
 *
 * The ground is one continuous analytic surface. Nothing is flattened into
 * pads and no carriageway is forced level across its width, because both of
 * those tricks tear the surface open at the kerb on a slope: a flat block pad
 * beside a level road leaves a two-metre drop the player cannot climb, and it
 * reads as broken geometry from the street. Keeping a single smooth field
 * means the walkable surface, the rendered surface and the collision surface
 * are the same thing everywhere, and the only step anywhere in the city is the
 * 15 cm kerb.
 *
 * The price is that streets carry a cross-fall equal to the local gradient.
 * That is why the profile is separable and why the main grade is capped near
 * three per cent: an east-west street then has almost no cross-fall at all,
 * and the widest north-south street banks by about half a metre over sixteen -
 * a camber, not a ramp.
 *
 *     elevation(x, z) = mainProfile(x) + minorProfile(z)
 *
 * The steeper ground is pushed outside the street grid, where the outskirts
 * climb away to the north-east and give the skyline a hill to sit against.
 */

import { smoothstep } from '../core/mathx';
import { AIRFIELD_LEVEL, CAUSEWAY, airfieldWeight, causewayWeight } from './airport/layout';

/**
 * Playable world bounds, including the water, the outskirts and the airfield.
 *
 * Grown south and east for Meridian Bay Regional. The east and south edges are
 * set by the airfield's own blend, not by the platform: `AIRFIELD` reaches
 * x = 430, z = 950 and `AIRFIELD_SKIRT` carries the embankment 46 m past that,
 * so a boundary at the platform edge would have cut the mesh off mid-slope and
 * left a 15 m wall of nothing where the runway looks south. 470 and 1000 clear
 * the toe of the bank on both sides (measured weight at x = 470 is 0.048, and
 * exactly 0 at z = 1000).
 *
 * The west and north edges are untouched. Everything the city occupies is at
 * airfield weight 0 - the southernmost city surface is South Circuit's far
 * pavement at z = 143, and the platform's influence starts at z = 154 - so the
 * grid, the blocks and the parcels are bit-identical after this change.
 * `tests/airport.test.ts` pins that.
 */
export const WORLD_BOUNDS = {
  minX: -232,
  maxX: 470,
  minZ: -206,
  maxZ: 1000,
} as const;

/** Sea level. Water renders as a plane at exactly this height. */
export const SEA_LEVEL = 0;

/** East of this the ground leaves the street grid and climbs the ridge. */
const OUTSKIRT_EAST = 178;
/** North of this the ground leaves the street grid and climbs the headland. */
const OUTSKIRT_NORTH = -166;

/**
 * East-west profile: the dominant grade, deliberately capped near 3 per cent
 * inside the street grid so no carriageway banks like a racetrack.
 */
export function mainProfile(x: number): number {
  return (
    1.9 +
    8.2 * smoothstep(-215, 195, x) +
    0.5 * Math.sin(x * 0.012 + 0.4) +
    // Outside the loop road the hill is free to climb properly.
    7.5 * smoothstep(OUTSKIRT_EAST, 232, x)
  );
}

/** North-south profile: a gentle secondary grade, under about 1 per cent. */
export function minorProfile(z: number): number {
  return (
    1.5 * smoothstep(150, -160, z) +
    0.3 * Math.sin(z * 0.0105 - 0.8) +
    5.5 * smoothstep(OUTSKIRT_NORTH, -215, z)
  );
}

/**
 * The untouched terrain profile, before any earthwork.
 *
 * Kept separate from `landElevation` because the airfield grading has to blend
 * AGAINST it, and a self-referential blend would recurse.
 */
export function naturalElevation(x: number, z: number): number {
  return mainProfile(x) + minorProfile(z);
}

/**
 * The airfield platform blended against natural ground.
 *
 * This is the formula the airfield survey specifies: `AIRFIELD_LEVEL` weighted
 * in by `airfieldWeight`, which is 1 over the whole platform and eases to 0
 * across `AIRFIELD_SKIRT` outside it. It is exact - not approximately 14.5 -
 * everywhere the runway, taxiway, apron, terminal, forecourt and car park
 * stand, and exactly 0 over every surface the city occupies.
 */
function platformElevation(x: number, z: number): number {
  const weight = airfieldWeight(x, z);
  const natural = naturalElevation(x, z);
  return weight <= 0 ? natural : natural + weight * (AIRFIELD_LEVEL - natural);
}

/**
 * Smooth land elevation. This is the ground everywhere on land, including the
 * airfield platform and the causeway that carries its access road.
 *
 * Two earthworks, applied in the order they would be built: the platform is
 * graded first, and the causeway is then cut and filled INTO that surface.
 * Inside the causeway its weight is 1, so the level there is
 * `platformElevation` read on the road's own centreline - a function of z
 * alone. That is what makes Airport Approach exactly level across its width
 * while still following the bank along its length; see the note above
 * `CAUSEWAY` in `airport/layout.ts`.
 *
 * The early return is not decoration. This runs for every ground sample, every
 * street quad corner and every prop placement in the city, and both weights are
 * zero over all of it.
 */
export function landElevation(x: number, z: number): number {
  const base = platformElevation(x, z);
  const causeway = causewayWeight(x, z);
  if (causeway <= 0) return base;
  return base + causeway * (platformElevation(CAUSEWAY.crownX, z) - base);
}

/**
 * Outer face of the harbour wall. The promenade is retained against this line.
 *
 * Harbour Walk runs at x = -160 with a corridor half-width of 12 m, so its
 * western edge is at -172. The wall sits just outside that, and the shoreline
 * is kept west of the wall, which is what guarantees the promenade always has
 * solid ground under it.
 */
export const SEAWALL_X = -173;

/**
 * The waterline. The bay is everything west of this curve; the wobble keeps the
 * shore from reading as a straight cut.
 *
 * IMPORTANT: this curve must stay well west of `SEAWALL_X`. It used to reach
 * -166.5 at its eastern extreme, which put the beach slope *underneath* the
 * promenade: the carriageway is drawn at land height while the ground beneath
 * it was already diving toward the seabed, so the whole road read as a ribbon
 * floating above the sand. The amplitude is reduced and the base moved west so
 * the ground under the entire corridor is flat land, with a margin to spare.
 */
export function shorelineX(z: number): number {
  return -196 + 7 * Math.sin(z * 0.0163 + 0.6) + 3 * Math.sin(z * 0.041 - 1.9);
}

/**
 * Ground height including the harbour. West of the shore the land dives below
 * sea level into the bay; the transition band is the beach and seawall footing.
 */
export function groundElevation(x: number, z: number): number {
  const shore = shorelineX(z);
  const land = landElevation(x, z);
  if (x >= shore + 12) return land;
  const seabed = -5.2 + 2.4 * smoothstep(shore - 70, shore, x);
  return seabed + (land - seabed) * smoothstep(shore - 24, shore + 12, x);
}

/** True where the ground is below sea level, i.e. the player would be in the bay. */
export function isUnderwater(x: number, z: number): boolean {
  return groundElevation(x, z) < SEA_LEVEL;
}

/** Worst-case surface gradient near a point, as a fraction (0.03 = 3 per cent). */
export function gradientAt(x: number, z: number, step = 0.5): number {
  const dx = (landElevation(x + step, z) - landElevation(x - step, z)) / (2 * step);
  const dz = (landElevation(x, z + step) - landElevation(x, z - step)) / (2 * step);
  return Math.hypot(dx, dz);
}
