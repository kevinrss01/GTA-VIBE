/**
 * What a shot ARRIVES on, and what it does when it gets there.
 *
 * Six defects are pinned here, every one of them reported rather than imagined,
 * and every one of them a case where the game registered a hit and then did
 * nothing anybody could see:
 *
 *  - A shot officer was spliced out of the world in the same `update` that
 *    killed them, and `writeVisuals` only ever drew officers who were chasing.
 *    They vanished on the frame they died, from a game whose civilians lie in
 *    the road for a minute.
 *  - Recoil was rotated onto the camera AFTER the shot had been cast from it,
 *    so the frame the player looked at was rotated relative to the bullet that
 *    left in it - and, because the controller rewrites the camera absolutely
 *    every frame, the aim itself never moved at all.
 *  - The broad phase asked the traffic system for vehicles whose CENTRE was
 *    within the shot's own length. A rocket steps 0.77 m per frame and a
 *    saloon's centre is 2.44 m behind its nose, so a rocket flew through cars.
 *  - An explosion skipped every vehicle that was not a police car, and
 *    measured the ones it did not skip centre to centre.
 *  - Every wall, kerb, lamp post and shopfront in the city threw the same pale
 *    stone dust, because one line hard-set the impact to `world`.
 *  - A head shot left its blood pool at a fixed drop below the wound, which for
 *    a head is most of a metre above the pavement.
 *
 * No renderer. The instance buffers the officer rig writes are read directly,
 * which is the only honest way to assert that a body is DRAWN rather than that
 * a counter went up.
 */

import { InstancedMesh, PerspectiveCamera, Vector3, type Object3D } from 'three';
import { describe, expect, it } from 'vitest';

import { buildRoadNetwork, lanePoint, type RoadNetwork } from '../src/city/RoadNetwork';
import { impactSound, surfaceImpact } from '../src/combat/CombatFx';
import {
  CombatSystem,
  type CombatVehicleView,
  type VehicleImpact,
} from '../src/combat/CombatSystem';
import { nearestPointOnOrientedBox, WorldRayIndex } from '../src/combat/rays';
import type { ActorSource, ActorTarget, Blow, DamageResult } from '../src/combat/targets';
import { CollisionWorld } from '../src/player/Collision';
import { PlayerState, WEAPONS, type WeaponId } from '../src/player/PlayerState';
import { PoliceSystem, type PoliceContext } from '../src/police/PoliceSystem';
import { FALL_TIME } from '../src/police/OfficerRig';
import type { ChassisSpec, VehicleHandle, VehicleKind, VehicleView } from '../src/traffic/types';
import { getCityPlan } from '../src/world/CityPlan';
import type { ColliderBox } from '../src/world/build/types';

// -- shared doubles -----------------------------------------------------------

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
  readonly blows: (Blow | undefined)[] = [];

  add(x: number, y: number, z: number, height = 1.75, radius = 0.32): StubBody {
    const body: StubBody = { id: this.bodies.length, x, y, z, radius, height, health: 100 };
    this.bodies.push(body);
    return body;
  }

  refresh(): void {
    /* stub bodies do not move */
  }

  hasWitnessWithin(): boolean {
    return false;
  }

  forEachActor(x: number, z: number, radius: number, visit: (t: ActorTarget) => void): void {
    for (const body of this.bodies) {
      if (body.health <= 0) continue;
      if (Math.hypot(body.x - x, body.z - z) > radius) continue;
      visit({ ...body, faction: 'civilian' });
    }
  }

  damage(id: number, amount: number, blow?: Blow): DamageResult {
    const body = this.bodies[id];
    if (!body || body.health <= 0) return 'none';
    // Copied: the caller reuses one blow object per hit, by design.
    this.blows.push(blow ? { ...blow } : undefined);
    body.health -= amount;
    return body.health > 0 ? 'hurt' : 'killed';
  }
}

/**
 * A fleet with the traffic system's own broad phase.
 *
 * `forEachNear` matching CENTRES is not an approximation of `TrafficSim`; it is
 * exactly what `TrafficSim.forEachNear` does, and reproducing it is the whole
 * point - the defect only exists because the combat layer passed a radius that
 * assumed otherwise.
 */
class CentreFleet {
  readonly views: CombatVehicleView[] = [];
  readonly impacts: { id: number; hit: VehicleImpact }[] = [];
  readonly shots: { id: number; amount: number }[] = [];

  add(view: CombatVehicleView): CombatVehicleView {
    this.views.push(view);
    return view;
  }

  forEachNear(x: number, z: number, radius: number, visit: (v: CombatVehicleView) => void): void {
    for (const view of this.views) {
      if (Math.hypot(view.x - x, view.z - z) <= radius) visit(view);
    }
  }

