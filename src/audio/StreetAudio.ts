/**
 * Everything in Meridian Bay that moves and therefore makes a noise.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   import { StreetAudio } from './audio/StreetAudio';
 *
 *   const street = new StreetAudio({
 *     host: audio,                                  // the AudioDirector
 *     surfaceAt: (x, z) => ground.sample(x, z).surface,
 *   });
 *
 *   // once per frame, AFTER traffic.update and pedestrians.update
 *   street.update(dt, {
 *     x: state.x, y: state.y, z: state.z,
 *     indoors: state.indoors,
 *     driving: drive.driving,
 *     driveSpeed: drive.speed,                      // SIGNED, m/s
 *     vehicles: traffic.vehicles,
 *     crowd: pedestrians.group,
 *   });
 *
 *   street.dispose();                               // on unload
 *
 * There is no `group`: this layer adds nothing to the scene. It reads the
 * simulation the renderer is already reading and produces sound from it.
 *
 * ============================================================================
 *
 * ## What it makes a noise about
 *
 *   - the player's engine, as two crossfaded loops through a lowpass whose
 *     pitch, level and colour come from `engineCurve.ts`;
 *   - up to five nearby ambient cars, one panned tyre-roll loop each;
 *   - tyre scrub when anything brakes hard, the player included;
 *   - the car door on the way in and the way out;
 *   - a collision thud when the player hits something;
 *   - the footfalls of nearby pedestrians, on the right surface;
 *   - a distant traffic hum whose level is how much traffic is actually moving.
 *
 * ## Budgets, because 140 cars and 270 people is not a mixing suggestion
 *
 * Every looping voice in here comes from a fixed pool that is allocated once
 * and then reassigned - an `AudioBufferSourceNode` cannot be restarted after it
 * is stopped, so a system that created one per car would either leak or fall
 * silent. Unassigned voices are ramped to zero and left running, which costs a
 * gain multiply and buys immunity from node churn.
 *
 *   player engine     2 looping sources, 1 filter, 3 gains   (allocated once)
 *   ambient cars      5 looping sources, 5 panners, 5 gains  (allocated once)
 *   distant hum       1 looping source, 1 gain               (allocated once)
 *   crowd footsteps   MAX_STEP_VOICES at a time, MAX 3 nodes each
 *   other one-shots   MAX_OTHER_VOICES at a time, self-releasing on `ended`
 *
 * 23 persistent nodes, and a transient tail capped by voice COUNT rather than
 * by a rate limiter - 65 nodes in the absolute worst case, whatever the
 * population, the frame rate or the relationship between simulated and real
 * time. The rate limiters alone were not enough; see MAX_STEP_VOICES.
 * `stats.liveNodes` is exported so a test can prove it over a long run rather
 * than trusting this comment.
 *
 * ## Why pedestrian positions come out of the instance matrices
 *
 * `PedestrianSystem` publishes `group` and `stats` and nothing else; the crowd
 * itself is private, and this module is not allowed to widen that. The rendered
 * instances are exactly the people near the player - the system compacts them
 * to the front of each buffer and sets `count` to the number drawn - so reading
 * the translation out of `instanceMatrix` gives precisely the set worth making
 * a sound for, with no new coupling and no second culling pass.
 *
 * Identity is recovered by nearest-neighbour association between frames, and
 * steps are emitted per METRE WALKED rather than on a clock, so somebody
 * waiting at a crossing is silent and somebody hurrying past is not.
 */

import type { AudioBusHost } from './AudioDirector';
import {
  ambientLevel,
  ambientRate,
  engineTone,
  loadFromAcceleration,
  type EngineTone,
} from './engineCurve';
import { getAudioAsset, STEP_SURFACES, TRAFFIC_HUM, VEHICLE_SOUNDS } from './manifest';
import type { AudioAssetId } from './manifest';
import type { SurfaceId } from '../world/CityGround';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Level of the player's engine before the effects bus trim. */
const ENGINE_LEVEL = 0.88;
/**
 * How long the engine takes to arrive and to go away.
 *
 * Fast enough that the car is already sounding by the time the camera has
 * settled behind it, slow enough that it is a start rather than a click.
 */
const ENGINE_FADE_IN = 0.22;
const ENGINE_FADE_OUT = 0.35;

/** Parameter ramp times. Short: these are corrections, not transitions. */
const RATE_RAMP = 0.07;
const MIX_RAMP = 0.1;
const GAIN_RAMP = 0.06;
const FILTER_RAMP = 0.08;

/**
 * Re-ramp thresholds. Below these the change is inaudible, so a frame in which
 * nothing much happened schedules no Web Audio work at all - the same trick the
 * sea layer uses, and the reason this can run at 120 Hz.
 */
const RATE_EPSILON = 0.004;
const GAIN_EPSILON = 0.006;
const FILTER_EPSILON = 25;

/** How fast the load estimate chases the measured acceleration. */
const LOAD_TAU = 0.16;

/**
 * Deceleration, in m/s squared, that can only be an impact.
 *
 * The heaviest brakes in the catalogue are an order of magnitude below this and
 * the driving layer's collision response scrubs speed multiplicatively in a
 * single frame, so 40 separates the two cleanly at any frame rate a player
 * would tolerate. Entering and leaving a car also step the speed, and those are
 * masked by `settleFrames` instead.
 */
