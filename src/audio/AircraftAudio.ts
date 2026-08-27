/**
 * Aeroplanes, the runway under them, and the airfield around them.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   const airAudio = new AircraftAudio(audio);    // audio: AudioBusHost
 *
 *   // the air layer's own callbacks, routed straight through:
 *   air.onEngine    = (frame) => airAudio.engine(frame);
 *   air.onTouchdown = (x, y, z, verticalSpeed) => airAudio.touchdown(x, y, z, verticalSpeed);
 *   air.onImpact    = (x, y, z, severity) => airAudio.impact(x, y, z, severity);
 *
 *   // once per frame, AFTER every onEngine for that frame:
 *   airAudio.update(dt, {
 *     x: listenerX, y: listenerY, z: listenerZ,
 *     indoors: state.indoors,
 *     inCockpit: flying,          // the player is INSIDE an aircraft
 *     airfieldDistance: metres,   // to the apron, for the terminal bed
 *   });
 *
 *   airAudio.dispose();                            // on unload
 *
 * `engine` is a per-aircraft, per-frame push rather than a list the mixer
 * pulls, because the air layer already iterates its aircraft and a second
 * iteration here would just be the same loop with a different owner. Frames are
 * accumulated and consumed by the next `update`; an aircraft that stops being
 * reported is faded out and its voice released, so a destroyed aeroplane needs
 * no explicit teardown call.
 *
 * ============================================================================
 *
 * ## What makes the noise
 *
 *   - one powerplant loop per aircraft TYPE, pitched by rpm and opened up by
 *     throttle. Four separate assets rather than one pitched four ways,
 *     because a piston single, a turboprop, a business jet and a narrowbody
 *     are four different machines and a playback rate cannot fake that;
 *   - runway roll, summed under any aircraft that is on the ground and moving,
 *     which is what makes a take-off run and a landing rollout read as contact
 *     with the ground rather than as an aeroplane hovering;
 *   - wind, whose level follows airspeed. Inside the cockpit it is louder and
 *     duller - the same asset through a lowpass, because that is what a
 *     windscreen does - and outside it belongs to the nearest aircraft;
 *   - a touchdown chirp, scaled by how hard the aeroplane arrived;
 *   - wheel brakes and reverse thrust, derived from the airspeed the air layer
 *     is already reporting rather than from a callback nobody would remember to
 *     fire;
 *   - the apron bed, a distance-driven layer exactly like the sea: it sums on
 *     top of whichever land bed is playing rather than replacing one.
 *
 * ## Budget
 *
 *   aircraft voices   MAX_VOICES * (source + gain + filter + panner) = 12
 *   runway roll       1 source + 1 gain + 1 panner                   =  3
 *   wind              1 source + 1 gain + 1 filter                   =  3
 *   apron bed         1 source + 1 gain                              =  2
 *   touchdowns etc.   MAX_SHOTS in flight, 3 nodes each              =  9
 *
 * 20 persistent and 9 transient, all allocated once and reassigned. Reported by
 * `stats.liveNodes` so a test can prove it rather than trusting this comment.
 *
 * ## Lazy loading
 *
 * Every asset here is outside the eager preload set (`LAZY_ASSET_IDS`): the
 * airfield is one corner of the map and 1.08 MB of the manifest. Each voice
 * therefore has to survive a null buffer for as long as the fetch takes, which
 * it does the same way the sea bed does - request once, stay silent, try again
 * next frame. `preload()` is there for a caller that wants to hide even that
 * one quiet frame by warming the set as the player approaches.
 */

import type { AudioBusHost } from './AudioDirector';
import {
  AIRCRAFT_ENGINES,
  AIRCRAFT_SOUNDS,
  AIRPORT_BED,
  getAudioAsset,
  VEHICLE_SOUNDS,
} from './manifest';
import type { AudioAssetId } from './manifest';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** The aircraft types the air layer publishes. */
export type AircraftType = keyof typeof AIRCRAFT_ENGINES;

