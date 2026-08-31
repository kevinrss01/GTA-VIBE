/**
 * The city with its mouth open: what the police shout and what the crowd says.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   const voices = new CrowdVoice(audio);       // audio: AudioBusHost
 *
 *   voices.preload();                           // after the start gesture
 *
 *   // once per frame, with the listener where the ears are:
 *   voices.update(dt, {
 *     x, y, z, indoors,
 *     police: police.voiceCues,                 // drained every frame
 *     conversations: pedestrians.conversations, // groups mid-sentence
 *   });
 *
 *   voices.react('gun', x, y, z);               // one-off, from a game event
 *   voices.dispose();
 *
 * ============================================================================
 *
 * ## Why this is a layer of its own
 *
 * `Dialogue` plays a scripted line with a subtitle at a moment the mission
 * chose, through the effects bus, unspatialised, one at a time. None of that is
 * true here. A bark has no script position, is picked from a pool, is
 * spatialised on whoever says it, and is competing with an engine and a siren.
 * The two share nothing but the word "speech".
 *
 * ## What actually stops it becoming noise
 *
 * A talking city is a very easy thing to overdo, and every constant below is
 * about not doing that:
 *
 *   - ONE LINE AT A TIME per category, and at most `MAX_VOICES` in the air
 *     altogether. Two overlapping lines are unintelligible, and three read as a
 *     fault rather than as a crowd.
 *   - A GLOBAL COOLDOWN per category on top of the per-source ones the callers
 *     already apply, because a cordon of four officers and a street of forty
 *     people are both perfectly capable of producing a legal line every frame.
 *   - NO IMMEDIATE REPEATS from a pool. Hearing the same sentence twice running
 *     is what makes a bark system sound like a bark system.
 *   - CHATTER IS DROPPED INDOORS and beyond `CHATTER_RADIUS`, which is a
 *     conversation's own range rather than a shout's. Overhearing somebody
 *     through a wall from thirty metres is worse than silence.
 *
 * Everything degrades to silence: a missing buffer, a locked context or a
 * dead panner constructor makes a call a no-op, never an exception into the
 * frame loop.
 */

import type { AudioBusHost } from './AudioDirector';
import { getAudioAsset } from './manifest';
import type { AudioAssetId, CrowdVoiceAssetId } from './manifest';

// ---------------------------------------------------------------------------
// The pools
// ---------------------------------------------------------------------------

/** An officer on foot ordering somebody to stop. */
const POLICE_CHALLENGE: readonly CrowdVoiceAssetId[] = [
  'vox/pol-stop-1',
  'vox/pol-stop-2',
  'vox/pol-stop-3',
  'vox/pol-halt-1',
  'vox/pol-halt-2',
  'vox/pol-halt-3',
];

/** The same order to somebody behind a wheel. */
const POLICE_PULLOVER: readonly CrowdVoiceAssetId[] = [
  'vox/pol-pullover-1',
  'vox/pol-pullover-2',
];

/** Unit-to-unit traffic as a pursuit opens. */
const POLICE_RADIO: readonly CrowdVoiceAssetId[] = [
  'vox/pol-radio-1',
  'vox/pol-radio-2',
  'vox/pol-radio-3',
];

/** An officer who can no longer see the player. */
const POLICE_LOST: readonly CrowdVoiceAssetId[] = ['vox/pol-lost-1', 'vox/pol-lost-2'];

/**
 * Half a conversation, in seven voices.
 *
 * Two lines per speaker, and the group picks a speaker rather than a line, so
 * a pair talking to each other never answers itself in its own voice.
 */
const CHATTER: readonly (readonly CrowdVoiceAssetId[])[] = [
  ['vox/chat-a-1', 'vox/chat-a-2'],
  ['vox/chat-b-1', 'vox/chat-b-2'],
  ['vox/chat-c-1', 'vox/chat-c-2'],
  ['vox/chat-d-1', 'vox/chat-d-2'],
  ['vox/chat-e-1', 'vox/chat-e-2'],
  ['vox/chat-f-1', 'vox/chat-f-2'],
  ['vox/chat-g-1', 'vox/chat-g-2'],
];

const REACT_SHOVE: readonly CrowdVoiceAssetId[] = ['vox/react-shove-1', 'vox/react-shove-2'];
const REACT_GUN: readonly CrowdVoiceAssetId[] = [
  'vox/react-gun-1',
  'vox/react-gun-2',
  'vox/react-gun-3',
];

