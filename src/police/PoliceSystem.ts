/**
 * Meridian Bay's police response.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   import { PoliceSystem } from './police/PoliceSystem';
 *
 *   const police = new PoliceSystem({
 *     player, traffic, network, collision,
 *     world: worldRays,                       // the same WorldRayIndex combat uses
 *     heightAt: (x, z) => ground.heightAt(x, z),
 *     effects: combat.effects,                // optional: shared muzzle flashes
 *     onArrest: () => respawn.bust('arrested'),
 *     quality: 'high',
 *   });
 *   engine.scene.add(police.group);
 *
 *   police.update(dt, {
 *     time: elapsed, playerX, playerY, playerZ, playerSpeed,
 *     forwardX, forwardZ, driving,
 *   });
 *
 *   police.dispose();
 *
 * IT OWNS THE COOLDOWN. `PlayerState.coolOff(dt, pursued)` is called from here
 * once per update, because this is the only object that knows whether anybody
 * still has eyes on the player. Do not call it anywhere else, or the heat will
 * decay twice as fast as the stars imply.
 *
 * IT COMMANDEERS AMBIENT TRAFFIC. A pursuit unit is a patrol car that was
 * already driving somewhere else, taken over with `TrafficSystem.takeControl`
 * and placed on a road about a hundred metres away, out of the player's view.
 * There is no second vehicle system, no second renderer and no second fleet:
 * the car being chased in is a car that was in the city a moment ago, and it
 * goes back to being traffic when the chase ends. Where no patrol car is far
 * enough away - the fleet only carries five or six - an ordinary saloon is
 * taken instead and works as an unmarked unit.
 *
 * WHAT IT ADDS TO THE FRAME: two draw calls during a pursuit (one instanced
 * mesh of officers, one of beacon lenses), and none at all while nobody is
 * wanted, because both meshes are hidden. It adds NO LIGHTS.
 *
 * ============================================================================
 */

import { Group, type Object3D } from 'three';

import { laneHeading, lanePoint, type LaneSegment, type RoadNetwork } from '../city/RoadNetwork';
import { clamp, damp } from '../core/mathx';
import { createRng, type Rng } from '../core/rng';
import { ACTOR_HEALTH } from '../combat/ballistics';
import { hasLineOfSight, type WorldRayIndex } from '../combat/rays';
import type { ActorTarget, DamageResult, LawTargets } from '../combat/targets';
import type { PlayerState } from '../player/PlayerState';
import type { CollisionWorld } from '../player/Collision';
import type { VehicleHandle, VehicleKind, VehicleView } from '../traffic/types';
import { Beacons, type BeaconPose } from './Beacons';
import { makeOfficer, OfficerRig, type OfficerPose } from './OfficerRig';
import {
  ABANDON_DISTANCE,
  ARREST_HEALTH,
  ARREST_RANGE,
  CAR_HOLD_RANGE,
  COMMANDEER_DISTANCE,
  DISMOUNT_RANGE,
  DISPATCH_DISTANCE,
  MAX_OFFICERS,
  MAX_UNITS,
  OFFICER_AIM_TIME,
  OFFICER_FIRE_RANGE,
  OFFICER_RUN_SPEED,
  OFFICER_SHOT_DAMAGE,
  OFFICER_SHOT_INTERVAL,
  PURSUIT_SPEED,
  SIGHT_RANGE_CAR,
  SIGHT_RANGE_FOOT,
  canArrest,
  carsForStars,
  dispatchInterval,
  officerAccuracy,
  officersPerCar,
  shootsOnSight,
} from './policy';
import { PursuitField, nearestLane, dispatchLane, pursuitSpeed, steerToward } from './pursuit';

/** Body dimensions used to move an officer through the world. */
const OFFICER_RADIUS = 0.34;
const OFFICER_HEIGHT = 1.8;
/** Eye height an officer sees and shoots from. */
const OFFICER_EYE = 1.6;
/** How close an officer closes to before stopping to shoot. */
const FIRING_STANDOFF = 7;
/** How close an officer closes to when trying to make an arrest. */
const ARREST_STANDOFF = 1.6;
/** Vehicle integrity. Roughly three rifle magazines, or one determined minute. */
const VEHICLE_INTEGRITY = 260;
/** Seconds a wrecked or stood-down unit lingers before rejoining traffic. */
const LINGER_SECONDS = 3;
/** Seconds an attack keeps every officer hostile. */
const HOSTILE_SECONDS = 40;
/** Body collision height used for the pursuit car, matching `Driving`. */
const CAR_BODY_HEIGHT = 1.4;
/** Sideways offset of the two extra sight rays, in metres. */
const SIGHT_SPREAD = 0.7;
/** Seconds between line-of-sight tests for one watcher. */
const SIGHT_INTERVAL = 0.12;
/** How far apart arriving units park, measured across the approach. */
const CORDON_SPACING = 4.2;
/** Within this range a stopped unit counts as stalled rather than travelling. */
const STALL_RANGE = 55;
/** Seconds a unit may sit still near the player before its crew gets out. */
const STALL_PATIENCE = 2.5;
/** Seconds of going nowhere before a unit reverses out of what it hit. */
const WEDGE_PATIENCE = 1.4;
/** How long one reversing manoeuvre lasts, and how fast it backs up. */
const REVERSE_SECONDS = 1.1;
const REVERSE_SPEED = 4.5;
/** Seconds without getting any closer before a unit is written off. */
const LOST_PATIENCE = 22;
/** Seconds an officer presses into something before going round it. */
const BLOCKED_PATIENCE = 1;
/** How long one detour lasts, and how far off the direct line it goes. */
const DETOUR_SECONDS = 2.4;
const DETOUR_ANGLE = 1.15;

