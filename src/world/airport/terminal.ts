/**
 * Inside the terminal.
 *
 * 62 by 190 m of floor, which is 22 times the area of the largest interior in
 * Meridian Bay and needs a different approach from the ones in
 * `interiorProps.ts`. Those are single rooms fitted out around one door; this
 * is a building with a sequence: you come in at the north end under the high
 * roof, check in against the west wall and at the islands beyond it, pass
 * security across the middle, and everything south of that line is airside -
 * the lounge, the gates, the shops and the baggage hall.
 *
 * ## Budget
 *
 * `InteriorBuilder` holds each city interior under 4,000 triangles and five
 * lights. Scaled by floor area that would allow 88,000 triangles here, which
 * would be absurd: the whole city is 313,000.
 *
 * The budget taken is 24,000 triangles and 16 lights - a ceiling, not an
 * estimate: `tests/terminalSurfaces.test.ts` fails if either is exceeded. The
 * fit-out MEASURES 17,326 triangles and asks for 13 lights. It was
 * 8,656 for the first fit-out, and the extra was spent where an empty 62 by
 * 190 m shed needed it: on the things that break the volume up (the dropped
 * soffits over both edges, the mezzanine over the hall, the clad columns), on
 * the fittings a passenger walks past at arm's length (the check-in islands,
 * the kiosk bank, the café, five retail units, the security queue and the gate
 * piers), and on a lighting scheme that makes 190 m of ceiling legible. Flat
 * wall is still left flat.
 *
 * Lights are the harder limit. The renderer ranks `LightRequest`s and drops
 * the ones it cannot afford, so 16 low-priority strips over 190 m is a request
 * for whichever few are nearest, not a promise of sixteen. The ceiling itself
 * is emissive so the room is never dark even when every request is dropped.
 *
 * ## The floor, and why it is a mosaic
 *
 * `CityGround.sample` reports `concrete` under the whole terminal footprint,
 * and the walkable surface indoors comes from the floor slab's collider, not
 * from the ground - `FirstPersonController` promotes it to `interior` when it
 * is standing on a built platform above the terrain. The slab is emitted here
 * as one non-solid collider covering the whole footprint.
 *
 * What the player SEES is laid differently, and this is the fix for a defect
 * that made the whole building unusable. The floor used to be one `tileFloor`
 * slab whose top face was at exactly `TERMINAL_FLOOR`, sitting inside the
 * shell's plinth whose top face was ALSO at exactly `TERMINAL_FLOOR` - two
 * coplanar, fully overlapping surfaces, so the depth test had nothing to
 * choose between and 62 by 190 m of floor flickered in bands as the camera
 * moved. The floor bands and the walking line then sat 4 mm above that slab,
 * which is inside the depth buffer's own resolution at the far end of a 190 m
 * room and shimmered for a second, independent reason.
 *
 * Both are gone, and neither is papered over. `buildings.ts` emits the plinth
 * as an apron around the walls that stops at the inner face, and everything
 * this module lays on the floor is laid by `layFloor` as a set of
 * NON-OVERLAPPING rectangles, all of them at exactly `TERMINAL_FLOOR`. Two
 * surfaces that never share a pixel cannot fight over one, at any distance and
 * on any depth buffer, which is why this is exact rather than a tolerance.
 *
 * ## The depth budget, for everything that is not the floor
 *
 * The camera is `PerspectiveCamera(62, 1, 0.1, 1200)`. On a 24-bit depth
 * buffer the smallest resolvable step at range z is about
 * `z^2 * (f - n) / (f * n * 2^24)`, which is `z^2 * 6.0e-7` m: 3.8 mm at 80 m,
 * 24 mm at the 200 m diagonal of this building. So `MIN_SURFACE_SEPARATION`
 * below is 25 mm, and no two horizontal surfaces that overlap in plan may be
 * closer than that. The test enforces it over every box the airport emits.
 */

import { clamp } from '../../core/mathx';
import { createRng } from '../../core/rng';
import type { MaterialKey } from '../../render/materials';
import type { GeometrySink, InteractionPoint } from '../build/types';
import { TERMINAL, TERMINAL_FLOOR } from './layout';
import {
  BAGGAGE_Z,
  BENCH_BACK_X,
  BENCH_BLOCK_Z,
  BENCH_RUN_LENGTH,
  CHECKIN_DESK_X,
  CHECKIN_DESK_Z,
  CONCOURSE_SPINE,
  SEAT_PAD_HEIGHT,
  SECURITY_LANE_HALF,
  SECURITY_LANES,
  SECURITY_Z,
  TERMINAL_QUEUES,
} from './plan';
import {
  TERMINAL_DOORS,
  TERMINAL_EAVES,
  TERMINAL_HALL_EAVES,
  TERMINAL_HALL_Z,
  TERMINAL_WALL,
  WorldBatch,
  doorCentre,
  doorNormal,
  type TerminalDoor,
} from './buildings';

/** Inner face of the envelope, which is where the fit-out starts. */
const INNER = {
  minX: TERMINAL.minX + TERMINAL_WALL,
  maxX: TERMINAL.maxX - TERMINAL_WALL,
  minZ: TERMINAL.minZ + TERMINAL_WALL,
  maxZ: TERMINAL.maxZ - TERMINAL_WALL,
} as const;

/**
 * The smallest vertical gap allowed between two horizontal surfaces that
 * overlap in plan, in metres. Derived in the header note from the depth buffer
 * at the far end of this building; asserted in `tests/terminalSurfaces`.
 */
export const MIN_SURFACE_SEPARATION = 0.025;

/** Ceiling height in the concourse and in the double-height check-in hall. */
const CEIL = TERMINAL_EAVES - 1.1;
const HALL_CEIL = TERMINAL_HALL_EAVES - 1.4;

/** Dropped soffit over the retail edges, and the mezzanine over the hall. */
const SOFFIT_Y = 5.4;
const MEZZANINE_Y = 5.0;

const F = TERMINAL_FLOOR;

/** Structural bay: columns at 11 m, which is what sets the room's rhythm. */
const BAY = 11;

/** Column rows, and how far the cladding stands proud of the concrete. */
const COLUMN_ROWS: readonly number[] = [165, 199];
const COLUMN_HALF = 0.45;
const CLAD_HALF = 0.58;
/** Where the cladding stops. Above this the column is bare concrete. */
const CLAD_TOP = 3.2;

/** Retail: three units on the east wall, two on the west, between the gates. */
const EAST_UNITS: readonly (readonly [number, number])[] = [
  [436, 448],
  [462, 476],
  [494, 508],
];
const WEST_UNITS: readonly (readonly [number, number])[] = [
  [440, 452],
  [470, 482],
];
/** How far a retail unit reaches out from the wall it backs onto. */
const UNIT_DEPTH = 12;
const EAST_UNIT_FRONT = INNER.maxX - UNIT_DEPTH;
const WEST_UNIT_FRONT = INNER.minX + UNIT_DEPTH - 4;

/** Check-in islands in the hall, free standing and running along z. */
const ISLAND_X: readonly [number, number] = [172, 176];
const ISLAND_Z: readonly (readonly [number, number])[] = [
  [364, 380],
  [384, 400],
];

/**
 * The café and the landside retail unit, on the hall's east side and under
 * the mezzanine deck. Their fronts stand 3.4 m clear of the x = 199 column
 * row, which is what leaves room for the café's tables in front of it.
 */
const CAFE = { minX: 203, maxX: INNER.maxX, minZ: 362, maxZ: 378 } as const;
const HALL_SHOP = { minX: 203, maxX: INNER.maxX, minZ: 384, maxZ: 398 } as const;
/** How far south the mezzanine deck reaches, and where the escalator lands. */
const MEZZANINE_Z = 400;

/** Self-service kiosks and the information desk, facing the hall. */
const KIOSK_X = 193.4;
const KIOSK_Z: readonly number[] = [362, 365, 368, 371, 374, 377];
const INFO_DESK = { minX: 192, maxX: 196, minZ: 386, maxZ: 396 } as const;

/** Baggage reclaim: two belt islands at the south end. */
const CAROUSEL_Z: readonly number[] = [534, 540];

// ---------------------------------------------------------------------------

function ceilingAt(z: number): number {
  return F + (z < TERMINAL_HALL_Z ? HALL_CEIL : CEIL);
}

/** Geometry plus a solid collider, in world metres. */
function fitting(
  batch: WorldBatch,
  sink: GeometrySink,
  key: MaterialKey,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  bottom: number,
  top: number,
): void {
  batch.box(key, minX, bottom, minZ, maxX, top, maxZ);
  sink.collider({ minX, maxX, minZ, maxZ, bottom, top, solid: true, surface: key });
}

// ---------------------------------------------------------------------------
// The floor
// ---------------------------------------------------------------------------

/** A rectangle of floor, and the material it is laid in. */
interface FloorZone {
  readonly key: MaterialKey;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

interface PlanRect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

function overlaps(a: PlanRect, b: PlanRect): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
}