  applyImpact(id: number, hit: VehicleImpact): boolean {
    const view = this.views.find((v) => v.id === id);
    if (!view) return false;
    this.impacts.push({ id, hit: { ...hit } });
    return true;
  }

  applyDamage(id: number, amount: number): boolean {
    const view = this.views.find((v) => v.id === id);
    if (!view) return false;
    this.shots.push({ id, amount });
    return true;
  }

  damageFor(id: number): number {
    let total = 0;
    for (const impact of this.impacts) if (impact.id === id) total += impact.hit.damage;
    return total;
  }
}

/** A camera at eye height on flat ground, looking due east (+X). */
function eastwardCamera(x = 0, y = 1.68, z = 0, pitch = 0): PerspectiveCamera {
  const camera = new PerspectiveCamera(70, 1.6, 0.1, 1000);
  camera.position.set(x, y, z);
  camera.rotation.set(pitch, -Math.PI / 2, 0, 'YXZ');
  camera.updateMatrixWorld(true);
  return camera;
}

const FLAT = (): number => 0;

function armed(id: WeaponId, rounds = 400): PlayerState {
  const player = new PlayerState();
  player.earn(500_000);
  player.buyWeapon(id);
  while (player.ammo(id) < rounds) {
    if (!player.buyAmmo(id)) break;
  }
  player.equip(id);
  return player;
}

function idle(): {
  driving: boolean;
  playerX: number;
  playerY: number;
  playerZ: number;
  playerSpeed: number;
} {
  return { driving: false, playerX: 0, playerY: 0, playerZ: 0, playerSpeed: 0 };
}

function build(options: {
  player: PlayerState;
  camera: PerspectiveCamera;
  crowd?: StubCrowd;
  fleet?: CentreFleet;
  boxes?: readonly ColliderBox[];
  recoil?: { addRecoil(pitch: number, yaw: number): void };
  onImpact?: (kind: string, x: number, y: number, z: number) => void;
  onExplosion?: (x: number, y: number, z: number, radius: number, distance: number) => void;
}): CombatSystem {
  return new CombatSystem({
    player: options.player,
    camera: options.camera,
    domElement: inertElement(),
    world: new WorldRayIndex(options.boxes ?? []),
    heightAt: FLAT,
    ...(options.crowd ? { civilians: options.crowd } : {}),
    ...(options.fleet ? { vehicles: options.fleet } : {}),
    ...(options.recoil ? { recoil: options.recoil } : {}),
    ...(options.onImpact ? { onImpact: options.onImpact } : {}),
    ...(options.onExplosion ? { onExplosion: options.onExplosion } : {}),
    seed: 'combat-impacts',
  });
}

// -- DEFECT: a shot officer vanished on the frame they died -------------------

const plan = getCityPlan();
const network: RoadNetwork = buildRoadNetwork(plan);

const CHASSIS: ChassisSpec = {
  length: 4.88, width: 1.92, height: 1.5, wheelbase: 2.94, track: 1.64,
  wheelRadius: 0.35, frontAxle: 1.62, mass: 1780, maxSteer: 0.62, steerRate: 2.4,
  accelMax: 3.54, brakeMax: 8, gripLateral: 7,
};

interface MutableView {
  id: number;
  kind: VehicleKind;
  police: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  halfLength: number;
  halfWidth: number;
  halfHeight: number;
  speed: number;
  pitch: number;
  roll: number;
  braking: boolean;
  control: 'ambient' | 'player';
}

class PatrolFleet {
  readonly views: MutableView[] = [];

  constructor(count: number, distance = 400) {
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      this.views.push({
        id: 100 + i,
        kind: 'patrolSedan',
        police: true,
        x: Math.cos(angle) * distance,
        y: 0.75,
        z: Math.sin(angle) * distance,
        yaw: 0,
        halfLength: 2.44,
        halfWidth: 0.96,
        halfHeight: 0.75,
        speed: 0,
        pitch: 0,
        roll: 0,
        braking: false,
        control: 'ambient',
      });
    }
  }

  get vehicles(): readonly VehicleView[] {
    return this.views as unknown as readonly VehicleView[];
  }

  takeControl(id: number): VehicleHandle | null {
    const view = this.views.find((v) => v.id === id && v.control === 'ambient');
    if (!view) return null;
    view.control = 'player';
    return {
      id: view.id,
      kind: view.kind,
      view: view as unknown as VehicleView,
      chassis: CHASSIS,
      setPose: (pose) => {
        view.x = pose.x;
        view.z = pose.z;
        view.yaw = pose.yaw;
        view.speed = pose.speed;
      },
      release: () => this.releaseControl(view.id),
    };
  }

  releaseControl(id: number): void {
    const view = this.views.find((v) => v.id === id);
    if (view) view.control = 'ambient';
  }
}