/** Kinds acceptable as an unmarked unit when no patrol car is free. */
const UNMARKED_KINDS: ReadonlySet<VehicleKind> = new Set<VehicleKind>([
  'sedan',
  'coupe',
  'crossover',
  'wagon',
  'compact',
]);

type UnitState = 'driving' | 'holding' | 'wrecked' | 'standdown';
type OfficerState = 'riding' | 'chasing' | 'down';

interface Officer extends OfficerPose {
  id: number;
  unit: Unit;
  health: number;
  state: OfficerState;
  aim: number;
  shotTimer: number;
  sightTimer: number;
  /** Seconds spent pressing into something instead of getting closer. */
  blocked: number;
  /** Seconds left of a detour around whatever is in the way. */
  detour: number;
  /** Which way this officer goes round: alternates each time. */
  detourSide: 1 | -1;
  /** Seconds the arrest conditions have held continuously. */
  held: number;
  seesPlayer: boolean;
}

interface Unit {
  id: number;
  handle: VehicleHandle;
  state: UnitState;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  steer: number;
  lane: LaneSegment | null;
  integrity: number;
  linger: number;
  /** Seconds the unit has been close enough for its crew to get out. */
  closeFor: number;
  /** Countdown to the next line-of-sight test, so it is not run every frame. */
  sightTimer: number;
  /** Seconds this unit has been near the player and unable to make progress. */
  stalled: number;
  /** Seconds spent unable to move at all, anywhere. Drives the unwedge. */
  wedged: number;
  /** Seconds left of a reversing manoeuvre out of whatever it hit. */
  reversing: number;
  /** Closest this unit has ever been to the player, and how long ago. */
  bestDistance: number;
  sinceProgress: number;
  /** Fraction of last frame's requested movement it actually achieved. */
  progress: number;
  targetX: number;
  targetZ: number;
  officers: Officer[];
  marked: boolean;
  seesPlayer: boolean;
}

/** The slice of `TrafficSystem` a pursuit needs. */
export interface PursuitTraffic {
  readonly vehicles: readonly VehicleView[];
  takeControl(id: number): VehicleHandle | null;
  releaseControl(id: number): void;
}

/** The slice of `CombatFx` officers borrow, so their shots look like shots. */
export interface PoliceEffects {
  muzzle(x: number, y: number, z: number, scale: number): void;
  tracer(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void;
}

export interface PoliceSystemOptions {
  readonly player: PlayerState;
  readonly traffic: PursuitTraffic;
  readonly network: RoadNetwork;
  readonly collision: CollisionWorld;
  /** Solid world geometry, for line of sight. Share the combat layer's index. */
  readonly world: WorldRayIndex;
  readonly heightAt: (x: number, z: number) => number;
  readonly effects?: PoliceEffects | undefined;
  readonly quality?: 'low' | 'medium' | 'high' | undefined;
  readonly seed?: string | undefined;
  /** The player has been taken into custody. Drive the respawn from here. */
  readonly onArrest?: (() => void) | undefined;
  /** An officer fired. For audio. */
  readonly onOfficerShot?: (() => void) | undefined;
}

export interface PoliceContext {
  /** Seconds since world start, the same clock traffic and signals use. */
  readonly time: number;
  readonly playerX: number;
  readonly playerY: number;
  readonly playerZ: number;
  readonly playerSpeed: number;
  /** Where the player is looking, so a unit is not dispatched into the view. */
  readonly forwardX: number;
  readonly forwardZ: number;
  readonly driving: boolean;
}

export interface PoliceStats {
  readonly stars: number;
  readonly units: number;
  readonly officers: number;
  readonly pursued: boolean;
  readonly dispatched: number;
  readonly arrests: number;
  readonly officersDown: number;
  readonly vehiclesWrecked: number;
  readonly unmarked: number;
}

export class PoliceSystem implements LawTargets {
  /** Add this to the scene. Officers and beacons; nothing else. */
  readonly group: Object3D;

  private readonly options: PoliceSystemOptions;
  private readonly rig: OfficerRig;
  private readonly beacons: Beacons;
  private readonly rng: Rng;
  /** One flow field over the lane graph, shared by every unit. */
  private readonly field: PursuitField;

