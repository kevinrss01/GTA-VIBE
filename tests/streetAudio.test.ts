/**
 * The moving city's audio: the engine curve, the vehicle layer and the crowd.
 *
 * Two halves. `engineCurve.ts` is pure arithmetic and is asserted directly,
 * which is where the "accelerating, cruising and lifting off must sound
 * different" requirement is actually pinned down. `StreetAudio` is asserted
 * against a mocked Web Audio graph, because the useful questions about it are
 * structural - does the graph exist, do its parameters move with speed and
 * throttle, are the voices budgeted, does anything leak - and none of them
 * need a browser or a working pair of ears.
 *
 * NOTE ON WHAT THIS CANNOT PROVE. Nothing here shows the result SOUNDS right;
 * that is a listening judgement and no test in this repository makes it. What
 * it does show is that the graph is wired, bounded, driven by the simulation
 * and free of leaks, and that the music contract survives the new layer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AudioDirector } from '../src/audio/AudioDirector';
import {
  GEAR_TOPS,
  REV_IDLE,
  ambientEngine,
  ambientLevel,
  ambientRate,
  engineTone,
  gearFor,
  loadFromAcceleration,
} from '../src/audio/engineCurve';
import { getAudioAsset, VEHICLE_SOUNDS, TRAFFIC_HUM } from '../src/audio/manifest';
import {
  StreetAudio,
  type CrowdNode,
  type StreetAudioContext,
  type VehicleAudioView,
} from '../src/audio/StreetAudio';

// ---------------------------------------------------------------------------
// The engine curve
// ---------------------------------------------------------------------------

describe('gearbox', () => {
  it('idles at rest and never falls below the idle floor', () => {
    expect(gearFor(0).gear).toBe(0);
    expect(gearFor(0).rev).toBeCloseTo(REV_IDLE, 6);
    for (let v = 0; v <= 40; v += 0.25) {
      expect(gearFor(v).rev).toBeGreaterThanOrEqual(REV_IDLE - 1e-9);
      expect(gearFor(v).rev).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('sweeps once per gear, so accelerating is a series of rises and drops', () => {
    let rises = 0;
    let drops = 0;
    let previous = gearFor(0).rev;
    for (let v = 0.1; v <= 34; v += 0.1) {
      const rev = gearFor(v).rev;
      if (rev < previous - 0.05) drops += 1;
      else if (rev > previous) rises += 1;
      previous = rev;
    }
    // Four gears means three upshifts, and a rise inside every one of them.
    expect(drops).toBe(GEAR_TOPS.length - 1);
    expect(rises).toBeGreaterThan(300);
  });

  it('reaches the top of the range at the top of each gear', () => {
    for (const top of GEAR_TOPS) expect(gearFor(top).rev).toBeCloseTo(1, 6);
  });

  it('revs in reverse exactly as it does pulling away forwards', () => {
    expect(gearFor(-4).rev).toBeCloseTo(gearFor(4).rev, 9);
    expect(engineTone(-4, 0.5).idleRate).toBeCloseTo(engineTone(4, 0.5).idleRate, 9);
  });
});

describe('engine tone', () => {
  const speed = 11;

  it('separates accelerating, cruising and lifting off at one road speed', () => {
    const accelerating = engineTone(speed, 1);
    const cruising = engineTone(speed, 0);
    const lifting = engineTone(speed, -1);

    // Louder on the throttle, quieter on the overrun.
    expect(accelerating.gain).toBeGreaterThan(cruising.gain);
    expect(cruising.gain).toBeGreaterThan(lifting.gain);

    // And brighter on the throttle, distinctly closed on the overrun. This is
    // the part a level change alone cannot imitate.
    expect(accelerating.cutoff).toBeGreaterThan(cruising.cutoff * 1.3);
    expect(lifting.cutoff).toBeLessThan(cruising.cutoff * 0.7);

    // The pitch is the road speed's business, not the throttle's.
    expect(accelerating.idleRate).toBeCloseTo(lifting.idleRate, 9);
  });

  it('raises pitch with revs on both layers', () => {
    const low = engineTone(0, 0);
    const high = engineTone(GEAR_TOPS[0] as number, 0);
    expect(high.idleRate).toBeGreaterThan(low.idleRate);
    expect(high.loadRate).toBeGreaterThan(low.loadRate);
  });

  it('crossfades the dark layer out and the bright layer in as revs rise', () => {
    const idling = engineTone(0, 0);
    const revving = engineTone(GEAR_TOPS[0] as number, 1);
    expect(idling.idleMix).toBeGreaterThan(0.9);
    expect(idling.loadMix).toBeLessThan(0.15);
    expect(revving.loadMix).toBeGreaterThan(0.9);
    expect(revving.idleMix).toBeLessThan(0.1);
  });

  it('keeps a car at a red light audible and never clips', () => {
    for (let v = 0; v <= 40; v += 0.5) {
      for (const load of [-1, -0.4, 0, 0.4, 1]) {
        const tone = engineTone(v, load);
        expect(tone.gain).toBeGreaterThan(0.2);
        expect(tone.gain).toBeLessThanOrEqual(1);
        expect(tone.cutoff).toBeGreaterThan(200);
        expect(Number.isFinite(tone.idleRate)).toBe(true);
        expect(Number.isFinite(tone.loadRate)).toBe(true);
      }
    }
  });

  it('clamps load to the reference acceleration in both directions', () => {
    expect(loadFromAcceleration(1000)).toBe(1);
    expect(loadFromAcceleration(-1000)).toBe(-1);
    expect(loadFromAcceleration(0)).toBe(0);
  });

  it('gives an ambient car pitch and level that both follow its speed', () => {
    expect(ambientRate(14)).toBeGreaterThan(ambientRate(2));
    expect(ambientLevel(14)).toBeGreaterThan(ambientLevel(0));
    // A queueing car is idling, not switched off - but what is audible at a
    // standstill is the ENGINE, not the tyres, which is why the two layers
    // exist. A stopped car rolling on its tyres is a sound that does not
    // happen; an idling one at a red light has to be heard.
    expect(ambientLevel(0)).toBe(0);
    expect(ambientEngine(0).level).toBeGreaterThan(0.1);
    expect(ambientEngine(14).level).toBeGreaterThan(ambientEngine(0).level);
    expect(ambientEngine(14).rate).toBeGreaterThan(ambientEngine(0).rate);
  });
});

// ---------------------------------------------------------------------------
// Web Audio mock
// ---------------------------------------------------------------------------

class FakeParam {
  value = 0;
  ramps = 0;
  setValueAtTime(v: number): FakeParam {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number): FakeParam {
    this.value = v;
    this.ramps += 1;
    return this;
  }
  cancelScheduledValues(): FakeParam {
    return this;
  }
}

interface FakeSource {
  buffer: { url: string } | null;
  startedAt: number;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  playbackRate: FakeParam;
  started: boolean;
  stopped: boolean;
  onended: (() => void) | null;
  target: unknown;
  connect(node: unknown): void;
  disconnect(): void;
  start(): void;
  stop(): void;
}

interface Harness {
  clock: number;
  fetched: string[];
  sources: FakeSource[];
  gains: number;
  panners: number;
  filters: number;
  /** Every biquad made, so a test can read the class colour off the last one. */
  filterNodes: Array<{ type: string; frequency: FakeParam; Q: FakeParam }>;
  connected: number;
  disconnected: number;
}

