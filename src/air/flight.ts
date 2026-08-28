/**
 * The flight model. Forces and moments, no Three.js, no DOM, no allocation.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   const state = createFlightState(spec, x, z, yaw, groundY);
 *   const events = createFlightEvents();
 *   advanceFlight(state, controls, spec, world, events, dt);   // once a frame
 *
 * `world` supplies the ground height and, optionally, a solid-geometry test.
 * Everything else is arithmetic over the numbers in `AircraftCatalogue`.
 *
 * ============================================================================
 *
 * ## What this is
 *
 * A real force model rather than an arcade approximation. Every frame it
 * computes, in this order:
 *
 *   1. the aircraft's body axes from yaw, pitch and roll;
 *   2. the relative wind in those axes, giving angle of attack and sideslip;
 *   3. `CL(alpha)` from a lift curve that PEAKS and then collapses, so the
 *      stall is a property of the curve and not an `if (speed < Vs)`;
 *   4. `CD = CD0 + gear + k*CL^2 + a compressibility rise`;
 *   5. thrust from a propeller or turbofan curve;
 *   6. moments about all three axes from control derivatives, static
 *      stability and aerodynamic damping, divided by real inertias;
 *   7. the ground reaction, if any: normal force, rolling or braking
 *      friction, a lateral tyre constraint and nose-wheel steering.
 *
 * Nothing is scripted. A banked aircraft turns because the lift vector is
 * tilted and its horizontal component is a centripetal force; it sinks in the
 * turn because the vertical component is now `L cos(bank)`, which is less than
 * the weight; it stalls in the turn because pulling the nose up to fix that
 * pushes `alpha` past the peak of the lift curve. That is all one calculation.
 *
 * ## Sign conventions, which are the easiest thing here to get wrong
 *
 * The game's heading convention is `forward = (-sin yaw, 0, -cos yaw)`, so
 * yaw 0 faces -Z and INCREASING YAW TURNS LEFT. Therefore:
 *
 *   - `pitch`     positive nose up;         `pitchRate = d(pitch)/dt`
 *   - `roll`      positive right wing down; `rollRate  = d(roll)/dt`
 *   - `yawRate  = d(yaw)/dt`, so it is POSITIVE TO THE LEFT
 *   - `controls.elevator` +1 = nose up
 *   - `controls.aileron`  +1 = roll right
 *   - `controls.rudder`   +1 = nose RIGHT, which is a NEGATIVE yaw rate
 *   - `alpha` positive when the relative wind comes from below the nose
 *   - `beta`  positive when the aircraft is moving toward its own right
 *
 * Every aerodynamic term below is written in the "nose right / right wing
 * down / nose up" sense and converted once, at the point it becomes a yaw
 * acceleration.
 *
 * ## Fixed sub-step
 *
 * `advanceFlight` accumulates the frame time and runs whole `FLIGHT_STEP`
 * (1/120 s) integrations, the same step and the same accumulator shape as
 * `FirstPersonController`. This is not tidiness: an aircraft is a stiff system
 * - the pitch damping term alone has a time constant of about 0.15 s - and
 * integrating it with a variable frame time makes the handling depend on the
 * frame rate. `tests/flight.test.ts` flies the same aeroplane at 30 Hz and at
 * 240 Hz and requires the two trajectories to agree.
 *
 * ## Rotation is emergent
 *
 * There is no "if the speed is above Vr, lift the nose". While the wheels are
 * down, the weight on them acting through `mainGearArm` is a nose-down moment;
 * the elevator's moment grows with dynamic pressure and the weight on the
 * wheels falls as the wing takes the load. Vr is where those cross. The same
 * arrangement is what makes a heavy aircraft rotate later than a light one
 * without a second number anywhere.
 */

import { clamp, smoothstep } from '../core/mathx';
import { GRAVITY, SEA_LEVEL_DENSITY, type AircraftSpec } from './AircraftCatalogue';

/** The integration step. Matches `FirstPersonController.FIXED_STEP`. */
export const FLIGHT_STEP = 1 / 120;

/**
 * Longest catch-up an `advanceFlight` call will attempt, in sub-steps.
 *
 * Eight, the same as the walking controller: a tab that has been asleep must
 * not deliver a second of simulation in one frame and fly the aeroplane into a
 * building while the player was not looking.
 */
const MAX_SUBSTEPS = 8;

/**
 * Furthest the aircraft may move between two solid-geometry tests, metres.
 *
 * The test is done at the END of a displacement, so a step longer than the
 * thinnest thing in the world can begin in front of a wall and end behind it.
 * The narrowest building mass in Meridian Bay is about 6 m; 1.5 m is a
 * comfortable quarter of that, and at the fastest speed any of these aircraft
 * reaches (209 m/s) one 1/120 s step is 1.74 m, so the loop normally runs
 * twice and never more than a handful of times.
 */
const MAX_COLLISION_STEP = 1.5;

/** Airspeed below which the aerodynamic terms are skipped as negligible. */
const AERO_FLOOR = 0.25;

/** How far below the wheels the ground may be before contact is broken. */
const CONTACT_EPSILON = 0.02;

