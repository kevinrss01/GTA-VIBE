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
 * DAMAGE IS INSTANCED TOO. A wrecked car is the same draw an undamaged one is:
 * how badly each region of the shell is hit travels on the instance, the
 * dents, soot and broken glazing come out of the same shader, and every plume
 * of smoke and every fire in the city shares ONE further instanced batch with
 * a hard cap on it. A street full of burnt-out wrecks therefore costs thirteen
 * draws rather than twelve, and never more.
 *
 * CULLING is done by not writing the instance at all. Every frame the renderer
 * walks the fleet, writes only the vehicles inside the render radius, and sets
 * `count` to what it wrote; a car on the far side of the city costs a distance
 * test. Three's own frustum culling is switched off, exactly as it is for the
 * static props, because an InstancedMesh caches its bounding sphere and a
 * fleet that moves every frame would invalidate it constantly.
 */

import {
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
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
  /** Per-instance region damage: front, rear, left, right. See `aSurf.zw`. */
  readonly damage: InstancedBufferAttribute;
  /** Per-instance glazing damage and soot. */
  readonly wear: InstancedBufferAttribute;
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

/**
 * The damage-particle pool.
 *
 * ONE instanced draw for every plume of smoke, every fire and every shower of
 * sparks in the city, and a hard ceiling on how many of them exist. This is
 * the whole performance argument for the effect: a wrecked car costs the same
 * twelve floats an undamaged one does, and a street full of them costs one
 * more draw call than a street with none. Ninety-six billboards is about six
 * burning cars' worth of plume at the emission rates below, which is more
 * simultaneous fire than the density of the fleet can produce near the camera.
 */
const MAX_PARTICLES = 96;
/** Beyond this from the camera a damaged car emits nothing. */
const PARTICLE_RANGE = 110;
/** Frames between emissions at full intensity. Scaled up as it thins out. */
const EMIT_INTERVAL = 5;
/** Seconds of fire it takes to blacken a shell completely. See `sootOf`. */
const SOOT_SECONDS = 6;

/** Particle kinds. Smoke rises and spreads, fire is short and bright, sparks fall. */
const SMOKE = 0;
const FIRE = 1;
const SPARK = 2;

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

  /**
   * The particle pool. Parallel arrays sized once at construction, so a fire
   * that burns for fourteen seconds allocates nothing at all.
   */
  private readonly px = new Float32Array(MAX_PARTICLES);
  private readonly py = new Float32Array(MAX_PARTICLES);
  private readonly pz = new Float32Array(MAX_PARTICLES);
  private readonly pvx = new Float32Array(MAX_PARTICLES);
  private readonly pvy = new Float32Array(MAX_PARTICLES);
  private readonly pvz = new Float32Array(MAX_PARTICLES);
  private readonly plife = new Float32Array(MAX_PARTICLES);
  private readonly pmax = new Float32Array(MAX_PARTICLES);
  private readonly psize = new Float32Array(MAX_PARTICLES);
  private readonly pkind = new Uint8Array(MAX_PARTICLES);
  private particleCount = 0;
  private particles: InstancedMesh | null = null;
  private particleColour: InstancedBufferAttribute | null = null;
  private particleMaterial: MeshBasicMaterial | null = null;
  private particleGeometry: PlaneGeometry | null = null;
  private frame = 0;
  /** xorshift state, so the plume is varied without being frame-dependent. */
  private noise = 0x9e3779b9;

  /** Live damage particles. Never above `MAX_PARTICLES`. */
  get liveParticles(): number {
    return this.particleCount;
  }

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
    return this.batches.size + (this.wheels ? 1 : 0) + (this.particles ? 1 : 0);
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

    this.buildParticles();
  }

  /**
   * The one batch every plume in the city is drawn from.
   *
   * `MeshBasicMaterial` rather than a bare `ShaderMaterial` on purpose: the
   * stock material already carries tone mapping, the output colour transform
   * and fog, and getting any of the three wrong on a transparent additive-ish
   * effect is the fastest way to make smoke look like a sticker. All the patch
   * adds is a per-instance colour with an alpha in it and a soft round mask,
   * neither of which the stock path can express.
   */
  private buildParticles(): void {
    const geometry = new PlaneGeometry(1, 1);
    const colour = new InstancedBufferAttribute(new Float32Array(MAX_PARTICLES * 4), 4);
    colour.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aParticle', colour);

    const material = new MeshBasicMaterial({
      transparent: true,
      // Never write depth: a plume is a volume being faked with sorted quads,
      // and one that occluded the car it is pouring out of would be worse than
      // no plume at all.
      depthWrite: false,
      side: DoubleSide,
    });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute vec4 aParticle;\nvarying vec4 vParticle;\nvarying vec2 vPUv;',
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvParticle = aParticle;\nvPUv = uv;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec4 vParticle;\nvarying vec2 vPUv;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          float pd = length(vPUv - 0.5) * 2.0;
          float pmask = smoothstep(1.0, 0.15, pd);
          diffuseColor.rgb *= vParticle.rgb;
          diffuseColor.a *= vParticle.a * pmask;`,
        );
    };
    material.customProgramCacheKey = (): string => 'meridian-vehicle-particle';

    const mesh = new InstancedMesh(geometry, material, MAX_PARTICLES);
    mesh.name = 'traffic-damage-particles';
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Drawn after the opaque fleet, which is what a transparent pass needs.
    mesh.renderOrder = 2;
    mesh.count = 0;

    this.particles = mesh;
    this.particleColour = colour;
    this.particleMaterial = material;
    this.particleGeometry = geometry;
    this.particleCount = 0;
    this.group.add(mesh);
  }

  private makeBatch(
    geometry: BufferGeometry,
    capacity: number,
    name: string,
    material: Material,
  ): KindBatch {
    const tint = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const lights = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    const damage = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    const wear = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    tint.setUsage(DynamicDrawUsage);
    lights.setUsage(DynamicDrawUsage);
    damage.setUsage(DynamicDrawUsage);
    wear.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aTint', tint);
    geometry.setAttribute('aLights', lights);
    geometry.setAttribute('aDamage', damage);
    geometry.setAttribute('aWear', wear);

    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // See the header: an InstancedMesh caches its bounding sphere, so leaving
    // three to cull a fleet that moves every frame makes cars vanish.
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.count = 0;
    return { mesh, tint, lights, damage, wear, capacity, count: 0 };
  }


  /**
   * Writes one frame of instances.
   *
   * The body carries the road slope plus the suspension's pitch and roll; the
   * wheels carry only the road slope, so that a car diving under braking loads
   * its nose without lifting its tyres off the tarmac.
   */
  update(vehicles: readonly Vehicle[], cameraX: number, cameraZ: number, dt = 1 / 60): void {
    for (const batch of this.batches.values()) batch.count = 0;
    if (this.wheels) this.wheels.count = 0;
    this.frame += 1;
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
      const view = vehicle.view;
      const regions = view.regions;
      batch.mesh.setMatrixAt(slot, outMatrix);
      TrafficRenderer.writeTint(batch.tint, slot, vehicle.paint, vehicle.damage);
      batch.lights.setXYZW(slot, vehicle.braking ? 1 : 0, vehicle.headlights, 0, 0);
      batch.damage.setXYZW(slot, regions.front, regions.rear, regions.left, regions.right);
      // Soot is permanent once a shell has burned; the flame is not, so the
      // scorching is driven by how far through the fire it is rather than by
      // how hot it is right now. A car merely damaged carries none.
      batch.wear.setXY(slot, regions.glass, TrafficRenderer.sootOf(vehicle));
      batch.count = slot + 1;

      this.emitFor(vehicle, cameraX, cameraZ);

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
      for (let corner = 0; corner < 4; corner += 1) {
        if (wheels.count >= wheels.capacity) break;
        const front = corner < 2;
        const side = corner % 2 === 0 ? -1 : 1;
        // A shot-out tyre sits on its rim. Scaling the wheel's radius rather
        // than moving the car is the honest version of that at this cost: the
        // body keeps its ride height, and the flat corner is visibly squatting
        // inside its own arch.
        const flat = regions.tyres[corner] ?? 0;
        const rolling = wheelRadius * (1 - 0.22 * flat);
        wheelScale.set(blueprint.wheelWidth * 0.5, rolling, wheelRadius);
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
        // The wheel's `aRegion` is a flat quarter everywhere, so all four
        // slots carry the same number and the dot product in the shader comes
        // out as this corner's tyre.
        wheels.damage.setXYZW(wheelSlot, flat, flat, flat, flat);
        wheels.wear.setXY(wheelSlot, 0, TrafficRenderer.sootOf(vehicle));
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
    this.stepParticles(dt, cameraX, cameraZ);
  }

  /** A deterministic 0..1, so a plume varies without depending on the frame rate. */
  private random(): number {
    // xorshift32. Cheap, and reproducible from the seed for a given call order.
    let x = this.noise;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.noise = x >>> 0;
    return (this.noise & 0xffffff) / 0x1000000;
  }

  /**
   * Emits smoke, flame and sparks for one damaged car.
   *
   * Rate limited two ways, and both matter. Distance, because a plume 150 m
   * away is two pixels and would still cost a slot in the shared pool; and a
   * per-vehicle frame stride keyed on the vehicle's own id, so twelve burning
   * cars spread their emissions across the frames between them instead of all
   * spawning together and starving the pool in a single frame.
   */
  private emitFor(vehicle: Vehicle, cameraX: number, cameraZ: number): void {
    const view = vehicle.view;
    const smoke = view.smoke;
    const fire = view.fire;
    if (smoke <= 0.02 && fire <= 0.02) return;
    if (this.particleCount >= MAX_PARTICLES) return;
    const dx = vehicle.x - cameraX;
    const dz = vehicle.z - cameraZ;
    if (dx * dx + dz * dz > PARTICLE_RANGE * PARTICLE_RANGE) return;

    const intensity = Math.max(smoke, fire);
    const stride = Math.max(1, Math.round(EMIT_INTERVAL / Math.max(intensity, 0.05)));
    if ((this.frame + vehicle.id) % stride !== 0) return;

    // Out of the engine bay, which is where the damage that causes this is.
    const fx = -Math.sin(vehicle.yaw);
    const fz = -Math.cos(vehicle.yaw);
    const reach = vehicle.blueprint.length * 0.36;
    const jitter = vehicle.blueprint.width * 0.3;
    const ox = fx * reach + (this.random() - 0.5) * jitter;
    const oz = fz * reach + (this.random() - 0.5) * jitter;
    const baseY = vehicle.y + vehicle.blueprint.beltY * 0.9;

    if (fire > 0.02) {
      this.spawn(FIRE, vehicle.x + ox, baseY, vehicle.z + oz, fire);
      // Sparks come off a fire that is still building, not off an ember.
      if (fire > 0.55 && this.random() < 0.35) {
        this.spawn(SPARK, vehicle.x + ox, baseY + 0.2, vehicle.z + oz, fire);
      }
    }
    if (smoke > 0.02) this.spawn(SMOKE, vehicle.x + ox, baseY + 0.15, vehicle.z + oz, smoke);
  }

  private spawn(kind: number, x: number, y: number, z: number, intensity: number): void {
    if (this.particleCount >= MAX_PARTICLES) return;
    const i = this.particleCount;
    this.particleCount = i + 1;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.pkind[i] = kind;
    const spread = kind === SPARK ? 2.4 : 0.55;
    this.pvx[i] = (this.random() - 0.5) * spread;
    this.pvz[i] = (this.random() - 0.5) * spread;
    if (kind === SMOKE) {
      this.pvy[i] = 1.1 + this.random() * 0.9;
      this.plife[i] = 1.6 + this.random() * 1.4;
      this.psize[i] = 0.5 + this.random() * 0.5;
    } else if (kind === FIRE) {
      this.pvy[i] = 1.6 + this.random() * 1.2;
      this.plife[i] = 0.32 + this.random() * 0.3;
      this.psize[i] = (0.4 + this.random() * 0.45) * (0.6 + intensity * 0.6);
    } else {
      this.pvy[i] = 1.8 + this.random() * 2.2;
      this.plife[i] = 0.35 + this.random() * 0.35;
      this.psize[i] = 0.05 + this.random() * 0.05;
    }
    this.pmax[i] = this.plife[i] as number;
  }

  /**
   * Ages, moves and writes the pool.
   *
   * Dead particles are swapped with the last live one rather than spliced, so
   * the whole thing is one pass with no allocation and no ordering to keep.
   * The quads are cylindrical billboards - yawed to face the camera, upright -
   * which is the right shape for something rising off the ground and needs
   * only the camera's plan position, which is all this renderer is given.
   */
  private stepParticles(dt: number, cameraX: number, cameraZ: number): void {
    const mesh = this.particles;
    const colour = this.particleColour;
    if (!mesh || !colour) return;

    let i = 0;
    while (i < this.particleCount) {
      const life = (this.plife[i] as number) - dt;
      if (life <= 0) {
        const last = this.particleCount - 1;
        if (i !== last) {
          this.px[i] = this.px[last] as number;
          this.py[i] = this.py[last] as number;
          this.pz[i] = this.pz[last] as number;
          this.pvx[i] = this.pvx[last] as number;
          this.pvy[i] = this.pvy[last] as number;
          this.pvz[i] = this.pvz[last] as number;
          this.plife[i] = this.plife[last] as number;
          this.pmax[i] = this.pmax[last] as number;
          this.psize[i] = this.psize[last] as number;
          this.pkind[i] = this.pkind[last] as number;
        }
        this.particleCount = last;
        continue;
      }
      this.plife[i] = life;
      const kind = this.pkind[i] as number;
      // A spark is a hot fragment on a ballistic arc; smoke and flame are
      // buoyant and get slower as they cool and spread.
      if (kind === SPARK) this.pvy[i] = (this.pvy[i] as number) - 9.8 * dt;
      else this.pvy[i] = (this.pvy[i] as number) * (1 - 0.6 * dt);
      const drag = kind === SPARK ? 1.6 : 0.9;
      this.pvx[i] = (this.pvx[i] as number) * (1 - drag * dt);
      this.pvz[i] = (this.pvz[i] as number) * (1 - drag * dt);
      this.px[i] = (this.px[i] as number) + (this.pvx[i] as number) * dt;
      this.py[i] = (this.py[i] as number) + (this.pvy[i] as number) * dt;
      this.pz[i] = (this.pz[i] as number) + (this.pvz[i] as number) * dt;

      const age = 1 - life / Math.max(this.pmax[i] as number, 1e-3);
      const size =
        kind === SMOKE
          ? (this.psize[i] as number) * (0.6 + age * 2.2)
          : (this.psize[i] as number) * (1 - age * 0.5);
      wheelScale.set(size, size, size);
      position.set(this.px[i] as number, this.py[i] as number, this.pz[i] as number);
      wheelEuler.set(0, Math.atan2(cameraX - position.x, cameraZ - position.z), 0);
      wheelQuat.setFromEuler(wheelEuler);
      outMatrix.compose(position, wheelQuat, wheelScale);
      mesh.setMatrixAt(i, outMatrix);

      // Linear-space colours: the shader multiplies the material's own white
      // diffuse, which is already in the renderer's working space.
      if (kind === SMOKE) {
        // Sooty grey, thinning and lightening as it climbs.
        const grey = 0.012 + age * 0.05;
        colour.setXYZW(i, grey, grey * 0.97, grey * 0.95, (1 - age) * 0.5);
      } else if (kind === FIRE) {
        // Yellow at the root, deep orange at the tip. Bright enough to read as
        // emissive against a sunlit street without a light of its own.
        colour.setXYZW(i, 3.2, 1.5 - age * 1.05, 0.28 - age * 0.24, 1 - age * age);
      } else {
        colour.setXYZW(i, 4.0, 2.2, 0.7, 1 - age);
      }
      i += 1;
    }

    mesh.count = this.particleCount;
    if (this.particleCount === 0) return;
    const matrix = mesh.instanceMatrix;
    matrix.clearUpdateRanges();
    matrix.addUpdateRange(0, this.particleCount * 16);
    matrix.needsUpdate = true;
    colour.clearUpdateRanges();
    colour.addUpdateRange(0, this.particleCount * 4);
    colour.needsUpdate = true;
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
    batch.damage.clearUpdateRanges();
    batch.damage.addUpdateRange(0, batch.count * 4);
    batch.damage.needsUpdate = true;
    batch.wear.clearUpdateRanges();
    batch.wear.addUpdateRange(0, batch.count * 2);
    batch.wear.needsUpdate = true;
  }

  /**
   * How burnt a shell is, 0 to 1, from how far through its fire it has got.
   *
   * The flame is temporary and the scorching is not, so this rises while the
   * car burns and then stays where it ended up. `smoke` alone would fade the
   * soot back off again as the smoke thinned.
   */
  private static sootOf(vehicle: Vehicle): number {
    if (vehicle.burnTimer < 0) return 0;
    return Math.min(1, vehicle.burnTimer / SOOT_SECONDS);
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
    if (this.particles) {
      this.group.remove(this.particles);
      this.particles.dispose();
      this.particles = null;
    }
    this.particleGeometry?.dispose();
    this.particleGeometry = null;
    this.particleMaterial?.dispose();
    this.particleMaterial = null;
    this.particleColour = null;
    this.particleCount = 0;
    for (const geometry of this.owned) geometry.dispose();
    this.owned.length = 0;
  }

  dispose(): void {
    this.disposeBatches();
    this.group.clear();
  }
}
