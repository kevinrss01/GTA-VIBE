/**
 * The traveller simulation: everything the terminal's population does, as
 * numbers.
 *
 * Free of Three.js on purpose, exactly like `crowd.ts`, so a long run can be
 * stepped and asserted in `tests/travellers.test.ts` with no renderer and no
 * GPU. `TerminalCrowd` is the only module that turns this state into geometry.
 *
 * The model, in the order it runs each frame:
 *
 *   1. Serve.     Each queue's head is released on an unconditional timer and
 *                 the line closes up. That the timer is unconditional is the
 *                 whole anti-deadlock argument: a slot index can only ever go
 *                 down, and slot 0 empties within one service interval no
 *                 matter what any agent is doing.
 *   2. Think.     Walkers follow a path over `TerminalGraph`; queuers steer at
 *                 their slot; everyone bounded by a patience timer, because
 *                 the street crowd's hardest bug was the one state that could
 *                 last for ever (see `crowd.ts`, "EVERY REASON TO STAND STILL
 *                 IS BOUNDED").
 *   3. Steer.     Desired direction, plus repulsion from close neighbours,
 *                 plus a speed cap behind whoever is directly in front. The
 *                 speed cap is what makes a queue shuffle instead of jitter.
 *   4. Integrate along the heading, then RESOLVE positionally: separate pairs,
 *                 push the player clear, push out of furniture, clamp into the
 *                 walkable rectangle. The last two are constraints rather than
 *                 forces, so no amount of crowding can drive anybody through a
 *                 desk or a wall.
 *
 * ## Cost, measured
 *
 * The neighbour passes are O(n^2). At the shipped population of 52 that is
 * 1 326 pairs, about 5 300 distance tests a frame - and the whole `update`,
 * steering and constraints included, was MEASURED at 22 microseconds over
 * 18 000 steps. The frame it runs inside is 5.6 ms.
 *
 * So no uniform grid, and no simulation LOD. Both were considered and both
 * were rejected on that number: the street crowd needs them because it runs
 * 270 agents over a 150 m radius, and this runs a fiftieth of that work inside
 * one building, where the whole population is either visible or culled
 * together. Past roughly 150 travellers the quadratic term starts to matter
 * and a grid earns its place; below it, it is code with no measurable effect.
 */

import { clamp, damp, insetRect, TAU, type Rect } from '../../core/mathx';
import { createRng, type Rng } from '../../core/rng';
import { makeLook, type PedestrianLook } from '../appearance';
import { LUGGAGE_KINDS, LUGGAGE_SPECS, type LuggageKind } from './props';
import {
  TRAVELLER_RADIUS,
  type BoxIndex,
  type QueueAnchor,
  type TerminalGraph,
  TerminalPaths,
} from './terminalSpace';

export type TravellerState = 'walk' | 'queue' | 'pause';

export interface Traveller {
  /** Its own position in `TravellerSim.travellers`; queues store this. */
  readonly index: number;
  x: number;
  z: number;
  /** Camera-convention heading: forward is `(-sin h, 0, -cos h)`. */
  heading: number;
  speed: number;
  /** Blend between the idle clip (0) and the walk clip (1). */
  gait: number;
  /**
   * Distance covered in RIG units. Drives the walk cycle through
   * `VatClip.phaseFor`, never a clock - that is the no-slide condition, and
   * dividing by `girth` rather than `height` is the correction
   * `PedestrianSystem` documents at `walked`.
   */
  walked: number;
  readonly look: PedestrianLook;
  /** Which baked character this person is drawn as. */
  readonly variant: number;
  readonly luggage: LuggageKind | null;
  state: TravellerState;
  /** Index into `queues`, or -1. */
  queue: number;
  /** Slot within that queue, or -1. */
  slot: number;
  /** Seconds of deliberate standing still left. */
  pause: number;
  /** Seconds before the current intention is abandoned. Always finite. */
  patience: number;
  /** Remaining path, as graph node indices. `cursor` is the next one. */
  readonly path: number[];
  cursor: number;
  /** The queue this walker is heading for, or -1. */
  goalQueue: number;
}

