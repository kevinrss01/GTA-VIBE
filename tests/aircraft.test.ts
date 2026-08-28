/**
 * The aircraft in the world: parking, boarding, leaving, and not going
 * through things.
 *
 * `AircraftSystem` builds its fleet from `STANDS` in its constructor and only
 * touches WebGL inside `load()`, and `Flying` takes its camera, its DOM
 * element and its player as optional structural pieces. Both therefore run
 * here with no renderer, no canvas and no `window` at all, which is the
 * project's rule for anything that simulates.
 */

import { describe, expect, it } from 'vitest';

import { AIRCRAFT, type AircraftType } from '../src/air/AircraftCatalogue';
import { AircraftSystem, STAND_FLEET, enterRadius } from '../src/air/AircraftSystem';
import { FLIGHT_CONTROLS, Flying, flightControlHints, type FlyingPlayer } from '../src/air/Flying';
import { createFlightControls, trimLevelFlight, type FlightControls } from '../src/air/flight';
import { CollisionWorld } from '../src/player/Collision';
import { BODY_HEIGHT, BODY_RADIUS } from '../src/player/FirstPersonController';
import { controlHints } from '../src/ui/platform';
import {
  AIRFIELD_LEVEL,
  APRON,
  RUNWAY,
  RUNWAY_READY,
  STANDS,
  inRect,
} from '../src/world/airport/layout';
import { landElevation } from '../src/world/elevation';
import type { ColliderBox } from '../src/world/build/types';

const AIRFIELD_GROUND = (x: number, z: number): number => landElevation(x, z);

/** A player that only records where it was put. */
function stubPlayer(): FlyingPlayer & { at: { x: number; z: number } | null; paused: boolean } {
  return {
    at: null,
    paused: false,
    teleport(x: number, z: number): void {
      this.at = { x, z };
    },
    setPaused(paused: boolean): void {
      this.paused = paused;
    },
  };
}

function box(
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  bottom: number,
  top: number,
): ColliderBox {
  return { minX, minZ, maxX, maxZ, bottom, top, solid: true };
}

interface Rig {
  readonly air: AircraftSystem;
  readonly flying: Flying;
  readonly player: ReturnType<typeof stubPlayer>;
  readonly collision: CollisionWorld;
}

function rig(colliders: readonly ColliderBox[] = []): Rig {
  const air = new AircraftSystem({ groundY: AIRFIELD_GROUND });
  const collision = new CollisionWorld(colliders);
  const player = stubPlayer();
  const flying = new Flying({ aircraft: air, collision, groundY: AIRFIELD_GROUND, controller: player });
  return { air, flying, player, collision };
}

function controls(overrides: Partial<FlightControls> = {}): FlightControls {
  return { ...createFlightControls(), ...overrides };
}

/** Runs `flying` for a number of seconds at a chosen frame rate. */
function fly(flying: Flying, seconds: number, input: FlightControls, hz = 60): void {
  for (let i = 0; i < seconds * hz; i += 1) flying.update(1 / hz, input);
}

// -- parking ------------------------------------------------------------------

