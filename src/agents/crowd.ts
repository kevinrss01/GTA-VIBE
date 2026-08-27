/**
 * The pedestrian simulation.
 *
 * Deliberately free of Three.js: everything here is numbers, so the whole crowd
 * can be stepped and asserted on in a unit test with no renderer, exactly like
 * `CityPlan` and `RoadNetwork`. `PedestrianSystem` is the only module that
 * turns this state into geometry.
 *
 * The model, in the order it runs each frame:
 *
 *   1. Route.  Every pedestrian is on a `PavementLink` with a distance along it
 *      and a signed lateral offset. Movement is free-form, but the position is
 *      projected back onto the link every step and the lateral offset is hard
 *      clamped to the pavement's half width. That clamp is the guarantee that
 *      nobody walks into a wall, onto a carriageway, or off a kerb: it is a
 *      constraint, not a force, so no amount of crowding can defeat it.
 *   2. Intent. Approaching the end of a link a pedestrian picks the next one,
 *      preferring to carry straight on. A crossing is only committed to once
 *      `walkSignal` says the traffic it crosses is stopped AND no vehicle is
 *      about to arrive; until then they wait a short way back from the kerb.
 *   3. Avoid.  Near the player: separation, a predicted-contact dodge, and
 *      speed matching behind whoever is in front. Speed control is what stops
 *      the jitter that pure repulsion produces in a queue.
 *   4. Integrate, project, then resolve remaining overlaps positionally so two
 *      people can never occupy the same place.
 *
 * GETTING SOMEWHERE. Two of those steps carry an invariant the rest of the
 * model depends on, and both were learned the hard way from people standing in
 * the road for minutes at a time:
 *
 *   - the steering target must be genuinely AHEAD along the current link, and
 *     never closer than a step. A target on top of a walker is chased at full
 *     speed, overshot, and then chased backwards; `along` stops advancing and
 *     nothing ever hands them to the next link. See `step`.
 *   - a route street furniture has closed is not offered at all, and a walker
 *     pressed against a prop looks for the gap rather than sliding into the
 *     kerb. See `ObstacleIndex.blocksCorridor` and `clearLateralAhead`.
 *
 * `watchStall` sits under both as a bounded ladder of last resorts, and its
 * final rung is a step along the link, which always works.
 *
 * SIMULATION LOD. Full steering runs inside `LOD_NEAR`. Between there and
 * `LOD_MID` the predicted-contact dodge and the obstacle push are dropped and
 * the agent is stepped every other frame with a doubled timestep. Beyond that
 * it is pure path following stepped every fourth frame. Past `RENDER_RADIUS`
 * nothing is drawn, and past `RECYCLE_RADIUS` the agent is returned to the pool
 * and respawned where the player is heading. The walk cycle phase advances
 * every frame at every level, which costs one add and keeps distant figures
 * from stuttering.
 */

import { clamp, damp, TAU } from '../core/mathx';
import { createRng, type Rng } from '../core/rng';
import { walkSignal, type RoadNetwork } from '../city/RoadNetwork';
import type { CityGround } from '../world/CityGround';
import { makeLook, type PedestrianLook } from './appearance';
import { gaitCadence } from './gait';
import type { ObstacleIndex } from './obstacles';
import { linkPoint, type PavementGraph, type PavementLink } from './pavement';

/** Half a shoulder width. Two people stop at twice this. */
export const PED_RADIUS = 0.27;

export const LOD_NEAR = 42;
export const LOD_MID = 95;
/**
 * Radii, in metres. These set the crowd's DENSITY, not just its reach, and the
 * relationship is not obvious: pedestrians diffuse, so a population recycled at
 * radius R settles into a roughly area-uniform distribution and the share
 * within 40 m goes as (40/R)^2. Measured at R = 192 that put only 15 of 270
 * people inside 40 m - a street with almost nobody on it. Pulling the recycle
 * radius in concentrates the same population where the player can actually
 * see faces, and the far end is covered by fog and by figures a pixel tall.
 */
export const RENDER_RADIUS = 150;
export const RECYCLE_RADIUS = 152;
const SPAWN_MIN = 46;
const SPAWN_MAX = 118;

/** Distance the player can move in one frame before we assume a teleport. */
const TELEPORT_JUMP = 55;

/**
 * Shortest steering target a direction may be normalised from.
 *
 * A target closer than this carries no usable direction: normalising a vector a
 * centimetre long and then walking at it full tilt overshoots it every step, and
 * the next step points back the way it came. See `step` for the deadlock that
 * produced.
 */
const MIN_TARGET_DISTANCE = 0.25;

/**
 * Forward progress a corner aim point must offer before it is trusted.
 *
 * Measured against the CURRENT link's direction of travel, because that is the
 * axis `along` advances on and `along` is what hands a pedestrian to the next
 * link.
 */
const MIN_CORNER_AHEAD = 0.35;

/** How far the stall watchdog's last-resort step moves someone, in metres. */
const STALL_NUDGE = 0.5;

/** Speed put on the decision to go round a prop rather than press into it. */
const SIDESTEP = 0.5;

/** Lateral resolution of the search for a way past a prop, in metres. */
const LATERAL_PROBE_STEP = 0.12;

/** How long a walker keeps aiming past a prop before it turns a corner. */
const DODGE_TIME = 1.4;

export type PedState = 'walk' | 'wait' | 'cross' | 'pause';

/**
 * The minimum a vehicle has to tell us. Deliberately structural so the vehicle
 * workstream can pass its own agents straight through without a shared type;
 * a missing velocity is read as stationary rather than as an error.
 */
export interface CrowdVehicle {
  readonly x: number;
  readonly z: number;
  readonly vx?: number | undefined;
  readonly vz?: number | undefined;
  /** Half extents in metres. Defaults to a family car if absent. */
  readonly halfLength?: number | undefined;
  readonly halfWidth?: number | undefined;
}

export interface Pedestrian {
  active: boolean;
  link: number;
  /** Chosen continuation, or -1 while undecided. */
  next: number;
  along: number;
  lateral: number;
  lateralTarget: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  speed: number;
  heading: number;
  state: PedState;
  /** Seconds left in the current wait or pause. */
  timer: number;
  /** Where along the current link a waiting pedestrian stands. */
  waitAlong: number;
  /** Walk cycle position in [0, 1). */
  phase: number;
  /** 0 standing, 1 walking. Drives limb amplitude in the shader. */
  gait: number;
  /** Gait cycles per second right now. The renderer sizes the stride from it. */
  cadenceNow: number;
  /** Seconds since the stall anchor was last reset. */
  stall: number;
  /** Where the pedestrian was when the stall anchor was last reset. */
  anchorX: number;
  anchorZ: number;
  /** How many recovery attempts the current blockage has taken. */
  stallTries: number;
  /**
   * Seconds left of "get past the thing in front of you before turning the
   * corner". Set when street furniture is actually being touched.
   */
  dodge: number;
  lod: number;
  /** Frames until this agent's next simulation step. */
  due: number;
  groundAge: number;
  look: PedestrianLook;
}

