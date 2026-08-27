/**
 * Getting a police car from where it is to where the player is.
 *
 * The city already has a lane graph with every legal turn in it, so a pursuit
 * does not need a navigation mesh or a path planner: it needs a rule for which
 * exit to take at each junction, and a rule for how to hold a car on a line.
 * Both are here, both are pure arithmetic, and both are unit tested.
 *
 * HOW A UNIT KNOWS WHICH WAY TO TURN. `PursuitField` searches the lane graph
 * backwards from the player once and gives every lane a hop count; a driver
 * then takes whichever legal exit has the lowest count. `chooseExit` is the
 * one-junction greedy version, kept as the fallback for a car that has been
 * shoved somewhere the field never reached, and used directly by the tests.
 */

import { clamp } from '../core/mathx';
import {
  exitsFrom,
  lanePoint,
  type LaneSegment,
  type RoadNetwork,
} from '../city/RoadNetwork';

export interface LanePosition {
  readonly lane: LaneSegment;
  /** Distance travelled from the lane's start, in metres. */
  readonly along: number;
  /** Perpendicular distance from the lane centreline at that point. */
  readonly offset: number;
}

/**
 * The lane a point is on, or nearest to.
 *
 * A linear scan over every lane. Meridian Bay has a few hundred of them and
 * this runs when a unit is dispatched or when one loses its lane, not per
 * frame, so an index would be more code than it saves.
 */
export function nearestLane(network: RoadNetwork, x: number, z: number): LanePosition | null {
  let best: LanePosition | null = null;
  let bestScore = Infinity;
  for (const lane of network.lanes) {
    const across = lane.axis === 'x' ? x : z;
    const at = lane.axis === 'x' ? z : x;
    const raw = (at - lane.start) * lane.travel;
    const along = clamp(raw, 0, lane.length);
    const overshoot = raw - along;
    const offset = across - lane.offset;
    const score = offset * offset + overshoot * overshoot;
    if (score < bestScore) {
      bestScore = score;
      best = { lane, along, offset };
    }
  }
  return best;
}

/**
 * A lane whose midpoint is as close as possible to a wanted distance from a
 * point, used to place a newly dispatched unit out of sight but on a road.
 *
 * The direction bias steers the choice away from the way the player is facing,
 * so a car does not materialise in the middle of the view. It is a bias and
 * not a filter: on a street where every candidate is ahead, a unit still
 * arrives.
 *
 * IT MUST BE SOMEWHERE A CAR CAN DRIVE OUT OF. `reachable` is the pursuit
 * field's own "can this lane get to the player" test, and passing it is not
 * optional decoration. Meridian Bay's one-way pairs and shoreline termini mean
 * a lane can be a hundred and forty metres away and have no legal route back:
 * measured, a three-star response placed every unit on exactly such a lane,
 * watched each one fail to make progress, wrote it off after the lost-patience
 * timeout and dispatched an identical replacement to the identical lane - 21
 * cars in 150 seconds, not one of which ever arrived. The pick is
 * deterministic, so a bad lane is bad forever.
 *
 * When nothing reachable exists at all - the field has not been built yet, or
 * the player is somewhere the graph cannot see - it falls back to the best
 * unreachable lane rather than declining to dispatch. A unit that has to find
 * its own way is still better than a city that never responds.
 */
export function dispatchLane(
  network: RoadNetwork,
  x: number,
  z: number,
  forwardX: number,
  forwardZ: number,
  wantedDistance: number,
  reachable?: (laneId: string) => boolean,
): LanePosition | null {
  let best: LanePosition | null = null;
  let bestScore = Infinity;
  let fallback: LanePosition | null = null;
  let fallbackScore = Infinity;
  for (const lane of network.lanes) {
    if (lane.length < 20) continue;
    const mid = lanePoint(lane, lane.length * 0.5);
    const dx = mid.x - x;
    const dz = mid.z - z;
    const distance = Math.hypot(dx, dz);
    if (distance < 1) continue;
    // Penalise being in front of the player: dot > 0 means the lane midpoint
    // lies the way the camera is pointing.
    const dot = (dx * forwardX + dz * forwardZ) / distance;
    const score = Math.abs(distance - wantedDistance) + Math.max(0, dot) * 45;
    if (score < fallbackScore) {
      fallbackScore = score;
      fallback = { lane, along: lane.length * 0.5, offset: 0 };
    }
    if (reachable && !reachable(lane.id)) continue;
    if (score < bestScore) {
      bestScore = score;
      best = { lane, along: lane.length * 0.5, offset: 0 };
    }
  }
  return best ?? fallback;
}

/**
 * A distance field over the lane graph, pointing at the player.
 *
 * WHY NOT GREEDY. `chooseExit` below picks whichever legal exit ENDS nearest
 * the target, which is optimal on an open grid and wrong the moment the grid
 * is not open. Measured in Meridian Bay: a unit dispatched north of the player
 * oscillated between two junctions for fifteen seconds, holding station at
 * 114 m, because every exit that made progress pointed briefly away first.
 * A greedy driver cannot see past one junction and this city has one-way
 * pairs, termini and a shoreline.
 *
 * So the whole graph is searched instead, backwards from the lane the player
 * is standing on, giving every lane a hop count to the target. A unit then
 * takes whichever legal exit has the lowest count - a flow field, computed
 * once for every unit at once.
 *
 * COST. One breadth-first search over the city's few hundred lanes, which is
 * a few tens of microseconds, and it is recomputed only when the player has
 * moved far enough to matter. The reverse adjacency it walks is built once.
 */
