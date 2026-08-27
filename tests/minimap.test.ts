/**
 * Minimap geometry.
 *
 * The minimap does its real work on a canvas, which is not available here, so
 * the projection, the map bounds and the field-of-view wedge are written as
 * pure functions and tested directly. What these assertions defend is the part
 * that silently goes wrong: an axis sign flip, a bound that clips part of the
 * city off the map, or a wedge that points behind the player.
 */

import { describe, expect, it } from 'vitest';

import { getCityPlan } from '../src/world/CityPlan';
import {
  districtAnchors,
  enterableParcels,
  fovWedgePoints,
  headingVector,
  labelledStreets,
  mapBoundsFor,
  MINIMAP_PALETTE,
  streetExtent,
  STATIC_SCALE,
  worldToMap,
  type MapPoint,
} from '../src/ui/Minimap';

const plan = getCityPlan();
const bounds = mapBoundsFor(plan);

function inside(point: MapPoint, width: number, height: number): boolean {
  return point.x >= 0 && point.y >= 0 && point.x <= width && point.y <= height;
}

describe('world to map projection', () => {
  it('puts a known world point at the expected pixel', () => {
    const origin = worldToMap(bounds.minX, bounds.minZ, bounds, 2);
    expect(origin.x).toBeCloseTo(0, 6);
    expect(origin.y).toBeCloseTo(0, 6);

    const offset = worldToMap(bounds.minX + 10, bounds.minZ + 4, bounds, 2);
    expect(offset.x).toBeCloseTo(20, 6);
    expect(offset.y).toBeCloseTo(8, 6);

    const corner = worldToMap(bounds.maxX, bounds.maxZ, bounds, 2);
    expect(corner.x).toBeCloseTo(bounds.width * 2, 6);
    expect(corner.y).toBeCloseTo(bounds.depth * 2, 6);
  });

  it('runs +X right and +Z down, monotonically in both axes', () => {
    const base = worldToMap(0, 0, bounds);
    const east = worldToMap(25, 0, bounds);
    const south = worldToMap(0, 25, bounds);

    // +X is east and must move right; +Z is south and must move DOWN a north-up map.
    expect(east.x).toBeGreaterThan(base.x);
    expect(east.y).toBeCloseTo(base.y, 6);
    expect(south.y).toBeGreaterThan(base.y);
    expect(south.x).toBeCloseTo(base.x, 6);

    let previousX = -Infinity;
    let previousY = -Infinity;
    for (let step = -200; step <= 160; step += 10) {
      const point = worldToMap(step, step, bounds);
      expect(point.x).toBeGreaterThan(previousX);
      expect(point.y).toBeGreaterThan(previousY);
      previousX = point.x;
      previousY = point.y;
    }
  });

  it('scales linearly, so a metre is the same size everywhere on the map', () => {
    const a = worldToMap(-40, 12, bounds, STATIC_SCALE);
    const b = worldToMap(-30, 12, bounds, STATIC_SCALE);
    const c = worldToMap(120, 12, bounds, STATIC_SCALE);
    const d = worldToMap(130, 12, bounds, STATIC_SCALE);
    expect(b.x - a.x).toBeCloseTo(d.x - c.x, 6);
    expect(b.x - a.x).toBeCloseTo(10 * STATIC_SCALE, 6);
  });
});

describe('map bounds', () => {
  const width = bounds.width * STATIC_SCALE;
  const height = bounds.depth * STATIC_SCALE;

  it('covers every street corridor', () => {
    expect(plan.streets.length).toBeGreaterThan(0);
    for (const street of plan.streets) {
      const rect = streetExtent(street);
      const a = worldToMap(rect.minX, rect.minZ, bounds);
      const b = worldToMap(rect.maxX, rect.maxZ, bounds);
      expect(inside(a, width, height), `${street.id} starts off the map`).toBe(true);
      expect(inside(b, width, height), `${street.id} runs off the map`).toBe(true);
    }
  });

  it('covers every building footprint and block', () => {
    expect(plan.parcels.length).toBeGreaterThan(0);
    for (const parcel of plan.parcels) {
      const a = worldToMap(parcel.rect.minX, parcel.rect.minZ, bounds);
      const b = worldToMap(parcel.rect.maxX, parcel.rect.maxZ, bounds);
      expect(inside(a, width, height), `${parcel.id} falls off the map`).toBe(true);
      expect(inside(b, width, height), `${parcel.id} falls off the map`).toBe(true);
    }
    for (const block of plan.blocks) {
      const a = worldToMap(block.rect.minX, block.rect.minZ, bounds);
      const b = worldToMap(block.rect.maxX, block.rect.maxZ, bounds);
      expect(inside(a, width, height), `${block.id} falls off the map`).toBe(true);
      expect(inside(b, width, height), `${block.id} falls off the map`).toBe(true);
    }
  });

  it('covers every landmark and the spawn point', () => {
    for (const landmark of plan.landmarks) {
      const point = worldToMap(landmark.x, landmark.z, bounds);
      expect(inside(point, width, height), `${landmark.id} falls off the map`).toBe(true);
    }
    const spawn = worldToMap(plan.spawn.x, plan.spawn.z, bounds);
    expect(inside(spawn, width, height)).toBe(true);
  });

  it('keeps a margin of open ground around the built city', () => {
    let minX = Infinity;
    let maxX = -Infinity;
    for (const parcel of plan.parcels) {
      minX = Math.min(minX, parcel.rect.minX);
      maxX = Math.max(maxX, parcel.rect.maxX);
    }
    expect(bounds.minX).toBeLessThan(minX);
    expect(bounds.maxX).toBeGreaterThan(maxX);
    expect(bounds.width).toBeGreaterThan(0);
    expect(bounds.depth).toBeGreaterThan(0);
  });
});