/**
 * `rect` with `hole` cut out of it, as up to four pieces.
 *
 * Split across z first and then across x in the middle band, which is the
 * decomposition that produces the fewest pieces for the long thin zones this
 * building is made of.
 */
function subtract(rect: FloorZone, hole: PlanRect): FloorZone[] {
  if (!overlaps(rect, hole)) return [rect];
  const out: FloorZone[] = [];
  const midMinZ = Math.max(rect.minZ, hole.minZ);
  const midMaxZ = Math.min(rect.maxZ, hole.maxZ);
  if (rect.minZ < midMinZ) out.push({ ...rect, maxZ: midMinZ });
  if (midMaxZ < rect.maxZ) out.push({ ...rect, minZ: midMaxZ });
  if (rect.minX < hole.minX) out.push({ ...rect, minZ: midMinZ, maxZ: midMaxZ, maxX: hole.minX });
  if (hole.maxX < rect.maxX) out.push({ ...rect, minZ: midMinZ, maxZ: midMaxZ, minX: hole.maxX });
  return out;
}

/**
 * Lays `zones` over `base` and returns a set of rectangles that TILE the
 * region: every point is covered exactly once, and no two pieces overlap.
 *
 * Painting order is significant - a later zone cuts every earlier one, so the
 * walking line can be drawn across a band and still be one rectangle rather
 * than a coplanar overlap. This is the whole defence against the floor
 * z-fighting, and it is structural rather than a tolerance: two rectangles
 * that share no area cannot share a pixel.
 */
function layFloor(base: FloorZone, zones: readonly FloorZone[]): FloorZone[] {
  let out: FloorZone[] = [base];
  for (const zone of zones) {
    const next: FloorZone[] = [];
    for (const piece of out) {
      for (const part of subtract(piece, zone)) next.push(part);
    }
    // Clipped to the base, so a zone quoted past a wall does not escape it.
    const minX = Math.max(zone.minX, base.minX);
    const maxX = Math.min(zone.maxX, base.maxX);
    const minZ = Math.max(zone.minZ, base.minZ);
    const maxZ = Math.min(zone.maxZ, base.maxZ);
    if (maxX - minX > 1e-4 && maxZ - minZ > 1e-4) next.push({ key: zone.key, minX, maxX, minZ, maxZ });
    out = next;
  }
  return out;
}

/**
 * Half-width of the walking line down the concourse, and half-depth of the two
 * transverse bands.
 *
 * NARROWED from 0.8 and 1.4 after looking at it: at 1.6 m wide and in the
 * palette's darkest floor stone the line read as a black runway down the
 * middle of the building rather than as a wayfinding inlay.
 */
const WALK_LINE_HALF = 0.5;
const BAND_HALF = 1.0;

/**
 * The floor's material zoning.
 *
 * Four rooms, and each of them is a different stone: a light tile hall, a
 * warmer stone concourse, timber inside every shop with a boarded strip in
 * front of it, and a dark back-of-house baggage hall. The transverse bands and
 * the walking line are painted last so they cut across all of it.
 */
function floorZones(): FloorZone[] {
  const zones: FloorZone[] = [
    // Airside concourse and baggage hall: the two rooms past the base tile.
    { key: 'plazaStone', minX: INNER.minX, maxX: INNER.maxX, minZ: SECURITY_Z, maxZ: BAGGAGE_Z },
    { key: 'pavementDark', minX: INNER.minX, maxX: INNER.maxX, minZ: BAGGAGE_Z, maxZ: INNER.maxZ },
  ];
  // Gate lounge pads, one under each bench block and its leg room.
  for (const z0 of BENCH_BLOCK_Z) {
    zones.push({
      key: 'pavement',
      minX: BENCH_BACK_X - 3.4,
      maxX: BENCH_BACK_X + 3.4,
      minZ: z0 - 2.4,
      maxZ: z0 + BENCH_RUN_LENGTH + 1.6,
    });
  }
  // Boarded strip along both retail frontages, and timber inside every unit.
  zones.push({ key: 'boardwalk', minX: EAST_UNIT_FRONT - 3, maxX: EAST_UNIT_FRONT, minZ: EAST_UNITS[0]![0], maxZ: EAST_UNITS[2]![1] });
  zones.push({ key: 'boardwalk', minX: WEST_UNIT_FRONT, maxX: WEST_UNIT_FRONT + 3, minZ: WEST_UNITS[0]![0], maxZ: WEST_UNITS[1]![1] });
  for (const [from, to] of EAST_UNITS) {
    zones.push({ key: 'timber', minX: EAST_UNIT_FRONT, maxX: INNER.maxX, minZ: from, maxZ: to });
  }
  for (const [from, to] of WEST_UNITS) {
    zones.push({ key: 'timber', minX: INNER.minX, maxX: WEST_UNIT_FRONT, minZ: from, maxZ: to });
  }
  zones.push({ key: 'timber', ...CAFE });
  zones.push({ key: 'timber', ...HALL_SHOP });
  // Entrance mat, then the two transverse bands, then the walking line.
  zones.push({ key: 'pavementDark', minX: 160, maxX: 206, minZ: INNER.minZ, maxZ: INNER.minZ + 2.5 });
  for (const z of [SECURITY_Z, BAGGAGE_Z]) {
    zones.push({ key: 'pavementDark', minX: INNER.minX, maxX: INNER.maxX, minZ: z - BAND_HALF, maxZ: z + BAND_HALF });
  }
  const line = (SECURITY_LANES[1] ?? 183);
  zones.push({
    key: 'pavement',
    minX: line - WALK_LINE_HALF,
    maxX: line + WALK_LINE_HALF,
    minZ: INNER.minZ + 2.5,
    maxZ: BAGGAGE_Z - BAND_HALF,
  });
  return zones;
}

/**
 * The floor and the ceiling.
 *
 * The floor is a mosaic of upward quads at exactly `TERMINAL_FLOOR`; see the
 * header. The collider is still one non-solid box over the whole footprint,
 * because that is what makes the interior walkable and what the controller
 * reads as `interior`.
 */