/** Descent rate below which a contact is a settle, not a touchdown, m/s. */
const TOUCHDOWN_FLOOR = 0.05;

/** Bank the main wheels hold while the aircraft is on them, radians. */
const GROUND_ROLL_LIMIT = 0.1;
const GROUND_ROLL_STIFFNESS = 22;
const GROUND_ROLL_DAMPING = 9;

/**
 * How far ahead the ground is probed on contact, in seconds of flight.
 *
 * Touching down on a runway and flying into a hillside look identical to a
 * height comparison. They are told apart by asking what the ground does just
 * ahead: if it is more than `TERRAIN_STRIKE_RISE` above the wheels a third of
 * a second from now, the aircraft is not landing on it.
 */
const TERRAIN_PROBE_SECONDS = 0.3;
const TERRAIN_STRIKE_RISE = 1.5;

/** What the pilot is asking for. Values outside the ranges are clamped. */
export interface FlightControls {
  /** -1 nose down .. +1 nose up. */
  elevator: number;
  /** -1 roll left .. +1 roll right. */
  aileron: number;
  /** -1 yaw left .. +1 yaw right. Also drives the nose wheel on the ground. */
  rudder: number;
  /** 0 .. 1. The engine spools toward this at `spec.spoolRate`. */
  throttle: number;
  /** Wheel brakes. */
  brakes: boolean;
  /** Gear lever. Ignored on a fixed-gear type. */
  gearDown: boolean;
}

export function createFlightControls(): FlightControls {
  return { elevator: 0, aileron: 0, rudder: 0, throttle: 0, brakes: false, gearDown: true };
}

/**
 * Everything that changes. Mutated in place; never reallocated.
 *
 * `x`, `y`, `z` are the CENTRE OF GRAVITY, and `y` is height above sea level.
 * The wheels are `spec.gearHeight` below it - see `contactHeight`.
 */
export interface FlightState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  roll: number;
  /** Positive to the LEFT. See the header. */
  yawRate: number;
  pitchRate: number;
  rollRate: number;
  /** Spooled throttle, 0..1. Lags the lever by `spec.spoolRate`. */
  throttle: number;
  /** Undercarriage travel: 0 fully up, 1 fully down. */
  gear: number;
  onGround: boolean;
  /** Once true the airframe is written off and nothing but gravity acts. */
  crashed: boolean;
  /** Left-over frame time, so sub-stepping survives across calls. */
  accumulator: number;
}

/**
 * What happened during one `advanceFlight`. An out-parameter, owned and reused
 * by the caller, so a frame of flight allocates nothing at all.
 */
export interface FlightEvents {
  touchdown: boolean;
  /** Descent rate at the moment of touchdown, m/s. Positive is downward. */
  touchdownVs: number;
  /** True when that touchdown was hard enough to break something. */
  touchdownHard: boolean;
  liftoff: boolean;
  impact: boolean;
  /** Closing speed of the worst impact this frame, m/s. */
  impactSpeed: number;
  /** True on the frame the airframe was written off. */
  crashed: boolean;
  /**
   * True when a displacement was REFUSED by solid geometry this frame,
   * whatever the closing speed.
   *
   * Distinct from `impact`, and the distinction is the whole point: `impact`
   * only fires above 0.2 m/s of closing speed, so an aeroplane creeping into
   * something reports nothing at all - it simply has its velocity zeroed every
   * step and stops, silently, for ever. That failure mode was real: a Light
   * twin taxiing off its stand met a ground-power cart 0.6 m in front of its
   * nose, and full throttle produced no motion and no message. Reporting every
   * refusal is what lets the caller notice a jam and say so.
   */
  blocked: boolean;
}

export function createFlightEvents(): FlightEvents {
  return {
    touchdown: false,
    touchdownVs: 0,
    touchdownHard: false,
    liftoff: false,
    impact: false,
    impactSpeed: 0,
    crashed: false,
    blocked: false,
  };
}

export function resetFlightEvents(events: FlightEvents): void {
  events.touchdown = false;
  events.touchdownVs = 0;
  events.touchdownHard = false;
  events.liftoff = false;
  events.impact = false;
  events.impactSpeed = 0;
  events.crashed = false;
  events.blocked = false;
}

/**
 * What the flight model is allowed to ask the world.
 *
 * Two plain functions, so a unit test supplies a flat plane and the game
 * supplies `CityGround` and `CollisionWorld` without this module knowing that
 * either exists.
 */
export interface FlightWorld {
  /** Ground height at a point, metres above sea level. */
  groundY(x: number, z: number): number;
  /**
   * True when the aircraft's oriented footprint would be inside something
   * solid. `bottom` and `top` are the world heights of the airframe, so a
   * height-banded test lets it fly over a building and hit the same building
   * on the way down. Omit it and the aircraft only ever meets the ground.
   */
  blocked?(
    x: number,
    z: number,
    yaw: number,
    halfLength: number,
    halfWidth: number,
    bottom: number,
    top: number,
  ): boolean;
}

// -- atmosphere ---------------------------------------------------------------

/**
 * ISA density at a height above sea level, kg/m^3.
 *
 * The troposphere formula, not a constant, because it is one line and it is
 * what makes a climb cost performance: at 2000 m the air is 18 per cent
 * thinner, so the wing needs more speed and the engines make less thrust.
 */
