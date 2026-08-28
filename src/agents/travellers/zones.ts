/**
 * Where people belong at Meridian Bay Regional, and how many of them.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   import { zoneAt, ZONE_RULES, zoneRule } from './travellers/zones';
 *
 *   const zone = zoneAt(x, z);            // one of PEDESTRIAN_ZONES
 *   const rule = zoneRule(zone);          // share, cap, forbidden
 *
 * ============================================================================
 *
 * ## The defect this exists to fix
 *
 * The city crowd is a FIXED population - 270 at 'high' - recycled inside a
 * 152 m radius, and it had no idea the airport existed. Grepping `src/agents`
 * for `airport` returned nothing before this file. `CityPlan` authors the
 * airport's roads as ordinary streets precisely so the traffic simulation, the
 * signal heads and the pavement graph pick them up with no special case, and
 * the crowd therefore populated them at ordinary city density.
 *
 * That is fine downtown and wrong at an airport, because the two places offer
 * completely different amounts of pavement to spread over. Measured on the
 * shipped build, metres of one-way pavement within the crowd's own 142 m seed
 * radius against the 270 people packed into it:
 *
 * | vantage                    | pavement | people | people per metre |
 * | -------------------------- | -------: | -----: | ---------------: |
 * | Old Quarter (-60, -40)     |   3324 m |    270 |            0.081 |
 * | city spawn                 |   2037 m |    270 |            0.133 |
 * | South Circuit (120, 132)   |   1870 m |    270 |            0.144 |
 * | airport approach (140,300) |   1241 m |    270 |        **0.218** |
 * | terminal forecourt         |   1241 m |    270 |        **0.218** |
 * | car park (183, 600)        |    597 m |    270 |        **0.452** |
 *
 * One person every 2.2 m on a 2.08 m wide footway is a continuous line of
 * bodies, and that is exactly what the player photographed: a wall of people
 * strung along an airport access road with nothing else on it.
 *
 * ## What the rules say
 *
 * Two numbers per zone, and they do different jobs:
 *
 *   - `share` scales the DENSITY. It multiplies a link's length when the crowd
 *     works out how many people the surroundings can carry, and it multiplies
 *     that link's weight when it picks somewhere to put one. A share of 0.14
 *     means a metre of airport access-road footway counts as 0.14 m of city
 *     pavement, so both the head count and the distribution fall together.
 *   - `cap` is the hard ceiling on how many people may be inside the zone at
 *     once, whatever the geometry says. It is what a test can assert, and it
 *     is what stops a pathological case - a player standing at the one spot
 *     where three zones meet - from stacking everybody in one place.
 *
 * A `forbidden` zone has `share: 0` and `cap: 0`: no link is ever offered
 * there, nobody is ever placed there, and `tests/airportPopulation.test.ts`
 * sweeps a long run to prove nobody reached one anyway.
 *
 * ## Why this module lives under `travellers/`
 *
 * `travellers/` is the airport population package. These rules govern the
 * boundary between its two crowds - the street crowd outside and the terminal
 * crowd inside - so they belong to neither one alone. Nothing here imports
 * Three.js or anything from `src/agents`, so `crowd.ts` can import it directly
 * (never through `./travellers`, which does pull in Three.js) and a unit test
 * can read it with no renderer, exactly like `world/airport/layout.ts` itself.
 *
 * COORDINATES: +X east, +Z south, metres, matching the rest of the project.
 */

import {
  AIRFIELD,
  APRON,
  CAR_PARK,
  CAUSEWAY,
  FORECOURT,
  HANGARS,
  TERMINAL,
  TOWER,
  inRect,
  isOnPavedAirfield,
} from '../../world/airport/layout';

/**
 * Every zone a pedestrian can be standing in, most restrictive first.
 *
 * `city` is the default and covers everything outside the airport site, so the
 * downtown crowd is untouched by any of this.
 */
export const PEDESTRIAN_ZONES = [
  'airside',
  'terminal',
  'forecourt',
  'carPark',
  'approach',
  'airportGrounds',
  'city',
] as const;

export type PedestrianZone = (typeof PEDESTRIAN_ZONES)[number];

