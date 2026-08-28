// @vitest-environment jsdom
/**
 * Taking the controls of an aeroplane, and keeping them.
 *
 * Every assertion here is a defect that was reproduced in a production build
 * before it was written:
 *
 *  - a player who sprinted up to the aircraft with the run key held boarded
 *    it and then had NO throttle, because `Flying` only recorded a keydown
 *    while it already owned an aeroplane and wiped its key set on boarding.
 *    Shift is the run key and Shift is the throttle, so this was the ordinary
 *    way to arrive, and the aeroplane simply did not answer the controls;
 *  - the Light twin on stand 3 taxied 0.60 m and stopped for ever. A
 *    ground-power cart sits 0.6 m in front of its nose, `flight.ts` answers a
 *    refusal by zeroing the velocity, and at rest neither the nose wheel nor
 *    the rudder can turn the aircraft away from it. Full throttle, no motion,
 *    no message;
 *  - two aircraft spawned on one spot pinned each other, because the aircraft
 *    footprint test had no containment waiver of the kind `CollisionWorld`
 *    has had all along;
 *  - walking up to the airliner showed no prompt and `E` did nothing, which
 *    is indistinguishable from a broken key.
 *
 * This file needs a DOM, unlike `tests/aircraft.test.ts`, because half of it
 * is about real `keydown`/`keyup` delivery and about the HUD. The physics
 * assertions still go through `update(dt, override)`, which is the seam that
 * needs no keyboard at all.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { AIRCRAFT } from '../src/air/AircraftCatalogue';
import { AircraftSystem } from '../src/air/AircraftSystem';
import {
  FLIGHT_CONTROLS,
  FLIGHT_HUD_CONTROLS,
  Flying,
  type FlyingPlayer,
} from '../src/air/Flying';
import {
  advanceFlight,
  createFlightControls,
  createFlightEvents,
  createFlightState,
  groundSpeed,
  stepFlight,
  type FlightControls,
  type FlightState,
  type FlightWorld,
} from '../src/air/flight';
import { CollisionWorld } from '../src/player/Collision';
import { Hud } from '../src/ui/Hud';
import { detectPlatform } from '../src/ui/platform';
import { scatterAirportProps } from '../src/world/airport/props';
import { AIRFIELD_LEVEL, RUNWAY, TAXIWAY } from '../src/world/airport/layout';
import { CityGround } from '../src/world/CityGround';
import { getCityPlan } from '../src/world/CityPlan';
import { landElevation } from '../src/world/elevation';
import type { ColliderBox, GeometrySink } from '../src/world/build/types';

const AIRFIELD_GROUND = (x: number, z: number): number => landElevation(x, z);

/** Somewhere long, flat and paved, well clear of the stands and their kit. */
const FIELD_X = RUNWAY.centreX;
const FIELD_Z = RUNWAY.northZ + 60;

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
}

const open: Rig[] = [];

function rig(colliders: readonly ColliderBox[] = []): Rig {
  const air = new AircraftSystem({ groundY: AIRFIELD_GROUND });
  const player = stubPlayer();
  const flying = new Flying({
    aircraft: air,
    collision: new CollisionWorld(colliders),
    groundY: AIRFIELD_GROUND,
    controller: player,
  });
  const made = { air, flying, player };
  open.push(made);
  return made;
}

afterEach(() => {
  for (const made of open) made.flying.dispose();
  open.length = 0;
});

function controls(overrides: Partial<FlightControls> = {}): FlightControls {
  return { ...createFlightControls(), ...overrides };
}

/** Runs the model for a number of seconds, reading the real keyboard. */
function run(flying: Flying, seconds: number, hz = 60): void {
  for (let i = 0; i < Math.round(seconds * hz); i += 1) flying.update(1 / hz);
}

/** The same, with the keyboard replaced by an explicit control position. */
function fly(flying: Flying, seconds: number, input: FlightControls, hz = 60): void {
  for (let i = 0; i < Math.round(seconds * hz); i += 1) flying.update(1 / hz, input);
}

function press(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true }));
}

function release(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
}

// -- ownership ----------------------------------------------------------------

