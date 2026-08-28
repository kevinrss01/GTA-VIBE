/**
 * The airport's population: how many people, where, and where never.
 *
 * The defect these exist for was photographed rather than measured: "an
 * implausibly large wall-like crowd gathered across the airport road and
 * parking area". It reproduced immediately, because the city crowd had no idea
 * the airport existed - grepping `src/agents` for `airport` returned nothing -
 * and `CityPlan` authors the airport's roads as ordinary streets so that the
 * traffic simulation, the signal heads and the pavement graph pick them up
 * with no special case. A fixed population of 270 recycled inside a 152 m
 * radius therefore packed the same head count onto a fifth of the pavement.
 *
 * Measured on the shipped build, one-way metres of pavement inside the crowd's
 * own seed radius against the people crammed into it:
 *
 *   Old Quarter        3324 m   270 people   0.081 per metre
 *   city spawn         2037 m   270 people   0.133 per metre
 *   airport forecourt  1241 m   270 people   0.218 per metre
 *   airport car park    597 m   270 people   0.452 per metre
 *
 * So the assertions here are about DENSITY and ZONING rather than about a
 * head count, and the sweeps are exhaustive rather than spot checks: every
 * active agent, at every sampled frame, at every vantage.
 */

import { describe, expect, it } from 'vitest';

import { buildRoadNetwork } from '../src/city/RoadNetwork';
import { getCityPlan } from '../src/world/CityPlan';
import { CityGround } from '../src/world/CityGround';
import {
  ALARM_RADIUS,
  CASUALTY_CLEAR,
  CASUALTY_LIMIT,
  CASUALTY_TIME,
  Crowd,
  RENDER_RADIUS,
  type Pedestrian,
} from '../src/agents/crowd';
import { InstancedMesh } from 'three';

import { insetRect } from '../src/core/mathx';
import { PedestrianSystem } from '../src/agents/PedestrianSystem';
import {
  AIRPORT_VAT_IDS,
  CITY_ROSTER_BUDGET,
  CITY_VAT_IDS,
  TERMINAL_ROSTER_BUDGET,
  TERMINAL_VAT_IDS,
} from '../src/agents/PedestrianVat';
import { TerminalCrowd } from '../src/agents/travellers/TerminalCrowd';
import { DEFAULT_QUEUE_SLOTS, QUEUE_PITCH } from '../src/agents/travellers/travellerSim';
import { GATE_SEATS, TERMINAL_QUEUES } from '../src/world/airport/plan';
import { ObstacleIndex } from '../src/agents/obstacles';
import { buildPavementGraph } from '../src/agents/pavement';
import {
  PEDESTRIAN_ZONES,
  ZONE_RULES,
  isAirside,
  zoneAt,
  type PedestrianZone,
} from '../src/agents/travellers/zones';
import {
  AIRFIELD_LEVEL,
  APRON,
  RUNWAY,
  TAXIWAY,
  TERMINAL,
  TERMINAL_FLOOR,
  isOnPavedAirfield,
} from '../src/world/airport/layout';

const plan = getCityPlan();
const network = buildRoadNetwork(plan);
const ground = new CityGround(plan);
const graph = buildPavementGraph(plan, network);
const obstacles = new ObstacleIndex(plan, ground);

function makeCrowd(population = 270): Crowd {
  return new Crowd({ ground, network, graph, obstacles, population, seed: plan.seed });
}

/** Vantages inside and around Meridian Bay Regional. */
const AIRPORT_VANTAGES: readonly (readonly [string, number, number])[] = [
  ['approach road', 140, 300],
  ['forecourt', 183, 330],
  ['forecourt outer', 183, 300],
  ['terminal frontage', 172, 400],
  ['mid concourse', 183, 470],
  ['car park', 183, 600],
  ['hangar road', 160, 700],
  ['causeway north', 141, 200],
];

const CITY_VANTAGES: readonly (readonly [string, number, number])[] = [
  ['city spawn', plan.spawn.x, plan.spawn.z],
  ['old quarter', -60, -40],
  ['grand concourse', -28, -62],
];