export function airDensity(altitude: number): number {
  const h = Math.max(0, altitude);
  return SEA_LEVEL_DENSITY * Math.pow(1 - 2.25577e-5 * h, 4.25588);
}

// -- aerodynamics -------------------------------------------------------------

/** The angle of attack at which this wing makes no lift at all, radians. */
export function zeroLiftAngle(spec: AircraftSpec): number {
  return -spec.clZero / spec.clAlpha;
}

/**
 * The lift curve, and the reason the stall is real.
 *
 * Below the stall the wing is a linear `CL0 + CLa * alpha`. Past it the flow
 * has separated and the wing is a flat plate, `sin(2 alpha)`, which is much
 * lower everywhere in the interesting range. The two are blended across
 * `stallWidth` with a smoothstep, so:
 *
 *   - the curve PEAKS at exactly `alphaStall` past the zero-lift angle, where
 *     `CL = clAlpha * alphaStall = clMax`;
 *   - a little beyond that CL falls, so holding the nose up loses lift, the
 *     nose drops, alpha falls, the flow reattaches and the aircraft flies
 *     again. The recovery is the same curve read backwards;
 *   - it is symmetric about the zero-lift angle, so the aircraft also stalls
 *     inverted or under a hard push.
 *
 * There is no speed anywhere in this function.
 */
export function liftCoefficient(spec: AircraftSpec, alpha: number): number {
  const relative = alpha - zeroLiftAngle(spec);
  const linear = spec.clZero + spec.clAlpha * alpha;
  // A flat plate at `alpha`: 2 sin cos, i.e. sin(2 alpha).
  const separated = 2 * Math.sin(alpha) * Math.cos(alpha);
  const blend = smoothstep(
    spec.alphaStall,
    spec.alphaStall + spec.stallWidth,
    Math.abs(relative),
  );
  return linear * (1 - blend) + separated * blend;
}

/** How far past the stall the wing is, 0 attached and 1 fully separated. */
export function stallFraction(spec: AircraftSpec, alpha: number): number {
  return smoothstep(
    spec.alphaStall,
    spec.alphaStall + spec.stallWidth,
    Math.abs(alpha - zeroLiftAngle(spec)),
  );
}

/**
 * Total drag coefficient.
 *
 * Parasite drag, the undercarriage when it is out, induced drag proportional
 * to `CL^2`, and a rise above `dragRiseSpeed`. The rise stands in for
 * compressibility on the jets and for the airframe simply running out of shape
 * on the propeller types; it is what actually limits level speed, and without
 * it the Learjet settled at 486 kt at sea level because nothing opposed the
 * flat turbofan curve.
 */
export function dragCoefficient(
  spec: AircraftSpec,
  cl: number,
  speed: number,
  gear: number,
): number {
  let cd = spec.cd0 + spec.cd0Gear * clamp(gear, 0, 1) + spec.inducedK * cl * cl;
  if (speed > spec.dragRiseSpeed) {
    const over = (speed - spec.dragRiseSpeed) / spec.dragRiseSpeed;
    cd += spec.dragRiseCoefficient * over * over;
  }
  return cd;
}

/**
 * Thrust available, newtons.
 *
 * One formula for both engine types, `1 - (V / Vzero) ^ n`:
 *
 *   - a PROPELLER unloads as the aircraft speeds up, so `n = 2` with a `Vzero`
 *     not far above the type's maximum level speed. The Cessna makes 2400 N
 *     standing still and 1400 N at cruise;
 *   - a TURBOFAN is very nearly flat, which is `n = 1` with `Vzero` at 900 m/s
 *     - a 17 per cent lapse by 150 m/s and nothing dramatic anywhere.
 *
 * Density scales it, so an engine loses thrust with altitude exactly as the
 * wing loses lift.
 */
export function thrustAt(
  spec: AircraftSpec,
  throttle: number,
  speed: number,
  density = SEA_LEVEL_DENSITY,
): number {
  const lever = clamp(throttle, 0, 1);
  const setting = spec.idleFraction + (1 - spec.idleFraction) * lever;
  const ratio = Math.max(0, speed) / spec.thrustZeroSpeed;
  const curve = Math.max(0, 1 - Math.pow(ratio, spec.thrustExponent));
  return spec.thrustStatic * setting * curve * (density / SEA_LEVEL_DENSITY);
}

// -- state helpers ------------------------------------------------------------

/** Height of the wheels above sea level. */
export function contactHeight(state: FlightState, spec: AircraftSpec): number {
  return state.y - spec.gearHeight;
}

export function airspeed(state: FlightState): number {
  return Math.hypot(state.vx, state.vy, state.vz);
}

export function groundSpeed(state: FlightState): number {
  return Math.hypot(state.vx, state.vz);
}

/** Rate of climb, m/s. Positive up, which is the opposite of a VSI reading. */
export function verticalSpeed(state: FlightState): number {
  return state.vy;
}

