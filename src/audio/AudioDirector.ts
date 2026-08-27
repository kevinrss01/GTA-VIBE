/**
 * The audio director for Meridian Bay.
 *
 * This is plain Web Audio on purpose. It imports nothing from Three.js and
 * touches no renderer state, so the whole module is unit-testable against a
 * mocked `AudioContext` and can never stall a frame with renderer work.
 *
 * Responsibilities, in the order the mix is assembled:
 *
 *   - ambience: six looping land beds, crossfaded over ~2 s, with an interior
 *     bed that takes over indoors while the outdoor bed ducks;
 *   - the sea: a seventh loop that is not a district bed at all. It sums on top
 *     of the land bed at a level taken from the listener's measured distance to
 *     the waterline, so the bay is loud on the quay and silent inland;
 *   - footsteps: two variants per surface, alternated, with per-step pitch and
 *     gain jitter so a walk cycle never reads as a metronome;
 *   - one-shots: doors and the interface tick;
 *   - positional audio: the harbour PA announcement near the ferry terminal,
 *     plus any looping emitters the world registers (fountains and the like);
 *   - music: off on every load, opt-in only, and never fetched until then.
 *
 * A limiter sits between the master gain and the output. It is a guard rail
 * rather than a mix stage - see `makeLimiter` - because the buses are trimmed
 * for the average case and the game has moments where a dozen legitimate
 * voices land inside the same 50 ms.
 *
 * ## Pausing
 *
 * `setGamePaused` and the visibility hook are two independent HOLDS on the
 * same context-level suspend, not a counter, so pausing then tabbing away and
 * back leaves a paused game silent. See `setGamePaused` for why that matters
 * and why it goes through `ctx.suspend()` rather than the music switch.
 *
 * ## The music contract
 *
 * Music is a product decision, not a mixing one, and it is enforced here rather
 * than relied upon elsewhere:
 *
 *   1. `musicEnabled` starts `false` on every fresh load. Nothing persists it,
 *      so there is no stored value that could ever turn it back on.
 *   2. The music file is not fetched or decoded until `setMusicEnabled(true)`.
 *      Construction and `unlock()` deliberately skip it, so a player who never
 *      turns music on never pays for the download.
 *   3. Only `setMusicEnabled` starts or stops music. Pointer-lock changes,
 *      window blur/focus, visibility changes and pauses never do. The one
 *      lifecycle hook installed here suspends and resumes the whole context,
 *      which leaves a stopped track stopped and lets a playing track continue
 *      from where it was rather than restarting it.
 */

import {
  DISTRICT_AMBIENCE,
  getAudioAsset,
  HARBOUR_PA_ASSET_ID,
  INTERIOR_BED,
  MUSIC_ASSET_ID,
  ONE_SHOTS,
  PRELOAD_ASSET_IDS,
  ROAD_SURFACE,
  SEA_BED,
  STEP_SURFACES,
  SURFACE_AMBIENCE,
  type AmbienceBedId,
  type AudioAssetId,
  type OneShotId,
} from './manifest';
import { seaGain, shoreDistance, SEA_SILENT_DISTANCE } from './seaAudibility';
import type { DistrictId } from '../world/CityPlan';
import type { SurfaceId } from '../world/CityGround';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Ambience crossfade time when the listener changes district or goes indoors. */
const AMBIENCE_CROSSFADE = 2.0;
/**
 * How far the outdoor beds drop while the listener is inside a building. The
 * sea takes the same duck as the land bed, which is what makes a shorefront
 * interior keep a muffled bay behind the glass while an inland one hears
 * nothing: -14 dB of a level that is already zero is still zero.
 */
export const INDOOR_DUCK_DB = -14;
/**
 * How fast the sea layer chases its distance-driven target.
 *
 * Short enough that the level is never noticeably behind the player - at the
 * 8 m/s sprint the curve moves at most 0.17/s, so a 0.35 s ramp lags by under
 * 0.06 in gain, half a decibel - and long enough that re-ramping does not have
 * to happen on every one of 120 frames a second.
 */
const SEA_TRACK_FADE = 0.35;
/**
 * Retarget the sea only when its level has actually moved. Below this the
 * change is inaudible (0.03 dB at unity), so the frame does no Web Audio work.
 */
const SEA_GAIN_EPSILON = 0.004;
/**
 * Hysteresis on releasing the sea loop. The gain is already zero from
 * `SEA_SILENT_DISTANCE`, so holding the source for another 20 m costs nothing
 * audible and stops a player pacing across the silence line from churning
 * buffer sources, which cannot be restarted once stopped.
 */
const SEA_RELEASE_DISTANCE = SEA_SILENT_DISTANCE + 20;
const MUSIC_FADE_IN = 1.2;
const MUSIC_FADE_OUT = 0.8;

/**
 * Bus trims. Music is scored as a background bed, not a soundtrack: it sits a
 * long way under the ambience and the footsteps so the city stays the thing you
 * are listening to. At -20 dB it is present when you notice it and easy to
 * ignore when you do not.
 */
const AMBIENCE_BUS_DB = -6;
const SFX_BUS_DB = -3;
const MUSIC_BUS_DB = -20;
const POSITIONAL_BUS_DB = -4;
/**
 * World-positioned sound EFFECTS: traffic, tyres and other people's footsteps.
 *
 * A fifth bus rather than a reuse of `positionalBus`, because the two groups
 * answer to different sliders. `positionalBus` is scaled by `ambience` and
 * carries environment sources - the ferry PA, the park fountain - while this
 * one is scaled by `effects`, so a player who turns effects down quietens the
 * crowd's footsteps at the same time as their own, which is what they meant.
 * Trimmed a little under the dry effects bus because these sources are also
 * attenuated by distance and would otherwise sit forward of the player.
 */