const IMPACT_DECEL = 40;
const IMPACT_MIN_SPEED = 2;
const IMPACT_COOLDOWN = 0.35;

/** Frames after a control handover in which speed steps are not real. */
const SETTLE_FRAMES = 3;

/** Player braking hard enough to scrub, and how often that may be heard. */
const PLAYER_SCRUB_DECEL = 5.5;
const PLAYER_SCRUB_SPEED = 6;
const SCRUB_COOLDOWN = 0.7;

/** Ambient cars: how many voices, how far they carry, when they are released. */
const TRAFFIC_VOICES = 5;
const TRAFFIC_RADIUS = 55;
const TRAFFIC_RELEASE = 72;
const TRAFFIC_REASSIGN = 0.25;
const TRAFFIC_REF_DISTANCE = 7;
/** Ambient braking loud enough to be worth a scrub, and how near it must be. */
const TRAFFIC_SCRUB_SPEED = 6;
const TRAFFIC_SCRUB_RADIUS = 34;
const TRAFFIC_SCRUB_COOLDOWN = 0.85;

/** Distant hum: how far cars contribute, and how quickly the level follows. */
const HUM_RADIUS = 95;
/** Weight at which the hum is about two thirds of the way up. */
const HUM_HALF = 6;
const HUM_LEVEL = 0.62;
const HUM_TAU = 1.2;
const HUM_INDOOR_DUCK = 0.2;

/** Crowd footsteps. */
const CROWD_RADIUS = 16;
/** Hard cap on people considered in one frame, whatever the crowd renders. */
const CROWD_SCAN = 64;
/** Simultaneous walkers whose stride is followed. */
const CROWD_TRACKS = 20;
/** How near two frames' positions must be to be the same person. */
const CROWD_ASSOCIATE = 0.55;
/** A jump larger than this is a respawn across the city, not a step. */
const CROWD_TELEPORT = 0.6;
/** Metres walked per footfall. A little over half an average stride length. */
const CROWD_STRIDE = 0.78;
/** How long a track survives without being matched. */
const CROWD_TRACK_TTL = 0.4;
/** Footsteps per second across the whole crowd, and the burst it may bank. */
const CROWD_STEP_RATE = 9;
const CROWD_STEP_BURST = 3;

/**
 * Hard ceilings on transient voices, independent of the rate limiters.
 *
 * The rate limiters count SIMULATED seconds and a voice ends after a real one,
 * so they only bound the mix while the two clocks agree. They do not during a
 * frame-rate collapse, and they emphatically do not under the `step()` QA
 * harness, which runs thirty seconds of simulation inside one second of wall
 * clock: measured, that stacked 420 live nodes out of an intended twenty-odd.
 *
 * These caps are counted against voices actually in flight, so the ceiling
 * holds whatever the two clocks are doing. Footsteps get the lower budget and
 * are counted separately, so a crowded pavement can never starve the door the
 * player just opened.
 */
const MAX_STEP_VOICES = 8;
const MAX_OTHER_VOICES = 6;
/** Other people's feet sit under the player's own. */
const CROWD_STEP_DB = -4;
const CROWD_STEP_JITTER_DB = 2.5;
const CROWD_STEP_PITCH_JITTER = 0.07;
const CROWD_STEP_REF_DISTANCE = 2.5;

/** Car doors: the gap between the door opening and it being pulled shut. */
const DOOR_CLOSE_DELAY = 0.45;

/**
 * MP3 encoder delay and padding, in seconds.
 *
 * A decoded MP3 carries a little silence at each end that the encoder added,
 * and looping straight over it puts a hole in a sustained engine every few
 * seconds. Every looping source here is given a `loopStart`/`loopEnd` just
 * inside the buffer, which costs 60 ms of a seven-second loop and removes it.
 */
const LOOP_TRIM = 0.03;

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** True when a parameter has drifted far enough to be worth re-scheduling. */
function moved(value: number, previous: number, epsilon: number): boolean {
  return Math.abs(value - previous) >= epsilon;
}

/** Hoisted so a per-frame mix never pays for a `Math.pow` or a map lookup. */
const AMBIENT_TRIM = dbToGain(getAudioAsset(VEHICLE_SOUNDS.engineFar).trimDb);
const HUM_TRIM = dbToGain(getAudioAsset(TRAFFIC_HUM).trimDb);
/** The engine's resting state, reported while the player is on foot. */
const SILENT_TONE: EngineTone = engineTone(0, 0);

// ---------------------------------------------------------------------------
// The shapes this layer reads
// ---------------------------------------------------------------------------

/**
 * What a vehicle has to look like to be heard. Structurally a subset of the
 * traffic system's `VehicleView`, so `traffic.vehicles` can be passed straight
 * in without either module importing the other.
 */
export interface VehicleAudioView {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Forward speed in m/s. */
  readonly speed: number;
  readonly braking: boolean;
  readonly control: 'ambient' | 'player';
}

/**
 * What the crowd has to look like. Structurally a subset of `Object3D`, so
 * `pedestrians.group` can be passed straight in and this module still imports
 * nothing from Three.js.
 */