export interface CrowdOptions {
  readonly ground: CityGround;
  readonly network: RoadNetwork;
  readonly graph: PavementGraph;
  readonly obstacles: ObstacleIndex;
  readonly population: number;
  readonly seed: string;
}

export interface CrowdContext {
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly time: number;
  readonly vehicles?: readonly CrowdVehicle[] | undefined;
}

export interface CrowdStats {
  active: number;
  near: number;
  mid: number;
  far: number;
  rendered: number;
  /**
   * Agents that actually ran a simulation step this frame. Compare with
   * `active`: the gap is what the simulation LOD is saving.
   */
  stepped: number;
  waiting: number;
  crossing: number;
  respawned: number;
  /**
   * Times a pedestrian decided to step around something rather than keep
   * pushing at it. Not an error count: most of these are people walking round
   * someone who has stopped. A sustained rise means the pavement is too narrow
   * for the density.
   */
  detours: number;
}

const GRID_BITS = 12;
const GRID_SIZE = 1 << GRID_BITS;
const GRID_MASK = GRID_SIZE - 1;
const CELL = 2.4;

function hashCell(ix: number, iz: number): number {
  return (Math.imul(ix, 92837111) ^ Math.imul(iz, 689287499)) & GRID_MASK;
}

function dampAngle(current: number, target: number, rate: number, dt: number): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= TAU;
  while (delta < -Math.PI) delta += TAU;
  return current + delta * (1 - Math.exp(-rate * dt));
}

export class Crowd {
  readonly peds: Pedestrian[] = [];
  /**
   * How many of the pool may be active. Lowering it retires the tail rather
   * than reallocating, so the quality menu never restarts the crowd.
   */
  budget: number;
  readonly stats: CrowdStats = {
    active: 0,
    near: 0,
    mid: 0,
    far: 0,
    rendered: 0,
    stepped: 0,
    waiting: 0,
    crossing: 0,
    respawned: 0,
    detours: 0,
  };

  private readonly ground: CityGround;
  private readonly network: RoadNetwork;
  private readonly graph: PavementGraph;
  private readonly obstacles: ObstacleIndex;
  private readonly rng: Rng;

  private readonly cellHead = new Int32Array(GRID_SIZE);
  private readonly cellNext: Int32Array;

  private readonly scratch = { x: 0, z: 0 };
  private readonly push = { x: 0, z: 0 };
  private readonly probe = { x: 0, z: 0 };
  private readonly probePush = { x: 0, z: 0 };
  /**
   * Links street furniture has closed outright, by index. Built once, because
   * the scatter is static: see `ObstacleIndex.blocksCorridor` for why a route
   * can be impassable at all, and `chooseNext` for what is done about it.
   */
  private readonly closed: Uint8Array;
  private lastPlayerX = Number.NaN;
  private lastPlayerZ = Number.NaN;
  /** Smoothed player direction, so recycled agents land where they are going. */
  private driftX = 0;
  private driftZ = 0;

  constructor(options: CrowdOptions) {
    this.ground = options.ground;
    this.network = options.network;
    this.graph = options.graph;
    this.obstacles = options.obstacles;
    this.rng = createRng(`${options.seed}:crowd`);
    this.budget = options.population;
    this.cellNext = new Int32Array(options.population);
    for (let i = 0; i < options.population; i += 1) this.peds.push(this.blank());

    this.closed = new Uint8Array(this.graph.links.length);
    for (let i = 0; i < this.graph.links.length; i += 1) {
      const link = this.graph.links[i];
      if (!link) continue;
      if (this.obstacles.blocksCorridor(link, PED_RADIUS + 0.14)) this.closed[i] = 1;
    }
  }

  /** How many links street furniture has closed. Diagnostics and tests. */
  get closedLinks(): number {
    let count = 0;
    for (const flag of this.closed) if (flag) count += 1;
    return count;
  }

  /** True when street furniture leaves no way along this link at all. */
  isClosed(index: number): boolean {
    return this.closed[index] === 1;
  }

  private blank(): Pedestrian {
    return {
      active: false,
      link: 0,
      next: -1,
      along: 0,
      lateral: 0,
      lateralTarget: 0,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vz: 0,
      speed: 0,
      heading: 0,
      state: 'walk',
      timer: 0,
      waitAlong: 0,
      phase: 0,
      gait: 0,
      cadenceNow: 1,
      stall: 0,
      anchorX: 0,
      anchorZ: 0,
      stallTries: 0,
      dodge: 0,
      lod: 2,
      due: 0,
      groundAge: 0,
      look: makeLook(this.rng),
    };
  }

  // -- spawning -------------------------------------------------------------

  /**
   * Fills the city around a point.
   *
   * Links are chosen by STRATIFIED length-weighted sampling of everything in
   * range rather than by repeated independent draws. Independent draws put a
   * visible clump on whichever street wins the first few rolls; stratifying
   * guarantees the population is spread over every street in range in
   * proportion to how much pavement each one has.
   */
  seed(px: number, pz: number): void {
    const candidates = this.linksNear(px, pz, 0, RENDER_RADIUS * 0.95);
    if (candidates.length === 0) return;

    let total = 0;
    for (const index of candidates) total += this.graph.links[index]?.length ?? 0;
    if (total <= 0) return;

    const count = Math.min(this.budget, this.peds.length);
    for (let i = 0; i < this.peds.length; i += 1) {
      const ped = this.peds[i];
      if (!ped) continue;
      if (i >= count) {
        ped.active = false;
        continue;
      }
      // One stratum per pedestrian, jittered inside it.
      const r = (i + this.rng.next()) / count;
      let target = r * total;
      let chosen = candidates[candidates.length - 1] ?? 0;
      for (const index of candidates) {
        target -= this.graph.links[index]?.length ?? 0;
        if (target <= 0) {
          chosen = index;
          break;
        }
      }
      this.place(ped, chosen, this.rng.next());
    }
    this.reindex();
    this.separateInitial();
  }

