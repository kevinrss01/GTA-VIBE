/**
 * Meridian Bay Regional, derived.
 *
 * `layout.ts` is the survey: where the runway, the apron and the terminal are.
 * This module is everything that follows from it and that BOTH the ground
 * sampler and the geometry builder have to agree about - which square metres
 * are concrete, which are tarmac, which are mown grass, and where the fence
 * runs. Keeping it here rather than in the builder is what stops the surface
 * the player hears underfoot from drifting away from the surface they can see,
 * which is the defect this workstream was asked to fix in the city.
 *
 * Nothing here imports Three.js.
 */

import {
  AIRFIELD,
  APRON,
  CAR_PARK,
  CAUSEWAY,
  FORECOURT,
  HANGARS,
  RUNWAY,
  TERMINAL,
  TOWER,
  inRect,
  isOnRunway,
  isOnTaxiway,
  type AirportRect,
} from './layout';

/**
 * The whole airport site: the graded platform plus the causeway strip that
 * carries the landside roads west of it. Grass inside here is mown airfield
 * grass, not the outskirt scrub.
 */
export function inAirportSite(x: number, z: number): boolean {
  return (
    inRect(AIRFIELD, x, z) ||
    (x >= CAUSEWAY.minX && x <= CAUSEWAY.maxX && z >= CAUSEWAY.minZ && z <= CAUSEWAY.maxZ)
  );
}

/**
 * Hardstanding at the south end: the tower, both hangars and the ground that
 * links them to the taxiway.
 *
 * One slab rather than a pad per building. Real maintenance areas are paved
 * across, aircraft are towed over the whole of it, and three separate pads with
 * grass between them would have read as three sheds in a field.
 */
export const SOUTH_APRON: AirportRect = { minX: 190, maxX: 266, minZ: 646, maxZ: 840 };

/** Ground the terminal itself stands on, carried a little past its walls. */
export const TERMINAL_PAD: AirportRect = {
  minX: TERMINAL.minX - 4,
  // Carried the extra metre east so it meets the apron at 215 rather than
  // leaving a one-metre ribbon of grass between the gates and the aircraft.
  maxX: APRON.minX,
  minZ: TERMINAL.minZ - 5,
  maxZ: TERMINAL.maxZ + 5,
};

/** Concrete: every airside movement area. */
export function isAirsideConcrete(x: number, z: number): boolean {
  return (
    isOnRunway(x, z) ||
    isOnTaxiway(x, z) ||
    inRect(APRON, x, z) ||
    inRect(SOUTH_APRON, x, z) ||
    inRect(TERMINAL_PAD, x, z)
  );
}

/**
 * The surface underfoot anywhere on the airport site, or null off it.
 *
 * Street corridors are resolved BEFORE this by `CityGround.sample`, so the
 * landside roads and their pavements are not this function's business; what is
 * left is the movement areas, the forecourt, the car park and the grass.
 */
export type AirportSurface = 'concrete' | 'asphalt' | 'pavement' | 'grass';

export function airportSurfaceAt(x: number, z: number): AirportSurface | null {
  if (!inAirportSite(x, z)) return null;
  if (isAirsideConcrete(x, z)) return 'concrete';
  // The forecourt is a paved pedestrian plaza; the car park is tarmac.
  if (inRect(FORECOURT, x, z)) return 'pavement';
  if (inRect(CAR_PARK, x, z)) return 'asphalt';
  return 'grass';
}

// ---------------------------------------------------------------------------
// Perimeter
// ---------------------------------------------------------------------------

/**
 * The airside boundary.
 *
 * Not the platform edge: the terminal, the forecourt and the car park are
 * landside, so the fence runs down the west side of the apron, round the back
 * of the terminal and out along the platform. Expressed as a closed polyline in
 * plan, walked by the builder to emit posts and mesh.
 *
 * The gap in the west run between z = 355 and 545 is the terminal itself - a
 * terminal IS the fence there, which is exactly why an airport has one.
 */
