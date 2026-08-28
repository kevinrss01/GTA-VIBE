/**
 * What happens to a civilian who gets shot.
 *
 * Four defects are pinned here, all of them reported as "the pedestrians
 * explode and disappear":
 *
 *  - A hit on a person was the LARGEST impact effect in the game: nine fast
 *    dark-red embers and a blood pool up to 0.6 m across, PER PELLET. One
 *    shotgun shell spent seventy-two of the hundred and seventy-six glow slots
 *    and eight of the seventy-two marks on one civilian in one frame, and
 *    played eight body-impact sounds on top of each other.
 *  - The crowd was told a casualty was at the victim's own instance origin -
 *    their feet - rather than at the point the round actually arrived, so with
 *    two people standing together the wrong one could be dropped.
 *  - A wounded civilian who was not killed did nothing at all: no flinch, no
 *    stagger, they simply kept walking with the damage recorded silently.
 *  - The casualty list recycled its oldest record when it filled up, and the
 *    oldest record is usually a BODY. The corpse then became a live target and
 *    a live witness again, and could be "killed" a second time.
 *
 * No renderer. `CrowdTargets` reads the crowd's instance matrices, so the
 * fixture writes those matrices exactly the way `PedestrianSystem.writeMatrix`
 * does - including the topple - which is the contract between the two modules
 * and the only honest way to assert against it.
 */

import {
  BufferGeometry,
  Group,
  InstancedMesh,
  MeshBasicMaterial,
  PerspectiveCamera,
} from 'three';
import { afterEach, describe, expect, it } from 'vitest';

import { hitZone, LEG_ZONE, LIMB_MULTIPLIER, HEAD_MULTIPLIER } from '../src/combat/ballistics';
import { FX_CAPACITY, impactBudget, type ImpactSound } from '../src/combat/CombatFx';
import { CombatSystem, WITNESS_RADIUS } from '../src/combat/CombatSystem';
import {
  BODY_FORGET_DISTANCE,
  BODY_MEMORY,
  CrowdTargets,
  MAX_TRACKED,
} from '../src/combat/CrowdTargets';
import { WorldRayIndex } from '../src/combat/rays';
import type { Blow } from '../src/combat/targets';
import { PlayerState, WEAPONS, type WeaponId } from '../src/player/PlayerState';

// -- a crowd, as the renderer actually publishes one ---------------------------

/** Half a torso, in rig units. `PedestrianSystem.DOWN_LIFT`. */
const DOWN_LIFT = 0.12;

interface Walker {
  x: number;
  y: number;
  z: number;
  heading: number;
  girth: number;
  height: number;
  /** The topple, in radians. Zero on their feet, ±PI/2 flat out. */
  tilt: number;
}

/**
 * A stand-in for `PedestrianSystem.group`.
 *
 * `write` is `PedestrianSystem.writeMatrix` verbatim: the 3x3 is
 * `Ry(heading) * Rx(tilt) * scale(girth, height, girth)` stored column-major.
 * Copying it rather than importing it is deliberate - if the crowd changes the
 * composition, this test is where the two stop agreeing.
 */
class FakeCrowd {
  readonly group = new Group();
  readonly walkers: Walker[] = [];
  private readonly mesh: InstancedMesh;

  constructor(capacity = 64) {
    this.mesh = new InstancedMesh(new BufferGeometry(), new MeshBasicMaterial(), capacity);
    this.mesh.count = 0;
    this.group.add(this.mesh);
  }

  add(x: number, z: number, options: Partial<Walker> = {}): Walker {
    const walker: Walker = {
      x, y: 0, z, heading: 0, girth: 1, height: 1.75, tilt: 0, ...options,
    };
    this.walkers.push(walker);
    this.write();
    return walker;
  }