describe('the parked fleet', () => {
  it('puts one aircraft on every stand, at the stand’s own position', () => {
    const { air } = rig();
    const list = air.list;
    // Every stand, plus the one lined up on the runway overrun.
    expect(list).toHaveLength(STANDS.length + 1);

    for (const stand of STANDS) {
      const parked = list.find((craft) => craft.standId === stand.id);
      expect(parked, `nothing on ${stand.id}`).toBeDefined();
      if (!parked) continue;
      expect(parked.x).toBe(stand.x);
      expect(parked.z).toBe(stand.z);
      expect(parked.yaw).toBe(stand.heading);
      expect(parked.type).toBe(STAND_FLEET[stand.id]);
    }
  });

  it('sits every one of them exactly on the apron at AIRFIELD_LEVEL', () => {
    const { air } = rig();
    for (const craft of air.list) {
      // The graded platform really is level, and the aircraft is ON it -
      // not floating above it and not sunk into it.
      expect(craft.y).toBe(AIRFIELD_LEVEL);
      expect(craft.pitch).toBe(craft.spec.groundPitch);
      expect(craft.roll).toBe(0);
      // And inside the apron rectangle the layout drew, wings included. The
      // runway-ready aeroplane is deliberately not on the apron; it has its
      // own assertions below.
      if (craft.standId === RUNWAY_READY.id) continue;
      expect(inRect(APRON, craft.x, craft.z, craft.spec.halfWidth + 1)).toBe(true);
    }
  });

  /*
   * THE AEROPLANE A PLAYER CAN ACTUALLY FLY.
   *
   * Every stand is at x = 240 facing east while the runway is at x = 340
   * running north-south, so an aeroplane taken from a stand and given full
   * power rolls ACROSS the runway and off the far side. Flying required a
   * hundred metres of taxi and a ninety-degree turn that nothing tells you
   * about, and it was reported as not being able to fly at all.
   *
   * These pin the aeroplane that answers that: on the centreline, pointing
   * down the runway, with the whole of it in front and nothing parked on the
   * surface anything lands on.
   */
  describe('the runway-ready aeroplane', () => {
    it('is lined up on the centreline, off the landing surface', () => {
      const { air } = rig();
      const ready = air.list.find((craft) => craft.standId === RUNWAY_READY.id);
      expect(ready, 'no aeroplane on the runway threshold').toBeDefined();
      if (!ready) return;
      expect(ready.x).toBe(RUNWAY.centreX);
      expect(ready.yaw).toBe(RUNWAY_READY.heading);
      expect(ready.y).toBe(AIRFIELD_LEVEL);
      // Before the threshold, on the paved overrun, so it is not standing on
      // the touchdown zone.
      expect(ready.z).toBeLessThan(RUNWAY.northZ);
      expect(ready.z).toBeGreaterThan(RUNWAY.northZ - RUNWAY.overrun);
    });

    it('has the whole runway in front of it', () => {
      const { air } = rig();
      const ready = air.list.find((craft) => craft.standId === RUNWAY_READY.id);
      if (!ready) throw new Error('no runway-ready aeroplane');
      // Forward is (-sin yaw, 0, -cos yaw): at PI that is +Z, toward the far
      // threshold. Anything else and full power drives it off the airfield.
      const forwardZ = -Math.cos(ready.yaw);
      expect(forwardZ).toBeGreaterThan(0.99);
      const runAhead = RUNWAY.southZ - ready.z;
      expect(runAhead).toBeGreaterThan(600);
    });

    it('is a type the player is allowed to fly', () => {
      const { air } = rig();
      const ready = air.list.find((craft) => craft.standId === RUNWAY_READY.id);
      if (!ready) throw new Error('no runway-ready aeroplane');
      expect(ready.spec.flyable).toBe(true);
    });
  });

  it('gives the heavy stand the only aircraft that fits it', () => {
    const { air } = rig();
    const heavy = STANDS.filter((stand) => stand.size === 'heavy').map((stand) => stand.id);
    for (const craft of air.list) {
      if (craft.type !== 'liner') continue;
      expect(heavy).toContain(craft.standId);
    }
    // Every stand's aircraft fits within the 51 m the apron is deep.
    for (const craft of air.list) {
      expect(craft.spec.span).toBeLessThan(APRON.maxZ - APRON.minZ);
    }
  });

  it('parks them far enough apart not to be touching', () => {
    const { air } = rig();
    const list = air.list;
    for (const craft of list) {
      const overlapping = air.blockedBy(
        craft.x,
        craft.z,
        craft.yaw,
        craft.spec.halfLength,
        craft.spec.halfWidth,
        craft.y,
        craft.y + craft.spec.height,
        craft.id,
      );
      expect(overlapping, `${craft.type} on ${craft.standId ?? '?'} overlaps a neighbour`).toBe(
        false,
      );
    }
  });
});

// -- getting in and out -------------------------------------------------------

