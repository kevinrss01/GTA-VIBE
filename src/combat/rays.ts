/**
 * What a bullet can hit, as geometry.
 *
 * Four shapes cover the whole city:
 *
 *   axis-aligned box    buildings, kerbs, steps, street furniture - every
 *                       `ColliderBox` the world builder already emitted
 *   oriented box        a vehicle, from its `VehicleView` (yaw only; a car's
 *                       pitch and roll are a couple of degrees and would cost
 *                       more to include than they could ever change)
 *   vertical cylinder   a person, capped top and bottom
 *   heightfield         the ground, marched rather than solved, because
 *                       `CityGround.sample` is a decision tree over streets,
 *                       blocks and terrain and has no closed form
 *
 * All of it is plain numbers: no Three.js, no allocation per test, and every
 * case is assertable in a unit test. Rays are `(origin, unit direction)` and
 * results are the parametric distance `t` in metres, or a negative number for
 * a miss, so a caller can compare hits from different shapes directly.
 */

import type { ColliderBox } from '../world/build/types';

export const NO_HIT = -1;

/**
 * Slab test against an axis-aligned box.
 *
 * Returns the entry distance, or `NO_HIT`. A ray that starts inside the box
 * returns 0, which is what a muzzle inside a wall should do.
 */
export function rayBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  maxT: number,
): number {
  let tMin = 0;
  let tMax = maxT;

  // Each axis in turn; a zero component means the ray is parallel to that pair
  // of faces, so it either misses outright or the axis places no bound at all.
  const invX = dx !== 0 ? 1 / dx : 0;
  if (dx === 0) {
    if (ox < minX || ox > maxX) return NO_HIT;
  } else {
    let t0 = (minX - ox) * invX;
    let t1 = (maxX - ox) * invX;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tMin) tMin = t0;
    if (t1 < tMax) tMax = t1;
    if (tMin > tMax) return NO_HIT;
  }

  const invY = dy !== 0 ? 1 / dy : 0;
  if (dy === 0) {
    if (oy < minY || oy > maxY) return NO_HIT;
  } else {
    let t0 = (minY - oy) * invY;
    let t1 = (maxY - oy) * invY;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tMin) tMin = t0;
    if (t1 < tMax) tMax = t1;
    if (tMin > tMax) return NO_HIT;
  }

  const invZ = dz !== 0 ? 1 / dz : 0;
  if (dz === 0) {
    if (oz < minZ || oz > maxZ) return NO_HIT;
  } else {
    let t0 = (minZ - oz) * invZ;
    let t1 = (maxZ - oz) * invZ;
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tMin) tMin = t0;
    if (t1 < tMax) tMax = t1;
    if (tMin > tMax) return NO_HIT;
  }

  return tMin;
}

/**
 * A box rotated about Y only, which is every vehicle in this game.
 *
 * The ray is moved into the box's own frame and the axis-aligned test does the
 * work. `half*` are half-extents: `halfLength` runs along the vehicle's forward
 * axis, which the project's yaw convention puts at `(-sin yaw, 0, -cos yaw)`.
 */
export function rayOrientedBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  cz: number,
  yaw: number,
  halfLength: number,
  halfWidth: number,
  halfHeight: number,
  maxT: number,
): number {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const rx = ox - cx;
  const rz = oz - cz;
  // Local +Z is the vehicle's tail direction, so forward is local -Z.
  const lx = rx * cos - rz * sin;
  const lz = rx * sin + rz * cos;
  const ldx = dx * cos - dz * sin;
  const ldz = dx * sin + dz * cos;
  return rayBox(
    lx,
    oy - cy,
    lz,
    ldx,
    dy,
    ldz,
    -halfWidth,
    -halfHeight,
    -halfLength,
    halfWidth,
    halfHeight,
    halfLength,
    maxT,
  );
}

/** Where on a box a point is nearest, and how far away that is. */
export interface BoxPoint {
  x: number;
  y: number;
  z: number;
  /** Metres from the query point to the box. Zero when the point is inside. */
  distance: number;
}

