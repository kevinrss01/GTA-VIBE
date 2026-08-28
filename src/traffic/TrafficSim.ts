/**
 * Ambient traffic: the part that decides where every car is.
 *
 * This module contains no Three.js at all, which is what lets a hundred and
 * fifty cars be driven around the real city for ten minutes inside a unit test
 * and asserted on - no WebGL, no canvas, no frame loop.
 *
 * THE MODEL, and why this one:
 *
 * - Longitudinally, the Intelligent Driver Model. Every reason to slow down -
 *   the car in front, a red light, a pedestrian on a crossing, a corner coming
 *   up, the player standing in the road - is expressed as the same thing, a
 *   "leader" at some gap moving at some speed, and the vehicle takes the most
 *   urgent of them. IDM is collision-free by construction for a following pair
 *   and it queues the way a real queue does: it compresses, it does not
 *   oscillate, and cars pull away one after another rather than in lockstep.
 *
 * - Laterally, a kinematic bicycle model steered by pure pursuit, with a
 *   steering-rate limit, a steering-angle limit and a lateral-grip limit. The
 *   rate limit is what stops a car snapping onto a new heading at a junction;
 *   the grip limit is what makes a heavy van understeer where a coupe would
 *   not. Weight transfer - nose dive under braking, roll into a bend - is a
 *   damped spring driven by the same accelerations, so a car that brakes hard
 *   visibly loads its front axle.
 *
 * - There is no physics engine here on purpose. What ambient traffic needs is
 *   exact lane discipline, guaranteed non-overlap and predictable queueing;
 *   a rigid-body solver gives none of those for free and costs far more.
 *
 * POSITION IS TRACKED TWICE, deliberately. `along` is the vehicle's position
 * on its lane, in one dimension, and drives every gap, queue and reservation
 * decision. `x, z, yaw` is where the car physically is, integrated from the
 * steering model. The steering keeps the second within a few centimetres of
 * the first on a straight and lets it cut a corner slightly on a turn, exactly
 * as a real car does, while the 1-D bookkeeping keeps the guarantees.
 */

import { clamp, damp, smoothstep } from '../core/mathx';
import { createRng, type Rng } from '../core/rng';
import {
  exitsFrom,
  laneHeading,
  lanePoint,
  signalFor,
  type Crossing,
  type Junction,
  type LaneSegment,
  type RoadNetwork,
} from '../city/RoadNetwork';
import type { CityPlan, Street, StreetKind } from '../world/CityPlan';
import {
  ALL_VEHICLE_KINDS,
  POLICE_KINDS,
  VEHICLE_BLUEPRINTS,
  VEHICLE_WEIGHTS,
  type VehicleBlueprint,
} from './VehicleCatalogue';
import {
  BLAST_SHARE,
  ENGINE_DEAD,
  ENGINE_SOFT,
  GLASS_CAPACITY,
  REGION_CAPACITY,
  TYRE_CAPACITY,
  TYRE_GRIP_LOSS,
  TYRE_PULL,
  VEHICLE_INTEGRITY,
  impactDamage,
  type TrafficObstacle,
  type VehicleControl,
  type VehicleImpact,
  type VehicleKind,
  type VehicleState,
  type VehicleView,
} from './types';

// -- tuning -----------------------------------------------------------------

/** Posted speed by street kind, metres per second. */
const SPEED_LIMIT: Readonly<Record<StreetKind, number>> = {
  promenade: 9,
  arterial: 15,
  secondary: 12,
  service: 8,
};

/** IDM parameters shared by every driver; the per-vehicle ones come from the chassis. */
const HEADWAY = 1.15;
const MIN_GAP = 1.7;
const BRAKE_COMFORT = 2.7;
const IDM_EXPONENT = 4;
/** Hard floor on acceleration, so a surprise never produces an impossible stop. */
const BRAKE_LIMIT_SCALE = 1.0;

/**
 * Route choice. See `chooseNext` for the measurements these came from.
 *
 * `GOAL_BIAS` is how hard a driver steers their route towards where they are
 * actually going, applied as `1 + GOAL_BIAS * cos(angle to the destination)`:
 * a continuation pointing at the destination is favoured, one pointing
 * straight back is nearly suppressed, and everything between is graded rather
 * than switched. Much above 1 the fleet stops reading as traffic and starts
 * reading as pathfinding.
 *
 * `ROAD_CLASS_REFERENCE` is the posted speed at which a continuation is
 * neither favoured nor penalised - the secondary streets that make up most of
 * Meridian Bay - so an arterial pulls traffic onto itself and a promenade
 * pushes it away, which is how a real city distributes its traffic.
 *
 * `QUEUE_AVERSION` is how strongly a driver avoids a continuation that is
 * already full: at 4, a lane standing bumper to bumper is a fifth as
 * attractive as an empty one.
 */
const GOAL_BIAS = 0.85;
/** A destination is reached, and a new one chosen, inside this radius. */
const ARRIVAL_RADIUS = 45;
const ROAD_CLASS_REFERENCE = 12;
const QUEUE_AVERSION = 4;
/** Metres of lane one stationary vehicle occupies, for the queue estimate. */
const JAM_SPACING = 8;
/** How far before the stop line the turn decision is taken again. */
const RECONSIDER_RANGE = 14;
/**
 * Seconds of the leader's own motion credited when asking whether there is
 * room on the far side of a junction. See `exitHasRoom`: roughly how long a
 * vehicle spends committed to crossing the box.
 */
const EXIT_LOOKAHEAD = 1.5;


/** Lateral acceleration a driver is willing to take through a junction turn. */
const TURN_COMFORT = 2.9;
/** How far ahead the junction's admission rules start being evaluated. */
const ADMISSION_RANGE = 26;
/** Distance from a junction centre at which a vehicle has cleared it. */
const CLEAR_MARGIN = 1.2;
/**
 * Seconds of near-standstill before a vehicle is assumed wedged.
 *
 * Well above any legitimate wait: a full red is 14.5 s and the back of a long
 * queue can sit through two cycles. This is a safety valve for a vehicle that
 * has genuinely deadlocked, not a queue-length limit.
 */
const STUCK_LIMIT = 70;
/** A wedged vehicle is only recycled once it is this far from the camera. */
const RECYCLE_DISTANCE = 70;
/** Minimum distance from the camera at which a recycled vehicle may reappear. */
const RESPAWN_CLEARANCE = 58;
/**
 * The longest body in the fleet, for sizing a spawn proximity query.
 *
 * Derived rather than written down: `tests/traffic.test.ts` caps every
 * blueprint at 7.5 m, and a constant that drifted away from the catalogue
 * would silently shrink the query until it stopped catching the lorry it
 * exists for.
 */
const LONGEST_VEHICLE = Math.max(...ALL_VEHICLE_KINDS.map((k) => VEHICLE_BLUEPRINTS[k].length));

/** Cell size of the vehicle broad-phase grid, metres. */
const GRID_CELL = 20;

// -- impacts and free bodies ------------------------------------------------

/**
 * Change in speed, m/s, below which a hit is felt but does not free the body.
 *
 * A car that left its lane every time something brushed it would spend the
 * day being re-attached, and every re-attach is a discontinuity in the queue
 * behind it. Below this the impulse is spent on the vehicle's own speed and
 * on damage, and the driver stays in charge.
 */
const LOOSE_TRIGGER = 0.9;
/**
 * Seconds one vehicle ignores further impulses after taking one.
 *
 * Two cars in contact stay in contact for many frames, and a contact that
 * re-applied its impulse at 120 Hz would launch a hatchback over a building.
 * A quarter of a second is longer than any single collision lasts and shorter
 * than the gap between two genuinely separate hits.
 */
const IMPACT_COOLDOWN = 0.22;
/**
 * How a free body slows: rolling along its own axis, scrubbing across it.
 *
 * Split because the two are nothing alike. A car shoved sideways is dragging
 * four locked tyres and stops in well under a second; one shunted forwards is
 * rolling, and a genuinely free-rolling car coasts for six or seven seconds,
 * which reads as ice. 3.0 m/s2 is a wreck with a bent wheel and no driver -
 * from 8 m/s it is stopped and back in traffic inside three seconds.
 */
const ROLL_DECEL = 3.0;
const SCRUB_DECEL = 8.5;
/** Yaw rate decay while loose, per second. */
const SPIN_DAMPING = 1.5;
/**
 * Roll rate decay, per second, in the two regimes a rolling car has.
 *
 * They are nothing alike and one constant cannot serve both. Below
 * `ROLL_CONTACT_ANGLE` the car is still on all four tyres and the roll it has
 * is suspension travel, which a damper kills inside a cycle. Past it two
 * wheels are off the ground and the body is swinging about the other pair,
 * with nothing but air resisting it.
 *
 * Measured with a single constant: 2.2 everywhere damped the rock-back
 * correctly but pushed the rollover threshold to 8.1 rad/s, half again more
 * than the real figure; 0.9 everywhere put the threshold at 5.7 and then left
 * a merely-shoved car rocking for seven seconds before it could rejoin
 * traffic. Split, a shoved car is upright and back in its lane in two seconds
 * and the threshold sits at 7.4.
 */
const ROLL_CONTACT_ANGLE = 0.3;
const ROLL_DAMPING_GROUNDED = 3.5;
const ROLL_DAMPING_AIRBORNE = 1.6;
/**
 * Ceilings on the angular rates one impact may impart, radians per second.
 *
 * Not physics, arithmetic hygiene: an explosion or a bug upstream can hand in
 * an impulse of any size, and a car spinning at fifty radians a second is a
 * strobe rather than a crash. Both are far above anything a collision at the
 * speeds this city reaches produces.
 */
const MAX_YAW_RATE = 9;
const MAX_ROLL_RATE = 8;
/**
 * Restoring angular acceleration that keeps a car on its wheels, 1/s2.
 *
 * Modelled as a pendulum with minima at upright and inverted, `-TIP_TORQUE *
 * sin(2 * roll)`, which costs one sine and gives exactly the behaviour that
 * matters: below the barrier the body rocks back onto its wheels, above it
 * carries over and stays there. The undamped barrier is `TIP_TORQUE`, so the
 * ideal threshold is `sqrt(2 * TIP_TORQUE)` = 4.9 rad/s; measured with the
 * damping below it is 7.4, against about 5.4 for the real thing at this track
 * and centre-of-mass height. Deliberately on the hard side: a rollover should
 * be the crash the player remembers, not one they cause every other junction.
 *
 * In lateral velocity change - which is what a caller actually controls - a
 * saloon struck a metre above its contact patches goes over at 7.7 m/s and
 * rocks back below it. The lever matters as much as the impulse: the same hit
 * at bumper height, 0.7 m, needs 11 m/s.
 */
const TIP_TORQUE = 12;
/** Speed and spin below which a free body counts as at rest. */
const REST_SPEED = 0.3;
const REST_SPIN = 0.3;
/** Seconds continuously at rest before a free body rejoins traffic. */
const SETTLE_SECONDS = 0.4;
/**
 * Seconds a body may stay loose before it is recycled out of sight.
 *
 * Same safety valve as `STUCK_LIMIT`, for the same reason: a wreck that can
 * never rejoin a lane would otherwise sit in the road forever, and the fleet
 * would bleed cars every time the player crashed one. Long enough that the
 * player who caused it gets to see it, and the recycle still waits for
 * `RECYCLE_DISTANCE` so nothing ever vanishes in front of them.
 */
const LOOSE_LIMIT = 18;
/** Restitution of a free body against the world. Sheet metal, not rubber. */
const WALL_RESTITUTION = 0.25;
/** Body height a loose car collides with, matching `Driving`'s own box. */
const LOOSE_BODY_HEIGHT = 1.4;
/** Closing speed, m/s, below which an ambient car touching a driven one is a nudge. */
const CONTACT_SPEED = 1.4;
/** Coefficient of restitution between two cars. Sheet metal absorbs most of it. */
const CAR_RESTITUTION = 0.15;

// -- abandoned cars and wrecks ----------------------------------------------

/**
 * How many abandoned cars and burnt-out wrecks the city keeps at once.
 *
 * A parked vehicle costs nothing to allocate - it is the same pooled object it
 * always was, in the same instance slot - so this is not a memory limit. It is
 * a limit on how much of the FLEET the player is allowed to take out of
 * circulation: at the shipping density of about a hundred and twenty cars,
 * twelve is a tenth of the traffic, which is the most that can be parked
 * before the streets visibly thin out.
 */
const PARKED_LIMIT = 12;
/**
 * The hard ceiling, and the reason there are two numbers.
 *
 * Nothing is ever removed in front of the player: `parkedRemoveDistance` is
 * strictly beyond the render distance, so a car being tidied away has already
 * stopped being drawn. That rule cannot be honoured unconditionally, though -
 * a player who abandons fifteen cars in one street has put every one of them
 * inside the render radius, and there is nothing out of sight to remove. Past
 * this second, higher count the oldest abandoned car is removed anyway, which
 * is a visible pop for a player who has gone out of their way to cause it and
 * is far better than an unbounded pool.
 */
const PARKED_HARD_LIMIT = 16;
/**
 * Metres past the render distance at which a parked vehicle may be removed.
 *
 * Expressed against `detailDistance` - which IS the renderer's render distance,
 * 150 to 260 m by quality - rather than as a constant, because "out of view"
 * is a property of the renderer and a fixed number would silently become wrong
 * the moment the render distance changed. The margin covers the frame or two
 * between the sim's opinion and the renderer's.
 */
const PARKED_REMOVE_MARGIN = 20;

// -- destruction ------------------------------------------------------------

/**
 * Seconds a write-off burns before it is a blackened shell.
 *
 * Long enough that the player who caused it sees the fire from across a couple
 * of streets, short enough that a street full of wrecks is not a permanent
 * bonfire. The soot it leaves behind is permanent; the flame is not.
 */
const FIRE_SECONDS = 14;
/** Seconds a write-off smoulders before the flame takes, so the fire builds. */
const IGNITION_SECONDS = 1.2;
/** Engine-bay damage at which an intact car starts smoking. */
const SMOKE_ONSET = 0.35;
/** Seconds the blackened shell smoulders after the flame is out. */
const SMOULDER_SECONDS = 10;

// -- lane metadata ----------------------------------------------------------

/**
 * The path through a junction from one lane onto the next.
 *
 * A lane graph whose nodes are junction CENTRES cannot describe a turn by
 * joining one lane's end to the next lane's start: for a right turn the two
 * carriageway centrelines cross BEFORE the centre, so an end-to-start curve
 * doubles back on itself. The turn is therefore anchored where it really
 * happens - it leaves the incoming lane at `startAlong`, passes through the
 * point where the two centrelines actually cross, and rejoins the outgoing
 * lane at `endAlong`. A quadratic Bezier through that crossing is tangent to
 * both lanes at its ends whatever radius is chosen, which is what lets a right
 * turn be tight and a left turn sweeping.
 */
interface TurnArc {
  readonly ax: number;
  readonly az: number;
  readonly cx: number;
  readonly cz: number;
  readonly bx: number;
  readonly bz: number;
  readonly length: number;
  /** Where the vehicle leaves the incoming lane. */
  readonly startAlong: number;
  /** Where it rejoins the outgoing lane. */
  readonly endAlong: number;
  /** Heading change across the arc, radians. Zero for a straight-through. */
  readonly sweep: number;
}

interface ExitInfo {
  readonly junction: Junction;
  /** Distance along the lane at which the stop line sits. */
  readonly stopAlong: number;
  readonly crossing: Crossing | null;
  /** Distance along the lane at which the crossing's near edge sits. */
  readonly crossingAlong: number;
}

interface EntryInfo {
  readonly junction: Junction;
  readonly crossing: Crossing | null;
  readonly crossingAlong: number;
}

interface LaneInfo {
  readonly lane: LaneSegment;
  readonly street: Street;
  readonly speedLimit: number;
  /** Half width of the lane corridor, used to decide what is "on" the lane. */
  readonly laneHalf: number;
  readonly heading: number;
  readonly forwardX: number;
  readonly forwardZ: number;
  readonly exit: ExitInfo | null;
  readonly entry: EntryInfo | null;
  /** Every legal continuation, and the subset that is not itself a dead end. */
  readonly exits: readonly LaneSegment[];
  liveExits: readonly LaneSegment[];
  /** True when the lane ends with nowhere to go; vehicles are recycled there. */
  readonly dead: boolean;
  /** Opposite-direction lane arriving at the same junction, for left turns. */
  oncoming: LaneSegment | null;
  /** Cached turn arcs to each continuation, keyed by the exit lane id. */
  readonly arcs: Map<string, TurnArc>;
  readonly occupants: Vehicle[];
  /** Obstacles projected onto this lane this tick, sorted by `along`. */
  readonly blockages: { along: number; radius: number }[];
}

// -- vehicles ---------------------------------------------------------------

/** Mutable twin of `VehicleDamageRegions`. Allocated once per vehicle. */
interface MutableRegions {
  front: number;
  rear: number;
  left: number;
  right: number;
  glass: number;
  /** Front left, front right, rear left, rear right. Fixed length four. */
  readonly tyres: number[];
}

/** Mutable twin of `VehicleHandling`. */
interface MutableHandling {
  power: number;
  grip: number;
  pull: number;
  destroyed: boolean;
}

interface MutableView {
  id: number;
  kind: VehicleKind;
  police: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  halfLength: number;
  halfWidth: number;
  halfHeight: number;
  speed: number;
  pitch: number;
  roll: number;
  braking: boolean;
  accelLong: number;
  control: VehicleControl;
  state: VehicleState;
  integrity: number;
  damage: number;
  destroyed: boolean;
  readonly regions: MutableRegions;
  readonly handling: MutableHandling;
  smoke: number;
  fire: number;
  overturned: boolean;
}

export interface Vehicle {
  readonly id: number;
  kind: VehicleKind;
  blueprint: VehicleBlueprint;
  active: boolean;
  /**
   * The internal state, which unlike the published `view.control` includes
   * `'parked'`. See `VehicleState`.
   */
  control: VehicleState;

  laneId: string;
  along: number;
  next: LaneSegment | null;
  nextArc: TurnArc | null;
  turn: -1 | 0 | 1;

  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  steer: number;
  accelLong: number;
  accelLat: number;

  bodyPitch: number;
  bodyPitchVel: number;
  bodyRoll: number;
  bodyRollVel: number;
  groundPitch: number;
  groundRoll: number;
  wheelSpin: number;

