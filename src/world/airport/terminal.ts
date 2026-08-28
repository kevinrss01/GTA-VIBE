/**
 * Inside the terminal.
 *
 * 62 by 190 m of floor, which is 22 times the area of the largest interior in
 * Meridian Bay and needs a different approach from the ones in
 * `interiorProps.ts`. Those are single rooms fitted out around one door; this
 * is a building with a sequence: you come in at the north end under the high
 * roof, check in against the west wall, pass security across the middle, and
 * everything south of that line is airside - the lounge, the gates, the shops
 * and the baggage hall.
 *
 * ## Budget
 *
 * `InteriorBuilder` holds each city interior under 4,000 triangles and five
 * lights. Scaled by floor area that would allow 88,000 triangles here, which
 * would be absurd: the whole city is 313,000. The budget taken instead is
 * about 12,000 triangles and 16 lights, and it is spent on the things that
 * make a big room legible - the structural bay rhythm, the floor bands that
 * separate landside from airside, and the fittings the player walks past. Flat
 * wall is left flat.
 *
 * Lights are the harder limit. The renderer ranks `LightRequest`s and drops
 * the ones it cannot afford, so 16 low-priority strips over 190 m is a request
 * for whichever few are nearest, not a promise of sixteen. The ceiling itself
 * is emissive so the room is never dark even when every request is dropped.
 *
 * ## The floor
 *
 * `CityGround.sample` reports `concrete` under the whole terminal footprint,
 * and the walkable surface indoors comes from the floor slab's collider, not
 * from the ground - `FirstPersonController` promotes it to `interior` when it
 * is standing on a built platform above the terrain. The slab is emitted here
 * as one non-solid collider covering the whole footprint.
 */

