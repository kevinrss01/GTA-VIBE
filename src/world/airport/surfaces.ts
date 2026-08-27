/**
 * Paving and markings for Meridian Bay Regional.
 *
 * Everything in here is a flat quad on the platform, so it shares one rule with
 * `StreetBuilder`: the surface is drawn at `landElevation(x, z)` and markings
 * sit `MARKING_LIFT` above it. Inside `AIRFIELD` that height is exactly
 * `AIRFIELD_LEVEL`, so the runway is level to the last decimal place rather
 * than to a tolerance.
 *
 * ## Where the marking dimensions come from
 *
 * ICAO Annex 14 Volume I chapter 5 and FAA AC 150/5340-1M, not from eyeballing
 * a satellite photo. Threshold bars are 1.8 m wide at 1.8 m centres with a
 * 3.6 m gap on the centreline; the runway centreline is 30 m painted with a
 * 20 m gap; taxiway centreline is a continuous 0.15 m yellow line; a
 * holding position is pattern A - two solid lines on the taxiway side, two
 * dashed on the runway side, 0.15 m wide at 0.15 m spacing.
 *
 * Two things are deliberately not to standard, and both are consequences of a
 * 600 m runway:
 *
 *  - A runway this short carries no touchdown zone at all in the real world.
 *    One pair of bars is drawn at 75 m from each threshold anyway, because the
 *    touchdown zone is the marking that says "put the wheels here" and without
 *    it a 45 m ribbon of concrete reads as a very wide road.
 *  - The aiming point sits at 150 m from each threshold, which IS the standard
 *    distance for a runway under 800 m, but the two of them are then only
 *    300 m apart rather than the usual single pair.
 */

import type { MaterialKey } from '../../render/materials';
import { SurfaceBuffer } from '../build/StreetBuilder';
import { corridorHalfWidth, type CityPlan, type Street } from '../CityPlan';
import type { GeometrySink } from '../build/types';
import {
  AIRFIELD_LEVEL,
  APRON,
  CAR_PARK,
  FORECOURT,
  RUNWAY,
  STANDS,
  TAXIWAY,
  TAXIWAY_LINKS,
  type AirportRect,
} from './layout';
import { BAY_WIDTH, MARKINGS, PARKING_ROWS, SOUTH_APRON, TERMINAL_PAD } from './plan';

/** Markings sit this far above the pavement, matching `StreetBuilder`. */
export const MARKING_LIFT = 0.012;

/** Largest quad the paving is broken into. */
const PAVING_STEP = 24;

/** A rectangle in plan, with the material it is paved in. */
interface PavedRect {
  readonly rect: AirportRect;
  readonly key: MaterialKey;
}

/**
 * Every square metre the airport paves, in the order it is laid.
 *
 * The runway, its overruns, the taxiway and its links are built from
 * `layout.ts` rather than restated, so a change to the survey moves the
 * concrete with it.
 */
export function pavedRects(): PavedRect[] {
  const out: PavedRect[] = [];
  const concrete = (rect: AirportRect): void => {
    out.push({ rect, key: 'concrete' });
  };

  // Runway, including both paved overruns.
  concrete({
    minX: RUNWAY.centreX - RUNWAY.halfWidth,
    maxX: RUNWAY.centreX + RUNWAY.halfWidth,
    minZ: RUNWAY.northZ - RUNWAY.overrun,
    maxZ: RUNWAY.southZ + RUNWAY.overrun,
  });
  // Parallel taxiway and the three links across to the runway.
  concrete({
    minX: TAXIWAY.centreX - TAXIWAY.halfWidth,
    maxX: TAXIWAY.centreX + TAXIWAY.halfWidth,
    minZ: TAXIWAY.fromZ,
    maxZ: TAXIWAY.toZ,
  });
  for (const z of TAXIWAY_LINKS) {
    concrete({
      minX: TAXIWAY.centreX,
      maxX: RUNWAY.centreX + RUNWAY.halfWidth,
      minZ: z - TAXIWAY.halfWidth,
      maxZ: z + TAXIWAY.halfWidth,
    });
  }
  concrete(APRON);
  concrete(SOUTH_APRON);
  concrete(TERMINAL_PAD);
  out.push({ rect: FORECOURT, key: 'pavement' });
  out.push({ rect: CAR_PARK, key: 'asphalt' });
  return out;
}

