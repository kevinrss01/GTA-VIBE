/**
 * Collision for a walking player.
 *
 * The player is a vertical cylinder. Everything it can hit is an axis-aligned
 * box, which is enough for a city of orthogonal buildings, kerbs, steps and
 * props, and is fast enough to test hundreds of times a frame without a physics
 * engine. Boxes are bucketed into a uniform grid so a query only ever looks at
 * its own neighbourhood.
 *
 * Boxes come in two flavours. `solid` boxes block horizontal movement and can
 * be stepped onto if their top is within the step height. Non-solid boxes are
 * pure platforms - floors, stairs, kerbs - which never block movement but do
 * provide support underfoot.
 *
 * ## Being inside a box
 *
 * A solid box only ever blocks a body that is approaching it from OUTSIDE. Once
 * the body's centre is within the box footprint the body is *inside the mass*,
 * not against one of its faces, and a blocking test there does not push anybody
 * out: it just refuses every direction, which freezes the player and leaves the
 * controller's stuck rescue nudging them upward once per fixed step.
 *
 * That case is not hypothetical. A building emits one coarse mass collider that
 * brackets its whole parcel from plinth base to roof, and the enterable ones put
 * a walkable room inside that bracket, so pressing E at a front door lands the
 * player squarely inside a solid box. Treating containment as "blocked" is what
 * turned that into a ride to the roof.
 *
 * The containment escape is safe because the blocking shell is a full body
 * radius thick (0.34 m) while a single fixed step moves at most
 * `RUN_SPEED / 120` = 0.05 m, and `move` only ever commits to positions that are
 * not blocked. A walking player therefore cannot cross the shell into the
 * inside of a box; they can only be *placed* there, which is exactly what a
 * door does.
 *
 * ## Vehicles
 *
 * The grid above is built once from the baked world and never changes. Traffic
 * cannot live in it: a hundred and forty cars move every frame, and rebucketing
 * them would cost more than testing them. They are held instead in a small
 * DYNAMIC set, refilled each frame from the traffic system's own broad phase
 * through `setVehicleSource` / `refreshVehicles`, holding only what is within
 * a few metres of whoever is asking. A car is an oriented box, so the tests
 * against it are a circle-versus-OBB for the walking player and a
 * separating-axis test for a driven one.
 *
 * Consulting that set is OPT-IN per query, and deliberately so. Walking into a
 * parked car has to stop the player; the chase camera's boom, which uses the
 * same `isStuck` call to decide whether something solid is between it and the
 * car, must not tuck itself in every time another car drives past.
 *
 * The positions are one frame old, because the game moves the player and their
 * car before it moves the traffic. At a closing speed of 30 m/s that is half a
 * metre against a body four and a half metres long, which no test here can
 * resolve; taking the traffic's own consistent end-of-frame state is worth more
 * than half a metre of freshness.
 */

import type { ColliderBox } from '../world/build/types';

const CELL = 8;

/** Largest number of vehicles a single query will consider. */
const MAX_NEARBY_VEHICLES = 24;

/**
 * Hands one vehicle to the collision world. Called back synchronously during
 * `refreshVehicles`; the values are copied, so nothing is retained.
 *
 * `bottom` and `top` are the world heights of the body, i.e. `y ± halfHeight`
 * about the centre the traffic system publishes.
 */
export type VehicleBoxSink = (
  id: number,
  x: number,
  z: number,
  yaw: number,
  halfLength: number,
  halfWidth: number,
  bottom: number,
  top: number,
) => void;

/**
 * Supplies the vehicles within `radius` of a point. Installed once by whoever
 * owns the traffic system; see `Driving`.
 */
export type VehicleSource = (
  x: number,
  z: number,
  radius: number,
  sink: VehicleBoxSink,
) => void;

/**
 * Where a move was refused by a vehicle, and by which one.
 *
 * `moveBox` reports the geometry of a refusal and nothing else - it has no
 * opinion about what a collision means. The caller owns the record, passes the
 * same one every frame so nothing allocates, and reads it after the call:
 * `id` is -1 when the move was refused by the world or not at all.
 *
 * This exists because a car that hits another car has to be able to push it,
 * and the only thing that knows which car was hit is the test that refused
 * the step. `MovingBox` carries no back-reference to the traffic system's own
 * `Vehicle`, and does not need one: the id is enough to name it again.
 */
export interface VehicleContact {
  id: number;
  /** World contact point: the point on that vehicle nearest the mover's centre. */
  x: number;
  /** Mid-height of the two bodies' vertical overlap - roughly bumper height. */
  y: number;
  z: number;
}

