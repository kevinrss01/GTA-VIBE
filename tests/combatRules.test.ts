/**
 * The rules the combat additions turn on, asserted without a renderer.
 *
 * Three things live here, and each one is a defect that was reported rather
 * than a property somebody thought would be nice to have:
 *
 *  - The launcher's economy. It is the one weapon whose ammunition is not sold
 *    by the magazine, because its magazine is a single rocket.
 *  - Health regeneration. The city has no pickups, so without it a bad thirty
 *    seconds follows the player for the rest of the session - but it must
 *    never tick DURING a firefight, or a firefight has no stakes.
 *  - The control hints. What they say has to match the machine the game is
 *    being played on, because a hint that names a key which does not work is
 *    worse than no hint.
 */

import { describe, expect, it } from 'vitest';

import {
  ALL_WEAPONS,
  MAX_HEALTH,
  PlayerState,
  WEAPONS,
  ammoBundleFor,
} from '../src/player/PlayerState';
import { controlHints, detectPlatform } from '../src/ui/platform';
import { weaponBars } from '../src/shop/weaponStats';

describe('the launcher', () => {
  it('is the only weapon in the shop with a blast', () => {
    const armed = ALL_WEAPONS.filter((id) => (WEAPONS[id].blastRadius ?? 0) > 0);
    expect(armed).toEqual(['launcher']);
  });

  it('is the only weapon whose round is an object rather than a ray', () => {
    const slow = ALL_WEAPONS.filter((id) => WEAPONS[id].muzzleSpeed !== undefined);
    expect(slow).toEqual(['launcher']);
    // Slow enough to watch and to lead a moving car with, which is the point.
    expect(WEAPONS.launcher.muzzleSpeed).toBeLessThan(80);
  });

  it('sells more than one rocket per trip to the counter', () => {
    expect(WEAPONS.launcher.magazine).toBe(1);
    expect(ammoBundleFor(WEAPONS.launcher)).toBeGreaterThan(1);

    const player = new PlayerState();
    player.earn(WEAPONS.launcher.price + WEAPONS.launcher.ammoPrice);
    expect(player.buyWeapon('launcher')).toBe(true);
    const afterBuy = player.ammo('launcher');
    expect(player.buyAmmo('launcher')).toBe(true);
    expect(player.ammo('launcher') - afterBuy).toBe(ammoBundleFor(WEAPONS.launcher));
  });

  it('leaves every other weapon selling exactly one magazine', () => {
    for (const id of ALL_WEAPONS) {
      if (id === 'launcher') continue;
      expect(ammoBundleFor(WEAPONS[id]), id).toBe(WEAPONS[id].magazine);
    }
  });

  it('is the most expensive thing in the shop, and affordable from the start', () => {
    const dearest = ALL_WEAPONS.reduce(
      (best, id) => (WEAPONS[id].price > WEAPONS[best].price ? id : best),
      ALL_WEAPONS[0] ?? 'pistol',
    );
    expect(dearest).toBe('launcher');
    const player = new PlayerState();
    expect(player.canAfford(WEAPONS.launcher.price)).toBe(true);
  });

  /*
   * The shop compares weapons as bars, and a bar is only honest if the row it
   * fills is a row the weapon really is best at. The launcher has to be judged
   * on its blast rather than on damage-per-shot and range, where it would look
   * like an odd rifle and take rows off the shotgun and the carbine.
   */
  it('wins the blast row and nothing else', () => {
    const full = (id: (typeof ALL_WEAPONS)[number]): string[] =>
      weaponBars(id)
        .filter((bar) => bar.fraction === 1)
        .map((bar) => bar.key);
    expect(full('launcher')).toEqual(['blast']);
    expect(full('shotgun')).toContain('damage');
    expect(full('rifle')).toContain('range');
    expect(full('pistol')).toContain('accuracy');
  });

  it('reads a dash rather than a zero for a firearm with no blast', () => {
    const row = weaponBars('pistol').find((bar) => bar.key === 'blast');
    expect(row?.value).toBe('—');
  });
});