export interface QueueState {
  readonly anchor: QueueAnchor;
  readonly capacity: number;
  /** Traveller index per slot. Occupancy is always a prefix of this. */
  readonly slots: Int32Array;
  /** Graph node a joiner walks to: the nearest one to the tail slot. */
  readonly approach: number;
  occupied: number;
  /** Seconds until the head is served. Counts down unconditionally. */
  timer: number;
  /** People served since the start. The proof that the line moves. */
  served: number;
}

export interface TravellerSimOptions {
  readonly region: Rect;
  readonly obstacles: BoxIndex;
  readonly graph: TerminalGraph;
  readonly queues: readonly QueueAnchor[];
  readonly population: number;
  readonly variants: number;
  readonly seed: number;
  /** Share of travellers carrying something. */
  readonly luggageShare?: number | undefined;
}

export interface TravellerSimStats {
  readonly population: number;
  readonly walking: number;
  readonly queueing: number;
  readonly paused: number;
  readonly served: number;
  /** Paths searched since the start; a spike here means goals are failing. */
  readonly searches: number;
  readonly failedSearches: number;
}

/** Distance between people standing in a line, in metres. */
export const QUEUE_PITCH = 0.92;

/** Slots a queue holds when the anchor does not say. */
export const DEFAULT_QUEUE_SLOTS = 8;

/** Seconds one person takes at the desk. Short enough that the line moves. */
const SERVICE_MIN = 4;
const SERVICE_MAX = 9;

/**
 * Longest anybody may stay in a line, in seconds.
 *
 * Three minutes is longer than the worst honest wait (a full eight-slot line
 * at nine seconds a head is 72 s), so it never fires in normal play. It exists
 * because a bound that is never reached is still a bound, and the alternative
 * is a state with no exit.
 */
const QUEUE_PATIENCE = 180;

/** Longest a walker may pursue one goal before picking another, in seconds. */
const WALK_PATIENCE = 70;

/** How close counts as having reached a path node, in metres. */
const WAYPOINT_RADIUS = 1.15;

/** How close counts as being in your slot, in metres. */
const SLOT_RADIUS = 0.22;

/** Distance over which a walker slows to a stop at its target. */
const ARRIVE_RADIUS = 1.6;

/** Neighbours inside this push each other's heading apart, in metres. */
const AVOID_RADIUS = 1.5;
const AVOID_GAIN = 1.5;

/** Somebody this close directly ahead caps your speed, in metres. */
const FOLLOW_RADIUS = 1.1;

/** Clearance kept from the player, in metres. */
const PLAYER_CLEARANCE = 0.62;

/** Clearance a traveller keeps from furniture, in metres. */
const OBSTACLE_CLEARANCE = TRAVELLER_RADIUS + 0.06;

/** Passes of the positional resolve. Two converges at this density. */
const RESOLVE_PASSES = 2;

/** How readily a walker who has arrived somewhere joins a line. */
const QUEUE_SHARE = 0.5;

/**
 * How long a trip a new goal may be, in metres.
 *
 * Both ends are load-bearing on a 190 m concourse. Without the FLOOR people
 * mill within a few metres of where they stopped and the hall reads as a gas
 * rather than a terminal. Without the CEILING a uniform draw over the graph
 * averages a 65 m walk - measured - so everybody is permanently in transit,
 * nobody reaches a desk, and the check-in line averages 1.4 people. Capping it
 * cut the mean journey to about half a minute, which is what filled the
 * queues.
 */
const MIN_TRIP = 18;
const MAX_TRIP = 48;

/**
 * How sharply a walker prefers a NEARER line, in metres.
 *
 * Nobody at the gates walks the length of the building to stand at check-in.
 * The weight is `1 / (1 + d / QUEUE_REACH)`, so a desk 25 m away is twice as
 * attractive as one 75 m away.
 */
const QUEUE_REACH = 25;

const TURN_RATE = 7;
const ACCELERATION = 3.2;

/** Indoor pace as a fraction of the street crowd's. Nobody strides in a hall. */
const INDOOR_PACE = 0.85;