/**
 * How many aircraft are voiced at once.
 *
 * Three is the number of aeroplanes that can plausibly be worth hearing at the
 * same time from one point on a small regional field - one on the runway, one
 * on approach, one on the apron - and each costs four nodes.
 */
const MAX_VOICES = 3;
/** Transient one-shots (touchdowns, brakes, impacts) in flight at once. */
const MAX_SHOTS = 3;

/** Distance at which an aircraft is at full level, and where it is dropped. */
const ENGINE_REF_DISTANCE = 30;
const ENGINE_MAX_DISTANCE = 900;
/**
 * Rolloff, flatter than anything else in the game.
 *
 * An airliner at full thrust is audible across a whole city, and rolling it off
 * at the street layer's 1.4 would make an aeroplane 200 m away quieter than a
 * car 30 m away, which is simply false.
 */
const ENGINE_ROLLOFF = 0.7;
/** Beyond this an aircraft gets no voice at all. */
const AUDIBLE_RADIUS = 950;
const RELEASE_RADIUS = 1100;
const REASSIGN_INTERVAL = 0.35;

/**
 * Playback rate from rpm.
 *
 * `rpm` is taken as a NORMALISED 0..1 fraction of the type's maximum, because
 * a piston single turns 2700 and a turbofan's N1 is a percentage: asking the
 * air layer to agree on a unit would be asking it to know about audio. Idle
 * sits at 0.82 of the recorded pitch and full power at 1.14, which is the
 * roughly +/- three semitone spread a real engine sweeps over its usable range.
 */
const RATE_AT_IDLE = 0.82;
const RATE_AT_FULL = 1.14;

/**
 * Throttle opens the filter rather than only raising the gain.
 *
 * An engine at high rpm and low throttle - a descent, a glide, a taxi - is
 * quieter AND duller than the same rpm under power, and level alone reads as
 * distance rather than as effort. This is the same trick the car engine curve
 * uses, for the same reason.
 */
const FILTER_CLOSED_HZ = 1400;
const FILTER_OPEN_HZ = 11000;
const IDLE_LEVEL = 0.3;

/** Runway roll: how fast an aircraft has to be rolling to be heard on it. */
const ROLL_FULL_SPEED = 60;
const ROLL_LEVEL = 0.9;

/** Wind: airspeed at which it is at full level. */
const WIND_FULL_SPEED = 90;
/** In the cockpit the airframe is between you and it. */
const WIND_COCKPIT_LEVEL = 0.85;
const WIND_COCKPIT_HZ = 1100;
const WIND_OUTSIDE_LEVEL = 0.3;
const WIND_OUTSIDE_HZ = 9000;

/** The apron bed: full level on the field, silent this far away. */
const AIRFIELD_FULL_DISTANCE = 120;
const AIRFIELD_SILENT_DISTANCE = 520;
const AIRFIELD_FADE = 1.5;

/** Braking is derived, not signalled: this much deceleration on the ground. */
const BRAKE_DECEL = 4.0;
const BRAKE_MIN_SPEED = 18;
const BRAKE_COOLDOWN = 3.0;

/** Touchdown loudness, from the vertical speed the air layer reports. */
const TOUCHDOWN_SOFT_VS = 0.6;
const TOUCHDOWN_HARD_VS = 4.0;
const TOUCHDOWN_COOLDOWN = 0.5;

/** Ramp times. Aircraft are heavy: nothing about them changes instantly. */
const LEVEL_RAMP = 0.18;
const FADE_IN = 0.4;
const FADE_OUT = 0.7;
const FILTER_RAMP = 0.25;

const GAIN_EPSILON = 0.005;
const RATE_EPSILON = 0.004;
const FILTER_EPSILON = 60;

const INDOOR_DUCK = 0.3;
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

const WIND_TRIM = dbToGain(getAudioAsset(AIRCRAFT_SOUNDS.wind).trimDb);
const ROLL_TRIM = dbToGain(getAudioAsset(AIRCRAFT_SOUNDS.runwayRoll).trimDb);
const AIRPORT_TRIM = dbToGain(getAudioAsset(AIRPORT_BED).trimDb);