export interface CrowdNode {
  readonly visible: boolean;
  readonly count?: number | undefined;
  readonly instanceMatrix?: { readonly array: ArrayLike<number> } | undefined;
  readonly children?: readonly CrowdNode[] | undefined;
}

export interface StreetAudioOptions {
  readonly host: AudioBusHost;
  /**
   * Surface under a world point, so a footfall on decking does not sound like
   * one on a paving slab. Called at most `CROWD_STEP_RATE` times a second.
   */
  readonly surfaceAt: (x: number, z: number) => SurfaceId;
}

export interface StreetAudioContext {
  /** Listener position: the camera on foot, the car while driving. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly indoors: boolean;
  readonly driving: boolean;
  /** Signed forward speed of the player's car in m/s. Negative in reverse. */
  readonly driveSpeed: number;
  /** Live views, read during the frame and never retained. */
  readonly vehicles: readonly VehicleAudioView[];
  /** The pedestrian group, or null to run without crowd footsteps. */
  readonly crowd: CrowdNode | null;
}

export interface StreetAudioStats {
  /** Web Audio nodes this layer holds. Bounded; see the note at the top. */
  readonly liveNodes: number;
  /** One-shots in flight, and how many of those are crowd footsteps. */
  readonly voices: number;
  readonly stepVoices: number;
  /** Ambient car voices currently assigned to a vehicle. */
  readonly trafficVoices: number;
  /** Pedestrians whose stride is being followed this frame. */
  readonly crowdTracks: number;
  /** Footsteps emitted since construction. */
  readonly crowdSteps: number;
  /** True once the player's engine graph exists. */
  readonly engineReady: boolean;
  readonly rev: number;
  readonly engineGain: number;
  readonly engineCutoff: number;
  readonly humLevel: number;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface EngineGraph {
  readonly idle: AudioBufferSourceNode;
  readonly load: AudioBufferSourceNode;
  readonly idleGain: GainNode;
  readonly loadGain: GainNode;
  readonly filter: BiquadFilterNode;
  readonly out: GainNode;
  /** Last values pushed, so an unchanged frame schedules nothing. */
  idleRate: number;
  loadRate: number;
  idleMix: number;
  loadMix: number;
  gain: number;
  cutoff: number;
}

interface TrafficVoice {
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly panner: PannerNode;
  vehicleId: number | null;
  wasBraking: boolean;
  /** Its vehicle was found in the fleet this frame. */
  seen: boolean;
  rate: number;
  level: number;
}

/** A one-shot in flight, held so `dispose` can release it and voices counted. */
interface OneShot {
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly panner: PannerNode | null;
  /** Footsteps are budgeted separately; see MAX_STEP_VOICES. */
  readonly step: boolean;
}

interface WalkerTrack {
  active: boolean;
  x: number;
  y: number;
  z: number;
  /** Metres walked since the last footfall. */
  stride: number;
  /** Seconds since this track was last matched to a rendered person. */
  idle: number;
  matched: boolean;
}

export class StreetAudio {
  private readonly host: AudioBusHost;
  private readonly surfaceAt: (x: number, z: number) => SurfaceId;

  private engine: EngineGraph | null = null;
  private engineRequested = false;
  private engineOn = false;
  private tone: EngineTone = SILENT_TONE;

  private lastSpeed = 0;
  private smoothedLoad = 0;
  private settleFrames = SETTLE_FRAMES;
  private wasDriving = false;
  private impactCooldown = 0;
  private scrubCooldown = 0;
  private doorCloseIn = -1;

  private readonly voices: TrafficVoice[] = [];
  private voicesRequested = 0;
  private reassignIn = 0;
  private trafficScrubCooldown = 0;
  /** Vehicle ids the voices should hold, refreshed on the reassign tick. */
  private readonly wanted: number[] = [];

  private hum: { source: AudioBufferSourceNode; gain: GainNode } | null = null;
  private humRequested = false;
  private humLevel = 0;
  private humPushed = -1;
  /** Traffic weight measured by the last `updateTraffic`, consumed by the hum. */
  private humWeight = 0;

  private readonly tracks: WalkerTrack[] = [];
  private readonly nearX = new Float32Array(CROWD_SCAN);
  private readonly nearY = new Float32Array(CROWD_SCAN);
  private readonly nearZ = new Float32Array(CROWD_SCAN);
  private nearCount = 0;
  private stepBudget = CROWD_STEP_BURST;
  private stepFlip = 0;
  private crowdSteps = 0;

  private readonly shots = new Set<OneShot>();
  private stepVoices = 0;
  private liveNodes = 0;
  private disposed = false;

  constructor(options: StreetAudioOptions) {
    this.host = options.host;
    this.surfaceAt = options.surfaceAt;
    for (let i = 0; i < CROWD_TRACKS; i += 1) {
      this.tracks.push({ active: false, x: 0, y: 0, z: 0, stride: 0, idle: 0, matched: false });
    }
  }

