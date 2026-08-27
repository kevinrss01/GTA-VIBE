/**
 * Deterministic pseudo-random numbers.
 *
 * The whole world is generated from a single seed so that the layout is stable
 * across reloads, testable without a renderer, and identical for every player.
 * `Math.random` is never used in world generation.
 */

export interface Rng {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform float in [min, max). */
  range(min: number, max: number): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** True with the given probability. */
  chance(probability: number): boolean;
  /** Uniformly picks one element. Throws on an empty list. */
  pick<T>(items: readonly T[]): T;
  /** Picks one element using non-negative weights parallel to `items`. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** Returns a shuffled copy (Fisher-Yates). */
  shuffle<T>(items: readonly T[]): T[];
}

/** Hashes a string into a 32-bit seed so callers can use readable seed names. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * mulberry32: small, fast, and good enough for content generation.
 * Chosen over a crypto generator because reproducibility and speed matter here
 * and statistical quality beyond visual variety does not.
 */
export function createRng(seed: number | string): Rng {
  let state = (typeof seed === 'string' ? hashSeed(seed) : seed >>> 0) || 0x9e3779b9;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    range: (min, max) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (probability) => next() < probability,
    pick: (items) => {
      if (items.length === 0) throw new Error('rng.pick: empty list');
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    weighted: (items, weights) => {
      if (items.length === 0) throw new Error('rng.weighted: empty list');
      if (items.length !== weights.length) throw new Error('rng.weighted: length mismatch');
      let total = 0;
      for (const w of weights) total += Math.max(0, w);
      if (total <= 0) return items[0] as (typeof items)[number];
      let roll = next() * total;
      for (let i = 0; i < items.length; i += 1) {
        roll -= Math.max(0, weights[i] ?? 0);
        if (roll <= 0) return items[i] as (typeof items)[number];
      }
      return items[items.length - 1] as (typeof items)[number];
    },
    shuffle: (items) => {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const a = out[i] as (typeof out)[number];
        const b = out[j] as (typeof out)[number];
        out[i] = b;
        out[j] = a;
      }
      return out;
    },
  };

  return rng;
}

/**
 * Stable 2D value hash in [0, 1). Used where a value must depend only on a world
 * position (per-window jitter, per-tile wear) and stay identical no matter what
 * order geometry happens to be built in.
 */
export function hash2(x: number, y: number, salt = 0): number {
  let h = Math.imul(Math.round(x * 8192) ^ 0x27d4eb2d, 0x165667b1);
  h ^= Math.imul(Math.round(y * 8192) ^ 0x9e3779b9, 0x85ebca6b);
  h ^= Math.imul(salt + 0x7feb352d, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