// ---------------------------------------------------------------------------
// Paving
// ---------------------------------------------------------------------------

/** Corridor of a street in plan, for clipping the paving out from under it. */
function corridorRect(street: Street): AirportRect {
  const half = corridorHalfWidth(street);
  return street.axis === 'x'
    ? { minX: street.position - half, maxX: street.position + half, minZ: street.from, maxZ: street.to }
    : { minX: street.from, maxX: street.to, minZ: street.position - half, maxZ: street.position + half };
}

function intersects(a: AirportRect, b: AirportRect): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
}

function contains(rect: AirportRect, x: number, z: number): boolean {
  return x >= rect.minX && x <= rect.maxX && z >= rect.minZ && z <= rect.maxZ;
}

/**
 * Cut lines across a span: the span's own ends, every edge of anything that
 * has to be clipped out of it, and enough intermediate lines that no quad is
 * longer than `step`.
 */
function breaks(from: number, to: number, edges: readonly number[], step: number): number[] {
  const set = new Set<number>([from, to]);
  for (const edge of edges) if (edge > from + 0.001 && edge < to - 0.001) set.add(edge);
  const sorted = [...set].sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i] as number;
    const b = sorted[i + 1] as number;
    const parts = Math.max(1, Math.ceil((b - a) / step));
    for (let k = 0; k < parts; k += 1) out.push(a + ((b - a) * k) / parts);
  }
  out.push(sorted[sorted.length - 1] as number);
  return out;
}

/**
 * Lays one paved rectangle, leaving out anything already drawn by a street.
 *
 * The landside roads are ordinary `Street` records, so `buildStreet` and
 * `buildIntersections` have already paved their corridors. Drawing over them
 * would put two coplanar surfaces in the same place - the z-fighting the city's
 * own intersection rule exists to avoid - so the grid is broken exactly on the
 * corridor edges and any cell whose centre falls inside one is skipped.
 */
function pavePaved(buffer: SurfaceBuffer, paved: PavedRect, corridors: readonly AirportRect[]): void {
  const hits = corridors.filter((c) => intersects(c, paved.rect));
  const xEdges: number[] = [];
  const zEdges: number[] = [];
  for (const c of hits) {
    xEdges.push(c.minX, c.maxX);
    zEdges.push(c.minZ, c.maxZ);
  }
  const xs = breaks(paved.rect.minX, paved.rect.maxX, xEdges, PAVING_STEP);
  const zs = breaks(paved.rect.minZ, paved.rect.maxZ, zEdges, PAVING_STEP);

  for (let i = 0; i < xs.length - 1; i += 1) {
    for (let j = 0; j < zs.length - 1; j += 1) {
      const x0 = xs[i] as number;
      const x1 = xs[i + 1] as number;
      const z0 = zs[j] as number;
      const z1 = zs[j + 1] as number;
      if (x1 - x0 < 0.01 || z1 - z0 < 0.01) continue;
      const cx = (x0 + x1) * 0.5;
      const cz = (z0 + z1) * 0.5;
      if (hits.some((c) => contains(c, cx, cz))) continue;
      buffer.top(paved.key, x0, z0, x1, z1, 0);
    }
  }
}

/**
 * All of the airport's paving.
 *
 * Emitted in 192 m tiles rather than as one geometry per material. `WorldSink`
 * buckets geometry into a chunk by its bounding-box CENTRE, so a single quad
 * spanning the 750 m runway would land in one chunk and be submitted whenever
 * that chunk is - and, worse, would keep the whole airfield alive whenever any
 * part of it is in range. Tiling matches the chunk grid so each piece is culled
 * with the ground it sits on.
 */