  private readonly units: Unit[] = [];
  private readonly officers: Officer[] = [];
  private readonly beaconPoses: BeaconPose[] = [];
  /** Reused so writing the rig allocates nothing per frame. */
  private readonly onFoot: Officer[] = [];
  private dispatchTimer = 0;
  /** The shared world clock, latched each update so damage can read it. */
  private now = 0;
  private nextUnitId = 1;
  private nextOfficerId = 1;
  private hostileUntil = -1;
  private pursuedNow = false;
  private disposed = false;

  private counters = { dispatched: 0, arrests: 0, officersDown: 0, vehiclesWrecked: 0, unmarked: 0 };
  /**
   * Where an officer's muzzle flash and tracer are drawn.
   *
   * Settable rather than constructor-only because the combat layer needs THIS
   * object to exist first - it damages officers through it - so the two cannot
   * both be built with a reference to the other.
   */
  private effects: PoliceEffects | null = null;

  private readonly scratchTarget: {
    id: number;
    x: number;
    y: number;
    z: number;
    radius: number;
    height: number;
    faction: 'police';
  } = { id: 0, x: 0, y: 0, z: 0, radius: 0, height: 0, faction: 'police' };

  constructor(options: PoliceSystemOptions) {
    this.options = options;
    this.rng = createRng(options.seed ?? 'meridian-police');
    this.field = new PursuitField(options.network);
    this.effects = options.effects ?? null;
    this.rig = new OfficerRig(MAX_OFFICERS, options.quality !== 'low');
    this.beacons = new Beacons(MAX_UNITS);

    const group = new Group();
    group.name = 'police';
    group.add(this.rig.mesh, this.beacons.object);
    group.userData.police = this;
    this.group = group;
  }

  // -- LawTargets -----------------------------------------------------------

  forEachActor(x: number, z: number, radius: number, visit: (target: ActorTarget) => void): void {
    const limit = radius * radius;
    for (const officer of this.officers) {
      if (officer.state !== 'chasing') continue;
      const dx = officer.x - x;
      const dz = officer.z - z;
      if (dx * dx + dz * dz > limit) continue;
      const target = this.scratchTarget;
      target.id = officer.id;
      target.x = officer.x;
      target.y = officer.y;
      target.z = officer.z;
      target.radius = 0.32 * officer.girth;
      target.height = officer.height;
      visit(target);
    }
  }

  damage(id: number, amount: number): DamageResult {
    const officer = this.officers.find((o) => o.id === id);
    if (!officer || officer.state === 'down' || amount <= 0) return 'none';
    officer.health -= amount;
    this.makeHostile();
    if (officer.health > 0) return 'hurt';
    officer.state = 'down';
    officer.health = 0;
    this.counters.officersDown += 1;
    return 'killed';
  }

  damageVehicle(vehicleId: number, amount: number): DamageResult {
    const unit = this.units.find((u) => u.handle.id === vehicleId);
    if (!unit || amount <= 0 || unit.state === 'wrecked') return 'none';
    unit.integrity -= amount;
    this.makeHostile();
    if (unit.integrity > 0) return 'hurt';
    unit.integrity = 0;
    this.wreck(unit);
    return 'killed';
  }

  reportAttack(): void {
    this.makeHostile();
  }

  watchingPlayer(): boolean {
    return this.pursuedNow;
  }

  // -- state ----------------------------------------------------------------

  /** True while any unit has line of sight to the player. */
  get pursued(): boolean {
    return this.pursuedNow;
  }

  /**
   * Per-unit detail, for automated QA and for the diagnostics overlay. This
   * allocates, so it is not for the frame loop.
   */
  get unitReport(): readonly {
    id: number;
    vehicleId: number;
    kind: string;
    state: string;
    marked: boolean;
    x: number;
    z: number;
    speed: number;
    integrity: number;
    seesPlayer: boolean;
    officers: number;
    onFoot: number;
  }[] {
    return this.units.map((unit) => ({
      id: unit.id,
      vehicleId: unit.handle.id,
      kind: unit.handle.kind,
      state: unit.state,
      marked: unit.marked,
      x: Number(unit.x.toFixed(1)),
      z: Number(unit.z.toFixed(1)),
      speed: Number(unit.speed.toFixed(2)),
      integrity: Math.round(unit.integrity),
      seesPlayer: unit.seesPlayer,
      officers: unit.officers.length,
      onFoot: unit.officers.filter((o) => o.state === 'chasing').length,
      lane: unit.lane?.id ?? '-',
      progress: Number(unit.progress.toFixed(2)),
      wedged: Number(unit.wedged.toFixed(1)),
      sinceProgress: Number(unit.sinceProgress.toFixed(1)),
      target: `${unit.targetX.toFixed(0)},${unit.targetZ.toFixed(0)}`,
    }));
  }

  get stats(): PoliceStats {
    return {
      stars: this.options.player.wanted,
      units: this.units.length,
      officers: this.officers.filter((o) => o.state === 'chasing').length,
      pursued: this.pursuedNow,
      ...this.counters,
    };
  }

