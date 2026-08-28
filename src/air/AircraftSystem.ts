/**
 * The aircraft in the world: where they are, and how they are drawn.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   const air = new AircraftSystem({
 *     baseUrl: import.meta.env.BASE_URL,
 *     groundY: (x, z) => ground.sample(x, z).y,
 *   });
 *   engine.scene.add(air.group);
 *   await air.load();                          // or `void air.load()`
 *   air.update(dt, viewerX, viewerZ);          // once a frame
 *   air.dispose();
 *
 * The fleet EXISTS before `load()` resolves - it is built from `STANDS` in the
 * constructor - so the flight model, the enter test and every unit test work
 * with no renderer at all. `load()` only adds meshes.
 *
 * ============================================================================
 *
 * ## Cost
 *
 * One `InstancedMesh` per aircraft TYPE, plus one for every propeller and fan
 * in the world: five draw calls for the whole airport, and fewer whenever a
 * type has nothing visible. Three's own frustum culling is switched off and the
 * culling is done by not writing the instance, exactly as `TrafficRenderer`
 * does and for the same reason - an `InstancedMesh` caches its bounding sphere
 * and a fleet that moves every frame invalidates it constantly.
 *
 * ## Why the cull distance is not the traffic's 260 m
 *
 * That number was set by a 4.5 m car. These are 11 to 40 m objects, and two
 * things make them need much more: the runway is 600 m long, so an aircraft at
 * one threshold must be visible from the other or the airfield looks empty
 * from the hold; and an airliner on the apron is a landmark that should be
 * readable from the city edge. Scaling the traffic figure by characteristic
 * size gives 636 m for the light single, which is what it has; the three
 * larger types are pushed to 900-950 m, where the fog has already taken them.
 * With at most five aircraft in the world the cull is a distance test each, so
 * the generous numbers cost nothing measurable.
 *
 * ## Model orientation
 *
 * The generated GLBs point their NOSE at +Z with the wings along +/-X. The
 * game's forward is `(-sin yaw, 0, -cos yaw)`, so every model needs a fixed
 * half turn. Rather than adding PI to a yaw - which would be wrong the moment
 * pitch and roll are involved - the instance matrix is built from the
 * aircraft's own basis with the columns `(-right, up, forward)`. That maps
 * model +Z onto forward and model +Y onto up in one step, and its determinant
 * is +1, so it is a rotation and not a mirror.
 *
 * ## Fitting, and why it is not uniform
 *
 * `ModelLibrary` normalises every model to a height of exactly 1 with its
 * origin at the centre of its footprint, so the returned `size` is the model's
 * own proportions and the metres-per-unit scale on each axis is the real
 * dimension divided by it.
 *
 * The generated models are not in the proportions of the aircraft they stand
 * for. Measured from the GLBs, as span : length : height against the real
 * figures in `AircraftCatalogue`:
 *
 *   cessna   x1.00  x1.07  x0.82      twin   x1.00  x1.28  x0.62
 *   jet      x1.00  x0.78  x0.73      liner  x1.00  x0.72  x0.76
 *
 * A UNIFORM fit by span would therefore draw an airliner 28 m long inside a
 * 39.5 m collision box - the player stopped five metres short of a nose that
 * is not there, or a wingtip through a hangar wall. So each axis is fitted
 * separately and the drawn aircraft is exactly the aircraft the flight model
 * and the collision box describe. One set of dimensions, in the catalogue,
 * and nothing anywhere disagrees with it.
 *
 * The price is a distortion of up to 1.4 to 1 between two axes. Two things
 * make that the right trade at this scale: an aeroplane is a long thin object
 * whose silhouette is dominated by the wing, and Three transforms instanced
 * normals by the instance matrix rather than its inverse transpose, so a
 * non-uniform instance tilts shading slightly - visible on a mirror, not on a
 * 3000-triangle textured airframe seen from a chase camera. The measured
 * result is published in `stats.measured` so it can be checked rather than
 * assumed.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Object3D,
  Vector3,
  type Material,
} from 'three';

import { STANDS, type Stand } from '../world/airport/layout';
import { ModelLibrary } from '../world/ModelLibrary';
import { AIRCRAFT, ALL_AIRCRAFT_TYPES, type AircraftSpec, type AircraftType } from './AircraftCatalogue';

/**
 * Which aircraft is on which stand.
 *
 * Authored rather than drawn from the rng: five stands and four types is not a
 * distribution worth randomising, and a fixed table means the QA hook can name
 * a stand and know what is on it. The sizes match `Stand.size` - the airliner
 * is the only thing that fits the heavy stand, and it is also the only thing
 * that cannot fly out of here.
 */
