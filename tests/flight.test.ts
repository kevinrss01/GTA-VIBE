/**
 * The flight model, flown.
 *
 * Everything here is numbers: no renderer, no canvas, no browser, no frame
 * loop. The aeroplanes are flown by small autopilots written in the tests
 * themselves, which is the only honest way to assert on a force model - a
 * take-off distance is not a property of one function, it is what happens when
 * thrust, drag, lift, the undercarriage and the elevator all run for twenty
 * seconds against each other.
 *
 * The measured figures these assertions bracket, all at sea-level density,
 * lightly loaded, on the 600 m runway in `airport/layout`:
 *
 *              Vs     Vr    Vref   ground roll   braking    touchdown
 *   cessna   25.1   28.1    32.6         216 m     133 m    0.90 m/s
 *   twin     40.0   44.8    52.0         482 m     333 m    1.41 m/s
 *   jet      54.9   61.5    71.3         563 m     551 m    1.56 m/s
 *   liner    78.6   88.1   102.2        1606 m    1254 m           -
 *
 * The airliner's 1606 m is why it is not flyable. See `AircraftCatalogue`.
 */

import { describe, expect, it } from 'vitest';

import {
  AIRCRAFT,
  ALL_AIRCRAFT_TYPES,
  FLYABLE_AIRCRAFT_TYPES,
  GRAVITY,
  approachSpeed,
  rotateSpeed,
  stallSpeed,
  type AircraftSpec,
} from '../src/air/AircraftCatalogue';
import {
  advanceFlight,
  airspeed,
  angleOfAttack,
  applyTrim,
  contactHeight,
  createFlightControls,
  createFlightEvents,
  createFlightState,
  levelFlightSpeed,
  liftCoefficient,
  thrustAt,
  trimLevelFlight,
  zeroLiftAngle,
  type FlightControls,
  type FlightState,
  type FlightWorld,
} from '../src/air/flight';
import { AIRFIELD_LEVEL, RUNWAY, RUNWAY_LENGTH } from '../src/world/airport/layout';

/** The airfield, as a flat plane. The platform really is level. */
const AIRFIELD: FlightWorld = { groundY: () => AIRFIELD_LEVEL };
/** Nothing to hit for thousands of metres: for the pure air-work cases. */
const OPEN_AIR: FlightWorld = { groundY: () => -3000 };

const STEP = 1 / 120;

