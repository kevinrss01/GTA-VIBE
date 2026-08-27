/**
 * Meridian Bay's traffic, as one object the game can own.
 *
 * ```ts
 * const traffic = new TrafficSystem({ plan, ground, network, quality });
 * scene.add(traffic.group);
 * traffic.update(dt, { x, z, time });   // camera position and the world clock
 * traffic.dispose();
 * ```
 *
 * `vehicles` is the contract every other system reads. See `types.ts` for what
 * a `VehicleView` promises; in short, an oriented box with a heading, half
 * extents, a speed and a flag for whether the brake lights are on. Views are
 * live objects mutated in place, so read them during the frame and never keep
 * one.
 *
 * WHAT THIS SYSTEM DOES NOT DO. It has no crime, pursuit or emergency
 * behaviour. Patrol cars are ordinary ambient traffic - they queue at lights
 * and give way exactly like everything else, and their beacons are wired but
 * never lit, because a flashing patrol car implies a chase that does not exist.
 * It also adds no lights of any kind: brake lamps and headlamps are emissive
 * surfaces, not point lights, because point lights measured at 61 per cent of
 * this project's frame.
 */

import type { Object3D } from 'three';
import type { Material } from 'three';

import type { RoadNetwork } from '../city/RoadNetwork';
import type { QualityLevel } from '../render/Lighting';
import type { CityGround } from '../world/CityGround';
import type { CityPlan } from '../world/CityPlan';
import { TrafficRenderer } from './TrafficRenderer';
import { TrafficSim, type TrafficCollision, type Vehicle } from './TrafficSim';
import { createVehicleMaterial } from './VehicleMaterial';
import type { VehicleModelSet } from './VehicleModels';
import type {
  ChassisSpec,
  ImpactReport,
  TrafficContext,
  TrafficObstacle,
  VehicleHandle,
  VehicleImpact,
  VehicleView,
} from './types';

export { VEHICLE_INTEGRITY, impactDamage } from './types';
export type { ImpactReport, VehicleImpact } from './types';
export type { TrafficCollision } from './TrafficSim';

export interface TrafficSystemOptions {
  readonly plan: CityPlan;
  readonly ground: CityGround;
  readonly network: RoadNetwork;
  readonly quality: QualityLevel;
  /** Overrides the density derived from `quality`. Metres of lane per vehicle. */
  readonly laneMetresPerVehicle?: number;
  readonly seed?: string;
  /**
   * The generated fleet from `loadVehicleModels`. Ownership passes to this
   * system, which disposes it. Omit it - or pass null after a failed load - to
   * fall back to the authored shells.
   */
  readonly models?: VehicleModelSet | null;
}

/**
 * Metres of lane per vehicle.
 *
 * Density is expressed against the length of the lane graph rather than as a
 * car count, so the city stays evenly busy from one end to the other instead
 * of crowding wherever the fleet happened to be seeded. Meridian Bay has 8.87
 * km of lane, so `high` is about a hundred and twenty cars spread across every
 * street - one per 72 m of lane.
 *
 * That number is measured, not guessed, and it was measured AFTER the two
 * structural faults in `TrafficSim` were fixed, because before them no density
 * was any good: route choice piled 2.6 times its fair share of traffic onto
 * the outer ring road, and the junction-clearance rule let cars commit to a
 * box that then filled up. Together those produced a city that slid into
 * gridlock the longer it ran.
 *
 * Settled behaviour over minutes 12 to 15 of a fifteen-minute run, seven
 * seeds, with the camera moving the way a player moves:
 *
 *   before, one per 63 m (141 cars)  mean 1.68 m/s, 61 per cent standing
 *   before, one per 72 m (123 cars)  mean 1.87 m/s, 57 per cent standing
 *   after,  one per 63 m (141 cars)  mean 2.42 m/s, 45 per cent standing
 *   after,  one per 72 m (123 cars)  mean 2.76 m/s, 39 per cent standing
 *
 * 72 m is the point where the last of the standing queues goes: the city at
 * 123 cars now moves half as fast again as it did at 141, and it no longer
 * degrades over time. `tests/traffic.test.ts` guards both the floor and the
 * absence of the slide so a future change cannot quietly reintroduce either.
 *
 * Queues concentrate at junctions, which is where the player is looking, so
 * the city reads busier than the raw count suggests.
 *
 * Measured on the target Mac in a 3840x2160 buffer: the whole fleet costs 23
 * draw calls and about 0.22 ms of frame time, plus 0.2 ms of CPU for the
 * simulation. See the note in `TrafficRenderer`.
 */
