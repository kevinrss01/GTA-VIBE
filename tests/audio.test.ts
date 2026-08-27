/**
 * Audio tests.
 *
 * These run in plain Node with no jsdom: Web Audio, `fetch` and the small slice
 * of `document` the director uses are all mocked here, which keeps the engine
 * honest about staying renderer-free and browser-agnostic.
 *
 * The bulk of the file guards the music contract, because "music is off until
 * the player asks for it, and the file is not even downloaded before then" is a
 * product requirement rather than an implementation detail.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AudioDirector,
  HARBOUR_PA_POSITION,
  INDOOR_DUCK_DB,
  type ListenerState,
} from '../src/audio/AudioDirector';
import {
  AUDIO_ASSETS,
  DISTRICT_AMBIENCE,
  MUSIC_ASSET_ID,
  PRELOAD_ASSET_IDS,
  SEA_BED,
  STEP_SURFACES,
  getAudioAsset,
} from '../src/audio/manifest';
import { getCityPlan } from '../src/world/CityPlan';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------------------------------------------------------------------------
// Web Audio mock
// ---------------------------------------------------------------------------

interface FakeBuffer {
  readonly duration: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  /** The URL this buffer was decoded from, so tests can identify sources. */
  readonly url: string;
}

interface FakeGain {
  gain: FakeParam;
  connect(): void;
  disconnect(): void;
}

interface FakeSource {
  buffer: FakeBuffer | null;
  loop: boolean;
  started: boolean;
  stopped: boolean;
  onended: (() => void) | null;
  playbackRate: { value: number };
  /** The gain node this source feeds, so a test can read its live level. */
  target: FakeGain | null;
  connect(node: FakeGain): void;
  disconnect(): void;
  start(): void;
  stop(): void;
}

class FakeParam {
  value = 0;
  setValueAtTime(v: number): FakeParam {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number): FakeParam {
    this.value = v;
    return this;
  }
  cancelScheduledValues(): FakeParam {
    return this;
  }
}

interface Harness {
  fetched: string[];
  sources: FakeSource[];
  suspendCalls: number;
  resumeCalls: number;
  closed: boolean;
  listeners: Map<string, Array<() => void>>;
  visibility: 'visible' | 'hidden';
}

let h: Harness;

/** A URL that should never resolve, used for the degradation test. */
let failingUrls: string[] = [];

function installMocks(): void {
  h = {
    fetched: [],
    sources: [],
    suspendCalls: 0,
    resumeCalls: 0,
    closed: false,
    listeners: new Map(),
    visibility: 'visible',
  };
  failingUrls = [];

  const bufferUrls = new WeakMap<ArrayBuffer, string>();

  const scope = globalThis as unknown as Record<string, unknown>;

  scope['fetch'] = async (url: string): Promise<unknown> => {
    h.fetched.push(url);
    if (failingUrls.some((f) => url.includes(f))) {
      return { ok: false, status: 404, arrayBuffer: async (): Promise<ArrayBuffer> => new ArrayBuffer(0) };
    }
    const bytes = new ArrayBuffer(16);
    bufferUrls.set(bytes, url);
    return { ok: true, status: 200, arrayBuffer: async (): Promise<ArrayBuffer> => bytes };
  };

  function makeGain(): FakeGain {
    return { gain: new FakeParam(), connect: () => undefined, disconnect: () => undefined };
  }

  function makeSource(): FakeSource {
    const source: FakeSource = {
      buffer: null,
      loop: false,
      started: false,
      stopped: false,
      onended: null,
      playbackRate: { value: 1 },
      target: null,
      connect: (node: FakeGain) => {
        source.target = node;
      },
      disconnect: () => undefined,
      start: () => {
        source.started = true;
      },
      stop: () => {
        source.stopped = true;
      },
    };
    h.sources.push(source);
    return source;
  }

  function makePanner(): unknown {
    return {
      panningModel: '',
      distanceModel: '',
      refDistance: 0,
      maxDistance: 0,
      rolloffFactor: 0,
      positionX: new FakeParam(),
      positionY: new FakeParam(),
      positionZ: new FakeParam(),
      connect: () => undefined,
      disconnect: () => undefined,
    };
  }

  class FakeAudioContext {
    currentTime = 0;
    state = 'running';
    destination = { connect: () => undefined, disconnect: () => undefined };
    listener = {
      positionX: new FakeParam(),
      positionY: new FakeParam(),
      positionZ: new FakeParam(),
      forwardX: new FakeParam(),
      forwardY: new FakeParam(),
      forwardZ: new FakeParam(),
      upX: new FakeParam(),
      upY: new FakeParam(),
      upZ: new FakeParam(),
    };
    createGain = makeGain;
    createBufferSource = makeSource;
    createPanner = makePanner;
    async decodeAudioData(bytes: ArrayBuffer): Promise<FakeBuffer> {
      const url = bufferUrls.get(bytes);
      if (!url) throw new Error('undecodable');
      return { duration: 1, sampleRate: 44100, numberOfChannels: 2, url };
    }
    async resume(): Promise<void> {
      h.resumeCalls += 1;
    }
    async suspend(): Promise<void> {
      h.suspendCalls += 1;
    }
    async close(): Promise<void> {
      h.closed = true;
    }
  }

  scope['AudioContext'] = FakeAudioContext;

  scope['document'] = {
    get visibilityState(): string {
      return h.visibility;
    },
    addEventListener: (type: string, fn: () => void): void => {
      const list = h.listeners.get(type) ?? [];
      list.push(fn);
      h.listeners.set(type, list);
    },
    removeEventListener: (type: string, fn: () => void): void => {
      const list = h.listeners.get(type) ?? [];
      h.listeners.set(
        type,
        list.filter((f) => f !== fn),
      );
    },
  };
}

