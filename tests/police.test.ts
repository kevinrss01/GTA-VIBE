/**
 * The wanted level, the pursuit, and what ends it.
 *
 * The escalation policy is pure arithmetic and is asserted directly. The
 * pursuit itself is run for real - the actual `PoliceSystem`, the actual
 * `RoadNetwork` built from the actual city plan, and a stub fleet standing in
 * for the traffic system's `takeControl` - so what is tested is the dispatch,
 * the driving and the sight logic the game runs, without a renderer.
 */

import { describe, expect, it } from 'vitest';

import { buildRoadNetwork, exitsFrom, lanePoint, type RoadNetwork } from '../src/city/RoadNetwork';
import { WorldRayIndex } from '../src/combat/rays';
import { CollisionWorld } from '../src/player/Collision';
import { HEAT, MAX_WANTED, PlayerState } from '../src/player/PlayerState';
import { PoliceSystem, type PoliceContext } from '../src/police/PoliceSystem';
import {
  ARREST_HEALTH,
  ARREST_HOLD,
  ARREST_RANGE,
  MAX_UNITS,
  canArrest,
  carsForStars,
  dispatchInterval,
  officerAccuracy,
  officersPerCar,
  shootsOnSight,
} from '../src/police/policy';
import {
  angleDelta,
  chooseExit,
  headingTo,
  nearestLane,
  PursuitField,
  pursuitSpeed,
} from '../src/police/pursuit';
import type { ChassisSpec, VehicleHandle, VehicleKind, VehicleView } from '../src/traffic/types';
import { getCityPlan } from '../src/world/CityPlan';

const plan = getCityPlan();
const network: RoadNetwork = buildRoadNetwork(plan);

// -- test doubles -------------------------------------------------------------

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

/**
 * A fleet of patrol cars parked far enough away to be commandeered.
 *
 * `takeControl` behaves like the real one: the vehicle stays in the list, its
 * control flips to `player`, and the caller writes its pose from then on.
 */
class StubFleet {
  readonly views: MutableView[] = [];
  taken = 0;
  released = 0;