// ---------------------------------------------------------------------------
// The shapes this layer reads
// ---------------------------------------------------------------------------

/** One aircraft, once per frame. Exactly the air layer's `onEngine` payload. */
export interface AircraftEngineFrame {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Engine speed as a 0..1 fraction of this type's maximum. */
  readonly rpm: number;
  /** Throttle lever position, 0..1. */
  readonly throttle: number;
  /** Airspeed in m/s. */
  readonly airspeed: number;
  readonly type: AircraftType;
  readonly onGround: boolean;
}

export interface AircraftAudioContext {
  /** Where the ears are. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly indoors: boolean;
  /** The player is inside an aircraft, so the wind is heard through glass. */
  readonly inCockpit?: boolean;
  /**
   * Distance to the airfield, for the apron bed. Omitting it leaves the bed
   * silent, which is the right behaviour for a caller with no airfield.
   */
  readonly airfieldDistance?: number;
}

export interface AircraftAudioStats {
  readonly liveNodes: number;
  /** Aircraft voices currently assigned. */
  readonly activeVoices: number;
  /** Aircraft reported to `engine()` since the last `update`. */
  readonly reported: number;
  readonly windLevel: number;
  readonly rollLevel: number;
  readonly airportLevel: number;
  /** One-shots in flight. */
  readonly shots: number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface AircraftVoice {
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly filter: BiquadFilterNode;
  readonly panner: PannerNode;
  /** The asset this voice is playing, so a type change reassigns rather than lies. */
  readonly assetId: AudioAssetId;
  aircraftId: number | null;
  seen: boolean;
  level: number;
  rate: number;
  cutoff: number;
}

interface Shot {
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly panner: PannerNode;
}

/** Per-aircraft state that survives between frames, for derived events. */
interface Track {
  airspeed: number;
  brakeCooldown: number;
}

export class AircraftAudio {
  private readonly host: AudioBusHost;
  private readonly voices: AircraftVoice[] = [];
  private readonly frames = new Map<number, AircraftEngineFrame>();
  private readonly tracks = new Map<number, Track>();
  private readonly shots = new Set<Shot>();

  private wind: { source: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode } | null =
    null;
  private windLevel = 0;
  private windCutoff = WIND_OUTSIDE_HZ;
  private windRequested = false;

  private roll: { source: AudioBufferSourceNode; gain: GainNode; panner: PannerNode } | null = null;
  private rollLevel = 0;
  private rollRequested = false;

  private bed: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
  private bedLevel = 0;
  private bedRequested = false;

  private reassignIn = 0;
  private touchdownCooldown = 0;
  private liveNodes = 0;
  private reported = 0;
  private disposed = false;

  constructor(host: AudioBusHost) {
    this.host = host;
  }

  /**
   * Warms the airfield set.
   *
   * These assets are deliberately not in the eager preload, so the first
   * aeroplane is silent for as long as the fetch takes. A caller that knows the
   * player is heading for the field can call this to hide that; calling it is
   * optional and calling it repeatedly is free.
   */
  preload(): void {
    for (const id of Object.values(AIRCRAFT_ENGINES)) this.host.requestAsset(id);
    for (const id of Object.values(AIRCRAFT_SOUNDS)) this.host.requestAsset(id);
    this.host.requestAsset(AIRPORT_BED);
  }

  get stats(): AircraftAudioStats {
    let active = 0;
    for (const voice of this.voices) if (voice.aircraftId !== null) active += 1;
    return {
      liveNodes: this.liveNodes,
      activeVoices: active,
      reported: this.reported,
      windLevel: this.windLevel,
      rollLevel: this.rollLevel,
      airportLevel: this.bedLevel,
      shots: this.shots.size,
    };
  }

  // -- the air layer's callbacks --------------------------------------------

  /**
   * Reports one aircraft for this frame.
   *
   * Last write wins for an id, so a caller that reports twice in a frame gets
   * the later state rather than two voices. The map is cleared by `update`.
   */
  engine(frame: AircraftEngineFrame): void {
    if (this.disposed) return;
    this.frames.set(frame.id, frame);
  }

