/**
 * Dying, being arrested, and going back to the start.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   const respawn = new RespawnDirector({
 *     player,
 *     spawn: plan.spawn,
 *     teleport: (x, z, heading) => controller.teleport(x, z, heading),
 *     setPaused: (paused) => controller.setPaused(paused),
 *     onBanner: (title, detail) => hud.setBanner(title, detail),
 *     onBust: () => { police.standDown(); combat.reset(); },
 *     // EVERY seat the player can be sitting in. See DISMOUNTING below.
 *     mounts: [
 *       { occupied: () => driving.driving, exit: () => driving.exit() },
 *       { occupied: () => flying.flying, exit: () => flying.exit(true) },
 *     ],
 *   });
 *
 *   respawn.update(dt);       // once per frame
 *   respawn.dispose();
 *
 * It takes callbacks rather than the controller and the driving layer
 * themselves, so the whole flow - including "if the player was in something,
 * get them out of it first" - is asserted in a unit test with no renderer.
 *
 * DISMOUNTING, AND WHY IT IS A LIST. This used to be one pair of callbacks,
 * `isDriving` and `exitVehicle`, wired to the driving layer. When the game grew
 * an aircraft nobody widened them, so a player killed in the air was respawned
 * WITHOUT being taken out of the aeroplane: the on-foot controller was
 * teleported to the spawn point while the flight layer still held the camera,
 * and every system that asks "is the player driving" - the view model, the
 * trigger, the weapon HUD - went on answering yes. The player's own report of
 * that was "I lost my gun when I died". A list makes adding the next kind of
 * seat a one-line change at the call site instead of a silent omission, and
 * `finish` leaves every one of them rather than the first.
 *
 * A DEAD PILOT'S DISMOUNT IS FORCED. `Flying.exit()` refuses in the air, which
 * is right for a living player pressing a key and wrong for a corpse; pass
 * `exit: () => flying.exit(true)`.
 *
 * IT OWNS `player.onDeath`. The constructor installs its own handler and
 * chains whatever was there before, so wiring this after something else that
 * listens for death does not silently replace it. Nothing else should assign
 * to `onDeath` after this is constructed.
 *
 * WHAT THE PLAYER KEEPS. `PlayerState.respawn()` restores health and clears the
 * heat while keeping money and every weapon. Losing an hour of shopping to one
 * bad decision is a punishment rather than a consequence. Nothing in this file
 * may touch what the player owns, what they have equipped, or their ammunition:
 * the death transition is a place, a banner and a clock, not an inventory.
 *
 * ============================================================================
 */

import type { PlayerState } from '../player/PlayerState';

export type BustReason = 'wasted' | 'busted';

export interface RespawnBanner {
  readonly title: string;
  readonly detail: string;
}

const BANNERS: Readonly<Record<BustReason, RespawnBanner>> = {
  wasted: { title: 'Wasted', detail: 'Meridian General Hospital · Harbourside' },
  busted: { title: 'Busted', detail: 'Released without charge · Harbourside' },
};

/** Seconds the outcome stays on screen before the player is put back. */
const DEFAULT_HOLD = 2.6;

/**
 * One thing the player can be sitting in: a car, an aeroplane, whatever comes
 * next. `occupied` says whether they are in this one right now; `exit` puts
 * them back on their feet beside it and must not refuse - see DISMOUNTING.
 */
export interface RespawnMount {
  readonly occupied: () => boolean;
  readonly exit: () => void;
}