const STAND_FLEET: Readonly<Record<string, AircraftType>> = {
  'stand-1': 'liner',
  'stand-2': 'jet',
  'stand-3': 'twin',
  'stand-4': 'cessna',
  'stand-5': 'cessna',
};

/** Radians per second at full throttle. About 2400 rpm on the piston type. */
const PROP_MAX_RATE = 250;
/** What the propeller turns at with the engine at idle and the brakes on. */
const PROP_IDLE_RATE = 22;

/** One aircraft, as everything outside this module sees it. */
export interface AircraftInfo {
  readonly id: number;
  readonly type: AircraftType;
  readonly spec: AircraftSpec;
  /** Ground contact point: the wheels are here, not the centre of gravity. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  /** True while the player is in it. */
  readonly piloted: boolean;
  /** The stand it started on, or null once it has been moved. */
  readonly standId: string | null;
  /** True once it has been written off. */
  readonly wrecked: boolean;
}

/** The pose the pilot writes back every frame. */
export interface AircraftPose {
  /** Ground contact point, matching `AircraftInfo`. */
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  /** 0..1. Drives the propeller and, through the callback, the engine note. */
  power: number;
  wrecked: boolean;
}

/**
 * Handle over one aircraft, mirroring `VehicleHandle` in the traffic system.
 *
 * The system keeps drawing the aircraft and keeps it in every collision query;
 * it simply stops treating it as parked. The holder writes a pose each frame.
 */
export interface AircraftHandle {
  readonly id: number;
  readonly type: AircraftType;
  readonly spec: AircraftSpec;
  setPose(pose: AircraftPose): void;
  release(): void;
}

export interface AircraftSystemOptions {
  /** Site root, as `Furnishings` takes it. */
  readonly baseUrl?: string;
  /** Ground height at a point. The game must pass the real sampler. */
  readonly groundY: (x: number, z: number) => number;
  /** Per-model download budget. */
  readonly timeoutMs?: number;
}

export interface AircraftSystemStats {
  readonly aircraft: number;
  readonly models: number;
  readonly missing: readonly string[];
  readonly drawn: number;
  readonly triangles: number;
  /**
   * What each model would be if it were fitted UNIFORMLY by span: its own
   * span, length and height in metres. Compare against the catalogue to see
   * how much the non-uniform fit is correcting. See the header.
   */
  readonly measured: Readonly<Partial<Record<AircraftType, [number, number, number]>>>;
}

interface Aircraft {
  readonly id: number;
  readonly type: AircraftType;
  readonly spec: AircraftSpec;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  power: number;
  /** Propeller angle, radians. Kept per aircraft so they are not in lockstep. */
  spin: number;
  piloted: boolean;
  wrecked: boolean;
  standId: string | null;
}

interface Batch {
  readonly mesh: InstancedMesh;
  /** Metres per model unit, per axis. See the header on fitting. */
  readonly scaleX: number;
  readonly scaleY: number;
  readonly scaleZ: number;
  count: number;
}

export class AircraftSystem {
  readonly group: Object3D;

  private readonly options: AircraftSystemOptions;
  private readonly models = new ModelLibrary();
  private readonly fleet: Aircraft[] = [];
  private readonly batches = new Map<AircraftType, Batch>();
  private readonly missing: string[] = [];
  private readonly measured: Partial<Record<AircraftType, [number, number, number]>> = {};
  private readonly owned: BufferGeometry[] = [];
  private readonly ownedMaterials: Material[] = [];

  private props: InstancedMesh | null = null;
  private propCapacity = 0;
  private propCount = 0;
  private drawn = 0;
  private trianglesDrawn = 0;
  private nextId = 1;
  private disposed = false;

