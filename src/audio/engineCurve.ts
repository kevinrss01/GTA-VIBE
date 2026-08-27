/**
 * How a car's speed and throttle become an engine note.
 *
 * This module is pure arithmetic. It imports nothing, touches no Web Audio and
 * allocates one small object per call, which means the whole feel of the engine
 * - the thing the player actually complains about - can be asserted in a unit
 * test rather than judged by ear in a browser.
 *
 * ## Why a gearbox
 *
 * Mapping playback rate straight to road speed is the obvious implementation
 * and it is the reason most hobby car audio sounds like a tape being spooled:
 * pitch rises monotonically forever and nothing ever happens. A real engine
 * sweeps its rev range, drops, and sweeps again. `GEAR_TOPS` gives the model
 * four gears, so accelerating from rest produces four rises and three drops,
 * and that pattern is most of what makes acceleration audible as acceleration.
 *
 * ## Why two layers
 *
 * One sample pitched across the whole range thins out at the top and turns to
 * mud at the bottom. The shipped assets are deliberately different: measured,
 * `veh/engine-idle` puts 86 per cent of its energy below 200 Hz and
 * `veh/engine-load` puts 72 per cent between 200 Hz and 1.5 kHz. Crossfading
 * the dark one out and the bright one in as the revs rise is what makes the
 * engine gain character under load instead of merely gaining pitch.
 *
 * ## Why load, not throttle
 *
 * The driving layer does not publish its throttle input, and it should not have
 * to: `load` here is normalised acceleration, which the caller can always
 * derive from two speed samples. It is also the more honest signal - a car
 * labouring up a hill at constant throttle is under load, and a car coasting
 * downhill on the same throttle is not.
 */

/** Road speed, in m/s, at which each gear reaches the top of its rev range. */
export const GEAR_TOPS: readonly number[] = [7, 13, 21, 32];

/** Where the revs sit at a standstill, as a fraction of the range. */
export const REV_IDLE = 0.18;
/** Where the revs drop to on an upshift. Well above idle, as a real one is. */
const REV_AFTER_SHIFT = 0.42;

/** Acceleration, in m/s squared, that counts as full load either way. */
export const LOAD_REFERENCE = 4;

/**
 * Playback-rate range for each layer.
 *
 * The idle loop was recorded at idle, so it must play near unity at
 * `REV_IDLE`; the load loop was recorded at a mid-range engine speed, so it
 * plays near unity around the middle of the range. Pitching either one much
 * past a factor of 1.5 starts to sound like a chipmunk rather than an engine,
 * which is what bounds the top of both.
 */
const IDLE_RATE_BASE = 0.92;
const IDLE_RATE_SPAN = 0.55;
const LOAD_RATE_BASE = 0.72;
const LOAD_RATE_SPAN = 0.62;

