/**
 * Flight assist: what the player asks for, turned into control surfaces.
 *
 * ## Why this exists
 *
 * The direct controls are a stick. `W` pitches the nose DOWN, turning means
 * banking with `A`/`D` and then holding back-pressure to stop the nose
 * dropping out of the turn, and the throttle is a separate axis on `Shift`.
 * Every one of those is correct and every one of them is a reason somebody
 * gets into an aeroplane, presses `Up`, watches the nose drop, and never
 * gets airborne. `ArrowUp` diving is the single worst of them.
 *
 * The assist is a fly-by-wire layer, not a cheat. It does not move the
 * aeroplane, does not scale its mass and does not touch the model: it decides
 * what a competent pilot would be doing with the stick and the pedals to
 * achieve what the player asked for, writes that into the SAME
 * `FlightControls` the direct mode writes, and lets `advanceFlight` fly it.
 * Everything downstream - lift, drag, stall, ground reaction, the whole of
 * `flight.ts` - is untouched and still in charge.
 *
 * ## What it does
 *
 * - **Up climbs and Down descends**, which is the thing the sim convention got
 *   backwards for a keyboard.
 * - **Left and Right turn**, rather than roll. The assist banks the aeroplane and
 *   holds the height through the turn, which is the back-pressure a pilot
 *   supplies from the elbow. It adds no rudder in the air, which is measured
 *   rather than assumed - see the note above the constants.
 * - **Wings level themselves** when nothing is asked of them, so letting go
 *   recovers rather than continuing whatever roll was left over.
 * - **The wing will not be stalled.** Commanded pitch is limited by the
 *   measured angle of attack, so holding `Up` at low speed mushes instead of
 *   departing. This is the difference between an aeroplane a beginner can fly
 *   and one that spins in on the first turn.
 * - **On the ground it steers**, because banking a parked aeroplane does
 *   nothing and the player pressing Left expects to go left.
 *
 * Gains are proportional with a rate term, which is enough for an aeroplane
 * that is already dynamically stable and avoids an integrator that would need
 * anti-windup on every state change.
 */

import { clamp } from '../core/mathx';
import type { AircraftSpec } from './AircraftCatalogue';
import { angleOfAttack, groundSpeed, type FlightControls, type FlightState } from './flight';

/** What the player asked for, before it is any particular control surface. */
export interface AssistDemand {
  /** -1 descend .. +1 climb. */
  readonly climb: number;
  /** -1 left .. +1 right. */
  readonly turn: number;
  readonly throttle: number;
  readonly brakes: boolean;
  readonly gearDown: boolean;
}

/**
 * Steepest bank the assist will roll into, radians. 45 degrees.
 *
 * The turn rate is `g * tan(bank) / V`, so the bank angle IS the turn rate and
 * this is the honest place to make turning feel quick: 45 degrees roughly
 * doubles the rate against 35 and still only asks 1.4 g of the wing, which is
 * nowhere near its limit. Steeper than this and the load factor climbs fast
 * enough that the stall limiter starts fighting the player's own turn.
 */
const MAX_BANK = 0.785;
/** Climb and descent rate a full deflection asks for, m/s. */
const CLIMB_RATE = 9;
/** How hard the assist chases its target bank, and how much it damps. */
const BANK_GAIN = 2.6;
const BANK_DAMPING = 0.7;
/**
 * Elevator per m/s of vertical-speed error, and the pitch-rate damping on it.
 *
 * The assist holds a VERTICAL SPEED rather than an attitude. Holding an
 * attitude looks right and flies wrong: a banked wing lifts less vertically, so
 * a turn at a fixed pitch descends, and measured it lost 30 m in ten seconds -
 * a beginner turning towards the airport arrives below it. Closing the loop on
 * vertical speed makes the same turn hold its height, and makes "no key
 * pressed" mean level flight rather than whatever attitude was left behind.
 */
const VS_GAIN = 0.13;
const PITCH_DAMPING = 0.9;
/*
 * THE ASSIST USES NO RUDDER IN THE AIR, and that is a measured result rather
 * than an omission.
 *
 * Two coordination schemes were tried against the real model. A loop closed on
 * turn rate diverged at every gain from 0.6 to 3.2 - this airframe has enough
 * roll-yaw coupling that a rudder strong enough to drive the heading also rolls
 * it, so it fought the aileron loop: 109 degrees of bank and 240 m of height
 * lost in ten seconds. A static term proportional to bank was stable but made
 * the turn WORSE, monotonically, at every value tried:
 *
 *   rudder per rad of bank   0.0     0.1     0.25    0.35    0.5     1.0
 *   heading change in 10 s   1.43    1.20    0.92    0.76    0.55    0.18 rad
 *   bank held                0.77    0.74    0.70    0.68    0.65    0.61 rad
 *
 * `flight.ts` already has directional stability (`cnBeta`), so the nose
 * weathercocks into the turn on its own. Any rudder on top of that is inducing
 * sideslip, which drags and turns less. Zero rudder holds the commanded 45
 * degrees and turns at 8.2 degrees a second - the rate `g * tan(bank) / V`
 * predicts. The rudder is therefore reserved for steering on the ground.
 */
