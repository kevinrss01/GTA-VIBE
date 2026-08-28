/**
 * The player keeps their gun through death.
 *
 * This pins a defect the player reported as "I lost my gun after I died". The
 * ownership state was never the problem: `PlayerState.respawn` keeps money,
 * weapons and ammunition and always did. What was lost was the DISMOUNT.
 * `RespawnDirector` was wired to the driving layer only, so a player killed in
 * an aeroplane was put back at the spawn point while the flight layer still
 * held them - and `CombatSystem` hides the view model and refuses the trigger
 * for as long as it believes the player is in a vehicle. The gun was still in
 * the inventory and completely unusable, which from the seat is the same thing.
 *
 * Everything here runs headless: a real `PlayerState`, a real `CombatSystem`
 * and a real `RespawnDirector` against two stub seats.
 */

import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';

import { CombatSystem } from '../src/combat/CombatSystem';
import { WorldRayIndex } from '../src/combat/rays';
import { RespawnDirector, type BustReason } from '../src/combat/Respawn';
import { defaultViewmodels, WeaponViewmodel } from '../src/combat/WeaponViewmodel';
import { ALL_WEAPONS, MAX_HEALTH, PlayerState, WEAPONS, type WeaponId } from '../src/player/PlayerState';

function inertElement(): HTMLElement {
  return {
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  } as unknown as HTMLElement;
}

const FLAT = (): number => 0;

/** A camera at eye height on flat ground, looking due east (+X). */
function eastwardCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(70, 1.6, 0.1, 1000);
  camera.position.set(0, 1.68, 0);
  camera.rotation.set(0, -Math.PI / 2, 0, 'YXZ');
  camera.updateMatrixWorld(true);
  return camera;
}

function armed(id: WeaponId, magazines = 4): PlayerState {
  const player = new PlayerState();
  player.earn(500_000);
  player.buyWeapon(id);
  for (let i = 0; i < magazines; i += 1) player.buyAmmo(id);
  player.equip(id);
  return player;
}

interface Seat {
  in: boolean;
  exits: number;
}

interface Stage {
  readonly player: PlayerState;
  readonly combat: CombatSystem;
  readonly respawn: RespawnDirector;
  readonly car: Seat;
  readonly plane: Seat;
  readonly teleports: { x: number; z: number }[];
  /** Runs the game loop for `seconds`, exactly as `main.ts` orders it. */
  run(seconds: number): void;
  dispose(): void;
}

/**
 * The whole death loop, wired the way `main.ts` wires it.
 *
 * `listPlaneSeat` is the switch this file exists for: with it false the
 * director knows about the car and not the aeroplane, which is the shipped
 * wiring the defect came from.
 */
function stage(weapon: WeaponId, listPlaneSeat = true): Stage {
  const player = armed(weapon);
  const camera = eastwardCamera();
  const combat = new CombatSystem({
    player,
    camera,
    domElement: inertElement(),
    world: new WorldRayIndex([]),
    heightAt: FLAT,
    seed: 'weapon-persistence',
  });

  const car: Seat = { in: false, exits: 0 };
  const plane: Seat = { in: false, exits: 0 };
  const teleports: { x: number; z: number }[] = [];

  const respawn = new RespawnDirector({
    player,
    spawn: { x: 12, z: -8, heading: 1 },
    teleport: (x, z) => {
      teleports.push({ x, z });
    },
    mounts: [
      { occupied: () => car.in, exit: () => { car.in = false; car.exits += 1; } },
      ...(listPlaneSeat
        ? [{ occupied: (): boolean => plane.in, exit: (): void => { plane.in = false; plane.exits += 1; } }]
        : []),
    ],
    onBust: () => combat.reset(),
    holdSeconds: 0.2,
  });

  const run = (seconds: number): void => {
    const dt = 1 / 60;
    for (let t = 0; t < seconds; t += dt) {
      combat.update(dt, {
        // Exactly what `main.ts` passes: a cockpit counts as driving.
        driving: car.in || plane.in,
        playerX: 0,
        playerY: 0,
        playerZ: 0,
        playerSpeed: 0,
      });
      respawn.update(dt);
    }
  };

  return {
    player,
    combat,
    respawn,
    car,
    plane,
    teleports,
    run,
    dispose: () => combat.dispose(),
  };
}

