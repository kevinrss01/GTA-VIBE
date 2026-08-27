/**
 * What the counter draws as bars.
 *
 * The shop used to print `Damage 34 · Range 90 m · Magazine 25 · 540 rpm` and
 * expect the player to hold four numbers in their head and compare them
 * against three other rows of four numbers. A bar answers the only question
 * that is actually being asked - "is this one better than that one?" - without
 * any arithmetic at all.
 *
 * ## The bars are relative, and honestly so
 *
 * Every fraction is the weapon's own value over the BEST value in the whole
 * catalogue for that stat, so a full bar means "nothing here beats this" and
 * nothing is rescaled to flatter anything. Every weapon wins at least one row,
 * which is the shape of the armoury rather than a decision taken here: the
 * Sweeper hits hardest, the SMG shoots fastest and holds most, the Sidearm is
 * tightest, the Carbine reaches furthest, and the Breaker is the only thing in
 * the shop with a blast radius at all.
 *
 * The printed value beside each bar is the real quantity in its real unit -
 * the bar is the comparison, the number is the fact - so nothing about the
 * normalisation can mislead a player who reads carefully.
 *
 * No DOM and no Three.js: this is arithmetic over `WEAPONS`, and it is tested
 * as arithmetic.
 */

import { ALL_WEAPONS, WEAPONS, type WeaponId, type WeaponSpec } from '../player/PlayerState';

export type WeaponBarKey = 'damage' | 'fireRate' | 'accuracy' | 'range' | 'magazine' | 'blast';

export interface WeaponBar {
  readonly key: WeaponBarKey;
  readonly label: string;
  /** 0..1 against the best weapon in the catalogue for this stat. */
  readonly fraction: number;
  /** The real quantity, in its real unit, for the player to read. */
  readonly value: string;
}

/**
 * Damage counted per TRIGGER PULL, not per projectile.
 *
 * A shotgun shell is eight pellets of 13, and a bar that read 13 next to the
 * carbine's 34 would tell the player the exact opposite of what happens when
 * the two are fired at somebody.
 */
export function damagePerShot(spec: WeaponSpec): number {
  return spec.damage * spec.pellets;
}

/**
 * Accuracy as the reciprocal of the muzzle cone, so more is better.
 *
 * `spreadRad` is a half-angle, so it is already the right quantity; it just
 * points the wrong way for a bar.
 */
export function accuracyScore(spec: WeaponSpec): number {
  return 1 / Math.max(spec.spreadRad, 1e-6);
}

/** A bar of zero width is a rendering bug to look at. Keep a visible stub. */
const MIN_FRACTION = 0.05;

interface Row {
  readonly key: WeaponBarKey;
  readonly label: string;
  readonly measure: (spec: WeaponSpec) => number;
  readonly format: (spec: WeaponSpec) => string;
}

const ROWS: readonly Row[] = [
  {
    key: 'damage',
    label: 'Damage',
    measure: damagePerShot,
    // `13 × 8` says "a shell, not a bullet" in four characters.
    format: (spec) => (spec.pellets > 1 ? `${spec.damage} × ${spec.pellets}` : `${spec.damage}`),
  },
  {
    key: 'fireRate',
    label: 'Fire rate',
    measure: (spec) => spec.roundsPerMinute,
    format: (spec) => `${spec.roundsPerMinute} rpm`,
  },
  {
    key: 'accuracy',
    label: 'Accuracy',
    measure: accuracyScore,
    // Degrees, because a player can picture a cone and cannot picture a radian.
    format: (spec) => `±${((spec.spreadRad * 180) / Math.PI).toFixed(1)}°`,
  },
  {
    key: 'range',
    label: 'Range',
    measure: (spec) => spec.rangeM,
    format: (spec) => `${spec.rangeM} m`,
  },
  {
    key: 'magazine',
    label: 'Magazine',
    measure: (spec) => spec.magazine,
    format: (spec) => `${spec.magazine}`,
  },
  /*
   * The row that exists so the launcher can be compared honestly.
   *
   * Without it a rocket has to be judged on damage-per-shot and range, where
   * it looks like a slightly odd rifle; the thing it actually does - kill
   * everything inside nine and a half metres of where it lands - has nowhere
   * to appear at all. A firearm reads a dash rather than a zero, because zero
   * blast radius is not a small amount of blast, it is a different weapon.
   */
  {
    key: 'blast',
    label: 'Blast',
    measure: (spec) => spec.blastRadius ?? 0,
    format: (spec) => (spec.blastRadius ? `${spec.blastRadius} m` : '—'),
  },
];

/** The best value in the catalogue for each row, computed once. */
const BEST: Readonly<Record<WeaponBarKey, number>> = (() => {
  const out = {} as Record<WeaponBarKey, number>;
  for (const row of ROWS) {
    let best = 0;
    for (const id of ALL_WEAPONS) best = Math.max(best, row.measure(WEAPONS[id]));
    out[row.key] = best;
  }
  return out;
})();

/** The bars for one weapon, in the order they are drawn. */
export function weaponBars(id: WeaponId): readonly WeaponBar[] {
  const spec = WEAPONS[id];
  return ROWS.map((row) => {
    const best = BEST[row.key];
    const raw = best > 0 ? row.measure(spec) / best : 0;
    return {
      key: row.key,
      label: row.label,
      fraction: Math.min(1, Math.max(MIN_FRACTION, raw)),
      value: row.format(spec),
    };
  });
}

/** The order of the bars, for anything that needs to lay out empty rows first. */
export const WEAPON_BAR_KEYS: readonly WeaponBarKey[] = ROWS.map((row) => row.key);