  get stats(): StreetAudioStats {
    let assigned = 0;
    for (const voice of this.voices) if (voice.vehicleId !== null) assigned += 1;
    let tracked = 0;
    for (const track of this.tracks) if (track.active) tracked += 1;
    return {
      liveNodes: this.liveNodes,
      voices: this.shots.size,
      stepVoices: this.stepVoices,
      trafficVoices: assigned,
      crowdTracks: tracked,
      crowdSteps: this.crowdSteps,
      engineReady: this.engine !== null,
      rev: this.tone.rev,
      engineGain: this.engine ? this.engine.gain : 0,
      engineCutoff: this.engine ? this.engine.cutoff : 0,
      humLevel: this.humLevel,
    };
  }

  /** Called once per frame, after the traffic and the crowd have moved. */
  update(dt: number, ctx: StreetAudioContext): void {
    if (this.disposed) return;
    const step = dt > 0 && dt < 0.5 ? dt : 1 / 60;

    this.impactCooldown = Math.max(0, this.impactCooldown - step);
    this.scrubCooldown = Math.max(0, this.scrubCooldown - step);
    this.trafficScrubCooldown = Math.max(0, this.trafficScrubCooldown - step);
    this.stepBudget = Math.min(CROWD_STEP_BURST, this.stepBudget + CROWD_STEP_RATE * step);

    this.updateDoors(step, ctx);
    // The context may still be locked; everything below is a no-op until it is
    // not, and the door/impact bookkeeping above stays honest either way.
    this.updateEngine(step, ctx);
    this.updateTraffic(step, ctx);
    this.updateHum(step, ctx);
    if (!ctx.driving) this.updateCrowd(step, ctx);
    else this.releaseTracks();
  }

  // -- the player's car ------------------------------------------------------

  /**
   * Opens and shuts the car door around a control handover.
   *
   * Driven from the `driving` flag rather than from the key press, so this owns
   * the whole behaviour and `main.ts` does not have to remember to call it.
   */
  private updateDoors(dt: number, ctx: StreetAudioContext): void {
    if (ctx.driving !== this.wasDriving) {
      this.wasDriving = ctx.driving;
      this.settleFrames = SETTLE_FRAMES;
      this.playOneShot(VEHICLE_SOUNDS.doorOpen, 1);
      this.doorCloseIn = DOOR_CLOSE_DELAY;
    }
    if (this.doorCloseIn >= 0) {
      this.doorCloseIn -= dt;
      if (this.doorCloseIn < 0) this.playOneShot(VEHICLE_SOUNDS.doorClose, 1);
    }
  }

  private updateEngine(dt: number, ctx: StreetAudioContext): void {
    if (!ctx.driving) {
      if (this.engineOn) {
        this.engineOn = false;
        const engine = this.engine;
        if (engine) {
          this.ramp(engine.out.gain, 0, ENGINE_FADE_OUT);
          engine.gain = 0;
        }
      }
      this.lastSpeed = 0;
      this.smoothedLoad = 0;
      this.tone = SILENT_TONE;
      return;
    }

    // Acceleration from two speed samples. This is also the impact detector:
    // the driving layer resolves a collision by scrubbing speed in one frame,
    // which no brake can imitate.
    const accel = (ctx.driveSpeed - this.lastSpeed) / dt;
    const settling = this.settleFrames > 0;
    if (settling) this.settleFrames -= 1;

    if (
      !settling &&
      accel < -IMPACT_DECEL &&
      Math.abs(this.lastSpeed) > IMPACT_MIN_SPEED &&
      this.impactCooldown <= 0
    ) {
      this.impactCooldown = IMPACT_COOLDOWN;
      // Harder hits are louder, but a graze is never silent.
      const severity = clamp01((Math.abs(this.lastSpeed) - IMPACT_MIN_SPEED) / 12);
      this.playOneShot(VEHICLE_SOUNDS.impact, 0.5 + 0.5 * severity);
    }

    if (
      !settling &&
      accel < -PLAYER_SCRUB_DECEL &&
      Math.abs(this.lastSpeed) > PLAYER_SCRUB_SPEED &&
      this.scrubCooldown <= 0
    ) {
      this.scrubCooldown = SCRUB_COOLDOWN;
      this.playOneShot(VEHICLE_SOUNDS.tyreScrub, 0.85);
    }

    this.lastSpeed = ctx.driveSpeed;
    // A settling frame's acceleration is a handover artefact, not a driver.
    const target = settling ? 0 : loadFromAcceleration(accel);
    this.smoothedLoad += (target - this.smoothedLoad) * Math.min(1, dt / LOAD_TAU);

    this.tone = engineTone(ctx.driveSpeed, this.smoothedLoad);
    this.ensureEngine();
    const engine = this.engine;
    if (!engine) return;

    if (!this.engineOn) {
      this.engineOn = true;
      engine.gain = -1; // force the level push below
    }

    const tone = this.tone;
    if (moved(tone.idleRate, engine.idleRate, RATE_EPSILON)) {
      engine.idleRate = tone.idleRate;
      this.ramp(engine.idle.playbackRate, tone.idleRate, RATE_RAMP);
    }
    if (moved(tone.loadRate, engine.loadRate, RATE_EPSILON)) {
      engine.loadRate = tone.loadRate;
      this.ramp(engine.load.playbackRate, tone.loadRate, RATE_RAMP);
    }
    if (moved(tone.idleMix, engine.idleMix, GAIN_EPSILON)) {
      engine.idleMix = tone.idleMix;
      this.ramp(engine.idleGain.gain, tone.idleMix, MIX_RAMP);
    }
    if (moved(tone.loadMix, engine.loadMix, GAIN_EPSILON)) {
      engine.loadMix = tone.loadMix;
      this.ramp(engine.loadGain.gain, tone.loadMix, MIX_RAMP);
    }
    if (moved(tone.cutoff, engine.cutoff, FILTER_EPSILON)) {
      engine.cutoff = tone.cutoff;
      this.ramp(engine.filter.frequency, tone.cutoff, FILTER_RAMP);
    }

    const level = tone.gain * ENGINE_LEVEL;
    if (Math.abs(level - engine.gain) > GAIN_EPSILON) {
      this.ramp(engine.out.gain, level, engine.gain < 0 ? ENGINE_FADE_IN : GAIN_RAMP);
      engine.gain = level;
    }
  }