/** Speed at which the walk clip is fully in, m/s. Below it the idle blends in. */
const GAIT_SPEED = 0.55;

/** Shortest usable steering target, in metres. Mirrors `crowd.ts`. */
const MIN_TARGET_DISTANCE = 0.2;

function angleOf(dx: number, dz: number): number {
  // Forward is (-sin h, -cos h), so the heading that points along (dx, dz) is
  // the angle of (-dx, -dz) measured the same way.
  return Math.atan2(-dx, -dz);
}

function dampAngle(current: number, target: number, rate: number, dt: number): number {
  let delta = (target - current) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  return current + delta * (1 - Math.exp(-rate * dt));
}

export class TravellerSim {
  readonly travellers: Traveller[] = [];
  readonly queues: QueueState[] = [];

  /** The walkable rectangle, already inset by a shoulder. */
  private readonly inner: Rect;
  private readonly obstacles: BoxIndex;
  private readonly graph: TerminalGraph;
  /** Public so the QA overlay and the tests can search the same graph. */
  readonly paths: TerminalPaths;
  private readonly rng: Rng;
  private readonly push = { x: 0, z: 0 };
  private readonly slotPointOut = { x: 0, z: 0 };
  private searches = 0;
  private failedSearches = 0;

  constructor(options: TravellerSimOptions) {
    // The clamp is inset by a shoulder, so a traveller pressed against the
    // wall has their body inside the room rather than their centre on it.
    this.inner = insetRect(options.region, TRAVELLER_RADIUS);
    this.obstacles = options.obstacles;
    this.graph = options.graph;
    this.paths = new TerminalPaths(options.graph);
    this.rng = createRng(options.seed);

    for (const anchor of options.queues) {
      const capacity = Math.max(1, anchor.slots ?? DEFAULT_QUEUE_SLOTS);
      this.slotPoint(anchor, capacity - 1, this.slotPointOut);
      this.queues.push({
        anchor,
        capacity,
        slots: new Int32Array(capacity).fill(-1),
        approach: this.graph.nearest(this.slotPointOut.x, this.slotPointOut.z),
        occupied: 0,
        timer: this.rng.range(SERVICE_MIN, SERVICE_MAX),
        served: 0,
      });
    }

    const luggageShare = options.luggageShare ?? 0.62;
    const variants = Math.max(1, options.variants);
    for (let i = 0; i < options.population && this.graph.count > 0; i += 1) {
      const look = makeLook(this.rng);
      this.travellers.push({
        index: i,
        x: 0,
        z: 0,
        heading: this.rng.range(0, TAU),
        speed: 0,
        gait: 0,
        walked: this.rng.range(0, 4),
        look,
        variant: this.rng.int(0, variants - 1),
        luggage: this.rng.chance(luggageShare) ? this.pickLuggage() : null,
        state: 'walk',
        queue: -1,
        slot: -1,
        pause: 0,
        patience: WALK_PATIENCE,
        path: [],
        cursor: 0,
        goalQueue: -1,
      });
    }

    this.place();
  }

  get stats(): TravellerSimStats {
    let walking = 0;
    let queueing = 0;
    let paused = 0;
    let served = 0;
    for (const t of this.travellers) {
      if (t.state === 'queue') queueing += 1;
      else if (t.state === 'pause') paused += 1;
      else walking += 1;
    }
    for (const q of this.queues) served += q.served;
    return {
      population: this.travellers.length,
      walking,
      queueing,
      paused,
      served,
      searches: this.searches,
      failedSearches: this.failedSearches,
    };
  }

  /** Where the person in slot `index` of this queue stands. */
  slotPoint(anchor: QueueAnchor, index: number, out: { x: number; z: number }): void {
    // The head faces `heading`, so the line runs the other way: back along
    // -(forward) = (sin h, cos h).
    out.x = anchor.x + Math.sin(anchor.heading) * QUEUE_PITCH * index;
    out.z = anchor.z + Math.cos(anchor.heading) * QUEUE_PITCH * index;
  }