  /** Ends the chase and returns every car to traffic. Used on respawn. */
  standDown(): void {
    for (const unit of this.units) this.release(unit);
    this.units.length = 0;
    this.officers.length = 0;
    this.pursuedNow = false;
    this.hostileUntil = -1;
    this.dispatchTimer = 0;
    this.rig.write(this.officers);
    this.beacons.write([], 0);
  }

  /** Points officers' gunfire at an effect pool. `CombatSystem.effects`. */
  setEffects(effects: PoliceEffects | null): void {
    this.effects = effects;
  }

  setQuality(quality: 'low' | 'medium' | 'high'): void {
    this.rig.setCastShadows(quality !== 'low');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.standDown();
    this.rig.dispose();
    this.beacons.dispose();
    this.group.clear();
  }

  // -- the frame ------------------------------------------------------------

  update(dt: number, ctx: PoliceContext): void {
    if (this.disposed || dt <= 0) return;
    this.now = ctx.time;
    const player = this.options.player;
    const stars = player.wanted;

    // One search for the whole response, and only when the player has moved
    // far enough to change any unit's answer.
    if (stars > 0) this.field.update(ctx.playerX, ctx.playerZ);

    this.updateDispatch(dt, stars, ctx);
    for (const unit of this.units) this.updateUnit(unit, dt, stars, ctx);
    this.updateOfficers(dt, stars, ctx);
    this.retire(dt, stars, ctx);

    // Eyes on the player is what keeps the heat from decaying, so it is
    // computed from the units themselves rather than from the star count.
    let pursued = false;
    for (const unit of this.units) if (unit.seesPlayer) pursued = true;
    for (const officer of this.officers) if (officer.seesPlayer) pursued = true;
    this.pursuedNow = pursued && stars > 0;
    player.coolOff(dt, this.pursuedNow);

    this.writeVisuals(ctx.time);
  }

  // -- dispatch -------------------------------------------------------------

  private updateDispatch(dt: number, stars: number, ctx: PoliceContext): void {
    if (stars <= 0) return;
    // Nobody is dispatched to a player who is already down. Without this the
    // city keeps sending cars through the two and a half seconds the outcome
    // is on screen, and one of them is still in the street on respawn.
    if (!this.options.player.alive) return;
    const wanted = carsForStars(stars);
    const live = this.units.filter((u) => u.state === 'driving' || u.state === 'holding').length;
    this.dispatchTimer -= dt;
    if (live >= wanted || this.units.length >= MAX_UNITS) return;
    if (this.dispatchTimer > 0) return;
    this.dispatchTimer = dispatchInterval(stars);
    this.dispatch(stars, ctx);
  }

  private dispatch(stars: number, ctx: PoliceContext): void {
    const source = this.pickVehicle(ctx.playerX, ctx.playerZ);
    if (!source) return;
    const spot = dispatchLane(
      this.options.network,
      ctx.playerX,
      ctx.playerZ,
      ctx.forwardX,
      ctx.forwardZ,
      DISPATCH_DISTANCE,
    );
    if (!spot) return;
    const handle = this.options.traffic.takeControl(source.id);
    if (!handle) return;

    const point = lanePoint(spot.lane, spot.along);
    const unit: Unit = {
      id: this.nextUnitId,
      handle,
      state: 'driving',
      x: point.x,
      z: point.z,
      yaw: laneHeading(spot.lane),
      speed: 9,
      steer: 0,
      lane: spot.lane,
      integrity: VEHICLE_INTEGRITY,
      linger: 0,
      closeFor: 0,
      sightTimer: 0,
      stalled: 0,
      wedged: 0,
      reversing: 0,
      bestDistance: Infinity,
      sinceProgress: 0,
      progress: 1,
      targetX: point.x,
      targetZ: point.z,
      officers: [],
      marked: source.police,
      seesPlayer: false,
    };
    this.nextUnitId += 1;
    handle.setPose({ x: unit.x, z: unit.z, yaw: unit.yaw, speed: unit.speed });

    const crew = officersPerCar(stars);
    for (let i = 0; i < crew; i += 1) {
      if (this.officers.length >= MAX_OFFICERS) break;
      const look = makeOfficer(this.nextOfficerId * 37 + unit.id);
      const officer: Officer = {
        id: this.nextOfficerId,
        unit,
        health: ACTOR_HEALTH,
        state: 'riding',
        aim: 0,
        shotTimer: 0,
        sightTimer: 0,
        blocked: 0,
        detour: 0,
        detourSide: i % 2 === 0 ? 1 : -1,
        held: 0,
        seesPlayer: false,
        x: unit.x,
        y: this.options.heightAt(unit.x, unit.z),
        z: unit.z,
        heading: unit.yaw,
        speed: 0,
        height: look.height,
        girth: look.girth,
        phase: this.rng.next(),
        gait: 0,
        variant: look.variant,
      };
      this.nextOfficerId += 1;
      unit.officers.push(officer);
      this.officers.push(officer);
    }

    this.units.push(unit);
    this.counters.dispatched += 1;
    if (!source.police) this.counters.unmarked += 1;
  }

