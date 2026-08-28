/**
 * Firing a weapon in Meridian Bay.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   import { CombatSystem } from './combat/CombatSystem';
 *   import { WorldRayIndex } from './combat/rays';
 *   import { CrowdTargets } from './combat/CrowdTargets';
 *
 *   const civilians = new CrowdTargets(pedestrians.group);
 *   const combat = new CombatSystem({
 *     player, camera: engine.camera, domElement: canvas,
 *     world: new WorldRayIndex(sink.colliders),
 *     heightAt: (x, z) => ground.heightAt(x, z),
 *     civilians,
 *     vehicles: traffic,          // anything with forEachNear
 *     law: police,                // PoliceSystem, or null
 *   });
 *   engine.scene.add(combat.group);
 *
 *   // ONCE PER FRAME, AFTER the controller and the driving layer have moved
 *   // the camera - see RECOIL below.
 *   combat.update(dt, { driving, playerX, playerY, playerZ, playerSpeed });
 *
 *   combat.dispose();
 *
 * RECOIL BELONGS TO WHOEVER OWNS THE AIM. Pass `recoil: controller` and the
 * kick goes into `FirstPersonController`'s own look angles, where it is part of
 * where the player is pointing: it climbs through a burst, has to be pulled
 * back down, and is in the pose every shot is cast from because it is in the
 * pose the controller writes. WITHOUT that option this system rotates the
 * camera itself, at the TOP of `update` so the shot still leaves from the pose
 * the player is looking at - but then `update` must run after something that
 * writes the camera pose absolutely each frame, or the rotation accumulates.
 * The controller and the driving layer both do; nothing else in the game poses
 * that camera.
 *
 * ON FOOT ONLY. Firing is refused while the player is driving. The driving
 * camera is a chase boom sitting six metres behind the car, so a shot from the
 * camera would leave through the player's own boot; a drive-by needs an aim
 * source that does not exist yet, and inventing one here would be guessing.
 * `canFire` reports false and the HUD says why.
 *
 * WHAT A SHOT CAN HIT, nearest first: people (civilians from the crowd's own
 * instance buffers, officers from `PoliceSystem`), vehicles (every ambient car
 * as an oriented box), solid world geometry (buildings, walls, kerbs, street
 * furniture) and the terrain. See `rays.ts` for the geometry and `targets.ts`
 * for how the people get here.
 *
 * ============================================================================
 */

import type { Object3D, PerspectiveCamera } from 'three';
import { Vector3 } from 'three';

import { clamp, damp } from '../core/mathx';
import { createRng, type Rng } from '../core/rng';
import type { RecoilSink } from '../player/FirstPersonController';
import {
  ALL_WEAPONS,
  HEAT,
  WEAPONS,
  type PlayerState,
  type WeaponId,
  type WeaponSpec,
} from '../player/PlayerState';
import type { ColliderBox } from '../world/build/types';
import {
  Armoury,
  damageAtRange,
  FALLOFF_END,
  hitZone,
  recoilKick,
  spreadDirection,
  zoneMultiplier,
  type Direction,
  type HitZone,
} from './ballistics';
import {
  CombatFx,
  impactSound,
  surfaceImpact,
  type ImpactKind,
  type ImpactSound,
  type ScorchPlacement,
} from './CombatFx';
import { Projectiles, type RocketHandle } from './Projectiles';
import {
  nearestPointOnOrientedBox,
  orientedBoxNormal,
  rayCylinder,
  rayGround,
  rayOrientedBox,
  WorldRayIndex,
  type BoxPoint,
} from './rays';
import {
  EMPTY_ACTORS,
  type ActorSource,
  type ActorTarget,
  type Blow,
  type LawTargets,
} from './targets';
import { WeaponViewmodel, type ViewmodelSet } from './WeaponViewmodel';

/** How close somebody has to be to notice a gunshot. */
export const WITNESS_RADIUS = 34;

/**
 * Shortest gap between two "a gun went off here" alarms, in seconds.
 *
 * The alarm is raised per trigger pull, and a carbine pulls its own trigger
 * nine times a second. Whoever receives it - the crowd - would then be asked
 * to re-scatter the whole street nine times for one burst. Firing immediately
 * and then going quiet for a third of a second makes a burst one event without
 * ever delaying the first shot's alarm, which is the one that matters.
 */
const ALARM_INTERVAL = 0.35;

/**
 * How far ahead of the eye the viewmodel's clearance probe looks.
 *
 * Only long enough to cover the reach of the longest weapon plus a little
 * slack; anything beyond that is not something the barrel can reach.
 */
const CLEARANCE_PROBE = 1.1;

/** Weapons that keep firing while the trigger is held. */
const AUTOMATIC: ReadonlySet<WeaponId> = new Set<WeaponId>(['smg', 'rifle']);

/** Seconds between dry-fire clicks, so a held trigger is not a woodpecker. */
const DRY_CLICK_INTERVAL = 0.34;

/**
 * Where a vehicle stops being sheet metal and starts being glass.
 *
 * A fraction of the vehicle's own half height, measured up from its centre.
 * Above it a round goes through a window, below it through a door skin, and
 * the two do not sound or look remotely alike.
 */
const GLAZING_FROM = 0.34;

/**
 * How far a vehicle's own body reaches past the point the broad phase matches.
 *
 * `TrafficSystem.forEachNear` matches vehicle CENTRES, and the biggest thing in
 * the fleet is the 6.70 x 2.14 x 2.92 m box truck, whose half diagonal is 3.81
 * m. Asking for a radius of exactly the shot's length therefore missed every
 * car whose nose was inside the shot and whose centre was not - which for a
 * 4.88 m saloon is the first 2.44 m of it, and for a rocket stepping 0.77 m per
 * frame at 46 m/s was EVERY car it ever flew at. Four metres covers the whole
 * catalogue with room for one more shape.
 */
const VEHICLE_REACH = 4;

/**
 * The same correction for people, whose broad phase also matches centres.
 *
 * A shoulder is about 0.4 m from the spine and nobody in the city is wider, so
 * a metre is generous; a person is a much smaller error than a box truck, but
 * it is the same error.
 */
const ACTOR_REACH = 1;

/**
 * Newton-seconds a point-blank warhead delivers to a vehicle.
 *
 * A saloon in this game masses 1 780 kg, so this is about 3.9 m/s of shove at
 * the seat of the blast, falling off with the same curve the damage does. Fast
 * enough that a rocket visibly throws a parked car; slow enough that it does
 * not launch one over a building.
 */
const BLAST_IMPULSE = 7000;

/**
 * The presented area `BLAST_IMPULSE` is calibrated against, in square metres.
 *
 * A saloon is 4.88 x 1.50 m in side elevation, which is 7.3 m². A blast does
 * not push a "vehicle": it pushes whatever area of one it can see, so a box
 * truck standing 6.70 x 2.92 m broadside has to take more of the shockwave
 * than a compact does. Without this the only thing separating them was mass,
 * and the truck - being heavier and no larger, as far as the arithmetic knew -
 * simply shrugged everything off.
 */
const BLAST_AREA_REFERENCE = 7.3;

/**
 * How hard the impulse grows with that area, and the ceiling on it.
 *
 * A SQUARE ROOT, not a straight ratio. The blast loads the near face hardest
 * and the far half of a long body barely at all, and the pressure has already
 * fallen off across the length of a truck, so doubling the silhouette does not
 * double the shove. Straight proportionality made every vehicle in the
 * catalogue accelerate to almost exactly the same speed, because area and mass
 * happen to scale together across it - which is arithmetic, not physics, and
 * it erased the difference between blowing over a hatchback and rocking a van.
 */
const BLAST_AREA_MIN = 0.55;
const BLAST_AREA_MAX = 2.2;

/**
 * Newton-seconds a warhead adds to the thing it hits SQUARE ON.
 *
 * The blast is radial and reaches everything; this is the part of the round
 * that was still travelling at 46 m/s when it arrived, and it only exists for
 * the one body the rocket physically struck. It is what makes a direct hit
 * different from a near miss at the same distance - the near miss shoves the
 * car sideways, the direct hit puts it through a shopfront.
 */
const DIRECT_IMPULSE = 4600;

/**
 * Newton-seconds a blast puts straight UP through a body it reaches.
 *
 * Scaled by the same exposure and falloff as the shove, then by how much of the
 * body the overpressure passes UNDER - see `blastLift`. 3200 N.s at the seat of
 * a blast is 2.25 m/s on a 1420 kg saloon: a car that visibly leaves the road,
 * hangs for about half a second and comes down hard, rather than one that
 * either slides or is launched over a rooftop.
 *
 * Added to the horizontal impulse rather than divided out of it, so the shove
 * every existing number was calibrated against is unchanged. See
 * `VehicleImpact.lift`.
 */
const BLAST_LIFT = 3200;

/**
 * Extra lift for the body the warhead physically struck.
 *
 * The counterpart of `DIRECT_IMPULSE`: 2600 N.s more, so a direct hit on a
 * saloon reaches 3.06 m/s upward - roughly 0.48 m of air and 0.62 s of hang. A
 * box truck three times the mass takes the same impulse and barely leaves the
 * ground, which is the difference worth having.
 */
const DIRECT_LIFT = 2600;

/**
 * How much of a blast lifts a body rather than shoving it, as a signed share.
 *
 * A blast is radial, so where its seat sits relative to the body decides how
 * much of it goes underneath. The reference is the body's own CENTRE - which is
 * what `CombatVehicleView.y` is, `vehicle.y + halfHeight`, not the ground under
 * the wheels - and the distance is measured in half heights so the answer is
 * scale free:
 *
 *   - a warhead at road level beside a car is a full half height below its
 *     centre and passes entirely under it: +1
 *   - one level with the centre is pure shove: 0
 *   - one arriving through the ROOF presses down instead: -1
 *
 * `direct` FLOORS it high, and the number matters. A warhead that physically
 * struck a car normally lands on a flank at or above mid height, where the
 * geometry alone returns zero or less - on the bare geometry a rocket into a
 * windscreen would press the car into the road. But a warhead that struck the
 * shell has already put its own energy inside it, and a car hit by a rocket
 * that merely settles on its springs is the whole defect this exists to fix. At
 * 0.75 a direct hit on a saloon is about 2.4 m/s upward - 0.30 m of air and
 * half a second of hang, a car visibly thrown. At the 0.35 first tried it was
 * a tenth of that, which is a pothole.
 */
