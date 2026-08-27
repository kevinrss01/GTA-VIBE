/**
 * Shooting: the arithmetic, the geometry, and the consequences.
 *
 * None of this needs a renderer. The ballistics and the ray tests are pure
 * functions; the hit registration runs the real `CombatSystem` against a
 * handful of stub bodies, a stub fleet and a real `PlayerState`, so what is
 * asserted here is the same code the game runs, not a description of it.
 */

import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';

import {
  Armoury,
  damageAtRange,
  FALLOFF_END,
  HEAD_MULTIPLIER,
  recoilKick,
  spreadDirection,
  zoneMultiplier,
  shotInterval,
} from '../src/combat/ballistics';
import { CombatSystem, type CombatVehicleView } from '../src/combat/CombatSystem';
import { RespawnDirector } from '../src/combat/Respawn';
import {
  hasLineOfSight,
  rayBox,
  rayCylinder,
  rayGround,
  rayOrientedBox,
  WorldRayIndex,
} from '../src/combat/rays';
import type { ActorSource, ActorTarget, DamageResult } from '../src/combat/targets';
import { createRng } from '../src/core/rng';
import {
  HEAT,
  MAX_HEALTH,
  PlayerState,
  WEAPONS,
  type WeaponId,
} from '../src/player/PlayerState';
import type { ColliderBox } from '../src/world/build/types';

// -- test doubles -------------------------------------------------------------

/**
 * The smallest DOM the combat system's constructor needs.
 *
 * Nothing is installed on `globalThis`: `CombatSystem` binds its window and
 * document listeners only when those globals exist, so the whole hit
 * registration path runs headless through `fireOnce` and `setTrigger`.
 */
function inertElement(): HTMLElement {
  return {
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  } as unknown as HTMLElement;
}

interface StubBody {
  id: number;
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
  health: number;
}

class StubCrowd implements ActorSource {
  readonly bodies: StubBody[] = [];
  killed = 0;
  hurt = 0;

  add(x: number, y: number, z: number, height = 1.75, radius = 0.32): StubBody {
    const body: StubBody = { id: this.bodies.length, x, y, z, radius, height, health: 100 };
    this.bodies.push(body);
    return body;
  }

  refresh(): void {
    /* stub bodies do not move */
  }

  hasWitnessWithin(x: number, z: number, radius: number): boolean {
    return this.bodies.some(
      (b) => b.health > 0 && Math.hypot(b.x - x, b.z - z) <= radius,
    );
  }

  forEachActor(x: number, z: number, radius: number, visit: (t: ActorTarget) => void): void {
    for (const body of this.bodies) {
      if (body.health <= 0) continue;
      if (Math.hypot(body.x - x, body.z - z) > radius) continue;
      visit({ ...body, faction: 'civilian' });
    }
  }

  damage(id: number, amount: number): DamageResult {
    const body = this.bodies[id];
    if (!body || body.health <= 0) return 'none';
    body.health -= amount;
    if (body.health > 0) {
      this.hurt += 1;
      return 'hurt';
    }
    this.killed += 1;
    return 'killed';
  }
}

class StubFleet {
  readonly views: CombatVehicleView[] = [];

  add(view: CombatVehicleView): void {
    this.views.push(view);
  }

  forEachNear(x: number, z: number, radius: number, visit: (v: CombatVehicleView) => void): void {
    for (const view of this.views) {
      if (Math.hypot(view.x - x, view.z - z) <= radius) visit(view);
    }
  }
}

/** A camera at eye height on flat ground, looking due east (+X). */
function eastwardCamera(x = 0, y = 1.68, z = 0, pitch = 0): PerspectiveCamera {
  const camera = new PerspectiveCamera(70, 1.6, 0.1, 1000);
  camera.position.set(x, y, z);
  // Forward is (-sin yaw, 0, -cos yaw); -PI/2 faces +X.
  camera.rotation.set(pitch, -Math.PI / 2, 0, 'YXZ');
  camera.updateMatrixWorld(true);
  return camera;
}

const FLAT = (): number => 0;

