/**
 * How a car's speed, load and CLASS become an engine note.
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
 * sweeps its rev range, drops, and sweeps again. `gearTops` gives each class
 * four or five gears, so accelerating from rest produces a rise per gear and a
 * drop between them, and that pattern is most of what makes acceleration
 * audible as acceleration.
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
 * ## Why a class, and not one engine for everything
 *
 * A hatchback, a van, a coupe, a box truck and a police interceptor were one
 * recording at one set of gear ratios, so they were the same car eleven times.
 * `ENGINE_PROFILES` gives each an idle/load pair of its own, its own gearing,
 * its own rate window, its own filter opening and its own weight. Two of those
 * are what actually carry the identity:
 *
 *   gearTops   a truck runs out of gear at 6 m/s and shifts constantly; a
 *              sports car pulls to 18 m/s in second and shifts rarely, so the
 *              two have completely different rhythms under acceleration.
 *   cutoff     a diesel is dark and stays dark; a coupe opens up hard.
 *
 * ## Why load, not throttle
 *
 * The driving layer does not publish its throttle input, and it should not have
 * to: `load` here is normalised acceleration, which the caller can always
 * derive from two speed samples. It is also the more honest signal - a car
 * labouring up a hill at constant throttle is under load, and a car coasting
 * downhill on the same throttle is not.
 */

/**
 * The distinct engine voices the game mixes.
 *
 * Five of them have a recorded idle/load pair of their own; `saloon` is the
 * original `veh/engine-idle` / `veh/engine-load` pair, which is a mid-size
 * four-cylinder petrol car and is exactly right for the saloons, the wagon,
 * the crossover and the taxi.
 */
export type EngineVoice = 'small' | 'saloon' | 'sport' | 'diesel' | 'truck' | 'interceptor';

export interface EngineProfile {
  readonly voice: EngineVoice;
  /** Road speed, m/s, at which each gear reaches the top of its rev range. */
  readonly gearTops: readonly number[];
  /** Where the revs sit at a standstill, as a fraction of the range. */
  readonly revIdle: number;
  /** Where the revs drop to on an upshift. Well above idle, as a real one is. */
  readonly revAfterShift: number;
  /** Playback rate of the idle layer at `revIdle`, and its span to the limiter. */
  readonly idleRateBase: number;
  readonly idleRateSpan: number;
  /** Playback rate of the load layer at `revIdle`, and its span. */
  readonly loadRateBase: number;
  readonly loadRateSpan: number;
  /** Lowpass corner, Hz, at idle off the throttle, and how far it opens. */
  readonly cutoffBase: number;
  readonly cutoffPerRev: number;
  readonly cutoffPerLoad: number;
  /** Overall weight of this voice, 0..1.2. A truck is bigger than a hatchback. */
  readonly level: number;
  /**
   * How loud this class's tyres are at speed, relative to the engine.
   *
   * A separate layer rather than part of the engine loop, because tyre roar
   * tracks ROAD SPEED and engine note tracks REVS, and those two diverge every
   * time the gearbox shifts. Baking them together is what makes an upshift
   * sound like the whole car briefly slowing down.
   */
  readonly tyreLevel: number;
}

/**
 * The rev range each layer's recording sits at.
 *
 * The idle loop was recorded at idle, so it must play near unity at `revIdle`;
 * the load loop was recorded at a mid-range engine speed, so it plays near
 * unity around the middle of the range. Pitching either one much past a factor
 * of 1.5 starts to sound like a chipmunk rather than an engine, which is what
 * bounds the top of both.
 */
