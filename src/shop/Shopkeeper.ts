/**
 * The person behind the counter.
 *
 * The crowd already ships four Tripo-generated, auto-rigged, retargeted
 * characters baked into vertex animation textures (`agents/PedestrianVat.ts`),
 * and one of them standing still playing its idle clip is exactly what a
 * shopkeeper is. Generating a dedicated clerk would have bought a different
 * shirt for forty credits and a second 2 MB download; this reuses the rig,
 * the shader, the material and the already-compiled program, and costs one
 * instanced draw call.
 *
 * The clerk is not part of the crowd: `PedestrianSystem` owns a pool of
 * walking agents on the pavement graph and has no concept of somebody who
 * stands in one place indoors. This is a single instance of the same mesh,
 * placed once and animated on the clock.
 *
 * ## Failure
 *
 * A character that fails to download leaves `ready` false and draws nothing.
 * The shop still works - the counter, the interface and the purchase are all
 * independent of it - so a missing asset is a missing person, not a broken
 * feature.
 */

import { Group, type InstancedMesh, type Object3D } from 'three';

import { createPedestrianVatMesh, type PedestrianVatBundle } from '../agents/PedestrianRig';
import { loadPedestrianVat, type PedestrianVatCharacter } from '../agents/PedestrianVat';

/**
 * Which of the baked characters serves in the shop.
 *
 * Fixed rather than random: the shopkeeper is a specific person in a specific
 * building, and a clerk who changes face between two loads of the same city
 * would be a bug, not variety.
 */
export const SHOPKEEPER_CHARACTER = 'ped-c';

/** Standing height and build, in metres. The rig is authored 1 unit tall. */
const HEIGHT = 1.79;
const GIRTH = 1.02;

export interface ShopkeeperPlacement {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Camera-convention heading: forward is `(-sin h, 0, -cos h)`. */
  readonly heading: number;
}

export class Shopkeeper {
  readonly group: Object3D;

  private readonly bundle: PedestrianVatBundle;
  private readonly mesh: InstancedMesh;
  private character: PedestrianVatCharacter | null = null;
  private placement: ShopkeeperPlacement | null = null;
  private clock = 0;
  private disposed = false;

  constructor() {
    this.group = new Group();
    this.group.name = 'shopkeeper';
    // Capacity one. The bundle is created with placeholder geometry and
    // `count = 0`, so it compiles with the rest of the scene and draws nothing
    // until the character arrives.
    this.bundle = createPedestrianVatMesh(1, 90);
    this.mesh = this.bundle.mesh;
    this.mesh.name = 'shopkeeper-mesh';
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // One stationary instance: a real bounding volume is worth having, and it
    // is recomputed once when the character is installed and placed.
    this.mesh.frustumCulled = true;
    // A near-neutral tint. The albedo already carries the clothing; anything
    // stronger than this turns skin a colour skin is not.
    const tint = this.bundle.tint.array as Float32Array;
    tint[0] = 0.94;
    tint[1] = 0.94;
    tint[2] = 0.97;
    tint[3] = 1;
    this.bundle.tint.needsUpdate = true;
    this.group.add(this.mesh);
  }

  /** True once the baked character is installed and drawing. */
  get ready(): boolean {
    return this.character !== null;
  }

  /**
   * Starts the download. Resolves to false when the character is unavailable,
   * which is a degraded visual rather than an error.
   */
  async load(id: string = SHOPKEEPER_CHARACTER): Promise<boolean> {
    const character = await loadPedestrianVat(id);
    if (this.disposed) {
      character?.dispose();
      return false;
    }
    if (!character) return false;
    this.character = character;
    this.bundle.install(character);
    this.applyPlacement();
    return true;
  }

  /** Puts the clerk on the floor behind the counter, facing the customer. */
  place(placement: ShopkeeperPlacement): void {
    this.placement = placement;
    this.applyPlacement();
  }

  /**
   * Advances the idle clip. The walk cycle is left at zero and the gait blend
   * (`iAnim.z`) at zero, so the shader only ever samples the idle pose.
   */
  update(dt: number): void {
    if (this.disposed || !this.character) return;
    const idle = this.character.idle ?? this.character.walk;
    if (!(idle.duration > 1e-3)) return;
    this.clock += dt;
    const anim = this.bundle.anim.array as Float32Array;
    anim[0] = 0;
    anim[1] = (this.clock / idle.duration) % 1;
    anim[2] = 0;
    anim[3] = 0;
    this.bundle.anim.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.clear();
    this.bundle.dispose();
    this.character?.dispose();
    this.character = null;
  }

  /**
   * Writes the one instance matrix.
   *
   * The layout mirrors `PedestrianSystem.writeMatrix` exactly: a Y rotation
   * scaled by `girth` horizontally and `height` vertically. `Matrix4.elements`
   * is column-major, so index 2 is row 2 of column 0.
   */
  private applyPlacement(): void {
    const at = this.placement;
    if (!at || !this.character) return;
    const c = Math.cos(at.heading);
    const s = Math.sin(at.heading);
    const m = this.mesh.instanceMatrix.array as Float32Array;
    m[0] = c * GIRTH;
    m[1] = 0;
    m[2] = -s * GIRTH;
    m[3] = 0;
    m[4] = 0;
    m[5] = HEIGHT;
    m[6] = 0;
    m[7] = 0;
    m[8] = s * GIRTH;
    m[9] = 0;
    m[10] = c * GIRTH;
    m[11] = 0;
    m[12] = at.x;
    m[13] = at.y;
    m[14] = at.z;
    m[15] = 1;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = 1;
    this.mesh.computeBoundingSphere();
  }
}