interface Census {
  /** Highest simultaneous occupancy seen in each zone. */
  readonly peakByZone: Map<PedestrianZone, number>;
  /** Every position ever sampled that broke a hard rule. */
  readonly illegal: string[];
  /** Peak active population. */
  peakActive: number;
  /** People-per-metre of raw pavement inside the seed radius, at the peak. */
  density: number;
  samples: number;
}

/** One-way metres of pavement whose midpoint is within `r`, zoning ignored. */
function rawPavementNear(px: number, pz: number, r: number): number {
  let total = 0;
  for (let i = 0; i < graph.links.length; i += 1) {
    const link = graph.links[i];
    if (!link || link.crossing) continue;
    if (link.reverse >= 0 && link.reverse < i) continue;
    const mx = (link.ax + link.bx) * 0.5;
    const mz = (link.az + link.bz) * 0.5;
    if (Math.hypot(mx - px, mz - pz) <= r) total += link.length;
  }
  return total;
}

/**
 * Stands a player at a point, runs the crowd, and records everything the
 * assertions below need.
 *
 * `seconds` is real simulated time at 30 Hz. The sweep looks at EVERY active
 * agent on every sampled frame rather than at a handful, which is what makes
 * "nobody was ever on the apron" a statement about the run and not about the
 * three positions somebody thought to check.
 */
