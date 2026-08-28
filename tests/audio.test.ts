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
  PLAYER_STEP_CEILING_DB,
  PLAYER_STEP_DB,
  type ListenerState,
} from '../src/audio/AudioDirector';
import {
  AIRPORT_BED,
  AUDIO_ASSETS,
  CONCRETE_STEPS,
  DISTRICT_AMBIENCE,
  LAZY_ASSET_IDS,
  MUSIC_ASSET_ID,
  POLICE_SOUNDS,
  PRELOAD_ASSET_IDS,
  SEA_BED,
  STEP_FAMILIES,
  STEP_MEAN_DB,
  STEP_SURFACES,
  TERMINAL_STEPS,
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

/**
 * A stand-in for `AudioParam` that refuses non-finite numbers, because the
 * real one does.
 *
 * The browser throws `TypeError: Failed to set the 'value' property on
 * 'AudioParam': The provided float value is non-finite`, and since the listener
 * is written from inside the frame loop that exception takes rendering, input
 * and the simulation down with it. A mock that quietly accepted NaN made the
 * test guarding against it vacuous - it stayed green with the guard deleted.
 * Caught by Greptile.
 */
class FakeParam {
  private current = 0;

  get value(): number {
    return this.current;
  }

  set value(next: number) {
    FakeParam.check(next);
    this.current = next;
  }

  setValueAtTime(v: number): FakeParam {
    FakeParam.check(v);
    this.current = v;
    return this;
  }
  linearRampToValueAtTime(v: number): FakeParam {
    FakeParam.check(v);
    this.current = v;
    return this;
  }
  cancelScheduledValues(): FakeParam {
    return this;
  }

  private static check(v: number): void {
    if (!Number.isFinite(v)) {
      throw new TypeError(
        "Failed to set the 'value' property on 'AudioParam': The provided float value is non-finite.",
      );
    }
  }
}

interface FakeCompressor {
  threshold: FakeParam;
  knee: FakeParam;
  ratio: FakeParam;
  attack: FakeParam;
  release: FakeParam;
  connect(): void;
  disconnect(): void;
}

interface Harness {
  fetched: string[];
  sources: FakeSource[];
  compressors: FakeCompressor[];
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
    compressors: [],
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

  function makeCompressor(): FakeCompressor {
    const node: FakeCompressor = {
      threshold: new FakeParam(),
      knee: new FakeParam(),
      ratio: new FakeParam(),
      attack: new FakeParam(),
      release: new FakeParam(),
      connect: () => undefined,
      disconnect: () => undefined,
    };
    h.compressors.push(node);
    return node;
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
    createDynamicsCompressor = makeCompressor;
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

/**
 * Fires `ended` on every one-shot that has been started, the way a real context
 * does when the buffer runs out. The mock never does it on its own, which is
 * the right default for testing the hard voice caps and the wrong one for
 * testing anything that happens across several steps.
 */
function endFinishedSources(): void {
  for (const source of h.sources) {
    if (source.loop || !source.started || source.stopped || !source.onended) continue;
    const done = source.onended;
    source.onended = null;
    source.stopped = true;
    done();
  }
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
    // Ending each voice between steps is what a real context does: a 0.32 s
    // asset is long finished by the next footfall at 0.518 s walking. Without
    // it this would be testing the hard voice cap instead of the alternation.
    for (let i = 0; i < 4; i += 1) {
      audio.footstep({ surface: 'pavement' });
      endFinishedSources();
    }

    const used = h.sources
      .filter((s) => s.buffer?.url.includes('/steps/') === true)
      .map((s) => s.buffer?.url ?? '');
    expect(used).toHaveLength(4);
    expect(used[0]).not.toBe(used[1]);
    expect(used[0]).toBe(used[2]);
    audio.dispose();
  });
});