export function blastLift(
  blastY: number,
  vehicleCentreY: number,
  halfHeight: number,
  direct: boolean,
): number {
  const half = Math.max(0.1, halfHeight);
  const bounded = clamp((vehicleCentreY - blastY) / half, -1, 1);
  return direct ? Math.max(bounded, 0.75) : bounded;
}

/**
 * Projected area of a yaw-oriented box seen from a direction, in square metres.
 *
 * The exact shadow a box casts along a direction is the sum over its three
 * face pairs of `|d · axis| * faceArea`, which is cheap, needs no clipping and
 * is right for every orientation including the diagonal ones. `d` need not be
 * normalised; a zero direction reports the side elevation, which is the most
 * likely answer when a blast is exactly at the centre of a car.
 */
export function presentedArea(
  halfLength: number,
  halfWidth: number,
  halfHeight: number,
  yaw: number,
  dx: number,
  dy: number,
  dz: number,
): number {
  const length = Math.max(0, halfLength) * 2;
  const width = Math.max(0, halfWidth) * 2;
  const height = Math.max(0, halfHeight) * 2;
  const norm = Math.hypot(dx, dy, dz);
  if (norm < 1e-6) return length * height;
  const ux = dx / norm;
  const uy = dy / norm;
  const uz = dz / norm;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  // The box's own axes, in the convention `rayOrientedBox` uses: local X runs
  // across the vehicle and local Z from nose to tail.
  const acrossX = cos;
  const acrossZ = -sin;
  const alongX = sin;
  const alongZ = cos;
  const across = Math.abs(ux * acrossX + uz * acrossZ);
  const along = Math.abs(ux * alongX + uz * alongZ);
  const up = Math.abs(uy);
  return across * length * height + along * width * height + up * length * width;
}

/**
 * How much of the peak impulse survives to a given share of the radius.
 *
 * SHARPER THAN THE DAMAGE CURVE, deliberately. Damage at the rim of a blast
 * should still be felt - that is what a radius means - but momentum at the rim
 * should be almost nothing, or every parked car within nine metres takes off
 * together and the street turns into a fairground. Raising the damage curve to
 * the power of one and a half gives full shove inside the fireball, 0.43 of it
 * at half the radius, and 0.028 at four fifths of it - a third of what the
 * damage curve still reports there.
 */
export function blastImpulseFalloff(share: number): number {
  const damage = blastFalloff(share);
  return damage * Math.sqrt(damage);
}

/**
 * Metres per second a body is thrown at by the thing that killed it.
 *
 * A bullet does not move a person; it drops them where they stood. A shockwave
 * does. The receiving end caps and scales these - see `PoliceSystem.knockDown`
 * and the crowd's own - so what matters here is only the ratio between them.
 */
const BULLET_THROW = 3;
const BLAST_THROW = 12;

/**
 * Ceilings and recovery for the fallback recoil path only.
 *
 * `FirstPersonController` enforces its own, identical, ceiling when it is the
 * one holding the offset; these apply when nothing was wired and this system
 * is rotating the camera itself.
 */
const RECOIL_PITCH_MAX = 0.2;
const RECOIL_YAW_MAX = 0.06;
const RECOIL_RECOVERY = 9;

/** World up, for a yaw that must not introduce roll. Never mutated. */
const WORLD_UP = new Vector3(0, 1, 0);

/**
 * Blast damage as a fraction of the peak, against distance from the seat of
 * the explosion as a fraction of its radius.
 *
 * Full damage inside the first third - anyone that close is inside the
 * fireball - then a square falloff to nothing at the edge. A linear falloff
 * made the outer half of the radius feel like a much bigger weapon than it is.
 */
export function blastFalloff(share: number): number {
  if (share <= 0.34) return 1;
  if (share >= 1) return 0;
  const t = (1 - share) / 0.66;
  return t * t;
}

/**
 * Number keys, in the order the shop lists weapons.
 *
 * Kept in step with `ALL_WEAPONS` on purpose: the row the player sees in the
 * shop and the key they press for it have to be the same ordinal or the
 * mapping is a memory test.
 */
const SLOT_ORDER: readonly WeaponId[] = ALL_WEAPONS;

/** A vehicle, as little of one as combat needs. */
export interface CombatVehicleView {
  readonly id: number;
  readonly police: boolean;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly halfLength: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/**
 * Something arriving on a vehicle hard enough for the vehicle to notice.
 *
 * Structural, and structurally identical to `TrafficSystem`'s own declaration,
 * so the traffic layer satisfies `VehicleQuery` without either module importing
 * the other. `damage` is on the same scale the pursuit uses for its cars, where
 * 260 is a write-off.
 */
export interface VehicleImpact {
  /** World contact point - the nearest point of the box, not its centre. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Unit push direction in the horizontal plane. */
  readonly dirX: number;
  readonly dirZ: number;
  /** Newton-seconds. */
  readonly impulse: number;
  /**
   * Newton-seconds STRAIGHT UP, added to the horizontal impulse rather than
   * divided out of it. Negative presses down. Structurally identical to
   * `VehicleImpact.lift` in `src/traffic/types.ts`, which is what the traffic
   * layer reads; this interface is the combat layer's own statement of the
   * contract so the two modules do not have to import each other.
   */
  readonly lift?: number;
  readonly damage: number;
}

export interface VehicleQuery {
  forEachNear(x: number, z: number, radius: number, visit: (view: CombatVehicleView) => void): void;
  /**
   * Damages and SHOVES one vehicle. Returns whether the id was recognised.
   *
   * For a blast, and only for a blast. The traffic layer rate limits this at
   * one impulse per vehicle per 0.22 s, because a contact between two cars
   * lasts many frames and re-integrating it would launch a hatchback over a
   * building - which is right, and which is exactly why a carbine emptying a
   * magazine at 9 rounds a second must not come through here. See
   * `applyDamage`.
   */
  applyImpact?(vehicleId: number, hit: VehicleImpact): boolean;
  /**
   * Damage with no impulse behind it: gunfire. Not rate limited.
   *
   * BOTH ARE OPTIONAL, so every existing test double - and any fleet that only
   * wants to be shot AT rather than damaged - keeps working. Without them a
   * round still registers as a hit and still draws its impact; the car simply
   * does not care, which is what the whole fleet did before.
   *
   * `x`/`y`/`z` are the WORLD CONTACT POINT of the round - the point the ray
   * test found on the body, not the vehicle's centre. The traffic layer
   * accumulates damage per region (front, rear, the two flanks, the glazing
   * and each of the four tyres) and that point is the only thing that says
   * which region took it: the HEIGHT picks glazing out from panel and the
   * CORNER picks one tyre out from four, so `y` carries as much as `x` and `z`.
   * They are optional, so a fleet that keeps one scalar still compiles;
   * omitted, damage lands uniformly over the shell, which is what shipped.
   *
   * A ROCKET IS TOLD FROM A BULLET BY SIZE, NOT BY WEAPON ID. The fleet treats
   * any single blow past a quarter of the shell as the thing that blows every
   * window and shreds the tyres on the struck side; a warhead is 190 points
   * against a carbine round's 34. Passing the real damage figure and the real
   * contact point is therefore the whole contract, and nothing on this side
   * special-cases the launcher.
   */
  applyDamage?(
    vehicleId: number,
    amount: number,
    x?: number,
    y?: number,
    z?: number,
  ): boolean;
}

/** What the crowd adapter adds on top of a plain `ActorSource`. */
export interface WitnessSource extends ActorSource {
  /**
   * Once per frame, before any hit test. The player's position is passed so a
   * source that keeps casualty records can apply a distance rule to them.
   */
  refresh(dt: number, playerX: number, playerZ: number): void;
  hasWitnessWithin(x: number, z: number, radius: number): boolean;
  /**
   * A gun went off at `(x, z)`; anybody within `radius` heard it.
   *
   * Optional, so an `ActorSource` with nothing to scatter - and every existing
   * test double - keeps working. Fired for a miss as readily as for a hit:
   * this is the SOUND, not the wound.
   */
  alarm?(x: number, z: number, radius: number): void;
}

export interface CombatHud {
  /** `magazine` is rounds in the gun, `reserve` is rounds the player owns. */
  setWeapon(
    name: string | null,
    magazine: number,
    reserve: number,
    state: 'ready' | 'reloading' | 'empty' | 'stowed',
  ): void;
}

export interface CombatSystemOptions {
  readonly player: PlayerState;
  readonly camera: PerspectiveCamera;
  readonly domElement: HTMLElement;
  /** Solid world geometry, built from `sink.colliders`. */
  readonly world: WorldRayIndex;
  readonly heightAt: (x: number, z: number) => number;
  readonly civilians?: WitnessSource | undefined;
  readonly vehicles?: VehicleQuery | undefined;
  readonly law?: LawTargets | undefined;
  readonly hud?: CombatHud | undefined;
  readonly seed?: string | undefined;
  /** Fires for every shot that leaves the barrel, so audio can play something. */
  readonly onShot?: ((weapon: WeaponId) => void) | undefined;
  /**
   * Where the weapon's kick goes. `FirstPersonController` is one.
   *
   * WIRE THIS. Without it the kick is applied to the camera here instead, which
   * is correct - the shot is still cast from the pose the player is looking at,
   * see `update` - but it cannot survive the controller's next absolute write,
   * so the aim itself never climbs and a burst has nothing to control.
   */
  readonly recoil?: RecoilSink | undefined;
  /**
   * Fires for every projectile that arrives somewhere.
   *
   * Reports the recorded sound the impact wants rather than the visual
   * material, because the two vocabularies are not the same size: see
   * `impactSound`.
   */
  readonly onImpact?:
    | ((kind: ImpactSound, x: number, y: number, z: number) => void)
    | undefined;
  /** Handling the weapon rather than firing it: drawing, stowing, an empty gun. */
  readonly onHandling?: ((kind: 'draw' | 'holster' | 'dry' | 'reload') => void) | undefined;
  /** A rocket left the tube, so audio can follow its motor down the street. */
  readonly onRocket?: ((rocket: RocketHandle) => void) | undefined;
  /**
   * The player reached for a weapon they do not have.
   *
   * Without this a slot key for an unbought weapon is indistinguishable from a
   * key that is not bound at all, which is exactly how "the weapon switching
   * does not work" gets reported: the control was working the whole time and
   * had nothing to say.
   */
  readonly onSlotDenied?: ((weapon: WeaponId, reason: 'unowned' | 'empty') => void) | undefined;
  /**
   * A warhead went off. `distance` is from the player, so the caller can
   * decide how hard to shake the camera and how long to ring the ears.
   */
  readonly onExplosion?:
    | ((x: number, y: number, z: number, radius: number, distance: number) => void)
    | undefined;
  /**
   * The rocket model, for the launcher.
   *
   * The projectile layer is built HERE rather than passed in, because it needs
   * this system's own world probe and its own detonation, and handing those
   * out through the constructor would make the two mutually dependent at the
   * call site. Omit it and rockets still fly and still explode; they are just
   * invisible while they do it.
   */
  readonly rocketUrl?: string | undefined;
  /**
   * Generated weapon models to hold in view. Omit for no view model at all -
   * the game is playable and every shot registers identically without one.
   * `defaultViewmodels(import.meta.env.BASE_URL)` is the shipped set.
   */
  readonly viewmodels?: ViewmodelSet | undefined;
}

export interface CombatContext {
  readonly driving: boolean;
  readonly playerX: number;
  readonly playerY: number;
  readonly playerZ: number;
  readonly playerSpeed: number;
}

export type HitKind = 'civilian' | 'police' | 'vehicle' | 'policeVehicle' | 'world' | 'ground' | 'none';

/**
 * What a warhead physically arrived on, carried into the detonation.
 *
 * ONE HIT RESULT DECIDES EVERYTHING. The rocket's swept probe already knows
 * the surface normal, the material and which vehicle - if any - was struck,
 * and until this existed all of it was thrown away and only the distance
 * survived. That is why a rocket into a wall used to leave its scorch lying
 * flat in mid-air, why it sounded the same against glass as against tarmac,
 * and why the car it hit dead centre was pushed by exactly the radial blast a
 * car standing beside it got.
 */
export interface BlastContact {
  /** Outward unit normal of the surface the warhead struck. */
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Unit direction the warhead was travelling on arrival. */
  readonly dirX: number;
  readonly dirY: number;
  readonly dirZ: number;
  readonly kind: HitKind;
  /** What the surface is made of, in the visual vocabulary. */
  readonly impact: ImpactKind;
  /** The vehicle the warhead physically struck, or -1 for anything else. */
  readonly vehicleId: number;
}

interface Hit {
  t: number;
  kind: HitKind;
  actor: number;
  vehicleId: number;
  /** Foot height and total height of an actor, for the damage zone. */
  footY: number;
  height: number;
  /** Centre and half height of a vehicle, for telling glazing from panel. */
  vehicleY: number;
  vehicleHalf: number;
  nx: number;
  ny: number;
  nz: number;
  box: ColliderBox | null;
}

interface Candidate {
  id: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
  police: boolean;
}

/**
 * Everything one cast needs to borrow, owned rather than shared.
 *
 * There are two casts in this system and they are NOT nested in a predictable
 * order for ever: the hitscan path runs from `pullTrigger`, and the rocket
 * probe runs from inside `projectiles.update`. Both used to write the same
 * `aim`, the same `direction`, the same `hit` and the same candidate arrays,
 * and the only thing that made that safe was that `projectiles.update` happens
 * to be called before the trigger is polled. Two of these, one per caller, so
 * the ordering stops being load bearing.
 */
interface CastScratch {
  aimX: number;
  aimY: number;
  aimZ: number;
  readonly direction: Direction;
  readonly hit: Hit;
  readonly candidates: Candidate[];
  candidateCount: number;
  readonly vehicles: CombatVehicleView[];
}

function createScratch(): CastScratch {
  return {
    aimX: 0,
    aimY: 0,
    aimZ: -1,
    direction: { x: 0, y: 0, z: 0 },
    hit: {
      t: 0, kind: 'none', actor: -1, vehicleId: -1, footY: 0, height: 0,
      vehicleY: 0, vehicleHalf: 0, nx: 0, ny: 1, nz: 0, box: null,
    },
    candidates: [],
    candidateCount: 0,
    vehicles: [],
  };
}

export interface CombatStats {
  readonly shotsFired: number;
  readonly pelletsFired: number;
  readonly hits: number;
  readonly civiliansHurt: number;
  readonly civiliansKilled: number;
  readonly officersHurt: number;
  readonly officersKilled: number;
  readonly magazine: number;
  readonly reserve: number;
  readonly reloading: boolean;
  readonly equipped: WeaponId | null;
}

export class CombatSystem {
  /** Add this to the scene. It holds the effect pools and nothing else. */
  readonly group: Object3D;