function fireVisibility(to: 'visible' | 'hidden'): void {
  h.visibility = to;
  for (const fn of h.listeners.get('visibilitychange') ?? []) fn();
}

function musicFetches(): string[] {
  return h.fetched.filter((u) => u.includes('meridian-theme'));
}

function musicSources(): FakeSource[] {
  return h.sources.filter((s) => s.buffer?.url.includes('meridian-theme') === true);
}

const STATE: ListenerState = {
  x: 0,
  y: 1.7,
  z: 0,
  forwardX: 0,
  forwardZ: -1,
  district: 'core',
  surface: 'pavement',
  indoors: false,
};

/** Harbour Walk, on the quay. Its centreline is the promenade's x. */
const PROMENADE: ListenerState = {
  ...STATE,
  x: -160,
  z: 0,
  district: 'harbourside',
  surface: 'boardwalk',
};

/** Lantern Park, taken from the fountain landmark in the city plan. */
const PARK: ListenerState = (() => {
  const fountain = getCityPlan().landmarks.find((l) => l.id === 'park-fountain');
  if (!fountain) throw new Error('no park fountain in the plan');
  return { ...STATE, x: fountain.x, z: fountain.z, district: 'civic', surface: 'gravel' };
})();

/** Inland positions the sea must never reach, waterfront-facing streets first. */
const INLAND_SPOTS: readonly { x: number; z: number }[] = [
  { x: -74, z: 0 }, // Cannery Row
  { x: -28, z: 0 }, // Meridian Avenue
  { x: PARK.x, z: PARK.z }, // Lantern Park
  { x: 190, z: -128 }, // the east ridge, by the water tower
];

const SEA_TRIM = Math.pow(10, getAudioAsset(SEA_BED).trimDb / 20);

function seaSources(): FakeSource[] {
  return h.sources.filter((s) => s.buffer?.url.includes('ambience/harbour') === true && !s.stopped);
}

/** One frame plus the microtasks a lazily started bed needs to appear. */
async function frame(audio: AudioDirector, state: ListenerState): Promise<void> {
  audio.update(0.016, state);
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  installMocks();
});

afterEach(() => {
  const scope = globalThis as unknown as Record<string, unknown>;
  delete scope['AudioContext'];
  delete scope['document'];
  delete scope['fetch'];
});

// ---------------------------------------------------------------------------