const SFX_POSITIONAL_BUS_DB = -5;

/**
 * Player-facing volume channels.
 *
 * These scale the bus trims above rather than replacing them: the mix balance
 * the audio was authored to keep is preserved, and the player only moves the
 * whole group up or down. `effects` covers footsteps, doors and interface
 * ticks; `ambience` covers the environment beds and the positional sources
 * placed in the world.
 */
export type VolumeChannel = 'master' | 'music' | 'effects' | 'ambience';

export const VOLUME_CHANNELS: readonly VolumeChannel[] = [
  'master',
  'music',
  'effects',
  'ambience',
];

const VOLUME_STORAGE_KEY = 'meridian.volumes';

/**
 * Volumes persist, music state does not.
 *
 * Every fresh load must start with music off - that is a hard requirement - so
 * only the levels are stored here. Turning the music slider down and reloading
 * gives you a quiet track when you switch music on, never a track playing.
 */
function loadVolumes(): Record<VolumeChannel, number> {
  const volumes: Record<VolumeChannel, number> = {
    master: 1,
    music: 1,
    effects: 1,
    ambience: 1,
  };
  try {
    const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
    if (!raw) return volumes;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return volumes;
    for (const channel of VOLUME_CHANNELS) {
      const value = (parsed as Record<string, unknown>)[channel];
      if (typeof value === 'number' && Number.isFinite(value)) {
        volumes[channel] = Math.max(0, Math.min(1, value));
      }
    }
  } catch {
    /* Storage can be unavailable or corrupt; defaults are always valid. */
  }
  return volumes;
}

/** Per-step variation. Enough to break the pattern, not enough to read as a bug. */
const STEP_PITCH_JITTER = 0.06;
const STEP_GAIN_JITTER_DB = 2;
/** Running lands harder and faster than walking. */
const RUN_GAIN_DB = 2.5;
const RUN_PITCH = 1.05;

/**
 * Hard ceiling on the player's own footsteps sounding at once.
 *
 * The controller emits a step per `strideLength` metres walked, which is one
 * every 0.325 s at a run. The step assets are 0.32 s, so two should never
 * genuinely overlap - but a frame-rate collapse, a debug time step or a pitch
 * jitter that lands long can all stack them, and there is no limiter under
 * this. Three is generous enough that nothing audible is ever dropped and low
 * enough that the summed level cannot run away.
 *
 * The cadence constants that used to live here were dead: `STEP_INTERVAL_WALK`,
 * `STEP_INTERVAL_RUN` and `stepIntervalFor` were exported for a caller that
 * never existed, because `FirstPersonController` schedules steps by DISTANCE
 * walked rather than on a clock. They are gone rather than kept as a second,
 * wrong description of the cadence.
 */
const MAX_PLAYER_STEP_VOICES = 3;

/**
 * How many consecutive footsteps a new surface must be reported on before the
 * sound actually changes.
 *
 * The ground sampler resolves a surface per point, so a player walking along a
 * boundary - a kerb, the edge of an apron, a path across grass - can be given a
 * different surface on every step, which is heard as the material flickering
 * underfoot. Requiring two steps in a row costs at most one step of the old
 * material on a real crossing, which nobody notices, and removes the flicker
 * entirely.
 *
 * `onRoad` bypasses it: that flag is the world's authoritative "this is a
 * carriageway", not a sampled guess, so crossing on or off a road switches
 * immediately and correctly.
 */
const SURFACE_HOLD_STEPS = 2;

/**
 * The ferry terminal PA. Position mirrors the `ferry-terminal` landmark in
 * `CityPlan.ts` (x -172, z 12); `y` is the speaker's mounting height above the
 * quay rather than a ground sample, so this module needs no access to the city
 * plan or the terrain function. A test pins x/z against the plan so the two
 * cannot drift apart.
 */
export const HARBOUR_PA_POSITION = { x: -172, y: 5, z: 12 } as const;
/** The announcement is only audible near the terminal. */
const HARBOUR_PA_RANGE = 55;
const HARBOUR_PA_MIN_GAP = 70;
const HARBOUR_PA_MAX_GAP = 140;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AudioDirectorOptions {
  /** Prefixed to every manifest path. Use for a sub-path deployment. */
  readonly basePath?: string;
}

export interface ListenerState {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Unit forward vector of the camera. */
  readonly forwardX: number;
  /** Optional: a level first-person camera leaves this at 0. */
  readonly forwardY?: number;
  readonly forwardZ: number;
  readonly district: DistrictId;
  readonly surface: SurfaceId;
  readonly indoors: boolean;
  /**
   * Horizontal speed in m/s. Accepted so callers can hand over the player state
   * they already have; the director does not schedule footsteps from it, because
   * the controller owns the decision of when a foot actually lands.
   */
  readonly speed?: number;
}

export interface LoopEmitterOptions {
  readonly assetId: AudioAssetId;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Distance at which the emitter plays at full level. */
  readonly refDistance?: number;
  /** Distance beyond which it is inaudible. */
  readonly maxDistance?: number;
  readonly gainDb?: number;
}

/** Handle returned when the world registers a looping positional source. */
export interface LoopEmitter {
  stop(): void;
}

