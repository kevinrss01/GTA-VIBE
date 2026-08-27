/**
 * Getting hit by a car, and being shot.
 *
 * Both end in the same place - a body on the pavement - and that is deliberate:
 * one `down` state, one topple, one set of rules for the crowd to walk around.
 * These tests hold the contract that makes it safe to attach a wanted level to
 * the first of them: a knock-down is a REAL COLLISION with a moving chassis,
 * never proximity, and never ambient traffic.
 */

import { describe, expect, it } from 'vitest';

import { buildRoadNetwork } from '../src/city/RoadNetwork';
import { getCityPlan } from '../src/world/CityPlan';
import { CityGround } from '../src/world/CityGround';
import {
  Crowd,
  DOWN_RADIUS,
  PED_RADIUS,
  type CrowdVehicle,
  type Pedestrian,
  type PedestrianImpact,
} from '../src/agents/crowd';
import { ObstacleIndex } from '../src/agents/obstacles';
import { buildPavementGraph, linkPoint, type PavementLink } from '../src/agents/pavement';

const plan = getCityPlan();
const network = buildRoadNetwork(plan);
const ground = new CityGround(plan);
const graph = buildPavementGraph(plan, network);
const obstacles = new ObstacleIndex(plan, ground);

function makeCrowd(population: number): Crowd {
  return new Crowd({ ground, network, graph, obstacles, population, seed: plan.seed });
}

/** A long straight pavement to stage collisions on. */
function longestPavement(): { index: number; link: PavementLink } {
  let best = -1;
  let length = 0;
  for (let i = 0; i < graph.links.length; i += 1) {
    const link = graph.links[i];
    if (!link || link.crossing) continue;
    if (link.length > length) {
      length = link.length;
      best = i;
    }
  }
  return { index: best, link: graph.links[best] as PavementLink };
}

/**
 * One pedestrian, standing still at a known point, with the player far enough
 * away that nothing else in the model touches them.
 */
function stage(along = 6, viewerOnTop = false): {
  crowd: Crowd;
  ped: Pedestrian;
  link: PavementLink;
  index: number;
  px: number;
  pz: number;
} {
  const { index, link } = longestPavement();
  const crowd = makeCrowd(1);
  const point = { x: 0, z: 0 };
  linkPoint(link, along, 0, point);
  const px = point.x;
  const pz = viewerOnTop ? point.z : point.z + 130;
  crowd.update(1 / 30, { x: px, y: 0, z: pz, time: 0 });
  const ped = crowd.peds[0] as Pedestrian;
  ped.active = true;
  ped.link = index;
  ped.next = -1;
  ped.along = along;
  ped.lateral = 0;
  ped.lateralTarget = 0;
  ped.state = 'walk';
  ped.due = 0;
  ped.x = point.x;
  ped.z = point.z;
  ped.vx = 0;
  ped.vz = 0;
  ped.speed = 0;
  ped.heading = Math.atan2(-link.dx, -link.dz);
  ped.anchorX = ped.x;
  ped.anchorZ = ped.z;
  return { crowd, ped, link, index, px, pz };
}

/** A car sitting on a pedestrian, travelling along the link at `speed`. */
function carOn(ped: Pedestrian, link: PavementLink, speed: number): CrowdVehicle {
  return {
    x: ped.x,
    z: ped.z,
    vx: link.dx * speed,
    vz: link.dz * speed,
    halfLength: 2.3,
    halfWidth: 0.95,
    player: true,
  };
}