let h: Harness;

function installMocks(): void {
  h = {
    clock: 0,
    fetched: [],
    sources: [],
    gains: 0,
    panners: 0,
    filters: 0,
    filterNodes: [],
    connected: 0,
    disconnected: 0,
  };
  const urls = new WeakMap<ArrayBuffer, string>();
  const scope = globalThis as unknown as Record<string, unknown>;

  scope['fetch'] = async (url: string): Promise<unknown> => {
    h.fetched.push(url);
    const bytes = new ArrayBuffer(16);
    urls.set(bytes, url);
    return { ok: true, status: 200, arrayBuffer: async (): Promise<ArrayBuffer> => bytes };
  };

  const makeGain = (): unknown => {
    h.gains += 1;
    return {
      gain: new FakeParam(),
      connect: (): void => {
        h.connected += 1;
      },
      disconnect: (): void => {
        h.disconnected += 1;
      },
    };
  };

  const makeSource = (): FakeSource => {
    const source: FakeSource = {
      buffer: null,
      startedAt: -1,
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      playbackRate: new FakeParam(),
      started: false,
      stopped: false,
      onended: null,
      target: null,
      connect: (node: unknown): void => {
        source.target = node;
        h.connected += 1;
      },
      disconnect: (): void => {
        h.disconnected += 1;
      },
      start: (): void => {
        source.started = true;
        source.startedAt = h.clock;
      },
      stop: (): void => {
        source.stopped = true;
      },
    };
    h.sources.push(source);
    return source;
  };

  const makePanner = (): unknown => {
    h.panners += 1;
    return {
      panningModel: '',
      distanceModel: '',
      refDistance: 0,
      maxDistance: 0,
      rolloffFactor: 0,
      positionX: new FakeParam(),
      positionY: new FakeParam(),
      positionZ: new FakeParam(),
      connect: (): void => {
        h.connected += 1;
      },
      disconnect: (): void => {
        h.disconnected += 1;
      },
    };
  };

  const makeFilter = (): unknown => {
    h.filters += 1;
    const filter = {
      type: '',
      frequency: new FakeParam(),
      Q: new FakeParam(),
      connect: (): void => {
        h.connected += 1;
      },
      disconnect: (): void => {
        h.disconnected += 1;
      },
    };
    h.filterNodes.push(filter);
    return filter;
  };

  class FakeAudioContext {
    get currentTime(): number {
      return h.clock;
    }
    state = 'running';
    destination = { connect: (): void => undefined, disconnect: (): void => undefined };
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
    createBiquadFilter = makeFilter;
    async decodeAudioData(bytes: ArrayBuffer): Promise<unknown> {
      const url = urls.get(bytes);
      if (!url) throw new Error('undecodable');
      return { duration: 1, sampleRate: 44100, numberOfChannels: 2, url };
    }
    async resume(): Promise<void> {}
    async suspend(): Promise<void> {}
    async close(): Promise<void> {}
  }

  scope['AudioContext'] = FakeAudioContext;
  scope['document'] = {
    visibilityState: 'visible',
    addEventListener: (): void => undefined,
    removeEventListener: (): void => undefined,
  };
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
// Harness helpers
// ---------------------------------------------------------------------------

async function makeStreet(): Promise<{ audio: AudioDirector; street: StreetAudio }> {
  const audio = new AudioDirector();
  await audio.unlock();
  const street = new StreetAudio({ host: audio, surfaceAt: () => 'pavement' });
  return { audio, street };
}

function car(over: Partial<VehicleAudioView> & { id: number }): VehicleAudioView {
  return {
    x: 0,
    y: 0.7,
    z: 0,
    speed: 8,
    braking: false,
    accelLong: 0,
    control: 'ambient',
    ...over,
  };
}

const BASE: StreetAudioContext = {
  x: 0,
  y: 1.7,
  z: 0,
  indoors: false,
  driving: false,
  driveSpeed: 0,
  vehicles: [],
  crowd: null,
};

/**
 * Advances the mocked context and ends any one-shot that has finished.
 *
 * A real `AudioContext` fires `ended` and releases the voice; without this the
 * mock holds every one-shot open for ever, which is a different scenario (and
 * one the hard voice cap has its own test for).
 */
function advance(dt: number): void {
  h.clock += dt;
  for (const source of h.sources) {
    if (source.loop || !source.started || source.stopped || !source.onended) continue;
    if (h.clock - source.startedAt < 1) continue;
    const done = source.onended;
    source.onended = null;
    source.stopped = true;
    done();
  }
}

/**
 * Lets the deferred assets finish loading.
 *
 * The class engine pairs and the tyre bed are in `LAZY_ASSET_IDS`, so the
 * frame that asks for them only starts a fetch. In the game a handful of
 * frames pass before they arrive; here the promise chain has to be drained
 * explicitly or the test is asserting on the first frame of a first drive.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function sourcesFor(id: string): FakeSource[] {
  return h.sources.filter((s) => s.buffer?.url.includes(id) === true);
}

/** An instanced crowd mesh holding `points` at the given world positions. */
function crowdWith(points: readonly { x: number; z: number }[]): CrowdNode {
  const array = new Float32Array(points.length * 16);
  points.forEach((p, i) => {
    array[i * 16 + 12] = p.x;
    array[i * 16 + 13] = 0;
    array[i * 16 + 14] = p.z;
  });
  return { visible: true, count: points.length, instanceMatrix: { array }, children: [] };
}

// ---------------------------------------------------------------------------
// The player's engine
// ---------------------------------------------------------------------------

describe('player engine', () => {
  it('is silent and builds nothing while the player is on foot', async () => {
    const { audio, street } = await makeStreet();
    for (let i = 0; i < 120; i += 1) street.update(1 / 60, BASE);

    expect(street.stats.engineReady).toBe(false);
    expect(sourcesFor('engine-idle')).toHaveLength(0);
    expect(sourcesFor('engine-load')).toHaveLength(0);
    audio.dispose();
    street.dispose();
  });

  it('builds two looping layers through a lowpass on the first drive', async () => {
    const { audio, street } = await makeStreet();
    street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 5 });

    const idle = sourcesFor('engine-idle');
    const load = sourcesFor('engine-load');
    expect(idle).toHaveLength(1);
    expect(load).toHaveLength(1);
    expect(idle[0]?.loop).toBe(true);
    expect(load[0]?.loop).toBe(true);
    expect(idle[0]?.started).toBe(true);
    // A biquad exists, which is what gives the overrun its colour.
    expect(h.filters).toBe(1);
    expect(street.stats.engineReady).toBe(true);

    // The MP3 padding is skipped, or the loop puts a hole in the engine.
    expect(idle[0]?.loopStart).toBeGreaterThan(0);
    expect(idle[0]?.loopEnd).toBeLessThan(getAudioAsset(VEHICLE_SOUNDS.engineIdle).duration);
    audio.dispose();
    street.dispose();
  });

  it('raises pitch with speed', async () => {
    const { audio, street } = await makeStreet();
    street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 1 });
    const idle = sourcesFor('engine-idle')[0];
    const slow = idle?.playbackRate.value ?? 0;

    street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 6 });
    const fast = idle?.playbackRate.value ?? 0;
    expect(fast).toBeGreaterThan(slow);
    audio.dispose();
    street.dispose();
  });

  it('is louder and brighter accelerating than coasting at the same speed', async () => {
    const dt = 1 / 60;
    const drive = async (profile: (i: number) => number): Promise<{ gain: number; cutoff: number }> => {
      const { audio, street } = await makeStreet();
      for (let i = 0; i < 90; i += 1) {
        street.update(dt, { ...BASE, driving: true, driveSpeed: profile(i) });
      }
      const stats = street.stats;
      audio.dispose();
      street.dispose();
      return { gain: stats.engineGain, cutoff: stats.engineCutoff };
    };

    // Both arrive at 12 m/s: one still pulling, one already coasting off it.
    const pulling = await drive((i) => Math.min(12, 12 * (i / 89)));
    const coasting = await drive((i) => (i < 45 ? 12 : 12 + (45 - i) * 0.02));

    expect(pulling.gain).toBeGreaterThan(coasting.gain);
    expect(pulling.cutoff).toBeGreaterThan(coasting.cutoff);
  });

  it('speaks in the voice of the class the player is actually driving', async () => {
    const { audio, street } = await makeStreet();
    const truck = car({ id: 1, kind: 'boxTruck', control: 'player', x: 0, z: 0, speed: 8 });
    street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 8, vehicles: [truck] });
    await settle();
    for (let i = 0; i < 10; i += 1) {
      street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 8, vehicles: [truck] });
    }
    expect(street.stats.engineVoice).toBe('truck');
    expect(sourcesFor('engine-truck-idle')).toHaveLength(1);
    expect(sourcesFor('engine-truck-load')).toHaveLength(1);
    audio.dispose();
    street.dispose();
  });

  it('swaps the pair when the player changes car, without growing the graph', async () => {
    const { audio, street } = await makeStreet();
    const drive = async (kind: string): Promise<void> => {
      const vehicle = car({ id: 1, kind, control: 'player', x: 0, z: 0, speed: 8 });
      street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 8, vehicles: [vehicle] });
      await settle();
      for (let i = 0; i < 10; i += 1) {
        street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 8, vehicles: [vehicle] });
      }
    };
    await drive('boxTruck');
    const afterTruck = street.stats.liveNodes;
    await drive('coupe');
    expect(street.stats.engineVoice).toBe('sport');
    expect(sourcesFor('engine-sport-idle')).toHaveLength(1);
    // The old pair is stopped, not left running underneath the new one.
    expect(sourcesFor('engine-truck-idle')[0]?.stopped).toBe(true);
    expect(street.stats.liveNodes).toBe(afterTruck);
    audio.dispose();
    street.dispose();
  });

  it('starts on the saloon pair when the class layers have not arrived', async () => {
    // The class engines are deferred; the saloon pair is not, which is the
    // whole reason it is not in LAZY_ASSET_IDS.
    const { audio, street } = await makeStreet();
    street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 5 });
    expect(street.stats.engineVoice).toBe('saloon');
    expect(sourcesFor('engine-idle')).toHaveLength(1);
    audio.dispose();
    street.dispose();
  });

  it('carries a tyre layer that follows road speed rather than revs', async () => {
    const { audio, street } = await makeStreet();
    street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 2 });
    await settle();
    for (let i = 0; i < 5; i += 1) {
      street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 2 });
    }
    const slow = street.stats.tyreLevel;
    for (let i = 0; i < 30; i += 1) {
      street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 22 });
    }
    expect(sourcesFor('tyre-roll')).toHaveLength(1);
    expect(sourcesFor('tyre-roll')[0]?.loop).toBe(true);
    expect(street.stats.tyreLevel).toBeGreaterThan(slow);
    audio.dispose();
    street.dispose();
  });

  it('clunks on an upshift under power and stays silent coasting down', async () => {
    const { audio, street } = await makeStreet();
    // Pull away hard: a saloon tops first at 7 m/s, so this crosses two shifts.
    for (let i = 0; i < 120; i += 1) {
      street.update(1 / 60, { ...BASE, driving: true, driveSpeed: (i / 119) * 16 });
      advance(1 / 60);
    }
    const up = sourcesFor('gear-shift').length;
    expect(up).toBeGreaterThanOrEqual(1);
    expect(street.stats.gear).toBeGreaterThan(0);

    // Now roll back down through the same gears off the throttle.
    for (let i = 0; i < 120; i += 1) {
      street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 16 - (i / 119) * 16 });
      advance(1 / 60);
    }
    expect(sourcesFor('gear-shift')).toHaveLength(up);
    audio.dispose();
    street.dispose();
  });

  it('squeals the pads rolling to a stop but not standing on the brakes', async () => {
    const { audio, street } = await makeStreet();
    // Ordinary stop: 4 m/s losing 2 m/s per second.
    let speed = 4;
    for (let i = 0; i < 60; i += 1) {
      speed = Math.max(0.7, speed - 2 / 60);
      street.update(1 / 60, { ...BASE, driving: true, driveSpeed: speed });
      advance(1 / 60);
    }
    expect(sourcesFor('brake-squeal').length).toBeGreaterThanOrEqual(1);
    expect(sourcesFor('tyre-scrub')).toHaveLength(0);
    audio.dispose();
    street.dispose();
  });

  it('fades the engine out when the player gets out', async () => {
    const { audio, street } = await makeStreet();
    for (let i = 0; i < 30; i += 1) street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 9 });
    expect(street.stats.engineGain).toBeGreaterThan(0);

    for (let i = 0; i < 30; i += 1) street.update(1 / 60, BASE);
    expect(street.stats.engineGain).toBe(0);
    // The sources are kept: one cannot be restarted, and getting back in must work.
    expect(sourcesFor('engine-idle')[0]?.stopped).toBe(false);

    for (let i = 0; i < 30; i += 1) street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 9 });
    expect(street.stats.engineGain).toBeGreaterThan(0);
    expect(sourcesFor('engine-idle')).toHaveLength(1);
    audio.dispose();
    street.dispose();
  });
});

