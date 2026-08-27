/**
 * Collision against things that move, and collision for something that is not a
 * disc.
 *
 * Two defects are pinned here.
 *
 *  - `CollisionWorld` was built once from the baked world, so traffic was not in
 *    it at all and the player walked straight through every car in the city.
 *  - A driven car was tested with ONE circle at its nose, so its flanks and its
 *    whole rear passed through anything they touched. Reversing into a wall did
 *    not collide; nor did clipping a corner on the way round it.
 *
 * Everything here is numbers: no renderer, no traffic system, no browser. The
 * vehicle source is a plain function, which is exactly the shape `Driving`
 * installs.
 */

import { describe, expect, it } from 'vitest';

import { CollisionWorld, type VehicleBoxSink } from '../src/player/Collision';
import { BODY_HEIGHT, BODY_RADIUS } from '../src/player/FirstPersonController';
import type { ColliderBox } from '../src/world/build/types';

/** A family car: 4.5 m by 1.9 m by 1.5 m, sitting on y = 0. */
const CAR = {
  halfLength: 2.25,
  halfWidth: 0.95,
  bottom: 0,
  top: 1.5,
};

interface ParkedCar {
  id: number;
  x: number;
  z: number;
  yaw: number;
  halfLength?: number;
  halfWidth?: number;
  bottom?: number;
  top?: number;
}

/** The shape `Driving` installs: hand every listed car to the sink. */
function fleet(cars: readonly ParkedCar[]) {
  return (x: number, z: number, radius: number, sink: VehicleBoxSink): void => {
    for (const car of cars) {
      if (Math.hypot(car.x - x, car.z - z) > radius) continue;
      sink(
        car.id,
        car.x,
        car.z,
        car.yaw,
        car.halfLength ?? CAR.halfLength,
        car.halfWidth ?? CAR.halfWidth,
        car.bottom ?? CAR.bottom,
        car.top ?? CAR.top,
      );
    }
  };
}

function box(
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  top = 6,
  solid = true,
): ColliderBox {
  return { minX, minZ, maxX, maxZ, bottom: 0, top, solid };
}

/** Walks a body in 5 cm steps and reports where it ended up. */
function walk(
  world: CollisionWorld,
  from: { x: number; z: number },
  dirX: number,
  dirZ: number,
  steps: number,
  vehicles: boolean,
): { x: number; z: number } {
  let { x, z } = from;
  for (let i = 0; i < steps; i += 1) {
    const moved = world.move(x, z, dirX * 0.05, dirZ * 0.05, 0, BODY_HEIGHT, BODY_RADIUS, vehicles);
    x = moved.x;
    z = moved.z;
  }
  return { x, z };
}