  private linksNear(px: number, pz: number, min: number, max: number): number[] {
    const out: number[] = [];
    const links = this.graph.links;
    for (let i = 0; i < links.length; i += 1) {
      const link = links[i];
      if (!link || link.crossing) continue;
      // Nobody may be placed where they could not walk out.
      if (this.closed[i] === 1) continue;
      // Reverse links duplicate their partner's geometry; sampling both would
      // double the weight of every stretch of pavement.
      if (link.reverse >= 0 && link.reverse < i) continue;
      const mx = (link.ax + link.bx) * 0.5;
      const mz = (link.az + link.bz) * 0.5;
      const d = Math.hypot(mx - px, mz - pz);
      if (d >= min && d <= max) out.push(i);
    }
    return out;
  }

  private place(ped: Pedestrian, linkIndex: number, t: number): void {
    const link = this.graph.links[linkIndex];
    if (!link) return;
    // Half the population walks the other way.
    const index = this.rng.chance(0.5) && link.reverse >= 0 ? link.reverse : linkIndex;
    const chosen = this.graph.links[index];
    if (!chosen) return;

    ped.look = makeLook(this.rng);
    ped.active = true;
    ped.link = index;
    ped.next = -1;
    ped.along = clamp(t * chosen.length, 0.5, Math.max(0.5, chosen.length - 0.5));
    ped.lateralTarget = this.preferredLateral(chosen, ped.look);
    ped.lateral = ped.lateralTarget;
    ped.state = 'walk';
    ped.timer = this.rng.range(4, 30);
    ped.speed = ped.look.preferredSpeed;
    ped.gait = 1;
    ped.stall = 0;
    ped.stallTries = 0;
    ped.dodge = 0;
    ped.phase = this.rng.next();
    ped.lod = 2;
    ped.due = 0;
    ped.groundAge = 999;
    linkPoint(chosen, ped.along, ped.lateral, this.scratch);
    ped.x = this.scratch.x;
    ped.z = this.scratch.z;
    ped.y = this.ground.sample(ped.x, ped.z).y;
    ped.vx = chosen.dx * ped.speed;
    ped.vz = chosen.dz * ped.speed;
    ped.heading = Math.atan2(-ped.vx, -ped.vz);
  }

  /**
   * Where on the pavement this person prefers to walk.
   *
   * Biased to the walker's right, which is what keeps two opposing streams from
   * meeting head-on all day. The bias is soft: pavements here are 2.8 m at
   * their narrowest and a hard keep-right would halve them.
   */
  private preferredLateral(link: PavementLink, look: PedestrianLook): number {
    const w = link.halfWidth;
    return clamp(-0.42 * w + look.laneBias * 0.55 * w, -w, w);
  }

  /**
   * Returns a pedestrian to the pool and puts them back somewhere useful.
   *
   * Two biases, both measured rather than guessed. Picking uniformly from the
   * links in the ring puts almost everyone at its far edge, because there is
   * far more pavement at 140 m than at 60 m; weighting by 1/(1 + (d/50)^2)
   * cancels that growth so the population is spread evenly in DISTANCE. And
   * the crowd is pulled toward wherever the player is heading, because
   * otherwise walking two hundred metres leaves the whole city behind you:
   * measured before this, a player who walked 200 m had 15 people within 60 m.
   */
  private respawn(ped: Pedestrian, px: number, pz: number): void {
    const candidates = this.linksNear(px, pz, SPAWN_MIN, SPAWN_MAX);
    if (candidates.length === 0) {
      ped.active = false;
      return;
    }

    const drift = Math.hypot(this.driftX, this.driftZ);
    const headX = drift > 0.25 ? this.driftX / drift : 0;
    const headZ = drift > 0.25 ? this.driftZ / drift : 0;

    let total = 0;
    let chosen = -1;
    for (const index of candidates) {
      const link = this.graph.links[index];
      if (!link) continue;
      const mx = (link.ax + link.bx) * 0.5 - px;
      const mz = (link.az + link.bz) * 0.5 - pz;
      const d = Math.hypot(mx, mz);
      const spread = 1 / (1 + (d / 38) * (d / 38));
      const ahead = headX === 0 && headZ === 0 ? 0 : Math.max(0, (mx * headX + mz * headZ) / d);
      const weight = spread * (1 + 1.9 * ahead);
      total += weight;
      // Weighted reservoir sample: one pass, no temporary array.
      if (this.rng.next() * total < weight) chosen = index;
    }
    if (chosen < 0) {
      ped.active = false;
      return;
    }
    this.place(ped, chosen, this.rng.next());
    this.stats.respawned += 1;
  }

  /** One pass of positional relaxation, so a fresh crowd is never stacked. */
  private separateInitial(): void {
    for (let pass = 0; pass < 4; pass += 1) {
      this.reindex();
      this.resolveOverlaps(1);
    }
  }

  // -- neighbour index ------------------------------------------------------

  private reindex(): void {
    this.cellHead.fill(-1);
    for (let i = 0; i < this.peds.length; i += 1) {
      const ped = this.peds[i];
      if (!ped || !ped.active) {
        this.cellNext[i] = -1;
        continue;
      }
      const key = hashCell(Math.floor(ped.x / CELL), Math.floor(ped.z / CELL));
      this.cellNext[i] = this.cellHead[key] ?? -1;
      this.cellHead[key] = i;
    }
  }

  // -- stepping -------------------------------------------------------------