export interface FenceRun {
  readonly fromX: number;
  readonly fromZ: number;
  readonly toX: number;
  readonly toZ: number;
  /** A vehicle gate at this fraction along the run, or null. */
  readonly gate: number | null;
}

/**
 * The airside boundary, as a closed polyline in plan.
 *
 * It is the LANDSIDE/AIRSIDE line, not the platform edge. The forecourt, the
 * terminal, the car park and every road are public; the apron, the taxiway, the
 * runway and the maintenance area are not. The terminal itself carries the
 * boundary for the 190 m it spans - which is exactly what a terminal is for -
 * so the fence stops at its north wall and starts again at its south.
 */
export interface FenceRun {
  readonly fromX: number;
  readonly fromZ: number;
  readonly toX: number;
  readonly toZ: number;
  /** A vehicle gate at this fraction along the run, or null. */
  readonly gate: number | null;
}

/** Half a metre outside the terminal's east wall, clear of the apron at 215. */
const FENCE_EAST_OF_TERMINAL = 214.5;
/** Two metres east of Car Park Road's corridor, west of the south apron. */
const FENCE_WEST_OF_APRON = 190;

export const FENCE_RUNS: readonly FenceRun[] = [
  // North boundary of the airfield.
  { fromX: FENCE_EAST_OF_TERMINAL, fromZ: 206, toX: 424, toZ: 206, gate: null },
  // East boundary, the full length of the platform.
  { fromX: 424, fromZ: 206, toX: 424, toZ: 944, gate: null },
  // South boundary.
  { fromX: 424, fromZ: 944, toX: FENCE_WEST_OF_APRON, toZ: 944, gate: null },
  // West boundary of the maintenance area, up past the hangars.
  { fromX: FENCE_WEST_OF_APRON, fromZ: 944, toX: FENCE_WEST_OF_APRON, toZ: 640, gate: 0.62 },
  // East across the back of the car park to the apron line.
  { fromX: FENCE_WEST_OF_APRON, fromZ: 640, toX: FENCE_EAST_OF_TERMINAL, toZ: 640, gate: null },
  // North up the apron line to the terminal's south wall.
  { fromX: FENCE_EAST_OF_TERMINAL, fromZ: 640, toX: FENCE_EAST_OF_TERMINAL, toZ: TERMINAL.maxZ, gate: null },
  // The terminal itself is the boundary from z = 545 to 355.
  // North again from its north wall, with the airside vehicle gate off the
  // forecourt.
  { fromX: FENCE_EAST_OF_TERMINAL, fromZ: TERMINAL.minZ, toX: FENCE_EAST_OF_TERMINAL, toZ: 206, gate: 0.4 },
];

// ---------------------------------------------------------------------------
// Terminal fit-out anchors
//
// Published for the traveller crowd, which places seated figures and queues
// against them. Both are pure data with no Three.js in sight, which is why
// they live here rather than in the terminal builder: the crowd reads them,
// the builder builds to them, and neither can drift.
// ---------------------------------------------------------------------------

/**
 * Height of the gate bench's seat pad above the platform.
 *
 * Measured by the traveller workstream from the seated figures: 0.364 m is
 * where their thighs are, so a pad at exactly this height leaves nobody
 * floating and nobody sunk into the bench. The builder is held to it.
 */
export const SEAT_PAD_HEIGHT = 0.364;

/** Seat pitch along a bench. The wide leaning pose needs at least 0.62 m. */
export const SEAT_PITCH = 0.7;

/** One seat. `heading` is the direction the SITTER faces. */
export interface SeatAnchor {
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  readonly y?: number;
}

/** Head of a queue. `heading` is the direction the queue faces. */
export interface QueueAnchor {
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  readonly slots?: number;
}

