/**
 * Meridian Bay Regional - the survey drawing.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   import { AIRPORT, RUNWAY, isOnPavedAirfield } from './world/airport/layout';
 *
 * Every module that needs to know WHERE the airport is reads it from here and
 * nowhere else: the geometry builder, the ground sampler, the flight model,
 * the traveller crowd, the mission and the minimap. Nothing in this file
 * imports Three.js, so it can be read by a unit test, by the deterministic
 * simulation and by the renderer alike.
 *
 * ============================================================================
 *
 * ## Why the runway points north-south
 *
 * Meridian Bay's terrain is a ramp. `mainProfile(x)` climbs from 1.6 m at the
 * western shore to 18.4 m past the eastern outskirts, while `minorProfile(z)`
 * moves by less than a metre over the whole map. Measured across the airfield
 * site: 16.5 m of rise east-west over 760 m, against 0.4 m north-south over
 * 210 m - a 0.19 per cent grade, which is inside ICAO's 1 per cent limit for a
 * runway without touching the terrain at all.
 *
 * So the runway lies along z. Turning it 90 degrees would have meant either an
 * 8 m cut at one threshold and an 8 m fill at the other, or a runway on a
 * 2.2 per cent slope. This is also why real airfields are sited before they
 * are designed.
 *
 * The apron and the terminal still cross the ramp, which is what
 * `AIRFIELD_LEVEL` is for: a graded platform, cut about 3 m into the east side
 * and filled about 3 m on the west, with an embankment skirt blending back to
 * open ground. That is a normal earthwork, and small enough to read as one.
 *
 * ## Units and conventions
 *
 * Metres, and the game's own heading convention: forward is
 * `(-sin yaw, 0, -cos yaw)`, so yaw 0 faces -Z (north) and yaw PI faces +Z
 * (south). The airport is SOUTH of the city, which ends at z = 186.
 */

