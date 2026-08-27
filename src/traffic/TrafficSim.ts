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

import { clamp, damp } from '../core/mathx';
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
import type { TrafficObstacle, VehicleControl, VehicleKind, VehicleView } from './types';

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

/** Cell size of the vehicle broad-phase grid, metres. */
const GRID_CELL = 20;

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
  control: VehicleControl;
}

export interface Vehicle {
  readonly id: number;
  kind: VehicleKind;
  blueprint: VehicleBlueprint;
  active: boolean;
  control: VehicleControl;

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
}

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
  private time = 0;
  private cameraX = 0;
  private cameraZ = 0;
  private frame = 0;

  constructor(options: TrafficSimOptions) {
    this.network = options.network;
    this.heightAt = options.heightAt;
    this.rng = createRng(options.seed ?? 'meridian-traffic-01');
    this.detailDistance = options.detailDistance ?? 240;

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
      control: 'ambient',
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
      vehicle.active = true;
      vehicle.control = 'ambient';
      vehicle.view.control = 'ambient';
      // The view has to be valid the instant a vehicle appears: a consumer
      // reading it before the first step would otherwise see the origin.
      this.syncView(vehicle);
      this.chooseNext(vehicle, info);
      // Inserted in order: the occupancy list is kept sorted by `along`, and a
      // plain push here would corrupt the leader lookup for the rest of the frame.
      let at = info.occupants.length;
      while (at > 0 && (info.occupants[at - 1] as Vehicle).along > along) at -= 1;
      info.occupants.splice(at, 0, vehicle);
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
      // Simulation level of detail: distant cars are stepped less often with a
      // proportionally larger dt. IDM is stable well past 100 ms, and nothing
      // within sight of the player is ever coarsened.
      const dx = vehicle.x - cameraX;
      const dz = vehicle.z - cameraZ;
      const distance = Math.hypot(dx, dz);
      const stride = distance < 130 ? 1 : distance < 260 ? 2 : 4;
      vehicle.simAccumulator += step;
      if (stride > 1 && (this.frame + vehicle.bucket) % stride !== 0) continue;
      const vehicleStep = vehicle.simAccumulator;
      vehicle.simAccumulator = 0;
      if (vehicleStep <= 0) continue;
      this.stepVehicle(vehicle, vehicleStep, distance);
    }

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

    for (const vehicle of this.vehicles) {
      if (!vehicle.active) continue;
      if (vehicle.control === 'ambient') {
        const info = this.laneInfo.get(vehicle.laneId);
        if (info) info.occupants.push(vehicle);
        if (vehicle.claim) this.addClaim(vehicle, vehicle.claim);
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
    let desired = vehicle.desiredSpeed;
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
      // Already over the line: commit rather than stop in the middle of a box.
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
          if (toJunction < 0) return other.turn !== 1;
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
    // A player-driven car has no lane; never contest a junction with one.
    if (other.control === 'player' || !otherInfo) return true;
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

    // Grip ceiling: v^2 * tan(d) / L must stay under what the tyres will hold.
    const speed = Math.max(vehicle.speed, 0.5);
    const gripSteer = Math.atan((chassis.gripLateral * chassis.wheelbase) / (speed * speed));
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
    view.y = vehicle.y + vehicle.blueprint.height * 0.5;
    view.z = vehicle.z;
    view.yaw = vehicle.yaw;
    view.speed = vehicle.speed;
    view.pitch = vehicle.groundPitch + vehicle.bodyPitch;
    view.roll = vehicle.groundRoll + vehicle.bodyRoll;
    view.braking = vehicle.braking;
    view.control = vehicle.control;
  }

  // -- handover -------------------------------------------------------------

  /** Detaches a vehicle from the traffic AI. See `TrafficSystem.takeControl`. */
  detach(vehicle: Vehicle): void {
    vehicle.control = 'player';
    vehicle.view.control = 'player';
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
   */
  attach(vehicle: Vehicle): void {
    let best: LaneInfo | null = null;
    let bestAlong = 0;
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
      }
    }
    if (!best || bestScore > 14) {
      this.recycle(vehicle);
      vehicle.control = 'ambient';
      vehicle.view.control = 'ambient';
      return;
    }
    vehicle.control = 'ambient';
    vehicle.view.control = 'ambient';
    vehicle.laneId = best.lane.id;
    vehicle.along = bestAlong;
    vehicle.stuck = 0;
    vehicle.desiredSpeed = this.desiredSpeedFor(vehicle, best);
    this.chooseNext(vehicle, best);
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
}

export type { LaneInfo };