describe('footstep loudness and cadence', () => {
  /**
   * The rebalance, asserted as arithmetic rather than as a listening opinion.
   *
   * The measured defect was a 15.5 dB spread in POST-TRIM MEAN level across the
   * step set - grass-2 at -23.9 dB against grass-1 at -39.4 dB, alternating on
   * every other step - caused by peak-normalising transients, which does not
   * equalise loudness. `meanDb` in the manifest is the ffmpeg measurement of
   * the shipped file, so trim + mean is exactly what a player hears.
   */
  const stepIds = [...new Set(Object.values(STEP_SURFACES).flat())];

  it('levels every surface to within 4 dB of the others', () => {
    const levels = stepIds.map((id) => {
      const asset = getAudioAsset(id);
      return { id, effective: STEP_MEAN_DB[id] + asset.trimDb };
    });
    const lowest = Math.min(...levels.map((l) => l.effective));
    const highest = Math.max(...levels.map((l) => l.effective));
    expect(highest - lowest, `spread across ${levels.length} step assets`).toBeLessThanOrEqual(4);
  });

  it('keeps the two variants of a surface within a step of each other', () => {
    // The grass pair was 15.5 dB apart and alternated, which is heard as a
    // limp rather than as variation. The runtime's own jitter is +/-2 dB, so
    // anything inside 4 dB is indistinguishable from that jitter.
    for (const [surface, variants] of Object.entries(STEP_SURFACES)) {
      const [a, b] = variants;
      const levelA = STEP_MEAN_DB[a] + getAudioAsset(a).trimDb;
      const levelB = STEP_MEAN_DB[b] + getAudioAsset(b).trimDb;
      expect(Math.abs(levelA - levelB), `${surface} variants`).toBeLessThanOrEqual(4);
    }
  });

  it('is short enough that a running footstep cannot overlap the last one', () => {
    // RUN_SPEED 6.0 m/s over a 1.95 m stride is a step every 0.325 s. Every
    // asset used to be 0.680249 s, so two or three summed at a run.
    const runningCadence = 1.95 / 6.0;
    for (const id of stepIds) {
      expect(getAudioAsset(id).duration, id).toBeLessThanOrEqual(runningCadence);
    }
  });

  it('caps the player\'s own footsteps by count, not only by cadence', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    // Nothing ends these sources, which is the frame-rate-collapse case: the
    // ceiling has to hold without help from `onended`.
    for (let i = 0; i < 40; i += 1) audio.footstep({ surface: 'pavement', running: true });
    const live = h.sources.filter((s) => s.buffer?.url.includes('/steps/') === true && !s.stopped);
    expect(live.length).toBeLessThanOrEqual(3);
    audio.dispose();
  });

  it('keeps the player\'s own footsteps under the documented ceiling', async () => {
    // The complaint was that they are too loud. The trim is 8 dB, the running
    // bonus 3.5 and the jitter +/-2, so the loudest OFFSET the mixer can
    // produce is -2.5 dB; the ceiling is asserted here rather than trusted.
    const audio = new AudioDirector();
    await audio.unlock();
    let loudest = -Infinity;
    for (let i = 0; i < 400; i += 1) {
      audio.footstep({ surface: 'pavement', running: true, foot: i % 2 ? 'left' : 'right' });
      endFinishedSources();
      const last = audio.debug.lastFootstep;
      if (last) loudest = Math.max(loudest, last.offsetDb);
    }
    expect(loudest).toBeLessThanOrEqual(PLAYER_STEP_CEILING_DB);
    // And genuinely quieter than the raw asset trim it used to play at.
    expect(PLAYER_STEP_DB).toBeLessThanOrEqual(-6);
    audio.dispose();
  });

  it('does not undo the asset rebalance while it is turning the volume down', async () => {
    /*
     * A step asset's `trimDb` is a per-file CORRECTION towards a -22 dBFS mean,
     * not a level, and the corrections run from -4.2 to +9.4 dB. Clamping
     * `trim + offset` therefore attenuates exactly the files whose correction
     * is largest, which is the 15.5 dB loudness spread the 2026-08-27 rebalance
     * removed, creeping back in through the mixer. Measured in the browser
     * before this was fixed: grass lost 3.4 dB and boardwalk 2.6 dB while
     * terminal and concrete lost nothing.
     *
     * The invariant: whatever the mixer does, `gainDb - offsetDb` is exactly
     * the asset's own trim, for every family.
     */
    const audio = new AudioDirector();
    await audio.unlock();
    const families = Object.keys(STEP_FAMILIES) as Array<keyof typeof STEP_FAMILIES>;
    const material: Partial<Record<string, string>> = {
      terminal: 'tileFloor',
      concrete: 'concrete',
      boardwalk: 'timber',
      asphalt: 'asphalt',
      pavement: 'pavement',
      gravel: 'gravel',
      grass: 'grass',
    };
    for (const family of families) {
      for (const running of [false, true]) {
        audio.footstep({
          surface: 'interior',
          material: material[family],
          running,
        });
        endFinishedSources();
        const last = audio.debug.lastFootstep;
        expect(last, family).not.toBeNull();
        if (!last) continue;
        expect(last.family, `material ${String(material[family])}`).toBe(family);
        expect(last.gainDb - last.offsetDb).toBeCloseTo(getAudioAsset(last.assetId).trimDb, 6);
      }
    }
    audio.dispose();
  });

  it('makes a run heavier and lower, not merely higher', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    const sample = (running: boolean): { gainDb: number; rate: number } => {
      let gain = 0;
      let rate = 0;
      for (let i = 0; i < 200; i += 1) {
        audio.footstep({ surface: 'pavement', running, foot: i % 2 === 0 ? 'left' : 'right' });
        endFinishedSources();
        const last = audio.debug.lastFootstep;
        if (!last) continue;
        gain += last.gainDb;
        rate += last.rate;
      }
      return { gainDb: gain / 200, rate: rate / 200 };
    };
    const walking = sample(false);
    const running = sample(true);
    expect(running.gainDb).toBeGreaterThan(walking.gainDb);
    // Heavier lands LOWER. The old constants raised the pitch, which is what a
    // lighter contact sounds like.
    expect(running.rate).toBeLessThan(walking.rate);
    audio.dispose();
  });

  it('places the two feet either side of the listener', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    audio.footstep({ surface: 'pavement', foot: 'left' });
    const left = audio.debug.lastFootstep?.pan ?? 0;
    endFinishedSources();
    audio.footstep({ surface: 'pavement', foot: 'right' });
    const right = audio.debug.lastFootstep?.pan ?? 0;
    expect(left).toBeLessThan(0);
    expect(right).toBeGreaterThan(0);
    expect(Math.abs(left)).toBeLessThanOrEqual(0.5);
    audio.dispose();
  });

  it('gives the airfield its own materials rather than reusing the pavement', () => {
    // Distinguishable is the requirement, and these are separate recordings
    // with separate prompts rather than a remap of an existing pair.
    const pairs = [CONCRETE_STEPS, TERMINAL_STEPS, STEP_SURFACES.pavement, STEP_SURFACES.interior];
    const files = pairs.flat();
    expect(new Set(files).size).toBe(files.length);
    for (const id of [...CONCRETE_STEPS, ...TERMINAL_STEPS]) {
      expect(() => getAudioAsset(id)).not.toThrow();
    }
  });
});