  constructor(count: number, distance = 400, police = true) {
    for (let i = 0; i < count; i += 1) {
      const angle = (i / count) * Math.PI * 2;
      this.views.push({
        id: 100 + i,
        kind: police ? 'patrolSedan' : 'sedan',
        police,
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
    this.taken += 1;
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
        view.braking = pose.braking ?? false;
      },
      release: () => this.releaseControl(view.id),
    };
  }

  releaseControl(id: number): void {
    const view = this.views.find((v) => v.id === id);
    if (!view || view.control !== 'player') return;
    view.control = 'ambient';
    this.released += 1;
  }
}

/** A point on the road network, so a dispatched unit has somewhere to drive. */
function onTheRoad(): { x: number; z: number } {
  const lane = network.lanes[40] ?? network.lanes[0];
  if (!lane) throw new Error('the city has no lanes');
  return lanePoint(lane, lane.length * 0.5);
}

function makeSystem(options: {
  player: PlayerState;
  fleet: StubFleet;
  onArrest?: () => void;
}): PoliceSystem {
  return new PoliceSystem({
    player: options.player,
    traffic: options.fleet,
    network,
    collision: new CollisionWorld([]),
    // No world geometry: everyone can see everyone, which isolates the sight
    // rules from the city's own occlusion.
    world: new WorldRayIndex([]),
    heightAt: () => 0,
    quality: 'low',
    seed: 'police-test',
    ...(options.onArrest ? { onArrest: options.onArrest } : {}),
  });
}

function context(x: number, z: number, extra: Partial<PoliceContext> = {}): PoliceContext {
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

/** Pins the player at a wanted level without letting the heat drift. */
function pinStars(player: PlayerState, stars: number): void {
  player.clearHeat();
  if (stars <= 0) return;
  let guard = 0;
  while (player.wanted < stars && guard < 2000) {
    player.addHeat(1);
    guard += 1;
  }
}

/** Runs the pursuit for `seconds`, holding the wanted level steady. */
function run(
  police: PoliceSystem,
  player: PlayerState,
  stars: number,
  seconds: number,
  at: { x: number; z: number },
  extra: Partial<PoliceContext> = {},
): void {
  const dt = 1 / 30;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i += 1) {
    pinStars(player, stars);
    police.update(dt, context(at.x, at.z, { ...extra, time: i * dt }));
  }
}

// -- policy -------------------------------------------------------------------

describe('escalation policy', () => {
  it('puts one more car on the street per star, up to the ceiling', () => {
    expect(carsForStars(0)).toBe(0);
    const counts = [1, 2, 3, 4, 5].map(carsForStars);
    expect(counts).toEqual([1, 2, 3, 4, 5]);
    for (let stars = 0; stars <= MAX_WANTED; stars += 1) {
      expect(carsForStars(stars)).toBeLessThanOrEqual(MAX_UNITS);
    }
    // Monotonic: no star ever reduces the response.
    for (let stars = 1; stars <= MAX_WANTED; stars += 1) {
      expect(carsForStars(stars)).toBeGreaterThanOrEqual(carsForStars(stars - 1));
    }
  });

  it('doubles the crew, shortens the wait and improves the aim as it climbs', () => {
    expect(officersPerCar(1)).toBe(1);
    expect(officersPerCar(2)).toBe(1);
    expect(officersPerCar(3)).toBe(2);
    expect(dispatchInterval(0)).toBe(Infinity);
    for (let stars = 2; stars <= MAX_WANTED; stars += 1) {
      expect(dispatchInterval(stars)).toBeLessThan(dispatchInterval(stars - 1));
    }
    expect(officerAccuracy(5)).toBeGreaterThan(officerAccuracy(2));
  });

  it('stops trying to arrest and starts shooting at the third star', () => {
    expect(shootsOnSight(1)).toBe(false);
    expect(shootsOnSight(2)).toBe(false);
    expect(shootsOnSight(3)).toBe(true);
    expect(shootsOnSight(5)).toBe(true);
  });
});

describe('arrest rules', () => {
  const base = {
    distance: 1.5,
    playerSpeed: 0,
    playerHealth: 100,
    stars: 1,
    driving: false,
    held: ARREST_HOLD,
  };

  it('takes a slow, cornered, low-level suspect', () => {
    expect(canArrest(base)).toBe(true);
  });

  it('will not take somebody out of reach, running, or in a car', () => {
    expect(canArrest({ ...base, distance: ARREST_RANGE + 0.1 })).toBe(false);
    expect(canArrest({ ...base, playerSpeed: 5 })).toBe(false);
    expect(canArrest({ ...base, driving: true })).toBe(false);
    expect(canArrest({ ...base, held: ARREST_HOLD - 0.01 })).toBe(false);
  });

  it('shoots a three-star suspect who is healthy and cuffs one who is not', () => {
    expect(canArrest({ ...base, stars: 4 })).toBe(false);
    expect(canArrest({ ...base, stars: 4, playerHealth: ARREST_HEALTH })).toBe(true);
    expect(canArrest({ ...base, stars: 5, playerHealth: 1 })).toBe(true);
  });
});

// -- routing ------------------------------------------------------------------

describe('pursuit routing', () => {
  it('finds the lane under a point on a street', () => {
    const spot = onTheRoad();
    const found = nearestLane(network, spot.x, spot.z);
    expect(found).not.toBeNull();
    expect(Math.abs(found?.offset ?? 99)).toBeLessThan(1);
  });

  it('takes the exit that ends nearest the target', () => {
    let checked = 0;
    for (const lane of network.lanes.slice(0, 60)) {
      const end = lanePoint(lane, lane.length);
      // Aim at a point well past the end of this lane, in its own direction.
      const exit = chooseExit(network, lane, end.x, end.z);
      if (!exit) continue;
      checked += 1;
      const chosen = lanePoint(exit, exit.length);
      const chosenDistance = Math.hypot(chosen.x - end.x, chosen.z - end.z);
      // Whatever it picked must be no worse than any other LEGAL exit. The
      // legal set excludes the U-turn, which is always the nearest and is
      // exactly why the comparison is made against `exitsFrom`.
      for (const other of exitsFrom(network, lane)) {
        const point = lanePoint(other, other.length);
        const distance = Math.hypot(point.x - end.x, point.z - end.z);
        expect(chosenDistance).toBeLessThanOrEqual(distance + 2.001);
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('agrees with the game’s yaw convention', () => {
    // Forward is (-sin yaw, 0, -cos yaw): yaw 0 faces -Z, -PI/2 faces +X.
    expect(headingTo(0, 0, 0, -10)).toBeCloseTo(0, 6);
    expect(headingTo(0, 0, 10, 0)).toBeCloseTo(-Math.PI / 2, 6);
    expect(angleDelta(3, -3)).toBeCloseTo(Math.PI * 2 - 6, 6);
    expect(angleDelta(0.1, -0.1)).toBeCloseTo(-0.2, 6);
  });

  it('reaches almost the whole city from anywhere, and points downhill', () => {
    const field = new PursuitField(network);
    const spot = onTheRoad();
    expect(field.update(spot.x, spot.z)).toBe(true);
    // Most of the city must be able to reach the player. It is not all of it:
    // Meridian Bay's lanes are one-way pairs and some runs end at a terminus
    // with no legal turn back, which is a property of the road layout rather
    // than of the search. Measured at 162 of 188 lanes from a mid-city street.
    expect(field.reach).toBeGreaterThan(network.lanes.length * 0.8);

    // From any reachable lane, the exit the field picks is strictly closer to
    // the target in hops than the lane it leaves. That is the property a
    // greedy driver does not have, and the reason it circled instead.
    let checked = 0;
    for (const lane of network.lanes) {
      const cost = field.cost(lane.id);
      if (!Number.isFinite(cost) || cost === 0) continue;
      const next = field.next(lane, spot.x, spot.z);
      if (!next) continue;
      expect(field.cost(next.id)).toBeLessThan(cost);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('does not re-search until the player has actually moved', () => {
    const field = new PursuitField(network);
    const spot = onTheRoad();
    expect(field.update(spot.x, spot.z)).toBe(true);
    expect(field.update(spot.x + 1, spot.z)).toBe(false);
    expect(field.update(spot.x + 40, spot.z)).toBe(true);
  });

  it('slows for a corner and for the target it is closing on', () => {
    expect(pursuitSpeed(16, 200, 0, 9)).toBeCloseTo(16, 6);
    expect(pursuitSpeed(16, 200, 0.5, 9)).toBeLessThan(16 * 0.4);
    expect(pursuitSpeed(16, 9, 0, 9)).toBe(0);
    expect(pursuitSpeed(16, 15, 0, 9)).toBeLessThan(16);
  });
});

// -- the pursuit itself -------------------------------------------------------

describe('police response', () => {
  it('sends nobody while the player is clean', () => {
    const player = new PlayerState();
    const fleet = new StubFleet(8);
    const police = makeSystem({ player, fleet });
    const spot = onTheRoad();
    run(police, player, 0, 20, spot);
    expect(police.stats.units).toBe(0);
    expect(police.stats.dispatched).toBe(0);
    expect(police.pursued).toBe(false);
    police.dispose();
  });

  it('puts more cars on the street as the stars climb', () => {
    const seen: number[] = [];
    for (const stars of [1, 2, 3, 4, 5]) {
      const player = new PlayerState();
      const fleet = new StubFleet(8);
      const police = makeSystem({ player, fleet });
      const spot = onTheRoad();
      // Long enough for the slowest dispatch cadence to reach its quota.
      run(police, player, stars, 40, spot);
      seen.push(police.stats.units);
      expect(police.stats.units).toBe(carsForStars(stars));
      police.dispose();
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  it('takes real patrol cars out of the fleet and gives them back', () => {
    const player = new PlayerState();
    const fleet = new StubFleet(8);
    const police = makeSystem({ player, fleet });
    const spot = onTheRoad();

    run(police, player, 3, 30, spot);
    expect(fleet.taken).toBeGreaterThanOrEqual(3);
    expect(police.stats.unmarked).toBe(0);
    const commandeered = fleet.views.filter((v) => v.control === 'player').length;
    expect(commandeered).toBe(police.stats.units);

    police.standDown();
    expect(fleet.views.every((v) => v.control === 'ambient')).toBe(true);
    expect(police.stats.units).toBe(0);
    police.dispose();
  });

  it('falls back to an unmarked car when the fleet has no patrol car free', () => {
    const player = new PlayerState();
    const fleet = new StubFleet(6, 400, false); // ordinary saloons only
    const police = makeSystem({ player, fleet });
    const spot = onTheRoad();
    run(police, player, 2, 25, spot);
    expect(police.stats.units).toBe(2);
    expect(police.stats.unmarked).toBe(2);
    police.dispose();
  });

  it('drives the dispatched car toward the player', () => {
    const player = new PlayerState();
    const fleet = new StubFleet(8);
    const police = makeSystem({ player, fleet });
    const spot = onTheRoad();

    run(police, player, 1, 3, spot);
    const unit = fleet.views.find((v) => v.control === 'player');
    expect(unit).toBeDefined();
    const startDistance = Math.hypot((unit?.x ?? 0) - spot.x, (unit?.z ?? 0) - spot.z);

    run(police, player, 1, 20, spot);
    const endDistance = Math.hypot((unit?.x ?? 0) - spot.x, (unit?.z ?? 0) - spot.z);
    expect(endDistance).toBeLessThan(startDistance);
    police.dispose();
  });

  it('gets officers out on foot once a car has arrived', () => {
    const player = new PlayerState();
    const fleet = new StubFleet(8);
    const police = makeSystem({ player, fleet });
    const spot = onTheRoad();
    run(police, player, 3, 60, spot);
    expect(police.stats.officers).toBeGreaterThan(0);
    police.dispose();
  });

  it('does not let the heat decay while the player is being watched', () => {
    const player = new PlayerState();
    const fleet = new StubFleet(8);
    const police = makeSystem({ player, fleet });
    const spot = onTheRoad();

    // Get a unit into sight range first.
    run(police, player, 3, 45, spot);
    expect(police.pursued).toBe(true);

    // Now stop topping the heat up and run for far longer than the eight
    // seconds it takes for cooling to begin.
    const heat = player.heat;
    const dt = 1 / 30;
    for (let i = 0; i < 30 * 30; i += 1) {
      police.update(dt, context(spot.x, spot.z, { time: 45 + i * dt }));
    }
    expect(police.pursued).toBe(true);
    expect(player.heat).toBe(heat);
    expect(player.wanted).toBeGreaterThanOrEqual(3);
    police.dispose();
  });

  it('lets the heat fall once nobody has eyes on the player', () => {
    const player = new PlayerState();
    // An empty fleet: there is no car in the city to commandeer, so nothing
    // can ever see the player and the cooldown is the only thing running.
    const fleet = new StubFleet(0);
    const police = makeSystem({ player, fleet });
    const spot = onTheRoad();

    pinStars(player, 2);
    const heat = player.heat;
    expect(player.wanted).toBe(2);

    const dt = 1 / 30;
    for (let i = 0; i < 30 * 6; i += 1) {
      police.update(dt, context(spot.x, spot.z, { time: i * dt }));
    }
    // Eight seconds of quiet are needed before the heat moves at all.
    expect(police.pursued).toBe(false);
    expect(player.heat).toBe(heat);

    for (let i = 0; i < 30 * 30; i += 1) {
      police.update(dt, context(spot.x, spot.z, { time: 6 + i * dt }));
    }
    expect(player.heat).toBeLessThan(heat);
    expect(player.wanted).toBeLessThan(2);
    police.dispose();
  });

  it('arrests a cornered one-star suspect rather than shooting them', () => {
    const player = new PlayerState();
    const fleet = new StubFleet(8);
    let arrests = 0;
    const police = makeSystem({ player, fleet, onArrest: () => { arrests += 1; } });
    const spot = onTheRoad();

    const dt = 1 / 30;
    for (let i = 0; i < 30 * 90 && arrests === 0; i += 1) {
      pinStars(player, 1);
      police.update(dt, context(spot.x, spot.z, { time: i * dt }));
    }
    expect(arrests).toBeGreaterThan(0);
    expect(player.health).toBe(100);
    police.dispose();
  });

  it('shoots a five-star suspect down instead', () => {
    const player = new PlayerState();
    const fleet = new StubFleet(8);
    const police = makeSystem({ player, fleet });
    const spot = onTheRoad();

    const dt = 1 / 30;
    for (let i = 0; i < 30 * 90 && player.alive; i += 1) {
      pinStars(player, 5);
      police.update(dt, context(spot.x, spot.z, { time: i * dt }));
    }
    expect(player.health).toBeLessThan(100);
    police.dispose();
  });

  it('lets the player shoot an officer, and charges the right heat for it', () => {
    const player = new PlayerState();
    const fleet = new StubFleet(8);
    const police = makeSystem({ player, fleet });
    const spot = onTheRoad();
    run(police, player, 3, 60, spot);
    expect(police.stats.officers).toBeGreaterThan(0);

    // Reach into the police the way combat does: find a target, damage it.
    let victim = -1;
    police.forEachActor(spot.x, spot.z, 200, (target) => {
      if (victim < 0) victim = target.id;
    });
    expect(victim).toBeGreaterThan(0);

    player.clearHeat();
    expect(police.damage(victim, 40)).toBe('hurt');
    player.addHeat(HEAT.policeHurt);
    expect(player.wanted).toBe(2);

    expect(police.damage(victim, 200)).toBe('killed');
    player.addHeat(HEAT.policeKilled);
    expect(player.wanted).toBe(3);
    expect(police.stats.officersDown).toBe(1);
    police.dispose();
  });

  it('wrecks a pursuit car under sustained fire and bails its crew out', () => {
    const player = new PlayerState();
    const fleet = new StubFleet(8);
    const police = makeSystem({ player, fleet });
    const spot = onTheRoad();
    run(police, player, 3, 10, spot);

    const unit = fleet.views.find((v) => v.control === 'player');
    expect(unit).toBeDefined();
    const id = unit?.id ?? -1;
    expect(police.damageVehicle(id, 100)).toBe('hurt');
    expect(police.damageVehicle(id, 500)).toBe('killed');
    expect(police.stats.vehiclesWrecked).toBe(1);
    // The crew is on the pavement, not inside a wreck.
    expect(police.stats.officers).toBeGreaterThan(0);
    police.dispose();
  });
});