/**
 * The wiring a second audio layer needs to build its own graph on these buses.
 *
 * `StreetAudio` owns a pool of looping engine voices and a footstep spawner,
 * which is far too much per-frame machinery to bolt onto this class - but it
 * must not open its own `AudioContext` either, or the player's volume sliders
 * would stop applying to half the game. This is the whole of the seam: the
 * context, the three buses that are legal to attach to, and read-only access to
 * the buffers this director has already decoded.
 *
 * Everything is nullable because the director is inert until `unlock()`. A
 * consumer must handle a null context on every frame, not just at start-up.
 */
export interface AudioBusHost {
  readonly context: AudioContext | null;
  /** Dry effects, scaled by the `effects` slider. */
  readonly effectsBus: GainNode | null;
  /** Panned effects, scaled by the `effects` slider. */
  readonly positionalEffectsBus: GainNode | null;
  /** Environment beds, scaled by the `ambience` slider. */
  readonly ambienceLayerBus: GainNode | null;
  /** A decoded buffer, or null if it is missing or still loading. */
  bufferFor(id: AudioAssetId): AudioBuffer | null;
  /** Starts a load if the asset is not resident. Safe to call repeatedly. */
  requestAsset(id: AudioAssetId): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Hoisted so the per-frame sea update never pays for a `Math.pow` or a lookup. */
const INDOOR_DUCK = dbToGain(INDOOR_DUCK_DB);
const SEA_BED_TRIM = dbToGain(getAudioAsset(SEA_BED).trimDb);

type AudioContextCtor = new () => AudioContext;

function resolveAudioContextCtor(): AudioContextCtor | null {
  const scope = globalThis as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/**
 * Deterministic PRNG for the PA schedule, so a session replays the same
 * announcement rhythm. Step jitter uses `Math.random`, which does not need to be
 * reproducible.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface BedVoice {
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
}

interface RegisteredEmitter {
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly panner: PannerNode;
}

/**
 * The beds `applyAmbience` owns, i.e. every bed except the sea. The sea is
 * excluded on purpose: it is driven by `updateSea` from the listener's distance
 * to the water, and must not be zeroed out just because the land bed changed.
 */
const LAND_BEDS: readonly AmbienceBedId[] = [
  'ambience/street',
  'ambience/old-quarter',
  'ambience/park',
  'ambience/cannery',
  'ambience/ridge',
  'ambience/interior',
];

// ---------------------------------------------------------------------------
// AudioDirector
// ---------------------------------------------------------------------------

export class AudioDirector implements AudioBusHost {
  private readonly basePath: string;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private ambienceBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private positionalBus: GainNode | null = null;
  private sfxPositionalBus: GainNode | null = null;

  private readonly buffers = new Map<AudioAssetId, AudioBuffer>();
  private readonly loading = new Map<AudioAssetId, Promise<AudioBuffer | null>>();
  /** Things already reported. Each failure is logged once, at debug level. */
  private readonly failed = new Set<string>();

  private readonly beds = new Map<AmbienceBedId, BedVoice>();
  /** Beds mid-fade-out. Tracked only so `dispose()` can stop them too. */
  private readonly dyingBeds = new Set<BedVoice>();
  private activeBed: AmbienceBedId | null = null;
  private activeIndoors = false;
  /** Level the sea loop was last ramped towards, so a still frame does no work. */
  private seaTarget = 0;
  /**
   * Set from the moment the sea loop is asked for until it is released, so a
   * slow decode cannot stack voices and a missing file cannot be re-fetched
   * once a frame.
   */
  private seaRequested = false;

  private musicSource: AudioBufferSourceNode | null = null;
  private musicGain: GainNode | null = null;
  private musicOn = false;
  /**
   * Guards against an out-of-order enable/disable: a music buffer that finishes
   * loading after the player has switched music back off must not start it.
   */
  private musicToken = 0;

  private readonly emitters = new Set<RegisteredEmitter>();
  private readonly stepFlip = new Map<SurfaceId, number>();
  /** The player's own footsteps in flight; see MAX_PLAYER_STEP_VOICES. */
  private stepVoices = 0;
  /** Surface hysteresis state; see `settleSurface`. */
  private heldSurface: SurfaceId | null = null;
  private pendingSurface: SurfaceId | null = null;
  private pendingSteps = 0;
  private heldOnRoad: boolean | null = null;

  private readonly volumes: Record<VolumeChannel, number> = loadVolumes();
  private state: ListenerState | null = null;

  private readonly paRandom = mulberry32(0x4d425041);
  private paTimer = 0;
  private paNextGap: number;

  private disposed = false;
  private visibilityHandler: (() => void) | null = null;
  /** Independent reasons the context is suspended; see `setGamePaused`. */
  private pausedHold = false;
  private hiddenHold = false;

  constructor(options?: AudioDirectorOptions) {
    this.basePath = options?.basePath ?? '';
    this.paNextGap = this.nextPaGap();
  }

  // -- lifecycle ------------------------------------------------------------

  get unlocked(): boolean {
    return this.ctx !== null;
  }

  /**
   * Creates the AudioContext. Must be called from a user gesture, because
   * browsers refuse to start a context without one.
   *
   * Preloads everything except music: see the music contract at the top.
   */
  async unlock(): Promise<void> {
    if (this.disposed || this.ctx) return;

    const Ctor = resolveAudioContextCtor();
    if (!Ctor) {
      this.debugOnce('audiocontext', 'Web Audio is unavailable; running silent.');
      return;
    }

    let ctx: AudioContext;
    try {
      ctx = new Ctor();
    } catch {
      this.debugOnce('audiocontext', 'Could not create an AudioContext; running silent.');
      return;
    }
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.connect(this.makeLimiter(ctx));

    this.ambienceBus = this.makeBus(AMBIENCE_BUS_DB);
    this.sfxBus = this.makeBus(SFX_BUS_DB);
    this.musicBus = this.makeBus(MUSIC_BUS_DB);
    this.positionalBus = this.makeBus(POSITIONAL_BUS_DB);
    this.sfxPositionalBus = this.makeBus(SFX_POSITIONAL_BUS_DB);
    // The buses exist now, so the stored levels can finally be applied.
    this.applyVolumes();

    // A player who paused before ever unlocking must not get audio back on the
    // gesture that unlocks it; the holds are the single source of truth here.
    if (ctx.state === 'suspended' && !this.suspended) {
      try {
        await ctx.resume();
      } catch {
        /* A context that will not resume still degrades to silence. */
      }
    }

    this.installLifecycleHook();

    // Music is intentionally absent from PRELOAD_ASSET_IDS.
    await Promise.all(PRELOAD_ASSET_IDS.map((id) => this.load(id)));

    // A district may already have been reported before the gesture landed.
    if (this.state) {
      this.applyAmbience(this.state, 0.35);
      this.updateSea(this.state, 0.35);
    }

    // Enabling music before unlocking is legal; honour it now that we can.
    if (this.musicOn) await this.startMusic();
  }

  /**
   * A catch-all limiter between the master gain and the output.
   *
   * There was nothing of the kind anywhere in the graph, and the mix has
   * genuinely unbounded moments: a burst of gunfire, an explosion and its
   * debris, five engines and a siren can all land inside the same 50 ms with no
   * single voice being wrong. The buses are trimmed for the AVERAGE case, so
   * without a ceiling the sum clips at the sound card.
   *
   * Deliberately transparent rather than a mix effect: -3 dBFS threshold, a
   * 20:1 ratio and a wide 8 dB knee mean it does nothing at all until the sum
   * is already within 7 dB of full scale, and the 250 ms release is long enough
   * that it cannot pump the ambience beds. It is a guard rail; the footstep and
   * voice budgets are what actually keep the level right.
   */
  private makeLimiter(ctx: AudioContext): AudioNode {
    if (typeof ctx.createDynamicsCompressor !== 'function') return ctx.destination;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 8;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(ctx.destination);
    this.limiter = limiter;
    return limiter;
  }

  private makeBus(db: number): GainNode {
    const ctx = this.ctx as AudioContext;
    const bus = ctx.createGain();
    bus.gain.value = dbToGain(db);
    bus.connect(this.master as GainNode);
    return bus;
  }

  /**
   * Suspends the context while the tab is hidden purely to save CPU. It never
   * touches music state, so resuming cannot start music that is off and cannot
   * restart a playing track from the beginning.
   */
  private installLifecycleHook(): void {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;

    const handler = (): void => {
      this.hiddenHold = document.visibilityState === 'hidden';
      this.applySuspension();
    };
    this.visibilityHandler = handler;
    document.addEventListener('visibilitychange', handler);
  }

  /**
   * Suspends audio while the game is paused, and resumes it when it is not.
   *
   * ## Why two named holds and not a counter
   *
   * Pause and tab-visibility both want the context suspended, and they overlap:
   * pausing, tabbing away and tabbing back must leave a PAUSED game silent.
   * A `suspendCount += 1 / -= 1` pair gets that wrong the moment either source
   * fires twice in a row, and `visibilitychange` does exactly that - it fires on
   * every focus change, not only on transitions the game asked about. Two named
   * booleans are idempotent by construction: setting a hold that is already set
   * is a no-op, and the context is suspended if and only if some hold is up.
   *
   * ## Why context-level suspend and not the music switch
   *
   * The music contract at the top of this file: suspend/resume must never touch
   * music STATE. `ctx.suspend()` freezes the whole graph including a playing
   * track's position, so resuming continues it from where it was; a stopped
   * track stays stopped because nothing here starts one.
   */
  setGamePaused(paused: boolean): void {
    if (this.pausedHold === paused) return;
    this.pausedHold = paused;
    this.applySuspension();
  }

  /** True while some hold wants the graph frozen. */
  get suspended(): boolean {
    return this.pausedHold || this.hiddenHold;
  }

  private applySuspension(): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    try {
      if (this.suspended) void ctx.suspend();
      else void ctx.resume();
    } catch {
      /* Suspend/resume is best-effort. */
    }
  }

  setMasterVolume(v: number): void {
    this.setVolume('master', v);
  }

  /** Current level for a channel, 0 to 1. */
  getVolume(channel: VolumeChannel): number {
    return this.volumes[channel];
  }

  /** Sets a channel level, applies it immediately and remembers it. */
  setVolume(channel: VolumeChannel, value: number): void {
    this.volumes[channel] = Math.max(0, Math.min(1, value));
    this.applyVolumes();
    try {
      localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify(this.volumes));
    } catch {
      /* Losing the preference is not worth breaking the game over. */
    }
  }