describe('boarding', () => {
  it('takes the nearest aircraft and gives it back again', () => {
    const { air, flying, player } = rig();
    const stand = STANDS.find((candidate) => candidate.id === 'stand-4');
    expect(stand).toBeDefined();
    if (!stand) return;

    expect(flying.flying).toBe(false);
    expect(flying.candidateAt(stand.x + 3, stand.z)).not.toBeNull();
    expect(flying.tryEnter(stand.x + 3, stand.z)).toBe(true);
    expect(flying.flying).toBe(true);
    expect(flying.state.type).toBe(STAND_FLEET[stand.id]);
    expect(player.paused).toBe(true);
    // The aircraft is marked as flown so nothing else can take it.
    expect(air.list.filter((craft) => craft.piloted)).toHaveLength(1);
    expect(flying.candidateAt(stand.x + 3, stand.z)).toBeNull();

    expect(flying.exit()).toBe(true);
    expect(flying.flying).toBe(false);
    expect(player.paused).toBe(false);
    expect(air.list.filter((craft) => craft.piloted)).toHaveLength(0);
    // And it can be taken again.
    expect(flying.tryEnter(stand.x + 3, stand.z)).toBe(true);
  });

  it('refuses an aircraft that is out of reach', () => {
    const { flying } = rig();
    const stand = STANDS[3];
    expect(stand).toBeDefined();
    if (!stand) return;
    const reach = enterRadius(AIRCRAFT[STAND_FLEET[stand.id] ?? 'cessna']);
    expect(flying.tryEnter(stand.x, stand.z + reach + 5)).toBe(false);
    expect(flying.flying).toBe(false);
  });

  it('will not hand over the airliner', () => {
    const { air, flying } = rig();
    const liner = air.list.find((craft) => craft.type === 'liner');
    expect(liner).toBeDefined();
    if (!liner) return;
    expect(AIRCRAFT.liner.flyable).toBe(false);
    expect(flying.tryEnter(liner.x, liner.z)).toBe(false);
    expect(air.takeControl(liner.id)).toBeNull();
    expect(flying.placeInAircraft('liner', 300, 400, 0)).toBe(false);
  });

  it('puts the player down on solid ground, clear of the aircraft', () => {
    const { air, flying, player, collision } = rig();
    for (const type of ['cessna', 'twin', 'jet'] as const) {
      expect(flying.placeInAircraft(type, RUNWAY.centreX, RUNWAY.northZ + 200, 0)).toBe(true);
      const spec = AIRCRAFT[type];
      expect(flying.exit()).toBe(true);
      expect(player.at).not.toBeNull();
      if (!player.at) continue;

      const { x, z } = player.at;
      // Not under the aeroplane: outside its footprint, whatever it is.
      const inside = air.blockedBy(
        x,
        z,
        0,
        BODY_RADIUS,
        BODY_RADIUS,
        AIRFIELD_LEVEL,
        AIRFIELD_LEVEL + BODY_HEIGHT,
      );
      expect(inside, `${type} put the player inside an aeroplane`).toBe(false);
      // Standing on the platform, not inside anything solid.
      expect(AIRFIELD_GROUND(x, z)).toBeCloseTo(AIRFIELD_LEVEL, 6);
      expect(collision.isStuck(x, z, AIRFIELD_LEVEL, BODY_HEIGHT, BODY_RADIUS)).toBe(false);
      // Beside it, not a hundred metres away.
      const distance = Math.hypot(x - RUNWAY.centreX, z - (RUNWAY.northZ + 200));
      expect(distance).toBeGreaterThan(spec.halfWidth);
      expect(distance).toBeLessThan(spec.halfWidth + 4);
    }
  });

  it('refuses to let the player out in the air', () => {
    const { flying } = rig();
    expect(
      flying.placeInAircraft(
        'cessna',
        RUNWAY.centreX,
        RUNWAY.northZ,
        Math.PI,
        AIRFIELD_LEVEL + 350,
      ),
    ).toBe(true);
    expect(flying.state.onGround).toBe(false);
    expect(flying.exit()).toBe(false);
    expect(flying.flying).toBe(true);
  });

  it('refuses while it is still rolling, and allows it once it has stopped', () => {
    const { flying } = rig();
    expect(flying.placeInAircraft('cessna', RUNWAY.centreX, RUNWAY.northZ, Math.PI)).toBe(true);

    fly(flying, 6, controls({ throttle: 1 }));
    expect(flying.state.onGround).toBe(true);
    expect(flying.state.groundSpeed).toBeGreaterThan(3);
    expect(flying.exit()).toBe(false);
    expect(flying.flying).toBe(true);

    fly(flying, 25, controls({ throttle: 0, brakes: true }));
    expect(flying.state.onGround).toBe(true);
    expect(flying.state.groundSpeed).toBeLessThan(0.5);
    expect(flying.exit()).toBe(true);
    expect(flying.flying).toBe(false);
  });
});

