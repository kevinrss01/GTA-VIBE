/**
 * The sound of being chased.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   const policeAudio = new PoliceAudio(audio);   // audio: AudioBusHost
 *
 *   // once per frame, AFTER police.update, with the listener where the ears
 *   // are - the camera on foot, the car while driving:
 *   policeAudio.update(dt, {
 *     x: listenerX, y: listenerY, z: listenerZ,
 *     indoors: state.indoors,
 *     units: police.beaconPoses,        // see PursuitUnit below
 *   });
 *
 *   policeAudio.dispose();              // on unload
 *
 * `units` is every unit whose siren should be audible - a PURSUING unit, not
 * every police car in the fleet. `PoliceSystem` already builds a per-frame
 * `beaconPoses` list of exactly the units running their lights; anything with
 * `{ id, x, y, z }` and an optional `siren`/`speed` works, and a unit with
 * `siren: false` is voiced as an engine with no siren, which is what a patrol
 * car sitting at a kerb should sound like.
 *
 * ============================================================================
 *
 * ## Why this is not `AudioDirector.addLoopEmitter`
 *
 * That primitive is position-FIXED and routes to the ambience-scaled bus, so it
 * is right for a fountain and wrong for a car. The shape that fits is
 * `CombatAudio.flight()`: a looping spatial source that moves. This adds the
 * two things a pursuit needs on top of it - a pool, because units come and go
 * and an `AudioBufferSourceNode` cannot be restarted once stopped, and Doppler,
 * because a siren is the one sound in the game whose pass-by is the point.
 *
 * ## Why a police car sounds different from a taxi
 *
 * `PoliceSystem` takes its cars over from ordinary traffic with
 * `traffic.takeControl`, so they stay in `traffic.vehicles` and keep the plain
 * tyre-roll voice `StreetAudio` gives every car. That voice is correct and is
 * left alone. This layer SUMS two more on top of the same car:
 *
 *   - `police/siren`, the identity, through its own lowpass so a unit behind a
 *     building is muffled rather than merely quieter;
 *   - `police/engine`, a V8 held at high revs, whose level follows how hard the
 *     unit is actually driving. It is what makes a car that is chasing you
 *     sound different from the same car parked, and it is why the engine and
 *     the siren are separate assets rather than one clip.
 *
 * Both share one panner, because they are one object in space - and both
 * therefore take the siren's distance model, which is the flatter of the two
 * that would be right on their own. That is deliberate: the engine being
 * audible slightly further out than a civilian one is what a pursuit sounds
 * like, and it costs one node per unit rather than two panners and a second
 * distance curve.
 *
 * ## Doppler, and why it is done here and nowhere else
 *
 * There is no Doppler anywhere else in this game, deliberately: a `PannerNode`
 * does it for you if you set velocities, but it does it to everything, and
 * pitch-shifting an idling engine as the player walks past reads as a fault.
 * A siren is the exception - the drop as a unit goes past is the single most
 * recognisable thing about it - so it is applied here, by hand, only to the
 * siren, from the RADIAL component of the unit's velocity. Capped at +/-6 per
 * cent, which is about 20 m/s of closing speed at the real 343 m/s speed of
 * sound, so a chase sounds right and a stationary unit is never detuned.
 */

import type { AudioBusHost } from './AudioDirector';
import { getAudioAsset, POLICE_SOUNDS } from './manifest';
import type { AudioAssetId } from './manifest';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * How many units may be voiced at once.
 *
 * A pursuit is one or two cars on you and the rest converging from streets
 * away; the third siren adds nothing but level, and each voice costs six nodes
 * against a graph the street layer already holds 23 persistent nodes in. Two is
 * measured against the budget rather than chosen: see `stats.liveNodes`.
 */
const MAX_UNITS = 2;

/** Distance at which a siren is at full level, and where it is released. */
const SIREN_REF_DISTANCE = 14;
const SIREN_MAX_DISTANCE = 170;
/**
 * Rolloff, flatter than the street layer's 1.4.
 *
 * A siren is designed to carry: rolling it off as fast as an idling engine
 * would make a unit two blocks away inaudible, which is the opposite of what
 * the sound is for. This is the same reasoning `CombatAudio` uses for gunfire.
 */