describe('control ownership', () => {
  it('transfers on boarding and is handed back whole on exit', () => {
    const { air, flying, player } = rig();

    expect(flying.flying).toBe(false);
    expect(player.paused).toBe(false);
    expect(air.list.some((craft) => craft.piloted)).toBe(false);

    expect(flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0)).toBe(true);

    // The walking player is stood down, the aircraft is flagged as flown, and
    // exactly one aircraft is.
    expect(player.paused).toBe(true);
    expect(flying.flying).toBe(true);
    expect(air.list.filter((craft) => craft.piloted)).toHaveLength(1);
    const flown = air.list.find((craft) => craft.piloted);
    expect(flown?.type).toBe('cessna');
    // The pilot is authoritative over the pose from the first frame.
    fly(flying, 2, controls({ throttle: 1 }));
    const moved = air.list.find((craft) => craft.piloted);
    expect(moved?.x).toBeCloseTo(flying.state.x, 6);
    expect(moved?.z).toBeCloseTo(flying.state.z, 6);
    expect(moved?.standId).toBeNull();

    fly(flying, 20, controls({ throttle: 0, brakes: true }));
    const stoppedAt = { x: flying.state.x, z: flying.state.z };
    expect(flying.exit()).toBe(true);

    // Everything given back: the controller, the handle and the flag.
    expect(player.paused).toBe(false);
    expect(flying.flying).toBe(false);
    expect(air.list.some((craft) => craft.piloted)).toBe(false);
    expect(flying.state.flying).toBe(false);
    expect(player.at).not.toBeNull();
    // A released aircraft is parked again: the system may re-offer it.
    expect(air.nearest(stoppedAt.x, stoppedAt.z)).not.toBeNull();
  });

  it('honours the throttle key the player was already holding when they boarded', () => {
    // The reported defect, in the order a player actually produces it: Shift
    // is the run key, so this is what sprinting up to an aeroplane looks like.
    const { flying } = rig();
    press('ShiftLeft');
    expect(flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0)).toBe(true);
    run(flying, 3);
    release('ShiftLeft');

    expect(flying.state.throttle).toBeGreaterThan(0.9);
    expect(flying.state.groundSpeed).toBeGreaterThan(1);
  });

  it('honours a held stick key as well, not only the throttle', () => {
    const { flying } = rig();
    press('KeyS');
    expect(
      flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0, AIRFIELD_LEVEL + 300),
    ).toBe(true);
    const before = flying.state.pitch;
    run(flying, 2);
    release('KeyS');
    // S is back pressure: the nose comes up.
    expect(flying.state.pitch).toBeGreaterThan(before + 0.2);
  });

  it('does not cycle the undercarriage because G happened to be down', () => {
    const { flying } = rig();
    press('KeyG');
    expect(flying.placeInAircraft('jet', FIELD_X, FIELD_Z, 0)).toBe(true);
    expect(AIRCRAFT.jet.retractableGear).toBe(true);
    run(flying, 1);
    // Still down: a key that was already held is not a fresh press.
    expect(flying.state.gearDown).toBe(true);
    release('KeyG');
    run(flying, 0.2);
    press('KeyG');
    // The jet's undercarriage takes 7 s to travel, so this is well past the
    // half-way point the readout switches on and well short of the stop.
    run(flying, 4.5);
    release('KeyG');
    // A real press does move the lever.
    expect(flying.state.gearDown).toBe(false);
  });

  it('drops every key when the window loses focus', () => {
    const { flying } = rig();
    expect(flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0, AIRFIELD_LEVEL + 400)).toBe(true);
    // Control winds the lever DOWN from the cruise setting the trim solved,
    // so neither end of its travel is reached and "frozen" is distinguishable
    // from "clamped".
    const trimmed = flying.state.throttle;
    press('ControlLeft');
    press('KeyD');
    run(flying, 0.8);
    const open = flying.state.throttle;
    const banked = flying.state.bank;
    expect(open).toBeLessThan(trimmed - 0.1);
    expect(open).toBeGreaterThan(0.05);
    expect(banked).toBeGreaterThan(0.1);

    window.dispatchEvent(new Event('blur'));
    run(flying, 2);
    release('ControlLeft');
    release('KeyD');
    const after = flying.state;

    // The throttle is a LEVER, so it stays where it was set - that is what a
    // throttle does. What must not happen is it going on opening on a key
    // nobody is holding any more, and it does not: it is frozen exactly.
    expect(after.throttle).toBeCloseTo(open, 9);
    // The stick is spring-loaded, so the aileron centres and the roll stops
    // being driven. Two more seconds of held aileron would have rolled the
    // aircraft past vertical; it is nowhere near.
    expect(after.bank).toBeLessThan(banked + 0.6);

    // The differential: the same 2.8 s with the keys genuinely held.
    const kept = rig();
    expect(
      kept.flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0, AIRFIELD_LEVEL + 400),
    ).toBe(true);
    press('ControlLeft');
    press('KeyD');
    run(kept.flying, 2.8);
    release('ControlLeft');
    release('KeyD');
    expect(kept.flying.state.throttle).toBeLessThan(after.throttle - 0.1);
    expect(kept.flying.state.bank).toBeGreaterThan(after.bank + 0.3);
  });

  it('leaves the parked fleet alone while one of them is being flown', () => {
    const { air, flying } = rig();
    expect(flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0)).toBe(true);
    const parked = air.list
      .filter((craft) => !craft.piloted)
      .map((craft) => ({ id: craft.id, x: craft.x, y: craft.y, z: craft.z, yaw: craft.yaw }));

    fly(flying, 6, controls({ throttle: 1 }));
    air.update(1 / 60, flying.state.x, flying.state.z);

    for (const before of parked) {
      const after = air.list.find((craft) => craft.id === before.id);
      expect(after?.x).toBe(before.x);
      expect(after?.y).toBe(before.y);
      expect(after?.z).toBe(before.z);
      expect(after?.yaw).toBe(before.yaw);
    }
    // And the one being flown is refused to anybody else.
    const flown = air.list.find((craft) => craft.piloted);
    expect(flown).toBeDefined();
    if (flown) {
      expect(air.takeControl(flown.id)).toBeNull();
      expect(air.place(flown.id, 0, 0, 0)).toBe(false);
    }
  });
});

