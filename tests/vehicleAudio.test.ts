/**
 * The vehicle mix, asserted as arithmetic.
 *
 * `engineCurve.ts` is the whole feel of the engine and it is pure, so the
 * things a player complains about - "they all sound the same", "the note does
 * not match what the car is doing", "the far ones are as loud as the near
 * ones" - are properties of a function and can be pinned here rather than
 * judged by ear. The graph-level behaviour (voice swapping, budgets, the
 * gearchange, leaks) lives in `tests/streetAudio.test.ts`, where the Web Audio
 * mock is.
 *
 * NOTE ON WHAT THIS CANNOT PROVE. Nothing here shows the result SOUNDS like a
 * truck. What it shows is that a truck's note is measurably not a hatchback's,
 * that every class is mapped to a recorded pair that exists, and that the
 * curves stay inside their documented bounds at every speed and load.
 */

import { describe, expect, it } from 'vitest';

import {
  ENGINE_PROFILES,
  ambientCutoff,
  ambientLevel,
  ambientRate,
  engineProfileFor,
  engineTone,
  engineVoiceFor,
  gearFor,
  inverseDistanceGain,
  loadFromAcceleration,
  type EngineVoice,
} from '../src/audio/engineCurve';
import { ENGINE_VOICE_LAYERS, getAudioAsset } from '../src/audio/manifest';
import { VEHICLE_BLUEPRINTS } from '../src/traffic/VehicleCatalogue';

// ---------------------------------------------------------------------------
// Class to voice
// ---------------------------------------------------------------------------