  update(dt: number, ctx: CrowdContext): void {
    if (dt <= 0) return;
    const step = Math.min(dt, 0.1);

    const jumped =
      !Number.isFinite(this.lastPlayerX) ||
      Math.hypot(ctx.x - this.lastPlayerX, ctx.z - this.lastPlayerZ) > TELEPORT_JUMP;
    if (!jumped && Number.isFinite(this.lastPlayerX)) {
      const dx = ctx.x - this.lastPlayerX;
      const dz = ctx.z - this.lastPlayerZ;
      const rate = 1 - Math.exp(-0.6 * step);
      this.driftX += (dx / step - this.driftX) * rate;
      this.driftZ += (dz / step - this.driftZ) * rate;
    }
    this.lastPlayerX = ctx.x;
    this.lastPlayerZ = ctx.z;
    if (jumped) {
      // A teleport (or the first frame) invalidates the whole distribution.
      // Reseeding is far cheaper than watching every agent recycle one by one.
      this.seed(ctx.x, ctx.z);
      return;
    }

    this.stats.active = 0;
    this.stats.near = 0;
    this.stats.mid = 0;
    this.stats.far = 0;
    this.stats.rendered = 0;
    this.stats.stepped = 0;
    this.stats.waiting = 0;
    this.stats.crossing = 0;

    this.reindex();

    for (let i = 0; i < this.peds.length; i += 1) {
      const ped = this.peds[i];
      if (!ped) continue;
      if (i >= this.budget) {
        ped.active = false;
        continue;
      }
      if (!ped.active) {
        this.respawn(ped, ctx.x, ctx.z);
        continue;
      }

      const distance = Math.hypot(ped.x - ctx.x, ped.z - ctx.z);
      if (distance > RECYCLE_RADIUS) {
        this.respawn(ped, ctx.x, ctx.z);
        continue;
      }

      ped.lod = distance < LOD_NEAR ? 0 : distance < LOD_MID ? 1 : 2;
      this.stats.active += 1;
      if (ped.lod === 0) this.stats.near += 1;
      else if (ped.lod === 1) this.stats.mid += 1;
      else this.stats.far += 1;
      if (distance <= RENDER_RADIUS) this.stats.rendered += 1;
      if (ped.state === 'wait') this.stats.waiting += 1;
      if (ped.state === 'cross') this.stats.crossing += 1;

      // The walk cycle advances every frame even when the agent does not, so
      // a distant figure never stutters. One add per pedestrian.
      this.advancePhase(ped, step);

      const stride = ped.lod === 0 ? 1 : ped.lod === 1 ? 2 : 4;
      ped.due -= 1;
      if (ped.due > 0) continue;
      ped.due = stride;
      this.stats.stepped += 1;
      this.step(ped, i, step * stride, ctx);
    }

    this.resolveOverlaps(2);
  }

  private advancePhase(ped: Pedestrian, dt: number): void {
    const look = ped.look;
    // `gaitCadence` is shared with the renderer so the stride the shader draws
    // is the stride the pedestrian is actually covering.
    const cadence = gaitCadence(ped.speed, look.preferredSpeed, look.cadence, look.height);
    ped.cadenceNow = cadence;
    // Never freeze completely: a standing figure still breathes and shifts its
    // weight, and the amplitude is what makes it a stand rather than a walk.
    ped.phase = (ped.phase + cadence * dt * Math.max(ped.gait, 0.14)) % 1;
    if (ped.phase < 0) ped.phase += 1;
  }