describe('music defaults', () => {
  it('is off before anything happens', () => {
    const audio = new AudioDirector();
    expect(audio.musicEnabled).toBe(false);
    expect(audio.unlocked).toBe(false);
    audio.dispose();
  });

  it('never fetches the music file on construction', () => {
    const audio = new AudioDirector();
    expect(h.fetched).toHaveLength(0);
    audio.dispose();
  });

  it('never fetches or decodes the music file during unlock', async () => {
    const audio = new AudioDirector();
    await audio.unlock();

    expect(audio.unlocked).toBe(true);
    expect(audio.musicEnabled).toBe(false);
    // Everything else did load, so the assertion below is not vacuous.
    expect(h.fetched.length).toBe(PRELOAD_ASSET_IDS.length);
    expect(musicFetches()).toHaveLength(0);
    expect(musicSources()).toHaveLength(0);
    audio.dispose();
  });

  it('stays off across many update frames', () => {
    const audio = new AudioDirector();
    for (let i = 0; i < 120; i += 1) audio.update(1 / 60, STATE);
    expect(audio.musicEnabled).toBe(false);
    expect(musicFetches()).toHaveLength(0);
    audio.dispose();
  });

  it('starts off again on a fresh instance after one enabled it', async () => {
    const first = new AudioDirector();
    await first.unlock();
    await first.setMusicEnabled(true);
    expect(first.musicEnabled).toBe(true);
    first.dispose();

    // Nothing may persist the choice: a reload must come back silent.
    const second = new AudioDirector();
    expect(second.musicEnabled).toBe(false);
    await second.unlock();
    expect(second.musicEnabled).toBe(false);
    second.dispose();
  });
});

describe('music enable/disable', () => {
  it('lazily fetches the track only on first enable, then starts it looping', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    expect(musicFetches()).toHaveLength(0);

    await audio.setMusicEnabled(true);

    expect(audio.musicEnabled).toBe(true);
    expect(musicFetches()).toHaveLength(1);
    const sources = musicSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]?.started).toBe(true);
    expect(sources[0]?.loop).toBe(true);
    expect(sources[0]?.stopped).toBe(false);
    audio.dispose();
  });

  it('leaves music stopped after enabling then disabling', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    await audio.setMusicEnabled(true);
    await audio.setMusicEnabled(false);

    expect(audio.musicEnabled).toBe(false);
    const sources = musicSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]?.stopped).toBe(true);
    audio.dispose();
  });

  it('does not re-fetch the track when it is toggled again', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    await audio.setMusicEnabled(true);
    await audio.setMusicEnabled(false);
    await audio.setMusicEnabled(true);

    expect(musicFetches()).toHaveLength(1);
    expect(musicSources()).toHaveLength(2);
    audio.dispose();
  });

  it('ignores a redundant enable and does not stack sources', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    await audio.setMusicEnabled(true);
    await audio.setMusicEnabled(true);

    expect(musicSources()).toHaveLength(1);
    audio.dispose();
  });

  it('does not start music if it was switched off while the file was loading', async () => {
    const audio = new AudioDirector();
    await audio.unlock();

    const enabling = audio.setMusicEnabled(true);
    const disabling = audio.setMusicEnabled(false);
    await Promise.all([enabling, disabling]);

    expect(audio.musicEnabled).toBe(false);
    for (const source of musicSources()) expect(source.started).toBe(false);
    audio.dispose();
  });
});

describe('music is immune to lifecycle events', () => {
  it('does not start music on a visibility change while music is off', async () => {
    const audio = new AudioDirector();
    await audio.unlock();

    fireVisibility('hidden');
    fireVisibility('visible');

    // The hook really did run, so this test cannot pass vacuously.
    expect(h.suspendCalls).toBe(1);
    expect(h.resumeCalls).toBeGreaterThanOrEqual(1);

    expect(audio.musicEnabled).toBe(false);
    expect(musicFetches()).toHaveLength(0);
    expect(musicSources()).toHaveLength(0);
    audio.dispose();
  });

  it('does not restart a playing track on a visibility change', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    await audio.setMusicEnabled(true);

    fireVisibility('hidden');
    fireVisibility('visible');
    audio.update(1 / 60, STATE);

    // Same single source, still running: resumed, not restarted.
    const sources = musicSources();
    expect(sources).toHaveLength(1);
    expect(sources[0]?.stopped).toBe(false);
    expect(audio.musicEnabled).toBe(true);
    audio.dispose();
  });

  it('does not start music from update(), however many frames run', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    for (let i = 0; i < 600; i += 1) audio.update(0.25, { ...STATE, x: i });

    expect(audio.musicEnabled).toBe(false);
    expect(musicFetches()).toHaveLength(0);
    audio.dispose();
  });
});