// -- the documented axes ------------------------------------------------------

describe('the documented controls', () => {
  it('accelerates from rest at full throttle and advances the physics state', () => {
    // The regression for "the throttle responds but the aircraft does not
    // move": asserted on the flight state, never on the drawn model.
    for (const type of ['cessna', 'twin', 'jet'] as const) {
      const { flying } = rig();
      expect(flying.placeInAircraft(type, FIELD_X, FIELD_Z, 0)).toBe(true);
      const start = flying.state;
      expect(start.groundSpeed).toBeLessThan(0.01);

      fly(flying, 6, controls({ throttle: 1 }));
      const after = flying.state;
      expect(after.throttle, type).toBeGreaterThan(0.9);
      expect(after.groundSpeed, type).toBeGreaterThan(5);
      // Yaw 0 faces -Z, so a taxiing aeroplane's z falls.
      expect(after.z, type).toBeLessThan(start.z - 10);
      expect(after.blocked, type).toBe(false);
      expect(after.crashed, type).toBe(false);
    }
  });

  it('answers every documented axis with the documented sign', () => {
    const at = AIRFIELD_LEVEL + 400;

    // S is back pressure: nose UP.
    const pitch = rig();
    expect(pitch.flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0, at)).toBe(true);
    const pitch0 = pitch.flying.state.pitch;
    press('KeyS');
    run(pitch.flying, 1.5);
    release('KeyS');
    expect(pitch.flying.state.pitch).toBeGreaterThan(pitch0);

    // W is the other way: nose DOWN.
    const push = rig();
    expect(push.flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0, at)).toBe(true);
    const push0 = push.flying.state.pitch;
    press('KeyW');
    run(push.flying, 1.5);
    release('KeyW');
    expect(push.flying.state.pitch).toBeLessThan(push0);

    // D rolls RIGHT, and `bank` is positive right-wing-down.
    const roll = rig();
    expect(roll.flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0, at)).toBe(true);
    press('KeyD');
    run(roll.flying, 1.2);
    release('KeyD');
    expect(roll.flying.state.bank).toBeGreaterThan(0.1);

    // A rolls LEFT.
    const left = rig();
    expect(left.flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0, at)).toBe(true);
    press('KeyA');
    run(left.flying, 1.2);
    release('KeyA');
    expect(left.flying.state.bank).toBeLessThan(-0.1);

    // C is right rudder. Yaw INCREASES to the left, so nose right is a fall.
    const yaw = rig();
    expect(yaw.flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0, at)).toBe(true);
    const yaw0 = yaw.flying.state.yaw;
    press('KeyC');
    run(yaw.flying, 2);
    release('KeyC');
    expect(yaw.flying.state.yaw).toBeLessThan(yaw0);

    // Z is left rudder, and the comma/full stop pair is the same axis.
    const rudder = rig();
    expect(rudder.flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0, at)).toBe(true);
    const rudder0 = rudder.flying.state.yaw;
    press('Comma');
    run(rudder.flying, 2);
    release('Comma');
    expect(rudder.flying.state.yaw).toBeGreaterThan(rudder0);
  });

  it('winds the throttle back down on Control', () => {
    const { flying } = rig();
    expect(flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0)).toBe(true);
    press('ShiftLeft');
    run(flying, 3);
    release('ShiftLeft');
    const open = flying.state.throttle;
    expect(open).toBeGreaterThan(0.9);
    press('ControlLeft');
    run(flying, 3);
    release('ControlLeft');
    expect(flying.state.throttle).toBeLessThan(0.05);
  });

  it('slows the aircraft on the ground when Space is held', () => {
    const { flying } = rig();
    expect(flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0)).toBe(true);
    fly(flying, 8, controls({ throttle: 1 }));
    const rolling = flying.state.groundSpeed;
    expect(rolling).toBeGreaterThan(8);

    press('Space');
    run(flying, 3);
    release('Space');
    const braked = flying.state.groundSpeed;
    expect(braked).toBeLessThan(rolling);
    expect(flying.state.onGround).toBe(true);

    // And it is the brakes doing it, not the throttle coming off: with the
    // same three seconds and no brakes the aircraft is faster.
    const coast = rig();
    expect(coast.flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0)).toBe(true);
    fly(coast.flying, 8, controls({ throttle: 1 }));
    fly(coast.flying, 3, controls({ throttle: 0 }));
    expect(coast.flying.state.groundSpeed).toBeGreaterThan(braked);
  });
});

