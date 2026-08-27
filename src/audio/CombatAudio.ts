/**
 * Gunfire, impacts, explosions, and the sound of being hit.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   const combatAudio = new CombatAudio(audio);   // audio: AudioBusHost
 *   combat.onShot = (id) => combatAudio.shot(id);
 *   combat.onImpact = (kind, x, y, z) => combatAudio.impact(kind, x, y, z);
 *   police.onOfficerShot = (x, y, z) => combatAudio.shotAt('pistol', x, y, z);
 *   // once per frame, after the player has moved:
 *   combatAudio.update(dt, { health, maxHealth, alive });
 *   combatAudio.dispose();
 *
 * ============================================================================
 *
 * A THIRD LAYER ON THE SAME BUSES. Like `StreetAudio`, this builds its own
 * graph on the director's buses rather than opening a context of its own, so
 * the player's volume sliders keep applying to all of it. It owns nothing the
 * director owns: no context, no decoding, no master gain.
 *
 * WHY THE PLAYER'S OWN SOUNDS ARE NOT PANNED. A gunshot from the weapon in
 * your hands, a grunt when you are hit, a heartbeat: none of those are at a
 * position in the world, they are AT the listener. Running them through an
 * HRTF panner at the listener's own coordinates produces a smeared, phasey
 * result as the panner tries to place something that is zero metres away. They
 * go through the dry bus flat. Everything that really is somewhere - an
 * officer firing across the street, a round hitting a wall, a blast - is
 * panned.
 *
 * VOICE BUDGET. An SMG at 780 rounds a minute plus its impacts is thirteen
 * shots and thirteen impacts a second, each up to 0.9 s long, so a naive
 * implementation would have two dozen sources alive at once and would clip the
 * bus. `MAX_VOICES` caps it, impacts are rate-limited, and the shot itself is
 * always allowed to win the last slot: a gun that stops making noise is a much
 * worse artefact than a missed ricochet.
 */

import type { AudioBusHost } from './AudioDirector';
import {
  BODY_SOUNDS,
  EXPLOSION_SOUND,
  getAudioAsset,
  HANDLING_SOUNDS,
  IMPACT_SOUNDS,
  impactSoundFor,
  ROCKET_FLIGHT_SOUND,
  WEAPON_SOUNDS,
  type AudioAssetId,
} from './manifest';

/** How many combat one-shots may sound at once. */
const MAX_VOICES = 18;
/** Of those, how many may be impacts. Shots always outrank them. */
const MAX_IMPACT_VOICES = 8;

/** Seconds between impact one-shots, so a shotgun is one hit and not eight. */
const IMPACT_INTERVAL = 0.055;

/**
 * Intensity spread on an impact.
 *
 * A weakest hit is 8 dB down and 8 per cent sharp against a full-energy one,
 * which is roughly the difference between a pistol round and a rifle round into
 * the same surface. Both ends stay clearly audible: an impact the player cannot
 * hear reads as the round having missed.
 */
const IMPACT_WEAK_LEVEL = 0.4;
const IMPACT_WEAK_RATE = 1.08;
const IMPACT_PITCH_JITTER = 0.12;

/** Pitch jitter on repeated fire, so a held trigger is not a machine. */
const SHOT_PITCH_JITTER = 0.045;
const SHOT_GAIN_JITTER_DB = 1.2;

/** Ejected brass, as a fraction of shots that get one and how late it lands. */
const SHELL_CHANCE = 0.55;
const SHELL_DELAY = 0.28;

/**
 * Distance model for a shot somebody else fired.
 *
 * `refDistance` is where it is at full level and `maxDistance` where it stops
 * being tracked. Gunfire carries much further than an engine, which is why
 * these are several times the street layer's numbers.
 */
const SHOT_REF = 9;
const SHOT_MAX = 220;
const IMPACT_REF = 5;
const IMPACT_MAX = 90;
const BLAST_REF = 22;
const BLAST_MAX = 400;

