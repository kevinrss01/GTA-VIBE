/**
 * The baked Tripo characters, asserted without a renderer.
 *
 * These are the checks that would have caught the failures a player notices
 * first in a baked crowd: a character standing in the ground or floating above
 * it, a character the wrong height, a walk that plays backwards, and above all
 * FEET THAT SKATE. The last one is the reason this file exists: the runtime
 * drives the clip by distance walked rather than by a clock, and the property
 * that makes that correct is measurable straight out of the shipped files.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  AIRPORT_VAT_IDS,
  CITY_ROSTER_BUDGET,
  CITY_VAT_IDS,
  MAX_WALK_SLIP,
  TERMINAL_ROSTER_BUDGET,
  TERMINAL_VAT_IDS,
  VAT_STATURE,
  VatClip,
} from '../src/agents/PedestrianVat';

/**
 * Every character the game ships, taken from the rosters themselves rather
 * than restated here - so a character added to a roster is covered by all of
 * the assertions below on the same commit, and a character removed from one
 * stops being asserted rather than failing to open.
 */
const IDS = [...new Set([...CITY_VAT_IDS, ...AIRPORT_VAT_IDS])] as const;

/**
 * How close to its own lowest point a sole vertex has to be to count as
 * touching the ground, in rig units. Mirrors `vertexSlide` in
 * `tools/bake-pedestrian-vat.mjs`; widening it merges two separate footfalls
 * into one run and invents slide that is not there.
 */
const CONTACT_BAND = 0.008;
const BASE = 'public/models/pedestrians';

interface Clip {
  name: string;
  column: number;
  frames: number;
  duration: number;
  travelPerCycle: number;
  travel: number[];
  slip: number;
}

interface Meta {
  version: number;
  id: string;
  vertexCount: number;
  indexCount: number;
  indexType: 'uint16' | 'uint32';
  texture: { width: number; height: number };
  clips: Clip[];
  albedo: string | null;
  layout: Record<string, { offset: number; length: number }>;
  heightUnits: number;
}

function fromHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * (mantissa + 1024) * 2 ** (exponent - 25);
}

interface Character {
  meta: Meta;
  positions: Uint16Array;
  width: number;
  /** Position of one vertex at one animation column, in rig units. */
  at(vertex: number, column: number): [number, number, number];
}

function load(id: string): Character {
  const meta = JSON.parse(readFileSync(`${BASE}/${id}.json`, 'utf8')) as Meta;
  const bin = readFileSync(`${BASE}/${id}.bin`);
  const section = meta.layout.position;
  if (!section) throw new Error(`${id}: no position section`);
  const positions = new Uint16Array(
    bin.buffer.slice(
      bin.byteOffset + section.offset,
      bin.byteOffset + section.offset + section.length,
    ),
  );
  const width = meta.texture.width;
  return {
    meta,
    positions,
    width,
    at(vertex: number, column: number): [number, number, number] {
      // The runtime gets this interpolation from the sampler's linear filter;
      // here it is done by hand so the test measures the same pose the GPU
      // shows rather than the nearest baked frame.
      const low = Math.floor(column);
      const t = column - low;
      const a = (vertex * width + low) * 4;
      const b = (vertex * width + low + 1) * 4;
      const mix = (k: number): number =>
        fromHalf(positions[a + k] ?? 0) * (1 - t) + fromHalf(positions[b + k] ?? 0) * t;
      return [mix(0), mix(1), mix(2)];
    },
  };
}

function clipOf(meta: Meta, name: string): Clip {
  const clip = meta.clips.find((entry) => entry.name === name);
  if (!clip) throw new Error(`${meta.id}: no ${name} clip`);
  return clip;
}