/** A plan-view rectangle. Matches the city's own `Rect`. */
export interface AirportRect {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * The finished level of every paved airside surface, in metres.
 *
 * Natural ground across the platform runs from about 11.5 m on the west edge
 * to about 17.4 m on the east. Sitting the platform at 14.5 m splits that
 * almost exactly - under 3 m of cut and under 3 m of fill - which is the
 * smallest earthwork that still gives a level runway, apron and terminal
 * floor. Change this and the embankment gets visibly steeper on one side.
 */
export const AIRFIELD_LEVEL = 14.5;

/**
 * How far the platform blends back into natural ground.
 *
 * 3 m of level change over 46 m is a 6.5 per cent bank - mowable grass, which
 * is what an airfield embankment actually is. Shorter reads as a wall; longer
 * starts eating into the terrain the city's own tests sweep for walkable grade.
 */
export const AIRFIELD_SKIRT = 46;

/** The graded platform. Everything paved is inside this. */
export const AIRFIELD: AirportRect = { minX: 150, maxX: 430, minZ: 200, maxZ: 950 };

/**
 * The runway.
 *
 * 600 m by 45 m. Short by airline standards and deliberately so: it is a
 * regional field, and 600 m is a real length - Courchevel is 537 m and takes
 * twin turboprops. It is sized so the light single and the twin get airborne
 * with room to spare and the business jet has to fly it properly.
 *
 * Designated 18/36 because it lies within a few degrees of true north-south.
 * Landing on 18 means flying south, which is `yaw = PI`.
 */
export const RUNWAY = {
  /** Centreline, constant x. */
  centreX: 340,
  halfWidth: 22.5,
  /** North threshold: the 18 end, where a southbound aircraft touches down. */
  northZ: 280,
  /** South threshold: the 36 end. */
  southZ: 880,
  /** Paved blast pad / stopway beyond each threshold. */
  overrun: 60,
  elevation: AIRFIELD_LEVEL,
  /** Heading flown when taking off toward the south threshold. */
  headingSouth: Math.PI,
  /** Heading flown when taking off toward the north threshold. */
  headingNorth: 0,
} as const;

/** 600 m between the thresholds. */
export const RUNWAY_LENGTH = RUNWAY.southZ - RUNWAY.northZ;

/**
 * The parallel taxiway, west of the runway.
 *
 * 65 m between centrelines. Real separation for a code-2 field is 87 m, but
 * the platform is only 280 m wide and the apron and terminal have to fit on
 * it as well; 65 m still clears the widest wingspan here by a wide margin.
 */
export const TAXIWAY = {
  centreX: 275,
  halfWidth: 9,
  fromZ: 280,
  toZ: 880,
} as const;

/**
 * Where the taxiway meets the runway. Two ends and one mid-field entry, which
 * is what lets an aircraft that lands long taxi off without backtracking.
 */
export const TAXIWAY_LINKS: readonly number[] = [300, 580, 860];

/** Aircraft parking, in front of the terminal. */
export const APRON: AirportRect = { minX: 215, maxX: 266, minZ: 300, maxZ: 620 };

/**
 * The terminal building.
 *
 * Long and thin, parallel to the apron, the way a pier terminal is: landside
 * doors on the west elevation, gates on the east. 62 m by 190 m.
 */
export const TERMINAL: AirportRect = { minX: 152, maxX: 214, minZ: 355, maxZ: 545 };

/** Interior floor level: one step above the platform, like every city plinth. */
export const TERMINAL_FLOOR = AIRFIELD_LEVEL + 0.16;

/** The control tower: a small footprint and a lot of height, sited to see both. */
export const TOWER = { x: 232, z: 660, halfX: 6.5, halfZ: 6.5, height: 27 } as const;

/** Maintenance hangars, south of the apron along the taxiway. */
export const HANGARS: readonly AirportRect[] = [
  { minX: 196, maxX: 254, minZ: 680, maxZ: 736 },
  { minX: 196, maxX: 254, minZ: 748, maxZ: 804 },
];

/** Landside: the forecourt, the car park and the road that arrives. */
export const FORECOURT: AirportRect = { minX: 158, maxX: 214, minZ: 250, maxZ: 350 };
export const CAR_PARK: AirportRect = { minX: 152, maxX: 214, minZ: 560, maxZ: 640 };

/**
 * Aircraft stands.
 *
 * `heading` is the direction the aircraft's NOSE points while parked, in the
 * game's convention. Everything on the apron noses east toward the runway, so
 * that pushing back onto the taxiway is a straight reverse.
 */
export interface Stand {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  /** The largest aircraft class this stand takes. */
  readonly size: 'light' | 'medium' | 'heavy';
}

/**
 * An aeroplane parked ON the runway, lined up and ready to go.
 *
 * Every stand is at x = 240 facing east; the runway is at x = 340 running
 * north-south. So an aircraft taken from a stand and given full power rolls
 * ACROSS the runway and off the far side - to fly it you first have to taxi
 * 100 m east and turn ninety degrees, on nose-wheel steering, before you have
 * even started the take-off roll. That was reported as simply not being able
 * to fly, and it is a fair description: nothing about the aeroplane tells you
 * any of it.
 *
 * This is the fix that needs no instructions. It sits on the northern
 * threshold pointing down the full 600 m of runway, so boarding it and opening
 * the throttle is a take-off. `heading` is `Math.PI` because the game's forward
 * is `(-sin yaw, 0, -cos yaw)`, which at PI is +Z - the direction of the far
 * threshold.
 */
export const RUNWAY_READY = {
  id: 'runway-ready',
  x: RUNWAY.centreX,
  /*
   * On the paved overrun BEFORE the threshold, not on the runway itself.
   * Lined up with the full 600 m ahead of it, and off the surface anything
   * lands on - an aeroplane parked on the touchdown zone is a hazard, and the
   * blast pad is where one waits in the real thing too.
   */
  z: RUNWAY.northZ - 30,
  heading: Math.PI,
} as const;

export const STANDS: readonly Stand[] = [
  { id: 'stand-1', x: 240, z: 336, heading: -Math.PI / 2, size: 'heavy' },
  { id: 'stand-2', x: 240, z: 404, heading: -Math.PI / 2, size: 'medium' },
  { id: 'stand-3', x: 240, z: 464, heading: -Math.PI / 2, size: 'medium' },
  { id: 'stand-4', x: 240, z: 520, heading: -Math.PI / 2, size: 'light' },
  { id: 'stand-5', x: 240, z: 570, heading: -Math.PI / 2, size: 'light' },
];

/**
 * The road in from the city.
 *
 * The city grid stops at z = 132 and x = 164. Airport Approach runs south from
 * there to the forecourt; Airport Way runs east-west across the front of the
 * terminal. Both are authored as ordinary `Street` records so the traffic
 * simulation, the pavement graph, the signal heads and the minimap pick them
 * up with no special case - see `RoadNetwork`, which derives everything from
 * `plan.streets`.
 */
export const AIRPORT_STREETS = {
  /*
   * MOVED from x = 132, z 100 to 300 during the build, and the reason is a
   * collision the survey could not see from the plan.
   *
   * A street's CORRIDOR is `roadHalf + sidewalk` either side, and
   * `buildIntersections` draws the junction of two crossing streets over both
   * of their full corridors. Ridge Road sits at x = 118 with a 10.5 m corridor,
   * so it occupies out to x = 128.5, and this road's own corridor at x = 132
   * reached back to 121.8. Where both meet South Circuit their junction
   * footprints overlapped by 6.7 m over the full 22 m depth of the junction:
   * two coplanar asphalt surfaces, drawn twice, z-fighting.
   *
   * x = 141 threads the 24.5 m gap between Ridge Road's corridor and East
   * Circuit's, clearing each by about 2 m. `from` moves to South Circuit's own
   * centreline so the T-junction is drawn once, by `buildIntersections`, rather
   * than half-drawn by a road that started 32 m north of it.
   *
   * The ENDS of both roads moved for a second reason, measured in the traffic
   * simulation rather than in the geometry. Every street in Meridian Bay begins
   * and ends on another street's centreline; `tests/traffic.test.ts` requires
   * every lane to have a continuation that is not a U-turn, and a road that
   * runs 38 m past its last junction leaves the lane at its tip with nowhere
   * to go. Airport Approach used to stop at z = 300, 38 m past Airport Way,
   * and Airport Way ran from x = 96 to 300 - a 45 m stub into open ground at
   * one end and a 100 m stub across the airfield at the other, which put an
   * access road pointing at the runway. Both now run junction to junction.
   *
   * Airport Approach runs the length of the landside strip rather than being
   * split in two at Airport Way, because two collinear streets meeting AT a
   * crossing produce two junction records with identical footprints, drawn
   * twice into the same plane. Cooper Street can be split either side of
   * Lantern Park precisely because its two halves end on DIFFERENT streets.
   */
  approach: { position: 141, from: 132, to: 700, roadHalf: 7.2, sidewalk: 3.0 },
  way: { position: 262, from: 141, to: 200, roadHalf: 6.4, sidewalk: 3.2 },
} as const;

/** Paved airside surfaces, for the ground sampler and the footstep mixer. */
export function isOnRunway(x: number, z: number): boolean {
  return (
    Math.abs(x - RUNWAY.centreX) <= RUNWAY.halfWidth &&
    z >= RUNWAY.northZ - RUNWAY.overrun &&
    z <= RUNWAY.southZ + RUNWAY.overrun
  );
}

export function isOnTaxiway(x: number, z: number): boolean {
  if (Math.abs(x - TAXIWAY.centreX) <= TAXIWAY.halfWidth && z >= TAXIWAY.fromZ && z <= TAXIWAY.toZ) {
    return true;
  }
  // The links across to the runway, which are taxiway too.
  for (const z0 of TAXIWAY_LINKS) {
    if (
      Math.abs(z - z0) <= TAXIWAY.halfWidth &&
      x >= TAXIWAY.centreX &&
      x <= RUNWAY.centreX + RUNWAY.halfWidth
    ) {
      return true;
    }
  }
  return false;
}

export function inRect(rect: AirportRect, x: number, z: number, grow = 0): boolean {
  return (
    x >= rect.minX - grow && x <= rect.maxX + grow && z >= rect.minZ - grow && z <= rect.maxZ + grow
  );
}

/** Any paved airside surface: runway, taxiway or apron. Concrete underfoot. */
export function isOnPavedAirfield(x: number, z: number): boolean {
  return isOnRunway(x, z) || isOnTaxiway(x, z) || inRect(APRON, x, z);
}

/**
 * How much the airfield platform overrides natural terrain at a point.
 *
 * 1 inside the platform, easing to 0 across `AIRFIELD_SKIRT` outside it. The
 * caller blends `AIRFIELD_LEVEL` against `landElevation` by this weight, which
 * is what makes the platform level without tearing the ground at its edge.
 *
 * Returns 0 well away from the airport, so the city's terrain is untouched -
 * and it is the ONLY route by which this module can affect existing ground.
 */
export function airfieldWeight(x: number, z: number): number {
  const dx = Math.max(AIRFIELD.minX - x, 0, x - AIRFIELD.maxX);
  const dz = Math.max(AIRFIELD.minZ - z, 0, z - AIRFIELD.maxZ);
  const d = Math.hypot(dx, dz);
  if (d <= 0) return 1;
  if (d >= AIRFIELD_SKIRT) return 0;
  const t = 1 - d / AIRFIELD_SKIRT;
  // Smoothstep, so the join has no crease at either end of the skirt.
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// The approach causeway
//
// ADDED after the original survey. `airfieldWeight` alone puts Airport Approach
// on the SIDE of the platform embankment: it runs north-south at x = 132,
// parallel to the platform's west edge at x = 150, so the skirt's gradient
// crosses the carriageway instead of running along it. Measured, the
// platform-only blend gives that road a 13.0 per cent CROSS-fall - a road lying
// on its side, and more than three times what `tests/cityPlan.test.ts` allows
// any carriageway in Meridian Bay.
//
// Lengthening `AIRFIELD_SKIRT` cannot fix it: about 4 m of fill over a 46 m
// skirt is already a 13 per cent maximum slope, and flattening that to 4 per
// cent needs a 158 m skirt, which would reach x = -8 and regrade the city.
//
// So the road is carried on a causeway: LEVEL ACROSS ITS WIDTH, with a bank
// filled out on the low side. It adds no grade of its own - its finished level
// is the platform-blended ground read along one fixed line - so the road still
// follows the site, it just no longer leans.
//
// WHICH line is the one real decision here, and it was measured. Reading the
// level on the road's own centreline leaves the corridor 1.4 m proud of the
// ground at its west kerb and 1.2 m below it at the east kerb, and Airport Way
// crosses that corridor at right angles: it then has to climb 3 m in the 17 m
// between the shoulder and the junction, a 31 per cent ramp. Reading it on
// `AIRFIELD.minX` instead makes the causeway a 30 m widening of the platform
// itself, at exactly `AIRFIELD_LEVEL` and flush with it, and every landside
// road on it is then dead level in both directions.
//
// That widening is also what makes a landside road network possible at all.
// The survey leaves 2 m between the platform edge at x = 150 and the terminal's
// west wall at 152, and the apron is hard against its east wall, so there is no
// route from the forecourt at the terminal's north end to the car park at its
// south end anywhere inside `AIRFIELD`. The spine has to run west of the
// platform, and a spine west of the platform has to be carried.
//
// The skirts are anisotropic for the same reason a real embankment is. West is
// the fill face, and it is long because Airport Way climbs it: measured at
// 26 m the way peaks at 27 per cent, at 40 m 17.8, at 46 m 15.8 and at 55 m
// 12.9 - which is where it stops being worth more earthwork, because 12.6 per
// cent is what the platform's own north face already costs Airport Approach.
// East is the top of the bank and gets 10 m, which keeps the causeway clear of
// the forecourt at x = 158; the ends taper over 20 m, which stops the north toe
// at z = 150, seven metres clear of South Circuit's outer pavement.
// ---------------------------------------------------------------------------

/**
 * Footprint of the graded causeway carrying Airport Approach onto the platform.
 *
 * Wider than the road corridor (x 121.8 to 142.2) so the whole corridor sits at
 * weight 1 with a margin either side.
 */
export const CAUSEWAY = {
  minX: 120,
  maxX: 152,
  minZ: 170,
  maxZ: 700,
  /** Fill face, on the low side. Airport Way climbs it - see above. */
  westSkirt: 55,
  /** Top of the bank. Short, so the causeway stops short of the forecourt. */
  eastSkirt: 8,
  /** End taper, along the road. */
  endSkirt: 20,
  /** The line the causeway takes its finished level from: the platform edge. */
  crownX: AIRFIELD.minX,
} as const;

/**
 * How much the causeway overrides the platform-graded ground, 0 to 1.
 *
 * Distances are normalised by their own skirt before being combined, so the
 * decay is elliptical and each face can have its own slope.
 */
export function causewayWeight(x: number, z: number): number {
  const west = (CAUSEWAY.minX - x) / CAUSEWAY.westSkirt;
  const east = (x - CAUSEWAY.maxX) / CAUSEWAY.eastSkirt;
  const dx = Math.max(west, east, 0);
  const dz = Math.max(CAUSEWAY.minZ - z, 0, z - CAUSEWAY.maxZ) / CAUSEWAY.endSkirt;
  const d = Math.hypot(dx, dz);
  if (d <= 0) return 1;
  if (d >= 1) return 0;
  const t = 1 - d;
  return t * t * (3 - 2 * t);
}
