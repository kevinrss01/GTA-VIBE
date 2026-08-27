/**
 * The gun shop's layout, and the generated furniture in every interior.
 *
 * Both are places where a builder and a RUNTIME module have to agree about a
 * position: the counter is geometry, the clerk and the stock behind him are
 * meshes placed later, and the furniture in the other rooms is a mesh placed
 * later over a collider emitted now. Nothing checks that agreement at run time,
 * so it is checked here.
 */

import { describe, expect, it } from 'vitest';

import { getCityPlan, type Parcel } from '../src/world/CityPlan';
import { buildInterior } from '../src/world/build/InteriorBuilder';
import {
  FURNISHING_SPECS,
  gunStoreAnchors,
  gunStorePlan,
  interiorFurnishings,
  makeRoom,
  toWorld,
  WALL_INSET,
} from '../src/world/build/interiorProps';
import { RecordingSink } from '../src/world/validate';

const plan = getCityPlan();
const enterable = plan.parcels.filter((parcel) => parcel.enterable);
const gunStores = plan.parcels.filter((parcel) => parcel.interiorKind === 'gunStore');

/** Shortest distance from a point to a segment, in the ground plane. */
function distanceToSegment(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / lengthSq));
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

function inside(parcel: Parcel, x: number, z: number, margin = WALL_INSET): boolean {
  return (
    x > parcel.rect.minX + margin &&
    x < parcel.rect.maxX - margin &&
    z > parcel.rect.minZ + margin &&
    z < parcel.rect.maxZ - margin
  );
}

describe('the gun shop is on the plan', () => {
  it('promotes exactly one parcel to a gun shop', () => {
    expect(gunStores.length).toBe(1);
    const shop = gunStores[0];
    expect(shop).toBeDefined();
    if (!shop) return;
    expect(shop.enterable).toBe(true);
    expect(shop.district).toBe('oldQuarter');
  });

  it('leaves every other enterable building exactly where it was', () => {
    // The gun shop was carved out of the Old Quarter's second shopfront by
    // splitting one `count: 2` target into two `count: 1` targets, which draws
    // the same parcels from the same RNG stream; The Vibe was added by
    // APPENDING a target, which leaves the first seven picks untouched. If any
    // line but the last ever changes, something moved a building somewhere
    // else in the city - which is exactly what happened when the nightclub was
    // briefly second in the list.
    const kinds = enterable
      .map((parcel) => `${parcel.id}:${parcel.interiorKind}`)
      .sort();
    expect(kinds).toEqual([
      'parcel-0:cafe',
      'parcel-106:workshop',
      'parcel-112:store',
      'parcel-116:marketHall',
      'parcel-31:stairhall',
      'parcel-58:nightclub',
      'parcel-69:gunStore',
      'parcel-9:lobby',
    ]);
  });

  it('still has one interior of every other kind', () => {
    const kinds = new Set(enterable.map((parcel) => parcel.interiorKind));
    for (const kind of ['cafe', 'store', 'gunStore', 'marketHall', 'lobby', 'workshop', 'stairhall']) {
      expect(kinds.has(kind as never), `no ${kind}`).toBe(true);
    }
  });
});