function onTheRoad(): { x: number; z: number } {
  const lane = network.lanes[40] ?? network.lanes[0];
  if (!lane) throw new Error('the city has no lanes');
  return lanePoint(lane, lane.length * 0.5);
}

function policeContext(x: number, z: number, extra: Partial<PoliceContext> = {}): PoliceContext {
  return {
    time: 0,
    playerX: x,
    playerY: 0,
    playerZ: z,
    playerSpeed: 0,
    forwardX: 0,
    forwardZ: -1,
    driving: false,
    ...extra,
  };
}

function pinStars(player: PlayerState, stars: number): void {
  player.clearHeat();
  if (stars <= 0) return;
  let guard = 0;
  while (player.wanted < stars && guard < 2000) {
    player.addHeat(1);
    guard += 1;
  }
}

/** Runs the pursuit on a continuous clock and returns where it stopped. */
function run(
  police: PoliceSystem,
  player: PlayerState,
  stars: number,
  seconds: number,
  at: { x: number; z: number },
  from = 0,
): number {
  const dt = 1 / 30;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i += 1) {
    pinStars(player, stars);
    police.update(dt, policeContext(at.x, at.z, { time: from + i * dt }));
  }
  return from + steps * dt;
}

/**
 * Every officer instance the rig actually wrote, straight out of the buffer.
 *
 * `m[5]` is the vertical scale times cos(tilt) and `m[9]` is -girth*sin(tilt),
 * so a body is distinguishable from a standing officer in the matrix itself -
 * which is the point: the topple is folded into the SAME instance the walk
 * cycle uses, and costs no extra draw call.
 */
function drawnOfficers(group: Object3D): { x: number; y: number; z: number; tilt: number }[] {
  const out: { x: number; y: number; z: number; tilt: number }[] = [];
  group.traverse((child: Object3D) => {
    if (!(child instanceof InstancedMesh)) return;
    if (!child.name.startsWith('police-officers')) return;
    const m = child.instanceMatrix.array as ArrayLike<number>;
    for (let i = 0; i < child.count; i += 1) {
      const o = i * 16;
      const girth = Math.hypot(m[o] ?? 1, m[o + 2] ?? 0) || 1;
      out.push({
        x: m[o + 12] ?? 0,
        y: m[o + 13] ?? 0,
        z: m[o + 14] ?? 0,
        // -girth * sin(tilt) over girth is -sin(tilt).
        tilt: Math.asin(Math.max(-1, Math.min(1, -(m[o + 9] ?? 0) / girth))),
      });
    }
  });
  return out;
}

function makePolice(player: PlayerState, fleet: PatrolFleet): PoliceSystem {
  return new PoliceSystem({
    player,
    traffic: fleet,
    network,
    collision: new CollisionWorld([]),
    world: new WorldRayIndex([]),
    heightAt: () => 0,
    quality: 'low',
    seed: 'police-bodies',
  });
}

/** Runs a pursuit until somebody is on the pavement, and shoots one of them. */
function downOneOfficer(): {
  police: PoliceSystem;
  player: PlayerState;
  spot: { x: number; z: number };
  clock: number;
  victim: number;
} {
  const player = new PlayerState();
  const fleet = new PatrolFleet(8);
  const police = makePolice(player, fleet);
  const spot = onTheRoad();
  const clock = run(police, player, 3, 60, spot);
  expect(police.stats.officers).toBeGreaterThan(0);

  let victim = -1;
  police.forEachActor(spot.x, spot.z, 200, (target) => {
    if (victim < 0) victim = target.id;
  });
  expect(victim).toBeGreaterThan(0);
  // Shot from the north, travelling south, which is where they fall.
  expect(police.damage(victim, 500, { dirX: 0, dirZ: 1, speed: 3 })).toBe('killed');
  return { police, player, spot, clock, victim };
}

