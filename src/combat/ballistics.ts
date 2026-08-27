/**
 * What a trigger pull is allowed to do, expressed as arithmetic.
 *
 * Everything here is a pure function or a small state machine over the weapon
 * specs in `PlayerState`. There is no Three.js, no DOM and no clock of its own,
 * so rate of fire, magazine limits, reload timing, spread and damage falloff
 * can all be asserted in a unit test without a renderer - which is the only way
 * to know a shotgun really does fire eight pellets at seventy-five rounds a
 * minute rather than merely appearing to.
 *
 * AMMUNITION MODEL. `PlayerState.ammo(id)` is the authoritative count of rounds
 * the player owns, and `consumeRound` is the only thing that spends them. The
 * magazine is NOT a second pool: it is a gate over that one pool, counting how
 * many shots have been fired since the last reload. A weapon can therefore hold
 * at most `magazine` shots before it needs `reloadSeconds` of standing still,
 * and the shop and the HUD keep reading exactly the number they always did.
 * Modelling a separate "loaded" count would have made `ammo()` mean something
 * different to the shop than to the gun.
 */

import { clamp } from '../core/mathx';
import type { Rng } from '../core/rng';
import { WEAPONS, type WeaponId, type WeaponSpec } from '../player/PlayerState';

/**
 * Damage falloff, as multiples of the weapon's own effective range.
 *
 * A weapon does full damage out to its stated range and then decays to nothing
 * over another 60 per cent of it. Making the damage zero AT the stated range
 * would mean a "45 m pistol" that cannot kill at 44 m; making it constant
 * forever would make the carbine's 90 m meaningless. The plateau is the range
 * the spec advertises and the tail is the part that punishes optimism.
 */
export const FALLOFF_START = 1.0;
export const FALLOFF_END = 1.6;

/** Fraction of an actor's height counted as the head. */
export const HEAD_ZONE = 0.12;
/** Damage multiplier for a hit inside that zone. */
export const HEAD_MULTIPLIER = 2.2;

/** Health of anybody in the city who is not the player. */
export const ACTOR_HEALTH = 100;

/**
 * Damage one projectile does at a distance.
 *
 * `distance` is metres from the muzzle. Returns zero past the tail rather than
 * a negative number, so a caller can use the result directly.
 */
export function damageAtRange(spec: WeaponSpec, distance: number): number {
  const start = spec.rangeM * FALLOFF_START;
  if (distance <= start) return spec.damage;
  const end = spec.rangeM * FALLOFF_END;
  if (distance >= end) return 0;
  return spec.damage * (1 - (distance - start) / (end - start));
}

/**
 * Multiplier for where on a body the shot landed.
 *
 * `hitY` and `footY` are world heights; `height` is the actor's full height.
 */
export function zoneMultiplier(hitY: number, footY: number, height: number): number {
  if (height <= 0) return 1;
  const up = (hitY - footY) / height;
  return up >= 1 - HEAD_ZONE ? HEAD_MULTIPLIER : 1;
}

/** Seconds between shots for a weapon's cyclic rate. */
export function shotInterval(spec: WeaponSpec): number {
  return 60 / Math.max(1, spec.roundsPerMinute);
}

/** A unit vector, returned by value so callers can keep it. */
export interface Direction {
  x: number;
  y: number;
  z: number;
}

/**
 * Deviates an aim direction inside the weapon's cone.
 *
 * Uniform over the disc rather than over the radius - sampling the radius
 * directly piles half the pellets into the middle quarter of the pattern,
 * which reads as a rifle with a wide crosshair rather than as a shotgun.
 *
 * `out` is written in place so a burst does not allocate.
 */
export function spreadDirection(
  fx: number,
  fy: number,
  fz: number,
  spreadRad: number,
  rng: Rng,
  out: Direction,
): Direction {
  const length = Math.hypot(fx, fy, fz) || 1;
  const nx = fx / length;
  const ny = fy / length;
  const nz = fz / length;
  if (spreadRad <= 0) {
    out.x = nx;
    out.y = ny;
    out.z = nz;
    return out;
  }

  // Any vector not parallel to the aim gives a usable first basis axis. `a` is
  // the cross product of that helper with the aim; `b` completes the frame.
  const upHelper = Math.abs(ny) < 0.9;
  let ax = upHelper ? nz : 0;
  let ay = upHelper ? 0 : -nz;
  let az = upHelper ? -nx : ny;
  const alen = Math.hypot(ax, ay, az) || 1;
  ax /= alen;
  ay /= alen;
  az /= alen;
  const bx = ny * az - nz * ay;
  const by = nz * ax - nx * az;
  const bz = nx * ay - ny * ax;

  const angle = spreadRad * Math.sqrt(rng.next());
  const theta = rng.next() * Math.PI * 2;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  const ox = Math.cos(theta) * sin;
  const oy = Math.sin(theta) * sin;

  const dx = nx * cos + ax * ox + bx * oy;
  const dy = ny * cos + ay * ox + by * oy;
  const dz = nz * cos + az * ox + bz * oy;
  const dlen = Math.hypot(dx, dy, dz) || 1;
  out.x = dx / dlen;
  out.y = dy / dlen;
  out.z = dz / dlen;
  return out;
}