function census(px: number, pz: number, seconds = 45, population = 270): Census {
  const crowd = makeCrowd(population);
  crowd.seed(px, pz);
  const result: Census = {
    peakByZone: new Map(),
    illegal: [],
    peakActive: 0,
    density: 0,
    samples: 0,
  };
  const raw = Math.max(1, rawPavementNear(px, pz, RENDER_RADIUS * 0.95));
  let time = 0;
  const steps = Math.round(seconds * 30);
  for (let step = 0; step < steps; step += 1) {
    time += 1 / 30;
    crowd.update(1 / 30, { x: px, y: 14.5, z: pz, time });
    // Every fifth frame: six samples a second is far finer than anything the
    // crowd can change in, and keeps a ten-vantage sweep inside a second.
    if (step % 5 !== 0) continue;
    result.samples += 1;
    const counts = new Map<PedestrianZone, number>();
    let active = 0;
    for (const ped of crowd.peds) {
      if (!ped.active) continue;
      active += 1;
      const zone = zoneAt(ped.x, ped.z);
      counts.set(zone, (counts.get(zone) ?? 0) + 1);
      const rule = ZONE_RULES[zone];
      if (rule.forbidden) {
        result.illegal.push(
          `${rule.label} at (${ped.x.toFixed(1)}, ${ped.z.toFixed(1)}) on link ${ped.link}`,
        );
      }
    }
    for (const [zone, n] of counts) {
      result.peakByZone.set(zone, Math.max(result.peakByZone.get(zone) ?? 0, n));
    }
    if (active > result.peakActive) {
      result.peakActive = active;
      result.density = active / raw;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------

describe('the zone table', () => {
  it('is internally consistent', () => {
    for (const zone of PEDESTRIAN_ZONES) {
      const rule = ZONE_RULES[zone];
      expect(rule.id, `${zone} is keyed by its own id`).toBe(zone);
      expect(rule.share).toBeGreaterThanOrEqual(0);
      expect(rule.share).toBeLessThanOrEqual(1);
      expect(rule.forbidden, `${zone}: forbidden and share disagree`).toBe(rule.share === 0);
      if (rule.forbidden) expect(rule.cap).toBe(0);
      else expect(rule.cap).toBeGreaterThan(0);
    }
    // The city must be untouched by any of this.
    expect(ZONE_RULES.city.share).toBe(1);
    expect(ZONE_RULES.city.cap).toBe(Number.POSITIVE_INFINITY);
  });

  it('puts every airside surface the layout publishes out of bounds', () => {
    // A grid over the whole platform, not three spot checks: every square metre
    // of runway, taxiway, apron and overrun has to answer the same way.
    let checked = 0;
    for (let x = 150; x <= 430; x += 5) {
      for (let z = 200; z <= 950; z += 5) {
        if (!isOnPavedAirfield(x, z)) continue;
        checked += 1;
        expect(isAirside(x, z), `paved airside at (${x}, ${z}) is not airside`).toBe(true);
        expect(zoneAt(x, z), `paved airside at (${x}, ${z})`).toBe('airside');
      }
    }
    expect(checked, 'the sweep found no airside at all').toBeGreaterThan(2000);

    // And the named surfaces specifically, so a future layout change that
    // moved one would fail here rather than silently stop being covered.
    expect(zoneAt(RUNWAY.centreX, (RUNWAY.northZ + RUNWAY.southZ) / 2)).toBe('airside');
    expect(zoneAt(RUNWAY.centreX, RUNWAY.northZ - RUNWAY.overrun + 1)).toBe('airside');
    expect(zoneAt(TAXIWAY.centreX, TAXIWAY.fromZ + 40)).toBe('airside');
    expect(zoneAt((APRON.minX + APRON.maxX) / 2, (APRON.minZ + APRON.maxZ) / 2)).toBe('airside');
    // The terminal interior belongs to `TerminalCrowd`, not to the street.
    expect(zoneAt((TERMINAL.minX + TERMINAL.maxX) / 2, (TERMINAL.minZ + TERMINAL.maxZ) / 2)).toBe(
      'terminal',
    );
  });
});

describe('the pavement the crowd is offered', () => {
  it('closes every link that touches a forbidden surface', () => {
    const crowd = makeCrowd(4);
    for (let i = 0; i < graph.links.length; i += 1) {
      const link = graph.links[i];
      if (!link) continue;
      // Sample the whole run, not the ends: a link is a corridor.
      const steps = Math.max(2, Math.ceil(link.length));
      for (let s = 0; s <= steps; s += 1) {
        const t = s / steps;
        const x = link.ax + (link.bx - link.ax) * t;
        const z = link.az + (link.bz - link.az) * t;
        if (!ZONE_RULES[zoneAt(x, z)].forbidden) continue;
        expect(
          crowd.isClosed(i),
          `link ${link.id} reaches ${zoneAt(x, z)} at (${x.toFixed(1)}, ${z.toFixed(1)}) and is open`,
        ).toBe(true);
        break;
      }
    }
  });

  it('leaves the city graph exactly as open as it was', () => {
    // The zoning may not close a single city link: everything it closes is
    // either street furniture's doing or on the airport.
    const crowd = makeCrowd(4);
    for (let i = 0; i < graph.links.length; i += 1) {
      const link = graph.links[i];
      if (!link || !crowd.isClosed(i)) continue;
      const zone = crowd.zoneOf(i);
      if (zone === 'city') continue;
      expect(
        ZONE_RULES[zone].forbidden || obstacles.blocksCorridor(link, 0.41),
        `link ${link.id} in ${zone} was closed for no stated reason`,
      ).toBe(true);
    }
  });
});

describe('airport population density', () => {
  it('never puts anybody airside, on a taxiway, on the apron or inside the terminal', () => {
    for (const [name, px, pz] of AIRPORT_VANTAGES) {
      const result = census(px, pz);
      expect(result.samples).toBeGreaterThan(100);
      expect(
        result.illegal.slice(0, 5),
        `${name}: ${result.illegal.length} illegal positions`,
      ).toEqual([]);
    }
  });

  it('keeps every zone inside its cap', () => {
    /*
     * The caps are enforced where people are SPAWNED and by retiring the
     * surplus, and a retirement takes `FADE_TIME` to finish because nobody may
     * vanish in front of the player. So a zone runs a little over while that
     * happens, and this is the MEASURED slack rather than a round number: the
     * worst overshoot over eight vantages, forty-five seconds each, at the
     * shipped population, is three (forecourt 33 against a cap of 30).
     *
     * A forbidden zone gets no slack at all. Zero means zero.
     */
    const SLACK = 4;
    for (const [name, px, pz] of AIRPORT_VANTAGES) {
      const result = census(px, pz);
      for (const [zone, peak] of result.peakByZone) {
        const cap = ZONE_RULES[zone].cap;
        expect(peak, `${name}: ${peak} people in ${zone}, cap ${cap}`).toBeLessThanOrEqual(
          cap + (cap === 0 ? 0 : SLACK),
        );
      }
    }
  });

  it('is never denser per metre of pavement than the city is', () => {
    // The city's own worst, measured the same way, is the ceiling: whatever
    // the airport looks like, it may not be MORE crowded than downtown.
    let cityWorst = 0;
    for (const [, px, pz] of CITY_VANTAGES) {
      cityWorst = Math.max(cityWorst, census(px, pz, 30).density);
    }
    expect(cityWorst).toBeGreaterThan(0.05);
    for (const [name, px, pz] of AIRPORT_VANTAGES) {
      const result = census(px, pz, 30);
      expect(
        result.density,
        `${name}: ${result.density.toFixed(3)} people per metre against the city's ${cityWorst.toFixed(3)}`,
      ).toBeLessThanOrEqual(cityWorst);
    }
  });

  it('leaves the city crowd at its full quality budget', () => {
    for (const [name, px, pz] of CITY_VANTAGES) {
      const crowd = makeCrowd(270);
      crowd.seed(px, pz);
      let time = 0;
      for (let step = 0; step < 300; step += 1) {
        time += 1 / 30;
        crowd.update(1 / 30, { x: px, y: 0, z: pz, time });
      }
      expect(crowd.stats.limit, `${name} lost people to the density cap`).toBe(270);
      expect(crowd.stats.active, `${name}`).toBeGreaterThan(250);
    }
  });

  it('thins and refills as the player walks to the airport and back', () => {
    /*
     * The convergence, and the guarantee that it is never SEEN. A player walks
     * from the city edge down the approach road to the forecourt and back,
     * and at no point may an active pedestrian inside the draw radius go
     * inactive without having faded out first.
     */
    const crowd = makeCrowd(270);
    const wasActive = crowd.peds.map(() => false);
    const lastFade = crowd.peds.map(() => 1);
    const lastDistance = crowd.peds.map(() => Number.POSITIVE_INFINITY);
    let pops = 0;
    let time = 0;
    let low = Number.POSITIVE_INFINITY;
    let high = 0;

    const leg = (fromZ: number, toZ: number): void => {
      const steps = Math.round(Math.abs(toZ - fromZ) / (1.6 / 30));
      for (let step = 0; step < steps; step += 1) {
        const z = fromZ + ((toZ - fromZ) * step) / steps;
        time += 1 / 30;
        crowd.update(1 / 30, { x: 141, y: 14.5, z, time, forwardX: 0, forwardZ: Math.sign(toZ - fromZ) });
        for (let i = 0; i < crowd.peds.length; i += 1) {
          const ped = crowd.peds[i] as Pedestrian;
          if (wasActive[i] && !ped.active && (lastDistance[i] as number) <= RENDER_RADIUS) {
            // Legal only if they were already dissolving.
            if ((lastFade[i] as number) > 0.35) pops += 1;
          }
          wasActive[i] = ped.active;
          lastFade[i] = ped.fade;
          lastDistance[i] = Math.hypot(ped.x - 141, ped.z - z);
        }
        if (z > 260) {
          low = Math.min(low, crowd.stats.active);
          high = Math.max(high, crowd.stats.active);
        }
      }
    };

    // Start well inside the city so the crowd is at full strength.
    crowd.update(1 / 30, { x: 141, y: 0, z: 100, time });
    leg(100, 330);
    const atAirport = crowd.stats.active;
    leg(330, 100);
    const backInTown = crowd.stats.active;

    expect(atAirport, 'the airport is still carrying a city crowd').toBeLessThan(90);
    expect(atAirport, 'the airport is deserted').toBeGreaterThan(12);
    expect(backInTown, 'the city never refilled').toBeGreaterThan(150);
    expect(pops, `${pops} people blinked out inside the draw radius`).toBe(0);
    expect(high - low, 'the airport population never settled').toBeLessThan(70);
  });
});

describe('gunfire', () => {
  it('leaves a shot civilian down permanently and a knocked-down one gets up', () => {
    const crowd = makeCrowd(120);
    crowd.seed(plan.spawn.x, plan.spawn.z);
    let time = 0;
    const step = (n: number): void => {
      for (let i = 0; i < n; i += 1) {
        time += 1 / 30;
        crowd.update(1 / 30, { x: plan.spawn.x, y: 0, z: plan.spawn.z, time });
      }
    };
    step(60);

    const victim = crowd.peds.find((p) => p.active && p.state !== 'down') as Pedestrian;
    expect(victim).toBeTruthy();
    expect(crowd.casualtyAt(victim.x, victim.z, { dirX: 1, dirZ: 0 })).toBe(true);
    expect(victim.state).toBe('down');
    expect(victim.fatal, 'a lethal round has to leave a persistent casualty').toBe(true);

    // A vehicle knock-down below the fatal speed is the OTHER state: it rises.
    const survivor = crowd.peds.find(
      (p) => p.active && p.state !== 'down' && p !== victim,
    ) as Pedestrian;
    crowd.knockDown(survivor, 1, 0, 3, false);
    expect(survivor.state).toBe('down');
    expect(survivor.fatal).toBe(false);

    // Twenty seconds is well past the rise but far short of `CASUALTY_TIME`,
    // and the player has not moved, so nothing may be cleared away either.
    step(20 * 30);
    expect(survivor.state, 'a survivable knock-down never got up').not.toBe('down');
    expect(victim.state, 'a casualty got back up').toBe('down');
    expect(victim.fatal).toBe(true);
  });

  it('staggers a wounded civilian instead of flooring them', () => {
    const crowd = makeCrowd(120);
    crowd.seed(plan.spawn.x, plan.spawn.z);
    let time = 0;
    const step = (n: number): void => {
      for (let i = 0; i < n; i += 1) {
        time += 1 / 30;
        crowd.update(1 / 30, { x: plan.spawn.x, y: 0, z: plan.spawn.z, time });
      }
    };
    step(90);

    const victim = crowd.peds.find(
      (p) => p.active && p.state !== 'down' && p.state !== 'wait',
    ) as Pedestrian;
    const fromX = victim.x;
    const fromZ = victim.z;
    expect(crowd.casualtyAt(victim.x, victim.z, { lethal: false, dirX: 1, dirZ: 0 })).toBe(true);

    // Upright, and therefore still a target for whoever is shooting.
    expect(victim.state, 'a wounded civilian was put on the ground').not.toBe('down');
    expect(victim.stagger).toBeGreaterThan(0);
    expect(victim.alarm, 'a wounded civilian did not react').toBeGreaterThan(0);
    // The lean arrives over the onset rather than snapping on, so it is zero
    // on the frame of the hit and at its deepest a few frames later.
    expect(Math.abs(Crowd.tilt(victim)), 'the flinch popped straight to full lean').toBe(0);

    // The stumble carries them along the round's line of travel, and the
    // pavement clamp still owns where they end up.
    step(6);
    // Leaning, drawn by the same instance matrix a topple uses.
    expect(Math.abs(Crowd.tilt(victim))).toBeGreaterThan(0.05);
    expect(Math.abs(Crowd.tilt(victim)), 'a flinch is not a topple').toBeLessThan(0.35);
    step(6);
    expect(victim.x - fromX, 'the stumble went the wrong way').toBeGreaterThan(0);
    expect(Math.hypot(victim.x - fromX, victim.z - fromZ), 'the stumble is a teleport').toBeLessThan(
      3,
    );

    // And it is over inside a second, leaving somebody running rather than a
    // permanent limp.
    step(45);
    expect(victim.stagger).toBe(0);
    expect(Crowd.tilt(victim)).toBe(0);
    expect(victim.state).not.toBe('down');
  });

  it('floors a wounded civilian only when the caller asks for it', () => {
    const crowd = makeCrowd(120);
    crowd.seed(plan.spawn.x, plan.spawn.z);
    let time = 0;
    for (let i = 0; i < 60; i += 1) {
      time += 1 / 30;
      crowd.update(1 / 30, { x: plan.spawn.x, y: 0, z: plan.spawn.z, time });
    }
    const victim = crowd.peds.find((p) => p.active && p.state !== 'down') as Pedestrian;
    expect(crowd.casualtyAt(victim.x, victim.z, { lethal: false, floor: true })).toBe(true);
    expect(victim.state).toBe('down');
    expect(victim.fatal).toBe(false);
    for (let i = 0; i < 20 * 30; i += 1) {
      time += 1 / 30;
      crowd.update(1 / 30, { x: plan.spawn.x, y: 0, z: plan.spawn.z, time });
    }
    expect(victim.state, 'a survivable knock-down never got up').not.toBe('down');
  });

  it('bounds the bodies and only clears one the player has walked away from', () => {
    const crowd = makeCrowd(270);
    const px = plan.spawn.x;
    const pz = plan.spawn.z;
    crowd.seed(px, pz);
    let time = 0;
    const step = (n: number, x = px, z = pz): void => {
      for (let i = 0; i < n; i += 1) {
        time += 1 / 30;
        crowd.update(1 / 30, { x, y: 0, z, time });
      }
    };
    step(90);

    // Shoot far more people than the bound allows.
    let shot = 0;
    for (const ped of crowd.peds) {
      if (!ped.active || ped.state === 'down') continue;
      if (Math.hypot(ped.x - px, ped.z - pz) > CASUALTY_CLEAR * 0.6) continue;
      if (crowd.casualtyAt(ped.x, ped.z, { radius: 0.5 })) shot += 1;
      if (shot >= CASUALTY_LIMIT * 2) break;
    }
    expect(shot).toBeGreaterThan(CASUALTY_LIMIT);

    // The player stays put. Every body is inside `CASUALTY_CLEAR`, so however
    // long they lie there NOT ONE may be taken away.
    step(Math.round((CASUALTY_TIME + 30) * 30));
    expect(
      crowd.stats.casualties,
      'a body was cleared away from under the player',
    ).toBeGreaterThanOrEqual(shot - 2);

    // Walk away, and the bounded cleanup runs.
    step(Math.round(40 * 30), px + 200, pz);
    expect(crowd.stats.casualties, 'bodies are unbounded').toBeLessThanOrEqual(CASUALTY_LIMIT);
  });

  it('makes the street react to a shot and forgets it in a bounded way', () => {
    const crowd = makeCrowd(200);
    const px = plan.spawn.x;
    const pz = plan.spawn.z;
    crowd.seed(px, pz);
    let time = 0;
    for (let i = 0; i < 90; i += 1) {
      time += 1 / 30;
      crowd.update(1 / 30, { x: px, y: 0, z: pz, time });
    }

    const heard = crowd.alarmAt(px, pz);
    expect(heard, 'nobody heard a shot in the middle of a crowd').toBeGreaterThan(3);
    let alarmed = 0;
    let moved = 0;
    const before = crowd.peds.filter((p) => p.alarm > 0).map((p) => Math.hypot(p.x - px, p.z - pz));
    for (const ped of crowd.peds) {
      if (!ped.active || ped.alarm <= 0) continue;
      alarmed += 1;
      expect(Math.hypot(ped.x - px, ped.z - pz)).toBeLessThanOrEqual(ALARM_RADIUS + 1e-6);
    }
    expect(alarmed).toBe(heard);
    expect(crowd.stats.alarmed).toBeGreaterThanOrEqual(0);

    // Six seconds later they are further from the shot than they were.
    const ids = crowd.peds.map((p, i) => (p.alarm > 0 ? i : -1)).filter((i) => i >= 0);
    for (let i = 0; i < 6 * 30; i += 1) {
      time += 1 / 30;
      crowd.update(1 / 30, { x: px, y: 0, z: pz, time });
    }
    for (let k = 0; k < ids.length; k += 1) {
      const ped = crowd.peds[ids[k] as number] as Pedestrian;
      if (!ped.active) continue;
      if (Math.hypot(ped.x - px, ped.z - pz) > (before[k] ?? 0)) moved += 1;
    }
    expect(moved / Math.max(1, ids.length), 'the street did not move away from the shot').toBeGreaterThan(
      0.55,
    );

    // Twelve seconds after that, `ALARM_TIME` has expired for everybody.
    for (let i = 0; i < 12 * 30; i += 1) {
      time += 1 / 30;
      crowd.update(1 / 30, { x: px, y: 0, z: pz, time });
    }
    expect(crowd.stats.alarmed, 'the alarm never wore off').toBe(0);

    // And the remembered list is bounded however many rounds are fired.
    for (let i = 0; i < 50; i += 1) crowd.alarmAt(px + i, pz);
    expect(crowd.recentAlarms.length).toBeLessThanOrEqual(8);
  });
});

describe('grounding', () => {
  /**
   * A pedestrian's `y` has to be the surface under them, wherever they are.
   *
   * The airfield is a graded platform at `AIRFIELD_LEVEL`, the terminal floor
   * is one step above it, and the city is a ramp. All three are the SAME
   * sampler, and this is the check that the crowd is asking it.
   */
  it('stands people on the surface at the airport and in the city', () => {
    for (const [name, px, pz] of [...AIRPORT_VANTAGES, ...CITY_VANTAGES]) {
      const crowd = makeCrowd(270);
      crowd.seed(px, pz);
      let time = 0;
      for (let step = 0; step < 600; step += 1) {
        time += 1 / 30;
        crowd.update(1 / 30, { x: px, y: 14.5, z: pz, time });
      }
      let worst = 0;
      let where = '';
      for (const ped of crowd.peds) {
        if (!ped.active) continue;
        const error = Math.abs(ped.y - ground.sample(ped.x, ped.z).y);
        if (error > worst) {
          worst = error;
          where = `(${ped.x.toFixed(1)}, ${ped.z.toFixed(1)})`;
        }
      }
      // A kerb is 0.15 m and the crowd EASES onto a new height rather than
      // snapping, so a walker crossing one is legitimately a few centimetres
      // out for a frame or two. Anything past a step is floating.
      expect(worst, `${name}: ${worst.toFixed(3)} m off the ground at ${where}`).toBeLessThan(0.2);
    }
  });

  it('knows the airport platform and the terminal floor are different heights', () => {
    // Not a crowd assertion - a guard on the numbers the crowd is grounded
    // against, so a change to the platform shows up here.
    expect(ground.sample(200, 300).y).toBeCloseTo(AIRFIELD_LEVEL, 1);
    expect(TERMINAL_FLOOR).toBeGreaterThan(AIRFIELD_LEVEL);
    expect(TERMINAL_FLOOR - AIRFIELD_LEVEL).toBeCloseTo(0.16, 3);
  });
});

describe('the crowd while its characters are still downloading', () => {
  /**
   * NOBODY MAY EVER BE A T-POSE.
   *
   * Two separate guarantees, and both are checked here because both were
   * available to get wrong:
   *
   *   - a missing or refused VAT leaves the PROCEDURAL crowd up, posed by
   *     `gait.ts`, rather than an empty street or a rest pose;
   *   - a freshly seeded crowd is spread across the walk cycle rather than
   *     every one of them stepping off with the same foot on frame one.
   */
  it('degrades to the procedural crowd when no character can be fetched', async () => {
    // `fetch` cannot reach anything from a unit test, so every id fails - the
    // same path a 404 or a bake over the slip gate takes in the browser.
    const system = new PedestrianSystem({
      plan,
      ground,
      network,
      quality: 'high',
      density: 40,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    system.update(1 / 60, { x: plan.spawn.x, y: 0, z: plan.spawn.z, time: 0 });
    system.update(1 / 60, { x: plan.spawn.x, y: 0, z: plan.spawn.z, time: 1 / 60 });

    expect(system.stats.characters, 'a character loaded in a unit test').toBe(0);
    const meshes = system.group.children.filter(
      (child): child is InstancedMesh => child instanceof InstancedMesh,
    );
    const procedural = meshes.find((mesh) => mesh.name === 'pedestriansProcedural');
    expect(procedural, 'the procedural crowd is missing').toBeTruthy();
    expect(procedural?.visible).toBe(true);
    expect(procedural?.count, 'the street is empty while the bakes download').toBeGreaterThan(0);
    // And the roster meshes are present but drawing nothing, which is what
    // lets `main.ts` pre-compile their programs behind the loading screen.
    for (const mesh of meshes) {
      if (mesh.name === 'pedestriansProcedural') continue;
      expect(mesh.count).toBe(0);
    }
    system.dispose();
  });

  it('spreads a fresh crowd across the walk cycle rather than in lockstep', () => {
    const crowd = makeCrowd(270);
    crowd.seed(plan.spawn.x, plan.spawn.z);
    const phases = crowd.peds.filter((p) => p.active).map((p) => p.phase);
    expect(phases.length).toBeGreaterThan(100);
    // Ten buckets, and every one of them occupied: a crowd all at phase zero
    // would put every person in the first.
    const buckets = new Set(phases.map((phase) => Math.floor(phase * 10)));
    expect(buckets.size, 'the crowd is in lockstep').toBeGreaterThanOrEqual(9);
    // Nobody is standing still on the first frame either - `place` starts
    // everybody walking, which is what makes the rest pose unreachable.
    expect(crowd.peds.filter((p) => p.active && p.gait > 0.9).length).toBe(phases.length);
  });
});

describe('the terminal', () => {
  /**
   * Queues only at declared service points.
   *
   * The anchors come from `world/airport/plan.ts`, which the terminal builder
   * builds the desks and the scanners to - so this is the check that people
   * are not queueing in the middle of the concourse, and that every line runs
   * backwards from a desk rather than through it.
   */
  it('queues only where the plan declares a service point', () => {
    const region = insetRect(TERMINAL, 1.6);
    const crowd = new TerminalCrowd({
      region,
      obstacles: [],
      seats: GATE_SEATS,
      queues: TERMINAL_QUEUES,
      floorY: TERMINAL_FLOOR,
      quality: 'high',
      seed: 4242,
    });
    for (let step = 0; step < 60 * 60; step += 1) {
      crowd.update(1 / 60, { x: 183, z: 450, time: step / 60 });
    }

    let queueing = 0;
    for (const traveller of crowd.sim.travellers) {
      if (traveller.state !== 'queue') continue;
      queueing += 1;
      const queue = crowd.sim.queues[traveller.queue];
      expect(queue, 'somebody is queueing at no queue at all').toBeTruthy();
      const anchor = (queue as { anchor: { x: number; z: number } }).anchor;
      // Inside the line's own length of its head, and no further.
      const along = Math.hypot(traveller.x - anchor.x, traveller.z - anchor.z);
      expect(
        along,
        `a queuer is ${along.toFixed(1)} m from the desk they are queueing at`,
      ).toBeLessThan(QUEUE_PITCH * DEFAULT_QUEUE_SLOTS + 2.5);
      // And the anchor is one the plan published, not one invented at runtime.
      expect(
        TERMINAL_QUEUES.some((q) => q.x === anchor.x && q.z === anchor.z),
        'a queue formed at an undeclared point',
      ).toBe(true);
    }
    expect(queueing, 'nobody ever queued').toBeGreaterThan(4);
    expect(crowd.sim.stats.served, 'the desks never served anybody').toBeGreaterThan(4);
  });

  it('gives the terminal its own cast without spending the street crowd budget', () => {
    expect(TERMINAL_VAT_IDS.length).toBeLessThanOrEqual(TERMINAL_ROSTER_BUDGET);
    expect(CITY_VAT_IDS.length).toBeLessThanOrEqual(CITY_ROSTER_BUDGET);
    // The airport characters must not be drawn by the street crowd, which is
    // the whole reason the rosters are two lists.
    for (const id of AIRPORT_VAT_IDS) expect(CITY_VAT_IDS).not.toContain(id);
  });
});