export interface ZoneRule {
  readonly id: PedestrianZone;
  /** For diagnostics and test failure messages. */
  readonly label: string;
  /**
   * Population density relative to a city street, 0 to 1.
   *
   * Multiplies both the pavement a zone contributes to the crowd's head count
   * and the chance a spawn lands on one of its links.
   */
  readonly share: number;
  /** Hard ceiling on people simultaneously inside the zone. */
  readonly cap: number;
  /** True when nobody may ever be here, for any reason. */
  readonly forbidden: boolean;
}

/**
 * Clearance kept outside a forbidden surface, in metres.
 *
 * A shoulder plus a stride: a pedestrian whose CENTRE is a metre outside the
 * apron edge still has an arm over it, and a link that merely grazes airside
 * should be refused rather than accepted and then relied on to steer.
 */
export const AIRSIDE_MARGIN = 1.2;

/**
 * The rules.
 *
 * The caps are what a regional field with one departure an hour actually
 * looks like, and they add up to 74 people outdoors against the terminal's own
 * 78 indoors. For scale, the shipped crowd put 270 people on the same ground.
 */
export const ZONE_RULES: Readonly<Record<PedestrianZone, ZoneRule>> = {
  /*
   * Everything a moving aircraft uses. Runway, its overruns, the taxiway and
   * its links, the apron, the maintenance hardstanding, the hangars and the
   * tower pad. A person on any of them is a runway incursion, not a
   * pedestrian, and no amount of density tuning makes one acceptable.
   */
  airside: { id: 'airside', label: 'apron, taxiway and runway', share: 0, cap: 0, forbidden: true },
  /*
   * The terminal building. The street crowd cannot enter it - the pavement
   * graph has no link inside a parcel and `Crowd.project` clamps every agent
   * into its link corridor - and `TerminalCrowd` owns the population that is
   * in there. Declared anyway so the invariant is checked rather than assumed.
   */
  terminal: { id: 'terminal', label: 'terminal interior', share: 0, cap: 0, forbidden: true },
  /*
   * The forecourt: the drop-off, the terminal frontage and the crossings
   * between them. The one place outdoors where a crowd is plausible, because
   * it is where every passenger arrives and leaves. Still less than a city
   * street: an airport kerbside is busy in bursts, not continuously.
   */
  forecourt: { id: 'forecourt', label: 'terminal forecourt', share: 0.6, cap: 30, forbidden: false },
  /*
   * The car park. People walk from a bay to the terminal, so it is not empty,
   * but they arrive a car at a time and they are carrying something.
   */
  carPark: { id: 'carPark', label: 'car park', share: 0.3, cap: 14, forbidden: false },
  /*
   * Airport Approach and Airport Way: a 570 m access road across open ground
   * with no frontage, no shops and no reason to be on foot. A handful of
   * people walking between the bus stop and the terminal is the honest read;
   * a continuous file of them is what this whole module exists to stop.
   */
  approach: { id: 'approach', label: 'airport approach road', share: 0.12, cap: 14, forbidden: false },
  /*
   * The rest of the site: the hangar road, the service verges, the grass. Staff
   * routes. Somebody is occasionally there; a crowd never is.
   */
  airportGrounds: {
    id: 'airportGrounds',
    label: 'airport grounds',
    share: 0.1,
    cap: 10,
    forbidden: false,
  },
  /** Meridian Bay itself. Unchanged, and deliberately so. */
  city: { id: 'city', label: 'city', share: 1, cap: Number.POSITIVE_INFINITY, forbidden: false },
};

export function zoneRule(zone: PedestrianZone): ZoneRule {
  return ZONE_RULES[zone];
}

/**
 * Each zone's position in `PEDESTRIAN_ZONES`, so a per-frame lookup is an
 * object property rather than a linear search over seven strings.
 */
export const ZONE_INDEX: Readonly<Record<PedestrianZone, number>> = Object.fromEntries(
  PEDESTRIAN_ZONES.map((zone, index) => [zone, index]),
) as Record<PedestrianZone, number>;

/** `zoneAt` as an index into `PEDESTRIAN_ZONES`. */
export function zoneIndexAt(x: number, z: number): number {
  return ZONE_INDEX[zoneAt(x, z)];
}