const DENSITY: Record<QualityLevel, number> = { low: 120, medium: 85, high: 72 };
const RENDER_DISTANCE: Record<QualityLevel, number> = { low: 150, medium: 200, high: 260 };
const MAX_POPULATION = 240;

/** Radius the player on foot presents to traffic. */
const PLAYER_RADIUS = 0.5;
/** Where a player-driven car's three obstacle circles sit along its length. */
const DRIVER_CIRCLES: readonly number[] = [-0.62, 0, 0.62];

export class TrafficSystem {
  /** Add this to the scene. It owns every vehicle mesh and nothing else. */
  readonly group: Object3D;

  private readonly sim: TrafficSim;
  private readonly renderer: TrafficRenderer;
  private readonly material: Material;
  private readonly models: VehicleModelSet | null;
  private readonly handles = new Map<number, VehicleHandle>();

  private external: readonly TrafficObstacle[] = [];
  private readonly obstacles: TrafficObstacle[] = [];
  private readonly playerObstacle = { x: 0, z: 0, radius: PLAYER_RADIUS };
  private readonly driverObstacles: { x: number; z: number; radius: number }[] = [];
  private playerIsObstacle = true;
  private quality: QualityLevel;
  private disposed = false;

  /**
   * Notified for every vehicle impact in the game, wherever it was resolved -
   * a knocked car, a wreck hitting a wall, the player's own car connecting
   * with something. One subscription so audio does not have to find and follow
   * four different systems. Rewritten in place; read it, do not keep it.
   */
  onImpact: ((info: ImpactReport) => void) | null = null;
  private readonly impact = { x: 0, y: 0, z: 0, intensity: 0, kind: 'vehicle' as 'vehicle' | 'world' };

  constructor(options: TrafficSystemOptions) {
    this.quality = options.quality;
    const perVehicle = options.laneMetresPerVehicle ?? DENSITY[options.quality];

    this.sim = new TrafficSim({
      network: options.network,
      plan: options.plan,
      heightAt: (x, z) => options.ground.heightAt(x, z),
      population: 0,
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      detailDistance: RENDER_DISTANCE[options.quality],
    });
    this.sim.resize(Math.min(MAX_POPULATION, Math.round(this.sim.laneLength / perVehicle)));

    this.material = createVehicleMaterial();
    this.models = options.models ?? null;
    this.renderer = new TrafficRenderer({
      material: this.material,
      models: this.models,
      renderDistance: RENDER_DISTANCE[options.quality],
      castShadows: options.quality !== 'low',
    });
    this.renderer.rebuild(this.sim.vehicles);
    this.group = this.renderer.group;
    this.sim.impactListener = (x, y, z, intensity, kind): void => {
      this.reportImpact(x, y, z, intensity, kind);
    };
  }

  /**
   * Live views of every active vehicle, rebuilt in place each update.
   *
   * The array and the objects inside it are reused between frames, so this is
   * safe to read every frame from any number of consumers and unsafe to retain.
   */
  get vehicles(): readonly VehicleView[] {
    return this.sim.views;
  }

  /** Vehicles whose centre is inside a radius, via the traffic broad phase. */
  forEachNear(x: number, z: number, radius: number, visit: (view: VehicleView) => void): void {
    this.sim.forEachNear(x, z, radius, visit);
  }

  /**
   * Things traffic must brake for that traffic does not own: pedestrians, and
   * anything else a caller wants respected. The array is read, never copied,
   * so a crowd system can hand over its own live list once and keep mutating it.
   */
  setObstacles(obstacles: readonly TrafficObstacle[]): void {
    this.external = obstacles;
  }

  /**
   * Optional hook so a crowd can declare a crossing occupied slightly before
   * anyone is physically on it. Without it, cars still stop for a pedestrian
   * standing on the carriageway, because obstacles are projected onto lanes.
   */
  setCrossingBlocked(predicate: ((crossingId: string) => boolean) | null): void {
    this.sim.setCrossingBlocked(predicate);
  }