// -- the sub-step through Flying ---------------------------------------------

describe('the fixed sub-step, as the game drives it', () => {
  /** The state after a measured ground roll at a chosen frame rate. */
  function roll(hz: number, seconds: number): FlightState {
    const spec = AIRCRAFT.cessna;
    const state = createFlightState(spec, FIELD_X, FIELD_Z, 0, AIRFIELD_LEVEL);
    const events = createFlightEvents();
    const input = controls({ throttle: 1, elevator: 0.2 });
    const world: FlightWorld = { groundY: () => AIRFIELD_LEVEL };
    for (let i = 0; i < Math.round(seconds * hz); i += 1) {
      advanceFlight(state, input, spec, world, events, 1 / hz);
    }
    return state;
  }

  it('reproduces a reference fixed-step run whatever the frame time', () => {
    const spec = AIRCRAFT.cessna;
    const seconds = 12;
    // The reference: the same twelve seconds integrated one whole sub-step at
    // a time, with no accumulator anywhere near it.
    const reference = createFlightState(spec, FIELD_X, FIELD_Z, 0, AIRFIELD_LEVEL);
    const events = createFlightEvents();
    const input = controls({ throttle: 1, elevator: 0.2 });
    const world: FlightWorld = { groundY: () => AIRFIELD_LEVEL };
    for (let i = 0; i < seconds * 120; i += 1) {
      stepFlight(reference, input, spec, world, events);
    }

    for (const hz of [20, 30, 60, 120, 240]) {
      const state = roll(hz, seconds);
      expect(state.x, `${hz} Hz`).toBeCloseTo(reference.x, 6);
      expect(state.y, `${hz} Hz`).toBeCloseTo(reference.y, 6);
      expect(state.z, `${hz} Hz`).toBeCloseTo(reference.z, 6);
      expect(state.pitch, `${hz} Hz`).toBeCloseTo(reference.pitch, 9);
      expect(groundSpeed(state), `${hz} Hz`).toBeCloseTo(groundSpeed(reference), 6);
    }
  });

  it('still advances the aircraft at the engine’s own delta clamp', () => {
    // `Engine` hands the world at most 0.1 s in one frame. Eight sub-steps of
    // 1/120 s is 0.0667 s of it, so a stalled tab runs SLOW - but it must
    // never run NOT AT ALL, which is the shape of "the throttle works and the
    // aeroplane does not move".
    const { flying } = rig();
    expect(flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0)).toBe(true);
    let last = flying.state.groundSpeed;
    for (let i = 0; i < 60; i += 1) {
      flying.update(0.1, controls({ throttle: 1 }));
      expect(flying.state.groundSpeed).toBeGreaterThanOrEqual(last);
      last = flying.state.groundSpeed;
    }
    expect(flying.state.groundSpeed).toBeGreaterThan(5);
  });

  it('does not lose the leftover of a frame shorter than one sub-step', () => {
    // At 400 Hz most frames integrate nothing at all. The accumulator has to
    // carry the remainder, or the aircraft never moves on any frame.
    const { flying } = rig();
    expect(flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0)).toBe(true);
    fly(flying, 6, controls({ throttle: 1 }), 400);
    const fast = flying.state.groundSpeed;

    const slow = rig();
    expect(slow.flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0)).toBe(true);
    fly(slow.flying, 6, controls({ throttle: 1 }), 60);
    expect(fast).toBeCloseTo(slow.flying.state.groundSpeed, 6);
  });
});

