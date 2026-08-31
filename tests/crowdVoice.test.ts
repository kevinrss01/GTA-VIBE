/**
 * The city with its mouth open: conversations, and the layer that voices them.
 *
 * Two halves, and neither needs a browser or a pair of ears.
 *
 * `crowd.ts` is asserted against the live city plan: do people actually stop
 * and talk, do they face each other, does the group hand the floor back and
 * forth, and - the property that matters most - does it always release both
 * parties, because nothing else in the crowd will ever move somebody who is
 * standing still. See `CHAT_SECONDS_MAX` for why that has a hard ceiling.
 *
 * `CrowdVoice` is asserted against a mocked bus host. The useful questions
 * about it are structural: does a cue produce a line, is the pool bounded, do
 * the cooldowns hold, is chatter refused through a wall and from across a
 * junction, and does a voice whose `onended` never arrives still free its slot.
 *
 * NOTE ON WHAT THIS CANNOT PROVE. Nothing here shows the result SOUNDS right;
 * that is a listening judgement and no test in this repository makes one.
 */

import { describe, expect, it } from 'vitest';

import { buildRoadNetwork } from '../src/city/RoadNetwork';
import { getCityPlan } from '../src/world/CityPlan';
import { CityGround } from '../src/world/CityGround';
import { Crowd } from '../src/agents/crowd';
import { ObstacleIndex } from '../src/agents/obstacles';
import { buildPavementGraph } from '../src/agents/pavement';
import { CrowdVoice, type ConversationView, type VoiceCue } from '../src/audio/CrowdVoice';
import { getAudioAsset, AUDIO_ASSETS } from '../src/audio/manifest';
import type { AudioAssetId } from '../src/audio/manifest';
import type { AudioBusHost } from '../src/audio/AudioDirector';

// ---------------------------------------------------------------------------
// Conversations, against the live city
// ---------------------------------------------------------------------------

const plan = getCityPlan();
const network = buildRoadNetwork(plan);
const ground = new CityGround(plan);
const graph = buildPavementGraph(plan, network);
const obstacles = new ObstacleIndex(plan, ground);
const SPAWN = plan.spawn;

function makeCrowd(population = 220): Crowd {
  return new Crowd({ ground, network, graph, obstacles, population, seed: plan.seed });
}

interface ChatRun {
  /** Highest number of conversations alive at any one moment. */
  readonly peak: number;
  /** Conversation ids seen, so the churn is visible. */
  readonly seen: Set<number>;
  /** Longest any one person was inside a conversation, in seconds. */
  readonly longest: number;
  /** Worst angle between a speaker's facing and their partner, in radians. */
  readonly worstFacing: number;
  /** Highest `line` any group reached, so hand-overs are visible. */
  readonly bestLine: number;
}