  update(dt: number, player?: { readonly x: number; readonly z: number } | undefined): void {
    if (this.travellers.length === 0) return;
    const step = Math.min(dt, 0.1);
    this.serve(step);
    for (const t of this.travellers) this.think(t, step);
    for (const t of this.travellers) this.steer(t, step);
    this.resolve(player);
  }

  /**
   * Advances every queue by the clock.
   *
   * Unconditional: the head is released whether or not it ever reached its
   * slot, and the line closes up whether or not the head was occupied. A queue
   * therefore cannot stall behind an agent that is physically wedged, which is
   * the failure a service rule conditioned on arrival would have.
   */
  private serve(dt: number): void {
    for (const q of this.queues) {
      q.timer -= dt;
      if (q.timer > 0) continue;
      q.timer = this.rng.range(SERVICE_MIN, SERVICE_MAX);
      const head = q.slots[0] ?? -1;
      if (head >= 0) {
        const person = this.travellers[head];
        if (person) this.release(person);
        q.served += 1;
      }
      for (let i = 0; i < q.capacity - 1; i += 1) q.slots[i] = q.slots[i + 1] ?? -1;
      q.slots[q.capacity - 1] = -1;
      q.occupied = Math.max(0, q.occupied - 1);
      this.reindex(q);
    }
  }

  private reindex(q: QueueState): void {
    for (let i = 0; i < q.capacity; i += 1) {
      const index = q.slots[i] ?? -1;
      if (index < 0) continue;
      const person = this.travellers[index];
      if (person) person.slot = i;
    }
  }

  /** Turns somebody who has been served, or given up, back into a walker. */
  private release(person: Traveller): void {
    person.queue = -1;
    person.slot = -1;
    person.state = 'pause';
    person.pause = this.rng.range(0.4, 1.8);
    person.path.length = 0;
    person.cursor = 0;
    person.goalQueue = -1;
    person.patience = WALK_PATIENCE;
  }

  private think(t: Traveller, dt: number): void {
    t.patience -= dt;

    if (t.state === 'pause') {
      t.pause -= dt;
      if (t.pause <= 0) {
        t.state = 'walk';
        this.chooseGoal(t);
      }
      return;
    }

    if (t.state === 'queue') {
      if (t.patience <= 0) {
        const q = this.queues[t.queue];
        if (q && t.slot >= 0) this.leaveQueue(q, t.slot);
        this.release(t);
      }
      return;
    }

    // Walking. An empty path means the goal is unset or was just reached.
    if (t.cursor >= t.path.length) {
      this.arrive(t);
      return;
    }
    const node = t.path[t.cursor] ?? -1;
    if (node < 0) {
      this.arrive(t);
      return;
    }
    const dx = (this.graph.x[node] ?? 0) - t.x;
    const dz = (this.graph.z[node] ?? 0) - t.z;
    if (dx * dx + dz * dz <= WAYPOINT_RADIUS * WAYPOINT_RADIUS) {
      t.cursor += 1;
      if (t.cursor >= t.path.length) this.arrive(t);
    }
    if (t.patience <= 0) this.chooseGoal(t);
  }

  /** Called the moment a walker runs out of path. */
  private arrive(t: Traveller): void {
    if (t.goalQueue >= 0) {
      const q = this.queues[t.goalQueue];
      if (q && q.occupied < q.capacity) {
        this.joinQueue(t.goalQueue, q, t);
        return;
      }
      // The line filled up on the way over. Go and do something else.
      t.goalQueue = -1;
    }
    t.state = 'pause';
    // Standing and reading the board, or looking for a gate. Bounded, and long
    // enough that the concourse is never entirely in motion.
    t.pause = this.rng.range(0.6, 5.5);
    t.path.length = 0;
    t.cursor = 0;
  }

  private joinQueue(queue: number, q: QueueState, t: Traveller): void {
    const slot = q.occupied;
    q.slots[slot] = t.index;
    q.occupied += 1;
    t.queue = queue;
    t.slot = slot;
    t.state = 'queue';
    t.patience = QUEUE_PATIENCE;
    t.path.length = 0;
    t.cursor = 0;
    t.goalQueue = -1;
  }