function buildFloorAndCeiling(batch: WorldBatch, sink: GeometrySink): void {
  for (const piece of layFloor({ key: 'tileFloor', ...INNER }, floorZones())) {
    batch.top(piece.key, piece.minX, piece.minZ, piece.maxX, piece.maxZ, F);
  }
  sink.collider({
    minX: TERMINAL.minX,
    maxX: TERMINAL.maxX,
    minZ: TERMINAL.minZ,
    maxZ: TERMINAL.maxZ,
    bottom: F - 0.4,
    top: F,
    solid: false,
    surface: 'tileFloor',
  });

  // Ceiling: two planes at the two roof heights.
  batch.box('concrete', INNER.minX, F + HALL_CEIL, INNER.minZ, INNER.maxX, F + HALL_CEIL + 0.2, TERMINAL_HALL_Z);
  batch.box('concrete', INNER.minX, F + CEIL, TERMINAL_HALL_Z, INNER.maxX, F + CEIL + 0.2, INNER.maxZ);
  /*
   * The step between them. Its top stops at the hall ceiling's SOFFIT rather
   * than at the hall ceiling's top face: carried to the top face it put a
   * 0.3 by 61 m strip of `concreteBoard` in exactly the plane of the slab it
   * was closing, which is the same coplanar-overlap defect as the floor, at
   * ceiling height.
   */
  batch.box('concreteBoard', INNER.minX, F + CEIL, TERMINAL_HALL_Z - 0.3, INNER.maxX, F + HALL_CEIL, TERMINAL_HALL_Z);
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/** Soffit height of the down-stand beam over a column row, at this z. */
function beamSoffit(z: number): number {
  return z < TERMINAL_HALL_Z ? F + HALL_CEIL - 0.9 : F + CEIL - 0.8;
}

/**
 * Columns and the beams they carry.
 *
 * Two rows at 11 m centres. In a room this size the structure is the only
 * thing that gives the eye a scale, and it is also what stops the 62 m span
 * reading as an impossible clear span.
 *
 * A column stops at the SOFFIT of the beam it carries, not at the ceiling:
 * carried to the ceiling its top face was in the same plane as the beam's, and
 * the two overlapped over the whole column. It is also what a column does.
 */
function buildStructure(batch: WorldBatch, sink: GeometrySink): void {
  for (const x of COLUMN_ROWS) {
    /*
     * PHASED from `INNER.minZ + 6`. At that phase a column stood at z = 372.5
     * and z = 394.5, which is 0.5 m and 2.5 m from the two check-in queue
     * lines published in `plan.ts` - so the fifth person in the first queue
     * was standing inside a structural column. `+ 3` puts every column in the
     * middle of a queue's gap.
     */
    for (let z = INNER.minZ + 3; z < INNER.maxZ - 4; z += BAY) {
      const top = beamSoffit(z);
      fitting(batch, sink, 'concrete', x - COLUMN_HALF, z - COLUMN_HALF, x + COLUMN_HALF, z + COLUMN_HALF, F, top);
      // Clad base. Wider than the shaft, so its top face clears the shaft's
      // by the whole height of the column rather than by a paint thickness.
      batch.box('metalLight', x - CLAD_HALF, F, z - CLAD_HALF, x + CLAD_HALF, F + CLAD_TOP, z + CLAD_HALF);
      batch.box('metalDark', x - CLAD_HALF - 0.05, F, z - CLAD_HALF - 0.05, x + CLAD_HALF + 0.05, F + 0.12, z + CLAD_HALF + 0.05);
    }
    // Down-stand beam over the row.
    // Stops at the ceiling step rather than under it: run to `TERMINAL_HALL_Z`
    // its top face was in the step's plane over the whole 1.1 m of its width.
    batch.box('concrete', x - 0.55, F + HALL_CEIL - 0.9, INNER.minZ, x + 0.55, F + HALL_CEIL, TERMINAL_HALL_Z - 0.3);
    batch.box('concrete', x - 0.55, F + CEIL - 0.8, TERMINAL_HALL_Z, x + 0.55, F + CEIL, INNER.maxZ);
  }

  // Roof trusses across the check-in hall, which is where the extra height is
  // and therefore the only place structure is visible from the floor.
  for (let z = INNER.minZ + 5.5; z < TERMINAL_HALL_Z; z += BAY) {
    batch.box('metalDark', INNER.minX, F + HALL_CEIL - 0.55, z - 0.16, INNER.maxX, F + HALL_CEIL - 0.2, z + 0.16);
    // The web hangs BELOW the chord. Drawn inside it the two shared a top
    // face and neither was visible anyway.
    for (let x = INNER.minX + 4; x < INNER.maxX - 4; x += 6) {
      batch.box('metalDark', x - 0.06, F + HALL_CEIL - 0.95, z - 0.06, x + 0.06, F + HALL_CEIL - 0.55, z + 0.06);
    }
  }
}

/**
 * The dropped soffits and the mezzanine.
 *
 * The single most effective thing in the building. 61 m of clear width under a
 * flat lid reads as a warehouse whatever is standing on the floor; dropping
 * the ceiling to 5.4 m over the two retail edges and running a mezzanine deck
 * over the hall's east side leaves a tall slot down the middle, and the slot
 * is what makes the concourse read as a concourse.
 *
 * None of it touches the floor, so none of it can block a route.
 */
function buildSoffits(batch: WorldBatch): void {
  const soffit = (minX: number, maxX: number, minZ: number, maxZ: number, fasciaAtMinX: boolean): void => {
    batch.box('concreteBoard', minX, F + SOFFIT_Y, minZ, maxX, F + SOFFIT_Y + 0.25, maxZ);
    // Fascia down the open edge, which is what gives the soffit an edge to
    // read by and where the cove lighting is hidden.
    const edge = fasciaAtMinX ? minX : maxX;
    const from = fasciaAtMinX ? edge : edge - 0.3;
    batch.box('metalDark', from, F + SOFFIT_Y - 0.55, minZ, from + 0.3, F + SOFFIT_Y, maxZ);
    batch.box('lampGlass', from + 0.05, F + SOFFIT_Y - 0.5, minZ + 0.4, from + 0.12, F + SOFFIT_Y - 0.12, maxZ - 0.4);
  };

  // Airside, both edges, from the security line to the baggage partition.
  soffit(INNER.minX, WEST_UNIT_FRONT + 3, SECURITY_Z + BAND_HALF, BAGGAGE_Z - BAND_HALF, false);
  soffit(EAST_UNIT_FRONT - 3, INNER.maxX, SECURITY_Z + BAND_HALF, BAGGAGE_Z - BAND_HALF, true);

  // Mezzanine over the hall's east side, carried on the x = 199 column row.
  const mezMinX = 197;
  batch.box('concrete', mezMinX, F + MEZZANINE_Y, INNER.minZ, INNER.maxX, F + MEZZANINE_Y + 0.4, MEZZANINE_Z);
  batch.box('metalDark', mezMinX - 0.35, F + MEZZANINE_Y - 0.5, INNER.minZ, mezMinX, F + MEZZANINE_Y + 0.4, MEZZANINE_Z);
  // Split round the escalator head, so the fascia and the top tread - both of
  // which top out at deck level - never stand on the same ground.
  batch.box('metalDark', mezMinX, F + MEZZANINE_Y - 0.5, MEZZANINE_Z, 208.2, F + MEZZANINE_Y, MEZZANINE_Z + 0.35);
  batch.box('metalDark', 210.6, F + MEZZANINE_Y - 0.5, MEZZANINE_Z, INNER.maxX, F + MEZZANINE_Y, MEZZANINE_Z + 0.35);
  // Glazed balustrade along its open edge.
  batch.box('glass', mezMinX - 0.3, F + MEZZANINE_Y + 0.4, INNER.minZ, mezMinX - 0.2, F + MEZZANINE_Y + 1.5, MEZZANINE_Z);
  for (let z = INNER.minZ + 2; z < MEZZANINE_Z; z += 3) {
    // Stops inside the handrail, which spans 1.50 to 1.62 above the deck.
    batch.box('metalLight', mezMinX - 0.34, F + MEZZANINE_Y + 0.4, z - 0.05, mezMinX - 0.16, F + MEZZANINE_Y + 1.56, z + 0.05);
  }
  batch.box('metalLight', mezMinX - 0.36, F + MEZZANINE_Y + 1.5, INNER.minZ, mezMinX - 0.14, F + MEZZANINE_Y + 1.62, MEZZANINE_Z);
  // Downlights on the deck's underside. Everything below it is in the shadow
  // of a 16 m slab, and an unlit café under a mezzanine reads as a hole.
  for (let z = INNER.minZ + 3; z < MEZZANINE_Z - 2; z += 4) {
    for (const x of [200.5, 206, 211]) {
      batch.box('lampGlass', x - 0.55, F + MEZZANINE_Y - 0.05, z - 0.24, x + 0.55, F + MEZZANINE_Y, z + 0.24);
    }
  }
  /*
   * The escalator up to it, against the hall's east wall. It climbs NORTH so
   * that its head lands on the deck's south edge rather than under the deck,
   * and its steps are separate treads rather than one ramp - a ramp with a
   * handrail is a fire escape, and the tread line is the whole read.
   */
  const rise = MEZZANINE_Y;
  const steps = 10;
  const bottom = MEZZANINE_Z + 12;
  for (let i = 0; i < steps; i += 1) {
    const t = i / steps;
    const z0 = bottom - 1.2 * i;
    batch.box('metalLight', 208.4, F + rise * t, z0 - 1.2, 210.4, F + rise * (t + 1 / steps), z0);
  }
  for (const x of [208.2, 210.4]) {
    batch.box('metalDark', x, F, MEZZANINE_Z, x + 0.2, F + rise + 1.1, bottom);
  }
}

// ---------------------------------------------------------------------------
// Check-in hall
// ---------------------------------------------------------------------------

/** A counter carcass with a lipped top, which is what a desk actually is. */
function counter(
  batch: WorldBatch,
  sink: GeometrySink,
  key: MaterialKey,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  height = 1.05,
): void {
  fitting(batch, sink, key, minX, minZ, maxX, maxZ, F, F + height);
  batch.box('metalLight', minX - 0.1, F + height, minZ - 0.1, maxX + 0.1, F + height + 0.06, maxZ + 0.1);
}

function buildCheckIn(batch: WorldBatch, sink: GeometrySink): void {
  const [deskMinX, deskMaxX] = CHECKIN_DESK_X;

  for (const z of CHECKIN_DESK_Z) {
    // Desk carcass and counter top. The queue anchors published in `plan.ts`
    // stand 0.8 m off the counter face, so nothing is built east of it.
    counter(batch, sink, 'pavementDark', deskMinX, z - 4.5, deskMaxX, z + 4.5);
    // Back-of-house screen behind the desks, with the belt opening in it.
    batch.box('concreteBoard', deskMinX - 0.1, F, z - 4.5, deskMinX, F + 2.6, z + 4.5);
    // Bag belt running back through the screen.
    batch.box('metalDark', deskMinX, F + 0.45, z - 0.7, deskMaxX - 0.6, F + 0.6, z + 0.7);
    // Desk position numbers, hung on a gantry over each pair of positions.
    batch.box('metalDark', deskMinX + 0.9, F + 3.1, z - 0.6, deskMaxX, F + 3.2, z + 0.6);
    batch.box('lampGlass', deskMinX + 1.1, F + 2.45, z - 0.55, deskMinX + 1.16, F + 3.1, z + 0.55);
    batch.box('metalDark', deskMinX + 1.0, F + 2.4, z - 0.62, deskMinX + 1.1, F + 3.14, z + 0.62);
    // A monitor at each position, facing the passenger.
    for (const dz of [-2.2, 2.2]) {
      batch.box('glassShop', deskMaxX - 0.5, F + 1.11, z + dz - 0.3, deskMaxX - 0.44, F + 1.62, z + dz + 0.3);
    }
  }

  // Belt drive housing along the wall behind the desks.
  batch.box('metalDark', INNER.minX, F, CHECKIN_DESK_Z[0]! - 6, deskMinX - 0.1, F + 1.4, CHECKIN_DESK_Z[2]! + 6);
  sink.collider({
    minX: INNER.minX,
    maxX: deskMinX,
    minZ: CHECKIN_DESK_Z[0]! - 6,
    maxZ: CHECKIN_DESK_Z[2]! + 6,
    bottom: F,
    top: F + 1.4,
    solid: true,
    surface: 'metalDark',
  });

  // Queue barriers: a run of posts along each queue lane, set back from the
  // head anchor so the line has something to follow without being boxed in.
  for (const queue of TERMINAL_QUEUES) {
    if (queue.heading !== Math.PI / 2) continue;
    for (const side of [-1, 1] as const) {
      for (let k = 0; k < 8; k += 1) {
        const x = queue.x + k * 0.92;
        batch.cylinder('metalLight', x, queue.z + side * 1.3, 0.035, 0.05, F, 0.95, 6);
        if (k > 0) {
          batch.box('canvasAwning', x - 0.92, F + 0.82, queue.z + side * 1.3 - 0.02, x, F + 0.88, queue.z + side * 1.3 + 0.02);
        }
      }
    }
  }

  buildCheckInIslands(batch, sink);
  buildKiosks(batch, sink);
}

/**
 * Two free-standing check-in islands in the middle of the hall.
 *
 * An island reads as an island because it is served from both sides and has
 * its own overhead gantry: a counter run against a wall is a bag drop, and the
 * hall already has three of those on the west wall.
 */
function buildCheckInIslands(batch: WorldBatch, sink: GeometrySink): void {
  const [minX, maxX] = ISLAND_X;
  const midX = (minX + maxX) / 2;
  for (const [from, to] of ISLAND_Z) {
    counter(batch, sink, 'pavementDark', minX, from, maxX, to);
    // Spine down the middle of the island, carrying the belt and the gantry.
    batch.box('metalLight', midX - 0.5, F + 1.11, from, midX + 0.5, F + 2.0, to);
    batch.box('metalDark', midX - 0.62, F + 2.0, from - 0.2, midX + 0.62, F + 2.2, to + 0.2);
    batch.box('metalDark', midX - 0.08, F + 2.2, from + 0.4, midX + 0.08, F + 3.4, to - 0.4);
    batch.box('metalDark', midX - 2.6, F + 3.4, from + 0.4, midX + 2.6, F + 3.55, to - 0.4);
    // Position numbers, one lightbox per side per position.
    for (let z = from + 2; z < to; z += 4) {
      for (const side of [-1, 1] as const) {
        batch.box('lampGlass', midX + side * 2.2, F + 2.75, z - 0.55, midX + side * 2.32, F + 3.35, z + 0.55);
        batch.box('metalDark', midX + side * 2.14, F + 2.7, z - 0.62, midX + side * 2.38, F + 3.4, z + 0.62);
        // Bag scale set into the counter, and a monitor at the position.
        batch.box('metalDark', midX + side * 1.55, F + 1.11, z - 0.6, midX + side * 1.95, F + 1.19, z + 0.6);
        batch.box('glassShop', midX + side * 0.95, F + 1.11, z - 0.3, midX + side * 1.01, F + 1.62, z + 0.3);
      }
    }
    // Glazed end screens, so the island has a front and a back.
    for (const z of [from - 0.05, to - 0.05]) {
      batch.box('glass', minX, F + 1.11, z, maxX, F + 2.3, z + 0.1);
    }
  }
}

/** Self-service kiosks and the information desk, on the hall's east side. */
function buildKiosks(batch: WorldBatch, sink: GeometrySink): void {
  for (const z of KIOSK_Z) {
    fitting(batch, sink, 'metalDark', KIOSK_X, z - 0.4, KIOSK_X + 0.7, z + 0.4, F, F + 0.95);
    // Canted screen head, facing west into the hall.
    batch.box('metalLight', KIOSK_X - 0.06, F + 0.95, z - 0.42, KIOSK_X + 0.72, F + 1.45, z + 0.42);
    batch.box('glassShop', KIOSK_X - 0.12, F + 1.02, z - 0.34, KIOSK_X - 0.04, F + 1.4, z + 0.34);
  }
  // A run of overhead signage over the bank.
  batch.box('metalDark', KIOSK_X - 0.4, F + 2.4, KIOSK_Z[0]! - 0.8, KIOSK_X + 0.9, F + 2.5, KIOSK_Z[5]! + 0.8);
  batch.box('signEmissiveWarm', KIOSK_X - 0.34, F + 1.75, KIOSK_Z[0]! - 0.7, KIOSK_X - 0.26, F + 2.4, KIOSK_Z[5]! + 0.7);
  for (const z of [KIOSK_Z[0]! - 0.8, KIOSK_Z[5]! + 0.8]) {
    batch.cylinder('metalDark', KIOSK_X + 0.25, z, 0.04, 0.04, F + 2.5, ceilingAt(z) - F - 2.5, 6);
  }

  // Information desk: an island counter with a back screen and a lit fascia.
  counter(batch, sink, 'timberDark', INFO_DESK.minX, INFO_DESK.minZ, INFO_DESK.maxX, INFO_DESK.maxZ, 1.02);
  batch.box('concreteBoard', INFO_DESK.maxX - 0.3, F, INFO_DESK.minZ + 1, INFO_DESK.maxX, F + 3.0, INFO_DESK.maxZ - 1);
  batch.box('signEmissiveWarm', INFO_DESK.maxX - 0.36, F + 2.2, INFO_DESK.minZ + 1.4, INFO_DESK.maxX - 0.31, F + 2.9, INFO_DESK.maxZ - 1.4);
  batch.box('metalDark', INFO_DESK.minX - 0.2, F + 2.6, (INFO_DESK.minZ + INFO_DESK.maxZ) / 2 - 1.6, INFO_DESK.minX + 0.1, F + 2.7, (INFO_DESK.minZ + INFO_DESK.maxZ) / 2 + 1.6);
}

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

/**
 * The security line: a partition across the building with three lanes through
 * it. This is the one place the plan is actually enforced - the partition has
 * colliders, so a player walking south really does go through a lane.
 */
function buildSecurity(batch: WorldBatch, sink: GeometrySink): void {
  const laneHalf = SECURITY_LANE_HALF;
  const edges: number[] = [INNER.minX];
  for (const lane of SECURITY_LANES) edges.push(lane - laneHalf, lane + laneHalf);
  edges.push(INNER.maxX);

  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i] as number;
    const b = edges[i + 1] as number;
    if (b - a < 0.2) continue;
    fitting(batch, sink, 'concreteBoard', a, SECURITY_Z - 0.9, b, SECURITY_Z + 0.9, F, F + 2.6);
    batch.box('glass', a + 0.2, F + 2.6, SECURITY_Z - 0.06, b - 0.2, F + 4.2, SECURITY_Z + 0.06);
    // A lit band along the landside face, so the line reads from up the hall.
    batch.box('lampGlass', a + 0.3, F + 2.42, SECURITY_Z - 0.96, b - 0.3, F + 2.56, SECURITY_Z - 0.9);
  }

  for (const lane of SECURITY_LANES) {
    // Archway frame round each lane, and the belt table beyond it.
    batch.box('metalLight', lane - laneHalf - 0.12, F, SECURITY_Z - 0.5, lane - laneHalf, F + 2.4, SECURITY_Z + 0.5);
    batch.box('metalLight', lane + laneHalf, F, SECURITY_Z - 0.5, lane + laneHalf + 0.12, F + 2.4, SECURITY_Z + 0.5);
    // The head spans the opening EXACTLY. Oversailed by 0.12 m it put its top
    // face in the partition's plane over both piers.
    batch.box('metalLight', lane - laneHalf, F + 2.4, SECURITY_Z - 0.5, lane + laneHalf, F + 2.6, SECURITY_Z + 0.5);
    // Lane number: a lit panel in a dark surround, not a bar of neon.
    batch.box('metalDark', lane - 0.62, F + 2.62, SECURITY_Z - 0.32, lane + 0.62, F + 3.3, SECURITY_Z + 0.32);
    batch.box('lampGlass', lane - 0.54, F + 2.7, SECURITY_Z - 0.38, lane + 0.54, F + 3.22, SECURITY_Z - 0.3);
    // Roller bed feeding the scanner, on the landside face. Rollers are bars
    // across the bed, 40 mm proud of it - not discs, which is what a vertical
    // cylinder would have been.
    batch.box('metalDark', lane - 1.1, F + 0.7, SECURITY_Z - 3.4, lane + 1.1, F + 0.86, SECURITY_Z - 1.3);
    for (let z = SECURITY_Z - 3.3; z < SECURITY_Z - 1.45; z += 0.28) {
      batch.box('metalLight', lane - 1.05, F + 0.86, z, lane + 1.05, F + 0.9, z + 0.14);
    }
  }

  /*
   * Tray tables and re-composure benches stand in the BAYS between the lane
   * corridors, never in one. A table across the exit of a lane is what a
   * re-composure bench looks like in a photograph and is also a wall across
   * the only route through the building; `tests/terminalSurfaces` fails on it.
   */
  for (const [from, to] of securityBays()) {
    const mid = (from + to) / 2;
    if (to - from < 4.5) continue;
    fitting(batch, sink, 'metalLight', mid - 2.0, SECURITY_Z + 1.4, mid + 2.0, SECURITY_Z + 3.6, F, F + 0.82);
    batch.box('metalDark', mid - 2.1, F + 0.82, SECURITY_Z + 1.3, mid + 2.1, F + 0.88, SECURITY_Z + 3.7);
  }

  buildSecurityQueue(batch);
  buildRecomposure(batch, sink);
}

