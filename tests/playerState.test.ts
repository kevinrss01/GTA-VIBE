/**
 * The economy, weapons and wanted rules.
 *
 * These are the rules several systems depend on agreeing about, so they are
 * asserted here rather than left to whichever module happens to read them.
 */

import { describe, expect, it } from 'vitest';

import {
  ALL_WEAPONS,
  HEAT,
  MAX_HEALTH,
  MAX_WANTED,
  PlayerState,
  STARTING_MONEY,
  WEAPONS,
} from '../src/player/PlayerState';

describe('player economy', () => {
  it('starts with money, full health, no heat and no gun', () => {
    const p = new PlayerState();
    expect(p.money).toBe(STARTING_MONEY);
    expect(p.health).toBe(MAX_HEALTH);
    expect(p.wanted).toBe(0);
    expect(p.equipped).toBeNull();
    for (const id of ALL_WEAPONS) expect(p.owns(id)).toBe(false);
  });

  /*
   * The player starts able to buy the whole armoury and still have money for
   * ammunition. This used to be the opposite - enough for a sidearm and
   * shells, with the carbine and the launcher out of reach - and the change
   * was asked for, so it is pinned here rather than left to drift back.
   */
  it('can afford the whole shop, and ammunition afterwards', () => {
    const guns = ALL_WEAPONS.reduce((sum, id) => sum + WEAPONS[id].price, 0);
    const refill = ALL_WEAPONS.reduce((sum, id) => sum + WEAPONS[id].ammoPrice, 0);
    expect(STARTING_MONEY).toBeGreaterThan(guns + refill);

    // Not merely on paper: buy every one of them through the real economy.
    const p = new PlayerState();
    for (const id of ALL_WEAPONS) expect(p.buyWeapon(id), id).toBe(true);
    for (const id of ALL_WEAPONS) expect(p.buyAmmo(id), id).toBe(true);
    expect(p.money).toBeGreaterThan(0);
  });

  it('buys a weapon once, with a magazine, and equips the first one', () => {
    const p = new PlayerState();
    expect(p.buyWeapon('pistol')).toBe(true);
    expect(p.money).toBe(STARTING_MONEY - WEAPONS.pistol.price);
    expect(p.ammo('pistol')).toBe(WEAPONS.pistol.magazine);
    expect(p.equipped).toBe('pistol');
    // Buying it again must not charge again.
    const before = p.money;
    expect(p.buyWeapon('pistol')).toBe(false);
    expect(p.money).toBe(before);
  });

  it('refuses a purchase it cannot afford and changes nothing', () => {
    const p = new PlayerState();
    while (p.canAfford(WEAPONS.rifle.price)) p.spend(WEAPONS.rifle.price);
    const money = p.money;
    expect(p.buyWeapon('rifle')).toBe(false);
    expect(p.money).toBe(money);
    expect(p.owns('rifle')).toBe(false);
  });

  it('sells ammunition only for weapons the player owns', () => {
    const p = new PlayerState();
    expect(p.buyAmmo('smg')).toBe(false);
    p.buyWeapon('smg');
    const before = p.ammo('smg');
    expect(p.buyAmmo('smg')).toBe(true);
    expect(p.ammo('smg')).toBe(before + WEAPONS.smg.magazine);
  });

  it('spends rounds and stops at empty', () => {
    const p = new PlayerState();
    p.buyWeapon('pistol');
    let fired = 0;
    while (p.consumeRound('pistol')) fired += 1;
    expect(fired).toBe(WEAPONS.pistol.magazine);
    expect(p.ammo('pistol')).toBe(0);
    expect(p.consumeRound('pistol')).toBe(false);
  });

  it('cannot equip a weapon it does not own', () => {
    const p = new PlayerState();
    expect(p.equip('rifle')).toBe(false);
    expect(p.equipped).toBeNull();
  });
});

describe('health and death', () => {
  it('dies exactly once at zero health', () => {
    const p = new PlayerState();
    let deaths = 0;
    p.onDeath = () => { deaths += 1; };
    expect(p.hurt(MAX_HEALTH - 1)).toBe(false);
    expect(p.alive).toBe(true);
    expect(p.hurt(50)).toBe(true);
    expect(p.health).toBe(0);
    expect(p.alive).toBe(false);
    // Further damage to a dead player must not fire death again.
    expect(p.hurt(20)).toBe(false);
    expect(deaths).toBe(1);
  });

  it('restores health and clears heat on respawn, keeping money and guns', () => {
    const p = new PlayerState();
    p.buyWeapon('pistol');
    p.addHeat(HEAT.policeKilled * 3);
    p.hurt(MAX_HEALTH);
    const money = p.money;
    p.respawn();
    expect(p.health).toBe(MAX_HEALTH);
    expect(p.alive).toBe(true);
    expect(p.wanted).toBe(0);
    expect(p.money).toBe(money);
    expect(p.owns('pistol')).toBe(true);
  });
});

describe('wanted level', () => {
  it('rises with offences and never exceeds the maximum', () => {
    const p = new PlayerState();
    expect(p.wanted).toBe(0);
    p.addHeat(HEAT.gunshot);
    expect(p.wanted).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 40; i += 1) p.addHeat(HEAT.policeKilled);
    expect(p.wanted).toBe(MAX_WANTED);
  });

  it('never falls while the police still have eyes on the player', () => {
    const p = new PlayerState();
    p.addHeat(HEAT.civilianKilled * 2);
    const stars = p.wanted;
    for (let i = 0; i < 600; i += 1) p.coolOff(1 / 60, true);
    expect(p.wanted).toBe(stars);
  });

  it('cools off once the player is clear, but not instantly', () => {
    const p = new PlayerState();
    p.addHeat(HEAT.gunshot * 3);
    const stars = p.wanted;
    // A couple of seconds of hiding must not end a manhunt.
    for (let i = 0; i < 120; i += 1) p.coolOff(1 / 60, false);
    expect(p.wanted).toBe(stars);
    // Sustained escape does.
    for (let i = 0; i < 60 * 60; i += 1) p.coolOff(1 / 60, false);
    expect(p.wanted).toBe(0);
    expect(p.heat).toBe(0);
  });

  it('reports a change to listeners when money or stars move', () => {
    const p = new PlayerState();
    let changes = 0;
    p.onChange = () => { changes += 1; };
    p.earn(100);
    p.addHeat(HEAT.gunshot);
    expect(changes).toBeGreaterThanOrEqual(2);
  });
});