  private leaveQueue(q: QueueState, slot: number): void {
    for (let i = slot; i < q.capacity - 1; i += 1) q.slots[i] = q.slots[i + 1] ?? -1;
    q.slots[q.capacity - 1] = -1;
    q.occupied = Math.max(0, q.occupied - 1);
    this.reindex(q);
  }

  /**
   * Picks somewhere to go and a route to it.
   *
   * The bias toward long trips is what makes the lattice read as a concourse:
   * uniform goals produce a gas of people milling within a few metres of where
   * they started, while goals at least `MIN_TRIP` away produce the traverses
   * between the doors, the desks and the gates that a terminal is made of.
   */
  private chooseGoal(t: Traveller): void {
    t.patience = WALK_PATIENCE;
    t.state = 'walk';
    t.goalQueue = -1;
    t.path.length = 0;
    t.cursor = 0;
    if (this.graph.count === 0) return;

    const from = this.graph.nearest(t.x, t.z);
    if (from < 0) return;

    let goal = -1;
    const open: number[] = [];
    const weights: number[] = [];
    for (let i = 0; i < this.queues.length; i += 1) {
      const q = this.queues[i];
      if (!q || q.occupied >= q.capacity || q.approach < 0) continue;
      open.push(i);
      const distance = Math.hypot(q.anchor.x - t.x, q.anchor.z - t.z);
      weights.push(1 / (1 + distance / QUEUE_REACH));
    }
    if (open.length > 0 && this.rng.chance(QUEUE_SHARE)) {
      const pick = this.rng.weighted(open, weights);
      const q = this.queues[pick];
      if (q) {
        goal = q.approach;
        t.goalQueue = pick;
      }
    }
    if (goal < 0) {
      goal = this.farNode(t.x, t.z);
    }

    this.searches += 1;
    if (!this.paths.find(from, goal, t.path)) {
      this.failedSearches += 1;
      t.goalQueue = -1;
      t.path.length = 0;
      // Not an error: two nodes in different pockets of a badly furnished room
      // are genuinely unreachable. Wait a moment and try somewhere else.
      t.state = 'pause';
      t.pause = this.rng.range(0.5, 1.5);
    }
  }

