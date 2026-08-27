/**
 * The weapon in the player's hands, and the weapon on the shop counter.
 *
 * None of this needs a renderer. The stat bars are arithmetic over `WEAPONS`;
 * the viewmodel table is data whose internal consistency - the muzzle is past
 * the middle of the weapon, the trigger hand is behind it, the support hand is
 * in front of the trigger hand - is exactly the kind of thing that silently
 * rots when somebody nudges one number; and the holster is a state machine on
 * the real `CombatSystem`, driven through the same `fireOnce` a mouse would.
 */

import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';

import { CombatSystem } from '../src/combat/CombatSystem';
import { WorldRayIndex } from '../src/combat/rays';
import { defaultHands, defaultViewmodels } from '../src/combat/WeaponViewmodel';
import { ALL_WEAPONS, PlayerState, WEAPONS, type WeaponId } from '../src/player/PlayerState';
import {
  accuracyScore,
  damagePerShot,
  weaponBars,
  WEAPON_BAR_KEYS,
} from '../src/shop/weaponStats';

const BASE = '/';

function inertElement(): HTMLElement {
  return {
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  } as unknown as HTMLElement;
}

function armed(id: WeaponId): PlayerState {
  const player = new PlayerState();
  player.earn(500_000);
  player.buyWeapon(id);
  player.equip(id);
  return player;
}

function combatFor(player: PlayerState): CombatSystem {
  return new CombatSystem({
    player,
    camera: new PerspectiveCamera(62, 16 / 9, 0.1, 500),
    domElement: inertElement(),
    world: new WorldRayIndex([]),
    heightAt: () => 0,
    seed: 'weapons-test',
  });
}

// -- the counter's stat bars --------------------------------------------------

describe('the shop draws stats as bars', () => {
  it('gives every weapon the same five rows in the same order', () => {
    for (const id of ALL_WEAPONS) {
      expect(weaponBars(id).map((bar) => bar.key)).toEqual([...WEAPON_BAR_KEYS]);
    }
  });

  it('keeps every fraction inside the track', () => {
    for (const id of ALL_WEAPONS) {
      for (const bar of weaponBars(id)) {
        expect(bar.fraction).toBeGreaterThan(0);
        expect(bar.fraction).toBeLessThanOrEqual(1);
      }
    }
  });

  it('fills exactly one bar per row, and it is the catalogue best', () => {
    for (const key of WEAPON_BAR_KEYS) {
      const full = ALL_WEAPONS.filter(
        (id) => weaponBars(id).find((bar) => bar.key === key)?.fraction === 1,
      );
      expect(full).toHaveLength(1);
    }
  });

  /*
   * The shape of the armoury, asserted as the shape of the panel: each weapon
   * has to be the best at exactly one thing, or the display case is showing
   * the player four rows of "this one is worse".
   */
  it('lets each of the four weapons win exactly one row', () => {
    const winners = new Map<WeaponId, number>();
    for (const key of WEAPON_BAR_KEYS) {
      for (const id of ALL_WEAPONS) {
        if (weaponBars(id).find((bar) => bar.key === key)?.fraction === 1) {
          winners.set(id, (winners.get(id) ?? 0) + 1);
        }
      }
    }
    expect([...winners.keys()].sort()).toEqual([...ALL_WEAPONS].sort());
  });

  it('counts a shotgun shell as all of its pellets', () => {
    expect(damagePerShot(WEAPONS.shotgun)).toBe(WEAPONS.shotgun.damage * WEAPONS.shotgun.pellets);
    expect(damagePerShot(WEAPONS.rifle)).toBe(WEAPONS.rifle.damage);
    // Otherwise the carbine would out-damage a shotgun shell on the panel.
    expect(damagePerShot(WEAPONS.shotgun)).toBeGreaterThan(damagePerShot(WEAPONS.rifle));
  });

  it('turns spread the right way round, so more accuracy is a longer bar', () => {
    expect(accuracyScore(WEAPONS.pistol)).toBeGreaterThan(accuracyScore(WEAPONS.shotgun));
    const pistol = weaponBars('pistol').find((bar) => bar.key === 'accuracy');
    const shotgun = weaponBars('shotgun').find((bar) => bar.key === 'accuracy');
    expect(pistol?.fraction).toBeGreaterThan(shotgun?.fraction ?? 1);
  });

  it('prints the real number beside every bar', () => {
    const bars = weaponBars('shotgun');
    expect(bars.find((bar) => bar.key === 'damage')?.value).toBe('13 × 8');
    expect(bars.find((bar) => bar.key === 'range')?.value).toBe('22 m');
    expect(bars.find((bar) => bar.key === 'fireRate')?.value).toBe('75 rpm');
    expect(bars.find((bar) => bar.key === 'magazine')?.value).toBe('6');
    expect(weaponBars('pistol').find((bar) => bar.key === 'damage')?.value).toBe('26');
  });
});

