/**
 * Draws the fleet.
 *
 * The whole city's traffic costs one instanced draw per body shell plus one
 * for every wheel in it. Nothing is added to the scene per vehicle, and no
 * vehicle owns a light.
 *
 * Each shell is a generated Tripo model with its own texture set, so the fleet
 * now carries eleven materials rather than one. That costs nothing in draw
 * calls - a batch is one draw whichever material it uses - and three compiles a
 * single program for all of them, because they differ only in their maps.
 *
 * DRAW-CALL BUDGET. This project measured 13 microseconds per draw call
 * against a frame of 8.4 ms, so the shape of the renderer is set by that
 * number: eleven shells and one wheel mesh is twelve colour draws and eleven
 * shadow draws, and adding a thirteenth silhouette would cost about 26
 * microseconds a frame rather than a proportional share of the fleet.
 *
 * CULLING is done by not writing the instance at all. Every frame the renderer
 * walks the fleet, writes only the vehicles inside the render radius, and sets
 * `count` to what it wrote; a car on the far side of the city costs a distance
 * test. Three's own frustum culling is switched off, exactly as it is for the
 * static props, because an InstancedMesh caches its bounding sphere and a
 * fleet that moves every frame would invalidate it constantly.
 */

import {
  DynamicDrawUsage,
  Euler,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';

import { ALL_VEHICLE_KINDS } from './VehicleCatalogue';
import { buildVehicleShell, buildWheel } from './VehicleGeometry';
import type { VehicleModelSet } from './VehicleModels';
import type { WheelMount } from './VehicleModelFit';
import type { Vehicle } from './TrafficSim';
import type { VehicleKind } from './types';

interface KindBatch {
  readonly mesh: InstancedMesh;
  readonly tint: InstancedBufferAttribute;
  readonly lights: InstancedBufferAttribute;
  readonly capacity: number;
  count: number;
}

export interface TrafficRendererOptions {
  /** Used for any shell that is not drawn from a generated model. */
  readonly material: Material;
  /**
   * The generated fleet. When present every shell and the wheel come from a
   * Tripo asset; when null the authored shells in `VehicleGeometry` are used,
   * which is what keeps a missing or broken download from emptying the city.
   */
  readonly models?: VehicleModelSet | null;
  /** Vehicles beyond this distance from the camera are not drawn at all. */
  readonly renderDistance: number;
  readonly castShadows: boolean;
}

/** Scratch, reused every frame. Nothing here allocates once the batches exist. */
const bodyEuler = new Euler(0, 0, 0, 'YXZ');
const wheelEuler = new Euler(0, 0, 0, 'YXZ');
const bodyQuat = new Quaternion();
const wheelQuat = new Quaternion();
const chassisQuat = new Quaternion();
const position = new Vector3();
const scale = new Vector3(1, 1, 1);
const wheelScale = new Vector3(1, 1, 1);
const wheelOffset = new Vector3();
const chassisMatrix = new Matrix4();
const localMatrix = new Matrix4();
const outMatrix = new Matrix4();

export class TrafficRenderer {
  readonly group = new Group();

  private readonly material: Material;
  private readonly models: VehicleModelSet | null;
  private readonly batches = new Map<VehicleKind, KindBatch>();
  /** Where each kind's wheels go, taken from its model's own arches. */
  private readonly mounts = new Map<VehicleKind, WheelMount>();
  private wheels: KindBatch | null = null;
  /** Geometry this renderer built and is responsible for freeing. */
  private readonly owned: BufferGeometry[] = [];
  private renderDistance: number;
  private castShadows: boolean;

  /** Instances written on the last update, for reporting. */
  drawnVehicles = 0;
  drawnWheels = 0;

  constructor(options: TrafficRendererOptions) {
    this.group.name = 'traffic';
    this.material = options.material;
    this.models = options.models ?? null;
    this.renderDistance = options.renderDistance;
    this.castShadows = options.castShadows;
  }

  setRenderDistance(distance: number): void {
    this.renderDistance = distance;
  }

  setCastShadows(enabled: boolean): void {
    if (this.castShadows === enabled) return;
    this.castShadows = enabled;
    for (const batch of this.batches.values()) batch.mesh.castShadow = enabled;
  }

  /** Draw calls this renderer submits when everything is visible. */
  get drawCallCeiling(): number {
    return this.batches.size + (this.wheels ? 1 : 0);
  }

  /**
   * (Re)builds the instanced batches for a fleet.
   *
   * Capacity is the exact number of vehicles of each kind in the pool, which is
   * known because a vehicle's shell never changes once it is created. That
   * makes the instance buffers exactly as large as they need to be.
   */
  rebuild(vehicles: readonly Vehicle[]): void {
    this.disposeBatches();

    const counts = new Map<VehicleKind, number>();
    for (const vehicle of vehicles) {
      counts.set(vehicle.kind, (counts.get(vehicle.kind) ?? 0) + 1);
    }

    for (const kind of ALL_VEHICLE_KINDS) {
      const capacity = counts.get(kind) ?? 0;
      if (capacity === 0) continue;
      const shell = this.models?.buildShell(kind) ?? buildVehicleShell(kind);
      this.owned.push(shell.geometry);
      const batch = this.makeBatch(
        shell.geometry,
        capacity,
        `traffic-${kind}`,
        this.models?.materialFor(kind) ?? this.material,
      );
      batch.mesh.castShadow = this.castShadows;
      batch.mesh.receiveShadow = true;
      this.batches.set(kind, batch);
      const mount = this.models?.wheelMountFor(kind);
      if (mount) this.mounts.set(kind, mount);
      this.group.add(batch.mesh);
    }

    const wheelCapacity = vehicles.length * 4;
    if (wheelCapacity > 0) {
      const wheel = this.models?.buildWheel() ?? buildWheel();
      this.owned.push(wheel.geometry);
      const batch = this.makeBatch(
        wheel.geometry,
        wheelCapacity,
        'traffic-wheels',
        this.models?.wheelMaterial ?? this.material,
      );
      // Wheels sit inside the body's own shadow; casting from them as well
      // doubles a shadow draw for something nobody can see.
      batch.mesh.castShadow = false;
      batch.mesh.receiveShadow = true;
      this.wheels = batch;
      this.group.add(batch.mesh);
    }
  }

  private makeBatch(
    geometry: BufferGeometry,
    capacity: number,
    name: string,
    material: Material,
  ): KindBatch {
    const tint = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const lights = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    tint.setUsage(DynamicDrawUsage);
    lights.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aTint', tint);
    geometry.setAttribute('aLights', lights);

    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // See the header: an InstancedMesh caches its bounding sphere, so leaving
    // three to cull a fleet that moves every frame makes cars vanish.
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.count = 0;
    return { mesh, tint, lights, capacity, count: 0 };
  }

  /**
   * Writes one frame of instances.
   *
   * The body carries the road slope plus the suspension's pitch and roll; the
   * wheels carry only the road slope, so that a car diving under braking loads
   * its nose without lifting its tyres off the tarmac.
   */
  update(vehicles: readonly Vehicle[], cameraX: number, cameraZ: number): void {
    for (const batch of this.batches.values()) batch.count = 0;
    if (this.wheels) this.wheels.count = 0;
    const limit = this.renderDistance * this.renderDistance;

    for (const vehicle of vehicles) {
      if (!vehicle.active) continue;
      const dx = vehicle.x - cameraX;
      const dz = vehicle.z - cameraZ;
      if (dx * dx + dz * dz > limit) continue;

      const batch = this.batches.get(vehicle.kind);
      if (!batch || batch.count >= batch.capacity) continue;

      const blueprint = vehicle.blueprint;
      // `bodyLift` is how far a rolled shell has to come off its own origin to
      // rest on the road; it is zero for every car on its wheels. The Euler
      // order is YXZ, so the Z component is a rotation about the body's own
      // longitudinal axis - roll - which is what lets a car end up on its roof
      // with no change to the geometry or the draw.
      position.set(vehicle.x, vehicle.y + vehicle.bodyLift, vehicle.z);

      chassisQuat.setFromEuler(
        bodyEuler.set(
          vehicle.groundPitch + vehicle.crashPitch,
          vehicle.yaw,
          vehicle.groundRoll + vehicle.crashRoll,
        ),
      );
      bodyQuat.setFromEuler(
        bodyEuler.set(
          vehicle.groundPitch + vehicle.bodyPitch + vehicle.crashPitch,
          vehicle.yaw,
          vehicle.groundRoll + vehicle.bodyRoll + vehicle.crashRoll,
        ),
      );

      outMatrix.compose(position, bodyQuat, scale);
      const slot = batch.count;
      batch.mesh.setMatrixAt(slot, outMatrix);
      TrafficRenderer.writeTint(batch.tint, slot, vehicle.paint, vehicle.damage);
      batch.lights.setXYZW(slot, vehicle.braking ? 1 : 0, vehicle.headlights, 0, 0);
      batch.count = slot + 1;

      const wheels = this.wheels;
      if (!wheels) continue;
      chassisMatrix.compose(position, chassisQuat, scale);
      const chassis = blueprint.chassis;
      // The generated arches rarely sit exactly on the blueprint's axles - a
      // truck's can be most of a metre out - and a wheel that misses its arch
      // is far more visible than a wheelbase the simulation never draws. So
      // the mount comes from the model when there is one.
      const mount = this.mounts.get(vehicle.kind);
      const frontAxleZ = mount ? -mount.frontZ : chassis.frontAxle;
      const rearAxleZ = mount ? mount.rearZ : chassis.wheelbase - chassis.frontAxle;
      const halfTrack = mount ? mount.halfTrack : chassis.track / 2;
      // The arch the model was cut with, when there is one: a wheel drawn at
      // the simulation's radius inside a generated arch of a different size is
      // what put a visible ring of wheel-well liner around every wheel.
      const wheelRadius =
        mount && mount.radius > 0.05 ? mount.radius : blueprint.wheelRadius;
      wheelScale.set(blueprint.wheelWidth * 0.5, wheelRadius, wheelRadius);
      for (let corner = 0; corner < 4; corner += 1) {
        if (wheels.count >= wheels.capacity) break;
        const front = corner < 2;
        const side = corner % 2 === 0 ? -1 : 1;
        // Local space: nose at -Z, so the front axle is at negative z.
        wheelOffset.set(side * halfTrack, wheelRadius, front ? -frontAxleZ : rearAxleZ);
        // Steer about the wheel's own vertical, then spin about its axle.
        //
        // The near-side wheels are turned through half a turn as well, exactly
        // as a real wheel is mounted: the generated wheel has a styled outer
        // face and a plain inner one, and without the flip one side of every
        // car would show the back of its rims. Half a turn about Y reverses
        // the axle, so the spin is negated to keep the wheel rolling forwards.
        wheelQuat.setFromEuler(
          wheelEuler.set(
            side > 0 ? vehicle.wheelSpin : -vehicle.wheelSpin,
            (front ? vehicle.steer : 0) + (side > 0 ? 0 : Math.PI),
            0,
          ),
        );
        localMatrix.compose(wheelOffset, wheelQuat, wheelScale);
        outMatrix.multiplyMatrices(chassisMatrix, localMatrix);
        const wheelSlot = wheels.count;
        wheels.mesh.setMatrixAt(wheelSlot, outMatrix);
        TrafficRenderer.writeTint(wheels.tint, wheelSlot, vehicle.rim, vehicle.damage);
        wheels.lights.setXYZW(wheelSlot, 0, 0, 0, 0);
        wheels.count = wheelSlot + 1;
      }
    }

    this.drawnVehicles = 0;
    for (const batch of this.batches.values()) {
      this.drawnVehicles += batch.count;
      TrafficRenderer.flush(batch);
    }
    if (this.wheels) {
      this.drawnWheels = this.wheels.count;
      TrafficRenderer.flush(this.wheels);
    }
  }

  /**
   * Per-instance paint, aged by how badly the shell is damaged.
   *
   * Damage is shown in the colour the renderer was already writing rather than
   * with a second mesh, a decal or a material swap, so a wrecked car costs the
   * same three floats an undamaged one does: no extra draw call, no extra
   * geometry, nothing to build when a car is hit. Bent panels lose their gloss
   * before they lose their hue, so the paint is desaturated towards its own
   * luminance first and darkened second - a written-off red car reads as a
   * scorched dark red rather than as a grey one.
   */
  private static writeTint(
    attribute: InstancedBufferAttribute,
    slot: number,
    paint: readonly [number, number, number],
    damage: number,
  ): void {
    if (damage <= 0) {
      attribute.setXYZ(slot, paint[0], paint[1], paint[2]);
      return;
    }
    const luminance = paint[0] * 0.2126 + paint[1] * 0.7152 + paint[2] * 0.0722;
    const flat = Math.min(1, damage) * 0.55;
    const dim = 1 - Math.min(1, damage) * 0.45;
    attribute.setXYZ(
      slot,
      (paint[0] + (luminance - paint[0]) * flat) * dim,
      (paint[1] + (luminance - paint[1]) * flat) * dim,
      (paint[2] + (luminance - paint[2]) * flat) * dim,
    );
  }

  /**
   * Uploads only the prefix of each buffer that was written this frame.
   *
   * Without the update range three re-uploads the whole instance buffer even
   * when four cars are visible out of a hundred and fifty.
   */
  private static flush(batch: KindBatch): void {
    batch.mesh.count = batch.count;
    if (batch.count === 0) return;
    const matrix = batch.mesh.instanceMatrix;
    matrix.clearUpdateRanges();
    matrix.addUpdateRange(0, batch.count * 16);
    matrix.needsUpdate = true;
    batch.tint.clearUpdateRanges();
    batch.tint.addUpdateRange(0, batch.count * 3);
    batch.tint.needsUpdate = true;
    batch.lights.clearUpdateRanges();
    batch.lights.addUpdateRange(0, batch.count * 4);
    batch.lights.needsUpdate = true;
  }

  private disposeBatches(): void {
    for (const batch of this.batches.values()) {
      this.group.remove(batch.mesh);
      batch.mesh.dispose();
    }
    this.batches.clear();
    this.mounts.clear();
    if (this.wheels) {
      this.group.remove(this.wheels.mesh);
      this.wheels.mesh.dispose();
      this.wheels = null;
    }
    for (const geometry of this.owned) geometry.dispose();
    this.owned.length = 0;
  }

  dispose(): void {
    this.disposeBatches();
    this.group.clear();
  }
}
