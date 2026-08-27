/**
 * The weapon in the player's hands.
 *
 * Meridian Bay draws no part of the player - no body, no shadow, no arms - and
 * that stays true here: this is the WEAPON only, held where a weapon would be
 * if somebody were holding it. Adding hands would mean adding a first-person
 * body, which is a different decision from "let the player see what they are
 * carrying", and it is not this module's to make.
 *
 * THE ASSETS ARE GENERATED. All four are Tripo text-to-3D models, and two of
 * them - the sidearm and the carbine - are the same files the gun shop already
 * puts in its display case, so a weapon looks the same on the rack as it does
 * in the player's hands. See `docs/weapon-assets.md` for task ids and costs.
 *
 * WHY IT IS NOT PARENTED TO THE CAMERA. Three.js only draws a camera's own
 * children when the camera is itself in the scene graph, which this game's
 * camera is not. The viewmodel is therefore an ordinary scene object whose
 * transform is rewritten from the camera's world matrix every frame. That also
 * makes the sway and the recoil trivial: they are offsets in the camera's own
 * basis rather than a second animated hierarchy.
 *
 * COST: one draw call for whichever weapon is drawn (two thousand triangles at
 * the very most), zero when nothing is equipped, and one shared material per
 * asset. No lights - the muzzle flash is still emissive geometry in `CombatFx`.
 */