import { clamp } from '../../core/mathx';
import { createRng } from '../../core/rng';
import type { MaterialKey } from '../../render/materials';
import type { GeometrySink, InteractionPoint } from '../build/types';
import { TERMINAL, TERMINAL_FLOOR } from './layout';
import {
  BENCH_BACK_X,
  BENCH_BLOCK_Z,
  BENCH_RUN_LENGTH,
  CHECKIN_DESK_X,
  CHECKIN_DESK_Z,
  SEAT_PAD_HEIGHT,
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

/** Where the baggage hall is partitioned off, south of the gate lounge. */
const BAGGAGE_Z = 528;
/** Ceiling height in the concourse and in the double-height check-in hall. */
const CEIL = TERMINAL_EAVES - 1.1;
const HALL_CEIL = TERMINAL_HALL_EAVES - 1.4;

const F = TERMINAL_FLOOR;

/** Structural bay: columns at 11 m, which is what sets the room's rhythm. */
const BAY = 11;

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
// Shell lining
// ---------------------------------------------------------------------------

function buildFloorAndCeiling(batch: WorldBatch, sink: GeometrySink): void {
  // Floor slab. One non-solid collider over the whole footprint is what makes
  // the interior walkable and what the controller reads as `interior`.
  batch.box('tileFloor', INNER.minX, F - 0.08, INNER.minZ, INNER.maxX, F, INNER.maxZ);
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

  /*
   * Floor bands, laid across the building at the two moments that matter:
   * where the check-in hall becomes the security line, and where airside
   * becomes the baggage hall. A 190 m tiled floor with no incident in it reads
   * as a corridor; two bands turn it into three rooms.
   */
  for (const z of [SECURITY_Z, BAGGAGE_Z]) {
    batch.box('plazaStone', INNER.minX, F + 0.004, z - 1.1, INNER.maxX, F + 0.012, z + 1.1);
  }
  // A walking line down the middle of the concourse, in the same darker stone.
  batch.box('pavementDark', 175.4, F + 0.004, TERMINAL_HALL_Z, 176.6, F + 0.012, BAGGAGE_Z);

  // Ceiling: two planes at the two roof heights, with a coffer rhythm.
  batch.box('concrete', INNER.minX, F + HALL_CEIL, INNER.minZ, INNER.maxX, F + HALL_CEIL + 0.2, TERMINAL_HALL_Z);
  batch.box('concrete', INNER.minX, F + CEIL, TERMINAL_HALL_Z, INNER.maxX, F + CEIL + 0.2, INNER.maxZ);
  // The step between them, closed so the two ceilings do not float apart.
  batch.box('concreteBoard', INNER.minX, F + CEIL, TERMINAL_HALL_Z - 0.3, INNER.maxX, F + HALL_CEIL + 0.2, TERMINAL_HALL_Z);
}

/**
 * Columns and the beams they carry.
 *
 * Two rows at 11 m centres. In a room this size the structure is the only
 * thing that gives the eye a scale, and it is also what stops the 62 m span
 * reading as an impossible clear span.
 */
function buildStructure(batch: WorldBatch, sink: GeometrySink): void {
  const rows = [165, 199];
  for (const x of rows) {
    for (let z = INNER.minZ + 6; z < INNER.maxZ - 4; z += BAY) {
      const top = ceilingAt(z);
      fitting(batch, sink, 'concrete', x - 0.45, z - 0.45, x + 0.45, z + 0.45, F, top);
    }
    // Down-stand beam over the row.
    batch.box('concrete', x - 0.55, F + HALL_CEIL - 0.9, INNER.minZ, x + 0.55, F + HALL_CEIL, TERMINAL_HALL_Z);
    batch.box('concrete', x - 0.55, F + CEIL - 0.8, TERMINAL_HALL_Z, x + 0.55, F + CEIL, INNER.maxZ);
  }

  // Roof trusses across the check-in hall, which is where the extra height is
  // and therefore the only place structure is visible from the floor.
  for (let z = INNER.minZ + 5.5; z < TERMINAL_HALL_Z; z += BAY) {
    batch.box('metalDark', INNER.minX, F + HALL_CEIL - 0.55, z - 0.16, INNER.maxX, F + HALL_CEIL - 0.2, z + 0.16);
    for (let x = INNER.minX + 4; x < INNER.maxX - 4; x += 6) {
      batch.box('metalDark', x - 0.06, F + HALL_CEIL - 0.55, z - 0.06, x + 0.06, F + HALL_CEIL - 0.2, z + 0.06);
    }
  }
}

// ---------------------------------------------------------------------------
// Check-in hall
// ---------------------------------------------------------------------------

function buildCheckIn(batch: WorldBatch, sink: GeometrySink): void {
  const [deskMinX, deskMaxX] = CHECKIN_DESK_X;

  for (const z of CHECKIN_DESK_Z) {
    // Desk carcass and counter top. The queue anchors published in `plan.ts`
    // stand 0.8 m off the counter face, so nothing is built east of it.
    fitting(batch, sink, 'pavementDark', deskMinX, z - 4.5, deskMaxX, z + 4.5, F, F + 1.05);
    batch.box('metalLight', deskMinX, F + 1.05, z - 4.6, deskMaxX + 0.12, F + 1.11, z + 4.6);
    // Back-of-house screen behind the desks, with the belt opening in it.
    batch.box('concreteBoard', deskMinX - 0.1, F, z - 4.5, deskMinX, F + 2.6, z + 4.5);
    // Bag belt running back through the screen.
    batch.box('metalDark', deskMinX, F + 0.45, z - 0.7, deskMaxX - 0.6, F + 0.6, z + 0.7);
    // Desk number, hung over each position.
    batch.box('signEmissiveWarm', deskMinX + 1.2, F + 2.5, z - 0.5, deskMinX + 1.3, F + 3.1, z + 0.5);
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
      }
    }
  }
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
  const lanes = [166, 183, 200];
  const laneHalf = 1.6;
  const edges: number[] = [INNER.minX];
  for (const lane of lanes) edges.push(lane - laneHalf, lane + laneHalf);
  edges.push(INNER.maxX);

  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i] as number;
    const b = edges[i + 1] as number;
    if (b - a < 0.2) continue;
    fitting(batch, sink, 'concreteBoard', a, SECURITY_Z - 0.9, b, SECURITY_Z + 0.9, F, F + 2.6);
    batch.box('glass', a + 0.2, F + 2.6, SECURITY_Z - 0.06, b - 0.2, F + 4.2, SECURITY_Z + 0.06);
  }

  for (const lane of lanes) {
    // Archway frame round each lane, and the belt table beyond it.
    batch.box('metalLight', lane - laneHalf - 0.12, F, SECURITY_Z - 0.5, lane - laneHalf, F + 2.4, SECURITY_Z + 0.5);
    batch.box('metalLight', lane + laneHalf, F, SECURITY_Z - 0.5, lane + laneHalf + 0.12, F + 2.4, SECURITY_Z + 0.5);
    batch.box('metalLight', lane - laneHalf - 0.12, F + 2.4, SECURITY_Z - 0.5, lane + laneHalf + 0.12, F + 2.6, SECURITY_Z + 0.5);
    batch.box('signEmissive', lane - 0.5, F + 2.42, SECURITY_Z - 0.2, lane + 0.5, F + 2.5, SECURITY_Z + 0.2);
    // Tray table on the airside face.
    fitting(batch, sink, 'metalLight', lane - 1.2, SECURITY_Z + 1.4, lane + 1.2, SECURITY_Z + 3.6, F, F + 0.82);
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
      batch.box('metalLight', Math.min(inner, outer), padY, from, Math.max(inner, outer), padY + 0.06, to);
      // Frame legs at each end and mid-run.
      for (const t of [0.06, 0.5, 0.94]) {
        const z = from + (to - from) * t;
        batch.box('metalDark', Math.min(inner, outer) + 0.05, F, z - 0.04, Math.max(inner, outer) - 0.05, padY, z + 0.04);
      }
      // Armrests every four seats, which is what stops a bench reading as a
      // shelf and is also how a real one is divided.
      for (let k = 0; k <= 8; k += 4) {
        const z = from + 0.35 + k * 0.7;
        if (z > to) continue;
        batch.box('metalDark', Math.min(inner, outer), padY + 0.06, z - 0.03, Math.max(inner, outer), padY + 0.26, z + 0.03);
      }
    }
  }
}