const SIREN_ROLLOFF = 0.85;

/** Beyond this a unit is not worth a voice at all. */
const AUDIBLE_RADIUS = 190;
/** Hysteresis on release, so a unit hovering at the edge does not churn. */
const RELEASE_RADIUS = 215;

/** Reassignment rate. The nearest two units barely change in a third of a second. */
const REASSIGN_INTERVAL = 0.3;

/** Fade times. A siren arrives fast; it must not click. */
const SIREN_FADE_IN = 0.25;
const SIREN_FADE_OUT = 0.5;
const LEVEL_RAMP = 0.12;
const FILTER_RAMP = 0.15;

/** Below these a change is inaudible and the frame schedules no Web Audio work. */
const GAIN_EPSILON = 0.005;
const RATE_EPSILON = 0.003;
const FILTER_EPSILON = 40;

/**
 * Occlusion-ish colour with distance.
 *
 * Not a real occlusion test - there is no ray budget for one here - but air and
 * buildings both eat treble, so a siren 150 m away is genuinely duller as well
 * as quieter. Sweeping the lowpass with distance is most of what a listener
 * uses to judge how far away a siren is, and it costs one biquad per unit.
 */
const FILTER_NEAR_HZ = 8000;
const FILTER_FAR_HZ = 900;

/** Speed at which the pursuit engine is at full level. */
const ENGINE_FULL_SPEED = 22;
/** A unit that is barely moving still idles rather than falling silent. */
const ENGINE_IDLE_LEVEL = 0.25;

/** Doppler. See the note at the top for why only the siren gets it. */
const SPEED_OF_SOUND = 343;
const MAX_DOPPLER = 0.06;

/** Indoors, a siren is on the other side of a wall. */
const INDOOR_DUCK = 0.35;

/** MP3 encoder padding, skipped at both ends of every loop. See `StreetAudio`. */
const LOOP_TRIM = 0.03;

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function moved(value: number, previous: number, epsilon: number): boolean {
  return Math.abs(value - previous) >= epsilon;
}

/** Hoisted so a per-frame mix never pays for a `Math.pow` or a map lookup. */
const SIREN_TRIM = dbToGain(getAudioAsset(POLICE_SOUNDS.siren).trimDb);
const ENGINE_TRIM = dbToGain(getAudioAsset(POLICE_SOUNDS.engine).trimDb);

// ---------------------------------------------------------------------------
// The shapes this layer reads
// ---------------------------------------------------------------------------

/**
 * A police unit worth hearing.
 *
 * Structurally a superset of `PoliceSystem`'s per-frame `beaconPoses` entries,
 * so that list can be passed straight in without either module importing the
 * other. Everything past the position is optional and has a defensible default:
 * a caller that knows only where its units are still gets sirens.
 */
export interface PursuitUnit {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /**
   * Whether this unit's siren is running. A parked patrol car reports `false`
   * and is voiced as an engine only. Defaults to `true`, because a caller
   * passing a list of units in a pursuit means exactly that.
   */
  readonly siren?: boolean;
  /** Speed in m/s, used for the engine level. Defaults to 0. */
  readonly speed?: number;
  /** World velocity, used for the siren's Doppler. Defaults to none. */
  readonly vx?: number;
  readonly vz?: number;
}

export interface PoliceAudioContext {
  /** Where the ears are: the camera on foot, the car while driving. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly indoors: boolean;
  /** Live views, read during the frame and never retained. */
  readonly units: readonly PursuitUnit[];
}

export interface PoliceAudioStats {
  /** Web Audio nodes this layer holds. Bounded at MAX_UNITS * 6. */
  readonly liveNodes: number;
  /** Voices currently assigned to a unit. */
  readonly activeUnits: number;
  /** Of those, how many are actually sounding a siren. */
  readonly sirens: number;
  /** Loudest siren level pushed this frame, for tests and diagnostics. */
  readonly sirenLevel: number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface UnitVoice {
  readonly siren: AudioBufferSourceNode;
  readonly sirenGain: GainNode;
  readonly filter: BiquadFilterNode;
  readonly engine: AudioBufferSourceNode;
  readonly engineGain: GainNode;
  readonly panner: PannerNode;
  unitId: number | null;
  /** Its unit was found in the list this frame. */
  seen: boolean;
  sirenLevel: number;
  engineLevel: number;
  rate: number;
  cutoff: number;
}

export class PoliceAudio {
  private readonly host: AudioBusHost;
  private readonly voices: UnitVoice[] = [];
  private readonly wanted: number[] = [];
  private reassignIn = 0;
  private requested = false;
  private liveNodes = 0;
  private loudestSiren = 0;
  private disposed = false;