const ALL_LINES: readonly CrowdVoiceAssetId[] = [
  ...POLICE_CHALLENGE,
  ...POLICE_PULLOVER,
  ...POLICE_RADIO,
  ...POLICE_LOST,
  ...CHATTER.flat(),
  ...REACT_SHOVE,
  ...REACT_GUN,
];

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Distance models, in metres: where a line is at full level and where it stops.
 *
 * A shout carries; a conversation does not. `CHATTER_RADIUS` is under half the
 * police one because being able to make out what two strangers are saying from
 * across a junction is not a detail, it is a bug.
 */
const POLICE_REF = 9;
const POLICE_MAX = 60;
const CHATTER_REF = 3.5;
const CHATTER_RADIUS = 20;
const REACT_REF = 5;
const REACT_MAX = 30;

/** Level of each category before the bus trim, 0..1. */
const POLICE_LEVEL = 1;
const CHATTER_LEVEL = 0.62;
const REACT_LEVEL = 0.85;

/**
 * Seconds between lines, per category.
 *
 * The police number is deliberately shorter than `OFFICER_VOICE_COOLDOWN`: the
 * police system already spaces one OFFICER's orders, and this only stops four
 * of them from all shouting in the same half second.
 */
const POLICE_GAP = 2.2;
const CHATTER_GAP = 5.5;
const REACT_GAP = 1.6;

/**
 * Speech in flight at once.
 *
 * Two, and the second only ever from a different category - the police talking
 * over a passer-by is a real thing that happens, two passers-by talking over
 * each other from four metres apart is not.
 */
const MAX_VOICES = 2;

/** How much a wall takes off a shout. Chatter is dropped indoors outright. */
const INDOOR_DUCK = 0.35;

/** Seconds past a line's own length before it is swept. See `Shot.endsAt`. */
const REAP_SLACK = 1;

// ---------------------------------------------------------------------------
// The public shape
// ---------------------------------------------------------------------------

/** A pursuit cue, structurally the police system's `PoliceVoiceCue`. */
export interface VoiceCue {
  readonly kind: 'challenge' | 'pullover' | 'radio' | 'lost';
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * A group of people who are talking, as the crowd reports them.
 *
 * `speaking` is which member has the floor, and it is the crowd's business
 * rather than this layer's: the same person has to be the one whose head is
 * turned. `line` advances every time the group changes speaker, and is what
 * stops a group repeating one sentence for as long as the player stands there.
 */
export interface ConversationView {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Which of the seven voices this speaker has. */
  readonly speaker: number;
  /** Increments on every hand-over, so a new line is a new event. */
  readonly line: number;
}

export interface CrowdVoiceContext {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly indoors: boolean;
  readonly police: readonly VoiceCue[];
  readonly conversations: readonly ConversationView[];
}

export interface CrowdVoiceStats {
  /** Lines currently in the air. */
  readonly voices: number;
  /** Lines started since construction, by category. */
  readonly police: number;
  readonly chatter: number;
  readonly reactions: number;
  /** True once every recording is resident. */
  readonly ready: boolean;
}

interface Shot {
  readonly source: AudioBufferSourceNode;
  readonly gain: GainNode;
  readonly panner: PannerNode;
  /**
   * Context time this line must be finished by, plus a second of slack.
   *
   * A BACKSTOP, not the release path: `onended` is what normally frees a shot.
   * But the whole budget is two voices, so a single `onended` that never
   * arrives - a suspended context, a node the browser collected, a headless
   * harness stepping the simulation faster than the audio clock - silences the
   * layer for the rest of the session rather than costing one line. Sweeping
   * on the clock cannot do that.
   */
  endsAt: number;
}

/** A group's last spoken line, so the same one is not repeated on hand-over. */
interface GroupMemory {
  line: number;
  last: CrowdVoiceAssetId | null;
}

export class CrowdVoice {
  private readonly host: AudioBusHost;
  private readonly shots = new Set<Shot>();
  private readonly groups = new Map<number, GroupMemory>();