/** Gate desks and the boarding-pass readers beside each airside door. */
function buildGates(batch: WorldBatch, sink: GeometrySink, doors: readonly TerminalDoor[]): void {
  for (const door of doors) {
    if (door.landside) continue;
    const z = door.along;
    fitting(batch, sink, 'pavementDark', 205, z - 1.6, 209, z + 1.6, F, F + 1.05);
    batch.box('metalLight', 204.9, F + 1.05, z - 1.7, 209.1, F + 1.11, z + 1.7);
    // Departure screen on a post beside the desk.
    batch.cylinder('metalDark', 204, z + 2.6, 0.05, 0.06, F, 1.9, 6);
    batch.box('signEmissive', 203.5, F + 1.9, z + 2.35, 204.5, F + 2.5, z + 2.85);
    // Gate barrier: a low run either side of the door so the opening reads as
    // a controlled one rather than a hole in the wall.
    for (const side of [-1, 1] as const) {
      batch.box('metalLight', 210.5, F, z + side * 2.4, 213.4, F + 1.0, z + side * 2.5);
    }
  }
}

/** Retail: three units backing onto the east wall between the gates. */
function buildShops(batch: WorldBatch, sink: GeometrySink): void {
  const rng = createRng('meridian-terminal-retail');
  const units: readonly [number, number][] = [
    [436, 448],
    [462, 476],
    [494, 508],
  ];
  for (const [from, to] of units) {
    // Shell: back against the east structural row, open to the concourse.
    fitting(batch, sink, 'stuccoCream', 196, from, 208, from + 0.2, F, F + 3.4);
    fitting(batch, sink, 'stuccoCream', 196, to - 0.2, 208, to, F, F + 3.4);
    fitting(batch, sink, 'stuccoCream', 207.8, from, 208, to, F, F + 3.4);
    batch.box('signEmissiveWarm', 196.2, F + 3.0, from + 0.3, 196.4, F + 3.35, to - 0.3);
    // Counter across the front, and shelving on the back wall.
    fitting(batch, sink, 'timberDark', 196, from + 1.2, 197.1, to - 1.2, F, F + 1.02);
    for (let y = 0.5; y < 2.4; y += 0.62) {
      batch.box('timber', 206.6, F + y, from + 0.4, 207.8, F + y + 0.05, to - 0.4);
      for (let z = from + 0.8; z < to - 0.8; z += 0.55) {
        const w = rng.range(0.16, 0.3);
        const h = rng.range(0.14, 0.32);
        batch.box(rng.chance(0.5) ? 'canvasAwning' : 'stuccoRose', 206.9 - w / 2, F + y + 0.05, z - 0.16, 206.9 + w / 2, F + y + 0.05 + h, z + 0.16);
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
  }
  batch.box('signEmissiveWarm', 172, F + 2.6, BAGGAGE_Z - 0.3, 190, F + 3.1, BAGGAGE_Z - 0.15);

  for (const z of [534, 540]) {
    // Belt island: a low kerb with the sloped belt above it.
    fitting(batch, sink, 'metalLight', 160, z - 1.5, 206, z + 1.5, F, F + 0.55);
    batch.box('metalDark', 159.6, F + 0.55, z - 1.7, 206.4, F + 0.75, z + 1.7);
    // Hood over the feed end, where the bags come through the wall.
    batch.box('concreteBoard', 204, F, z - 2.2, INNER.maxX, F + 2.6, z + 2.2);
  }
  // Trolley bay against the west wall.
  for (let z = BAGGAGE_Z + 3; z < BAGGAGE_Z + 9; z += 1.1) {
    batch.box('metalLight', INNER.minX + 0.4, F, z, INNER.minX + 1.4, F + 1.0, z + 0.5);
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
 */
function buildSignage(batch: WorldBatch): void {
  const hang = (z: number, halfWidth: number, colour: MaterialKey): void => {
    const top = ceilingAt(z) - 0.35;
    batch.box('metalDark', 183 - halfWidth, top - 0.06, z - 0.09, 183 + halfWidth, top, z + 0.09);
    batch.box(colour, 183 - halfWidth, top - 1.05, z - 0.07, 183 + halfWidth, top - 0.1, z + 0.07);
    for (const t of [-0.8, 0.8]) {
      batch.cylinder('metalDark', 183 + halfWidth * t, z, 0.02, 0.02, top, ceilingAt(z) - top, 5);
    }
  };
  hang(TERMINAL.minZ + 14, 5.5, 'signEmissiveWarm');
  hang(SECURITY_Z - 12, 6.5, 'signEmissive');
  hang(SECURITY_Z + 10, 6.5, 'signEmissiveWarm');
  hang(BAGGAGE_Z - 10, 5.5, 'signEmissiveWarm');

  // Flight information board, free-standing across the hall's south end.
  batch.box('metalDark', 175, F, 414.4, 191, F + 0.25, 415.6);
  batch.box('metalDark', 175, F + 0.25, 414.7, 191, F + 3.4, 415.3);
  batch.box('signEmissive', 175.4, F + 0.55, 414.6, 190.6, F + 3.2, 414.68);
}

/**
 * Light.
 *
 * Emissive ceiling panels first, because they cannot be dropped: the renderer
 * ranks `LightRequest`s against a budget and a 190 m building would swallow it
 * whole. The requests that follow are a top-up for the four places the player
 * actually stops - the entrance, check-in, security and the gates - and they
 * are priority 2, below the city's street lamps.
 */
function buildLighting(batch: WorldBatch, sink: GeometrySink): void {
  for (let z = INNER.minZ + 4; z < INNER.maxZ - 2; z += 5.5) {
    const y = ceilingAt(z) - 0.06;
    for (const x of [163, 183, 203]) {
      batch.box('lampGlass', x - 3.2, y, z - 0.28, x + 3.2, y + 0.05, z + 0.28);
    }
  }

  const lamp = (x: number, z: number): void => {
    sink.light({
      x,
      y: ceilingAt(z) - 1.2,
      z,
      color: 0xffe9c9,
      intensity: 1.5,
      distance: 22,
      priority: 2,
    });
  };
  lamp(183, TERMINAL.minZ + 10);
  lamp(166, 380);
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

// ---------------------------------------------------------------------------

/** Builds the whole terminal interior. */
export function buildTerminalInterior(sink: GeometrySink): void {
  const batch = new WorldBatch();
  buildFloorAndCeiling(batch, sink);
  buildStructure(batch, sink);
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
  readonly model: 'checkin-desk' | 'scanner' | 'flight-board' | 'trolley' | 'gate-seats';
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
  for (const lane of [166, 183, 200]) {
    out.push({ model: 'scanner', x: lane, y: F, z: SECURITY_Z + 0.2, heading: Math.PI });
  }
  out.push({ model: 'flight-board', x: 183, y: F, z: 415, heading: 0 });
  for (let k = 0; k < 6; k += 1) {
    out.push({
      model: 'trolley',
      x: clamp(157.5 + (k % 2) * 1.1, INNER.minX, INNER.maxX),
      y: F,
      z: 404 + k * 1.15,
      heading: -Math.PI / 2,
    });
  }
  // Extra benches against the east structural row, between the shop units.
  for (const z of [456, 486]) {
    out.push({ model: 'gate-seats', x: 199.5, y: F, z, heading: Math.PI / 2 });
  }
  return out;
}