// ---------------------------------------------------------------------------
// Doors, braking and impacts
// ---------------------------------------------------------------------------

describe('car doors, braking and impacts', () => {
  it('opens and shuts the CAR door on the way in and the way out', async () => {
    const { audio, street } = await makeStreet();
    street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 0 });
    expect(sourcesFor('veh/car-door-open')).toHaveLength(1);

    for (let i = 0; i < 60; i += 1) street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 0 });
    expect(sourcesFor('veh/car-door-close')).toHaveLength(1);

    street.update(1 / 60, BASE);
    expect(sourcesFor('veh/car-door-open')).toHaveLength(2);
    // Never the building door, which is a wooden latch on a hinge.
    expect(sourcesFor('sfx/door-open')).toHaveLength(0);
    audio.dispose();
    street.dispose();
  });

  it('does not mistake taking a moving car for a collision', async () => {
    const { audio, street } = await makeStreet();
    // Entering steps the reported speed from 0 to the car's own speed.
    street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 14 });
    for (let i = 0; i < 10; i += 1) {
      street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 14 });
    }
    expect(sourcesFor('veh/impact')).toHaveLength(0);
    audio.dispose();
    street.dispose();
  });

  it('thuds when the car loses its speed in a single frame', async () => {
    const { audio, street } = await makeStreet();
    for (let i = 0; i < 20; i += 1) {
      street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 14 });
    }
    expect(sourcesFor('veh/impact')).toHaveLength(0);

    // What Driving.ts does on a head-on hit: scrub the speed, hard.
    street.update(1 / 60, { ...BASE, driving: true, driveSpeed: -1.6 });
    expect(sourcesFor('veh/impact')).toHaveLength(1);
    audio.dispose();
    street.dispose();
  });

  it('scrubs the tyres under heavy braking but not under ordinary slowing', async () => {
    const gentle = await makeStreet();
    let v = 14;
    for (let i = 0; i < 60; i += 1) {
      v -= 1.5 / 60; // 1.5 m/s^2, lifting off
      gentle.street.update(1 / 60, { ...BASE, driving: true, driveSpeed: v });
    }
    expect(sourcesFor('veh/tyre-scrub')).toHaveLength(0);
    gentle.audio.dispose();
    gentle.street.dispose();

    installMocks();
    const hard = await makeStreet();
    v = 14;
    for (let i = 0; i < 60; i += 1) {
      v = Math.max(0, v - 9 / 60); // 9 m/s^2, on the brakes
      hard.street.update(1 / 60, { ...BASE, driving: true, driveSpeed: v });
    }
    expect(sourcesFor('veh/tyre-scrub').length).toBeGreaterThan(0);
    hard.audio.dispose();
    hard.street.dispose();
  });
});