  write(): void {
    const m = this.mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < this.walkers.length; i += 1) {
      const w = this.walkers[i];
      if (!w) continue;
      const o = i * 16;
      const c = Math.cos(w.heading);
      const s = Math.sin(w.heading);
      const ct = Math.cos(w.tilt);
      const st = Math.sin(w.tilt);
      m[o] = c * w.girth;
      m[o + 1] = 0;
      m[o + 2] = -s * w.girth;
      m[o + 3] = 0;
      m[o + 4] = s * w.height * st;
      m[o + 5] = w.height * ct;
      m[o + 6] = c * w.height * st;
      m[o + 7] = 0;
      m[o + 8] = s * w.girth * ct;
      m[o + 9] = -w.girth * st;
      m[o + 10] = c * w.girth * ct;
      m[o + 11] = 0;
      m[o + 12] = w.x;
      m[o + 13] = w.y + DOWN_LIFT * w.girth * Math.abs(st);
      m[o + 14] = w.z;
      m[o + 15] = 1;
    }
    this.mesh.count = this.walkers.length;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
    this.mesh.dispose();
  }
}

/** What the crowd is asked to do, recorded rather than performed. */
interface CrowdCalls {
  readonly downs: {
    x: number;
    y: number;
    z: number;
    dirX?: number;
    dirZ?: number;
    /** Which way the crowd's own rule would topple them. See `fallSignOf`. */
    fallSign: number;
  }[];
  readonly staggers: { x: number; z: number; dirX: number; dirZ: number; zone: string }[];
  readonly alarms: { x: number; z: number; radius: number }[];
}

/**
 * `Crowd.knockDown`'s topple rule, copied rather than imported.
 *
 * `heading` is the direction the model FACES, which is `-(sin, cos)`. A blow
 * travelling the same way they face came from behind and folds them forwards
 * (-1); one travelling against it hit them in the chest and puts them over
 * backwards (+1). Copied so that if the crowd ever changes the rule, this file
 * is where the two stop agreeing.
 */
function fallSignOf(heading: number, dirX: number, dirZ: number): number {
  const facingX = -Math.sin(heading);
  const facingZ = -Math.cos(heading);
  return dirX * facingX + dirZ * facingZ > 0 ? -1 : 1;
}

function wired(crowd: FakeCrowd): { targets: CrowdTargets; calls: CrowdCalls } {
  const calls: CrowdCalls = { downs: [], staggers: [], alarms: [] };
  const targets = new CrowdTargets(crowd.group, {
    removeAt: (x, y, z, dirX, dirZ) => {
      // What `PedestrianSystem.downAt` does: find the nearest person still on
      // their feet within a metre, and put them over for good. Modelled here
      // as the topple the renderer would then publish, so `CrowdTargets` has
      // to read the consequence out of the instance buffer exactly as it does
      // against the real crowd.
      let best: Walker | null = null;
      let bestDistance = 1;
      for (const w of crowd.walkers) {
        const d = Math.hypot(w.x - x, w.z - z);
        if (w.tilt === 0 && d < bestDistance) {
          bestDistance = d;
          best = w;
        }
      }
      const sign = best ? fallSignOf(best.heading, dirX ?? 0, dirZ ?? 0) : 0;
      calls.downs.push({
        x, y, z,
        ...(dirX === undefined ? {} : { dirX }),
        ...(dirZ === undefined ? {} : { dirZ }),
        fallSign: sign,
      });
      if (best) best.tilt = sign * Math.PI / 2;
      crowd.write();
    },
    staggerAt: (x, z, dirX, dirZ, zone) => {
      calls.staggers.push({ x, z, dirX, dirZ, zone });
    },
    alarmAt: (x, z, radius) => {
      calls.alarms.push({ x, z, radius });
    },
  });
  return { targets, calls };
}

// -- the combat system around it -----------------------------------------------

function inertElement(): HTMLElement {
  return {
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  } as unknown as HTMLElement;
}

const FLAT = (): number => 0;

/**
 * A camera looking along a compass bearing.
 *
 * Forward is `(-sin yaw, 0, -cos yaw)`, so yaw PI looks down +Z and -PI/2 down
 * +X. `y` is the eye height, and it is a parameter rather than a constant
 * because it is how these tests choose a damage zone: a LEVEL shot has no
 * range-dependent drop, so an eye at 1.2 m is a chest hit at any distance and
 * an eye at 0.6 m is a leg hit at any distance, whatever the weapon's spread
 * does. Aiming down at a distant target instead makes the zone a function of
 * three numbers and the test a coin toss.
 */