export const ENGINE_PROFILES: Readonly<Record<EngineVoice, EngineProfile>> = {
  /** 1.2 litre hatchback: short gears, buzzy, thin, revs hard and often. */
  small: {
    voice: 'small',
    gearTops: [6, 11, 18, 27],
    revIdle: 0.2,
    revAfterShift: 0.44,
    idleRateBase: 0.96,
    idleRateSpan: 0.6,
    loadRateBase: 0.8,
    loadRateSpan: 0.66,
    cutoffBase: 760,
    cutoffPerRev: 2900,
    cutoffPerLoad: 2400,
    level: 0.82,
    tyreLevel: 0.5,
  },
  /** The original pair: a mid-size four-cylinder saloon. The reference voice. */
  saloon: {
    voice: 'saloon',
    gearTops: [7, 13, 21, 32],
    revIdle: 0.18,
    revAfterShift: 0.42,
    idleRateBase: 0.92,
    idleRateSpan: 0.55,
    loadRateBase: 0.72,
    loadRateSpan: 0.62,
    cutoffBase: 700,
    cutoffPerRev: 2600,
    cutoffPerLoad: 2200,
    level: 1,
    tyreLevel: 0.55,
  },
  /** Coupe: long gears, high limiter, opens up hard and stays bright. */
  sport: {
    voice: 'sport',
    gearTops: [10, 18, 28, 40, 52],
    revIdle: 0.16,
    revAfterShift: 0.5,
    idleRateBase: 0.9,
    idleRateSpan: 0.62,
    loadRateBase: 0.74,
    loadRateSpan: 0.7,
    cutoffBase: 900,
    cutoffPerRev: 4200,
    cutoffPerLoad: 3200,
    level: 1.06,
    tyreLevel: 0.62,
  },
  /** Van and pickup: a light commercial diesel. Dark, clattery, low limiter. */
  diesel: {
    voice: 'diesel',
    gearTops: [6, 11, 17, 25, 33],
    revIdle: 0.24,
    revAfterShift: 0.46,
    idleRateBase: 0.9,
    idleRateSpan: 0.42,
    loadRateBase: 0.74,
    loadRateSpan: 0.48,
    cutoffBase: 480,
    cutoffPerRev: 1700,
    cutoffPerLoad: 1500,
    level: 1.04,
    tyreLevel: 0.66,
  },
  /**
   * Box truck: very short gears and a very low limiter, so it is shifting all
   * the time and never gets anywhere near the pitch a car reaches.
   */
  truck: {
    voice: 'truck',
    gearTops: [4, 7, 10.5, 15, 20, 26],
    revIdle: 0.26,
    revAfterShift: 0.5,
    idleRateBase: 0.84,
    idleRateSpan: 0.34,
    loadRateBase: 0.68,
    loadRateSpan: 0.4,
    cutoffBase: 380,
    cutoffPerRev: 1250,
    cutoffPerLoad: 1150,
    level: 1.18,
    tyreLevel: 0.78,
  },
  /** Patrol V8: long-legged, heavy, mid-dominant, loud off the line. */
  interceptor: {
    voice: 'interceptor',
    gearTops: [9, 17, 27, 38],
    revIdle: 0.17,
    revAfterShift: 0.46,
    idleRateBase: 0.9,
    idleRateSpan: 0.5,
    loadRateBase: 0.72,
    loadRateSpan: 0.58,
    cutoffBase: 640,
    cutoffPerRev: 3100,
    cutoffPerLoad: 2700,
    level: 1.12,
    tyreLevel: 0.6,
  },
};

/**
 * Which voice each catalogue shell speaks with.
 *
 * Keyed by the traffic system's `VehicleKind` STRINGS rather than by the type,
 * so this module stays free of any import from `src/traffic` and an unknown
 * kind - a shell added while this file was not looking - falls back to the
 * saloon instead of failing to compile the audio layer.
 */
const VOICE_BY_KIND: Readonly<Record<string, EngineVoice>> = {
  compact: 'small',
  sedan: 'saloon',
  wagon: 'saloon',
  crossover: 'saloon',
  taxi: 'saloon',
  coupe: 'sport',
  van: 'diesel',
  pickup: 'diesel',
  boxTruck: 'truck',
  patrolSedan: 'interceptor',
  patrolSuv: 'interceptor',
};