describe('a car that hits somebody knocks them down', () => {
  it('puts them on the ground and throws them the way the car was going', () => {
    const { crowd, ped, link, px, pz } = stage();
    const before = { x: ped.x, z: ped.z };
    const hits: PedestrianImpact[] = [];
    crowd.onImpact = (impact): void => {
      hits.push(impact);
    };
    const car = carOn(ped, link, 9);

    for (let step = 1; step <= 30; step += 1) {
      crowd.update(1 / 30, { x: px, y: 0, z: pz, time: step / 30, vehicles: [car] });
    }

    expect(ped.state, 'not knocked down').toBe('down');
    expect(hits.length, 'onImpact fired once per person, not once per frame').toBe(1);
    const hit = hits[0] as PedestrianImpact;
    expect(hit.vehicle).toBe(car);
    expect(hit.index).toBe(0);
    expect(hit.speed).toBeCloseTo(9, 5);
    expect(hit.fatal, '9 m/s is above the survivable threshold').toBe(true);
    // Thrown along the car's line of travel, and a real distance, not a nudge.
    const moved = (ped.x - before.x) * link.dx + (ped.z - before.z) * link.dz;
    expect(moved, 'not thrown forward at all').toBeGreaterThan(0.5);
    expect(Math.abs(ped.x - before.x) + Math.abs(ped.z - before.z)).toBeLessThan(6);
  });

  it('topples them over the second they are hit and lies them flat', () => {
    const { crowd, ped, link, px, pz } = stage();
    const car = carOn(ped, link, 9);
    crowd.update(1 / 30, { x: px, y: 0, z: pz, time: 1 / 30, vehicles: [car] });
    expect(ped.state).toBe('down');
    // The moment of the hit: still on their feet, about to go over.
    expect(Math.abs(Crowd.tilt(ped))).toBeLessThan(0.35);

    for (let step = 2; step <= 30; step += 1) {
      crowd.update(1 / 30, { x: px, y: 0, z: pz, time: step / 30, vehicles: [] });
    }
    // A second later: flat out, a quarter turn from standing.
    expect(Math.abs(Crowd.tilt(ped))).toBeCloseTo(Math.PI / 2, 2);
    // Struck from behind, so they go over onto their face.
    expect(ped.fallSign).toBe(-1);
  });

  it('lets a survivor get back up and walk on', () => {
    const { crowd, ped, link, px, pz } = stage();
    // Below the survivable threshold: a clip rather than a killing blow.
    const car = carOn(ped, link, 3);
    crowd.update(1 / 30, { x: px, y: 0, z: pz, time: 1 / 30, vehicles: [car] });
    expect(ped.state).toBe('down');
    expect(ped.fatal).toBe(false);

    let up = -1;
    for (let step = 2; step <= 30 * 20; step += 1) {
      crowd.update(1 / 30, { x: px, y: 0, z: pz, time: step / 30, vehicles: [] });
      if (ped.state !== 'down' && up < 0) up = step / 30;
    }
    expect(up, 'never got up').toBeGreaterThan(3);
    expect(up, 'took too long to get up').toBeLessThan(12);
    expect(Crowd.tilt(ped), 'still leaning after standing up').toBe(0);
    expect(ped.state).toBe('walk');
  });

  it('leaves a casualty on the ground', () => {
    const { crowd, ped, link, px, pz } = stage();
    const car = carOn(ped, link, 12);
    crowd.update(1 / 30, { x: px, y: 0, z: pz, time: 1 / 30, vehicles: [car] });
    expect(ped.fatal).toBe(true);
    for (let step = 2; step <= 30 * 30; step += 1) {
      crowd.update(1 / 30, { x: px, y: 0, z: pz, time: step / 30, vehicles: [] });
    }
    expect(ped.state, 'a casualty got back up').toBe('down');
  });
});