  private readonly options: CombatSystemOptions;
  private readonly armoury: Armoury;
  private readonly fx = new CombatFx();
  private readonly rng: Rng;
  private readonly civilians: ActorSource;
  private readonly witnesses: WitnessSource | null;
  private readonly viewmodel: WeaponViewmodel | null;
  private readonly projectiles: Projectiles;

  private trigger = false;
  /** Cleared on mouse-up so a semi-automatic needs a fresh pull. */
  private triggerLatched = false;
  /**
   * The weapon is put away.
   *
   * Distinct from equipping nothing: the player still OWNS a weapon and is
   * still carrying it, the HUD still names it, and one key brings it back.
   * Nothing fires while this is true.
   */
  private stowed = false;
  /**
   * The kick, when there is nowhere better to put it.
   *
   * Used ONLY when no `recoil` sink was supplied. See `applyOwnRecoil`.
   */
  private recoilPitch = 0;
  private recoilYaw = 0;
  private dryClick = 0;
  /**
   * The player is in a vehicle, latched from the last `update`.
   *
   * ON FOOT ONLY is a rule of this system - see the header - and it used to
   * live only in the trigger POLLING, so `fireOnce` fired happily from the
   * cockpit of an aeroplane. That is not academic: it is how a respawn that
   * left the player nominally still flying passed an automated check that
   * pulled the trigger directly, while the player saw no weapon, no flash and
   * no round. The rule belongs on the trigger itself.
   */
  private inVehicle = false;
  /** Seconds until the crowd may be told about gunfire again. */
  private alarmCooldown = 0;
  /**
   * Where the player was on the last frame.
   *
   * Latched because a blast has to be measured from the PLAYER and the camera
   * is not always where they are: the driving layer's camera is a chase boom
   * 6.6 m behind the car, so a rocket that landed on the bonnet would have
   * measured six metres away and left the driver unhurt.
   */
  private playerX = 0;
  private playerY = 0;
  private playerZ = 0;
  private paused = false;
  private disposed = false;

  /** The hitscan path's scratch, and the rocket probe's. Never shared. */
  private readonly shotCast = createScratch();
  private readonly probeCast = createScratch();
  private readonly hurtCivilians: number[] = [];
  private readonly hurtOfficers: number[] = [];
  /**
   * Victims that have already been given their impact effect this trigger pull.
   *
   * A shotgun shell is eight pellets arriving on one chest in the same
   * millisecond. Drawing eight impacts and playing eight body sounds for it is
   * what made a civilian look like they had been blown apart; one wound cluster
   * per victim per shot is both truer and a twelfth of the particle budget.
   * Encoded as `id * 2 + faction` so a civilian and an officer with the same
   * index are different people. Reused, so a burst allocates nothing.
   */
  private readonly struckThisShot: number[] = [];

  private readonly eye = new Vector3();
  private readonly aim = new Vector3();
  /** The viewmodel clearance probe's own direction; it runs every frame. */
  private readonly clearAim = new Vector3();
  private readonly muzzle = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  /**
   * Reused so a burst, or a blast in a car park, allocates nothing.
   *
   * Carries the CONTACT POINT and the damage zone as well as the direction,
   * because a source that forwards the casualty on - the crowd does - needs to
   * say where the round arrived and what it arrived on. See `Blow`.
   */
  private readonly blow: {
    dirX: number;
    dirZ: number;
    speed: number;
    x: number | undefined;
    y: number | undefined;
    z: number | undefined;
    zone: HitZone | undefined;
  } = { dirX: 0, dirZ: 0, speed: 0, x: undefined, y: undefined, z: undefined, zone: undefined };
  private readonly contact: BoxPoint = { x: 0, y: 0, z: 0, distance: 0 };
  /**
   * What the rocket's last swept probe found.
   *
   * Written by `probeRocket` and read by `onDetonate`, which `Projectiles`
   * calls in the same loop iteration as the probe that ended the flight - see
   * `Projectiles.update`. `valid` is cleared on every probe that found
   * nothing, so a detonation can never read a hit from an earlier rocket.
   * Reused rather than returned so a rocket in flight allocates nothing.
   */
  private readonly probeHit = {
    valid: false,
    nx: 0,
    ny: 1,
    nz: 0,
    kind: 'none' as HitKind,
    impact: 'world' as ImpactKind,
    vehicleId: -1,
  };
  /** The contact handed to `detonate`, reused for the same reason. */
  private readonly blastContact = {
    nx: 0, ny: 1, nz: 0,
    dirX: 0, dirY: 0, dirZ: -1,
    kind: 'none' as HitKind,
    impact: 'world' as ImpactKind,
    vehicleId: -1,
  };
  /** Where a detonation's scorch goes. Reused. */
  private readonly scorch = { x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 };
  private readonly vehicleHit: {
    x: number; y: number; z: number;
    dirX: number; dirZ: number;
    impulse: number; lift: number; damage: number;
  } = { x: 0, y: 0, z: 0, dirX: 0, dirZ: 0, impulse: 0, lift: 0, damage: 0 };

  private counters = {
    shotsFired: 0,
    pelletsFired: 0,
    hits: 0,
    civiliansHurt: 0,
    civiliansKilled: 0,
    officersHurt: 0,
    officersKilled: 0,
  };

  constructor(options: CombatSystemOptions) {
    this.options = options;
    this.armoury = new Armoury(options.player);
    this.rng = createRng(options.seed ?? 'meridian-combat');
    this.witnesses = options.civilians ?? null;
    this.civilians = options.civilians ?? EMPTY_ACTORS;
    this.group = this.fx.group;
    this.group.userData.combat = this;
    this.viewmodel = options.viewmodels ? new WeaponViewmodel(options.viewmodels) : null;
    this.projectiles = new Projectiles({
      url: options.rocketUrl,
      length: 0.62,
      probe: (ox, oy, oz, dx, dy, dz, maxT) => this.probeRocket(ox, oy, oz, dx, dy, dz, maxT),
      onDetonate: (x, y, z, dx, dy, dz, contact) => this.detonateRocket(x, y, z, dx, dy, dz, contact),
      onTrail: (x, y, z) => this.fx.exhaust(x, y, z, () => this.rng.next()),
      ...(options.onRocket ? { onLaunch: options.onRocket } : {}),
    });
    this.group.add(this.projectiles.group);

    // Guarded so the whole hit-registration path can be constructed and driven
    // in a unit test with no DOM at all. `fireOnce` and `setTrigger` are the
    // API the game's own input handlers below are a thin wrapper over.
    options.domElement.addEventListener?.('mousedown', this.onMouseDown);
    const view = typeof window === 'undefined' ? null : window;
    view?.addEventListener('mouseup', this.onMouseUp);
    view?.addEventListener('keydown', this.onKeyDown);
    view?.addEventListener('wheel', this.onWheel, { passive: true });
    view?.addEventListener('blur', this.onBlur);
  }

