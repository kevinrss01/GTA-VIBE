/**
 * District lookup on the ground the player actually walks on.
 *
 * `blockAt` only answers inside a block rectangle, and every carriageway and
 * pavement in the city falls BETWEEN blocks. Callers used to default that null
 * to a fixed district, so most of the map reported `harbourside` - which is how
 * the sea ambience ended up at full level on the east ridge, 370 m inland.
 */

import { describe, expect, it } from 'vitest';

import { CityGround } from '../src/world/CityGround';
import { corridorHalfWidth, getCityPlan } from '../src/world/CityPlan';

const plan = getCityPlan();
const ground = new CityGround(plan);

describe('districtAt', () => {
  it('agrees with blockAt wherever blockAt has an answer', () => {
    let checked = 0;
    for (const block of plan.blocks) {
      const x = (block.rect.minX + block.rect.maxX) / 2;
      const z = (block.rect.minZ + block.rect.maxZ) / 2;
      const inside = ground.blockAt(x, z);
      if (!inside) continue;
      checked += 1;
      expect(ground.districtAt(x, z)).toBe(inside.district);
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('answers on street corridors, where blockAt returns null', () => {
    let nullBlocks = 0;
    const districts = new Set<string>();
    for (const street of plan.streets) {
      const half = corridorHalfWidth(street);
      for (let t = 0.1; t < 0.95; t += 0.1) {
        const along = street.from + (street.to - street.from) * t;
        // Sit on the carriageway centreline, which is never inside a block.
        const x = street.axis === 'x' ? street.position : along;
        const z = street.axis === 'x' ? along : street.position;
        void half;
        if (ground.blockAt(x, z) === null) nullBlocks += 1;
        districts.add(ground.districtAt(x, z));
      }
    }
    // The premise: streets really are outside every block.
    expect(nullBlocks).toBeGreaterThan(50);
    // The fix: they no longer all collapse onto one district.
    expect(districts.size, `streets reported only: ${[...districts].join(', ')}`).toBeGreaterThanOrEqual(4);
  });

  it('reports the far inland districts as themselves, never the waterfront', () => {
    // The east ridge and the central park are the two places the old default
    // was most obviously wrong, because they are as far from the bay as the
    // map allows.
    expect(ground.districtAt(150, 40)).not.toBe('harbourside');
    expect(ground.districtAt(120, 60)).not.toBe('harbourside');
  });

  it('is stable and cheap to call every frame', () => {
    // Memoised on a coarse cell: repeated calls at the same spot agree, and
    // walking a metre never flips the answer back and forth.
    const first = ground.districtAt(20, -40);
    for (let i = 0; i < 50; i += 1) expect(ground.districtAt(20, -40)).toBe(first);
    let flips = 0;
    let previous = ground.districtAt(-200, 0);
    for (let x = -200; x < 200; x += 1) {
      const now = ground.districtAt(x, 0);
      if (now !== previous) flips += 1;
      previous = now;
    }
    // A 400 m west-east walk crosses a handful of districts, not dozens.
    expect(flips).toBeLessThan(12);
  });
});
