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
 * THE RESPONSE BUILDS. Nothing is sent for `dispatchDelay(stars)` seconds
 * after the alarm is raised, the unit that answers starts `dispatchDistance`
 * metres away, and the next one follows `dispatchInterval` later - all three
 * functions of the wanted level, all three in `policy.ts`. A first star is a
 * distant single car that takes half a minute to find you; a fifth is five
 * cars from just beyond the fog. See the escalation note in `policy.ts` for
 * the measured before and after.
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
import type { ActorTarget, Blow, DamageResult, LawTargets } from '../combat/targets';
import type { PlayerState } from '../player/PlayerState';
import type { CollisionWorld } from '../player/Collision';
import type { VehicleHandle, VehicleKind, VehicleView } from '../traffic/types';
import { Beacons, type BeaconPose } from './Beacons';

/**
 * One pursuit car, as the audio layer wants to hear it.
 *
 * Declared here and structurally compatible with `PursuitUnit` in
 * `src/audio/PoliceAudio.ts` rather than imported from it: the police
 * simulation must not depend on the audio layer, and this way either can be
 * tested without the other.
 */
export interface PursuitAudioUnit {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly siren: boolean;
  readonly speed: number;
  readonly vx: number;
  readonly vz: number;
}
import { makeOfficer, OfficerRig, type OfficerPose } from './OfficerRig';
import {
  ABANDON_DISTANCE,
  ARREST_HEALTH,
  ARREST_RANGE,
  CAR_HOLD_RANGE,
  COMMANDEER_DISTANCE,
  DISMOUNT_RANGE,
  MAX_OFFICERS,
  MAX_UNITS,
  OFFICER_FIRE_RANGE,
  OFFICER_VOICE_COOLDOWN,
  OFFICER_VOICE_RANGE,
  RADIO_COOLDOWN,
  UNIT_VOICE_RANGE,
  OFFICER_RUN_SPEED,
  OFFICER_SHOT_DAMAGE,
  OFFICER_SHOT_INTERVAL,
  PURSUIT_SPEED,
  SIGHT_RANGE_CAR,
  SIGHT_RANGE_FOOT,
  canArrest,
  carsForStars,
  dispatchDelay,
  dispatchDistance,
  dispatchInterval,
  officerAccuracy,
  officerAimTime,
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

// -- bodies -----------------------------------------------------------------
//
// A SHOT OFFICER IS A BODY, NOT A DELETION. `damage` used to set the state to
// 'down' and `updateOfficers` spliced them out of the array in the same call -
// and `update` runs `updateOfficers` BEFORE `writeVisuals`, so a killed officer
// was never once drawn on the ground. They vanished on the frame they died.
//
// The numbers below are the crowd's, for the civilians it already lays in the
// road: see `THROW_SHARE`, `THROW_MAX`, `THROW_DRAG`, `CASUALTY_TIME` and
// `LOD_NEAR` in `src/agents/crowd.ts`. They are duplicated rather than imported
// because `src/agents` is another workstream's, and a body in the street has to
// read as one game whoever it was.

/** Fraction of the striking speed a body is thrown at. */
const THROW_SHARE = 0.55;
/** Fastest a body is thrown, m/s. Above this it looks like a rag doll. */
const THROW_MAX = 6;
/** How quickly a thrown body scrubs off speed on the ground, per second. */
const THROW_DRAG = 4.5;
/** Seconds a body lies in the street before its slot may be reused. */
const CASUALTY_TIME = 60;
/**
 * How far the player has to be before a body is allowed to disappear.
 *
 * The crowd's `LOD_NEAR`. A casualty is scenery until the player has walked
 * away from them; nobody may watch a body blink out.
 */
const BODY_KEEP_RANGE = 42;
/**
 * Bodies kept at once, across the whole response.
 *
 * The officer mesh has room for `MAX_OFFICERS` live officers plus this, so a
 * body never costs a living officer their instance slot. Beyond it the oldest
 * body is dropped, which by then is the one furthest from the fight.
 */
const MAX_BODIES = 6;
/** Below this a sliding body has stopped. */
const SLIDE_STOP = 0.05;
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
  /** Seconds until this officer may shout at the player again. */
  voiceTimer: number;
  seesPlayer: boolean;
  /** Where a thrown body is still sliding to. Zero for anybody on their feet. */
  vx: number;
  vz: number;
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
  /** Seconds until this unit may hail the player again over its PA. */
  voiceTimer: number;
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
  /** An officer fired, and where their muzzle was. For audio. */
  readonly onOfficerShot?: ((x: number, y: number, z: number) => void) | undefined;
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
  /** Bodies still lying in the street. Diagnostics and automated QA. */
  readonly bodies: number;
  readonly vehiclesWrecked: number;
  readonly unmarked: number;
  /** Which officer mesh is live. `procedural` means the bake failed to load. */
  readonly officerModel: 'baked' | 'procedural';
  /** Seconds still to wait before the first unit is sent, 0 once it has been. */
  readonly dispatchIn: number;
}