/**
 * Where the gate lounge's benches are.
 *
 * Three blocks of back-to-back benches down the middle of the lounge, so every
 * seat has a bench back behind it - which matters for more than looks, because
 * one of the seated models carries a residual seat stub 0.38 m behind its
 * origin that is only hidden against a back.
 *
 * Sitters' toes reach 0.80 m in front of the pad, so a block occupies x 178.3
 * to 181.7. The lounge's two circulation aisles run at x = 165 and x = 200 and
 * are untouched.
 */
const BENCH_BACK_X = 180;
const BENCH_BLOCK_Z: readonly number[] = [446, 472, 498];
const SEATS_PER_BENCH = 8;

export const GATE_SEATS: readonly SeatAnchor[] = (() => {
  const out: SeatAnchor[] = [];
  for (const z0 of BENCH_BLOCK_Z) {
    for (const side of [-1, 1] as const) {
      for (let k = 0; k < SEATS_PER_BENCH; k += 1) {
        out.push({
          x: BENCH_BACK_X + side * 0.9,
          z: z0 + k * SEAT_PITCH,
          // Forward is (-sin yaw, 0, -cos yaw): +PI/2 faces west, -PI/2 east.
          heading: side < 0 ? Math.PI / 2 : -Math.PI / 2,
        });
      }
    }
  }
  return out;
})();

/** Length of one bench block along z, for the builder. */
export const BENCH_RUN_LENGTH = (SEATS_PER_BENCH - 1) * SEAT_PITCH + 0.7;
export { BENCH_BACK_X, BENCH_BLOCK_Z };

/**
 * Check-in desk faces, on the hall's west wall, and the security line.
 *
 * A queue anchor is where the person at the HEAD stands: 0.8 m in front of the
 * desk face, with the line running backwards from there at 0.92 m pitch, so
 * each one needs about seven clear metres behind it. Both check-in queues run
 * east into the hall and the security queue runs north up it; nothing else is
 * placed in either band.
 */
export const CHECKIN_DESK_X: readonly [number, number] = [156, 160];
export const CHECKIN_DESK_Z: readonly number[] = [368, 380, 392];
export const SECURITY_Z = 428;

export const TERMINAL_QUEUES: readonly QueueAnchor[] = [
  { x: CHECKIN_DESK_X[1] + 0.8, z: 372, heading: Math.PI / 2, slots: 8 },
  { x: CHECKIN_DESK_X[1] + 0.8, z: 388, heading: Math.PI / 2, slots: 8 },
  // Security: the head stands 1.5 m short of the scanners, facing south down
  // the terminal, and the line runs back north into the check-in hall.
  { x: 176, z: SECURITY_Z - 1.5, heading: Math.PI, slots: 8 },
];

// ---------------------------------------------------------------------------
// Car park
// ---------------------------------------------------------------------------

/** One row of parking bays, with the aisle it is reached from. */
export interface ParkingRow {
  readonly z: number;
  readonly fromX: number;
  readonly toX: number;
}

export const BAY_WIDTH = 2.6;
export const BAY_DEPTH = 5.0;

/**
 * Bays laid in pairs back to back with a 6 m aisle between pairs, which is the
 * standard 90-degree layout: 2.6 by 5.0 m bays, 16 m module.
 *
 * `car-park-road` runs down the west side at x = 160 with its corridor out to
 * 168, so the bays start at 170.
 */
export const PARKING_ROWS: readonly ParkingRow[] = (() => {
  const rows: ParkingRow[] = [];
  for (let z = CAR_PARK.minZ + 5; z + BAY_DEPTH * 2 <= CAR_PARK.maxZ - 4; z += 16) {
    rows.push({ z, fromX: 170, toX: CAR_PARK.maxX - 4 });
    rows.push({ z: z + BAY_DEPTH, fromX: 170, toX: CAR_PARK.maxX - 4 });
  }
  return rows;
})();

// ---------------------------------------------------------------------------
// Runway marking geometry
// ---------------------------------------------------------------------------