  /**
   * Pushes the channel levels onto the buses.
   *
   * Each bus keeps its authored trim and is scaled by the player's setting, so
   * moving a slider changes loudness without changing the balance between the
   * sounds inside that group. Assigning `gain.value` is safe here: the indoor
   * duck automates the individual ambience beds, not these buses.
   */
  private applyVolumes(): void {
    if (this.master) this.master.gain.value = this.volumes.master;
    if (this.ambienceBus) {
      this.ambienceBus.gain.value = dbToGain(AMBIENCE_BUS_DB) * this.volumes.ambience;
    }
    if (this.positionalBus) {
      this.positionalBus.gain.value = dbToGain(POSITIONAL_BUS_DB) * this.volumes.ambience;
    }
    if (this.sfxBus) this.sfxBus.gain.value = dbToGain(SFX_BUS_DB) * this.volumes.effects;
    if (this.sfxPositionalBus) {
      this.sfxPositionalBus.gain.value = dbToGain(SFX_POSITIONAL_BUS_DB) * this.volumes.effects;
    }
    if (this.musicBus) this.musicBus.gain.value = dbToGain(MUSIC_BUS_DB) * this.volumes.music;
  }

  // -- the seam for the street layer ----------------------------------------

  get context(): AudioContext | null {
    return this.ctx;
  }