  /**
   * Main gear on the runway.
   *
   * `verticalSpeed` is the rate of descent in m/s at contact and is the only
   * thing that decides how hard this reads: a greaser and an arrival that
   * bottoms the oleos are the same tyres and the same concrete, and the panner
   * cannot express the difference between them.
   */
  touchdown(x: number, y: number, z: number, verticalSpeed: number): void {
    if (this.disposed || this.touchdownCooldown > 0) return;
    this.touchdownCooldown = TOUCHDOWN_COOLDOWN;
    const severity = clamp01(
      (Math.abs(verticalSpeed) - TOUCHDOWN_SOFT_VS) / (TOUCHDOWN_HARD_VS - TOUCHDOWN_SOFT_VS),
    );
    const id = AIRCRAFT_SOUNDS.touchdown;
    // A firm arrival is both louder and lower: more mass arriving, less chirp.
    this.playAt(
      id,
      x,
      y,
      z,
      dbToGain(getAudioAsset(id).trimDb) * (0.45 + 0.55 * severity),
      1.06 - 0.14 * severity,
      ENGINE_REF_DISTANCE,
      ENGINE_MAX_DISTANCE,
    );
  }

  /**
   * An aircraft hitting something.
   *
   * `severity` is 0..1. It picks the asset as well as the level, because a
   * wingtip against a hangar door and a gear collapse are not one recording at
   * two volumes: below the threshold this is the light vehicle knock, above it
   * the heavy structural crunch, and the two overlap in the middle so there is
   * no audible step at the boundary.
   */
  impact(x: number, y: number, z: number, severity: number): void {
    if (this.disposed) return;
    const level = clamp01(severity);
    const id = level < 0.45 ? VEHICLE_SOUNDS.impactLight : VEHICLE_SOUNDS.impactHeavy;
    const scale = level < 0.45 ? 0.5 + level : 0.55 + 0.45 * level;
    this.playAt(
      id,
      x,
      y,
      z,
      dbToGain(getAudioAsset(id).trimDb) * scale,
      // An aeroplane is bigger than a car, so the same collision is lower.
      0.86 + Math.random() * 0.1,
      ENGINE_REF_DISTANCE,
      ENGINE_MAX_DISTANCE,
    );
  }

  // -- frame -----------------------------------------------------------------

  /** Called once per frame, after every `engine()` for that frame. */
  update(dt: number, ctx: AircraftAudioContext): void {
    if (this.disposed) return;
    const step = dt > 0 && dt < 0.5 ? dt : 1 / 60;
    this.touchdownCooldown = Math.max(0, this.touchdownCooldown - step);
    this.reported = this.frames.size;

    this.reassignIn -= step;
    if (this.reassignIn <= 0) {
      this.reassignIn = REASSIGN_INTERVAL;
      this.reassign(ctx);
    }

    for (const voice of this.voices) voice.seen = false;

    // One pass over the reported aircraft serves the voices, the runway roll,
    // the wind and the derived braking.
    let rollWeight = 0;
    let nearestAirspeed = 0;
    let nearestSq = Infinity;
    for (const frame of this.frames.values()) {
      this.updateTrack(frame, step, ctx);

      const dx = frame.x - ctx.x;
      const dz = frame.z - ctx.z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq < nearestSq) {
        nearestSq = distanceSq;
        nearestAirspeed = frame.airspeed;
      }
      if (frame.onGround && distanceSq < AUDIBLE_RADIUS * AUDIBLE_RADIUS) {
        rollWeight = Math.max(rollWeight, clamp01(Math.abs(frame.airspeed) / ROLL_FULL_SPEED));
      }

      for (const voice of this.voices) {
        if (voice.aircraftId !== frame.id) continue;
        voice.seen = true;
        this.driveVoice(voice, frame, ctx);
        break;
      }
    }

    for (const voice of this.voices) {
      if (voice.aircraftId === null || voice.seen) continue;
      voice.aircraftId = null;
      this.setVoiceLevel(voice, 0, FADE_OUT);
    }

    this.updateRoll(rollWeight, ctx);
    this.updateWind(ctx, nearestAirspeed);
    this.updateBed(ctx);