  // Scratch, reused every frame so the update path allocates nothing.
  private readonly matrix = new Matrix4();
  private readonly axisRight = new Vector3();
  private readonly axisUp = new Vector3();
  private readonly axisForward = new Vector3();
  private readonly modelX = new Vector3();
  private readonly bladeX = new Vector3();
  private readonly bladeY = new Vector3();
  private readonly scaleVector = new Vector3();

  /** The public view of one aircraft, rewritten in place. See `list`. */
  private readonly views: AircraftInfo[] = [];

  constructor(options: AircraftSystemOptions) {
    this.options = options;
    this.group = new Group();
    this.group.name = 'aircraft';
    for (const stand of STANDS) this.park(stand);
  }

  private park(stand: Stand): void {
    const type = STAND_FLEET[stand.id];
    if (!type) return;
    const spec = AIRCRAFT[type];
    this.fleet.push({
      id: this.nextId,
      type,
      spec,
      x: stand.x,
      z: stand.z,
      // The stands are on the graded platform, so this is `AIRFIELD_LEVEL`
      // unless the world says otherwise - and if it ever does, the aircraft
      // follows the world rather than the assumption.
      y: this.options.groundY(stand.x, stand.z),
      yaw: stand.heading,
      pitch: spec.groundPitch,
      roll: 0,
      power: 0,
      spin: 0,
      piloted: false,
      wrecked: false,
      standId: stand.id,
    });
    this.nextId += 1;
  }

  /**
   * Every aircraft, as a fresh read-only snapshot.
   *
   * This ALLOCATES - one small object per aircraft - so it is for the QA hook,
   * the minimap and anything else that asks occasionally, not for the frame
   * loop. Everything the frame loop needs (`update`, `blockedBy`, `nearest`)
   * walks the fleet directly and allocates nothing.
   */
  get list(): readonly AircraftInfo[] {
    this.views.length = this.fleet.length;
    for (let i = 0; i < this.fleet.length; i += 1) {
      const craft = this.fleet[i];
      if (!craft) continue;
      this.views[i] = {
        id: craft.id,
        type: craft.type,
        spec: craft.spec,
        x: craft.x,
        y: craft.y,
        z: craft.z,
        yaw: craft.yaw,
        pitch: craft.pitch,
        roll: craft.roll,
        piloted: craft.piloted,
        standId: craft.standId,
        wrecked: craft.wrecked,
      };
    }
    return this.views;
  }

  get stats(): AircraftSystemStats {
    return {
      aircraft: this.fleet.length,
      models: this.batches.size,
      missing: [...this.missing],
      drawn: this.drawn,
      triangles: this.trianglesDrawn,
      measured: this.measured,
    };
  }

  /**
   * The nearest aircraft the player could walk up to.
   *
   * The reach is per type rather than a single constant: standing at a
   * Cessna's wingtip is 5.5 m from its centre and standing at an airliner's is
   * 18 m, so one radius would either refuse the small one or hand over the
   * large one from across the apron. `flyableOnly` is what keeps the airliner
   * out of the player's hands without hiding it from anything else.
   */
  nearest(x: number, z: number, flyableOnly = true): AircraftInfo | null {
    let best: Aircraft | null = null;
    let bestDistance = Infinity;
    for (const craft of this.fleet) {
      if (craft.piloted) continue;
      if (flyableOnly && !craft.spec.flyable) continue;
      if (craft.wrecked) continue;
      const reach = enterRadius(craft.spec);
      const distance = Math.hypot(craft.x - x, craft.z - z);
      if (distance > reach || distance >= bestDistance) continue;
      best = craft;
      bestDistance = distance;
    }
    return best ? this.viewOf(best) : null;
  }

  /** The first free aircraft of a type, whatever the distance. For QA. */
  firstOfType(type: AircraftType): AircraftInfo | null {
    for (const craft of this.fleet) {
      if (craft.type === type && !craft.piloted && !craft.wrecked) return this.viewOf(craft);
    }
    return null;
  }

  byId(id: number): AircraftInfo | null {
    const craft = this.fleet.find((candidate) => candidate.id === id);
    return craft ? this.viewOf(craft) : null;
  }

  private viewOf(craft: Aircraft): AircraftInfo {
    return {
      id: craft.id,
      type: craft.type,
      spec: craft.spec,
      x: craft.x,
      y: craft.y,
      z: craft.z,
      yaw: craft.yaw,
      pitch: craft.pitch,
      roll: craft.roll,
      piloted: craft.piloted,
      standId: craft.standId,
      wrecked: craft.wrecked,
    };
  }

