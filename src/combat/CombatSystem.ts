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
 *   // the camera - the recoil kick is applied on top of the pose they set.
 *   combat.update(dt, { driving, playerX, playerY, playerZ, playerSpeed });
 *
 *   combat.dispose();
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
import { ALL_WEAPONS, HEAT, WEAPONS, type PlayerState, type WeaponId } from '../player/PlayerState';
import type { ColliderBox } from '../world/build/types';
import {
  Armoury,
  damageAtRange,
  FALLOFF_END,
  recoilKick,
  spreadDirection,
  zoneMultiplier,
  type Direction,
} from './ballistics';
import { CombatFx, type ImpactKind } from './CombatFx';
import { Projectiles, type RocketHandle } from './Projectiles';
import { rayCylinder, rayGround, rayOrientedBox, WorldRayIndex } from './rays';
import { EMPTY_ACTORS, type ActorSource, type ActorTarget, type LawTargets } from './targets';
import { WeaponViewmodel, type ViewmodelSet } from './WeaponViewmodel';

/** How close somebody has to be to notice a gunshot. */
export const WITNESS_RADIUS = 34;

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
 * Blast damage as a fraction of the peak, against distance from the seat of
 * the explosion as a fraction of its radius.
 *
 * Full damage inside the first third - anyone that close is inside the
 * fireball - then a square falloff to nothing at the edge. A linear falloff
 * made the outer half of the radius feel like a much bigger weapon than it is.
 */