/** Angle of attack from the current velocity and attitude, radians. */
export function angleOfAttack(state: FlightState): number {
  const cy = Math.cos(state.yaw);
  const sy = Math.sin(state.yaw);
  const cp = Math.cos(state.pitch);
  const sp = Math.sin(state.pitch);
  const cr = Math.cos(state.roll);
  const sr = Math.sin(state.roll);
  const fx = -sy * cp;
  const fy = sp;
  const fz = -cy * cp;
  const ux = sy * sp * cr + cy * sr;
  const uy = cp * cr;
  const uz = cy * sp * cr - sy * sr;
  const vf = state.vx * fx + state.vy * fy + state.vz * fz;
  const vu = state.vx * ux + state.vy * uy + state.vz * uz;
  if (Math.abs(vf) < 1e-6 && Math.abs(vu) < 1e-6) return 0;
  return Math.atan2(-vu, vf);
}

/** Parked, wheels on the ground, engine at idle. */
export function createFlightState(
  spec: AircraftSpec,
  x: number,
  z: number,
  yaw: number,
  groundY: number,
): FlightState {
  return {
    x,
    y: groundY + spec.gearHeight,
    z,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw,
    pitch: spec.groundPitch,
    roll: 0,
    yawRate: 0,
    pitchRate: 0,
    rollRate: 0,
    throttle: 0,
    gear: 1,
    onGround: true,
    crashed: false,
    accumulator: 0,
  };
}

// -- trim ---------------------------------------------------------------------

/** A steady level-flight solution. Everything a caller needs to fly hands-off. */
export interface TrimSolution {
  readonly speed: number;
  readonly alpha: number;
  /** Body attitude. In level flight the flight path is flat, so pitch = alpha. */
  readonly pitch: number;
  readonly throttle: number;
  readonly elevator: number;
}

/**
 * The angle of attack that produces a given CL, on the ATTACHED side of the
 * lift curve. Returns null when the wing cannot make that much lift at all.
 *
 * Bisection rather than algebra because the curve is blended and therefore not
 * invertible in closed form. Forty iterations is 1e-12 radians; it is called
 * once per trim request, never in the frame loop.
 */
export function alphaForLift(spec: AircraftSpec, targetCl: number): number | null {
  if (targetCl > spec.clMax) return null;
  const zero = zeroLiftAngle(spec);
  let low = zero;
  let high = zero + spec.alphaStall;
  if (targetCl < liftCoefficient(spec, low)) {
    // Below the zero-lift angle: search downward instead.
    low = zero - spec.alphaStall;
    high = zero;
    if (targetCl < liftCoefficient(spec, low)) return null;
  }
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) * 0.5;
    if (liftCoefficient(spec, mid) < targetCl) low = mid;
    else high = mid;
  }
  return (low + high) * 0.5;
}

/**
 * Solves steady level flight at a given speed.
 *
 * `L + T sin(alpha) = W` and `T cos(alpha) = D` are coupled through CL, so it
 * is iterated four times from `CL = W / qS`; the correction is under one per
 * cent by the second pass. The elevator is then whatever cancels the static
 * pitching moment, which is what makes an aircraft set up with this solution
 * hold its altitude with the stick untouched.
 *
 * Returns null when the aircraft cannot fly level at that speed - too slow for
 * the wing, or too fast for the engines.
 */
export function trimLevelFlight(
  spec: AircraftSpec,
  speed: number,
  altitude = 0,
  gear = 0,
): TrimSolution | null {
  if (!(speed > 1)) return null;
  const density = airDensity(altitude);
  const qS = 0.5 * density * speed * speed * spec.wingArea;
  const weight = spec.mass * GRAVITY;

  let alpha = 0;
  let drag = 0;
  let cl = weight / qS;
  for (let i = 0; i < 4; i += 1) {
    const solved = alphaForLift(spec, cl);
    if (solved === null) return null;
    alpha = solved;
    drag = dragCoefficient(spec, cl, speed, gear) * qS;
    cl = (weight - drag * Math.tan(alpha)) / qS;
    if (cl <= 0) return null;
  }

  const thrustNeeded = drag / Math.cos(alpha);
  const full = thrustAt(spec, 1, speed, density);
  if (!(full > 0)) return null;
  const idleThrust = thrustAt(spec, 0, speed, density);
  if (thrustNeeded > full) return null;
  const throttle = clamp((thrustNeeded - idleThrust) / Math.max(full - idleThrust, 1e-6), 0, 1);

  return {
    speed,
    alpha,
    pitch: alpha,
    throttle,
    elevator: clamp((-spec.cmAlpha * (alpha - spec.alphaTrim)) / spec.elevatorPower, -1, 1),
  };
}

/**
 * Highest speed at which thrust still equals drag in level flight.
 *
 * Walked down from 420 m/s rather than up from zero because the power curve
 * has two roots and only the fast one is the aircraft's top speed; the slow
 * one is the back of the drag curve, where the aircraft is mushing along on
 * the wrong side of minimum drag. Returns 0 if it cannot fly level at all.
 */