function armed(id: WeaponId, rounds = 400): PlayerState {
  const player = new PlayerState();
  // Funded first: these tests are about what a magazine and a cyclic rate
  // allow, not about what the wallet allows, and a loop that buys until it is
  // satisfied must never be able to outspend the account it is buying from.
  player.earn(500_000);
  player.buyWeapon(id);
  while (player.ammo(id) < rounds) {
    if (!player.buyAmmo(id)) break;
  }
  player.equip(id);
  return player;
}

function build(options: {
  player: PlayerState;
  camera: PerspectiveCamera;
  crowd?: StubCrowd;
  fleet?: StubFleet;
  boxes?: readonly ColliderBox[];
  heightAt?: (x: number, z: number) => number;
}): CombatSystem {
  return new CombatSystem({
    player: options.player,
    camera: options.camera,
    domElement: inertElement(),
    world: new WorldRayIndex(options.boxes ?? []),
    heightAt: options.heightAt ?? FLAT,
    ...(options.crowd ? { civilians: options.crowd } : {}),
    ...(options.fleet ? { vehicles: options.fleet } : {}),
    seed: 'combat-test',
  });
}

// -- ballistics ---------------------------------------------------------------

describe('damage falloff', () => {
  it('does full damage out to the weapon’s stated range', () => {
    for (const spec of Object.values(WEAPONS)) {
      expect(damageAtRange(spec, 0)).toBe(spec.damage);
      expect(damageAtRange(spec, spec.rangeM * 0.5)).toBe(spec.damage);
      expect(damageAtRange(spec, spec.rangeM)).toBe(spec.damage);
    }
  });

  it('decays to nothing past the range and never goes negative', () => {
    const rifle = WEAPONS.rifle;
    const mid = rifle.rangeM * ((1 + FALLOFF_END) / 2);
    expect(damageAtRange(rifle, mid)).toBeCloseTo(rifle.damage * 0.5, 5);
    expect(damageAtRange(rifle, rifle.rangeM * FALLOFF_END)).toBe(0);
    expect(damageAtRange(rifle, 10_000)).toBe(0);
  });

  it('falls monotonically', () => {
    const spec = WEAPONS.pistol;
    let previous = Infinity;
    for (let d = 0; d < spec.rangeM * 2; d += 1) {
      const damage = damageAtRange(spec, d);
      expect(damage).toBeLessThanOrEqual(previous + 1e-9);
      previous = damage;
    }
  });

  it('doubles for the top of the body and not for the rest of it', () => {
    expect(zoneMultiplier(1.7, 0, 1.75)).toBeGreaterThan(1);
    expect(zoneMultiplier(1.2, 0, 1.75)).toBe(1);
    // A person standing on a first floor is measured from THEIR feet.
    expect(zoneMultiplier(4.7, 3, 1.75)).toBeGreaterThan(1);
  });

  it('gives the shotgun more damage at contact range than the carbine', () => {
    const shotgun = WEAPONS.shotgun.damage * WEAPONS.shotgun.pellets;
    expect(shotgun).toBeGreaterThan(WEAPONS.rifle.damage);
    // ...and less at fifty metres, where its pattern no longer reaches.
    expect(damageAtRange(WEAPONS.shotgun, 50)).toBe(0);
    expect(damageAtRange(WEAPONS.rifle, 50)).toBe(WEAPONS.rifle.damage);
  });
});