/**
 * Something an officer says out loud, at a place in the world.
 *
 * WHY THE POLICE EMIT THIS AND THE AUDIO LAYER DOES NOT DERIVE IT. Whether a
 * line should be said is a question about pursuit state - has this officer just
 * closed on the player, has the pursuit only now started, has it just been
 * lost - and all of that lives here. The audio layer's business is which
 * recording, at what level, through which panner. Publishing EVENTS rather than
 * state also means the "did the police shout at me" question has one answer per
 * frame instead of a level the mixer has to edge-detect for itself.
 *
 * The list is rebuilt and drained every frame; nothing retains it.
 */
export interface PoliceVoiceCue {
  /**
   * `challenge` an officer on foot ordering the player to stop; `pullover` the
   * same order to somebody in a car; `radio` unit-to-unit traffic as a pursuit
   * opens; `lost` an officer who can no longer see the player.
   */
  readonly kind: 'challenge' | 'pullover' | 'radio' | 'lost';
  readonly x: number;
  readonly y: number;
  readonly z: number;
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
  /** Reused by `pursuitAudio`. Never retained by the caller. */
  private readonly audioUnits: PursuitAudioUnit[] = [];
  /** Reused so writing the rig allocates nothing per frame. */
  private readonly onFoot: Officer[] = [];
  private dispatchTimer = 0;
  /**
   * World time the current alarm was raised, or -1 while the player is clean.
   *
   * The whole of `dispatchDelay` is measured from here, so the wait belongs to
   * the OFFENCE and not to each dispatch: a player who goes from one star to
   * four during the delay gets the four-star wait counted from the original
   * shot, which is a shorter remaining wait rather than a fresh one. Cleared
   * the moment the stars reach zero, so the next offence is a new alarm.
   */
  private alarmAt = -1;
  /** Rebuilt every frame; see `PoliceVoiceCue`. Never retained by a caller. */
  private readonly cues: PoliceVoiceCue[] = [];
  /** Edge detector for the pursuit itself, so `radio` and `lost` fire once. */
  private wasPursued = false;
  /** Seconds until any unit may key the radio again. */
  private radioTimer = 0;
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
    // Room for every live officer AND every body, so a casualty on the
    // pavement can never push a living officer out of the instance buffer.
    this.rig = new OfficerRig(MAX_OFFICERS + MAX_BODIES, options.quality !== 'low');
    this.beacons = new Beacons(MAX_UNITS);

    const group = new Group();
    group.name = 'police';
    group.add(...this.rig.meshes, this.beacons.object);
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