describe('footstep material selection', () => {
  function stepFiles(): string[] {
    return h.sources
      .filter((s) => s.buffer?.url.includes('/steps/') === true)
      .map((s) => (s.buffer?.url ?? '').replace(/.*\/steps\//, '').replace(/-\d\.mp3$/, ''));
  }

  /**
   * The mixer is now a mixer: a material arrives and the matching pair plays.
   *
   * The two-step hold and the `onRoad` override that used to live here are
   * gone - see the note in `AudioDirector` where they were, and
   * `tests/footsteps.test.ts` for the debounce that replaced them, which is
   * asserted for promptness AND stability rather than only for stability.
   */
  it('plays the collider material rather than the terrain under it', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    // Standing on the terminal slab: the sampler says the airfield concrete
    // the building stands on, the collider says the floor that was laid on it.
    audio.footstep({ surface: 'concrete', material: 'tileFloor' });
    expect(stepFiles()[0]).toBe('terminal');
    audio.dispose();
  });

  it('falls back to the terrain when nothing built is underfoot', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    audio.footstep({ surface: 'concrete', material: null });
    expect(stepFiles()[0]).toBe('concrete');
    audio.dispose();
  });

  it('switches material on the step that reports it, with no hold', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    audio.footstep({ surface: 'pavement' });
    endFinishedSources();
    audio.footstep({ surface: 'asphalt' });
    const heard = stepFiles();
    expect(heard[0]).toBe('pavement');
    expect(heard[1]).toBe('asphalt');
    audio.dispose();
  });
});