  private policeGap = 0;
  private chatterGap = 0;
  private reactGap = 0;
  private lastPolice: CrowdVoiceAssetId | null = null;
  private lastReact: CrowdVoiceAssetId | null = null;
  private counts = { police: 0, chatter: 0, reactions: 0 };
  private requested = false;
  private disposed = false;

  constructor(host: AudioBusHost) {
    this.host = host;
  }

  get stats(): CrowdVoiceStats {
    return {
      voices: this.shots.size,
      police: this.counts.police,
      chatter: this.counts.chatter,
      reactions: this.counts.reactions,
      ready: this.ready,
    };
  }

  private get ready(): boolean {
    for (const id of ALL_LINES) if (!this.host.bufferFor(id)) return false;
    return true;
  }

  /**
   * Fetches every recording.
   *
   * A line that arrives after the moment it belonged to is worse than no line
   * at all - the same reason `CombatAudio.preload` exists - and the whole set
   * is about 1.2 MB, so it is asked for once on the start gesture rather than
   * being paid for during the boot.
   */
  preload(): void {
    if (this.disposed || this.requested) return;
    this.requested = true;
    for (const id of ALL_LINES) this.host.requestAsset(id);
  }

  update(dt: number, ctx: CrowdVoiceContext): void {
    if (this.disposed) return;
    const step = dt > 0 && dt < 0.5 ? dt : 1 / 60;
    this.policeGap = Math.max(0, this.policeGap - step);
    this.chatterGap = Math.max(0, this.chatterGap - step);
    this.reactGap = Math.max(0, this.reactGap - step);

    this.reap();
    this.updatePolice(ctx);
    this.updateChatter(ctx);
    this.forgetStaleGroups(ctx);
  }

  /**
   * A passer-by reacting to the player, from a game event rather than a state.
   *
   * `shove` is being walked into; `gun` is a weapon coming out in public.
   */
  react(kind: 'shove' | 'gun', x: number, y: number, z: number): void {
    if (this.disposed || this.reactGap > 0) return;
    const pool = kind === 'gun' ? REACT_GUN : REACT_SHOVE;
    const id = this.pick(pool, this.lastReact);
    if (!id) return;
    if (!this.play(id, x, y, z, REACT_LEVEL, REACT_REF, REACT_MAX, false)) return;
    this.lastReact = id;
    this.reactGap = REACT_GAP;
    this.counts.reactions += 1;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const shot of this.shots) {
      this.stop(shot.source);
      this.disconnect(shot.gain);
      this.disconnect(shot.panner);
    }
    this.shots.clear();
    this.groups.clear();
  }