/** One vehicle as collision sees it. Pooled and rewritten in place. */
interface MovingBox {
  id: number;
  x: number;
  z: number;
  /** Unit forward, `(-sin yaw, -cos yaw)`, matching the game's convention. */
  fx: number;
  fz: number;
  halfLength: number;
  halfWidth: number;
  bottom: number;
  top: number;
}

/** How high a step the player climbs without jumping. A kerb is 0.15 m. */
export const STEP_HEIGHT = 0.45;

export interface Support {
  /** Height of the surface under the player. */
  y: number;
  /** True when the support came from built geometry rather than the terrain. */
  built: boolean;
}

export class CollisionWorld {
  private readonly grid = new Map<number, ColliderBox[]>();
  private readonly all: ColliderBox[];

  constructor(colliders: readonly ColliderBox[]) {
    this.all = colliders.slice();
    for (const box of this.all) {
      const x0 = Math.floor(box.minX / CELL);
      const x1 = Math.floor(box.maxX / CELL);
      const z0 = Math.floor(box.minZ / CELL);
      const z1 = Math.floor(box.maxZ / CELL);
      for (let cx = x0; cx <= x1; cx += 1) {
        for (let cz = z0; cz <= z1; cz += 1) {
          const key = CollisionWorld.key(cx, cz);
          const bucket = this.grid.get(key);
          if (bucket) bucket.push(box);
          else this.grid.set(key, [box]);
        }
      }
    }
  }

  get count(): number {
    return this.all.length;
  }

  private static key(cx: number, cz: number): number {
    return (cx + 1024) * 8192 + (cz + 1024);
  }

  // -- vehicles ---------------------------------------------------------------

  /** Pooled to the high-water mark; `movingCount` is the live length. */
  private readonly moving: MovingBox[] = [];
  private movingCount = 0;
  private vehicleSource: VehicleSource | null = null;
  private excludeId = -1;

  private readonly sink: VehicleBoxSink = (
    id,
    x,
    z,
    yaw,
    halfLength,
    halfWidth,
    bottom,
    top,
  ): void => {
    if (id === this.excludeId) return;
    if (this.movingCount >= MAX_NEARBY_VEHICLES) return;
    let slot = this.moving[this.movingCount];
    if (!slot) {
      slot = { id: 0, x: 0, z: 0, fx: 0, fz: 0, halfLength: 0, halfWidth: 0, bottom: 0, top: 0 };
      this.moving[this.movingCount] = slot;
    }
    slot.id = id;
    slot.x = x;
    slot.z = z;
    slot.fx = -Math.sin(yaw);
    slot.fz = -Math.cos(yaw);
    slot.halfLength = halfLength;
    slot.halfWidth = halfWidth;
    slot.bottom = bottom;
    slot.top = top;
    this.movingCount += 1;
  };

  /**
   * Installs the traffic broad phase. Passing null leaves the world purely
   * static, which is what every headless audit and unit test gets.
   */
  setVehicleSource(source: VehicleSource | null): void {
    this.vehicleSource = source;
    this.movingCount = 0;
  }

  /**
   * Refills the dynamic set around a point. Call once per frame, before any
   * query that passes `vehicles`. `exclude` drops one id, which is how a driven
   * car avoids colliding with itself.
   *
   * Allocation-free after the first few frames: the slots are pooled and only
   * rewritten. The cap exists so a pile-up cannot turn one query into a
   * hundred; twenty-four cars inside a ten metre circle is already denser than
   * this city's traffic ever gets.
   */
  refreshVehicles(x: number, z: number, radius: number, exclude = -1): void {
    this.movingCount = 0;
    this.excludeId = exclude;
    this.vehicleSource?.(x, z, radius, this.sink);
  }

  /** How many vehicles the last refresh found. Diagnostics and tests. */
  get vehicleCount(): number {
    return this.movingCount;
  }

