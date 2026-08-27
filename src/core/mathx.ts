/** Small scalar/2D helpers shared by world generation, physics and UI. */

export const TAU = Math.PI * 2;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, value: number): number {
  return a === b ? 0 : (value - a) / (b - a);
}

/** Hermite smoothstep, clamped at the edges. */
export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01(inverseLerp(edge0, edge1, value));
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach. `rate` is the decay per second. */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-rate * dt));
}

export interface Vec2 {
  x: number;
  y: number;
}

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.hypot(dx, dy);
}

/** Squared distance from a point to a segment, plus the parametric position on it. */
export function pointSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { distance: number; t: number; cx: number; cy: number } {
  const abx = bx - ax;
  const aby = by - ay;
  const lengthSq = abx * abx + aby * aby;
  const t = lengthSq === 0 ? 0 : clamp01(((px - ax) * abx + (py - ay) * aby) / lengthSq);
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return { distance: Math.hypot(px - cx, py - cy), t, cx, cy };
}

/** Total length of an open or closed polyline. */
export function polylineLength(points: readonly Vec2[], closed = false): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as Vec2;
    const b = points[i] as Vec2;
    total += dist2(a.x, a.y, b.x, b.y);
  }
  if (closed && points.length > 1) {
    const a = points[points.length - 1] as Vec2;
    const b = points[0] as Vec2;
    total += dist2(a.x, a.y, b.x, b.y);
  }
  return total;
}

/** Resamples a polyline into evenly spaced points (used for road ribbons). */
export function resamplePolyline(points: readonly Vec2[], spacing: number, closed = false): Vec2[] {
  if (points.length < 2 || spacing <= 0) return points.slice();
  const source = closed ? [...points, points[0] as Vec2] : points;
  const out: Vec2[] = [source[0] as Vec2];
  let carry = 0;
  for (let i = 1; i < source.length; i += 1) {
    const a = source[i - 1] as Vec2;
    const b = source[i] as Vec2;
    const segment = dist2(a.x, a.y, b.x, b.y);
    if (segment <= 1e-6) continue;
    let travelled = spacing - carry;
    while (travelled <= segment) {
      const t = travelled / segment;
      out.push({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
      travelled += spacing;
    }
    carry = segment - (travelled - spacing);
  }
  if (!closed) out.push(source[source.length - 1] as Vec2);
  return out;
}

/** Chaikin corner cutting; turns an authored polyline into a smooth curve. */
export function smoothPolyline(points: readonly Vec2[], iterations = 2, closed = false): Vec2[] {
  let current = points.slice();
  for (let pass = 0; pass < iterations; pass += 1) {
    const next: Vec2[] = [];
    const count = closed ? current.length : current.length - 1;
    if (!closed) next.push(current[0] as Vec2);
    for (let i = 0; i < count; i += 1) {
      const a = current[i] as Vec2;
      const b = current[(i + 1) % current.length] as Vec2;
      next.push({ x: lerp(a.x, b.x, 0.25), y: lerp(a.y, b.y, 0.25) });
      next.push({ x: lerp(a.x, b.x, 0.75), y: lerp(a.y, b.y, 0.75) });
    }
    if (!closed) next.push(current[current.length - 1] as Vec2);
    current = next;
  }
  return current;
}

export interface Rect {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export function rectWidth(rect: Rect): number {
  return rect.maxX - rect.minX;
}

export function rectDepth(rect: Rect): number {
  return rect.maxZ - rect.minZ;
}

export function rectCenter(rect: Rect): Vec2 {
  return { x: (rect.minX + rect.maxX) * 0.5, y: (rect.minZ + rect.maxZ) * 0.5 };
}

export function rectContains(rect: Rect, x: number, z: number, margin = 0): boolean {
  return (
    x >= rect.minX - margin &&
    x <= rect.maxX + margin &&
    z >= rect.minZ - margin &&
    z <= rect.maxZ + margin
  );
}

export function insetRect(rect: Rect, amount: number): Rect {
  return {
    minX: rect.minX + amount,
    minZ: rect.minZ + amount,
    maxX: rect.maxX - amount,
    maxZ: rect.maxZ - amount,
  };
}