describe('ambience', () => {
  it('starts a looping bed for the district and crossfades on a change', async () => {
    const audio = new AudioDirector();
    await audio.unlock();

    audio.update(0.016, STATE);
    await Promise.resolve();
    await Promise.resolve();

    const street = h.sources.filter((s) => s.buffer?.url.includes('ambience/street') === true);
    expect(street).toHaveLength(1);
    expect(street[0]?.loop).toBe(true);
    expect(street[0]?.started).toBe(true);

    audio.update(0.016, { ...STATE, district: 'oldQuarter', surface: 'pavement' });
    await Promise.resolve();
    await Promise.resolve();

    const oldQuarter = h.sources.filter(
      (s) => s.buffer?.url.includes('ambience/old-quarter') === true,
    );
    expect(oldQuarter).toHaveLength(1);
    expect(oldQuarter[0]?.loop).toBe(true);
    expect(oldQuarter[0]?.started).toBe(true);
    // The bed it replaced is on its way out, not still at full level.
    expect(street[0]?.stopped).toBe(true);
    audio.dispose();
  });

  it('gives a returning listener a fresh voice rather than reviving a dying one', async () => {
    // Regression: a scheduled stop() cannot be cancelled, so walking out of and
    // straight back into a district must not ramp a doomed source back up.
    const audio = new AudioDirector();
    await audio.unlock();

    const settle = async (): Promise<void> => {
      await Promise.resolve();
      await Promise.resolve();
    };
    const streetSources = (): FakeSource[] =>
      h.sources.filter((s) => s.buffer?.url.includes('ambience/street') === true);

    audio.update(0.016, STATE);
    await settle();
    expect(streetSources()).toHaveLength(1);

    audio.update(0.016, { ...STATE, district: 'ridge', surface: 'gravel' });
    await settle();
    audio.update(0.016, STATE);
    await settle();

    const street = streetSources();
    expect(street).toHaveLength(2);
    expect(street[0]?.stopped).toBe(true);
    expect(street[1]?.stopped).toBe(false);
    expect(street[1]?.started).toBe(true);
    audio.dispose();
  });

  it('never lets the sea reach the city, whatever the reported district is', async () => {
    // Regression for "the sea sound follows the player everywhere". The frame
    // loop has no block under the player on any street corridor and reports
    // `harbourside` there, so the worst case is the whole city claiming to be
    // the waterfront: the distance to the water has to be what silences it.
    const audio = new AudioDirector();
    await audio.unlock();

    for (const spot of INLAND_SPOTS) {
      await frame(audio, { ...STATE, ...spot, district: 'harbourside', surface: 'boardwalk' });
    }

    expect(seaSources()).toHaveLength(0);
    audio.dispose();
  });

  it('brings the bay in at full level on the promenade', async () => {
    const audio = new AudioDirector();
    await audio.unlock();

    await frame(audio, PROMENADE);
    // The loop is asked for at zero and brought up on the next frame, so that a
    // target that went stale during the decode cannot land it at an audible
    // level somewhere inland.
    await frame(audio, PROMENADE);

    const sea = seaSources();
    expect(sea).toHaveLength(1);
    expect(sea[0]?.loop).toBe(true);
    expect(sea[0]?.started).toBe(true);
    expect(sea[0]?.target?.gain.value ?? 0).toBeCloseTo(SEA_TRIM, 6);
    audio.dispose();
  });

  it('sums the bay on top of the land bed rather than replacing it', async () => {
    const audio = new AudioDirector();
    await audio.unlock();

    await frame(audio, PROMENADE);
    await frame(audio, PROMENADE);

    // Both are sounding: the quay has a city behind it and water in front.
    expect(seaSources()).toHaveLength(1);
    const land = h.sources.filter(
      (s) => s.buffer?.url.includes('ambience/street') === true && !s.stopped,
    );
    expect(land).toHaveLength(1);
    expect(land[0]?.target?.gain.value ?? 0).toBeGreaterThan(0);
    audio.dispose();
  });

  it('fades the bay out and releases the loop as the player walks inland', async () => {
    const audio = new AudioDirector();
    await audio.unlock();

    await frame(audio, PROMENADE);
    await frame(audio, PROMENADE);
    const sea = seaSources()[0];
    expect(sea?.target?.gain.value ?? 0).toBeGreaterThan(0);

    // Walk due east to the park at 4 m steps, the way a player actually would.
    let last = sea?.target?.gain.value ?? 0;
    for (let x = PROMENADE.x; x <= PARK.x; x += 4) {
      await frame(audio, { ...PROMENADE, x });
      const level = sea?.target?.gain.value ?? 0;
      expect(level, `level rose walking inland at x=${x}`).toBeLessThanOrEqual(last + 1e-9);
      last = level;
    }

    expect(last).toBe(0);
    expect(sea?.stopped).toBe(true);
    expect(seaSources()).toHaveLength(0);
    audio.dispose();
  });

  it('brings the bay back when the player returns to the water', async () => {
    // Regression: a released loop cannot be restarted, so walking inland and
    // back has to produce a brand new voice rather than a permanently silent
    // one. This is the same trap the land beds have a test for.
    const audio = new AudioDirector();
    await audio.unlock();

    await frame(audio, PROMENADE);
    await frame(audio, PROMENADE);
    const first = seaSources()[0];
    expect(first?.target?.gain.value ?? 0).toBeGreaterThan(0);

    await frame(audio, PARK);
    await frame(audio, PARK);
    expect(seaSources()).toHaveLength(0);
    expect(first?.stopped).toBe(true);

    await frame(audio, PROMENADE);
    await frame(audio, PROMENADE);
    const second = seaSources();
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first);
    expect(second[0]?.started).toBe(true);
    expect(second[0]?.target?.gain.value ?? 0).toBeCloseTo(SEA_TRIM, 6);
    audio.dispose();
  });

  it('retries the bay after a failed download, once per trip to the water', async () => {
    failingUrls = ['ambience/harbour'];
    const audio = new AudioDirector();
    await audio.unlock();

    const seaFetches = (): number => h.fetched.filter((u) => u.includes('ambience/harbour')).length;
    const afterPreload = seaFetches();

    // Standing on the quay must not refetch a missing file every frame.
    for (let i = 0; i < 30; i += 1) await frame(audio, PROMENADE);
    expect(seaSources()).toHaveLength(0);
    expect(seaFetches()).toBe(afterPreload + 1);

    // Leaving and coming back is worth exactly one more attempt.
    await frame(audio, PARK);
    await frame(audio, PROMENADE);
    await frame(audio, PROMENADE);
    expect(seaFetches()).toBe(afterPreload + 2);
    audio.dispose();
  });

  it('leaves a shorefront interior a muffled bay and an inland one none', async () => {
    const audio = new AudioDirector();
    await audio.unlock();

    await frame(audio, { ...PROMENADE, indoors: true, surface: 'interior' });
    await frame(audio, { ...PROMENADE, indoors: true, surface: 'interior' });

    const sea = seaSources()[0];
    const indoorLevel = sea?.target?.gain.value ?? 0;
    expect(indoorLevel).toBeGreaterThan(0);
    // Ducked by exactly the same amount as the land bed is indoors.
    expect(indoorLevel).toBeCloseTo(SEA_TRIM * Math.pow(10, INDOOR_DUCK_DB / 20), 6);

    await frame(audio, { ...PARK, indoors: true, surface: 'interior' });
    await frame(audio, { ...PARK, indoors: true, surface: 'interior' });
    expect(sea?.target?.gain.value ?? 0).toBe(0);
    audio.dispose();
  });

  it('brings in the interior bed when the listener goes indoors', async () => {
    const audio = new AudioDirector();
    await audio.unlock();

    audio.update(0.016, { ...STATE, indoors: true, surface: 'interior' });
    await Promise.resolve();
    await Promise.resolve();

    const interior = h.sources.filter((s) => s.buffer?.url.includes('ambience/interior') === true);
    expect(interior).toHaveLength(1);
    expect(interior[0]?.loop).toBe(true);
    audio.dispose();
  });
});