  /** Moves a parked aircraft. Refused while somebody is flying it. */
  place(id: number, x: number, z: number, yaw: number): boolean {
    const craft = this.fleet.find((candidate) => candidate.id === id);
    if (!craft || craft.piloted) return false;
    craft.x = x;
    craft.z = z;
    craft.y = this.options.groundY(x, z);
    craft.yaw = yaw;
    craft.pitch = craft.spec.groundPitch;
    craft.roll = 0;
    craft.standId = null;
    return true;
  }

  takeControl(id: number): AircraftHandle | null {
    const craft = this.fleet.find((candidate) => candidate.id === id);
    if (!craft || craft.piloted || craft.wrecked || !craft.spec.flyable) return null;
    craft.piloted = true;
    return {
      id: craft.id,
      type: craft.type,
      spec: craft.spec,
      setPose: (pose: AircraftPose): void => {
        craft.x = pose.x;
        craft.y = pose.y;
        craft.z = pose.z;
        craft.yaw = pose.yaw;
        craft.pitch = pose.pitch;
        craft.roll = pose.roll;
        craft.power = pose.power;
        craft.wrecked = pose.wrecked;
        craft.standId = null;
      },
      release: (): void => {
        craft.piloted = false;
        craft.power = 0;
      },
    };
  }

  /**
   * True when an oriented footprint would be inside another aircraft.
   *
   * Aircraft are NOT pushed through `CollisionWorld`'s dynamic vehicle set:
   * `Driving` owns `setVehicleSource` for the whole game, and two systems
   * fighting over one slot is a bug waiting for a frame where the car layer
   * happens to run second. Five aircraft is a linear scan, which at this size
   * is faster than any structure that could replace it.
   *
   * `fromX`/`fromZ` is the same CONTAINMENT WAIVER `CollisionWorld.blockedBox`
   * takes, and it has to be here for the same reason. Without it an aeroplane
   * whose footprint already overlaps another one - two spawned on one stand, a
   * wingtip resting over a neighbour's tail - is refused every direction at
   * once and is pinned for ever with no velocity, no impact and no message.
   * Waiving only the aircraft it is ALREADY inside, rather than switching the
   * test off, is what keeps the rest of the fleet solid meanwhile.
   */
  blockedBy(
    x: number,
    z: number,
    yaw: number,
    halfLength: number,
    halfWidth: number,
    bottom: number,
    top: number,
    exclude = -1,
    fromX?: number,
    fromZ?: number,
  ): boolean {
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    for (const craft of this.fleet) {
      if (craft.id === exclude) continue;
      const otherBottom = craft.y;
      const otherTop = craft.y + craft.spec.height;
      if (otherTop <= bottom + 0.02 || otherBottom >= top - 0.02) continue;
      const ofx = -Math.sin(craft.yaw);
      const ofz = -Math.cos(craft.yaw);
      if (
        !obbOverlap(
          x,
          z,
          fx,
          fz,
          halfLength,
          halfWidth,
          craft.x,
          craft.z,
          ofx,
          ofz,
          craft.spec.halfLength,
          craft.spec.halfWidth,
        )
      ) {
        continue;
      }
      if (
        fromX !== undefined &&
        fromZ !== undefined &&
        obbOverlap(
          fromX,
          fromZ,
          fx,
          fz,
          halfLength,
          halfWidth,
          craft.x,
          craft.z,
          ofx,
          ofz,
          craft.spec.halfLength,
          craft.spec.halfWidth,
        )
      ) {
        continue;
      }
      return true;
    }
    return false;
  }

  // -- assets -----------------------------------------------------------------