export function engineVoiceFor(kind: string | null | undefined): EngineVoice {
  if (kind === null || kind === undefined) return 'saloon';
  return VOICE_BY_KIND[kind] ?? 'saloon';
}

export function engineProfileFor(kind: string | null | undefined): EngineProfile {
  return ENGINE_PROFILES[engineVoiceFor(kind)];
}

/** The reference profile. Everything with no class of its own gets this one. */
export const DEFAULT_PROFILE: EngineProfile = ENGINE_PROFILES.saloon;

/** Road speed, in m/s, at which each gear reaches the top of its rev range. */
export const GEAR_TOPS: readonly number[] = DEFAULT_PROFILE.gearTops;

/** Where the revs sit at a standstill, as a fraction of the range. */
export const REV_IDLE = DEFAULT_PROFILE.revIdle;

/** Acceleration, in m/s squared, that counts as full load either way. */
export const LOAD_REFERENCE = 4;

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
  /** Position through the rev range, `revIdle` at rest and 1 at the limiter. */
  readonly rev: number;
}

/**
 * Which gear a road speed is in, and how far through its rev range it sits.
 *
 * Speed is taken as an absolute value: reversing revs the engine exactly the
 * way pulling away forwards does, which is what a real car with one reverse
 * gear sounds like.
 */
export function gearFor(speed: number, profile: EngineProfile = DEFAULT_PROFILE): GearPoint {
  return { gear: gearIndex(speed, profile), rev: gearRev(speed, profile) };
}

/** Which gear a road speed is in. Allocation-free half of `gearFor`. */
function gearIndex(speed: number, profile: EngineProfile): number {
  const tops = profile.gearTops;
  const v = Math.abs(speed);
  for (let i = 0; i < tops.length; i += 1) {
    if (v <= (tops[i] as number)) return i;
  }
  return tops.length - 1;
}

/**
 * How far through its rev range a road speed sits, without allocating.
 *
 * `gearFor` returns a `GearPoint` object, which is the readable form and the
 * one the tests assert on. The ambient traffic mixer calls this for seven
 * voices EVERY FRAME, twice each, and two object literals per voice per frame
 * is 2,500 short-lived objects a second at 120 Hz - which is exactly the
 * per-frame allocation the engineering rules forbid in a simulation loop.
 */
export function gearRev(speed: number, profile: EngineProfile = DEFAULT_PROFILE): number {
  const tops = profile.gearTops;
  const gear = gearIndex(speed, profile);
  const top = tops[gear] as number;
  const bottom = gear === 0 ? 0 : (tops[gear - 1] as number);
  const floor = gear === 0 ? profile.revIdle : profile.revAfterShift;
  const through = clamp01((Math.abs(speed) - bottom) / Math.max(1e-6, top - bottom));
  return floor + (1 - floor) * through;
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
  /** Level of the tyre/road-noise layer, 0 to 1. Follows ROAD SPEED. */
  readonly tyreGain: number;
  /** Playback rate of the tyre layer. Also road speed, never revs. */
  readonly tyreRate: number;
}

/**
 * Speed, m/s, at which tyre roar has reached its full level.
 *
 * Tyre noise rises roughly with the square of road speed up to motorway pace
 * and then flattens; 26 m/s is faster than anything in Meridian Bay goes, so
 * the layer is still climbing at every speed the player will actually drive.
 */
const TYRE_FULL_SPEED = 26;
/** Below this the tyres are inaudible under the engine, so the layer is off. */
const TYRE_ONSET_SPEED = 1.6;