  /**
   * Builds the engine graph the first time the player drives.
   *
   * Both layers run from the same moment so they stay phase-locked to each
   * other; only their gains and rates move. Nothing is torn down when the
   * player gets out, because a stopped `AudioBufferSourceNode` can never be
   * started again and getting back into a car has to work.
   */
  private ensureEngine(): void {
    if (this.engine || this.engineRequested) return;
    const ctx = this.host.context;
    const bus = this.host.effectsBus;
    if (!ctx || !bus) return;

    const idleBuffer = this.host.bufferFor(VEHICLE_SOUNDS.engineIdle);
    const loadBuffer = this.host.bufferFor(VEHICLE_SOUNDS.engineLoad);
    if (!idleBuffer || !loadBuffer) {
      this.host.requestAsset(VEHICLE_SOUNDS.engineIdle);
      this.host.requestAsset(VEHICLE_SOUNDS.engineLoad);
      return;
    }
    this.engineRequested = true;

    const out = ctx.createGain();
    out.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1200;
    filter.Q.value = 0.7;
    out.connect(bus);
    filter.connect(out);

    const idleGain = ctx.createGain();
    idleGain.gain.value = 0;
    idleGain.connect(filter);
    const loadGain = ctx.createGain();
    loadGain.gain.value = 0;
    loadGain.connect(filter);

    const idle = this.startLoop(idleBuffer, idleGain, VEHICLE_SOUNDS.engineIdle);
    const load = this.startLoop(loadBuffer, loadGain, VEHICLE_SOUNDS.engineLoad);
    // Two sources, two layer gains, the filter and the output gain.
    this.liveNodes += 6;

    this.engine = {
      idle,
      load,
      idleGain,
      loadGain,
      filter,
      out,
      idleRate: 1,
      loadRate: 1,
      idleMix: 0,
      loadMix: 0,
      gain: -1,
      cutoff: 1200,
    };
  }

  // -- ambient traffic -------------------------------------------------------

  /**
   * Assigns the voice pool to the nearest cars and mixes them.
   *
   * Reassignment runs at 4 Hz, not per frame: the set of five nearest cars
   * barely changes in 250 ms, and re-panning a voice to a different car more
   * often than that is audible as a swirl rather than as traffic.
   */
  private updateTraffic(dt: number, ctx: StreetAudioContext): void {
    this.reassignIn -= dt;
    if (this.reassignIn <= 0) {
      this.reassignIn = TRAFFIC_REASSIGN;
      this.reassignVoices(ctx);
    }

    // One pass over the fleet serves the voices, the brake watch and the hum.
    let humWeight = 0;
    for (const voice of this.voices) voice.seen = false;

    for (const vehicle of ctx.vehicles) {
      const dx = vehicle.x - ctx.x;
      const dz = vehicle.z - ctx.z;
      const distanceSq = dx * dx + dz * dz;

      if (distanceSq < HUM_RADIUS * HUM_RADIUS && vehicle.control !== 'player') {
        const near = 1 - Math.sqrt(distanceSq) / HUM_RADIUS;
        humWeight += near * near * clamp01(Math.abs(vehicle.speed) / 8);
      }

      for (const voice of this.voices) {
        if (voice.vehicleId !== vehicle.id) continue;
        voice.seen = true;
        this.driveVoice(voice, vehicle, Math.sqrt(distanceSq));
        break;
      }
    }

    // A voice whose vehicle was recycled out of the fleet must not hold its
    // last level for the quarter second until the next reassignment.
    for (const voice of this.voices) {
      if (voice.vehicleId !== null && !voice.seen) {
        voice.vehicleId = null;
        this.setVoiceLevel(voice, 0);
      }
    }

    this.humWeight = humWeight;
  }

  private driveVoice(voice: TrafficVoice, vehicle: VehicleAudioView, distance: number): void {
    this.setPanner(voice.panner, vehicle.x, vehicle.y, vehicle.z);
    const rate = ambientRate(vehicle.speed);
    if (moved(rate, voice.rate, RATE_EPSILON)) {
      voice.rate = rate;
      this.ramp(voice.source.playbackRate, rate, RATE_RAMP);
    }
    this.setVoiceLevel(voice, ambientLevel(vehicle.speed) * AMBIENT_TRIM);

    const startedBraking = vehicle.braking && !voice.wasBraking;
    voice.wasBraking = vehicle.braking;
    if (
      startedBraking &&
      Math.abs(vehicle.speed) > TRAFFIC_SCRUB_SPEED &&
      distance < TRAFFIC_SCRUB_RADIUS &&
      this.trafficScrubCooldown <= 0
    ) {
      this.trafficScrubCooldown = TRAFFIC_SCRUB_COOLDOWN;
      this.playPositional(VEHICLE_SOUNDS.tyreScrub, vehicle.x, vehicle.y, vehicle.z, 0.8, 8, 40);
    }
  }