describe('PlayerState.respawn keeps everything the player bought', () => {
  it('touches health, heat and nothing else', () => {
    const player = new PlayerState();
    player.earn(500_000);
    for (const id of ALL_WEAPONS) {
      player.buyWeapon(id);
      player.buyAmmo(id);
    }
    player.equip('shotgun');
    player.consumeRound('shotgun');
    const money = player.money;
    const ammo = ALL_WEAPONS.map((id) => player.ammo(id));

    player.addHeat(400);
    player.hurt(MAX_HEALTH);
    expect(player.alive).toBe(false);

    player.respawn();

    expect(player.health).toBe(MAX_HEALTH);
    expect(player.heat).toBe(0);
    expect(player.money).toBe(money);
    expect(player.equipped).toBe('shotgun');
    for (const id of ALL_WEAPONS) expect(player.owns(id)).toBe(true);
    expect(ALL_WEAPONS.map((id) => player.ammo(id))).toEqual(ammo);
  });
});

describe('dying on foot', () => {
  for (const reason of ['wasted', 'busted'] as BustReason[]) {
    it(`keeps the weapon, the magazine and the trigger through a ${reason}`, () => {
      const s = stage('pistol');
      s.run(0.2);
      expect(s.combat.fireOnce()).toBe(true);
      const reserve = s.player.ammo('pistol');

      if (reason === 'wasted') s.player.hurt(MAX_HEALTH);
      else s.respawn.bust('busted');
      expect(s.respawn.busy).toBe(true);

      s.run(1);
      expect(s.respawn.count).toBe(1);
      expect(s.teleports).toHaveLength(1);

      expect(s.player.owns('pistol')).toBe(true);
      expect(s.player.equipped).toBe('pistol');
      // The ammunition policy is preserved rather than refilled: what was
      // spent stays spent, and what was left is still there.
      expect(s.player.ammo('pistol')).toBe(reserve);
      expect(s.combat.magazine).toBeGreaterThan(0);
      expect(s.combat.holstered).toBe(false);
      // The round that proves it: a real trigger pull, off a real magazine.
      expect(s.combat.fireOnce()).toBe(true);
      expect(s.player.ammo('pistol')).toBe(reserve - 1);
      s.dispose();
    });
  }

  it('does not refuse the trigger merely because a reload was running', () => {
    // The shotgun reloads for 2.6 s, comfortably longer than the 0.2 s hold,
    // so without `combat.reset` the respawned player stands there cycling a
    // weapon they cannot fire.
    const s = stage('shotgun', true);
    s.run(0.05);
    s.combat.fireOnce();
    s.combat.reload();
    expect(s.combat.reloading).toBe(true);

    s.player.hurt(MAX_HEALTH);
    s.run(1);

    expect(s.combat.reloading).toBe(false);
    expect(s.combat.fireOnce()).toBe(true);
    s.dispose();
  });
});