  /**
   * A car to take over: a patrol car well out of sight if there is one, a
   * patrol car merely out of the immediate street if there is not, and an
   * ordinary saloon as an unmarked unit only when the fleet has no patrol car
   * left to give. The fleet carries five or six patrol cars in a hundred and
   * forty, so the last case is what a five-star response actually runs on.
   */
  private pickVehicle(px: number, pz: number): VehicleView | null {
    let farPatrol: VehicleView | null = null;
    let nearPatrol: VehicleView | null = null;
    let unmarked: VehicleView | null = null;
    let farPatrolScore = Infinity;
    let nearPatrolScore = Infinity;
    let unmarkedScore = Infinity;

    for (const view of this.options.traffic.vehicles) {
      if (view.control !== 'ambient') continue;
      if (this.units.some((u) => u.handle.id === view.id)) continue;
      const distance = Math.hypot(view.x - px, view.z - pz);
      if (view.police) {
        if (distance >= COMMANDEER_DISTANCE && distance < farPatrolScore) {
          farPatrolScore = distance;
          farPatrol = view;
        } else if (distance >= 70 && distance < nearPatrolScore) {
          nearPatrolScore = distance;
          nearPatrol = view;
        }
      } else if (
        UNMARKED_KINDS.has(view.kind) &&
        distance >= COMMANDEER_DISTANCE &&
        distance < unmarkedScore
      ) {
        unmarkedScore = distance;
        unmarked = view;
      }
    }
    return farPatrol ?? nearPatrol ?? unmarked;
  }

  // -- units ----------------------------------------------------------------

  private updateUnit(unit: Unit, dt: number, stars: number, ctx: PoliceContext): void {
    const view = unit.handle.view;
    const dx = ctx.playerX - unit.x;
    const dz = ctx.playerZ - unit.z;
    const distance = Math.hypot(dx, dz);

    unit.sightTimer -= dt;
    if (unit.sightTimer <= 0) {
      unit.sightTimer = SIGHT_INTERVAL;
      unit.seesPlayer =
        unit.state !== 'wrecked' &&
        unit.state !== 'standdown' &&
        distance < SIGHT_RANGE_CAR &&
        this.canSee(unit.x, view.y + 0.8, unit.z, ctx);
    }

    if (unit.state === 'wrecked' || unit.state === 'standdown') {
      unit.speed = damp(unit.speed, 0, 6, dt);
      this.integrate(unit, dt, 0);
      return;
    }

    // -- where to aim the car ------------------------------------------------
    // Every unit takes a different post across the approach, otherwise they
    // all follow the same lane to the same stopping point and three patrol
    // cars end up occupying one parking space.
    const slot = ((unit.id % 4) - 1.5) * CORDON_SPACING;
    const across = distance > 1e-3 ? { x: -dz / distance, z: dx / distance } : { x: 1, z: 0 };
    let targetX = ctx.playerX + across.x * slot;
    let targetZ = ctx.playerZ + across.z * slot;
    if (distance > DISMOUNT_RANGE * 2.2 && unit.lane) {
      // Far away: follow the lane graph, aiming at a point ahead on the lane.
      const along = this.alongLane(unit.lane, unit.x, unit.z);
      if (along > unit.lane.length - 7) {
        const next = this.field.next(unit.lane, ctx.playerX, ctx.playerZ);
        if (next) unit.lane = next;
      }
      const lane = unit.lane;
      const ahead = clamp(this.alongLane(lane, unit.x, unit.z) + 11, 0, lane.length);
      const point = lanePoint(lane, ahead);
      targetX = point.x;
      targetZ = point.z;
      // A car shoved far off its lane re-acquires the nearest one rather than
      // steering back to a road it can no longer reach.
      const offset = lane.axis === 'x' ? unit.x - lane.offset : unit.z - lane.offset;
      if (Math.abs(offset) > 13) unit.lane = nearestLane(this.options.network, unit.x, unit.z)?.lane ?? lane;
    } else {
      unit.lane = null;
    }

    unit.targetX = targetX;
    unit.targetZ = targetZ;

    const chassis = unit.handle.chassis;
    unit.steer = steerToward({
      yaw: unit.yaw,
      speed: unit.speed,
      steer: unit.steer,
      targetX,
      targetZ,
      x: unit.x,
      z: unit.z,
      maxSteer: chassis.maxSteer,
      steerRate: chassis.steerRate,
      dt,
    });

    const holdRange = ctx.driving ? 6 : CAR_HOLD_RANGE;
    let desired = pursuitSpeed(PURSUIT_SPEED, distance, unit.steer, holdRange);
    let steer = unit.steer;

    // A car that has driven itself into a corner cannot steer out of it: the
    // model only goes forward, so pointing at the target harder just presses
    // it into the same wall. Backing up with opposite lock is what a driver
    // would do, and it is the only way out that does not teleport the car.
    if (unit.reversing > 0) {
      unit.reversing -= dt;
      desired = -REVERSE_SPEED;
      steer = -unit.steer;
    } else if (unit.wedged > WEDGE_PATIENCE) {
      unit.reversing = REVERSE_SECONDS;
      unit.wedged = 0;
      desired = -REVERSE_SPEED;
      steer = -unit.steer;
    }

    const gap = desired - unit.speed;
    const rate = gap > 0 ? chassis.accelMax : chassis.brakeMax;
    unit.speed += clamp(gap, -rate * dt, rate * dt);
    if (unit.reversing <= 0) unit.speed = Math.max(0, unit.speed);
    this.integrate(unit, dt, steer);

    // Wedged is "asked to move and did not", which a car waiting at its post
    // is not. Progress is "got closer than it has ever been"; a unit that has
    // not managed that in a while is lost and is replaced by a fresh dispatch.
    const wants = Math.abs(desired) > 1;
    unit.wedged = wants && unit.progress < 0.25 ? unit.wedged + dt : 0;
    if (distance < unit.bestDistance - 1) {
      unit.bestDistance = distance;
      unit.sinceProgress = 0;
    } else if (distance > CAR_HOLD_RANGE + 4) {
      unit.sinceProgress += dt;
    }

    // -- get out and chase on foot -------------------------------------------
    // A car that has been wedged against a bollard for a few seconds is not
    // going to reach its post. Its crew gets out and finishes the job on
    // foot, which is both what a driver would do and what stops a blocked
    // unit sitting in the street for the rest of the chase.
    const nearby = !ctx.driving && distance < STALL_RANGE;
    unit.stalled = nearby && unit.speed < 0.6 ? unit.stalled + dt : 0;

    if (!ctx.driving && distance < DISMOUNT_RANGE) unit.closeFor += dt;
    else unit.closeFor = 0;
    if ((unit.closeFor > 0.6 && unit.speed < 3.5) || unit.stalled > STALL_PATIENCE) {
      for (const officer of unit.officers) {
        if (officer.state !== 'riding') continue;
        this.deploy(officer, unit);
      }
      unit.state = 'holding';
    }
    if (ctx.driving && unit.state === 'holding') unit.state = 'driving';
    if (stars <= 0) unit.state = 'standdown';
  }