  /**
   * True when a circle of `radius` overlaps one vehicle's oriented footprint,
   * containment included.
   *
   * A circle against an oriented box: the offset is resolved into the vehicle's
   * own forward/lateral axes, which are orthonormal, so clamping there and
   * measuring back is exact rather than conservative.
   */
  private static circleHitsVehicle(
    body: MovingBox,
    x: number,
    z: number,
    feetY: number,
    headY: number,
    radius: number,
  ): boolean {
    if (body.top <= feetY + 0.02 || body.bottom >= headY - 0.02) return false;
    const dx = x - body.x;
    const dz = z - body.z;
    const along = dx * body.fx + dz * body.fz;
    const across = dx * -body.fz + dz * body.fx;
    const clampedAlong =
      along < -body.halfLength ? -body.halfLength : along > body.halfLength ? body.halfLength : along;
    const clampedAcross =
      across < -body.halfWidth ? -body.halfWidth : across > body.halfWidth ? body.halfWidth : across;
    const overAlong = along - clampedAlong;
    const overAcross = across - clampedAcross;
    return overAlong * overAlong + overAcross * overAcross < radius * radius;
  }

  /**
   * True when the player's body would be inside a vehicle here.
   *
   * `fromX`/`fromZ`, when given, are where the body is starting from, and any
   * vehicle it is ALREADY overlapping there is ignored. Walking cannot produce
   * that state - `move` only ever commits to positions that are clear - but a
   * car can: it drives, the body does not, and somebody who was a hand's
   * breadth clear a moment ago is inside the shell now. Blocking there would
   * refuse every direction at once and pin them under the car for as long as it
   * sat there. Skipping only the vehicle they are touching, rather than
   * switching the whole test off, keeps every other car solid meanwhile.
   */
  private blockedByVehicle(
    x: number,
    z: number,
    feetY: number,
    headY: number,
    radius: number,
    fromX?: number,
    fromZ?: number,
  ): boolean {
    for (let i = 0; i < this.movingCount; i += 1) {
      const body = this.moving[i];
      if (!body) continue;
      if (!CollisionWorld.circleHitsVehicle(body, x, z, feetY, headY, radius)) continue;
      if (
        fromX !== undefined &&
        fromZ !== undefined &&
        CollisionWorld.circleHitsVehicle(body, fromX, fromZ, feetY, headY, radius)
      ) {
        continue;
      }
      return true;
    }
    return false;
  }

  /**
   * True when a solid box of the baked world overlaps an oriented footprint.
   *
   * Separating axis theorem on four axes - the two world axes and the two the
   * footprint is turned onto - which is exact for a box pair in the plane and
   * costs a handful of multiplies per candidate.
   *
   * This is what a car needs and a single circle at the nose cannot give: a
   * 4.5 m body is nothing like a 0.95 m disc, so a nose probe lets both flanks
   * and the whole rear pass through a wall the body is plainly touching.
   */
  blockedBox(
    x: number,
    z: number,
    yaw: number,
    halfLength: number,
    halfWidth: number,
    feetY: number,
    headY: number,
    fromX?: number,
    fromZ?: number,
  ): boolean {
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    // Right of forward, rotated a quarter turn about +Y.
    const rx = -fz;
    const rz = fx;
    const reach = Math.hypot(halfLength, halfWidth);
    const boxes = this.near(x, z, reach, this.scratch);
    for (const box of boxes) {
      if (!box.solid) continue;
      if (box.top <= feetY + 0.02 || box.bottom >= headY - 0.02) continue;
      if (!CollisionWorld.footprintOverlaps(box, x, z, fx, fz, rx, rz, halfLength, halfWidth)) {
        continue;
      }
      // Anything the footprint is ALREADY sitting in cannot block it, or a car
      // that has been handed over inside a mass collider - or has come to rest
      // touching a railing after mounting a pavement - is trapped. Skipping
      // just that box, rather than switching the whole test off, is what keeps
      // the building next to the railing solid meanwhile: an earlier version
      // waived every box at once and let a car resting against a fence drive
      // clean through the shop behind it.
      if (
        fromX !== undefined &&
        fromZ !== undefined &&
        CollisionWorld.footprintOverlaps(box, fromX, fromZ, fx, fz, rx, rz, halfLength, halfWidth)
      ) {
        continue;
      }
      return true;
    }
    return false;
  }

  /** Plan-view separating axis test: one axis-aligned box, one oriented one. */
  private static footprintOverlaps(
    box: ColliderBox,
    x: number,
    z: number,
    fx: number,
    fz: number,
    rx: number,
    rz: number,
    halfLength: number,
    halfWidth: number,
  ): boolean {
    const ex = (box.maxX - box.minX) * 0.5;
    const ez = (box.maxZ - box.minZ) * 0.5;
    const dx = (box.minX + box.maxX) * 0.5 - x;
    const dz = (box.minZ + box.maxZ) * 0.5 - z;
    if (Math.abs(dx) > ex + halfLength * Math.abs(fx) + halfWidth * Math.abs(rx)) return false;
    if (Math.abs(dz) > ez + halfLength * Math.abs(fz) + halfWidth * Math.abs(rz)) return false;
    if (Math.abs(dx * fx + dz * fz) > halfLength + ex * Math.abs(fx) + ez * Math.abs(fz)) {
      return false;
    }
    if (Math.abs(dx * rx + dz * rz) > halfWidth + ex * Math.abs(rx) + ez * Math.abs(rz)) {
      return false;
    }
    return true;
  }