describe('what does NOT count as being hit', () => {
  it('ignores a car that drives past without touching anybody', () => {
    const { crowd, ped, link, px, pz } = stage();
    // Alongside, a metre and a half clear of the chassis - a bus queue, not a
    // collision. This is the case a false wanted star would come from.
    const clear = 0.95 + PED_RADIUS + 1.2;
    let hits = 0;
    crowd.onImpact = (): void => {
      hits += 1;
    };
    for (let step = 1; step <= 60; step += 1) {
      const car: CrowdVehicle = {
        x: ped.x + link.nx * clear,
        z: ped.z + link.nz * clear,
        vx: link.dx * 12,
        vz: link.dz * 12,
        halfLength: 2.3,
        halfWidth: 0.95,
        player: true,
      };
      crowd.update(1 / 30, { x: px, y: 0, z: pz, time: step / 30, vehicles: [car] });
    }
    expect(hits, 'a car that never touched anybody reported an impact').toBe(0);
    expect(ped.state).not.toBe('down');
  });

  it('ignores a parked car somebody walks into', () => {
    const { crowd, ped, link, px, pz } = stage();
    const car: CrowdVehicle = {
      x: ped.x,
      z: ped.z,
      vx: 0,
      vz: 0,
      halfLength: 2.3,
      halfWidth: 0.95,
      player: true,
    };
    for (let step = 1; step <= 60; step += 1) {
      crowd.update(1 / 30, { x: px, y: 0, z: pz, time: step / 30, vehicles: [car] });
    }
    expect(ped.state, 'a stationary car knocked somebody down').not.toBe('down');
    void link;
  });

  it('leaves ambient traffic passing through, because nothing makes it yield', () => {
    // `CrowdVehicle.player` unset and the vehicle nowhere near the viewer, so
    // this is another driver. See `CrowdVehicle.player` for the measurement
    // behind this: letting every car hit people produced 210 knock-downs in ten
    // minutes, of which 57 per cent were turning or junction-clearing traffic a
    // pedestrian cannot see coming.
    const { crowd, ped, link, px, pz } = stage();
    let hits = 0;
    crowd.onImpact = (): void => {
      hits += 1;
    };
    const car: CrowdVehicle = {
      x: ped.x,
      z: ped.z,
      vx: link.dx * 12,
      vz: link.dz * 12,
      halfLength: 2.3,
      halfWidth: 0.95,
    };
    for (let step = 1; step <= 60; step += 1) {
      crowd.update(1 / 30, { x: px, y: 0, z: pz, time: step / 30, vehicles: [car] });
    }
    expect(hits).toBe(0);
    expect(ped.state).not.toBe('down');

    // ...until it is turned on, at which point it works exactly the same way.
    crowd.trafficStrikes = true;
    const onThem: CrowdVehicle = { ...car, x: ped.x, z: ped.z };
    crowd.update(1 / 30, { x: px, y: 0, z: pz, time: 3, vehicles: [onThem] });
    expect(ped.state).toBe('down');
    expect(hits).toBe(1);
  });

  it('recognises the player by the viewer sitting in it, with no flag set', () => {
    // `main.ts` hands the crowd the CAR's position while somebody is driving,
    // so the player's vehicle is the one on top of the viewer. This is what
    // makes the feature work with no change to the integration.
    const { crowd, ped, link } = stage(6, true);
    const car: CrowdVehicle = {
      x: ped.x,
      z: ped.z,
      vx: link.dx * 10,
      vz: link.dz * 10,
      halfLength: 2.3,
      halfWidth: 0.95,
    };
    crowd.update(1 / 30, { x: car.x, y: 0, z: car.z, time: 1 / 30, vehicles: [car] });
    expect(ped.state, 'the car the player is driving did not hit anybody').toBe('down');
  });
});