function blastFalloff(share: number): number {
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

export interface VehicleQuery {
  forEachNear(x: number, z: number, radius: number, visit: (view: CombatVehicleView) => void): void;
}

/** What the crowd adapter adds on top of a plain `ActorSource`. */
export interface WitnessSource extends ActorSource {
  refresh(dt: number): void;
  hasWitnessWithin(x: number, z: number, radius: number): boolean;
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
  /** Fires for every projectile that arrives somewhere. */
  readonly onImpact?:
    | ((kind: ImpactKind, x: number, y: number, z: number) => void)
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
  private recoilPitch = 0;
  private recoilYaw = 0;
  private dryClick = 0;
  private paused = false;
  private disposed = false;

  private readonly direction: Direction = { x: 0, y: 0, z: 0 };
  private readonly hit: Hit = {
    t: 0, kind: 'none', actor: -1, vehicleId: -1, footY: 0, height: 0,
    vehicleY: 0, vehicleHalf: 0, nx: 0, ny: 1, nz: 0, box: null,
  };
  private readonly candidates: Candidate[] = [];
  private candidateCount = 0;
  private readonly vehicleCandidates: CombatVehicleView[] = [];
  private readonly hurtCivilians: number[] = [];
  private readonly hurtOfficers: number[] = [];

  private readonly eye = new Vector3();
  private readonly aim = new Vector3();
  private readonly muzzle = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();

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
      onDetonate: (x, y, z) => this.detonate(x, y, z),
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
  }

  /**
   * One frame. Must run AFTER the controller and the driving layer, because
   * the recoil kick is applied on top of the camera pose they wrote.
   */
  update(dt: number, ctx: CombatContext): void {
    if (this.disposed) return;

    this.witnesses?.refresh(dt);
    this.armoury.update(dt);
    if (this.dryClick > 0) this.dryClick = Math.max(0, this.dryClick - dt);
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

    this.recoilPitch = damp(this.recoilPitch, 0, 9, dt);
    this.recoilYaw = damp(this.recoilYaw, 0, 9, dt);
    if (!ctx.driving && (this.recoilPitch !== 0 || this.recoilYaw !== 0)) {
      this.options.camera.rotateX(this.recoilPitch);
      this.options.camera.rotateY(this.recoilYaw);
    }

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
  }

  // -- firing ---------------------------------------------------------------

  private pullTrigger(): boolean {
    const player = this.options.player;
    const id = player.equipped;
    if (!id || !player.alive || this.stowed) return false;
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
      this.fireProjectile(spec.muzzleSpeed, mx, my, mz);
      this.counters.shotsFired += 1;
      if (this.witnessed()) player.addHeat(HEAT.gunshot);
      this.fx.muzzle(mx, my, mz, 1.9);
      const blastKick = recoilKick(spec);
      this.recoilPitch = clamp(this.recoilPitch + blastKick, 0, 0.2);
      this.viewmodel?.punch(2.4);
      this.options.onShot?.(id);
      return true;
    }

    const maxT = spec.rangeM * FALLOFF_END;
    this.gatherCandidates(this.eye.x, this.eye.y, this.eye.z, spec.rangeM * FALLOFF_END, spec.spreadRad);

    // Asked BEFORE the shot is resolved. Whether the street saw a gun go off
    // cannot depend on who is still standing a millisecond later, or shooting
    // the only witness would erase the report of the shot that killed them.
    const seen = this.witnessed();

    this.hurtCivilians.length = 0;
    this.hurtOfficers.length = 0;
    let killedCivilians = 0;
    let killedOfficers = 0;
    let hitPolice = false;
    let hitPoliceVehicle = false;

    for (let pellet = 0; pellet < outcome.pellets; pellet += 1) {
      spreadDirection(this.aim.x, this.aim.y, this.aim.z, spec.spreadRad, this.rng, this.direction);
      const hit = this.castOne(this.eye.x, this.eye.y, this.eye.z, this.direction, maxT);
      this.counters.pelletsFired += 1;

      const endX = this.eye.x + this.direction.x * hit.t;
      const endY = this.eye.y + this.direction.y * hit.t;
      const endZ = this.eye.z + this.direction.z * hit.t;
      this.fx.tracer(mx, my, mz, endX, endY, endZ);

      if (hit.kind === 'none') continue;
      this.counters.hits += 1;

      let impact: ImpactKind = 'world';
      const base = damageAtRange(spec, hit.t);

      if (hit.kind === 'civilian' || hit.kind === 'police') {
        impact = 'body';
        const damage = base * zoneMultiplier(endY, hit.footY, hit.height);
        const source = hit.kind === 'civilian' ? this.civilians : (this.options.law ?? EMPTY_ACTORS);
        const result = source.damage(hit.actor, damage);
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
      } else if (hit.kind === 'policeVehicle') {
        impact = this.vehicleSurface(hit, endY);
        hitPoliceVehicle = true;
        this.options.law?.damageVehicle(hit.vehicleId, base);
      } else if (hit.kind === 'vehicle') {
        impact = this.vehicleSurface(hit, endY);
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
      );
      this.options.onImpact?.(impact, endX, endY, endZ);
    }

    // -- consequences -------------------------------------------------------
    // Heat is applied once per trigger pull and once per victim, not per
    // pellet: eight shotgun pellets in one officer is one offence.
    const consequences = this.options.player;
    if (seen) consequences.addHeat(HEAT.gunshot);
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
    this.recoilPitch = clamp(this.recoilPitch + kick, 0, 0.16);
    this.recoilYaw = clamp(this.recoilYaw + (this.rng.next() - 0.5) * kick * 0.9, -0.06, 0.06);
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
    ox: number,
    oy: number,
    oz: number,
    maxT: number,
    spreadRad: number,
  ): void {
    this.candidateCount = 0;
    this.vehicleCandidates.length = 0;
    const ax = this.aim.x;
    const ay = this.aim.y;
    const az = this.aim.z;
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
      const slot = this.candidates[this.candidateCount] ?? {
        id: 0, x: 0, y: 0, z: 0, radius: 0, height: 0, police: false,
      };
      slot.id = id;
      slot.x = x;
      slot.y = y;
      slot.z = z;
      slot.radius = radius;
      slot.height = height;
      slot.police = police;
      this.candidates[this.candidateCount] = slot;
      this.candidateCount += 1;
    };

    const visitActor = (police: boolean) => (target: ActorTarget): void => {
      consider(target.id, target.x, target.y, target.z, target.radius, target.height, police);
    };
    this.civilians.forEachActor(ox, oz, maxT, visitActor(false));
    this.options.law?.forEachActor(ox, oz, maxT, visitActor(true));

    this.options.vehicles?.forEachNear(ox, oz, maxT, (view) => {
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
      this.vehicleCandidates.push(view);
    });
  }

  /** Nearest thing along one pellet's path. Writes and returns `this.hit`. */
  private castOne(ox: number, oy: number, oz: number, dir: Direction, maxT: number): Hit {
    const hit = this.hit;
    hit.t = maxT;
    hit.kind = 'none';
    hit.actor = -1;
    hit.vehicleId = -1;
    hit.box = null;
    hit.nx = -dir.x;
    hit.ny = -dir.y;
    hit.nz = -dir.z;

    for (let i = 0; i < this.candidateCount; i += 1) {
      const c = this.candidates[i];
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

    for (const view of this.vehicleCandidates) {
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
      hit.nx = -dir.x;
      hit.ny = -dir.y;
      hit.nz = -dir.z;
      hit.box = null;
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
   * Sends a rocket downrange.
   *
   * The aim is taken from the camera rather than from the muzzle so the rocket
   * goes where the crosshair is, not where a barrel held at the shoulder
   * happens to point - those differ by about two degrees, which is a metre and
   * a half at thirty metres and reads as the weapon being inaccurate.
   */
  private fireProjectile(speed: number, mx: number, my: number, mz: number): void {
    spreadDirection(
      this.aim.x, this.aim.y, this.aim.z,
      WEAPONS.launcher.spreadRad, this.rng, this.direction,
    );
    this.projectiles.launch(mx, my, mz, this.direction.x, this.direction.y, this.direction.z, speed);
  }

  /**
   * Nearest obstruction along a rocket's next step.
   *
   * Reuses the same candidate gathering and the same cast the hitscan weapons
   * do, so a rocket collides with exactly the things a bullet collides with
   * and there is no second, subtly different world model to keep in step.
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
    this.aim.set(dx, dy, dz);
    this.gatherCandidates(ox, oy, oz, maxT, 0);
    this.direction.x = dx;
    this.direction.y = dy;
    this.direction.z = dz;
    const hit = this.castOne(ox, oy, oz, this.direction, maxT);
    return hit.kind === 'none' ? -1 : hit.t;
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
  detonate(x: number, y: number, z: number): void {
    const spec = WEAPONS.launcher;
    const radius = spec.blastRadius ?? 8;
    const peak = spec.blastDamage ?? 150;
    const player = this.options.player;

    this.fx.explosion(x, y, z, radius, () => this.rng.next());

    let civiliansHurt = 0;
    let civiliansKilled = 0;
    let officersHurt = 0;
    let officersKilled = 0;
    let hitPolice = false;

    const strike = (
      source: ActorSource,
      police: boolean,
    ): void => {
      source.forEachActor(x, z, radius, (target) => {
        // Measured to the middle of the body, not to the feet: somebody
        // standing at the lip of the radius is otherwise untouched by a blast
        // that visibly engulfs them.
        const dx = target.x - x;
        const dy = target.y + target.height * 0.5 - y;
        const dz = target.z - z;
        const distance = Math.hypot(dx, dy, dz);
        if (distance > radius) return;
        const damage = peak * blastFalloff(distance / radius);
        if (damage <= 0) return;
        const result = source.damage(target.id, damage);
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
    this.options.vehicles?.forEachNear(x, z, radius, (view) => {
      if (!view.police) return;
      const distance = Math.hypot(view.x - x, view.y - y, view.z - z);
      if (distance > radius) return;
      hitPoliceVehicle = true;
      this.options.law?.damageVehicle(view.id, peak * blastFalloff(distance / radius));
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
    // just fired at is a decision with a consequence, not a free shot.
    const camera = this.options.camera;
    const self = Math.hypot(camera.position.x - x, camera.position.y - 1 - y, camera.position.z - z);
    if (self < radius && player.alive) player.hurt(peak * 0.55 * blastFalloff(self / radius));

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
    camera.getWorldDirection(this.aim);
    const world = this.options.world.cast(
      camera.position.x,
      camera.position.y,
      camera.position.z,
      this.aim.x,
      this.aim.y,
      this.aim.z,
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
