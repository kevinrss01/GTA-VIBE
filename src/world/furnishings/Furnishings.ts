/**
 * Generated furniture for the buildings the player can walk into.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   import { Furnishings } from './world/furnishings/Furnishings';
 *
 *   const furnishings = new Furnishings(plan, import.meta.env.BASE_URL);
 *   engine.scene.add(furnishings.group);
 *   void furnishings.load();                       // off the critical path
 *   furnishings.update(state.x, state.z);          // once per frame
 *   furnishings.dispose();                         // on unload
 *
 * ============================================================================
 *
 * ## Why this is not world geometry
 *
 * The interiors are built by `world/build`, which emits merged triangle soup
 * under a material key and may never create a mesh or a material. A Tripo GLB
 * arrives with its own PBR material and three textures, so it cannot go
 * through that path at all. The builder therefore decides only WHERE each
 * piece stands - `interiorFurnishings(parcel)` - and emits the matching
 * collider; this module owns the meshes and puts them exactly there.
 *
 * ## Fitting
 *
 * Every model arrives normalised into a unit box with a CENTRE pivot, so one
 * dimension is 0.998 and the rest are smaller - and WHICH one differs per
 * model. `ModelLibrary` is asked for a target height of exactly one metre,
 * which puts the origin at the centre of the footprint at floor level and
 * makes the returned `size` the model's proportions; the real size is then one
 * division by whichever axis `FURNISHING_SPECS` says is known. Fitting a sofa
 * whose 0.998 is its LENGTH by its height would produce a sofa two and a half
 * metres tall.
 *
 * ## Cost
 *
 * One `InstancedMesh` per model per interior, hung under a per-interior group
 * that is switched off beyond `VISIBLE_RANGE`. That is the whole of the
 * culling: at most one interior is ever close enough to draw, so the practical
 * cost is a handful of draw calls, and nothing at all while the player is on
 * the street. A single mesh per model across the whole city would have been
 * fewer objects and strictly worse - its bounding sphere would span Meridian
 * Bay, so every plant in every building would be submitted from everywhere.
 *
 * A model that fails to download leaves its anchors empty. The interiors are
 * furnished without it, and the collider the builder emitted stays - the same
 * tradeoff the generated fountain landmark already makes in `main.ts`.
 */

import { Group, InstancedMesh, Matrix4, Object3D } from 'three';

import { ModelLibrary } from '../ModelLibrary';
import type { CityPlan } from '../CityPlan';
import {
  FURNISHING_SPECS,
  interiorFurnishings,
  type Furnishing,
  type FurnishingModel,
  type FurnishingSpec,
} from '../build/interiorProps';

/** Past this an interior's furniture is not drawn. It is inside a building. */
export const VISIBLE_RANGE = 42;

/**
 * Extra rotation that turns a model's own forward axis onto the heading the
 * anchor asks for.
 *
 * Solving `rotationY(t) * front == (-sin yaw, 0, -cos yaw)` for each of the
 * four signed axes gives these four constants and nothing else; they are
 * written out rather than derived at runtime because getting one of them wrong
 * is a whole row of market stalls facing the wall.
 */
const FRONT_TURNS: Readonly<Record<FurnishingSpec['front'], number>> = {
  z: Math.PI,
  '-z': 0,
  x: Math.PI / 2,
  '-x': -Math.PI / 2,
};

/** Where each model's runtime GLB lives, relative to the site root. */
const MODEL_PATHS: Readonly<Record<FurnishingModel, string>> = {
  plant: 'models/shop/plant.glb',
  armchair: 'models/shop/armchair.glb',
  drinksCabinet: 'models/interiors/drinks-cabinet/model.glb',
  bistroChair: 'models/interiors/bistro-chair/model.glb',
  bistroTable: 'models/interiors/bistro-table/model.glb',
  espressoMachine: 'models/interiors/espresso-machine/model.glb',
  produceStall: 'models/interiors/produce-stall/model.glb',
  workbench: 'models/interiors/workbench/model.glb',
  receptionSofa: 'models/interiors/reception-sofa/model.glb',
  stockShelving: 'models/interiors/stock-shelving/model.glb',
  counterTill: 'models/interiors/counter-till/model.glb',
  stallFish: 'models/interiors/stall-fish/model.glb',
  stallButcher: 'models/interiors/stall-butcher/model.glb',
  stallFlowers: 'models/interiors/stall-flowers/model.glb',
  cafeCounter: 'models/interiors/cafe-counter/model.glb',
  vendingMachine: 'models/interiors/vending-machine/model.glb',
};

interface Fitted {
  readonly geometry: import('three').BufferGeometry;
  readonly material: import('three').Material;
  readonly scale: number;
  readonly triangles: number;
}

interface Room {
  readonly group: Group;
  readonly x: number;
  readonly z: number;
}

export interface FurnishingsStats {
  readonly rooms: number;
  readonly pieces: number;
  readonly models: number;
  readonly missing: readonly string[];
  readonly triangles: number;
}

export class Furnishings {
  readonly group: Object3D;