describe('a shot officer', () => {
  it('is still in the world, and still drawn, on the frame after they die', () => {
    const { police, player, spot, clock } = downOneOfficer();
    expect(police.stats.officersDown).toBe(1);
    expect(police.stats.bodies).toBe(1);

    // One frame of the whole system, which is what used to delete them: the
    // splice ran in `updateOfficers` and `writeVisuals` ran afterwards.
    pinStars(player, 3);
    police.update(1 / 30, policeContext(spot.x, spot.z, { time: clock }));
    expect(police.stats.bodies).toBe(1);

    const drawn = drawnOfficers(police.group);
    expect(drawn.length).toBe(police.stats.officers + 1);
    // A body is on the ground and a standing officer is not, and the two are
    // in the same instance buffer.
    const toppling = drawn.filter((pose) => Math.abs(pose.tilt) > 1e-3);
    expect(toppling).toHaveLength(1);
    police.dispose();
  });

  it('falls over the length of the crowd’s own fall and then lies still', () => {
    const { police, player, spot, clock } = downOneOfficer();
    const dt = 1 / 60;
    let now = clock;

    const tiltAfter = (seconds: number): number => {
      const steps = Math.round(seconds / dt);
      for (let i = 0; i < steps; i += 1) {
        pinStars(player, 3);
        police.update(dt, policeContext(spot.x, spot.z, { time: now }));
        now += dt;
      }
      const body = drawnOfficers(police.group).find((pose) => Math.abs(pose.tilt) > 1e-3);
      return Math.abs(body?.tilt ?? 0);
    };

    const early = tiltAfter(FALL_TIME * 0.4);
    const settled = tiltAfter(FALL_TIME);
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(settled);
    // Flat out, and it stays flat out rather than easing back up.
    expect(settled).toBeCloseTo(Math.PI * 0.5, 3);
    expect(tiltAfter(4)).toBeCloseTo(Math.PI * 0.5, 3);
    police.dispose();
  });

  it('cannot be shot again, and is not a witness', () => {
    const { police, spot, victim } = downOneOfficer();
    let stillATarget = false;
    police.forEachActor(spot.x, spot.z, 300, (target) => {
      if (target.id === victim) stillATarget = true;
    });
    expect(stillATarget).toBe(false);
    expect(police.damage(victim, 200)).toBe('none');
    police.dispose();
  });

  it('lies there for a minute, and only leaves once the player has walked away', () => {
    const { police, player, spot, clock } = downOneOfficer();
    const dt = 1 / 10;
    let now = clock;
    // Fifty seconds of being stood over: still there.
    for (let i = 0; i < 500; i += 1) {
      pinStars(player, 3);
      police.update(dt, policeContext(spot.x, spot.z, { time: now }));
      now += dt;
    }
    expect(police.stats.bodies).toBe(1);

    // Past the minute, and still being looked at from close range: still there.
    for (let i = 0; i < 200; i += 1) {
      pinStars(player, 3);
      police.update(dt, policeContext(spot.x, spot.z, { time: now }));
      now += dt;
    }
    expect(police.stats.bodies).toBe(1);

    // The player walks away. Now it may go.
    for (let i = 0; i < 20; i += 1) {
      pinStars(player, 3);
      police.update(dt, policeContext(spot.x + 120, spot.z, { time: now }));
      now += dt;
    }
    expect(police.stats.bodies).toBe(0);
    police.dispose();
  });

  it('falls away from the shot rather than always the same way', () => {
    const player = new PlayerState();
    const fleet = new PatrolFleet(8);
    const police = makePolice(player, fleet);
    const spot = onTheRoad();
    run(police, player, 4, 90, spot);

    const found: { id: number; x: number; z: number }[] = [];
    police.forEachActor(spot.x, spot.z, 300, (target) => {
      found.push({ id: target.id, x: target.x, z: target.z });
    });
    expect(found.length).toBeGreaterThanOrEqual(2);

    const first = found[0];
    const second = found[1];
    if (!first || !second) throw new Error('needed two officers on foot');
    // An officer on foot faces the player, so a round coming FROM the player
    // is a blow against their facing and puts them over backwards, and one
    // from behind them puts them onto their face. Same weapon, same officers,
    // opposite directions: the signs have to differ.
    const away = (o: { x: number; z: number }): { dirX: number; dirZ: number; speed: number } => {
      const dx = o.x - spot.x;
      const dz = o.z - spot.z;
      const d = Math.hypot(dx, dz) || 1;
      return { dirX: dx / d, dirZ: dz / d, speed: 3 };
    };
    const behind = away(second);
    police.damage(first.id, 500, away(first));
    police.damage(second.id, 500, { dirX: -behind.dirX, dirZ: -behind.dirZ, speed: 3 });
    police.update(1 / 60, policeContext(spot.x, spot.z, { time: 91 }));

    const tilts = drawnOfficers(police.group)
      .map((pose) => pose.tilt)
      .filter((tilt) => Math.abs(tilt) > 1e-4);
    expect(tilts).toHaveLength(2);
    expect(Math.sign(tilts[0] ?? 0)).not.toBe(Math.sign(tilts[1] ?? 0));
    police.dispose();
  });
});

// -- DEFECT: the shot did not leave from the pose the player was looking at ---