/**
 * The queue snake north of the security line.
 *
 * Belt posts only - no colliders anywhere in it. A retractable belt is not
 * something a person walks into, the traveller crowd already queues to the
 * anchors published in `plan.ts`, and a solid maze here would close the one
 * route through the building. The band the published security queue occupies
 * is left empty on purpose; the posts stand either side of it.
 */
function buildSecurityQueue(batch: WorldBatch): void {
  const post = (x: number, z: number): void => {
    batch.cylinder('metalDark', x, z, 0.04, 0.055, F, 1.0, 6);
    batch.box('metalDark', x - 0.12, F, z - 0.12, x + 0.12, F + 0.05, z + 0.12);
  };
  // Grown only ACROSS the run, so consecutive belts abut instead of overlapping.
  const belt = (x0: number, x1: number, z: number): void => {
    batch.box('canvasAwning', Math.min(x0, x1), F + 0.86, z - 0.02, Math.max(x0, x1), F + 0.92, z + 0.02);
  };
  // Two blocks of snake, west and east of the published queue band at x = 176.
  for (const [from, to] of [
    [161, 173],
    [179, 202],
  ] as const) {
    for (let z = SECURITY_Z - 9; z <= SECURITY_Z - 3.5; z += 2.2) {
      let previous = from;
      for (let x = from; x <= to; x += 3) {
        post(x, z);
        if (x > previous) belt(previous, x, z);
        previous = x;
      }
    }
  }
  // Head-of-queue lecterns beside each lane, tucked against the pier so the
  // lane itself stays its full width.
  for (const lane of SECURITY_LANES) {
    const x = lane + SECURITY_LANE_HALF + 0.2;
    batch.box('timberDark', x, F, SECURITY_Z - 1.6, x + 0.7, F + 1.12, SECURITY_Z - 0.7);
    batch.box('glassShop', x + 0.05, F + 1.12, SECURITY_Z - 1.5, x + 0.65, F + 1.16, SECURITY_Z - 0.8);
  }
}

