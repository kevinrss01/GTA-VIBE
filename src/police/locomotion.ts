/**
 * How an officer on foot moves, and what they are trying to do.
 *
 * Two things live here, both pure arithmetic with no Three.js and no world:
 * the KINEMATICS that turn a wish into a bounded change of velocity, and the
 * BEHAVIOUR state machine that decides what the wish is. `PoliceSystem` owns
 * the bodies, the collision and the shooting; this module owns the rules, so
 * every one of them can be asserted in a unit test instead of watched.
 *
 * WHY IT EXISTS. The officers used to have no kinematics at all: their speed
 * was `wantsToMove ? OFFICER_RUN_SPEED : 0` and their heading was the exact
 * bearing to the player, recomputed every frame. Both are step functions, and
 * a step function in velocity is precisely the thing an animation cannot
 * follow - the body translates, the legs do not, and the officer slides. The
 * fix is not a better walk cycle; it is a velocity that a walk cycle CAN
 * follow, which means bounded acceleration and a bounded turn rate.
 *
 * THE INVARIANT THE WHOLE THING RESTS ON. An officer's displacement in one
 * frame is `speed * dt` along their CURRENT heading, and `speed` may change by
 * at most `accel * dt`. Nothing here may ever write a position directly. That
 * is what makes "no teleport, no implausible speed" a property that can be
 * proved from the outside rather than a claim: see `tests/policeOfficers.test.ts`.
 */

import { clamp } from '../core/mathx';

/**
 * What an officer on foot is doing, as a named state.
 *
 * Deliberately explicit rather than derived from distances at the point of
 * use. The old code recomputed "am I close enough" three separate times per
 * frame from three slightly different expressions, which is why an officer
 * could be shooting and trying to cuff you in the same instant.
 */
export type OfficerBehaviour =
  /** On their feet with nothing to chase. */
  | 'idle'
  /** Has just acquired the suspect: stops, turns to face, registers them. */
  | 'notice'
  /** The sidearm is coming out of the holster. */
  | 'draw'
  /** Closing the distance, running or walking as the range demands. */
  | 'pursue'
  /** Inside the last few metres: walking in, under control. */
  | 'close'
  /** At the standoff distance, stopped, facing the suspect. */
  | 'hold'
  /** Weapon up and tracking, waiting out the aim time. */
  | 'aim'
  /** A round is leaving the weapon this frame. */
  | 'fire'
  /** Magazine change. Weapon comes down; they do not shoot and do not close. */
  | 'reload'
  /** Taking an angle around something solid instead of pressing into it. */
  | 'reposition'
  /** Staggered by a round. */
  | 'hit';

/** Everything the transition function is allowed to look at. */
export interface OfficerSense {
  readonly state: OfficerBehaviour;
  /** Seconds spent in `state` so far. */
  readonly elapsed: number;
  /** Metres to the suspect. */
  readonly distance: number;
  /** Distance this officer means to stop at. */
  readonly standoff: number;
  readonly seesPlayer: boolean;
  /** Seconds since this officer last had eyes on the suspect. */
  readonly unseen: number;
  /** This officer will use their weapon rather than their cuffs. */
  readonly armedIntent: boolean;
  /** The sidearm is already in their hand. */
  readonly armed: boolean;
  /** The firing stance is fully raised. */
  readonly settled: boolean;
  /** Seconds of holding the suspect in view that the policy demands. */
  readonly aimTime: number;
  /** Rounds left in the magazine. */
  readonly rounds: number;
  /** The shot interval has elapsed. */
  readonly shotReady: boolean;
  /** Facing close enough to the suspect for the weapon to point at them. */
  readonly onTarget: boolean;
  /** Inside the weapon's useful range, with a clear line to the suspect. */
  readonly canShoot: boolean;
  /** Took damage since the last tick. */
  readonly hurt: boolean;
  /** Pressing into something solid instead of making ground. */
  readonly blocked: boolean;
}

/** Seconds an officer stays in `fire`. One state per round, not per burst. */
const FIRE_TIME = 0.08;

/** The timings and distances the transition table is parameterised on. */
export interface OfficerTuning {
  readonly notice: number;
  readonly draw: number;
  readonly reload: number;
  readonly recover: number;
  readonly reposition: number;
  readonly losePatience: number;
  /** Extra distance beyond the standoff at which a run becomes a walk. */
  readonly closeMargin: number;
}

/**
 * The next behaviour, as a total function of the current one and the world.
 *
 * Deterministic: no clock, no RNG, no hidden state. Every transition in the
 * chase - notice, draw, pursue, close, hold, aim, fire, reload - is one line
 * that a test can drive directly.
 */