/**
 * The complete engine note for a speed, a load and a class.
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
export function engineTone(
  speed: number,
  load: number,
  profile: EngineProfile = DEFAULT_PROFILE,
): EngineTone {
  const { gear, rev } = gearFor(speed, profile);
  const pull = clamp01(load);
  // Overrun, as a positive 0..1. Split out because it only ever subtracts.
  const overrun = clamp01(-load);

  const idleMix = 1 - smoothstep(0.15, 0.55, rev);
  const loadMix = smoothstep(0.12, 0.5, rev);

  // Level rises with revs and with throttle, and is cut on the overrun. The
  // floor is deliberately well above zero: a car ticking over at a red light
  // must still be audible, or stopping sounds like the engine died.
  const gain = clamp01(
    (0.5 + 0.5 * rev) * (0.78 + 0.32 * pull) * (1 - 0.28 * overrun) * profile.level,
  );

  const cutoff =
    (profile.cutoffBase + profile.cutoffPerRev * rev + profile.cutoffPerLoad * pull) *
    (1 - CUTOFF_OVERRUN * overrun);

  const roadSpeed = Math.abs(speed);
  const tyreThrough = clamp01(
    (roadSpeed - TYRE_ONSET_SPEED) / (TYRE_FULL_SPEED - TYRE_ONSET_SPEED),
  );
  return {
    gear,
    rev,
    idleRate: profile.idleRateBase + profile.idleRateSpan * rev,
    loadRate: profile.loadRateBase + profile.loadRateSpan * rev,
    idleMix,
    loadMix,
    gain,
    cutoff,
    // Squared, because tyre roar is close to a power law in road speed and a
    // linear ramp is audible as the tyres fading in rather than as speed.
    tyreGain: tyreThrough * tyreThrough * profile.tyreLevel,
    tyreRate: 0.86 + tyreThrough * 0.34,
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

/*
 * ---------------------------------------------------------------------------
 * Ambient traffic
 * ---------------------------------------------------------------------------
 *
 * A CAR THE PLAYER WALKS PAST HAS AN ENGINE. That sounds obvious and it was
 * the defect: the ambient voice was a single `veh/engine-far` loop, which is a
 * recording of TYRE ROLL, chosen on the reasoning that traffic "is always heard
 * through a panner at 15 m or more where the layering is inaudible". Standing
 * on a pavement in Meridian Bay that premise does not hold - the panner's
 * reference distance is 7 m and cars pass inside it constantly - and a broad
 * rubber hiss under the district ambience and the traffic-hum bed is exactly
 * what "the cars are not making any noise" describes. A queueing car was worse
 * still: it was voiced as tyre noise at a standstill, which is a sound that
 * does not exist.
 *
 * So an ambient car is now TWO layers on one panner, the same split the
 * player's own car uses and for the same reason:
 *
 *   engine  `veh/engine-idle`, rate and level from the gear model, so a car
 *           idling at a red light is audibly idling and one pulling away
 *           audibly climbs and shifts;
 *   tyres   `veh/engine-far`, level and rate from ROAD SPEED alone, so it is
 *           silent at a standstill and dominant at 50 km/h.
 *
 * They diverge on every gearchange, which is the whole point - see the note on
 * `tyre-roll` in the manifest. It costs two nodes per voice over the one-layer
 * version; the voice count and the pool ceiling are unchanged in kind.
 */

/**
 * Rate an ambient car's tyre-roll loop is played back at.
 *
 * ROAD SPEED, never revs. The class shifts the whole window - a box truck is a
 * bigger, slower-turning thing than a hatchback and has to sound like one from
 * across the street too.
 */
export function ambientRate(speed: number, profile: EngineProfile = DEFAULT_PROFILE): number {
  const window = profile.idleRateBase / DEFAULT_PROFILE.idleRateBase;
  return (0.82 + clamp01(Math.abs(speed) / 18) * 0.5) * window;
}

/**
 * Speed, m/s, at which an ambient car's tyre layer is at full level.
 *
 * Lower than the player's own `TYRE_FULL_SPEED` because ambient traffic in a
 * 30 km/h city never reaches motorway pace: at 26 m/s the layer would still be
 * at a fifth of its level everywhere the player actually hears it.
 */