// -- collision ----------------------------------------------------------------

describe('collision', () => {
  it('does not tunnel through a wall at full speed', () => {
    // A 12 m thick block across the runway, from the surface to 60 m up.
    const wallZ = RUNWAY.northZ + 400;
    const { flying } = rig([
      box(
        RUNWAY.centreX - 60,
        wallZ,
        RUNWAY.centreX + 60,
        wallZ + 12,
        AIRFIELD_LEVEL,
        AIRFIELD_LEVEL + 60,
      ),
    ]);

    expect(
      flying.placeInAircraft('jet', RUNWAY.centreX, wallZ - 900, Math.PI, AIRFIELD_LEVEL + 25),
    ).toBe(true);
    // Nose down the throttle and fly straight at it as fast as it will go.
    let impacted = false;
    let furthest = -Infinity;
    for (let i = 0; i < 60 * 40; i += 1) {
      flying.update(1 / 60, controls({ throttle: 1, gearDown: false }));
      const state = flying.state;
      furthest = Math.max(furthest, state.z);
      if (state.crashed) impacted = true;
      if (impacted) break;
    }
    expect(impacted).toBe(true);
    // Stopped by the near face, never on the far side of the block.
    expect(furthest).toBeLessThan(wallZ + 12);
  });

  it('does not tunnel at the coarsest frame time the model accepts', () => {
    const wallZ = RUNWAY.northZ + 300;
    const { flying } = rig([
      box(
        RUNWAY.centreX - 60,
        wallZ,
        RUNWAY.centreX + 60,
        wallZ + 12,
        AIRFIELD_LEVEL,
        AIRFIELD_LEVEL + 60,
      ),
    ]);
    expect(
      flying.placeInAircraft('jet', RUNWAY.centreX, wallZ - 700, Math.PI, AIRFIELD_LEVEL + 25),
    ).toBe(true);
    let furthest = -Infinity;
    // 15 Hz: the accumulator caps the catch-up, so this is the worst the
    // model will ever be asked to resolve.
    for (let i = 0; i < 15 * 90; i += 1) {
      flying.update(1 / 15, controls({ throttle: 1, gearDown: false }));
      furthest = Math.max(furthest, flying.state.z);
    }
    expect(furthest).toBeLessThan(wallZ + 12);
  });

  it('flies OVER a building and hits the same building on the way down', () => {
    const roof = AIRFIELD_LEVEL + 40;
    const blockZ = RUNWAY.northZ + 350;
    const colliders = [
      box(RUNWAY.centreX - 60, blockZ, RUNWAY.centreX + 60, blockZ + 40, AIRFIELD_LEVEL, roof),
    ];

    const spec = AIRCRAFT.cessna;
    /** Level cruise at a height, held with the trim the model itself solves. */
    const cruise = (altitude: number): FlightControls => {
      const trim = trimLevelFlight(spec, spec.referenceCruise, altitude);
      expect(trim).not.toBeNull();
      return controls({
        throttle: trim?.throttle ?? 0.7,
        elevator: trim?.elevator ?? 0,
        gearDown: false,
      });
    };

    // High: crosses it untouched.
    {
      const { flying } = rig(colliders);
      const altitude = roof + 40;
      flying.placeInAircraft('cessna', RUNWAY.centreX, blockZ - 700, Math.PI, altitude);
      const input = cruise(altitude);
      let hit = false;
      for (let i = 0; i < 60 * 40; i += 1) {
        flying.update(1 / 60, input);
        if (flying.state.crashed) hit = true;
        if (flying.state.z > blockZ + 120) break;
      }
      expect(hit).toBe(false);
      expect(flying.state.z).toBeGreaterThan(blockZ + 40);
    }

    // Low: stopped by the same box, on the same height band test.
    {
      const { flying } = rig(colliders);
      const altitude = roof - 18;
      flying.placeInAircraft('cessna', RUNWAY.centreX, blockZ - 400, Math.PI, altitude);
      const input = cruise(altitude);
      let hit = false;
      for (let i = 0; i < 60 * 60; i += 1) {
        flying.update(1 / 60, input);
        if (flying.state.crashed) {
          hit = true;
          break;
        }
        if (flying.state.z > blockZ + 120) break;
      }
      expect(hit).toBe(true);
      expect(flying.state.z).toBeLessThan(blockZ + 40);
    }
  });

  it('stops one aircraft from taxiing through another', () => {
    const { air, flying } = rig();
    const target = air.list.find((craft) => craft.standId === 'stand-3');
    expect(target).toBeDefined();
    if (!target) return;

    // Start 60 m north of the parked twin and taxi straight at it. Heading PI
    // is +Z, which is the direction the stands run.
    expect(
      flying.placeInAircraft('cessna', target.x, target.z - 60, Math.PI),
    ).toBe(true);
    for (let i = 0; i < 60 * 60; i += 1) {
      flying.update(1 / 60, controls({ throttle: 0.35 }));
      if (flying.state.z > target.z + 40) break;
    }
    // Never past the parked aircraft's own half-span along z.
    expect(flying.state.z).toBeLessThan(target.z - target.spec.halfWidth * 0.5);
  });
});