export function nextBehaviour(s: OfficerSense, tuning: OfficerTuning): OfficerBehaviour {
  // A round landing interrupts anything. Re-entering `hit` from `hit` is
  // deliberate: the caller resets `elapsed` on a state change, so a second
  // round extends the stagger rather than being swallowed by the first.
  if (s.hurt) return 'hit';

  switch (s.state) {
    case 'hit':
      if (s.elapsed < tuning.recover) return 'hit';
      return s.seesPlayer ? 'notice' : 'idle';

    case 'idle':
      return s.seesPlayer ? 'notice' : 'idle';

    case 'notice':
      if (s.elapsed < tuning.notice) return 'notice';
      if (s.armedIntent && !s.armed) return 'draw';
      return 'pursue';

    case 'draw':
      return s.elapsed < tuning.draw ? 'draw' : 'pursue';

    // The three chase states share one rule ahead of their own: a weapon that
    // is now needed and is still holstered comes out FIRST. Without this an
    // officer who set out to make an arrest and was then shot at could never
    // draw - the draw only ever followed `notice` - and would close on an
    // armed suspect for the rest of the chase with empty hands.
    case 'pursue':
      if (s.unseen > tuning.losePatience) return 'idle';
      if (s.armedIntent && !s.armed) return 'draw';
      if (s.blocked) return 'reposition';
      if (s.distance <= s.standoff) return 'hold';
      if (s.distance <= closeRange(s.standoff, tuning.closeMargin)) return 'close';
      return 'pursue';

    case 'close':
      if (s.unseen > tuning.losePatience) return 'idle';
      if (s.armedIntent && !s.armed) return 'draw';
      if (s.blocked) return 'reposition';
      if (s.distance <= s.standoff) return 'hold';
      // Hysteresis: it takes more to fall back to a run than it took to drop
      // out of one, so an officer holding station at the edge does not flick
      // between a walk and a run every other frame.
      if (s.distance > closeRange(s.standoff, tuning.closeMargin) * 1.25) return 'pursue';
      return 'close';

    case 'hold':
      if (s.unseen > tuning.losePatience) return 'idle';
      if (s.armedIntent && !s.armed) return 'draw';
      if (s.armed && s.canShoot && s.onTarget) return 'aim';
      if (s.distance > s.standoff * 1.25) return 'close';
      return 'hold';

    case 'aim':
      if (s.rounds <= 0) return 'reload';
      if (!s.canShoot) return 'hold';
      // A suspect who is walking away is followed between shots rather than
      // shot at from an ever-increasing range. The threshold is well outside
      // the one that brought the officer to a stop, so the two cannot fight.
      if (s.distance > s.standoff * 1.6) return 'close';
      if (s.elapsed >= s.aimTime && s.settled && s.shotReady && s.onTarget) return 'fire';
      return 'aim';

    case 'fire':
      if (s.elapsed < FIRE_TIME) return 'fire';
      return s.rounds <= 0 ? 'reload' : 'aim';

    case 'reload':
      if (s.elapsed < tuning.reload) return 'reload';
      return s.seesPlayer ? 'hold' : 'idle';

    case 'reposition':
      if (s.unseen > tuning.losePatience) return 'idle';
      if (s.elapsed >= tuning.reposition || !s.blocked) return 'pursue';
      return 'reposition';
  }
}

/** Where `pursue` hands over to `close`: the standoff plus a braking margin. */
export function closeRange(standoff: number, margin = 4): number {
  return standoff + margin;
}

/** True while the officer is meant to be putting one foot in front of another. */
export function isTravelling(state: OfficerBehaviour): boolean {
  return state === 'pursue' || state === 'close' || state === 'reposition';
}

/**
 * Speed an officer in this state is asking for, m/s.
 *
 * The only state that runs is `pursue`, and only while the ground it has to
 * make is worth running for. Everything else walks or stands. This is the
 * whole of "an officer at standoff distance walks, turns, stops and aims
 * naturally rather than continuously homing in".
 */
export function desiredSpeed(
  state: OfficerBehaviour,
  distance: number,
  standoff: number,
  running: boolean,
  speeds: { readonly walk: number; readonly run: number },
): number {
  if (state === 'reposition') return speeds.walk;
  if (state === 'close') {
    // Ease into the standoff instead of stopping dead on it. The taper is
    // linear in the remaining ground, floored so the last half metre is still
    // covered at a believable shuffle rather than asymptotically.
    const left = Math.max(0, distance - standoff);
    return clamp(speeds.walk * (left / 1.5), speeds.walk * 0.25, speeds.walk);
  }
  if (state !== 'pursue') return 0;
  return running ? speeds.run : speeds.walk;
}

/**
 * Whether an officer breaks into a run, with hysteresis on the boundary.
 *
 * `running` is the answer from last frame. Crossing OUT of a run needs the
 * suspect to be properly inside the walk band, so an officer holding at the
 * threshold does not alternate gaits.
 */
export function shouldRun(
  distance: number,
  playerSpeed: number,
  running: boolean,
  runRange: number,
  hysteresis: number,
  walkSpeed: number,
): boolean {
  // A suspect who is actually running away is chased at a run whatever the
  // range: that is the one case where sprinting at somebody is what a person
  // would do. Standing still at ten metres is not.
  if (playerSpeed > walkSpeed * 1.6 && distance > runRange * 0.4) return true;
  return running ? distance > runRange - hysteresis : distance > runRange;
}

