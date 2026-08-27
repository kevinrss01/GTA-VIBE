/**
 * The stock on show in the gun shop: generated weapons, instanced.
 *
 * A rifle is the one object in this game that procedural boxes cannot fake.
 * A counter, a shelf, a crate and a safe are all boxes and read correctly as
 * boxes; a bolt-action rifle is a thin, articulated silhouette, and six boxes
 * arranged to look like one reads as six boxes. Both models here are Tripo
 * text-to-3D outputs, converted to GLTF and shipped in `public/models/shop`.
 *
 * ## Why these are not world geometry
 *
 * Every builder in `world/build` emits merged triangle soup under a material
 * key and may not create a mesh or a material. A generated GLB carries its own
 * PBR material and textures, so it cannot go through that path at all. This
 * module owns the meshes instead, and takes its positions from
 * `gunStoreAnchors`, which is derived from the same layout the fit-out was
 * built from.
 *
 * ## Cost
 *
 * One `InstancedMesh` per model: two colour draw calls and two shadow draws
 * for the whole display. The rifles are 2,020 triangles each and the pistols
 * 1,090, which is real money at nine and four instances, so the group is
 * hidden entirely once the player is further away than `VISIBLE_RANGE`. They
 * are indoors behind a wall; nobody can see them from the next street, and
 * WebGL has no occlusion culling to work that out on its own.
 */

import {
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  type Material,
  type Object3D,
} from 'three';

import { ModelLibrary } from '../world/ModelLibrary';
import { GUN_SHOP_SIGN, type GunStoreAnchors, type ShopPoint } from '../world/build/interiorProps';

/** Real length of the shipped models, in metres, along their longest axis. */
const RIFLE_LENGTH = 1.12;
const PISTOL_LENGTH = 0.21;

/** Past this the shop's stock is not drawn. It is inside a building. */
export const VISIBLE_RANGE = 42;

/** A model normalised so its ORIGIN is the centre of its bounding box. */
interface CentredModel {
  readonly geometry: import('three').BufferGeometry;
  readonly material: Material;
  /** Uniform scale that takes the loaded model to its real length. */
  readonly scale: number;
  /** Height in metres in the model's own rest orientation, after scaling. */
  readonly height: number;
  readonly triangles: number;
}

export class WeaponDisplay {
  readonly group: Object3D;

  private readonly stock: Group;
  private readonly models = new ModelLibrary();
  private readonly meshes: InstancedMesh[] = [];
  private disposed = false;
  private trianglesDrawn = 0;

  constructor(private readonly baseUrl: string) {
    this.group = new Group();
    this.group.name = 'gun-shop-display';
    // The stock is indoors and culled by distance; the sign is on the façade
    // and is the whole point of being visible from down the street, so it
    // hangs outside that group and is never switched off.
    this.stock = new Group();
    this.stock.name = 'gun-shop-stock';
    this.stock.visible = false;
    this.group.add(this.stock);
  }

  /** Whether the indoor stock is currently drawn. The clerk follows it. */
  get stockVisible(): boolean {
    return this.stock.visible;
  }

  /** Triangles this display puts on screen when it is visible. */
  get triangles(): number {
    return this.trianglesDrawn;
  }

  /**
   * Loads both models and lays the stock out. Resolves to the number of
   * meshes actually built; zero means both downloads failed and the shop is
   * simply short of stock.
   */
  async load(anchors: GunStoreAnchors): Promise<number> {
    const [rifle, pistol] = await Promise.all([
      this.centred('shopRifle', 'models/shop/rifle.glb', RIFLE_LENGTH),
      this.centred('shopPistol', 'models/shop/pistol.glb', PISTOL_LENGTH),
    ]);
    if (this.disposed) return 0;

    // The room's own frame. `uDir` runs along the shopfront, `vDir` deeper in.
    const { uDir, vDir } = anchors;
    // A rotation that turns the model's local +Z to face out of the back wall,
    // i.e. along -v, towards the customer.
    const outYaw = Math.atan2(-vDir.x, -vDir.z);
    // A rotation that turns the model's local +X along +u, for anything laid
    // lengthways along the counter.
    const alongYaw = Math.atan2(-uDir.z, uDir.x);

    let built = 0;
    if (rifle) {
      const matrices: Matrix4[] = [];
      for (let i = 0; i < anchors.rack.length; i += 1) {
        const slot = anchors.rack[i];
        if (!slot) continue;
        /*
         * Standing on its butt plate. The model lies along its own +X with the
         * BUTT at +X, so the quarter turn has to be NEGATIVE: `+PI/2` stands
         * every rifle on its muzzle, which is both wrong and, in a shop,
         * alarming. Verified in the browser, not derived from the axes.
         *
         * A slight alternating lean is what a rack of guns resting against a
         * retaining rail actually looks like.
         */
        const lean = (i % 2 === 0 ? 1 : -1) * 0.028;
        matrices.push(
          new Matrix4()
            .makeTranslation(slot.x, slot.y + RIFLE_LENGTH / 2, slot.z)
            .multiply(new Matrix4().makeRotationY(outYaw + lean))
            .multiply(new Matrix4().makeRotationZ(-Math.PI / 2))
            .multiply(new Matrix4().makeScale(rifle.scale, rifle.scale, rifle.scale)),
        );
      }
      // One laid flat across the counter top, the way a clerk leaves one out.
      // The origin is the middle of the model, so it has to be lifted by half
      // its own height or it sits inside the counter.
      matrices.push(
        new Matrix4()
          .makeTranslation(
            anchors.counterGun.x,
            anchors.counterGun.y + rifle.height / 2,
            anchors.counterGun.z,
          )
          .multiply(new Matrix4().makeRotationY(alongYaw))
          .multiply(new Matrix4().makeScale(rifle.scale, rifle.scale, rifle.scale)),
      );
      built += this.addInstances('gun-shop-rifles', rifle, matrices) ? 1 : 0;
    }

    if (pistol) {
      const matrices = anchors.caseGuns.map((slot: ShopPoint, i: number) =>
        new Matrix4()
          // The pistol model already stands on its magazine base with its
          // barrel along local +Z, so it only needs turning to face the front
          // of the case, with a little splay so four of them are not a row of
          // identical clones. Lifted by half its height for the same reason as
          // the rifle above: these origins are centres, not feet.
          .makeTranslation(slot.x, slot.y + pistol.height / 2, slot.z)
          .multiply(new Matrix4().makeRotationY(outYaw + Math.PI / 2 + (i - 1.5) * 0.06))
          .multiply(new Matrix4().makeScale(pistol.scale, pistol.scale, pistol.scale)),
      );
      built += this.addInstances('gun-shop-pistols', pistol, matrices) ? 1 : 0;
    }

    built += (await this.addSign(anchors)) ? 1 : 0;
    return built;
  }