  /** A node a walk away but not a hike: the first draw inside the trip band. */
  private farNode(x: number, z: number): number {
    let best = -1;
    let bestError = Infinity;
    const middle = (MIN_TRIP + MAX_TRIP) * 0.5;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const node = this.rng.int(0, this.graph.count - 1);
      const dx = (this.graph.x[node] ?? 0) - x;
      const dz = (this.graph.z[node] ?? 0) - z;
      const distance = Math.hypot(dx, dz);
      if (distance >= MIN_TRIP && distance <= MAX_TRIP) return node;
      const error = Math.abs(distance - middle);
      if (error < bestError) {
        bestError = error;
        best = node;
      }
    }
    return best;
  }

  private pickLuggage(): LuggageKind {
    const weights = LUGGAGE_KINDS.map((kind) => LUGGAGE_SPECS[kind].share);
    return this.rng.weighted(LUGGAGE_KINDS, weights);
  }

  /** Where this traveller is trying to be, and how fast. */
  private target(t: Traveller, out: { x: number; z: number }): number {
    if (t.state === 'queue') {
      const q = this.queues[t.queue];
      if (!q) return 0;
      this.slotPoint(q.anchor, Math.max(0, t.slot), out);
      return t.look.preferredSpeed * INDOOR_PACE * 0.55;
    }
    if (t.state === 'pause' || t.cursor >= t.path.length) {
      out.x = t.x;
      out.z = t.z;
      return 0;
    }
    const node = t.path[t.cursor] ?? 0;
    out.x = this.graph.x[node] ?? t.x;
    out.z = this.graph.z[node] ?? t.z;
    return t.look.preferredSpeed * INDOOR_PACE;
  }

  private steer(t: Traveller, dt: number): void {
    const goal = this.steerOut;
    const preferred = this.target(t, goal);
    let dx = goal.x - t.x;
    let dz = goal.z - t.z;
    const distance = Math.hypot(dx, dz);

    let desired = preferred;
    if (distance < ARRIVE_RADIUS) desired = preferred * (distance / ARRIVE_RADIUS);
    if (t.state === 'queue' && distance < SLOT_RADIUS) desired = 0;

    if (distance > MIN_TARGET_DISTANCE) {
      dx /= distance;
      dz /= distance;
    } else {
      dx = 0;
      dz = 0;
    }

    // Neighbours: a repulsion on the steering direction, and a cap on speed
    // behind whoever is immediately in front. Both from one pass.
    const forwardX = -Math.sin(t.heading);
    const forwardZ = -Math.cos(t.heading);
    for (const other of this.travellers) {
      if (other === t) continue;
      const ox = t.x - other.x;
      const oz = t.z - other.z;
      const d2 = ox * ox + oz * oz;
      if (d2 >= AVOID_RADIUS * AVOID_RADIUS || d2 < 1e-6) continue;
      const d = Math.sqrt(d2);
      const weight = (1 - d / AVOID_RADIUS) * AVOID_GAIN;
      dx += (ox / d) * weight;
      dz += (oz / d) * weight;
      if (d < FOLLOW_RADIUS && -ox * forwardX - oz * forwardZ > 0.55 * d) {
        // Directly ahead and close: match them rather than walk into them.
        desired = Math.min(desired, other.speed * 0.9);
      }
    }

    const length = Math.hypot(dx, dz);
    if (length > 1e-4) {
      let aim = angleOf(dx / length, dz / length);
      // Settled in a queue slot: face the desk, not the last direction of
      // travel, or a line of people ends up looking at the wall.
      if (t.state === 'queue' && distance < SLOT_RADIUS * 3) {
        const q = this.queues[t.queue];
        if (q) aim = q.anchor.heading;
      }
      t.heading = dampAngle(t.heading, aim, TURN_RATE, dt);
    } else if (t.state === 'queue') {
      const q = this.queues[t.queue];
      if (q) t.heading = dampAngle(t.heading, q.anchor.heading, TURN_RATE, dt);
    }

    t.speed = damp(t.speed, desired, ACCELERATION, dt);
    if (t.speed < 0.02) t.speed = 0;
    t.gait = damp(t.gait, clamp(t.speed / GAIT_SPEED, 0, 1), 6, dt);

    // The realised displacement is banked in `resolve`, after the constraints
    // have had their say; crediting it here would count a step the separation
    // pass is about to take back, and the walk cycle would run ahead of the
    // ground the feet are actually on.
    this.moved[t.index * 2] = t.x;
    this.moved[t.index * 2 + 1] = t.z;
    t.x += -Math.sin(t.heading) * t.speed * dt;
    t.z += -Math.cos(t.heading) * t.speed * dt;
  }

  /** Scratch for the pre-constraint positions, refilled every `steer` pass. */
  private readonly moved: number[] = [];
  private readonly steerOut = { x: 0, z: 0 };

  /**
   * The constraint pass.
   *
   * Order matters and is the whole guarantee. Pairs first, then the player,
   * then furniture, then the walls: whatever the earlier steps did, the last
   * two are applied afterwards, so a traveller can finish a frame overlapping
   * another traveller by a centimetre but can never finish one inside a
   * check-in desk or outside the room.
   */
  private resolve(player?: { readonly x: number; readonly z: number } | undefined): void {
    const people = this.travellers;
    const minimum = TRAVELLER_RADIUS * 2;

    for (let pass = 0; pass < RESOLVE_PASSES; pass += 1) {
      for (let i = 0; i < people.length; i += 1) {
        const a = people[i];
        if (!a) continue;
        for (let j = i + 1; j < people.length; j += 1) {
          const b = people[j];
          if (!b) continue;
          let dx = a.x - b.x;
          let dz = a.z - b.z;
          let d2 = dx * dx + dz * dz;
          if (d2 >= minimum * minimum) continue;
          if (d2 < 1e-8) {
            // Exactly coincident. Any direction will do; a stable one derived
            // from the pair's indices keeps it out of the shared RNG.
            dx = ((i * 37 + j * 11) % 7) / 7 - 0.5;
            dz = ((i * 13 + j * 29) % 5) / 5 - 0.5;
            d2 = dx * dx + dz * dz;
          }
          const d = Math.sqrt(d2);
          const overlap = (minimum - d) * 0.5;
          const nx = (dx / d) * overlap;
          const nz = (dz / d) * overlap;
          a.x += nx;
          a.z += nz;
          b.x -= nx;
          b.z -= nz;
        }
      }

      for (const t of people) {
        if (player) {
          const dx = t.x - player.x;
          const dz = t.z - player.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < PLAYER_CLEARANCE * PLAYER_CLEARANCE && d2 > 1e-8) {
            const d = Math.sqrt(d2);
            const push = PLAYER_CLEARANCE - d;
            t.x += (dx / d) * push;
            t.z += (dz / d) * push;
          }
        }
        // Furniture, repeated: one push can leave a traveller touching the
        // next box along in a row of seating.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (!this.obstacles.resolve(t.x, t.z, OBSTACLE_CLEARANCE, this.push)) break;
          t.x += this.push.x;
          t.z += this.push.z;
        }
        t.x = clamp(t.x, this.inner.minX, this.inner.maxX);
        t.z = clamp(t.z, this.inner.minZ, this.inner.maxZ);
      }
    }

    // Distance actually covered, projected onto the heading, in rig units.
    // Sideways shoves must not spin the legs, and a step the constraints took
    // back must not turn the walk cycle.
    for (let i = 0; i < people.length; i += 1) {
      const t = people[i];
      if (!t) continue;
      const fromX = this.moved[i * 2] ?? t.x;
      const fromZ = this.moved[i * 2 + 1] ?? t.z;
      const dx = t.x - fromX;
      const dz = t.z - fromZ;
      const forward = -dx * Math.sin(t.heading) - dz * Math.cos(t.heading);
      if (forward > 0) t.walked += forward / Math.max(0.4, t.look.girth);
    }
    this.moved.length = 0;
  }

  /**
   * Spreads the population over the graph and pre-fills the queues.
   *
   * Pre-filling matters: a player who walks in during the first ten seconds
   * would otherwise find two empty desks and a concourse of people converging
   * on them, which is the one arrangement a real terminal never has.
   */
  private place(): void {
    const nodes = this.graph.count;
    if (nodes === 0) return;
    const used = new Set<number>();
    let next = 0;

    for (const q of this.queues) {
      const fill = Math.round(this.rng.range(0.35, 0.9) * q.capacity);
      for (let slot = 0; slot < fill && next < this.travellers.length; slot += 1) {
        const person = this.travellers[next];
        if (!person) break;
        next += 1;
        this.slotPoint(q.anchor, slot, this.slotPointOut);
        person.x = this.slotPointOut.x;
        person.z = this.slotPointOut.z;
        person.heading = q.anchor.heading;
        person.state = 'queue';
        person.queue = this.queues.indexOf(q);
        person.slot = slot;
        person.patience = QUEUE_PATIENCE;
        q.slots[slot] = next - 1;
        q.occupied = slot + 1;
      }
    }

    for (let i = next; i < this.travellers.length; i += 1) {
      const person = this.travellers[i];
      if (!person) continue;
      let node = -1;
      for (let attempt = 0; attempt < 24; attempt += 1) {
        const candidate = this.rng.int(0, nodes - 1);
        if (used.has(candidate)) continue;
        node = candidate;
        break;
      }
      if (node < 0) node = this.rng.int(0, nodes - 1);
      used.add(node);
      person.x = this.graph.x[node] ?? 0;
      person.z = this.graph.z[node] ?? 0;
      this.chooseGoal(person);
    }

    // A settling pass, so nobody is standing inside anybody on frame one.
    this.resolve(undefined);
  }
}