  /** One bicycle-model step, resolved against the world like `Driving` does. */
  private integrate(unit: Unit, dt: number, steer: number): void {
    const chassis = unit.handle.chassis;
    const yawRate = (unit.speed / chassis.wheelbase) * Math.tan(steer);
    unit.yaw += yawRate * dt;
    const fx = -Math.sin(unit.yaw);
    const fz = -Math.cos(unit.yaw);
    let dx = fx * unit.speed * dt;
    let dz = fz * unit.speed * dt;

    const view = unit.handle.view;
    const reach = Math.max(0, view.halfLength - view.halfWidth);
    const noseX = unit.x + fx * reach;
    const noseZ = unit.z + fz * reach;
    const groundY = this.options.heightAt(unit.x, unit.z);
    const moved = this.options.collision.move(
      noseX,
      noseZ,
      dx,
      dz,
      groundY,
      CAR_BODY_HEIGHT,
      view.halfWidth,
    );
    const gotX = moved.x - noseX;
    const gotZ = moved.z - noseZ;
    const wanted = Math.hypot(dx, dz);
    const achieved = Math.hypot(gotX, gotZ);
    unit.progress = wanted > 1e-5 ? achieved / wanted : 1;
    if (wanted > 1e-5 && achieved < wanted - 1e-4) {
      unit.speed *= Math.max(0, 1 - (1 - achieved / wanted) * 1.4);
      dx = gotX;
      dz = gotZ;
    }
    unit.x += dx;
    unit.z += dz;

    unit.handle.setPose({
      x: unit.x,
      z: unit.z,
      yaw: unit.yaw,
      speed: unit.speed,
      steer,
      braking: unit.speed < 1 && unit.state !== 'driving',
    });
  }

  /** Puts one officer on the pavement beside their car. */
  private deploy(officer: Officer, unit: Unit): void {
    const view = unit.handle.view;
    const fx = -Math.sin(unit.yaw);
    const fz = -Math.cos(unit.yaw);
    const rx = -fz;
    const rz = fx;
    const side = officer.id % 2 === 0 ? 1 : -1;
    const offset = view.halfWidth + 0.75;
    officer.x = unit.x + rx * offset * side;
    officer.z = unit.z + rz * offset * side;
    officer.y = this.options.heightAt(officer.x, officer.z);
    officer.heading = unit.yaw;
    officer.speed = 0;
    officer.state = 'chasing';
  }

  // -- officers -------------------------------------------------------------