describe('the player on foot against traffic', () => {
  it('has no dynamic set at all until one is installed', () => {
    const world = new CollisionWorld([]);
    expect(world.vehicleCount).toBe(0);
    // A refresh with no source is a no-op rather than an error: this is the
    // state every headless audit and unit test runs in.
    world.refreshVehicles(0, 0, 20);
    expect(world.vehicleCount).toBe(0);
  });

  it('walks straight through a car when vehicles are not asked for', () => {
    // The defect, preserved as the control case for the test below. It is also
    // the behaviour the camera boom still relies on.
    const world = new CollisionWorld([]);
    world.setVehicleSource(fleet([{ id: 1, x: 0, z: 0, yaw: 0 }]));
    world.refreshVehicles(0, 4, 20);
    expect(world.vehicleCount).toBe(1);

    const end = walk(world, { x: 0, z: 4 }, 0, -1, 160, false);
    expect(end.z, 'the static path must be unchanged').toBeLessThan(-2);
  });

  it('is stopped by the back of a car', () => {
    const world = new CollisionWorld([]);
    world.setVehicleSource(fleet([{ id: 1, x: 0, z: 0, yaw: 0 }]));
    world.refreshVehicles(0, 4, 20);

    const end = walk(world, { x: 0, z: 4 }, 0, -1, 160, true);
    // The tail is at z = +2.25 and the body is 0.34 m across, so a walker who
    // is stopped rather than absorbed ends up just outside 2.59 m.
    expect(end.z, `walked to z = ${end.z.toFixed(3)}`).toBeGreaterThan(2.55);
    expect(end.z).toBeLessThan(2.75);
    expect(world.isStuck(0, end.z, 0, BODY_HEIGHT, BODY_RADIUS, true)).toBe(false);
  });

  it('is stopped by the flank of a car it walks into sideways', () => {
    const world = new CollisionWorld([]);
    world.setVehicleSource(fleet([{ id: 1, x: 0, z: 0, yaw: 0 }]));
    world.refreshVehicles(4, 0, 20);

    const end = walk(world, { x: 4, z: 0 }, -1, 0, 160, true);
    // The flank is at x = 0.95.
    expect(end.x, `walked to x = ${end.x.toFixed(3)}`).toBeGreaterThan(1.25);
    expect(end.x).toBeLessThan(1.45);
  });

  it('respects the heading of a car parked across the street', () => {
    // Turned a quarter turn, so its LENGTH now runs east-west. A walker
    // approaching from the east must stop 2.25 m out rather than 0.95 m.
    const world = new CollisionWorld([]);
    world.setVehicleSource(fleet([{ id: 1, x: 0, z: 0, yaw: Math.PI / 2 }]));
    world.refreshVehicles(6, 0, 20);

    const end = walk(world, { x: 6, z: 0 }, -1, 0, 160, true);
    expect(end.x, `walked to x = ${end.x.toFixed(3)}`).toBeGreaterThan(2.55);
    expect(end.x).toBeLessThan(2.75);
  });

  it('slides along a car rather than sticking to it', () => {
    const world = new CollisionWorld([]);
    world.setVehicleSource(fleet([{ id: 1, x: 0, z: 0, yaw: 0 }]));
    world.refreshVehicles(2, 1.5, 20);

    // Pushing diagonally into the flank, level with the car: the component
    // along the flank has to survive, which is what makes brushing past a car
    // feel right rather than sticky.
    const end = walk(world, { x: 2, z: 1.5 }, -0.7071, -0.7071, 60, true);
    expect(end.x, `pressed to x = ${end.x.toFixed(3)}`).toBeGreaterThan(1.25);
    expect(end.x).toBeLessThan(1.45);
    expect(end.z, `slid to z = ${end.z.toFixed(2)}`).toBeLessThan(-0.4);
  });

  it('ignores a car that is not at body height', () => {
    const world = new CollisionWorld([]);
    world.setVehicleSource(
      fleet([{ id: 1, x: 0, z: 0, yaw: 0, bottom: 4, top: 5.5 }]),
    );
    world.refreshVehicles(0, 4, 20);
    const end = walk(world, { x: 0, z: 4 }, 0, -1, 160, true);
    expect(end.z).toBeLessThan(-2);
  });

  it('drops the excluded vehicle, so a driven car cannot hit itself', () => {
    const world = new CollisionWorld([]);
    world.setVehicleSource(fleet([{ id: 7, x: 0, z: 0, yaw: 0 }]));
    world.refreshVehicles(0, 4, 20, 7);
    expect(world.vehicleCount).toBe(0);
    const end = walk(world, { x: 0, z: 4 }, 0, -1, 160, true);
    expect(end.z).toBeLessThan(-2);
  });

  it('lets a body the car has driven over walk out of it', () => {
    // A car can drive onto a body that is standing still, which walking can
    // never do. Blocking there refuses every direction at once and would pin
    // somebody under a stopped car indefinitely, so a body that already
    // overlaps a vehicle is let out instead.
    const world = new CollisionWorld([]);
    world.setVehicleSource(fleet([{ id: 1, x: 0, z: 0, yaw: 0 }]));
    world.refreshVehicles(0, 0, 20);
    // Standing inside a car IS "stuck" as far as choosing a spot to put
    // somebody goes - `Driving.exit` uses exactly this to refuse a door that
    // opens into the side of a bus.
    expect(world.isStuck(0, 0, 0, BODY_HEIGHT, BODY_RADIUS, true)).toBe(true);
    // Walking out of it still works, because a move waives the one vehicle the
    // body already overlaps.
    const end = walk(world, { x: 0, z: 0 }, 0, 1, 160, true);
    expect(end.z).toBeGreaterThan(4);
  });
});