  constructor(host: AudioBusHost) {
    this.host = host;
  }

  /**
   * Asks the director to decode the pursuit pair.
   *
   * Both are in the eager preload set, so this is normally a no-op; it exists
   * so a caller that has torn the director down and rebuilt it can get them
   * back without waiting for the first siren to request them.
   */
  preload(): void {
    for (const id of Object.values(POLICE_SOUNDS)) this.host.requestAsset(id);
  }

  get stats(): PoliceAudioStats {
    let active = 0;
    let sirens = 0;
    for (const voice of this.voices) {
      if (voice.unitId === null) continue;
      active += 1;
      if (voice.sirenLevel > 0) sirens += 1;
    }
    return {
      liveNodes: this.liveNodes,
      activeUnits: active,
      sirens,
      sirenLevel: this.loudestSiren,
    };
  }

  /** Called once per frame, after the police system has moved its units. */
  update(dt: number, ctx: PoliceAudioContext): void {
    if (this.disposed) return;
    const step = dt > 0 && dt < 0.5 ? dt : 1 / 60;

    this.reassignIn -= step;
    if (this.reassignIn <= 0) {
      this.reassignIn = REASSIGN_INTERVAL;
      this.reassign(ctx);
    }

    for (const voice of this.voices) voice.seen = false;

    this.loudestSiren = 0;
    for (const unit of ctx.units) {
      for (const voice of this.voices) {
        if (voice.unitId !== unit.id) continue;
        voice.seen = true;
        this.driveVoice(voice, unit, ctx);
        break;
      }
    }

    // A unit that was destroyed, arrested the player or simply dropped out of
    // the list must not hold its last level until the next reassignment tick.
    for (const voice of this.voices) {
      if (voice.unitId === null || voice.seen) continue;
      voice.unitId = null;
      this.setSiren(voice, 0, SIREN_FADE_OUT);
      this.setEngine(voice, 0);
    }
  }

  // -- per-unit mixing -------------------------------------------------------

  private driveVoice(voice: UnitVoice, unit: PursuitUnit, ctx: PoliceAudioContext): void {
    this.setPanner(voice.panner, unit.x, unit.y, unit.z);

    const dx = unit.x - ctx.x;
    const dz = unit.z - ctx.z;
    const distance = Math.hypot(dx, dz);
    const duck = ctx.indoors ? INDOOR_DUCK : 1;

    // The panner already applies distance; this is the COLOUR of that distance.
    const near = clamp01(1 - distance / SIREN_MAX_DISTANCE);
    const cutoff = FILTER_FAR_HZ + (FILTER_NEAR_HZ - FILTER_FAR_HZ) * near * near;
    if (moved(cutoff, voice.cutoff, FILTER_EPSILON)) {
      voice.cutoff = cutoff;
      this.ramp(voice.filter.frequency, cutoff, FILTER_RAMP);
    }

    const sirenOn = unit.siren ?? true;
    this.setSiren(voice, sirenOn ? SIREN_TRIM * duck : 0, sirenOn ? SIREN_FADE_IN : SIREN_FADE_OUT);
    if (sirenOn) this.loudestSiren = Math.max(this.loudestSiren, voice.sirenLevel);

    const speed = Math.abs(unit.speed ?? 0);
    const effort = ENGINE_IDLE_LEVEL + (1 - ENGINE_IDLE_LEVEL) * clamp01(speed / ENGINE_FULL_SPEED);
    this.setEngine(voice, ENGINE_TRIM * effort * duck);

    this.setDoppler(voice, unit, dx, dz, distance);
  }