// -- the viewmodel table ------------------------------------------------------

describe('the held weapon is laid out consistently', () => {
  const set = defaultViewmodels(BASE);

  it('covers every weapon and ships a pair of hands with them', () => {
    expect(Object.keys(set.weapons).sort()).toEqual([...ALL_WEAPONS].sort());
    expect(set.hands).not.toBeNull();
    expect(set.hands?.url).toBe(`${BASE}models/weapons/fist.glb`);
    expect(set.hands?.length).toBeGreaterThan(0.1);
    expect(set.hands?.length).toBeLessThan(0.25);
  });

  it('builds every url from the base, so a sub-path deployment still loads', () => {
    const scoped = defaultViewmodels('/meridian/');
    for (const id of ALL_WEAPONS) {
      expect(scoped.weapons[id].url.startsWith('/meridian/models/')).toBe(true);
    }
    expect(scoped.hands?.url.startsWith('/meridian/models/')).toBe(true);
  });

  it('puts the muzzle past the far end of the weapon and never behind the eye', () => {
    for (const id of ALL_WEAPONS) {
      const spec = set.weapons[id];
      const centre = spec.offset[2];
      const muzzle = spec.muzzle[2];
      // The model is centred on `offset`, so its nose is half a length past it.
      expect(muzzle).toBeGreaterThanOrEqual(centre + spec.length / 2 - 0.03);
      expect(muzzle).toBeLessThanOrEqual(centre + spec.length / 2 + 0.03);
    }
  });

  /*
   * An arm that reaches further than a shoulder can is what gives the trick
   * away, and it is also what puts a barrel through a wall. Nothing may sit
   * more than a metre in front of the eye.
   */
  it('keeps the whole assembly within reach of a shoulder', () => {
    for (const id of ALL_WEAPONS) {
      const spec = set.weapons[id];
      expect(spec.muzzle[2]).toBeLessThan(1);
      expect(spec.offset[2]).toBeGreaterThan(0.2);
      expect(spec.grip[2]).toBeGreaterThan(0.2);
    }
  });

  it('closes the trigger hand behind the weapon and the support hand in front of it', () => {
    for (const id of ALL_WEAPONS) {
      const spec = set.weapons[id];
      // The trigger hand is behind the model's centre on every weapon here.
      expect(spec.grip[2]).toBeLessThan(spec.offset[2]);
      // The support hand is always further out than the trigger hand, and
      // inboard of it: two hands cannot occupy the same place.
      expect(spec.support[2]).toBeGreaterThanOrEqual(spec.grip[2] - 0.02);
      expect(spec.support[0]).toBeLessThan(spec.grip[0]);
      // Both hands hang below the barrel, never above it.
      expect(spec.grip[1]).toBeLessThan(spec.offset[1]);
      expect(spec.support[1]).toBeLessThan(spec.offset[1]);
    }
  });

  it('spreads the hands apart on a long gun and keeps them together on a pistol', () => {
    const pistol = set.weapons.pistol;
    const rifle = set.weapons.rifle;
    const gap = (spec: typeof pistol): number => spec.support[2] - spec.grip[2];
    expect(gap(pistol)).toBeLessThan(0.1);
    expect(gap(rifle)).toBeGreaterThan(0.2);
  });

  it('cants the hands inboard rather than leaving them square', () => {
    for (const id of ALL_WEAPONS) {
      expect(set.weapons[id].handRoll).toBeGreaterThan(0);
      expect(set.weapons[id].handRoll).toBeLessThan(0.6);
    }
  });

  it('exposes the hands on their own for a caller that wants no weapons', () => {
    const hands = defaultHands(BASE);
    expect(hands.pivot).toHaveLength(3);
    expect(Number.isFinite(hands.yaw)).toBe(true);
    expect(Number.isFinite(hands.pitch)).toBe(true);
  });
});