  // -- public API -----------------------------------------------------------

  /** Stops input without tearing anything down. Mirrors the controller. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.trigger = false;
  }

  /** Holds or releases the trigger. Exposed so automated QA can shoot. */
  setTrigger(held: boolean): void {
    this.trigger = held;
    if (!held) this.triggerLatched = false;
  }

  /** One deliberate trigger pull. Returns true if a round left the barrel. */
  fireOnce(): boolean {
    return this.pullTrigger();
  }

  reload(): boolean {
    const started = this.armoury.startReload(this.options.player.equipped);
    if (started) this.options.onHandling?.('reload');
    return started;
  }

  /** True while the weapon is holstered. Nothing fires in this state. */
  get holstered(): boolean {
    return this.stowed;
  }

  /** Puts the weapon away, or takes it back out. Exposed for automated QA. */
  setHolstered(holstered: boolean): void {
    if (this.stowed === holstered) return;
    this.stowed = holstered;
    // A holstered weapon cannot be mid-pull; letting the trigger stay held
    // would fire the instant it came back out.
    if (holstered) {
      this.trigger = false;
      this.triggerLatched = false;
    }
    // Only when the player actually has something to put away or take out.
    if (this.options.player.equipped) {
      this.options.onHandling?.(holstered ? 'holster' : 'draw');
    }
  }

  toggleHolster(): boolean {
    this.setHolstered(!this.stowed);
    return this.stowed;
  }

  equipSlot(slot: number): boolean {
    const id = SLOT_ORDER[slot];
    if (!id) return false;
    const player = this.options.player;
    if (!player.owns(id)) {
      this.options.onSlotDenied?.(id, 'unowned');
      return false;
    }
    if (player.ammo(id) <= 0) this.options.onSlotDenied?.(id, 'empty');
    // Reaching for a weapon is taking it out. Making the player press two keys
    // to draw the one they just asked for would be a puzzle, not a control.
    const wasStowed = this.stowed;
    this.setHolstered(false);
    const changed = player.equipped !== id;
    const equipped = player.equip(id);
    // Swapping weapons is a draw too, but only when something actually
    // changed - re-pressing the key for the weapon already in hand is not.
    if (equipped && changed && !wasStowed) this.options.onHandling?.('draw');
    return equipped;
  }

  /**
   * Steps to the next or previous weapon the player actually owns.
   *
   * The scroll wheel's job, and the reason it exists at all: the number row
   * needs a modifier on several common layouts and is nowhere near the hand on
   * a trackpad, so a player who cannot reach `2` still has to be able to reach
   * the SMG. Weapons the player does not own are skipped rather than reported,
   * because a wheel is a browse and not a request for a specific thing.
   */
  cycleWeapon(direction: 1 | -1): boolean {
    const player = this.options.player;
    const owned = SLOT_ORDER.filter((id) => player.owns(id));
    if (owned.length === 0) return false;
    const current = player.equipped;
    const at = current ? owned.indexOf(current) : -1;
    // From nothing equipped, a scroll down starts at the first weapon and a
    // scroll up at the last, rather than both landing on the same one.
    const next = at < 0
      ? (direction > 0 ? 0 : owned.length - 1)
      : (at + direction + owned.length) % owned.length;
    const id = owned[next];
    if (!id) return false;
    const changed = id !== current;
    this.setHolstered(false);
    const equipped = player.equip(id);
    if (equipped && changed) this.options.onHandling?.('draw');
    return equipped;
  }

  /**
   * The effect pools, so the police can draw their own muzzle flashes and
   * tracers through the same two instanced meshes instead of adding more.
   */
  get effects(): CombatFx {
    return this.fx;
  }

  /**
   * The held weapon and hands, for the renderer's first-person overlay pass.
   *
   * Deliberately NOT part of `group`. `group` goes into the scene, where the
   * depth buffer is shared with the city and a shop counter the player is
   * standing at is geometrically inside the weapon they are holding. This one
   * belongs in `Engine.overlayScene`, which is drawn afterwards against a
   * cleared depth buffer - see `Engine.renderFrame`.
   */
  get overlay(): Object3D | null {
    return this.viewmodel?.group ?? null;
  }

  /** True once the equipped weapon's generated model is on screen. */
  get viewmodelReady(): boolean {
    return this.viewmodel?.ready ?? false;
  }

  /**
   * The weapon the overlay is currently holding, or null.
   *
   * Distinct from `viewmodelReady`, which is also false while an asset is
   * downloading. This one says whether the game has ASKED for a weapon to be
   * in the player's hands at all - the difference between "the gun is still
   * loading" and "the gun is gone".
   */
  get viewmodelWeapon(): WeaponId | null {
    return this.viewmodel?.drawn ?? null;
  }

  /** Weapon models that failed to download. The game plays on without them. */
  get viewmodelFailures(): number {
    return this.viewmodel?.failedCount ?? 0;
  }

  /** Rounds in the magazine of the equipped weapon. */
  get magazine(): number {
    const id = this.options.player.equipped;
    return id ? this.armoury.magazine(id) : 0;
  }

  get reloading(): boolean {
    return this.armoury.reloading;
  }

  get stats(): CombatStats {
    const id = this.options.player.equipped;
    return {
      ...this.counters,
      magazine: this.magazine,
      reserve: id ? this.options.player.ammo(id) : 0,
      reloading: this.armoury.reloading,
      equipped: id,
    };
  }

  /** Rockets in the air. Diagnostics and automated QA. */
  get rocketsLive(): number {
    return this.projectiles.liveCount;
  }

  /** Clears cooldowns, reloads and live effects. Called on respawn. */
  reset(): void {
    this.armoury.reset();
    this.projectiles.clear();
    this.fx.clear();
    this.trigger = false;
    this.triggerLatched = false;
    this.stowed = false;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.alarmCooldown = 0;
    // NOT `inVehicle`: whether the player is in a car is a fact about the
    // world, not a cooldown, and the next `update` is the thing that knows it.
    // Clearing it here would let one frame's trigger pull leave a cockpit.
  }

  /**
   * One frame. Must run AFTER the controller and the driving layer: without a
   * `recoil` sink the kick is applied on top of the camera pose they wrote,
   * and it is their absolute write that keeps it from accumulating.
   */
  update(dt: number, ctx: CombatContext): void {
    if (this.disposed) return;

    this.playerX = ctx.playerX;
    this.playerY = ctx.playerY;
    this.playerZ = ctx.playerZ;
    this.inVehicle = ctx.driving;
    this.witnesses?.refresh(dt, ctx.playerX, ctx.playerZ);
    this.armoury.update(dt);
    if (this.dryClick > 0) this.dryClick = Math.max(0, this.dryClick - dt);
    if (this.alarmCooldown > 0) this.alarmCooldown = Math.max(0, this.alarmCooldown - dt);
    // BEFORE the trigger is polled. When the kick lives here rather than in the
    // controller it is a rotation applied on top of the controller's absolute
    // write, and the whole point is that the shot leaves from the pose the
    // player is looking at - so the pose has to exist before anything is cast
    // from it. Doing this afterwards, which is what shipped, rotated the frame
    // the player saw relative to the bullet that left in it.
    this.applyOwnRecoil(dt, ctx.driving);
    this.projectiles.update(dt);

    if (!this.paused && this.trigger && !ctx.driving) {
      const id = this.options.player.equipped;
      const automatic = id !== null && AUTOMATIC.has(id);
      if (automatic || !this.triggerLatched) {
        this.triggerLatched = true;
        this.pullTrigger();
      }
    }

    // An empty gun reloads itself; a player should not have to learn a key to
    // keep a weapon usable, and the manual reload stays available for topping
    // a partly used magazine up before trouble starts.
    const equipped = this.options.player.equipped;
    if (equipped && !ctx.driving) this.armoury.autoReload(equipped);

    const camera = this.options.camera;
    // Guarded rather than optional-chained: `clearanceAhead` casts a ray, and a
    // build with no view models must not pay for one every frame.
    if (this.viewmodel) {
      this.viewmodel.update(dt, camera, this.options.player.equipped, {
        reloading: this.armoury.reloading,
        holstered: this.stowed,
        hidden: ctx.driving || !this.options.player.alive,
        speed: ctx.playerSpeed,
        clearance: this.clearanceAhead(),
      });
    }
    this.fx.update(dt, camera.position.x, camera.position.y, camera.position.z);
    this.writeHud(ctx);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.domElement.removeEventListener?.('mousedown', this.onMouseDown);
    const view = typeof window === 'undefined' ? null : window;
    view?.removeEventListener('mouseup', this.onMouseUp);
    view?.removeEventListener('keydown', this.onKeyDown);
    view?.removeEventListener('wheel', this.onWheel);
    view?.removeEventListener('blur', this.onBlur);
    this.viewmodel?.dispose();
    this.projectiles.dispose();
    this.fx.dispose();
    // The group outlives this object - the caller added it to a scene and may
    // not remove it - and holding `this` on its userData kept the whole combat
    // layer, its effect pools and its options object reachable for ever.
    delete this.group.userData.combat;
  }

  // -- firing ---------------------------------------------------------------

  private pullTrigger(): boolean {
    const player = this.options.player;
    const id = player.equipped;
    // `inVehicle` is the ON FOOT ONLY rule, and it is enforced HERE rather
    // than only where the held trigger is polled, so every way of asking for a
    // shot - the mouse, `setTrigger`, `fireOnce` from automated QA - gets the
    // same answer the player gets.
    if (!id || !player.alive || this.stowed || this.inVehicle) return false;
    const outcome = this.armoury.fire(id);
    if (!outcome.fired) {
      if (outcome.reason === 'magazine') {
        if (this.armoury.startReload(id)) this.options.onHandling?.('reload');
      }
      // A trigger pull on an empty weapon has to make a sound or the player
      // reads it as the game having stopped responding to the mouse.
      if (outcome.reason === 'noAmmo' || outcome.reason === 'magazine') {
        if (this.dryClick <= 0) {
          this.dryClick = DRY_CLICK_INTERVAL;
          this.options.onHandling?.('dry');
        }
      }
      return false;
    }

    const spec = WEAPONS[id];
    const camera = this.options.camera;
    camera.updateMatrixWorld();
    // FROM THE CAMERA, sway and all, and deliberately not from an un-swayed
    // "true eye". The crosshair is the camera's own centre ray, so a round cast
    // from the camera's position along the camera's direction lands exactly
    // where the crosshair is - by construction, at every range. Subtracting the
    // walk sway from the origin while the RENDERED camera still carries it
    // would introduce the parallax it looks like it removes. Measured, the sway
    // is at most 0.012 m: `amplitude` peaks at 0.035 and the lateral term is
    // 0.35 of it (`FirstPersonController.applyCamera`).
    this.eye.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldDirection(this.aim);
    this.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);