/** True when the point is anywhere on the airport site, platform or causeway. */
export function inAirportGrounds(x: number, z: number): boolean {
  return (
    inRect(AIRFIELD, x, z) ||
    (x >= CAUSEWAY.minX && x <= CAUSEWAY.maxX && z >= CAUSEWAY.minZ && z <= CAUSEWAY.maxZ)
  );
}

/**
 * True when a point is on, or within a stride of, a surface aircraft use.
 *
 * Three sources, unioned: the paved airside surfaces the layout already
 * publishes for the ground sampler, the hangars, and the tower pad. The
 * hangars straddle `TERMINAL.maxX`, so the "east of the terminal" rule below
 * cannot be relied on to catch them.
 */
export function isAirside(x: number, z: number): boolean {
  if (isOnPavedAirfield(x, z)) return true;
  // `isOnPavedAirfield` takes no margin, so the surfaces whose edge a
  // pedestrian could plausibly reach are re-tested grown. The runway and
  // taxiway are hundreds of metres from any footway and need no such care.
  if (inRect(APRON, x, z, AIRSIDE_MARGIN)) return true;
  for (const hangar of HANGARS) if (inRect(hangar, x, z, AIRSIDE_MARGIN)) return true;
  if (
    Math.abs(x - TOWER.x) <= TOWER.halfX + AIRSIDE_MARGIN &&
    Math.abs(z - TOWER.z) <= TOWER.halfZ + AIRSIDE_MARGIN
  ) {
    return true;
  }
  /*
   * Everything on the platform east of the terminal's own east wall. The
   * apron starts at `APRON.minX` = 215 and the terminal ends at 214, so this
   * one comparison covers the apron, both taxiway shoulders, the runway strip
   * and the mown grass between them - the whole airside half of the platform -
   * without enumerating a surface at a time.
   */
  return inRect(AIRFIELD, x, z) && x >= TERMINAL.maxX;
}

/**
 * Which zone a point is in.
 *
 * Ordered most restrictive first, so a point that is both inside the forecourt
 * rectangle and on the apron is airside. The city test is last and is the
 * common case by a wide margin, which is why the airport tests are cheap
 * rectangle comparisons and nothing here allocates.
 */
export function zoneAt(x: number, z: number): PedestrianZone {
  if (!inAirportGrounds(x, z)) return 'city';
  if (isAirside(x, z)) return 'airside';
  // SHRUNK by half a metre (`inRect`'s grow is signed), so somebody standing
  // on the frontage against the outside of the wall is still outdoors.
  if (inRect(TERMINAL, x, z, -0.5)) return 'terminal';
  if (inRect(FORECOURT, x, z)) return 'forecourt';
  if (inRect(CAR_PARK, x, z)) return 'carPark';
  /*
   * The causeway strip carries Airport Approach and the west end of Airport
   * Way. Anything on it that is not already forecourt or car park is the
   * access road, including the verges either side of it.
   */
  if (x <= CAUSEWAY.maxX) return 'approach';
  return 'airportGrounds';
}

/**
 * The most restrictive zone touched by a straight run from A to B.
 *
 * A pavement link is a corridor, not a point, and a link whose midpoint sits on
 * the forecourt can still have an end on the apron. "Most restrictive" is the
 * LOWEST `share`, so a link that reaches out of the forecourt and onto the
 * access road is an access-road link and is populated like one, and a link that
 * touches airside anywhere is refused outright.
 *
 * Sampled rather than solved: every zone is an axis-aligned rectangle tens of
 * metres across and the default step is 2 m, so a run cannot pass through one
 * unnoticed.
 */
export function zoneAlong(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  step = 2,
): PedestrianZone {
  const length = Math.hypot(bx - ax, bz - az);
  const samples = Math.max(1, Math.ceil(length / Math.max(0.5, step)));
  let worst: PedestrianZone = 'city';
  let worstShare = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const zone = zoneAt(ax + (bx - ax) * t, az + (bz - az) * t);
    const rule = ZONE_RULES[zone];
    if (rule.forbidden) return zone;
    if (rule.share < worstShare) {
      worstShare = rule.share;
      worst = zone;
    }
  }
  return worst;
}