describe('rate of fire and magazine limits', () => {
  it('refuses a second shot inside the cyclic interval', () => {
    const player = armed('pistol');
    const armoury = new Armoury(player);
    expect(armoury.fire('pistol').fired).toBe(true);
    expect(armoury.fire('pistol').reason).toBe('cooldown');
    armoury.update(shotInterval(WEAPONS.pistol) - 0.001);
    expect(armoury.fire('pistol').reason).toBe('cooldown');
    armoury.update(0.002);
    expect(armoury.fire('pistol').fired).toBe(true);
  });

  it('fires exactly one magazine before it has to reload', () => {
    const spec = WEAPONS.smg;
    const player = armed('smg');
    const armoury = new Armoury(player);
    let fired = 0;
    for (let i = 0; i < spec.magazine + 5; i += 1) {
      if (armoury.fire('smg').fired) fired += 1;
      armoury.update(shotInterval(spec));
    }
    expect(fired).toBe(spec.magazine);
    expect(armoury.magazine('smg')).toBe(0);
  });

  it('is unusable for exactly the reload time, then full again', () => {
    const spec = WEAPONS.pistol;
    const player = armed('pistol');
    const armoury = new Armoury(player);
    for (let i = 0; i < spec.magazine; i += 1) {
      armoury.fire('pistol');
      armoury.update(shotInterval(spec));
    }
    expect(armoury.startReload('pistol')).toBe(true);
    armoury.update(spec.reloadSeconds - 0.01);
    expect(armoury.reloading).toBe(true);
    expect(armoury.fire('pistol').reason).toBe('reloading');
    armoury.update(0.02);
    expect(armoury.reloading).toBe(false);
    expect(armoury.magazine('pistol')).toBe(spec.magazine);
  });

  it('never offers more rounds than the player owns', () => {
    const player = new PlayerState();
    player.buyWeapon('rifle');
    player.equip('rifle');
    const armoury = new Armoury(player);
    // One magazine came with the purchase; spend all but three.
    const spec = WEAPONS.rifle;
    for (let i = 0; i < spec.magazine - 3; i += 1) {
      armoury.fire('rifle');
      armoury.update(shotInterval(spec));
    }
    armoury.startReload('rifle');
    armoury.update(spec.reloadSeconds);
    expect(player.ammo('rifle')).toBe(3);
    expect(armoury.magazine('rifle')).toBe(3);
  });

  it('spends one round per trigger pull however many pellets it throws', () => {
    const player = armed('shotgun');
    const before = player.ammo('shotgun');
    const armoury = new Armoury(player);
    const outcome = armoury.fire('shotgun');
    expect(outcome.pellets).toBe(WEAPONS.shotgun.pellets);
    expect(player.ammo('shotgun')).toBe(before - 1);
  });

  it('refuses to fire with no weapon and with no ammunition', () => {
    const player = new PlayerState();
    const armoury = new Armoury(player);
    expect(armoury.fire(null).reason).toBe('noWeapon');
    player.buyWeapon('pistol');
    player.equip('pistol');
    for (let i = 0; i < 200; i += 1) {
      armoury.fire('pistol');
      armoury.update(1);
    }
    expect(player.ammo('pistol')).toBe(0);
    expect(armoury.fire('pistol').reason).toBe('noAmmo');
  });
});

describe('spread', () => {
  it('keeps every pellet inside the weapon’s cone and produces unit vectors', () => {
    const rng = createRng('spread');
    const out = { x: 0, y: 0, z: 0 };
    for (const id of ['pistol', 'shotgun', 'rifle'] as const) {
      const spec = WEAPONS[id];
      for (let i = 0; i < 400; i += 1) {
        spreadDirection(0, 0, -1, spec.spreadRad, rng, out);
        expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 6);
        const angle = Math.acos(Math.min(1, -out.z));
        expect(angle).toBeLessThanOrEqual(spec.spreadRad + 1e-6);
      }
    }
  });

  it('is deterministic for a given seed', () => {
    const a = createRng('same');
    const b = createRng('same');
    const outA = { x: 0, y: 0, z: 0 };
    const outB = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 20; i += 1) {
      spreadDirection(1, 0, 0, 0.1, a, outA);
      spreadDirection(1, 0, 0, 0.1, b, outB);
      expect(outA).toEqual(outB);
    }
  });

  it('kicks the camera hardest for the heaviest weapon', () => {
    expect(recoilKick(WEAPONS.rifle)).toBeGreaterThan(recoilKick(WEAPONS.smg));
    expect(recoilKick(WEAPONS.shotgun)).toBeGreaterThan(recoilKick(WEAPONS.pistol));
    for (const spec of Object.values(WEAPONS)) {
      expect(recoilKick(spec)).toBeLessThan(0.06);
    }
  });
});

// -- geometry -----------------------------------------------------------------