    // The muzzle sits low and to the right of the eye. With a view model
    // loaded it is that model's own barrel end; without one it is where a
    // weapon held at the shoulder would put it, so a build with no generated
    // assets still shows the flash and the tracer leaving the right place.
    let mx = this.eye.x + this.aim.x * 0.5 + this.right.x * 0.17 - this.up.x * 0.13;
    let my = this.eye.y + this.aim.y * 0.5 + this.right.y * 0.17 - this.up.y * 0.13;
    let mz = this.eye.z + this.aim.z * 0.5 + this.right.z * 0.17 - this.up.z * 0.13;
    if (this.viewmodel?.ready) {
      this.viewmodel.muzzleWorld(camera, this.muzzle);
      mx = this.muzzle.x;
      my = this.muzzle.y;
      mz = this.muzzle.z;
    }

    // A weapon with a muzzle speed fires an object, not a ray. Everything
    // below this point - candidate gathering, per-pellet casting, per-victim
    // heat - is the hitscan path and does not apply to it: a rocket's
    // consequences happen wherever and whenever it lands, which is `detonate`.
    if (spec.muzzleSpeed !== undefined) {
      this.fireProjectile(spec, mx, my, mz);
      this.counters.shotsFired += 1;
      if (this.witnessed()) player.addHeat(HEAT.gunshot);
      this.raiseAlarm(this.eye.x, this.eye.z, WITNESS_RADIUS);
      this.fx.muzzle(mx, my, mz, 1.9);
      this.kick(recoilKick(spec), 0);
      this.viewmodel?.punch(2.4);
      this.options.onShot?.(id);
      return true;
    }

    const maxT = spec.rangeM * FALLOFF_END;
    const cast = this.shotCast;
    cast.aimX = this.aim.x;
    cast.aimY = this.aim.y;
    cast.aimZ = this.aim.z;
    this.gatherCandidates(cast, this.eye.x, this.eye.y, this.eye.z, maxT, spec.spreadRad);

    // Asked BEFORE the shot is resolved. Whether the street saw a gun go off
    // cannot depend on who is still standing a millisecond later, or shooting
    // the only witness would erase the report of the shot that killed them.
    const seen = this.witnessed();

    this.hurtCivilians.length = 0;
    this.hurtOfficers.length = 0;
    this.struckThisShot.length = 0;
    let killedCivilians = 0;
    let killedOfficers = 0;
    let hitPolice = false;
    let hitPoliceVehicle = false;

    const direction = cast.direction;
    for (let pellet = 0; pellet < outcome.pellets; pellet += 1) {
      spreadDirection(this.aim.x, this.aim.y, this.aim.z, spec.spreadRad, this.rng, direction);
      const hit = this.castOne(cast, this.eye.x, this.eye.y, this.eye.z, maxT);
      this.counters.pelletsFired += 1;

      const endX = this.eye.x + direction.x * hit.t;
      const endY = this.eye.y + direction.y * hit.t;
      const endZ = this.eye.z + direction.z * hit.t;
      this.fx.tracer(mx, my, mz, endX, endY, endZ);

      if (hit.kind === 'none') continue;
      this.counters.hits += 1;

      let impact: ImpactKind = 'world';
      // Where the blood pool goes. For anything that is not a person this is
      // unused; for a person it is their own feet, which is exact.
      let floorY = endY;
      // One impact effect and one impact sound per victim per trigger pull.
      // A miss, a wall and a car are unaffected; only a body coalesces.
      let drawImpact = true;
      const base = damageAtRange(spec, hit.t);

      if (hit.kind === 'civilian' || hit.kind === 'police') {
        impact = 'body';
        floorY = hit.footY;
        const zone = hitZone(endY, hit.footY, hit.height);
        const damage = base * zoneMultiplier(endY, hit.footY, hit.height);
        const source = hit.kind === 'civilian' ? this.civilians : (this.options.law ?? EMPTY_ACTORS);
        // A shot person falls the way the round was travelling, and is hit
        // where the ray actually met them rather than at their own centre.
        const result = source.damage(
          hit.actor,
          damage,
          this.aimBlow(direction, BULLET_THROW, endX, endY, endZ, zone),
        );
        // A victim wounded by one pellet and killed by the next is ONE offence,
        // the worse of the two, so the wounding is withdrawn when the killing
        // lands. Without this a shotgun charged both for the same person.
        const list = hit.kind === 'civilian' ? this.hurtCivilians : this.hurtOfficers;
        if (result === 'killed') {
          const already = list.indexOf(hit.actor);
          if (already >= 0) list.splice(already, 1);
          if (hit.kind === 'civilian') killedCivilians += 1;
          else killedOfficers += 1;
        } else if (result === 'hurt' && !list.includes(hit.actor)) {
          list.push(hit.actor);
        }
        if (hit.kind === 'police') hitPolice = true;
        const token = hit.actor * 2 + (hit.kind === 'police' ? 1 : 0);
        if (this.struckThisShot.includes(token)) drawImpact = false;
        else this.struckThisShot.push(token);
      } else if (hit.kind === 'policeVehicle' || hit.kind === 'vehicle') {
        impact = this.vehicleSurface(hit, endY);
        // The sheet metal takes the round whoever is driving. `damageVehicle`
        // is the PURSUIT's own integrity - whether that unit is still in the
        // chase - and is a different quantity from the state of the bodywork,
        // so a patrol car pays both and an ordinary car pays the one that
        // exists for it. No impulse: a bullet dents a car, it does not move
        // one, and the impulse path is rate limited against exactly this.
        // The contact point goes with it. The fleet accumulates damage per
        // region, and glass is selected by hit height and a tyre by corner, so
        // a round that arrives without a point can only be spread over the
        // whole shell - which is the uniform damage this replaces.
        this.options.vehicles?.applyDamage?.(hit.vehicleId, base, endX, endY, endZ);
        if (hit.kind === 'policeVehicle') {
          hitPoliceVehicle = true;
          this.options.law?.damageVehicle(hit.vehicleId, base);
        }
      } else if (hit.kind === 'world' && hit.box) {
        // The one line that made every building, kerb, lamp post and shopfront
        // in the city throw identical pale stone dust.
        //
        // NON-SOLID BOXES - steps, low platforms - are not in this index and a
        // round still passes through them. Including them would be more
        // truthful for a bullet, and it is NOT done here on purpose: the index
        // is built once in `main.ts` and shared with `PoliceSystem`'s line of
        // sight, so adding the walkable boxes would also change who can see the
        // player from behind a step. That is a decision for the wiring, not for
        // this system, and it needs its own measurement.
        impact = surfaceImpact(hit.box.surface);
      }

      if (!drawImpact) continue;
      if (hit.kind === 'vehicle' || hit.kind === 'policeVehicle') {
        /*
         * SPARKS, BUT NO DECAL.
         *
         * A mark is welded to the WORLD, and a car is not part of the world:
         * it drives off half a second later and leaves its bullet holes
         * hanging in the middle of the street, which is a worse artefact than
         * having no holes at all. Parenting a decal to a vehicle would need
         * the traffic layer to own a decal budget per car, which is a much
         * larger change than this one and is not what was asked for. The
         * sparks off the panel, the glass out of the window and the sound are
         * what a hit on a moving body honestly leaves, and all three live for
         * a third of a second.
         */
        this.fx.debris(endX, endY, endZ, hit.nx, hit.ny, hit.nz, impact, () => this.rng.next());
        this.options.onImpact?.(impactSound(impact, false), endX, endY, endZ);
        continue;
      }
      this.fx.impact(
        endX,
        endY,
        endZ,
        hit.nx,
        hit.ny,
        hit.nz,
        impact,
        () => this.rng.next(),
        floorY,
      );
      this.options.onImpact?.(impactSound(impact, hit.kind === 'ground'), endX, endY, endZ);
    }

    // -- consequences -------------------------------------------------------
    // Heat is applied once per trigger pull and once per victim, not per
    // pellet: eight shotgun pellets in one officer is one offence.
    const consequences = this.options.player;
    if (seen) consequences.addHeat(HEAT.gunshot);
    // The street reacts to the SOUND, whether or not anything was hit and
    // whether or not the shot counted as public - a miss into a wall is still
    // a gunshot to everybody who heard it.
    this.raiseAlarm(this.eye.x, this.eye.z, WITNESS_RADIUS);
    for (let i = 0; i < this.hurtCivilians.length; i += 1) consequences.addHeat(HEAT.civilianHurt);
    for (let i = 0; i < killedCivilians; i += 1) consequences.addHeat(HEAT.civilianKilled);
    for (let i = 0; i < this.hurtOfficers.length; i += 1) consequences.addHeat(HEAT.policeHurt);
    for (let i = 0; i < killedOfficers; i += 1) consequences.addHeat(HEAT.policeKilled);
    if (hitPoliceVehicle && !hitPolice) consequences.addHeat(HEAT.policeHurt);
    if (hitPolice || hitPoliceVehicle) {
      this.options.law?.reportAttack(this.eye.x, this.eye.z);
    }

    this.counters.civiliansHurt += this.hurtCivilians.length;
    this.counters.civiliansKilled += killedCivilians;
    this.counters.officersHurt += this.hurtOfficers.length;
    this.counters.officersKilled += killedOfficers;
    this.counters.shotsFired += 1;

    this.fx.muzzle(mx, my, mz, 0.7 + spec.damage * 0.02);
    const kick = recoilKick(spec);
    this.kick(kick, (this.rng.next() - 0.5) * kick * 0.9);
    this.viewmodel?.punch(Math.max(0.5, spec.damage / 26));
    this.options.onShot?.(id);
    return true;
  }