// ---------------------------------------------------------------------------
// Ambient traffic
// ---------------------------------------------------------------------------

/*
 * The tyre squeal that was audible from a pavement all day.
 *
 * The ambient scrub used to trigger on `vehicle.braking`, which is the BRAKE
 * LAMP: it lights at 0.55 m/s of deceleration per second, which is ordinary
 * lift-off and something every car in the city does several times per junction.
 * The asset behind it is an emergency stop with brake squeal, so the result was
 * an emergency stop within 34 m every 0.85 s, forever.
 */
describe('the ambient tyre scrub', () => {
  const braking = (over: Partial<VehicleAudioView> & { id: number }): VehicleAudioView =>
    car({ braking: true, ...over });

  it('says nothing for a car merely lifting off in traffic', async () => {
    const { audio, street } = await makeStreet();
    // Ten seconds of a car doing what a car in traffic does: lifting off and
    // coasting, over and over, with the brake lamp flickering on each time.
    // Every one of those is a rising edge of the flag the old gate read.
    for (let i = 0; i < 600; i += 1) {
      const lifting = i % 2 === 0;
      street.update(1 / 60, {
        ...BASE,
        vehicles: [
          braking({ id: 1, x: 6, speed: 14, braking: lifting, accelLong: lifting ? -0.9 : 0 }),
        ],
      });
    }
    expect(sourcesFor('veh/tyre-scrub')).toHaveLength(0);
    audio.dispose();
    street.dispose();
  });

  it('does say something for a car actually standing on the brakes', async () => {
    const { audio, street } = await makeStreet();
    for (let i = 0; i < 120; i += 1) {
      street.update(1 / 60, {
        ...BASE,
        vehicles: [braking({ id: 1, x: 6, speed: 16, accelLong: i < 5 ? 0 : -8.5 })],
      });
    }
    expect(sourcesFor('veh/tyre-scrub').length).toBeGreaterThan(0);
    audio.dispose();
    street.dispose();
  });

  it('ignores a hard stop from walking pace', async () => {
    const { audio, street } = await makeStreet();
    for (let i = 0; i < 120; i += 1) {
      street.update(1 / 60, {
        ...BASE,
        vehicles: [braking({ id: 1, x: 6, speed: 3, accelLong: i < 5 ? 0 : -9 })],
      });
    }
    expect(sourcesFor('veh/tyre-scrub')).toHaveLength(0);
    audio.dispose();
    street.dispose();
  });

  it('ignores a hard stop happening a street away', async () => {
    const { audio, street } = await makeStreet();
    for (let i = 0; i < 120; i += 1) {
      street.update(1 / 60, {
        ...BASE,
        vehicles: [braking({ id: 1, x: 40, speed: 16, accelLong: i < 5 ? 0 : -9 })],
      });
    }
    expect(sourcesFor('veh/tyre-scrub')).toHaveLength(0);
    audio.dispose();
    street.dispose();
  });

  it('does not repeat itself once a second while a queue stops', async () => {
    const { audio, street } = await makeStreet();
    // Ten seconds of cars braking hard in front of the listener, one after
    // another. The cooldown has to hold this to a handful of squeals.
    for (let i = 0; i < 600; i += 1) {
      const phase = Math.floor(i / 30) % 2;
      street.update(1 / 60, {
        ...BASE,
        vehicles: [
          braking({ id: 1, x: 6, speed: 16, accelLong: phase === 0 ? -9 : 0 }),
          braking({ id: 2, x: 9, speed: 16, accelLong: phase === 1 ? -9 : 0 }),
        ],
      });
    }
    expect(sourcesFor('veh/tyre-scrub').length).toBeLessThanOrEqual(5);
    audio.dispose();
    street.dispose();
  });
});