describe('recoil and the shot', () => {
  /*
   * The pose the pellet was cast from is captured at the moment damage lands,
   * which is inside `pullTrigger`; the pose the player looks at is the camera
   * when `update` returns. Before the fix the kick was rotated on between those
   * two points, so a burst rendered one pose and shot from another.
   */
  it('casts from exactly the pose the frame is rendered with', () => {
    const player = armed('rifle');
    const camera = eastwardCamera();
    // A wall, because a wall cannot die and stop reporting. The direction the
    // camera is pointing is read at the moment the round ARRIVES, which is
    // inside the trigger pull, and again when the frame is finished.
    const boxes: ColliderBox[] = [
      { minX: 40, maxX: 42, minZ: -40, maxZ: 40, bottom: -40, top: 60, solid: true },
    ];
    const atShot: number[] = [];
    const probe = new Vector3();
    const combat = build({
      player,
      camera,
      boxes,
      onImpact: () => {
        atShot.push(camera.getWorldDirection(probe).y);
      },
    });

    // The controller rewrites the camera quaternion absolutely every frame and
    // the combat layer's own kick is applied on top of it; without a stand-in
    // for that write the rotations would pile up frame on frame. This is that
    // write, and it is the only thing `main.ts` does that matters here.
    const base = camera.quaternion.clone();

    combat.setTrigger(true);
    let compared = 0;
    let mismatch = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      atShot.length = 0;
      camera.quaternion.copy(base);
      camera.updateMatrixWorld(true);
      combat.update(1 / 60, idle());
      if (atShot.length === 0) continue;
      const rendered = camera.getWorldDirection(probe).y;
      for (const y of atShot) {
        compared += 1;
        if (Math.abs(y - rendered) > 1e-9) mismatch += 1;
      }
    }
    expect(combat.stats.shotsFired).toBeGreaterThan(4);
    expect(compared).toBeGreaterThan(4);
    expect(mismatch, 'the rendered pose and the cast pose disagreed').toBe(0);
    combat.dispose();
  });

  /*
   * ...and the pose really does move, so the test above is not passing because
   * nothing ever happens. Held with no sink, the kick is this system's own and
   * it rotates the camera; the shot climbs with it.
   */
  it('really does climb, so agreeing is not the same as standing still', () => {
    const player = armed('rifle');
    const camera = eastwardCamera();
    const probe = new Vector3();
    const combat = build({ player, camera });
    const level = camera.getWorldDirection(probe).y;
    const base = camera.quaternion.clone();
    const frame = (): void => {
      camera.quaternion.copy(base);
      camera.updateMatrixWorld(true);
      combat.update(1 / 60, idle());
    };

    combat.setTrigger(true);
    for (let i = 0; i < 30; i += 1) frame();
    expect(camera.getWorldDirection(probe).y).toBeGreaterThan(level + 0.01);

    combat.setTrigger(false);
    for (let i = 0; i < 240; i += 1) frame();
    expect(Math.abs(camera.getWorldDirection(probe).y - level)).toBeLessThan(2e-3);
    combat.dispose();
  });

  it('climbs through a burst and comes back down, in the aim and not the picture', () => {
    const kicks: number[] = [];
    let held = 0;
    const sink = {
      addRecoil: (pitch: number): void => {
        kicks.push(pitch);
        held += pitch;
      },
    };
    const player = armed('rifle');
    const camera = eastwardCamera();
    const before = camera.quaternion.clone();
    const combat = build({ player, camera, recoil: sink });

    combat.setTrigger(true);
    for (let frame = 0; frame < 30; frame += 1) combat.update(1 / 60, idle());
    expect(kicks.length).toBeGreaterThan(3);
    // Accumulating: several rounds have each pushed the aim up.
    expect(held).toBeGreaterThan((kicks[0] ?? 0) * 2);
    // ...and the camera itself was never touched, because the owner of the aim
    // composes the offset into its own absolute write.
    expect(camera.quaternion.angleTo(before)).toBe(0);
    combat.dispose();
  });

  it('leaves the camera where it found it when nothing is firing', () => {
    const player = armed('pistol');
    const camera = eastwardCamera();
    const combat = build({ player, camera });
    const before = camera.quaternion.clone();
    for (let frame = 0; frame < 10; frame += 1) combat.update(1 / 60, idle());
    expect(camera.quaternion.angleTo(before)).toBe(0);
    combat.dispose();
  });
});

/*
 * The controller half of the same defect.
 *
 * `FirstPersonController` writes the camera quaternion ABSOLUTELY from its own
 * pitch and yaw every frame, which is why a kick applied to the camera by
 * somebody else cannot survive: the next frame overwrites it. Held as the
 * controller's own offset it is part of the aim, and it recovers.
 *
 * The constructor binds window and document listeners, so this is the one test
 * here that needs those to exist. Stubbing the two calls it makes is a great
 * deal less machinery than a DOM, and it is removed again afterwards so nothing
 * else in this file sees a browser that is not there.
 */