/**
 * The point of a yaw-rotated box nearest an arbitrary point in space.
 *
 * A BLAST IS NOT MEASURED CENTRE TO CENTRE. A box truck is 6.7 m long, so its
 * centre is 3.35 m from its own bumper: a warhead landing on that bumper is
 * 3.35 m from the vehicle by the centre measure and inside a 9.5 m radius by
 * over a third of its falloff. The same arithmetic is what decides where the
 * shockwave pushed the body, so the contact point comes back too.
 *
 * Written into `out` so a detonation walking a street of parked cars does not
 * allocate. Axis convention matches `rayOrientedBox`: local X is across the
 * vehicle (`halfWidth`) and local Z runs nose to tail (`halfLength`).
 */
export function nearestPointOnOrientedBox(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cy: number,
  cz: number,
  yaw: number,
  halfLength: number,
  halfWidth: number,
  halfHeight: number,
  out: BoxPoint,
): BoxPoint {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const rx = px - cx;
  const rz = pz - cz;
  const lx = rx * cos - rz * sin;
  const ly = py - cy;
  const lz = rx * sin + rz * cos;

  const qx = lx < -halfWidth ? -halfWidth : lx > halfWidth ? halfWidth : lx;
  const qy = ly < -halfHeight ? -halfHeight : ly > halfHeight ? halfHeight : ly;
  const qz = lz < -halfLength ? -halfLength : lz > halfLength ? halfLength : lz;

  out.distance = Math.hypot(lx - qx, ly - qy, lz - qz);
  // Back out of the box's frame: the inverse of the rotation above.
  out.x = cx + qx * cos + qz * sin;
  out.y = cy + qy;
  out.z = cz - qx * sin + qz * cos;
  return out;
}

/** An outward unit normal, written in place so a burst does not allocate. */
export interface SurfaceNormal {
  nx: number;
  ny: number;
  nz: number;
}

/**
 * Outward normal of the face of a yaw-rotated box a point lies on.
 *
 * A vehicle is an oriented box and a round that arrives on its flank has to
 * throw its sparks and lay its mark along THAT flank, not back down the line
 * the round came from. The reversed shot direction was standing in for this,
 * which is right only for a shot square onto a panel and wrong by up to ninety
 * degrees for every other one.
 *
 * The point is expressed in the box's own frame - same convention as
 * `rayOrientedBox`, local X across the vehicle and local Z nose to tail - the
 * nearest face is chosen by how far the point sits inside each slab, and the
 * winning local axis is rotated back out. A point at a corner is on two faces
 * at once and gets whichever is marginally nearer, which is the same tie a
 * corner has in reality.
 */
export function orientedBoxNormal(
  px: number,
  py: number,
  pz: number,
  cx: number,
  cy: number,
  cz: number,
  yaw: number,
  halfLength: number,
  halfWidth: number,
  halfHeight: number,
  out: SurfaceNormal,
): SurfaceNormal {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const rx = px - cx;
  const rz = pz - cz;
  const lx = rx * cos - rz * sin;
  const ly = py - cy;
  const lz = rx * sin + rz * cos;

  // Distance to each slab wall. The smallest is the face the point is on.
  const gapX = halfWidth - Math.abs(lx);
  const gapY = halfHeight - Math.abs(ly);
  const gapZ = halfLength - Math.abs(lz);

  let nlx = 0;
  let nly = 0;
  let nlz = 0;
  if (gapX <= gapY && gapX <= gapZ) nlx = lx >= 0 ? 1 : -1;
  else if (gapY <= gapZ) nly = ly >= 0 ? 1 : -1;
  else nlz = lz >= 0 ? 1 : -1;

  // Inverse of the rotation above, matching `nearestPointOnOrientedBox`.
  out.nx = nlx * cos + nlz * sin;
  out.ny = nly;
  out.nz = -nlx * sin + nlz * cos;
  return out;
}

/**
 * A standing person: a vertical cylinder from `footY` to `footY + height`.
 *
 * Capsule ends would be marginally kinder to a shot at the ankles, but a
 * cylinder is exact for the shape a pedestrian instance actually occupies and
 * costs one quadratic instead of two spheres.
 */