function clampx(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Puts an aircraft into a trimmed cruise at a height, ready to be flown. */
function airborne(spec: AircraftSpec, speed: number, altitude: number): FlightState | null {
  const trim = trimLevelFlight(spec, speed, altitude);
  if (!trim) return null;
  const state = createFlightState(spec, 0, 0, 0, -3000);
  state.y = altitude + spec.gearHeight;
  applyTrim(state, spec, trim);
  return state;
}

/** Elevator that holds a commanded pitch: an inner loop, as an autopilot has. */
function holdPitch(state: FlightState, target: number): number {
  return clampx((target - state.pitch) * 6 - state.pitchRate * 1.6, -1, 1);
}

// -- the lift curve -----------------------------------------------------------

describe('the lift curve', () => {
  it('peaks at the stall angle and then collapses', () => {
    for (const type of ALL_AIRCRAFT_TYPES) {
      const spec = AIRCRAFT[type];
      const stallAt = zeroLiftAngle(spec) + spec.alphaStall;

      // Sweep it and find the real peak rather than trusting the algebra.
      let peakCl = -Infinity;
      let peakAlpha = 0;
      for (let a = -0.6; a <= 0.9; a += 0.001) {
        const cl = liftCoefficient(spec, a);
        if (cl > peakCl) {
          peakCl = cl;
          peakAlpha = a;
        }
      }

      // The peak is where the spec says it is, and it is worth what it says.
      expect(peakAlpha).toBeCloseTo(stallAt, 1);
      expect(peakCl).toBeGreaterThan(spec.clMax * 0.98);
      expect(peakCl).toBeLessThan(spec.clMax * 1.06);

      // Past it the wing gives up more than a third of its lift. This is the
      // whole point: nothing anywhere reads a speed to decide that.
      const past = liftCoefficient(spec, stallAt + spec.stallWidth);
      expect(past).toBeLessThan(peakCl * 0.65);

      // And it is still monotonic below the stall, so trimming is well posed.
      for (let a = zeroLiftAngle(spec); a < stallAt - 0.02; a += 0.01) {
        expect(liftCoefficient(spec, a + 0.01)).toBeGreaterThan(liftCoefficient(spec, a));
      }
    }
  });

  it('stalls symmetrically, so a hard push lets go as well as a hard pull', () => {
    for (const type of ALL_AIRCRAFT_TYPES) {
      const spec = AIRCRAFT[type];
      const zero = zeroLiftAngle(spec);
      const deep = spec.alphaStall + spec.stallWidth;
      expect(Math.abs(liftCoefficient(spec, zero - deep))).toBeLessThan(spec.clMax * 0.65);
    }
  });
});

// -- the stall, in flight -----------------------------------------------------

describe('stalling', () => {
  it('drops the aircraft when the wing lets go, and flies again when it does not', () => {
    for (const type of FLYABLE_AIRCRAFT_TYPES) {
      const spec = AIRCRAFT[type];
      const state = airborne(spec, spec.referenceCruise * 0.72, 900);
      expect(state).not.toBeNull();
      if (!state) continue;

      const controls: FlightControls = { ...createFlightControls(), throttle: 0.15, gearDown: false };
      const events = createFlightEvents();
      const stallAt = zeroLiftAngle(spec) + spec.alphaStall;

      let brokeAway = false;
      let clAtBreak = 0;
      let worstSink = 0;
      let peakAfter = -Infinity;
      let lowestAfter = Infinity;

      // Hold it off until it lets go. The aeroplane ZOOMS first - back stick
      // trades speed for height - so the sink is measured after the break,
      // not at it.
      for (let i = 0; i < 120 * 30; i += 1) {
        controls.elevator = 1;
        advanceFlight(state, controls, spec, OPEN_AIR, events, STEP);
        const alpha = angleOfAttack(state);
        if (!brokeAway && alpha > stallAt + spec.stallWidth) {
          brokeAway = true;
          clAtBreak = liftCoefficient(spec, alpha);
        }
        if (brokeAway) {
          if (state.vy < worstSink) worstSink = state.vy;
          if (state.y < lowestAfter) lowestAfter = state.y;
          if (state.y > peakAfter) peakAfter = state.y;
        }
      }

      // It stalled, it lost most of its lift, and then it fell. The NET
      // altitude change is not the measure - back stick trades speed for
      // height first, so a jet is 400 m higher when the wing lets go than
      // when the pull started - so what is asserted is the fall from
      // whatever height the zoom reached.
      expect(brokeAway).toBe(true);
      expect(clAtBreak).toBeLessThan(spec.clMax * 0.75);
      expect(worstSink).toBeLessThan(-3);
      expect(peakAfter - lowestAfter).toBeGreaterThan(50);

      // Recover the way a pilot does: unload to break the stall, then fly the
      // attitude back to level with full power. Nothing in the model knows
      // this is a recovery - it is the same lift curve, read on the way down.
      for (let i = 0; i < 120 * 3; i += 1) {
        controls.elevator = -0.45;
        controls.throttle = 1;
        advanceFlight(state, controls, spec, OPEN_AIR, events, STEP);
      }
      for (let i = 0; i < 120 * 12; i += 1) {
        controls.elevator = holdPitch(state, 0.03);
        advanceFlight(state, controls, spec, OPEN_AIR, events, STEP);
      }

      const alphaAfter = angleOfAttack(state);
      expect(alphaAfter).toBeLessThan(stallAt);
      expect(liftCoefficient(spec, alphaAfter)).toBeGreaterThan(spec.clMax * 0.1);
      expect(airspeed(state)).toBeGreaterThan(stallSpeed(spec));
      // Flying again: the descent has been arrested to a fraction of the fall.
      expect(state.vy).toBeGreaterThan(worstSink * 0.35);
    }
  });
});

// -- trim ---------------------------------------------------------------------

describe('a trimmed aircraft', () => {
  it('holds its altitude for ninety seconds with nothing touching the stick', () => {
    for (const type of ALL_AIRCRAFT_TYPES) {
      const spec = AIRCRAFT[type];
      const trim = trimLevelFlight(spec, spec.referenceCruise, 300);
      expect(trim).not.toBeNull();
      if (!trim) continue;

      const state = createFlightState(spec, 0, 0, 0, -1000);
      state.y = 300 + spec.gearHeight;
      applyTrim(state, spec, trim);
      const controls: FlightControls = {
        ...createFlightControls(),
        throttle: trim.throttle,
        elevator: trim.elevator,
        gearDown: false,
      };
      const events = createFlightEvents();
      const startY = state.y;

      for (let i = 0; i < 120 * 90; i += 1) {
        advanceFlight(state, controls, spec, OPEN_AIR, events, STEP);
      }

      // Two metres in a minute and a half. It settles; it does not oscillate.
      expect(Math.abs(state.y - startY)).toBeLessThan(2);
      expect(Math.abs(airspeed(state) - spec.referenceCruise)).toBeLessThan(2);
      expect(Math.abs(state.pitchRate)).toBeLessThan(0.01);
      expect(Math.abs(state.roll)).toBeLessThan(0.01);
    }
  });

  it('damps a disturbance rather than swinging about it', () => {
    const spec = AIRCRAFT.cessna;
    const trim = trimLevelFlight(spec, spec.referenceCruise, 400);
    expect(trim).not.toBeNull();
    if (!trim) return;
    const state = createFlightState(spec, 0, 0, 0, -1000);
    state.y = 400 + spec.gearHeight;
    applyTrim(state, spec, trim);
    // Kick the nose up hard and let go.
    state.pitchRate = 0.6;
    const controls: FlightControls = {
      ...createFlightControls(),
      throttle: trim.throttle,
      elevator: trim.elevator,
      gearDown: false,
    };
    const events = createFlightEvents();

    let peak = 0;
    for (let i = 0; i < 120 * 12; i += 1) {
      advanceFlight(state, controls, spec, OPEN_AIR, events, STEP);
      peak = Math.max(peak, Math.abs(state.pitchRate));
    }
    // The disturbance has decayed by more than an order of magnitude.
    expect(Math.abs(state.pitchRate)).toBeLessThan(peak * 0.1);
  });
});

// -- the power curve ----------------------------------------------------------

describe('thrust against drag', () => {
  it('settles at each type of aircraft’s real top speed', () => {
    for (const type of ALL_AIRCRAFT_TYPES) {
      const spec = AIRCRAFT[type];
      const solved = levelFlightSpeed(spec, 1, 0);
      // Within 12 per cent of the published sea-level maximum, every type.
      expect(Math.abs(solved - spec.referenceMaxSpeed) / spec.referenceMaxSpeed).toBeLessThan(0.12);
    }
  });

  it('reaches that speed by flying, not only by algebra', () => {
    for (const type of ALL_AIRCRAFT_TYPES) {
      const spec = AIRCRAFT[type];
      const state = airborne(spec, spec.referenceCruise * 0.8, 600);
      expect(state).not.toBeNull();
      if (!state) continue;
      const trim = trimLevelFlight(spec, spec.referenceCruise * 0.8, 600);
      if (!trim) continue;

      const controls: FlightControls = { ...createFlightControls(), throttle: 1, gearDown: false };
      const events = createFlightEvents();
      const hold = state.y;
      for (let i = 0; i < 120 * 400; i += 1) {
        const vsTarget = clampx((hold - state.y) * 0.25, -6, 6);
        controls.elevator = holdPitch(
          state,
          clampx(trim.pitch + (vsTarget - state.vy) * 0.02, -0.3, 0.3),
        );
        advanceFlight(state, controls, spec, OPEN_AIR, events, STEP);
      }
      const algebraic = levelFlightSpeed(spec, 1, 600);
      expect(Math.abs(airspeed(state) - algebraic)).toBeLessThan(algebraic * 0.05);
    }
  });

  it('gives the propellers a thrust that falls away and the fans one that does not', () => {
    const cessna = AIRCRAFT.cessna;
    const jet = AIRCRAFT.jet;
    // At its own cruise the piston has lost a third of its static thrust.
    const propRatio = thrustAt(cessna, 1, cessna.referenceCruise) / thrustAt(cessna, 1, 0);
    expect(propRatio).toBeLessThan(0.7);
    // The turbofan has lost under a fifth at a speed three times higher.
    const fanRatio = thrustAt(jet, 1, jet.referenceCruise) / thrustAt(jet, 1, 0);
    expect(fanRatio).toBeGreaterThan(0.8);
  });

  it('costs performance with altitude, because the air is thinner', () => {
    for (const type of ALL_AIRCRAFT_TYPES) {
      const spec = AIRCRAFT[type];
      expect(thrustAt(spec, 1, 0, 1.0)).toBeLessThan(thrustAt(spec, 1, 0, 1.225));
      expect(stallSpeed(spec, 1.0)).toBeGreaterThan(stallSpeed(spec, 1.225));
    }
  });
});

// -- turning ------------------------------------------------------------------

describe('a banked turn', () => {
  it('turns at g tan(bank) / V, because that is what the lift vector does', () => {
    for (const bank of [0.35, 0.5236, 0.7]) {
      for (const type of ALL_AIRCRAFT_TYPES) {
        const spec = AIRCRAFT[type];
        const trim = trimLevelFlight(spec, spec.referenceCruise, 500);
        const state = airborne(spec, spec.referenceCruise, 500);
        if (!trim || !state) continue;
        state.roll = bank;

        const controls: FlightControls = {
          ...createFlightControls(),
          throttle: trim.throttle,
          gearDown: false,
        };
        const events = createFlightEvents();
        let yawStart = 0;
        const settle = 120 * 8;
        const total = 120 * 24;

        for (let i = 0; i < total; i += 1) {
          // Hold the bank, hold the altitude, hold the speed - which is
          // exactly the three things a pilot does in a level turn.
          controls.aileron = clampx((bank - state.roll) * 3 - state.rollRate * 1.4, -1, 1);
          controls.elevator = holdPitch(state, trim.pitch / Math.cos(bank) - state.vy * 0.02);
          controls.throttle = clampx(
            trim.throttle + (spec.referenceCruise - airspeed(state)) * 0.05,
            0,
            1,
          );
          advanceFlight(state, controls, spec, OPEN_AIR, events, STEP);
          if (i === settle) yawStart = state.yaw;
        }

        let yawEnd = state.yaw;
        while (yawEnd - yawStart > Math.PI) yawEnd -= 2 * Math.PI;
        while (yawEnd - yawStart < -Math.PI) yawEnd += 2 * Math.PI;
        const measured = Math.abs(yawEnd - yawStart) / ((total - settle) / 120);
        const ideal = (GRAVITY * Math.tan(bank)) / airspeed(state);
        expect(Math.abs(measured - ideal) / ideal).toBeLessThan(0.12);
      }
    }
  });

  it('sinks in a bank unless the nose comes up', () => {
    const spec = AIRCRAFT.cessna;
    const trim = trimLevelFlight(spec, spec.referenceCruise, 500);
    const state = airborne(spec, spec.referenceCruise, 500);
    if (!trim || !state) return;
    const controls: FlightControls = {
      ...createFlightControls(),
      throttle: trim.throttle,
      elevator: trim.elevator,
      gearDown: false,
    };
    const events = createFlightEvents();
    const startY = state.y;
    // Roll to 45 degrees and hold the elevator exactly where level flight
    // wanted it. `L cos(bank)` is now 0.71 W, so it must descend.
    for (let i = 0; i < 120 * 14; i += 1) {
      controls.aileron = clampx((0.785 - state.roll) * 3 - state.rollRate * 1.4, -1, 1);
      advanceFlight(state, controls, spec, OPEN_AIR, events, STEP);
    }
    expect(state.y).toBeLessThan(startY - 20);
  });
});

// -- take-off -----------------------------------------------------------------

/** Full power from the north threshold; back stick from just below Vr. */
function takeOff(spec: AircraftSpec): { roll: number; liftoffSpeed: number } {
  const state = createFlightState(
    spec,
    RUNWAY.centreX,
    RUNWAY.northZ,
    RUNWAY.headingSouth,
    AIRFIELD_LEVEL,
  );
  const controls: FlightControls = { ...createFlightControls(), throttle: 1, gearDown: true };
  const events = createFlightEvents();
  const rotate = rotateSpeed(spec) * 0.9;
  const start = state.z;

  for (let i = 0; i < 120 * 180; i += 1) {
    const v = airspeed(state);
    controls.elevator = v >= rotate ? 1 : 0;
    const wasDown = state.onGround;
    advanceFlight(state, controls, spec, AIRFIELD, events, STEP);
    if (wasDown && !state.onGround) return { roll: state.z - start, liftoffSpeed: v };
    if (state.crashed) break;
  }
  return { roll: Number.POSITIVE_INFINITY, liftoffSpeed: Number.NaN };
}

describe('the take-off roll', () => {
  it('gets every flyable type airborne inside the 600 m runway', () => {
    for (const type of FLYABLE_AIRCRAFT_TYPES) {
      const spec = AIRCRAFT[type];
      const run = takeOff(spec);
      // The assertion the runway length exists to satisfy.
      expect(run.roll, `${type} needs ${run.roll.toFixed(0)} m of runway`).toBeLessThan(
        RUNWAY_LENGTH,
      );
      // And it left the ground because it was flying, not because it was fast:
      // between 1.05 and 1.3 times the stall speed is a real rotation.
      const ratio = run.liftoffSpeed / stallSpeed(spec);
      expect(ratio).toBeGreaterThan(1.03);
      expect(ratio).toBeLessThan(1.32);
    }
  });

  it('rotates because the elevator beats the nose wheel, not because of a speed check', () => {
    // Same aeroplane, twice the weight on the wheels: the heavy one must need
    // more speed before the nose comes up. Nothing in the model is told this.
    const light = AIRCRAFT.cessna;
    const heavy: AircraftSpec = { ...light, mass: light.mass * 1.35 };
    expect(takeOff(heavy).liftoffSpeed).toBeGreaterThan(takeOff(light).liftoffSpeed);
  });

  it('states loudly that the airliner cannot use this runway', () => {
    const spec = AIRCRAFT.liner;
    expect(spec.flyable).toBe(false);
    expect(spec.groundedReason).toBeTruthy();
    const run = takeOff(spec);
    // The number behind the decision. If anyone flips `flyable`, this is why.
    expect(run.roll).toBeGreaterThan(RUNWAY_LENGTH * 1.5);
    expect(run.roll).toBeLessThan(2200);
  });
});

// -- landing ------------------------------------------------------------------

describe('an approach at Vref', () => {
  it('touches down on the runway at a survivable rate', () => {
    for (const type of FLYABLE_AIRCRAFT_TYPES) {
      const spec = AIRCRAFT[type];
      const vref = approachSpeed(spec);
      const slope = 3 * (Math.PI / 180);
      const trim = trimLevelFlight(spec, vref, AIRFIELD_LEVEL + 120, 1);
      expect(trim).not.toBeNull();
      if (!trim) continue;

      const state = createFlightState(
        spec,
        RUNWAY.centreX,
        RUNWAY.northZ - 120 / Math.tan(slope),
        RUNWAY.headingSouth,
        AIRFIELD_LEVEL,
      );
      state.y = AIRFIELD_LEVEL + 120 + spec.gearHeight;
      applyTrim(state, spec, trim, true);
      const controls: FlightControls = {
        ...createFlightControls(),
        throttle: trim.throttle,
        gearDown: true,
      };
      const events = createFlightEvents();
      const descent = vref * Math.tan(slope);

      let landed = false;
      for (let i = 0; i < 120 * 240; i += 1) {
        const agl = contactHeight(state, spec) - AIRFIELD_LEVEL;
        const flare = agl < spec.gearHeight * 2 + 2;
        const toGo = RUNWAY.northZ - state.z;
        const wantedAgl = Math.max(0, toGo * Math.tan(slope));
        const path = clampx(-descent - (agl - wantedAgl) * 0.22, -descent * 2.2, 0.6);
        const target = flare ? -Math.max(0.35, agl * 0.5) : path;
        controls.elevator = holdPitch(state, trim.pitch + (target - state.vy) * 0.03);
        // Over the fence at 1.15 Vs, not the full approach speed: carrying
        // Vref into the flare is exactly how a light aircraft floats.
        const wanted = agl > 15 ? vref : stallSpeed(spec) * 1.15;
        controls.throttle = flare
          ? 0
          : clampx(trim.throttle + (wanted - airspeed(state)) * 0.06, 0, 1);
        advanceFlight(state, controls, spec, AIRFIELD, events, STEP);
        if (events.touchdown) {
          landed = true;
          // Under the undercarriage's limit, so nothing breaks.
          expect(events.touchdownVs).toBeGreaterThan(0);
          expect(events.touchdownVs).toBeLessThan(spec.gearLimitVs);
          expect(events.touchdownHard).toBe(false);
          expect(state.crashed).toBe(false);
          // On the pavement, between the two thresholds.
          expect(state.z).toBeGreaterThan(RUNWAY.northZ);
          expect(state.z).toBeLessThan(RUNWAY.southZ);
          expect(Math.abs(state.x - RUNWAY.centreX)).toBeLessThan(RUNWAY.halfWidth);
          break;
        }
        if (state.crashed) break;
      }
      expect(landed, `${type} never touched down`).toBe(true);
    }
  });

  it('breaks the gear when it arrives too hard, and says so', () => {
    const spec = AIRCRAFT.cessna;
    const state = createFlightState(
      spec,
      RUNWAY.centreX,
      RUNWAY.northZ + 200,
      RUNWAY.headingSouth,
      AIRFIELD_LEVEL,
    );
    state.y = AIRFIELD_LEVEL + 12 + spec.gearHeight;
    state.onGround = false;
    state.vz = approachSpeed(spec);
    state.vy = -(spec.crashVs + 3);
    const controls: FlightControls = { ...createFlightControls(), gearDown: true };
    const events = createFlightEvents();
    for (let i = 0; i < 120 * 6; i += 1) {
      advanceFlight(state, controls, spec, AIRFIELD, events, STEP);
      if (events.touchdown) break;
    }
    expect(events.touchdown).toBe(true);
    expect(events.touchdownHard).toBe(true);
    expect(events.impact).toBe(true);
    expect(state.crashed).toBe(true);
  });

  it('treats a belly arrival as damage even when it is gentle', () => {
    const spec = AIRCRAFT.jet;
    const state = createFlightState(
      spec,
      RUNWAY.centreX,
      RUNWAY.northZ + 200,
      RUNWAY.headingSouth,
      AIRFIELD_LEVEL,
    );
    state.y = AIRFIELD_LEVEL + 4 + spec.gearHeight;
    state.onGround = false;
    state.gear = 0;
    state.vz = approachSpeed(spec);
    state.vy = -1.0;
    const controls: FlightControls = { ...createFlightControls(), gearDown: false };
    const events = createFlightEvents();
    for (let i = 0; i < 120 * 8; i += 1) {
      advanceFlight(state, controls, spec, AIRFIELD, events, STEP);
      if (events.touchdown) break;
    }
    expect(events.touchdown).toBe(true);
    expect(events.touchdownHard).toBe(true);
    expect(events.impactSpeed).toBeGreaterThan(1);
  });

  it('calls flying into a hillside an impact, not a landing', () => {
    const spec = AIRCRAFT.cessna;
    // Ground that climbs steeply ahead of the aircraft.
    const hill: FlightWorld = {
      groundY: (_x: number, z: number): number => AIRFIELD_LEVEL + Math.max(0, (z - 300) * 0.35),
    };
    const state = createFlightState(spec, 0, 200, Math.PI, AIRFIELD_LEVEL);
    state.y = AIRFIELD_LEVEL + 40 + spec.gearHeight;
    state.onGround = false;
    state.vz = spec.referenceCruise;
    const controls: FlightControls = { ...createFlightControls(), throttle: 0.6, gearDown: true };
    const events = createFlightEvents();
    let sawImpact = false;
    let sawTouchdown = false;
    for (let i = 0; i < 120 * 20; i += 1) {
      advanceFlight(state, controls, spec, hill, events, STEP);
      if (events.impact) sawImpact = true;
      if (events.touchdown) sawTouchdown = true;
      if (state.crashed) break;
    }
    expect(sawImpact).toBe(true);
    expect(sawTouchdown).toBe(false);
    expect(state.crashed).toBe(true);
  });
});

// -- braking ------------------------------------------------------------------

describe('the wheel brakes', () => {
  it('stop every flyable type on the paved surface', () => {
    for (const type of FLYABLE_AIRCRAFT_TYPES) {
      const spec = AIRCRAFT[type];
      const state = createFlightState(
        spec,
        RUNWAY.centreX,
        RUNWAY.northZ,
        RUNWAY.headingSouth,
        AIRFIELD_LEVEL,
      );
      state.vz = approachSpeed(spec);
      const controls: FlightControls = { ...createFlightControls(), throttle: 0, brakes: true };
      const events = createFlightEvents();
      const start = state.z;

      let stopped = false;
      for (let i = 0; i < 120 * 120; i += 1) {
        advanceFlight(state, controls, spec, AIRFIELD, events, STEP);
        if (airspeed(state) < 0.5) {
          stopped = true;
          break;
        }
      }
      const roll = state.z - start;
      expect(stopped, `${type} never stopped`).toBe(true);
      expect(roll, `${type} used ${roll.toFixed(0)} m`).toBeLessThan(
        RUNWAY_LENGTH + RUNWAY.overrun,
      );
      // It stopped; it did not creep on for ever afterwards.
      expect(state.onGround).toBe(true);
      expect(Math.abs(state.vy)).toBeLessThan(0.01);
    }
  });

  it('rolls much further without them', () => {
    const spec = AIRCRAFT.jet;
    const roll = (brakes: boolean): number => {
      const state = createFlightState(spec, 0, 0, RUNWAY.headingSouth, AIRFIELD_LEVEL);
      state.vz = approachSpeed(spec);
      const controls: FlightControls = { ...createFlightControls(), throttle: 0, brakes };
      const events = createFlightEvents();
      for (let i = 0; i < 120 * 20; i += 1) {
        advanceFlight(state, controls, spec, AIRFIELD, events, STEP);
      }
      return state.z;
    };
    expect(roll(false)).toBeGreaterThan(roll(true) * 1.5);
  });
});

// -- frame rate ---------------------------------------------------------------

describe('the fixed sub-step', () => {
  /** The same twenty seconds of open-loop flying, at a chosen frame rate. */
  function sweep(spec: AircraftSpec, hz: number): FlightState {
    const state = createFlightState(spec, 100, 200, 0.4, -3000);
    state.y = 500 + spec.gearHeight;
    const trim = trimLevelFlight(spec, spec.referenceCruise, 500);
    if (trim) applyTrim(state, spec, trim);
    const controls: FlightControls = {
      elevator: 0.22,
      aileron: 0.3,
      rudder: -0.12,
      throttle: 0.8,
      brakes: false,
      gearDown: false,
    };
    const events = createFlightEvents();
    for (let i = 0; i < hz * 20; i += 1) {
      advanceFlight(state, controls, spec, OPEN_AIR, events, 1 / hz);
    }
    return state;
  }

  it('flies the same aeroplane at 30 Hz and at 240 Hz', () => {
    for (const type of ALL_AIRCRAFT_TYPES) {
      const spec = AIRCRAFT[type];
      const slow = sweep(spec, 30);
      const fast = sweep(spec, 240);
      // Both frame rates are whole multiples of the 1/120 s step, so the same
      // number of integrations runs and the trajectories are identical - not
      // close, identical. A tolerance is kept for the arithmetic, not for the
      // model.
      expect(slow.x).toBeCloseTo(fast.x, 6);
      expect(slow.y).toBeCloseTo(fast.y, 6);
      expect(slow.z).toBeCloseTo(fast.z, 6);
      expect(slow.yaw).toBeCloseTo(fast.yaw, 9);
      expect(slow.pitch).toBeCloseTo(fast.pitch, 9);
      expect(slow.roll).toBeCloseTo(fast.roll, 9);
      expect(airspeed(slow)).toBeCloseTo(airspeed(fast), 6);
    }
  });

  it('runs the same number of steps however the frame time arrives', () => {
    const spec = AIRCRAFT.cessna;
    const events = createFlightEvents();
    const controls = createFlightControls();
    const count = (hz: number, seconds: number): number => {
      const state = createFlightState(spec, 0, 0, 0, AIRFIELD_LEVEL);
      let steps = 0;
      for (let i = 0; i < hz * seconds; i += 1) {
        steps += advanceFlight(state, controls, spec, AIRFIELD, events, 1 / hz);
      }
      return steps;
    };
    expect(count(30, 10)).toBe(1200);
    expect(count(60, 10)).toBe(1200);
    expect(count(240, 10)).toBe(1200);
  });

  it('refuses to deliver a whole stalled second in one frame', () => {
    const spec = AIRCRAFT.cessna;
    const state = createFlightState(spec, 0, 0, 0, AIRFIELD_LEVEL);
    const events = createFlightEvents();
    const controls = createFlightControls();
    // A tab that has been asleep for a second must not fly 120 steps at once.
    expect(advanceFlight(state, controls, spec, AIRFIELD, events, 1)).toBeLessThanOrEqual(8);
  });
});

// -- per-type character -------------------------------------------------------

describe('the four types', () => {
  it('are ordered the way their wing loading says they should be', () => {
    const speeds = ALL_AIRCRAFT_TYPES.map((type) => stallSpeed(AIRCRAFT[type]));
    for (let i = 1; i < speeds.length; i += 1) {
      expect(speeds[i]).toBeGreaterThan(speeds[i - 1] as number);
    }
    // The Cessna is the forgiving one: lowest stall, lowest approach speed,
    // shortest roll. The jet is the slippery one: least drag of the flyable
    // three, so it keeps its speed with the power off.
    expect(AIRCRAFT.cessna.cd0).toBeGreaterThan(AIRCRAFT.jet.cd0 * 1.5);
    expect(approachSpeed(AIRCRAFT.cessna)).toBeLessThan(approachSpeed(AIRCRAFT.jet) * 0.6);
  });

  it('coasts further in the slippery one than in the draggy one', () => {
    const glide = (spec: AircraftSpec): number => {
      const state = airborne(spec, spec.referenceCruise, 2000);
      if (!state) return 0;
      const trim = trimLevelFlight(spec, spec.referenceCruise, 2000);
      if (!trim) return 0;
      const controls: FlightControls = { ...createFlightControls(), throttle: 0, gearDown: false };
      const events = createFlightEvents();
      const startY = state.y;
      const startZ = state.z;
      for (let i = 0; i < 120 * 60; i += 1) {
        controls.elevator = holdPitch(state, trim.pitch);
        advanceFlight(state, controls, spec, OPEN_AIR, events, STEP);
      }
      // Glide ratio: distance covered per metre lost.
      return Math.hypot(state.x, state.z - startZ) / Math.max(0.01, startY - state.y);
    };
    expect(glide(AIRCRAFT.jet)).toBeGreaterThan(glide(AIRCRAFT.cessna));
  });
});