describe('ray geometry', () => {
  it('hits an axis-aligned box at the right distance and misses beside it', () => {
    expect(rayBox(0, 0, 0, 1, 0, 0, 5, -1, -1, 6, 1, 1, 100)).toBeCloseTo(5, 6);
    expect(rayBox(0, 0, 0, 1, 0, 0, 5, 4, -1, 6, 5, 1, 100)).toBe(-1);
    // A ray that starts inside is already touching it.
    expect(rayBox(5.5, 0, 0, 1, 0, 0, 5, -1, -1, 6, 1, 1, 100)).toBe(0);
    // Beyond the ray's own length is a miss.
    expect(rayBox(0, 0, 0, 1, 0, 0, 5, -1, -1, 6, 1, 1, 4)).toBe(-1);
  });

  it('hits a standing person as a cylinder, and misses over their head', () => {
    // Body at (10, 0, 0), 1.8 m tall, shot from eye height due east.
    expect(rayCylinder(0, 1.6, 0, 1, 0, 0, 10, 0, 0, 0.32, 1.8, 100)).toBeCloseTo(9.68, 2);
    expect(rayCylinder(0, 2.4, 0, 1, 0, 0, 10, 0, 0, 0.32, 1.8, 100)).toBe(-1);
    // Straight down onto the top of their head.
    expect(rayCylinder(10, 5, 0, 0, -1, 0, 10, 0, 0, 0.32, 1.8, 100)).toBeCloseTo(3.2, 5);
  });

  it('respects a vehicle’s heading', () => {
    // A 4.5 x 1.9 car at the origin, nose north. Broadside from the east is a
    // 0.95 m half-width; head-on from the north is a 2.25 m half-length.
    const across = rayOrientedBox(10, 0.8, 0, -1, 0, 0, 0, 0.8, 0, 0, 2.25, 0.95, 0.7, 100);
    const along = rayOrientedBox(0, 0.8, -10, 0, 0, 1, 0, 0.8, 0, 0, 2.25, 0.95, 0.7, 100);
    expect(across).toBeCloseTo(9.05, 5);
    expect(along).toBeCloseTo(7.75, 5);
  });

  it('finds the ground where a shot aimed down meets it', () => {
    const flat = (): number => 0;
    const down = Math.SQRT1_2;
    expect(rayGround(flat, 0, 10, 0, 0, -1, 0, 100)).toBeCloseTo(10, 2);
    expect(rayGround(flat, 0, 10, 0, down, -down, 0, 100)).toBeCloseTo(14.14, 1);
    // A level shot from eye height never meets flat ground.
    expect(rayGround(flat, 0, 1.6, 0, 1, 0, 0, 100)).toBe(-1);
    // A slope does.
    const ramp = (x: number): number => x * 0.1;
    const t = rayGround(ramp, 0, 1.6, 0, 1, 0, 0, 100);
    expect(t).toBeGreaterThan(15);
    expect(t).toBeLessThan(17);
  });

  it('indexes the world and returns the nearest box on the path', () => {
    const boxes: ColliderBox[] = [
      { minX: 4, maxX: 6, minZ: -2, maxZ: 2, bottom: 0, top: 6, solid: true },
      { minX: 30, maxX: 34, minZ: -4, maxZ: 4, bottom: 0, top: 20, solid: true },
      { minX: 4, maxX: 6, minZ: 20, maxZ: 24, bottom: 0, top: 6, solid: true },
      { minX: 8, maxX: 9, minZ: -2, maxZ: 2, bottom: 0, top: 0.15, solid: false },
    ];
    const index = new WorldRayIndex(boxes);
    expect(index.count).toBe(3);
    const hit = index.cast(0, 1.6, 0, 1, 0, 0, 100);
    expect(hit?.t).toBeCloseTo(4, 6);
    // Nothing lies to the west.
    expect(index.cast(0, 1.6, 0, -1, 0, 0, 100)).toBeNull();
    // Line of sight is the same test, inverted.
    expect(hasLineOfSight(index, 0, 1.6, 0, 20, 1.6, 0)).toBe(false);
    expect(hasLineOfSight(index, 0, 1.6, 0, 0, 1.6, 40)).toBe(true);
  });
});

// -- hit registration and consequences ----------------------------------------