/**
 * Fraction of the stall angle the assist will let the wing reach.
 *
 * 0.82 keeps a margin for gusts, for the extra angle a turn demands, and for
 * the fact that the player is holding the key down and expecting to climb.
 */
const ALPHA_LIMIT = 0.82;
/** Below this ground speed the wheels steer instead of the wings banking. */
const STEER_SPEED = 22;

/**
 * Writes the assisted control surfaces into `controls` and returns it.
 *
 * `controls` is the caller's own reused object, so an assisted frame allocates
 * nothing, exactly like the direct path.
 */
export function applyFlightAssist(
  state: FlightState,
  spec: AircraftSpec,
  demand: AssistDemand,
  controls: FlightControls,
  dt: number,
): FlightControls {
  controls.throttle = clamp(demand.throttle, 0, 1);
  controls.brakes = demand.brakes;
  controls.gearDown = demand.gearDown;

  const climb = clamp(demand.climb, -1, 1);
  const turn = clamp(demand.turn, -1, 1);
  const speed = groundSpeed(state);

  /*
   * ON THE GROUND, TURN MEANS STEER.
   *
   * Below `STEER_SPEED` the wings are not carrying anything and rolling does
   * nothing a player can see, so the turn demand goes to the rudder, which is
   * also what drives the nose wheel. Blended rather than switched, so there is
   * no moment on the take-off roll where the controls change meaning under the
   * player's hands.
   */
  const onWheels = state.onGround ? 1 - clamp(speed / STEER_SPEED, 0, 1) : 0;

  // -- roll ------------------------------------------------------------------
  // Target bank is what the turn demand asks for, and zero when it asks for
  // nothing - which is what makes the wings level themselves.
  const targetBank = turn * MAX_BANK * (1 - onWheels);
  const bankError = targetBank - state.roll;
  controls.aileron = clamp(bankError * BANK_GAIN - state.rollRate * BANK_DAMPING, -1, 1);

  // -- yaw -------------------------------------------------------------------
  /*
   * `yawRate` and the rudder are positive to the LEFT (see `flight.ts`), so a
   * right turn on the ground is a negative rudder. In the air this is zero;
   * see the note above the constants for the measurements behind that.
   */
  const steering = -turn * onWheels;
  controls.rudder = clamp(steering, -1, 1);

  // -- pitch -----------------------------------------------------------------
  /*
   * Closed on VERTICAL SPEED, not on attitude. No key means hold this height;
   * a key means climb or descend at `CLIMB_RATE`. A turn's sink shows up as a
   * negative vertical speed and is answered by the same loop, which is what
   * stops the nose falling through the turn without any special case for it.
   *
   * Then the angle of attack limits the whole thing. Without that, holding `Up`
   * at low speed is a stall - which is exactly the situation a player who
   * cannot yet fly will put themselves in.
   */
  const targetVs = climb * CLIMB_RATE;
  let elevator = (targetVs - state.vy) * VS_GAIN - state.pitchRate * PITCH_DAMPING;

  const alpha = angleOfAttack(state);
  const alphaCeiling = spec.alphaStall * ALPHA_LIMIT;
  if (alpha > alphaCeiling) {
    // Past the limit: command the nose down in proportion to the overshoot, so
    // the wing unloads however hard the player is pulling.
    elevator = Math.min(elevator, -(alpha - alphaCeiling) * 12);
  }
  controls.elevator = clamp(elevator, -1, 1);

  /*
   * ROTATION. On the take-off roll the elevator above is chasing an attitude
   * the aeroplane cannot have yet, because the wheels are holding it level.
   * Feeding the raw climb demand through as well is what actually lifts the
   * nose at rotation speed, and it costs nothing once airborne because
   * `onWheels` has already faded out.
   */
  if (onWheels > 0 && climb > 0) {
    controls.elevator = clamp(controls.elevator + climb * onWheels, -1, 1);
  }

  void dt;
  return controls;
}