export function buildAirportPaving(plan: CityPlan, sink: GeometrySink): void {
  const corridors = plan.streets.map(corridorRect);
  const rects = pavedRects();

  const TILE = 192;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const { rect } of rects) {
    minX = Math.min(minX, rect.minX);
    maxX = Math.max(maxX, rect.maxX);
    minZ = Math.min(minZ, rect.minZ);
    maxZ = Math.max(maxZ, rect.maxZ);
  }

  for (let tx = Math.floor(minX / TILE); tx <= Math.floor(maxX / TILE); tx += 1) {
    for (let tz = Math.floor(minZ / TILE); tz <= Math.floor(maxZ / TILE); tz += 1) {
      const tile: AirportRect = {
        minX: tx * TILE,
        maxX: (tx + 1) * TILE,
        minZ: tz * TILE,
        maxZ: (tz + 1) * TILE,
      };
      const buffer = new SurfaceBuffer();
      let any = false;
      for (const paved of rects) {
        if (!intersects(paved.rect, tile)) continue;
        const clipped: AirportRect = {
          minX: Math.max(paved.rect.minX, tile.minX),
          maxX: Math.min(paved.rect.maxX, tile.maxX),
          minZ: Math.max(paved.rect.minZ, tile.minZ),
          maxZ: Math.min(paved.rect.maxZ, tile.maxZ),
        };
        pavePaved(buffer, { rect: clipped, key: paved.key }, corridors);
        any = true;
      }
      if (any) buffer.flush(sink);
    }
  }
}

// ---------------------------------------------------------------------------
// Marking primitives
// ---------------------------------------------------------------------------

/** A painted rectangle, centred on (x, z). */
function paint(
  buffer: SurfaceBuffer,
  key: MaterialKey,
  x: number,
  z: number,
  halfX: number,
  halfZ: number,
): void {
  buffer.top(key, x - halfX, z - halfZ, x + halfX, z + halfZ, MARKING_LIFT);
}

/**
 * A stroke between two points, as a chain of short quads.
 *
 * Used for the taxiway centreline, which has to turn corners: a swept line of
 * segments takes a fillet radius without any curve machinery.
 */
