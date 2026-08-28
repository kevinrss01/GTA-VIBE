/**
 * Rockets: the only round in Meridian Bay that is an object rather than a ray.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   const rockets = new Projectiles({
 *     url: `${BASE_URL}models/weapons/rocket.glb`,
 *     length: 0.62,
 *     probe: (ox, oy, oz, dx, dy, dz, maxT) => nearestHitDistance,
 *     onDetonate: (x, y, z) => explode(x, y, z),
 *     onTrail: (x, y, z) => fx.exhaust(x, y, z),
 *   });
 *   scene.add(rockets.group);
 *   rockets.launch(x, y, z, dx, dy, dz, 46);
 *   rockets.update(dt);          // once a frame
 *   rockets.dispose();
 *
 * ============================================================================
 *
 * WHY THIS IS NOT HITSCAN. Every other weapon here resolves the whole shot in
 * the frame the trigger is pulled, and that is right for them: a 9 mm round
 * crosses this entire city in a fifth of a second, so flight time is below the
 * threshold at which a player could act on it. A rocket at 46 m/s takes most of
 * a second to reach the far side of a junction. That is long enough to watch,
 * long enough to have to lead a moving car, and long enough to regret - which
 * is the whole character of the weapon and cannot be faked with a ray.
 *
 * COLLISION. Swept, not sampled. Each frame the rocket asks `probe` for the
 * nearest thing along the segment it is ABOUT to cross, so a rocket travelling
 * 0.77 m per frame cannot pass through a 0.3 m railing between two samples.
 *
 * COST. One draw call per rocket in the air, and there are at most
 * `MAX_LIVE` of those. The model is downloaded once and cloned; a failed
 * download costs the visible rocket and nothing else - it still flies, still
 * detonates, and still leaves its trail.
 */