  private setVoiceLevel(voice: TrafficVoice, level: number): void {
    if (Math.abs(level - voice.level) < GAIN_EPSILON) return;
    voice.level = level;
    this.ramp(voice.gain.gain, level, GAIN_RAMP);
  }

  /**
   * Picks the nearest cars worth hearing and hands them to the pool.
   *
   * A voice keeps its car while that car is inside `TRAFFIC_RELEASE`, which is
   * deliberately wider than `TRAFFIC_RADIUS`: without the hysteresis, two cars
   * a metre apart in the ranking swap voices several times a second and the
   * street sounds like it is being shuffled.
   */
  private reassignVoices(ctx: StreetAudioContext): void {
    this.wanted.length = 0;
    const bestId: number[] = [];
    const bestDistance: number[] = [];

    for (const vehicle of ctx.vehicles) {
      if (vehicle.control === 'player') continue;
      const dx = vehicle.x - ctx.x;
      const dz = vehicle.z - ctx.z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq > TRAFFIC_RADIUS * TRAFFIC_RADIUS) continue;
      // Insertion into a five-slot ladder; no sort, no allocation.
      let slot = bestId.length;
      while (slot > 0 && (bestDistance[slot - 1] as number) > distanceSq) slot -= 1;
      if (slot >= TRAFFIC_VOICES) continue;
      bestId.splice(slot, 0, vehicle.id);
      bestDistance.splice(slot, 0, distanceSq);
      if (bestId.length > TRAFFIC_VOICES) {
        bestId.length = TRAFFIC_VOICES;
        bestDistance.length = TRAFFIC_VOICES;
      }
    }
    for (const id of bestId) this.wanted.push(id);

    // Anything a voice holds that is no longer wanted, and no longer close, is
    // let go; the rest keep their assignment across the tick.
    const held = new Set<number>();
    for (const voice of this.voices) {
      if (voice.vehicleId === null) continue;
      const stillWanted = this.wanted.includes(voice.vehicleId);
      const stillNear = this.withinRelease(ctx, voice.vehicleId);
      if (stillWanted || stillNear) held.add(voice.vehicleId);
      else {
        voice.vehicleId = null;
        this.setVoiceLevel(voice, 0);
      }
    }

    for (const id of this.wanted) {
      if (held.has(id)) continue;
      const voice = this.freeVoice();
      if (!voice) break;
      voice.vehicleId = id;
      voice.wasBraking = false;
      held.add(id);
    }
  }

  private withinRelease(ctx: StreetAudioContext, id: number): boolean {
    for (const vehicle of ctx.vehicles) {
      if (vehicle.id !== id) continue;
      const dx = vehicle.x - ctx.x;
      const dz = vehicle.z - ctx.z;
      return dx * dx + dz * dz <= TRAFFIC_RELEASE * TRAFFIC_RELEASE;
    }
    return false;
  }

  /** An idle voice, growing the pool up to its ceiling on demand. */
  private freeVoice(): TrafficVoice | null {
    for (const voice of this.voices) if (voice.vehicleId === null) return voice;
    if (this.voices.length >= TRAFFIC_VOICES) return null;

    const ctx = this.host.context;
    const bus = this.host.positionalEffectsBus;
    if (!ctx || !bus) return null;
    const buffer = this.host.bufferFor(VEHICLE_SOUNDS.engineFar);
    if (!buffer) {
      if (this.voicesRequested === 0) {
        this.voicesRequested = 1;
        this.host.requestAsset(VEHICLE_SOUNDS.engineFar);
      }
      return null;
    }

    const panner = this.makePanner(TRAFFIC_REF_DISTANCE, TRAFFIC_RELEASE);
    if (!panner) return null;
    panner.connect(bus);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(panner);
    const source = this.startLoop(buffer, gain, VEHICLE_SOUNDS.engineFar);
    this.liveNodes += 3;

    const voice: TrafficVoice = {
      source,
      gain,
      panner,
      vehicleId: null,
      wasBraking: false,
      seen: false,
      rate: 1,
      level: 0,
    };
    this.voices.push(voice);
    return voice;
  }

  // -- the distant hum -------------------------------------------------------

