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
import { HEAT, WEAPONS, type PlayerState, type WeaponId } from '../player/PlayerState';
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
import { rayCylinder, rayGround, rayOrientedBox, WorldRayIndex } from './rays';
import { EMPTY_ACTORS, type ActorSource, type ActorTarget, type LawTargets } from './targets';
import { WeaponViewmodel, type ViewmodelSpec } from './WeaponViewmodel';

/** How close somebody has to be to notice a gunshot. */
export const WITNESS_RADIUS = 34;

/** Weapons that keep firing while the trigger is held. */
const AUTOMATIC: ReadonlySet<WeaponId> = new Set<WeaponId>(['smg', 'rifle']);

/** Number keys, in the order the shop lists weapons. */
const SLOT_ORDER: readonly WeaponId[] = ['pistol', 'smg', 'shotgun', 'rifle'];

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
  /** Fires for every shot that lands, so audio can play something. */
  readonly onShot?: ((weapon: WeaponId) => void) | undefined;
  /**
   * Generated weapon models to hold in view. Omit for no view model at all -
   * the game is playable and every shot registers identically without one.
   * `defaultViewmodels(import.meta.env.BASE_URL)` is the shipped set.
   */
  readonly viewmodels?: Readonly<Record<WeaponId, ViewmodelSpec>> | undefined;
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

  private trigger = false;
  /** Cleared on mouse-up so a semi-automatic needs a fresh pull. */
  private triggerLatched = false;
  private recoilPitch = 0;
  private recoilYaw = 0;
  private paused = false;
  private disposed = false;

  private readonly direction: Direction = { x: 0, y: 0, z: 0 };
  private readonly hit: Hit = {
    t: 0, kind: 'none', actor: -1, vehicleId: -1, footY: 0, height: 0,
    nx: 0, ny: 1, nz: 0, box: null,
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
    if (this.viewmodel) this.group.add(this.viewmodel.group);

    // Guarded so the whole hit-registration path can be constructed and driven
    // in a unit test with no DOM at all. `fireOnce` and `setTrigger` are the
    // API the game's own input handlers below are a thin wrapper over.
    options.domElement.addEventListener?.('mousedown', this.onMouseDown);
    const view = typeof window === 'undefined' ? null : window;
    view?.addEventListener('mouseup', this.onMouseUp);
    view?.addEventListener('keydown', this.onKeyDown);
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
    return this.armoury.startReload(this.options.player.equipped);
  }

  equipSlot(slot: number): boolean {
    const id = SLOT_ORDER[slot];
    if (!id) return false;
    if (!this.options.player.owns(id)) return false;
    return this.options.player.equip(id);
  }

  /**
   * The effect pools, so the police can draw their own muzzle flashes and
   * tracers through the same two instanced meshes instead of adding more.
   */
  get effects(): CombatFx {
    return this.fx;
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

  /** Clears cooldowns, reloads and live effects. Called on respawn. */
  reset(): void {
    this.armoury.reset();
    this.fx.clear();
    this.trigger = false;
    this.triggerLatched = false;
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
    this.viewmodel?.update(dt, camera, this.options.player.equipped, {
      reloading: this.armoury.reloading,
      hidden: ctx.driving || !this.options.player.alive,
      speed: ctx.playerSpeed,
    });
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
    view?.removeEventListener('blur', this.onBlur);
    this.viewmodel?.dispose();
    this.fx.dispose();
  }

  // -- firing ---------------------------------------------------------------

  private pullTrigger(): boolean {
    const player = this.options.player;
    const id = player.equipped;
    if (!id || !player.alive) return false;
    const outcome = this.armoury.fire(id);
    if (!outcome.fired) {
      if (outcome.reason === 'magazine') this.armoury.startReload(id);
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
        impact = 'metal';
        hitPoliceVehicle = true;
        this.options.law?.damageVehicle(hit.vehicleId, base);
      } else if (hit.kind === 'vehicle') {
        impact = 'metal';
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
    const state = ctx.driving
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
    if (event.code === 'Digit0') {
      this.options.player.equip(null);
      return;
    }
    const slot = SLOT_ORDER.findIndex((_, index) => event.code === `Digit${index + 1}`);
    if (slot >= 0) this.equipSlot(slot);
  };
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