function camera(x: number, z: number, yaw: number, y = 1.2, pitch = 0): PerspectiveCamera {
  const c = new PerspectiveCamera(70, 1.6, 0.1, 1000);
  c.position.set(x, y, z);
  c.rotation.set(pitch, yaw, 0, 'YXZ');
  c.updateMatrixWorld(true);
  return c;
}

/** Eye heights that put a level round in a named part of a 1.75 m person. */
const EYE = { head: 1.72, chest: 1.2, leg: 0.6 } as const;

function armed(id: WeaponId, magazines = 30): PlayerState {
  const player = new PlayerState();
  player.earn(5_000_000);
  player.buyWeapon(id);
  for (let i = 0; i < magazines; i += 1) player.buyAmmo(id);
  player.equip(id);
  return player;
}

interface Rig {
  readonly player: PlayerState;
  readonly combat: CombatSystem;
  readonly crowd: FakeCrowd;
  readonly targets: CrowdTargets;
  readonly calls: CrowdCalls;
  readonly sounds: ImpactSound[];
  /** Refreshes the target list and runs one frame of effects. */
  frame(dt?: number): void;
  dispose(): void;
}

const rigs: Rig[] = [];
afterEach(() => {
  while (rigs.length > 0) rigs.pop()?.dispose();
});

function build(weapon: WeaponId, view: PerspectiveCamera, crowd: FakeCrowd): Rig {
  const player = armed(weapon);
  const { targets, calls } = wired(crowd);
  const sounds: ImpactSound[] = [];
  const combat = new CombatSystem({
    player,
    camera: view,
    domElement: inertElement(),
    world: new WorldRayIndex([]),
    heightAt: FLAT,
    civilians: targets,
    seed: 'pedestrian-hits',
    onImpact: (kind) => sounds.push(kind),
  });
  const rig: Rig = {
    player,
    combat,
    crowd,
    targets,
    calls,
    sounds,
    frame: (dt = 1 / 60) => {
      combat.update(dt, {
        driving: false,
        playerX: view.position.x,
        playerY: 0,
        playerZ: view.position.z,
        playerSpeed: 0,
      });
    },
    dispose: () => {
      combat.dispose();
      crowd.dispose();
    },
  };
  rigs.push(rig);
  return rig;
}

// -- what the geometry says ----------------------------------------------------

describe('where on a body a round landed', () => {
  it('splits a person into a head, a trunk and legs', () => {
    expect(hitZone(1.7, 0, 1.75)).toBe('head');
    expect(hitZone(1.2, 0, 1.75)).toBe('body');
    expect(hitZone(0.5, 0, 1.75)).toBe('limb');
    // Measured from THEIR feet, wherever those are.
    expect(hitZone(3 + 0.5, 3, 1.75)).toBe('limb');
    // The boundary itself is a leg, and a millimetre above it is not.
    expect(hitZone(LEG_ZONE * 1.75, 0, 1.75)).toBe('limb');
    expect(hitZone(LEG_ZONE * 1.75 + 0.001, 0, 1.75)).toBe('body');
  });

  it('makes a leg hit weaker than a chest hit and a chest weaker than a head', () => {
    expect(LIMB_MULTIPLIER).toBeLessThan(1);
    expect(HEAD_MULTIPLIER).toBeGreaterThan(1);
  });
});

// -- the effect a round on a person spends -------------------------------------