// -- the ground ---------------------------------------------------------------

describe('the ground', () => {
  it('never lets an aircraft sink below the runway, however it is flown', () => {
    const { flying } = rig();
    expect(flying.placeInAircraft('twin', RUNWAY.centreX, RUNWAY.northZ + 40, Math.PI)).toBe(true);

    // A deliberately abusive sequence: full power, full back stick, hard
    // rudder, brakes on and off, at an ugly frame time.
    const script: FlightControls[] = [
      controls({ throttle: 1, elevator: 1 }),
      controls({ throttle: 1, elevator: -1, rudder: 1 }),
      controls({ throttle: 0, brakes: true, elevator: -1 }),
      controls({ throttle: 1, elevator: 1, aileron: 1 }),
      controls({ throttle: 0.2, rudder: -1, brakes: true }),
    ];
    let lowest = Infinity;
    for (let phase = 0; phase < script.length; phase += 1) {
      const input = script[phase];
      if (!input) continue;
      for (let i = 0; i < 24 * 8; i += 1) {
        flying.update(1 / 24, input);
        lowest = Math.min(lowest, flying.state.y);
      }
    }
    // The wheels never went below the platform, not once, not by a millimetre.
    expect(lowest).toBeGreaterThanOrEqual(AIRFIELD_LEVEL - 1e-9);
  });

  it('does not leave it hovering a hand’s breadth above the apron either', () => {
    const { flying } = rig();
    expect(flying.placeInAircraft('cessna', RUNWAY.centreX, RUNWAY.northZ + 100, Math.PI)).toBe(
      true,
    );
    fly(flying, 6, controls({ brakes: true }));
    expect(flying.state.onGround).toBe(true);
    expect(flying.state.y).toBeCloseTo(AIRFIELD_LEVEL, 9);
    expect(flying.state.altitudeAgl).toBeCloseTo(0, 9);
    expect(flying.state.groundSpeed).toBeLessThan(0.01);
  });

  it('registers a landing rather than silently absorbing it', () => {
    const { flying } = rig();
    let touchdowns = 0;
    let lastVs = 0;
    flying.onTouchdown = (_x, _y, _z, vs): void => {
      touchdowns += 1;
      lastVs = vs;
    };
    expect(
      flying.placeInAircraft('cessna', RUNWAY.centreX, RUNWAY.northZ + 60, Math.PI, AIRFIELD_LEVEL + 30),
    ).toBe(true);
    // Idle power, nose slightly down: it will arrive.
    for (let i = 0; i < 60 * 60; i += 1) {
      flying.update(1 / 60, controls({ throttle: 0, elevator: -0.05 }));
      if (touchdowns > 0) break;
    }
    expect(touchdowns).toBeGreaterThan(0);
    expect(lastVs).toBeGreaterThan(0);
  });
});