// -- the holster --------------------------------------------------------------

describe('holstering', () => {
  it('starts with the weapon out', () => {
    const combat = combatFor(armed('pistol'));
    expect(combat.holstered).toBe(false);
    combat.dispose();
  });

  it('refuses to fire while the weapon is away, and spends no ammunition', () => {
    const player = armed('pistol');
    const combat = combatFor(player);
    const loaded = player.ammo('pistol');

    expect(combat.toggleHolster()).toBe(true);
    expect(combat.fireOnce()).toBe(false);
    expect(combat.stats.shotsFired).toBe(0);
    expect(player.ammo('pistol')).toBe(loaded);

    expect(combat.toggleHolster()).toBe(false);
    expect(combat.fireOnce()).toBe(true);
    expect(combat.stats.shotsFired).toBe(1);
    combat.dispose();
  });

  it('drops a held trigger, so the weapon does not fire the moment it comes back', () => {
    const player = armed('smg');
    const combat = combatFor(player);
    combat.setTrigger(true);
    combat.setHolstered(true);
    combat.update(1 / 60, { driving: false, playerX: 0, playerY: 0, playerZ: 0, playerSpeed: 0 });
    expect(combat.stats.shotsFired).toBe(0);

    combat.setHolstered(false);
    combat.update(1 / 60, { driving: false, playerX: 0, playerY: 0, playerZ: 0, playerSpeed: 0 });
    expect(combat.stats.shotsFired).toBe(0);
    combat.dispose();
  });

  it('takes the weapon back out when the player reaches for one', () => {
    const player = armed('pistol');
    player.buyWeapon('smg');
    const combat = combatFor(player);
    combat.setHolstered(true);
    expect(combat.equipSlot(1)).toBe(true);
    expect(player.equipped).toBe('smg');
    expect(combat.holstered).toBe(false);
    combat.dispose();
  });

  it('comes back out on respawn', () => {
    const combat = combatFor(armed('rifle'));
    combat.setHolstered(true);
    combat.reset();
    expect(combat.holstered).toBe(false);
    combat.dispose();
  });

  it('tells the HUD the weapon is stowed, by name', () => {
    const player = armed('shotgun');
    const seen: { name: string | null; state: string }[] = [];
    const combat = new CombatSystem({
      player,
      camera: new PerspectiveCamera(62, 16 / 9, 0.1, 500),
      domElement: inertElement(),
      world: new WorldRayIndex([]),
      heightAt: () => 0,
      hud: {
        setWeapon: (name, _magazine, _reserve, state): void => {
          seen.push({ name, state });
        },
      },
      seed: 'weapons-test',
    });
    const ctx = { driving: false, playerX: 0, playerY: 0, playerZ: 0, playerSpeed: 0 };

    combat.update(1 / 60, ctx);
    expect(seen.at(-1)).toEqual({ name: WEAPONS.shotgun.name, state: 'ready' });

    combat.setHolstered(true);
    combat.update(1 / 60, ctx);
    // The name stays: the player still owns and carries it, it is just away.
    expect(seen.at(-1)).toEqual({ name: WEAPONS.shotgun.name, state: 'stowed' });
    combat.dispose();
  });
});