  /**
   * Downloads and fits every model. Resolves to how many types are drawable.
   *
   * A model that fails to arrive leaves its type in `missing` and its aircraft
   * invisible but still solid, still enterable and still flyable - the same
   * tradeoff `Furnishings` makes. A missing asset must never be able to stop
   * the airport working.
   */
  async load(): Promise<number> {
    const base = this.options.baseUrl ?? '/';
    await Promise.all(
      ALL_AIRCRAFT_TYPES.map(async (type) => {
        const spec = AIRCRAFT[type];
        const model = await this.models.load(type, {
          url: `${base}${spec.modelUrl}`,
          targetHeight: 1,
          timeoutMs: this.options.timeoutMs ?? 20000,
        });
        if (!model || !(model.size.x > 1e-6) || !(model.size.z > 1e-6) || !(model.size.y > 1e-6)) {
          this.missing.push(type);
          return;
        }
        // Model +X is the wing, +Z the fuselage, +Y the fin. Each is taken to
        // the catalogue's real figure on its own - see the header.
        const scaleX = spec.span / model.size.x;
        const scaleY = spec.height / model.size.y;
        const scaleZ = spec.length / model.size.z;
        // What the model was, so the distortion can be read rather than
        // guessed: its own proportions expressed against the real span.
        this.measured[type] = [
          spec.span,
          (model.size.z / model.size.x) * spec.span,
          (model.size.y / model.size.x) * spec.span,
        ];
        const capacity = this.fleet.reduce((n, craft) => n + (craft.type === type ? 1 : 0), 0);
        if (capacity === 0) return;
        const mesh = new InstancedMesh(model.geometry, model.material, capacity);
        mesh.name = `aircraft-${type}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // See the header: the cull is done by not writing the instance.
        mesh.frustumCulled = false;
        mesh.count = 0;
        this.group.add(mesh);
        this.batches.set(type, { mesh, scaleX, scaleY, scaleZ, count: 0 });
        this.trianglesDrawn += model.triangles;
      }),
    );

    if (this.disposed) {
      this.releaseMeshes();
      return 0;
    }
    this.buildPropellers();
    return this.batches.size;
  }

  /**
   * One instanced mesh for every propeller and fan in the world.
   *
   * Three narrow blades rather than a translucent disc: a disc is
   * rotationally symmetric, so it cannot show that it is turning, and the
   * whole point of the mesh is that a running engine looks different from a
   * dead one. Unlit and double-sided, because a 2 mm blade lit properly is
   * invisible from the side.
   */
  private buildPropellers(): void {
    let mounts = 0;
    for (const craft of this.fleet) mounts += craft.spec.propMounts.length;
    if (mounts === 0) return;
    const geometry = buildBladeGeometry();
    const material = new MeshStandardMaterial({
      color: 0x14161a,
      roughness: 0.55,
      metalness: 0.1,
      side: DoubleSide,
    });
    this.owned.push(geometry);
    this.ownedMaterials.push(material);
    const mesh = new InstancedMesh(geometry, material, mounts);
    mesh.name = 'aircraft-propellers';
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.group.add(mesh);
    this.props = mesh;
    this.propCapacity = mounts;
  }

  // -- frame ------------------------------------------------------------------

  /**
   * Spins the propellers and writes the visible instances.
   *
   * `dt` advances the spin; `viewerX`/`viewerZ` are where the camera is. The
   * aircraft the player is flying is always written, whatever the distance,
   * because the chase camera is looking straight at it.
   */
  update(dt: number, viewerX: number, viewerZ: number): void {
    if (this.disposed) return;

    for (const craft of this.fleet) {
      const target = craft.wrecked
        ? 0
        : PROP_IDLE_RATE + (PROP_MAX_RATE - PROP_IDLE_RATE) * clamp01(craft.power);
      craft.spin += (craft.piloted || craft.power > 0 ? target : 0) * dt;
      if (craft.spin > 1e6) craft.spin -= 1e6;
    }

    for (const batch of this.batches.values()) batch.count = 0;
    this.propCount = 0;
    this.drawn = 0;
    if (this.batches.size === 0 && !this.props) return;

    for (const craft of this.fleet) {
      const dx = craft.x - viewerX;
      const dz = craft.z - viewerZ;
      const cull = craft.spec.cullDistance;
      if (!craft.piloted && dx * dx + dz * dz > cull * cull) continue;

      this.basisFor(craft);
      /*
       * Where the MESH origin goes.
       *
       * The flight model rotates about the centre of gravity, and `craft.y`
       * is the contact plane a `gearHeight` vertically below it. The model's
       * own origin is the centre of its footprint, so it has to be placed a
       * `gearHeight` below the centre of gravity ALONG THE BODY'S UP AXIS,
       * not straight down. The two agree exactly while the aircraft is level
       * and differ by half a metre at a ten-degree rotation, which is the
       * difference between a nose that lifts and a whole aeroplane that
       * pivots about its wheels.
       */
      const arm = craft.spec.gearHeight;
      const cgY = craft.y + arm;
      const originX = craft.x - this.axisUp.x * arm;
      const originY = cgY - this.axisUp.y * arm;
      const originZ = craft.z - this.axisUp.z * arm;

      const batch = this.batches.get(craft.type);
      if (batch) {
        // Model +X is the aircraft's LEFT after the half turn, so the first
        // basis column is the negated right vector. See the header.
        this.modelX.set(-this.axisRight.x, -this.axisRight.y, -this.axisRight.z);
        this.matrix.makeBasis(this.modelX, this.axisUp, this.axisForward);
        // `scale` multiplies on the right, so each factor scales the basis
        // column it belongs to: model X by the span, Y by the height, Z by
        // the length.
        this.scaleVector.set(batch.scaleX, batch.scaleY, batch.scaleZ);
        this.matrix.scale(this.scaleVector);
        this.matrix.setPosition(originX, originY, originZ);
        batch.mesh.setMatrixAt(batch.count, this.matrix);
        batch.count += 1;
        this.drawn += 1;
      }
      this.writePropellers(craft, originX, originY, originZ);
    }

    for (const batch of this.batches.values()) {
      batch.mesh.count = batch.count;
      batch.mesh.instanceMatrix.needsUpdate = true;
    }
    if (this.props) {
      this.props.count = this.propCount;
      this.props.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * The aircraft's own axes in world space: right, up and forward, all real.
   *
   * The 180-degree model correction is applied where the instance matrix is
   * built, not here, so the propeller mounts can be read in the frame they
   * were authored in.
   */
  private basisFor(craft: Aircraft): void {
    const cy = Math.cos(craft.yaw);
    const sy = Math.sin(craft.yaw);
    const cp = Math.cos(craft.pitch);
    const sp = Math.sin(craft.pitch);
    const cr = Math.cos(craft.roll);
    const sr = Math.sin(craft.roll);
    const hfx = -sy;
    const hfz = -cy;
    const hrx = cy;
    const hrz = -sy;
    const pux = -hfx * sp;
    const puy = cp;
    const puz = -hfz * sp;
    this.axisForward.set(hfx * cp, sp, hfz * cp);
    this.axisUp.set(pux * cr + hrx * sr, puy * cr, puz * cr + hrz * sr);
    this.axisRight.set(hrx * cr - pux * sr, -puy * sr, hrz * cr - puz * sr);
  }

  /** `originX/Y/Z` is the mesh origin from `update`: the wheels, not the CG. */
  private writePropellers(
    craft: Aircraft,
    originX: number,
    originY: number,
    originZ: number,
  ): void {
    const props = this.props;
    if (!props) return;
    const spinCos = Math.cos(craft.spin);
    const spinSin = Math.sin(craft.spin);

    for (const mount of craft.spec.propMounts) {
      if (this.propCount >= this.propCapacity) return;
      const px =
        originX +
        this.axisForward.x * mount.along +
        this.axisRight.x * mount.side +
        this.axisUp.x * mount.up;
      const py =
        originY +
        this.axisForward.y * mount.along +
        this.axisRight.y * mount.side +
        this.axisUp.y * mount.up;
      const pz =
        originZ +
        this.axisForward.z * mount.along +
        this.axisRight.z * mount.side +
        this.axisUp.z * mount.up;

      // Turn the blade plane about the aircraft's forward axis by `spin`. The
      // blades live in the disc's own X/Y, so this is a 2x2 rotation of the
      // two in-plane axes and needs no quaternion.
      this.bladeX.set(
        this.axisRight.x * spinCos + this.axisUp.x * spinSin,
        this.axisRight.y * spinCos + this.axisUp.y * spinSin,
        this.axisRight.z * spinCos + this.axisUp.z * spinSin,
      );
      this.bladeY.set(
        this.axisUp.x * spinCos - this.axisRight.x * spinSin,
        this.axisUp.y * spinCos - this.axisRight.y * spinSin,
        this.axisUp.z * spinCos - this.axisRight.z * spinSin,
      );
      this.matrix.makeBasis(this.bladeX, this.bladeY, this.axisForward);
      this.scaleVector.set(mount.radius, mount.radius, mount.radius);
      this.matrix.scale(this.scaleVector);
      this.matrix.setPosition(px, py, pz);
      props.setMatrixAt(this.propCount, this.matrix);
      this.propCount += 1;
    }
  }

  private releaseMeshes(): void {
    for (const batch of this.batches.values()) {
      this.group.remove(batch.mesh);
      batch.mesh.dispose();
    }
    this.batches.clear();
    if (this.props) {
      this.group.remove(this.props);
      this.props.dispose();
      this.props = null;
    }
    this.propCapacity = 0;
    for (const geometry of this.owned) geometry.dispose();
    this.owned.length = 0;
    for (const material of this.ownedMaterials) material.dispose();
    this.ownedMaterials.length = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseMeshes();
    this.group.clear();
    this.models.dispose();
  }
}

/**
 * How close the player must be to be offered an aircraft.
 *
 * Its own half diagonal plus 3 m, so the reach always includes standing at a
 * wingtip: 9.4 m for the Cessna and 29 m for the airliner. A single constant
 * would have refused half the fleet or handed over the other half from the
 * next stand along.
 */
export function enterRadius(spec: AircraftSpec): number {
  return Math.hypot(spec.halfLength, spec.halfWidth) + 3;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Plan-view separating-axis test between two oriented boxes. */
function obbOverlap(
  ax: number,
  az: number,
  afx: number,
  afz: number,
  ahl: number,
  ahw: number,
  bx: number,
  bz: number,
  bfx: number,
  bfz: number,
  bhl: number,
  bhw: number,
): boolean {
  const arx = -afz;
  const arz = afx;
  const brx = -bfz;
  const brz = bfx;
  const dx = bx - ax;
  const dz = bz - az;
  if (
    Math.abs(dx * afx + dz * afz) >
    ahl + bhl * Math.abs(bfx * afx + bfz * afz) + bhw * Math.abs(brx * afx + brz * afz)
  ) {
    return false;
  }
  if (
    Math.abs(dx * arx + dz * arz) >
    ahw + bhl * Math.abs(bfx * arx + bfz * arz) + bhw * Math.abs(brx * arx + brz * arz)
  ) {
    return false;
  }
  if (
    Math.abs(dx * bfx + dz * bfz) >
    bhl + ahl * Math.abs(afx * bfx + afz * bfz) + ahw * Math.abs(arx * bfx + arz * bfz)
  ) {
    return false;
  }
  if (
    Math.abs(dx * brx + dz * brz) >
    bhw + ahl * Math.abs(afx * brx + afz * brz) + ahw * Math.abs(arx * brx + arz * brz)
  ) {
    return false;
  }
  return true;
}

/**
 * A three-bladed propeller of unit radius, lying in the X/Y plane with its
 * axis along +Z. Scaled per instance to the mount's real radius.
 */
function buildBladeGeometry(): BufferGeometry {
  const blades = 3;
  const root = 0.14;
  const rootHalf = 0.075;
  const tipHalf = 0.035;
  const positions = new Float32Array(blades * 6 * 3);
  const normals = new Float32Array(blades * 6 * 3);
  let p = 0;
  for (let i = 0; i < blades; i += 1) {
    const angle = (i / blades) * Math.PI * 2;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    // Along the blade, and across it.
    const alongX = ca;
    const alongY = sa;
    const acrossX = -sa;
    const acrossY = ca;
    const corner = (radius: number, half: number, sign: number): [number, number] => [
      alongX * radius + acrossX * half * sign,
      alongY * radius + acrossY * half * sign,
    ];
    const a = corner(root, rootHalf, -1);
    const b = corner(root, rootHalf, 1);
    const c = corner(1, tipHalf, 1);
    const d = corner(1, tipHalf, -1);
    const quad: [number, number][] = [a, b, c, a, c, d];
    for (const [qx, qy] of quad) {
      positions[p] = qx;
      positions[p + 1] = qy;
      positions[p + 2] = 0;
      normals[p] = 0;
      normals[p + 1] = 0;
      normals[p + 2] = 1;
      p += 3;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Exported so a test can assert the stands were filled from the layout. */
export { STAND_FLEET };