describe('viewing direction', () => {
  // Yaw convention: forward is (-sin yaw, 0, -cos yaw), so yaw 0 faces north (-Z),
  // which on a north-up map is straight up the screen.
  const yaws = [0, Math.PI / 6, Math.PI / 2, 2.4, Math.PI, -Math.PI / 3, 5.9, -2.2];

  it('heads the way the camera looks', () => {
    for (const yaw of yaws) {
      const heading = headingVector(yaw);
      expect(heading.x).toBeCloseTo(-Math.sin(yaw), 10);
      expect(heading.y).toBeCloseTo(-Math.cos(yaw), 10);
      expect(Math.hypot(heading.x, heading.y)).toBeCloseTo(1, 10);
    }
    // Yaw 0 looks north: up the map, not down it.
    expect(headingVector(0).y).toBeLessThan(0);
    // Yaw -PI/2 looks east: to the right.
    expect(headingVector(-Math.PI / 2).x).toBeGreaterThan(0);
  });

  it('sweeps the field-of-view wedge around the facing direction', () => {
    const radius = 40;
    for (const yaw of yaws) {
      const points = fovWedgePoints(yaw, radius);
      expect(points.length).toBeGreaterThan(4);

      const apex = points[0];
      expect(apex).toBeDefined();
      expect(apex?.x).toBe(0);
      expect(apex?.y).toBe(0);

      const arc = points.slice(1);
      let sumX = 0;
      let sumY = 0;
      for (const point of arc) {
        sumX += point.x;
        sumY += point.y;
        expect(Math.hypot(point.x, point.y)).toBeCloseTo(radius, 6);
      }
      const length = Math.hypot(sumX, sumY);
      expect(length).toBeGreaterThan(0);

      const expected = headingVector(yaw);
      expect(sumX / length).toBeCloseTo(expected.x, 6);
      expect(sumY / length).toBeCloseTo(expected.y, 6);

      // Every point on the arc lies inside half the field of view of the heading.
      const halfFov = (70 / 2 / 180) * Math.PI;
      for (const point of arc) {
        const dot = (point.x * expected.x + point.y * expected.y) / radius;
        expect(Math.acos(Math.min(1, Math.max(-1, dot)))).toBeLessThanOrEqual(halfFov + 1e-9);
      }
    }
  });

  it('opens the wedge to the requested angle', () => {
    const points = fovWedgePoints(0, 10, 70);
    const first = points[1];
    const last = points[points.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    if (!first || !last) return;
    const angle = Math.acos((first.x * last.x + first.y * last.y) / 100);
    expect((angle * 180) / Math.PI).toBeCloseTo(70, 4);
  });
});

describe('map contents', () => {
  it('collects the enterable buildings', () => {
    const enterable = enterableParcels(plan);
    expect(enterable.length).toBeGreaterThan(4);
    for (const parcel of enterable) {
      expect(parcel.enterable).toBe(true);
      expect(parcel.interiorKind).not.toBeNull();
    }
    // Enterable parcels are a distinct subset, not the whole building stock.
    expect(enterable.length).toBeLessThan(plan.parcels.length);
  });

  it('labels the arterials and every district', () => {
    const streets = labelledStreets(plan);
    expect(streets.length).toBeGreaterThanOrEqual(3);
    for (const street of streets) {
      expect(street.name.length).toBeGreaterThan(0);
    }
    const anchors = districtAnchors(plan);
    expect(anchors.length).toBe(new Set(plan.blocks.map((b) => b.district)).size);
    for (const anchor of anchors) {
      const point = worldToMap(anchor.x, anchor.z, bounds);
      expect(inside(point, bounds.width * STATIC_SCALE, bounds.depth * STATIC_SCALE)).toBe(true);
    }
  });

  it('gives a street corridor its full width, pavements included', () => {
    const promenade = plan.streets.find((street) => street.id === 'harbour-walk');
    expect(promenade).toBeDefined();
    if (!promenade) return;
    const rect = streetExtent(promenade);
    expect(rect.maxX - rect.minX).toBeCloseTo(
      (promenade.roadHalf + promenade.sidewalk) * 2,
      6,
    );
    expect(rect.minZ).toBe(promenade.from);
    expect(rect.maxZ).toBe(promenade.to);
  });
});

describe('palette', () => {
  it('gives each kind of ground its own colour', () => {
    const keys = ['road', 'building', 'park', 'water', 'enterable'] as const;
    const values = keys.map((key) => MINIMAP_PALETTE[key]);
    for (const value of values) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(new Set(values).size).toBe(keys.length);
  });

  it('keeps the accent warm and everything else desaturated', () => {
    const channels = (hex: string): [number, number, number] => [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
    const spread = (hex: string): number => {
      const [r, g, b] = channels(hex);
      return Math.max(r, g, b) - Math.min(r, g, b);
    };
    // The one warm note on the map is the buildings the player can walk into.
    expect(spread(MINIMAP_PALETTE.enterable)).toBeGreaterThan(40);
    for (const key of ['road', 'building', 'water', 'block', 'land', 'park'] as const) {
      expect(spread(MINIMAP_PALETTE[key]), `${key} is too saturated`).toBeLessThan(30);
    }
  });
});