describe('ambient traffic voices', () => {
  const fleet = (n: number, spacing: number): VehicleAudioView[] =>
    Array.from({ length: n }, (_, i) => car({ id: i, x: (i + 1) * spacing, z: 0 }));

  it('never allocates more than the pool of looping voices, whatever the traffic is', async () => {
    const { audio, street } = await makeStreet();
    for (let i = 0; i < 240; i += 1) {
      street.update(1 / 60, { ...BASE, vehicles: fleet(60, 0.8) });
    }
    // TRAFFIC_VOICES, and one tyre source plus one engine source for each.
    expect(sourcesFor('engine-far')).toHaveLength(7);
    expect(sourcesFor('veh/engine-idle')).toHaveLength(7);
    expect(street.stats.trafficVoices).toBe(7);
    audio.dispose();
    street.dispose();
  });

  it('gives the voices to the nearest cars', async () => {
    const { audio, street } = await makeStreet();
    const vehicles = [
      car({ id: 1, x: 4 }),
      car({ id: 2, x: 9 }),
      car({ id: 3, x: 200 }),
      car({ id: 4, x: 300 }),
    ];
    for (let i = 0; i < 60; i += 1) street.update(1 / 60, { ...BASE, vehicles });
    // Only the two inside the radius are worth a voice.
    expect(street.stats.trafficVoices).toBe(2);
    audio.dispose();
    street.dispose();
  });

  it('drops a voice when its car drives out of range and never leaks nodes', async () => {
    const { audio, street } = await makeStreet();
    for (let i = 0; i < 60; i += 1) street.update(1 / 60, { ...BASE, vehicles: [car({ id: 1, x: 6 })] });
    expect(street.stats.trafficVoices).toBe(1);
    const nodes = street.stats.liveNodes;

    for (let i = 0; i < 120; i += 1) {
      street.update(1 / 60, { ...BASE, vehicles: [car({ id: 1, x: 400 })] });
    }
    expect(street.stats.trafficVoices).toBe(0);
    // The voice was released, not destroyed and rebuilt.
    expect(street.stats.liveNodes).toBe(nodes);
    expect(sourcesFor('engine-far')).toHaveLength(1);
    audio.dispose();
    street.dispose();
  });

  it('releases a voice whose car is recycled out of the fleet', async () => {
    const { audio, street } = await makeStreet();
    for (let i = 0; i < 60; i += 1) street.update(1 / 60, { ...BASE, vehicles: [car({ id: 1, x: 6 })] });
    expect(street.stats.trafficVoices).toBe(1);

    street.update(1 / 60, { ...BASE, vehicles: [] });
    expect(street.stats.trafficVoices).toBe(0);
    audio.dispose();
    street.dispose();
  });

  it('does not give the player their own car an ambient voice', async () => {
    const { audio, street } = await makeStreet();
    const vehicles = [car({ id: 1, x: 0, z: 0, control: 'player' })];
    for (let i = 0; i < 60; i += 1) {
      street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 9, vehicles });
    }
    expect(street.stats.trafficVoices).toBe(0);
    audio.dispose();
    street.dispose();
  });
});