import {
  Group,
  Mesh,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
  type Texture,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Rockets in the air at once.
 *
 * The launcher holds one round and takes 3.6 s to reload, so two is already
 * generous; the cap exists so a scripted test firing in a loop cannot grow the
 * pool without bound.
 */
const MAX_LIVE = 4;

/** Seconds a rocket may fly before it gives up and detonates in mid-air. */
const MAX_FLIGHT = 6;

/**
 * Metres a rocket travels before its fuse arms.
 *
 * Nothing is tested for collision inside this distance, which is what stops a
 * rocket detonating on the shoulder that fired it or on the player's own
 * collision cylinder. It is a distance TRAVELLED and not a forward offset on
 * the probe: offsetting the probe leaves an untested gap between where the
 * rocket is and where it looks, and at 46 m/s that gap is wider than a frame's
 * step - a wall half a metre away would have been passed straight through.
 */
const ARMING_DISTANCE = 0.9;

/**
 * Fall, in m/s². Deliberately gentle.
 *
 * A real rocket's motor burns for most of its flight and it barely drops. A
 * full 9.81 would make the launcher a mortar and every shot at anything over
 * thirty metres would land in the road, which reads as the weapon being broken
 * rather than as ballistics.
 */
const GRAVITY = -2.4;

/** Seconds between exhaust puffs along the trail. */
const TRAIL_INTERVAL = 0.022;

export interface ProjectileOptions {
  /** Rocket model. Omit for an invisible - but fully functional - rocket. */
  readonly url?: string | undefined;
  /** Real length of the rocket along its axis, in metres. */
  readonly length?: number | undefined;
  /**
   * Distance to the nearest obstruction along a segment, in metres, or a
   * NEGATIVE number for a clear path. This is the caller's whole world:
   * geometry, terrain, people and vehicles all arrive through it.
   */
  readonly probe: (
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxT: number,
  ) => number;
  /**
   * The rocket arrived somewhere. Everything violent happens in here.
   *
   * `dx/dy/dz` is the unit direction the rocket was travelling on arrival, so
   * a warhead that struck something can push it the way it was going rather
   * than only radially.
   *
   * `contact` is true when the flight ended on a `probe` HIT and false when
   * the fuse simply ran out in mid-air. It is what tells the caller whether
   * the probe result it is holding describes this detonation: the probe that
   * reported the hit is the last one made before this call, with no other
   * rocket stepped in between, which is what makes it safe to read.
   */
  readonly onDetonate: (
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    contact: boolean,
  ) => void;
  /** Called along the flight path so the caller can draw an exhaust trail. */
  readonly onTrail?: ((x: number, y: number, z: number) => void) | undefined;
  /** Called once per launch with the live rocket, so audio can follow it. */
  readonly onLaunch?: ((rocket: RocketHandle) => void) | undefined;
}

/** A rocket in flight, as much of one as the audio layer needs. */
export interface RocketHandle {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly live: boolean;
}

interface Rocket {
  id: number;
  live: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  /** Metres covered since launch, for the fuse. */
  travelled: number;
  trail: number;
  view: Object3D | null;
}

export class Projectiles {
  /** Add this to the SCENE. A rocket is out in the world, not on the camera. */
  readonly group: Group;

  private readonly options: ProjectileOptions;
  private readonly rockets: Rocket[] = [];
  private template: Object3D | null = null;
  /** Clones a rocket can borrow. See `attachView`. */
  private readonly views: Object3D[] = [];
  private loading = false;
  private failed = false;
  private disposed = false;
  private nextId = 1;

  private readonly forward = new Vector3();
  private readonly axis = new Vector3(0, 0, 1);
  private readonly turn = new Quaternion();

  constructor(options: ProjectileOptions) {
    this.options = options;
    this.group = new Group();
    this.group.name = 'projectiles';
  }

  /** True once the rocket model is on screen. Diagnostics and QA. */
  get modelReady(): boolean {
    return this.template !== null;
  }

  get liveCount(): number {
    let n = 0;
    for (const rocket of this.rockets) if (rocket.live) n += 1;
    return n;
  }

  /** Starts the model download. Safe to call repeatedly. */
  preload(): void {
    if (this.template || this.loading || this.failed || !this.options.url) return;
    this.loading = true;
    const loader = new GLTFLoader();
    loader.load(
      this.options.url,
      (gltf) => {
        this.loading = false;
        if (this.disposed) return;
        this.template = normaliseRocket(gltf.scene, this.options.length ?? 0.62);
      },
      undefined,
      () => {
        this.loading = false;
        // A rocket nobody can see still kills whatever it lands on. The game
        // is playable without the asset and says so rather than throwing.
        this.failed = true;
      },
    );
  }

  /**
   * Fires one. `dx/dy/dz` need not be normalised.
   *
   * Returns false when every slot is busy, which the caller can ignore: the
   * round has already been spent by the armoury and a launcher that holds one
   * shell cannot reach the cap in practice.
   */
  launch(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    speed: number,
  ): boolean {
    if (this.disposed) return false;
    this.preload();
    const rocket = this.take();
    if (!rocket) return false;
    const length = Math.hypot(dx, dy, dz) || 1;
    rocket.id = this.nextId++;
    rocket.live = true;
    rocket.x = x;
    rocket.y = y;
    rocket.z = z;
    rocket.vx = (dx / length) * speed;
    rocket.vy = (dy / length) * speed;
    rocket.vz = (dz / length) * speed;
    rocket.age = 0;
    rocket.travelled = 0;
    rocket.trail = 0;
    this.attachView(rocket);
    this.options.onLaunch?.(snapshot(rocket));
    return true;
  }

  update(dt: number): void {
    if (this.disposed || dt <= 0) return;
    for (const rocket of this.rockets) {
      if (!rocket.live) continue;
      rocket.age += dt;

      rocket.vy += GRAVITY * dt;
      const speed = Math.hypot(rocket.vx, rocket.vy, rocket.vz);
      const step = speed * dt;
      if (step > 0 && speed > 0) {
        const dirX = rocket.vx / speed;
        const dirY = rocket.vy / speed;
        const dirZ = rocket.vz / speed;
        /*
         * Everything past the arming distance is tested, and nothing before
         * it, with no gap between the two.
         *
         * `from` is how much of THIS step is still inside the fuse. Testing
         * the whole step only once `travelled` has already passed the
         * threshold sounds equivalent and is not: at 46 m/s a step is 0.77 m,
         * so the rocket clears 0.9 m two steps in and the first probe would
         * start at 1.54 m - leaving [0.9, 1.54] crossed and never looked at.
         */
        const from = Math.max(0, ARMING_DISTANCE - rocket.travelled);
        if (from < step) {
          const reach = step - from;
          const hit = this.options.probe(
            rocket.x + dirX * from,
            rocket.y + dirY * from,
            rocket.z + dirZ * from,
            dirX,
            dirY,
            dirZ,
            reach,
          );
          if (hit >= 0 && hit < reach) {
            const at = from + hit;
            this.detonate(
              rocket,
              rocket.x + dirX * at,
              rocket.y + dirY * at,
              rocket.z + dirZ * at,
              dirX,
              dirY,
              dirZ,
              true,
            );
            continue;
          }
        }
        rocket.x += dirX * step;
        rocket.y += dirY * step;
        rocket.z += dirZ * step;
        rocket.travelled += step;
      }

      if (rocket.age >= MAX_FLIGHT) {
        const spent = Math.hypot(rocket.vx, rocket.vy, rocket.vz) || 1;
        this.detonate(
          rocket,
          rocket.x,
          rocket.y,
          rocket.z,
          rocket.vx / spent,
          rocket.vy / spent,
          rocket.vz / spent,
          false,
        );
        continue;
      }

      rocket.trail += dt;
      while (rocket.trail >= TRAIL_INTERVAL) {
        rocket.trail -= TRAIL_INTERVAL;
        this.options.onTrail?.(rocket.x, rocket.y, rocket.z);
      }

      this.poseView(rocket);
    }
  }

  /** Detonates everything in the air with no effect. Used on respawn. */
  clear(): void {
    for (const rocket of this.rockets) {
      if (!rocket.live) continue;
      rocket.live = false;
      this.detachView(rocket);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.rockets.length = 0;
    this.views.length = 0;
    this.group.clear();
    // The downloaded model is GPU memory: buffers, programs and textures that
    // no amount of dropping the JavaScript reference frees. Clones share all of
    // it with the template, so walking the template once is the whole job.
    if (this.template) releaseTree(this.template);
    this.template = null;
  }

  // -- internals ------------------------------------------------------------

  private take(): Rocket | null {
    for (const rocket of this.rockets) if (!rocket.live) return rocket;
    if (this.rockets.length >= MAX_LIVE) return null;
    const rocket: Rocket = {
      id: 0, live: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      age: 0, travelled: 0, trail: 0, view: null,
    };
    this.rockets.push(rocket);
    return rocket;
  }

  private detonate(
    rocket: Rocket,
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    contact: boolean,
  ): void {
    rocket.live = false;
    rocket.x = x;
    rocket.y = y;
    rocket.z = z;
    this.detachView(rocket);
    this.options.onDetonate(x, y, z, dx, dy, dz, contact);
  }

  /**
   * Gives a rocket its model.
   *
   * POOLED. Every launch used to `clone(true)` the whole loaded scene and then
   * drop the clone on arrival, so the launcher allocated a fresh object graph
   * per shot and left it for the collector - and `MAX_LIVE` is 4, so the pool
   * this replaces it with is at most four clones for the life of the session.
   * The clone shares its geometry and materials with the template, which is
   * why disposal only has to walk the template once.
   */
  private attachView(rocket: Rocket): void {
    if (rocket.view || !this.template) return;
    const view = this.views.pop() ?? this.template.clone(true);
    view.visible = true;
    rocket.view = view;
    this.group.add(view);
    this.poseView(rocket);
  }

  private detachView(rocket: Rocket): void {
    if (!rocket.view) return;
    const view = rocket.view;
    view.visible = false;
    this.group.remove(view);
    if (this.views.length < MAX_LIVE) this.views.push(view);
    rocket.view = null;
  }

  private poseView(rocket: Rocket): void {
    // A rocket that has not been drawn yet - the model landed mid-flight -
    // picks its view up on the next frame rather than never.
    if (!rocket.view) {
      this.attachView(rocket);
      if (!rocket.view) return;
    }
    rocket.view.position.set(rocket.x, rocket.y, rocket.z);
    this.forward.set(rocket.vx, rocket.vy, rocket.vz);
    if (this.forward.lengthSq() > 1e-6) {
      this.forward.normalize();
      this.turn.setFromUnitVectors(this.axis, this.forward);
      rocket.view.quaternion.copy(this.turn);
    }
  }
}

/**
 * Frees the GPU resources under a loaded model.
 *
 * Three.js disposes nothing on its own: dropping the scene graph leaves the
 * vertex buffers, the compiled material and every texture it references
 * resident until the context is lost. Materials and textures are shared freely
 * inside a GLTF, so both are tracked and each is disposed exactly once.
 */
function releaseTree(root: Object3D): void {
  const seenMaterials = new Set<Material>();
  const seenTextures = new Set<Texture>();
  const releaseMaterial = (material: Material): void => {
    if (seenMaterials.has(material)) return;
    seenMaterials.add(material);
    // Every texture-valued slot, whatever the material type calls it. Reading
    // the record rather than a fixed list of names is what makes this survive
    // a model that arrives with, say, a clearcoat map nobody expected.
    for (const value of Object.values(material as unknown as Record<string, unknown>)) {
      const texture = value as Texture | null;
      if (!texture || typeof texture !== 'object') continue;
      if (!(texture as { isTexture?: boolean }).isTexture) continue;
      if (seenTextures.has(texture)) continue;
      seenTextures.add(texture);
      texture.dispose();
    }
    material.dispose();
  };

  root.traverse((child: Object3D) => {
    if (!(child instanceof Mesh)) return;
    const geometry = child.geometry as BufferGeometry | undefined;
    geometry?.dispose();
    const material = child.material as Material | Material[] | undefined;
    if (Array.isArray(material)) for (const one of material) releaseMaterial(one);
    else if (material) releaseMaterial(material);
  });
}

function snapshot(rocket: Rocket): RocketHandle {
  return {
    get id() {
      return rocket.id;
    },
    get x() {
      return rocket.x;
    },
    get y() {
      return rocket.y;
    },
    get z() {
      return rocket.z;
    },
    get live() {
      return rocket.live;
    },
  };
}

/**
 * Turns a generated rocket into one that points down +Z at a real size.
 *
 * Like every Tripo asset it arrives normalised into a unit box with a centre
 * pivot and no promise about which way it faces. Measured by slicing this one
 * along Z: the slab at max-Z is 12 vertices across 8 mm - the point of the
 * warhead - and the slab at min-Z is 239 vertices spanning 0.232, twice the
 * body's width, which is the fin cluster. The nose is therefore ALREADY at +Z
 * and needs no turn; `poseView` aims the model's +Z down the velocity, so the
 * two conventions meet with nothing in between.
 *
 * The wrapper group exists anyway, so that the scale and any future correction
 * live in one place rather than on the loaded scene the caller might reuse.
 */
function normaliseRocket(scene: Object3D, length: number): Object3D {
  const holder = new Group();
  holder.name = 'rocket';
  const scale = length;
  scene.scale.setScalar(scale);
  scene.traverse((child) => {
    child.castShadow = false;
    child.receiveShadow = false;
  });
  holder.add(scene);
  holder.frustumCulled = false;
  return holder;
}