  /**
   * The same test against the dynamic set: one oriented box against others.
   *
   * `contact`, when given, is filled in with the vehicle that refused the move
   * and where it was touched. Additive and optional: every existing caller
   * passes nothing and gets the same boolean it always did.
   */
  private blockedBoxByVehicle(
    x: number,
    z: number,
    fx: number,
    fz: number,
    halfLength: number,
    halfWidth: number,
    feetY: number,
    headY: number,
    fromX?: number,
    fromZ?: number,
    contact?: VehicleContact,
  ): boolean {
    for (let i = 0; i < this.movingCount; i += 1) {
      const body = this.moving[i];
      if (!body) continue;
      if (body.top <= feetY + 0.02 || body.bottom >= headY - 0.02) continue;
      if (!CollisionWorld.boxHitsVehicle(body, x, z, fx, fz, halfLength, halfWidth)) continue;
      if (
        fromX !== undefined &&
        fromZ !== undefined &&
        CollisionWorld.boxHitsVehicle(body, fromX, fromZ, fx, fz, halfLength, halfWidth)
      ) {
        continue;
      }
      if (contact) CollisionWorld.writeContact(body, x, z, feetY, headY, contact);
      return true;
    }
    return false;
  }

  /**
   * The point on one vehicle nearest a position, and the height the two bodies
   * share.
   *
   * Clamping into the vehicle's own forward/lateral axes is exact rather than
   * conservative, because those axes are orthonormal - the same argument as in
   * `circleHitsVehicle`. What comes out is a point on the struck car's shell,
   * which is what decides whether a hit spins it or shunts it square.
   */
  private static writeContact(
    body: MovingBox,
    x: number,
    z: number,
    feetY: number,
    headY: number,
    out: VehicleContact,
  ): void {
    const dx = x - body.x;
    const dz = z - body.z;
    const along = dx * body.fx + dz * body.fz;
    const across = dx * -body.fz + dz * body.fx;
    const clampedAlong =
      along < -body.halfLength ? -body.halfLength : along > body.halfLength ? body.halfLength : along;
    const clampedAcross =
      across < -body.halfWidth ? -body.halfWidth : across > body.halfWidth ? body.halfWidth : across;
    out.id = body.id;
    out.x = body.x + body.fx * clampedAlong - body.fz * clampedAcross;
    out.z = body.z + body.fz * clampedAlong + body.fx * clampedAcross;
    out.y = (Math.max(feetY, body.bottom) + Math.min(headY, body.top)) * 0.5;
  }

  /** Separating axis test between one oriented footprint and one vehicle. */
  private static boxHitsVehicle(
    body: MovingBox,
    x: number,
    z: number,
    fx: number,
    fz: number,
    halfLength: number,
    halfWidth: number,
  ): boolean {
    const rx = -fz;
    const rz = fx;
    {
      const dx = body.x - x;
      const dz = body.z - z;
      const bfx = body.fx;
      const bfz = body.fz;
      const brx = -bfz;
      const brz = bfx;
      const hl = body.halfLength;
      const hw = body.halfWidth;
      if (
        Math.abs(dx * fx + dz * fz) >
        halfLength + hl * Math.abs(bfx * fx + bfz * fz) + hw * Math.abs(brx * fx + brz * fz)
      ) {
        return false;
      }
      if (
        Math.abs(dx * rx + dz * rz) >
        halfWidth + hl * Math.abs(bfx * rx + bfz * rz) + hw * Math.abs(brx * rx + brz * rz)
      ) {
        return false;
      }
      if (
        Math.abs(dx * bfx + dz * bfz) >
        hl + halfLength * Math.abs(fx * bfx + fz * bfz) + halfWidth * Math.abs(rx * bfx + rz * bfz)
      ) {
        return false;
      }
      if (
        Math.abs(dx * brx + dz * brz) >
        hw + halfLength * Math.abs(fx * brx + fz * brz) + halfWidth * Math.abs(rx * brx + rz * brz)
      ) {
        return false;
      }
      return true;
    }
  }