// -- the audio and QA surfaces ------------------------------------------------

describe('the callbacks', () => {
  it('reports the engine every frame with a live position and a real rpm', () => {
    const { flying } = rig();
    expect(flying.placeInAircraft('cessna', RUNWAY.centreX, RUNWAY.northZ, Math.PI)).toBe(true);
    let calls = 0;
    let lastRpm = 0;
    let lastType: AircraftType | null = null;
    flying.onEngine = (info): void => {
      calls += 1;
      lastRpm = info.rpm;
      lastType = info.type;
      expect(info.z).toBeCloseTo(flying.state.z, 6);
      expect(info.onGround).toBe(flying.state.onGround);
    };
    fly(flying, 1, controls({ throttle: 0 }));
    const idleRpm = lastRpm;
    fly(flying, 4, controls({ throttle: 1, brakes: true }));
    expect(calls).toBe(60 * 5);
    expect(lastType).toBe('cessna');
    expect(lastRpm).toBeGreaterThan(idleRpm + 500);
  });

  it('reports an impact with a severity that reaches 1 for a write-off', () => {
    const wallZ = RUNWAY.northZ + 300;
    const { flying } = rig([
      box(
        RUNWAY.centreX - 60,
        wallZ,
        RUNWAY.centreX + 60,
        wallZ + 12,
        AIRFIELD_LEVEL,
        AIRFIELD_LEVEL + 60,
      ),
    ]);
    let severity = 0;
    flying.onImpact = (_x, _y, _z, value): void => {
      severity = Math.max(severity, value);
    };
    flying.placeInAircraft('cessna', RUNWAY.centreX, wallZ - 500, Math.PI, AIRFIELD_LEVEL + 20);
    for (let i = 0; i < 60 * 60; i += 1) {
      flying.update(1 / 60, controls({ throttle: 1 }));
      if (flying.state.crashed) break;
    }
    expect(flying.state.crashed).toBe(true);
    expect(severity).toBe(1);
  });

  it('lets the player out of a wreck instead of sealing them in it', () => {
    const wallZ = RUNWAY.northZ + 300;
    const { flying, player } = rig([
      box(
        RUNWAY.centreX - 60,
        wallZ,
        RUNWAY.centreX + 60,
        wallZ + 12,
        AIRFIELD_LEVEL,
        AIRFIELD_LEVEL + 60,
      ),
    ]);
    flying.placeInAircraft('cessna', RUNWAY.centreX, wallZ - 500, Math.PI, AIRFIELD_LEVEL + 20);
    for (let i = 0; i < 60 * 90; i += 1) {
      flying.update(1 / 60, controls({ throttle: 1 }));
      if (!flying.flying) break;
    }
    expect(flying.flying).toBe(false);
    expect(player.at).not.toBeNull();
    expect(player.paused).toBe(false);
  });
});