  private step(ped: Pedestrian, index: number, dt: number, ctx: CrowdContext): void {
    const entry = this.graph.links[ped.link];
    if (!entry) {
      this.respawn(ped, ctx.x, ctx.z);
      return;
    }

    this.decide(ped, entry, dt, ctx);

    // `decide` may have handed the pedestrian to the next link. Everything
    // below - the target, the kerb slide, the projection - has to be about the
    // link they are on NOW. Reusing the entry link here meant a pedestrian who
    // had just turned a corner was steered and then re-projected onto the
    // corridor they had left, which pinned them at a negative distance along
    // their new link and stalled them until the watchdog turned them round.
    const link = this.graph.links[ped.link];
    if (!link) {
      this.respawn(ped, ctx.x, ctx.z);
      return;
    }

    const stopped = ped.state === 'wait' || ped.state === 'pause';
    const goalAlong = stopped ? ped.waitAlong : ped.along + this.lookahead(ped);

    ped.dodge = Math.max(0, ped.dodge - dt);

    let targetX: number;
    let targetZ: number;
    // Aiming past the corner is right for a clear corner and wrong for a
    // blocked one: it throws away the lateral preference, which is the only
    // thing that can carry a walker round a prop parked in the gap. So anyone
    // who is currently squeezing past something finishes THIS link first.
    if (!stopped && goalAlong > link.length && ped.dodge <= 0) {
      // Aim just past the corner, on the next link's CENTRELINE.
      //
      // Two links meeting at a right angle swap axes: the next link's lateral
      // direction is the current link's direction of travel. Carrying a
      // lateral preference through the corner therefore places the target up
      // to a pavement half width BEHIND the pedestrian, and they walk backwards
      // into the corner instead of round it. Aiming at the centreline a little
      // way past the corner always leaves a forward component.
      const next = this.graph.links[ped.next];
      if (next) {
        const over = clamp(goalAlong - link.length, 0.6, next.length);
        linkPoint(next, over, 0, this.scratch);
      } else {
        linkPoint(link, link.length, ped.lateralTarget, this.scratch);
      }
      targetX = this.scratch.x;
      targetZ = this.scratch.z;

      // ...but only when that point is genuinely IN FRONT.
      //
      // Nothing in the graph promises a continuation leads onward. A pavement
      // chain resumes on the far kerb of the crossing that reaches it, running
      // straight back the way the walker came: `x:j:cannery-row:grand-concourse:w`
      // ends at (-82.10, -75.50) heading (0, -1) and its legal successor
      // `p:cannery-row:-1:3` leaves the same node heading (0, +1). Aiming
      // `over` metres along THAT put the target within a centimetre of a walker
      // standing 0.65 m short of the kerb - and, being a target rather than a
      // stop, it was chased at full walking speed. The walker overshot it, the
      // direction flipped, and they oscillated a centimetre either side of one
      // spot for ever: `along` never reached `link.length - 0.05`, so `decide`
      // never handed them on, and `watchStall` may not U-turn a body off a
      // crossing. Measured over four minutes with 270 people: nine were locked
      // in that cycle for more than thirty seconds and one for two minutes,
      // every one of them standing in a carriageway.
      //
      // The corner itself is the honest fallback. It is `link.length - along`
      // metres ahead by construction, so progress along the link is guaranteed.
      if ((targetX - ped.x) * link.dx + (targetZ - ped.z) * link.dz < MIN_CORNER_AHEAD) {
        linkPoint(link, link.length, 0, this.scratch);
        targetX = this.scratch.x;
        targetZ = this.scratch.z;
      }
    } else {
      linkPoint(link, Math.min(goalAlong, link.length), ped.lateralTarget, this.scratch);
      targetX = this.scratch.x;
      targetZ = this.scratch.z;
    }

    let dx = targetX - ped.x;
    let dz = targetZ - ped.z;
    const distance = Math.hypot(dx, dz);
    // A stopped pedestrian is speed-limited by how far they still have to go,
    // so a short vector is safe for them. A walking one is not: they are driven
    // at their full preferred speed whatever the distance, so anything shorter
    // than a step has to give way to the link's own direction or they oscillate.
    if (distance > (stopped ? 1e-4 : MIN_TARGET_DISTANCE)) {
      dx /= distance;
      dz /= distance;
    } else {
      dx = link.dx;
      dz = link.dz;
    }

    let desired = stopped ? Math.min(0.45, distance * 1.6) : this.desiredSpeed(ped, link);
    let steerX = dx * desired;
    let steerZ = dz * desired;

    if (ped.lod <= 1) {
      const brake = this.avoid(ped, index, dx, dz);
      steerX += this.push.x;
      steerZ += this.push.z;
      desired *= brake;
      // A shuffling floor. Without it a jam is absorbing: everyone reaches
      // zero, the avoidance terms that depend on motion vanish, and the knot
      // never unties. Only a vehicle or a deliberate wait may stop someone.
      if (!stopped) desired = Math.max(desired, 0.22);
    }

    if (ped.lod === 0 || ped.state === 'cross') {
      const vehicleBrake = this.avoidVehicles(ped, dx, dz, ctx);
      desired *= vehicleBrake;
    }

    const maxSpeed = ped.look.preferredSpeed * 1.75;
    const steerLength = Math.hypot(steerX, steerZ);
    if (steerLength > maxSpeed) {
      steerX = (steerX / steerLength) * maxSpeed;
      steerZ = (steerZ / steerLength) * maxSpeed;
    }

    // Damped velocity rather than a direct set: an agent that snaps to its
    // steering output shivers whenever two influences disagree by a degree.
    ped.vx = damp(ped.vx, steerX, 7, dt);
    ped.vz = damp(ped.vz, steerZ, 7, dt);

    const speed = Math.hypot(ped.vx, ped.vz);
    const cap = Math.max(0, desired);
    if (speed > cap && speed > 1e-5) {
      ped.vx = (ped.vx / speed) * cap;
      ped.vz = (ped.vz / speed) * cap;
    }
    // Slide along the kerb rather than press into it.
    //
    // Without this a pedestrian aiming round a corner points straight at the
    // pavement opposite, the lateral clamp cancels the whole step, and they
    // stand there at full walking speed making no headway for ever. Measured
    // before the fix: 72 of 270 had travelled under 0.6 m in twenty seconds.
    const intoWall = ped.vx * link.nx + ped.vz * link.nz;
    if (
      (ped.lateral >= link.halfWidth - 1e-4 && intoWall > 0) ||
      (ped.lateral <= -link.halfWidth + 1e-4 && intoWall < 0)
    ) {
      ped.vx -= intoWall * link.nx;
      ped.vz -= intoWall * link.nz;
    }

    ped.speed = Math.hypot(ped.vx, ped.vz);
    ped.gait = damp(ped.gait, ped.speed > 0.16 ? 1 : 0, 6, dt);

    ped.x += ped.vx * dt;
    ped.z += ped.vz * dt;

    if (ped.lod === 0) {
      // Street furniture is a hard constraint, not a suggestion.
      if (this.obstacles.resolve(ped.x, ped.z, PED_RADIUS + 0.14, this.push)) {
        ped.x += this.push.x;
        ped.z += this.push.z;
        // Same slide, against the lamp post rather than the kerb.
        const length = Math.hypot(this.push.x, this.push.z);
        if (length > 1e-5) {
          const into = (ped.vx * this.push.x + ped.vz * this.push.z) / length;
          if (into < 0) {
            ped.vx -= (into * this.push.x) / length;
            ped.vz -= (into * this.push.z) / length;
          }
          // Sliding alone is not an escape route.
          //
          // A prop square across the line of travel leaves nothing after the
          // slide: the whole velocity IS the into-component, cancelling it
          // leaves zero, and the walker stands against the thing at full
          // walking speed making no headway. The stall watchdog's mirror flip
          // of the lateral preference does not help either, because a prop over
          // the middle of a corridor blocks both mirrored offsets equally.
          //
          // So go and look for the gap. `clearLateralAhead` is the smallest
          // change of course that clears whatever is in the way; steering to it
          // covers the walk, and a nudge of real velocity toward it covers the
          // frame, so the decision shows before the next steering step.
          const clear = this.clearLateralAhead(ped, link);
          ped.lateralTarget = clear;
          const side = Math.sign(clear - ped.lateral);
          if (side !== 0) {
            ped.dodge = DODGE_TIME;
            ped.vx += side * link.nx * SIDESTEP;
            ped.vz += side * link.nz * SIDESTEP;
          }
        }
      }
    }

    this.project(ped, link);
    this.watchStall(ped, link, dt);

    if (ped.speed > 0.14) {
      ped.heading = dampAngle(ped.heading, Math.atan2(-ped.vx, -ped.vz), 8, dt);
    }

    ped.groundAge += dt;
    const groundEvery = ped.lod === 0 ? 0 : ped.lod === 1 ? 0.2 : 0.7;
    if (ped.groundAge >= groundEvery) {
      ped.groundAge = 0;
      const sample = this.ground.sample(ped.x, ped.z);
      // Snap when close, ease when the pavement steps: a kerb is 0.15 m and a
      // person should rise over it, not pop.
      ped.y = Math.abs(sample.y - ped.y) > 0.4 ? sample.y : damp(ped.y, sample.y, 14, dt);
    }
  }

  /**
   * The offset a little way ahead, nearest to where the walker already is, that
   * street furniture is not standing in.
   *
   * Searched outward from their own offset so the answer is the smallest change
   * of course that clears the obstruction, and stepped at 0.12 m because the
   * tightest gap this city's scatter leaves on a route is 0.20 m wide. Returns
   * the walker's current offset when nothing is clear, which leaves the stall
   * watchdog to deal with it.
   *
   * Only ever called for a LOD 0 agent that is actually touching something, so
   * the probe cost - at most a few dozen grid lookups - is paid by a handful of
   * agents a frame rather than by the crowd.
   */
  private clearLateralAhead(ped: Pedestrian, link: PavementLink): number {
    const width = link.halfWidth;
    const ahead = Math.min(link.length, ped.along + 0.6);
    const radius = PED_RADIUS + 0.14;
    const steps = Math.ceil((2 * width) / LATERAL_PROBE_STEP);
    for (let i = 1; i <= steps; i += 1) {
      for (let sign = 1; sign >= -1; sign -= 2) {
        const lateral = clamp(ped.lateral + sign * i * LATERAL_PROBE_STEP, -width, width);
        linkPoint(link, ahead, lateral, this.probe);
        if (!this.obstacles.resolve(this.probe.x, this.probe.z, radius, this.probePush)) {
          return lateral;
        }
      }
    }
    return ped.lateral;
  }