describe('a standard round on a civilian is not an explosion', () => {
  it('spends a small, fixed particle budget', () => {
    // Three specks. The number is the assertion: it used to be nine per
    // pellet, which is what "they explode" was describing.
    expect(impactBudget('body')).toBeLessThanOrEqual(4);
    // ...and no more than any of the hard surfaces throws.
    expect(impactBudget('body')).toBeLessThanOrEqual(impactBudget('concrete'));
  });

  it('draws one impact for one round, not a burst', () => {
    const crowd = new FakeCrowd();
    crowd.add(20, 0);
    const rig = build('pistol', camera(0, 0, -Math.PI / 2, EYE.chest), crowd);
    rig.frame();

    expect(rig.combat.fireOnce()).toBe(true);
    rig.frame();

    // One muzzle flash, one tracer, and the body's own three specks.
    expect(rig.combat.effects.stats.glows).toBe(2 + impactBudget('body'));
    // One blood mark, not eight.
    expect(rig.combat.effects.stats.marks).toBe(1);
    expect(rig.sounds).toEqual(['body']);
  });

  /*
   * THE SHOTGUN IS THE CASE THAT LOOKED LIKE A DETONATION.
   *
   * Eight pellets arriving on one chest in the same millisecond used to draw
   * eight impacts - 72 embers and 8 overlapping pools - and play eight body
   * sounds. It is one wound cluster.
   *
   * At two and a half metres the whole 0.10 rad pattern is inside a shoulder's
   * width, so every pellet is on the body and the shell is lethal on its own:
   * eight pellets of thirteen is a hundred and four.
   */
  it('coalesces a shotgun shell into one wound rather than eight', () => {
    const crowd = new FakeCrowd();
    crowd.add(2.5, 0);
    const rig = build('shotgun', camera(0, 0, -Math.PI / 2, EYE.chest), crowd);
    rig.frame();

    expect(rig.combat.fireOnce()).toBe(true);
    rig.frame();

    expect(rig.combat.stats.pelletsFired).toBe(WEAPONS.shotgun.pellets);
    // Every pellet still draws its own tracer - the pattern is visible - but
    // the wound is drawn once and heard once.
    expect(rig.sounds).toEqual(['body']);
    expect(rig.combat.effects.stats.marks).toBe(1);
    expect(rig.combat.effects.stats.glows).toBeLessThanOrEqual(
      1 + WEAPONS.shotgun.pellets + impactBudget('body'),
    );
    // One shell, one casualty, one call into the crowd.
    expect(rig.calls.downs).toHaveLength(1);
    expect(rig.targets.trackedCount).toBe(1);
    expect(rig.targets.downCount).toBe(1);
  });

  it('does not remove the body when the round lands', () => {
    const crowd = new FakeCrowd();
    const victim = crowd.add(2.5, 0);
    const rig = build('shotgun', camera(0, 0, -Math.PI / 2, EYE.chest), crowd);
    rig.frame();
    rig.combat.fireOnce();
    rig.frame();

    // Still drawn, and now drawn lying down. Nothing was deleted.
    expect(rig.combat.stats.civiliansKilled).toBe(1);
    expect(crowd.walkers).toContain(victim);
    expect(rig.targets.liveCount).toBe(1);
    expect(rig.targets.proneCount).toBe(1);
  });
});

// -- direction and contact point -----------------------------------------------