  /**
   * Free-body state. Only integrated while `control === 'loose'`, but always
   * present so the hot path never branches on whether the fields exist.
   */
  vx: number;
  vz: number;
  yawRate: number;
  rollRate: number;
  /**
   * Attitude a crash left behind, added on top of the road slope and the
   * suspension. Kept separate from `bodyPitch`/`bodyRoll` because those are a
   * spring driven by this frame's accelerations, and separate from
   * `groundPitch`/`groundRoll` because `settleBody` zeroes those at long range
   * - an overturned car has to stay overturned on the far side of the city.
   */
  crashPitch: number;
  crashRoll: number;
  /** How far the body has to be lifted to rest on its side or its roof. */
  bodyLift: number;
  /** Seconds spent loose, and seconds spent continuously at rest while loose. */
  looseTimer: number;
  restTimer: number;
  /** Seconds left before another impulse will be accepted. */
  impactCooldown: number;

  /** Structural points remaining, out of `VEHICLE_INTEGRITY`. */
  integrity: number;
  /** The same as a fraction, 0 to 1. Cached because the renderer reads it per frame. */
  damage: number;
  /**
   * Damage points taken by each region and each tyre, in the same scale as
   * `integrity`. Kept in points rather than fractions so a capacity can be
   * retuned in one place without rescaling anything already on a car.
   */
  readonly regionPoints: {
    front: number;
    rear: number;
    left: number;
    right: number;
    glass: number;
    readonly tyres: number[];
  };
  /** Seconds since the shell was written off, for the fire. -1 while intact. */
  burnTimer: number;
  /**
   * True once nothing will ever drive this vehicle again.
   *
   * Set when the player gets out of it and when it is written off or rolled.
   * It is what stops a shunted abandoned car quietly rejoining the traffic AI
   * on the next kerb it comes to rest against: there is nobody in it, and a
   * car with nobody in it does not drive away.
   */
  abandoned: boolean;
  /**
   * Frame on which this vehicle was parked, for the abandoned-car lifecycle.
   * -1 when it is not parked. Ordering by it is what makes "the oldest one"
   * mean something without a second list to keep in step.
   */
  parkedFrame: number;
  /** True once a parked body has stopped moving and no longer needs stepping. */
  parkedAtRest: boolean;

  desiredSpeed: number;
  braking: boolean;
  /** Seconds the brake lamps stay lit after the brake is released. */
  brakeHold: number;
  claim: string | null;
  /**
   * True once the turn has been re-decided on this lane. See `stepVehicle`:
   * the first choice is made a whole block early, and a driver who cannot
   * change their mind on the approach cannot avoid a queue they can see.
   */
  reconsidered: boolean;
  /** Where this driver is going. See `chooseNext`. */
  destX: number;
  destZ: number;
  stuck: number;
  groundTimer: number;

  /** Per-instance paint and rim colours, linear-space triples. */
  paint: readonly [number, number, number];
  rim: readonly [number, number, number];
  headlights: number;

  simAccumulator: number;
  bucket: number;

  readonly view: MutableView;
}

export interface TrafficSimOptions {
  readonly network: RoadNetwork;
  readonly plan: CityPlan;
  /** Authoritative ground height. `CityGround.heightAt` in the game. */
  readonly heightAt: (x: number, z: number) => number;
  readonly population: number;
  readonly seed?: string;
  /** Beyond this the ground is sampled coarsely; nothing else changes. */
  readonly detailDistance?: number;
  /**
   * The static world a loose body bounces off. Optional: without it a knocked
   * car still slides, spins and settles, it just does not notice walls. Every
   * headless test that only needs traffic runs without one.
   */
  readonly collision?: TrafficCollision;
}

/**
 * The slice of the player's `CollisionWorld` a free body needs.
 *
 * Structural rather than an import, so `TrafficSim` keeps its promise of
 * containing nothing but arithmetic and never reaches into the player module.
 */
export interface TrafficCollision {
  moveBox(
    x: number,
    z: number,
    yaw: number,
    dx: number,
    dz: number,
    halfLength: number,
    halfWidth: number,
    feetY: number,
    height: number,
    vehicles?: boolean,
  ): { x: number; z: number; feetY: number };
}

/** Where a body ends up after one free step, and what it hit getting there. */
export type ImpactListener = (
  x: number,
  y: number,
  z: number,
  intensity: number,
  kind: 'vehicle' | 'world',
) => void;

// -- helpers ----------------------------------------------------------------