const AMBIENT_TYRE_FULL_SPEED = 14;

/**
 * Level of an ambient car's TYRE layer from its speed.
 *
 * Zero below the onset speed: a stopped car makes no tyre noise, and the
 * engine layer below is what keeps it audible at a red light. Squared for the
 * same reason the player's own tyre layer is - tyre roar is close to a power
 * law in road speed, and a linear ramp reads as a fade rather than as speed.
 */
export function ambientLevel(speed: number, profile: EngineProfile = DEFAULT_PROFILE): number {
  const through = clamp01(
    (Math.abs(speed) - TYRE_ONSET_SPEED) / (AMBIENT_TYRE_FULL_SPEED - TYRE_ONSET_SPEED),
  );
  return through * through * profile.level;
}

/**
 * Rate and level of an ambient car's ENGINE layer.
 *
 * Both come off the same `gearFor` model the player's car uses, so ambient
 * traffic shifts where the player's car shifts and a hatchback buzzing through
 * four short gears still sounds nothing like a truck lugging through two. The
 * level floor is well clear of zero on purpose: an idling engine at a junction
 * is the sound this whole layer exists to restore.
 */
export interface AmbientEngine {
  rate: number;
  level: number;
  rev: number;
}

/**
 * Writes into `out` rather than returning, for the reason `gearRev` exists:
 * this is called per voice per frame. The convenience form below allocates and
 * is for tests and for anything that is not in the frame loop.
 */
export function ambientEngineInto(
  speed: number,
  profile: EngineProfile,
  out: AmbientEngine,
): AmbientEngine {
  const rev = gearRev(speed, profile);
  out.rev = rev;
  out.rate = profile.idleRateBase + profile.idleRateSpan * rev;
  out.level = (0.52 + 0.48 * rev) * profile.level;
  return out;
}

export function ambientEngine(
  speed: number,
  profile: EngineProfile = DEFAULT_PROFILE,
): AmbientEngine {
  return ambientEngineInto(speed, profile, { rate: 1, level: 0, rev: 0 });
}

/**
 * Lowpass corner, Hz, for an ambient car of this class.
 *
 * ONE filter for both layers, because they are one car: the corner is the
 * class's colour rather than the throttle's, and a truck heard across a
 * junction is almost entirely low rumble where a coupe going past is mostly
 * the top of its exhaust. It opens with the revs so an accelerating car
 * brightens, which is what makes a car pulling away read as pulling away
 * rather than as merely getting louder.
 */
export function ambientCutoff(profile: EngineProfile = DEFAULT_PROFILE, speed = 0): number {
  return ambientCutoffAt(profile, gearRev(speed, profile));
}

/** The same corner from a rev the caller has already computed. */
export function ambientCutoffAt(profile: EngineProfile, rev: number): number {
  return profile.cutoffBase + profile.cutoffPerRev * (0.3 + 0.5 * rev);
}

/**
 * The Web Audio `inverse` distance model, written out.
 *
 * `PannerNode` applies exactly this, and the runtime relies on it for every
 * positional voice, but a browser doing the arithmetic inside a native node is
 * not something a headless test can assert. Reproducing the formula here means
 * the property the mix depends on - that a sound gets quieter with distance,
 * monotonically, and never exceeds unity or falls below zero - is pinned by a
 * test rather than assumed.
 *
 * See https://www.w3.org/TR/webaudio/#Inverse-distance: the distance is first
 * clamped to `[refDistance, maxDistance]`.
 */
export function inverseDistanceGain(
  distance: number,
  refDistance: number,
  rolloffFactor: number,
  maxDistance: number,
): number {
  const d = Math.min(Math.max(distance, refDistance), maxDistance);
  return refDistance / (refDistance + rolloffFactor * (d - refDistance));
}
