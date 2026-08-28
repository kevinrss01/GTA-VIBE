/**
 * The pursuit, the airfield and the crash.
 *
 * Three layers that did not exist and one that did the wrong thing, all
 * asserted against a mocked Web Audio graph for the same reason the street
 * layer is: the useful questions are structural - is there a siren at all, is
 * it in the world rather than in the player's head, does it stop, is any of it
 * bounded - and none of them need a browser.
 *
 * NOTE ON WHAT THIS CANNOT PROVE. Nothing here shows any of it SOUNDS right.
 * That is a listening judgement and no test in this repository makes one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AudioDirector } from '../src/audio/AudioDirector';
import { AircraftAudio, type AircraftEngineFrame } from '../src/audio/AircraftAudio';
import { CombatAudio } from '../src/audio/CombatAudio';
import { PoliceAudio, type PursuitUnit } from '../src/audio/PoliceAudio';
import { StreetAudio, type VehicleAudioView } from '../src/audio/StreetAudio';
import {
  AIRCRAFT_ENGINES,
  AIRCRAFT_SOUNDS,
  AIRPORT_BED,
  POLICE_SOUNDS,
  VEHICLE_SOUNDS,
  getAudioAsset,
  impactSoundFor,
} from '../src/audio/manifest';

// ---------------------------------------------------------------------------
// Web Audio mock
// ---------------------------------------------------------------------------

class FakeParam {
  value: number;
  ramps = 0;
  /** Every value this parameter has ever been asked for, in order. */
  readonly history: number[] = [];
  /** Web Audio's own defaults: gains start at 1, playbackRate at 1. */
  constructor(initial = 0) {
    this.value = initial;
  }
  setValueAtTime(v: number): FakeParam {
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number): FakeParam {
    this.value = v;
    this.ramps += 1;
    this.history.push(v);
    return this;
  }
  cancelScheduledValues(): FakeParam {
    return this;
  }
}

interface FakeSource {
  buffer: { url: string } | null;
  loop: boolean;
  playbackRate: FakeParam;
  started: boolean;
  stopped: boolean;
  startedAt: number;
  onended: (() => void) | null;
  target: unknown;
  connect(node: unknown): void;
  disconnect(): void;
  start(): void;
  stop(): void;
}

interface FakePanner {
  refDistance: number;
  maxDistance: number;
  rolloffFactor: number;
  panningModel: string;
  positionX: FakeParam;
  positionY: FakeParam;
  positionZ: FakeParam;
  connect(node: unknown): void;
  disconnect(): void;
}

interface Harness {
  clock: number;
  state: 'running' | 'suspended';
  sources: FakeSource[];
  panners: FakePanner[];
  filters: { frequency: FakeParam }[];
  gains: { gain: FakeParam }[];
}

let h: Harness;