/** Runs the crowd beside the player and watches what the groups do. */
function runChats(crowd: Crowd, seconds: number, dt = 1 / 30): ChatRun {
  const steps = Math.round(seconds / dt);
  const held = new Float64Array(crowd.peds.length);
  const seen = new Set<number>();
  let peak = 0;
  let longest = 0;
  let worstFacing = 0;
  let bestLine = 0;

  for (let step = 0; step < steps; step += 1) {
    crowd.update(dt, { x: SPAWN.x, y: 0, z: SPAWN.z, time: step * dt });
    const groups = crowd.conversations;
    peak = Math.max(peak, groups.length);
    for (const group of groups) {
      seen.add(group.id);
      bestLine = Math.max(bestLine, group.line);
    }
    for (let i = 0; i < crowd.peds.length; i += 1) {
      const ped = crowd.peds[i];
      if (!ped) continue;
      if (ped.chat === 0) {
        held[i] = 0;
        continue;
      }
      held[i] = (held[i] ?? 0) + dt;
      longest = Math.max(longest, held[i] ?? 0);
    }
    // Everybody in a group must be facing their partner. Checked on the pair
    // rather than on the published view, because the view only carries whoever
    // currently has the floor.
    for (const ped of crowd.peds) {
      if (!ped.active || ped.chat === 0) continue;
      const other = crowd.peds.find((p) => p !== ped && p.chat === ped.chat);
      if (!other) continue;
      const dx = other.x - ped.x;
      const dz = other.z - ped.z;
      if (dx * dx + dz * dz < 1e-4) continue;
      const want = Math.atan2(-dx, -dz);
      let delta = Math.abs(((ped.heading - want + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (!Number.isFinite(delta)) delta = 0;
      worstFacing = Math.max(worstFacing, delta);
    }
  }
  return { peak, seen, longest, worstFacing, bestLine };
}

describe('conversations', () => {
  const crowd = makeCrowd();
  const run = runChats(crowd, 120);

  it('gets people talking on the pavement near the player', () => {
    // The number that matters is that it happens AT ALL near the listener: a
    // conversation carries about 20 m and the crowd covers 63,000 square
    // metres, which is why they are formed inside `CHAT_FORM_RADIUS`.
    expect(run.peak).toBeGreaterThan(0);
    expect(run.seen.size).toBeGreaterThan(3);
  });

  it('never exceeds the conversation budget', () => {
    // MAX_CONVERSATIONS. A pavement with more people standing than walking is
    // a market rather than a street.
    expect(run.peak).toBeLessThanOrEqual(10);
  });

  it('turns both parties to face each other', () => {
    // Within a couple of degrees: the heading is written directly, not damped.
    expect(run.worstFacing).toBeLessThan(0.05);
  });

  it('hands the floor back and forth rather than holding one line', () => {
    expect(run.bestLine).toBeGreaterThan(0);
  });

  it('always lets go, because nothing else in the crowd will', () => {
    /*
     * THE INVARIANT THIS FEATURE COULD BREAK. `watchStall` polices `walk` and
     * `cross` only - standing still is a decision, not a failure - so a
     * conversation that never ended would root two people to a pavement for
     * the rest of the session, and `tests/crowdCorners.test.ts` holds the
     * whole crowd to nobody standing still for thirty seconds.
     */
    expect(run.longest).toBeLessThanOrEqual(17.5);
    for (const ped of crowd.peds) {
      if (ped.chat === 0) continue;
      // Anybody still in a group is in one that exists.
      expect(crowd.conversations.some((c) => c.id === ped.chat)).toBe(true);
    }
  });

  it('publishes a reused array rather than allocating one per frame', () => {
    expect(crowd.conversations).toBe(crowd.conversations);
  });
});

// ---------------------------------------------------------------------------
// The voice layer, against a mocked bus
// ---------------------------------------------------------------------------

class FakeParam {
  value = 0;
}

interface FakeShot {
  started: boolean;
  stopped: boolean;
  disconnected: boolean;
  onended: (() => void) | null;
  buffer: { id: AudioAssetId } | null;
}

/** Everything `CrowdVoice` touches, and nothing else. */
class FakeHost implements AudioBusHost {
  currentTime = 0;
  readonly shots: FakeShot[] = [];
  readonly panners: { refDistance: number; maxDistance: number; x: number }[] = [];
  readonly requested: AudioAssetId[] = [];
  /** Assets pretended to be resident. Everything by default. */
  resident: Set<AudioAssetId> | null = null;
  private readonly buffers = new Map<AudioAssetId, { id: AudioAssetId }>();

  get context(): AudioContext | null {
    // The object literal below is the mocked `AudioContext`, and its methods
    // need a handle on the host that owns it. A class field holding an arrow
    // would not give the mock the shape a real context has.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const host = this;
    return {
      get currentTime(): number {
        return host.currentTime;
      },
      createPanner(): unknown {
        const panner = {
          panningModel: '',
          distanceModel: '',
          refDistance: 0,
          maxDistance: 0,
          rolloffFactor: 0,
          positionX: new FakeParam(),
          positionY: new FakeParam(),
          positionZ: new FakeParam(),
          connect: (): void => {},
          disconnect: (): void => {},
        };
        host.panners.push({
          get refDistance(): number {
            return panner.refDistance;
          },
          get maxDistance(): number {
            return panner.maxDistance;
          },
          get x(): number {
            return panner.positionX.value;
          },
        } as { refDistance: number; maxDistance: number; x: number });
        return panner;
      },
      createGain(): unknown {
        return { gain: new FakeParam(), connect: (): void => {}, disconnect: (): void => {} };
      },
      createBufferSource(): unknown {
        const shot: FakeShot = {
          started: false,
          stopped: false,
          disconnected: false,
          onended: null,
          buffer: null,
        };
        host.shots.push(shot);
        return {
          set buffer(value: { id: AudioAssetId } | null) {
            shot.buffer = value;
          },
          get buffer(): { id: AudioAssetId } | null {
            return shot.buffer;
          },
          playbackRate: new FakeParam(),
          set onended(fn: (() => void) | null) {
            shot.onended = fn;
          },
          get onended(): (() => void) | null {
            return shot.onended;
          },
          connect: (): void => {},
          disconnect: (): void => {
            shot.disconnected = true;
          },
          start: (): void => {
            shot.started = true;
          },
          stop: (): void => {
            shot.stopped = true;
          },
        };
      },
    } as unknown as AudioContext;
  }

  get effectsBus(): GainNode | null {
    return {} as GainNode;
  }

  get positionalEffectsBus(): GainNode | null {
    return {} as GainNode;
  }

  get ambienceLayerBus(): GainNode | null {
    return {} as GainNode;
  }

  bufferFor(id: AudioAssetId): AudioBuffer | null {
    if (this.resident && !this.resident.has(id)) return null;
    let buffer = this.buffers.get(id);
    if (!buffer) {
      buffer = { id };
      this.buffers.set(id, buffer);
    }
    return buffer as unknown as AudioBuffer;
  }

  requestAsset(id: AudioAssetId): void {
    this.requested.push(id);
  }

  /** Ends every line in flight, the way a real context does. */
  finish(): void {
    for (const shot of this.shots) shot.onended?.();
  }

  /** Which recordings have actually been started, in order. */
  get played(): AudioAssetId[] {
    return this.shots.filter((s) => s.started && s.buffer).map((s) => s.buffer?.id as AudioAssetId);
  }
}

const LISTENER = { x: 0, y: 1.6, z: 0, indoors: false } as const;

function challengeAt(x: number, z: number): VoiceCue {
  return { kind: 'challenge', x, y: 1.6, z };
}

function talkersAt(x: number, z: number, line = 1, id = 1): ConversationView {
  return { id, x, y: 1.5, z, speaker: 0, line };
}

/** Runs `update` for the given seconds so the cooldowns actually elapse. */
function tick(voice: CrowdVoice, host: FakeHost, seconds: number, context: object): void {
  const dt = 1 / 30;
  for (let i = 0; i < Math.round(seconds / dt); i += 1) {
    host.currentTime += dt;
    voice.update(dt, { ...LISTENER, police: [], conversations: [], ...context });
  }
}

describe('crowd and police voices', () => {
  it('says something when an officer challenges the player', () => {
    const host = new FakeHost();
    const voice = new CrowdVoice(host);
    voice.update(1 / 30, {
      ...LISTENER,
      police: [challengeAt(6, 0)],
      conversations: [],
    });
    expect(host.played).toHaveLength(1);
    expect(host.played[0]?.startsWith('vox/pol-')).toBe(true);
    voice.dispose();
  });

  it('picks the pool the cue asked for', () => {
    const kinds: { kind: VoiceCue['kind']; prefix: string }[] = [
      { kind: 'challenge', prefix: 'vox/pol-' },
      { kind: 'pullover', prefix: 'vox/pol-pullover' },
      { kind: 'radio', prefix: 'vox/pol-radio' },
      { kind: 'lost', prefix: 'vox/pol-lost' },
    ];
    for (const { kind, prefix } of kinds) {
      const host = new FakeHost();
      const voice = new CrowdVoice(host);
      voice.update(1 / 30, {
        ...LISTENER,
        police: [{ kind, x: 5, y: 1.6, z: 0 }],
        conversations: [],
      });
      expect(host.played[0]?.startsWith(prefix), `${kind} -> ${host.played[0]}`).toBe(true);
      voice.dispose();
    }
  });

  it('holds a cordon of four officers to one line at a time', () => {
    const host = new FakeHost();
    const voice = new CrowdVoice(host);
    // Every officer qualifying on the same frame, for two seconds.
    for (let i = 0; i < 60; i += 1) {
      host.currentTime += 1 / 30;
      voice.update(1 / 30, {
        ...LISTENER,
        police: [challengeAt(5, 0), challengeAt(6, 1), challengeAt(7, 2), challengeAt(8, 3)],
        conversations: [],
      });
    }
    // POLICE_GAP is 2.2 s, so two seconds of continuous cues is one line.
    expect(host.played).toHaveLength(1);
    voice.dispose();
  });

  it('never says the same line twice running', () => {
    const host = new FakeHost();
    const voice = new CrowdVoice(host);
    const said: string[] = [];
    for (let round = 0; round < 8; round += 1) {
      voice.update(1 / 30, {
        ...LISTENER,
        police: [challengeAt(5, 0)],
        conversations: [],
      });
      host.finish();
      const last = host.played[host.played.length - 1];
      if (last) said.push(last);
      tick(voice, host, 2.5, {});
    }
    expect(said.length).toBeGreaterThan(4);
    for (let i = 1; i < said.length; i += 1) expect(said[i]).not.toBe(said[i - 1]);
    voice.dispose();
  });

  it('overhears a conversation nearby and not one across the junction', () => {
    const near = new FakeHost();
    const voiceNear = new CrowdVoice(near);
    voiceNear.update(1 / 30, { ...LISTENER, police: [], conversations: [talkersAt(4, 0)] });
    expect(near.played).toHaveLength(1);
    expect(near.played[0]?.startsWith('vox/chat-')).toBe(true);
    voiceNear.dispose();

    const far = new FakeHost();
    const voiceFar = new CrowdVoice(far);
    // Beyond CHATTER_RADIUS.
    voiceFar.update(1 / 30, { ...LISTENER, police: [], conversations: [talkersAt(45, 0)] });
    expect(far.played).toHaveLength(0);
    voiceFar.dispose();
  });

  it('does not overhear the street from inside a building', () => {
    const host = new FakeHost();
    const voice = new CrowdVoice(host);
    voice.update(1 / 30, {
      ...LISTENER,
      indoors: true,
      police: [],
      conversations: [talkersAt(4, 0)],
    });
    expect(host.played).toHaveLength(0);
    voice.dispose();
  });

  it('says nothing more until the group hands the floor over', () => {
    const host = new FakeHost();
    const voice = new CrowdVoice(host);
    const group = talkersAt(4, 0, 1);
    voice.update(1 / 30, { ...LISTENER, police: [], conversations: [group] });
    host.finish();
    // Same `line`, for far longer than CHATTER_GAP.
    tick(voice, host, 12, { conversations: [group] });
    expect(host.played).toHaveLength(1);
    // A hand-over is a new event.
    voice.update(1 / 30, { ...LISTENER, police: [], conversations: [talkersAt(4, 0, 2)] });
    expect(host.played).toHaveLength(2);
    voice.dispose();
  });

  it('gives a shout a shout’s distance model and a conversation a conversation’s', () => {
    const host = new FakeHost();
    const voice = new CrowdVoice(host);
    voice.update(1 / 30, { ...LISTENER, police: [challengeAt(5, 0)], conversations: [] });
    const police = host.panners[0];
    host.finish();
    tick(voice, host, 6, {});
    voice.update(1 / 30, { ...LISTENER, police: [], conversations: [talkersAt(4, 0)] });
    const chatter = host.panners[1];
    expect(police?.maxDistance ?? 0).toBeGreaterThan((chatter?.maxDistance ?? 0) * 2);
    expect(police?.refDistance ?? 0).toBeGreaterThan(chatter?.refDistance ?? 0);
    voice.dispose();
  });

  it('reacts to a gun and to somebody being knocked down', () => {
    const host = new FakeHost();
    const voice = new CrowdVoice(host);
    voice.react('gun', 3, 1.6, 0);
    expect(host.played[0]?.startsWith('vox/react-gun')).toBe(true);
    host.finish();
    tick(voice, host, 2, {});
    voice.react('shove', 3, 1.6, 0);
    expect(host.played[1]?.startsWith('vox/react-shove')).toBe(true);
    voice.dispose();
  });

  it('never has more than two lines in the air', () => {
    const host = new FakeHost();
    const voice = new CrowdVoice(host);
    // Nothing is ever allowed to finish, and everything asks at once.
    for (let i = 0; i < 400; i += 1) {
      host.currentTime += 1 / 30;
      voice.update(1 / 30, {
        ...LISTENER,
        police: [challengeAt(5, 0)],
        conversations: [talkersAt(4, 0, i)],
      });
      voice.react('gun', 3, 1.6, 0);
    }
    expect(voice.stats.voices).toBeLessThanOrEqual(2);
    voice.dispose();
  });

  it('frees a line whose onended never arrives', () => {
    /*
     * THE FAILURE THIS GUARDS. The budget is two voices and `onended` is the
     * only thing that normally returns one - so a single lost callback, from a
     * suspended context or a collected node, silences the layer for the rest
     * of the session rather than costing one line. `Shot.endsAt` is the
     * backstop and this is the proof it works.
     */
    const host = new FakeHost();
    const voice = new CrowdVoice(host);
    voice.update(1 / 30, { ...LISTENER, police: [challengeAt(5, 0)], conversations: [] });
    voice.react('gun', 3, 1.6, 0);
    expect(voice.stats.voices).toBe(2);
    // No `finish()`: every callback is lost. Past the longest line plus slack.
    tick(voice, host, 12, {});
    expect(voice.stats.voices).toBe(0);
    voice.dispose();
  });

  it('degrades to silence while the recordings are still loading', () => {
    const host = new FakeHost();
    host.resident = new Set();
    const voice = new CrowdVoice(host);
    voice.update(1 / 30, { ...LISTENER, police: [challengeAt(5, 0)], conversations: [] });
    expect(host.played).toHaveLength(0);
    // And it asks for them rather than giving up.
    expect(host.requested.length).toBeGreaterThan(0);
    voice.dispose();
  });

  it('preloads every line it can ever play, and they all exist', () => {
    const host = new FakeHost();
    host.resident = new Set();
    const voice = new CrowdVoice(host);
    voice.preload();
    expect(host.requested.length).toBe(32);
    for (const id of host.requested) expect(() => getAudioAsset(id)).not.toThrow();
    // Every `vox/` asset in the manifest is reachable from a pool: a recording
    // that is shipped and never played is 40 KB of dead weight.
    const shipped = AUDIO_ASSETS.filter((a) => a.id.startsWith('vox/')).map((a) => a.id);
    expect([...host.requested].sort()).toEqual([...shipped].sort());
    voice.dispose();
  });

  it('stops and disconnects everything it holds on dispose', () => {
    const host = new FakeHost();
    const voice = new CrowdVoice(host);
    voice.update(1 / 30, { ...LISTENER, police: [challengeAt(5, 0)], conversations: [] });
    voice.dispose();
    expect(host.shots.every((s) => s.stopped)).toBe(true);
    expect(voice.stats.voices).toBe(0);
  });
});