  get effectsBus(): GainNode | null {
    return this.sfxBus;
  }

  get positionalEffectsBus(): GainNode | null {
    return this.sfxPositionalBus;
  }

  get ambienceLayerBus(): GainNode | null {
    return this.ambienceBus;
  }

  bufferFor(id: AudioAssetId): AudioBuffer | null {
    return this.buffers.get(id) ?? null;
  }

  requestAsset(id: AudioAssetId): void {
    if (this.disposed || !this.ctx || this.buffers.has(id)) return;
    void this.load(id);
  }

  // -- loading --------------------------------------------------------------

  private urlFor(id: AudioAssetId): string {
    return `${this.basePath}${getAudioAsset(id).path}`;
  }

  /**
   * Fetches and decodes an asset once. Every failure path is swallowed: a
   * missing or corrupt file must degrade to silence, never throw into the game
   * loop, and never spam the console.
   */
  private load(id: AudioAssetId): Promise<AudioBuffer | null> {
    const ready = this.buffers.get(id);
    if (ready) return Promise.resolve(ready);

    const inFlight = this.loading.get(id);
    if (inFlight) return inFlight;

    const task = this.fetchAndDecode(id);
    this.loading.set(id, task);
    return task;
  }

  private async fetchAndDecode(id: AudioAssetId): Promise<AudioBuffer | null> {
    const ctx = this.ctx;
    if (!ctx || typeof fetch !== 'function') return null;

    try {
      const response = await fetch(this.urlFor(id));
      if (!response.ok) {
        this.debugOnce(id, `Audio asset ${id} returned HTTP ${response.status}.`);
        return null;
      }
      const bytes = await response.arrayBuffer();
      const buffer = await ctx.decodeAudioData(bytes);
      this.buffers.set(id, buffer);
      return buffer;
    } catch {
      this.debugOnce(id, `Audio asset ${id} could not be loaded; continuing without it.`);
      return null;
    } finally {
      this.loading.delete(id);
    }
  }

  private debugOnce(key: string, message: string): void {
    if (this.failed.has(key)) return;
    this.failed.add(key);
    if (typeof console !== 'undefined' && typeof console.debug === 'function') {
      console.debug(`[audio] ${message}`);
    }
  }

  // -- per-frame ------------------------------------------------------------

  /** Called every frame with the listener state and the surface underfoot. */
  update(dt: number, state: ListenerState): void {
    this.state = state;
    if (this.disposed || !this.ctx) return;

    this.updateListener(state);
    this.applyAmbience(state, AMBIENCE_CROSSFADE);
    this.updateSea(state, SEA_TRACK_FADE);
    this.updateHarbourPa(dt, state);
  }

  private updateListener(state: ListenerState): void {
    const listener = (this.ctx as AudioContext).listener;

    // The modern AudioParam interface where available, the deprecated setters
    // otherwise; Safari only grew the former relatively recently.
    const forwardY = state.forwardY ?? 0;
    if (listener.positionX) {
      listener.positionX.value = state.x;
      listener.positionY.value = state.y;
      listener.positionZ.value = state.z;
      listener.forwardX.value = state.forwardX;
      listener.forwardY.value = forwardY;
      listener.forwardZ.value = state.forwardZ;
      listener.upX.value = 0;
      listener.upY.value = 1;
      listener.upZ.value = 0;
    } else if (typeof listener.setPosition === 'function') {
      listener.setPosition(state.x, state.y, state.z);
      listener.setOrientation(state.forwardX, forwardY, state.forwardZ, 0, 1, 0);
    }
  }

  // -- ambience -------------------------------------------------------------

  /** The outdoor land bed for a position: surface first, then district. */
  private outdoorBedFor(state: ListenerState): AmbienceBedId {
    return SURFACE_AMBIENCE[state.surface] ?? DISTRICT_AMBIENCE[state.district];
  }

  /**
   * Retargets the land beds when — and only when — the listener's bed or indoor
   * status actually changes, so a normal frame does no work and allocates
   * nothing. The sea is not a land bed and is handled by `updateSea`.
   */
  private applyAmbience(state: ListenerState, fade: number): void {
    const outdoor = this.outdoorBedFor(state);
    if (outdoor === this.activeBed && state.indoors === this.activeIndoors) return;
    this.activeBed = outdoor;
    this.activeIndoors = state.indoors;

    for (const bed of LAND_BEDS) {
      let target = 0;
      if (state.indoors) {
        if (bed === INTERIOR_BED) target = 1;
        else if (bed === outdoor) target = INDOOR_DUCK;
      } else if (bed === outdoor) {
        target = 1;
      }
      this.rampBed(bed, target, fade);
    }
  }