  /**
   * A single bed whose level is how much traffic is actually moving nearby.
   *
   * It sums on top of whatever land bed the director is playing rather than
   * replacing one, which is the same shape as the sea layer and for the same
   * reason: a street with cars on it should sound like a street with cars on
   * it, not like a different district.
   */
  private updateHum(dt: number, ctx: StreetAudioContext): void {
    const saturated = 1 - Math.exp(-this.humWeight / HUM_HALF);
    const target = saturated * HUM_LEVEL * (ctx.indoors ? HUM_INDOOR_DUCK : 1);
    this.humLevel += (target - this.humLevel) * Math.min(1, dt / HUM_TAU);

    if (!this.hum) {
      if (this.humLevel <= 0.001 || this.humRequested) return;
      const ctxNode = this.host.context;
      const bus = this.host.ambienceLayerBus;
      if (!ctxNode || !bus) return;
      const buffer = this.host.bufferFor(TRAFFIC_HUM);
      if (!buffer) {
        this.host.requestAsset(TRAFFIC_HUM);
        return;
      }
      this.humRequested = true;
      const gain = ctxNode.createGain();
      gain.gain.value = 0;
      gain.connect(bus);
      const source = this.startLoop(buffer, gain, TRAFFIC_HUM);
      this.liveNodes += 2;
      this.hum = { source, gain };
      return;
    }

    const level = this.humLevel * HUM_TRIM;
    if (Math.abs(level - this.humPushed) < GAIN_EPSILON * 0.5) return;
    this.humPushed = level;
    this.ramp(this.hum.gain.gain, level, 0.5);
  }

  // -- the crowd -------------------------------------------------------------

  /**
   * Emits a footfall for every `CROWD_STRIDE` metres each nearby person walks.
   *
   * Distance walked, not a timer: the crowd system already decides who is
   * moving and who is waiting at a kerb, and following its realised
   * displacement means the audio agrees with what is on screen for free.
   */
  private updateCrowd(dt: number, ctx: StreetAudioContext): void {
    this.gather(ctx);
    if (this.nearCount === 0) {
      this.ageTracks(dt);
      return;
    }

    for (const track of this.tracks) track.matched = false;

    for (let i = 0; i < this.nearCount; i += 1) {
      const px = this.nearX[i] as number;
      const py = this.nearY[i] as number;
      const pz = this.nearZ[i] as number;

      let best: WalkerTrack | null = null;
      let bestSq = CROWD_ASSOCIATE * CROWD_ASSOCIATE;
      for (const track of this.tracks) {
        if (!track.active || track.matched) continue;
        const dx = track.x - px;
        const dz = track.z - pz;
        const d = dx * dx + dz * dz;
        if (d < bestSq) {
          bestSq = d;
          best = track;
        }
      }

      if (!best) {
        for (const track of this.tracks) {
          if (track.active) continue;
          track.active = true;
          track.matched = true;
          track.x = px;
          track.y = py;
          track.z = pz;
          // Part of a stride, so a crowd walking into view does not all land
          // its first foot on the same frame.
          track.stride = Math.random() * CROWD_STRIDE;
          track.idle = 0;
          break;
        }
        continue;
      }

      const moved = Math.sqrt(bestSq);
      best.matched = true;
      best.idle = 0;
      best.x = px;
      best.y = py;
      best.z = pz;
      // A respawn teleports a pool slot across the city; that is not a step,
      // and the association radius already rejects most of it.
      if (moved > CROWD_TELEPORT) continue;
      best.stride += moved;
      if (best.stride < CROWD_STRIDE) continue;
      best.stride = Math.min(best.stride - CROWD_STRIDE, CROWD_STRIDE);
      if (this.stepBudget < 1) continue;
      this.stepBudget -= 1;
      this.playFootstep(px, py, pz);
    }

    this.ageTracks(dt);
  }

  private ageTracks(dt: number): void {
    for (const track of this.tracks) {
      if (!track.active || track.matched) continue;
      track.idle += dt;
      if (track.idle > CROWD_TRACK_TTL) track.active = false;
    }
  }

  private releaseTracks(): void {
    this.nearCount = 0;
    for (const track of this.tracks) track.active = false;
  }

  /**
   * Reads the rendered instance positions out of the crowd's instanced meshes.
   *
   * A Three.js instance matrix is column-major, so the translation is elements
   * 12, 13 and 14. Only `count` instances are live - the crowd compacts the
   * people it draws to the front of the buffer - so everything beyond that is
   * last frame's data and must not be read.
   */
  private gather(ctx: StreetAudioContext): void {
    this.nearCount = 0;
    const root = ctx.crowd;
    if (!root) return;
    this.gatherFrom(root, ctx);
  }

  private gatherFrom(node: CrowdNode, ctx: StreetAudioContext): void {
    if (!node.visible) return;
    const array = node.instanceMatrix?.array;
    const count = node.count ?? 0;
    if (array && count > 0) {
      const cutoff = CROWD_RADIUS * CROWD_RADIUS;
      for (let i = 0; i < count && this.nearCount < CROWD_SCAN; i += 1) {
        const m = i * 16;
        const px = array[m + 12] as number;
        const pz = array[m + 14] as number;
        const dx = px - ctx.x;
        const dz = pz - ctx.z;
        if (dx * dx + dz * dz > cutoff) continue;
        this.nearX[this.nearCount] = px;
        this.nearY[this.nearCount] = array[m + 13] as number;
        this.nearZ[this.nearCount] = pz;
        this.nearCount += 1;
      }
    }
    for (const child of node.children ?? []) this.gatherFrom(child, ctx);
  }