  /**
   * Pitches the siren by the closing speed along the line to the listener.
   *
   * Only the radial component matters: a unit crossing in front of the player
   * at 20 m/s is not approaching at all, and pitching it would be wrong. The
   * sign convention is the physical one - closing (negative radial distance
   * rate) raises the pitch - and the shift is clamped hard, because a rate that
   * runs away also runs the loop off its own tail.
   */
  private setDoppler(
    voice: UnitVoice,
    unit: PursuitUnit,
    dx: number,
    dz: number,
    distance: number,
  ): void {
    let rate = 1;
    const vx = unit.vx;
    const vz = unit.vz;
    if (vx !== undefined && vz !== undefined && distance > 0.5) {
      const radial = (vx * dx + vz * dz) / distance;
      const shift = -radial / SPEED_OF_SOUND;
      rate = 1 + Math.max(-MAX_DOPPLER, Math.min(MAX_DOPPLER, shift));
    }
    if (!moved(rate, voice.rate, RATE_EPSILON)) return;
    voice.rate = rate;
    this.ramp(voice.siren.playbackRate, rate, LEVEL_RAMP);
  }

  private setSiren(voice: UnitVoice, level: number, fade: number): void {
    if (Math.abs(level - voice.sirenLevel) < GAIN_EPSILON) return;
    voice.sirenLevel = level;
    this.ramp(voice.sirenGain.gain, level, fade);
  }

  private setEngine(voice: UnitVoice, level: number): void {
    if (Math.abs(level - voice.engineLevel) < GAIN_EPSILON) return;
    voice.engineLevel = level;
    this.ramp(voice.engineGain.gain, level, LEVEL_RAMP);
  }

  // -- assignment ------------------------------------------------------------

  /**
   * Gives the pool the nearest units worth hearing.
   *
   * A siren outranks a silent patrol car at the same distance: the sound that
   * matters is the one telling the player they are being chased, and a parked
   * car being voiced instead would be an actively worse mix, not merely a
   * different one. Beyond that it is nearest-first, with `RELEASE_RADIUS`
   * hysteresis so a unit sitting on the edge of earshot does not churn voices.
   */
  private reassign(ctx: PoliceAudioContext): void {
    this.wanted.length = 0;
    const bestId: number[] = [];
    const bestRank: number[] = [];

    for (const unit of ctx.units) {
      const dx = unit.x - ctx.x;
      const dz = unit.z - ctx.z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq > AUDIBLE_RADIUS * AUDIBLE_RADIUS) continue;
      // A silent unit is ranked as if it were a long way further off, which
      // keeps one comparison rather than two sorted lists.
      const rank = (unit.siren ?? true) ? distanceSq : distanceSq + AUDIBLE_RADIUS * AUDIBLE_RADIUS;

      let slot = bestId.length;
      while (slot > 0 && (bestRank[slot - 1] as number) > rank) slot -= 1;
      if (slot >= MAX_UNITS) continue;
      bestId.splice(slot, 0, unit.id);
      bestRank.splice(slot, 0, rank);
      if (bestId.length > MAX_UNITS) {
        bestId.length = MAX_UNITS;
        bestRank.length = MAX_UNITS;
      }
    }
    for (const id of bestId) this.wanted.push(id);

    const held = new Set<number>();
    for (const voice of this.voices) {
      if (voice.unitId === null) continue;
      if (this.wanted.includes(voice.unitId) || this.withinRelease(ctx, voice.unitId)) {
        held.add(voice.unitId);
        continue;
      }
      voice.unitId = null;
      this.setSiren(voice, 0, SIREN_FADE_OUT);
      this.setEngine(voice, 0);
    }

    for (const id of this.wanted) {
      if (held.has(id)) continue;
      const voice = this.freeVoice();
      if (!voice) break;
      voice.unitId = id;
      held.add(id);
    }
  }

  private withinRelease(ctx: PoliceAudioContext, id: number): boolean {
    for (const unit of ctx.units) {
      if (unit.id !== id) continue;
      const dx = unit.x - ctx.x;
      const dz = unit.z - ctx.z;
      return dx * dx + dz * dz <= RELEASE_RADIUS * RELEASE_RADIUS;
    }
    return false;
  }