/** Lowpass corner, in Hz, that gives the engine its on/off-throttle colour. */
const CUTOFF_BASE = 700;
const CUTOFF_PER_REV = 2600;
const CUTOFF_PER_LOAD = 2200;
/** How far the corner closes when the driver lifts right off. */
const CUTOFF_OVERRUN = 0.45;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Hermite fade, so a layer never crossfades with an audible corner. */
function smoothstep(edge0: number, edge1: number, v: number): number {
  const t = clamp01((v - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export interface GearPoint {
  /** Zero-based gear the model is in. */
  readonly gear: number;
  /** Position through the rev range, `REV_IDLE` at rest and 1 at the limiter. */
  readonly rev: number;
}

/**
 * Which gear a road speed is in, and how far through its rev range it sits.
 *
 * Speed is taken as an absolute value: reversing revs the engine exactly the
 * way pulling away forwards does, which is what a real car with one reverse
 * gear sounds like.
 */
export function gearFor(speed: number): GearPoint {
  const v = Math.abs(speed);
  let gear = GEAR_TOPS.length - 1;
  for (let i = 0; i < GEAR_TOPS.length; i += 1) {
    if (v <= (GEAR_TOPS[i] as number)) {
      gear = i;
      break;
    }
  }
  const top = GEAR_TOPS[gear] as number;
  const bottom = gear === 0 ? 0 : (GEAR_TOPS[gear - 1] as number);
  const floor = gear === 0 ? REV_IDLE : REV_AFTER_SHIFT;
  const through = clamp01((v - bottom) / Math.max(1e-6, top - bottom));
  return { gear, rev: floor + (1 - floor) * through };
}

export interface EngineTone {
  readonly gear: number;
  readonly rev: number;
  /** Playback rate for the idle layer. */
  readonly idleRate: number;
  /** Playback rate for the on-load layer. */
  readonly loadRate: number;
  /** Relative level of the idle layer, 0 to 1. */
  readonly idleMix: number;
  /** Relative level of the on-load layer, 0 to 1. */
  readonly loadMix: number;
  /** Overall level of the engine, 0 to 1, before any bus trim. */
  readonly gain: number;
  /** Lowpass corner in Hz. Bright on throttle, closed on the overrun. */
  readonly cutoff: number;
}

/**
 * The complete engine note for a speed and a load.
 *
 * `load` is acceleration divided by `LOAD_REFERENCE`, clamped to -1..1: 1 is
 * hard on the throttle, 0 is holding a steady speed, -1 is braking or hard on
 * the overrun. Three things move with it, and they are what separate the three
 * cases the player asked to be able to hear apart:
 *
 *   accelerating  louder, brighter, revs climbing towards a shift
 *   cruising      steady level, mid colour, revs flat
 *   lifting off   quieter, distinctly duller, revs falling with the road speed
 */
export function engineTone(speed: number, load: number): EngineTone {
  const { gear, rev } = gearFor(speed);
  const pull = clamp01(load);
  // Overrun, as a positive 0..1. Split out because it only ever subtracts.
  const overrun = clamp01(-load);

  const idleMix = 1 - smoothstep(0.15, 0.55, rev);
  const loadMix = smoothstep(0.12, 0.5, rev);

  // Level rises with revs and with throttle, and is cut on the overrun. The
  // floor is deliberately well above zero: a car ticking over at a red light
  // must still be audible, or stopping sounds like the engine died.
  const gain = clamp01((0.5 + 0.5 * rev) * (0.78 + 0.32 * pull) * (1 - 0.28 * overrun));

  const cutoff = (CUTOFF_BASE + CUTOFF_PER_REV * rev + CUTOFF_PER_LOAD * pull) *
    (1 - CUTOFF_OVERRUN * overrun);

  return {
    gear,
    rev,
    idleRate: IDLE_RATE_BASE + IDLE_RATE_SPAN * rev,
    loadRate: LOAD_RATE_BASE + LOAD_RATE_SPAN * rev,
    idleMix,
    loadMix,
    gain,
    cutoff,
  };
}

/**
 * Normalised load from an acceleration, ready for `engineTone`.
 *
 * Kept here rather than in the caller so the reference figure lives beside the
 * curve that consumes it.
 */
export function loadFromAcceleration(accel: number): number {
  const v = accel / LOAD_REFERENCE;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/**
 * Rate an ambient car's tyre-roll loop is played back at.
 *
 * Ambient traffic gets one loop rather than the two-layer engine, because it is
 * always heard through a panner at 15 m or more where the layering is inaudible
 * and the voice budget is what matters. Pitch still tracks speed, so a car
 * pulling away from a light is audibly doing so.
 */
export function ambientRate(speed: number): number {
  return 0.82 + clamp01(Math.abs(speed) / 18) * 0.5;
}

/**
 * Level of an ambient car's loop from its speed.
 *
 * A queueing car is not silent - it is idling - but a moving one is much more
 * present, which is what makes a junction audibly release when the light goes
 * green.
 */
export function ambientLevel(speed: number): number {
  return 0.22 + 0.78 * clamp01(Math.abs(speed) / 12);
}