/**
 * One step of speed toward a target, bounded by acceleration and braking.
 *
 * Never returns a speed above `Math.max(current, desired)`, which with a
 * desired speed capped at the run speed is what makes the ceiling provable.
 */
export function approachSpeed(
  current: number,
  desired: number,
  accel: number,
  brake: number,
  dt: number,
): number {
  const gap = desired - current;
  if (gap === 0) return current;
  const limit = (gap > 0 ? accel : brake) * dt;
  return current + clamp(gap, -limit, limit);
}

/** Signed shortest angle from `from` to `to`, in (-PI, PI]. */
export function shortestTurn(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta <= -Math.PI) delta += Math.PI * 2;
  return delta;
}

/** One step of heading toward a target, bounded by the turn rate. */
export function turnToward(heading: number, desired: number, rate: number, dt: number): number {
  const delta = shortestTurn(heading, desired);
  const limit = rate * dt;
  return heading + clamp(delta, -limit, limit);
}

/**
 * The game's heading convention: forward is `(-sin yaw, -cos yaw)`.
 *
 * Duplicated from `pursuit.headingTo` rather than imported so this module has
 * no reason to reach into the driving code; both are asserted against the same
 * convention in the tests.
 */
export function headingOf(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** The angles tried either side of the wanted one, in radians. */
const WHISKERS: readonly number[] = [0, 0.42, -0.42, 0.9, -0.9, 1.45, -1.45];

export interface Avoidance {
  /** Unit direction to actually walk in. */
  readonly x: number;
  readonly z: number;
  /**
   * Angle this deflection sits at, relative to the direction asked for.
   *
   * Returned so a caller can hold the DEFLECTION rather than the direction
   * between re-evaluations: the direct line rotates as the officer moves, and
   * a stored world direction would be stale within a metre.
   */
  readonly turn: number;
  /** True when nothing within the whisker fan was clear. */
  readonly blocked: boolean;
  /** True when the direct line was refused and a whisker was taken instead. */
  readonly deflected: boolean;
}

/**
 * Steers around whatever is in the way by trying angles either side.
 *
 * A fan of whiskers cast against the collision world, taking the clear one
 * nearest the direction we actually want. This is NOT a navigation graph and
 * is not trying to be: four people getting round a building corner do not
 * justify a second search structure over the city, and the flow field the cars
 * use is a lane graph that pavements are not on. A whisker fan gets round a
 * corner because the corner stops refusing the wider angles as soon as the
 * officer has walked past it.
 *
 * `clear(x, z)` is asked whether a unit step in that direction is free; the
 * caller supplies it so this stays testable without a world. `bias` breaks the
 * tie between two equally good sides, so an officer commits to one way round
 * instead of oscillating in the mouth of a doorway.
 */
export function steerAround(
  dirX: number,
  dirZ: number,
  bias: 1 | -1,
  clear: (x: number, z: number) => boolean,
): Avoidance {
  if (clear(dirX, dirZ)) {
    return { x: dirX, z: dirZ, turn: 0, blocked: false, deflected: false };
  }
  for (const angle of WHISKERS) {
    if (angle === 0) continue;
    // The biased side is tried first at each magnitude, which is what makes
    // the choice stable frame to frame.
    const swept = angle * bias;
    const x = rotateX(dirX, dirZ, swept);
    const z = rotateZ(dirX, dirZ, swept);
    if (clear(x, z)) return { x, z, turn: swept, blocked: false, deflected: true };
  }
  return { x: dirX, z: dirZ, turn: 0, blocked: true, deflected: false };
}

/** The X component of `(x, z)` rotated by `angle` in the XZ plane. */
export function rotateX(x: number, z: number, angle: number): number {
  return x * Math.cos(angle) - z * Math.sin(angle);
}

/** The Z component of `(x, z)` rotated by `angle` in the XZ plane. */
export function rotateZ(x: number, z: number, angle: number): number {
  return x * Math.sin(angle) + z * Math.cos(angle);
}

/** Which locomotion clip a body moving at this speed should be drawn with. */
export type OfficerStance = 'idle' | 'walk' | 'run';

/**
 * Picks the clip from the MEASURED speed, with hysteresis on both boundaries.
 *
 * Bands rather than thresholds: an officer decelerating through 1.5 m/s must
 * not flicker between the walk and run clips for the half second it takes to
 * cross. The exit speed is always below the entry speed for the same band.
 */
export function stanceFor(speed: number, previous: OfficerStance, runSpeed: number): OfficerStance {
  const runEnter = runSpeed * 0.62;
  const runExit = runSpeed * 0.48;
  const walkEnter = 0.28;
  const walkExit = 0.16;
  if (previous === 'run') return speed > runExit ? 'run' : speed > walkExit ? 'walk' : 'idle';
  if (speed > runEnter) return 'run';
  if (previous === 'walk') return speed > walkExit ? 'walk' : 'idle';
  return speed > walkEnter ? 'walk' : 'idle';
}