describe('the controller owns the kick', () => {
  it('adds it to the aim, and gives it back', async () => {
    const globals = globalThis as unknown as Record<string, unknown>;
    const hadWindow = 'window' in globals;
    const hadDocument = 'document' in globals;
    const listener = {
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
      pointerLockElement: null,
    };
    if (!hadWindow) globals.window = listener;
    if (!hadDocument) globals.document = listener;

    try {
      const { FirstPersonController } = await import('../src/player/FirstPersonController');
      const { CityGround } = await import('../src/world/CityGround');
      const camera = new PerspectiveCamera(70, 1.6, 0.1, 1000);
      const probe = new Vector3();
      const controller = new FirstPersonController({
        ground: new CityGround(plan),
        collision: new CollisionWorld([]),
        camera,
        domElement: inertElement(),
        spawn: plan.spawn,
      });

      controller.update(1 / 60);
      const level = camera.getWorldDirection(probe).y;

      controller.addRecoil(0.08, 0);
      controller.update(1 / 60);
      const kicked = camera.getWorldDirection(probe).y;
      // The view really is pointing higher, which is what makes recoil a thing
      // the player has to fight rather than a thing they watch.
      expect(kicked).toBeGreaterThan(level + 0.05);
      expect(controller.state.recoilPitch).toBeGreaterThan(0.06);

      for (let i = 0; i < 180; i += 1) controller.update(1 / 60);
      expect(controller.state.recoilPitch).toBeLessThan(1e-3);
      const recovered = camera.getWorldDirection(probe).y;
      expect(Math.abs(recovered - level)).toBeLessThan(2e-3);

      // A ceiling, so a held burst cannot walk the crosshair into the sky.
      for (let i = 0; i < 40; i += 1) controller.addRecoil(0.05, 0.05);
      expect(controller.state.recoilPitch).toBeLessThanOrEqual(0.2 + 1e-9);
      expect(controller.state.recoilYaw).toBeLessThanOrEqual(0.06 + 1e-9);

      controller.dispose();
    } finally {
      if (!hadWindow) delete globals.window;
      if (!hadDocument) delete globals.document;
    }
  });
});

// -- DEFECT: rockets flew through cars ---------------------------------------

describe('a rocket and a car', () => {
  it('hits a saloon whose centre is further away than one frame of flight', () => {
    const player = armed('launcher', 6);
    const fleet = new CentreFleet();
    // Nose north, so the shot from the west meets its 0.96 m flank at x=21.04.
    // Its CENTRE is 22 m out; a frame of flight at 46 m/s is 0.77 m. Asking the
    // fleet for vehicles within 0.77 m of the rocket never saw it at all.
    fleet.add({
      id: 3, police: false, x: 22, y: 0.75, z: 0, yaw: 0,
      halfLength: 2.44, halfWidth: 0.96, halfHeight: 0.75,
    });
    const blasts: { x: number; z: number }[] = [];
    const combat = build({
      player,
      camera: eastwardCamera(0, 0.75, 0),
      fleet,
      onExplosion: (x, _y, z) => blasts.push({ x, z }),
    });

    expect(combat.fireOnce()).toBe(true);
    for (let frame = 0; frame < 120 && blasts.length === 0; frame += 1) {
      combat.update(1 / 60, idle());
    }
    expect(blasts, 'the rocket flew straight through the car').toHaveLength(1);
    // Arrived at the near flank, not at the far side of the street.
    expect(blasts[0]?.x ?? 0).toBeGreaterThan(20.5);
    expect(blasts[0]?.x ?? 0).toBeLessThan(21.6);
    // ...and the car was damaged by the direct arrival, not merely lit up.
    expect(fleet.damageFor(3)).toBeGreaterThan(0);
    combat.dispose();
  });

  it('leaves the tube on the crosshair’s line, not parallel to it', () => {
    const player = armed('launcher', 6);
    // A wall close enough that the weapon's own 0.014 rad of spread is 0.06 m,
    // which is a third of the 0.17 m the muzzle sits to the right of the eye.
    // Fired along the CAMERA's direction from the muzzle, the rocket runs down
    // a line parallel to the crosshair and 0.17 m off it, at every range - so
    // it arrives at z = 0.17 rather than at what the player was pointing at.
    const boxes: ColliderBox[] = [
      { minX: 4, maxX: 6, minZ: -6, maxZ: 6, bottom: 0, top: 8, solid: true },
    ];
    const blasts: { x: number; y: number; z: number }[] = [];
    const combat = build({
      player,
      camera: eastwardCamera(0, 1.68, 0),
      boxes,
      onExplosion: (x, y, z) => blasts.push({ x, y, z }),
    });

    expect(combat.fireOnce()).toBe(true);
    for (let frame = 0; frame < 120 && blasts.length === 0; frame += 1) {
      combat.update(1 / 60, idle());
    }
    expect(blasts).toHaveLength(1);
    expect(blasts[0]?.x ?? 0).toBeCloseTo(4, 1);
    // On the crosshair's line, not the muzzle's: 0.17 m away would be outside
    // anything the spread can explain.
    expect(Math.abs(blasts[0]?.z ?? 1)).toBeLessThan(0.09);
    combat.dispose();
  });
});