  /**
   * People and vehicles that could plausibly be on this shot's path.
   *
   * Gathering once per trigger pull rather than once per pellet is what keeps
   * a shotgun cheap: eight pellets then test a handful of candidates each
   * instead of the whole street eight times.
   */
  private gatherCandidates(
    cast: CastScratch,
    ox: number,
    oy: number,
    oz: number,
    maxT: number,
    spreadRad: number,
  ): void {
    cast.candidateCount = 0;
    cast.vehicles.length = 0;
    const ax = cast.aimX;
    const ay = cast.aimY;
    const az = cast.aimZ;
    // Half-width of the corridor the pattern can reach at its far end, plus a
    // body radius and a little slack.
    const corridor = Math.tan(spreadRad) * maxT + 1.2;

    const consider = (
      id: number,
      x: number,
      y: number,
      z: number,
      radius: number,
      height: number,
      police: boolean,
    ): void => {
      const dx = x - ox;
      const dy = y + height * 0.5 - oy;
      const dz = z - oz;
      const along = dx * ax + dy * ay + dz * az;
      if (along < -1 || along > maxT + 2) return;
      const px = dx - ax * along;
      const py = dy - ay * along;
      const pz = dz - az * along;
      const perpendicular = Math.hypot(px, py, pz);
      if (perpendicular > corridor + radius + height * 0.5) return;
      const slot = cast.candidates[cast.candidateCount] ?? {
        id: 0, x: 0, y: 0, z: 0, radius: 0, height: 0, police: false,
      };
      slot.id = id;
      slot.x = x;
      slot.y = y;
      slot.z = z;
      slot.radius = radius;
      slot.height = height;
      slot.police = police;
      cast.candidates[cast.candidateCount] = slot;
      cast.candidateCount += 1;
    };

    const visitActor = (police: boolean) => (target: ActorTarget): void => {
      consider(target.id, target.x, target.y, target.z, target.radius, target.height, police);
    };
    // BOTH broad phases are asked for the shot's length PLUS the body's own
    // reach, because both match centres. The narrow phase below is exact and
    // is not touched: this only decides who gets to be tested at all.
    this.civilians.forEachActor(ox, oz, maxT + ACTOR_REACH, visitActor(false));
    this.options.law?.forEachActor(ox, oz, maxT + ACTOR_REACH, visitActor(true));

    this.options.vehicles?.forEachNear(ox, oz, maxT + VEHICLE_REACH, (view) => {
      const dx = view.x - ox;
      const dy = view.y - oy;
      const dz = view.z - oz;
      const along = dx * ax + dy * ay + dz * az;
      if (along < -view.halfLength || along > maxT + view.halfLength) return;
      const px = dx - ax * along;
      const py = dy - ay * along;
      const pz = dz - az * along;
      const reach = Math.hypot(view.halfLength, view.halfWidth, view.halfHeight);
      if (Math.hypot(px, py, pz) > corridor + reach) return;
      cast.vehicles.push(view);
    });
  }

  /** Nearest thing along one pellet's path. Writes and returns `cast.hit`. */
  private castOne(cast: CastScratch, ox: number, oy: number, oz: number, maxT: number): Hit {
    const hit = cast.hit;
    const dir = cast.direction;
    hit.t = maxT;
    hit.kind = 'none';
    hit.actor = -1;
    hit.vehicleId = -1;
    hit.box = null;
    hit.nx = -dir.x;
    hit.ny = -dir.y;
    hit.nz = -dir.z;

    for (let i = 0; i < cast.candidateCount; i += 1) {
      const c = cast.candidates[i];
      if (!c) continue;
      const t = rayCylinder(ox, oy, oz, dir.x, dir.y, dir.z, c.x, c.y, c.z, c.radius, c.height, hit.t);
      if (t < 0 || t >= hit.t) continue;
      hit.t = t;
      hit.kind = c.police ? 'police' : 'civilian';
      hit.actor = c.id;
      hit.footY = c.y;
      hit.height = c.height;
      hit.nx = -dir.x;
      hit.ny = -dir.y;
      hit.nz = -dir.z;
      hit.box = null;
    }

    for (const view of cast.vehicles) {
      const t = rayOrientedBox(
        ox, oy, oz, dir.x, dir.y, dir.z,
        view.x, view.y, view.z, view.yaw,
        view.halfLength, view.halfWidth, view.halfHeight,
        hit.t,
      );
      if (t < 0 || t >= hit.t) continue;
      hit.t = t;
      hit.kind = view.police ? 'policeVehicle' : 'vehicle';
      hit.vehicleId = view.id;
      hit.vehicleY = view.y;
      hit.vehicleHalf = view.halfHeight;
      hit.actor = -1;
      hit.box = null;
      // The PANEL's own normal, not the reversed shot. Sparks off a wing
      // struck at forty degrees come off the wing, and the mark lies along it;
      // the reversed direction was only ever right for a square hit.
      orientedBoxNormal(
        ox + dir.x * t, oy + dir.y * t, oz + dir.z * t,
        view.x, view.y, view.z, view.yaw,
        view.halfLength, view.halfWidth, view.halfHeight,
        hit,
      );
    }

    const world = this.options.world.cast(ox, oy, oz, dir.x, dir.y, dir.z, hit.t);
    if (world && world.t < hit.t) {
      hit.t = world.t;
      hit.kind = 'world';
      hit.actor = -1;
      hit.vehicleId = -1;
      hit.box = world.box;
      boxNormal(ox + dir.x * world.t, oy + dir.y * world.t, oz + dir.z * world.t, world.box, hit);
    }

    const ground = rayGround(
      this.options.heightAt, ox, oy, oz, dir.x, dir.y, dir.z, hit.t,
    );
    if (ground >= 0 && ground < hit.t) {
      hit.t = ground;
      hit.kind = 'ground';
      hit.actor = -1;
      hit.vehicleId = -1;
      hit.box = null;
      hit.nx = 0;
      hit.ny = 1;
      hit.nz = 0;
    }

    return hit;
  }

  /**
   * The weapon's kick, wherever it belongs.
   *
   * `pitch` is positive upward. The controller is the right owner - a kick it
   * holds is part of the aim, climbs through a burst and has to be pulled back
   * down - and the local fallback keeps the ray and the rendered pose in
   * agreement when nothing was wired.
   */
  private kick(pitch: number, yaw: number): void {
    const sink = this.options.recoil;
    if (sink) {
      sink.addRecoil(pitch, yaw);
      return;
    }
    this.recoilPitch = clamp(this.recoilPitch + pitch, -RECOIL_PITCH_MAX, RECOIL_PITCH_MAX);
    this.recoilYaw = clamp(this.recoilYaw + yaw, -RECOIL_YAW_MAX, RECOIL_YAW_MAX);
  }

  /**
   * Rotates the camera by the accumulated kick, when nobody else will.
   *
   * Silent when a `recoil` sink exists, because the controller has already
   * composed the offset into the pose it wrote and doing it twice would double
   * the climb.
   */
  private applyOwnRecoil(dt: number, driving: boolean): void {
    if (this.options.recoil) return;
    this.recoilPitch = damp(this.recoilPitch, 0, RECOIL_RECOVERY, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, RECOIL_RECOVERY, dt);
    if (driving || (this.recoilPitch === 0 && this.recoilYaw === 0)) return;
    const camera = this.options.camera;
    camera.rotateX(this.recoilPitch);
    // About WORLD up rather than the camera's own. The controller's pose is
    // Ry(yaw)*Rx(pitch); Ry_world(dy) * pose * Rx_local(dp) is exactly
    // Ry(yaw + dy)*Rx(pitch + dp), whereas a local yaw on a pitched camera
    // introduces roll.
    if (this.recoilYaw !== 0) camera.rotateOnWorldAxis(WORLD_UP, this.recoilYaw);
    camera.updateMatrixWorld();
  }

  /**
   * The shot as a blow: which way it was going, where it arrived, and on what.
   *
   * Flattened and normalised for the direction, because a body topples in the
   * horizontal plane, and exact for the contact point, because that is what
   * identifies WHICH person was hit to a source that has to look one up.
   * Reused, so a shotgun's eight pellets allocate nothing.
   */
  private aimBlow(
    direction: Direction,
    speed: number,
    x: number,
    y: number,
    z: number,
    zone: HitZone,
  ): Blow {
    const flat = Math.hypot(direction.x, direction.z);
    this.blow.dirX = flat > 1e-4 ? direction.x / flat : 0;
    this.blow.dirZ = flat > 1e-4 ? direction.z / flat : 0;
    this.blow.speed = speed;
    this.blow.x = x;
    this.blow.y = y;
    this.blow.z = z;
    this.blow.zone = zone;
    return this.blow;
  }

  /**
   * Tells the crowd a gun went off, at most once every `ALARM_INTERVAL`.
   *
   * A no-op against a source with no `alarm` - which is every existing test
   * double, and the crowd itself until it grows one - so a build without it
   * behaves exactly as it does today.
   */
  private raiseAlarm(x: number, z: number, radius: number): void {
    if (this.alarmCooldown > 0) return;
    this.alarmCooldown = ALARM_INTERVAL;
    this.witnesses?.alarm?.(x, z, radius);
  }

  /**
   * Hands one vehicle a blast's damage and its shove.
   *
   * A no-op against a fleet with no `applyImpact`, which is every test double
   * and was every fleet until the traffic layer grew one.
   */
  private blastVehicle(
    id: number,
    x: number,
    y: number,
    z: number,
    dirX: number,
    dirZ: number,
    damage: number,
    impulse: number,
    lift: number,
  ): void {
    const fleet = this.options.vehicles;
    if (!fleet?.applyImpact || id < 0 || damage <= 0) return;
    const hit = this.vehicleHit;
    hit.x = x;
    hit.y = y;
    hit.z = z;
    hit.dirX = dirX;
    hit.dirZ = dirZ;
    hit.impulse = impulse;
    // Written unconditionally: the object is reused across every vehicle in a
    // blast, so a value left over from the last one would follow the next.
    hit.lift = lift;
    hit.damage = damage;
    fleet.applyImpact(id, hit);
  }

  /**
   * Glazing or bodywork.
   *
   * A vehicle is one oriented box to the ray test, so the only thing that can
   * distinguish a window from a door is where up the box the round landed.
   * Above `GLAZING_FROM` of the half height is the greenhouse on every shape
   * in the fleet, from the compact to the box truck.
   */
  private vehicleSurface(hit: Hit, hitY: number): ImpactKind {
    if (hit.vehicleHalf <= 0) return 'metal';
    return (hitY - hit.vehicleY) / hit.vehicleHalf >= GLAZING_FROM ? 'glass' : 'metal';
  }