  /**
   * Notices a pedestrian who is not getting anywhere, and does something a
   * person would do about it.
   *
   * Measured on WORLD displacement over a window, not on progress along the
   * link. Along-progress alone counts someone crossing the width of a wide
   * pavement as stuck, and "fixing" that by flipping their preferred side sets
   * up an oscillation that is worse than the problem.
   *
   * A safety net rather than a mechanism. First try the other side of whatever
   * is in the way; if that fails twice, give up and walk back the way you came.
   * Neither is a teleport, so a player sees someone change their mind.
   */
  private watchStall(ped: Pedestrian, link: PavementLink, dt: number): void {
    if (ped.state !== 'walk' && ped.state !== 'cross') {
      ped.stall = 0;
      ped.anchorX = ped.x;
      ped.anchorZ = ped.z;
      return;
    }
    ped.stall += dt;
    if (ped.stall < 2.5) return;
    const moved = Math.hypot(ped.x - ped.anchorX, ped.z - ped.anchorZ);
    ped.stall = 0;
    ped.anchorX = ped.x;
    ped.anchorZ = ped.z;
    if (moved > 0.9) {
      ped.stallTries = 0;
      return;
    }
    ped.stallTries += 1;
    this.stats.detours += 1;
    if (ped.stallTries < 3) {
      const width = link.halfWidth;
      const flipped = ped.lateralTarget === 0 ? width * 0.6 : -ped.lateralTarget;
      ped.lateralTarget = clamp(flipped, -width, width);
      return;
    }
    ped.stallTries = 0;
    // Only turn round for a genuine blockage, not for a slow queue - and never
    // onto a crossing, because the reverse of a crossing is the same strip of
    // carriageway and taking it here would skip the signal check entirely.
    // Somebody stalled halfway across a road is safer finishing the crossing.
    const back = this.graph.links[link.reverse];
    if (moved < 0.35 && back && !back.crossing) {
      ped.next = link.reverse;
      ped.state = 'walk';
      this.commit(ped);
      return;
    }
    if (moved >= 0.35) return;

    // Still stuck, and nowhere legal to turn. Resetting `stallTries` and hoping
    // is what let a body stand in a carriageway for two minutes: the ladder has
    // to end in something that always works. Finishing the link is the one move
    // that is both legal anywhere - it is the direction they were already
    // walking, on the corridor they are already on - and productive, because
    // reaching `link.length` is exactly what hands them to the next link.
    // Capped at half a stride and at the distance remaining, so it reads as a
    // step rather than a teleport, and `project` still owns where they land.
    const room = Math.max(0, link.length - ped.along);
    const nudge = Math.min(STALL_NUDGE, room);
    if (nudge <= 0) return;
    ped.x += link.dx * nudge;
    ped.z += link.dz * nudge;
    // Re-pick the continuation: the one they had is the likeliest reason they
    // were not getting anywhere.
    ped.next = -1;
    this.project(ped, link);
  }

  /** How far ahead a pedestrian aims. Longer at speed, so turns anticipate. */
  private lookahead(ped: Pedestrian): number {
    return clamp(1.1 + ped.speed * 0.75, 1.1, 3.1);
  }

  private desiredSpeed(ped: Pedestrian, link: PavementLink): number {
    let speed = ped.look.preferredSpeed;
    // Nobody dawdles on a carriageway.
    if (link.crossing) speed *= 1.16;
    return speed;
  }

  /**
   * Projects the free-moving position back onto the pavement.
   *
   * Only the LATERAL clamp may move a pedestrian. `along` is bookkeeping: it
   * records progress and triggers the hand-over to the next link, and clamping
   * it used to be applied to the world position too. That was wrong at every
   * corner - two links meeting at a right angle turn one's lateral offset into
   * the other's along offset, so a pedestrian arriving at a corner enters the
   * next link with a NEGATIVE along of up to a full pavement half width, and
   * folding that back to zero teleported them up to 2.8 m sideways. The corner
   * apron they are standing on is real pavement, so the honest answer is to
   * leave them on it and let them walk out of it.
   */
  private project(ped: Pedestrian, link: PavementLink): void {
    const rx = ped.x - link.ax;
    const rz = ped.z - link.az;
    const along = rx * link.dx + rz * link.dz;
    let lateral = rx * link.nx + rz * link.nz;
    const limit = link.halfWidth;
    if (lateral > limit) lateral = limit;
    else if (lateral < -limit) lateral = -limit;
    else {
      ped.along = clamp(along, -3.4, link.length + 0.6);
      ped.lateral = lateral;
      return;
    }
    ped.along = clamp(along, -3.4, link.length + 0.6);
    ped.lateral = lateral;
    // Rebuild from the TRUE along, never the clamped one.
    ped.x = link.ax + link.dx * along + link.nx * lateral;
    ped.z = link.az + link.dz * along + link.nz * lateral;
  }

  // -- intent ---------------------------------------------------------------

  private decide(ped: Pedestrian, link: PavementLink, dt: number, ctx: CrowdContext): void {
    if (ped.state === 'pause') {
      ped.timer -= dt;
      if (ped.timer <= 0) ped.state = 'walk';
      return;
    }

    if (ped.state === 'cross' && ped.along >= link.length - 0.05) {
      ped.state = 'walk';
    }

    // Choose the continuation early enough to slow down for it.
    if (ped.next < 0 && ped.along > link.length - Math.max(3.5, ped.speed * 2.2)) {
      ped.next = this.chooseNext(link);
    }

    if (ped.state === 'wait') {
      ped.timer += dt;
      const next = this.graph.links[ped.next];
      if (!next) {
        ped.state = 'walk';
        return;
      }
      if (this.crossingClear(next, ctx, ped.look.preferredSpeed)) {
        ped.state = 'cross';
        ped.timer = 0;
        this.commit(ped);
      }
      return;
    }

    if (ped.along < link.length - 0.05) {
      // A short stop to look at something. Only ever on a pavement, never in
      // the road, and never right at a kerb where it would block a crossing.
      if (
        ped.state === 'walk' &&
        !link.crossing &&
        ped.along > 3 &&
        ped.along < link.length - 6 &&
        this.rng.next() < ped.look.dwell * 0.0016 * dt * 60
      ) {
        ped.state = 'pause';
        ped.timer = this.rng.range(1.6, 6.5);
        ped.waitAlong = ped.along;
      }
      return;
    }

    const next = this.graph.links[ped.next < 0 ? (ped.next = this.chooseNext(link)) : ped.next];
    if (!next) {
      // Nowhere to go: turn around rather than stand in the way for ever.
      // A crossing is never a legal fallback; only the signalled path enters one.
      const back = this.graph.links[link.reverse];
      if (back && !back.crossing) {
        ped.next = link.reverse;
        this.commit(ped);
      }
      return;
    }

    if (next.crossing && !this.crossingClear(next, ctx, ped.look.preferredSpeed)) {
      ped.state = 'wait';
      ped.timer = 0;
      // Stand a little back from the kerb, and spread across it, so a group
      // waiting to cross does not queue single file in the way of the people
      // coming the other way off the crossing.
      ped.waitAlong = Math.max(0, link.length - this.rng.range(0.15, 1.8));
      ped.lateralTarget = this.rng.range(-link.halfWidth * 0.85, link.halfWidth * 0.85);
      return;
    }

    ped.state = next.crossing ? 'cross' : 'walk';
    this.commit(ped);
  }