describe('hit registration', () => {
  it('hits a civilian in the body when the shot is aimed at their body', () => {
    const player = armed('pistol');
    const crowd = new StubCrowd();
    crowd.add(20, 0, 0);
    // Twenty metres out and two degrees down puts the round in the chest.
    const combat = build({ player, camera: eastwardCamera(0, 1.68, 0, -0.021), crowd });

    expect(combat.fireOnce()).toBe(true);
    expect(crowd.hurt).toBe(1);
    expect(crowd.bodies[0]?.health).toBeCloseTo(100 - WEAPONS.pistol.damage, 5);
    combat.dispose();
  });

  it('is a head shot when a level shot meets somebody the same height', () => {
    const player = armed('pistol');
    const crowd = new StubCrowd();
    crowd.add(20, 0, 0);
    const combat = build({ player, camera: eastwardCamera(), crowd });

    combat.fireOnce();
    expect(crowd.bodies[0]?.health).toBeCloseTo(
      100 - WEAPONS.pistol.damage * HEAD_MULTIPLIER,
      5,
    );
    combat.dispose();
  });

  it('stops at a wall rather than shooting through it', () => {
    const player = armed('rifle');
    const crowd = new StubCrowd();
    crowd.add(20, 0, 0);
    const boxes: ColliderBox[] = [
      { minX: 9, maxX: 10, minZ: -6, maxZ: 6, bottom: 0, top: 8, solid: true },
    ];
    const combat = build({ player, camera: eastwardCamera(), crowd, boxes });

    combat.fireOnce();
    expect(crowd.hurt).toBe(0);
    expect(crowd.bodies[0]?.health).toBe(100);
    combat.dispose();
  });

  it('hits the nearer of two people on the same line', () => {
    const player = armed('rifle');
    const crowd = new StubCrowd();
    crowd.add(12, 0, 0);
    crowd.add(30, 0, 0);
    const combat = build({ player, camera: eastwardCamera(), crowd });

    combat.fireOnce();
    expect(crowd.bodies[0]?.health).toBeLessThan(100);
    expect(crowd.bodies[1]?.health).toBe(100);
    combat.dispose();
  });

  it('registers a hit on a car without hurting anyone', () => {
    const player = armed('pistol');
    const crowd = new StubCrowd();
    const fleet = new StubFleet();
    // A crossover: 1.75 m to the roof, so a level shot from eye height is on
    // the glass rather than over it.
    fleet.add({
      id: 7, police: false, x: 14, y: 0.875, z: 0, yaw: 0,
      halfLength: 2.25, halfWidth: 0.95, halfHeight: 0.875,
    });
    const combat = build({ player, camera: eastwardCamera(), crowd, fleet });

    combat.fireOnce();
    expect(combat.stats.hits).toBe(1);
    combat.dispose();
  });

  it('kills a civilian with a shotgun at contact range inside two shells', () => {
    const player = armed('shotgun');
    const crowd = new StubCrowd();
    crowd.add(3, 0, 0);
    const combat = build({ player, camera: eastwardCamera(), crowd });

    let pulls = 0;
    while (crowd.killed === 0 && pulls < 4) {
      if (combat.fireOnce()) pulls += 1;
      combat.update(1, idle());
    }
    expect(crowd.killed).toBe(1);
    expect(pulls).toBeLessThanOrEqual(2);
    combat.dispose();
  });

  it('cannot kill at four times the shotgun’s range', () => {
    const player = armed('shotgun');
    const crowd = new StubCrowd();
    crowd.add(80, 0, 0);
    const combat = build({ player, camera: eastwardCamera(), crowd });

    combat.fireOnce();
    expect(crowd.killed).toBe(0);
    expect(crowd.bodies[0]?.health).toBe(100);
    combat.dispose();
  });

  it('refuses to fire while driving', () => {
    const player = armed('pistol');
    const crowd = new StubCrowd();
    crowd.add(10, 0, 0);
    const combat = build({ player, camera: eastwardCamera(), crowd });

    combat.setTrigger(true);
    combat.update(1 / 60, {
      driving: true, playerX: 0, playerY: 0, playerZ: 0, playerSpeed: 0,
    });
    expect(combat.stats.shotsFired).toBe(0);

    combat.update(1 / 60, {
      driving: false, playerX: 0, playerY: 0, playerZ: 0, playerSpeed: 0,
    });
    expect(combat.stats.shotsFired).toBe(1);
    combat.dispose();
  });

  it('holds the trigger down for an automatic and not for a shotgun', () => {
    const auto = armed('smg');
    const autoCombat = build({ player: auto, camera: eastwardCamera() });
    autoCombat.setTrigger(true);
    for (let i = 0; i < 60; i += 1) autoCombat.update(1 / 60, idle());
    expect(autoCombat.stats.shotsFired).toBeGreaterThan(5);
    autoCombat.dispose();

    const pump = armed('shotgun');
    const pumpCombat = build({ player: pump, camera: eastwardCamera() });
    pumpCombat.setTrigger(true);
    for (let i = 0; i < 60; i += 1) pumpCombat.update(1 / 60, idle());
    expect(pumpCombat.stats.shotsFired).toBe(1);
    pumpCombat.dispose();
  });
});