function normaliseAngle(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** sRGB hex to a linear triple, matching the renderer's working colour space. */
function linearTriple(hex: number): [number, number, number] {
  const convert = (c: number): number =>
    c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return [
    convert(((hex >> 16) & 0xff) / 255),
    convert(((hex >> 8) & 0xff) / 255),
    convert((hex & 0xff) / 255),
  ];
}

function bezier(arc: TurnArc, t: number): { x: number; z: number } {
  const u = 1 - t;
  const a = u * u;
  const b = 2 * u * t;
  const c = t * t;
  return {
    x: a * arc.ax + b * arc.cx + c * arc.bx,
    z: a * arc.az + b * arc.cz + c * arc.bz,
  };
}

/**
 * Plan-view separating-axis test between two yaw-oriented vehicle footprints.
 *
 * Four axes is exact for a box pair in the plane. Used only where an
 * approximate answer would be wrong - deciding whether a car has actually
 * struck a driven one - never in the following model, which works on gaps.
 */
/**
 * How deep two footprints overlap, and along which direction, or zero.
 *
 * The separating-axis test already computes every candidate axis; the smallest
 * positive overlap among them IS the minimum translation that separates them,
 * so the depth costs nothing beyond the boolean. The axis is written into a
 * module-level scratch rather than returned, because this runs inside the
 * frame loop and a returned pair would allocate.
 */
const penetrationAxis = { x: 0, z: 0 };

function footprintPenetration(
  x: number,
  z: number,
  yaw: number,
  ahl: number,
  ahw: number,
  b: Vehicle,
): number {
  const afx = -Math.sin(yaw);
  const afz = -Math.cos(yaw);
  const bfx = -Math.sin(b.yaw);
  const bfz = -Math.cos(b.yaw);
  const bhl = b.blueprint.length * 0.5;
  const bhw = b.blueprint.width * 0.5;
  const dx = b.x - x;
  const dz = b.z - z;
  let least = Infinity;
  for (let axis = 0; axis < 4; axis += 1) {
    const ax = axis === 0 ? afx : axis === 1 ? -afz : axis === 2 ? bfx : -bfz;
    const az = axis === 0 ? afz : axis === 1 ? afx : axis === 2 ? bfz : bfx;
    const reach =
      ahl * Math.abs(afx * ax + afz * az) +
      ahw * Math.abs(-afz * ax + afx * az) +
      bhl * Math.abs(bfx * ax + bfz * az) +
      bhw * Math.abs(-bfz * ax + bfx * az);
    const overlap = reach - Math.abs(dx * ax + dz * az);
    if (overlap <= 0) return 0;
    if (overlap < least) {
      least = overlap;
      // Oriented away from `b`, so `a` is the one that gets pushed out.
      const sign = dx * ax + dz * az > 0 ? -1 : 1;
      penetrationAxis.x = ax * sign;
      penetrationAxis.z = az * sign;
    }
  }
  return least;
}

function footprintsOverlap(a: Vehicle, b: Vehicle): boolean {
  const afx = -Math.sin(a.yaw);
  const afz = -Math.cos(a.yaw);
  const arx = -afz;
  const arz = afx;
  const bfx = -Math.sin(b.yaw);
  const bfz = -Math.cos(b.yaw);
  const brx = -bfz;
  const brz = bfx;
  const ahl = a.blueprint.length * 0.5;
  const ahw = a.blueprint.width * 0.5;
  const bhl = b.blueprint.length * 0.5;
  const bhw = b.blueprint.width * 0.5;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const separated = (ax: number, az: number, own: number): boolean =>
    Math.abs(dx * ax + dz * az) >
    own + bhl * Math.abs(bfx * ax + bfz * az) + bhw * Math.abs(brx * ax + brz * az);
  if (separated(afx, afz, ahl)) return false;
  if (separated(arx, arz, ahw)) return false;
  if (
    Math.abs(dx * bfx + dz * bfz) >
    bhl + ahl * Math.abs(afx * bfx + afz * bfz) + ahw * Math.abs(arx * bfx + arz * bfz)
  ) {
    return false;
  }
  if (
    Math.abs(dx * brx + dz * brz) >
    bhw + ahl * Math.abs(afx * brx + afz * brz) + ahw * Math.abs(arx * brx + arz * brz)
  ) {
    return false;
  }
  return true;
}

/**
 * Intelligent Driver Model acceleration.
 *
 * `gap` is bumper to bumper; `closing` is this vehicle's speed minus the
 * leader's. A gap at or below zero is already an overlap, so the term is
 * clamped rather than allowed to divide by nothing.
 */
export function idmAccel(
  speed: number,
  desired: number,
  gap: number,
  closing: number,
  accelMax: number,
): number {
  const free = accelMax * (1 - (speed / Math.max(desired, 0.5)) ** IDM_EXPONENT);
  if (gap >= 1e5) return free;
  const dynamic = (speed * closing) / (2 * Math.sqrt(accelMax * BRAKE_COMFORT));
  const target = MIN_GAP + Math.max(0, speed * HEADWAY + dynamic);
  const ratio = target / Math.max(gap, 0.25);
  return free - accelMax * ratio * ratio;
}

// -- simulation -------------------------------------------------------------

export class TrafficSim {
  readonly network: RoadNetwork;
  readonly vehicles: Vehicle[] = [];
  /** Live views, rebuilt in place each update. Never reallocated. */
  readonly views: MutableView[] = [];

  private readonly laneInfo = new Map<string, LaneInfo>();
  /**
   * Which lanes feed each junction. Built once with `laneInfo`, because the
   * road network never changes, and read by `junctionConflict` at 120 Hz.
   */
  private readonly junctionApproaches = new Map<string, LaneInfo[]>();
  private readonly laneList: LaneInfo[] = [];
  private readonly spawnLanes: LaneInfo[] = [];
  private readonly spawnWeights: number[] = [];
  private readonly streets = new Map<string, Street>();
  private readonly heightAt: (x: number, z: number) => number;
  private readonly rng: Rng;
  private readonly detailDistance: number;

  /**
   * Vehicles holding a junction, by junction id.
   *
   * A claim is taken the moment a driver commits to entering, before it is
   * physically inside the box, and released when it is clear of it. Checking
   * only physical presence is not enough: two opposing drivers can both find
   * the box empty in the same frame, both commit, and meet in the middle.
   */
  private readonly claims = new Map<string, Vehicle[]>();
  /** Broad-phase grid of vehicle centres, rebuilt each tick. */
  private readonly grid = new Map<number, Vehicle[]>();
  private readonly gridPool: Vehicle[][] = [];
  /**
   * Static grids over the lane graph and the crossings.
   *
   * Obstacles are projected onto lanes obstacle-first, so the per-frame cost is
   * proportional to the number of pedestrians in the road rather than to
   * lanes times pedestrians, which at city scale is the difference between a
   * few hundred tests and forty thousand.
   */
  private readonly laneGrid = new Map<number, LaneInfo[]>();
  private readonly crossingGrid = new Map<number, Crossing[]>();
  private readonly occupiedCrossings = new Set<string>();
  /** Reused blockage records. Projecting obstacles must not allocate per frame. */
  private readonly blockagePool: { along: number; radius: number }[] = [];
  private blockagesUsed = 0;

  private obstacles: readonly TrafficObstacle[] = [];
  private crossingBlocked: ((crossingId: string) => boolean) | null = null;
  private collision: TrafficCollision | null = null;
  /** Notified for every resolved impact. See `TrafficSystem.onImpact`. */
  impactListener: ImpactListener | null = null;
  /**
   * Impulse waiting to be collected by whoever owns a driven vehicle's pose.
   *
   * A `player` vehicle's position is written from outside, so the sim cannot
   * move it: all it can do is record what hit it and let the owner - `Driving`,
   * or a pursuit - decide what that does to the car. Keyed by vehicle id, and
   * empty on all but the handful of frames where something actually connects.
   */
  private readonly pendingImpulses = new Map<
    number,
    { x: number; z: number; yaw: number; damage: number }
  >();
  /**
   * Vehicles the traffic AI is not driving that something can still run into:
   * the player's car, every police unit, and every abandoned car or wreck near
   * enough to matter. Rebuilt in place each frame, and bounded by
   * `PARKED_LIMIT` plus the handful of units in play.
   */
  private readonly driven: Vehicle[] = [];
  /**
   * Every parked vehicle, oldest first.
   *
   * Append-ordered, so index 0 is the least recently abandoned - which is what
   * `enforceParkedLimit` removes first. Length is bounded by
   * `PARKED_HARD_LIMIT`.
   */
  private readonly parked: Vehicle[] = [];
  private time = 0;
  private cameraX = 0;
  private cameraZ = 0;
  private frame = 0;

  constructor(options: TrafficSimOptions) {
    this.network = options.network;
    this.heightAt = options.heightAt;
    this.rng = createRng(options.seed ?? 'meridian-traffic-01');
    this.detailDistance = options.detailDistance ?? 240;
    this.collision = options.collision ?? null;

    for (const street of options.plan.streets) this.streets.set(street.id, street);
    this.buildLaneInfo();
    this.resize(options.population);
  }

  // -- construction ---------------------------------------------------------

  private buildLaneInfo(): void {
    const { network } = this;

    for (const lane of network.lanes) {
      const street = this.streets.get(lane.streetId);
      if (!street) continue;
      const heading = laneHeading(lane);
      const exits = this.forwardExits(lane);

      const toNode = network.nodes.get(lane.toNode);
      let exit: ExitInfo | null = null;
      if (toNode) {
        // A street that ends exactly on a junction produces a terminus node at
        // the same point, and the lane arrives at that instead. Without this
        // fallback those approaches carry no signal, no crossing and no
        // conflict check, and cars drive straight through the light.
        const junction = network.junctionById.get(lane.toNode) ?? this.junctionAt(toNode.x, toNode.z);
        if (junction) {
          // Approaching along 'x' means moving in Z, so the box to clear is the
          // east-west street's half width; getting these the wrong way round
          // puts the stop line inside the junction.
          const halfAlong = lane.axis === 'x' ? junction.halfZ : junction.halfX;
          const crossing = this.approachCrossing(junction, lane);
          const crossingAlong = lane.length - (halfAlong + 1.6 + 1.6);
          exit = {
            junction,
            stopAlong: Math.max(lane.length * 0.35, crossingAlong - 0.4),
            crossing,
            crossingAlong,
          };
        }
      }

      const fromNode = network.nodes.get(lane.fromNode);
      let entry: EntryInfo | null = null;
      if (fromNode) {
        const junction =
          network.junctionById.get(lane.fromNode) ?? this.junctionAt(fromNode.x, fromNode.z);
        if (junction) {
          const halfAlong = lane.axis === 'x' ? junction.halfZ : junction.halfX;
          entry = {
            junction,
            crossing: this.departCrossing(junction, lane),
            crossingAlong: halfAlong + 1.6 - 1.6,
          };
        }
      }

      const info: LaneInfo = {
        lane,
        street,
        speedLimit: SPEED_LIMIT[street.kind],
        laneHalf: street.roadHalf * 0.5,
        heading,
        forwardX: -Math.sin(heading),
        forwardZ: -Math.cos(heading),
        exit,
        entry,
        exits,
        liveExits: exits,
        dead: exits.length === 0,
        oncoming: null,
        arcs: new Map(),
        occupants: [],
        blockages: [],
      };
      this.laneInfo.set(lane.id, info);
      if (info.exit) {
        const list = this.junctionApproaches.get(info.exit.junction.id);
        if (list) list.push(info);
        else this.junctionApproaches.set(info.exit.junction.id, [info]);
      }
      this.laneList.push(info);
    }

    // Second pass: prefer continuations that are not themselves dead ends, and
    // find the oncoming lane at each junction so a left turn can yield to it.
    for (const info of this.laneList) {
      const live = info.exits.filter((exitLane) => !(this.laneInfo.get(exitLane.id)?.dead ?? true));
      info.liveExits = live.length > 0 ? live : info.exits;
      const stopAlong = info.exit ? info.exit.stopAlong : Number.NEGATIVE_INFINITY;
      for (const exitLane of info.exits) {
        info.arcs.set(exitLane.id, this.buildArc(info.lane, exitLane, stopAlong));
      }
      if (info.exit) {
        info.oncoming =
          this.network.lanes.find(
            (other) =>
              other.streetId === info.lane.streetId &&
              other.travel !== info.lane.travel &&
              other.toNode === info.lane.toNode,
          ) ?? null;
      }
    }

    for (const info of this.laneList) {
      if (info.dead) continue;
      // Never seed a vehicle on a lane it can only leave by being recycled.
      this.spawnLanes.push(info);
      this.spawnWeights.push(info.lane.length);
    }

    for (const info of this.laneList) {
      const a = lanePoint(info.lane, 0);
      const b = lanePoint(info.lane, info.lane.length);
      const pad = info.laneHalf + 2;
      this.indexCells(
        Math.min(a.x, b.x) - pad,
        Math.min(a.z, b.z) - pad,
        Math.max(a.x, b.x) + pad,
        Math.max(a.z, b.z) + pad,
        (key) => {
          const bucket = this.laneGrid.get(key);
          if (bucket) bucket.push(info);
          else this.laneGrid.set(key, [info]);
        },
      );
    }
    for (const crossing of this.network.crossings) {
      const halfX = crossing.axis === 'x' ? crossing.halfSpan : crossing.halfWidth;
      const halfZ = crossing.axis === 'x' ? crossing.halfWidth : crossing.halfSpan;
      this.indexCells(
        crossing.x - halfX - 1,
        crossing.z - halfZ - 1,
        crossing.x + halfX + 1,
        crossing.z + halfZ + 1,
        (key) => {
          const bucket = this.crossingGrid.get(key);
          if (bucket) bucket.push(crossing);
          else this.crossingGrid.set(key, [crossing]);
        },
      );
    }
  }

  private indexCells(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    visit: (key: number) => void,
  ): void {
    const x0 = Math.floor(minX / GRID_CELL);
    const x1 = Math.floor(maxX / GRID_CELL);
    const z0 = Math.floor(minZ / GRID_CELL);
    const z1 = Math.floor(maxZ / GRID_CELL);
    for (let ix = x0; ix <= x1; ix += 1) {
      for (let iz = z0; iz <= z1; iz += 1) visit((ix + 4096) * 8192 + (iz + 4096));
    }
  }

  /**
   * Legal continuations, with every U-turn removed.
   *
   * `exitsFrom` allows a car to turn round where a street simply ends. This
   * layer does not: a 180 in a junction box is the most obvious way for traffic
   * to read as fake, and the instruction for a lane with nowhere to go is to
   * recycle the vehicle.
   *
   * The aliasing pass exists because several of Meridian Bay's outer streets
   * end exactly ON a junction. The network gives those two coincident nodes -
   * a terminus and a junction at the same point - and the zero-length link
   * between them is dropped, so a lane arrives at the terminus and finds
   * nothing leaving it while the junction beside it has three exits. Matching
   * nodes by position recovers those, which is what keeps traffic running
   * round the whole outer ring instead of stopping 40 m short of every corner.
   */
  private forwardExits(lane: LaneSegment): readonly LaneSegment[] {
    const isUTurn = (next: LaneSegment): boolean =>
      next.streetId === lane.streetId && next.travel !== lane.travel;
    const direct = exitsFrom(this.network, lane).filter((next) => !isUTurn(next));
    if (direct.length > 0) return direct;

    const node = this.network.nodes.get(lane.toNode);
    if (!node) return [];
    const aliased: LaneSegment[] = [];
    for (const [id, other] of this.network.nodes) {
      if (id === node.id) continue;
      if (Math.abs(other.x - node.x) > 0.75 || Math.abs(other.z - node.z) > 0.75) continue;
      for (const next of this.network.lanesFrom.get(id) ?? []) {
        if (!isUTurn(next)) aliased.push(next);
      }
    }
    return aliased;
  }

  /** Junction at a point, matching a terminus node that sits on one. */
  private junctionAt(x: number, z: number): Junction | null {
    for (const junction of this.network.junctions) {
      if (Math.abs(junction.x - x) < 0.75 && Math.abs(junction.z - z) < 0.75) return junction;
    }
    return null;
  }

  /** Crossing a lane meets on its way INTO a junction. */
  private approachCrossing(junction: Junction, lane: LaneSegment): Crossing | null {
    const side =
      lane.axis === 'x' ? (lane.travel === 1 ? 'n' : 's') : lane.travel === 1 ? 'w' : 'e';
    return this.network.crossingById.get(`${junction.id}:${side}`) ?? null;
  }

  /** Crossing a lane meets on its way OUT of a junction. */
  private departCrossing(junction: Junction, lane: LaneSegment): Crossing | null {
    const side =
      lane.axis === 'x' ? (lane.travel === 1 ? 's' : 'n') : lane.travel === 1 ? 'e' : 'w';
    return this.network.crossingById.get(`${junction.id}:${side}`) ?? null;
  }

  /**
   * Quadratic arc from the end of one lane into the start of the next.
   *
   * The control point is where the two lane centrelines cross, which is what
   * makes the curve read as a real turn rather than as a corner cut. A
   * straight-through continuation produces a zero-length arc and costs nothing.
   */
  private buildArc(from: LaneSegment, to: LaneSegment, stopAlong: number): TurnArc {
    const sweep = normaliseAngle(laneHeading(to) - laneHeading(from));
    const straight = Math.abs(sweep) < 0.05 || from.axis === to.axis;
    if (straight) {
      const p = lanePoint(from, from.length);
      return {
        ax: p.x,
        az: p.z,
        cx: p.x,
        cz: p.z,
        bx: p.x,
        bz: p.z,
        length: 0,
        startAlong: from.length,
        endAlong: 0,
        sweep: 0,
      };
    }

    // Where the two carriageway centrelines cross. Each lane contributes the
    // coordinate that is constant along it.
    const cx = from.axis === 'x' ? from.offset : to.offset;
    const cz = from.axis === 'x' ? to.offset : from.offset;
    const crossFrom = (to.offset - from.start) * from.travel;
    const crossTo = (from.offset - to.start) * to.travel;

    // Radius: a right turn is tight, a left turn sweeps across the junction.
    const inset = Math.abs(from.length - crossFrom) + Math.abs(crossTo);
    const right = sweep < 0;
    let radius = right ? Math.max(4.5, inset * 0.9) : Math.max(8, inset * 1.6);
    radius = Math.min(radius, from.length * 0.4, to.length * 0.4);

    let startAlong = crossFrom - radius;
    // A driver does not begin swinging the wheel before the stop line, but the
    // geometry wins if the natural turn-in point is already behind it.
    if (Number.isFinite(stopAlong) && stopAlong > startAlong) {
      startAlong = Math.min(stopAlong, Math.max(0.5, crossFrom - 1));
    }
    startAlong = clamp(startAlong, 0.5, from.length);
    const endAlong = clamp(crossTo + radius, 0.5, to.length - 0.5);
    const a = lanePoint(from, startAlong);
    const b = lanePoint(to, endAlong);

    const arc: TurnArc = {
      ax: a.x,
      az: a.z,
      cx,
      cz,
      bx: b.x,
      bz: b.z,
      length: 1,
      startAlong,
      endAlong,
      sweep,
    };
    let length = 0;
    let px = a.x;
    let pz = a.z;
    for (let i = 1; i <= 8; i += 1) {
      const p = bezier(arc, i / 8);
      length += Math.hypot(p.x - px, p.z - pz);
      px = p.x;
      pz = p.z;
    }
    return { ...arc, length: Math.max(length, 0.5) };
  }

  // -- population -----------------------------------------------------------

  /** Grows or shrinks the fleet. Existing vehicles keep their state. */
  resize(population: number): void {
    const target = Math.max(0, Math.floor(population));
    while (this.vehicles.length < target) {
      const vehicle = this.createVehicle(this.vehicles.length);
      this.vehicles.push(vehicle);
      this.placeVehicle(vehicle, 0);
    }
    while (this.vehicles.length > target) {
      const removed = this.vehicles.pop();
      if (removed) removed.active = false;
    }
  }

  private createVehicle(id: number): Vehicle {
    const kind = this.rng.weighted(ALL_VEHICLE_KINDS, VEHICLE_WEIGHTS);
    const blueprint = VEHICLE_BLUEPRINTS[kind];
    const first = this.laneList[0] as LaneInfo;
    const view: MutableView = {
      id,
      kind,
      police: POLICE_KINDS.has(kind),
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      halfLength: blueprint.length * 0.5,
      halfWidth: blueprint.width * 0.5,
      halfHeight: blueprint.height * 0.5,
      speed: 0,
      pitch: 0,
      roll: 0,
      braking: false,
      accelLong: 0,
      control: 'ambient',
      state: 'ambient',
      integrity: VEHICLE_INTEGRITY,
      damage: 0,
      destroyed: false,
      regions: { front: 0, rear: 0, left: 0, right: 0, glass: 0, tyres: [0, 0, 0, 0] },
      handling: { power: 1, grip: 1, pull: 0, destroyed: false },
      smoke: 0,
      fire: 0,
      overturned: false,
    };
    return {
      id,
      kind,
      blueprint,
      active: false,
      control: 'ambient',
      laneId: first.lane.id,
      along: 0,
      next: null,
      nextArc: null,
      turn: 0,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
      speed: 0,
      steer: 0,
      accelLong: 0,
      accelLat: 0,
      bodyPitch: 0,
      bodyPitchVel: 0,
      bodyRoll: 0,
      bodyRollVel: 0,
      groundPitch: 0,
      groundRoll: 0,
      wheelSpin: 0,
      vx: 0,
      vz: 0,
      yawRate: 0,
      rollRate: 0,
      crashPitch: 0,
      crashRoll: 0,
      bodyLift: 0,
      looseTimer: 0,
      restTimer: 0,
      impactCooldown: 0,
      integrity: VEHICLE_INTEGRITY,
      damage: 0,
      regionPoints: { front: 0, rear: 0, left: 0, right: 0, glass: 0, tyres: [0, 0, 0, 0] },
      burnTimer: -1,
      abandoned: false,
      parkedFrame: -1,
      parkedAtRest: false,
      desiredSpeed: 10,
      braking: false,
      brakeHold: 0,
      claim: null,
      reconsidered: false,
      destX: 0,
      destZ: 0,
      stuck: 0,
      groundTimer: 0,
      paint: linearTriple(this.rng.pick(blueprint.paints)),
      rim: linearTriple(this.rng.pick(blueprint.rims)),
      headlights: this.rng.chance(0.55) ? 1 : 0,
      simAccumulator: 0,
      bucket: id & 3,
      view,
    };
  }

  /**
   * Puts a vehicle on a free stretch of lane.
   *
   * `clearance` keeps a recycled car from reappearing in front of the player;
   * at start-up it is zero, because the city is meant to be populated from the
   * first frame including where the player is standing.
   */
  private placeVehicle(vehicle: Vehicle, clearance: number): boolean {
    if (this.spawnLanes.length === 0) return false;
    const halfLength = vehicle.blueprint.length * 0.5;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const info = this.rng.weighted(this.spawnLanes, this.spawnWeights);
      const margin = halfLength + 3;
      if (info.lane.length < margin * 2 + 6) continue;
      const along = this.rng.range(margin, info.lane.length - margin);
      const point = lanePoint(info.lane, along);
      // Never seed a vehicle already inside a junction box.
      if (info.exit && along > info.exit.stopAlong - 1) continue;
      if (info.entry && along < info.entry.crossingAlong + margin) continue;
      if (clearance > 0) {
        const dx = point.x - this.cameraX;
        const dz = point.z - this.cameraZ;
        if (dx * dx + dz * dz < clearance * clearance) continue;
      }
      let blocked = false;
      for (const other of info.occupants) {
        const need = halfLength + other.blueprint.length * 0.5 + 9;
        if (Math.abs(other.along - along) < need) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      /*
       * ...and not on top of anybody on a DIFFERENT lane either.
       *
       * The check above is one-dimensional: it compares `along` within one
       * lane, which is exactly right for the car in front and blind to the one
       * crossing at right angles. Near a junction the two lanes are metres
       * apart in the plan and arbitrarily far apart in `along`, so a car could
       * be seeded straight through a lorry on the cross street.
       *
       * Measured before this check: a coupe on Grand Concourse and a box lorry
       * on Ridge Road overlapping by 0.524 m, three and a half seconds into a
       * ten-minute run. It was always possible and the old lane graph simply
       * never rolled it; adding two streets re-rolled the draws and it
       * appeared. The plan-view test is the honest one.
       *
       * Radius, not a box test: this runs at most 14 times per placement and
       * the whole point is to reject the site, not to resolve a contact.
       */
      const reach = halfLength + LONGEST_VEHICLE * 0.5 + 1;
      this.forEachNearVehicle(point.x, point.z, reach, (other) => {
        if (other === vehicle || blocked) return;
        const need = halfLength + other.blueprint.length * 0.5 + 1;
        const ddx = other.x - point.x;
        const ddz = other.z - point.z;
        if (ddx * ddx + ddz * ddz < need * need) blocked = true;
      });
      if (blocked) continue;

      vehicle.laneId = info.lane.id;
      vehicle.along = along;
      vehicle.claim = null;
      vehicle.stuck = 0;
      // A vehicle that reappears somewhere else is a different journey.
      this.pickDestination(vehicle);
      vehicle.x = point.x;
      vehicle.z = point.z;
      vehicle.y = this.heightAt(point.x, point.z);
      vehicle.yaw = info.heading;
      vehicle.steer = 0;
      vehicle.desiredSpeed = this.desiredSpeedFor(vehicle, info);
      // Seeded at a speed it can always stop from before the junction ahead.
      // Dropping a car 3 m short of a red light at 11 m/s is how a fleet
      // starts its life already wedged across an intersection.
      let speed = vehicle.desiredSpeed * 0.8;
      if (info.exit) {
        const room = Math.max(0, info.exit.stopAlong - along - halfLength);
        speed = Math.min(speed, Math.sqrt(2 * BRAKE_COMFORT * room));
      }
      vehicle.speed = speed;
      vehicle.accelLong = 0;
      vehicle.accelLat = 0;
      vehicle.bodyPitch = 0;
      vehicle.bodyRoll = 0;
      // A vehicle that reappears is a different car, not the wreck that left.
      this.resetBody(vehicle);
      vehicle.active = true;
      vehicle.control = 'ambient';
      vehicle.view.control = 'ambient';
      vehicle.view.state = 'ambient';
      // The view has to be valid the instant a vehicle appears: a consumer
      // reading it before the first step would otherwise see the origin.
      this.syncView(vehicle);
      this.chooseNext(vehicle, info);
      // Inserted in order: the occupancy list is kept sorted by `along`, and a
      // plain push here would corrupt the leader lookup for the rest of the frame.
      let at = info.occupants.length;
      while (at > 0 && (info.occupants[at - 1] as Vehicle).along > along) at -= 1;
      info.occupants.splice(at, 0, vehicle);
      /*
       * ...and into the broad-phase grid, so the NEXT placement can see it.
       *
       * `rebuildIndexes` fills the grid at the top of every `update`, which is
       * enough for a respawn but not for the initial seeding: the whole fleet
       * is placed before the first frame runs, against an empty grid, so the
       * cross-lane check above saw nobody and every car was placed as though
       * it were alone. Measured: a coupe on Grand Concourse and a box lorry on
       * Ridge Road overlapping by 0.524 m three and a half seconds in.
       *
       * Inserting here costs one push per placement and is discarded by the
       * next rebuild, which is the correct lifetime for it.
       */
      const key = TrafficSim.cellKey(vehicle.x, vehicle.z);
      const cell = this.grid.get(key);
      if (cell) cell.push(vehicle);
      else {
        const fresh = this.gridPool.pop() ?? [];
        fresh.push(vehicle);
        this.grid.set(key, fresh);
      }
      return true;
    }
    return false;
  }

  private desiredSpeedFor(vehicle: Vehicle, info: LaneInfo): number {
    // A stable per-vehicle variation, so the same car is always the slow one.
    const variation = 0.9 + ((vehicle.id * 2654435761) % 1000) / 5000;
    return info.speedLimit * vehicle.blueprint.speedFactor * variation;
  }

  /**
   * Gives a driver somewhere to be going.
   *
   * Sampled from the lane graph weighted by length, so destinations are spread
   * over the city in proportion to how much street there is. That is what
   * makes the resulting traffic distribution match the network instead of
   * matching whichever corner the turn preference happens to favour.
   */
  private pickDestination(vehicle: Vehicle): void {
    if (this.spawnLanes.length === 0) {
      vehicle.destX = vehicle.x;
      vehicle.destZ = vehicle.z;
      return;
    }
    const info = this.rng.weighted(this.spawnLanes, this.spawnWeights);
    const point = lanePoint(info.lane, this.rng.range(0, info.lane.length));
    vehicle.destX = point.x;
    vehicle.destZ = point.z;
  }

  /**
   * How full a lane is, as a fraction of what it would hold at a standstill.
   *
   * Read straight off the occupancy index this frame has already built, so a
   * route decision costs a divide rather than a search.
   */
  private laneLoad(info: LaneInfo): number {
    return info.occupants.length / Math.max(1, info.lane.length / JAM_SPACING);
  }

  private chooseNext(vehicle: Vehicle, info: LaneInfo): void {
    if (info.liveExits.length === 0) {
      vehicle.reconsidered = false;
      vehicle.next = null;
      vehicle.nextArc = null;
      vehicle.turn = 0;
      return;
    }
    // Straight is preferred, then right, then left: a city where every driver
    // turns as often as they go straight reads as random rather than as traffic.
    //
    // THAT ALONE IS NOT ENOUGH, and the reason is measurable. A turn choice
    // that only looks at the shape of the junction is a random walk on the
    // street grid, and a walk that prefers to go straight REFLECTS off the
    // edge of the map: every car reaching the outer ring must join it, and the
    // one option that would take it back into the city is the one the straight
    // preference makes least likely. Measured on an uncongested fleet of forty
    // - too few cars for a queue to distort anything - the shape preference
    // alone put 2.6 times its fair share of turns onto the northern ring road
    // and a third of its fair share onto Dock Street. At the shipping fleet
    // size that became 4.4 cars per 100 m of ring against a city average of
    // 1.6, while the two arterials Meridian Bay was drawn around carried 0.5
    // and 0.9: its widest roads were its emptiest and its seafront was a car
    // park. The imbalance was in the route choice, not in the traffic.
    //
    // So a driver here weighs three more things, all of them things a real
    // driver weighs:
    //
    //  - WHERE THEY ARE GOING. This is what breaks the reflection. A driver
    //    with a destination is drawn across the city towards it rather than
    //    rattling around the edge of the map, and because destinations are
    //    drawn from the lane graph by length, the fleet ends up spread the way
    //    the street network is.
    //  - ROAD CLASS. An arterial attracts more traffic than a service street,
    //    in proportion to the speed it is posted at.
    //  - WHAT IS ALREADY THERE. A queue on the continuation is visible from
    //    the junction behind it, and a driver who can turn instead does. This
    //    is the term that makes the distribution self-levelling: any street
    //    that fills up stops attracting traffic until it drains.
    let goalX = vehicle.destX - vehicle.x;
    let goalZ = vehicle.destZ - vehicle.z;
    if (goalX * goalX + goalZ * goalZ < ARRIVAL_RADIUS * ARRIVAL_RADIUS) {
      this.pickDestination(vehicle);
      goalX = vehicle.destX - vehicle.x;
      goalZ = vehicle.destZ - vehicle.z;
    }
    const range = Math.hypot(goalX, goalZ);
    const goalUnitX = range > 1e-3 ? goalX / range : 0;
    const goalUnitZ = range > 1e-3 ? goalZ / range : 0;

    const weights: number[] = [];
    for (const candidate of info.liveExits) {
      const sweep = normaliseAngle(laneHeading(candidate) - info.heading);
      let weight = sweep > 0.5 ? 1.1 : sweep < -0.5 ? 1.7 : 3.2;
      // Forward is (-sin yaw, 0, -cos yaw); this is its dot with the bearing
      // to the destination, so +1 heads straight there and -1 straight away.
      const heading = laneHeading(candidate);
      weight *= 1 + GOAL_BIAS * (-Math.sin(heading) * goalUnitX - Math.cos(heading) * goalUnitZ);
      const next = this.laneInfo.get(candidate.id);
      if (next) {
        weight *= next.speedLimit / ROAD_CLASS_REFERENCE;
        weight /= 1 + QUEUE_AVERSION * this.laneLoad(next);
      }
      // Never zero: a merely unattractive continuation must stay reachable, or
      // a car with nowhere else to go has no legal move at all.
      weights.push(Math.max(weight, 0.02));
    }
    const chosen = this.rng.weighted(info.liveExits, weights);
    const sweep = normaliseAngle(laneHeading(chosen) - info.heading);
    vehicle.reconsidered = false;
    vehicle.next = chosen;
    vehicle.nextArc =
      info.arcs.get(chosen.id) ??
      this.buildArc(info.lane, chosen, info.exit ? info.exit.stopAlong : Number.NEGATIVE_INFINITY);
    vehicle.turn = sweep > 0.5 ? 1 : sweep < -0.5 ? -1 : 0;
  }

  // -- external inputs ------------------------------------------------------

  /**
   * Replaces the obstacle list for the coming frames. The caller owns the
   * array; the sim reads it and never keeps a copy. Pedestrians, the player on
   * foot and player-driven cars all arrive this way.
   */
  setObstacles(obstacles: readonly TrafficObstacle[]): void {
    this.obstacles = obstacles;
  }

  /**
   * Optional override so a crowd system can declare a crossing occupied before
   * anyone has physically stepped onto it. Obstacles alone already stop cars
   * for a pedestrian standing on the carriageway.
   */
  setCrossingBlocked(predicate: ((crossingId: string) => boolean) | null): void {
    this.crossingBlocked = predicate;
  }

  /**
   * Gives free bodies a world to bounce off. Optional, and installed after
   * construction because the collision world is built from the baked city and
   * the traffic system is built from the plan - neither can precede the other.
   */
  setCollision(collision: TrafficCollision | null): void {
    this.collision = collision;
  }

  // -- frame ----------------------------------------------------------------

  update(dt: number, cameraX: number, cameraZ: number, time: number): void {
    this.time = time;
    this.cameraX = cameraX;
    this.cameraZ = cameraZ;
    this.frame += 1;
    const step = clamp(dt, 0, 0.1);

    this.rebuildIndexes();

    for (const vehicle of this.vehicles) {
      if (!vehicle.active) {
        this.placeVehicle(vehicle, RESPAWN_CLEARANCE);
        continue;
      }
      if (vehicle.impactCooldown > 0) vehicle.impactCooldown -= step;
      // Smoke and fire are the only things a car does on its own once it is
      // damaged, so the check that skips it is one comparison for the fleet.
      if (vehicle.burnTimer >= 0 || vehicle.damage > 0) this.updateBurn(vehicle, step);
      const dx = vehicle.x - cameraX;
      const dz = vehicle.z - cameraZ;
      const distance = Math.hypot(dx, dz);
      if (vehicle.control === 'parked') {
        this.stepParked(vehicle, step, distance);
        continue;
      }
      if (vehicle.control === 'player') {
        // Still settle a player car on the road. `settleBody` is what reads the
        // terrain into `vehicle.y`, and it only ran inside `stepVehicle` - which
        // this branch skips. The height therefore froze at whatever it was when
        // the player took over, so driving downhill left the body climbing into
        // the sky while the driver stayed at ground level.
        this.settleBody(vehicle, step, 0);
        this.syncView(vehicle);
        continue;
      }
      if (vehicle.control === 'loose') {
        // Never coarsened. A free body lives for a few seconds, is almost
        // always the thing the player is looking at, and integrating it at a
        // quarter rate visibly changes where it ends up.
        this.stepLoose(vehicle, step, distance);
        continue;
      }
      // Simulation level of detail: distant cars are stepped less often with a
      // proportionally larger dt. IDM is stable well past 100 ms, and nothing
      // within sight of the player is ever coarsened.
      const stride = distance < 130 ? 1 : distance < 260 ? 2 : 4;
      vehicle.simAccumulator += step;
      if (stride > 1 && (this.frame + vehicle.bucket) % stride !== 0) continue;
      const vehicleStep = vehicle.simAccumulator;
      vehicle.simAccumulator = 0;
      if (vehicleStep <= 0) continue;
      this.stepVehicle(vehicle, vehicleStep, distance);
    }

    this.resolveDrivenContacts();
    this.enforceParkedLimit();

    this.views.length = 0;
    for (const vehicle of this.vehicles) {
      if (vehicle.active) this.views.push(vehicle.view);
    }
  }

  private rebuildIndexes(): void {
    for (const info of this.laneList) {
      info.occupants.length = 0;
      info.blockages.length = 0;
    }
    for (const list of this.claims.values()) list.length = 0;
    for (const list of this.grid.values()) {
      list.length = 0;
      this.gridPool.push(list);
    }
    this.grid.clear();

    this.driven.length = 0;
    for (const vehicle of this.vehicles) {
      if (!vehicle.active) continue;
      if (vehicle.control === 'ambient') {
        const info = this.laneInfo.get(vehicle.laneId);
        if (info) info.occupants.push(vehicle);
        if (vehicle.claim) this.addClaim(vehicle, vehicle.claim);
      } else if (vehicle.control === 'player') this.driven.push(vehicle);
      else if (vehicle.control === 'parked') {
        // An abandoned car is something traffic can run into, but only while
        // it is near enough for anyone to be near it: a wreck on the far side
        // of the city would cost a broad-phase walk a frame for nothing.
        const dx = vehicle.x - this.cameraX;
        const dz = vehicle.z - this.cameraZ;
        const reach = this.detailDistance;
        if (dx * dx + dz * dz < reach * reach) this.driven.push(vehicle);
      }
      const key = TrafficSim.cellKey(vehicle.x, vehicle.z);
      const cell = this.grid.get(key);
      if (cell) cell.push(vehicle);
      else {
        const fresh = this.gridPool.pop() ?? [];
        fresh.push(vehicle);
        this.grid.set(key, fresh);
      }
    }

    for (const info of this.laneList) {
      info.occupants.sort((a, b) => a.along - b.along);
    }

    this.projectObstacles();
  }

  private addClaim(vehicle: Vehicle, junctionId: string): void {
    const list = this.claims.get(junctionId);
    if (list) {
      if (!list.includes(vehicle)) list.push(vehicle);
    } else this.claims.set(junctionId, [vehicle]);
  }

  private dropClaim(vehicle: Vehicle, junctionId: string): void {
    const list = this.claims.get(junctionId);
    if (!list) return;
    const index = list.indexOf(vehicle);
    if (index >= 0) list.splice(index, 1);
  }

  private static cellKey(x: number, z: number): number {
    return (Math.floor(x / GRID_CELL) + 4096) * 8192 + (Math.floor(z / GRID_CELL) + 4096);
  }

  /**
   * Projects every obstacle onto the lanes it stands on.
   *
   * Doing it obstacle-first rather than vehicle-first is what keeps this cheap:
   * the cost is proportional to the number of pedestrians in the road, not to
   * the number of cars that might have to look for one.
   */
  private projectObstacles(): void {
    this.occupiedCrossings.clear();
    this.blockagesUsed = 0;
    if (this.obstacles.length === 0) return;

    const touched: LaneInfo[] = [];
    for (const obstacle of this.obstacles) {
      const key =
        (Math.floor(obstacle.x / GRID_CELL) + 4096) * 8192 +
        (Math.floor(obstacle.z / GRID_CELL) + 4096);

      const lanes = this.laneGrid.get(key);
      if (lanes) {
        for (const info of lanes) {
          const lane = info.lane;
          const across = lane.axis === 'x' ? obstacle.x : obstacle.z;
          if (Math.abs(across - lane.offset) > info.laneHalf + obstacle.radius) continue;
          const at = lane.axis === 'x' ? obstacle.z : obstacle.x;
          const along = (at - lane.start) * lane.travel;
          if (along < -obstacle.radius || along > lane.length + obstacle.radius) continue;
          if (info.blockages.length === 0) touched.push(info);
          let record = this.blockagePool[this.blockagesUsed];
          if (!record) {
            record = { along: 0, radius: 0 };
            this.blockagePool.push(record);
          }
          this.blockagesUsed += 1;
          record.along = along;
          record.radius = obstacle.radius;
          info.blockages.push(record);
        }
      }

      const crossings = this.crossingGrid.get(key);
      if (crossings) {
        for (const crossing of crossings) {
          const halfX = crossing.axis === 'x' ? crossing.halfSpan : crossing.halfWidth;
          const halfZ = crossing.axis === 'x' ? crossing.halfWidth : crossing.halfSpan;
          if (Math.abs(obstacle.x - crossing.x) > halfX + obstacle.radius) continue;
          if (Math.abs(obstacle.z - crossing.z) > halfZ + obstacle.radius) continue;
          this.occupiedCrossings.add(crossing.id);
        }
      }
    }

    for (const info of touched) {
      if (info.blockages.length > 1) info.blockages.sort((a, b) => a.along - b.along);
    }
  }

  // -- one vehicle ----------------------------------------------------------

  private stepVehicle(vehicle: Vehicle, dt: number, cameraDistance: number): void {
    const info = this.laneInfo.get(vehicle.laneId);
    if (!info) {
      vehicle.active = false;
      return;
    }

    // A vehicle always has a route. Recovering it here rather than assuming it
    // was set on entry keeps a vehicle placed by any other path - a test, a
    // handover, a future spawner - from running off the end of its lane.
    if (!vehicle.next && info.liveExits.length > 0) this.chooseNext(vehicle, info);

    // Re-decide the turn once, on the approach.
    //
    // The first choice is taken the instant the vehicle enters the lane, which
    // is a whole block and ten to twenty seconds before it reaches the
    // junction - far too early for the queue it is trying to avoid to still be
    // the queue that is there. Taking the decision again where a driver
    // actually takes it is what turns route choice from a statistical
    // preference into something that responds to the street ahead.
    //
    // Once only, and never after the wheel has started going over: a car that
    // changes its mind mid-turn swings back across the junction, which is far
    // worse than the queue it was avoiding.
    if (
      !vehicle.reconsidered &&
      info.exit !== null &&
      vehicle.claim === null &&
      vehicle.along > info.exit.stopAlong - RECONSIDER_RANGE
    ) {
      const committed = vehicle.nextArc;
      if (!committed || vehicle.along < committed.startAlong - 0.5) {
        this.chooseNext(vehicle, info);
      }
      vehicle.reconsidered = true;
    }

    const halfLength = vehicle.blueprint.length * 0.5;
    const chassis = vehicle.blueprint.chassis;
    vehicle.desiredSpeed = this.desiredSpeedFor(vehicle, info);

    // Once past the end of the lane the vehicle is on the junction arc and
    // committed to the turn, so the speed target becomes the corner's.
    //
    // A damaged engine is expressed as a lower TARGET rather than as a lower
    // `accelMax`, deliberately: IDM's braking term divides by the square root
    // of the acceleration limit, so scaling that towards zero makes the model
    // unstable exactly when a car is at its most fragile. Capping the speed it
    // is trying to reach produces the same behaviour - a misfiring car falls
    // back through the traffic and a dead one rolls to a stop - out of
    // arithmetic that cannot blow up.
    let desired = vehicle.desiredSpeed * vehicle.view.handling.power;
    const arc = vehicle.nextArc;
    if (arc && arc.length > 0.2 && vehicle.along > arc.startAlong) {
      desired = Math.min(desired, this.arcSpeed(arc));
    }

    let accel = idmAccel(vehicle.speed, desired, 1e6, 0, chassis.accelMax);

    const consider = (gap: number, leaderSpeed: number): void => {
      const a = idmAccel(
        vehicle.speed,
        desired,
        Math.max(gap, 0.05),
        vehicle.speed - leaderSpeed,
        chassis.accelMax,
      );
      if (a < accel) accel = a;
    };

    // 1. The vehicle in front, on this lane and then on the next one.
    const leader = this.findLaneLeader(vehicle, info);
    if (leader) consider(leader.gap, leader.speed);

    // 2. Anything physically ahead of the nose, whatever lane it thinks it is
    //    on. This is what covers junction interactions, player-driven cars and
    //    the moment a turning car cuts across a lane it does not belong to.
    const near = this.findNearestAhead(vehicle);
    if (near) consider(near.gap, near.speed);

    // 3. Obstacles standing on the carriageway - pedestrians, the player.
    const blockage = this.findBlockage(vehicle, info, halfLength);
    if (blockage !== null) consider(blockage, 0);

    // 4. A crossing with someone on it, entering or leaving the junction.
    const crossingGap = this.findCrossingStop(vehicle, info, halfLength);
    if (crossingGap !== null) consider(crossingGap, 0);

    // 5. The junction itself: signal, conflicts and room on the far side.
    const junctionGap = this.junctionConstraint(vehicle, info, halfLength);
    if (junctionGap !== null) consider(junctionGap, 0);

    // 6. The corner coming up, if the chosen continuation turns.
    if (arc && arc.length > 0.2 && vehicle.along < arc.startAlong) {
      const target = this.arcSpeed(arc);
      if (vehicle.speed > target) {
        const distance = Math.max(arc.startAlong - vehicle.along - halfLength, 0.4);
        const required = (target * target - vehicle.speed * vehicle.speed) / (2 * distance);
        if (required < accel) accel = required;
      }
    }

    const brakeLimit = chassis.brakeMax * BRAKE_LIMIT_SCALE;
    accel = clamp(accel, -brakeLimit, chassis.accelMax);

    const previousSpeed = vehicle.speed;
    vehicle.speed = Math.max(0, vehicle.speed + accel * dt);
    vehicle.accelLong = (vehicle.speed - previousSpeed) / dt;
    // Brake lamps hold briefly after the pedal comes up. Without the hold they
    // strobe every time IDM crosses zero, which is the tell of a fake car.
    if (vehicle.accelLong < -0.55 || (vehicle.speed < 0.4 && accel < 0)) vehicle.brakeHold = 0.24;
    else vehicle.brakeHold = Math.max(0, vehicle.brakeHold - dt);
    vehicle.braking = vehicle.brakeHold > 0;

    const travelled = vehicle.speed * dt;
    vehicle.along += travelled;
    vehicle.wheelSpin -= travelled / vehicle.blueprint.wheelRadius;

    this.steerAndMove(vehicle, dt, travelled);
    this.advanceLane(vehicle, info);
    this.updateClaim(vehicle);
    this.settleBody(vehicle, dt, cameraDistance);

    if (vehicle.speed < 0.15) vehicle.stuck += dt;
    else vehicle.stuck = 0;
    if (vehicle.stuck > STUCK_LIMIT) {
      // Never make a car disappear in front of the player. It waits, visibly,
      // until the camera has moved on.
      if (cameraDistance > RECYCLE_DISTANCE) this.recycle(vehicle);
      else vehicle.stuck = STUCK_LIMIT;
    }

    this.syncView(vehicle);
  }

  /** Comfortable speed through an arc, from its radius. */
  private arcSpeed(arc: TurnArc): number {
    if (arc.length <= 0.2 || Math.abs(arc.sweep) < 0.05) return 1e6;
    const radius = arc.length / Math.abs(arc.sweep);
    return Math.max(2.2, Math.sqrt(TURN_COMFORT * radius));
  }

  // -- perception -----------------------------------------------------------

  private findLaneLeader(
    vehicle: Vehicle,
    info: LaneInfo,
  ): { gap: number; speed: number } | null {
    const halfLength = vehicle.blueprint.length * 0.5;
    const list = info.occupants;
    const index = list.indexOf(vehicle);
    if (index >= 0 && index + 1 < list.length) {
      const ahead = list[index + 1] as Vehicle;
      return {
        gap: ahead.along - ahead.blueprint.length * 0.5 - vehicle.along - halfLength,
        speed: ahead.speed,
      };
    }
    if (!vehicle.next) return null;
    const nextInfo = this.laneInfo.get(vehicle.next.id);
    if (!nextInfo || nextInfo.occupants.length === 0) return null;
    const first = nextInfo.occupants[0] as Vehicle;
    const arc = vehicle.nextArc;
    const boundary = arc ? arc.startAlong + arc.length : info.lane.length;
    const entry = arc ? arc.endAlong : 0;
    const gap =
      boundary - vehicle.along - halfLength + (first.along - entry) - first.blueprint.length * 0.5;
    return { gap, speed: first.speed };
  }

  /**
   * Nearest thing physically in front of the nose, from the broad-phase grid.
   *
   * The 1-D lane model cannot see a car that is crossing a junction on another
   * lane, and it cannot see a player-driven car at all. This can.
   */
  private findNearestAhead(vehicle: Vehicle): { gap: number; speed: number } | null {
    const fx = -Math.sin(vehicle.yaw);
    const fz = -Math.cos(vehicle.yaw);
    const rx = Math.cos(vehicle.yaw);
    const rz = -Math.sin(vehicle.yaw);
    const halfLength = vehicle.blueprint.length * 0.5;
    const halfWidth = vehicle.blueprint.width * 0.5;
    // Twenty metres, fixed. Shortening it at low speed was tried, to stop a
    // turning car sweeping its cone across the queue on the cross street: it
    // gained a little junction throughput and cost the collision guarantee,
    // because a car creeping through a box then cannot see far enough ahead.
    // Measured, over ten minutes of city traffic: 0 interpenetrations at 20 m,
    // 504 at a speed-scaled reach.
    const reach = 20;

    let best: { gap: number; speed: number } | null = null;
    const cx = Math.floor(vehicle.x / GRID_CELL);
    const cz = Math.floor(vehicle.z / GRID_CELL);
    const span = Math.ceil(reach / GRID_CELL);
    for (let ix = cx - span; ix <= cx + span; ix += 1) {
      for (let iz = cz - span; iz <= cz + span; iz += 1) {
        const cell = this.grid.get((ix + 4096) * 8192 + (iz + 4096));
        if (!cell) continue;
        for (const other of cell) {
          if (other === vehicle || !other.active) continue;
          const dx = other.x - vehicle.x;
          const dz = other.z - vehicle.z;
          const forward = dx * fx + dz * fz;
          if (forward <= 0 || forward > reach) continue;
          const lateral = Math.abs(dx * rx + dz * rz);
          const otherHalfWidth = other.blueprint.width * 0.5;
          if (lateral > halfWidth + otherHalfWidth + 0.25) continue;
          // Project the other car's extent onto our forward axis so a car
          // sitting across our path is measured by its near edge.
          const ofx = -Math.sin(other.yaw);
          const ofz = -Math.cos(other.yaw);
          const orx = Math.cos(other.yaw);
          const orz = -Math.sin(other.yaw);
          const extent =
            Math.abs((ofx * fx + ofz * fz) * (other.blueprint.length * 0.5)) +
            Math.abs((orx * fx + orz * fz) * otherHalfWidth);
          const gap = forward - halfLength - extent;
          if (!best || gap < best.gap) {
            best = { gap, speed: Math.max(0, other.speed * (ofx * fx + ofz * fz)) };
          }
        }
      }
    }
    return best;
  }

  private findBlockage(vehicle: Vehicle, info: LaneInfo, halfLength: number): number | null {
    let gap: number | null = null;
    for (const blockage of info.blockages) {
      const distance = blockage.along - blockage.radius - vehicle.along - halfLength;
      if (distance < -0.5) continue;
      if (distance > 34) break;
      gap = distance;
      break;
    }
    if (vehicle.next) {
      const nextInfo = this.laneInfo.get(vehicle.next.id);
      if (nextInfo && nextInfo.blockages.length > 0) {
        const first = nextInfo.blockages[0] as { along: number; radius: number };
        const arc = vehicle.nextArc;
        const boundary = arc ? arc.startAlong + arc.length : info.lane.length;
        const distance =
          boundary - vehicle.along - halfLength + (first.along - (arc ? arc.endAlong : 0)) - first.radius;
        if (distance >= -0.5 && distance < 34 && (gap === null || distance < gap)) gap = distance;
      }
    }
    return gap;
  }

  private crossingOccupied(crossing: Crossing): boolean {
    if (this.occupiedCrossings.has(crossing.id)) return true;
    return this.crossingBlocked?.(crossing.id) === true;
  }

  private findCrossingStop(
    vehicle: Vehicle,
    info: LaneInfo,
    halfLength: number,
  ): number | null {
    let gap: number | null = null;
    if (info.exit?.crossing && this.crossingOccupied(info.exit.crossing)) {
      const distance = info.exit.crossingAlong - vehicle.along - halfLength;
      if (distance > -1) gap = distance;
    }
    if (info.entry?.crossing && this.crossingOccupied(info.entry.crossing)) {
      const distance = info.entry.crossingAlong - vehicle.along - halfLength;
      if (distance > -1 && (gap === null || distance < gap)) gap = distance;
    }
    return gap;
  }

  // -- junctions ------------------------------------------------------------

  /**
   * Returns the gap to the stop line when the vehicle may not proceed, or null
   * when it may. Signals gate every approach; the conflict, clearance and
   * oncoming rules only apply close in, where they are what a driver actually
   * looks at.
   */
  private junctionConstraint(
    vehicle: Vehicle,
    info: LaneInfo,
    halfLength: number,
  ): number | null {
    const exit = info.exit;
    if (!exit) return null;
    if (vehicle.claim === exit.junction.id) return null;
    const distance = exit.stopAlong - vehicle.along - halfLength;
    if (distance < -0.6) {
      // Already over the line: commit rather than stop in the middle of a
      // box. Whether it should ever have got this far is decided upstream, by
      // the committed-approach rule in `junctionConflict`.
      vehicle.claim = exit.junction.id;
      this.addClaim(vehicle, exit.junction.id);
      return null;
    }

    const state = signalFor(exit.junction, info.lane.axis, this.time);
    if (state === 'red') return Math.max(distance, 0);
    if (state === 'amber') {
      // Stop if it can be done without standing on the brakes.
      const stopping = (vehicle.speed * vehicle.speed) / (2 * BRAKE_COMFORT);
      if (distance > stopping) return Math.max(distance, 0);
    }

    if (distance > ADMISSION_RANGE) return null;

    if (!this.exitHasRoom(vehicle)) return Math.max(distance, 0);
    if (this.junctionConflict(vehicle, info, exit.junction)) return Math.max(distance, 0);

    if (distance <= 0.9) {
      vehicle.claim = exit.junction.id;
      this.addClaim(vehicle, exit.junction.id);
    }
    return null;
  }

  /**
   * Never enter a junction without somewhere to be on the far side of it.
   *
   * This is the rule that stops a city gridlocking, and how it decides matters
   * more than whether it exists. Two versions were wrong before this one. The
   * strict version - is there room RIGHT NOW - throttled every junction to
   * about one vehicle every two and a half seconds, below the demand this city
   * generates, so a green never cleared its own queue. The version that
   * replaced it waived the check entirely for a leader moving faster than
   * 2.5 m/s, which is a cliff: a car pulling away at 2.6 m/s let a whole
   * queue in behind it and then stopped, and every vehicle that had committed
   * on the strength of that was left standing in the box. Anything on the
   * crossing axis then had nowhere to go either, and because a junction with
   * a stopped car in it refuses all four approaches, the block spread outwards
   * and never recovered. Measured over fifteen minutes with the camera held
   * still, the fleet fell from 3.1 m/s and a third standing to 1.1 m/s and
   * three quarters standing - a city that visibly slid into gridlock the
   * longer it was watched.
   *
   * The rule here asks the question a driver actually asks: will there be room
   * by the time I get across? The leader's own speed carries it forward while
   * the turn is happening, so a leader genuinely pulling away opens the gap
   * and one that is merely rolling does not. It is the same test at every
   * speed rather than two different tests either side of a threshold, and it
   * held the same fifteen-minute run at 2.2 m/s and half standing.
   */
  private exitHasRoom(vehicle: Vehicle): boolean {
    if (!vehicle.next) return true;
    const nextInfo = this.laneInfo.get(vehicle.next.id);
    if (!nextInfo || nextInfo.occupants.length === 0) return true;
    const first = nextInfo.occupants[0] as Vehicle;
    const entry = vehicle.nextArc?.endAlong ?? 0;
    const needed = vehicle.blueprint.length + first.blueprint.length * 0.5 + 1.6;
    return first.along - entry + first.speed * EXIT_LOOKAHEAD > needed;
  }

  /**
   * True when something already in the junction conflicts with this movement.
   *
   * Two flows on the same axis travelling the same way never conflict. Opposing
   * flows conflict only when exactly one of them is turning left across the
   * other. Anything on the other axis conflicts outright: it should not be
   * there under the signal plan, but a car that entered on amber still is, and
   * that is precisely the moment worth protecting.
   */
  private junctionConflict(vehicle: Vehicle, info: LaneInfo, junction: Junction): boolean {
    // Whoever already holds the junction. This is what makes entry exclusive:
    // a claim is granted synchronously inside the vehicle loop, so two drivers
    // cannot both find the box free in the same frame.
    const holders = this.claims.get(junction.id);
    if (holders) {
      for (const other of holders) {
        if (other === vehicle || !other.active) continue;
        if (this.movementsConflict(vehicle, info, other)) return true;
      }
    }

    // Anything physically inside the box, claim or not: a car seeded there at
    // start-up, or one that entered on amber, has none.
    // A car that entered on amber, or that was seeded mid-junction at start-up,
    // has no claim and is exactly what this needs to see.
    const reachX = junction.halfX + 3;
    const reachZ = junction.halfZ + 3;
    const span = Math.ceil((Math.max(reachX, reachZ) + GRID_CELL) / GRID_CELL);
    const cx = Math.floor(junction.x / GRID_CELL);
    const cz = Math.floor(junction.z / GRID_CELL);
    for (let ix = cx - span; ix <= cx + span; ix += 1) {
      for (let iz = cz - span; iz <= cz + span; iz += 1) {
        const cell = this.grid.get((ix + 4096) * 8192 + (iz + 4096));
        if (!cell) continue;
        for (const other of cell) {
          if (other === vehicle || !other.active) continue;
          if (Math.abs(other.x - junction.x) > reachX) continue;
          if (Math.abs(other.z - junction.z) > reachZ) continue;
          if (this.movementsConflict(vehicle, info, other)) return true;
        }
      }
    }

    /*
     * Do not take the box in front of a car that can no longer stop.
     *
     * Admission is granted at `distance <= 0.9`, but a conflicting driver on
     * another approach may already be inside its own braking distance of its
     * own line. Claiming ahead of that car does not stop it - nothing can -
     * it simply arrives anyway, hits the `distance < -0.6` commit path, takes
     * the same junction and drives into whoever is in it.
     *
     * Measured before this rule: a pickup and a saloon on opposite approaches
     * of Anchor Street, both turning into Ferro Street, both holding
     * `j:ferro-street:anchor-street`, both stopped, overlapping by 0.223 m,
     * and still there 69 seconds later when `STUCK_LIMIT` recycled one.
     *
     * Yielding is the cheap side of this trade. The car that waits is the one
     * that CAN wait, by construction, and it waits about as long as the other
     * takes to cross - whereas the alternative, refusing the commit, stops a
     * car inside the box and was measured costing five points of arterial
     * density and seven points of twelve-minute flow.
     */
    const approaches = this.junctionApproaches.get(junction.id);
    for (const approachInfo of approaches ?? []) {
      if (approachInfo === info || !approachInfo.exit) continue;
      // The last occupant is the one nearest the line; nobody behind it can be
      // committed while it is not.
      for (let i = approachInfo.occupants.length - 1; i >= 0; i -= 1) {
        const other = approachInfo.occupants[i] as Vehicle;
        if (other === vehicle || !other.active) continue;
        const toLine =
          approachInfo.exit.stopAlong - other.along - other.blueprint.length * 0.5;
        // Behind its line and able to pull up: it is not committed, and the
        // ordinary claim exclusion covers it.
        if (toLine < 0) break;
        const stopping = (other.speed * other.speed) / (2 * BRAKE_COMFORT);
        if (toLine > stopping) break;
        if (this.movementsConflict(vehicle, approachInfo, other)) return true;
        break;
      }
    }

    // A left turn also yields to oncoming traffic that has not arrived yet.
    // The gap a driver will accept shrinks the longer they have been sitting
    // there: without that, one waiting left-turner blocks the single lane
    // behind it for a whole cycle and the queue never recovers.
    //
    // THE GAP IS MEASURED IN TIME, and that is not a detail. The first version
    // of this measured it in distance - `toJunction < other.speed * patience +
    // 6` - which has a floor of six metres that no amount of patience removes.
    // An oncoming car STANDING at its own stop line is inside six metres and
    // is going nowhere, so the left-turner yielded to it forever; two opposing
    // queues, each headed by a left-turner, each yielded to the other's
    // stationary head car and neither ever moved again. Measured over fifteen
    // minutes on a fixed camera, that took the fleet from 3.1 m/s and a third
    // standing to 1.1 m/s and three quarters standing - a city that visibly
    // slid into gridlock the longer it was watched, which is exactly what it
    // looked like.
    //
    // Time to arrive fixes it by construction: a car that is not moving does
    // not arrive. The speed floor keeps a car that is about to pull away from
    // reading as harmless, and a head car that has been standing for longer
    // than the turn itself takes is a queue rather than a hazard.
    if (vehicle.turn === 1 && info.oncoming) {
      const oncomingInfo = this.laneInfo.get(info.oncoming.id);
      if (oncomingInfo) {
        const patience = clamp(2.2 - vehicle.stuck * 0.06, 1.3, 2.2);
        for (let i = oncomingInfo.occupants.length - 1; i >= 0; i -= 1) {
          const other = oncomingInfo.occupants[i] as Vehicle;
          const toJunction = oncomingInfo.lane.length - other.along;
          if (toJunction < -other.blueprint.length) break;
          /*
           * The oncoming car is already IN the box.
           *
           * This used to wave our driver through whenever that car was also
           * turning - `return other.turn !== 1` - on the reasoning that two
           * opposing left-turners pass each other driver's side to driver's
           * side. Real junctions are often marked for exactly that. These
           * ones are not: the two turn arcs this simulation builds cross, and
           * `movementsConflict` says so everywhere else in the file. One rule
           * said conflict and this one said clear, so both cars entered.
           *
           * Measured before the change: a pickup and a saloon on opposite
           * approaches of Anchor Street, both turning into Ferro Street, both
           * holding `j:ferro-street:anchor-street`, both stopped, overlapping
           * by 0.223 m - and still there 69 seconds later, when `STUCK_LIMIT`
           * finally recycled one of them.
           *
           * Yielding here is bounded: a car inside the box is leaving it, so
           * this is a wait of a second or two, not the standing-queue deadlock
           * the time-based gap below exists to prevent.
           */
          if (toJunction < 0) return true;
          if (toJunction < other.speed * patience + 6) return true;
          break;
        }
      }
    }
    return false;
  }

  /**
   * Whether two movements through the same junction cross.
   *
   * Same axis and same direction never conflict. Opposing directions conflict
   * as soon as either is turning left across the other, including two cars
   * turning left towards each other: their arcs are wide enough to meet in the
   * middle of the box. Anything on the other axis conflicts outright - the
   * signal plan should have kept it out, and a car that beat the amber is
   * exactly the case worth protecting against.
   */
  private movementsConflict(vehicle: Vehicle, info: LaneInfo, other: Vehicle): boolean {
    const otherInfo = this.laneInfo.get(other.laneId);
    // Anything the traffic AI is not driving has no meaningful lane - a driven
    // car, a wreck, an abandoned one - so never contest a junction with it.
    if (other.control !== 'ambient' || !otherInfo) return true;
    if (otherInfo.lane.axis !== info.lane.axis) return true;
    if (otherInfo.lane.travel === info.lane.travel) return false;
    return vehicle.turn === 1 || other.turn === 1;
  }

  /** Clears a junction claim once the vehicle is physically out of the box. */
  private updateClaim(vehicle: Vehicle): void {
    if (!vehicle.claim) return;
    const junction = this.network.junctionById.get(vehicle.claim);
    if (!junction) {
      this.dropClaim(vehicle, vehicle.claim);
      vehicle.claim = null;
      return;
    }
    const dx = Math.abs(vehicle.x - junction.x) - junction.halfX;
    const dz = Math.abs(vehicle.z - junction.z) - junction.halfZ;
    const clear = vehicle.blueprint.length * 0.5 + CLEAR_MARGIN;
    if (dx > clear || dz > clear) {
      this.dropClaim(vehicle, vehicle.claim);
      vehicle.claim = null;
    }
  }

  // -- movement -------------------------------------------------------------

  /** World point at a distance along the vehicle's planned path. */
  pathAt(vehicle: Vehicle, distance: number): { x: number; z: number } {
    const info = this.laneInfo.get(vehicle.laneId);
    if (!info) return { x: vehicle.x, z: vehicle.z };
    const s = vehicle.along + distance;
    const arc = vehicle.nextArc;
    const turnStart = arc ? arc.startAlong : info.lane.length;

    if (s <= turnStart) return lanePoint(info.lane, s);
    if (arc && arc.length > 0.2) {
      const over = s - turnStart;
      if (over < arc.length) return bezier(arc, over / arc.length);
      if (vehicle.next) return lanePoint(vehicle.next, arc.endAlong + over - arc.length);
    }
    if (vehicle.next) return lanePoint(vehicle.next, s - info.lane.length);
    return lanePoint(info.lane, s);
  }

  /**
   * Pure-pursuit steering, then a kinematic bicycle step.
   *
   * The lookahead grows with speed - a driver looks further down the road the
   * faster they go - and the steering angle is limited three ways: by the rack
   * (`maxSteer`), by how fast the wheel can be turned (`steerRate`), and by
   * grip, which is what produces believable understeer when a van tries to take
   * a corner as fast as a coupe.
   */
  private steerAndMove(vehicle: Vehicle, dt: number, travelled: number): void {
    const chassis = vehicle.blueprint.chassis;
    const lookahead = clamp(3.4 + vehicle.speed * 0.62, 3.4, 13);
    const target = this.pathAt(vehicle, lookahead);

    const dx = target.x - vehicle.x;
    const dz = target.z - vehicle.z;
    const fx = -Math.sin(vehicle.yaw);
    const fz = -Math.cos(vehicle.yaw);
    const rx = Math.cos(vehicle.yaw);
    const rz = -Math.sin(vehicle.yaw);
    const forward = dx * fx + dz * fz;
    const lateral = dx * rx + dz * rz;
    const range = Math.max(Math.hypot(dx, dz), 0.4);

    // Pure pursuit: sin(alpha) is the lateral error over the lookahead range,
    // and the wheel angle that arcs onto the target follows directly from it.
    const sinAlpha = clamp(-lateral / range, -1, 1);
    let wanted = Math.atan2(2 * chassis.wheelbase * sinAlpha, range);
    if (forward < 0) wanted = Math.sign(sinAlpha) * chassis.maxSteer;
    // A flat tyre drags the car towards its own side. Added to what the driver
    // wants rather than to the steering angle itself, so they can hold it
    // straight - badly - instead of being steered off the road.
    const handling = vehicle.view.handling;
    wanted += handling.pull;

    // Grip ceiling: v^2 * tan(d) / L must stay under what the tyres will hold,
    // less whatever the tyres have already lost.
    const speed = Math.max(vehicle.speed, 0.5);
    const gripSteer = Math.atan(
      (chassis.gripLateral * handling.grip * chassis.wheelbase) / (speed * speed),
    );
    const limit = Math.min(chassis.maxSteer, gripSteer);
    wanted = clamp(wanted, -limit, limit);

    // Rate limit, easing off with speed the way a real rack does.
    const rate = chassis.steerRate / (1 + vehicle.speed * 0.08);
    const delta = clamp(wanted - vehicle.steer, -rate * dt, rate * dt);
    vehicle.steer += delta;

    const yawRate = (vehicle.speed * Math.tan(vehicle.steer)) / chassis.wheelbase;
    vehicle.yaw = normaliseAngle(vehicle.yaw + yawRate * dt);
    vehicle.accelLat = vehicle.speed * yawRate;

    vehicle.x += -Math.sin(vehicle.yaw) * travelled;
    vehicle.z += -Math.cos(vehicle.yaw) * travelled;

    // A recycled or newly placed vehicle can start off the line; pull it back
    // gently rather than letting pure pursuit fight a large offset.
    const here = this.pathAt(vehicle, 0);
    const offX = here.x - vehicle.x;
    const offZ = here.z - vehicle.z;
    const off = Math.hypot(offX, offZ);
    if (off > 1.6) {
      const pull = Math.min(1, (off - 1.6) * 0.5 * dt * 6);
      vehicle.x += offX * pull;
      vehicle.z += offZ * pull;
    }
  }

  /** Moves the vehicle onto its next lane once it has left this one. */
  private advanceLane(vehicle: Vehicle, info: LaneInfo): void {
    const arc = vehicle.nextArc;
    const boundary = arc ? arc.startAlong + arc.length : info.lane.length;
    if (vehicle.along < boundary) return;

    const next = vehicle.next;
    if (!next) {
      // The graph offers no continuation here. Recycling is the honest answer:
      // spinning the car round on the spot is the single most obvious way for
      // traffic to read as fake.
      this.recycle(vehicle);
      return;
    }
    const nextInfo = this.laneInfo.get(next.id);
    if (!nextInfo) {
      this.recycle(vehicle);
      return;
    }
    vehicle.along = vehicle.along - boundary + (arc ? arc.endAlong : 0);
    vehicle.laneId = next.id;
    this.chooseNext(vehicle, nextInfo);
  }

  /** Returns a vehicle to the pool; it reappears elsewhere on the next frame. */
  private recycle(vehicle: Vehicle): void {
    vehicle.active = false;
    if (vehicle.claim) this.dropClaim(vehicle, vehicle.claim);
    vehicle.claim = null;
    vehicle.stuck = 0;
    vehicle.speed = 0;
    this.unpark(vehicle);
    vehicle.abandoned = false;
    vehicle.control = 'ambient';
    vehicle.view.control = 'ambient';
    vehicle.view.state = 'ambient';
  }

  // -- impacts and free bodies ----------------------------------------------

  /**
   * Applies one collision to one vehicle. Returns true if it took the hit.
   *
   * THE WHOLE POINT of this method is that a struck car goes where it was
   * actually hit. The impulse divided by the chassis mass is the change in
   * velocity, so a hatchback is thrown by what a box truck shrugs off; the
   * moment of that impulse about the centre of mass is the yaw, so a corner
   * hit spins the car and a square one does not; and its lateral component
   * acting at the contact height above the tyres is the roll, so a hard enough
   * side impact takes the car over. Nothing here is a special case - all three
   * come out of the same impulse and the same chassis numbers.
   *
   * Once past `LOOSE_TRIGGER` the vehicle leaves the traffic AI entirely and
   * integrates as a free body until it stops. A `player` vehicle cannot be
   * moved from here - somebody else owns its pose - so its impulse is banked
   * for `takeImpulse` instead.
   */
  applyImpact(vehicleId: number, hit: VehicleImpact): boolean {
    const vehicle = this.vehicles.find((v) => v.id === vehicleId && v.active);
    if (!vehicle) return false;
    // One contact lasts many frames. Without this, standing on a car with the
    // throttle open would integrate the same impulse at the frame rate.
    if (vehicle.impactCooldown > 0) return false;
    vehicle.impactCooldown = IMPACT_COOLDOWN;

    const chassis = vehicle.blueprint.chassis;
    const mass = Math.max(1, chassis.mass);
    const impulse = Math.max(0, hit.impulse);
    const jx = hit.dirX * impulse;
    const jz = hit.dirZ * impulse;
    const deltaV = impulse / mass;

    this.damage(vehicle, hit.damage, hit.x, hit.y, hit.z, true);
    this.report(hit.x, hit.y, hit.z, deltaV / 12, 'vehicle');

    if (vehicle.control === 'player') {
      const pending = this.pendingImpulses.get(vehicleId);
      const rx = hit.x - vehicle.x;
      const rz = hit.z - vehicle.z;
      // Torque about +Y. Pushing the right-hand side forward swings the nose
      // left, which is the positive yaw direction in this game's convention.
      const yaw = rz * jx - rx * jz;
      if (pending) {
        pending.x += jx;
        pending.z += jz;
        pending.yaw += yaw;
        pending.damage += hit.damage;
      } else {
        this.pendingImpulses.set(vehicleId, { x: jx, z: jz, yaw, damage: hit.damage });
      }
      return true;
    }

    if (vehicle.control === 'ambient' || vehicle.control === 'parked') {
      if (deltaV < LOOSE_TRIGGER) {
        if (vehicle.control === 'ambient') {
          // Felt, not freed: spend it on the driver's own speed and let them
          // carry on. Anything else turns a kerbside scrape into a recovery.
          const fx = -Math.sin(vehicle.yaw);
          const fz = -Math.cos(vehicle.yaw);
          vehicle.speed = Math.max(0, vehicle.speed + (jx * fx + jz * fz) / mass);
          return true;
        }
        // A parked car has no driver to absorb it. The shove goes into the
        // body and `stepParked` bleeds it off against the road, which is what
        // makes nudging an abandoned car rock it rather than nothing at all.
        vehicle.vx += jx / mass;
        vehicle.vz += jz / mass;
        vehicle.parkedAtRest = false;
        return true;
      }
      this.goLoose(vehicle);
    }

    vehicle.vx += jx / mass;
    vehicle.vz += jz / mass;

    // Yaw. A box's moment of inertia about its vertical axis is m(L2 + W2)/12.
    const length = vehicle.blueprint.length;
    const width = vehicle.blueprint.width;
    const yawInertia = (mass * (length * length + width * width)) / 12;
    const rx = hit.x - vehicle.x;
    const rz = hit.z - vehicle.z;
    vehicle.yawRate = clamp(
      vehicle.yawRate + (rz * jx - rx * jz) / yawInertia,
      -MAX_YAW_RATE,
      MAX_YAW_RATE,
    );

    // Roll. The lateral component acts at the contact height above the tyres,
    // and the body pivots over the tyres it is being pushed onto - which is
    // why a car tips in the direction of the hit, not away from it. Positive
    // roll is right-side-up, so a shove to the driver's right rolls negative.
    const rightX = Math.cos(vehicle.yaw);
    const rightZ = -Math.sin(vehicle.yaw);
    const lateral = jx * rightX + jz * rightZ;
    const lever = Math.max(0, hit.y - vehicle.y);
    const halfTrack = chassis.track * 0.5;
    const comHeight = vehicle.blueprint.height * 0.45;
    const rollInertia = mass * (halfTrack * halfTrack + comHeight * comHeight);
    vehicle.rollRate = clamp(
      vehicle.rollRate - (lateral * lever) / rollInertia,
      -MAX_ROLL_RATE,
      MAX_ROLL_RATE,
    );

    return true;
  }

  /**
   * Structural damage with no impulse behind it - gunfire, fire, an explosion
   * felt at a distance. Returns true if the vehicle existed and took it.
   *
   * Deliberately NOT subject to `IMPACT_COOLDOWN`: a rifle fires far faster
   * than the cooldown and every round has to count.
   *
   * The world point is where the round landed, and it is what makes damage
   * LOCAL: rounds into a bonnet kill the engine, rounds into a wheel arch flat
   * the tyre, rounds through a window take the glazing out. Omit it and the
   * damage is spread evenly over the shell, which is what every caller that
   * does not know where it hit gets.
   */
  applyDamage(vehicleId: number, amount: number, x?: number, y?: number, z?: number): boolean {
    const vehicle = this.vehicles.find((v) => v.id === vehicleId && v.active);
    if (!vehicle || !(amount > 0)) return false;
    const located = x !== undefined && y !== undefined && z !== undefined;
    this.damage(vehicle, amount, x ?? 0, y ?? 0, z ?? 0, located);
    return true;
  }

  /**
   * Collects and clears the impulse banked for a driven vehicle, in newton
   * seconds, or null when nothing hit it. Allocates only on a real contact.
   */
  takeImpulse(vehicleId: number): { x: number; z: number; yaw: number; damage: number } | null {
    const pending = this.pendingImpulses.get(vehicleId);
    if (!pending) return null;
    this.pendingImpulses.delete(vehicleId);
    return pending;
  }

  /**
   * Structural damage, optionally at a point on the body.
   *
   * TWO ACCOUNTS ARE KEPT, and they are not a partition of each other. The
   * integrity total is the whole shell and decides when the car is a write-off.
   * The regions are where the damage landed, and they decide what still works:
   * an engine bay can be finished long before the car as a whole is, which is
   * exactly what happens when somebody empties half a magazine into a bonnet.
   *
   * `located` is false for damage with no position - a scrape charged after
   * the fact, a test - and the points are spread evenly over the four panels.
   */
  private damage(
    vehicle: Vehicle,
    amount: number,
    x: number,
    y: number,
    z: number,
    located: boolean,
  ): void {
    if (!(amount > 0)) return;
    const wasWreck = vehicle.integrity <= 0;
    vehicle.integrity = Math.max(0, vehicle.integrity - amount);
    vehicle.damage = 1 - vehicle.integrity / VEHICLE_INTEGRITY;

    // One blow worth a quarter of the shell is a blast, not a bullet. See
    // `BLAST_SHARE`: it is what puts every window out and shreds the tyres on
    // the struck side, and it is the entire difference between being shot at
    // and being on the receiving end of a warhead.
    const blast = amount >= VEHICLE_INTEGRITY * BLAST_SHARE;
    const points = vehicle.regionPoints;

    let front = 0.25;
    let rear = 0.25;
    let left = 0.25;
    let right = 0.25;
    let glassShare = blast ? 1 : 0;
    let tyre = -1;
    let tyreShare = 0;

    if (located) {
      const fx = -Math.sin(vehicle.yaw);
      const fz = -Math.cos(vehicle.yaw);
      const rx = Math.cos(vehicle.yaw);
      const rz = -Math.sin(vehicle.yaw);
      const dx = x - vehicle.x;
      const dz = z - vehicle.z;
      const alongM = dx * fx + dz * fz;
      const acrossM = dx * rx + dz * rz;
      const halfLength = vehicle.blueprint.length * 0.5;
      const halfWidth = vehicle.blueprint.width * 0.5;
      const along = clamp(alongM / halfLength, -1, 1);
      const across = clamp(acrossM / halfWidth, -1, 1);
      // A blast wraps around the body and a bullet lands on one panel, so the
      // only difference between them is the floor under every region.
      const spread = blast ? 0.5 : 0.04;
      front = Math.max(0, along) + spread;
      rear = Math.max(0, -along) + spread;
      right = Math.max(0, across) + spread;
      left = Math.max(0, -across) + spread;

      // `vehicle.y` is the ground contact plane, so this is height up the body
      // and `beltY` is where the glazing starts on every shape in the fleet.
      const height = y - vehicle.y;
      const belt = vehicle.blueprint.beltY;
      if (!blast) glassShare = smoothstep(belt - 0.12, belt + 0.12, height);

      // Low, outboard and beside an axle is a tyre rather than a panel.
      const wheel = vehicle.blueprint.wheelRadius;
      if (!blast && height < wheel * 2 && Math.abs(across) > 0.45) {
        const chassis = vehicle.blueprint.chassis;
        const nearFront = Math.abs(alongM - chassis.frontAxle) < wheel * 2.2;
        const nearRear = Math.abs(alongM - (chassis.frontAxle - chassis.wheelbase)) < wheel * 2.2;
        if (nearFront || nearRear) {
          tyre = (nearFront ? 0 : 2) + (acrossM > 0 ? 1 : 0);
          tyreShare = 1;
        }
      } else if (blast) {
        // A blast takes the tyres on the side it came from with it. At 0.18 a
        // warhead's 190 points burst both near-side tyres outright and a
        // hard side impact - about 110 points - leaves them half gone, which
        // is the right ordering between the two.
        const nearSide = acrossM > 0 ? 1 : 0;
        points.tyres[nearSide] = (points.tyres[nearSide] as number) + amount * 0.18;
        points.tyres[nearSide + 2] = (points.tyres[nearSide + 2] as number) + amount * 0.18;
      }
    }

    // A round that went into a wheel did not also crumple the door beside it.
    const panelScale = tyre >= 0 ? 0.3 : 1;
    // NORMALISED BY THE PEAK, not by the sum, and only when the hit has a
    // place. The panel the round actually went through takes the damage it
    // actually did - four rifle rounds in a bonnet are four rounds' worth of
    // bonnet - and the neighbours take the spread floor's share of it. Divide
    // by the sum instead and a point hit loses a sixth of its effect to panels
    // it never touched, which makes the numbers impossible to reason about
    // from the outside. Damage with no location has no peak to speak of, so it
    // really is divided four ways.
    const peak = located
      ? Math.max(front, rear, left, right)
      : front + rear + left + right;
    const share = (amount * panelScale) / peak;
    points.front += front * share;
    points.rear += rear * share;
    points.left += left * share;
    points.right += right * share;
    if (glassShare > 0) points.glass += amount * glassShare;
    if (tyre >= 0) points.tyres[tyre] = (points.tyres[tyre] as number) + amount * tyreShare;

    if (!wasWreck && vehicle.integrity <= 0) this.writeOff(vehicle);
    this.syncDamage(vehicle);
  }

  /**
   * The moment a shell stops being a car.
   *
   * A write-off never drives again: an ambient one is cut loose so it coasts
   * to a stop where it was rather than continuing down its lane with no
   * engine, and every one of them is flagged `abandoned` so that when it does
   * stop it becomes a wreck rather than rejoining traffic. The fire starts
   * here, and `updateBurn` carries it.
   */
  private writeOff(vehicle: Vehicle): void {
    vehicle.abandoned = true;
    if (vehicle.burnTimer < 0) vehicle.burnTimer = 0;
    if (vehicle.control === 'ambient') this.goLoose(vehicle);
  }

  /**
   * Recomputes the published damage fractions and what they do to the driving.
   *
   * Called after every damage event rather than every frame: damage only ever
   * changes when something hits the car, and the renderer and the driving
   * layer both read the result once a frame.
   */
  private syncDamage(vehicle: Vehicle): void {
    const points = vehicle.regionPoints;
    const view = vehicle.view;
    const regions = view.regions;
    regions.front = Math.min(1, points.front / REGION_CAPACITY);
    regions.rear = Math.min(1, points.rear / REGION_CAPACITY);
    regions.left = Math.min(1, points.left / REGION_CAPACITY);
    regions.right = Math.min(1, points.right / REGION_CAPACITY);
    regions.glass = Math.min(1, points.glass / GLASS_CAPACITY);

    let flats = 0;
    let pull = 0;
    for (let i = 0; i < 4; i += 1) {
      const wear = Math.min(1, (points.tyres[i] as number) / TYRE_CAPACITY);
      regions.tyres[i] = wear;
      flats += wear;
      // Even indexes are the near side. A flat on the left drags the car left,
      // and positive yaw is left in this game's convention.
      pull += (i % 2 === 0 ? 1 : -1) * wear;
    }

    const destroyed = vehicle.integrity <= 0;
    const handling = view.handling;
    handling.destroyed = destroyed;
    handling.power = destroyed
      ? 0
      : clamp(1 - (regions.front - ENGINE_SOFT) / (ENGINE_DEAD - ENGINE_SOFT), 0, 1);
    // A car on three tyres still steers, badly. The floor is what stops the
    // grip limit collapsing to a straight line the model cannot follow.
    handling.grip = Math.max(0.3, 1 - flats * TYRE_GRIP_LOSS);
    handling.pull = pull * TYRE_PULL;
    view.destroyed = destroyed;
  }

  /**
   * Smoke and fire over time.
   *
   * An engine bay past `SMOKE_ONSET` steams; a write-off catches, burns for
   * `FIRE_SECONDS` and then goes out, leaving a blackened shell that smoulders
   * away to nothing. The shell itself stays: the fire is the only part of a
   * destroyed car that is temporary.
   */
  private updateBurn(vehicle: Vehicle, dt: number): void {
    const view = vehicle.view;
    if (vehicle.burnTimer < 0) {
      view.fire = 0;
      view.smoke = clamp((view.regions.front - SMOKE_ONSET) / (1 - SMOKE_ONSET), 0, 1);
      return;
    }
    vehicle.burnTimer += dt;
    const t = vehicle.burnTimer;
    view.fire =
      t < IGNITION_SECONDS
        ? t / IGNITION_SECONDS
        : Math.max(0, 1 - (t - IGNITION_SECONDS) / FIRE_SECONDS);
    const since = t - IGNITION_SECONDS - FIRE_SECONDS;
    view.smoke = since < 0 ? 1 : Math.max(0, 1 - since / SMOULDER_SECONDS);
  }

  private report(
    x: number,
    y: number,
    z: number,
    intensity: number,
    kind: 'vehicle' | 'world',
  ): void {
    if (!this.impactListener || intensity <= 0.01) return;
    this.impactListener(x, y, z, Math.min(1, intensity), kind);
  }

  /** Takes a vehicle out of the traffic AI without stopping it. */
  private goLoose(vehicle: Vehicle): void {
    // A car on rails carries its velocity along its own axis, so that is where
    // the free-body velocity comes from. A parked one is ALREADY a free body
    // and may be sliding sideways; overwriting its velocity from its heading
    // would throw away the sideways part of whatever just hit it.
    if (vehicle.control !== 'parked') {
      const fx = -Math.sin(vehicle.yaw);
      const fz = -Math.cos(vehicle.yaw);
      vehicle.vx = fx * vehicle.speed;
      vehicle.vz = fz * vehicle.speed;
    }
    this.unpark(vehicle);
    vehicle.control = 'loose';
    vehicle.view.control = 'loose';
    vehicle.view.state = 'loose';
    vehicle.looseTimer = 0;
    // A car already on its roof stays flagged; one on its wheels starts the
    // episode upright whatever happened to it in a previous life.
    if (Math.abs(vehicle.crashRoll) < Math.PI / 2) vehicle.view.overturned = false;
    vehicle.restTimer = 0;
    vehicle.stuck = 0;
    vehicle.braking = false;
    vehicle.brakeHold = 0;
    if (vehicle.claim) this.dropClaim(vehicle, vehicle.claim);
    vehicle.claim = null;
    const info = this.laneInfo.get(vehicle.laneId);
    if (info) {
      const index = info.occupants.indexOf(vehicle);
      if (index >= 0) info.occupants.splice(index, 1);
    }
  }

  /** Clears everything a crash left on a vehicle. */
  private resetBody(vehicle: Vehicle): void {
    vehicle.vx = 0;
    vehicle.vz = 0;
    vehicle.yawRate = 0;
    vehicle.rollRate = 0;
    vehicle.crashPitch = 0;
    vehicle.crashRoll = 0;
    vehicle.bodyLift = 0;
    vehicle.looseTimer = 0;
    vehicle.restTimer = 0;
    vehicle.impactCooldown = 0;
    vehicle.integrity = VEHICLE_INTEGRITY;
    vehicle.damage = 0;
    const points = vehicle.regionPoints;
    points.front = 0;
    points.rear = 0;
    points.left = 0;
    points.right = 0;
    points.glass = 0;
    points.tyres[0] = 0;
    points.tyres[1] = 0;
    points.tyres[2] = 0;
    points.tyres[3] = 0;
    vehicle.burnTimer = -1;
    vehicle.abandoned = false;
    vehicle.parkedAtRest = false;
    this.unpark(vehicle);
    vehicle.view.overturned = false;
    this.syncDamage(vehicle);
    this.pendingImpulses.delete(vehicle.id);
  }

  /**
   * One free-body step: no lane, no rail, no IDM.
   *
   * The vehicle integrates its own velocity, drags on the road, resolves
   * against the static world and rocks on its suspension until it is slow
   * enough to count as stopped. `steerAndMove` is bypassed entirely, which is
   * the point: its 1.6 m rail snap would drag a spinning car straight back
   * onto the centreline it was just knocked off.
   */
  private stepLoose(vehicle: Vehicle, dt: number, cameraDistance: number): void {
    vehicle.looseTimer += dt;
    const resting = this.integrateFree(vehicle, dt, cameraDistance);

    // At rest for long enough, or out of patience.
    if (resting) {
      vehicle.restTimer += dt;
      if (vehicle.restTimer > SETTLE_SECONDS) this.settleLoose(vehicle);
    } else vehicle.restTimer = 0;

    this.syncView(vehicle);

    if (vehicle.control === 'loose' && vehicle.looseTimer > LOOSE_LIMIT) {
      // Same rule as `STUCK_LIMIT`: it waits, visibly, until the camera has
      // moved on. Nothing is ever allowed to disappear in front of the player.
      if (cameraDistance > RECYCLE_DISTANCE) this.recycle(vehicle);
      else vehicle.looseTimer = LOOSE_LIMIT;
    }
  }

  /**
   * One step of a car that nothing is driving. Returns true once it is at rest.
   *
   * Shared by the two states that have no driver: a body still rolling after a
   * crash, and one the player abandoned. They differ in what happens when the
   * motion stops - one rejoins traffic or is written off, the other stays
   * exactly where it is - and in nothing before that, so the physics lives
   * here once.
   */
  private integrateFree(vehicle: Vehicle, dt: number, cameraDistance: number): boolean {
    const fx = -Math.sin(vehicle.yaw);
    const fz = -Math.cos(vehicle.yaw);
    const rx = Math.cos(vehicle.yaw);
    const rz = -Math.sin(vehicle.yaw);

    // Drag, resolved in the body frame: rolling along the axis, scrubbing
    // across it. See ROLL_DECEL / SCRUB_DECEL for why they differ so much.
    let along = vehicle.vx * fx + vehicle.vz * fz;
    let across = vehicle.vx * rx + vehicle.vz * rz;
    const rollDrop = ROLL_DECEL * dt;
    const scrubDrop = SCRUB_DECEL * dt;
    const wasAlong = along;
    along = Math.abs(along) <= rollDrop ? 0 : along - Math.sign(along) * rollDrop;
    across = Math.abs(across) <= scrubDrop ? 0 : across - Math.sign(across) * scrubDrop;
    vehicle.vx = fx * along + rx * across;
    vehicle.vz = fz * along + rz * across;

    // Attitude. Yaw is pure damping - nothing restores a heading - while roll
    // sits in a potential with minima upright and inverted, so it either rocks
    // back or goes over. Pitch is a bounded spring: an end-over-end needs four
    // times the energy of a roll on this wheelbase and never happens in a city.
    vehicle.yawRate = damp(vehicle.yawRate, 0, SPIN_DAMPING, dt);
    vehicle.rollRate -= TIP_TORQUE * Math.sin(2 * vehicle.crashRoll) * dt;
    const onTyres = Math.abs(vehicle.crashRoll) < ROLL_CONTACT_ANGLE;
    vehicle.rollRate = damp(
      vehicle.rollRate,
      0,
      onTyres ? ROLL_DAMPING_GROUNDED : ROLL_DAMPING_AIRBORNE,
      dt,
    );
    vehicle.yaw = normaliseAngle(vehicle.yaw + vehicle.yawRate * dt);
    vehicle.crashRoll = normaliseAngle(vehicle.crashRoll + vehicle.rollRate * dt);
    vehicle.crashPitch = damp(vehicle.crashPitch, 0, 4, dt);
    // A quarter turn is the top of the potential: past it gravity is taking
    // the body over rather than bringing it back, so that is the moment the
    // car has gone over and the latch is what makes it stay gone. Latched
    // rather than read off the final angle, because a hard enough hit can
    // carry the body past inverted and the answer must not depend on exactly
    // where it stopped rolling.
    if (!vehicle.view.overturned && Math.abs(vehicle.crashRoll) > Math.PI / 2) {
      vehicle.view.overturned = true;
    }

    // Move, and let the world refuse it.
    const dx = vehicle.vx * dt;
    const dz = vehicle.vz * dt;
    const before = Math.hypot(vehicle.vx, vehicle.vz);
    if (this.collision && (dx !== 0 || dz !== 0)) {
      const moved = this.collision.moveBox(
        vehicle.x,
        vehicle.z,
        vehicle.yaw,
        dx,
        dz,
        vehicle.blueprint.length * 0.5,
        vehicle.blueprint.width * 0.5,
        vehicle.y,
        LOOSE_BODY_HEIGHT,
      );
      // `moveBox` resolves one world axis at a time, so a refused axis is a
      // face the body is up against: bounce that component and keep the other,
      // which is what makes a car spin off a wall rather than stick to it.
      const gotX = moved.x - vehicle.x;
      const gotZ = moved.z - vehicle.z;
      let hitWall = false;
      if (dx !== 0 && Math.abs(gotX) < Math.abs(dx) - 1e-6) {
        vehicle.vx = -vehicle.vx * WALL_RESTITUTION;
        hitWall = true;
      }
      if (dz !== 0 && Math.abs(gotZ) < Math.abs(dz) - 1e-6) {
        vehicle.vz = -vehicle.vz * WALL_RESTITUTION;
        hitWall = true;
      }
      vehicle.x = moved.x;
      vehicle.z = moved.z;
      if (hitWall) {
        const lost = before - Math.hypot(vehicle.vx, vehicle.vz);
        vehicle.yawRate *= 0.5;
        // Charged to the end of the car that was leading. A body sliding
        // sideways into a wall has no leading end, `Math.sign` returns zero,
        // and the damage is spread over the shell - which is the honest answer.
        const reach = vehicle.blueprint.length * 0.5 * Math.sign(wasAlong);
        this.damage(
          vehicle,
          impactDamage(lost * vehicle.blueprint.chassis.mass),
          vehicle.x + fx * reach,
          vehicle.y + 0.6,
          vehicle.z + fz * reach,
          true,
        );
        this.report(vehicle.x, vehicle.y + 0.6, vehicle.z, lost / 12, 'world');
      }
    } else {
      vehicle.x += dx;
      vehicle.z += dz;
    }

    this.separateLoose(vehicle);

    // Published state. `speed` stays the signed forward component so the wheels
    // spin the right way and the crowd reads a velocity, not a magnitude.
    const speed = Math.hypot(vehicle.vx, vehicle.vz);
    vehicle.speed = vehicle.vx * fx + vehicle.vz * fz;
    vehicle.accelLong = (Math.abs(along) - Math.abs(wasAlong)) / Math.max(dt, 1e-4);
    vehicle.accelLat = 0;
    vehicle.wheelSpin -= (vehicle.speed * dt) / vehicle.blueprint.wheelRadius;

    this.settleBody(vehicle, dt, cameraDistance);

    return (
      speed < REST_SPEED &&
      Math.abs(vehicle.yawRate) < REST_SPIN &&
      Math.abs(vehicle.rollRate) < REST_SPIN
    );
  }

  // -- abandoned cars and wrecks ---------------------------------------------

  /**
   * Leaves a vehicle exactly where it is, with nobody in it.
   *
   * THIS IS WHAT HAPPENS WHEN THE PLAYER GETS OUT OF A CAR, and it is the
   * whole reason the state exists. The old code handed the car back to the
   * traffic AI, which found the nearest lane pointing roughly the right way,
   * snapped the body onto its centreline, rotated it to the lane heading and
   * drove it off - or, when no lane fitted, recycled it, so the car the player
   * had just parked disappeared and reappeared somewhere across the city.
   * Neither is what a parked car does.
   *
   * So: the transform is not touched. Not the position, not the heading, not
   * the resting pitch and roll, not the damage. Whatever speed it still had
   * becomes real velocity, which `stepParked` bleeds off against the road, so
   * a car let go of at a walking pace rolls to a stop instead of stopping dead
   * in mid-air. It is published as an obstacle the whole time, so traffic
   * queues behind it and steers around it; it can be re-entered; and it is
   * removed only by the bounded, out-of-view rule in `enforceParkedLimit`.
   */
  park(vehicle: Vehicle): void {
    if (vehicle.control === 'parked') return;
    if (vehicle.control !== 'loose') {
      const fx = -Math.sin(vehicle.yaw);
      const fz = -Math.cos(vehicle.yaw);
      vehicle.vx = fx * vehicle.speed;
      vehicle.vz = fz * vehicle.speed;
    }
    vehicle.control = 'parked';
    vehicle.abandoned = true;
    vehicle.parkedFrame = this.frame;
    // Anything still rolling settles first; a car handed over at a standstill
    // is at rest immediately and stops being integrated at all.
    vehicle.parkedAtRest = false;
    vehicle.braking = false;
    vehicle.brakeHold = 0;
    vehicle.stuck = 0;
    vehicle.looseTimer = 0;
    vehicle.restTimer = 0;
    vehicle.accelLong = 0;
    vehicle.accelLat = 0;
    // No route: a parked car is not going anywhere, and leaving a stale
    // continuation on it would give `advanceLane` something to act on if it
    // were ever handed back to the AI.
    vehicle.next = null;
    vehicle.nextArc = null;
    if (vehicle.claim) this.dropClaim(vehicle, vehicle.claim);
    vehicle.claim = null;
    const info = this.laneInfo.get(vehicle.laneId);
    if (info) {
      const index = info.occupants.indexOf(vehicle);
      if (index >= 0) info.occupants.splice(index, 1);
    }
    if (!this.parked.includes(vehicle)) this.parked.push(vehicle);
    this.syncView(vehicle);
    this.enforceParkedLimit();
  }

  /** Takes a vehicle out of the abandoned pool without moving it. */
  private unpark(vehicle: Vehicle): void {
    if (vehicle.parkedFrame < 0) return;
    const index = this.parked.indexOf(vehicle);
    if (index >= 0) this.parked.splice(index, 1);
    vehicle.parkedFrame = -1;
    vehicle.parkedAtRest = false;
  }

  /**
   * One step of an abandoned car or a wreck.
   *
   * Two regimes. While anything is still moving it is the same free body a
   * crash produces, so a car shoved into a parked one rocks it, slides it and
   * scrapes it along the wall behind it. Once it stops it is LATCHED: the pose
   * is frozen and the only thing that still runs is the ground contact, which
   * costs a height sample and is what keeps a wreck sitting on the road rather
   * than hovering over the crown of it.
   */
  private stepParked(vehicle: Vehicle, dt: number, cameraDistance: number): void {
    if (vehicle.parkedAtRest) {
      vehicle.speed = 0;
      vehicle.accelLong = 0;
      vehicle.accelLat = 0;
      this.settleBody(vehicle, dt, cameraDistance);
      this.syncView(vehicle);
      return;
    }

    if (this.integrateFree(vehicle, dt, cameraDistance)) {
      vehicle.restTimer += dt;
      if (vehicle.restTimer > SETTLE_SECONDS) {
        // Snap to the attitude the body is actually resting in - on its wheels
        // or on its roof - exactly as `settleLoose` does, and then stop.
        vehicle.crashRoll = vehicle.view.overturned
          ? Math.sign(vehicle.crashRoll || 1) * Math.PI
          : 0;
        vehicle.rollRate = 0;
        vehicle.yawRate = 0;
        vehicle.vx = 0;
        vehicle.vz = 0;
        vehicle.speed = 0;
        vehicle.parkedAtRest = true;
      }
    } else vehicle.restTimer = 0;

    this.syncView(vehicle);
  }

  /**
   * Keeps the abandoned pool bounded, and never in front of the player.
   *
   * Oldest first, and only beyond `PARKED_REMOVE_MARGIN` past the render
   * distance - which is to say only once the car has already stopped being
   * drawn, so nothing ever vanishes on screen. See `PARKED_LIMIT` and
   * `PARKED_HARD_LIMIT` for the two counts and why there are two.
   */
  private enforceParkedLimit(): void {
    if (this.parked.length <= PARKED_LIMIT) return;
    const removeAt = this.detailDistance + PARKED_REMOVE_MARGIN;
    const limitSq = removeAt * removeAt;
    let index = 0;
    while (index < this.parked.length && this.parked.length > PARKED_LIMIT) {
      const vehicle = this.parked[index] as Vehicle;
      const dx = vehicle.x - this.cameraX;
      const dz = vehicle.z - this.cameraZ;
      if (dx * dx + dz * dz > limitSq || this.parked.length > PARKED_HARD_LIMIT) {
        // `recycle` unparks it, which splices it out of this list, so the
        // index deliberately does not advance.
        this.recycle(vehicle);
      } else index += 1;
    }
  }

  /**
   * Keeps a free body out of the cars it lands among.
   *
   * The traffic model's non-overlap guarantee comes from the one-dimensional
   * lane bookkeeping, and a car that has left its lane is outside it. Without
   * this a knocked car slides through the queue it was shunted into, and a
   * wreck comes to rest inside somebody's boot.
   *
   * Only the FREE body is moved. Everything else is on rails, and pushing a
   * lane-bound car sideways would break the very invariant this is protecting.
   * Above a closing speed the contact is a collision as well as an overlap, so
   * it goes through the same impulse exchange as any other - which is what
   * makes a crash knock on into the car in front of it. `IMPACT_COOLDOWN`
   * bounds that: one car cannot be hit twice inside a fifth of a second, so a
   * pile-up settles instead of running away.
   */
  private separateLoose(vehicle: Vehicle): void {
    const reach = vehicle.blueprint.length * 0.5 + 3.5;
    const cx = Math.floor(vehicle.x / GRID_CELL);
    const cz = Math.floor(vehicle.z / GRID_CELL);
    const span = Math.ceil(reach / GRID_CELL);
    for (let ix = cx - span; ix <= cx + span; ix += 1) {
      for (let iz = cz - span; iz <= cz + span; iz += 1) {
        const cell = this.grid.get((ix + 4096) * 8192 + (iz + 4096));
        if (!cell) continue;
        for (const other of cell) {
          if (other === vehicle || !other.active) continue;
          if (Math.abs(other.x - vehicle.x) > reach || Math.abs(other.z - vehicle.z) > reach) {
            continue;
          }
          const depth = footprintPenetration(
            vehicle.x,
            vehicle.z,
            vehicle.yaw,
            vehicle.blueprint.length * 0.5,
            vehicle.blueprint.width * 0.5,
            other,
          );
          if (depth <= 0) continue;
          const nx = penetrationAxis.x;
          const nz = penetrationAxis.z;
          vehicle.x += nx * depth;
          vehicle.z += nz * depth;
          const closing = -(vehicle.vx * nx + vehicle.vz * nz);
          if (closing <= 0) continue;
          if (closing > CONTACT_SPEED && other.impactCooldown <= 0) {
            this.exchangeImpulse(other, vehicle, -nx, -nz, closing);
          } else {
            // Too slow to be a collision: just stop driving into them.
            vehicle.vx += nx * closing;
            vehicle.vz += nz * closing;
          }
        }
      }
    }
  }

  /**
   * Decides what a stopped free body does next.
   *
   * A car that is upright, drivable and beside a lane rejoins traffic, which is
   * what keeps the fleet at strength and keeps the road clear. Anything else -
   * on its roof, written off, or come to rest somewhere no lane fits - stays a
   * wreck and waits out `LOOSE_LIMIT`, published as an obstacle the whole time
   * so the traffic behind it queues instead of driving through it.
   */
  private settleLoose(vehicle: Vehicle): void {
    // Snap to the attitude the body is actually resting in: on its wheels, or
    // on its roof. Nothing rests on the top of the potential.
    const overturned = vehicle.view.overturned;
    vehicle.crashRoll = overturned ? Math.sign(vehicle.crashRoll || 1) * Math.PI : 0;
    vehicle.rollRate = 0;
    vehicle.yawRate = 0;
    vehicle.vx = 0;
    vehicle.vz = 0;
    vehicle.speed = 0;
    if (overturned || vehicle.integrity <= 0 || vehicle.abandoned) {
      // Nothing here has a driver: a car on its roof, a write-off, or one the
      // player got out of and left. It becomes a parked wreck, which is a
      // BOUNDED, permanent state - it stays exactly where it stopped until the
      // out-of-view rule in `enforceParkedLimit` takes it away - rather than
      // sitting loose for `LOOSE_LIMIT` seconds and then vanishing.
      this.park(vehicle);
      return;
    }
    const spot = this.findAttachLane(vehicle);
    if (!spot) return;

    // Wait for a gap before pulling back out, and judge it at the pose the
    // vehicle will END UP in, not the one it stopped in.
    //
    // Rejoining a lane hands the vehicle back to a model that steers on rails:
    // within a frame or two the pure-pursuit and the 1.6 m centreline snap have
    // dragged the body sideways onto the lane line. A car that stopped in a
    // clear patch of road can therefore be pulled straight into the flank of
    // one that is queued on the line it is rejoining, and the lane bookkeeping
    // will not notice, because its non-overlap guarantee is one-dimensional and
    // only covers cars already on the same lane.
    //
    // Measured before this: one shunted car in a five-minute run rejoined into
    // another and the pair sat interpenetrated by 0.34 m for the seventy
    // seconds it took `STUCK_LIMIT` to recycle one of them. Refusing simply
    // leaves the body loose, and `stepLoose` asks again every frame until the
    // road clears or `LOOSE_LIMIT` recycles it - which is what a driver whose
    // car has been spun round in traffic actually does.
    // Only from inside the lane, pointing roughly along it.
    //
    // `attach` is generous by design - it is what puts the player's car back
    // in traffic when they step out of it beside a kerb, and refusing there
    // would strand them. Fourteen metres of lateral tolerance is far too much
    // for an automatic recovery: a body that stopped in the middle of a
    // junction would take the nearest lane, and the centreline snap would then
    // drag it bodily across the carriageway into oncoming traffic - which is
    // exactly what produced the one sustained interpenetration this file's
    // crash-load measurement found. Inside the corridor, within 35 degrees.
    if (spot.offset > spot.info.laneHalf + 0.8 || spot.facing > 0.6) return;

    // Never back into traffic from inside a junction box.
    //
    // `placeVehicle` refuses to SEED a car there for a reason, and the reason
    // applies twice over here: a vehicle inside the box holds no claim, so the
    // admission rules cannot see it, and the first driver to take the claim
    // crosses straight into it. That is the second sustained interpenetration
    // the crash-load measurement found - two stopped cars at an angle, 3.2 m
    // apart, wedged until `STUCK_LIMIT` recycled one of them seventy seconds
    // later. Left loose instead, the body is published as an obstacle and
    // everything approaching the junction queues behind it, which is both
    // correct and what a real blocked junction looks like.
    const half = vehicle.blueprint.length * 0.5;
    const exit = spot.info.exit;
    if (exit && spot.along > exit.stopAlong - half) return;
    const entry = spot.info.entry;
    if (entry && spot.along < entry.crossingAlong + half) return;

    const target = lanePoint(spot.info.lane, spot.along);
    if (!this.poseIsClear(vehicle, target.x, target.z, spot.info.heading)) return;
    this.attach(vehicle);
  }

  /** True when no other vehicle's footprint overlaps this pose. */
  private poseIsClear(vehicle: Vehicle, x: number, z: number, yaw: number): boolean {
    const halfLength = vehicle.blueprint.length * 0.5;
    const halfWidth = vehicle.blueprint.width * 0.5;
    const reach = halfLength + 3.5;
    const cx = Math.floor(x / GRID_CELL);
    const cz = Math.floor(z / GRID_CELL);
    const span = Math.ceil(reach / GRID_CELL);
    for (let ix = cx - span; ix <= cx + span; ix += 1) {
      for (let iz = cz - span; iz <= cz + span; iz += 1) {
        const cell = this.grid.get((ix + 4096) * 8192 + (iz + 4096));
        if (!cell) continue;
        for (const other of cell) {
          if (other === vehicle || !other.active) continue;
          if (Math.abs(other.x - x) > reach || Math.abs(other.z - z) > reach) continue;
          if (footprintPenetration(x, z, yaw, halfLength, halfWidth, other) > 0) return false;
        }
      }
    }
    return true;
  }

  /**
   * Impacts between an ambient car and one whose pose is written from outside.
   *
   * The other direction - the player driving into traffic - is detected by the
   * collision resolve in `Driving`, which knows about it a frame earlier and
   * calls `applyImpact` directly. This covers the case nothing else can see:
   * a car running into a driven one that is parked, or crossing in front of it.
   * The cooldown `applyImpact` sets is what stops the two paths double-counting
   * the same contact.
   *
   * Costs nothing when nobody is driving, and `driven` is one entry plus the
   * police units even when somebody is.
   */
  private resolveDrivenContacts(): void {
    if (this.driven.length === 0) return;
    for (const target of this.driven) {
      const reach = target.blueprint.length * 0.5 + 3.5;
      const cx = Math.floor(target.x / GRID_CELL);
      const cz = Math.floor(target.z / GRID_CELL);
      const span = Math.ceil(reach / GRID_CELL);
      for (let ix = cx - span; ix <= cx + span; ix += 1) {
        for (let iz = cz - span; iz <= cz + span; iz += 1) {
          const cell = this.grid.get((ix + 4096) * 8192 + (iz + 4096));
          if (!cell) continue;
          for (const other of cell) {
            if (other.control !== 'ambient' || !other.active) continue;
            if (other.impactCooldown > 0) continue;
            const dx = target.x - other.x;
            const dz = target.z - other.z;
            const range = Math.hypot(dx, dz);
            if (range < 1e-4 || range > reach) continue;
            // Closing speed along the line of centres. A car that is already
            // separating is not a collision however much it overlaps.
            const nx = dx / range;
            const nz = dz / range;
            const ofx = -Math.sin(other.yaw);
            const ofz = -Math.cos(other.yaw);
            const tfx = -Math.sin(target.yaw);
            const tfz = -Math.cos(target.yaw);
            const closing =
              (ofx * other.speed - tfx * target.speed) * nx +
              (ofz * other.speed - tfz * target.speed) * nz;
            if (closing < CONTACT_SPEED) continue;
            if (!footprintsOverlap(target, other)) continue;
            this.exchangeImpulse(other, target, nx, nz, closing);
          }
        }
      }
    }
  }

  /**
   * One inelastic collision between two vehicles, applied to both.
   *
   * `n` points from `a` towards `b`, so `a` is pushed back along it and `b` is
   * pushed along it. The reduced mass is what makes the exchange believable in
   * both directions: a lorry meeting a hatchback barely notices, and the same
   * arithmetic run the other way throws the hatchback.
   */
  private exchangeImpulse(
    a: Vehicle,
    b: Vehicle,
    nx: number,
    nz: number,
    closing: number,
  ): void {
    const ma = Math.max(1, a.blueprint.chassis.mass);
    const mb = Math.max(1, b.blueprint.chassis.mass);
    const impulse = (1 + CAR_RESTITUTION) * closing * ((ma * mb) / (ma + mb));
    if (impulse <= 0) return;
    // Contact point: half way between the two centres, at bumper height.
    const px = (a.x + b.x) * 0.5;
    const pz = (a.z + b.z) * 0.5;
    const py = Math.min(a.y, b.y) + 0.55;
    const wear = impactDamage(impulse);
    this.applyImpact(a.id, {
      x: px,
      y: py,
      z: pz,
      dirX: -nx,
      dirZ: -nz,
      impulse,
      damage: wear,
    });
    this.applyImpact(b.id, {
      x: px,
      y: py,
      z: pz,
      dirX: nx,
      dirZ: nz,
      impulse,
      damage: wear,
    });
  }

  // -- presentation ---------------------------------------------------------

  /**
   * Ground contact and weight transfer.
   *
   * The road carries a real cross-fall, so the car is sat on a plane through
   * its four contact patches rather than on a single height, and the body's
   * own pitch and roll are added on top as a damped spring driven by the
   * accelerations the driver just produced.
   */
  private settleBody(vehicle: Vehicle, dt: number, cameraDistance: number): void {
    const chassis = vehicle.blueprint.chassis;
    const fx = -Math.sin(vehicle.yaw);
    const fz = -Math.cos(vehicle.yaw);
    const rx = Math.cos(vehicle.yaw);
    const rz = -Math.sin(vehicle.yaw);
    const front = chassis.frontAxle;
    const rear = chassis.frontAxle - chassis.wheelbase;
    const half = chassis.track * 0.5;

    if (cameraDistance < 48) {
      const sample = (alongAxle: number, side: number): number =>
        this.heightAt(
          vehicle.x + fx * alongAxle + rx * side,
          vehicle.z + fz * alongAxle + rz * side,
        );
      const fl = sample(front, -half);
      const fr = sample(front, half);
      const rl = sample(rear, -half);
      const rr = sample(rear, half);
      vehicle.y = (fl + fr + rl + rr) * 0.25;
      vehicle.groundPitch = Math.atan2((fl + fr) * 0.5 - (rl + rr) * 0.5, chassis.wheelbase);
      vehicle.groundRoll = Math.atan2((fr + rr) * 0.5 - (fl + rl) * 0.5, chassis.track);
    } else if (cameraDistance < this.detailDistance) {
      const yFront = this.heightAt(vehicle.x + fx * front, vehicle.z + fz * front);
      const yRear = this.heightAt(vehicle.x + fx * rear, vehicle.z + fz * rear);
      vehicle.y = (yFront + yRear) * 0.5;
      vehicle.groundPitch = Math.atan2(yFront - yRear, chassis.wheelbase);
      vehicle.groundRoll = damp(vehicle.groundRoll, 0, 2, dt);
    } else {
      vehicle.groundTimer -= dt;
      if (vehicle.groundTimer <= 0) {
        vehicle.groundTimer = 0.5;
        vehicle.y = this.heightAt(vehicle.x, vehicle.z);
      }
      vehicle.groundPitch = 0;
      vehicle.groundRoll = 0;
    }

    // Suspension: a critically damped spring per axis. The targets are the
    // static deflections a real body takes under these accelerations.
    const pitchTarget = clamp(vehicle.accelLong * 0.010, -0.055, 0.045);
    const rollTarget = clamp(-vehicle.accelLat * 0.014, -0.07, 0.07);
    const stiffness = 46;
    const damping = 11;
    vehicle.bodyPitchVel +=
      (stiffness * (pitchTarget - vehicle.bodyPitch) - damping * vehicle.bodyPitchVel) * dt;
    vehicle.bodyPitch += vehicle.bodyPitchVel * dt;
    vehicle.bodyRollVel +=
      (stiffness * (rollTarget - vehicle.bodyRoll) - damping * vehicle.bodyRollVel) * dt;
    vehicle.bodyRoll += vehicle.bodyRollVel * dt;
  }

  private syncView(vehicle: Vehicle): void {
    const view = vehicle.view;
    view.x = vehicle.x;
    view.z = vehicle.z;
    view.yaw = vehicle.yaw;
    view.speed = vehicle.speed;
    // A rolled body sits on its flank or its roof, which raises the mesh off
    // its own origin and changes the vertical half-extent of the box every
    // other system tests against. The branch keeps the upright path - which is
    // every vehicle on all but a handful of frames - exactly as cheap as it was.
    const halfHeight = vehicle.blueprint.height * 0.5;
    if (vehicle.crashRoll === 0) {
      vehicle.bodyLift = 0;
      view.y = vehicle.y + halfHeight;
      view.halfHeight = halfHeight;
    } else {
      const halfWidth = vehicle.blueprint.width * 0.5;
      const sin = Math.abs(Math.sin(vehicle.crashRoll));
      const cos = Math.cos(vehicle.crashRoll);
      // Lowest corner of the rolled section, so the shell rests on the road.
      vehicle.bodyLift = halfWidth * sin + vehicle.blueprint.height * Math.max(0, -cos);
      const half = halfHeight * Math.abs(cos) + halfWidth * sin;
      view.y = vehicle.y + vehicle.bodyLift + half;
      view.halfHeight = half;
    }
    view.pitch = vehicle.groundPitch + vehicle.bodyPitch + vehicle.crashPitch;
    view.roll = vehicle.groundRoll + vehicle.bodyRoll + vehicle.crashRoll;
    view.braking = vehicle.braking;
    view.accelLong = vehicle.accelLong;
    // `control` answers "who is driving": for a parked car nobody is, which is
    // exactly what `'loose'` has always meant. `state` carries the difference.
    // See `VehicleState` for why the published union is deliberately narrower
    // than the internal one.
    view.control = vehicle.control === 'parked' ? 'loose' : vehicle.control;
    view.state = vehicle.control;
    view.integrity = vehicle.integrity;
    view.damage = vehicle.damage;
  }

  // -- handover -------------------------------------------------------------

  /** Detaches a vehicle from the traffic AI. See `TrafficSystem.takeControl`. */
  detach(vehicle: Vehicle): void {
    // Somebody has got into it, so it is no longer abandoned and no longer
    // part of the parked pool - getting back into a car you parked has to take
    // it out of the queue of things waiting to be tidied away.
    this.unpark(vehicle);
    vehicle.abandoned = false;
    vehicle.control = 'player';
    vehicle.view.control = 'player';
    vehicle.view.state = 'player';
    if (vehicle.claim) this.dropClaim(vehicle, vehicle.claim);
    vehicle.claim = null;
    vehicle.speed = 0;
    vehicle.braking = false;
    const info = this.laneInfo.get(vehicle.laneId);
    if (info) {
      const index = info.occupants.indexOf(vehicle);
      if (index >= 0) info.occupants.splice(index, 1);
    }
  }

  /**
   * Returns a detached vehicle to ambient control on the nearest lane pointing
   * roughly the way it is facing, or recycles it when there is no such lane.
   *
   * NOT the path a car the player got out of takes - see `park`. This is for a
   * body that still has a driver in it: a wreck that rolled to a stop beside a
   * lane and is fit to be driven again, and nothing else.
   */
  attach(vehicle: Vehicle): void {
    const found = this.findAttachLane(vehicle);
    if (!found) {
      this.recycle(vehicle);
      return;
    }
    this.unpark(vehicle);
    vehicle.abandoned = false;
    vehicle.control = 'ambient';
    vehicle.view.control = 'ambient';
    vehicle.view.state = 'ambient';
    vehicle.laneId = found.info.lane.id;
    vehicle.along = found.along;
    vehicle.stuck = 0;
    vehicle.looseTimer = 0;
    vehicle.restTimer = 0;
    vehicle.vx = 0;
    vehicle.vz = 0;
    vehicle.yawRate = 0;
    vehicle.rollRate = 0;
    vehicle.desiredSpeed = this.desiredSpeedFor(vehicle, found.info);
    this.chooseNext(vehicle, found.info);
  }

  /**
   * The lane a detached vehicle would rejoin, or null when none fits.
   *
   * Split out of `attach` so a free body can ASK before it commits: `attach`
   * recycles when nothing fits, and a wreck that vanished the moment it stopped
   * rolling - in front of the player who had just crashed it - would be the
   * most obvious tell in the game.
   */
  private findAttachLane(
    vehicle: Vehicle,
  ): { info: LaneInfo; along: number; offset: number; facing: number } | null {
    let best: LaneInfo | null = null;
    let bestAlong = 0;
    let bestOffset = 0;
    let bestFacing = 0;
    let bestScore = Infinity;
    for (const info of this.laneList) {
      if (info.dead) continue;
      const lane = info.lane;
      const across = lane.axis === 'x' ? vehicle.x : vehicle.z;
      const at = lane.axis === 'x' ? vehicle.z : vehicle.x;
      const along = (at - lane.start) * lane.travel;
      if (along < 2 || along > lane.length - 2) continue;
      const offset = Math.abs(across - lane.offset);
      const facing = Math.abs(normaliseAngle(info.heading - vehicle.yaw));
      if (facing > 1.0) continue;
      const score = offset + facing * 6;
      if (score < bestScore) {
        bestScore = score;
        best = info;
        bestAlong = along;
        bestOffset = offset;
        bestFacing = facing;
      }
    }
    if (!best || bestScore > 14) return null;
    return { info: best, along: bestAlong, offset: bestOffset, facing: bestFacing };
  }

  /** Nearest active vehicle to a point, for the handover. */
  nearestVehicle(x: number, z: number, maxDistance: number): Vehicle | null {
    let best: Vehicle | null = null;
    let bestDistance = maxDistance * maxDistance;
    for (const vehicle of this.vehicles) {
      if (!vehicle.active) continue;
      const dx = vehicle.x - x;
      const dz = vehicle.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestDistance) {
        bestDistance = d;
        best = vehicle;
      }
    }
    return best;
  }

  /** Visits every active vehicle whose centre is within `radius` of a point. */
  /**
   * The same walk as `forEachNear`, but handing over the VEHICLE rather than
   * its view, for callers inside the simulation. Private because a `Vehicle`
   * is mutable and nothing outside may hold one.
   */
  private forEachNearVehicle(
    x: number,
    z: number,
    radius: number,
    visit: (vehicle: Vehicle) => void,
  ): void {
    const span = Math.ceil(radius / GRID_CELL);
    const cx = Math.floor(x / GRID_CELL);
    const cz = Math.floor(z / GRID_CELL);
    const limit = radius * radius;
    for (let ix = cx - span; ix <= cx + span; ix += 1) {
      for (let iz = cz - span; iz <= cz + span; iz += 1) {
        const cell = this.grid.get((ix + 4096) * 8192 + (iz + 4096));
        if (!cell) continue;
        for (const vehicle of cell) {
          const dx = vehicle.x - x;
          const dz = vehicle.z - z;
          if (dx * dx + dz * dz <= limit) visit(vehicle);
        }
      }
    }
  }

  forEachNear(x: number, z: number, radius: number, visit: (view: VehicleView) => void): void {
    const span = Math.ceil(radius / GRID_CELL);
    const cx = Math.floor(x / GRID_CELL);
    const cz = Math.floor(z / GRID_CELL);
    const limit = radius * radius;
    for (let ix = cx - span; ix <= cx + span; ix += 1) {
      for (let iz = cz - span; iz <= cz + span; iz += 1) {
        const cell = this.grid.get((ix + 4096) * 8192 + (iz + 4096));
        if (!cell) continue;
        for (const vehicle of cell) {
          const dx = vehicle.x - x;
          const dz = vehicle.z - z;
          if (dx * dx + dz * dz <= limit) visit(vehicle.view);
        }
      }
    }
  }

  /**
   * Lane metadata. Exposed for the tests and for diagnostics only - the arrays
   * inside are the live per-frame indexes and must not be mutated.
   */
  laneMeta(laneId: string): LaneInfo | undefined {
    return this.laneInfo.get(laneId);
  }

  /** Total drivable lane length, used to size the fleet. */
  get laneLength(): number {
    let total = 0;
    for (const info of this.laneList) total += info.lane.length;
    return total;
  }

  get liveCount(): number {
    let count = 0;
    for (const vehicle of this.vehicles) if (vehicle.active) count += 1;
    return count;
  }

  /** Abandoned cars and wrecks currently held. Bounded by `PARKED_HARD_LIMIT`. */
  get parkedCount(): number {
    return this.parked.length;
  }

  /** How many of those are write-offs rather than cars somebody walked away from. */
  get wreckCount(): number {
    let count = 0;
    for (const vehicle of this.parked) {
      if (vehicle.integrity <= 0 || vehicle.view.overturned) count += 1;
    }
    return count;
  }

  /**
   * The caps and the removal distance, so a test can assert against the real
   * numbers rather than copies of them that could drift.
   */
  get parkedLimits(): { limit: number; hardLimit: number; removeDistance: number } {
    return {
      limit: PARKED_LIMIT,
      hardLimit: PARKED_HARD_LIMIT,
      removeDistance: this.detailDistance + PARKED_REMOVE_MARGIN,
    };
  }
}

export type { LaneInfo };