export function rayCylinder(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  footY: number,
  cz: number,
  radius: number,
  height: number,
  maxT: number,
): number {
  const px = ox - cx;
  const pz = oz - cz;
  const a = dx * dx + dz * dz;
  const topY = footY + height;

  if (a < 1e-9) {
    // Straight up or down the axis: only the caps can be hit.
    if (px * px + pz * pz > radius * radius) return NO_HIT;
    if (dy === 0) return NO_HIT;
    const tTop = (topY - oy) / dy;
    const tBottom = (footY - oy) / dy;
    const t = Math.min(tTop < 0 ? Infinity : tTop, tBottom < 0 ? Infinity : tBottom);
    return t <= maxT ? t : NO_HIT;
  }

  const b = 2 * (px * dx + pz * dz);
  const c = px * px + pz * pz - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return NO_HIT;
  const root = Math.sqrt(disc);
  const t0 = (-b - root) / (2 * a);
  const t1 = (-b + root) / (2 * a);

  // Walk the two side-wall roots first, then the caps, and keep the nearest
  // intersection that is actually on the finite cylinder.
  let best = Infinity;
  for (const t of [t0, t1]) {
    if (t < 0 || t > maxT) continue;
    const y = oy + dy * t;
    if (y >= footY && y <= topY && t < best) best = t;
  }
  if (dy !== 0) {
    for (const capY of [footY, topY]) {
      const t = (capY - oy) / dy;
      if (t < 0 || t > maxT || t >= best) continue;
      const hx = px + dx * t;
      const hz = pz + dz * t;
      if (hx * hx + hz * hz <= radius * radius) best = t;
    }
  }
  return best === Infinity ? NO_HIT : best;
}

export interface WorldHit {
  /** Distance along the ray, in metres. */
  readonly t: number;
  readonly box: ColliderBox;
}

/**
 * Every solid box in the city, bucketed so a shot only tests its own corridor.
 *
 * The player's `CollisionWorld` holds the same boxes but exposes no ray query
 * and is not ours to change, so this builds a second index over the SAME
 * `sink.colliders` array. It stores references, not copies: the memory cost is
 * one array of pointers per occupied cell.
 *
 * Cell size is 12 m rather than the collision world's 8 m because a shot walks
 * a long thin corridor while a walking body queries a small disc, and a longer
 * cell means fewer cell transitions on a 90 m ray.
 */
const CELL = 12;

export class WorldRayIndex {
  private readonly grid = new Map<number, number[]>();
  private readonly boxes: ColliderBox[] = [];
  /**
   * Cast number each box was last tested in. A box straddling four cells is
   * otherwise tested four times, and the biggest colliders in this city - the
   * per-parcel building masses - straddle several.
   */
  private readonly stamp: Int32Array;
  private castId = 0;

  constructor(colliders: readonly ColliderBox[], includeNonSolid = false) {
    for (const box of colliders) {
      if (!box.solid && !includeNonSolid) continue;
      const index = this.boxes.length;
      this.boxes.push(box);
      const x0 = Math.floor(box.minX / CELL);
      const x1 = Math.floor(box.maxX / CELL);
      const z0 = Math.floor(box.minZ / CELL);
      const z1 = Math.floor(box.maxZ / CELL);
      for (let cx = x0; cx <= x1; cx += 1) {
        for (let cz = z0; cz <= z1; cz += 1) {
          const key = WorldRayIndex.key(cx, cz);
          const bucket = this.grid.get(key);
          if (bucket) bucket.push(index);
          else this.grid.set(key, [index]);
        }
      }
    }
    this.stamp = new Int32Array(this.boxes.length);
  }

  get count(): number {
    return this.boxes.length;
  }

  private static key(cx: number, cz: number): number {
    return (cx + 2048) * 8192 + (cz + 2048);
  }