describe('vehicle class to engine voice', () => {
  const table: Array<{ kind: string; voice: EngineVoice }> = [
    { kind: 'compact', voice: 'small' },
    { kind: 'sedan', voice: 'saloon' },
    { kind: 'wagon', voice: 'saloon' },
    { kind: 'crossover', voice: 'saloon' },
    { kind: 'taxi', voice: 'saloon' },
    { kind: 'coupe', voice: 'sport' },
    { kind: 'van', voice: 'diesel' },
    { kind: 'pickup', voice: 'diesel' },
    { kind: 'boxTruck', voice: 'truck' },
    { kind: 'patrolSedan', voice: 'interceptor' },
    { kind: 'patrolSuv', voice: 'interceptor' },
  ];

  for (const row of table) {
    it(`gives a ${row.kind} the ${row.voice} voice`, () => {
      expect(engineVoiceFor(row.kind)).toBe(row.voice);
      expect(engineProfileFor(row.kind).voice).toBe(row.voice);
    });
  }

  it('covers every shell in the catalogue', () => {
    // Reads the catalogue itself, so a body kind added over there without a
    // voice fails here rather than silently becoming a saloon.
    const mapped = new Set(table.map((r) => r.kind));
    for (const kind of Object.keys(VEHICLE_BLUEPRINTS)) {
      expect(mapped.has(kind), `${kind} has no voice mapping`).toBe(true);
    }
  });

  it('falls back to the saloon for a shell it has never heard of', () => {
    expect(engineVoiceFor('hovercraft')).toBe('saloon');
    expect(engineVoiceFor(null)).toBe('saloon');
    expect(engineVoiceFor(undefined)).toBe('saloon');
  });

  it('points every voice at two recordings that exist', () => {
    for (const [voice, layers] of Object.entries(ENGINE_VOICE_LAYERS)) {
      expect(() => getAudioAsset(layers.idle), voice).not.toThrow();
      expect(() => getAudioAsset(layers.load), voice).not.toThrow();
      expect(layers.idle).not.toBe(layers.load);
      expect(getAudioAsset(layers.idle).loop).toBe(true);
      expect(getAudioAsset(layers.load).loop).toBe(true);
    }
  });

  it('never gives two voices the same recording', () => {
    const seen = new Set<string>();
    for (const layers of Object.values(ENGINE_VOICE_LAYERS)) {
      for (const id of [layers.idle, layers.load]) {
        expect(seen.has(id), `${id} is shared between voices`).toBe(false);
        seen.add(id);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The classes are actually different
// ---------------------------------------------------------------------------

describe('the classes do not all sound the same', () => {
  const voices = Object.keys(ENGINE_PROFILES) as EngineVoice[];

  it('gives every class its own gearing', () => {
    const shapes = new Set(voices.map((v) => ENGINE_PROFILES[v].gearTops.join(',')));
    expect(shapes.size).toBe(voices.length);
  });

  it('separates a truck from a hatchback at the same road speed', () => {
    // 12 m/s is third gear in a hatchback and fourth-and-shifting in a truck.
    const hatch = engineTone(12, 0.5, ENGINE_PROFILES.small);
    const truck = engineTone(12, 0.5, ENGINE_PROFILES.truck);
    expect(truck.gear).toBeGreaterThan(hatch.gear);
    // The truck is darker and heavier; the hatchback is brighter and thinner.
    expect(truck.cutoff).toBeLessThan(hatch.cutoff * 0.6);
    expect(truck.gain).toBeGreaterThan(hatch.gain);
    expect(truck.idleRate).toBeLessThan(hatch.idleRate);
  });

  it('separates a coupe from a van at the same road speed', () => {
    const coupe = engineTone(20, 1, ENGINE_PROFILES.sport);
    const van = engineTone(20, 1, ENGINE_PROFILES.diesel);
    expect(coupe.cutoff).toBeGreaterThan(van.cutoff * 1.8);
    expect(coupe.gear).toBeLessThan(van.gear);
  });

  it('shifts a truck far more often than a coupe over the same run', () => {
    const shifts = (voice: EngineVoice): number => {
      let count = 0;
      let previous = gearFor(0, ENGINE_PROFILES[voice]).gear;
      for (let v = 0; v <= 26; v += 0.05) {
        const gear = gearFor(v, ENGINE_PROFILES[voice]).gear;
        if (gear > previous) count += 1;
        previous = gear;
      }
      return count;
    };
    expect(shifts('truck')).toBeGreaterThan(shifts('sport') + 2);
  });

  it('keeps an ambient car of each class distinguishable across a junction', () => {
    const rates = voices.map((v) => ambientRate(10, ENGINE_PROFILES[v]));
    const cutoffs = voices.map((v) => ambientCutoff(ENGINE_PROFILES[v]));
    // Truck lowest and darkest, sport highest and brightest.
    expect(Math.min(...rates)).toBe(ambientRate(10, ENGINE_PROFILES.truck));
    expect(Math.min(...cutoffs)).toBe(ambientCutoff(ENGINE_PROFILES.truck));
    expect(Math.max(...cutoffs)).toBe(ambientCutoff(ENGINE_PROFILES.sport));
    // And the spread is wide enough to hear: better than an octave of filter.
    expect(Math.max(...cutoffs)).toBeGreaterThan(Math.min(...cutoffs) * 2);
  });
});

// ---------------------------------------------------------------------------
// State to parameters
// ---------------------------------------------------------------------------

describe('engine state to engine note', () => {
  const voices = Object.keys(ENGINE_PROFILES) as EngineVoice[];

  const states: Array<{
    what: string;
    speed: number;
    load: number;
    expect: (
      t: ReturnType<typeof engineTone>,
      idle: ReturnType<typeof engineTone>,
      profile: (typeof ENGINE_PROFILES)[EngineVoice],
    ) => void;
  }> = [
    {
      what: 'stopped at a light',
      speed: 0,
      load: 0,
      expect: (t) => {
        // Audible, or stopping sounds like the engine died, and dark.
        expect(t.gain).toBeGreaterThan(0.35);
        expect(t.idleMix).toBeGreaterThan(t.loadMix);
        expect(t.tyreGain).toBe(0);
      },
    },
    {
      what: 'pulling away hard',
      speed: 5,
      load: 1,
      expect: (t, idle) => {
        expect(t.gain).toBeGreaterThan(idle.gain);
        expect(t.cutoff).toBeGreaterThan(idle.cutoff);
        expect(t.rev).toBeGreaterThan(idle.rev);
      },
    },
    {
      what: 'cruising',
      speed: 16,
      load: 0,
      expect: (t) => {
        expect(t.loadMix).toBeGreaterThan(t.idleMix);
        expect(t.tyreGain).toBeGreaterThan(0);
      },
    },
    {
      what: 'lifting off',
      speed: 16,
      load: -1,
      expect: (t, _idle, profile) => {
        const cruising = engineTone(16, 0, profile);
        expect(t.gain).toBeLessThan(cruising.gain);
        expect(t.cutoff).toBeLessThan(cruising.cutoff);
      },
    },
    {
      what: 'braking hard',
      speed: 4,
      load: -1,
      expect: (t, _idle, profile) => {
        // Quieter and duller than holding the same speed. Comparing against a
        // HIGHER road speed would be wrong: braking drops through the gears,
        // so 4 m/s in first can legitimately be revving harder than 20 m/s in
        // fourth - which is the gearbox being honest, not the note lagging.
        const holding = engineTone(4, 0, profile);
        expect(t.cutoff).toBeLessThan(holding.cutoff);
        expect(t.gain).toBeLessThan(holding.gain);
      },
    },
  ];

  for (const voice of voices) {
    for (const state of states) {
      it(`${voice}: ${state.what}`, () => {
        const profile = ENGINE_PROFILES[voice];
        state.expect(
          engineTone(state.speed, state.load, profile),
          engineTone(0, 0, profile),
          profile,
        );
      });
    }
  }

  it('never leaves the documented bounds at any speed or load', () => {
    for (const voice of voices) {
      const profile = ENGINE_PROFILES[voice];
      for (let v = -40; v <= 60; v += 0.5) {
        for (const load of [-1, -0.5, 0, 0.5, 1]) {
          const t = engineTone(v, load, profile);
          expect(Number.isFinite(t.gain)).toBe(true);
          expect(t.gain).toBeGreaterThan(0);
          expect(t.gain).toBeLessThanOrEqual(1);
          expect(t.idleMix).toBeGreaterThanOrEqual(0);
          expect(t.idleMix).toBeLessThanOrEqual(1);
          expect(t.loadMix).toBeGreaterThanOrEqual(0);
          expect(t.loadMix).toBeLessThanOrEqual(1);
          expect(t.tyreGain).toBeGreaterThanOrEqual(0);
          expect(t.tyreGain).toBeLessThanOrEqual(1);
          // Pitching a recording past 1.6 is a chipmunk, not an engine.
          expect(t.idleRate).toBeGreaterThan(0.5);
          expect(t.idleRate).toBeLessThan(1.6);
          expect(t.loadRate).toBeGreaterThan(0.5);
          expect(t.loadRate).toBeLessThan(1.6);
          expect(t.tyreRate).toBeGreaterThan(0.5);
          expect(t.tyreRate).toBeLessThan(1.6);
          expect(t.cutoff).toBeGreaterThan(80);
          expect(t.cutoff).toBeLessThan(20000);
        }
      }
    }
  });

  it('reverses exactly as it pulls away forwards', () => {
    for (const voice of voices) {
      const profile = ENGINE_PROFILES[voice];
      expect(engineTone(-6, 0.5, profile).idleRate).toBeCloseTo(
        engineTone(6, 0.5, profile).idleRate,
        9,
      );
    }
  });

  it('keeps the tyres tracking road speed, not revs', () => {
    // The whole reason the tyre bed is a separate layer: across an upshift the
    // revs drop and the road speed does not, so the tyres must not.
    const profile = ENGINE_PROFILES.saloon;
    const below = engineTone(profile.gearTops[0] as number, 1, profile);
    const above = engineTone((profile.gearTops[0] as number) + 0.2, 1, profile);
    expect(above.rev).toBeLessThan(below.rev);
    expect(above.tyreGain).toBeGreaterThan(below.tyreGain);
  });

  it('rises with speed monotonically on the tyre layer', () => {
    let previous = -1;
    for (let v = 0; v <= 40; v += 0.25) {
      const t = engineTone(v, 0, ENGINE_PROFILES.saloon);
      expect(t.tyreGain).toBeGreaterThanOrEqual(previous);
      previous = t.tyreGain;
    }
  });

  it('clamps load to the reference acceleration in both directions', () => {
    expect(loadFromAcceleration(1000)).toBe(1);
    expect(loadFromAcceleration(-1000)).toBe(-1);
    expect(loadFromAcceleration(0)).toBe(0);
  });

  it('keeps a queueing ambient car audible and a moving one louder', () => {
    for (const voice of Object.keys(ENGINE_PROFILES) as EngineVoice[]) {
      const profile = ENGINE_PROFILES[voice];
      expect(ambientLevel(0, profile)).toBeGreaterThan(0.1);
      expect(ambientLevel(14, profile)).toBeGreaterThan(ambientLevel(2, profile));
      expect(ambientRate(14, profile)).toBeGreaterThan(ambientRate(2, profile));
    }
  });
});

// ---------------------------------------------------------------------------
// Distance
// ---------------------------------------------------------------------------

describe('distance attenuation', () => {
  // The parameters `StreetAudio.makePanner` actually configures.
  const REF = 7;
  const ROLLOFF = 1.4;
  const MAX = 72;

  it('is monotonically decreasing with distance', () => {
    let previous = Infinity;
    for (let d = 0; d <= 200; d += 0.5) {
      const g = inverseDistanceGain(d, REF, ROLLOFF, MAX);
      expect(g).toBeLessThanOrEqual(previous + 1e-12);
      previous = g;
    }
  });

  it('is bounded to (0, 1] everywhere, including inside the reference sphere', () => {
    for (let d = 0; d <= 500; d += 0.25) {
      const g = inverseDistanceGain(d, REF, ROLLOFF, MAX);
      expect(g).toBeGreaterThan(0);
      expect(g).toBeLessThanOrEqual(1);
    }
    expect(inverseDistanceGain(0, REF, ROLLOFF, MAX)).toBe(1);
    expect(inverseDistanceGain(REF, REF, ROLLOFF, MAX)).toBe(1);
  });

  it('flattens past the maximum distance rather than running to zero', () => {
    const atMax = inverseDistanceGain(MAX, REF, ROLLOFF, MAX);
    expect(inverseDistanceGain(MAX * 4, REF, ROLLOFF, MAX)).toBeCloseTo(atMax, 12);
  });

  it('drops a car across the street well below one alongside', () => {
    // 7 m is the reference; 35 m is across a junction. More than 12 dB down.
    const near = inverseDistanceGain(7, REF, ROLLOFF, MAX);
    const far = inverseDistanceGain(35, REF, ROLLOFF, MAX);
    expect(20 * Math.log10(far / near)).toBeLessThan(-12);
  });
});
