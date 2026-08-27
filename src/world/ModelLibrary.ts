/**
 * Loads generated GLB assets and makes them safe to place.
 *
 * Never trust a generated model's transform. The street lamp that came back
 * from the generator is normalised to exactly 1.0 units tall with its pivot at
 * the CENTRE of its bounding box, not at its base, and it carries a node
 * hierarchy with its own scaling. Dropping that into the world at face value
 * puts a 1 m lamp half-buried in the pavement.
 *
 * So everything loaded here is measured, re-scaled to a real-world height, and
 * re-centred so that the origin is the point that touches the ground, with the
 * footprint centred on it. After that a caller can place it with nothing but a
 * position and a rotation.
 */

import {
  Box3,
  BufferGeometry,
  Matrix4,
  Mesh,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Rejects if the promise has not settled in time.
 *
 * Shared with the traffic system's model loader: a generated asset must never
 * be able to hold the loading screen open forever, and there is no reason for
 * two loaders to disagree about that.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out loading ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface LoadedModel {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  /** Measured size after normalisation, in metres. */
  readonly size: Vector3;
  readonly triangles: number;
}

export interface ModelSpec {
  readonly url: string;
  /** Real-world height in metres. The model is scaled uniformly to match. */
  readonly targetHeight: number;
  /** Give up after this long and let the world build without the asset. */
  readonly timeoutMs?: number;
}

/**
 * Flattens a loaded scene into one geometry, baking every node transform, and
 * takes the first material it finds. Generated assets are single-material in
 * practice; if one is not, the extra materials are dropped deliberately rather
 * than silently producing a mesh with the wrong surface.
 */
function flatten(root: Object3D): { geometry: BufferGeometry; material: Material } | null {
  const geometries: BufferGeometry[] = [];
  let material: Material | null = null;

  root.updateMatrixWorld(true);
  root.traverse((child: Object3D) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    // Merging requires a consistent attribute set.
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') geometry.deleteAttribute(name);
    }
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    geometries.push(geometry);
    if (!material) {
      material = Array.isArray(mesh.material)
        ? (mesh.material[0] as Material)
        : (mesh.material as Material);
    }
  });

  if (geometries.length === 0 || !material) return null;
  const merged =
    geometries.length === 1 ? (geometries[0] as BufferGeometry) : mergeGeometries(geometries, false);
  if (!merged) return null;
  if (geometries.length > 1) for (const g of geometries) g.dispose();
  return { geometry: merged, material };
}

export class ModelLibrary {
  private readonly loader = new GLTFLoader();
  private readonly loaded = new Map<string, LoadedModel>();

  /**
   * Loads and normalises one model. Returns null on any failure - a missing
   * generated asset must degrade to the procedural fallback, never break the
   * whole world build.
   */
  async load(id: string, spec: ModelSpec): Promise<LoadedModel | null> {
    const existing = this.loaded.get(id);
    if (existing) return existing;

    try {
      // A generated asset must never be able to hold the game hostage. These
      // files carry multi-megabyte textures, and a slow decode - or a tab the
      // browser has throttled - would otherwise leave the player stuck on the
      // loading screen forever with no way to tell what went wrong.
      const gltf = await withTimeout(
        this.loader.loadAsync(spec.url),
        spec.timeoutMs ?? 15000,
        spec.url,
      );
      const flat = flatten(gltf.scene);
      if (!flat) return null;

      const box = new Box3().setFromBufferAttribute(
        flat.geometry.getAttribute('position') as never,
      );
      const size = new Vector3();
      box.getSize(size);
      if (!(size.y > 1e-6)) {
        flat.geometry.dispose();
        return null;
      }

      // Scale to the real height, then move the origin to the centre of the
      // footprint at ground level.
      const scale = spec.targetHeight / size.y;
      const transform = new Matrix4()
        .makeTranslation(
          -((box.min.x + box.max.x) / 2) * scale,
          -box.min.y * scale,
          -((box.min.z + box.max.z) / 2) * scale,
        )
        .multiply(new Matrix4().makeScale(scale, scale, scale));
      flat.geometry.applyMatrix4(transform);
      flat.geometry.computeBoundingBox();
      flat.geometry.computeBoundingSphere();

      const model: LoadedModel = {
        geometry: flat.geometry,
        material: flat.material,
        size: size.multiplyScalar(scale),
        triangles: (flat.geometry.index?.count ?? flat.geometry.getAttribute('position').count) / 3,
      };
      this.loaded.set(id, model);
      return model;
    } catch (error) {
      // A generated asset that fails to load is a degraded visual, not a crash.
      // eslint-disable-next-line no-console
      console.warn(`[meridian] ${id} unavailable, using the procedural fallback`, error);
      return null;
    }
  }

  get(id: string): LoadedModel | null {
    return this.loaded.get(id) ?? null;
  }

  dispose(): void {
    for (const model of this.loaded.values()) {
      model.geometry.dispose();
      model.material.dispose();
    }
    this.loaded.clear();
  }
}