describe('a shot civilian is dropped where the round arrived, the way it was going', () => {
  /*
   * The four cardinal approaches onto one person standing at the origin
   * FACING NORTH - heading 0, which the crowd draws as facing `-(sin, cos)`,
   * that is straight down -Z.
   *
   * `forward` is `(-sin yaw, 0, -cos yaw)`, so the yaw that looks from the
   * west toward the origin is -PI/2 and the one that looks from the north is
   * PI. `fall` is what `Crowd.knockDown` does with the resulting blow: +1 over
   * backwards, -1 onto the face.
   */
  const approaches = [
    { name: 'in the chest, from the north', at: [0, -8], yaw: Math.PI, dir: [0, 1], fall: 1 },
    { name: 'in the back, from the south', at: [0, 8], yaw: 0, dir: [0, -1], fall: -1 },
    // Side on, where the two are equally plausible: which way they go is
    // decided by whichever side of square the weapon's own spread put the
    // round, and the assertion is that it is a legal topple rather than which.
    { name: 'side on, from the west', at: [-8, 0], yaw: -Math.PI / 2, dir: [1, 0], fall: 0 },
    { name: 'side on, from the east', at: [8, 0], yaw: Math.PI / 2, dir: [-1, 0], fall: 0 },
  ] as const;

  for (const approach of approaches) {
    it(`falls the way the round was going, hit ${approach.name}`, () => {
      const crowd = new FakeCrowd();
      crowd.add(0, 0, { heading: 0 });
      const view = camera(approach.at[0], approach.at[1], approach.yaw, EYE.chest);
      const rig = build('rifle', view, crowd);
      rig.frame();
      // The carbine needs three trunk hits.
      for (let i = 0; i < 8 && rig.calls.downs.length === 0; i += 1) {
        rig.combat.fireOnce();
        rig.frame(0.2);
      }

      expect(rig.calls.downs).toHaveLength(1);
      const blow = rig.calls.downs[0];
      const dirX = blow?.dirX ?? 0;
      const dirZ = blow?.dirZ ?? 0;
      // A unit vector pointing the way the round was travelling, to within the
      // weapon's own spread.
      expect(Math.hypot(dirX, dirZ)).toBeCloseTo(1, 5);
      expect(dirX * approach.dir[0] + dirZ * approach.dir[1]).toBeGreaterThan(0.99);
      if (approach.fall === 0) expect(Math.abs(blow?.fallSign ?? 0)).toBe(1);
      else expect(blow?.fallSign).toBe(approach.fall);
    });
  }

  it('reports the contact point rather than the victim’s feet', () => {
    const crowd = new FakeCrowd();
    crowd.add(6, 0);
    // A level round from a 1.2 m eye arrives in the chest, 1.2 m up. The old
    // code reported the instance origin instead, which is the pavement.
    const rig = build('rifle', camera(0, 0, -Math.PI / 2, EYE.chest), crowd);
    rig.frame();
    for (let i = 0; i < 8 && rig.calls.downs.length === 0; i += 1) {
      rig.combat.fireOnce();
      rig.frame(0.2);
    }

    const contact = rig.calls.downs[0];
    expect(contact).toBeDefined();
    expect(contact?.y).toBeCloseTo(EYE.chest, 1);
    expect(contact?.y).toBeGreaterThan(1);
    // Still within the shoulder of the person it belongs to, so the crowd's
    // one-metre search finds the right body.
    expect(Math.hypot((contact?.x ?? 0) - 6, contact?.z ?? 0)).toBeLessThan(1);
  });

  it('passes the contact point straight through `damage` when a caller has one', () => {
    const crowd = new FakeCrowd();
    crowd.add(0, 0);
    const { targets, calls } = wired(crowd);
    targets.refresh(1 / 60, 0, 0);
    const blow: Blow = { dirX: 1, dirZ: 0, speed: 3, x: 0.2, y: 1.3, z: -0.1, zone: 'body' };
    expect(targets.damage(0, 1000, blow)).toBe('killed');
    expect(calls.downs[0]).toMatchObject({ x: 0.2, y: 1.3, z: -0.1, dirX: 1, dirZ: 0 });
  });
});

// -- wounded, not killed --------------------------------------------------------

describe('a hit that does not kill still does something', () => {
  it('staggers a wounded civilian instead of ignoring them', () => {
    const crowd = new FakeCrowd();
    crowd.add(20, 0);
    const rig = build('pistol', camera(0, 0, -Math.PI / 2, EYE.chest), crowd);
    rig.frame();

    rig.combat.fireOnce();
    rig.frame();

    expect(rig.combat.stats.civiliansHurt).toBe(1);
    expect(rig.calls.staggers).toHaveLength(1);
    expect(rig.calls.downs).toHaveLength(0);
    expect(rig.calls.staggers[0]?.zone).toBe('body');
    // Staggered the way the round was travelling: due east.
    expect(rig.calls.staggers[0]?.dirX).toBeCloseTo(1, 2);
  });

  it('reports a leg hit as a limb, and a limb hit does less', () => {
    const crowd = new FakeCrowd();
    crowd.add(12, 0);
    // A level round from a 0.6 m eye is below the hip at every range.
    const rig = build('rifle', camera(0, 0, -Math.PI / 2, EYE.leg), crowd);
    rig.frame();
    rig.combat.fireOnce();
    rig.frame();

    expect(rig.calls.staggers).toHaveLength(1);
    expect(rig.calls.staggers[0]?.zone).toBe('limb');
    expect(rig.calls.downs).toHaveLength(0);

    // A carbine round in the trunk is 34 of 100 and three of them kill; in a
    // leg it is 20.4, and the fourth is still not enough.
    for (let i = 0; i < 3; i += 1) {
      rig.combat.fireOnce();
      rig.frame(0.2);
    }
    expect(rig.combat.stats.civiliansKilled).toBe(0);
    expect(rig.calls.downs).toHaveLength(0);
    // The fifth finishes it, and THAT is a fall rather than a stagger.
    rig.combat.fireOnce();
    rig.frame(0.2);
    expect(rig.calls.downs).toHaveLength(1);
  });
});