// -- something in the way ------------------------------------------------------

describe('an obstruction on the ground', () => {
  /** A box of a given height, `ahead` metres in front of a taxiing aircraft. */
  function obstacle(ahead: number, height: number): ColliderBox {
    const nose = FIELD_Z - AIRCRAFT.cessna.halfLength - ahead;
    return box(
      FIELD_X - 6,
      nose - 1,
      FIELD_X + 6,
      nose,
      AIRFIELD_LEVEL,
      AIRFIELD_LEVEL + height,
    );
  }

  it('says the aircraft is blocked rather than pinning it in silence', () => {
    const { flying } = rig([obstacle(2, 6)]);
    expect(flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0)).toBe(true);
    expect(flying.state.blocked).toBe(false);

    fly(flying, 6, controls({ throttle: 1 }));
    const state = flying.state;
    expect(state.groundSpeed).toBeLessThan(0.5);
    // The point of the whole exercise: the state SAYS so.
    expect(state.blocked).toBe(true);
    expect(state.blockedSeconds).toBeGreaterThan(1);
    // And the player is told, and can still get out.
    expect(flying.hintState?.warning).toBe('Blocked — something solid ahead');
    expect(flying.exit()).toBe(true);
  });

  it('pushes ground equipment aside after a second of leaning on it', () => {
    // A 1.3 m ground-power cart: the exact case that pinned the Light twin.
    const { flying } = rig([obstacle(2, 1.3)]);
    expect(flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0)).toBe(true);
    const start = flying.state.z;

    fly(flying, 2, controls({ throttle: 1 }));
    // It is refused first - clutter does not simply not exist.
    expect(flying.state.blocked).toBe(true);

    fly(flying, 12, controls({ throttle: 1 }));
    expect(flying.state.blocked).toBe(false);
    expect(flying.state.z).toBeLessThan(start - 20);
    expect(flying.state.crashed).toBe(false);
  });

  it('never pushes through a wall, however long the throttle is held', () => {
    const wall = obstacle(2, 6);
    const { flying } = rig([wall]);
    expect(flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0)).toBe(true);
    let furthest = flying.state.z;
    for (let i = 0; i < 60 * 40; i += 1) {
      flying.update(1 / 60, controls({ throttle: 1 }));
      furthest = Math.min(furthest, flying.state.z);
    }
    // Never past the near face of the block.
    expect(furthest).toBeGreaterThan(wall.maxZ - AIRCRAFT.cessna.halfLength - 0.05);
    expect(flying.state.blocked).toBe(true);
  });

  it('never pushes another aeroplane aside, however low it is standing', () => {
    const { air, flying } = rig();
    const target = air.list.find((craft) => craft.type === 'liner');
    expect(target).toBeDefined();
    if (!target) return;

    expect(
      flying.placeInAircraft('cessna', target.x, target.z + 60, Math.PI * 0),
    ).toBe(true);
    for (let i = 0; i < 60 * 60; i += 1) {
      flying.update(1 / 60, controls({ throttle: 0.4 }));
      if (flying.state.z < target.z + 30) break;
    }
    // Still north of the airliner's own half-span: an aeroplane is never
    // clutter, whatever the jam timer says.
    expect(flying.state.z).toBeGreaterThan(target.z + target.spec.halfWidth * 0.5);
  });

  it('lets every flyable type taxi off its own stand, past its own kit', () => {
    /*
     * The reported defect, against the world's REAL apron equipment.
     *
     * `apronEquipment` puts a ground-power cart at `stand.x + 9.5`, and the
     * stands face +X, so on stand 3 that cart lands 0.6 m in front of the
     * Light twin's nose. Measured in a production build before the fix: full
     * throttle for five seconds moved the twin 0.60 m and left it at exactly
     * 0.000 m/s, not crashed, with nothing said. The number 0.6 is not a
     * coincidence and it is not tuned here - it is the cart's own minX.
     */
    const colliders: ColliderBox[] = [];
    const sink: GeometrySink = {
      add: () => undefined,
      instance: () => undefined,
      collider: (collider) => colliders.push(collider),
      light: () => undefined,
      interaction: () => undefined,
    };
    scatterAirportProps(new CityGround(getCityPlan()), sink);
    expect(colliders.length).toBeGreaterThan(10);

    for (const type of ['jet', 'twin', 'cessna'] as const) {
      const { air, flying } = rig(colliders);
      const stand = air.list.find((craft) => craft.type === type);
      expect(stand, type).toBeDefined();
      if (!stand) continue;

      // Boarded where it is parked, and taxied out the way it is pointing.
      expect(flying.tryEnter(stand.x, stand.z), type).toBe(true);
      fly(flying, 20, controls({ throttle: 0.6 }));
      // Clear of its stand and out onto the taxiway, which is the whole
      // journey the aircraft has to be able to begin.
      expect(flying.state.x, `${type} never left its stand`).toBeGreaterThan(
        TAXIWAY.centreX - TAXIWAY.halfWidth,
      );
      expect(flying.state.crashed, type).toBe(false);
    }
  });

  it('lets an aeroplane spawned inside another one drive out of it', () => {
    const { air, flying } = rig();
    const other = air.list.find((craft) => craft.type === 'twin');
    expect(other).toBeDefined();
    if (!other) return;

    // Exactly on top of the twin, which is how a QA spawn or a badly placed
    // stand produces the pin.
    expect(air.place(other.id, FIELD_X, FIELD_Z, 0)).toBe(true);
    expect(flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0)).toBe(true);

    fly(flying, 8, controls({ throttle: 1 }));
    expect(flying.state.groundSpeed).toBeGreaterThan(5);
    expect(flying.state.z).toBeLessThan(FIELD_Z - 20);
    expect(flying.state.crashed).toBe(false);
  });
});