    // Tracks for aircraft that stopped being reported are dropped here rather
    // than on a timer: the air layer owns their lifetime, not this module.
    for (const id of [...this.tracks.keys()]) {
      if (!this.frames.has(id)) this.tracks.delete(id);
    }
    this.frames.clear();
  }

  // -- per-aircraft ----------------------------------------------------------

  /**
   * Derives what the air layer does not signal.
   *
   * Braking is the interesting one: the callbacks are engine, touchdown and
   * impact, and asking for a fourth would put an audio concern in the flight
   * model. Deceleration on the ground is already implied by two consecutive
   * airspeed samples, so it is measured here instead - the same way
   * `StreetAudio` finds a car's collision from its speed collapsing.
   */
  private updateTrack(frame: AircraftEngineFrame, dt: number, ctx: AircraftAudioContext): void {
    let track = this.tracks.get(frame.id);
    if (!track) {
      track = { airspeed: frame.airspeed, brakeCooldown: 0 };
      this.tracks.set(frame.id, track);
      return;
    }
    track.brakeCooldown = Math.max(0, track.brakeCooldown - dt);
    const decel = (track.airspeed - frame.airspeed) / dt;
    track.airspeed = frame.airspeed;

    if (
      frame.onGround &&
      decel > BRAKE_DECEL &&
      frame.airspeed > BRAKE_MIN_SPEED &&
      track.brakeCooldown <= 0
    ) {
      track.brakeCooldown = BRAKE_COOLDOWN;
      const id = AIRCRAFT_SOUNDS.brake;
      const severity = clamp01((decel - BRAKE_DECEL) / BRAKE_DECEL);
      this.playAt(
        id,
        frame.x,
        frame.y,
        frame.z,
        dbToGain(getAudioAsset(id).trimDb) * (0.5 + 0.5 * severity) * (ctx.indoors ? INDOOR_DUCK : 1),
        0.95 + Math.random() * 0.1,
        ENGINE_REF_DISTANCE,
        ENGINE_MAX_DISTANCE,
      );
    }
  }

  private driveVoice(
    voice: AircraftVoice,
    frame: AircraftEngineFrame,
    ctx: AircraftAudioContext,
  ): void {
    this.setPanner(voice.panner, frame.x, frame.y, frame.z);

    const rpm = clamp01(frame.rpm);
    const throttle = clamp01(frame.throttle);
    const rate = RATE_AT_IDLE + (RATE_AT_FULL - RATE_AT_IDLE) * rpm;
    if (moved(rate, voice.rate, RATE_EPSILON)) {
      voice.rate = rate;
      this.ramp(voice.source.playbackRate, rate, LEVEL_RAMP);
    }

    const cutoff = FILTER_CLOSED_HZ + (FILTER_OPEN_HZ - FILTER_CLOSED_HZ) * throttle;
    if (moved(cutoff, voice.cutoff, FILTER_EPSILON)) {
      voice.cutoff = cutoff;
      this.ramp(voice.filter.frequency, cutoff, FILTER_RAMP);
    }

    // Level follows the two together: rpm is how fast it is turning and
    // throttle is how hard it is working, and an engine windmilling at speed
    // with the levers back is genuinely quiet.
    const effort = IDLE_LEVEL + (1 - IDLE_LEVEL) * clamp01(rpm * 0.45 + throttle * 0.55);
    const trim = dbToGain(getAudioAsset(voice.assetId).trimDb);
    this.setVoiceLevel(voice, trim * effort * (ctx.indoors ? INDOOR_DUCK : 1), LEVEL_RAMP);
  }

  private setVoiceLevel(voice: AircraftVoice, level: number, seconds: number): void {
    if (Math.abs(level - voice.level) < GAIN_EPSILON) return;
    voice.level = level;
    this.ramp(voice.gain.gain, level, seconds);
  }

  // -- assignment ------------------------------------------------------------