  /**
   * Sends a rocket downrange, at whatever the crosshair is on.
   *
   * A ROCKET LEAVES A TUBE, NOT AN EYE. The launch point is the muzzle, which
   * is about 0.2 m below and to the right of the camera; firing it along the
   * CAMERA's direction therefore sent it down a line parallel to the crosshair
   * ray and 0.2 m off it, at every range, for ever. That is a miss on anything
   * narrower than a car and it reads as the weapon being broken.
   *
   * So the two are converged: one cast finds what the crosshair is actually
   * pointing at, and the rocket is aimed from the tube AT THAT POINT. Beyond
   * the last thing in the way it converges at the weapon's own range, which is
   * far enough that the residual parallax is smaller than the warhead.
   *
   * One cast per launch, and the launcher holds one round and reloads for 3.6
   * seconds, so this is not a per-frame cost by any measure.
   */
  private fireProjectile(spec: WeaponSpec, mx: number, my: number, mz: number): void {
    const cast = this.probeCast;
    const reach = spec.rangeM * FALLOFF_END;
    cast.aimX = this.aim.x;
    cast.aimY = this.aim.y;
    cast.aimZ = this.aim.z;
    cast.direction.x = this.aim.x;
    cast.direction.y = this.aim.y;
    cast.direction.z = this.aim.z;
    this.gatherCandidates(cast, this.eye.x, this.eye.y, this.eye.z, reach, 0);
    const crosshair = this.castOne(cast, this.eye.x, this.eye.y, this.eye.z, reach);
    const range = crosshair.kind === 'none' ? reach : Math.max(1, crosshair.t);
    const toX = this.eye.x + this.aim.x * range - mx;
    const toY = this.eye.y + this.aim.y * range - my;
    const toZ = this.eye.z + this.aim.z * range - mz;

    spreadDirection(toX, toY, toZ, spec.spreadRad, this.rng, cast.direction);
    this.projectiles.launch(
      mx, my, mz,
      cast.direction.x, cast.direction.y, cast.direction.z,
      spec.muzzleSpeed ?? 46,
    );
  }

  /**
   * Nearest obstruction along a rocket's next step.
   *
   * Reuses the same candidate gathering and the same cast the hitscan weapons
   * do, so a rocket collides with exactly the things a bullet collides with
   * and there is no second, subtly different world model to keep in step.
   *
   * The contract with `Projectiles` is a distance, because that is all the
   * flight integrator can use - but the cast found a normal, a material and a
   * victim as well, and every one of those is needed a moment later by the
   * detonation. They are latched here rather than recomputed there: recasting
   * from the impact point would be a SECOND hit test with its own answer, and
   * two hit tests that disagree is exactly the class of defect this is.
   */
  private probeRocket(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxT: number,
  ): number {
    const cast = this.probeCast;
    cast.aimX = dx;
    cast.aimY = dy;
    cast.aimZ = dz;
    cast.direction.x = dx;
    cast.direction.y = dy;
    cast.direction.z = dz;
    this.gatherCandidates(cast, ox, oy, oz, maxT, 0);
    const hit = this.castOne(cast, ox, oy, oz, maxT);
    const latch = this.probeHit;
    if (hit.kind === 'none') {
      latch.valid = false;
      return -1;
    }
    latch.valid = true;
    latch.nx = hit.nx;
    latch.ny = hit.ny;
    latch.nz = hit.nz;
    latch.kind = hit.kind;
    latch.vehicleId = hit.vehicleId;
    latch.impact = warheadSurface(hit);
    return hit.t;
  }

  /**
   * A rocket arrived. Turns the latched probe result into a blast contact.
   *
   * `contact` false is the fuse running out in mid-air, where there is no
   * surface, nothing was struck and the scorch has to fall to the ground.
   */
  private detonateRocket(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    contact: boolean,
  ): void {
    if (!contact || !this.probeHit.valid) {
      this.detonate(x, y, z);
      return;
    }
    const at = this.blastContact;
    at.nx = this.probeHit.nx;
    at.ny = this.probeHit.ny;
    at.nz = this.probeHit.nz;
    at.dirX = dx;
    at.dirY = dy;
    at.dirZ = dz;
    at.kind = this.probeHit.kind;
    at.impact = this.probeHit.impact;
    at.vehicleId = this.probeHit.vehicleId;
    this.probeHit.valid = false;
    this.detonate(x, y, z, at);
  }

  /**
   * A warhead going off.
   *
   * Reads the LAUNCHER's blast numbers, because the launcher is the only thing
   * in the armoury that fires a warhead - `Projectiles` carries a rocket, not
   * the weapon that sent it. A second explosive weapon would have to thread
   * its spec through the projectile rather than land here by default.
   *
   * Damage is radial and applied ONCE per victim, which is why it walks the
   * actor sources directly rather than going anywhere near `castOne`: a blast
   * is not a very fat bullet, it does not care about line of sight along a
   * ray, and everyone inside the radius is hit at the same instant.
   *
   * Line of sight is deliberately not tested at all. A grenade behind a kerb
   * killing somebody standing on it is correct - blast goes over cover - and
   * casting a ray to every person in a 9.5 m radius to decide otherwise would
   * cost more than the whole rest of the weapon.
   */
  detonate(x: number, y: number, z: number, contact?: BlastContact): void {
    const spec = WEAPONS.launcher;
    const radius = spec.blastRadius ?? 8;
    const peak = spec.blastDamage ?? 150;
    const player = this.options.player;

    /*
     * Where the scorch goes.
     *
     * A warhead that struck the WORLD - a wall, a kerb, the road - scorches
     * exactly that surface, standing the mark up on a wall and laying it down
     * on a road out of the one normal the probe already found. Anything else -
     * a car, a person, or a fuse that simply ran out in the air - has no
     * surface worth marking, because the thing that was struck is about to
     * move, so the mark falls to the ground under the blast where a player
     * will still find it afterwards.
     */
    const onSurface = contact !== undefined && (contact.kind === 'world' || contact.kind === 'ground');
    const place = this.scorch;
    if (onSurface && contact) {
      place.x = x;
      place.y = y;
      place.z = z;
      place.nx = contact.nx;
      place.ny = contact.ny;
      place.nz = contact.nz;
    } else {
      place.x = x;
      place.y = this.options.heightAt(x, z);
      place.z = z;
      place.nx = 0;
      place.ny = 1;
      place.nz = 0;
    }
    this.fx.explosion(x, y, z, radius, () => this.rng.next(), place as ScorchPlacement);
    // What the warhead landed ON, thrown out of it: grit off concrete, sparks
    // off steel, glass off a shopfront. The same material the sound and the
    // scorch came from, because all three read one hit result.
    if (contact) {
      this.fx.debris(
        x, y, z,
        contact.nx, contact.ny, contact.nz,
        contact.impact,
        () => this.rng.next(),
      );
    }
    // Heard a great deal further than a gunshot, and unthrottled relative to
    // one: a detonation is never part of a burst.
    this.alarmCooldown = 0;
    this.raiseAlarm(x, z, Math.max(WITNESS_RADIUS, radius * 3));

    let civiliansHurt = 0;
    let civiliansKilled = 0;
    let officersHurt = 0;
    let officersKilled = 0;
    let hitPolice = false;

    const strike = (
      source: ActorSource,
      police: boolean,
    ): void => {
      source.forEachActor(x, z, radius + ACTOR_REACH, (target) => {
        // Measured to the middle of the body, not to the feet: somebody
        // standing at the lip of the radius is otherwise untouched by a blast
        // that visibly engulfs them.
        const dx = target.x - x;
        const dy = target.y + target.height * 0.5 - y;
        const dz = target.z - z;
        const distance = Math.hypot(dx, dy, dz);
        if (distance > radius) return;
        const share = blastFalloff(distance / radius);
        const damage = peak * share;
        if (damage <= 0) return;
        // Thrown outward from the seat of the blast. A body at the very centre
        // has no direction to be thrown in and simply drops.
        const flat = Math.hypot(dx, dz);
        this.blow.dirX = flat > 1e-4 ? dx / flat : 0;
        this.blow.dirZ = flat > 1e-4 ? dz / flat : 0;
        this.blow.speed = BLAST_THROW * share;
        // A blast has no contact point and no damage zone: it arrives on all
        // of somebody at once. Cleared rather than left holding whatever the
        // last bullet wrote, which would file a rocket at a rifle's wound.
        this.blow.x = undefined;
        this.blow.y = undefined;
        this.blow.z = undefined;
        this.blow.zone = undefined;
        const result = source.damage(target.id, damage, this.blow);
        if (result === 'killed') {
          if (police) officersKilled += 1;
          else civiliansKilled += 1;
        } else if (result === 'hurt') {
          if (police) officersHurt += 1;
          else civiliansHurt += 1;
        }
        if (police && result !== 'none') hitPolice = true;
      });
    };

    strike(this.civilians, false);
    if (this.options.law) strike(this.options.law, true);

    let hitPoliceVehicle = false;
    const struck = contact?.vehicleId ?? -1;
    // EVERY vehicle, not only the police ones, and measured to the nearest
    // point of the body rather than to its centre. Both of those were wrong:
    // a rocket that landed against a van's bumper measured itself ten metres
    // away from the van, and an ordinary parked car was never asked at all.
    this.options.vehicles?.forEachNear(x, z, radius + VEHICLE_REACH, (view) => {
      const near = nearestPointOnOrientedBox(
        x, y, z,
        view.x, view.y, view.z, view.yaw,
        view.halfLength, view.halfWidth, view.halfHeight,
        this.contact,
      );
      const direct = view.id === struck && struck >= 0;
      if (near.distance > radius) return;
      const share = blastFalloff(near.distance / radius);
      if (share <= 0 && !direct) return;
      // Pushed along the line from the blast to the vehicle's centre: pushing
      // from the contact point would send a car struck square on its flank
      // nowhere at all, because that line is only the thickness of the panel.
      // The MOMENT still comes from the contact point, which is why a blast
      // beside one wing spins the car and one abeam its centre does not.
      const dx = view.x - x;
      const dz = view.z - z;
      const flat = Math.hypot(dx, dz);
      let pushX = flat > 1e-4 ? dx / flat : 1;
      let pushZ = flat > 1e-4 ? dz / flat : 0;

      /*
       * How much of the shockwave this body can actually catch.
       *
       * Measured along the line the blast reaches it on, so a car standing
       * broadside to a detonation takes far more of it than one nose-on -
       * which is the difference between a van being rolled onto its side and
       * being shoved down the street.
       */
      const area = presentedArea(
        view.halfLength, view.halfWidth, view.halfHeight, view.yaw,
        dx, view.y - y, dz,
      );
      const exposure = clamp(
        Math.sqrt(area / BLAST_AREA_REFERENCE),
        BLAST_AREA_MIN,
        BLAST_AREA_MAX,
      );
      const momentum = blastImpulseFalloff(near.distance / radius);
      let impulse = BLAST_IMPULSE * exposure * momentum;
      // Straight up, and added rather than taken out of the shove above. The
      // share is signed, so a warhead through the roof presses down instead.
      let lift =
        BLAST_LIFT *
        exposure *
        momentum *
        blastLift(y, view.y, view.halfHeight, direct);
      let damage = peak * share;
      let pointX = near.x;
      let pointY = near.y;
      let pointZ = near.z;

      if (direct && contact) {
        /*
         * THE ONE BODY THE WARHEAD PHYSICALLY HIT.
         *
         * It gets the round's own direct damage on top of the blast, and the
         * momentum the rocket was still carrying, applied where it actually
         * arrived rather than at the point of the shell nearest the blast.
         * Both go into the SAME `applyImpact` call: the traffic layer rate
         * limits impulses to one per vehicle every 0.22 s, so a second call
         * for the direct hit would simply be refused and the car would be
         * pushed by the blast alone.
         */
        damage += spec.damage;
        lift += DIRECT_LIFT * blastLift(y, view.y, view.halfHeight, true);
        pointX = x;
        pointY = y;
        pointZ = z;
        const travel = Math.hypot(contact.dirX, contact.dirZ);
        const alongX = travel > 1e-4 ? contact.dirX / travel : pushX;
        const alongZ = travel > 1e-4 ? contact.dirZ / travel : pushZ;
        // The two impulses are added as vectors, not as magnitudes: a warhead
        // arriving along the same line the blast pushes reinforces it, one
        // arriving across it turns the push.
        const sumX = pushX * impulse + alongX * DIRECT_IMPULSE;
        const sumZ = pushZ * impulse + alongZ * DIRECT_IMPULSE;
        impulse = Math.hypot(sumX, sumZ);
        if (impulse > 1e-4) {
          pushX = sumX / impulse;
          pushZ = sumZ / impulse;
        }
      }

      this.blastVehicle(view.id, pointX, pointY, pointZ, pushX, pushZ, damage, impulse, lift);
      if (!view.police) return;
      hitPoliceVehicle = true;
      this.options.law?.damageVehicle(view.id, damage);
    });

    for (let i = 0; i < civiliansHurt; i += 1) player.addHeat(HEAT.civilianHurt);
    for (let i = 0; i < civiliansKilled; i += 1) player.addHeat(HEAT.civilianKilled);
    for (let i = 0; i < officersHurt; i += 1) player.addHeat(HEAT.policeHurt);
    for (let i = 0; i < officersKilled; i += 1) player.addHeat(HEAT.policeKilled);
    if (hitPoliceVehicle && !hitPolice) player.addHeat(HEAT.policeHurt);
    if (hitPolice || hitPoliceVehicle) this.options.law?.reportAttack(x, z);

    this.counters.civiliansHurt += civiliansHurt;
    this.counters.civiliansKilled += civiliansKilled;
    this.counters.officersHurt += officersHurt;
    this.counters.officersKilled += officersKilled;
    this.counters.hits += civiliansHurt + civiliansKilled + officersHurt + officersKilled;

    // The player is not immune to their own rocket. Standing next to what you
    // just fired at is a decision with a consequence, not a free shot. Measured
    // from where the PLAYER is - see `playerX` - and to the middle of them,
    // the same way everybody else in the radius is measured.
    const self = Math.hypot(this.playerX - x, this.playerY + 0.9 - y, this.playerZ - z);
    if (self < radius && player.alive) {
      player.hurt(peak * 0.55 * blastFalloff(self / radius), x, z);
    }

    this.options.onExplosion?.(x, y, z, radius, self);
  }