  private playFootstep(x: number, y: number, z: number): void {
    if (this.voicesFull(true)) return;
    this.crowdSteps += 1;
    const variants = STEP_SURFACES[this.surfaceAt(x, z)];
    const assetId = variants[this.stepFlip === 0 ? 0 : 1];
    this.stepFlip ^= 1;
    const jitter = (Math.random() * 2 - 1) * CROWD_STEP_JITTER_DB;
    const gain = dbToGain(getAudioAsset(assetId).trimDb + CROWD_STEP_DB + jitter);
    const rate = 1 + (Math.random() * 2 - 1) * CROWD_STEP_PITCH_JITTER;
    this.playPositional(
      assetId,
      x,
      y + 0.1,
      z,
      gain,
      CROWD_STEP_REF_DISTANCE,
      CROWD_RADIUS,
      rate,
      true,
    );
  }

  // -- shared plumbing -------------------------------------------------------

  private startLoop(
    buffer: AudioBuffer,
    target: AudioNode,
    id: AudioAssetId,
  ): AudioBufferSourceNode {
    const ctx = this.host.context as AudioContext;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    // Skip the encoder's own padding at both ends; see LOOP_TRIM.
    const duration = getAudioAsset(id).duration;
    if (duration > LOOP_TRIM * 4) {
      source.loopStart = LOOP_TRIM;
      source.loopEnd = duration - LOOP_TRIM;
    }
    source.connect(target);
    source.start();
    return source;
  }

  private playOneShot(id: AudioAssetId, scale: number): void {
    const ctx = this.host.context;
    const bus = this.host.effectsBus;
    if (!ctx || !bus || this.voicesFull(false)) return;
    const buffer = this.host.bufferFor(id);
    if (!buffer) {
      this.host.requestAsset(id);
      return;
    }

    const gain = ctx.createGain();
    gain.gain.value = dbToGain(getAudioAsset(id).trimDb) * scale;
    gain.connect(bus);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    this.arm({ source, gain, panner: null, step: false });
    source.start();
  }

  /**
   * Registers a one-shot so it is released on `ended` - or on `dispose`, if the
   * game is torn down while it is still sounding. Without the second path a
   * player who quits mid-footstep leaves nodes attached to a closing context,
   * and `liveNodes` stops being a truthful leak check.
   */
  private arm(shot: OneShot): void {
    this.liveNodes += shot.panner ? 3 : 2;
    if (shot.step) this.stepVoices += 1;
    this.shots.add(shot);
    shot.source.onended = (): void => this.release(shot);
  }

  /** True when another voice of this kind would break the hard ceiling. */
  private voicesFull(step: boolean): boolean {
    return step
      ? this.stepVoices >= MAX_STEP_VOICES
      : this.shots.size - this.stepVoices >= MAX_OTHER_VOICES;
  }

  private release(shot: OneShot): void {
    if (!this.shots.delete(shot)) return;
    if (shot.step) this.stepVoices -= 1;
    this.liveNodes -= shot.panner ? 3 : 2;
    shot.source.onended = null;
    this.disconnect(shot.source);
    this.disconnect(shot.gain);
    if (shot.panner) this.disconnect(shot.panner);
  }

  private playPositional(
    id: AudioAssetId,
    x: number,
    y: number,
    z: number,
    scale: number,
    refDistance: number,
    maxDistance: number,
    rate = 1,
    step = false,
  ): void {
    const ctx = this.host.context;
    const bus = this.host.positionalEffectsBus;
    if (!ctx || !bus || this.voicesFull(step)) return;
    const buffer = this.host.bufferFor(id);
    if (!buffer) {
      this.host.requestAsset(id);
      return;
    }

    const panner = this.makePanner(refDistance, maxDistance);
    if (!panner) return;
    panner.connect(bus);
    this.setPanner(panner, x, y, z);
    const gain = ctx.createGain();
    gain.gain.value = scale;
    gain.connect(panner);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.connect(gain);
    this.arm({ source, gain, panner, step });
    source.start();
  }

  private makePanner(refDistance: number, maxDistance: number): PannerNode | null {
    const ctx = this.host.context;
    if (!ctx) return null;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDistance;
    panner.maxDistance = maxDistance;
    panner.rolloffFactor = 1.4;
    return panner;
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

  private ramp(param: AudioParam, value: number, seconds: number): void {
    const ctx = this.host.context;
    if (!ctx) return;
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

  private stop(source: AudioBufferSourceNode): void {
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* Already stopped. */
    }
    this.disconnect(source);
  }

  /** Releases every node this layer owns, one-shots in flight included. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const shot of [...this.shots]) {
      this.stop(shot.source);
      this.release(shot);
    }
    this.shots.clear();
    this.stepVoices = 0;

    const engine = this.engine;
    if (engine) {
      this.stop(engine.idle);
      this.stop(engine.load);
      this.disconnect(engine.idleGain);
      this.disconnect(engine.loadGain);
      this.disconnect(engine.filter);
      this.disconnect(engine.out);
      this.liveNodes -= 6;
    }
    this.engine = null;

    for (const voice of this.voices) {
      this.stop(voice.source);
      this.disconnect(voice.gain);
      this.disconnect(voice.panner);
      this.liveNodes -= 3;
    }
    this.voices.length = 0;

    if (this.hum) {
      this.stop(this.hum.source);
      this.disconnect(this.hum.gain);
      this.liveNodes -= 2;
    }
    this.hum = null;

    for (const track of this.tracks) track.active = false;
  }
}