/** Why a trigger pull produced nothing. */
export type MisfireReason = 'cooldown' | 'reloading' | 'magazine' | 'noWeapon' | 'noAmmo';

export interface ShotOutcome {
  readonly fired: boolean;
  /** Pellets this trigger pull sent downrange. Zero when it did not fire. */
  readonly pellets: number;
  readonly reason: MisfireReason | null;
}

const MISS = (reason: MisfireReason): ShotOutcome => ({ fired: false, pellets: 0, reason });

/**
 * The minimum a firearm has to remember: how long until it can fire again, how
 * long until it is reloaded, and how much of the magazine has been used.
 *
 * One instance covers the whole armoury. Per-weapon magazine wear is kept per
 * id so switching to the shotgun and back does not silently reload the pistol,
 * while the cooldown and the reload timer belong to the hands and are shared.
 */
export interface AmmunitionSource {
  /** Rounds the player owns for this weapon. */
  ammo(id: WeaponId): number;
  /** Spends one. Returns false when there was nothing to spend. */
  consumeRound(id: WeaponId): boolean;
}

export class Armoury {
  private readonly used = new Map<WeaponId, number>();
  private cooldown = 0;
  private reloadLeft = 0;
  private reloadingId: WeaponId | null = null;

  constructor(private readonly ammoSource: AmmunitionSource) {}

  /** Seconds left before the weapon can fire again. */
  get cooldownLeft(): number {
    return this.cooldown;
  }

  get reloading(): boolean {
    return this.reloadLeft > 0;
  }

  get reloadRemaining(): number {
    return this.reloadLeft;
  }

  /** Rounds left in the magazine, never more than the player actually owns. */
  magazine(id: WeaponId): number {
    const spec = WEAPONS[id];
    const used = this.used.get(id) ?? 0;
    return Math.max(0, Math.min(spec.magazine - used, this.ammoSource.ammo(id)));
  }

  /** True when a trigger pull right now would send something downrange. */
  canFire(id: WeaponId | null): boolean {
    if (!id) return false;
    if (this.cooldown > 0 || this.reloadLeft > 0) return false;
    return this.magazine(id) > 0;
  }

  /**
   * Pulls the trigger. Spends exactly one round from the player's ammunition
   * and returns how many projectiles left the barrel, which is the weapon's
   * pellet count - a shotgun shell is one round and eight pellets.
   */
  fire(id: WeaponId | null): ShotOutcome {
    if (!id) return MISS('noWeapon');
    if (this.reloadLeft > 0) return MISS('reloading');
    if (this.cooldown > 0) return MISS('cooldown');
    if (this.ammoSource.ammo(id) <= 0) return MISS('noAmmo');
    if (this.magazine(id) <= 0) return MISS('magazine');
    if (!this.ammoSource.consumeRound(id)) return MISS('noAmmo');

    const spec = WEAPONS[id];
    this.used.set(id, (this.used.get(id) ?? 0) + 1);
    this.cooldown = shotInterval(spec);
    return { fired: true, pellets: Math.max(1, spec.pellets), reason: null };
  }

  /**
   * Starts a reload. Refused when the magazine is already full, when one is
   * already running, or when the player has nothing left to load.
   */
  startReload(id: WeaponId | null): boolean {
    if (!id || this.reloadLeft > 0) return false;
    const spec = WEAPONS[id];
    const used = this.used.get(id) ?? 0;
    if (used === 0) return false;
    if (this.ammoSource.ammo(id) <= 0) return false;
    this.reloadLeft = spec.reloadSeconds;
    this.reloadingId = id;
    return true;
  }

  /** Starts a reload only if the magazine has actually run dry. */
  autoReload(id: WeaponId | null): boolean {
    if (!id || this.magazine(id) > 0) return false;
    return this.startReload(id);
  }

  update(dt: number): void {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.reloadLeft > 0) {
      this.reloadLeft = Math.max(0, this.reloadLeft - dt);
      if (this.reloadLeft === 0 && this.reloadingId) {
        this.used.set(this.reloadingId, 0);
        this.reloadingId = null;
      }
    }
  }

  /** Cancels a reload and clears every cooldown. Used on respawn. */
  reset(): void {
    this.used.clear();
    this.cooldown = 0;
    this.reloadLeft = 0;
    this.reloadingId = null;
  }
}

/**
 * Vertical kick applied to the camera for one shot, in radians.
 *
 * Scaled by damage rather than by calibre because damage is the only measure
 * of a weapon's violence the spec carries, and clamped so the carbine does not
 * point the player at the sky.
 */
export function recoilKick(spec: WeaponSpec): number {
  return clamp(spec.damage * 0.00062 * Math.max(1, spec.pellets) ** 0.5, 0.004, 0.05);
}