function installMocks(): void {
  h = { clock: 0, state: 'running', sources: [], panners: [], filters: [], gains: [] };
  const urls = new WeakMap<ArrayBuffer, string>();
  const scope = globalThis as unknown as Record<string, unknown>;

  scope['fetch'] = async (url: string): Promise<unknown> => {
    const bytes = new ArrayBuffer(16);
    urls.set(bytes, url);
    return { ok: true, status: 200, arrayBuffer: async (): Promise<ArrayBuffer> => bytes };
  };

  const makeGain = (): unknown => {
    const node = {
      gain: new FakeParam(),
      connect: (): void => undefined,
      disconnect: (): void => undefined,
    };
    h.gains.push(node);
    return node;
  };

  const makeSource = (): FakeSource => {
    const source: FakeSource = {
      buffer: null,
      loop: false,
      playbackRate: new FakeParam(1),
      started: false,
      stopped: false,
      startedAt: -1,
      onended: null,
      target: null,
      connect: (node: unknown): void => {
        source.target = node;
      },
      disconnect: (): void => undefined,
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

  const makePanner = (): FakePanner => {
    const panner: FakePanner = {
      panningModel: '',
      refDistance: 0,
      maxDistance: 0,
      rolloffFactor: 0,
      positionX: new FakeParam(),
      positionY: new FakeParam(),
      positionZ: new FakeParam(),
      connect: (): void => undefined,
      disconnect: (): void => undefined,
    };
    h.panners.push(panner);
    return panner;
  };

  const makeFilter = (): unknown => {
    const node = {
      type: '',
      frequency: new FakeParam(),
      Q: new FakeParam(),
      connect: (): void => undefined,
      disconnect: (): void => undefined,
    };
    h.filters.push(node);
    return node;
  };

  const makeCompressor = (): unknown => ({
    threshold: new FakeParam(),
    knee: new FakeParam(),
    ratio: new FakeParam(),
    attack: new FakeParam(),
    release: new FakeParam(),
    connect: (): void => undefined,
    disconnect: (): void => undefined,
  });

  class FakeAudioContext {
    get currentTime(): number {
      return h.clock;
    }
    get state(): string {
      return h.state;
    }
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
    createDynamicsCompressor = makeCompressor;
    async decodeAudioData(bytes: ArrayBuffer): Promise<unknown> {
      const url = urls.get(bytes);
      if (!url) throw new Error('undecodable');
      return { duration: 1, sampleRate: 44100, numberOfChannels: 2, url };
    }
    async resume(): Promise<void> {
      h.state = 'running';
    }
    async suspend(): Promise<void> {
      h.state = 'suspended';
    }
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
// Helpers
// ---------------------------------------------------------------------------

/** An unlocked director with every asset resident, lazy ones included. */
async function makeHost(): Promise<AudioDirector> {
  const audio = new AudioDirector();
  await audio.unlock();
  return audio;
}

/** Warms the lazily loaded airfield set and lets the fetches settle. */
async function warm(air: AircraftAudio): Promise<void> {
  air.preload();
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function advance(dt: number): void {
  h.clock += dt;
  for (const source of h.sources) {
    if (source.loop || !source.started || source.stopped || !source.onended) continue;
    if (h.clock - source.startedAt < 2.5) continue;
    const done = source.onended;
    source.onended = null;
    source.stopped = true;
    done();
  }
}

/** Sources playing exactly this asset. `veh/impact` is a PREFIX of
 * `veh/impact-light`, so this matches the whole filename rather than a stem. */
function sourcesFor(id: string): FakeSource[] {
  return h.sources.filter((s) => s.buffer?.url.endsWith(`${id}.mp3`) === true);
}

function liveSourcesFor(id: string): FakeSource[] {
  return sourcesFor(id).filter((s) => !s.stopped);
}

const LISTENER = { x: 0, y: 1.7, z: 0, indoors: false };

function unit(over: Partial<PursuitUnit> & { id: number }): PursuitUnit {
  return { x: 20, y: 0.7, z: 0, siren: true, speed: 18, ...over };
}

/** Runs `frames` frames of the police layer with a fixed unit list. */
function runPolice(
  police: PoliceAudio,
  units: readonly PursuitUnit[],
  frames = 40,
  over: Partial<typeof LISTENER> = {},
): void {
  for (let f = 0; f < frames; f += 1) {
    police.update(1 / 60, { ...LISTENER, ...over, units });
    advance(1 / 60);
  }
}

function plane(over: Partial<AircraftEngineFrame> & { id: number }): AircraftEngineFrame {
  return {
    x: 60,
    y: 40,
    z: 0,
    rpm: 0.7,
    throttle: 0.7,
    airspeed: 60,
    type: 'cessna',
    onGround: false,
    ...over,
  };
}

function runAir(
  air: AircraftAudio,
  planes: readonly AircraftEngineFrame[],
  frames = 40,
  over: Record<string, unknown> = {},
): void {
  for (let f = 0; f < frames; f += 1) {
    for (const frame of planes) air.engine(frame);
    air.update(1 / 60, { ...LISTENER, ...over });
    advance(1 / 60);
  }
}

// ---------------------------------------------------------------------------
// Police
// ---------------------------------------------------------------------------

describe('police siren', () => {
  it('gives a pursuing unit a siren', async () => {
    // There was no siren asset, no code path and no stub before this: a police
    // car was an ordinary traffic engine voice and nothing else.
    const audio = await makeHost();
    const police = new PoliceAudio(audio);
    runPolice(police, [unit({ id: 1 })]);

    expect(liveSourcesFor(POLICE_SOUNDS.siren).length).toBeGreaterThan(0);
    expect(police.stats.sirens).toBe(1);
    expect(police.stats.sirenLevel).toBeGreaterThan(0);
    police.dispose();
    audio.dispose();
  });

  it('does not give a parked patrol car one', async () => {
    const audio = await makeHost();
    const police = new PoliceAudio(audio);
    runPolice(police, [unit({ id: 1, siren: false, speed: 0 })]);

    expect(police.stats.activeUnits).toBe(1);
    expect(police.stats.sirens).toBe(0);
    expect(police.stats.sirenLevel).toBe(0);
    police.dispose();
    audio.dispose();
  });

  it('still gives that parked car an engine, so it is not a silent prop', async () => {
    const audio = await makeHost();
    const police = new PoliceAudio(audio);
    runPolice(police, [unit({ id: 1, siren: false, speed: 0 })]);

    const engines = liveSourcesFor(POLICE_SOUNDS.engine);
    expect(engines.length).toBeGreaterThan(0);
    police.dispose();
    audio.dispose();
  });

  it('is louder for a unit driving hard than for one at a standstill', async () => {
    const audio = await makeHost();
    const police = new PoliceAudio(audio);
    const gainsBefore = h.gains.length;
    runPolice(police, [unit({ id: 1, siren: false, speed: 0 })], 30);
    const idle = h.gains
      .slice(gainsBefore)
      .map((g) => g.gain.value)
      .reduce((a, b) => Math.max(a, b), 0);

    const audio2 = await makeHost();
    const police2 = new PoliceAudio(audio2);
    const mark = h.gains.length;
    runPolice(police2, [unit({ id: 2, siren: false, speed: 25 })], 30);
    const chasing = h.gains
      .slice(mark)
      .map((g) => g.gain.value)
      .reduce((a, b) => Math.max(a, b), 0);

    expect(chasing).toBeGreaterThan(idle);
    police.dispose();
    police2.dispose();
    audio.dispose();
    audio2.dispose();
  });

  it('is spatial: it is panned at the unit and not at the listener', async () => {
    const audio = await makeHost();
    const police = new PoliceAudio(audio);
    runPolice(police, [unit({ id: 1, x: 42, y: 0.7, z: -17 })]);

    const placed = h.panners.filter((p) => p.positionX.value === 42 && p.positionZ.value === -17);
    expect(placed.length).toBeGreaterThan(0);
    // And it carries: rolling a siren off as fast as an idling engine would
    // defeat the point of the sound.
    expect(placed[0]?.rolloffFactor).toBeLessThan(1);
    expect(placed[0]?.maxDistance).toBeGreaterThan(100);
    police.dispose();
    audio.dispose();
  });

  it('follows a unit that moves rather than emitting from a fixed point', async () => {
    const audio = await makeHost();
    const police = new PoliceAudio(audio);
    for (let f = 0; f < 60; f += 1) {
      police.update(1 / 60, { ...LISTENER, units: [unit({ id: 1, x: 60 - f, z: 5 })] });
      advance(1 / 60);
    }
    const moved = h.panners.filter((p) => p.positionX.value === 1);
    expect(moved.length).toBeGreaterThan(0);
    police.dispose();
    audio.dispose();
  });

  it('goes silent when the pursuit ends', async () => {
    const audio = await makeHost();
    const police = new PoliceAudio(audio);
    runPolice(police, [unit({ id: 1 })]);
    expect(police.stats.sirens).toBe(1);

    // The units list empties: the pursuit was called off, or the unit was lost.
    runPolice(police, []);
    expect(police.stats.activeUnits).toBe(0);
    expect(police.stats.sirens).toBe(0);
    for (const gain of h.gains) {
      if (gain.gain.history.length === 0) continue;
    }
    // The voice is kept but ramped to zero: a stopped buffer source can never
    // be restarted, and a second pursuit has to work.
    expect(liveSourcesFor(POLICE_SOUNDS.siren).length).toBeGreaterThan(0);
    police.dispose();
    audio.dispose();
  });

  it('drops a unit that drives out of earshot, and takes it back', async () => {
    const audio = await makeHost();
    const police = new PoliceAudio(audio);
    runPolice(police, [unit({ id: 1, x: 20 })]);
    expect(police.stats.activeUnits).toBe(1);

    runPolice(police, [unit({ id: 1, x: 900 })]);
    expect(police.stats.activeUnits).toBe(0);

    runPolice(police, [unit({ id: 1, x: 25 })]);
    expect(police.stats.activeUnits).toBe(1);
    police.dispose();
    audio.dispose();
  });

  it('prefers a screaming unit over a silent one at the same distance', async () => {
    const audio = await makeHost();
    const police = new PoliceAudio(audio);
    const units = [
      unit({ id: 1, x: 18, siren: false }),
      unit({ id: 2, x: 19, siren: false }),
      unit({ id: 3, x: 40, siren: true }),
    ];
    runPolice(police, units);
    // Two voices, and the chasing unit has one of them even though it is twice
    // as far away: the sound that matters is the one saying "you are caught".
    expect(police.stats.sirens).toBe(1);
    police.dispose();
    audio.dispose();
  });

  it('applies Doppler to a closing unit and not to a stationary one', async () => {
    const audio = await makeHost();
    const police = new PoliceAudio(audio);

    runPolice(police, [unit({ id: 1, x: 40, vx: -30, vz: 0 })], 20);
    const closing = liveSourcesFor(POLICE_SOUNDS.siren)[0]?.playbackRate.value ?? 1;
    police.dispose();
    audio.dispose();

    const audio2 = await makeHost();
    const police2 = new PoliceAudio(audio2);
    runPolice(police2, [unit({ id: 2, x: 40, vx: 0, vz: 0 })], 20);
    const still = liveSourcesFor(POLICE_SOUNDS.siren).slice(-1)[0]?.playbackRate.value ?? 1;

    // Closing raises the pitch, standing still leaves it alone, and neither
    // runs away: the loop has to stay inside its own buffer.
    expect(closing).toBeGreaterThan(1);
    expect(closing).toBeLessThan(1.07);
    expect(still).toBe(1);
    police2.dispose();
    audio2.dispose();
  });

  it('does not pitch a unit crossing in front of the player', async () => {
    // Only the RADIAL component is Doppler. A car passing left to right at
    // 30 m/s is not approaching at all.
    const audio = await makeHost();
    const police = new PoliceAudio(audio);
    runPolice(police, [unit({ id: 1, x: 0, z: 40, vx: 30, vz: 0 })], 20);
    const rate = liveSourcesFor(POLICE_SOUNDS.siren)[0]?.playbackRate.value ?? 1;
    expect(Math.abs(rate - 1)).toBeLessThan(0.005);
    police.dispose();
    audio.dispose();
  });

  it('holds its node budget through a long chase with units coming and going', async () => {
    const audio = await makeHost();
    const police = new PoliceAudio(audio);
    let peak = 0;
    for (let f = 0; f < 3600; f += 1) {
      const t = f / 60;
      const units: PursuitUnit[] = [];
      // Up to six units churning in and out of earshot, which is far more than
      // a real pursuit and exactly the case a pool has to survive.
      for (let i = 0; i < 6; i += 1) {
        if ((f + i * 37) % 300 > 240) continue;
        units.push(
          unit({
            id: i,
            x: Math.sin(i * 1.3 + t) * 120,
            z: Math.cos(i * 0.9 + t) * 120,
            siren: i % 2 === 0,
            speed: 8 + i * 3,
            vx: Math.cos(i * 1.3 + t) * 20,
            vz: -Math.sin(i * 0.9 + t) * 20,
          }),
        );
      }
      police.update(1 / 60, { ...LISTENER, units });
      advance(1 / 60);
      peak = Math.max(peak, police.stats.liveNodes);
    }
    // Two units, six nodes each: two sources, two gains, a filter and one
    // shared panner. Nothing here is transient, so this is the whole cost.
    expect(peak).toBeLessThanOrEqual(12);
    expect(police.stats.activeUnits).toBeLessThanOrEqual(2);
    police.dispose();
    expect(police.stats.liveNodes).toBe(0);
    audio.dispose();
  });

  it('stops every looping voice it owns on dispose', async () => {
    const audio = await makeHost();
    const police = new PoliceAudio(audio);
    runPolice(police, [unit({ id: 1 }), unit({ id: 2, x: -30 })]);
    const looping = h.sources.filter((s) => s.loop);
    expect(looping.length).toBeGreaterThanOrEqual(4);

    police.dispose();
    for (const source of looping) expect(source.stopped).toBe(true);
    audio.dispose();
  });

  it('is inert before the context is unlocked and never throws', () => {
    const audio = new AudioDirector();
    const police = new PoliceAudio(audio);
    expect(() => police.update(1 / 60, { ...LISTENER, units: [unit({ id: 1 })] })).not.toThrow();
    expect(police.stats.liveNodes).toBe(0);
    police.dispose();
    audio.dispose();
  });

  it('never throws while the context is suspended', async () => {
    const audio = await makeHost();
    const police = new PoliceAudio(audio);
    runPolice(police, [unit({ id: 1 })], 10);
    audio.setGamePaused(true);
    expect(() => runPolice(police, [unit({ id: 1, x: 5 })], 10)).not.toThrow();
    police.dispose();
    audio.dispose();
  });
});

describe('street layer and the police', () => {
  it('does not give a dispatched pursuit unit a second, civilian engine voice', async () => {
    /*
     * A pursuit unit is taken over from ordinary traffic and stays in
     * `traffic.vehicles`, so without this it gets the plain tyre-roll loop as
     * well as the pursuit one: two engines on one object, a few milliseconds
     * apart, phasing against each other.
     *
     * THE FIXTURE HAS TO SAY `control: 'player'`. `TrafficSystem.takeControl`
     * is what the police system calls, and it sets control to `'player'` -
     * so a car with police livery and AMBIENT control has not been dispatched
     * by anybody. It is one of the two patrol body kinds driving around as
     * part of the fleet, it is a measurable share of the traffic, and it must
     * still be audible. That case is the next test.
     */
    const audio = await makeHost();
    const street = new StreetAudio({ host: audio, surfaceAt: () => 'asphalt' });
    const cars: VehicleAudioView[] = [
      { id: 1, x: 8, y: 0.7, z: 0, speed: 14, braking: false, accelLong: 0, control: 'player', police: true },
    ];
    for (let f = 0; f < 90; f += 1) {
      street.update(1 / 60, {
        x: 0, y: 1.7, z: 0, indoors: false, driving: false, driveSpeed: 0,
        vehicles: cars, crowd: null,
      });
      advance(1 / 60);
    }
    expect(street.stats.trafficVoices).toBe(0);

    // A civilian car in the same place does get one.
    const civilian: VehicleAudioView[] = [
      { ...(cars[0] as VehicleAudioView), police: false, control: 'ambient' },
    ];
    for (let f = 0; f < 90; f += 1) {
      street.update(1 / 60, {
        x: 0, y: 1.7, z: 0, indoors: false, driving: false, driveSpeed: 0,
        vehicles: civilian, crowd: null,
      });
      advance(1 / 60);
    }
    expect(street.stats.trafficVoices).toBe(1);
    street.dispose();
    audio.dispose();
  });

  it('still voices a patrol car nobody has dispatched', async () => {
    // Police livery is not a pursuit. Two of the eleven body kinds wear it and
    // spawn as ordinary traffic; silencing those left a measurable share of the
    // fleet driving past with no engine at all.
    const audio = await makeHost();
    const street = new StreetAudio({ host: audio, surfaceAt: () => 'asphalt' });
    const patrol: VehicleAudioView[] = [
      { id: 1, x: 8, y: 0.7, z: 0, speed: 14, braking: false, accelLong: 0, control: 'ambient', police: true },
    ];
    for (let f = 0; f < 90; f += 1) {
      street.update(1 / 60, {
        x: 0, y: 1.7, z: 0, indoors: false, driving: false, driveSpeed: 0,
        vehicles: patrol, crowd: null,
      });
      advance(1 / 60);
    }
    expect(street.stats.trafficVoices).toBe(1);
    street.dispose();
    audio.dispose();
  });
});

// ---------------------------------------------------------------------------
// Aircraft and the airfield
// ---------------------------------------------------------------------------

describe('aircraft', () => {
  it('voices an aircraft with the loop for its own powerplant', async () => {
    const audio = await makeHost();
    const air = new AircraftAudio(audio);
    await warm(air);

    runAir(air, [plane({ id: 1, type: 'liner' })]);
    expect(liveSourcesFor(AIRCRAFT_ENGINES.liner).length).toBeGreaterThan(0);
    expect(liveSourcesFor(AIRCRAFT_ENGINES.cessna)).toHaveLength(0);
    expect(air.stats.activeVoices).toBe(1);
    air.dispose();
    audio.dispose();
  });

  it('raises pitch with rpm', async () => {
    const audio = await makeHost();
    const air = new AircraftAudio(audio);
    await warm(air);

    runAir(air, [plane({ id: 1, rpm: 0.1, throttle: 0.1 })], 20);
    const low = liveSourcesFor(AIRCRAFT_ENGINES.cessna)[0]?.playbackRate.value ?? 0;
    runAir(air, [plane({ id: 1, rpm: 1, throttle: 1 })], 20);
    const high = liveSourcesFor(AIRCRAFT_ENGINES.cessna)[0]?.playbackRate.value ?? 0;

    expect(high).toBeGreaterThan(low);
    // And never so far that the loop runs off the end of its own buffer.
    expect(high).toBeLessThan(1.2);
    expect(low).toBeGreaterThan(0.75);
    air.dispose();
    audio.dispose();
  });

  it('opens the filter with throttle at a fixed rpm', async () => {
    // Level alone reads as distance. An engine turning fast with the levers
    // back is quieter AND duller, which is what separates a descent from a
    // climb at the same indicated rpm.
    const audio = await makeHost();
    const air = new AircraftAudio(audio);
    await warm(air);

    // The aircraft voice's filter is the first one created: the pool is filled
    // during `reassign`, and the wind layer is built later in the same frame.
    runAir(air, [plane({ id: 1, rpm: 0.8, throttle: 0.05 })], 30);
    const closed = h.filters[0]?.frequency.value ?? 0;
    runAir(air, [plane({ id: 1, rpm: 0.8, throttle: 1 })], 30);
    const open = h.filters[0]?.frequency.value ?? 0;

    expect(closed).toBeGreaterThan(0);
    expect(open).toBeGreaterThan(closed * 1.5);
    air.dispose();
    audio.dispose();
  });

  it('rumbles on the runway only while an aircraft is on the ground', async () => {
    const audio = await makeHost();
    const air = new AircraftAudio(audio);
    await warm(air);

    runAir(air, [plane({ id: 1, onGround: false, airspeed: 70 })], 40);
    expect(air.stats.rollLevel).toBe(0);

    runAir(air, [plane({ id: 1, onGround: true, airspeed: 55, y: 1 })], 40);
    expect(air.stats.rollLevel).toBeGreaterThan(0);
    expect(liveSourcesFor(AIRCRAFT_SOUNDS.runwayRoll).length).toBe(1);
    air.dispose();
    audio.dispose();
  });

  it('plays a touchdown scaled by how hard the aeroplane arrived', async () => {
    const audio = await makeHost();
    const air = new AircraftAudio(audio);
    await warm(air);

    air.touchdown(100, 1, 0, 0.5);
    const soft = sourcesFor(AIRCRAFT_SOUNDS.touchdown).slice(-1)[0];
    expect(soft).toBeDefined();
    const softRate = soft?.playbackRate.value ?? 0;

    // The cooldown runs off `dt`, not the wall clock, so it needs real frames.
    for (let f = 0; f < 60; f += 1) {
      air.update(1 / 60, LISTENER);
      advance(1 / 60);
    }
    air.touchdown(100, 1, 0, 4.5);
    const touchdowns = sourcesFor(AIRCRAFT_SOUNDS.touchdown);
    expect(touchdowns).toHaveLength(2);
    const hard = touchdowns[1];
    // A firm arrival is lower: more mass landing, less chirp.
    expect(hard?.playbackRate.value ?? 1).toBeLessThan(softRate);
    air.dispose();
    audio.dispose();
  });

  it('derives braking from airspeed rather than needing a fourth callback', async () => {
    const audio = await makeHost();
    const air = new AircraftAudio(audio);
    await warm(air);

    // A landing rollout: on the ground, decelerating hard.
    let speed = 70;
    for (let f = 0; f < 60; f += 1) {
      air.engine(plane({ id: 1, onGround: true, airspeed: speed, y: 1, throttle: 0 }));
      air.update(1 / 60, LISTENER);
      advance(1 / 60);
      speed -= 0.35;
    }
    expect(sourcesFor(AIRCRAFT_SOUNDS.brake).length).toBeGreaterThan(0);
    air.dispose();
    audio.dispose();
  });

  it('does not hear brakes on a steady taxi', async () => {
    const audio = await makeHost();
    const air = new AircraftAudio(audio);
    await warm(air);
    runAir(air, [plane({ id: 1, onGround: true, airspeed: 8, y: 1, throttle: 0.2 })], 120);
    expect(sourcesFor(AIRCRAFT_SOUNDS.brake)).toHaveLength(0);
    air.dispose();
    audio.dispose();
  });

  it('makes the wind louder and duller in the cockpit than outside it', async () => {
    const audio = await makeHost();
    const air = new AircraftAudio(audio);
    await warm(air);

    runAir(air, [plane({ id: 1, airspeed: 80 })], 60, { inCockpit: false });
    const outside = air.stats.windLevel;
    // The wind filter is the second created: the engine voice takes the first.
    const outsideCutoff = h.filters[1]?.frequency.value ?? 0;

    runAir(air, [plane({ id: 1, airspeed: 80 })], 60, { inCockpit: true });
    const inside = air.stats.windLevel;
    const insideCutoff = h.filters[1]?.frequency.value ?? 0;

    expect(inside).toBeGreaterThan(outside);
    expect(insideCutoff).toBeLessThan(outsideCutoff);
    air.dispose();
    audio.dispose();
  });

  it('scales the wind with airspeed and silences it at rest', async () => {
    const audio = await makeHost();
    const air = new AircraftAudio(audio);
    await warm(air);

    runAir(air, [plane({ id: 1, airspeed: 90 })], 60, { inCockpit: true });
    const fast = air.stats.windLevel;
    runAir(air, [plane({ id: 1, airspeed: 0, onGround: true })], 60, { inCockpit: true });
    expect(air.stats.windLevel).toBeLessThan(fast);
    expect(air.stats.windLevel).toBeLessThan(0.02);
    air.dispose();
    audio.dispose();
  });

  it('brings the apron bed up on the field and down away from it', async () => {
    const audio = await makeHost();
    const air = new AircraftAudio(audio);
    await warm(air);

    runAir(air, [plane({ id: 1 })], 200, { airfieldDistance: 40 });
    const onField = air.stats.airportLevel;
    expect(onField).toBeGreaterThan(0);
    expect(liveSourcesFor(AIRPORT_BED)).toHaveLength(1);

    runAir(air, [plane({ id: 1 })], 400, { airfieldDistance: 800 });
    expect(air.stats.airportLevel).toBeLessThan(onField);
    expect(air.stats.airportLevel).toBe(0);
    // Still one source: it is faded, not churned.
    expect(liveSourcesFor(AIRPORT_BED)).toHaveLength(1);
    air.dispose();
    audio.dispose();
  });

  it('leaves the bed silent for a caller with no airfield', async () => {
    const audio = await makeHost();
    const air = new AircraftAudio(audio);
    await warm(air);
    runAir(air, [plane({ id: 1 })], 60);
    expect(air.stats.airportLevel).toBe(0);
    expect(sourcesFor(AIRPORT_BED)).toHaveLength(0);
    air.dispose();
    audio.dispose();
  });

  it('holds its node budget over a long busy circuit', async () => {
    const audio = await makeHost();
    const air = new AircraftAudio(audio);
    await warm(air);

    let peak = 0;
    const types = ['cessna', 'twin', 'jet', 'liner'] as const;
    for (let f = 0; f < 3600; f += 1) {
      const t = f / 60;
      const planes: AircraftEngineFrame[] = [];
      // Eight aircraft of four types churning in and out of range, plus
      // touchdowns and impacts landing on top of them.
      for (let i = 0; i < 8; i += 1) {
        planes.push(
          plane({
            id: i,
            type: types[i % 4] as AircraftEngineFrame['type'],
            x: Math.sin(i * 1.1 + t) * 400,
            z: Math.cos(i * 0.7 + t) * 400,
            rpm: 0.3 + 0.6 * Math.abs(Math.sin(t + i)),
            throttle: Math.abs(Math.cos(t * 0.7 + i)),
            airspeed: 20 + 60 * Math.abs(Math.sin(t * 0.3 + i)),
            onGround: i % 3 === 0,
          }),
        );
      }
      for (const frame of planes) air.engine(frame);
      if (f % 90 === 0) air.touchdown(10, 1, 0, 2.5);
      if (f % 150 === 0) air.impact(12, 1, 0, 0.8);
      air.update(1 / 60, { ...LISTENER, airfieldDistance: 60, inCockpit: f % 400 < 200 });
      advance(1 / 60);
      peak = Math.max(peak, air.stats.liveNodes);
    }

    // 3 voices * 4 + roll 3 + wind 3 + bed 2 = 20 persistent, plus at most
    // 3 one-shots at 3 nodes each.
    expect(peak).toBeLessThanOrEqual(29);
    expect(air.stats.activeVoices).toBeLessThanOrEqual(3);
    air.dispose();
    expect(air.stats.liveNodes).toBe(0);
    audio.dispose();
  });

  it('stays silent rather than throwing while its lazy assets are missing', async () => {
    // Everything here is outside the eager preload, so a first frame at the
    // airfield genuinely has no buffers. That must be quiet, not a crash.
    const audio = await makeHost();
    const air = new AircraftAudio(audio);
    expect(() => runAir(air, [plane({ id: 1 })], 5, { airfieldDistance: 30 })).not.toThrow();
    expect(() => air.touchdown(0, 0, 0, 3)).not.toThrow();
    air.dispose();
    audio.dispose();
  });

  it('is inert before the context is unlocked and never throws', () => {
    const audio = new AudioDirector();
    const air = new AircraftAudio(audio);
    expect(() => runAir(air, [plane({ id: 1 })], 5)).not.toThrow();
    expect(air.stats.liveNodes).toBe(0);
    air.dispose();
    audio.dispose();
  });

  it('stops every looping voice it owns on dispose', async () => {
    const audio = await makeHost();
    const air = new AircraftAudio(audio);
    await warm(air);
    runAir(air, [plane({ id: 1, onGround: true, airspeed: 50, y: 1 })], 120, {
      airfieldDistance: 30,
      inCockpit: true,
    });
    const looping = h.sources.filter((s) => s.loop);
    expect(looping.length).toBeGreaterThanOrEqual(4);
    air.dispose();
    for (const source of looping) expect(source.stopped).toBe(true);
    audio.dispose();
  });
});

// ---------------------------------------------------------------------------
// Impacts
// ---------------------------------------------------------------------------

describe('vehicle impacts', () => {
  function street(audio: AudioDirector): StreetAudio {
    return new StreetAudio({ host: audio, surfaceAt: () => 'asphalt' });
  }

  it('picks a different recording for a nudge and for a crash', async () => {
    // The old behaviour was one asset at `0.5 + 0.5 * severity`: a 6 dB range
    // on a single recording, which reads as one event heard from two distances.
    const audio = await makeHost();
    const layer = street(audio);

    layer.impact({ x: 3, y: 0.6, z: 1, intensity: 0.1, kind: 'vehicle' });
    expect(sourcesFor(VEHICLE_SOUNDS.impactLight).length).toBe(1);

    layer.impact({ x: 3, y: 0.6, z: 1, intensity: 0.5, kind: 'vehicle' });
    expect(sourcesFor(VEHICLE_SOUNDS.impact).length).toBe(1);

    layer.impact({ x: 3, y: 0.6, z: 1, intensity: 0.9, kind: 'vehicle' });
    expect(sourcesFor(VEHICLE_SOUNDS.impactHeavy).length).toBe(1);
    layer.dispose();
    audio.dispose();
  });

  it('pans an impact at the collision rather than at the listener', async () => {
    const audio = await makeHost();
    const layer = street(audio);
    layer.impact({ x: -22, y: 0.6, z: 14, intensity: 0.5, kind: 'vehicle' });
    const placed = h.panners.filter((p) => p.positionX.value === -22 && p.positionZ.value === 14);
    expect(placed.length).toBeGreaterThan(0);
    layer.dispose();
    audio.dispose();
  });

  it('varies pitch between two identical collisions', async () => {
    const audio = await makeHost();
    const layer = street(audio);
    const rates = new Set<number>();
    for (let i = 0; i < 12; i += 1) {
      layer.impact({ x: 0, y: 0.6, z: 0, intensity: 0.5, kind: 'vehicle' });
      const last = sourcesFor(VEHICLE_SOUNDS.impact).slice(-1)[0];
      if (last) rates.add(last.playbackRate.value);
      advance(3);
    }
    expect(rates.size).toBeGreaterThan(6);
    layer.dispose();
    audio.dispose();
  });

  it('makes hitting scenery duller than hitting another car', async () => {
    const audio = await makeHost();
    const layer = street(audio);
    let world = 0;
    let vehicle = 0;
    for (let i = 0; i < 40; i += 1) {
      layer.impact({ x: 0, y: 0.6, z: 0, intensity: 0.5, kind: 'world' });
      world += sourcesFor(VEHICLE_SOUNDS.impact).slice(-1)[0]?.playbackRate.value ?? 0;
      advance(3);
      layer.impact({ x: 0, y: 0.6, z: 0, intensity: 0.5, kind: 'vehicle' });
      vehicle += sourcesFor(VEHICLE_SOUNDS.impact).slice(-1)[0]?.playbackRate.value ?? 0;
      advance(3);
    }
    expect(world / 40).toBeLessThan(vehicle / 40);
    layer.dispose();
    audio.dispose();
  });

  it('brings glass down with a hard hit and not with a soft one', async () => {
    const audio = await makeHost();
    const layer = street(audio);
    layer.impact({ x: 0, y: 0.6, z: 0, intensity: 0.4, kind: 'vehicle' });
    expect(sourcesFor('imp/glass')).toHaveLength(0);
    advance(3);
    layer.impact({ x: 0, y: 0.6, z: 0, intensity: 0.95, kind: 'vehicle' });
    expect(sourcesFor('imp/glass').length).toBe(1);
    layer.dispose();
    audio.dispose();
  });

  it('clamps an intensity outside 0..1 rather than producing a silent or hot hit', async () => {
    const audio = await makeHost();
    const layer = street(audio);
    expect(() => layer.impact({ x: 0, y: 0, z: 0, intensity: -5, kind: 'world' })).not.toThrow();
    advance(3);
    expect(() => layer.impact({ x: 0, y: 0, z: 0, intensity: 9, kind: 'world' })).not.toThrow();
    expect(sourcesFor(VEHICLE_SOUNDS.impactLight).length).toBe(1);
    expect(sourcesFor(VEHICLE_SOUNDS.impactHeavy).length).toBe(1);
    layer.dispose();
    audio.dispose();
  });
});

describe('bullet impacts', () => {
  it('varies level and pitch with intensity, which it never used to', async () => {
    const audio = await makeHost();
    const combat = new CombatAudio(audio);
    combat.preload();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();

    combat.impact('metal', 5, 1, 0, 0.05);
    const weak = h.gains.slice(-1)[0]?.gain.value ?? 0;
    combat.update(0.2, { health: 100, maxHealth: 100, alive: true });
    combat.impact('metal', 5, 1, 0, 1);
    const strong = h.gains.slice(-1)[0]?.gain.value ?? 0;
    expect(strong).toBeGreaterThan(weak);

    // Pitch is averaged rather than sampled once: the per-hit jitter is +/-12
    // per cent and the intensity term is 8, so a single pair can invert. The
    // jitter is the point - two identical hits must not sound identical - so
    // the assertion is about the population, not about one round.
    let weakSum = 0;
    let strongSum = 0;
    const rounds = 40;
    for (let i = 0; i < rounds; i += 1) {
      combat.update(0.2, { health: 100, maxHealth: 100, alive: true });
      combat.impact('metal', 5, 1, 0, 0.05);
      weakSum += sourcesFor('imp/metal').slice(-1)[0]?.playbackRate.value ?? 0;
      combat.update(0.2, { health: 100, maxHealth: 100, alive: true });
      combat.impact('metal', 5, 1, 0, 1);
      strongSum += sourcesFor('imp/metal').slice(-1)[0]?.playbackRate.value ?? 0;
      advance(3);
    }
    // A weak hit is higher: less energy into the surface, less of it low.
    expect(weakSum / rounds).toBeGreaterThan(strongSum / rounds);
    combat.dispose();
    audio.dispose();
  });

  it('has a real recording for the materials the combat layer is adding', () => {
    expect(impactSoundFor('timber')).toBe('imp/wood');
    expect(impactSoundFor('wood')).toBe('imp/wood');
    expect(impactSoundFor('foliage')).toBe('imp/foliage');
    expect(impactSoundFor('stone')).toBe('imp/concrete');
    expect(impactSoundFor('concrete')).toBe('imp/concrete');
    for (const kind of ['timber', 'foliage', 'stone', 'concrete']) {
      expect(() => getAudioAsset(impactSoundFor(kind))).not.toThrow();
    }
  });

  it('degrades to concrete for a material nobody has recorded', async () => {
    // A round has to make a noise. A silent impact reads as broken ballistics,
    // not as a missing asset.
    expect(impactSoundFor('unobtainium')).toBe('imp/concrete');

    const audio = await makeHost();
    const combat = new CombatAudio(audio);
    combat.preload();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(() => combat.impact('unobtainium', 1, 1, 1, 0.7)).not.toThrow();
    expect(sourcesFor('imp/concrete').length).toBe(1);
    combat.dispose();
    audio.dispose();
  });
});