  /** Whether traffic brakes for the camera position. On by default. */
  setPlayerIsObstacle(enabled: boolean): void {
    this.playerIsObstacle = enabled;
  }

  setQuality(quality: QualityLevel): void {
    if (quality === this.quality) return;
    this.quality = quality;
    this.renderer.setRenderDistance(RENDER_DISTANCE[quality]);
    this.renderer.setCastShadows(quality !== 'low');
    this.sim.resize(Math.min(MAX_POPULATION, Math.round(this.sim.laneLength / DENSITY[quality])));
    this.renderer.rebuild(this.sim.vehicles);
  }

  update(dt: number, ctx: TrafficContext): void {
    if (this.disposed) return;

    this.obstacles.length = 0;
    for (const obstacle of this.external) this.obstacles.push(obstacle);
    if (this.playerIsObstacle) {
      this.playerObstacle.x = ctx.x;
      this.playerObstacle.z = ctx.z;
      this.obstacles.push(this.playerObstacle);
    }
    // A car the traffic AI is not driving is an obstacle to everyone else -
    // the player's, a pursuit unit's, and a wreck lying where it stopped.
    // Three circles along its length approximate the box well enough for a car
    // to queue behind it. Publishing the wrecks is what keeps the rest of the
    // traffic from driving through one; without it a crash in a live lane is
    // invisible to every driver behind it.
    let driverIndex = 0;
    for (const vehicle of this.sim.vehicles) {
      if (!vehicle.active || vehicle.control === 'ambient') continue;
      const fx = -Math.sin(vehicle.yaw);
      const fz = -Math.cos(vehicle.yaw);
      const halfLength = vehicle.blueprint.length * 0.5;
      for (const t of DRIVER_CIRCLES) {
        const slot = this.driverObstacles[driverIndex] ?? { x: 0, z: 0, radius: 1 };
        slot.x = vehicle.x + fx * halfLength * t;
        slot.z = vehicle.z + fz * halfLength * t;
        slot.radius = vehicle.blueprint.width * 0.5;
        this.driverObstacles[driverIndex] = slot;
        this.obstacles.push(slot);
        driverIndex += 1;
      }
    }
    this.sim.setObstacles(this.obstacles);

    this.sim.update(dt, ctx.x, ctx.z, ctx.time);
    this.renderer.update(this.sim.vehicles, ctx.x, ctx.z);
  }

  // -- player handover ------------------------------------------------------

  /**
   * Hands one ambient vehicle to a driving layer.
   *
   * The vehicle stays in the fleet: it keeps being drawn, its wheels keep
   * turning, and every other driver keeps treating it as something to queue
   * behind, because a player car is fed back to the sim as an obstacle. What
   * stops is the traffic AI - no lane, no IDM, no junction claim.
   *
   * The caller then owns the pose and writes it each frame through
   * `handle.setPose`. `handle.chassis` carries the wheelbase, track, mass,
   * grip and steering limits the ambient model was using, so a driving layer
   * can start from the same physical numbers.
   */
  takeControl(id: number): VehicleHandle | null {
    const vehicle = this.sim.vehicles.find((v) => v.id === id && v.active);
    // A car that is mid-crash has no pose to hand over and nothing to drive.
    if (!vehicle || vehicle.control !== 'ambient') return null;
    return this.makeHandle(vehicle);
  }

  /** The nearest ambient vehicle to a point, for an "enter the car" prompt. */
  nearestVehicle(x: number, z: number, maxDistance = 6): VehicleView | null {
    return this.sim.nearestVehicle(x, z, maxDistance)?.view ?? null;
  }

  /** Returns a vehicle to ambient control, rejoining the nearest suitable lane. */
  releaseControl(id: number): void {
    const vehicle = this.sim.vehicles.find((v) => v.id === id);
    if (!vehicle || vehicle.control !== 'player') return;
    this.sim.attach(vehicle);
    this.handles.delete(id);
  }

  private makeHandle(vehicle: Vehicle): VehicleHandle {
    this.sim.detach(vehicle);
    const chassis: ChassisSpec = vehicle.blueprint.chassis;
    const handle: VehicleHandle = {
      id: vehicle.id,
      kind: vehicle.kind,
      view: vehicle.view,
      chassis,
      setPose: (pose) => {
        vehicle.x = pose.x;
        vehicle.z = pose.z;
        vehicle.yaw = pose.yaw;
        const travelled = pose.speed * (1 / 60);
        vehicle.wheelSpin -= travelled / vehicle.blueprint.wheelRadius;
        vehicle.speed = pose.speed;
        vehicle.steer = pose.steer ?? 0;
        vehicle.braking = pose.braking ?? false;
      },
      release: () => this.releaseControl(vehicle.id),
    };
    this.handles.set(vehicle.id, handle);
    return handle;
  }