describe.each(IDS)('baked character %s', (id) => {
  const character = load(id);
  const meta = character.meta;

  it('describes a mesh the runtime can build', () => {
    expect(meta.version).toBe(1);
    expect(meta.vertexCount).toBeGreaterThan(500);
    // The VAT costs one texture row per vertex and one draw call per
    // character, so the mesh budget is the asset's real cost. 4000 triangles
    // is already generous for someone seen from two to thirty metres.
    expect(meta.indexCount / 3).toBeLessThan(4000);
    expect(meta.indexCount % 3).toBe(0);
    expect(meta.texture.height).toBe(meta.vertexCount);
    expect(meta.albedo).toBeTruthy();

    // Every clip is laid end to end with a duplicated wrap column.
    let column = 0;
    for (const clip of meta.clips) {
      expect(clip.column).toBe(column);
      column += clip.frames + 1;
    }
    expect(meta.texture.width).toBe(column);

    const bytes = readFileSync(`${BASE}/${id}.bin`).byteLength;
    let end = 0;
    for (const part of Object.values(meta.layout)) end = Math.max(end, part.offset + part.length);
    expect(end).toBe(bytes);
  });

  it('stands one unit tall with its feet on the ground', () => {
    const walk = clipOf(meta, 'walk');
    let low = Infinity;
    let high = -Infinity;
    for (let v = 0; v < meta.vertexCount; v += 1) {
      const y = character.at(v, walk.column)[1];
      low = Math.min(low, y);
      high = Math.max(high, y);
    }
    // Generated models arrive normalised with a CENTRE pivot; the bake
    // re-origins them, and this is the check that it did.
    expect(low).toBeGreaterThan(-0.02);
    expect(low).toBeLessThan(0.02);
    expect(high).toBeGreaterThan(0.97);
    expect(high).toBeLessThan(1.03);
  });

  it('walks forwards, towards -Z, at a human stride', () => {
    const walk = clipOf(meta, 'walk');
    // Two gait cycles per baked loop, so 1.2 to 2.0 body heights of travel.
    expect(walk.travelPerCycle).toBeGreaterThan(1.2);
    expect(walk.travelPerCycle).toBeLessThan(2.0);
    expect(walk.travel).toHaveLength(walk.frames + 1);
    expect(walk.travel[0]).toBe(0);
    expect(walk.travel[walk.frames]).toBeCloseTo(walk.travelPerCycle, 5);
    for (let f = 1; f <= walk.frames; f += 1) {
      expect(walk.travel[f] ?? -1).toBeGreaterThanOrEqual(walk.travel[f - 1] ?? 0);
    }
  });

  it('turns distance walked into a cycle position, monotonically', () => {
    const walk = new VatClip(clipOf(meta, 'walk'));
    expect(walk.phaseFor(0)).toBeCloseTo(0, 6);
    let previous = -1;
    for (let i = 0; i <= 200; i += 1) {
      const phase = walk.phaseFor((i / 201) * walk.travelPerCycle);
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(1);
      expect(phase).toBeGreaterThanOrEqual(previous);
      previous = phase;
    }
    /*
     * One whole cycle of distance returns to the start of the clip - and the
     * comparison has to be CYCLIC, because the phase is. `3 * a / a` is not
     * exactly 3 for every `travelPerCycle` a bake can carry (`ped-f`'s 1.5778
     * is one that it is not), so the answer legitimately lands a rounding
     * error BELOW one rather than at zero. Those are the same pose; a linear
     * `toBeCloseTo(0)` calls one of them a whole cycle wrong.
     */
    const fromStart = (phase: number): number => Math.min(phase, 1 - phase);
    expect(fromStart(walk.phaseFor(walk.travelPerCycle))).toBeCloseTo(0, 6);
    expect(fromStart(walk.phaseFor(walk.travelPerCycle * 3))).toBeCloseTo(0, 6);
    // A negative distance is still a valid phase, not NaN.
    expect(Number.isFinite(walk.phaseFor(-walk.travelPerCycle * 0.3))).toBe(true);
  });

  /**
   * THE ONE THAT MATTERS. Drive the clip the way `PedestrianSystem` does -
   * phase from distance covered - and follow the individual vertices of the
   * sole. While a vertex is touching the ground its world position must not
   * move; anything else is skating.
   *
   * The procedural rig this replaced was measured in the browser at a median
   * 283 mm of forward slide per stance, because `gait.ts` derives its stride
   * from the person's HEIGHT while the instance matrix scales them
   * horizontally by their GIRTH. The threshold here is an order of magnitude
   * tighter than that.
   */
  it('holds a planted foot still while the body walks over it', () => {
    const walk = new VatClip(clipOf(meta, 'walk'));
    const steps = 240;

    // The feet: the lowest vertices of the first frame.
    const first: { v: number; y: number }[] = [];
    for (let v = 0; v < meta.vertexCount; v += 1) {
      first.push({ v, y: character.at(v, walk.column)[1] });
    }
    first.sort((a, b) => a.y - b.y);
    const feet = first.slice(0, 80).map((entry) => entry.v);

    // World position of every tracked vertex at every step. Forward is -Z, so
    // a body that has covered `d` sits at z = -d.
    const world: number[][] = [];
    const height: number[][] = [];
    for (let step = 0; step < steps; step += 1) {
      const distance = (step / steps) * walk.travelPerCycle;
      const column = walk.column + walk.phaseFor(distance) * walk.frames;
      const z: number[] = [];
      const y: number[] = [];
      for (const v of feet) {
        const p = character.at(v, column);
        z.push(p[2] - distance);
        y.push(p[1]);
      }
      world.push(z);
      height.push(y);
    }

    const excursions: number[] = [];
    for (let k = 0; k < feet.length; k += 1) {
      let ground = Infinity;
      for (let step = 0; step < steps; step += 1) ground = Math.min(ground, height[step]?.[k] ?? 0);
      let run: number[] = [];
      const flush = (): void => {
        // A run must be a real footfall: at least a tenth of the loop, and
        // less than half of it, or it has merged two separate contacts.
        if (run.length >= steps * 0.08 && run.length <= steps * 0.45) {
          excursions.push(Math.max(...run) - Math.min(...run));
        }
        run = [];
      };
      for (let step = 0; step < steps; step += 1) {
        if ((height[step]?.[k] ?? 1) < ground + CONTACT_BAND) run.push(world[step]?.[k] ?? 0);
        else flush();
      }
      flush();
    }

    expect(excursions.length, 'no footfall was long enough to measure').toBeGreaterThan(4);
    excursions.sort((a, b) => a - b);
    const median = excursions[excursions.length >> 1] ?? 0;
    const worst = excursions[excursions.length - 1] ?? 0;
    // Rig units, where 1.0 is a body height. The procedural crowd measured
    // 0.162 median (283 mm) by the same definition, so these bounds are a
    // regression guard at roughly half that, not an aspiration: the shipped
    // characters measure 0.010 to 0.059 median.
    expect(median, `median slide ${(median * 1750).toFixed(0)} mm on a 1.75 m person`).toBeLessThan(
      0.07,
    );
    expect(worst, `worst slide ${(worst * 1750).toFixed(0)} mm on a 1.75 m person`).toBeLessThan(
      0.25,
    );
  });

  it('carries an idle clip that stands still', () => {
    const idle = clipOf(meta, 'idle');
    expect(idle.frames).toBeGreaterThan(8);
    expect(idle.duration).toBeGreaterThan(1);
    // An idle that travels would drag a standing pedestrian across the paving.
    expect(Math.abs(idle.travelPerCycle)).toBeLessThan(0.02);
  });

  it('actually animates rather than repeating one pose', () => {
    const walk = clipOf(meta, 'walk');
    let mostMoved = 0;
    for (let v = 0; v < meta.vertexCount; v += 1) {
      const a = character.at(v, walk.column);
      for (const fraction of [0.1, 0.25, 0.5]) {
        const b = character.at(v, walk.column + walk.frames * fraction);
        mostMoved = Math.max(mostMoved, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
      }
    }
    // A quarter of a body height is a swinging hand or a lifted foot; a bake
    // that lost its animation would sit far below this.
    expect(mostMoved).toBeGreaterThan(0.2);
  });

  it('loops without a jump', () => {
    const walk = clipOf(meta, 'walk');
    let worst = 0;
    for (let v = 0; v < meta.vertexCount; v += 7) {
      const a = character.at(v, walk.column);
      const b = character.at(v, walk.column + walk.frames);
      worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
    // The wrap column is a copy of the first frame, so this is exact bar the
    // half-float rounding.
    expect(worst).toBeLessThan(0.002);
  });
});

/**
 * The rosters, which are a RENDERING BUDGET as much as a cast list: each id a
 * system is given costs it one colour draw call and one shadow draw call, so a
 * single shared list of eleven characters would have cost the downtown street
 * twenty-two calls for people it never shows.
 */
describe('the rosters', () => {
  it('keeps each system inside its stated draw-call budget', () => {
    expect(CITY_VAT_IDS.length).toBeLessThanOrEqual(CITY_ROSTER_BUDGET);
    expect(TERMINAL_VAT_IDS.length).toBeLessThanOrEqual(TERMINAL_ROSTER_BUDGET);
    // A budget that is not doing anything is not a budget.
    expect(AIRPORT_VAT_IDS.length).toBeGreaterThan(0);
    expect(CITY_VAT_IDS.length).toBeGreaterThan(0);
    expect(TERMINAL_VAT_IDS.length).toBeGreaterThan(0);
  });

  it('gives the airport its own cast rather than the street crowd cast', () => {
    // The whole point of two lists. If the terminal ever falls back to the
    // city's characters it is because the airport roster is short, not because
    // the split stopped working.
    for (const id of AIRPORT_VAT_IDS.slice(0, TERMINAL_ROSTER_BUDGET)) {
      expect(TERMINAL_VAT_IDS).toContain(id);
    }
    expect(new Set(TERMINAL_VAT_IDS).size).toBe(TERMINAL_VAT_IDS.length);
    expect(new Set(CITY_VAT_IDS).size).toBe(CITY_VAT_IDS.length);
  });

  it('ships a file for every id on every roster', () => {
    for (const id of [...CITY_VAT_IDS, ...AIRPORT_VAT_IDS]) {
      const meta = JSON.parse(readFileSync(`${BASE}/${id}.json`, 'utf8')) as Meta;
      expect(meta.id, `${id}.json disagrees about its own id`).toBe(id);
      expect(meta.version).toBe(1);
    }
  });

  it('keeps every roster character inside the foot-slide gate', () => {
    // `loadPedestrianVat` REFUSES a bake over this, so a character that failed
    // here would silently leave the crowd a face short in the browser.
    for (const id of [...CITY_VAT_IDS, ...AIRPORT_VAT_IDS]) {
      const meta = JSON.parse(readFileSync(`${BASE}/${id}.json`, 'utf8')) as Meta;
      const walk = meta.clips.find((clip) => clip.name === 'walk');
      expect(walk, `${id} has no walk`).toBeTruthy();
      expect(
        (walk as Clip).slip,
        `${id} slides ${(walk as Clip).slip.toFixed(3)} rig units`,
      ).toBeLessThanOrEqual(MAX_WALK_SLIP);
    }
  });

  it('gives the airport cast a hand to carry a bag with', () => {
    // The four street characters were baked before the tool recorded a hand
    // track; the airport ones were not, which is what lets a holdall hang off
    // the hand that is holding it. Read straight out of the shipped files.
    for (const id of AIRPORT_VAT_IDS) {
      const raw = JSON.parse(readFileSync(`${BASE}/${id}.json`, 'utf8')) as {
        clips: { name: string; hand?: unknown }[];
      };
      const walk = raw.clips.find((clip) => clip.name === 'walk');
      expect(walk?.hand, `${id} carries no hand track`).toBeTruthy();
    }
  });

  it('states a plausible stature for every airport character', () => {
    for (const id of AIRPORT_VAT_IDS) {
      const stature = VAT_STATURE[id];
      expect(stature, `${id} has no stature`).toBeGreaterThan(0);
      // Inside the crowd's own 1.54-1.92 m band: the roster correlates height
      // with the mesh, it does not widen the range.
      expect(stature).toBeGreaterThanOrEqual(1.54);
      expect(stature as number).toBeLessThanOrEqual(1.92);
    }
    // And they are not all the same person.
    const spread = AIRPORT_VAT_IDS.map((id) => VAT_STATURE[id] ?? 0);
    expect(Math.max(...spread) - Math.min(...spread)).toBeGreaterThan(0.2);
  });
});