export function levelFlightSpeed(
  spec: AircraftSpec,
  throttle: number,
  altitude = 0,
  gear = 0,
): number {
  const density = airDensity(altitude);
  const weight = spec.mass * GRAVITY;
  const excess = (speed: number): number => {
    const qS = 0.5 * density * speed * speed * spec.wingArea;
    if (qS <= 0) return -1;
    const cl = weight / qS;
    if (cl > spec.clMax) return -1;
    const drag = dragCoefficient(spec, cl, speed, gear) * qS;
    return thrustAt(spec, throttle, speed, density) - drag;
  };

  let high = 420;
  if (excess(high) > 0) return high;
  let low = high;
  for (let v = 420; v >= 5; v -= 1) {
    if (excess(v) > 0) {
      low = v;
      high = v + 1;
      break;
    }
  }
  if (low === 420) return 0;
  for (let i = 0; i < 40; i += 1) {
    const mid = (low + high) * 0.5;
    if (excess(mid) > 0) low = mid;
    else high = mid;
  }
  return (low + high) * 0.5;
}

/** Puts an aircraft into a trimmed cruise. Used by QA spawns and by the tests. */
export function applyTrim(
  state: FlightState,
  spec: AircraftSpec,
  trim: TrimSolution,
  gearDown = false,
): void {
  const cp = Math.cos(trim.pitch);
  state.pitch = trim.pitch;
  state.roll = 0;
  state.pitchRate = 0;
  state.rollRate = 0;
  state.yawRate = 0;
  // Velocity along the flight path, which in level flight is horizontal.
  state.vx = -Math.sin(state.yaw) * trim.speed;
  state.vz = -Math.cos(state.yaw) * trim.speed;
  state.vy = 0;
  state.throttle = trim.throttle;
  state.gear = spec.retractableGear && !gearDown ? 0 : 1;
  state.onGround = false;
  state.accumulator = 0;
  void cp;
}

// -- the integrator -----------------------------------------------------------

/**
 * Advances the aircraft by `dt`, in whole fixed sub-steps.
 *
 * Resets `events` first, then accumulates across the sub-steps, so a frame
 * that contains both a touchdown and a bounce reports the worse of the two.
 * Returns how many sub-steps ran, which the tests use to prove the step count
 * is a function of elapsed time and nothing else.
 */
export function advanceFlight(
  state: FlightState,
  controls: FlightControls,
  spec: AircraftSpec,
  world: FlightWorld,
  events: FlightEvents,
  dt: number,
): number {
  resetFlightEvents(events);
  state.accumulator = Math.min(state.accumulator + dt, FLIGHT_STEP * MAX_SUBSTEPS);
  let steps = 0;
  while (state.accumulator >= FLIGHT_STEP && steps < MAX_SUBSTEPS) {
    stepFlight(state, controls, spec, world, events, FLIGHT_STEP);
    state.accumulator -= FLIGHT_STEP;
    steps += 1;
  }
  return steps;
}

/**
 * One fixed integration step.
 *
 * Public so a test can drive the model a step at a time, and so `advanceFlight`
 * is nothing more than an accumulator around it. It ACCUMULATES into `events`
 * rather than resetting them; `advanceFlight` owns the reset.
 */