describe('a driven car against the world', () => {
  /** A wall running east-west along z = 0, thick enough to be a building. */
  const wall = [box(-40, 0, 40, 4)];

  /**
   * The car is 4.5 m by 1.9 m. Parked below the wall pointing north, its nose
   * is `halfLength` from its centre and its flanks `halfWidth`; the nose probe
   * this replaced tested a single 0.95 m circle at the nose only.
   */
  function drive(
    world: CollisionWorld,
    from: { x: number; z: number },
    yaw: number,
    dirX: number,
    dirZ: number,
    steps: number,
  ): { x: number; z: number } {
    let { x, z } = from;
    for (let i = 0; i < steps; i += 1) {
      const moved = world.moveBox(
        x,
        z,
        yaw,
        dirX * 0.05,
        dirZ * 0.05,
        CAR.halfLength,
        CAR.halfWidth,
        0,
        1.4,
        false,
      );
      x = moved.x;
      z = moved.z;
    }
    return { x, z };
  }

  it('stops the nose against a wall', () => {
    const world = new CollisionWorld(wall);
    // Yaw 0 faces -Z, i.e. toward the wall from below? No: -Z is north and the
    // wall is at z >= 0, so approach it from the south driving -Z... the wall
    // spans z 0..4, the car starts at z = 10 and drives north.
    const end = drive(world, { x: 0, z: 10 }, 0, 0, -1, 200);
    expect(end.z, `nose reached z = ${(end.z - CAR.halfLength).toFixed(3)}`).toBeGreaterThan(
      4 + CAR.halfLength - 0.06,
    );
  });

  it('stops the REAR against a wall - the nose probe could not', () => {
    const world = new CollisionWorld(wall);
    // Facing away from the wall and reversing into it: with a probe at the nose
    // this drove the whole car through the building.
    const end = drive(world, { x: 0, z: 10 }, Math.PI, 0, -1, 200);
    expect(end.z, `car centre reached z = ${end.z.toFixed(3)}`).toBeGreaterThan(
      4 + CAR.halfLength - 0.06,
    );
  });

  it('stops the LEFT flank against a wall - the nose probe could not', () => {
    const world = new CollisionWorld(wall);
    // Pointing east, sliding north sideways: the wall meets the flank, which is
    // 0.95 m from the centre, and no part of the nose ever touches it.
    const end = drive(world, { x: 0, z: 10 }, -Math.PI / 2, 0, -1, 200);
    expect(end.z, `car centre reached z = ${end.z.toFixed(3)}`).toBeGreaterThan(
      4 + CAR.halfWidth - 0.06,
    );
    expect(end.z).toBeLessThan(4 + CAR.halfWidth + 0.2);
  });

  it('stops the RIGHT flank against a wall - the nose probe could not', () => {
    const world = new CollisionWorld(wall);
    const end = drive(world, { x: 0, z: 10 }, Math.PI / 2, 0, -1, 200);
    expect(end.z, `car centre reached z = ${end.z.toFixed(3)}`).toBeGreaterThan(
      4 + CAR.halfWidth - 0.06,
    );
    expect(end.z).toBeLessThan(4 + CAR.halfWidth + 0.2);
  });

  it('is what the old nose probe let through', () => {
    // The control: one circle at the nose, exactly as `Driving` used to test.
    // Every flank and rear case above passes clean through it, which is why the
    // player could drive into buildings.
    const world = new CollisionWorld(wall);
    const reach = CAR.halfLength - CAR.halfWidth;
    let x = 0;
    let z = 10;
    const yaw = Math.PI; // reversing at the wall
    for (let i = 0; i < 200; i += 1) {
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const moved = world.move(
        x + fx * reach,
        z + fz * reach,
        0,
        -0.05,
        0,
        1.4,
        CAR.halfWidth,
      );
      x = moved.x - fx * reach;
      z = moved.z - fz * reach;
    }
    // The wall's near face is z = 4 and the car's rear is 2.25 m behind its
    // centre, so a rear that stopped at the wall would leave the centre at
    // 6.25. The nose probe parks the centre at 3.65 instead: two and a half
    // metres of car inside the building.
    const rear = z - CAR.halfLength;
    expect(rear, `rear reached z = ${rear.toFixed(2)}, wall face is z = 4`).toBeLessThan(3.5);
  });

  it('still slides along a wall it meets at an angle', () => {
    const world = new CollisionWorld(wall);
    // Pointing east and pushed north-east into the wall: the along-wall
    // component must survive, which is what makes scraping a building feel
    // right rather than sticky.
    const end = drive(world, { x: -12, z: 10 }, -Math.PI / 2, 0.7071, -0.7071, 200);
    expect(end.z, `stopped at z = ${end.z.toFixed(2)}`).toBeGreaterThan(4 + CAR.halfWidth - 0.06);
    expect(end.x, `slid to x = ${end.x.toFixed(2)}`).toBeGreaterThan(-5);
  });

  it('drives freely where there is nothing', () => {
    const world = new CollisionWorld([]);
    const end = drive(world, { x: 0, z: 10 }, 0, 0, -1, 200);
    expect(end.z).toBeCloseTo(0, 6);
  });

  it('does not collide with a platform it is driving on', () => {
    // Non-solid boxes are floors, and a car sits on top of hundreds of them.
    const world = new CollisionWorld([box(-40, -40, 40, 40, 0.2, false)]);
    const end = drive(world, { x: 0, z: 10 }, 0, 0, -1, 200);
    expect(end.z).toBeCloseTo(0, 6);
  });

  it('rides over a kerb rather than being stopped by it', () => {
    // A 0.15 m kerb stone is solid and well under the step height, and the car
    // could mount one before this change. That must not regress.
    const world = new CollisionWorld([box(-40, 0, 40, 0.4, 0.15)]);
    const end = drive(world, { x: 0, z: 6 }, 0, 0, -1, 160);
    expect(end.z, `stopped at z = ${end.z.toFixed(2)}`).toBeLessThan(0);
  });

  it('waives only the box it is already in, not the whole world', () => {
    // The browser caught this one. A car that mounts a pavement comes to rest
    // touching a railing, and an all-or-nothing waiver then let it drive
    // straight through the shop front behind the railing.
    const railing = box(-0.4, 9, 0.4, 9.4, 1.1);
    const world = new CollisionWorld([railing, ...wall]);
    // Starting overlapped with the railing, driving north at the wall.
    const end = drive(world, { x: 0, z: 9.2 }, 0, 0, -1, 300);
    expect(end.z, `drove to z = ${end.z.toFixed(2)}, wall face is z = 4`).toBeGreaterThan(
      4 + CAR.halfLength - 0.06,
    );
  });

  it('lets a car placed inside geometry drive back out', () => {
    const world = new CollisionWorld([box(-40, -40, 40, 40)]);
    const end = drive(world, { x: 0, z: 0 }, 0, 0, -1, 40);
    expect(end.z).toBeCloseTo(-2, 6);
  });
});