describe('surface coverage', () => {
  /**
   * Reads the union straight out of the world module, so adding a SurfaceId
   * without a footstep mapping fails here as well as at compile time.
   */
  function surfaceIdsFromSource(): string[] {
    const src = readFileSync(join(ROOT, 'src/world/CityGround.ts'), 'utf8');
    const match = /export type SurfaceId =([\s\S]*?);/.exec(src);
    expect(match).not.toBeNull();
    return [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
  }

  it('maps every SurfaceId in CityGround.ts to two step variants', () => {
    const surfaces = surfaceIdsFromSource();
    expect(surfaces.length).toBeGreaterThanOrEqual(9);

    for (const surface of surfaces) {
      const variants = (STEP_SURFACES as Record<string, readonly string[] | undefined>)[surface];
      expect(variants, `no footstep mapping for surface '${surface}'`).toBeDefined();
      expect(variants).toHaveLength(2);
      expect(variants?.[0]).not.toBe(variants?.[1]);
    }
  });

  it('points every step mapping at a real manifest asset', () => {
    for (const variants of Object.values(STEP_SURFACES)) {
      for (const id of variants) expect(() => getAudioAsset(id)).not.toThrow();
    }
  });

  it('gives every district an ambience bed', () => {
    const districts = new Set(getCityPlan().blocks.map((b) => b.district));
    for (const district of districts) {
      expect(DISTRICT_AMBIENCE[district]).toBeDefined();
      expect(() => getAudioAsset(DISTRICT_AMBIENCE[district])).not.toThrow();
    }
  });

  it('alternates the two variants for a surface', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    for (let i = 0; i < 4; i += 1) audio.footstep('pavement', false);

    const used = h.sources
      .filter((s) => s.buffer?.url.includes('/steps/') === true)
      .map((s) => s.buffer?.url ?? '');
    expect(used).toHaveLength(4);
    expect(used[0]).not.toBe(used[1]);
    expect(used[0]).toBe(used[2]);
    audio.dispose();
  });
});