export interface RespawnOptions {
  readonly player: PlayerState;
  readonly spawn: { readonly x: number; readonly z: number; readonly heading: number };
  /** Puts the player, on foot, at a point. `FirstPersonController.teleport`. */
  readonly teleport: (x: number, z: number, heading: number) => void;
  /**
   * Everything the player might be sitting in. All of them are checked and
   * all of the occupied ones are left, in order.
   */
  readonly mounts?: readonly RespawnMount[] | undefined;
  /**
   * The driving layer, as a shorthand for a single mount.
   *
   * Kept because it is what every existing caller and every existing test
   * passes. It is folded into `mounts` and behaves identically; prefer
   * `mounts` for anything new, because it is the form that cannot silently
   * miss the second kind of vehicle.
   */
  readonly isDriving?: (() => boolean) | undefined;
  readonly exitVehicle?: (() => void) | undefined;
  readonly setPaused?: ((paused: boolean) => void) | undefined;
  /** Shows or clears the outcome. `null` clears it. */
  readonly onBanner?: ((title: string | null, detail: string) => void) | undefined;
  /** Fired the instant the player is taken out, before the hold. */
  readonly onBust?: ((reason: BustReason) => void) | undefined;
  /** Fired once the player is standing at the spawn point again. */
  readonly onRespawn?: (() => void) | undefined;
  readonly holdSeconds?: number | undefined;
}

export class RespawnDirector {
  private readonly options: RespawnOptions;
  private readonly hold: number;
  private readonly previousOnDeath: (() => void) | null;
  /** Every seat, including the legacy `isDriving`/`exitVehicle` pair. */
  private readonly mounts: readonly RespawnMount[];

  private reason: BustReason | null = null;
  private timer = 0;
  private respawns = 0;
  private disposed = false;

  constructor(options: RespawnOptions) {
    this.options = options;
    this.hold = options.holdSeconds ?? DEFAULT_HOLD;
    this.previousOnDeath = options.player.onDeath;
    const mounts: RespawnMount[] = [];
    const occupied = options.isDriving;
    const exit = options.exitVehicle;
    if (occupied) mounts.push({ occupied, exit: exit ?? ((): void => undefined) });
    if (options.mounts) mounts.push(...options.mounts);
    this.mounts = mounts;
    options.player.onDeath = this.onDeath;
  }

  /** True from the moment the player goes down until they are back on foot. */
  get busy(): boolean {
    return this.reason !== null;
  }

  get outcome(): BustReason | null {
    return this.reason;
  }

  get count(): number {
    return this.respawns;
  }

  /**
   * Takes the player out of play. `'busted'` is an arrest, `'wasted'` is
   * having been killed; a second call while one is already running is ignored,
   * so being shot by three officers at once is one death.
   */
  bust(reason: BustReason): void {
    if (this.disposed || this.reason !== null) return;
    this.reason = reason;
    this.timer = this.hold;
    const banner = BANNERS[reason];
    this.options.onBanner?.(banner.title, banner.detail);
    this.options.setPaused?.(true);
    this.options.onBust?.(reason);
  }

  update(dt: number): void {
    if (this.disposed || this.reason === null) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.finish();
  }

  /** Completes the respawn immediately, skipping whatever hold is left. */
  finish(): void {
    if (this.reason === null) return;
    this.reason = null;
    this.timer = 0;

    // Out of the vehicle first, and out of EVERY vehicle: `exit` places the
    // player beside it and hands it back to whoever owns it, and doing this
    // after the teleport would strand them at the spawn point still nominally
    // driving - or flying - something a mile away. That state is not cosmetic:
    // the combat layer refuses the trigger and hides the weapon while it
    // believes the player is in a vehicle, so missing one seat here is
    // indistinguishable from having lost the gun.
    for (const mount of this.mounts) {
      if (mount.occupied()) mount.exit();
    }

    const spawn = this.options.spawn;
    this.options.player.respawn();
    this.options.teleport(spawn.x, spawn.z, spawn.heading);
    this.options.setPaused?.(false);
    this.options.onBanner?.(null, '');
    this.respawns += 1;
    this.options.onRespawn?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.options.player.onDeath === this.onDeath) {
      this.options.player.onDeath = this.previousOnDeath;
    }
  }

  private readonly onDeath = (): void => {
    this.previousOnDeath?.();
    this.bust('wasted');
  };
}