describe('pausing', () => {
  it('suspends the context and resumes it again', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    const before = h.suspendCalls;

    audio.setGamePaused(true);
    expect(h.suspendCalls).toBe(before + 1);
    expect(audio.suspended).toBe(true);

    audio.setGamePaused(false);
    expect(audio.suspended).toBe(false);
    audio.dispose();
  });

  it('stays suspended through pause, tab away and tab back', async () => {
    // The refcount requirement, stated as the sequence that breaks a naive
    // implementation: a single boolean or an unbalanced counter resumes a
    // PAUSED game the moment the tab comes back.
    const audio = new AudioDirector();
    await audio.unlock();

    audio.setGamePaused(true);
    fireVisibility('hidden');
    fireVisibility('visible');

    expect(audio.suspended).toBe(true);
    audio.dispose();
  });

  it('stays suspended while hidden even after the game is unpaused', async () => {
    const audio = new AudioDirector();
    await audio.unlock();

    audio.setGamePaused(true);
    fireVisibility('hidden');
    audio.setGamePaused(false);
    expect(audio.suspended).toBe(true);

    fireVisibility('visible');
    expect(audio.suspended).toBe(false);
    audio.dispose();
  });

  it('is idempotent, because visibilitychange fires more often than it changes', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    fireVisibility('hidden');
    fireVisibility('hidden');
    fireVisibility('hidden');
    fireVisibility('visible');
    expect(audio.suspended).toBe(false);
    audio.dispose();
  });

  it('never touches music state, so a playing track resumes rather than restarts', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    await audio.setMusicEnabled(true);
    const started = musicSources().length;
    expect(started).toBe(1);

    audio.setGamePaused(true);
    fireVisibility('hidden');
    fireVisibility('visible');
    audio.setGamePaused(false);

    // Same source, still running: no second buffer was started and the first
    // was never stopped, which is what "resumes rather than restarts" means.
    expect(audio.musicEnabled).toBe(true);
    expect(musicSources()).toHaveLength(started);
    expect(musicSources()[0]?.stopped).toBe(false);
    audio.dispose();
  });

  it('leaves a stopped track stopped across a pause', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    audio.setGamePaused(true);
    audio.setGamePaused(false);
    expect(audio.musicEnabled).toBe(false);
    expect(musicFetches()).toHaveLength(0);
    audio.dispose();
  });

  it('does not resume on unlock if the game was already paused', async () => {
    const audio = new AudioDirector();
    audio.setGamePaused(true);
    await audio.unlock();
    expect(audio.suspended).toBe(true);
    audio.dispose();
  });

  it('never throws when driven while suspended', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    audio.setGamePaused(true);
    expect(() => audio.update(0.016, STATE)).not.toThrow();
    expect(() => audio.footstep({ surface: 'pavement', running: true })).not.toThrow();
    expect(() => audio.setVolume('effects', 0.4)).not.toThrow();
    audio.dispose();
  });
});