  /**
   * Mixes the bay from the listener's real position.
   *
   * The level is a gain on the bed rather than a `PannerNode` on the positional
   * bus, and that is a deliberate choice for this source in particular:
   *
   *   - the sea here is a 390 m line source running the length of the west edge
   *     of the map, not a point. Projecting it onto its nearest shoreline point
   *     would swing the surf across the stereo field as the player walks along
   *     the quay, which reads as a machine at the water's edge rather than as
   *     open water;
   *   - `panningModel: 'HRTF'` downmixes its input to mono, and the width of
   *     this stereo loop is most of what makes it read as the sea at all;
   *   - `distanceModel: 'inverse'` never reaches zero, it flattens out at
   *     `maxDistance` — the exact "still faintly there" failure being fixed.
   *
   * The panners keep the job they are right for: the ferry terminal PA and the
   * world's registered loop emitters really are points, and still use them.
   * Routing through the bed keeps the sea inside the machinery that already
   * handles a failed download, `dispose()` and the `volumes.ambience` slider.
   */
  private updateSea(state: ListenerState, fade: number): void {
    const distance = shoreDistance(state.x, state.z);
    const target = seaGain(state.x, state.z) * (state.indoors ? INDOOR_DUCK : 1);
    const voice = this.beds.get(SEA_BED);

    if (target <= 0 && distance > SEA_RELEASE_DISTANCE) {
      // Clearing the request here also covers a download that failed and left
      // no voice: the sea is retried once the next time the player comes back
      // to the water, the way a land bed is retried when its district comes
      // round again, rather than never or once a frame.
      if (voice) {
        this.beds.delete(SEA_BED);
        this.retireBed(voice, fade);
      }
      this.seaRequested = false;
      this.seaTarget = 0;
      return;
    }

    if (!voice) {
      // Asked for at zero and brought up by the tracking branch on the next
      // frame, so a target that went stale during the decode cannot land the
      // loop at an audible level a hundred metres inland.
      if (target > 0 && !this.seaRequested) {
        this.seaRequested = true;
        this.seaTarget = 0;
        void this.startBed(SEA_BED, 0, fade);
      }
      return;
    }

    if (Math.abs(target - this.seaTarget) < SEA_GAIN_EPSILON) return;
    this.seaTarget = target;
    this.ramp(voice.gain.gain, target * SEA_BED_TRIM, fade);
  }

  private rampBed(bed: AmbienceBedId, target: number, fade: number): void {
    const existing = this.beds.get(bed);

    if (!existing) {
      if (target <= 0) return;
      void this.startBed(bed, target, fade);
      return;
    }

    if (target <= 0) {
      this.beds.delete(bed);
      this.retireBed(existing, fade);
      return;
    }

    const trim = dbToGain(getAudioAsset(bed).trimDb);
    this.ramp(existing.gain.gain, target * trim, fade);
  }

  private async startBed(bed: AmbienceBedId, target: number, fade: number): Promise<void> {
    const buffer = await this.load(bed);
    const ctx = this.ctx;
    // The player may have walked back out of this district while it loaded.
    if (!buffer || !ctx || this.disposed || this.beds.has(bed)) return;

    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.ambienceBus as GainNode);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    source.start();

    const voice: BedVoice = { source, gain };
    this.beds.set(bed, voice);