// -- the crowd hears it ---------------------------------------------------------

describe('gunfire is an event the street responds to', () => {
  it('raises an alarm for a shot that hits nothing at all', () => {
    const crowd = new FakeCrowd();
    crowd.add(60, 0);
    const rig = build('pistol', camera(0, 0, Math.PI / 2, EYE.chest), crowd);
    rig.frame();

    rig.combat.fireOnce();
    expect(rig.combat.stats.hits).toBe(0);
    expect(rig.calls.alarms).toHaveLength(1);
    expect(rig.calls.alarms[0]?.radius).toBe(WITNESS_RADIUS);
  });

  it('makes a burst one event rather than one per round', () => {
    const crowd = new FakeCrowd();
    crowd.add(60, 0);
    const rig = build('smg', camera(0, 0, Math.PI / 2, EYE.chest), crowd);
    rig.frame();

    // A full magazine at 780 rounds a minute is 2.3 seconds of fire.
    rig.combat.setTrigger(true);
    for (let i = 0; i < 150; i += 1) rig.frame();
    rig.combat.setTrigger(false);

    expect(rig.combat.stats.shotsFired).toBeGreaterThan(20);
    // Bounded by the throttle rather than by the rate of fire.
    expect(rig.calls.alarms.length).toBeLessThanOrEqual(10);
    expect(rig.calls.alarms.length).toBeGreaterThan(2);
  });
});

// -- persistence and cleanup ----------------------------------------------------