  /**
   * How much open space is straight ahead of the eye, in metres.
   *
   * The held weapon reaches most of a metre in front of the camera and the
   * player's collision cylinder is only 0.34 m of radius, so standing at a
   * wall used to put the barrel inside it. One ray a frame against the same
   * index every shot already uses is enough to know, and the viewmodel pulls
   * the weapon in and tips it up rather than letting that happen.
   */
  private clearanceAhead(): number {
    const camera = this.options.camera;
    // Its OWN vector. This runs every frame, from inside the same `update`
    // that fires the weapon, and it used to write the aim the shot was cast
    // from - safe only because it happened to run afterwards.
    camera.getWorldDirection(this.clearAim);
    const world = this.options.world.cast(
      camera.position.x,
      camera.position.y,
      camera.position.z,
      this.clearAim.x,
      this.clearAim.y,
      this.clearAim.z,
      CLEARANCE_PROBE,
    );
    return world ? world.t : Infinity;
  }

  /** True when somebody is close enough for the shot to count as public. */
  private witnessed(): boolean {
    if (this.witnesses?.hasWitnessWithin(this.eye.x, this.eye.z, WITNESS_RADIUS)) return true;
    return this.options.law?.watchingPlayer() ?? false;
  }

  // -- presentation ---------------------------------------------------------

  private writeHud(ctx: CombatContext): void {
    const hud = this.options.hud;
    if (!hud) return;
    const id = this.options.player.equipped;
    if (!id) {
      hud.setWeapon(null, 0, 0, 'stowed');
      return;
    }
    const spec = WEAPONS[id];
    const reserve = this.options.player.ammo(id);
    const magazine = this.armoury.magazine(id);
    const state = ctx.driving || this.stowed
      ? 'stowed'
      : this.armoury.reloading
        ? 'reloading'
        : magazine > 0
          ? 'ready'
          : 'empty';
    hud.setWeapon(spec.name, magazine, reserve, state);
  }

  // -- input ----------------------------------------------------------------

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    // Only shoot when the game actually has the pointer. The first click on
    // the canvas is the one that asks for the lock, and it must not also be a
    // shot fired at whatever the cursor happened to be over.
    if (typeof document === 'undefined') return;
    if (document.pointerLockElement !== this.options.domElement) return;
    this.setTrigger(true);
  };

  private readonly onMouseUp = (): void => {
    this.setTrigger(false);
  };

  private readonly onBlur = (): void => {
    this.setTrigger(false);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.paused || event.repeat) return;
    if (event.code === 'KeyR') {
      this.reload();
      return;
    }
    // H for holster. Free: the movement keys are WASD and the arrows, Shift
    // runs, E interacts, M is the map, R reloads, Space is the handbrake,
    // backquote and F3 are diagnostics, and 0-4 are the weapon slots.
    if (event.code === 'KeyH') {
      this.toggleHolster();
      return;
    }
    if (matchesDigit(event, 0)) {
      this.options.player.equip(null);
      return;
    }
    for (let slot = 0; slot < SLOT_ORDER.length; slot += 1) {
      if (!matchesDigit(event, slot + 1)) continue;
      this.equipSlot(slot);
      return;
    }
  };

  /**
   * The scroll wheel cycles weapons, but only while the game owns the pointer.
   *
   * Without the pointer-lock check a scroll over the pause menu or the shop
   * would silently change the weapon behind them.
   */
  private readonly onWheel = (event: WheelEvent): void => {
    if (this.paused || event.deltaY === 0) return;
    if (typeof document === 'undefined') return;
    if (document.pointerLockElement !== this.options.domElement) return;
    this.cycleWeapon(event.deltaY > 0 ? 1 : -1);
  };
}

/**
 * True when a key event is the player asking for a given number.
 *
 * Three ways, because one is not enough across the keyboards this game is
 * actually played on:
 *
 *  - `code === 'DigitN'` is the physical key in the number row, which is right
 *    on every layout where that key is unshifted.
 *  - `code === 'NumpadN'` is the same number on the keypad, which a desktop
 *    player may well be using and which reports a completely different code.
 *  - `key === 'N'` is the character actually produced, which is the only one
 *    that works on a layout where the number needs a modifier - and the only
 *    one that works when the browser remaps the row at all.
 *
 * Modified presses are excluded outright: Command-1 and Control-1 are browser
 * tab switches, and firing a weapon swap underneath one of those is worse than
 * ignoring it.
 */
function matchesDigit(event: KeyboardEvent, digit: number): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const text = String(digit);
  return (
    event.code === `Digit${text}` ||
    event.code === `Numpad${text}` ||
    event.key === text
  );
}

/**
 * What a warhead arrived on, in the visual vocabulary.
 *
 * The same classification the hitscan path uses, in one place so a rocket and
 * a rifle round striking the same shopfront agree it is glass.
 */
function warheadSurface(hit: Hit): ImpactKind {
  if (hit.kind === 'civilian' || hit.kind === 'police') return 'body';
  if (hit.kind === 'vehicle' || hit.kind === 'policeVehicle') return 'metal';
  if (hit.kind === 'world') return hit.box ? surfaceImpact(hit.box.surface) : 'world';
  // Terrain carries no declared material; it is paving, sand or grass and the
  // stone bucket is what the ground has always thrown.
  if (hit.kind === 'ground') return 'stone';
  return 'world';
}

/**
 * Outward normal of the box face a point is on.
 *
 * The point comes from a slab test, so it is on the surface to within floating
 * point; the face is whichever one it is nearest.
 */
function boxNormal(
  x: number,
  y: number,
  z: number,
  box: ColliderBox,
  out: { nx: number; ny: number; nz: number },
): void {
  const dx0 = Math.abs(x - box.minX);
  const dx1 = Math.abs(x - box.maxX);
  const dy0 = Math.abs(y - box.bottom);
  const dy1 = Math.abs(y - box.top);
  const dz0 = Math.abs(z - box.minZ);
  const dz1 = Math.abs(z - box.maxZ);
  let best = dx0;
  out.nx = -1;
  out.ny = 0;
  out.nz = 0;
  if (dx1 < best) {
    best = dx1;
    out.nx = 1;
  }
  if (dy0 < best) {
    best = dy0;
    out.nx = 0;
    out.ny = -1;
  }
  if (dy1 < best) {
    best = dy1;
    out.nx = 0;
    out.ny = 1;
  }
  if (dz0 < best) {
    best = dz0;
    out.nx = 0;
    out.ny = 0;
    out.nz = -1;
  }
  if (dz1 < best) {
    out.nx = 0;
    out.ny = 0;
    out.nz = 1;
  }
}