  /** Every box whose footprint touches the given circle. */
  private near(x: number, z: number, radius: number, out: ColliderBox[]): ColliderBox[] {
    out.length = 0;
    const x0 = Math.floor((x - radius) / CELL);
    const x1 = Math.floor((x + radius) / CELL);
    const z0 = Math.floor((z - radius) / CELL);
    const z1 = Math.floor((z + radius) / CELL);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cz = z0; cz <= z1; cz += 1) {
        const bucket = this.grid.get(CollisionWorld.key(cx, cz));
        if (!bucket) continue;
        for (const box of bucket) if (!out.includes(box)) out.push(box);
      }
    }
    return out;
  }

  private readonly scratch: ColliderBox[] = [];

  /**
   * The highest surface the player can stand on at this position.
   *
   * `terrainY` is the open-ground height; built platforms above it win, but
   * only if they are not above the player's reach, so a first-floor slab does
   * not teleport someone standing in the street below it.
   */
  supportAt(x: number, z: number, feetY: number, terrainY: number): Support {
    const boxes = this.near(x, z, 0.05, this.scratch);
    let best = terrainY;
    let built = false;
    const ceiling = feetY + STEP_HEIGHT;
    for (const box of boxes) {
      if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
      // A surface is a candidate if it is under the player's reach and above
      // whatever we have found so far.
      if (box.top <= ceiling && box.top > best) {
        best = box.top;
        built = true;
      }
    }
    return { y: best, built };
  }

  /**
   * True when a solid box stands in the way of the player's body here.
   *
   * See the note at the top of the file: a box whose footprint already contains
   * the body's centre is a mass the body is inside, and it must not block -
   * otherwise the player is trapped rather than kept out.
   */
  private blocked(
    x: number,
    z: number,
    feetY: number,
    headY: number,
    radius: number,
    vehicles = false,
    fromX?: number,
    fromZ?: number,
  ): boolean {
    if (vehicles && this.blockedByVehicle(x, z, feetY, headY, radius, fromX, fromZ)) return true;
    const boxes = this.near(x, z, radius, this.scratch);
    for (const box of boxes) {
      if (!box.solid) continue;
      if (box.top <= feetY + 0.02 || box.bottom >= headY - 0.02) continue;
      if (x > box.minX && x < box.maxX && z > box.minZ && z < box.maxZ) continue;
      const nearestX = Math.max(box.minX, Math.min(x, box.maxX));
      const nearestZ = Math.max(box.minZ, Math.min(z, box.maxZ));
      const dx = x - nearestX;
      const dz = z - nearestZ;
      if (dx * dx + dz * dz < radius * radius) return true;
    }
    return false;
  }

  /**
   * Moves the player horizontally, sliding along whatever it hits.
   *
   * Axes are resolved separately so that walking into a wall at an angle keeps
   * the component parallel to the wall, which is what makes movement feel
   * smooth rather than sticky. A blocked axis is retried after a step-up, so
   * kerbs and stair treads do not stop the player dead.
   *
   * `vehicles` opts the move into the dynamic set as well, so walking into a
   * car stops the player and sliding along its flank still works. It is off by
   * default because the headless placement audit and the camera boom want the
   * baked world alone.
   */
  move(
    x: number,
    z: number,
    dx: number,
    dz: number,
    feetY: number,
    height: number,
    radius: number,
    vehicles = false,
  ): { x: number; z: number; feetY: number } {
    let nx = x;
    let nz = z;
    let ny = feetY;

    const tryAxis = (candidateX: number, candidateZ: number): boolean => {
      if (!this.blocked(candidateX, candidateZ, ny, ny + height, radius, vehicles, x, z)) {
        nx = candidateX;
        nz = candidateZ;
        return true;
      }
      // Retry from the top of whatever is in the way, if it is low enough.
      const boxes = this.near(candidateX, candidateZ, radius, this.scratch);
      let stepTop = -Infinity;
      for (const box of boxes) {
        if (!box.solid) continue;
        if (box.top <= ny + 0.02 || box.top > ny + STEP_HEIGHT) continue;
        const nearestX = Math.max(box.minX, Math.min(candidateX, box.maxX));
        const nearestZ = Math.max(box.minZ, Math.min(candidateZ, box.maxZ));
        const ddx = candidateX - nearestX;
        const ddz = candidateZ - nearestZ;
        if (ddx * ddx + ddz * ddz < radius * radius) stepTop = Math.max(stepTop, box.top);
      }
      if (
        stepTop > -Infinity &&
        !this.blocked(candidateX, candidateZ, stepTop, stepTop + height, radius, vehicles, x, z)
      ) {
        nx = candidateX;
        nz = candidateZ;
        ny = stepTop;
        return true;
      }
      return false;
    };

    if (dx !== 0) tryAxis(nx + dx, nz);
    if (dz !== 0) tryAxis(nx, nz + dz);

    return { x: nx, z: nz, feetY: ny };
  }

  /**
   * Moves a vehicle-sized oriented footprint, sliding along whatever it hits.
   *
   * Same axis-at-a-time structure as `move`, for the same reason: keeping the
   * component parallel to a wall is what lets a car scrape down a building
   * instead of stopping dead against it. The footprint is the car's real box,
   * so the flanks and the rear collide as well as the nose.
   *
   * Anything the footprint is already sitting in is waived for the length of
   * one move, so a car handed over inside a mass collider - or resting against
   * a railing after mounting a pavement - can drive back out. The waiver is per
   * BOX, not per move: waiving the whole test the moment a 4.5 m body touched
   * anything let a car parked against a fence drive clean through the building
   * behind it, which is a worse bug than the one it was fixing.
   */
  moveBox(
    x: number,
    z: number,
    yaw: number,
    dx: number,
    dz: number,
    halfLength: number,
    halfWidth: number,
    feetY: number,
    height: number,
    vehicles = false,
    contact?: VehicleContact,
  ): { x: number; z: number; feetY: number } {
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    let ny = feetY;
    // Cleared on entry, so a caller that reuses one record across sub-steps
    // never reads a stale hit. It ends the call holding the last vehicle that
    // refused a candidate, which is the one the mover is up against.
    if (contact) contact.id = -1;

    const clear = (cx: number, cz: number, atY: number): boolean =>
      !this.blockedBox(cx, cz, yaw, halfLength, halfWidth, atY, atY + height, x, z) &&
      !(
        vehicles &&
        this.blockedBoxByVehicle(
          cx,
          cz,
          fx,
          fz,
          halfLength,
          halfWidth,
          atY,
          atY + height,
          x,
          z,
          contact,
        )
      );

    let nx = x;
    let nz = z;
    const tryAxis = (candidateX: number, candidateZ: number): void => {
      if (clear(candidateX, candidateZ, ny)) {
        nx = candidateX;
        nz = candidateZ;
        return;
      }
      // Retry from the top of whatever is in the way, if it is low enough: a
      // car rides over a 0.15 m kerb rather than being stopped by it, which is
      // what the nose probe this replaced already allowed.
      const stepTop = this.stepTopUnderBox(candidateX, candidateZ, yaw, halfLength, halfWidth, ny);
      if (stepTop > -Infinity && clear(candidateX, candidateZ, stepTop)) {
        nx = candidateX;
        nz = candidateZ;
        ny = stepTop;
      }
    };

    if (dx !== 0) tryAxis(nx + dx, nz);
    if (dz !== 0) tryAxis(nx, nz + dz);

    return { x: nx, z: nz, feetY: ny };
  }

  /** Highest step-height surface under an oriented footprint, or -Infinity. */
  private stepTopUnderBox(
    x: number,
    z: number,
    yaw: number,
    halfLength: number,
    halfWidth: number,
    feetY: number,
  ): number {
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = -fz;
    const rz = fx;
    let best = -Infinity;
    for (const box of this.near(x, z, Math.hypot(halfLength, halfWidth), this.stepScratch)) {
      if (!box.solid) continue;
      if (box.top <= feetY + 0.02 || box.top > feetY + STEP_HEIGHT) continue;
      if (
        CollisionWorld.footprintOverlaps(box, x, z, fx, fz, rx, rz, halfLength, halfWidth) &&
        box.top > best
      ) {
        best = box.top;
      }
    }
    return best;
  }

  private readonly stepScratch: ColliderBox[] = [];

  /**
   * True if the player's body is jammed into a solid face here. Used for
   * rescues. A body merely standing inside a larger mass is not "stuck": it can
   * walk out, and lifting it would be a teleport rather than a rescue.
   */
  isStuck(
    x: number,
    z: number,
    feetY: number,
    height: number,
    radius: number,
    vehicles = false,
  ): boolean {
    return this.blocked(x, z, feetY, feetY + height, radius, vehicles);
  }
}