/** Health fraction at which the heartbeat starts, and where it is loudest. */
const HEARTBEAT_FROM = 0.42;
const HEARTBEAT_FULL = 0.12;

/** Seconds the ears ring after a blast close enough to deafen. */
const DEAFEN_SECONDS = 4.5;
/** How near a blast has to be to ring the ears at all. */
const DEAFEN_RADIUS = 16;

/** How fast a driven loop's level follows its target. */
const LAYER_RAMP = 0.25;

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * What a projectile arrived at.
 *
 * The known set. `impact()` deliberately accepts any string on top of it: the
 * combat layer owns its own `ImpactKind` and is growing it, and a material this
 * module has never heard of must produce a concrete hit rather than a compile
 * error in somebody else's file or, worse, a silent round.
 */
export type ImpactSoundKind = keyof typeof IMPACT_SOUNDS;
export type HandlingSound = keyof typeof HANDLING_SOUNDS;
export type WeaponSound = keyof typeof WEAPON_SOUNDS;

export interface VitalsState {
  readonly health: number;
  readonly maxHealth: number;
  readonly alive: boolean;
}

interface Voice {
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly panner: PannerNode | null;
  readonly impact: boolean;
}

/** A looping layer whose level is driven from game state rather than played. */
interface Layer {
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  level: number;
  requested: boolean;
}

/** A rocket in flight, carrying its motor loop with it. */
export interface FlightSound {
  moveTo(x: number, y: number, z: number): void;
  stop(): void;
}

const SILENT_FLIGHT: FlightSound = { moveTo: () => {}, stop: () => {} };

export interface CombatAudioStats {
  readonly voices: number;
  readonly impactVoices: number;
  readonly heartbeat: number;
  readonly tinnitus: number;
}

export class CombatAudio {
  private readonly host: AudioBusHost;
  private readonly voices = new Set<Voice>();
  private impactVoices = 0;
  private impactCooldown = 0;
  private disposed = false;

  private heartbeat: Layer | null = null;
  private tinnitus: Layer | null = null;
  private deafness = 0;
  /** Queued brass, so a shell lands after the shot rather than inside it. */
  private readonly shells: number[] = [];

  constructor(host: AudioBusHost) {
    this.host = host;
  }

  /** Asks the director to decode everything combat can trigger. */
  preload(): void {
    for (const id of Object.values(WEAPON_SOUNDS)) this.host.requestAsset(id);
    for (const id of Object.values(HANDLING_SOUNDS)) this.host.requestAsset(id);
    for (const id of Object.values(IMPACT_SOUNDS)) this.host.requestAsset(id);
    for (const id of Object.values(BODY_SOUNDS)) this.host.requestAsset(id);
    this.host.requestAsset(EXPLOSION_SOUND);
    this.host.requestAsset(ROCKET_FLIGHT_SOUND);
  }

  get stats(): CombatAudioStats {
    return {
      voices: this.voices.size,
      impactVoices: this.impactVoices,
      heartbeat: this.heartbeat?.level ?? 0,
      tinnitus: this.tinnitus?.level ?? 0,
    };
  }

  // -- firing ---------------------------------------------------------------

  /** The weapon in the player's own hands. Dry, unpanned, full level. */
  shot(weapon: WeaponSound): void {
    const id = WEAPON_SOUNDS[weapon];
    const jitterDb = (Math.random() * 2 - 1) * SHOT_GAIN_JITTER_DB;
    this.playFlat(id, dbToGain(getAudioAsset(id).trimDb + jitterDb), this.shotRate());
    if (weapon !== 'launcher' && Math.random() < SHELL_CHANCE) this.shells.push(SHELL_DELAY);
  }