function idle(): {
  driving: boolean;
  playerX: number;
  playerY: number;
  playerZ: number;
  playerSpeed: number;
} {
  return { driving: false, playerX: 0, playerY: 0, playerZ: 0, playerSpeed: 0 };
}

describe('consequences', () => {
  it('adds nothing when nobody is there to see it', () => {
    const player = armed('pistol');
    const combat = build({ player, camera: eastwardCamera(), crowd: new StubCrowd() });
    combat.fireOnce();
    expect(player.heat).toBe(0);
    expect(player.wanted).toBe(0);
    combat.dispose();
  });

  it('adds one gunshot of heat, and one star, for a shot with a witness', () => {
    const player = armed('pistol');
    const crowd = new StubCrowd();
    crowd.add(0, 0, 12); // beside the player, not on the shot's path
    const combat = build({ player, camera: eastwardCamera(), crowd });

    combat.fireOnce();
    expect(player.heat).toBe(HEAT.gunshot);
    expect(player.wanted).toBe(1);
    combat.dispose();
  });

  it('charges a wounded civilian once per trigger pull, not once per pellet', () => {
    const player = armed('shotgun');
    const crowd = new StubCrowd();
    // Far enough that eight pellets cannot kill, close enough that several land.
    const victim = crowd.add(18, 0, 0);
    const combat = build({ player, camera: eastwardCamera(), crowd });

    combat.fireOnce();
    expect(victim.health).toBeLessThan(100);
    expect(victim.health).toBeGreaterThan(0);
    expect(player.heat).toBe(HEAT.gunshot + HEAT.civilianHurt);
    combat.dispose();
  });

  it('charges a killing exactly once, not as a wounding and a killing', () => {
    const killer = armed('shotgun');
    const crowd = new StubCrowd();
    crowd.add(3, 0, 0);
    const combat = build({ player: killer, camera: eastwardCamera(), crowd });

    let before = killer.heat;
    let pulls = 0;
    while (crowd.killed === 0 && pulls < 4) {
      before = killer.heat;
      if (combat.fireOnce()) pulls += 1;
      combat.update(1, idle());
    }
    expect(crowd.killed).toBe(1);
    // The pull that killed them: one gunshot, one killing, and NOT also a
    // wounding, even though several pellets landed before the fatal one.
    expect(killer.heat - before).toBe(HEAT.gunshot + HEAT.civilianKilled);
    expect(killer.wanted).toBeGreaterThanOrEqual(2);
    combat.dispose();
  });

  it('puts a killed officer two heat brackets above a killed civilian', () => {
    const civilian = new PlayerState();
    civilian.addHeat(HEAT.gunshot);
    civilian.addHeat(HEAT.civilianKilled);
    expect(civilian.wanted).toBe(2);

    const officer = new PlayerState();
    officer.addHeat(HEAT.gunshot);
    officer.addHeat(HEAT.policeKilled);
    expect(officer.wanted).toBe(3);
  });

  it('climbs through the stars in the order the offences escalate', () => {
    const player = new PlayerState();
    const seen: number[] = [];
    const record = (): void => {
      if (seen[seen.length - 1] !== player.wanted) seen.push(player.wanted);
    };
    record();
    player.addHeat(HEAT.gunshot);
    record();
    player.addHeat(HEAT.civilianKilled);
    record();
    player.addHeat(HEAT.policeKilled);
    record();
    player.addHeat(HEAT.policeKilled);
    record();
    player.addHeat(HEAT.policeKilled);
    record();
    expect(seen).toEqual([0, 1, 2, 3, 4, 5]);
    expect(player.wanted).toBe(5);
  });
});