// -- DEFECT: explosions left ordinary cars untouched --------------------------

describe('a detonation and the street', () => {
  it('reaches an ordinary truck whose centre is outside the radius', () => {
    const player = armed('launcher', 3);
    const fleet = new CentreFleet();
    // A box truck lying east-west. Its centre is 12 m from the blast, well
    // outside the 9.5 m radius; its tail is 8.65 m away, comfortably inside
    // it. Centre to centre said nothing happened here, while the truck was
    // standing in the fireball - and being an ordinary truck rather than a
    // patrol car, it was never even asked.
    fleet.add({
      id: 11, police: false, x: 12, y: 1.46, z: 0, yaw: -Math.PI / 2,
      halfLength: 3.35, halfWidth: 1.07, halfHeight: 1.46,
    });
    const combat = build({ player, camera: eastwardCamera(), fleet });

    combat.detonate(0, 1, 0);
    expect(fleet.impacts).toHaveLength(1);
    const hit = fleet.impacts[0]?.hit;
    expect(hit?.damage ?? 0).toBeGreaterThan(0);
    expect(hit?.impulse ?? 0).toBeGreaterThan(0);
    // Pushed away from the blast, along the line to the truck.
    expect(hit?.dirX).toBeCloseTo(1, 6);
    expect(hit?.dirZ).toBeCloseTo(0, 6);
    // The contact point is on the box, not at its centre.
    const contact = nearestPointOnOrientedBox(
      0, 1, 0, 12, 1.46, 0, -Math.PI / 2, 3.35, 1.07, 1.46,
      { x: 0, y: 0, z: 0, distance: 0 },
    );
    expect(contact.x).toBeCloseTo(8.65, 5);
    expect(contact.distance).toBeCloseTo(8.65, 5);
    expect(hit?.x).toBeCloseTo(contact.x, 5);
    combat.dispose();
  });

  it('throws a car it lands beside', () => {
    const player = armed('launcher', 3);
    const fleet = new CentreFleet();
    fleet.add({
      id: 9, police: false, x: 6, y: 0.75, z: 0, yaw: -Math.PI / 2,
      halfLength: 2.44, halfWidth: 0.96, halfHeight: 0.75,
    });
    const combat = build({ player, camera: eastwardCamera(), fleet });

    combat.detonate(0, 1, 0);
    const hit = fleet.impacts[0]?.hit;
    expect(hit).toBeDefined();
    // Inside the first third of the radius, so the whole warhead: a saloon
    // masses 1 780 kg and this has to actually move one.
    expect(hit?.damage ?? 0).toBeGreaterThan(150);
    expect((hit?.impulse ?? 0) / 1780).toBeGreaterThan(1);
    combat.dispose();
  });

  it('leaves a car outside the radius alone', () => {
    const player = armed('launcher', 3);
    const fleet = new CentreFleet();
    fleet.add({
      id: 12, police: false, x: 40, y: 0.75, z: 0, yaw: 0,
      halfLength: 2.44, halfWidth: 0.96, halfHeight: 0.75,
    });
    const combat = build({ player, camera: eastwardCamera(), fleet });
    combat.detonate(0, 1, 0);
    expect(fleet.impacts).toHaveLength(0);
    combat.dispose();
  });

  it('throws the people it kills away from the seat of the blast', () => {
    const player = armed('launcher', 3);
    const crowd = new StubCrowd();
    crowd.add(4, 0, 0);
    const combat = build({ player, camera: eastwardCamera(), crowd });

    combat.detonate(0, 1, 0);
    expect(crowd.blows).toHaveLength(1);
    const blow = crowd.blows[0];
    expect(blow?.dirX).toBeCloseTo(1, 6);
    expect(blow?.speed ?? 0).toBeGreaterThan(0);
    combat.dispose();
  });
});

// -- DEFECT: every surface in the city threw the same pale dust ---------------