export function stepFlight(
  state: FlightState,
  controls: FlightControls,
  spec: AircraftSpec,
  world: FlightWorld,
  events: FlightEvents,
  dt: number = FLIGHT_STEP,
): void {
  const mass = spec.mass;
  const weight = mass * GRAVITY;

  // -- engine and undercarriage ---------------------------------------------
  if (state.crashed) {
    // A write-off keeps falling and keeps being stopped by the ground, but
    // nothing answers the controls. Killing the throttle here rather than at
    // the moment of the crash means a wreck cannot be flown by holding a key.
    state.throttle = 0;
  } else {
    const lever = clamp(controls.throttle, 0, 1);
    const spool = spec.spoolRate * dt;
    state.throttle += clamp(lever - state.throttle, -spool, spool);
    if (!spec.retractableGear) {
      state.gear = 1;
    } else if (spec.gearTransit > 0) {
      const travel = dt / spec.gearTransit;
      state.gear += clamp((controls.gearDown ? 1 : 0) - state.gear, -travel, travel);
    } else {
      state.gear = controls.gearDown ? 1 : 0;
    }
  }
  const elevator = state.crashed ? 0 : clamp(controls.elevator, -1, 1);
  const aileron = state.crashed ? 0 : clamp(controls.aileron, -1, 1);
  const rudder = state.crashed ? 0 : clamp(controls.rudder, -1, 1);
  // A wreck's brakes are on: it is not going to roll away down the taxiway.
  const brakes = state.crashed ? true : controls.brakes;

  // -- body axes -------------------------------------------------------------
  // Heading basis first (no pitch, no roll), then pitch about the heading's
  // right axis, then roll about the resulting forward axis. Written out rather
  // than composed from matrices because it is three trig pairs and no objects.
  const cy = Math.cos(state.yaw);
  const sy = Math.sin(state.yaw);
  const cp = Math.cos(state.pitch);
  const sp = Math.sin(state.pitch);
  const cr = Math.cos(state.roll);
  const sr = Math.sin(state.roll);

  // Heading forward and heading right, both horizontal.
  const hfx = -sy;
  const hfz = -cy;
  const hrx = cy;
  const hrz = -sy;

  // Forward, after pitch.
  const fx = hfx * cp;
  const fy = sp;
  const fz = hfz * cp;
  // Up, after pitch (still unrolled).
  const pux = -hfx * sp;
  const puy = cp;
  const puz = -hfz * sp;
  // Right and up, after roll. Positive roll drops the right wing.
  const rx = hrx * cr - pux * sr;
  const ry = -puy * sr;
  const rz = hrz * cr - puz * sr;
  const ux = pux * cr + hrx * sr;
  const uy = puy * cr;
  const uz = puz * cr + hrz * sr;

  // -- relative wind ---------------------------------------------------------
  const speed = Math.hypot(state.vx, state.vy, state.vz);
  const density = airDensity(state.y);
  const q = 0.5 * density * speed * speed;
  const qS = q * spec.wingArea;

  let alpha = 0;
  let beta = 0;
  let lift = 0;
  let drag = 0;
  let sideForce = 0;
  // Unit lift direction: perpendicular to the relative wind, in the plane the
  // wind and the aircraft's own up share. Doing it this way rather than "lift
  // acts along up" matters near the stall, where the two are 15 degrees apart.
  let lhx = ux;
  let lhy = uy;
  let lhz = uz;
  let vhx = 0;
  let vhy = 0;
  let vhz = 0;

  if (speed > AERO_FLOOR) {
    const inv = 1 / speed;
    vhx = state.vx * inv;
    vhy = state.vy * inv;
    vhz = state.vz * inv;
    const vf = state.vx * fx + state.vy * fy + state.vz * fz;
    const vu = state.vx * ux + state.vy * uy + state.vz * uz;
    const vr = state.vx * rx + state.vy * ry + state.vz * rz;
    alpha = Math.atan2(-vu, vf);
    beta = Math.atan2(vr, Math.hypot(vf, vu));

    const dot = ux * vhx + uy * vhy + uz * vhz;
    lhx = ux - vhx * dot;
    lhy = uy - vhy * dot;
    lhz = uz - vhz * dot;
    const norm = Math.hypot(lhx, lhy, lhz);
    if (norm > 1e-6) {
      const k = 1 / norm;
      lhx *= k;
      lhy *= k;
      lhz *= k;
    } else {
      lhx = ux;
      lhy = uy;
      lhz = uz;
    }

    const cl = state.crashed ? 0 : liftCoefficient(spec, alpha);
    lift = cl * qS;
    drag = dragCoefficient(spec, cl, speed, state.gear) * qS;
    sideForce = spec.cyBeta * beta * qS;
  }

  const thrust = state.crashed ? 0 : thrustAt(spec, state.throttle, speed, density);

  // -- forces ----------------------------------------------------------------
  let forceX = thrust * fx + lift * lhx - drag * vhx + sideForce * rx;
  let forceY = thrust * fy + lift * lhy - drag * vhy + sideForce * ry - weight;
  let forceZ = thrust * fz + lift * lhz - drag * vhz + sideForce * rz;

  // -- moments ---------------------------------------------------------------
  // Damping terms carry the standard non-dimensional rate, `c*q/(2V)` in pitch
  // and `b*p/(2V)` laterally. The 1 m/s floor on V keeps them finite at rest
  // without changing anything above walking pace.
  const invV = 1 / Math.max(speed, 1);
  const qSc = qS * spec.chord;
  const qSb = qS * spec.span;

  let pitchAccel =
    (spec.elevatorPower * elevator * qSc +
      spec.cmAlpha * (alpha - spec.alphaTrim) * qSc +
      spec.cmq * (spec.chord * state.pitchRate * 0.5 * invV) * qSc) /
    spec.inertiaPitch;

  let rollAccel =
    (spec.aileronPower * aileron * qSb +
      spec.clp * (spec.span * state.rollRate * 0.5 * invV) * qSb +
      spec.clBeta * beta * qSb) /
    spec.inertiaRoll;

  // Written nose-right-positive, then flipped once: `yawRate` is positive left.
  const noseRight =
    spec.rudderPower * rudder * qSb +
    spec.cnBeta * beta * qSb +
    spec.cnr * (spec.span * -state.yawRate * 0.5 * invV) * qSb;
  let yawAccel = -noseRight / spec.inertiaYaw;

  // -- ground reaction -------------------------------------------------------
  if (state.onGround) {
    // Whatever downward force is left after lift and thrust is carried by the
    // wheels. When the total goes upward the normal force is zero and the
    // aircraft is flying - no threshold, no flag.
    const normal = Math.max(0, -forceY);
    forceY += normal;
    const wheelLoad = clamp(normal / weight, 0, 1);

    // Rotation: weight on the wheels through the main-gear arm is nose-down.
    pitchAccel -= (normal * spec.mainGearArm) / spec.inertiaPitch;

    // The main wheels hold the wings level while they are carrying weight.
    rollAccel +=
      (-state.roll * GROUND_ROLL_STIFFNESS - state.rollRate * GROUND_ROLL_DAMPING) * wheelLoad;

    const horizontal = Math.hypot(state.vx, state.vz);
    if (horizontal > 1e-4) {
      const mu = brakes ? spec.brakeMu : spec.rollMu;
      // Capped so friction can arrest the aircraft but never reverse it inside
      // a single step, which is what turns a brake into a jitter.
      const decel = Math.min((mu * normal) / mass, horizontal / dt);
      forceX -= (state.vx / horizontal) * decel * mass;
      forceZ -= (state.vz / horizontal) * decel * mass;
    }

    // Sideways tyre grip: an aeroplane on wheels tracks its nose. Without this
    // a crosswind turn slides it off the taxiway sideways at full speed.
    const across = state.vx * hrx + state.vz * hrz;
    if (Math.abs(across) > 1e-5) {
      const grip = Math.min((spec.tyreSideMu * normal) / mass, Math.abs(across) / dt);
      const sign = across > 0 ? 1 : -1;
      forceX -= hrx * sign * grip * mass;
      forceZ -= hrz * sign * grip * mass;
    }

    // Nose-wheel steering, fading out as the rudder takes over. The target is
    // the kinematic bicycle rate the rest of this game already uses for cars.
    const fade = 1 - smoothstep(0, spec.steerFadeSpeed, horizontal);
    if (fade > 0.001) {
      const along = state.vx * hfx + state.vz * hfz;
      // Rudder right must turn the nose right, which is a negative yaw rate.
      const angle = -rudder * spec.maxSteerAngle;
      const target = (along * Math.tan(angle)) / spec.wheelBase;
      yawAccel += (target - state.yawRate) * spec.steerStiffness * fade * wheelLoad;
    }
  }

  // -- integrate -------------------------------------------------------------
  state.vx += (forceX / mass) * dt;
  state.vy += (forceY / mass) * dt;
  state.vz += (forceZ / mass) * dt;

  state.pitchRate += pitchAccel * dt;
  state.rollRate += rollAccel * dt;
  state.yawRate += yawAccel * dt;
  state.pitch += state.pitchRate * dt;
  state.roll += state.rollRate * dt;
  state.yaw += state.yawRate * dt;

  // Keep the attitude angles in a sane range. Pitch is clamped just short of
  // vertical: past it the yaw/pitch/roll parameterisation gimbal-locks, and an
  // aircraft that has been pulled past vertical in this game has already lost.
  state.pitch = clamp(state.pitch, -1.45, 1.45);
  if (state.roll > Math.PI) state.roll -= 2 * Math.PI;
  else if (state.roll < -Math.PI) state.roll += 2 * Math.PI;
  if (state.yaw > Math.PI) state.yaw -= 2 * Math.PI;
  else if (state.yaw < -Math.PI) state.yaw += 2 * Math.PI;

  movePosition(state, spec, world, events, dt);
  resolveGround(state, spec, world, events, dt);
}