    const trim = dbToGain(getAudioAsset(bed).trimDb);
    this.ramp(gain.gain, target * trim, fade);
  }

  /**
   * Fades a bed out and frees it once silent, so retired loops stop costing CPU.
   *
   * The voice leaves `beds` the moment it starts dying. A scheduled `stop()`
   * cannot be cancelled, so a listener who walks back into this district before
   * the fade completes must be given a brand new voice; reviving this one would
   * ramp its gain back up only for the source to cut out mid-fade.
   */
  private retireBed(voice: BedVoice, fade: number): void {
    const ctx = this.ctx;
    if (!ctx) return;

    this.dyingBeds.add(voice);
    this.ramp(voice.gain.gain, 0, fade);
    try {
      voice.source.stop(ctx.currentTime + fade + 0.05);
    } catch {
      /* Already stopped. */
    }
    voice.source.onended = (): void => {
      this.dyingBeds.delete(voice);
      this.disconnect(voice.source);
      this.disconnect(voice.gain);
    };
  }

  // -- footsteps and one-shots ---------------------------------------------

  /**
   * Plays a footstep for the given surface, alternating the two variants.
   *
   * `onRoad` is `GroundSample.onRoad`, which the world already computes and
   * documents as being "so the footstep mixer can pick the right variant" but
   * which nothing in audio read until now. It is the authoritative carriageway
   * flag rather than a sampled material, so it wins outright over `surface`,
   * and a change in it resets the hysteresis below - stepping off a kerb is a
   * real transition and must be heard on the step that makes it.
   *
   * Omitting it is legal and leaves the sampled surface in charge, which is
   * what a caller with no ground sample (a cutscene, a test) should get.
   */
  footstep(surface: SurfaceId, running: boolean, onRoad?: boolean): void {
    if (this.disposed || !this.ctx) return;
    if (this.stepVoices >= MAX_PLAYER_STEP_VOICES) return;

    const heard = this.settleSurface(surface, onRoad);
    const variants = STEP_SURFACES[heard];
    const flip = this.stepFlip.get(heard) ?? 0;
    this.stepFlip.set(heard, flip ^ 1);
    const assetId = variants[flip === 0 ? 0 : 1];

    const jitterDb = (Math.random() * 2 - 1) * STEP_GAIN_JITTER_DB;
    const gainDb = getAudioAsset(assetId).trimDb + jitterDb + (running ? RUN_GAIN_DB : 0);
    const rate =
      (1 + (Math.random() * 2 - 1) * STEP_PITCH_JITTER) * (running ? RUN_PITCH : 1);

    this.playBuffered(assetId, dbToGain(gainDb), rate, true);
  }

  /**
   * Which surface is actually heard for this step.
   *
   * Two rules, in order. A carriageway is a carriageway: if the world says the
   * foot is on a road, the sound is asphalt whatever the sampler returned, and
   * the moment `onRoad` flips the held surface is abandoned. Otherwise a new
   * surface has to survive `SURFACE_HOLD_STEPS` consecutive footsteps before it
   * is heard, which is what stops a boundary flickering between two materials
   * step by step.
   */
  private settleSurface(surface: SurfaceId, onRoad?: boolean): SurfaceId {
    if (onRoad !== undefined && onRoad !== this.heldOnRoad) {
      this.heldOnRoad = onRoad;
      this.heldSurface = onRoad ? ROAD_SURFACE : surface;
      this.pendingSurface = null;
      this.pendingSteps = 0;
      return this.heldSurface;
    }
    if (onRoad === true) return ROAD_SURFACE;

    if (this.heldSurface === null) {
      this.heldSurface = surface;
      return surface;
    }
    if (surface === this.heldSurface) {
      this.pendingSurface = null;
      this.pendingSteps = 0;
      return this.heldSurface;
    }

    if (surface === this.pendingSurface) this.pendingSteps += 1;
    else {
      this.pendingSurface = surface;
      this.pendingSteps = 1;
    }
    if (this.pendingSteps < SURFACE_HOLD_STEPS) return this.heldSurface;

    this.heldSurface = surface;
    this.pendingSurface = null;
    this.pendingSteps = 0;
    return surface;
  }

  playOneShot(id: OneShotId): void {
    if (this.disposed || !this.ctx) return;
    const assetId = ONE_SHOTS[id];
    this.playBuffered(assetId, dbToGain(getAudioAsset(assetId).trimDb), 1);
  }

  /**
   * Fires a one-shot through the sfx bus. Buffers are already resident after
   * `unlock()`; if one is missing the call is a silent no-op rather than a
   * deferred sound arriving seconds late.
   */
  private playBuffered(
    assetId: AudioAssetId,
    gainValue: number,
    rate: number,
    step = false,
  ): void {
    const ctx = this.ctx;
    const buffer = this.buffers.get(assetId);
    if (!ctx || !buffer) {
      if (!buffer) void this.load(assetId);
      return;
    }

    const gain = ctx.createGain();
    gain.gain.value = gainValue;
    gain.connect(this.sfxBus as GainNode);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.connect(gain);
    if (step) this.stepVoices += 1;
    source.onended = (): void => {
      if (step) this.stepVoices = Math.max(0, this.stepVoices - 1);
      this.disconnect(source);
      this.disconnect(gain);
    };
    source.start();
  }

  // -- positional -----------------------------------------------------------

  /**
   * Registers a looping positional source, e.g. the park fountain. The returned
   * handle is the only way to stop it, which keeps the surface area small.
   */
  addLoopEmitter(options: LoopEmitterOptions): LoopEmitter {
    const entry: { emitter: RegisteredEmitter | null; stopped: boolean } = {
      emitter: null,
      stopped: false,
    };

    void (async (): Promise<void> => {
      const buffer = await this.load(options.assetId);
      const ctx = this.ctx;
      if (!buffer || !ctx || this.disposed || entry.stopped) return;

      const panner = this.makePanner(
        options.x,
        options.y,
        options.z,
        options.refDistance ?? 6,
        options.maxDistance ?? 90,
      );
      const gain = ctx.createGain();
      gain.gain.value = dbToGain(options.gainDb ?? getAudioAsset(options.assetId).trimDb);
      gain.connect(panner);

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(gain);
      source.start();

      const registered: RegisteredEmitter = { source, gain, panner };
      entry.emitter = registered;
      this.emitters.add(registered);
    })();

    return {
      stop: (): void => {
        entry.stopped = true;
        const registered = entry.emitter;
        if (!registered) return;
        entry.emitter = null;
        this.emitters.delete(registered);
        this.teardownEmitter(registered);
      },
    };
  }

  private makePanner(
    x: number,
    y: number,
    z: number,
    refDistance: number,
    maxDistance: number,
  ): PannerNode {
    const ctx = this.ctx as AudioContext;
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDistance;
    panner.maxDistance = maxDistance;
    panner.rolloffFactor = 1;
    if (panner.positionX) {
      panner.positionX.value = x;
      panner.positionY.value = y;
      panner.positionZ.value = z;
    } else if (typeof panner.setPosition === 'function') {
      panner.setPosition(x, y, z);
    }
    panner.connect(this.positionalBus as GainNode);
    return panner;
  }

  private teardownEmitter(registered: RegisteredEmitter): void {
    try {
      registered.source.stop();
    } catch {
      /* Already stopped. */
    }
    this.disconnect(registered.source);
    this.disconnect(registered.gain);
    this.disconnect(registered.panner);
  }

  /**
   * The ferry terminal announcement. It runs on its own clock whether or not the
   * player is nearby — arriving at the quay should not trigger an immediate
   * announcement — and is only actually played when they are within earshot.
   */
  private updateHarbourPa(dt: number, state: ListenerState): void {
    this.paTimer += dt;
    if (this.paTimer < this.paNextGap) return;

    this.paTimer = 0;
    this.paNextGap = this.nextPaGap();

    const dx = state.x - HARBOUR_PA_POSITION.x;
    const dz = state.z - HARBOUR_PA_POSITION.z;
    if (Math.hypot(dx, dz) > HARBOUR_PA_RANGE) return;

    this.playPositionalOneShot(
      HARBOUR_PA_ASSET_ID,
      HARBOUR_PA_POSITION.x,
      HARBOUR_PA_POSITION.y,
      HARBOUR_PA_POSITION.z,
    );
  }

  private nextPaGap(): number {
    return HARBOUR_PA_MIN_GAP + this.paRandom() * (HARBOUR_PA_MAX_GAP - HARBOUR_PA_MIN_GAP);
  }

  private playPositionalOneShot(assetId: AudioAssetId, x: number, y: number, z: number): void {
    const ctx = this.ctx;
    const buffer = this.buffers.get(assetId);
    if (!ctx || !buffer) return;

    const panner = this.makePanner(x, y, z, 12, HARBOUR_PA_RANGE);
    const gain = ctx.createGain();
    gain.gain.value = dbToGain(getAudioAsset(assetId).trimDb);
    gain.connect(panner);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    source.onended = (): void => {
      this.disconnect(source);
      this.disconnect(gain);
      this.disconnect(panner);
    };
    source.start();
  }

  // -- music ----------------------------------------------------------------

  get musicEnabled(): boolean {
    return this.musicOn;
  }

  /**
   * The only entry point that changes music state. Enabling lazily loads the
   * track the first time; disabling fades out and releases the source so a
   * disabled track holds no decoded audio graph.
   */
  async setMusicEnabled(enabled: boolean): Promise<void> {
    if (this.disposed || enabled === this.musicOn) return;
    this.musicOn = enabled;
    this.musicToken += 1;

    if (!enabled) {
      this.stopMusic();
      return;
    }
    // Before unlock there is no context; unlock() honours the flag afterwards.
    if (!this.ctx) return;
    await this.startMusic();
  }

  private async startMusic(): Promise<void> {
    const token = this.musicToken;
    const buffer = await this.load(MUSIC_ASSET_ID);
    const ctx = this.ctx;

    // Disabled again, disposed, or superseded while the file was loading.
    if (!buffer || !ctx || this.disposed || !this.musicOn || token !== this.musicToken) return;
    if (this.musicSource) return;

    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.musicBus as GainNode);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    source.start();

    this.musicSource = source;
    this.musicGain = gain;
    this.ramp(gain.gain, dbToGain(getAudioAsset(MUSIC_ASSET_ID).trimDb), MUSIC_FADE_IN);
  }

  private stopMusic(): void {
    const source = this.musicSource;
    const gain = this.musicGain;
    const ctx = this.ctx;
    this.musicSource = null;
    this.musicGain = null;
    if (!source || !gain || !ctx) return;

    this.ramp(gain.gain, 0, MUSIC_FADE_OUT);
    try {
      source.stop(ctx.currentTime + MUSIC_FADE_OUT + 0.05);
    } catch {
      /* Already stopped. */
    }
    source.onended = (): void => {
      this.disconnect(source);
      this.disconnect(gain);
    };
  }

  // -- teardown -------------------------------------------------------------

  /** Stops everything, disconnects every node and closes the context. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.visibilityHandler = null;

    for (const voice of [...this.beds.values(), ...this.dyingBeds]) {
      voice.source.onended = null;
      this.stopSource(voice.source);
      this.disconnect(voice.source);
      this.disconnect(voice.gain);
    }
    this.beds.clear();
    this.dyingBeds.clear();

    for (const emitter of this.emitters) this.teardownEmitter(emitter);
    this.emitters.clear();

    if (this.musicSource) {
      this.musicSource.onended = null;
      this.stopSource(this.musicSource);
      this.disconnect(this.musicSource);
    }
    if (this.musicGain) this.disconnect(this.musicGain);
    this.musicSource = null;
    this.musicGain = null;
    this.musicOn = false;

    for (const bus of [
      this.ambienceBus,
      this.sfxBus,
      this.musicBus,
      this.positionalBus,
      this.sfxPositionalBus,
    ]) {
      if (bus) this.disconnect(bus);
    }
    if (this.master) this.disconnect(this.master);
    if (this.limiter) this.disconnect(this.limiter);
    this.limiter = null;

    this.ambienceBus = null;
    this.sfxBus = null;
    this.musicBus = null;
    this.positionalBus = null;
    this.sfxPositionalBus = null;
    this.master = null;

    this.buffers.clear();
    this.loading.clear();
    this.stepFlip.clear();
    this.stepVoices = 0;
    this.heldSurface = null;
    this.pendingSurface = null;
    this.pendingSteps = 0;
    this.heldOnRoad = null;
    this.activeBed = null;
    this.seaTarget = 0;
    this.seaRequested = false;

    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && typeof ctx.close === 'function') {
      try {
        void ctx.close();
      } catch {
        /* Closing twice is harmless. */
      }
    }
  }

  // -- small shared helpers -------------------------------------------------

  /**
   * Ramps a parameter, or sets it outright while the context is suspended.
   *
   * `ctx.currentTime` stops advancing under `suspend()`, so every ramp
   * scheduled during a pause targets the same instant and they pile up on one
   * another: the frame loop is gated while paused, but a level change can still
   * arrive from a UI slider or a lifecycle callback, and this must not turn
   * into a queue of ramps that all fire at once on resume. Assigning the value
   * is both correct and inaudible, because nothing is being rendered.
   */
  private ramp(param: AudioParam, value: number, seconds: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      try {
        param.cancelScheduledValues(ctx.currentTime);
      } catch {
        /* Nothing was scheduled. */
      }
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

  private stopSource(source: AudioBufferSourceNode): void {
    try {
      source.stop();
    } catch {
      /* Already stopped. */
    }
  }

  private disconnect(node: AudioNode): void {
    try {
      node.disconnect();
    } catch {
      /* Already disconnected. */
    }
  }
}