describe('the crowd goes round a body', () => {
  it('never walks through one, and never shoves it down the street', () => {
    const { index, link } = longestPavement();
    const crowd = makeCrowd(30);
    const point = { x: 0, z: 0 };
    linkPoint(link, link.length * 0.5, 0, point);
    const px = point.x;
    const pz = point.z;
    crowd.update(1 / 30, { x: px, y: 0, z: pz, time: 0 });

    // A body halfway along, and everybody else queued up behind walking at it.
    const victim = crowd.peds[0] as Pedestrian;
    victim.active = true;
    victim.link = index;
    victim.along = link.length * 0.5;
    victim.lateral = 0;
    victim.x = point.x;
    victim.z = point.z;
    victim.state = 'walk';
    victim.heading = Math.atan2(-link.dx, -link.dz);
    crowd.knockDown(victim, link.dx, link.dz, 11, true);
    // Let the throw play out first: what is being tested here is whether the
    // CROWD moves the body, not whether the car did.
    for (let step = 1; step <= 90; step += 1) {
      crowd.update(1 / 30, { x: px, y: 0, z: pz, time: step / 30 });
    }
    expect(victim.speed, 'the body never came to rest').toBeLessThan(0.05);
    const restX = victim.x;
    const restZ = victim.z;

    const walkers: Pedestrian[] = [];
    for (let i = 1; i < 12; i += 1) {
      const ped = crowd.peds[i] as Pedestrian;
      const at = victim.along - 3 - i * 0.5;
      if (at < 1) break;
      linkPoint(link, at, ((i % 3) - 1) * 0.3, point);
      ped.active = true;
      ped.link = index;
      ped.next = -1;
      ped.along = at;
      ped.lateral = ((i % 3) - 1) * 0.3;
      ped.lateralTarget = ped.lateral;
      ped.state = 'walk';
      ped.due = 0;
      ped.x = point.x;
      ped.z = point.z;
      ped.vx = link.dx * ped.speed;
      ped.vz = link.dz * ped.speed;
      ped.heading = Math.atan2(-link.dx, -link.dz);
      ped.anchorX = ped.x;
      ped.anchorZ = ped.z;
      walkers.push(ped);
    }
    expect(walkers.length).toBeGreaterThan(6);

    let closest = Infinity;
    for (let step = 1; step <= 30 * 25; step += 1) {
      crowd.update(1 / 30, { x: px, y: 0, z: pz, time: step / 30 });
      for (const ped of walkers) {
        if (!ped.active || ped.state === 'down') continue;
        closest = Math.min(closest, Math.hypot(ped.x - victim.x, ped.z - victim.z));
      }
    }

    // Nobody stood on the body. The separation is deliberately larger than a
    // pair of walkers, because a body takes up a person's LENGTH.
    expect(closest, `somebody came within ${closest.toFixed(2)} m of the body`).toBeGreaterThan(
      PED_RADIUS + DOWN_RADIUS - 0.12,
    );
    // ...and the traffic of people walking past did not push it anywhere.
    const drifted = Math.hypot(victim.x - restX, victim.z - restZ);
    expect(drifted, `the body was shoved ${drifted.toFixed(2)} m by the crowd`).toBeLessThan(0.05);
    // The people behind it did not simply stop for ever either.
    const movedOn = walkers.filter((p) => p.active && p.along > victim.along).length;
    expect(movedOn, 'nobody managed to get past the body in 25 s').toBeGreaterThan(0);
  });
});

describe('the hook a shot civilian goes down through', () => {
  it('puts the nearest person down for good and reports whether it found one', () => {
    const { crowd, ped, px, pz } = stage();
    crowd.update(1 / 30, { x: px, y: 0, z: pz, time: 1 / 30 });
    // 0.4 m out, which is the worst `CrowdTargets` can be: it tracks a body by
    // position with a 0.6 m match radius.
    expect(crowd.downNearest(ped.x + 0.4, ped.z, 1, true)).toBe(true);
    expect(ped.state).toBe('down');
    expect(ped.fatal, 'a shot civilian got back up').toBe(true);
    // A second shot at the same body is not a second casualty.
    expect(crowd.downNearest(ped.x, ped.z, 1, true)).toBe(false);
  });

  it('reports false when there is nobody there', () => {
    const { crowd, ped, px, pz } = stage();
    crowd.update(1 / 30, { x: px, y: 0, z: pz, time: 1 / 30 });
    expect(crowd.downNearest(ped.x + 40, ped.z + 40, 1, true)).toBe(false);
    expect(ped.state).not.toBe('down');
  });
});

describe('what the traffic layer is offered so it can brake', () => {
  it('lists only the people standing on a carriageway', () => {
    const crowd = makeCrowd(60);
    const at = plan.spawn;
    crowd.update(1 / 30, { x: at.x, y: 0, z: at.z, time: 0 });
    for (let step = 1; step <= 30 * 40; step += 1) {
      crowd.update(1 / 30, { x: at.x, y: 0, z: at.z, time: step / 30 });
    }
    const obstacleList = crowd.carriagewayObstacles();
    let onRoad = 0;
    for (const ped of crowd.peds) {
      if (ped.active && graph.links[ped.link]?.crossing) onRoad += 1;
    }
    expect(obstacleList.length).toBe(onRoad);
    for (const obstacle of obstacleList) {
      expect(obstacle.radius).toBeGreaterThan(0);
      // Everything listed really is on a crossing somewhere.
      const near = crowd.peds.some(
        (p) => p.active && Math.abs(p.x - obstacle.x) < 1e-6 && Math.abs(p.z - obstacle.z) < 1e-6,
      );
      expect(near).toBe(true);
    }
  });
});