  // -- impacts --------------------------------------------------------------

  /**
   * Applies one collision to one vehicle. Returns true if it took the hit.
   *
   * This is the seam every system that can hit a car goes through: the player's
   * own collision resolve, a pursuit unit shunting traffic, an explosion. The
   * impulse is converted with the vehicle's real chassis mass and the moment of
   * the contact point about its centre, so an off-centre hit spins it, a
   * central one does not, and a lateral one high enough on the body takes it
   * over. Past a threshold the car leaves the traffic AI and finishes the
   * collision as a free body. See `TrafficSim.applyImpact`.
   *
   * A hit is ignored for a fifth of a second afterwards, so a contact that
   * persists across frames is one collision rather than a hundred.
   */
  applyImpact(vehicleId: number, hit: VehicleImpact): boolean {
    if (this.disposed) return false;
    return this.sim.applyImpact(vehicleId, hit);
  }

  /**
   * Structural damage with no impulse behind it - gunfire, fire, blast at a
   * distance. Not rate limited, because a rifle is not.
   *
   * Ordinary cars and patrol cars share this one model, on the one scale:
   * `VEHICLE_INTEGRITY` points, zero is a write-off. Read the result back off
   * `VehicleView.integrity`.
   */
  applyDamage(vehicleId: number, amount: number): boolean {
    if (this.disposed) return false;
    return this.sim.applyDamage(vehicleId, amount);
  }

  /**
   * Collects the impulse banked for a vehicle whose pose is written from
   * outside, in newton seconds, or null when nothing hit it.
   *
   * The simulation cannot move a car it does not own, so when traffic runs into
   * the player's - or a pursuit unit's - it records the exchange here and lets
   * the owner decide what it does to the car. Poll it once a frame.
   */
  takeImpulse(vehicleId: number): { x: number; z: number; yaw: number; damage: number } | null {
    return this.sim.takeImpulse(vehicleId);
  }

  /** The chassis of one vehicle, for anything that has to do momentum with it. */
  chassisOf(id: number): ChassisSpec | null {
    const vehicle = this.sim.vehicles.find((v) => v.id === id && v.active);
    return vehicle ? vehicle.blueprint.chassis : null;
  }

  /**
   * Gives free bodies the static world to bounce off.
   *
   * Installed after construction: the collision world is built from the baked
   * city and this system from the plan, so neither can precede the other.
   * Without it a knocked car still slides, spins and settles - it just does not
   * notice walls.
   */
  setCollision(collision: TrafficCollision | null): void {
    this.sim.setCollision(collision);
  }

  /** Publishes an impact somebody else resolved. See `onImpact`. */
  reportImpact(
    x: number,
    y: number,
    z: number,
    intensity: number,
    kind: 'vehicle' | 'world',
  ): void {
    const listener = this.onImpact;
    if (!listener || intensity <= 0) return;
    this.impact.x = x;
    this.impact.y = y;
    this.impact.z = z;
    this.impact.intensity = Math.min(1, intensity);
    this.impact.kind = kind;
    listener(this.impact);
  }

  // -- diagnostics ----------------------------------------------------------

  get stats(): {
    population: number;
    active: number;
    drawnVehicles: number;
    drawnWheels: number;
    /** Colour-pass draw calls. The shadow pass adds one per body shell. */
    drawCalls: number;
    laneLength: number;
    /** False when a generated asset failed to load and the fallback is drawn. */
    generated: boolean;
  } {
    return {
      population: this.sim.vehicles.length,
      active: this.sim.liveCount,
      drawnVehicles: this.renderer.drawnVehicles,
      drawnWheels: this.renderer.drawnWheels,
      drawCalls: this.renderer.drawCallCeiling,
      laneLength: this.sim.laneLength,
      generated: this.models !== null,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.handles.clear();
    this.renderer.dispose();
    this.material.dispose();
    this.models?.dispose();
  }
}