/**
 * ICAO Annex 14 / FAA AC 150/5340-1 marking dimensions, in metres.
 *
 * These are real numbers, scaled only where the runway itself is: this is a
 * 45 m runway, so it takes the 12-stripe threshold pattern and the full-width
 * touchdown zone, but the 600 m length means only ONE touchdown-zone pair and
 * ONE aiming point fit between the threshold and the midpoint. A 600 m runway
 * would not carry a touchdown zone at all in the real world; it is here because
 * it is the marking that tells a pilot where to put the wheels, and without it
 * the runway reads as a road.
 */
export const MARKINGS = {
  /** Threshold bars: 30 m long, 1.8 m wide, 1.8 m apart, 3 m in from the edge. */
  thresholdBarLength: 30,
  thresholdBarWidth: 1.8,
  thresholdBarGap: 1.8,
  thresholdInset: 3,
  /** How far the threshold bars start beyond the threshold line. */
  thresholdStandoff: 6,
  /** Centreline: 30 m stripe, 20 m gap, 0.9 m wide. */
  centrelineStripe: 30,
  centrelineGap: 20,
  centrelineWidth: 0.9,
  /** Touchdown zone: pairs of 22.5 by 3 m bars, 75 m from the threshold. */
  touchdownLength: 22.5,
  touchdownWidth: 3,
  touchdownOffset: 75,
  /** Gap between the two bars of a touchdown pair, measured centre to centre. */
  touchdownSpacing: 3.6,
  /** Aiming point: 45 by 6 m bars 22.5 m either side of the centreline. */
  aimingLength: 45,
  aimingWidth: 6,
  aimingOffset: 150,
  aimingSpacing: 10.5,
  /** Runway edge stripes: 0.9 m wide, 0.6 m in from the pavement edge. */
  edgeWidth: 0.9,
  edgeInset: 0.6,
  /** Designator numerals sit 20 m in from the threshold and are 12 m tall. */
  designatorHeight: 12,
  /**
   * Centre of the numerals, measured from the threshold. Past the 30 m
   * threshold bars, which start 6 m in and end at 36 m.
   */
  designatorOffset: 52,
  /** Taxiway centreline: continuous, 0.15 m wide. */
  taxiCentreWidth: 0.15,
  /** Holding position: two solid, two dashed, 0.3 m wide, 0.3 m apart. */
  holdLineWidth: 0.3,
  holdLineGap: 0.3,
  /** Stand lead-in line width. */
  leadInWidth: 0.15,
} as const;

/** Centre of the runway, used for the minimap marker and for labels. */
export const RUNWAY_CENTRE = {
  x: RUNWAY.centreX,
  z: (RUNWAY.northZ + RUNWAY.southZ) / 2,
} as const;

/** Where the taxiway links meet the runway; a holding position sits at each. */
export function holdingPositionX(): number {
  return RUNWAY.centreX - RUNWAY.halfWidth - 30;
}

/** The tower's pad centre, for the minimap and the interaction prompt. */
export const TOWER_CENTRE = { x: TOWER.x, z: TOWER.z } as const;

/** Bounding rect of everything the airport occupies, for the map. */
export const AIRPORT_EXTENT: AirportRect = {
  minX: Math.min(AIRFIELD.minX, CAUSEWAY.minX) - 8,
  maxX: AIRFIELD.maxX + 8,
  minZ: AIRFIELD.minZ - 8,
  maxZ: AIRFIELD.maxZ + 8,
};

/** Hangar door openings face the taxiway, on the east elevation. */
export function hangarDoorRect(hangar: AirportRect): AirportRect {
  const centreZ = (hangar.minZ + hangar.maxZ) / 2;
  const half = (hangar.maxZ - hangar.minZ) * 0.36;
  return { minX: hangar.maxX - 0.4, maxX: hangar.maxX + 0.4, minZ: centreZ - half, maxZ: centreZ + half };
}

export { HANGARS };