describe('gun shop anchors', () => {
  const parcel = gunStores[0];

  it('returns nothing for a parcel that is not the gun shop', () => {
    for (const other of plan.parcels) {
      if (other.interiorKind === 'gunStore') continue;
      expect(gunStoreAnchors(other)).toBeNull();
    }
  });

  it('stands the clerk behind the counter, inside the room, on the floor', () => {
    expect(parcel).toBeDefined();
    if (!parcel) return;
    const anchors = gunStoreAnchors(parcel);
    expect(anchors).not.toBeNull();
    if (!anchors) return;
    const room = makeRoom(parcel, 'gunStore');
    const layout = gunStorePlan(room);

    expect(anchors.floorY).toBeCloseTo(parcel.groundY, 6);
    expect(anchors.clerk.y).toBeCloseTo(parcel.groundY, 6);
    expect(inside(parcel, anchors.clerk.x, anchors.clerk.z)).toBe(true);
    // Behind the counter means further into the room than its staff face.
    expect(layout.clerkV).toBeGreaterThan(layout.counterV[1]);
    // And with room to stand: not jammed against the back wall.
    expect(layout.backFace - layout.clerkV).toBeGreaterThan(0.5);
  });

  it('puts the service point on the customer side, facing the clerk', () => {
    if (!parcel) return;
    const room = makeRoom(parcel, 'gunStore');
    const layout = gunStorePlan(room);
    expect(layout.serviceV).toBeLessThan(layout.counterV[0]);
    expect(layout.serviceV).toBeGreaterThan(0.6);
    // The customer and the clerk face each other across the same run.
    expect(layout.serviceU).toBeCloseTo(layout.clerkU, 6);
  });

  it('emits the counter as an interaction point the shop can claim', () => {
    if (!parcel) return;
    const anchors = gunStoreAnchors(parcel);
    const sink = new RecordingSink();
    buildInterior(parcel, sink);
    const point = sink.interactions.find((entry) => entry.id === anchors?.interactionId);
    expect(point, 'no counter interaction point').toBeDefined();
    if (!point || !anchors) return;
    // Not a door: the application's door handler must ignore it.
    expect(point.kind).toBe('sign');
    expect(point.target).toBeUndefined();
    expect(point.prompt).toBe('Press E to buy weapons');
    expect(point.parcelId).toBe(parcel.id);
    expect(inside(parcel, point.x, point.z)).toBe(true);
    // Within reach of where the player actually stands.
    expect(point.radius).toBeGreaterThan(1.5);
  });

  it('stands every rack gun inside the room, above the floor and under the ceiling', () => {
    if (!parcel) return;
    const anchors = gunStoreAnchors(parcel);
    if (!anchors) return;
    const room = makeRoom(parcel, 'gunStore');
    expect(anchors.rack.length).toBeGreaterThanOrEqual(6);
    for (const slot of anchors.rack) {
      expect(inside(parcel, slot.x, slot.z)).toBe(true);
      expect(slot.y).toBeGreaterThan(parcel.groundY + 0.5);
      // A 1.12 m rifle standing on this point still has to fit.
      expect(slot.y + 1.12).toBeLessThan(room.ceilY);
    }
    // The rack is a block, not a row spread over the whole back wall.
    const spread = anchors.rack.map((slot) => Math.hypot(slot.x - anchors.rack[0]!.x, slot.z - anchors.rack[0]!.z));
    expect(Math.max(...spread)).toBeLessThan(3.0);
  });

  it('puts the counter stock on the counter top and the case stock in the case', () => {
    if (!parcel) return;
    const anchors = gunStoreAnchors(parcel);
    if (!anchors) return;
    const room = makeRoom(parcel, 'gunStore');
    const layout = gunStorePlan(room);
    const top = parcel.groundY + layout.counterHeight;

    expect(anchors.counterGun.y).toBeGreaterThan(top);
    expect(anchors.counterGun.y).toBeLessThan(top + 0.2);
    expect(inside(parcel, anchors.counterGun.x, anchors.counterGun.z)).toBe(true);

    expect(anchors.caseGuns.length).toBeGreaterThanOrEqual(4);
    for (const gun of anchors.caseGuns) {
      expect(gun.y).toBeGreaterThan(top);
      expect(gun.y).toBeLessThan(top + 0.25);
      expect(inside(parcel, gun.x, gun.z)).toBe(true);
    }
  });

  it('faces the clerk out of the shop, the way the exit does', () => {
    if (!parcel) return;
    const anchors = gunStoreAnchors(parcel);
    const sink = new RecordingSink();
    buildInterior(parcel, sink);
    const exit = sink.interactions.find((entry) => entry.kind === 'door');
    expect(anchors?.clerkHeading).toBeCloseTo(exit?.target?.heading ?? Number.NaN, 6);
  });

  it('gives the same answer every time', () => {
    if (!parcel) return;
    expect(gunStoreAnchors(parcel)).toEqual(gunStoreAnchors(parcel));
  });
});