  /** Somebody else's weapon, somewhere in the city. */
  shotAt(weapon: WeaponSound, x: number, y: number, z: number): void {
    const id = WEAPON_SOUNDS[weapon];
    this.playAt(id, x, y, z, dbToGain(getAudioAsset(id).trimDb), SHOT_REF, SHOT_MAX, this.shotRate(), false);
  }

  /** An empty chamber, a reload, drawing or putting the weapon away. */
  handling(kind: HandlingSound): void {
    const id = HANDLING_SOUNDS[kind];
    this.playFlat(id, dbToGain(getAudioAsset(id).trimDb), 1);
  }

  /**
   * Where a round landed. Rate-limited; a shotgun is one impact, not eight.
   *
   * `intensity` is 0..1 and defaults to 1, so every existing call site keeps
   * its current behaviour. It exists because impacts had NO intensity variation
   * at all: a .22 grazing a wall and a rifle round into the same wall were the
   * same recording at the same level, which is the defect the bullet impacts
   * shared with the vehicle ones. A weak hit is quieter AND higher - less
   * energy goes into the surface, so less of it ends up in the low end - which
   * is a cheap approximation of what actually happens and reads correctly.
   */
  impact(kind: ImpactSoundKind | string, x: number, y: number, z: number, intensity = 1): void {
    if (this.impactCooldown > 0) return;
    this.impactCooldown = IMPACT_INTERVAL;
    const id = impactSoundFor(kind);
    const strength = intensity < 0 ? 0 : intensity > 1 ? 1 : intensity;
    // Impacts vary far more than gunshots do - the same round into the same
    // wall never sounds the same twice - so they get a wider rate spread.
    const jitter = 1 + (Math.random() * 2 - 1) * IMPACT_PITCH_JITTER;
    const rate = jitter * (IMPACT_WEAK_RATE + (1 - IMPACT_WEAK_RATE) * strength);
    const gain =
      dbToGain(getAudioAsset(id).trimDb) * (IMPACT_WEAK_LEVEL + (1 - IMPACT_WEAK_LEVEL) * strength);
    this.playAt(id, x, y, z, gain, IMPACT_REF, IMPACT_MAX, rate, true);
  }

  /**
   * A detonation, and the rubble that comes down afterwards.
   *
   * `listenerDistance` is how far the player is from it, which is the only
   * thing that decides whether their ears ring: a blast across the bay is loud
   * and a blast at their feet is deafening, and the panner cannot express the
   * difference between those two on its own.
   */
  explosion(x: number, y: number, z: number, listenerDistance: number): void {
    const asset = getAudioAsset(EXPLOSION_SOUND);
    this.playAt(EXPLOSION_SOUND, x, y, z, dbToGain(asset.trimDb), BLAST_REF, BLAST_MAX, 0.94 + Math.random() * 0.1, false);
    const debris = IMPACT_SOUNDS.debris;
    this.playAt(debris, x, y, z, dbToGain(getAudioAsset(debris).trimDb - 3), BLAST_REF, BLAST_MAX, 1, false);
    if (listenerDistance < DEAFEN_RADIUS) {
      const share = 1 - listenerDistance / DEAFEN_RADIUS;
      this.deafness = Math.max(this.deafness, DEAFEN_SECONDS * share);
    }
  }

  /**
   * A rocket motor that travels with its rocket.
   *
   * Returns a handle rather than taking an id, because the caller already owns
   * the projectile and should not have to learn a second identity for it. The
   * handle is inert - never null - so a missing buffer costs the caller no
   * branch at the call site.
   */
  flight(x: number, y: number, z: number): FlightSound {
    const ctx = this.host.context;
    const bus = this.host.positionalEffectsBus;
    if (!ctx || !bus) return SILENT_FLIGHT;
    const buffer = this.host.bufferFor(ROCKET_FLIGHT_SOUND);
    if (!buffer) {
      this.host.requestAsset(ROCKET_FLIGHT_SOUND);
      return SILENT_FLIGHT;
    }
    const panner = this.makePanner(ctx, 8, 160);
    panner.connect(bus);
    setPannerPosition(panner, x, y, z);
    const gain = ctx.createGain();
    gain.gain.value = dbToGain(getAudioAsset(ROCKET_FLIGHT_SOUND).trimDb + 20);
    gain.connect(panner);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    source.start();

    let stopped = false;
    return {
      moveTo: (nx: number, ny: number, nz: number): void => {
        if (!stopped) setPannerPosition(panner, nx, ny, nz);
      },
      stop: (): void => {
        if (stopped) return;
        stopped = true;
        try {
          source.stop();
        } catch {
          /* already ended */
        }
        source.disconnect();
        gain.disconnect();
        panner.disconnect();
      },
    };
  }