  damage(id: number, amount: number, blow?: Blow): DamageResult {
    const officer = this.officers.find((o) => o.id === id);
    if (!officer || officer.state === 'down' || amount <= 0) return 'none';
    officer.health -= amount;
    this.makeHostile();
    if (officer.health > 0) return 'hurt';
    officer.health = 0;
    this.knockDown(officer, blow);
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
      bodies: this.bodyCount,
      pursued: this.pursuedNow,
      officerModel: this.rig.ready ? 'baked' : 'procedural',
      dispatchIn: this.remainingDelay(),
      ...this.counters,
    };
  }

  /**
   * Where the officers on foot are, and how far into the firing stance.
   *
   * Diagnostics only: it exists so a change to the officer rig can be LOOKED
   * at - put the camera three metres from a man who is shooting at you - and
   * so automated QA can assert that somebody really did raise their weapon
   * rather than that a counter went up.
   */
  get officerPoses(): readonly {
    x: number;
    y: number;
    z: number;
    heading: number;
    aiming: number;
  }[] {
    return this.officers
      .filter((officer) => officer.state === 'chasing')
      .map((officer) => ({
        x: officer.x,
        y: officer.y,
        z: officer.z,
        heading: officer.heading,
        aiming: Number(officer.aiming.toFixed(3)),
      }));
  }

  /**
   * Seconds left of the dispatch delay, for the diagnostics overlay and for
   * automated QA that wants to assert the pacing without a stopwatch.
   */
  private remainingDelay(): number {
    const stars = this.options.player.wanted;
    if (stars <= 0 || this.alarmAt < 0) return 0;
    const left = dispatchDelay(stars) - (this.now - this.alarmAt);
    return left > 0 ? Number(left.toFixed(2)) : 0;
  }

  /** Ends the chase and returns every car to traffic. Used on respawn. */
  standDown(): void {
    for (const unit of this.units) this.release(unit);
    this.units.length = 0;
    this.officers.length = 0;
    this.pursuedNow = false;
    this.hostileUntil = -1;
    this.dispatchTimer = 0;
    this.alarmAt = -1;
    this.rig.write(this.officers, 0);
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
    // Drained by whoever read it last frame; see `PoliceVoiceCue`.
    this.cues.length = 0;
    this.radioTimer = Math.max(0, this.radioTimer - dt);

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
    this.updateVoice(dt, ctx);

    this.writeVisuals(ctx.time);
  }

  // -- dispatch -------------------------------------------------------------

  private updateDispatch(dt: number, stars: number, ctx: PoliceContext): void {
    if (stars <= 0) {
      // Clean again: the next offence starts its own alarm from scratch.
      this.alarmAt = -1;
      this.dispatchTimer = 0;
      return;
    }
    // Nobody is dispatched to a player who is already down. Without this the
    // city keeps sending cars through the two and a half seconds the outcome
    // is on screen, and one of them is still in the street on respawn.
    if (!this.options.player.alive) return;
    if (this.alarmAt < 0) {
      this.alarmAt = ctx.time;
      this.dispatchTimer = 0;
    }

    const wanted = carsForStars(stars);
    const live = this.units.filter((u) => u.state === 'driving' || u.state === 'holding').length;
    // CLAMPED AT ZERO, not allowed to run negative. It used to keep counting
    // down while the quota was already met, so a player who sat at two stars
    // for a minute had banked a minute of credit: the instant a third star
    // landed, or a unit was wrecked, two replacements went out on consecutive
    // frames. That is most of what "three units arrived within four seconds"
    // was. The interval now means the same thing whenever it is reached.
    this.dispatchTimer = Math.max(0, this.dispatchTimer - dt);
    if (live >= wanted || this.units.length >= MAX_UNITS) return;
    // Nothing at all goes out until the call has had time to. This is the
    // difference between a response and an ambush.
    if (ctx.time - this.alarmAt < dispatchDelay(stars)) return;
    if (this.dispatchTimer > 0) return;
    this.dispatchTimer = dispatchInterval(stars);
    this.dispatch(stars, ctx);
  }

  private dispatch(stars: number, ctx: PoliceContext): void {
    const source = this.pickVehicle(ctx.playerX, ctx.playerZ);
    if (!source) return;
    // Spread consecutive dispatches over a band of distances rather than
    // stacking them on one street. This is what makes a four-car response
    // arrive as four separate cars from four directions instead of a convoy,
    // and it is drawn from the seeded RNG so a replay is still identical.
    const spread = 0.85 + this.rng.next() * 0.3;
    const spot = dispatchLane(
      this.options.network,
      ctx.playerX,
      ctx.playerZ,
      ctx.forwardX,
      ctx.forwardZ,
      dispatchDistance(stars) * spread,
      (laneId) => Number.isFinite(this.field.cost(laneId)),
    );
    if (!spot) return;
    const handle = this.options.traffic.takeControl(source.id);
    if (!handle) return;

    const point = lanePoint(spot.lane, spot.along);
    const unit: Unit = {
      id: this.nextUnitId,
      handle,
      state: 'driving',
      voiceTimer: 0,
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
    // LIVE officers, not entries in the array: bodies stay in it for a minute
    // and must not count against the city's ability to send anybody else.
    let live = this.officers.length - this.bodyCount;
    for (let i = 0; i < crew; i += 1) {
      if (live >= MAX_OFFICERS) break;
      live += 1;
      const look = makeOfficer(this.nextOfficerId * 37 + unit.id);
      const officer: Officer = {
        id: this.nextOfficerId,
        unit,
        health: ACTOR_HEALTH,
        state: 'riding',
        aim: 0,
        aiming: 0,
        shotTimer: 0,
        sightTimer: 0,
        blocked: 0,
        detour: 0,
        detourSide: i % 2 === 0 ? 1 : -1,
        held: 0,
        voiceTimer: 0,
        seesPlayer: false,
        vx: 0,
        vz: 0,
        down: false,
        downFor: 0,
        fallSign: 1,
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
        walked: this.rng.next() * 4,
        lastX: unit.x,
        lastZ: unit.z,
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
    // Getting out of a car is a teleport, not a stride: reseed the walk
    // accumulator's reference point so the first frame on foot does not
    // advance the clip by the width of the car.
    officer.lastX = officer.x;
    officer.lastZ = officer.z;
  }

  // -- officers -------------------------------------------------------------

  private updateOfficers(dt: number, stars: number, ctx: PoliceContext): void {
    const player = this.options.player;
    const hostile = this.hostileUntil > ctx.time || shootsOnSight(stars);

    // BODIES FIRST, AND IN THEIR OWN PASS. The live-officer loop below returns
    // outright when somebody makes an arrest, and a corpse must not stop
    // falling because the player got cuffed on the other side of the street.
    for (let i = this.officers.length - 1; i >= 0; i -= 1) {
      const officer = this.officers[i];
      if (!officer || officer.state !== 'down') continue;
      if (this.stepDown(officer, dt, ctx)) this.officers.splice(i, 1);
    }

    for (let i = this.officers.length - 1; i >= 0; i -= 1) {
      const officer = this.officers[i];
      if (!officer || officer.state === 'down') continue;

      if (officer.state === 'riding') {
        // Riding officers travel with the car and are not shootable; the car is.
        const unit = officer.unit;
        officer.x = unit.x;
        officer.z = unit.z;
        officer.y = this.options.heightAt(unit.x, unit.z);
        officer.heading = unit.yaw;
        officer.speed = 0;
        officer.seesPlayer = false;
        // Nobody aims from inside a moving car; the weapon comes up after they
        // get out. Snapped rather than damped because a riding officer is not
        // drawn as a person at all.
        officer.aiming = 0;
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
        // The stance comes down over about a third of a second, so an officer
        // who loses sight of the player lowers their weapon rather than
        // snapping upright.
        officer.aiming = damp(officer.aiming, 0, 9, dt);
        continue;
      }
      officer.aim += dt;
      // ...and goes up over the same time it takes them to line the shot up,
      // so the pose is fully raised exactly when the first round leaves.
      officer.aiming = damp(officer.aiming, 1, 7, dt);
      if (officer.aim < officerAimTime(stars) || officer.shotTimer > 0) continue;
      officer.shotTimer = OFFICER_SHOT_INTERVAL * (0.85 + this.rng.next() * 0.35);
      this.fireAtPlayer(officer, stars, ctx);
    }
  }

  // -- bodies ---------------------------------------------------------------

  /** Bodies currently lying in the street. */
  private get bodyCount(): number {
    let n = 0;
    for (const officer of this.officers) if (officer.state === 'down') n += 1;
    return n;
  }

  /**
   * Lays an officer down, thrown the way the blow was travelling.
   *
   * The crowd's `knockDown`, for the people who wear uniforms: topple away from
   * wherever the blow came from - shoved the way they were already facing goes
   * onto the face, shoved against it goes over backwards - and slide.
   *
   * They come OFF THE CREW here and stay in `this.officers`. That is the whole
   * of how a body outlives the car it arrived in: `retire` walks the crew, and
   * a body is no longer on it.
   */
  private knockDown(officer: Officer, blow?: Blow): void {
    officer.state = 'down';
    officer.down = true;
    officer.downFor = 0;
    officer.aim = 0;
    officer.aiming = 0;
    officer.gait = 0;
    officer.held = 0;
    officer.blocked = 0;
    officer.detour = 0;
    officer.seesPlayer = false;
    officer.speed = 0;

    const dirX = blow?.dirX ?? 0;
    const dirZ = blow?.dirZ ?? 0;
    // `heading` is the direction the model FACES, which is -(sin, cos).
    const facingX = -Math.sin(officer.heading);
    const facingZ = -Math.cos(officer.heading);
    officer.fallSign = dirX * facingX + dirZ * facingZ > 0 ? -1 : 1;
    const thrown = Math.min(THROW_MAX, Math.max(0, blow?.speed ?? 0) * THROW_SHARE);
    officer.vx = dirX * thrown;
    officer.vz = dirZ * thrown;

    const crew = officer.unit.officers;
    const at = crew.indexOf(officer);
    if (at >= 0) crew.splice(at, 1);

    this.trimBodies();
  }

  /**
   * One frame of being dead. Returns true when the body may be taken away.
   *
   * Deliberately not routed through the walking update: a body has no target,
   * no arrest to make and no opinion about cover, and putting it through that
   * code would have it crawl toward the player on its back.
   */
  private stepDown(officer: Officer, dt: number, ctx: PoliceContext): boolean {
    officer.downFor += dt;

    const speed = Math.hypot(officer.vx, officer.vz);
    if (speed > SLIDE_STOP) {
      const drag = Math.max(0, 1 - THROW_DRAG * dt);
      officer.vx *= drag;
      officer.vz *= drag;
      // Resolved against the world like a walking officer is: being shot is
      // not a licence to slide through a wall.
      const moved = this.options.collision.move(
        officer.x,
        officer.z,
        officer.vx * dt,
        officer.vz * dt,
        officer.y,
        OFFICER_HEIGHT,
        OFFICER_RADIUS,
      );
      officer.x = moved.x;
      officer.z = moved.z;
      officer.y = this.options.heightAt(officer.x, officer.z);
    } else if (officer.vx !== 0 || officer.vz !== 0) {
      officer.vx = 0;
      officer.vz = 0;
      // One last sample, so a body that came to rest on a kerb is on the kerb.
      officer.y = this.options.heightAt(officer.x, officer.z);
    }

    if (officer.downFor <= CASUALTY_TIME) return false;
    // A minute is up, but a body still does not disappear while it is being
    // looked at. It goes when the player has walked away from it.
    const distance = Math.hypot(officer.x - ctx.playerX, officer.z - ctx.playerZ);
    return distance > BODY_KEEP_RANGE;
  }

  /**
   * Keeps the number of bodies bounded.
   *
   * The oldest goes first, which in a running firefight is the one furthest
   * from where the fight now is. Without a cap a long chase would fill the
   * officer mesh with corpses.
   */
  private trimBodies(): void {
    let bodies = this.bodyCount;
    while (bodies > MAX_BODIES) {
      let oldest = -1;
      let age = -1;
      for (let i = 0; i < this.officers.length; i += 1) {
        const officer = this.officers[i];
        if (!officer || officer.state !== 'down') continue;
        if (officer.downFor > age) {
          age = officer.downFor;
          oldest = i;
        }
      }
      if (oldest < 0) return;
      this.officers.splice(oldest, 1);
      bodies -= 1;
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
    this.options.onOfficerShot?.(officer.x, muzzleY, officer.z);
    // The officer's own position is passed with the damage so the HUD can
    // point the player at whoever is shooting at them.
    if (hits) this.options.player.hurt(OFFICER_SHOT_DAMAGE, officer.x, officer.z);
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
      // unlike a civilian they really do disappear. A BODY DOES NOT: it was
      // taken off the crew the moment it went down, so retiring the car it
      // arrived in cannot make it vanish out from under the player. Bodies
      // leave on their own terms, in `stepDown`.
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

  /**
   * Live pursuit units, for the audio layer.
   *
   * The same loop `writeVisuals` runs for the beacons, and for the same
   * reason: `unitReport` allocates and rounds and says so in its own comment,
   * so it cannot be called at 120 Hz. This reuses one scratch array and is
   * safe to read every frame - but the array is REUSED, so a caller must
   * consume it during the frame and never retain it.
   *
   * `siren` follows the light bar. A unit that is driving or holding station
   * on a live pursuit has both on; one that has been stood down or wrecked has
   * neither, and is voiced as an ordinary engine.
   */
  /**
   * What the police are saying this frame. See `PoliceVoiceCue`.
   *
   * Read once per frame by the audio layer and never retained: the array is
   * the same one every time and is cleared at the top of `update`.
   */
  get voiceCues(): readonly PoliceVoiceCue[] {
    return this.cues;
  }

  /**
   * Turns pursuit state into things somebody says.
   *
   * Three rules, and the timers are what keep a chase from turning into a
   * chant. An officer challenges the player when they get close enough to be
   * heard and can actually see them, then holds their tongue for
   * `OFFICER_VOICE_COOLDOWN`; the radio opens once when a pursuit starts and
   * once more if the player breaks line of sight; and everything stops the
   * moment the stars do.
   */
  private updateVoice(dt: number, ctx: PoliceContext): void {
    const stars = this.options.player.wanted;
    if (stars <= 0) {
      this.wasPursued = false;
      return;
    }

    /*
     * THE EDGE IS ONLY CONSUMED ONCE IT HAS BEEN SPOKEN.
     *
     * `wasPursued` used to be assigned unconditionally, which meant an edge
     * that arrived inside the radio cooldown was thrown away rather than
     * deferred: break line of sight within twelve seconds of the opening call
     * and the "we've lost visual" line could never be said, because by the
     * time the cooldown expired there was no edge left to detect.
     */
    if (this.pursuedNow !== this.wasPursued && this.radioTimer <= 0) {
      const unit = this.nearestUnit(ctx);
      if (unit) {
        this.radioTimer = RADIO_COOLDOWN;
        this.cues.push({
          kind: this.pursuedNow ? 'radio' : 'lost',
          x: unit.x,
          y: unit.handle.view.y + 1,
          z: unit.z,
        });
        this.wasPursued = this.pursuedNow;
      }
    }

    /*
     * A CAR TELLS YOU TO PULL OVER; A MAN ON FOOT TELLS YOU TO GET DOWN.
     *
     * The two orders come from different places for a structural reason, not
     * for flavour: a unit only ever sets `holding` and lets its crew out when
     * the player is NOT driving (see `updateUnit`), so while there is a chase
     * on there is nobody on foot to shout anything. The order has to come off
     * the car's own PA, from further out - a loudhailer carries, and a driver
     * is inside a car with the windows up.
     */
    /*
     * ONE ORDER PER FRAME, AND ONLY THAT SPEAKER'S TIMER IS STARTED.
     *
     * The audio layer plays at most one police line per frame and drops the
     * rest, so emitting a cue for every eligible officer meant four of them
     * arriving together produced one line and then EIGHT SECONDS OF SILENCE,
     * because all four had started their cooldown for a line only one of them
     * got to say. Starting the clock on the officer who actually spoke lets
     * the cordon alternate at the mixer's own two-second cadence, which is
     * what `OFFICER_VOICE_COOLDOWN` was tuned against.
     *
     * The nearest eligible speaker wins, so the order comes from the officer
     * the player can actually see.
     */
    if (ctx.driving) {
      let best: Unit | null = null;
      let bestDistance = UNIT_VOICE_RANGE;
      for (const unit of this.units) {
        unit.voiceTimer = Math.max(0, unit.voiceTimer - dt);
        if (unit.state === 'wrecked' || unit.state === 'standdown') continue;
        if (!unit.seesPlayer || unit.voiceTimer > 0) continue;
        const distance = Math.hypot(ctx.playerX - unit.x, ctx.playerZ - unit.z);
        if (distance > bestDistance) continue;
        bestDistance = distance;
        best = unit;
      }
      if (best) {
        best.voiceTimer = OFFICER_VOICE_COOLDOWN;
        this.cues.push({
          kind: 'pullover',
          x: best.x,
          y: best.handle.view.y + 1.2,
          z: best.z,
        });
      }
      return;
    }

    let speaker: Officer | null = null;
    let speakerDistance = OFFICER_VOICE_RANGE;
    for (const officer of this.officers) {
      officer.voiceTimer = Math.max(0, officer.voiceTimer - dt);
      if (officer.state !== 'chasing' || officer.down || !officer.seesPlayer) continue;
      if (officer.voiceTimer > 0) continue;
      const distance = Math.hypot(ctx.playerX - officer.x, ctx.playerZ - officer.z);
      if (distance > speakerDistance) continue;
      speakerDistance = distance;
      speaker = officer;
    }
    if (speaker) {
      speaker.voiceTimer = OFFICER_VOICE_COOLDOWN;
      this.cues.push({
        kind: 'challenge',
        x: speaker.x,
        // Mouth height, not foot height: the line is spatialised on the person.
        y: speaker.y + 1.6,
        z: speaker.z,
      });
    }
  }

  /** The closest unit still in the pursuit, for a line that belongs to a car. */
  private nearestUnit(ctx: PoliceContext): Unit | null {
    let best: Unit | null = null;
    let bestSq = Infinity;
    for (const unit of this.units) {
      if (unit.state === 'wrecked' || unit.state === 'standdown') continue;
      const dx = unit.x - ctx.playerX;
      const dz = unit.z - ctx.playerZ;
      const d = dx * dx + dz * dz;
      if (d < bestSq) {
        bestSq = d;
        best = unit;
      }
    }
    return best;
  }

  get pursuitAudio(): readonly PursuitAudioUnit[] {
    this.audioUnits.length = 0;
    for (const unit of this.units) {
      const view = unit.handle.view;
      const lit = unit.state === 'driving' || unit.state === 'holding';
      this.audioUnits.push({
        id: unit.id,
        x: unit.x,
        y: view.y,
        z: unit.z,
        siren: lit,
        speed: Math.abs(unit.speed),
        // Forward is the game's own convention, so the Doppler shift agrees
        // with which way the car is actually pointing.
        vx: -Math.sin(unit.yaw) * unit.speed,
        vz: -Math.cos(unit.yaw) * unit.speed,
      });
    }
    return this.audioUnits;
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
    // Living officers first, so if the buffer ever did run short it is a body
    // that is dropped and not somebody still shooting.
    for (const officer of this.officers) {
      if (officer.state === 'chasing') this.onFoot.push(officer);
    }
    for (const officer of this.officers) {
      if (officer.state === 'down') this.onFoot.push(officer);
    }
    this.rig.write(this.onFoot, time);
  }

  /** Where an officer thinks the lane runs, used by the pursuit driver. */
  private alongLane(lane: LaneSegment, x: number, z: number): number {
    const at = lane.axis === 'x' ? z : x;
    return clamp((at - lane.start) * lane.travel, 0, lane.length);
  }
}