  /**
   * The projecting shopfront sign, so the shop is a gun shop from the
   * pavement and not just from the inside.
   *
   * Its model is a bracket and a blank panel whose wall plate is at local +Z,
   * so the anchor's heading turns that plate into the façade and the anchor's
   * position has already pushed the model's mid-projection origin half a
   * projection clear of the wall. It is placed by its BASE, which is why it is
   * loaded through the target-height path rather than re-centred like the
   * weapons.
   */
  private async addSign(anchors: GunStoreAnchors): Promise<boolean> {
    const model = await this.models.load('shopSign', {
      url: `${this.baseUrl}models/interiors/shop-sign/model.glb`,
      targetHeight: GUN_SHOP_SIGN.height,
      timeoutMs: 15000,
    });
    if (!model || this.disposed) return false;
    const mesh = new Mesh(model.geometry, model.material);
    mesh.name = 'gun-shop-sign';
    mesh.position.set(anchors.sign.x, anchors.sign.y, anchors.sign.z);
    mesh.rotation.y = anchors.sign.heading;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    this.trianglesDrawn += model.triangles;
    return true;
  }

  /** Draws the stock only while the player is close enough to be in the shop. */
  update(x: number, z: number, anchor: { readonly x: number; readonly z: number }): void {
    if (this.disposed) return;
    const dx = x - anchor.x;
    const dz = z - anchor.z;
    this.stock.visible = dx * dx + dz * dz < VISIBLE_RANGE * VISIBLE_RANGE;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of this.meshes) mesh.dispose();
    this.meshes.length = 0;
    this.stock.clear();
    this.group.clear();
    // The library owns the geometry and material it handed out.
    this.models.dispose();
  }

  private addInstances(name: string, model: CentredModel, matrices: readonly Matrix4[]): boolean {
    if (matrices.length === 0) return false;
    const mesh = new InstancedMesh(model.geometry, model.material, matrices.length);
    mesh.name = name;
    for (let i = 0; i < matrices.length; i += 1) {
      const matrix = matrices[i];
      if (matrix) mesh.setMatrixAt(i, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    this.meshes.push(mesh);
    this.stock.add(mesh);
    this.trianglesDrawn += model.triangles * matrices.length;
    return true;
  }

  /**
   * Loads a generated model and moves its origin to the centre of its own
   * bounding box.
   *
   * `ModelLibrary` normalises to a target HEIGHT with the origin at the centre
   * of the footprint - right for a street lamp, wrong for anything that is
   * going to be rotated onto its side. Re-centring once here means every
   * placement above is "put the middle of it here, turned like this", which is
   * the only way to keep a rack of rotated objects from drifting.
   */
  private async centred(id: string, path: string, length: number): Promise<CentredModel | null> {
    const model = await this.models.load(id, {
      url: `${this.baseUrl}${path}`,
      targetHeight: 1,
      timeoutMs: 15000,
    });
    if (!model) return null;
    model.geometry.translate(0, -model.size.y / 2, 0);
    model.geometry.computeBoundingBox();
    model.geometry.computeBoundingSphere();
    const longest = Math.max(model.size.x, model.size.y, model.size.z);
    if (!(longest > 1e-6)) return null;
    const scale = length / longest;
    return {
      geometry: model.geometry,
      material: model.material,
      scale,
      height: model.size.y * scale,
      triangles: model.triangles,
    };
  }
}