  private updateOfficers(dt: number, stars: number, ctx: PoliceContext): void {
    const player = this.options.player;
    const hostile = this.hostileUntil > ctx.time || shootsOnSight(stars);

    for (let i = this.officers.length - 1; i >= 0; i -= 1) {
      const officer = this.officers[i];
      if (!officer) continue;

      if (officer.state === 'down') {
        officer.seesPlayer = false;
        this.officers.splice(i, 1);
        const crew = officer.unit.officers;
        const at = crew.indexOf(officer);
        if (at >= 0) crew.splice(at, 1);
        continue;
      }

      if (officer.state === 'riding') {
        // Riding officers travel with the car and are not shootable; the car is.
        const unit = officer.unit;
        officer.x = unit.x;
        officer.z = unit.z;
        officer.y = this.options.heightAt(unit.x, unit.z);
        officer.heading = unit.yaw;
        officer.speed = 0;
        officer.seesPlayer = false;
        continue;
      }

      const dx = ctx.playerX - officer.x;
      const dz = ctx.playerZ - officer.z;
      const distance = Math.hypot(dx, dz);
      officer.sightTimer -= dt;
      if (officer.sightTimer <= 0) {
        officer.sightTimer = SIGHT_INTERVAL;
        officer.seesPlayer =
          distance < SIGHT_RANGE_FOOT &&
          this.canSee(officer.x, officer.y + OFFICER_EYE, officer.z, ctx);
      }

      // An officer either closes in to make an arrest or holds at shooting
      // range. A hurt suspect is always worth cuffing rather than shooting,
      // which is what makes the last few points of health a real decision.
      const wantsArrest =
        !ctx.driving && (!hostile || player.health <= ARREST_HEALTH);
      const standoff = wantsArrest ? ARREST_STANDOFF : FIRING_STANDOFF;
      const wantsToMove = distance > standoff;
      const speed = wantsToMove ? OFFICER_RUN_SPEED : 0;

      if (wantsToMove && distance > 0.01) {
        const step = speed * dt;
        // Officers steer straight at the player and slide along whatever they
        // touch. Sliding alone cannot get round a building, so an officer who
        // has been pressing into something for a second peels off at an angle
        // for a few seconds and tries again from there. It is not a path
        // planner; it is enough to get round a corner, and the alternative -
        // a second navigation graph for four people - is not worth the code.
        let ux = dx / distance;
        let uz = dz / distance;
        if (officer.detour > 0) {
          officer.detour -= dt;
          const angle = DETOUR_ANGLE * officer.detourSide;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const rx = ux * cos - uz * sin;
          const rz = ux * sin + uz * cos;
          ux = rx;
          uz = rz;
        }
        const moved = this.options.collision.move(
          officer.x,
          officer.z,
          ux * step,
          uz * step,
          officer.y,
          OFFICER_HEIGHT,
          OFFICER_RADIUS,
        );
        const travelled = Math.hypot(moved.x - officer.x, moved.z - officer.z);
        officer.x = moved.x;
        officer.z = moved.z;
        officer.y = this.options.heightAt(officer.x, officer.z);
        officer.speed = dt > 0 ? travelled / dt : 0;
        officer.heading = Math.atan2(-dx, -dz);

        if (travelled < step * 0.45) {
          officer.blocked += dt;
          if (officer.blocked > BLOCKED_PATIENCE && officer.detour <= 0) {
            officer.detour = DETOUR_SECONDS;
            officer.detourSide = officer.detourSide === 1 ? -1 : 1;
            officer.blocked = 0;
          }
        } else if (officer.detour <= 0) {
          officer.blocked = 0;
        }
      } else {
        officer.speed = damp(officer.speed, 0, 10, dt);
        officer.heading = Math.atan2(-dx, -dz);
      }
      OfficerRig.advance(officer, dt);

      // -- arrest ------------------------------------------------------------
      const eligible =
        distance <= ARREST_RANGE && ctx.playerSpeed <= 1.7 && !ctx.driving && officer.seesPlayer;
      officer.held = eligible ? officer.held + dt : 0;
      if (
        canArrest({
          distance,
          playerSpeed: ctx.playerSpeed,
          playerHealth: player.health,
          stars,
          driving: ctx.driving,
          held: officer.held,
        }) &&
        officer.seesPlayer
      ) {
        this.counters.arrests += 1;
        this.options.onArrest?.();
        return;
      }

      // -- open fire ---------------------------------------------------------
      officer.shotTimer -= dt;
      const canShoot =
        hostile &&
        officer.seesPlayer &&
        distance < OFFICER_FIRE_RANGE &&
        player.alive &&
        // Hands are for cuffs at arm's length, not for a sidearm.
        !(wantsArrest && distance <= ARREST_RANGE * 1.7);
      if (!canShoot) {
        officer.aim = 0;
        continue;
      }
      officer.aim += dt;
      if (officer.aim < OFFICER_AIM_TIME || officer.shotTimer > 0) continue;
      officer.shotTimer = OFFICER_SHOT_INTERVAL * (0.85 + this.rng.next() * 0.35);
      this.fireAtPlayer(officer, stars, ctx);
    }
  }