  /**
   * Gives the pool the nearest aircraft.
   *
   * A voice is bound to ONE powerplant asset for its whole life, because the
   * buffer cannot be swapped on a running source. An aircraft whose type has no
   * free voice of that type simply does not get one this tick, which is
   * correct: pretending a turbofan is a piston single would be worse than
   * silence.
   */
  private reassign(ctx: AircraftAudioContext): void {
    const held = new Set<number>();
    for (const voice of this.voices) {
      if (voice.aircraftId === null) continue;
      if (this.withinRelease(ctx, voice.aircraftId)) held.add(voice.aircraftId);
      else {
        voice.aircraftId = null;
        this.setVoiceLevel(voice, 0, FADE_OUT);
      }
    }

    // Nearest first, so a full pool holds the aircraft that matter.
    const ranked = [...this.frames.values()]
      .map((frame) => {
        const dx = frame.x - ctx.x;
        const dz = frame.z - ctx.z;
        return { frame, distanceSq: dx * dx + dz * dz };
      })
      .filter((entry) => entry.distanceSq <= AUDIBLE_RADIUS * AUDIBLE_RADIUS)
      .sort((a, b) => a.distanceSq - b.distanceSq);

    for (const { frame } of ranked) {
      if (held.has(frame.id)) continue;
      const voice = this.freeVoice(frame.type);
      if (!voice) continue;
      voice.aircraftId = frame.id;
      held.add(frame.id);
    }
  }

  private withinRelease(ctx: AircraftAudioContext, id: number): boolean {
    const frame = this.frames.get(id);
    if (!frame) return false;
    const dx = frame.x - ctx.x;
    const dz = frame.z - ctx.z;
    return dx * dx + dz * dz <= RELEASE_RADIUS * RELEASE_RADIUS;
  }

  private freeVoice(type: AircraftType): AircraftVoice | null {
    const assetId = AIRCRAFT_ENGINES[type];
    for (const voice of this.voices) {
      if (voice.aircraftId === null && voice.assetId === assetId) return voice;
    }
    if (this.voices.length >= MAX_VOICES) {
      // The pool is full of the wrong types. Steal an idle voice by releasing
      // it; it comes back as the right type the next time it is asked for.
      const idle = this.voices.findIndex((v) => v.aircraftId === null);
      if (idle < 0) return null;
      const voice = this.voices[idle] as AircraftVoice;
      this.stopVoice(voice);
      this.voices.splice(idle, 1);
      this.liveNodes -= 4;
    }

    const ctx = this.host.context;
    const bus = this.host.positionalEffectsBus;
    if (!ctx || !bus) return null;
    const buffer = this.host.bufferFor(assetId);
    if (!buffer) {
      this.host.requestAsset(assetId);
      return null;
    }

    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = ENGINE_REF_DISTANCE;
    panner.maxDistance = ENGINE_MAX_DISTANCE;
    panner.rolloffFactor = ENGINE_ROLLOFF;
    panner.connect(bus);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = FILTER_OPEN_HZ;
    filter.Q.value = 0.6;
    filter.connect(panner);

    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(filter);
    const source = this.startLoop(ctx, buffer, gain, assetId);
    this.liveNodes += 4;

    const voice: AircraftVoice = {
      source,
      gain,
      filter,
      panner,
      assetId,
      aircraftId: null,
      seen: false,
      level: 0,
      rate: 1,
      cutoff: FILTER_OPEN_HZ,
    };
    this.voices.push(voice);
    return voice;
  }

  // -- the shared layers -----------------------------------------------------