// -- what the player is told ---------------------------------------------------

describe('the prompt at an aircraft', () => {
  it('offers a flyable aircraft by name', () => {
    const { air, flying } = rig();
    const cessna = air.list.find((craft) => craft.type === 'cessna');
    expect(cessna).toBeDefined();
    if (!cessna) return;
    expect(flying.promptAt(cessna.x, cessna.z)).toBe('Press E to board the Light single');
  });

  it('says why the airliner cannot be taken instead of saying nothing', () => {
    const { air, flying } = rig();
    const liner = air.list.find((craft) => craft.type === 'liner');
    expect(liner).toBeDefined();
    if (!liner) return;

    // It is not on offer...
    expect(flying.candidateAt(liner.x, liner.z)).toBeNull();
    expect(flying.tryEnter(liner.x, liner.z)).toBe(false);
    // ...but standing at it is no longer silent.
    const prompt = flying.promptAt(liner.x, liner.z);
    expect(prompt).not.toBeNull();
    expect(prompt).toContain(AIRCRAFT.liner.label);
    expect(prompt).toContain(AIRCRAFT.liner.groundedReason ?? '');
    expect(prompt).not.toContain('Press E');
  });

  it('says nothing at all when there is no aircraft within reach', () => {
    const { flying } = rig();
    expect(flying.promptAt(-900, -900)).toBeNull();
  });

  it('says nothing while the player is already flying', () => {
    const { air, flying } = rig();
    const liner = air.list.find((craft) => craft.type === 'liner');
    expect(flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0)).toBe(true);
    expect(flying.promptAt(liner?.x ?? 0, liner?.z ?? 0)).toBeNull();
  });
});

// -- the contextual control panel ---------------------------------------------