import {
  Box3,
  Color,
  Group,
  Mesh,
  Object3D,
  Quaternion,
  Vector3,
  type Material,
  type PerspectiveCamera,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { clamp, damp } from '../core/mathx';
import type { WeaponId } from '../player/PlayerState';

/**
 * How each generated asset has to be turned and sized to sit in a hand.
 *
 * Every Tripo model arrives normalised to 1.0 on its longest axis with a
 * CENTRE pivot, so the length here is the real one in metres and the rotation
 * is whatever puts the muzzle down the camera's forward axis. `yaw` is applied
 * first, then `pitch`, then `roll`; `offset` is in the camera's own basis,
 * (right, up, forward).
 */
export interface ViewmodelSpec {
  readonly url: string;
  /** Real length along the barrel, in metres. */
  readonly length: number;
  readonly yaw: number;
  readonly pitch: number;
  readonly roll: number;
  readonly offset: readonly [number, number, number];
  /** Where the muzzle sits, along the same three axes, in metres. */
  readonly muzzle: readonly [number, number, number];
  /**
   * Optional multiplier over the generated base colour map.
   *
   * A generator reads "blued steel" as the colour blue, and the shotgun came
   * back a bright cobalt that looked like a toy in the hand. Multiplying the
   * map down is an honest correction of a known generation artefact, and it
   * costs nothing at runtime - it is one material colour, not a shader.
   */
  readonly tint?: number | undefined;
}

/**
 * The shipped set.
 *
 * The sidearm and the carbine are `models/shop/*.glb`, generated for the gun
 * shop; the SMG and the shotgun are `models/weapons/*.glb`, generated here.
 * Three of the four are modelled nose-along-Z and the carbine nose-along-X,
 * which is why the yaw differs rather than the whole asset being re-exported.
 *
 * THE LENGTHS ARE FRAMING, NOT PHYSICS. A real 1.12 m carbine held 40 cm from
 * a 62-degree eye fills half the screen and puts its butt inside the near
 * plane; every first-person game shortens and shrinks the held weapon for the
 * same reason. The shop's rack draws the same file at its real world size,
 * where the viewer is metres away and the real size is what reads correctly.
 */
export function defaultViewmodels(baseUrl: string): Readonly<Record<WeaponId, ViewmodelSpec>> {
  return {
    pistol: {
      url: `${baseUrl}models/shop/pistol.glb`,
      length: 0.21,
      yaw: Math.PI,
      pitch: 0,
      roll: 0,
      offset: [0.13, -0.14, 0.4],
      muzzle: [0.13, -0.12, 0.53],
    },
    smg: {
      url: `${baseUrl}models/weapons/smg.glb`,
      length: 0.4,
      yaw: Math.PI,
      pitch: 0,
      roll: 0,
      offset: [0.13, -0.15, 0.46],
      muzzle: [0.13, -0.11, 0.68],
    },
    shotgun: {
      url: `${baseUrl}models/weapons/shotgun.glb`,
      length: 0.6,
      yaw: Math.PI,
      pitch: 0,
      roll: 0,
      offset: [0.13, -0.16, 0.52],
      muzzle: [0.13, -0.12, 0.84],
      // The generator painted "blued steel" cobalt blue. Halving the blue
      // channel and easing the green back turns it into gunmetal again.
      tint: 0xf2e089,
    },
    rifle: {
      // The gun shop's own rack model, turned nose-forward. Its local +X is
      // the butt, so -PI/2 about Y puts the muzzle down the camera's -Z.
      url: `${baseUrl}models/shop/rifle.glb`,
      length: 0.66,
      yaw: -Math.PI / 2,
      pitch: 0,
      roll: 0,
      offset: [0.13, -0.16, 0.54],
      muzzle: [0.13, -0.12, 0.9],
    },
  };
}

/** How far the weapon is pushed back and down when it is being reloaded. */
const RELOAD_DROP = 0.11;
/** How far the whole model kicks back along the barrel per shot. */
const KICK_BACK = 0.045;

interface Entry {
  readonly spec: ViewmodelSpec;
  object: Object3D | null;
  loading: boolean;
  failed: boolean;
}

export class WeaponViewmodel {
  /** Add this to the scene. It holds at most one weapon at a time. */
  readonly group: Object3D;

  private readonly entries = new Map<WeaponId, Entry>();
  private readonly loader = new GLTFLoader();
  private readonly disposables: (Material | { dispose(): void })[] = [];

  private current: WeaponId | null = null;
  private kick = 0;
  private lower = 0;
  private swayX = 0;
  private swayY = 0;
  private disposed = false;

  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private readonly forward = new Vector3();
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly scratch = new Vector3();

  constructor(specs: Readonly<Record<WeaponId, ViewmodelSpec>>) {
    const group = new Group();
    group.name = 'weapon-viewmodel';
    // Held a few tens of centimetres from the eye, well inside the fog and
    // never worth culling against a frustum it is always inside.
    group.frustumCulled = false;
    group.renderOrder = 4;
    this.group = group;
    for (const [id, spec] of Object.entries(specs) as [WeaponId, ViewmodelSpec][]) {
      this.entries.set(id, { spec, object: null, loading: false, failed: false });
    }
  }

  /** The muzzle position in world space, for the flash and the tracer. */
  muzzleWorld(camera: PerspectiveCamera, out: Vector3): Vector3 {
    const entry = this.current ? this.entries.get(this.current) : undefined;
    this.readBasis(camera);
    const m = entry?.spec.muzzle ?? [0.17, -0.13, 0.5];
    out.copy(camera.position);
    out.addScaledVector(this.right, m[0] ?? 0);
    out.addScaledVector(this.up, m[1] ?? 0);
    out.addScaledVector(this.forward, (m[2] ?? 0) - this.kick);
    return out;
  }

  /** True once the equipped weapon's asset is on screen. Diagnostics only. */
  get ready(): boolean {
    const entry = this.current ? this.entries.get(this.current) : undefined;
    return entry?.object !== null && entry?.object !== undefined;
  }

  /** Assets that failed to download. The game carries on without them. */
  get failedCount(): number {
    let n = 0;
    for (const entry of this.entries.values()) if (entry.failed) n += 1;
    return n;
  }

  /** Kicks the model back. Called once per shot, alongside the camera recoil. */
  punch(strength = 1): void {
    this.kick = Math.min(0.09, this.kick + KICK_BACK * strength);
  }

  /**
   * One frame.
   *
   * `equipped` is the weapon in hand, or null for empty hands - which is also
   * what a driving player has, since this game does not fire from a car.
   */
  update(
    dt: number,
    camera: PerspectiveCamera,
    equipped: WeaponId | null,
    options: { reloading: boolean; hidden: boolean; speed: number },
  ): void {
    if (this.disposed) return;

    const wanted = options.hidden ? null : equipped;
    if (wanted !== this.current) {
      this.setCurrent(wanted);
      // A weapon that has just been drawn comes up from below rather than
      // appearing in place.
      if (wanted) this.lower = 1;
    }
    if (wanted) this.ensureLoaded(wanted);

    this.kick = damp(this.kick, 0, 11, dt);
    this.lower = damp(this.lower, options.reloading ? 1 : 0, 9, dt);

    const entry = wanted ? this.entries.get(wanted) : undefined;
    const object = entry?.object ?? null;
    this.group.visible = object !== null;
    if (!object || !entry) return;

    // Sway: the model lags the camera slightly, which is what makes turning
    // feel like swinging something with weight rather than panning a texture.
    this.readBasis(camera);
    const bob = Math.sin(performance.now() * 0.0042) * clamp(options.speed / 6, 0, 1);
    this.swayX = damp(this.swayX, bob * 0.012, 6, dt);
    this.swayY = damp(this.swayY, bob * 0.008, 5, dt);

    const spec = entry.spec;
    const drop = this.lower * RELOAD_DROP;
    this.position.copy(camera.position);
    this.position.addScaledVector(this.right, (spec.offset[0] ?? 0) + this.swayX);
    this.position.addScaledVector(this.up, (spec.offset[1] ?? 0) - drop + this.swayY);
    this.position.addScaledVector(this.forward, (spec.offset[2] ?? 0) - this.kick);
    this.group.position.copy(this.position);

    this.rotation.copy(camera.quaternion);
    this.group.quaternion.copy(this.rotation);
    // Lowering the weapon tips it as well as dropping it.
    this.group.rotateX(-this.lower * 0.5 + this.kick * 1.4);
    this.scratch.set(0, 0, 0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.clear();
    for (const item of this.disposables) item.dispose();
    this.disposables.length = 0;
    this.entries.clear();
  }

  // -- internals ------------------------------------------------------------

  private readBasis(camera: PerspectiveCamera): void {
    this.right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    this.forward.set(0, 0, -1).applyQuaternion(camera.quaternion);
  }

  private setCurrent(id: WeaponId | null): void {
    this.current = id;
    this.group.clear();
    if (!id) return;
    const object = this.entries.get(id)?.object;
    if (object) this.group.add(object);
  }

  private ensureLoaded(id: WeaponId): void {
    const entry = this.entries.get(id);
    if (!entry || entry.object || entry.loading || entry.failed) return;
    entry.loading = true;
    this.loader.load(
      entry.spec.url,
      (gltf) => {
        entry.loading = false;
        if (this.disposed) return;
        entry.object = this.prepare(gltf.scene, entry.spec);
        if (this.current === id) this.setCurrent(id);
      },
      undefined,
      () => {
        // A weapon the player cannot see still fires: the asset is cosmetic.
        entry.loading = false;
        entry.failed = true;
      },
    );
  }

  /**
   * Rescales a normalised generated asset to real metres and re-origins it.
   *
   * Tripo returns a model normalised to 1.0 on its longest axis with a centre
   * pivot and its own node scaling, so the transform is measured rather than
   * trusted - exactly what `ModelLibrary` does for the street furniture.
   */
  private prepare(scene: Object3D, spec: ViewmodelSpec): Object3D {
    const holder = new Group();
    const inner = new Group();
    inner.add(scene);
    inner.rotation.set(spec.pitch, spec.yaw, spec.roll, 'YXZ');
    inner.updateMatrixWorld(true);

    const box = new Box3().setFromObject(inner);
    const size = box.getSize(new Vector3());
    const longest = Math.max(size.x, size.y, size.z, 1e-4);
    const scale = spec.length / longest;
    inner.scale.setScalar(scale);
    inner.updateMatrixWorld(true);

    // Re-measure after scaling and put the model's centre on the holder's
    // origin, so the offsets above mean the same thing for every weapon.
    const scaled = new Box3().setFromObject(inner);
    const centre = scaled.getCenter(new Vector3());
    inner.position.sub(centre);

    holder.add(inner);
    holder.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      // Held a hand's width from the eye: it lights itself from the
      // environment and casts nothing, because a shadow from an object with no
      // arms behind it would be the thing that gives the trick away.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      const material = mesh.material as Material | Material[];
      const list = Array.isArray(material) ? material : [material];
      for (const item of list) {
        if (spec.tint !== undefined) {
          const tinted = item as Material & { color?: Color };
          tinted.color?.setHex(spec.tint).convertSRGBToLinear();
        }
        this.disposables.push(item);
      }
      if (mesh.geometry) this.disposables.push(mesh.geometry);
    });
    return holder;
  }
}