  /** Frees any line whose recording has certainly finished. See `Shot.endsAt`. */
  private reap(): void {
    if (this.shots.size === 0) return;
    const ctx = this.host.context;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const shot of this.shots) {
      if (shot.endsAt > now) continue;
      this.shots.delete(shot);
      this.stop(shot.source);
      this.disconnect(shot.gain);
      this.disconnect(shot.panner);
    }
  }

  // -- the police ------------------------------------------------------------

  private updatePolice(ctx: CrowdVoiceContext): void {
    if (ctx.police.length === 0 || this.policeGap > 0) return;
    // One line per frame however many officers qualified: the rest of the
    // cordon has its own cooldown and will get its turn.
    const cue = ctx.police[0];
    if (!cue) return;
    const pool =
      cue.kind === 'pullover'
        ? POLICE_PULLOVER
        : cue.kind === 'radio'
          ? POLICE_RADIO
          : cue.kind === 'lost'
            ? POLICE_LOST
            : POLICE_CHALLENGE;
    const id = this.pick(pool, this.lastPolice);
    if (!id) return;
    if (!this.play(id, cue.x, cue.y, cue.z, POLICE_LEVEL, POLICE_REF, POLICE_MAX, ctx.indoors)) {
      return;
    }
    this.lastPolice = id;
    this.policeGap = POLICE_GAP;
    this.counts.police += 1;
  }

  // -- the crowd -------------------------------------------------------------

  private updateChatter(ctx: CrowdVoiceContext): void {
    // Inside a building the street is not what the player is listening to, and
    // a conversation heard through a wall is worse than a quiet room.
    if (ctx.indoors || this.chatterGap > 0) return;

    let best: ConversationView | null = null;
    let bestSq = CHATTER_RADIUS * CHATTER_RADIUS;
    for (const group of ctx.conversations) {
      const memory = this.groups.get(group.id);
      // Nothing to say until the crowd hands the floor to somebody new.
      if (memory && memory.line === group.line) continue;
      const dx = group.x - ctx.x;
      const dz = group.z - ctx.z;
      const d = dx * dx + dz * dz;
      if (d < bestSq) {
        bestSq = d;
        best = group;
      }
    }
    if (!best) return;

    const memory = this.groups.get(best.id) ?? { line: -1, last: null };
    const pool = CHATTER[best.speaker % CHATTER.length];
    if (!pool) return;
    const id = this.pick(pool, memory.last);
    if (!id) return;
    if (!this.play(id, best.x, best.y, best.z, CHATTER_LEVEL, CHATTER_REF, CHATTER_RADIUS, false)) {
      return;
    }
    // Consumed only once the line has actually started. Marking the hand-over
    // before that would have a group silently skip a sentence whenever the
    // voice budget happened to be full at the moment it changed speaker.
    memory.line = best.line;
    memory.last = id;
    this.groups.set(best.id, memory);
    this.chatterGap = CHATTER_GAP;
    this.counts.chatter += 1;
  }

  /** Drops the memory of groups the crowd has recycled, so the map is bounded. */
  private forgetStaleGroups(ctx: CrowdVoiceContext): void {
    if (this.groups.size <= ctx.conversations.length + 8) return;
    const live = new Set<number>();
    for (const group of ctx.conversations) live.add(group.id);
    for (const id of this.groups.keys()) if (!live.has(id)) this.groups.delete(id);
  }

  // -- playback --------------------------------------------------------------

  /** A line from a pool that is not the one just heard. Null if none is ready. */
  private pick(
    pool: readonly CrowdVoiceAssetId[],
    avoid: CrowdVoiceAssetId | null,
  ): CrowdVoiceAssetId | null {
    if (pool.length === 0) return null;
    const first = Math.floor(Math.random() * pool.length);
    for (let i = 0; i < pool.length; i += 1) {
      const id = pool[(first + i) % pool.length];
      if (!id) continue;
      if (id === avoid && pool.length > 1) continue;
      if (this.host.bufferFor(id)) return id;
    }
    // Everything is either the last line or still loading. Asking again is
    // free and idempotent, and silence for a beat is the right answer.
    this.preload();
    return null;
  }

  private play(
    id: AudioAssetId,
    x: number,
    y: number,
    z: number,
    level: number,
    refDistance: number,
    maxDistance: number,
    indoors: boolean,
  ): boolean {
    if (this.shots.size >= MAX_VOICES) return false;
    const ctx = this.host.context;
    const bus = this.host.positionalEffectsBus;
    if (!ctx || !bus) return false;
    const buffer = this.host.bufferFor(id);
    if (!buffer) return false;

    let panner: PannerNode;
    try {
      panner = ctx.createPanner();
    } catch {
      return false;
    }
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = refDistance;
    panner.maxDistance = maxDistance;
    panner.rolloffFactor = 1.2;
    if (panner.positionX) {
      panner.positionX.value = x;
      panner.positionY.value = y;
      panner.positionZ.value = z;
    } else if (typeof panner.setPosition === 'function') {
      panner.setPosition(x, y, z);
    }
    panner.connect(bus);

    const trim = Math.pow(10, getAudioAsset(id).trimDb / 20);
    const gain = ctx.createGain();
    gain.gain.value = level * trim * (indoors ? INDOOR_DUCK : 1);
    gain.connect(panner);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    const shot: Shot = {
      source,
      gain,
      panner,
      endsAt: ctx.currentTime + getAudioAsset(id).duration + REAP_SLACK,
    };
    this.shots.add(shot);
    source.onended = (): void => {
      this.shots.delete(shot);
      this.disconnect(source);
      this.disconnect(gain);
      this.disconnect(panner);
    };
    try {
      source.start();
    } catch {
      this.shots.delete(shot);
      return false;
    }
    return true;
  }

  private stop(source: AudioBufferSourceNode): void {
    try {
      source.onended = null;
      source.stop();
    } catch {
      /* Already stopped, or a mock that cannot be. */
    }
  }

  private disconnect(node: AudioNode): void {
    try {
      node.disconnect();
    } catch {
      /* Disconnecting twice is legal enough to ignore. */
    }
  }
}