describe('ambient traffic classes', () => {
  it('colours a box truck differently from a hatchback across the street', async () => {
    const { audio, street } = await makeStreet();
    const at = (kind: string): { rate: number; cutoff: number } => {
      const vehicle = car({ id: 1, kind, x: 18, z: 0, speed: 10 });
      for (let i = 0; i < 30; i += 1) {
        street.update(1 / 60, { ...BASE, vehicles: [vehicle] });
      }
      const source = sourcesFor('engine-far')[0];
      const filter = h.filterNodes[h.filterNodes.length - 1];
      return { rate: source?.playbackRate.value ?? 0, cutoff: filter?.frequency.value ?? 0 };
    };
    const truck = at('boxTruck');
    const hatch = at('compact');
    expect(truck.rate).toBeLessThan(hatch.rate);
    expect(truck.cutoff).toBeLessThan(hatch.cutoff);
    audio.dispose();
    street.dispose();
  });

  it('voices a car standing at a red light as an engine, not as tyres', async () => {
    // The defect this pins: an ambient car used to be ONE tyre-roll loop, so a
    // queue at a junction was voiced as rubber on asphalt at a standstill -
    // which is a sound that does not happen - and a car passing a pedestrian
    // had no engine in it at all. See the note above `ambientRate`.
    const { audio, street } = await makeStreet();
    const level = (id: string): number => {
      const source = sourcesFor(id)[0];
      const gain = source?.target as { gain: FakeParam } | null;
      return gain?.gain.value ?? -1;
    };

    const stopped = car({ id: 1, x: 9, z: 0, speed: 0 });
    for (let i = 0; i < 60; i += 1) street.update(1 / 60, { ...BASE, vehicles: [stopped] });
    expect(level(VEHICLE_SOUNDS.engineIdle)).toBeGreaterThan(0.05);
    expect(level(VEHICLE_SOUNDS.engineFar)).toBe(0);

    // Green light. The tyres arrive, the engine climbs with the revs, and both
    // are driven from the same car rather than from a clock.
    const moving = car({ id: 1, x: 9, z: 0, speed: 12 });
    for (let i = 0; i < 60; i += 1) street.update(1 / 60, { ...BASE, vehicles: [moving] });
    expect(level(VEHICLE_SOUNDS.engineFar)).toBeGreaterThan(0);
    expect(sourcesFor(VEHICLE_SOUNDS.engineIdle)[0]?.playbackRate.value ?? 0).toBeGreaterThan(
      ambientEngine(0).rate,
    );

    audio.dispose();
    street.dispose();
  });

  it('allocates one filter per voice and no more', async () => {
    const { audio, street } = await makeStreet();
    const vehicles = Array.from({ length: 30 }, (_, i) =>
      car({ id: i, kind: i % 2 === 0 ? 'boxTruck' : 'coupe', x: i, z: 0, speed: 9 }),
    );
    for (let i = 0; i < 200; i += 1) street.update(1 / 60, { ...BASE, vehicles });
    // One filter per ambient voice - the two layers of a car share it, because
    // they are one car - and the player's own engine filter is not built here
    // because the player is on foot.
    expect(h.filters).toBeLessThanOrEqual(7);
    audio.dispose();
    street.dispose();
  });
});

describe('distant traffic hum', () => {
  it('rises with moving traffic and stays silent on an empty street', async () => {
    const empty = await makeStreet();
    for (let i = 0; i < 300; i += 1) empty.street.update(1 / 60, BASE);
    expect(empty.street.stats.humLevel).toBe(0);
    expect(sourcesFor(TRAFFIC_HUM)).toHaveLength(0);
    empty.audio.dispose();
    empty.street.dispose();

    installMocks();
    const busy = await makeStreet();
    const vehicles = Array.from({ length: 30 }, (_, i) =>
      car({ id: i, x: (i % 6) * 9 - 20, z: Math.floor(i / 6) * 9 - 20, speed: 9 }),
    );
    for (let i = 0; i < 300; i += 1) busy.street.update(1 / 60, { ...BASE, vehicles });
    expect(busy.street.stats.humLevel).toBeGreaterThan(0.2);
    expect(sourcesFor(TRAFFIC_HUM)).toHaveLength(1);
    expect(sourcesFor(TRAFFIC_HUM)[0]?.loop).toBe(true);
    busy.audio.dispose();
    busy.street.dispose();
  });

  it('ducks indoors', async () => {
    const vehicles = Array.from({ length: 30 }, (_, i) =>
      car({ id: i, x: (i % 6) * 9 - 20, z: Math.floor(i / 6) * 9 - 20, speed: 9 }),
    );
    const { audio, street } = await makeStreet();
    for (let i = 0; i < 300; i += 1) street.update(1 / 60, { ...BASE, vehicles });
    const outside = street.stats.humLevel;

    for (let i = 0; i < 300; i += 1) {
      street.update(1 / 60, { ...BASE, vehicles, indoors: true });
    }
    expect(street.stats.humLevel).toBeLessThan(outside * 0.4);
    audio.dispose();
    street.dispose();
  });
});