  /**
   * Runway roll, one voice for the whole field rather than one per aircraft.
   *
   * Tyre rumble on concrete is broadband and low, which an HRTF panner places
   * badly anyway, and two aeroplanes rolling at once do not sound like two
   * rumbles - they sound like a louder one. The voice follows the loudest
   * roller, panned at it.
   */
  private updateRoll(weight: number, ctx: AircraftAudioContext): void {
    const target = weight * ROLL_LEVEL * ROLL_TRIM * (ctx.indoors ? INDOOR_DUCK : 1);
    if (!this.roll) {
      if (target <= 0.001 || this.rollRequested) return;
      const audio = this.host.context;
      const bus = this.host.positionalEffectsBus;
      if (!audio || !bus) return;
      const buffer = this.host.bufferFor(AIRCRAFT_SOUNDS.runwayRoll);
      if (!buffer) {
        this.host.requestAsset(AIRCRAFT_SOUNDS.runwayRoll);
        return;
      }
      this.rollRequested = true;
      const panner = audio.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = ENGINE_REF_DISTANCE;
      panner.maxDistance = ENGINE_MAX_DISTANCE;
      panner.rolloffFactor = ENGINE_ROLLOFF;
      panner.connect(bus);
      const gain = audio.createGain();
      gain.gain.value = 0;
      gain.connect(panner);
      const source = this.startLoop(audio, buffer, gain, AIRCRAFT_SOUNDS.runwayRoll);
      this.liveNodes += 3;
      this.roll = { source, gain, panner };
      return;
    }

    // Follow whichever aircraft is rolling hardest, so the rumble is where the
    // aeroplane is rather than at the listener's feet.
    let bestWeight = -1;
    for (const frame of this.frames.values()) {
      if (!frame.onGround) continue;
      const w = clamp01(Math.abs(frame.airspeed) / ROLL_FULL_SPEED);
      if (w <= bestWeight) continue;
      bestWeight = w;
      this.setPanner(this.roll.panner, frame.x, frame.y, frame.z);
    }

    if (Math.abs(target - this.rollLevel) < GAIN_EPSILON) return;
    this.rollLevel = target;
    this.ramp(this.roll.gain.gain, target, LEVEL_RAMP);
  }

  /**
   * Airflow, flat and unpanned.
   *
   * Wind is not somewhere: outside it belongs to the nearest aircraft and
   * inside it is on the other side of the windscreen, and neither is a point in
   * space. It goes through the dry effects bus, the same decision `CombatAudio`
   * makes for the player's own body.
   */
  private updateWind(ctx: AircraftAudioContext, nearestAirspeed: number): void {
    const inCockpit = ctx.inCockpit === true;
    const share = clamp01(Math.abs(nearestAirspeed) / WIND_FULL_SPEED);
    const ceiling = inCockpit ? WIND_COCKPIT_LEVEL : WIND_OUTSIDE_LEVEL;
    const target = this.frames.size === 0 ? 0 : share * ceiling * WIND_TRIM;

    if (!this.wind) {
      if (target <= 0.001 || this.windRequested) return;
      const audio = this.host.context;
      const bus = this.host.effectsBus;
      if (!audio || !bus) return;
      const buffer = this.host.bufferFor(AIRCRAFT_SOUNDS.wind);
      if (!buffer) {
        this.host.requestAsset(AIRCRAFT_SOUNDS.wind);
        return;
      }
      this.windRequested = true;
      const filter = audio.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = WIND_OUTSIDE_HZ;
      filter.Q.value = 0.5;
      filter.connect(bus);
      const gain = audio.createGain();
      gain.gain.value = 0;
      gain.connect(filter);
      const source = this.startLoop(audio, buffer, gain, AIRCRAFT_SOUNDS.wind);
      this.liveNodes += 3;
      this.wind = { source, gain, filter };
      return;
    }

    const cutoff = inCockpit ? WIND_COCKPIT_HZ : WIND_OUTSIDE_HZ;
    if (moved(cutoff, this.windCutoff, FILTER_EPSILON)) {
      this.windCutoff = cutoff;
      this.ramp(this.wind.filter.frequency, cutoff, FILTER_RAMP);
    }
    if (Math.abs(target - this.windLevel) < GAIN_EPSILON) return;
    this.windLevel = target;
    this.ramp(this.wind.gain.gain, target, target > 0 ? FADE_IN : FADE_OUT);
  }