describe('what a bullet finds', () => {
  it('maps a builder’s material onto something a player can tell apart', () => {
    expect(surfaceImpact('glassShop')).toBe('glass');
    expect(surfaceImpact('corrugated')).toBe('metal');
    expect(surfaceImpact('timber')).toBe('timber');
    expect(surfaceImpact('foliage')).toBe('foliage');
    expect(surfaceImpact('kerb')).toBe('stone');
    expect(surfaceImpact('concrete')).toBe('concrete');
    // A builder that has not said keeps exactly the behaviour it always had.
    expect(surfaceImpact(undefined)).toBe('world');
  });

  it('collapses onto the sounds the audio layer actually has', () => {
    expect(impactSound('glass')).toBe('glass');
    expect(impactSound('metal')).toBe('metal');
    expect(impactSound('body')).toBe('body');
    expect(impactSound('timber')).toBe('debris');
    expect(impactSound('foliage')).toBe('debris');
    expect(impactSound('stone')).toBe('world');
    expect(impactSound('concrete')).toBe('world');
    expect(impactSound('world', true)).toBe('ground');
  });

  it('reports a shopfront as glass and a plain wall as before', () => {
    const seen: string[] = [];
    const shopfront = build({
      player: armed('pistol'),
      camera: eastwardCamera(),
      boxes: [
        {
          minX: 9, maxX: 10, minZ: -6, maxZ: 6, bottom: 0, top: 8,
          solid: true, surface: 'glassShop',
        },
      ],
      onImpact: (kind) => seen.push(kind),
    });
    shopfront.fireOnce();
    expect(seen).toEqual(['glass']);
    shopfront.dispose();

    const bare: string[] = [];
    const plain = build({
      player: armed('pistol'),
      camera: eastwardCamera(),
      boxes: [{ minX: 9, maxX: 10, minZ: -6, maxZ: 6, bottom: 0, top: 8, solid: true }],
      onImpact: (kind) => bare.push(kind),
    });
    plain.fireOnce();
    expect(bare).toEqual(['world']);
    plain.dispose();
  });

  it('calls the terrain the ground, which it never used to', () => {
    const seen: string[] = [];
    // Aimed steeply down: nothing but the pavement is out there.
    const combat = build({
      player: armed('pistol'),
      camera: eastwardCamera(0, 1.68, 0, -0.9),
      onImpact: (kind) => seen.push(kind),
    });
    combat.fireOnce();
    expect(seen).toEqual(['ground']);
    combat.dispose();
  });
});

// -- DEFECT: a head shot left blood floating in mid air -----------------------

describe('the blood a shot leaves', () => {
  it('lands on the floor the victim was standing on, not below the wound', () => {
    const player = armed('pistol');
    const crowd = new StubCrowd();
    // A level shot from eye height at somebody the same height is a head shot,
    // so the wound is about 1.68 m up. The pool used to be pinned 0.9 to 1.5 m
    // below THAT, which is half a metre above the pavement.
    crowd.add(20, 0, 0);
    const combat = build({ player, camera: eastwardCamera(), crowd });

    combat.fireOnce();
    combat.update(1 / 60, idle());

    const marks: number[] = [];
    combat.group.traverse((child: Object3D) => {
      if (!(child instanceof InstancedMesh) || child.name !== 'combat-marks') return;
      const m = child.instanceMatrix.array as ArrayLike<number>;
      for (let i = 0; i < child.count; i += 1) marks.push(m[i * 16 + 13] ?? 0);
    });
    expect(marks).toHaveLength(1);
    // On the ground the victim's feet are on, a millimetre proud of it.
    expect(marks[0] ?? -1).toBeGreaterThanOrEqual(0);
    expect(marks[0] ?? 1).toBeLessThan(0.05);
    combat.dispose();
  });
});

// -- the broad phase, directly ------------------------------------------------

describe('the vehicle broad phase', () => {
  it('asks for a radius that covers a body, not only a centre', () => {
    const player = armed('rifle');
    const fleet = new CentreFleet();
    const asked: number[] = [];
    const spy = {
      forEachNear: (x: number, z: number, radius: number, visit: (v: CombatVehicleView) => void) => {
        asked.push(radius);
        fleet.forEachNear(x, z, radius, visit);
      },
      applyImpact: (id: number, hit: VehicleImpact) => fleet.applyImpact(id, hit),
      applyDamage: (id: number, amount: number) => fleet.applyDamage(id, amount),
    };
    const combat = new CombatSystem({
      player,
      camera: eastwardCamera(),
      domElement: inertElement(),
      world: new WorldRayIndex([]),
      heightAt: FLAT,
      vehicles: spy,
      seed: 'broadphase',
    });
    combat.fireOnce();
    // The carbine reaches 90 m * 1.6 of falloff; the radius has to exceed that
    // by at least the half diagonal of the largest thing in the fleet.
    const reach = WEAPONS.rifle.rangeM * 1.6;
    expect(asked.length).toBeGreaterThan(0);
    expect(asked[0] ?? 0).toBeGreaterThan(reach + 3.8);
    combat.dispose();
  });
});
