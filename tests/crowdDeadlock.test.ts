/**
 * The pedestrian crowd must never deadlock.
 *
 * Every test here reproduces a mechanism that was observed stranding real
 * pedestrians in Meridian Bay's streets, measured rather than imagined:
 *
 *  - A continuation that doubles straight back. The pavement chain on the far
 *    kerb of a crossing resumes heading back the way the walker came, so the
 *    aim point `Crowd.step` put `over` metres along it landed ON the walker.
 *    Normalising a centimetre-long vector and then chasing it at full walking
 *    speed overshoots every step, the direction flips, and `along` never
 *    reaches the hand-over threshold. Nine of 270 people spent more than thirty
 *    seconds like that in four minutes, one of them for two whole minutes, and
 *    every one of them was standing in a carriageway.
 *  - Street furniture across a route. The prop scatter knows nothing about the
 *    pedestrian graph and puts a planter over the middle of one crossing,
 *    closing it outright.
 *  - Anything else. The last test is a bound on the whole crowd rather than on
 *    a mechanism, so a future regression that nobody predicted still fails it.
 */

import { describe, expect, it } from 'vitest';

import { buildRoadNetwork } from '../src/city/RoadNetwork';
import { getCityPlan } from '../src/world/CityPlan';
import { CityGround } from '../src/world/CityGround';
import { Crowd, PED_RADIUS, type Pedestrian } from '../src/agents/crowd';
import { ObstacleIndex } from '../src/agents/obstacles';
import { buildPavementGraph, linkPoint, type PavementLink } from '../src/agents/pavement';
import type { ColliderBox } from '../src/world/build/types';

const plan = getCityPlan();
const network = buildRoadNetwork(plan);
const ground = new CityGround(plan);
const graph = buildPavementGraph(plan, network);
const obstacles = new ObstacleIndex(plan, ground);

const SPAWN = plan.spawn;
const WALK_RADIUS = PED_RADIUS + 0.14;

function makeCrowd(population: number): Crowd {
  return new Crowd({ ground, network, graph, obstacles, population, seed: plan.seed });
}

/** Every continuation of `link` that offers no forward progress along it. */
function doublesBack(link: PavementLink, index: number): number[] {
  const out: number[] = [];
  const from = { x: 0, z: 0 };
  const to = { x: 0, z: 0 };
  // Where a walker stands when the aim jumps to the next link, and where the
  // aim would then be: `Crowd.step`'s `over` floor is 0.6 m.
  linkPoint(link, Math.max(0, link.length - 0.65), 0, from);
  for (const candidate of graph.linksFrom[link.to] ?? []) {
    if (candidate === link.reverse) continue;
    const next = graph.links[candidate];
    if (!next) continue;
    linkPoint(next, Math.min(next.length, 0.66), 0, to);
    if ((to.x - from.x) * link.dx + (to.z - from.z) * link.dz <= 0) out.push(candidate);
  }
  void index;
  return out;
}