describe('output limiter', () => {
  it('puts a limiter between the master gain and the output', async () => {
    // There was no compressor or limiter anywhere in the graph, and the buses
    // are trimmed for the average case: gunfire, a blast, five engines and a
    // siren inside one 50 ms window are all individually correct and sum past
    // full scale.
    const audio = new AudioDirector();
    await audio.unlock();
    expect(h.compressors).toHaveLength(1);
    const limiter = h.compressors[0];
    expect(limiter?.ratio.value).toBeGreaterThanOrEqual(10);
    expect(limiter?.threshold.value).toBeLessThan(0);
    // Transparent, not a mix effect: it must do nothing until the sum is
    // already close to clipping.
    expect(limiter?.threshold.value).toBeGreaterThanOrEqual(-6);
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

  it('preloads everything except the assets deliberately deferred', () => {
    // This used to be `AUDIO_ASSETS.length - 1`, i.e. everything but music.
    // The airfield moved it: eight aircraft assets and the apron bed are
    // 1.08 MB of a manifest for one corner of the map that most sessions never
    // visit, and every consumer of them already survives a null buffer for a
    // frame. The assertion is now against the same declared set the runtime
    // uses rather than a count, so deferring a ninth asset cannot silently
    // change what is fetched without saying so in `LAZY_ASSET_IDS`.
    expect(PRELOAD_ASSET_IDS).not.toContain(MUSIC_ASSET_ID);
    expect(PRELOAD_ASSET_IDS.length).toBe(AUDIO_ASSETS.length - LAZY_ASSET_IDS.size);
    for (const id of PRELOAD_ASSET_IDS) expect(LAZY_ASSET_IDS.has(id)).toBe(false);
    for (const id of LAZY_ASSET_IDS) expect(() => getAudioAsset(id)).not.toThrow();
  });

  it('keeps the police siren eager, because a pursuit does not announce itself', () => {
    // The one asset in this group whose lateness would be a product defect
    // rather than a loading detail.
    expect(PRELOAD_ASSET_IDS).toContain(POLICE_SOUNDS.siren);
    expect(PRELOAD_ASSET_IDS).toContain(POLICE_SOUNDS.engine);
  });

  it('defers the airfield set and the class engines, and nothing else', () => {
    // Spelled out rather than derived, so adding an asset to the lazy set is a
    // deliberate act with a reason attached rather than something that happens
    // by accident. The class engine layers and the tyre bed are 1.07 MB that a
    // player who never gets into a box truck never needs; `StreetAudio` asks
    // for them on the frame the player takes a car.
    const deferred = [...LAZY_ASSET_IDS].sort();
    const expected = [
      MUSIC_ASSET_ID,
      AIRPORT_BED,
      ...AUDIO_ASSETS.filter((a) => a.kind === 'aircraft').map((a) => a.id),
      'veh/engine-small-idle',
      'veh/engine-small-load',
      'veh/engine-sport-idle',
      'veh/engine-sport-load',
      'veh/engine-diesel-idle',
      'veh/engine-diesel-load',
      'veh/engine-truck-idle',
      'veh/engine-truck-load',
      'veh/engine-v8-idle',
      'veh/engine-v8-load',
      'veh/tyre-roll',
    ].sort();
    expect(deferred).toEqual(expected);
  });

  it('keeps the saloon engine pair eager, because it is the fallback voice', () => {
    // A class whose own layers have not arrived yet speaks with this pair, so
    // it has to be resident before the first car door closes.
    expect(PRELOAD_ASSET_IDS).toContain('veh/engine-idle');
    expect(PRELOAD_ASSET_IDS).toContain('veh/engine-load');
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
    expect(() => audio.footstep({ surface: 'pavement', running: true })).not.toThrow();
    expect(() => audio.playOneShot('door-open')).not.toThrow();
    audio.dispose();
  });

  it('is inert before unlock and never throws', () => {
    const audio = new AudioDirector();
    expect(() => audio.update(0.016, STATE)).not.toThrow();
    expect(() => audio.footstep({ surface: 'gravel' })).not.toThrow();
    expect(() => audio.playOneShot('ui-tick')).not.toThrow();
    expect(h.sources).toHaveLength(0);
    audio.dispose();
  });

  it('takes the QA hook off the window on dispose', async () => {
    // The getter closes over the director, so leaving it behind keeps a
    // disposed instance and every decoded buffer it holds alive.
    const scope = globalThis as unknown as Record<string, unknown>;
    scope['window'] = scope['window'] ?? {};
    const audio = new AudioDirector();
    await audio.unlock();
    expect((scope['window'] as Record<string, unknown>)['__meridianAudio']).toBeDefined();
    audio.dispose();
    expect((scope['window'] as Record<string, unknown>)['__meridianAudio']).toBeUndefined();
    delete scope['window'];
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

describe('the listener cannot take the game down with it', () => {
  /*
   * `AudioParam.value` throws on a non-finite number, and the listener is
   * updated from inside the frame loop - so one NaN reaching it stops
   * rendering, input and the simulation, not just the sound. Found by handing
   * it a NaN position from a QA harness; the fix is that the audio layer is
   * the wrong place to discover that something upstream produced one.
   */
  it('ignores a non-finite pose instead of throwing', async () => {
    const audio = new AudioDirector();
    await audio.unlock();
    const good = {
      x: 10, y: 1.7, z: 20, forwardX: 0, forwardZ: -1,
      district: 'harbourside' as const, surface: 'pavement' as const,
      indoors: false, speed: 0,
    };
    audio.update(1 / 60, good);
    for (const bad of [
      { ...good, x: Number.NaN },
      { ...good, y: Number.POSITIVE_INFINITY },
      { ...good, z: Number.NaN },
      { ...good, forwardX: Number.NaN },
      { ...good, forwardZ: Number.NEGATIVE_INFINITY },
    ]) {
      expect(() => audio.update(1 / 60, bad)).not.toThrow();
    }
    // And it is still working afterwards.
    expect(() => audio.update(1 / 60, good)).not.toThrow();
    audio.dispose();
  });
});