  // -- the player's own body ------------------------------------------------

  hurt(): void {
    const id = BODY_SOUNDS.hurt;
    this.playFlat(id, dbToGain(getAudioAsset(id).trimDb), 0.94 + Math.random() * 0.12);
  }

  death(): void {
    const id = BODY_SOUNDS.death;
    this.playFlat(id, dbToGain(getAudioAsset(id).trimDb), 1);
  }

  /** Clears the ringing and the heartbeat. Called on respawn. */
  reset(): void {
    this.deafness = 0;
    this.shells.length = 0;
  }

  // -- frame ----------------------------------------------------------------

  update(dt: number, vitals: VitalsState): void {
    if (this.disposed) return;
    if (this.impactCooldown > 0) this.impactCooldown = Math.max(0, this.impactCooldown - dt);
    if (this.deafness > 0) this.deafness = Math.max(0, this.deafness - dt);

    for (let i = this.shells.length - 1; i >= 0; i -= 1) {
      const left = (this.shells[i] as number) - dt;
      if (left > 0) {
        this.shells[i] = left;
        continue;
      }
      this.shells.splice(i, 1);
      const id = HANDLING_SOUNDS.shell;
      this.playFlat(id, dbToGain(getAudioAsset(id).trimDb - 6), 0.9 + Math.random() * 0.2);
    }

    const share = vitals.maxHealth > 0 ? vitals.health / vitals.maxHealth : 1;
    const beat =
      !vitals.alive || share >= HEARTBEAT_FROM
        ? 0
        : Math.min(1, (HEARTBEAT_FROM - share) / (HEARTBEAT_FROM - HEARTBEAT_FULL));
    this.driveLayer('heartbeat', beat);
    this.driveLayer('tinnitus', Math.min(1, this.deafness / DEAFEN_SECONDS));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const voice of [...this.voices]) this.release(voice, true);
    this.voices.clear();
    this.impactVoices = 0;
    for (const layer of [this.heartbeat, this.tinnitus]) {
      if (!layer) continue;
      try {
        layer.source.stop();
      } catch {
        /* already ended */
      }
      layer.source.disconnect();
      layer.gain.disconnect();
    }
    this.heartbeat = null;
    this.tinnitus = null;
  }

  // -- internals ------------------------------------------------------------

  /** Shot-to-shot pitch variation. Sub-audible on its own, obvious in a burst. */
  private shotRate(): number {
    return 1 + (Math.random() * 2 - 1) * SHOT_PITCH_JITTER;
  }

  private playFlat(id: AudioAssetId, gainValue: number, rate: number): void {
    const ctx = this.host.context;
    const bus = this.host.effectsBus;
    if (!ctx || !bus || this.voices.size >= MAX_VOICES) return;
    const buffer = this.host.bufferFor(id);
    if (!buffer) {
      this.host.requestAsset(id);
      return;
    }
    const gain = ctx.createGain();
    gain.gain.value = gainValue;
    gain.connect(bus);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.connect(gain);
    this.arm({ source, gain, panner: null, impact: false });
    source.start();
  }

  private playAt(
    id: AudioAssetId,
    x: number,
    y: number,
    z: number,
    gainValue: number,
    refDistance: number,
    maxDistance: number,
    rate: number,
    impact: boolean,
  ): void {
    const ctx = this.host.context;
    const bus = this.host.positionalEffectsBus;
    if (!ctx || !bus) return;
    if (this.voices.size >= MAX_VOICES) return;
    if (impact && this.impactVoices >= MAX_IMPACT_VOICES) return;
    const buffer = this.host.bufferFor(id);
    if (!buffer) {
      this.host.requestAsset(id);
      return;
    }
    const panner = this.makePanner(ctx, refDistance, maxDistance);
    panner.connect(bus);
    setPannerPosition(panner, x, y, z);
    const gain = ctx.createGain();
    gain.gain.value = gainValue;
    gain.connect(panner);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.connect(gain);
    this.arm({ source, gain, panner, impact });
    source.start();
  }

  private makePanner(ctx: AudioContext, refDistance: number, maxDistance: number): PannerNode {
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDistance;
    panner.maxDistance = maxDistance;
    // Flatter than the street layer's 1.4: a gunshot two blocks away is still
    // a gunshot, and rolling it off as fast as an idling engine would make the
    // city sound like it has no depth during a chase.
    panner.rolloffFactor = 0.9;
    return panner;
  }

  private arm(voice: Voice): void {
    this.voices.add(voice);
    if (voice.impact) this.impactVoices += 1;
    voice.source.onended = (): void => this.release(voice, false);
  }

  private release(voice: Voice, stopping: boolean): void {
    if (!this.voices.delete(voice)) return;
    if (voice.impact) this.impactVoices = Math.max(0, this.impactVoices - 1);
    voice.source.onended = null;
    if (stopping) {
      try {
        voice.source.stop();
      } catch {
        /* already ended */
      }
    }
    voice.source.disconnect();
    voice.gain.disconnect();
    voice.panner?.disconnect();
  }

  /**
   * Starts a driven loop the first time it is asked for above zero and leaves
   * it running at gain zero afterwards.
   *
   * A heartbeat that is started and stopped clicks on every transition and
   * restarts mid-beat; one that runs silently costs one source and never does
   * either.
   */
  private driveLayer(which: 'heartbeat' | 'tinnitus', target: number): void {
    const existing = which === 'heartbeat' ? this.heartbeat : this.tinnitus;
    if (!existing) {
      if (target <= 0) return;
      const created = this.startLayer(which === 'heartbeat' ? BODY_SOUNDS.heartbeat : BODY_SOUNDS.tinnitus);
      if (!created) return;
      if (which === 'heartbeat') this.heartbeat = created;
      else this.tinnitus = created;
      return;
    }
    if (Math.abs(target - existing.level) < 0.01) return;
    existing.level = target;
    const ctx = this.host.context;
    const trim = dbToGain(
      getAudioAsset(which === 'heartbeat' ? BODY_SOUNDS.heartbeat : BODY_SOUNDS.tinnitus).trimDb,
    );
    const value = trim * target;
    if (ctx) {
      existing.gain.gain.cancelScheduledValues(ctx.currentTime);
      existing.gain.gain.setTargetAtTime(value, ctx.currentTime, LAYER_RAMP);
    } else {
      existing.gain.gain.value = value;
    }
  }

  private startLayer(id: AudioAssetId): Layer | null {
    const ctx = this.host.context;
    const bus = this.host.effectsBus;
    if (!ctx || !bus) return null;
    const buffer = this.host.bufferFor(id);
    if (!buffer) {
      this.host.requestAsset(id);
      return null;
    }
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(bus);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    source.start();
    return { source, gain, level: 0, requested: true };
  }
}

function setPannerPosition(panner: PannerNode, x: number, y: number, z: number): void {
  if (panner.positionX) {
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
  } else if (typeof panner.setPosition === 'function') {
    panner.setPosition(x, y, z);
  }
}