describe('generated furnishings', () => {
  it('dresses several interiors', () => {
    const dressed = enterable.filter((parcel) => interiorFurnishings(parcel).length > 0);
    expect(dressed.length).toBeGreaterThanOrEqual(5);
  });

  it('places nothing in a building with no interior', () => {
    const plain = plan.parcels.find((parcel) => !parcel.enterable);
    expect(plain).toBeDefined();
    if (!plain) return;
    expect(interiorFurnishings(plain)).toEqual([]);
  });

  it('keeps every piece inside its own room, standing on the floor', () => {
    for (const parcel of enterable) {
      for (const piece of interiorFurnishings(parcel)) {
        expect(
          inside(parcel, piece.x, piece.z, WALL_INSET + 0.05),
          `${parcel.id} ${piece.model} is outside the room`,
        ).toBe(true);
        if (piece.solid) {
          expect(piece.y, `${parcel.id} ${piece.model} floats`).toBeCloseTo(parcel.groundY, 6);
        } else {
          /*
           * A piece with no collider stands ON something, never in mid air and
           * never above head height.
           *
           * The lower bound used to be 0.5, which was the height of the only
           * surface that existed when it was written - a counter. The club
           * added a second: a 0.34 m DJ platform, which is emitted as a solid
           * in its own right, so the console on top of it needs no collider of
           * its own and correctly stands lower than any counter in the city.
           */
          expect(piece.y).toBeGreaterThan(parcel.groundY + 0.3);
          expect(piece.y).toBeLessThan(parcel.groundY + 1.6);
        }
        // Nothing is smaller than a strongbox or taller than a stall canopy.
        // The floor was 0.3 until the club's cash box arrived at 0.21, which
        // is what a strongbox is; the bound is there to catch a model fitted
        // by the wrong axis, and 0.18 still does that.
        expect(piece.height).toBeGreaterThan(0.18);
        expect(piece.height).toBeLessThan(2.2);
        expect(piece.halfX).toBeGreaterThan(0.1);
        expect(piece.halfZ).toBeGreaterThan(0.1);
        expect(Number.isFinite(piece.yaw)).toBe(true);
      }
    }
  });

  it('emits one collider per piece, no taller than a trip hazard', () => {
    for (const parcel of enterable) {
      const pieces = interiorFurnishings(parcel);
      if (pieces.length === 0) continue;
      const sink = new RecordingSink();
      buildInterior(parcel, sink);

      for (const piece of pieces) {
        if (!piece.solid) {
          // Nothing on a counter takes a collider: it would be a phantom wall
          // in the middle of the room at chest height.
          const phantom = sink.colliders.find(
            (box) =>
              box.solid &&
              Math.abs((box.minX + box.maxX) / 2 - piece.x) < 1e-6 &&
              Math.abs((box.minZ + box.maxZ) / 2 - piece.z) < 1e-6,
          );
          expect(phantom, `${parcel.id} ${piece.model} should not collide`).toBeUndefined();
          continue;
        }
        const match = sink.colliders.find(
          (box) =>
            box.solid &&
            Math.abs((box.minX + box.maxX) / 2 - piece.x) < 1e-6 &&
            Math.abs((box.minZ + box.maxZ) / 2 - piece.z) < 1e-6,
        );
        expect(match, `${parcel.id} ${piece.model} has no collider`).toBeDefined();
        if (!match) continue;
        expect(match.bottom).toBeCloseTo(parcel.groundY, 6);
        expect(match.top - match.bottom).toBeLessThanOrEqual(1.0);
      }
    }
  });

  it('never stands a piece in the way in', () => {
    /*
     * The furnishing anchors are checked against `blocksEntry` before they are
     * kept. This asserts the result of that check rather than trusting it: no
     * piece may come within its own footprint plus a shoulder of the route the
     * player walks from the door to the middle of the room.
     */
    const SHOULDER = 0.5;
    for (const parcel of enterable) {
      const kind = parcel.interiorKind;
      if (!kind) continue;
      const room = makeRoom(parcel, kind);
      const route = room.entryPath.map((step) => toWorld(room, step.u, step.v));

      for (const piece of interiorFurnishings(parcel)) {
        if (!piece.solid) continue;
        for (let i = 1; i < route.length; i += 1) {
          const a = route[i - 1];
          const b = route[i];
          if (!a || !b) continue;
          const gap = distanceToSegment(piece.x, piece.z, a.x, a.z, b.x, b.z);
          // Half the diagonal of the footprint is the worst case the piece can
          // reach towards the route from its own centre.
          const reach = Math.hypot(piece.halfX, piece.halfZ);
          expect(
            gap,
            `${parcel.id} ${piece.model} is ${gap.toFixed(2)}m from the way in`,
          ).toBeGreaterThan(reach + SHOULDER);
        }
      }
    }
  });

  /*
   * A collider has to be the shape of the thing it is standing in for.
   *
   * The world footprint is derived twice over - once to turn the piece within
   * the room, once to map the room's axes onto the world's - and getting the
   * second one to consult the first as well swapped width for depth on every
   * quarter-turned piece in the city. Eight of fifty-nine were wrong,
   * including the club's four-metre bar, which became a 1.5 m stub across the
   * room: an invisible wall in the middle of the floor and a walk-through gap
   * where the counter actually is.
   *
   * The check is the piece's own yaw, which is the one thing that says which
   * way it is facing. `halfWidth` runs ACROSS the front, so it lies on x when
   * the front points along z, and on z when the front points along x.
   */
  it('gives every furnishing a collider the shape of the model, whichever way it is turned', () => {
    let checked = 0;
    for (const parcel of enterable) {
      for (const piece of interiorFurnishings(parcel)) {
        const spec = FURNISHING_SPECS[piece.model];
        // A skewed piece is not axis-aligned and has no exact answer here.
        const quarter = piece.yaw / (Math.PI / 2);
        if (Math.abs(quarter - Math.round(quarter)) > 1e-6) continue;
        checked += 1;

        // |sin yaw| is 1 when the piece faces along x, 0 when it faces along z.
        const facesX = Math.abs(Math.sin(piece.yaw)) > 0.5;
        const wantX = facesX ? spec.halfDepth : spec.halfWidth;
        const wantZ = facesX ? spec.halfWidth : spec.halfDepth;
        expect(piece.halfX, `${parcel.id} ${piece.model} halfX`).toBeCloseTo(wantX, 6);
        expect(piece.halfZ, `${parcel.id} ${piece.model} halfZ`).toBeCloseTo(wantZ, 6);
      }
    }
    expect(checked, 'no axis-aligned furnishings to check').toBeGreaterThan(30);
  });

  it('gives the same answer every time', () => {
    for (const parcel of enterable) {
      expect(interiorFurnishings(parcel)).toEqual(interiorFurnishings(parcel));
    }
  });
});