  private readonly models = new ModelLibrary();
  private readonly rooms: Room[] = [];
  private readonly meshes: InstancedMesh[] = [];
  private readonly plan: CityPlan;
  private readonly baseUrl: string;
  private readonly missing: string[] = [];
  private loadedModels = 0;
  private pieces = 0;
  private trianglesPlaced = 0;
  private disposed = false;

  constructor(plan: CityPlan, baseUrl = '/') {
    this.plan = plan;
    this.baseUrl = baseUrl;
    this.group = new Group();
    this.group.name = 'interior-furnishings';
  }

  get stats(): FurnishingsStats {
    return {
      rooms: this.rooms.length,
      pieces: this.pieces,
      models: this.loadedModels,
      missing: [...this.missing],
      triangles: this.trianglesPlaced,
    };
  }

  /**
   * Downloads every model and dresses every interior that wants one. Resolves
   * to the number of pieces actually placed.
   */
  async load(): Promise<number> {
    const ids = Object.keys(MODEL_PATHS) as FurnishingModel[];
    const fitted = new Map<FurnishingModel, Fitted>();

    await Promise.all(
      ids.map(async (id) => {
        const spec = FURNISHING_SPECS[id];
        const model = await this.models.load(id, {
          url: `${this.baseUrl}${MODEL_PATHS[id]}`,
          targetHeight: 1,
          timeoutMs: 15000,
        });
        if (!model) {
          this.missing.push(id);
          return;
        }
        const proportion =
          spec.fit === 'x' ? model.size.x : spec.fit === 'z' ? model.size.z : model.size.y;
        if (!(proportion > 1e-6)) {
          this.missing.push(id);
          return;
        }
        fitted.set(id, {
          geometry: model.geometry,
          material: model.material,
          scale: spec.metres / proportion,
          triangles: model.triangles,
        });
      }),
    );
    if (this.disposed) return 0;
    this.loadedModels = fitted.size;
    if (fitted.size === 0) return 0;

    for (const parcel of this.plan.parcels) {
      const pieces = interiorFurnishings(parcel);
      if (pieces.length === 0) continue;

      const byModel = new Map<FurnishingModel, Matrix4[]>();
      for (const piece of pieces) {
        const model = fitted.get(piece.model);
        if (!model) continue;
        const bucket = byModel.get(piece.model) ?? [];
        bucket.push(matrixFor(piece, model.scale));
        byModel.set(piece.model, bucket);
      }
      if (byModel.size === 0) continue;

      const room = new Group();
      room.name = `furnishings-${parcel.id}`;
      room.visible = false;
      let placed = 0;
      let sumX = 0;
      let sumZ = 0;
      for (const [id, matrices] of byModel) {
        const model = fitted.get(id);
        if (!model) continue;
        const mesh = new InstancedMesh(model.geometry, model.material, matrices.length);
        mesh.name = `furnishing-${id}-${parcel.id}`;
        for (let i = 0; i < matrices.length; i += 1) {
          const matrix = matrices[i];
          if (matrix) mesh.setMatrixAt(i, matrix);
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.computeBoundingSphere();
        this.meshes.push(mesh);
        room.add(mesh);
        placed += matrices.length;
        this.trianglesPlaced += model.triangles * matrices.length;
      }
      if (placed === 0) continue;

      for (const piece of pieces) {
        sumX += piece.x;
        sumZ += piece.z;
      }
      this.pieces += placed;
      this.rooms.push({ group: room, x: sumX / pieces.length, z: sumZ / pieces.length });
      this.group.add(room);
    }
    return this.pieces;
  }

  /** Draws only the interior the player is actually standing in or beside. */
  update(x: number, z: number): void {
    if (this.disposed) return;
    for (const room of this.rooms) {
      const dx = x - room.x;
      const dz = z - room.z;
      room.group.visible = dx * dx + dz * dz < VISIBLE_RANGE * VISIBLE_RANGE;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of this.meshes) mesh.dispose();
    this.meshes.length = 0;
    this.rooms.length = 0;
    this.group.clear();
    this.models.dispose();
  }
}

/**
 * Places one piece: scale it, turn it to face where the anchor says, stand it
 * on the floor (or on a counter top).
 *
 * `piece.yaw` is the CAMERA convention this whole game uses - forward is
 * `(-sin h, 0, -cos h)` - but a model's own forward is whichever local axis
 * `FURNISHING_SPECS.front` names, so the mesh rotation is that heading plus a
 * fixed quarter or half turn. Getting this wrong sits every sofa with its back
 * to the room, which is not obvious from a plan view and very obvious from a
 * doorway.
 */
function matrixFor(piece: Furnishing, scale: number): Matrix4 {
  const turn = FRONT_TURNS[FURNISHING_SPECS[piece.model].front];
  return new Matrix4()
    .makeTranslation(piece.x, piece.y, piece.z)
    .multiply(new Matrix4().makeRotationY(piece.yaw + turn))
    .multiply(new Matrix4().makeScale(scale, scale, scale));
}