function stroke(
  buffer: SurfaceBuffer,
  key: MaterialKey,
  points: readonly { x: number; z: number }[],
  width: number,
): void {
  const half = width * 0.5;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i] as { x: number; z: number };
    const b = points[i + 1] as { x: number; z: number };
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    // Axis-aligned runs are the common case and stay exact; a diagonal is
    // approximated by its bounding quad, which at 0.15 m wide is invisible.
    if (Math.abs(dz) < 1e-6) {
      buffer.top(key, Math.min(a.x, b.x), a.z - half, Math.max(a.x, b.x), a.z + half, MARKING_LIFT);
    } else if (Math.abs(dx) < 1e-6) {
      buffer.top(key, a.x - half, Math.min(a.z, b.z), a.x + half, Math.max(a.z, b.z), MARKING_LIFT);
    } else {
      const steps = Math.max(1, Math.ceil(length / 1.5));
      for (let k = 0; k < steps; k += 1) {
        const t0 = k / steps;
        const t1 = (k + 1) / steps;
        const x0 = a.x + dx * t0;
        const z0 = a.z + dz * t0;
        const x1 = a.x + dx * t1;
        const z1 = a.z + dz * t1;
        buffer.top(
          key,
          Math.min(x0, x1) - half,
          Math.min(z0, z1) - half,
          Math.max(x0, x1) + half,
          Math.max(z0, z1) + half,
          MARKING_LIFT,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Numerals
// ---------------------------------------------------------------------------

/**
 * Runway designator numerals, as seven-segment strokes.
 *
 * A real designator is drawn from a specified 20-point grid with rounded
 * terminals. At 12 m tall, read from the threshold, the difference between
 * that and seven segments is the corner radius; the digit shapes are the same,
 * and seven segments is four lines of code instead of four pages of outlines.
 */
const SEGMENTS: Readonly<Record<string, readonly number[]>> = {
  // Segment order: top, top-left, top-right, middle, bottom-left,
  // bottom-right, bottom.
  '0': [1, 1, 1, 0, 1, 1, 1],
  '1': [0, 0, 1, 0, 0, 1, 0],
  '2': [1, 0, 1, 1, 1, 0, 1],
  '3': [1, 0, 1, 1, 0, 1, 1],
  '4': [0, 1, 1, 1, 0, 1, 0],
  '5': [1, 1, 0, 1, 0, 1, 1],
  '6': [1, 1, 0, 1, 1, 1, 1],
  '7': [1, 0, 1, 0, 0, 1, 0],
  '8': [1, 1, 1, 1, 1, 1, 1],
  '9': [1, 1, 1, 1, 0, 1, 1],
};

/**
 * Paints one digit.
 *
 * `up` is +1 when the top of the digit points toward +Z and -1 when it points
 * toward -Z, which is how the same numeral reads correctly from either
 * threshold. `x` and `z` are the centre of the digit.
 */
function digit(
  buffer: SurfaceBuffer,
  char: string,
  x: number,
  z: number,
  height: number,
  up: 1 | -1,
): void {
  const on = SEGMENTS[char];
  if (!on) return;
  const width = height * 0.52;
  const t = height * 0.1;
  const hx = width * 0.5;
  const hz = height * 0.5;
  // Local frame: +u across the digit, +v up the digit.
  const at = (u: number, v: number, du: number, dv: number): void => {
    // Both axes flip together for the far threshold, which is a half turn
    // about the digit's own centre - what "reads from the other end" means.
    paint(buffer, 'roadPaint', x + u * up, z + v * up, du * 0.5, dv * 0.5);
  };
  const halfBar = hz - t;
  if (on[0]) at(0, hz - t * 0.5, width, t);
  if (on[1]) at(-hx + t * 0.5, hz * 0.5, t, halfBar);
  if (on[2]) at(hx - t * 0.5, hz * 0.5, t, halfBar);
  if (on[3]) at(0, 0, width, t);
  if (on[4]) at(-hx + t * 0.5, -hz * 0.5, t, halfBar);
  if (on[5]) at(hx - t * 0.5, -hz * 0.5, t, halfBar);
  if (on[6]) at(0, -hz + t * 0.5, width, t);
}

function designator(
  buffer: SurfaceBuffer,
  text: string,
  x: number,
  z: number,
  height: number,
  up: 1 | -1,
): void {
  const width = height * 0.52;
  const pitch = width * 1.35;
  const start = -((text.length - 1) * pitch) / 2;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;
    // Digits run left to right as the pilot reads them, which reverses with
    // the approach direction.
    digit(buffer, char, x + (start + i * pitch) * up, z, height, up);
  }
}

// ---------------------------------------------------------------------------
// Runway
// ---------------------------------------------------------------------------

function buildThreshold(buffer: SurfaceBuffer, z: number, into: 1 | -1): void {
  const m = MARKINGS;
  const half = m.thresholdBarWidth * 0.5;
  const barZ = z + into * (m.thresholdStandoff + m.thresholdBarLength * 0.5);
  // Six bars either side of a 3.6 m centreline gap: twelve in all, which is
  // the pattern for a 45 m runway.
  for (let k = 0; k < 6; k += 1) {
    const offset = m.thresholdBarGap + half + k * (m.thresholdBarWidth + m.thresholdBarGap);
    for (const side of [-1, 1] as const) {
      paint(
        buffer,
        'roadPaint',
        RUNWAY.centreX + side * offset,
        barZ,
        half,
        m.thresholdBarLength * 0.5,
      );
    }
  }
}

/** Yellow chevrons over a paved overrun: the surface is not for landing on. */
function buildOverrunChevrons(buffer: SurfaceBuffer, from: number, into: 1 | -1): void {
  const spacing = 15;
  const count = Math.floor(RUNWAY.overrun / spacing);
  for (let i = 0; i < count; i += 1) {
    const apex = from + into * (i * spacing + spacing * 0.5);
    for (const side of [-1, 1] as const) {
      stroke(
        buffer,
        'roadPaintYellow',
        [
          { x: RUNWAY.centreX, z: apex },
          { x: RUNWAY.centreX + side * (RUNWAY.halfWidth - 1.5), z: apex + into * 7 },
        ],
        0.9,
      );
    }
  }
}

export function buildRunwayMarkings(sink: GeometrySink): void {
  const buffer = new SurfaceBuffer();
  const m = MARKINGS;

  // Side stripes, full length between the thresholds.
  for (const side of [-1, 1] as const) {
    paint(
      buffer,
      'roadPaint',
      RUNWAY.centreX + side * (RUNWAY.halfWidth - m.edgeInset - m.edgeWidth * 0.5),
      (RUNWAY.northZ + RUNWAY.southZ) * 0.5,
      m.edgeWidth * 0.5,
      (RUNWAY.southZ - RUNWAY.northZ) * 0.5,
    );
  }

  // Centreline: 30 m painted, 20 m gap, laid symmetrically about the midpoint.
  const mid = (RUNWAY.northZ + RUNWAY.southZ) * 0.5;
  const pitch = m.centrelineStripe + m.centrelineGap;
  for (let k = -6; k <= 6; k += 1) {
    const centre = mid + k * pitch;
    const from = Math.max(RUNWAY.northZ + 12, centre - m.centrelineStripe * 0.5);
    const to = Math.min(RUNWAY.southZ - 12, centre + m.centrelineStripe * 0.5);
    if (to - from < 1) continue;
    paint(buffer, 'roadPaint', RUNWAY.centreX, (from + to) * 0.5, m.centrelineWidth * 0.5, (to - from) * 0.5);
  }

  for (const [z, into] of [
    [RUNWAY.northZ, 1],
    [RUNWAY.southZ, -1],
  ] as const) {
    buildThreshold(buffer, z, into);
    // Designator, then the touchdown zone, then the aiming point.
    designator(
      buffer,
      z === RUNWAY.northZ ? '18' : '36',
      RUNWAY.centreX,
      z + into * m.designatorOffset,
      m.designatorHeight,
      into,
    );
    for (const side of [-1, 1] as const) {
      for (const inner of [4.5, 4.5 + m.touchdownSpacing + m.touchdownWidth] as const) {
        paint(
          buffer,
          'roadPaint',
          RUNWAY.centreX + side * (inner + m.touchdownWidth * 0.5),
          z + into * m.touchdownOffset,
          m.touchdownWidth * 0.5,
          m.touchdownLength * 0.5,
        );
      }
      paint(
        buffer,
        'roadPaint',
        RUNWAY.centreX + side * (m.aimingSpacing + m.aimingWidth * 0.5),
        z + into * m.aimingOffset,
        m.aimingWidth * 0.5,
        m.aimingLength * 0.5,
      );
    }
    buildOverrunChevrons(buffer, z, -into as 1 | -1);
  }

  buffer.flush(sink);
}

// ---------------------------------------------------------------------------
// Taxiway and apron
// ---------------------------------------------------------------------------

/** A quarter-turn fillet between two axis-aligned runs. */
function fillet(
  cx: number,
  cz: number,
  radius: number,
  fromAngle: number,
  toAngle: number,
): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  const steps = 6;
  for (let i = 0; i <= steps; i += 1) {
    const a = fromAngle + ((toAngle - fromAngle) * i) / steps;
    out.push({ x: cx + Math.cos(a) * radius, z: cz + Math.sin(a) * radius });
  }
  return out;
}

export function buildTaxiwayMarkings(sink: GeometrySink): void {
  const buffer = new SurfaceBuffer();
  const m = MARKINGS;
  const width = m.taxiCentreWidth;

  stroke(
    buffer,
    'roadPaintYellow',
    [
      { x: TAXIWAY.centreX, z: TAXIWAY.fromZ },
      { x: TAXIWAY.centreX, z: TAXIWAY.toZ },
    ],
    width,
  );

  for (const z of TAXIWAY_LINKS) {
    // Centreline out to the runway, with a 12 m fillet off the parallel
    // taxiway so an aircraft has a curve to follow rather than a right angle.
    const r = 12;
    const turn = fillet(TAXIWAY.centreX + r, z - r, r, Math.PI, Math.PI * 0.5);
    stroke(buffer, 'roadPaintYellow', turn, width);
    stroke(
      buffer,
      'roadPaintYellow',
      [
        { x: TAXIWAY.centreX + r, z },
        { x: RUNWAY.centreX, z },
      ],
      width,
    );

    // Holding position, pattern A: two solid lines on the taxiway side and two
    // dashed on the runway side. Set 37.5 m from the runway centreline, which
    // clears the code-2 runway strip.
    const holdX = RUNWAY.centreX - RUNWAY.halfWidth - 15;
    const pitch = m.holdLineWidth + m.holdLineGap;
    for (let i = 0; i < 4; i += 1) {
      const x = holdX - (1.5 - i) * pitch;
      if (i < 2) {
        paint(buffer, 'roadPaintYellow', x, z, m.holdLineWidth * 0.5, TAXIWAY.halfWidth);
        continue;
      }
      // Dashed: 1 m painted, 1 m gap.
      for (let d = -TAXIWAY.halfWidth; d < TAXIWAY.halfWidth; d += 2) {
        paint(buffer, 'roadPaintYellow', x, z + d + 0.5, m.holdLineWidth * 0.5, 0.5);
      }
    }
  }

  // Taxiway edge lines: a continuous double yellow each side.
  for (const side of [-1, 1] as const) {
    for (const inset of [0.5, 0.8] as const) {
      paint(
        buffer,
        'roadPaintYellow',
        TAXIWAY.centreX + side * (TAXIWAY.halfWidth - inset),
        (TAXIWAY.fromZ + TAXIWAY.toZ) * 0.5,
        0.075,
        (TAXIWAY.toZ - TAXIWAY.fromZ) * 0.5,
      );
    }
  }

  buffer.flush(sink);
}

export function buildApronMarkings(sink: GeometrySink): void {
  const buffer = new SurfaceBuffer();
  const m = MARKINGS;

  // Apron safety line, inside the eastern edge: the boundary equipment may not
  // cross while an aircraft is on stand.
  paint(
    buffer,
    'roadPaintYellow',
    APRON.maxX - 2,
    (APRON.minZ + APRON.maxZ) * 0.5,
    0.15,
    (APRON.maxZ - APRON.minZ) * 0.5 - 2,
  );

  for (const stand of STANDS) {
    // Lead-in line: in from the apron edge, then a turn onto the stand axis.
    stroke(
      buffer,
      'roadPaintYellow',
      [
        { x: APRON.maxX, z: stand.z },
        { x: stand.x, z: stand.z },
      ],
      m.leadInWidth,
    );
    // Stop bar across the stand axis, with the wing-tip clearance box.
    paint(buffer, 'roadPaintYellow', stand.x - 1.2, stand.z, 0.1, 5.5);
    const halfSpan = stand.size === 'heavy' ? 14 : stand.size === 'medium' ? 10 : 7;
    for (const side of [-1, 1] as const) {
      stroke(
        buffer,
        'roadPaintYellow',
        [
          { x: stand.x - 2, z: stand.z + side * halfSpan },
          { x: stand.x + 16, z: stand.z + side * halfSpan },
        ],
        m.leadInWidth,
      );
    }
  }
  buffer.flush(sink);
}

export function buildCarParkMarkings(sink: GeometrySink): void {
  const buffer = new SurfaceBuffer();
  for (const row of PARKING_ROWS) {
    for (let x = row.fromX; x + BAY_WIDTH <= row.toX; x += BAY_WIDTH) {
      paint(buffer, 'roadPaint', x, row.z, 0.06, 2.5);
    }
    paint(buffer, 'roadPaint', (row.fromX + row.toX) * 0.5, row.z, (row.toX - row.fromX) * 0.5, 0.06);
  }
  buffer.flush(sink);
}

/** The forecourt's pedestrian crossings and its kerbside drop-off hatching. */
export function buildForecourtMarkings(sink: GeometrySink): void {
  const buffer = new SurfaceBuffer();
  for (let z = FORECOURT.minZ + 12; z < FORECOURT.maxZ - 8; z += 9) {
    for (let x = FORECOURT.minX + 3; x < FORECOURT.maxX - 3; x += 2.4) {
      paint(buffer, 'roadPaint', x, z, 0.3, 1.4);
    }
  }
  buffer.flush(sink);
}

export { AIRFIELD_LEVEL };