// ---------------------------------------------------------------------------
// The crowd
// ---------------------------------------------------------------------------

describe('crowd footsteps', () => {
  /** Walks `people` past the listener for `frames` at `speed` m/s. */
  function walk(
    street: StreetAudio,
    people: number,
    speed: number,
    frames: number,
    radius = 4,
  ): void {
    const dt = 1 / 60;
    for (let f = 0; f < frames; f += 1) {
      const points = Array.from({ length: people }, (_, i) => ({
        x: radius + i * 1.5,
        z: -6 + speed * f * dt,
      }));
      street.update(dt, { ...BASE, crowd: crowdWith(points) });
      advance(dt);
    }
  }

  it('makes no sound for a crowd that is standing still', async () => {
    const { audio, street } = await makeStreet();
    walk(street, 6, 0, 180);
    expect(street.stats.crowdSteps).toBe(0);
    audio.dispose();
    street.dispose();
  });

  it('emits roughly one footfall per stride actually walked', async () => {
    const { audio, street } = await makeStreet();
    // One person, 1.4 m/s for 3 s: 4.2 m, about five strides of 0.78 m.
    walk(street, 1, 1.4, 180);
    expect(street.stats.crowdSteps).toBeGreaterThanOrEqual(4);
    expect(street.stats.crowdSteps).toBeLessThanOrEqual(7);
    audio.dispose();
    street.dispose();
  });

  it('walks faster, steps more often', async () => {
    const slow = await makeStreet();
    walk(slow.street, 1, 1.0, 180);
    const slowSteps = slow.street.stats.crowdSteps;
    slow.audio.dispose();
    slow.street.dispose();

    installMocks();
    const fast = await makeStreet();
    walk(fast.street, 1, 3.0, 180);
    expect(fast.street.stats.crowdSteps).toBeGreaterThan(slowSteps * 1.8);
    fast.audio.dispose();
    fast.street.dispose();
  });

  it('hears nobody beyond the cull radius', async () => {
    const { audio, street } = await makeStreet();
    walk(street, 8, 1.4, 180, 400);
    expect(street.stats.crowdSteps).toBe(0);
    expect(street.stats.crowdTracks).toBe(0);
    audio.dispose();
    street.dispose();
  });

  it('holds the rate down when a whole crowd walks past at once', async () => {
    const { audio, street } = await makeStreet();
    // 40 people at 3 m/s would be about 150 footfalls a second unbudgeted.
    walk(street, 40, 3.0, 180);
    const seconds = 3;
    expect(street.stats.crowdSteps).toBeLessThanOrEqual(9 * seconds + 3);
    expect(street.stats.crowdSteps).toBeGreaterThan(10);
    // The tracker itself is bounded too.
    expect(street.stats.crowdTracks).toBeLessThanOrEqual(20);
    audio.dispose();
    street.dispose();
  });

  it('ignores a respawn teleporting somebody across the city', async () => {
    const { audio, street } = await makeStreet();
    const dt = 1 / 60;
    for (let f = 0; f < 120; f += 1) {
      // One person flipping between two spots 6 m apart every frame.
      const x = f % 2 === 0 ? 3 : 9;
      street.update(dt, { ...BASE, crowd: crowdWith([{ x, z: 0 }]) });
    }
    expect(street.stats.crowdSteps).toBe(0);
    audio.dispose();
    street.dispose();
  });

  it('stops tracking the crowd while the player is driving', async () => {
    const { audio, street } = await makeStreet();
    walk(street, 6, 1.4, 60);
    expect(street.stats.crowdTracks).toBeGreaterThan(0);

    const points = Array.from({ length: 6 }, (_, i) => ({ x: 4 + i, z: 0 }));
    street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 8, crowd: crowdWith(points) });
    expect(street.stats.crowdTracks).toBe(0);
    audio.dispose();
    street.dispose();
  });

  it('reads instances out of a nested, partly hidden crowd group', async () => {
    const { audio, street } = await makeStreet();
    const dt = 1 / 60;
    for (let f = 0; f < 180; f += 1) {
      const moving = crowdWith([{ x: 3, z: -6 + 1.4 * f * dt }]);
      const hidden: CrowdNode = { ...crowdWith([{ x: 3.5, z: 0 }]), visible: false };
      const root: CrowdNode = { visible: true, children: [hidden, moving] };
      street.update(dt, { ...BASE, crowd: root });
    }
    expect(street.stats.crowdSteps).toBeGreaterThan(3);
    audio.dispose();
    street.dispose();
  });
});

// ---------------------------------------------------------------------------
// Budgets, lifecycle and the music contract
// ---------------------------------------------------------------------------

const KINDS = [
  'compact',
  'sedan',
  'coupe',
  'wagon',
  'crossover',
  'pickup',
  'van',
  'boxTruck',
  'taxi',
  'patrolSedan',
  'patrolSuv',
];