  /** Moves a pedestrian onto `ped.next`, keeping their world position exact. */
  private commit(ped: Pedestrian): void {
    const next = this.graph.links[ped.next];
    if (!next) return;
    ped.link = ped.next;
    ped.next = -1;
    ped.lateralTarget = this.preferredLateral(next, ped.look);
    this.project(ped, next);
  }

  /**
   * Picks the next link.
   *
   * Straight on is much the most likely; a U-turn is a last resort. Crossings
   * are picked far less often than the geometry alone would suggest, because a
   * crowd that crosses at every single opportunity spends its life in the road.
   */
  private chooseNext(link: PavementLink): number {
    const options = this.graph.linksFrom[link.to];
    if (!options || options.length === 0) return link.reverse;

    let bestIndex = -1;
    let bestScore = -1;
    for (const candidate of options) {
      const next = this.graph.links[candidate];
      if (!next) continue;
      // A corridor street furniture has closed is not a route. Offering one
      // strands whoever takes it, and on a crossing that means standing in a
      // carriageway until the watchdog notices.
      if (this.closed[candidate] === 1) continue;
      const straight = next.dx * link.dx + next.dz * link.dz;
      let weight: number;
      if (candidate === link.reverse) weight = 0.02;
      else if (next.crossing) weight = link.crossing ? 0.005 : 0.24 + 0.26 * Math.max(0, straight);
      else if (straight > 0.9) weight = 5.5;
      else weight = 1.15;
      // Reservoir-style weighted pick: one pass, no allocation.
      const score = this.rng.next() / weight;
      if (bestIndex < 0 || score < bestScore) {
        bestScore = score;
        bestIndex = candidate;
      }
    }
    return bestIndex >= 0 ? bestIndex : link.reverse;
  }

  /**
   * True when a pedestrian may step onto a crossing.
   *
   * Two conditions, both required: the shared signal says the traffic this
   * crossing cuts across is stopped, and no vehicle is close enough to reach
   * the crossing before we are off it. The second is what makes a red-light
   * runner survivable.
   */
  private crossingClear(link: PavementLink, ctx: CrowdContext, speed: number): boolean {
    const crossing = link.crossing;
    if (!crossing) return true;
    if (!walkSignal(this.network, crossing, ctx.time)) return false;

    const vehicles = ctx.vehicles;
    if (!vehicles || vehicles.length === 0) return true;

    const need = link.length / Math.max(0.4, speed);
    const horizon = Math.min(6, need + 1.2);
    const cx = (link.ax + link.bx) * 0.5;
    const cz = (link.az + link.bz) * 0.5;
    const reach = link.length * 0.5 + 2.4;
    for (const vehicle of vehicles) {
      const vx = vehicle.vx ?? 0;
      const vz = vehicle.vz ?? 0;
      let rx = vehicle.x - cx;
      let rz = vehicle.z - cz;
      if (Math.hypot(rx, rz) < reach) return false;
      const closing = rx * vx + rz * vz;
      if (closing >= 0) continue;
      const speedSq = vx * vx + vz * vz;
      if (speedSq < 0.25) continue;
      const t = Math.min(horizon, -closing / speedSq);
      rx += vx * t;
      rz += vz * t;
      if (Math.hypot(rx, rz) < reach) return false;
    }
    return true;
  }

  // -- avoidance ------------------------------------------------------------

  /**
   * Writes a steering displacement into `this.push` and returns a speed factor.
   *
   * The important distinction is between someone walking the same way and
   * everyone else. Matching the pace of the person you are following is what
   * makes a queue behave; applying it to a person coming the other way is a
   * deadlock, because both stop, both velocities go to zero, and the dodge -
   * which is computed from relative velocity - switches off exactly when it is
   * needed. Measured before this split: 36 of 204 walkers were stalled and 53
   * were stranded part-way across a road. So a neighbour who is stationary or
   * approaching is walked AROUND, never stopped for.
   *
   * The side is chosen from the sign of the cross product, which is the same
   * sign for both people in an encounter, so each steps to their own right and
   * the pair cannot mirror each other into a stalemate.
   */
  private avoid(ped: Pedestrian, index: number, dx: number, dz: number): number {
    this.push.x = 0;
    this.push.z = 0;
    let brake = 1;

    const near = ped.lod === 0;
    const range = near ? 3.0 : 1.6;
    const cx = Math.floor(ped.x / CELL);
    const cz = Math.floor(ped.z / CELL);
    const span = range > CELL ? 2 : 1;
    const contact = PED_RADIUS * 2 + 0.14;

    for (let i = -span; i <= span; i += 1) {
      for (let j = -span; j <= span; j += 1) {
        let other = this.cellHead[hashCell(cx + i, cz + j)] ?? -1;
        while (other >= 0) {
          const step = this.cellNext[other] ?? -1;
          if (other === index) {
            other = step;
            continue;
          }
          const o = this.peds[other];
          if (!o || !o.active) {
            other = step;
            continue;
          }
          const rx = o.x - ped.x;
          const rz = o.z - ped.z;
          const d2 = rx * rx + rz * rz;
          if (d2 > range * range || d2 < 1e-8) {
            other = step;
            continue;
          }
          const d = Math.sqrt(d2);

          if (d < contact + 0.85) {
            const strength = ((contact + 0.85 - d) / (contact + 0.85)) * 2.2;
            this.push.x -= (rx / d) * strength;
            this.push.z -= (rz / d) * strength;
          }

          const ahead = (rx * dx + rz * dz) / d;
          if (ahead > 0.6 && d < 2.4) {
            const theirs = o.vx * dx + o.vz * dz;
            if (theirs > 0.25) {
              const room = clamp((d - contact) / 1.2, 0, 1);
              const allowed = theirs * (1 - room) + ped.look.preferredSpeed * room;
              brake = Math.min(
                brake,
                clamp(allowed / Math.max(0.2, ped.look.preferredSpeed), 0.12, 1),
              );
            } else {
              // Positive means they are to our left; step the other way.
              const toLeft = dx * rz - dz * rx;
              const side = toLeft > 0 ? -1 : 1;
              const urgency = clamp((2.4 - d) / 2.4, 0, 1) * 2.1;
              this.push.x += side * -dz * urgency;
              this.push.z += side * dx * urgency;
              brake = Math.min(brake, clamp(0.4 + (d - contact) * 0.55, 0.34, 1));
            }
          }

          if (near) {
            const rvx = ped.vx - o.vx;
            const rvz = ped.vz - o.vz;
            const rvSq = rvx * rvx + rvz * rvz;
            if (rvSq > 0.02) {
              const t = clamp(-(rx * rvx + rz * rvz) / rvSq, 0, 2.4);
              if (t > 0.001) {
                const mx = rx - rvx * t;
                const mz = rz - rvz * t;
                const miss = Math.hypot(mx, mz);
                if (miss < contact + 0.34) {
                  const urgency = (contact + 0.34 - miss) / (0.5 + t);
                  if (miss > 1e-3) {
                    this.push.x -= (mx / miss) * urgency * 1.5;
                    this.push.z -= (mz / miss) * urgency * 1.5;
                  } else {
                    this.push.x += dz * urgency;
                    this.push.z -= dx * urgency;
                  }
                }
              }
            }
          }
          other = step;
        }
      }
    }
    return brake;
  }