// -- death and respawn --------------------------------------------------------

describe('death and respawn', () => {
  function director(player: PlayerState, extras: Partial<{ driving: boolean }> = {}): {
    respawn: RespawnDirector;
    at: { x: number; z: number; heading: number } | null;
    state: { driving: boolean; exits: number; banners: (string | null)[]; busts: number };
  } {
    const state = { driving: extras.driving ?? false, exits: 0, banners: [] as (string | null)[], busts: 0 };
    const box: { at: { x: number; z: number; heading: number } | null } = { at: null };
    const respawn = new RespawnDirector({
      player,
      spawn: { x: -153, z: 18, heading: -1.44 },
      teleport: (x, z, heading) => {
        box.at = { x, z, heading };
      },
      isDriving: () => state.driving,
      exitVehicle: () => {
        state.driving = false;
        state.exits += 1;
      },
      onBanner: (title) => state.banners.push(title),
      onBust: () => {
        state.busts += 1;
      },
      holdSeconds: 1,
    });
    return { respawn, get at() { return box.at; }, state };
  }

  it('restores health and clears the heat while keeping money and weapons', () => {
    const player = armed('rifle');
    player.spend(1200);
    const money = player.money;
    const ammo = player.ammo('rifle');
    player.addHeat(HEAT.policeKilled);
    expect(player.wanted).toBe(3);

    const harness = director(player);
    expect(player.hurt(MAX_HEALTH)).toBe(true);
    expect(player.alive).toBe(false);
    expect(harness.respawn.busy).toBe(true);

    harness.respawn.update(1.01);
    expect(player.alive).toBe(true);
    expect(player.health).toBe(MAX_HEALTH);
    expect(player.wanted).toBe(0);
    expect(player.heat).toBe(0);
    expect(player.money).toBe(money);
    expect(player.owns('rifle')).toBe(true);
    expect(player.ammo('rifle')).toBe(ammo);
    harness.respawn.dispose();
  });

  it('puts the player back at the city spawn point', () => {
    const player = armed('pistol');
    const harness = director(player);
    harness.respawn.bust('busted');
    harness.respawn.update(1.01);
    expect(harness.at).toEqual({ x: -153, z: 18, heading: -1.44 });
    harness.respawn.dispose();
  });

  it('gets the player out of the car before moving them', () => {
    const player = armed('pistol');
    const harness = director(player, { driving: true });
    harness.respawn.bust('wasted');
    harness.respawn.update(1.01);
    expect(harness.state.exits).toBe(1);
    expect(harness.state.driving).toBe(false);
    harness.respawn.dispose();
  });

  it('shows an outcome, then clears it, and counts one death for three bullets', () => {
    const player = armed('pistol');
    const harness = director(player);
    player.hurt(60);
    player.hurt(60);
    player.hurt(60);
    expect(harness.state.busts).toBe(1);
    expect(harness.state.banners).toEqual(['Wasted']);
    harness.respawn.update(1.01);
    expect(harness.state.banners).toEqual(['Wasted', null]);
    expect(harness.respawn.count).toBe(1);
    harness.respawn.dispose();
  });

  it('hands `onDeath` back when it is disposed', () => {
    const player = new PlayerState();
    let mine = 0;
    player.onDeath = (): void => {
      mine += 1;
    };
    const harness = director(player);
    player.hurt(MAX_HEALTH);
    // The director chains rather than replaces.
    expect(mine).toBe(1);
    harness.respawn.dispose();
    expect(player.onDeath).not.toBeNull();
  });
});