describe('the contextual control panel', () => {
  it('is absent on foot and present from the moment the player is in', () => {
    const { flying } = rig();
    expect(flying.hintState).toBeNull();
    expect(flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0)).toBe(true);
    const state = flying.hintState;
    expect(state).not.toBeNull();
    expect(state?.hints).toBe(FLIGHT_HUD_CONTROLS);
    expect(state?.hold).toBe(true);
    expect(state?.warning).toBeNull();
  });

  /*
   * The panel is a SHORTER RESTATEMENT of the Controls tab, not a second set of
   * bindings. Nothing stops the two drifting apart except this: every key the
   * overlay advertises has to be one the reference list documents, and the
   * overlay has to stay the shorter of the two or it is not a summary.
   */
  it('never advertises a key the Controls tab does not document', () => {
    expect(FLIGHT_HUD_CONTROLS.length).toBeLessThan(FLIGHT_CONTROLS.length);
    const documented = FLIGHT_CONTROLS.map((hint) => hint.keys).join(' | ');
    for (const hint of FLIGHT_HUD_CONTROLS) {
      const tokens = hint.keys
        .split('/')
        .map((token) => token.replace(/[()]/g, '').trim())
        .filter((token) => token.length > 0);
      expect(tokens.length).toBeGreaterThan(0);
      for (const token of tokens) {
        expect(documented).toContain(token);
      }
    }
  });

  it('holds while the aeroplane is stopped and fades once it is under way', () => {
    const { flying } = rig();
    expect(flying.placeInAircraft('cessna', FIELD_X, FIELD_Z, 0)).toBe(true);
    // Sitting still with the brakes on: still up after half a minute.
    fly(flying, 30, controls({ throttle: 0, brakes: true }));
    expect(flying.hintState?.hold).toBe(true);

    // Rolling: gone.
    fly(flying, 12, controls({ throttle: 1 }));
    expect(flying.state.groundSpeed).toBeGreaterThan(2);
    expect(flying.hintState?.hold).toBe(false);

    // Stopped again: back, because that is when it is being read.
    fly(flying, 25, controls({ throttle: 0, brakes: true }));
    expect(flying.state.groundSpeed).toBeLessThan(1.5);
    expect(flying.hintState?.hold).toBe(true);
  });

  it('renders into the HUD and puts the walking hint away while it is up', () => {
    const hud = new Hud({
      onMusicToggle: () => undefined,
      onResume: () => undefined,
      onQualityChange: () => undefined,
    });
    document.body.append(hud.element);
    try {
      const walking = hud.element.querySelector('.mb-hud__hint:not(.mb-hud__hint--flight)');
      const panel = hud.element.querySelector('.mb-hud__hint--flight');
      expect(walking).not.toBeNull();
      expect(panel).not.toBeNull();
      if (!walking || !panel) return;

      expect(hud.flightHintsShown).toBe(false);
      hud.setFlightHints({ hints: FLIGHT_CONTROLS, hold: true, warning: null });
      expect(hud.flightHintsShown).toBe(true);
      expect(walking.classList.contains('is-visible')).toBe(false);

      // Every documented control is on screen, with the key and the action.
      const rows = panel.querySelectorAll('p .mb-hud__keys');
      expect(rows).toHaveLength(FLIGHT_CONTROLS.length);
      const text = panel.textContent ?? '';
      for (const hint of FLIGHT_CONTROLS) {
        expect(text).toContain(hint.keys);
        expect(text).toContain(hint.action);
      }

      // The warning line appears and disappears with the jam.
      hud.setFlightHints({ hints: FLIGHT_CONTROLS, hold: true, warning: 'Blocked — x' });
      expect(panel.textContent).toContain('Blocked — x');
      hud.setFlightHints({ hints: FLIGHT_CONTROLS, hold: true, warning: null });
      expect(panel.textContent).not.toContain('Blocked — x');

      // Fading, then leaving the aircraft altogether.
      hud.setFlightHints({ hints: FLIGHT_CONTROLS, hold: false, warning: null });
      expect(hud.flightHintsShown).toBe(false);
      hud.setFlightHints(null);
      expect(hud.flightHintsShown).toBe(false);
      // The walking hint may come back once the panel has gone.
      hud.setPointerLocked(true);
      expect(walking.classList.contains('is-visible')).toBe(true);
    } finally {
      hud.dispose();
    }
  });

  it('names the keys the way this machine’s keyboard prints them', () => {
    // `flightControlHints` is resolved once, so the panel can only ever show
    // the labels for the machine it is being read on.
    const mac = detectPlatform() === 'mac';
    const throttle = FLIGHT_CONTROLS.find((hint) => hint.action.startsWith('Throttle'));
    expect(throttle).toBeDefined();
    expect(throttle?.keys).toBe(mac ? '⇧ Shift / ⌃ Control' : 'Shift / Ctrl');
  });
});