  /** Keeps the crowd out from under the player's feet. */
  avoidPlayer(px: number, pz: number, dt: number): void {
    const radius = 0.95;
    for (const ped of this.peds) {
      if (!ped.active || ped.lod !== 0) continue;
      const rx = ped.x - px;
      const rz = ped.z - pz;
      const d = Math.hypot(rx, rz);
      if (d > radius || d < 1e-4) continue;
      const link = this.graph.links[ped.link];
      if (!link) continue;
      const gain = (radius - d) / radius;
      ped.x += (rx / d) * gain * Math.min(0.9, 5 * dt);
      ped.z += (rz / d) * gain * Math.min(0.9, 5 * dt);
      this.project(ped, link);
    }
  }

  /** Returns a speed factor: hurry across, or stop for a vehicle that will not. */
  private avoidVehicles(
    ped: Pedestrian,
    dx: number,
    dz: number,
    ctx: CrowdContext,
  ): number {
    const vehicles = ctx.vehicles;
    if (!vehicles || vehicles.length === 0) return 1;
    const link = this.graph.links[ped.link];
    const onRoad = link?.crossing != null;
    let factor = 1;
    for (const vehicle of vehicles) {
      const rx = vehicle.x - ped.x;
      const rz = vehicle.z - ped.z;
      const d2 = rx * rx + rz * rz;
      if (d2 > 400) continue;
      const vx = vehicle.vx ?? 0;
      const vz = vehicle.vz ?? 0;
      const halfLength = vehicle.halfLength ?? 2.3;
      const halfWidth = vehicle.halfWidth ?? 0.95;
      const clearance = Math.max(halfLength, halfWidth) + PED_RADIUS + 0.5;
      const d = Math.sqrt(d2);
      if (d < clearance) return 0;
      const rvx = ped.vx - vx;
      const rvz = ped.vz - vz;
      const rvSq = rvx * rvx + rvz * rvz;
      if (rvSq < 0.09) continue;
      const t = clamp(-(rx * rvx + rz * rvz) / rvSq, 0, 4);
      const mx = rx - rvx * t;
      const mz = rz - rvz * t;
      if (Math.hypot(mx, mz) > clearance + 0.6) continue;
      if (!onRoad) {
        // On the pavement a near miss just means standing still for a moment.
        factor = Math.min(factor, t < 1.4 ? 0 : 0.5);
        continue;
      }
      // Already committed to the road: getting off it fast beats stopping,
      // unless the vehicle arrives before we could clear its path.
      const ahead = rx * dx + rz * dz;
      factor = Math.min(factor, t < 0.9 && ahead > 0 ? 0 : 1);
      if (t < 2.6) factor = Math.max(factor, 1.45);
    }
    return factor;
  }

  /**
   * Positional correction so two pedestrians never share a spot.
   *
   * Runs after integration, so it is the last word. The correction is split
   * between the pair and then re-projected onto the pavement, which is why
   * someone squeezed against a wall stops rather than being pushed through it.
   */
  private resolveOverlaps(iterations: number): void {
    const minimum = PED_RADIUS * 2;
    for (let pass = 0; pass < iterations; pass += 1) {
      for (let i = 0; i < this.peds.length; i += 1) {
        const ped = this.peds[i];
        if (!ped || !ped.active || ped.lod > 1) continue;
        const cx = Math.floor(ped.x / CELL);
        const cz = Math.floor(ped.z / CELL);
        for (let a = -1; a <= 1; a += 1) {
          for (let b = -1; b <= 1; b += 1) {
            let other = this.cellHead[hashCell(cx + a, cz + b)] ?? -1;
            while (other >= 0) {
              const step = this.cellNext[other] ?? -1;
              if (other <= i) {
                other = step;
                continue;
              }
              const o = this.peds[other];
              if (!o || !o.active) {
                other = step;
                continue;
              }
              let rx = o.x - ped.x;
              let rz = o.z - ped.z;
              let d = Math.hypot(rx, rz);
              if (d >= minimum) {
                other = step;
                continue;
              }
              if (d < 1e-5) {
                // Coincident: separate along a stable, index-derived axis so
                // the pair cannot oscillate between two equal answers.
                const angle = ((i * 2654435761) % 1000) / 1000 * TAU;
                rx = Math.cos(angle);
                rz = Math.sin(angle);
                d = 1;
              }
              const correction = (minimum - d) * 0.5;
              const ux = (rx / d) * correction;
              const uz = (rz / d) * correction;
              ped.x -= ux;
              ped.z -= uz;
              o.x += ux;
              o.z += uz;
              const la = this.graph.links[ped.link];
              const lb = this.graph.links[o.link];
              if (la) this.project(ped, la);
              if (lb) this.project(o, lb);
              other = step;
            }
          }
        }
      }
      if (pass + 1 < iterations) this.reindex();
    }
  }
}