describe('dying in something', () => {
  it('gets the player out of a car and hands the gun back', () => {
    const s = stage('rifle');
    s.car.in = true;
    s.run(0.1);
    // On foot only: the weapon is refused from the driver's seat, by design.
    expect(s.combat.fireOnce()).toBe(false);

    s.player.hurt(MAX_HEALTH);
    s.run(1);

    expect(s.car.exits).toBe(1);
    expect(s.car.in).toBe(false);
    expect(s.player.equipped).toBe('rifle');
    expect(s.combat.fireOnce()).toBe(true);
    s.dispose();
  });

  it('gets the player out of an aircraft and hands the gun back', () => {
    const s = stage('rifle');
    s.plane.in = true;
    s.run(0.1);
    expect(s.combat.fireOnce()).toBe(false);

    s.player.hurt(MAX_HEALTH);
    s.run(1);

    expect(s.plane.exits).toBe(1);
    expect(s.plane.in).toBe(false);
    expect(s.player.owns('rifle')).toBe(true);
    expect(s.player.equipped).toBe('rifle');
    expect(s.combat.fireOnce()).toBe(true);
    s.dispose();
  });

  it('gets the player out of an aircraft on an arrest too', () => {
    const s = stage('smg');
    s.plane.in = true;
    s.run(0.1);
    s.respawn.bust('busted');
    s.run(1);
    expect(s.plane.in).toBe(false);
    expect(s.combat.fireOnce()).toBe(true);
    s.dispose();
  });

  /*
   * THE DEFECT ITSELF, pinned from the other side.
   *
   * A director that was never told about the second kind of seat leaves the
   * player in it, and every symptom the player described follows from that one
   * fact: no weapon on screen, no shot, and a HUD that says the gun is stowed.
   */
  it('leaves the weapon unusable when a seat is missing from the director', () => {
    const s = stage('rifle', false);
    s.plane.in = true;
    s.run(0.1);

    s.player.hurt(MAX_HEALTH);
    s.run(1);

    expect(s.respawn.count).toBe(1);
    expect(s.player.owns('rifle'), 'the weapon was never actually lost').toBe(true);
    expect(s.player.equipped).toBe('rifle');
    // ...and is completely unusable, which is what the player saw.
    expect(s.plane.in).toBe(true);
    expect(s.combat.fireOnce()).toBe(false);
    s.dispose();
  });
});

describe('the trigger honours ON FOOT ONLY however it is pulled', () => {
  it('refuses a direct trigger pull from a vehicle, not only a held one', () => {
    const s = stage('pistol');
    s.run(0.05);
    expect(s.combat.fireOnce()).toBe(true);

    s.car.in = true;
    s.run(0.05);
    // `fireOnce` is what automated QA pulls. It used to fire happily from a
    // cockpit, which is how a respawn that never dismounted the player passed
    // a check the player themselves could not.
    expect(s.combat.fireOnce()).toBe(false);
    s.combat.setTrigger(true);
    s.run(0.2);
    expect(s.combat.stats.shotsFired).toBe(1);

    s.combat.setTrigger(false);
    s.car.in = false;
    s.run(0.05);
    expect(s.combat.fireOnce()).toBe(true);
    s.dispose();
  });
});

describe('the view model is asked for the weapon again after a respawn', () => {
  it('drops it while the player is dead and takes it back out afterwards', () => {
    const camera = eastwardCamera();
    // No asset is downloaded in this test: `drawn` is the REQUEST - which
    // weapon the overlay has been told to hold - and is written before the
    // loader is ever consulted.
    const vm = new WeaponViewmodel(defaultViewmodels(''));
    const pose = { reloading: false, holstered: false, hidden: false, speed: 0 };

    vm.update(1 / 60, camera, 'pistol', pose);
    expect(vm.drawn).toBe('pistol');

    // Dead: `CombatSystem` passes `hidden` and the hands come up empty.
    vm.update(1 / 60, camera, 'pistol', { ...pose, hidden: true });
    expect(vm.drawn).toBeNull();

    // Respawned.
    vm.update(1 / 60, camera, 'pistol', pose);
    expect(vm.drawn).toBe('pistol');
    // Drawn from the holster rather than appearing in place.
    expect(vm.raised).toBeLessThan(1);
    vm.dispose();
  });
});

describe('every weapon in the shop survives a death', () => {
  it('keeps each one owned, equipped and firing', () => {
    for (const id of ALL_WEAPONS) {
      const s = stage(id);
      s.run(0.05);
      const reserve = s.player.ammo(id);
      expect(reserve).toBeGreaterThan(0);

      s.player.hurt(MAX_HEALTH);
      s.run(1);

      expect(s.player.owns(id)).toBe(true);
      expect(s.player.equipped).toBe(id);
      expect(s.player.ammo(id)).toBe(reserve);
      expect(s.combat.magazine).toBe(Math.min(WEAPONS[id].magazine, reserve));
      expect(s.combat.fireOnce(), `${id} would not fire after a respawn`).toBe(true);
      s.dispose();
    }
  });
});