describe('manifest integrity', () => {
  it('ships every manifest asset on disk at the recorded size', () => {
    for (const asset of AUDIO_ASSETS) {
      const file = join(ROOT, 'public', asset.path);
      expect(existsSync(file), `missing audio file for ${asset.id}: ${asset.path}`).toBe(true);
      expect(statSync(file).size, `size drift for ${asset.id}`).toBe(asset.bytes);
    }
  });

  it('has unique ids and paths', () => {
    const ids = AUDIO_ASSETS.map((a) => a.id);
    const paths = AUDIO_ASSETS.map((a) => a.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('excludes music from the preload set', () => {
    expect(PRELOAD_ASSET_IDS).not.toContain(MUSIC_ASSET_ID);
    expect(PRELOAD_ASSET_IDS.length).toBe(AUDIO_ASSETS.length - 1);
  });

  it('records provenance without leaking a key or a signed URL', () => {
    const sources = [
      readFileSync(join(ROOT, 'src/audio/manifest.ts'), 'utf8'),
      readFileSync(join(ROOT, 'docs/audio-manifest.md'), 'utf8'),
    ];
    for (const text of sources) {
      expect(text).not.toMatch(/X-Goog-Signature/);
      expect(text).not.toMatch(/xi-api-key/i);
      expect(text).not.toMatch(/sk_[a-zA-Z0-9]{16}/);
    }

    for (const asset of AUDIO_ASSETS) {
      expect(asset.generation.provider).toBe('elevenlabs');
      expect(asset.generation.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('keeps the harbour PA in step with the ferry terminal in the city plan', () => {
    const terminal = getCityPlan().landmarks.find((l) => l.id === 'ferry-terminal');
    expect(terminal).toBeDefined();
    expect(HARBOUR_PA_POSITION.x).toBe(terminal?.x);
    expect(HARBOUR_PA_POSITION.z).toBe(terminal?.z);
  });
});

describe('robustness', () => {
  it('degrades silently when a file is missing and never throws', async () => {
    failingUrls = ['ambience/street'];
    const audio = new AudioDirector();
    await audio.unlock();

    expect(() => audio.update(0.016, STATE)).not.toThrow();
    expect(() => audio.footstep('pavement', true)).not.toThrow();
    expect(() => audio.playOneShot('door-open')).not.toThrow();
    audio.dispose();
  });

  it('is inert before unlock and never throws', () => {
    const audio = new AudioDirector();
    expect(() => audio.update(0.016, STATE)).not.toThrow();
    expect(() => audio.footstep('gravel', false)).not.toThrow();
    expect(() => audio.playOneShot('ui-tick')).not.toThrow();
    expect(h.sources).toHaveLength(0);
    audio.dispose();
  });

  it('closes the context and detaches its listener on dispose', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    audio.update(0.016, STATE);
    audio.dispose();

    expect(h.closed).toBe(true);
    expect(audio.unlocked).toBe(false);
    expect(h.listeners.get('visibilitychange') ?? []).toHaveLength(0);
  });

  it('stops every sounding source on dispose', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    await audio.setMusicEnabled(true);
    audio.update(0.016, STATE);
    await Promise.resolve();
    await Promise.resolve();

    const looping = h.sources.filter((s) => s.loop);
    expect(looping.length).toBeGreaterThan(0);
    audio.dispose();
    for (const source of looping) expect(source.stopped).toBe(true);
  });

  it('survives dispose being called twice', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    audio.dispose();
    expect(() => audio.dispose()).not.toThrow();
  });

  it('ignores enabling music after dispose', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    audio.dispose();
    await audio.setMusicEnabled(true);
    expect(audio.musicEnabled).toBe(false);
    expect(musicFetches()).toHaveLength(0);
  });
});