/**
 * Moves the aircraft, refusing any part of the step that would end inside
 * something solid.
 *
 * Sub-stepped by DISTANCE, exactly as `Driving` does, because the solid test
 * only looks at the end of a displacement. On a refusal the three axes are
 * retried one at a time so that clipping a rooftop scrubs the vertical
 * component and lets the aircraft carry on, rather than stopping it dead in
 * mid-air.
 */
function movePosition(
  state: FlightState,
  spec: AircraftSpec,
  world: FlightWorld,
  events: FlightEvents,
  dt: number,
): void {
  const dx = state.vx * dt;
  const dy = state.vy * dt;
  const dz = state.vz * dt;
  const blocked = world.blocked;
  if (!blocked) {
    state.x += dx;
    state.y += dy;
    state.z += dz;
    return;
  }

  const distance = Math.hypot(dx, dy, dz);
  const steps = Math.max(1, Math.ceil(distance / MAX_COLLISION_STEP));
  const sx = dx / steps;
  const sy = dy / steps;
  const sz = dz / steps;

  for (let i = 0; i < steps; i += 1) {
    const nx = state.x + sx;
    const ny = state.y + sy;
    const nz = state.z + sz;
    if (!isBlocked(blocked, spec, nx, ny, nz, state.yaw)) {
      state.x = nx;
      state.y = ny;
      state.z = nz;
      continue;
    }

    // Every refusal is reported, however gentle. See `FlightEvents.blocked`.
    events.blocked = true;
    let refusedSq = 0;
    if (!isBlocked(blocked, spec, nx, state.y, state.z, state.yaw)) {
      state.x = nx;
    } else {
      refusedSq += state.vx * state.vx;
      state.vx = 0;
    }
    if (!isBlocked(blocked, spec, state.x, state.y, nz, state.yaw)) {
      state.z = nz;
    } else {
      refusedSq += state.vz * state.vz;
      state.vz = 0;
    }
    if (!isBlocked(blocked, spec, state.x, ny, state.z, state.yaw)) {
      state.y = ny;
    } else {
      refusedSq += state.vy * state.vy;
      state.vy = 0;
    }

    const closing = Math.sqrt(refusedSq);
    if (closing > 0.2) reportImpact(state, spec, events, closing);
    // Nothing further this step: the remaining sub-steps push into the same
    // thing, and re-testing them costs without changing the answer.
    break;
  }
}

function isBlocked(
  blocked: NonNullable<FlightWorld['blocked']>,
  spec: AircraftSpec,
  x: number,
  y: number,
  z: number,
  yaw: number,
): boolean {
  const bottom = y - spec.gearHeight;
  return blocked(x, z, yaw, spec.halfLength, spec.halfWidth, bottom, bottom + spec.height);
}