  /**
   * An idle voice, growing the pool up to its ceiling on demand.
   *
   * Voices are never torn down until `dispose`: a stopped `AudioBufferSourceNode`
   * cannot be restarted, and a second pursuit has to work. An unassigned voice
   * is two sources running at gain zero, which costs a multiply.
   */
  private freeVoice(): UnitVoice | null {
    for (const voice of this.voices) if (voice.unitId === null) return voice;
    if (this.voices.length >= MAX_UNITS) return null;

    const ctx = this.host.context;
    const bus = this.host.positionalEffectsBus;
    if (!ctx || !bus) return null;

    const sirenBuffer = this.host.bufferFor(POLICE_SOUNDS.siren);
    const engineBuffer = this.host.bufferFor(POLICE_SOUNDS.engine);
    if (!sirenBuffer || !engineBuffer) {
      if (!this.requested) {
        this.requested = true;
        this.preload();
      }
      return null;
    }

    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = SIREN_REF_DISTANCE;
    panner.maxDistance = SIREN_MAX_DISTANCE;
    panner.rolloffFactor = SIREN_ROLLOFF;
    panner.connect(bus);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = FILTER_NEAR_HZ;
    filter.Q.value = 0.6;
    filter.connect(panner);

    const sirenGain = ctx.createGain();
    sirenGain.gain.value = 0;
    sirenGain.connect(filter);
    const siren = this.startLoop(ctx, sirenBuffer, sirenGain, POLICE_SOUNDS.siren);

    // The engine bypasses the siren's lowpass: it is already low-frequency, and
    // a duplicate biquad per unit buys nothing audible for another node.
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    engineGain.connect(panner);
    const engine = this.startLoop(ctx, engineBuffer, engineGain, POLICE_SOUNDS.engine);

    // Two sources, two gains, the filter and the shared panner.
    this.liveNodes += 6;

    const voice: UnitVoice = {
      siren,
      sirenGain,
      filter,
      engine,
      engineGain,
      panner,
      unitId: null,
      seen: false,
      sirenLevel: 0,
      engineLevel: 0,
      rate: 1,
      cutoff: FILTER_NEAR_HZ,
    };
    this.voices.push(voice);
    return voice;
  }

  // -- shared plumbing -------------------------------------------------------

  private startLoop(
    ctx: AudioContext,
    buffer: AudioBuffer,
    target: AudioNode,
    id: AudioAssetId,
  ): AudioBufferSourceNode {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const duration = getAudioAsset(id).duration;
    if (duration > LOOP_TRIM * 4) {
      source.loopStart = LOOP_TRIM;
      source.loopEnd = duration - LOOP_TRIM;
    }
    source.connect(target);
    source.start();
    return source;
  }

  private setPanner(panner: PannerNode, x: number, y: number, z: number): void {
    if (panner.positionX) {
      panner.positionX.value = x;
      panner.positionY.value = y;
      panner.positionZ.value = z;
    } else if (typeof panner.setPosition === 'function') {
      panner.setPosition(x, y, z);
    }
  }

  /**
   * Ramps, or assigns while the context is suspended.
   *
   * `AudioDirector.setGamePaused` freezes `currentTime`, and a ramp scheduled
   * against a frozen clock is a ramp with zero duration that stacks on every
   * other one. The frame loop is gated while paused, but this layer must not
   * depend on that being true to stay correct.
   */
  private ramp(param: AudioParam, value: number, seconds: number): void {
    const ctx = this.host.context;
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      param.value = value;
      return;
    }
    const now = ctx.currentTime;
    try {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(value, now + seconds);
    } catch {
      param.value = value;
    }
  }

  private disconnect(node: AudioNode): void {
    try {
      node.disconnect();
    } catch {
      /* Already disconnected. */
    }
  }

  /** Releases every node this layer owns. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const voice of this.voices) {
      for (const source of [voice.siren, voice.engine]) {
        try {
          source.stop();
        } catch {
          /* Already stopped. */
        }
        this.disconnect(source);
      }
      this.disconnect(voice.sirenGain);
      this.disconnect(voice.engineGain);
      this.disconnect(voice.filter);
      this.disconnect(voice.panner);
      this.liveNodes -= 6;
    }
    this.voices.length = 0;
    this.loudestSiren = 0;
  }
}