describe('crossing continuations that double back', () => {
  it('the city really does contain one', () => {
    // If this ever stops being true the reproduction below is testing nothing,
    // so it is asserted rather than assumed.
    let found = 0;
    for (let i = 0; i < graph.links.length; i += 1) {
      const link = graph.links[i];
      if (!link || !link.crossing) continue;
      found += doublesBack(link, i).length;
    }
    expect(found, 'no crossing has a continuation that doubles back').toBeGreaterThan(0);
  });

  /**
   * The reproduction. One pedestrian, far enough away to be simulated at the
   * cheapest level - which is where this was first caught, because the coarse
   * level drops the crowd forces that would otherwise mask it - placed where
   * the old aim point sat on top of them.
   *
   * Without the guard in `Crowd.step` this pedestrian never leaves the
   * carriageway: measured on the unfixed code they oscillate 2 cm either side
   * of one spot indefinitely.
   */
  it('never strands a pedestrian a stride short of the far kerb', () => {
    let cases = 0;
    for (let i = 0; i < graph.links.length; i += 1) {
      const link = graph.links[i];
      if (!link || !link.crossing) continue;
      const backwards = doublesBack(link, i);
      if (backwards.length === 0) continue;
      const next = backwards[0];
      if (next === undefined) continue;
      cases += 1;

      const crowd = makeCrowd(1);
      // Far enough for the coarse simulation level, well inside the recycle
      // radius so nobody is respawned out from under the test.
      const point = { x: 0, z: 0 };
      linkPoint(link, link.length - 0.65, 0, point);
      const px = point.x;
      const pz = point.z + 110;

      // Prime the crowd: the very first update reseeds, because a crowd with no
      // previous player position cannot tell a first frame from a teleport.
      crowd.update(1 / 30, { x: px, y: 0, z: pz, time: 0 });

      const ped = crowd.peds[0] as Pedestrian;
      ped.active = true;
      ped.link = i;
      ped.next = next;
      ped.along = link.length - 0.65;
      ped.lateral = 0;
      ped.lateralTarget = 0;
      ped.state = 'cross';
      ped.timer = 0;
      ped.stall = 0;
      ped.stallTries = 0;
      ped.dodge = 0;
      ped.due = 0;
      ped.x = point.x;
      ped.z = point.z;
      ped.vx = link.dx * ped.speed;
      ped.vz = link.dz * ped.speed;
      ped.anchorX = ped.x;
      ped.anchorZ = ped.z;

      // Four seconds: many times the one a walker needs to cover the remaining
      // 0.65 m, and deliberately short of the 7.5 s the stall watchdog's ladder
      // takes to reach its last rung, so this tests the steering rather than
      // the safety net underneath it.
      let left = false;
      for (let step = 1; step <= 120 && !left; step += 1) {
        crowd.update(1 / 30, { x: px, y: 0, z: pz, time: step / 30 });
        if (ped.link !== i) left = true;
      }

      expect(
        left,
        `${link.id} -> ${graph.links[next]?.id ?? '?'}: still on the crossing after 4 s, ` +
          `${(link.length - ped.along).toFixed(2)} m short of the kerb at ${ped.speed.toFixed(2)} m/s`,
      ).toBe(true);
    }
    expect(cases, 'nothing was exercised').toBeGreaterThan(0);
  });
});

describe('corridors street furniture has closed', () => {
  it('recognises a corridor with a prop straight across it', () => {
    // A synthetic corridor over real ground, so the index's own height filter
    // behaves exactly as it does in the city.
    const here = ground.sample(SPAWN.x, SPAWN.z).y;
    const link: PavementLink = {
      id: 'test',
      from: 0,
      to: 1,
      ax: SPAWN.x,
      az: SPAWN.z,
      bx: SPAWN.x,
      bz: SPAWN.z + 10,
      dx: 0,
      dz: 1,
      nx: -1,
      nz: 0,
      length: 10,
      halfWidth: 1.1,
      streetId: 'test',
      crossing: null,
      reverse: -1,
    };
    const wall: ColliderBox = {
      minX: SPAWN.x - 3,
      maxX: SPAWN.x + 3,
      minZ: SPAWN.z + 4.7,
      maxZ: SPAWN.z + 5.3,
      bottom: here,
      top: here + 1,
      solid: true,
    };
    const gap: ColliderBox = {
      // Same wall with the far half missing: a walker can still get by.
      minX: SPAWN.x - 3,
      maxX: SPAWN.x + 0.2,
      minZ: SPAWN.z + 4.7,
      maxZ: SPAWN.z + 5.3,
      bottom: here,
      top: here + 1,
      solid: true,
    };
    expect(new ObstacleIndex(plan, ground, [wall]).blocksCorridor(link, WALK_RADIUS)).toBe(true);
    expect(new ObstacleIndex(plan, ground, [gap]).blocksCorridor(link, WALK_RADIUS)).toBe(false);
    expect(new ObstacleIndex(plan, ground, []).blocksCorridor(link, WALK_RADIUS)).toBe(false);
  });

  it("finds the city's own blocked crossing and refuses to route through it", () => {
    const crowd = makeCrowd(240);
    // Meridian Bay's scatter closes `j:harbour-walk:cooper-street:n` with a
    // planter over the middle of the crossing and a bollard beside it.
    expect(crowd.closedLinks).toBeGreaterThan(0);

    // Seed the crowd ON the closed corridor's doorstep, otherwise the run
    // proves nothing: nobody walks 150 m to the far side of the city in a
    // minute, and the test would pass whether or not the router avoids it.
    let closed = -1;
    for (let i = 0; i < graph.links.length; i += 1) {
      if (crowd.isClosed(i)) {
        closed = i;
        break;
      }
    }
    const shut = graph.links[closed];
    expect(shut, 'no closed link to test against').toBeDefined();
    if (!shut) return;
    const nearX = (shut.ax + shut.bx) * 0.5;
    const nearZ = (shut.az + shut.bz) * 0.5;

    crowd.seed(nearX, nearZ);
    let entered = 0;
    for (let step = 0; step < 3600; step += 1) {
      crowd.update(1 / 30, { x: nearX, y: 0, z: nearZ, time: step / 30 });
      for (const ped of crowd.peds) {
        if (ped.active && crowd.isClosed(ped.link)) entered += 1;
      }
    }
    expect(entered, `pedestrians stood on a closed corridor ${entered} times`).toBe(0);
  });
});

