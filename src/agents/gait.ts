/**
 * The walk cycle, as arithmetic.
 *
 * This module is the single source of truth for the relationship between how
 * fast a pedestrian is moving and how their legs are arranged. It has three
 * consumers and they must all agree, which is the whole reason it exists
 * separately:
 *
 *   - `crowd.ts` advances the cycle phase (no Three.js, unit tested),
 *   - `PedestrianSystem.ts` turns speed into a hip amplitude per instance,
 *   - `PedestrianRig.ts` pastes these constants into its GLSL, and its
 *     `mbHip()` is a line-for-line mirror of `hipAngle()` below.
 *
 * IF YOU CHANGE `hipAngle`, CHANGE `mbHip` IN `PedestrianRig.ts` TO MATCH.
 * `tests/pedestrians.test.ts` asserts the no-slide property that both rely on,
 * so a drift between them shows up as a failing test rather than as a crowd
 * that skates down the pavement.
 *
 * THE NO-SLIDE CONDITION. While a foot is planted its world position must not
 * change, so the foot's offset from the body has to shrink at exactly the rate
 * the body advances. The foot's forward offset is `R * H * sin(hip)`, so
 * holding it linear in time means the hip angle is an inverse sine, and the
 * amplitude is fixed by the distance covered in one stance phase:
 *
 *     sin(amp) = speed * DUTY / (2 * R * H * cadence)
 *
 * When that would ask for a hip angle no one has, the answer is not to accept
 * the slide: it is to take quicker steps. `gaitCadence` raises the cadence
 * until the amplitude fits, which is what a person speeding up actually does.
 */

import { clamp } from '../core/mathx';

/** Fraction of the cycle a foot is on the ground. Real walking is 0.60-0.62. */
export const GAIT_DUTY = 0.62;

/**
 * Distance from the hip axis to the foot's ground contact, in rig units where
 * the whole body is 1.0 tall. Between the ankle (0.465) and the sole (0.514)
 * because the contact point rolls from heel to toe through stance.
 */
export const GAIT_STRIDE_RADIUS = 0.5;

/** Largest hip angle we ask for: about 35 degrees, a long but human stride. */
export const GAIT_MAX_SWING = 0.62;

const SIN_MAX = Math.sin(GAIT_MAX_SWING);

/**
 * Gait cycles per second for a pedestrian at this speed.
 *
 * Cadence rises with the square root of the speed ratio, which is roughly how
 * people trade step length against step rate, and then rises further if the
 * stride would otherwise be impossible.
 */
export function gaitCadence(
  speed: number,
  preferredSpeed: number,
  baseCadence: number,
  height: number,
): number {
  const ratio = speed / Math.max(0.3, preferredSpeed);
  let cadence = baseCadence * clamp(0.55 + 0.55 * Math.sqrt(Math.max(0, ratio)), 0.35, 1.9);
  const needed = requiredSine(speed, cadence, height);
  if (needed > SIN_MAX) cadence *= needed / SIN_MAX;
  return cadence;
}

function requiredSine(speed: number, cadence: number, height: number): number {
  const reach = GAIT_STRIDE_RADIUS * Math.max(0.5, height);
  return (Math.max(0, speed) * GAIT_DUTY) / (2 * reach * Math.max(0.2, cadence));
}

/** Hip swing amplitude, in radians, that plants the foot at this speed. */
export function hipAmplitude(speed: number, cadence: number, height: number): number {
  return Math.asin(Math.min(requiredSine(speed, cadence, height), SIN_MAX));
}

/**
 * Hip angle at cycle position `u` in [0, 1). Positive swings the foot forward.
 * MIRRORED BY `mbHip()` in `PedestrianRig.ts`; keep the two identical.
 */
export function hipAngle(u: number, amp: number): number {
  const r = Math.sin(amp);
  if (u < GAIT_DUTY) {
    return Math.asin(clamp(r * (1 - (2 * u) / GAIT_DUTY), -0.9995, 0.9995));
  }
  const s = (u - GAIT_DUTY) / (1 - GAIT_DUTY);
  const eased = s * s * (3 - 2 * s);
  return -amp + 2 * amp * eased;
}

/** Forward offset of the foot from the body centre, in metres. */
export function footOffset(u: number, amp: number, height: number): number {
  return GAIT_STRIDE_RADIUS * height * Math.sin(hipAngle(u, amp));
}

/**
 * Worst-case ground slip of a planted foot over one stance phase, in metres.
 * Zero whenever the amplitude was derived from this speed and cadence.
 */
export function stanceSlip(speed: number, cadence: number, height: number, samples = 64): number {
  const amp = hipAmplitude(speed, cadence, height);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i <= samples; i += 1) {
    const u = (i / samples) * GAIT_DUTY;
    // World position of the planted foot: the body has advanced u/cadence
    // seconds' worth of travel, and the foot is offset from the body by this.
    const world = (speed * u) / cadence + footOffset(u, amp, height);
    if (world < min) min = world;
    if (world > max) max = world;
  }
  return max - min;
}