  /**
   * Nearest solid box along the ray, or null.
   *
   * Cells are walked in order with a 2D DDA and the search stops as soon as a
   * hit is closer than the entry point of the next cell, so a shot into a wall
   * five metres away never touches the far side of the block.
   */
  cast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxT: number,
  ): WorldHit | null {
    this.castId += 1;
    const id = this.castId;
    let best: WorldHit | null = null;

    let cellX = Math.floor(ox / CELL);
    let cellZ = Math.floor(oz / CELL);
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;
    const tDeltaX = stepX === 0 ? Infinity : Math.abs(CELL / dx);
    const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(CELL / dz);
    let tMaxX =
      stepX === 0
        ? Infinity
        : ((stepX > 0 ? (cellX + 1) * CELL : cellX * CELL) - ox) / dx;
    let tMaxZ =
      stepZ === 0
        ? Infinity
        : ((stepZ > 0 ? (cellZ + 1) * CELL : cellZ * CELL) - oz) / dz;

    // A ray parallel to both horizontal axes never leaves its cell; the guard
    // below still terminates because `travelled` starts at zero and the loop
    // breaks on the first iteration's cell advance.
    let travelled = 0;
    let guard = 0;
    while (travelled <= maxT && guard < 512) {
      guard += 1;
      const bucket = this.grid.get(WorldRayIndex.key(cellX, cellZ));
      if (bucket) {
        for (const index of bucket) {
          if (this.stamp[index] === id) continue;
          this.stamp[index] = id;
          const box = this.boxes[index];
          if (!box) continue;
          const t = rayBox(
            ox,
            oy,
            oz,
            dx,
            dy,
            dz,
            box.minX,
            box.bottom,
            box.minZ,
            box.maxX,
            box.top,
            box.maxZ,
            best ? best.t : maxT,
          );
          if (t >= 0 && (!best || t < best.t)) best = { t, box };
        }
      }
      const next = Math.min(tMaxX, tMaxZ);
      // Anything found before the ray leaves this cell is already the nearest.
      if (best && best.t <= next) break;
      if (next === Infinity) break;
      travelled = next;
      if (tMaxX < tMaxZ) {
        cellX += stepX;
        tMaxX += tDeltaX;
      } else {
        cellZ += stepZ;
        tMaxZ += tDeltaZ;
      }
    }

    return best && best.t <= maxT ? best : null;
  }
}

/**
 * Where a ray meets the terrain, by marching.
 *
 * `heightAt` is `CityGround.heightAt` in the game and a plain function in the
 * tests. The march steps coarsely and then bisects the straddling interval,
 * which costs about twenty samples for a ninety-metre shot instead of the two
 * hundred a fine march would need for the same precision.
 *
 * Returns `NO_HIT` for a ray that never gets below the ground, which is most
 * of them - the player is shooting at eye height along a level street.
 *
 * There is deliberately no early out for a level or rising ray: Meridian Bay
 * has a ridge in it, and a flat shot fired at the foot of a hill really does
 * meet the ground. The march runs to the end of the shot instead.
 */
export function rayGround(
  heightAt: (x: number, z: number) => number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxT: number,
  step = 2.5,
): number {
  let prevT = 0;
  if (oy - heightAt(ox, oz) <= 0) return 0;

  for (let t = step; t <= maxT + step; t += step) {
    const at = Math.min(t, maxT);
    const gap = oy + dy * at - heightAt(ox + dx * at, oz + dz * at);
    if (gap <= 0) {
      // Bisect the straddling interval to a centimetre.
      let lo = prevT;
      let hi = at;
      for (let i = 0; i < 8; i += 1) {
        const mid = (lo + hi) / 2;
        const g = oy + dy * mid - heightAt(ox + dx * mid, oz + dz * mid);
        if (g <= 0) hi = mid;
        else lo = mid;
      }
      return hi;
    }
    prevT = at;
    if (at >= maxT) break;
  }
  return NO_HIT;
}

/**
 * Line of sight between two points, blocked only by solid world geometry.
 *
 * Used by the police to decide whether they can see the player and by the
 * combat layer to decide whether a gunshot had a witness. People and vehicles
 * deliberately do not block sight: a crowd would otherwise make a chase end
 * every time somebody walked past.
 */
export function hasLineOfSight(
  index: WorldRayIndex,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-4) return true;
  const hit = index.cast(ax, ay, az, dx / length, dy / length, dz / length, length - 0.05);
  return hit === null;
}