describe('health regeneration', () => {
  it('does nothing at all until the player has been left alone', () => {
    const player = new PlayerState();
    player.hurt(40);
    expect(player.health).toBe(60);
    // Seven seconds of not being shot is not enough; the delay is eight.
    for (let i = 0; i < 7 * 60; i += 1) player.regenerate(1 / 60);
    expect(player.health).toBe(60);
  });

  it('comes back once nothing has landed for long enough', () => {
    const player = new PlayerState();
    player.hurt(40);
    for (let i = 0; i < 20 * 60; i += 1) player.regenerate(1 / 60);
    expect(player.health).toBe(MAX_HEALTH);
  });

  it('is restarted by every hit, so a firefight never heals anybody', () => {
    const player = new PlayerState();
    player.hurt(40);
    // An officer fires about once a second. Regeneration must never reach the
    // delay while that is happening.
    for (let volley = 0; volley < 12; volley += 1) {
      for (let i = 0; i < 60; i += 1) player.regenerate(1 / 60);
      player.hurt(0.0001);
    }
    expect(player.health).toBeLessThan(61);
  });

  it('cannot raise a dead player, and never overshoots', () => {
    const player = new PlayerState();
    player.hurt(MAX_HEALTH);
    expect(player.alive).toBe(false);
    for (let i = 0; i < 60 * 60; i += 1) player.regenerate(1 / 60);
    expect(player.health).toBe(0);

    player.respawn();
    for (let i = 0; i < 60 * 60; i += 1) player.regenerate(1 / 60);
    expect(player.health).toBe(MAX_HEALTH);
  });
});

describe('damage reporting', () => {
  it('carries where the shot came from, so the HUD can point at it', () => {
    const player = new PlayerState();
    const seen: (number | undefined)[][] = [];
    player.onDamage = (amount, x, z) => seen.push([amount, x, z]);
    player.hurt(12, 40, -7);
    player.hurt(9);
    expect(seen).toEqual([
      [12, 40, -7],
      [9, undefined, undefined],
    ]);
  });

  it('reports nothing for a hit that lands on somebody already dead', () => {
    const player = new PlayerState();
    player.hurt(MAX_HEALTH);
    let after = 0;
    player.onDamage = () => (after += 1);
    player.hurt(20);
    expect(after).toBe(0);
  });
});

describe('control hints', () => {
  it('names the backquote first on a Mac, where F3 is Mission Control', () => {
    const mac = controlHints('mac').find((hint) => hint.action === 'Performance stats');
    expect(mac?.keys).toContain('`');
    expect(mac?.keys).toContain('fn');
  });

  it('does not tell a Windows player to hold fn', () => {
    const win = controlHints('windows').find((hint) => hint.action === 'Performance stats');
    expect(win?.keys).not.toContain('fn');
  });

  it('offers the scroll wheel everywhere, for layouts where the row is shifted', () => {
    for (const platform of ['mac', 'windows', 'linux', 'other'] as const) {
      const weapons = controlHints(platform).find((h) => h.action === 'Select a weapon');
      expect(weapons?.keys, platform).toContain('scroll');
    }
  });

  it('covers every weapon slot the armoury actually has', () => {
    const weapons = controlHints('linux').find((h) => h.action === 'Select a weapon');
    expect(weapons?.keys).toContain(`1 - ${ALL_WEAPONS.length}`);
  });

  it('reads the platform out of whatever the browser exposes', () => {
    expect(detectPlatform({ userAgentData: { platform: 'macOS' } })).toBe('mac');
    expect(detectPlatform({ platform: 'Win32' })).toBe('windows');
    expect(detectPlatform({ userAgent: 'X11; Linux x86_64' })).toBe('linux');
    // Safari has never shipped `userAgentData`; the fallbacks are the point.
    expect(detectPlatform({ userAgent: 'Macintosh; Intel Mac OS X' })).toBe('mac');
    expect(detectPlatform({})).toBe('other');
  });
});