/**
 * The clear spans across the building between the security lane corridors.
 *
 * A lane is a hole in a wall that people walk through in single file, so the
 * corridor it opens has to stay clear all the way through the room, not just
 * across the partition. Everything security puts on the floor is placed in
 * these bays, and the concourse spine is deliberately not one of them.
 */
function securityBays(): [number, number][] {
  const out: [number, number][] = [];
  let cursor = INNER.minX + 1;
  for (const lane of SECURITY_LANES) {
    out.push([cursor, lane - SECURITY_LANE_HALF - 0.4]);
    cursor = lane + SECURITY_LANE_HALF + 0.4;
  }
  out.push([cursor, INNER.maxX - 1]);
  return out.filter(([from, to]) => to - from > 3 && !(to > CONCOURSE_SPINE.minX && from < CONCOURSE_SPINE.maxX));
}

/** Re-composure benches airside of the lanes, where people repack. */
function buildRecomposure(batch: WorldBatch, sink: GeometrySink): void {
  for (const [from, to] of securityBays()) {
    if (to - from < 6) continue;
    const a = from + 1;
    const b = Math.min(to - 1, a + 10);
    fitting(batch, sink, 'timber', a, SECURITY_Z + 5.6, b, SECURITY_Z + 6.5, F, F + 0.86);
    batch.box('metalDark', a, F + 0.86, SECURITY_Z + 5.5, b, F + 0.92, SECURITY_Z + 6.6);
    for (let x = a + 0.6; x < b; x += 2.2) {
      batch.box('metalDark', x - 0.05, F, SECURITY_Z + 5.7, x + 0.05, F + 0.8, SECURITY_Z + 6.4);
    }
  }
}

// ---------------------------------------------------------------------------
// Gate lounge
// ---------------------------------------------------------------------------

/**
 * The benches.
 *
 * Back to back in three blocks, with the pad at exactly
 * `TERMINAL_FLOOR + SEAT_PAD_HEIGHT`. That number is measured from the seated
 * figures the traveller crowd places, so it is a contract rather than a taste:
 * a bench a few centimetres out puts every sitter through the seat or above it.
 *
 * No collider on the pad. A bench the player can walk over is wrong, but a
 * bench that is a 0.45 m solid step is worse - the controller's step height
 * lets the player climb it and then stand on the backrest - so the collider is
 * the back panel only, which is what actually blocks the route.
 */
function buildGateSeating(batch: WorldBatch, sink: GeometrySink): void {
  const padY = F + SEAT_PAD_HEIGHT;
  for (const z0 of BENCH_BLOCK_Z) {
    const from = z0 - 0.35;
    const to = z0 + BENCH_RUN_LENGTH - 0.35;
    // Shared back panel, and the collider that stands for the whole block.
    fitting(batch, sink, 'metalDark', BENCH_BACK_X - 0.09, from, BENCH_BACK_X + 0.09, to, F, padY + 0.5);
    for (const side of [-1, 1] as const) {
      const inner = BENCH_BACK_X + side * 0.35;
      const outer = BENCH_BACK_X + side * 1.32;
      /*
       * The slab is drawn DOWN from `padY`, not up from it. Drawn upward its
       * visible surface was 60 mm above the height `plan.ts` publishes as the
       * seat pad, so the number the traveller crowd measures its seated
       * figures against and the number a player sees were not the same number.
       */
      batch.box('metalLight', Math.min(inner, outer), padY - 0.06, from, Math.max(inner, outer), padY, to);
      // Frame legs at each end and mid-run.
      for (const t of [0.06, 0.5, 0.94]) {
        const z = from + (to - from) * t;
        batch.box('metalDark', Math.min(inner, outer) + 0.05, F, z - 0.04, Math.max(inner, outer) - 0.05, padY - 0.06, z + 0.04);
      }
      // Armrests every four seats, which is what stops a bench reading as a
      // shelf and is also how a real one is divided.
      for (let k = 0; k <= 8; k += 4) {
        const z = from + 0.35 + k * 0.7;
        if (z > to) continue;
        batch.box('metalDark', Math.min(inner, outer), padY, z - 0.03, Math.max(inner, outer), padY + 0.2, z + 0.03);
      }
    }
    // A bin and a charging column at the head of each block, which is the
    // detail that says somebody waits here rather than walks past.
    batch.cylinder('metalDark', BENCH_BACK_X, from - 1.3, 0.22, 0.24, F, 0.85, 8);
    batch.box('metalLight', BENCH_BACK_X - 0.22, F, to + 0.6, BENCH_BACK_X + 0.22, F + 1.05, to + 1.04);
    batch.box('lampGlass', BENCH_BACK_X - 0.16, F + 1.05, to + 0.66, BENCH_BACK_X + 0.16, F + 1.1, to + 0.98);
  }

  // A planter run down the east side of the lounge, between the seating and
  // the shops, which is what breaks the sight line without blocking it.
  for (let z = BENCH_BLOCK_Z[0]! - 4; z < BENCH_BLOCK_Z[2]! + BENCH_RUN_LENGTH + 4; z += 9) {
    fitting(batch, sink, 'plazaStone', 187.4, z, 189.4, z + 3.4, F, F + 0.55);
    batch.box('foliage', 187.5, F + 0.55, z + 0.1, 189.3, F + 1.5, z + 3.3);
  }
}

/**
 * Gate desks, boarding doors and the pier furniture around them.
 *
 * Each airside door gets the set that makes an opening in a wall read as a
 * gate: a podium with a reader, a numbered lightbox over the door, a glazed
 * boarding vestibule inside it, and a barrier run either side.
 */