  private fireAtPlayer(officer: Officer, stars: number, ctx: PoliceContext): void {
    const muzzleY = officer.y + OFFICER_EYE * 0.86;
    const targetY = ctx.playerY + 1.1;
    const hits = this.rng.next() < officerAccuracy(stars);
    const effects = this.effects;
    if (effects) {
      effects.muzzle(officer.x, muzzleY, officer.z, 0.8);
      // A miss is drawn passing the player rather than stopping at them, which
      // is the only way a near miss reads as a near miss.
      const spreadX = hits ? 0 : (this.rng.next() - 0.5) * 2.4;
      const spreadY = hits ? 0 : (this.rng.next() - 0.5) * 1.2;
      effects.tracer(
        officer.x,
        muzzleY,
        officer.z,
        ctx.playerX + spreadX,
        targetY + spreadY,
        ctx.playerZ + spreadX * 0.4,
      );
    }
    this.options.onOfficerShot?.();
    if (hits) this.options.player.hurt(OFFICER_SHOT_DAMAGE);
  }

  // -- housekeeping ---------------------------------------------------------

  private retire(dt: number, stars: number, ctx: PoliceContext): void {
    for (let i = this.units.length - 1; i >= 0; i -= 1) {
      const unit = this.units[i];
      if (!unit) continue;
      const distance = Math.hypot(unit.x - ctx.playerX, unit.z - ctx.playerZ);

      if (stars <= 0 && unit.state !== 'wrecked') unit.state = 'standdown';
      if (unit.state === 'wrecked' || unit.state === 'standdown') {
        unit.linger += dt;
      }
      const lost = unit.sinceProgress > LOST_PATIENCE && unit.officers.every((o) => o.state === 'riding');
      const gone =
        lost ||
        distance > ABANDON_DISTANCE ||
        (unit.state === 'standdown' && unit.linger > LINGER_SECONDS) ||
        (unit.state === 'wrecked' && unit.linger > LINGER_SECONDS * 6);
      if (!gone) continue;

      // Officers whose car is retired leave with it; their agent is ours, so
      // unlike a civilian they really do disappear.
      for (const officer of unit.officers) {
        const at = this.officers.indexOf(officer);
        if (at >= 0) this.officers.splice(at, 1);
      }
      unit.officers.length = 0;
      this.release(unit);
      this.units.splice(i, 1);
    }
  }

  private wreck(unit: Unit): void {
    if (unit.state === 'wrecked') return;
    unit.state = 'wrecked';
    unit.linger = 0;
    this.counters.vehiclesWrecked += 1;
    // The crew bails out and keeps coming; a wrecked car is a setback, not the
    // end of a chase.
    for (const officer of unit.officers) {
      if (officer.state === 'riding') this.deploy(officer, unit);
    }
  }

  private release(unit: Unit): void {
    try {
      unit.handle.release();
    } catch {
      // The traffic system may already have recycled the vehicle; a pursuit
      // ending must never be able to throw into the frame loop.
    }
  }

  private makeHostile(): void {
    this.hostileUntil = this.now + HOSTILE_SECONDS;
  }

  /**
   * Whether a watcher at `(x, y, z)` can see the player.
   *
   * THREE rays, not one. A single ray to the chest is blocked by a lamp post,
   * a bin or a bollard, and Meridian Bay's pavements are full of them: a
   * patrol car eleven metres away was reporting no sight of a player standing
   * in the open because one street lamp happened to be on the line. The two
   * extra rays are offset sideways by most of a body width, which thin street
   * furniture cannot cover but a wall still does.
   */
  private canSee(x: number, y: number, z: number, ctx: PoliceContext): boolean {
    const world = this.options.world;
    const eyeY = ctx.playerY + 1.2;
    if (hasLineOfSight(world, x, y, z, ctx.playerX, eyeY, ctx.playerZ)) return true;
    const dx = ctx.playerX - x;
    const dz = ctx.playerZ - z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-3) return true;
    const px = (-dz / length) * SIGHT_SPREAD;
    const pz = (dx / length) * SIGHT_SPREAD;
    if (hasLineOfSight(world, x, y, z, ctx.playerX + px, eyeY, ctx.playerZ + pz)) return true;
    return hasLineOfSight(world, x, y, z, ctx.playerX - px, eyeY, ctx.playerZ - pz);
  }

  private writeVisuals(time: number): void {
    this.beaconPoses.length = 0;
    for (const unit of this.units) {
      const view = unit.handle.view;
      this.beaconPoses.push({
        x: unit.x,
        y: view.y,
        z: unit.z,
        yaw: unit.yaw,
        halfHeight: view.halfHeight,
        halfWidth: view.halfWidth,
        lit: unit.state === 'driving' || unit.state === 'holding',
      });
    }
    this.beacons.write(this.beaconPoses, time);
    this.onFoot.length = 0;
    for (const officer of this.officers) {
      if (officer.state === 'chasing') this.onFoot.push(officer);
    }
    this.rig.write(this.onFoot);
  }

  /** Where an officer thinks the lane runs, used by the pursuit driver. */
  private alongLane(lane: LaneSegment, x: number, z: number): number {
    const at = lane.axis === 'x' ? z : x;
    return clamp((at - lane.start) * lane.travel, 0, lane.length);
  }
}