describe('the QA surface', () => {
  it('places the player in a named type at a point, on the ground or in the air', () => {
    const { air, flying } = rig();

    expect(flying.placeInAircraft('jet', RUNWAY.centreX, RUNWAY.northZ + 120, Math.PI)).toBe(true);
    let state = flying.state;
    expect(state.type).toBe('jet');
    expect(state.onGround).toBe(true);
    expect(state.x).toBeCloseTo(RUNWAY.centreX, 6);
    expect(state.z).toBeCloseTo(RUNWAY.northZ + 120, 6);
    expect(state.y).toBeCloseTo(AIRFIELD_LEVEL, 6);

    // The same call with a height puts it there, trimmed and flying.
    expect(
      flying.placeInAircraft('twin', RUNWAY.centreX, RUNWAY.northZ, Math.PI, AIRFIELD_LEVEL + 400),
    ).toBe(true);
    state = flying.state;
    expect(state.type).toBe('twin');
    expect(state.onGround).toBe(false);
    expect(state.altitude).toBeCloseTo(AIRFIELD_LEVEL + 400, 6);
    expect(state.airspeed).toBeCloseTo(AIRCRAFT.twin.referenceCruise, 6);
    expect(Math.abs(state.verticalSpeed)).toBeLessThan(0.01);

    // And it stays there hands-off, which is what makes an airborne check
    // reproducible without flying a take-off first.
    fly(flying, 30, controls({ throttle: flying.state.throttle, elevator: 0, gearDown: false }));
    // The list the QA hook publishes tracks the aircraft the player is in.
    const piloted = air.list.filter((craft) => craft.piloted);
    expect(piloted).toHaveLength(1);
    expect(piloted[0]?.type).toBe('twin');
  });

  it('exposes every aircraft with a position the world can be checked against', () => {
    const { air } = rig();
    for (const craft of air.list) {
      expect(Number.isFinite(craft.x)).toBe(true);
      expect(Number.isFinite(craft.y)).toBe(true);
      expect(Number.isFinite(craft.z)).toBe(true);
      expect(craft.id).toBeGreaterThan(0);
    }
    expect(new Set(air.list.map((craft) => craft.id)).size).toBe(air.list.length);
    expect(air.stats.aircraft).toBe(air.list.length);
    // Nothing is drawn before `load()`, and asking does not throw.
    expect(air.stats.drawn).toBe(0);
    expect(air.stats.models).toBe(0);
  });
});

// -- the control list ---------------------------------------------------------

describe('the control list', () => {
  it('is the same shape the pause menu already renders', () => {
    expect(FLIGHT_CONTROLS.length).toBeGreaterThan(4);
    for (const hint of FLIGHT_CONTROLS) {
      expect(typeof hint.keys).toBe('string');
      expect(typeof hint.action).toBe('string');
      expect(hint.keys.length).toBeGreaterThan(0);
      expect(hint.action.length).toBeGreaterThan(0);
    }
    // Structurally interchangeable with the walking list.
    const walking = controlHints('windows');
    expect(Object.keys(walking[0] ?? {}).sort()).toEqual(
      Object.keys(FLIGHT_CONTROLS[0] ?? {}).sort(),
    );
  });

  it('names the modifier keys the way the player’s own keyboard prints them', () => {
    const mac = flightControlHints('mac').map((hint) => hint.keys).join(' ');
    const pc = flightControlHints('windows').map((hint) => hint.keys).join(' ');
    expect(mac).toContain('⇧');
    expect(pc).not.toContain('⇧');
    // And it never advertises E as anything but the way out, because that is
    // the one key the rest of the game has already claimed.
    for (const hint of flightControlHints('windows')) {
      if (hint.keys === 'E') expect(hint.action.toLowerCase()).toContain('out');
    }
  });

  it('covers every axis the model actually reads', () => {
    // The DIRECT mapping is the complete stick, so it is the one that has to
    // name every axis `flight.ts` reads. On the assisted mapping roll and
    // rudder are reached through "turn" - the player never commands them - so
    // asserting those words there would be asserting a lie.
    const text = flightControlHints('windows', false)
      .map((hint) => `${hint.keys} ${hint.action}`)
      .join(' ')
      .toLowerCase();
    for (const word of ['nose up', 'nose down', 'roll', 'rudder', 'throttle', 'brake', 'gear']) {
      expect(text, `no control listed for ${word}`).toContain(word);
    }
  });

  it('covers everything the assisted mapping lets the player ask for', () => {
    const text = flightControlHints('windows')
      .map((hint) => `${hint.keys} ${hint.action}`)
      .join(' ')
      .toLowerCase();
    for (const word of ['climb', 'descend', 'turn left', 'turn right', 'throttle', 'brake', 'gear']) {
      expect(text, `no control listed for ${word}`).toContain(word);
    }
    // And it must not advertise the axes it does not expose.
    expect(text).not.toContain('rudder');
  });
});