export class PursuitField {
  private readonly reverse = new Map<string, LaneSegment[]>();
  private readonly hops = new Map<string, number>();
  private targetLane: string | null = null;
  private lastX = Number.NaN;
  private lastZ = Number.NaN;

  constructor(private readonly network: RoadNetwork) {
    for (const lane of network.lanes) {
      for (const exit of exitsFrom(network, lane)) {
        const list = this.reverse.get(exit.id);
        if (list) list.push(lane);
        else this.reverse.set(exit.id, [lane]);
      }
    }
  }

  /** Lanes reached by the last search. Diagnostics and tests. */
  get reach(): number {
    return this.hops.size;
  }

  get target(): string | null {
    return this.targetLane;
  }

  /**
   * Rebuilds the field around a point, unless the point has barely moved.
   * `minMove` is the distance the target must travel to be worth a re-search.
   */
  update(x: number, z: number, minMove = 12): boolean {
    if (
      this.targetLane !== null &&
      Number.isFinite(this.lastX) &&
      Math.hypot(x - this.lastX, z - this.lastZ) < minMove
    ) {
      return false;
    }
    const here = nearestLane(this.network, x, z);
    if (!here) return false;
    this.lastX = x;
    this.lastZ = z;
    this.targetLane = here.lane.id;

    this.hops.clear();
    this.hops.set(here.lane.id, 0);
    // Breadth-first over the REVERSED graph: a lane's cost is one more than
    // the cost of the lane it feeds.
    let frontier: LaneSegment[] = [here.lane];
    let depth = 0;
    while (frontier.length > 0 && depth < 400) {
      depth += 1;
      const next: LaneSegment[] = [];
      for (const lane of frontier) {
        for (const before of this.reverse.get(lane.id) ?? []) {
          if (this.hops.has(before.id)) continue;
          this.hops.set(before.id, depth);
          next.push(before);
        }
      }
      frontier = next;
    }
    return true;
  }

  /** Hops from this lane to the target lane, or Infinity if it cannot get there. */
  cost(laneId: string): number {
    return this.hops.get(laneId) ?? Infinity;
  }

  /**
   * The exit a pursuit driver should take. Falls back to the greedy choice
   * when the target is unreachable from here, which happens for a car that has
   * been pushed off the network entirely.
   */
  next(lane: LaneSegment, targetX: number, targetZ: number): LaneSegment | null {
    let best: LaneSegment | null = null;
    let bestCost = Infinity;
    for (const exit of exitsFrom(this.network, lane)) {
      const cost = this.cost(exit.id);
      if (cost < bestCost) {
        bestCost = cost;
        best = exit;
      }
    }
    if (best && bestCost < Infinity) return best;
    return chooseExit(this.network, lane, targetX, targetZ);
  }
}

/**
 * Which legal exit from a lane gets a car closest to the target.
 *
 * Ties break toward continuing straight on: `current` is the lane being left,
 * and an exit on the same street wins an otherwise equal comparison.
 */
export function chooseExit(
  network: RoadNetwork,
  current: LaneSegment,
  targetX: number,
  targetZ: number,
): LaneSegment | null {
  const exits = exitsFrom(network, current);
  let best: LaneSegment | null = null;
  let bestScore = Infinity;
  for (const exit of exits) {
    const end = lanePoint(exit, exit.length);
    const dx = end.x - targetX;
    const dz = end.z - targetZ;
    // A small bonus for staying on the same street removes the oscillation
    // between two symmetric turns at a crossroads.
    const straight = exit.streetId === current.streetId ? -2 : 0;
    const score = Math.hypot(dx, dz) + straight;
    if (score < bestScore) {
      bestScore = score;
      best = exit;
    }
  }
  return best;
}

/** Signed smallest angle from `from` to `to`, in radians. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** The yaw that points from one place to another, in the game's convention. */
export function headingTo(fromX: number, fromZ: number, toX: number, toZ: number): number {
  // Forward is (-sin yaw, 0, -cos yaw), so yaw = atan2(-dx, -dz).
  return Math.atan2(-(toX - fromX), -(toZ - fromZ));
}

export interface SteerInput {
  readonly yaw: number;
  readonly speed: number;
  readonly steer: number;
  readonly targetX: number;
  readonly targetZ: number;
  readonly x: number;
  readonly z: number;
  readonly maxSteer: number;
  readonly steerRate: number;
  readonly dt: number;
}

/**
 * One step of a pursuit driver's steering.
 *
 * Pure pursuit: aim the front wheels at the waypoint, rate-limit the rack, and
 * tighten the limit as speed rises so a car cannot pivot on the spot at 16 m/s.
 * Returns the new steering angle, in radians.
 */
export function steerToward(input: SteerInput): number {
  const wanted = headingTo(input.x, input.z, input.targetX, input.targetZ);
  const error = angleDelta(input.yaw, wanted);
  const speedFactor = 1 / (1 + Math.abs(input.speed) * 0.07);
  const target = clamp(error * 1.6, -input.maxSteer, input.maxSteer) * speedFactor;
  const rate = input.steerRate * input.dt;
  return input.steer + clamp(target - input.steer, -rate, rate);
}

/**
 * How fast a pursuit car should be going, given how far it still has to run
 * and how hard it is turning.
 *
 * The turn term is what stops a patrol car taking a right angle at 16 m/s and
 * ending up on the pavement; the approach term is what stops it arriving at
 * the player's back at full speed.
 */
export function pursuitSpeed(
  topSpeed: number,
  distanceToTarget: number,
  steer: number,
  holdRange: number,
): number {
  const turn = 1 / (1 + Math.abs(steer) * 4.5);
  const approach = clamp((distanceToTarget - holdRange) / 12, 0, 1);
  return topSpeed * turn * approach;
}