  /**
   * The apron bed.
   *
   * Distance-driven and summed on top of whichever land bed the director is
   * playing, exactly like the sea: standing on the apron you hear the field AND
   * the city behind it, and a street two districts away hears neither the field
   * nor a hole where its own bed should have been.
   */
  private updateBed(ctx: AircraftAudioContext): void {
    const distance = ctx.airfieldDistance;
    const target =
      distance === undefined
        ? 0
        : clamp01(
            1 -
              (distance - AIRFIELD_FULL_DISTANCE) /
                (AIRFIELD_SILENT_DISTANCE - AIRFIELD_FULL_DISTANCE),
          ) *
          AIRPORT_TRIM *
          (ctx.indoors ? INDOOR_DUCK : 1);

    if (!this.bed) {
      if (target <= 0.001 || this.bedRequested) return;
      const audio = this.host.context;
      const bus = this.host.ambienceLayerBus;
      if (!audio || !bus) return;
      const buffer = this.host.bufferFor(AIRPORT_BED);
      if (!buffer) {
        this.host.requestAsset(AIRPORT_BED);
        return;
      }
      this.bedRequested = true;
      const gain = audio.createGain();
      gain.gain.value = 0;
      gain.connect(bus);
      const source = this.startLoop(audio, buffer, gain, AIRPORT_BED);
      this.liveNodes += 2;
      this.bed = { source, gain };
      return;
    }

    if (Math.abs(target - this.bedLevel) < GAIN_EPSILON) return;
    this.bedLevel = target;
    this.ramp(this.bed.gain.gain, target, AIRFIELD_FADE);
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

  private playAt(
    id: AudioAssetId,
    x: number,
    y: number,
    z: number,
    gainValue: number,
    rate: number,
    refDistance: number,
    maxDistance: number,
  ): void {
    const ctx = this.host.context;
    const bus = this.host.positionalEffectsBus;
    if (!ctx || !bus || this.shots.size >= MAX_SHOTS) return;
    const buffer = this.host.bufferFor(id);
    if (!buffer) {
      this.host.requestAsset(id);
      return;
    }

    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDistance;
    panner.maxDistance = maxDistance;
    panner.rolloffFactor = ENGINE_ROLLOFF;
    panner.connect(bus);
    this.setPanner(panner, x, y, z);

    const gain = ctx.createGain();
    gain.gain.value = gainValue;
    gain.connect(panner);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.connect(gain);

    const shot: Shot = { source, gain, panner };
    this.shots.add(shot);
    this.liveNodes += 3;
    source.onended = (): void => this.releaseShot(shot);
    source.start();
  }

  private releaseShot(shot: Shot): void {
    if (!this.shots.delete(shot)) return;
    this.liveNodes -= 3;
    shot.source.onended = null;
    this.disconnect(shot.source);
    this.disconnect(shot.gain);
    this.disconnect(shot.panner);
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

  /** Ramps, or assigns while the context is suspended. See `PoliceAudio.ramp`. */
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

  private stopVoice(voice: AircraftVoice): void {
    voice.source.onended = null;
    try {
      voice.source.stop();
    } catch {
      /* Already stopped. */
    }
    this.disconnect(voice.source);
    this.disconnect(voice.gain);
    this.disconnect(voice.filter);
    this.disconnect(voice.panner);
  }

  /** Releases every node this layer owns, one-shots in flight included. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const shot of [...this.shots]) {
      shot.source.onended = null;
      try {
        shot.source.stop();
      } catch {
        /* Already stopped. */
      }
      this.releaseShot(shot);
    }
    this.shots.clear();

    for (const voice of this.voices) {
      this.stopVoice(voice);
      this.liveNodes -= 4;
    }
    this.voices.length = 0;

    for (const layer of [this.roll, this.wind, this.bed]) {
      if (!layer) continue;
      try {
        layer.source.stop();
      } catch {
        /* Already stopped. */
      }
      this.disconnect(layer.source);
      this.disconnect(layer.gain);
    }
    if (this.roll) {
      this.disconnect(this.roll.panner);
      this.liveNodes -= 3;
    }
    if (this.wind) {
      this.disconnect(this.wind.filter);
      this.liveNodes -= 3;
    }
    if (this.bed) this.liveNodes -= 2;
    this.roll = null;
    this.wind = null;
    this.bed = null;

    this.frames.clear();
    this.tracks.clear();
  }
}