function buildGates(batch: WorldBatch, sink: GeometrySink, doors: readonly TerminalDoor[]): void {
  for (const door of doors) {
    if (door.landside) continue;
    const z = door.along;
    counter(batch, sink, 'pavementDark', 205, z - 1.6, 209, z + 1.6);
    // Boarding-pass reader on the podium, and the agent's monitor.
    batch.box('metalDark', 206.2, F + 1.11, z - 0.3, 206.6, F + 1.36, z + 0.3);
    batch.box('glassShop', 207.6, F + 1.11, z - 0.35, 207.66, F + 1.6, z + 0.35);
    // Departure screen on a post beside the desk.
    batch.cylinder('metalDark', 204, z + 2.6, 0.05, 0.06, F, 1.9, 6);
    batch.box('metalDark', 203.4, F + 1.9, z + 2.3, 204.6, F + 2.56, z + 2.9);
    batch.box('lampGlass', 203.5, F + 1.96, z + 2.24, 204.5, F + 2.5, z + 2.3);
    // Glazed boarding vestibule in the opening, so the door reads as a gate
    // rather than as a hole. Set clear of the reveal on both sides.
    for (const side of [-1, 1] as const) {
      batch.box('glass', 209.6, F + 0.1, z + side * 2.0, INNER.maxX, F + 2.9, z + side * 2.1);
      batch.box('metalLight', 209.6, F + 2.9, z + side * 2.02, INNER.maxX, F + 3.05, z + side * 2.12);
      // Gate barrier: a low run either side of the door so the opening reads
      // as a controlled one.
      batch.box('metalLight', 210.5, F, z + side * 2.4, 213.4, F + 1.0, z + side * 2.5);
    }
    // Numbered lightbox over the opening, inside the terminal.
    batch.box('metalDark', 209.4, F + 3.3, z - 1.7, 209.6, F + 4.3, z + 1.7);
    batch.box('lampGlass', 209.2, F + 3.42, z - 1.55, 209.4, F + 4.18, z + 1.55);
  }
}

/**
 * Retail and food, five units: three backing onto the east wall between the
 * gates, two onto the west wall opposite them.
 *
 * Each is a shell with a real front - a glazed screen with a wide opening in
 * it, a counter across the opening and a fascia over it - because a unit that
 * is open along its whole face reads as an alcove and not as a shop.
 */
function buildShops(batch: WorldBatch, sink: GeometrySink): void {
  const rng = createRng('meridian-terminal-retail');

  const unit = (front: number, back: number, from: number, to: number, fascia: MaterialKey): void => {
    const dir = Math.sign(back - front);
    const wall = 0.2;
    // Three walls that TILE the shell rather than overlapping at its corners:
    // the two flanks run the full depth and the back wall runs between them.
    const side = (a: number, b: number): void => {
      fitting(batch, sink, 'stuccoCream', Math.min(front, back), a, Math.max(front, back), b, F, F + 3.4);
    };
    side(from, from + wall);
    side(to - wall, to);
    fitting(
      batch,
      sink,
      'stuccoCream',
      Math.min(back, back - dir * wall),
      from + wall,
      Math.max(back, back - dir * wall),
      to - wall,
      F,
      F + 3.4,
    );
    // Shopfront: a glazed screen either side of a 3 m opening, under a fascia.
    const openFrom = (from + to) / 2 - 1.5;
    const openTo = (from + to) / 2 + 1.5;
    for (const [a, b] of [
      [from + wall, openFrom],
      [openTo, to - wall],
    ] as const) {
      batch.box('glass', front - dir * 0.06, F + 0.1, a, front + dir * 0.06, F + 2.9, b);
      batch.box('metalLight', front - dir * 0.09, F, a, front + dir * 0.09, F + 0.1, b);
    }
    batch.box('metalDark', Math.min(front, front + dir * 0.5), F + 2.9, from + wall, Math.max(front, front + dir * 0.5), F + 3.4, to - wall);
    // Set INTO the header rather than floating in front of it.
    batch.box(fascia, front - dir * 0.22, F + 3.0, from + 0.35, front + dir * 0.1, F + 3.32, to - 0.35);
    // Counter just inside the opening, and shelving on the back wall.
    fitting(
      batch,
      sink,
      'timberDark',
      Math.min(front + dir * 0.9, front + dir * 2.0),
      openFrom + 0.1,
      Math.max(front + dir * 0.9, front + dir * 2.0),
      openTo - 0.1,
      F,
      F + 1.02,
    );
    const shelfFront = back - dir * (wall + 1.2);
    // Three shelves at 0.72 m, stocked at 0.95 m. Denser looked better in a
    // screenshot and cost 3,900 triangles across seven units for stock the
    // player only ever sees through a 3 m opening.
    for (let y = 0.55; y < 2.3; y += 0.72) {
      batch.box('timber', Math.min(shelfFront, back - dir * wall), F + y, from + 0.4, Math.max(shelfFront, back - dir * wall), F + y + 0.05, to - 0.4);
      for (let z = from + 0.8; z < to - 0.8; z += 0.95) {
        const w = rng.range(0.16, 0.3);
        const h = rng.range(0.14, 0.32);
        const cx = back - dir * (wall + 0.6);
        batch.box(rng.chance(0.5) ? 'canvasAwning' : 'stuccoRose', cx - w / 2, F + y + 0.05, z - 0.16, cx + w / 2, F + y + 0.05 + h, z + 0.16);
      }
    }
  };

  for (const [from, to] of EAST_UNITS) unit(EAST_UNIT_FRONT, INNER.maxX, from, to, 'signEmissiveWarm');
  for (const [from, to] of WEST_UNITS) unit(WEST_UNIT_FRONT, INNER.minX, from, to, 'signEmissiveWarm');

  // The hall's own two units: a café with tables out front, and one shop.
  unit(CAFE.minX, CAFE.maxX, CAFE.minZ, CAFE.maxZ, 'signEmissiveWarm');
  unit(HALL_SHOP.minX, HALL_SHOP.maxX, HALL_SHOP.minZ, HALL_SHOP.maxZ, 'signEmissiveWarm');
  for (let z = CAFE.minZ + 2; z < CAFE.maxZ - 1; z += 3.4) {
    for (const x of [201.2]) {
      batch.cylinder('metalDark', x, z, 0.04, 0.06, F, 0.72, 8);
      batch.cylinder('timber', x, z, 0.42, 0.42, F + 0.72, 0.05, 10);
      for (const [dx, dz] of [
        [-0.62, 0],
        [0.62, 0],
      ] as const) {
        batch.box('timberDark', x + dx - 0.2, F + 0.42, z + dz - 0.2, x + dx + 0.2, F + 0.47, z + dz + 0.2);
        batch.box('timberDark', x + dx - 0.2, F + 0.47, z + dz - 0.2, x + dx - 0.14, F + 0.86, z + dz + 0.2);
      }
    }
  }
}

/** Baggage reclaim: two belts in an island each, at the south end. */
function buildBaggage(batch: WorldBatch, sink: GeometrySink): void {
  // Partition with a wide opening, so the hall reads as a separate room.
  for (const [a, b] of [
    [INNER.minX, 170],
    [192, INNER.maxX],
  ] as const) {
    fitting(batch, sink, 'concreteBoard', a, BAGGAGE_Z - 0.25, b, BAGGAGE_Z + 0.25, F, F + 3.2);
    // Glazed clerestory over the partition, up to the ceiling.
    batch.box('glass', a + 0.3, F + 3.2, BAGGAGE_Z - 0.06, b - 0.3, F + CEIL - 0.4, BAGGAGE_Z + 0.06);
  }
  // The way through, named. A fascia band rather than a bar of light.
  batch.box('metalDark', 170, F + 2.9, BAGGAGE_Z - 0.35, 192, F + 3.5, BAGGAGE_Z - 0.15);
  batch.box('signEmissiveWarm', 172, F + 3.02, BAGGAGE_Z - 0.42, 190, F + 3.38, BAGGAGE_Z - 0.36);

  for (const z of CAROUSEL_Z) {
    // Belt island: a low kerb with the sloped belt above it. It runs between
    // the two structural rows rather than wall to wall, which is both what a
    // reclaim belt does and what keeps it out of the columns at x = 165, 199.
    fitting(batch, sink, 'metalLight', 167, z - 1.5, 197, z + 1.5, F, F + 0.55);
    batch.box('metalDark', 166.6, F + 0.55, z - 1.7, 197.4, F + 0.75, z + 1.7);
    // Rubber slats along the belt, so it is a belt and not a painted top.
    for (let x = 167.4; x < 197; x += 1.6) {
      batch.box('metalLight', x, F + 0.75, z - 1.68, x + 0.9, F + 0.79, z + 1.68);
    }
    // Hood over the feed end, where the bags come through the wall.
    batch.box('concreteBoard', 200, F, z - 2.2, 205, F + 2.6, z + 2.2);
    batch.box('metalDark', 197.4, F + 1.4, z - 2.0, 200, F + 2.4, z + 2.0);
    // Belt number and an arrivals screen over the head of each carousel.
    batch.box('metalDark', 189, F + 2.5, z - 0.9, 193, F + 3.3, z - 0.8);
    batch.box('lampGlass', 189.2, F + 2.6, z - 0.94, 192.8, F + 3.2, z - 0.9);
    for (const x of [189, 193]) {
      batch.cylinder('metalDark', x, z - 0.85, 0.035, 0.035, F + 3.3, ceilingAt(z) - F - 3.3, 6);
    }
  }
  // Trolley bay against the west wall.
  for (let z = BAGGAGE_Z + 3; z < BAGGAGE_Z + 9; z += 1.1) {
    batch.box('metalLight', INNER.minX + 0.4, F, z, INNER.minX + 1.4, F + 1.0, z + 0.5);
  }
  // Customs channel on the way out, against the west wall: two glazed bays
  // with a bench in each, which is what the last room of an airport has.
  for (const z of [INNER.maxZ - 5.2, INNER.maxZ - 10.4]) {
    fitting(batch, sink, 'concreteBoard', INNER.minX + 3, z, INNER.minX + 3.3, z + 3.6, F, F + 2.6);
    batch.box('metalLight', INNER.minX, F + 0.7, z + 0.6, INNER.minX + 2.6, F + 0.78, z + 3.0);
    batch.box('glass', INNER.minX + 3.05, F + 2.6, z, INNER.minX + 3.25, F + CEIL - 0.6, z + 3.6);
  }
}