describe('somebody who takes a lethal hit stays down', () => {
  it('is still recorded as a casualty after a long interval with the player there', () => {
    const crowd = new FakeCrowd();
    crowd.add(2.5, 0);
    const rig = build('shotgun', camera(0, 0, -Math.PI / 2, EYE.chest), crowd);
    rig.frame();
    rig.combat.fireOnce();
    rig.frame();
    expect(rig.targets.downCount).toBe(1);

    // Five minutes, which is five times the crowd's own casualty timer.
    for (let t = 0; t < 300; t += 0.5) rig.frame(0.5);

    expect(rig.targets.downCount).toBe(1);
    expect(rig.targets.proneCount).toBe(1);
    // ...and cannot be shot, witnessed, or killed a second time.
    let seen = 0;
    rig.targets.forEachActor(2.5, 0, 20, () => { seen += 1; });
    expect(seen).toBe(0);
    expect(rig.targets.hasWitnessWithin(2.5, 0, 20)).toBe(false);
    expect(rig.targets.damage(0, 500)).toBe('none');
    expect(rig.calls.downs).toHaveLength(1);
  });

  it('is forgotten only after the documented delay AND the documented distance', () => {
    const crowd = new FakeCrowd();
    crowd.add(0, 0);
    const { targets } = wired(crowd);
    targets.refresh(1 / 60, 0, 0);
    expect(targets.damage(0, 500, { dirX: 1, dirZ: 0, speed: 0 })).toBe('killed');
    expect(targets.downCount).toBe(1);

    // Long past the delay, but the player is standing over the body.
    for (let t = 0; t < BODY_MEMORY * 2; t += 0.5) targets.refresh(0.5, 0, 0);
    expect(targets.downCount).toBe(1);

    // The other half of the rule - far enough away but not yet old enough -
    // is the next test. Here both conditions are met: one more refresh from
    // across the district is all it takes once the record has served its time.
    targets.refresh(0.5, BODY_FORGET_DISTANCE + 5, 0);
    expect(targets.downCount).toBe(0);
    expect(targets.trackedCount).toBe(0);
  });

  it('keeps a fresh casualty even when the player is a district away', () => {
    const crowd = new FakeCrowd();
    crowd.add(0, 0);
    const { targets } = wired(crowd);
    targets.refresh(1 / 60, 0, 0);
    targets.damage(0, 500, { dirX: 1, dirZ: 0, speed: 0 });
    for (let t = 0; t < BODY_MEMORY - 5; t += 0.5) {
      targets.refresh(0.5, BODY_FORGET_DISTANCE + 50, 0);
    }
    expect(targets.downCount).toBe(1);
  });

  it('never lets a corpse become a target again, whatever the record says', () => {
    // The record list is deliberately overflowed so the casualty's record is
    // recycled. Being on the ground is read from the DRAW CALL, so the body
    // stays a body regardless.
    const crowd = new FakeCrowd(128);
    crowd.add(0, 0);
    const { targets } = wired(crowd);
    targets.refresh(1 / 60, 0, 0);
    targets.damage(0, 500, { dirX: 1, dirZ: 0, speed: 0 });

    for (let i = 1; i <= MAX_TRACKED + 8; i += 1) {
      crowd.add(i * 3, 0);
      targets.refresh(1 / 60, 0, 0);
      targets.damage(i, 10, { dirX: 1, dirZ: 0, speed: 0 });
    }
    targets.refresh(1 / 60, 0, 0);

    expect(targets.trackedCount).toBeLessThanOrEqual(MAX_TRACKED);
    let seen = 0;
    targets.forEachActor(0, 0, 1, () => { seen += 1; });
    expect(seen, 'a body on the pavement was offered as a target').toBe(0);
    expect(targets.damage(0, 500)).toBe('none');
  });

  it('does not shadow somebody standing beside a body', () => {
    // Half a metre apart: inside the radius a WALKING record claims, outside
    // the one a casualty claims. The crowd keeps 0.85 m of clearance around a
    // body, so this is closer than anybody should ever actually get.
    const crowd = new FakeCrowd();
    crowd.add(0, 0);
    crowd.add(0.5, 0);
    const { targets } = wired(crowd);
    targets.refresh(1 / 60, 0, 0);
    expect(targets.damage(0, 500, { dirX: 1, dirZ: 0, speed: 0 })).toBe('killed');
    targets.refresh(1 / 60, 0, 0);

    let seen = 0;
    targets.forEachActor(0.5, 0, 0.2, () => { seen += 1; });
    expect(seen, 'the neighbour was hidden behind a corpse’s record').toBe(1);
    expect(targets.hasWitnessWithin(0.5, 0, 0.2)).toBe(true);
    expect(targets.damage(1, 10, { dirX: 1, dirZ: 0, speed: 0 })).toBe('hurt');
  });

  it('does not hand a casualty’s record to somebody walking past it', () => {
    const crowd = new FakeCrowd();
    crowd.add(0, 0);
    const passerby = crowd.add(3, 0);
    const { targets } = wired(crowd);
    targets.refresh(1 / 60, 0, 0);
    targets.damage(0, 500, { dirX: 1, dirZ: 0, speed: 0 });
    expect(targets.downCount).toBe(1);

    // They walk over the body and away again. A record that followed "the
    // nearest body" would go with them and delete them from the game.
    for (let step = 0; step <= 40; step += 1) {
      passerby.x = 3 - step * 0.15;
      crowd.write();
      targets.refresh(1 / 60, 0, 0);
    }

    expect(targets.downCount).toBe(1);
    let seen = 0;
    targets.forEachActor(passerby.x, passerby.z, 2, () => { seen += 1; });
    expect(seen, 'a living pedestrian inherited a corpse’s record').toBe(1);
  });
});

// -- budgets --------------------------------------------------------------------

describe('nothing grows without a ceiling under sustained fire', () => {
  it('holds the casualty list, the body list and both effect pools', () => {
    const crowd = new FakeCrowd(128);
    // A dense line of people straight down the barrel.
    for (let i = 0; i < 60; i += 1) crowd.add(4 + i * 1.4, 0);
    const rig = build('rifle', camera(0, 0, -Math.PI / 2, EYE.chest), crowd);

    rig.combat.setTrigger(true);
    for (let i = 0; i < 900; i += 1) {
      rig.frame();
      expect(rig.targets.trackedCount).toBeLessThanOrEqual(MAX_TRACKED);
      expect(rig.combat.effects.stats.glows).toBeLessThanOrEqual(FX_CAPACITY.glows);
      expect(rig.combat.effects.stats.marks).toBeLessThanOrEqual(FX_CAPACITY.marks);
    }
    rig.combat.setTrigger(false);

    expect(rig.combat.stats.shotsFired).toBeGreaterThan(50);
    expect(rig.combat.stats.civiliansKilled).toBeGreaterThan(0);
    // The body list is the crowd's own instance count and never exceeds it.
    expect(rig.targets.liveCount).toBe(crowd.walkers.length);
  });
});