describe('no pedestrian stands still for long', () => {
  /**
   * The catch-all. Judged on WORLD displacement over a rolling window, because
   * that is what a player sees; `pause` and `wait` are excluded because they
   * are deliberate, and both are bounded elsewhere (a pause is at most 6.5 s
   * and a signal cycle is 26 s).
   *
   * Measured on the unfixed code over exactly this run: the worst walker stood
   * still for 16.4 s.
   */
  it('keeps every walker moving through a five minute run', () => {
    const dt = 1 / 30;
    const steps = 300 / dt;
    const windowSteps = Math.round(4 / dt);
    const crowd = makeCrowd(240);
    const count = crowd.peds.length;

    const historyX = new Float64Array(count * windowSteps);
    const historyZ = new Float64Array(count * windowSteps);
    const stalled = new Float64Array(count);
    let worst = 0;
    let worstWho = '';

    crowd.update(dt, { x: SPAWN.x, y: 0, z: SPAWN.z, time: 0 });
    for (let step = 0; step < steps; step += 1) {
      crowd.update(dt, { x: SPAWN.x, y: 0, z: SPAWN.z, time: (step + 1) * dt });
      const slot = step % windowSteps;
      for (let i = 0; i < count; i += 1) {
        const ped = crowd.peds[i];
        if (!ped) continue;
        const base = i * windowSteps;
        const wasX = historyX[base + slot] ?? 0;
        const wasZ = historyZ[base + slot] ?? 0;
        historyX[base + slot] = ped.x;
        historyZ[base + slot] = ped.z;
        if (!ped.active || ped.state === 'pause' || ped.state === 'wait' || step < windowSteps) {
          stalled[i] = 0;
          continue;
        }
        const moved = Math.hypot(ped.x - wasX, ped.z - wasZ);
        // A respawn is a jump, not progress and not a stall.
        if (moved > 40 || moved > 0.6) {
          stalled[i] = 0;
          continue;
        }
        const held = (stalled[i] ?? 0) + dt;
        stalled[i] = held;
        if (held > worst) {
          worst = held;
          const link = graph.links[ped.link];
          worstWho =
            `#${i} ${ped.state} on ${link?.id ?? '?'} at ` +
            `${ped.along.toFixed(2)}/${(link?.length ?? 0).toFixed(2)}, ` +
            `${ped.speed.toFixed(2)} m/s, at (${ped.x.toFixed(1)}, ${ped.z.toFixed(1)})`;
        }
      }
    }

    expect(worst, `stalled for ${worst.toFixed(1)} s: ${worstWho}`).toBeLessThan(12);
  });
});