// ---------------------------------------------------------------------------
// Services, signage and lighting
// ---------------------------------------------------------------------------

/**
 * Overhead signage.
 *
 * Hung on the structural line at every decision point: the way to security,
 * the way to the gates, the way to baggage. It is the cheapest thing in the
 * building and the thing that most makes it read as an airport.
 *
 * The colour is a decision and it was a bug before. `signEmissive` is the
 * palette's magenta - `0xff5aa8`, authored for the nightclub - and a magenta
 * direction sign reads as a bar, not as an airport. Wayfinding here is a dark
 * panel with a lit face: `metalDark` around `lampGlass`, which is the warm
 * white the ceiling coffers already use.
 */
function buildSignage(batch: WorldBatch): void {
  const hang = (z: number, halfWidth: number, drop: number): void => {
    const top = ceilingAt(z) - 0.35;
    batch.box('metalDark', 183 - halfWidth, top - drop - 0.06, z - 0.12, 183 + halfWidth, top, z + 0.12);
    for (const side of [-1, 1] as const) {
      batch.box('lampGlass', 183 - halfWidth + 0.12, top - drop, z + side * 0.12, 183 + halfWidth - 0.12, top - 0.12, z + side * 0.13);
    }
    for (const t of [-0.8, 0.8]) {
      batch.cylinder('metalDark', 183 + halfWidth * t, z, 0.025, 0.025, top, ceilingAt(z) - top, 5);
    }
  };
  hang(TERMINAL.minZ + 14, 5.5, 0.95);
  hang(SECURITY_Z - 12, 6.5, 1.05);
  hang(SECURITY_Z + 10, 6.5, 1.05);
  hang(BAGGAGE_Z - 10, 5.5, 0.95);
  // A second rank over the gate piers, on the lounge's own centre line.
  for (const z of [458, 490]) hang(z, 4.5, 0.8);

  /*
   * Flight information: two banks either side of the spine, not one board
   * across it. The single 16 m board stood squarely on the route from the
   * main door to the security lane, and it was drawn with no collider, so the
   * player walked through it.
   */
  for (const [minX, maxX] of [
    [166, 180],
    [186, 200],
  ] as const) {
    batch.box('metalDark', minX, F, 414.4, maxX, F + 0.25, 415.6);
    batch.box('metalDark', minX, F + 0.25, 414.7, maxX, F + 3.4, 415.3);
    // Rows of departures, not one lit slab. A 14 m panel of unbroken light
    // reads as a blank lightbox from anywhere in the hall; six rows with dark
    // gutters between them read as a board with flights on it, and they cost
    // ten boxes.
    for (let k = 0; k < 6; k += 1) {
      const y = F + 0.75 + k * 0.42;
      batch.box('lampGlass', minX + 0.4, y, 414.62, maxX - 0.4, y + 0.28, 414.7);
      batch.box('lampGlass', minX + 0.4, y, 415.3, maxX - 0.4, y + 0.28, 415.38);
    }
    // Header band over the rows, so the board has a top.
    batch.box('signEmissiveWarm', minX + 0.4, F + 3.32, 414.62, maxX - 0.4, F + 3.36, 414.7);
    batch.box('signEmissiveWarm', minX + 0.4, F + 3.32, 415.3, maxX - 0.4, F + 3.36, 415.38);
  }
}

/**
 * Light.
 *
 * Emissive ceiling first, because it cannot be dropped: the renderer ranks
 * `LightRequest`s against a budget and a 190 m building would swallow it
 * whole. The scheme is three layers - continuous coffers down the spine,
 * cross rows over the rooms where people stop, and the cove strips already
 * hidden in the soffit fascias - so the volume is legible even when every
 * request below is refused.
 *
 * The requests that follow are a top-up for the places the player actually
 * stops, and they are priority 2, below the city's street lamps.
 */
function buildLighting(batch: WorldBatch, sink: GeometrySink): void {
  /*
   * Everything hung from the ceiling stops `LAMP_DROP` below it.
   *
   * The down-stand beams' top faces are at exactly `ceilingAt(z)`, and a light
   * fitting 10 mm under the ceiling put its own top face 10 mm under theirs
   * wherever a run crossed a beam - inside the depth budget, over a 1.1 m wide
   * strip, thirty-four times. 0.06 m clears it by more than twice the margin.
   */
  const LAMP_DROP = 0.06;
  // Continuous coffer troughs either side of the walking line, the full
  // length. Rails and lamp share no ground: the lamp sits BETWEEN the rails.
  for (const x of [181.2, 184.8]) {
    for (let z = INNER.minZ + 3; z < INNER.maxZ - 2; z += 12) {
      const y = ceilingAt(z) - LAMP_DROP;
      const to = Math.min(z + 9.5, INNER.maxZ - 2);
      for (const side of [-1, 1] as const) {
        batch.box('metalDark', x + side * 0.34, y - 0.22, z - 0.2, x + side * 0.5, y, to + 0.2);
      }
      batch.box('lampGlass', x - 0.34, y - 0.14, z, x + 0.34, y - 0.09, to);
    }
  }
  // Cross rows over the rooms: tighter over check-in and the gate lounge,
  // sparser over the concourse between them. Every run is broken either side
  // of the spine coffers so no two lit panels ever share ground.
  const row = (z: number, from: number, to: number): void => {
    const y = ceilingAt(z) - LAMP_DROP;
    batch.box('lampGlass', from, y - 0.05, z - 0.26, to, y, z + 0.26);
  };
  for (let z = INNER.minZ + 5; z < TERMINAL_HALL_Z; z += 5.5) {
    row(z, 155, 179);
    row(z, 187, 196);
  }
  for (let z = SECURITY_Z + 4; z < BAGGAGE_Z; z += 6.5) {
    row(z, 160, 179.5);
    row(z, 186.5, 206);
  }
  for (let z = BAGGAGE_Z + 3; z < INNER.maxZ - 2; z += 5) {
    row(z, 158, 179.5);
    row(z, 186.5, 208);
  }

  // 2.2 rather than 1.5, and 30 m rather than 22. The count is what the
  // renderer rations, not the reach, so a bigger pool from the same thirteen
  // requests is free - and a 62 m span needs the reach.
  const lamp = (x: number, z: number, intensity = 2.2): void => {
    sink.light({
      x,
      y: ceilingAt(z) - 1.2,
      z,
      color: 0xffe9c9,
      intensity,
      distance: 30,
      priority: 2,
    });
  };
  lamp(183, TERMINAL.minZ + 10);
  lamp(166, 380);
  lamp(174, 392, 1.9);
  lamp(196, 372, 1.9);
  lamp(183, SECURITY_Z - 4);
  lamp(183, SECURITY_Z + 8);
  for (const z of BENCH_BLOCK_Z) lamp(BENCH_BACK_X, z + 2.5);
  lamp(206, 452);
  lamp(206, 482);
  lamp(206, 512);
  lamp(183, 537);
}

// ---------------------------------------------------------------------------
// Doors
// ---------------------------------------------------------------------------

/**
 * The interaction points.
 *
 * The terminal is not a `Parcel`, so it is outside the enterable-building
 * machinery entirely: nothing teleports here. Its doors are real holes in a
 * real wall that the player walks through, and the prompts exist only to name
 * the place - `kind: 'sign'` rather than `'door'`, so `validateDoors` and the
 * interaction system do not try to treat them as a threshold with a target on
 * the far side.
 */
function buildDoorPrompts(sink: GeometrySink): void {
  for (const door of TERMINAL_DOORS) {
    const centre = doorCentre(door);
    const normal = doorNormal(door);
    const point: InteractionPoint = {
      id: `airport-${door.id}`,
      x: centre.x + normal.x * 1.4,
      y: F + 1.4,
      z: centre.z + normal.z * 1.4,
      radius: 3.2,
      prompt: door.landside ? 'Meridian Bay Regional' : `Gate ${door.id.slice(-1)}`,
      kind: 'sign',
    };
    sink.interaction(point);
  }
}