describe('budgets and lifecycle', () => {
  it('holds a bounded node count over a long busy run', async () => {
    const { audio, street } = await makeStreet();
    const dt = 1 / 60;
    let peak = 0;

    // Get the deferred layers resident first, so the ceiling is measured with
    // the tyre bed and a class engine actually in the graph rather than with
    // the fetches still in flight.
    street.update(dt, {
      ...BASE,
      driving: true,
      driveSpeed: 8,
      vehicles: [car({ id: 999, kind: 'boxTruck', control: 'player' })],
    });
    await settle();

    for (let f = 0; f < 3600; f += 1) {
      const t = f * dt;
      const vehicles = Array.from({ length: 40 }, (_, i) =>
        car({
          id: i,
          // Every class in the catalogue, so the voice pool is reassigned
          // between classes as well as between cars.
          kind: KINDS[i % KINDS.length] as string,
          x: Math.sin(i * 1.7 + t) * 40,
          z: Math.cos(i * 2.3 + t) * 40,
          speed: 4 + (i % 7),
          braking: (f + i) % 90 === 0,
        }),
      );
      const people = Array.from({ length: 30 }, (_, i) => ({
        x: Math.sin(i * 0.9) * 8,
        z: Math.cos(i * 1.3) * 8 + 1.4 * t,
      }));
      street.update(dt, {
        ...BASE,
        driving: f % 600 < 300,
        driveSpeed: 6 + Math.sin(t) * 6,
        vehicles,
        crowd: crowdWith(people),
      });
      advance(dt);
      peak = Math.max(peak, street.stats.liveNodes);
    }

    // 8 engine (2 layers, tyres, 4 gains, filter) + 42 traffic (7 voices of
    // tyre source, tyre gain, engine source, engine gain, filter, panner) +
    // 2 hum = 52 persistent, plus whatever one-shots are mid-flight:
    // MAX_STEP_VOICES * 3 + MAX_OTHER_VOICES * 3. The ceiling is that sum.
    expect(peak).toBeLessThanOrEqual(94);
    expect(peak).toBeGreaterThan(30); // the persistent set really was built
    expect(street.stats.crowdTracks).toBeLessThanOrEqual(20);
    audio.dispose();
    street.dispose();
  });

  it('caps transient voices by count, not only by rate', async () => {
    // Regression, found in the browser: `step()` runs thirty seconds of
    // simulation inside one second of wall clock, so the per-second rate
    // limiters let footsteps pile up faster than a real context could end
    // them - measured, 420 live nodes. `advance` is deliberately NOT called
    // here, which is the same thing seen from the other end: voices that never
    // finish. The ceiling has to hold anyway.
    const { audio, street } = await makeStreet();
    const dt = 1 / 60;
    for (let f = 0; f < 5400; f += 1) {
      const t = f * dt;
      const people = Array.from({ length: 50 }, (_, i) => ({
        x: Math.sin(i * 0.7) * 9,
        z: Math.cos(i * 1.1) * 9 + 3.2 * t,
      }));
      const vehicles = Array.from({ length: 30 }, (_, i) =>
        car({ id: i, x: (i % 6) * 6 - 15, z: i * 1.5 - 20, speed: 9, braking: (f + i) % 40 === 0 }),
      );
      street.update(dt, { ...BASE, vehicles, crowd: crowdWith(people) });
    }

    const stats = street.stats;
    expect(stats.stepVoices).toBeLessThanOrEqual(8);
    expect(stats.voices - stats.stepVoices).toBeLessThanOrEqual(6);
    // 45 persistent (7 two-layer voices and the hum), 8 footsteps and 6
    // others at three nodes each.
    expect(stats.liveNodes).toBeLessThanOrEqual(87);
    audio.dispose();
    street.dispose();
  });

  it('never fetches or decodes the music track, however busy the street is', async () => {
    const { audio, street } = await makeStreet();
    const dt = 1 / 60;
    for (let f = 0; f < 1200; f += 1) {
      const vehicles = Array.from({ length: 20 }, (_, i) => car({ id: i, x: i * 2, z: i }));
      const people = Array.from({ length: 12 }, (_, i) => ({ x: i * 0.9, z: 1.4 * f * dt }));
      street.update(dt, {
        ...BASE,
        driving: f % 200 < 100,
        driveSpeed: 11,
        vehicles,
        crowd: crowdWith(people),
      });
    }

    expect(audio.musicEnabled).toBe(false);
    expect(h.fetched.filter((u) => u.includes('meridian-theme'))).toHaveLength(0);
    audio.dispose();
    street.dispose();
  });

  it('is inert before the context is unlocked and never throws', () => {
    const audio = new AudioDirector();
    const street = new StreetAudio({ host: audio, surfaceAt: () => 'asphalt' });
    expect(() =>
      street.update(1 / 60, {
        ...BASE,
        driving: true,
        driveSpeed: 12,
        vehicles: [car({ id: 1, x: 3 })],
        crowd: crowdWith([{ x: 2, z: 0 }]),
      }),
    ).not.toThrow();
    expect(h.sources).toHaveLength(0);
    expect(street.stats.liveNodes).toBe(0);
    street.dispose();
    audio.dispose();
  });

  it('stops every looping voice it owns on dispose', async () => {
    const { audio, street } = await makeStreet();
    for (let f = 0; f < 300; f += 1) {
      street.update(1 / 60, {
        ...BASE,
        driving: true,
        driveSpeed: 12,
        vehicles: Array.from({ length: 8 }, (_, i) => car({ id: i, x: i * 3 })),
      });
    }
    const looping = h.sources.filter((s) => s.loop);
    expect(looping.length).toBeGreaterThanOrEqual(6);

    street.dispose();
    for (const source of looping) expect(source.stopped).toBe(true);
    expect(street.stats.liveNodes).toBe(0);
    audio.dispose();
  });

  it('survives dispose being called twice and ignores updates afterwards', async () => {
    const { audio, street } = await makeStreet();
    street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 5 });
    street.dispose();
    expect(() => street.dispose()).not.toThrow();
    expect(() => street.update(1 / 60, { ...BASE, driving: true, driveSpeed: 5 })).not.toThrow();
    audio.dispose();
  });
});