describe('a driven car against other traffic', () => {
  it('cannot drive through the car in front', () => {
    const world = new CollisionWorld([]);
    world.setVehicleSource(fleet([{ id: 2, x: 0, z: 0, yaw: 0 }]));
    world.refreshVehicles(0, 12, 30, 1);
    expect(world.vehicleCount).toBe(1);

    let x = 0;
    let z = 12;
    for (let i = 0; i < 300; i += 1) {
      const moved = world.moveBox(x, z, 0, 0, -0.05, CAR.halfLength, CAR.halfWidth, 0, 1.4, true);
      x = moved.x;
      z = moved.z;
    }
    // Two cars nose to tail: 2.25 m of each between the centres.
    expect(z, `closed to z = ${z.toFixed(3)}`).toBeGreaterThan(4.44);
    expect(z).toBeLessThan(4.6);
  });

  it('queues behind a car turned across it', () => {
    const world = new CollisionWorld([]);
    world.setVehicleSource(fleet([{ id: 2, x: 0, z: 0, yaw: Math.PI / 2 }]));
    world.refreshVehicles(0, 12, 30, 1);

    let x = 0;
    let z = 12;
    for (let i = 0; i < 300; i += 1) {
      const moved = world.moveBox(x, z, 0, 0, -0.05, CAR.halfLength, CAR.halfWidth, 0, 1.4, true);
      x = moved.x;
      z = moved.z;
    }
    // Their width now faces us: 0.95 m of theirs plus 2.25 m of ours.
    expect(z, `closed to z = ${z.toFixed(3)}`).toBeGreaterThan(3.14);
    expect(z).toBeLessThan(3.3);
  });

  it('passes a car in the next lane without touching it', () => {
    const world = new CollisionWorld([]);
    world.setVehicleSource(fleet([{ id: 2, x: 3.2, z: 0, yaw: 0 }]));
    world.refreshVehicles(0, 12, 30, 1);

    let x = 0;
    let z = 12;
    for (let i = 0; i < 300; i += 1) {
      const moved = world.moveBox(x, z, 0, 0, -0.05, CAR.halfLength, CAR.halfWidth, 0, 1.4, true);
      x = moved.x;
      z = moved.z;
    }
    expect(z).toBeLessThan(-2);
  });

  it('is not stopped by traffic when vehicles are not asked for', () => {
    const world = new CollisionWorld([]);
    world.setVehicleSource(fleet([{ id: 2, x: 0, z: 0, yaw: 0 }]));
    world.refreshVehicles(0, 12, 30, 1);

    let x = 0;
    let z = 12;
    for (let i = 0; i < 300; i += 1) {
      const moved = world.moveBox(x, z, 0, 0, -0.05, CAR.halfLength, CAR.halfWidth, 0, 1.4, false);
      x = moved.x;
      z = moved.z;
    }
    expect(z).toBeLessThan(-2);
  });
});