/** Revolving-door drums in the two wide landside openings. */
function buildDoorFurniture(batch: WorldBatch): void {
  for (const door of TERMINAL_DOORS) {
    const centre = doorCentre(door);
    const normal = doorNormal(door);
    const height = F + door.height;
    // A glazed screen either side of the opening, set in the reveal.
    const along = door.face === 'north' ? 'x' : 'z';
    const half = door.width / 2 - 0.25;
    if (along === 'x') {
      batch.box('glass', centre.x - half, F + 0.1, centre.z - 0.05, centre.x - half + 0.08, height - 0.1, centre.z + 0.05);
      batch.box('glass', centre.x + half - 0.08, F + 0.1, centre.z - 0.05, centre.x + half, height - 0.1, centre.z + 0.05);
      batch.box('metalLight', centre.x - door.width / 2, height - 0.14, centre.z - 0.14, centre.x + door.width / 2, height, centre.z + 0.14);
    } else {
      batch.box('glass', centre.x - 0.05, F + 0.1, centre.z - half, centre.x + 0.05, height - 0.1, centre.z - half + 0.08);
      batch.box('glass', centre.x - 0.05, F + 0.1, centre.z + half - 0.08, centre.x + 0.05, height - 0.1, centre.z + half);
      batch.box('metalLight', centre.x - 0.14, height - 0.14, centre.z - door.width / 2, centre.x + 0.14, height, centre.z + door.width / 2);
    }
    // A canopy stub outside every opening, so a door reads from a distance.
    const cx = centre.x + normal.x * 1.1;
    const cz = centre.z + normal.z * 1.1;
    batch.box(
      'metalDark',
      Math.min(centre.x, cx) - (normal.x === 0 ? door.width / 2 : 0),
      height + 0.2,
      Math.min(centre.z, cz) - (normal.z === 0 ? door.width / 2 : 0),
      Math.max(centre.x, cx) + (normal.x === 0 ? door.width / 2 : 0),
      height + 0.36,
      Math.max(centre.z, cz) + (normal.z === 0 ? door.width / 2 : 0),
    );
  }
}

/** Meeters and greeters: a barrier and planters inside the main entrance. */
function buildEntrance(batch: WorldBatch, sink: GeometrySink): void {
  for (const [from, to] of [
    [168, 179.5],
    [186.5, 192],
  ] as const) {
    for (let x = from; x <= to; x += 2.6) {
      batch.cylinder('metalDark', x, INNER.minZ + 6.4, 0.04, 0.055, F, 1.0, 6);
    }
    batch.box('canvasAwning', from, F + 0.88, INNER.minZ + 6.38, to, F + 0.94, INNER.minZ + 6.42);
  }
  // Planters either side of the main door, and a trolley bay beside them.
  for (const x of [169, 193]) {
    fitting(batch, sink, 'plazaStone', x, INNER.minZ + 1.6, x + 4.4, INNER.minZ + 3.6, F, F + 0.6);
    batch.box('foliage', x + 0.1, F + 0.6, INNER.minZ + 1.7, x + 4.3, F + 1.8, INNER.minZ + 3.5);
  }
}

// ---------------------------------------------------------------------------

/** Builds the whole terminal interior. */
export function buildTerminalInterior(sink: GeometrySink): void {
  const batch = new WorldBatch();
  buildFloorAndCeiling(batch, sink);
  buildStructure(batch, sink);
  buildSoffits(batch);
  buildEntrance(batch, sink);
  buildCheckIn(batch, sink);
  buildSecurity(batch, sink);
  buildGateSeating(batch, sink);
  buildGates(batch, sink, TERMINAL_DOORS);
  buildShops(batch, sink);
  buildBaggage(batch, sink);
  buildSignage(batch);
  buildLighting(batch, sink);
  buildDoorFurniture(batch);
  buildDoorPrompts(sink);
  batch.flush(sink);
}

// ---------------------------------------------------------------------------
// Generated-model anchors
// ---------------------------------------------------------------------------

/** A generated interior model, placed by `airport/models.ts`. */
export interface TerminalModelAnchor {
  readonly model:
    | 'checkin-desk'
    | 'scanner'
    | 'flight-board'
    | 'trolley'
    | 'gate-seats'
    | 'backpack'
    | 'garment-bag';
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
}

/**
 * Where each generated interior model stands.
 *
 * The procedural fit-out above is complete on its own - every desk, scanner
 * and board is modelled - and these sit ON TOP of it as the detailed version,
 * exactly as the generated bench replaces the authored one on the street. The
 * two are deliberately in the same places.
 */
export function terminalModelAnchors(): TerminalModelAnchor[] {
  const out: TerminalModelAnchor[] = [];
  for (const z of CHECKIN_DESK_Z) {
    // Facing east, into the hall: -PI/2 in the game's heading convention.
    out.push({ model: 'checkin-desk', x: 159, y: F, z, heading: -Math.PI / 2 });
  }
  // Island positions, served from both sides.
  for (const [from, to] of ISLAND_Z) {
    for (let z = from + 3; z < to; z += 6) {
      out.push({ model: 'checkin-desk', x: ISLAND_X[1] - 1, y: F, z, heading: -Math.PI / 2 });
      out.push({ model: 'checkin-desk', x: ISLAND_X[0] + 1, y: F, z, heading: Math.PI / 2 });
    }
  }
  for (const lane of SECURITY_LANES) {
    out.push({ model: 'scanner', x: lane, y: F, z: SECURITY_Z + 0.2, heading: Math.PI });
  }
  // The two flight-information banks, and one over the reclaim belts.
  out.push({ model: 'flight-board', x: 173, y: F, z: 415, heading: 0 });
  out.push({ model: 'flight-board', x: 193, y: F, z: 415, heading: 0 });
  out.push({ model: 'flight-board', x: 191, y: F, z: CAROUSEL_Z[0]! - 0.85, heading: 0 });
  for (let k = 0; k < 6; k += 1) {
    out.push({
      model: 'trolley',
      x: clamp(157.5 + (k % 2) * 1.1, INNER.minX, INNER.maxX),
      y: F,
      z: 404 + k * 1.15,
      heading: -Math.PI / 2,
    });
  }
  // Trolley bays at the entrance and in the baggage hall, where they live.
  for (let k = 0; k < 4; k += 1) {
    out.push({ model: 'trolley', x: 199 + (k % 2) * 1.1, y: F, z: INNER.minZ + 2.6 + k * 1.15, heading: Math.PI });
    out.push({ model: 'trolley', x: INNER.minX + 2.2, y: F, z: BAGGAGE_Z + 3.2 + k * 1.15, heading: -Math.PI / 2 });
  }
  // Extra benches against the east structural row, between the shop units.
  for (const z of [456, 486]) {
    out.push({ model: 'gate-seats', x: 199.5, y: F, z, heading: Math.PI / 2 });
  }
  // Landside seating in the hall, facing the flight-information banks.
  for (const z of [406, 410]) {
    out.push({ model: 'gate-seats', x: 176, y: F, z, heading: Math.PI });
    out.push({ model: 'gate-seats', x: 190, y: F, z, heading: Math.PI });
  }
  /*
   * Left luggage.
   *
   * A bag on the floor beside a seat is the cheapest thing in the building
   * that says somebody is in it: the traveller crowd carries its own cases,
   * so these are the ones nobody is holding - propped at the end of a bench,
   * stood against a check-in island while its owner finds a passport, and
   * riding the reclaim belt. All static, all instanced, no colliders: a bag
   * you trip over is worse than no bag.
   */
  for (const z0 of BENCH_BLOCK_Z) {
    out.push({ model: 'backpack', x: BENCH_BACK_X - 1.7, y: F, z: z0 + 0.4, heading: -Math.PI / 2 });
    out.push({ model: 'garment-bag', x: BENCH_BACK_X + 1.7, y: F, z: z0 + 3.6, heading: Math.PI / 2 });
  }
  for (const [from] of ISLAND_Z) {
    out.push({ model: 'backpack', x: ISLAND_X[1] + 1.3, y: F, z: from + 5.2, heading: Math.PI });
    out.push({ model: 'garment-bag', x: ISLAND_X[0] - 1.3, y: F, z: from + 9.4, heading: 0 });
  }
  // On the reclaim belts, which sit 0.79 m above the floor.
  for (const z of CAROUSEL_Z) {
    out.push({ model: 'backpack', x: 176, y: F + 0.79, z, heading: -Math.PI / 2 });
    out.push({ model: 'garment-bag', x: 188, y: F + 0.79, z, heading: Math.PI / 2 });
  }
  return out;
}

/** Published so the surface tests can assert the routes stay open. */
export { CONCOURSE_SPINE, SECURITY_LANES, SECURITY_LANE_HALF, BAGGAGE_Z };