function reportImpact(
  state: FlightState,
  spec: AircraftSpec,
  events: FlightEvents,
  closing: number,
): void {
  events.impact = true;
  if (closing > events.impactSpeed) events.impactSpeed = closing;
  if (closing >= spec.impactCrashSpeed && !state.crashed) {
    state.crashed = true;
    events.crashed = true;
  }
}

/**
 * Settles the aircraft onto whatever is under it, and decides what that was.
 *
 * Three outcomes share one height comparison and are told apart on purpose:
 *
 *   - a TOUCHDOWN, which is the wheels meeting ground that is roughly level
 *     with them. Reported with its descent rate so audio can pick a squeak or
 *     a bang and so a heavy arrival can break the gear;
 *   - a TERRAIN STRIKE, which is ground that is well above the wheels a third
 *     of a second ahead - flying into a hillside. Without this test the two
 *     are indistinguishable and an aircraft flown into a hill simply rides up
 *     it, which is the "landing that never registers" failure;
 *   - a GEAR-UP arrival, which is always damage.
 */
function resolveGround(
  state: FlightState,
  spec: AircraftSpec,
  world: FlightWorld,
  events: FlightEvents,
  dt: number,
): void {
  const groundY = world.groundY(state.x, state.z);
  const wheelY = state.y - spec.gearHeight;
  const gap = wheelY - groundY;

  /*
   * Contact is broken by CLIMBING, not by clearing a fixed height.
   *
   * Testing `gap > epsilon` alone was a real bug and an instructive one: one
   * fixed step at the moment of lift-off raises the wheels by `vy / 120`,
   * which is 2 mm at a metre a second, so the aircraft never cleared a 20 mm
   * epsilon in a single step. It was re-pinned to the runway every step while
   * its vertical velocity climbed to 2.4 m/s, and only left the ground when
   * the lift had built far past what was needed - a Cessna rolling 396 m and
   * flying at 1.30 Vs instead of 230 m at 1.10 Vs.
   *
   * While the wheels are down the ground reaction has already clamped the net
   * vertical force to zero or better, so `vy > 0` means one thing only: the
   * wing is now carrying more than the weight. That IS lift-off.
   */
  if (gap > CONTACT_EPSILON || (gap >= 0 && state.vy > 0)) {
    if (state.onGround) {
      state.onGround = false;
      events.liftoff = true;
    }
    return;
  }

  const descent = -state.vy;
  const wasAirborne = !state.onGround;

  if (wasAirborne && descent > TOUCHDOWN_FLOOR) {
    // Rising ground ahead means this is not a runway.
    const aheadX = state.x + state.vx * TERRAIN_PROBE_SECONDS;
    const aheadZ = state.z + state.vz * TERRAIN_PROBE_SECONDS;
    const ahead = world.groundY(aheadX, aheadZ);
    if (ahead > wheelY + TERRAIN_STRIKE_RISE) {
      reportImpact(state, spec, events, Math.hypot(state.vx, state.vy, state.vz));
    } else {
      events.touchdown = true;
      if (descent > events.touchdownVs) events.touchdownVs = descent;
      const gearUp = spec.retractableGear && state.gear < 0.9;
      if (gearUp) {
        // A belly arrival is damage at any rate worth the name, and a
        // write-off above 2 m/s. The airframe slides; it does not bounce.
        events.touchdownHard = true;
        reportImpact(state, spec, events, Math.max(descent, 2.5));
        if (descent > 2 && !state.crashed) {
          state.crashed = true;
          events.crashed = true;
        }
      } else if (descent > spec.crashVs) {
        events.touchdownHard = true;
        reportImpact(state, spec, events, descent);
        if (!state.crashed) {
          state.crashed = true;
          events.crashed = true;
        }
      } else if (descent > spec.gearLimitVs) {
        events.touchdownHard = true;
      }
    }
  }

  // Pin the wheels to the surface. This is also what makes "sinking under the
  // runway" impossible: the comparison runs after every integration, and the
  // only way past it would be a step that both starts and ends above ground,
  // which the sub-stepping in `movePosition` already rules out.
  state.y = groundY + spec.gearHeight;
  if (state.vy < 0) state.vy = 0;
  state.onGround = true;

  // Attitude limits imposed by having three wheels on the ground.
  const lowPitch = spec.groundPitch;
  const highPitch = spec.groundPitch + spec.maxRotation;
  if (state.pitch < lowPitch) {
    state.pitch = lowPitch;
    if (state.pitchRate < 0) state.pitchRate = 0;
  } else if (state.pitch > highPitch) {
    state.pitch = highPitch;
    if (state.pitchRate > 0) state.pitchRate = 0;
  }
  if (state.roll > GROUND_ROLL_LIMIT) {
    state.roll = GROUND_ROLL_LIMIT;
    if (state.rollRate > 0) state.rollRate = 0;
  } else if (state.roll < -GROUND_ROLL_LIMIT) {
    state.roll = -GROUND_ROLL_LIMIT;
    if (state.rollRate < 0) state.rollRate = 0;
  }
  void dt;
}
