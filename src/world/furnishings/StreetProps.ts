/**
 * Generated models for the city's street furniture.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   import { loadStreetPropModels } from './world/furnishings/StreetProps';
 *
 *   // in the boot sequence, beside the existing street-lamp load:
 *   const streetModels = await loadStreetPropModels(import.meta.env.BASE_URL);
 *   for (const [key, parts] of streetModels) propGeometry.set(key, parts);
 *   // ...then sink.bake(materials, propGeometry) exactly as before.
 *
 * ============================================================================
 *
 * This is the same trick `main.ts` already plays with the generated street
 * lamp: `createPropGeometry` authors a procedural version of every prop, and
 * anything that downloads successfully overwrites its entry in the geometry
 * table before the city is baked. The prop stays a single `InstancedMesh` per
 * material key per chunk, so a hundred generated benches still cost one draw
 * call in each chunk that holds them, and they inherit the chunk's distance
 * culling and shadow behaviour for free.
 *
 * ## The two conventions that have to be met
 *
 * `PropLibrary` states them: origin at the BASE of the prop, and the front
 * elevation facing -Z. `ModelLibrary` gives us the first (it re-origins to the
 * centre of the footprint at floor level); the second is a Y rotation baked
 * into the geometry here, derived from the model's own measured forward axis.
 * Getting it wrong points every bus shelter at the building line instead of
 * the road.
 *
 * ## Failure
 *
 * Any model that does not download is simply absent from the returned map, and
 * the procedural massing in `PropLibrary` stands in for it. The city is never
 * short of a bench.
 */

import { ModelLibrary } from '../ModelLibrary';
import { PROP_SPECS } from '../build/PropLibrary';
import type { PropPart } from '../WorldBuilder';
import type { PropKey } from '../build/types';

/**
 * What each generated street prop is, and which way it faces.
 *
 * `height` is the target the model is scaled to. It is the fitted dimension
 * for all of these because a street prop is placed on the ground and read
 * against a human standing next to it, so its height is the measurement that
 * has to be right; the resulting width and depth are recorded back into
 * `PROP_SPECS`, which is what the scatterer spaces and the clearance tests
 * measure.
 *
 * `front` is the model's own forward axis, measured from the mesh: the half of
 * the bounding box with the higher mean vertex height is the back of a bench,
 * and the half with far more vertices is the face of a kiosk.
 */
interface StreetPropModel {
  readonly file: string;
  readonly front: 'x' | '-x' | 'z' | '-z';
}

const MODELS: Readonly<Partial<Record<PropKey, StreetPropModel>>> = {
  bench: { file: 'street-bench', front: '-z' },
  litterBin: { file: 'litter-bin', front: '-z' },
  busShelter: { file: 'bus-shelter', front: '-x' },
  phoneKiosk: { file: 'phone-kiosk', front: 'x' },
  newsStand: { file: 'news-stand', front: 'z' },
};

/**
 * How many files this loader will fetch.
 *
 * Exported so the boot can show REAL download progress: the loading screen
 * counts arrivals against the total, and the total has to come from the
 * manifest rather than from a number typed somewhere else that would rot the
 * first time a prop is added.
 */
export const STREET_PROP_MODEL_COUNT = Object.keys(MODELS).length;

/**
 * Rotation that turns a model's forward axis onto the props' own convention of
 * facing -Z. Solving `rotationY(t) * front == (0, 0, -1)` gives these four and
 * nothing else.
 */
const FRONT_TURNS: Readonly<Record<StreetPropModel['front'], number>> = {
  z: Math.PI,
  '-z': 0,
  x: Math.PI / 2,
  '-x': -Math.PI / 2,
};

/** The material every generated prop reports itself under, for batching. */
const BATCH_KEY = 'metalDark' as const;

export interface StreetPropModels {
  readonly parts: Map<PropKey, PropPart[]>;
  readonly loaded: readonly PropKey[];
  readonly missing: readonly PropKey[];
  readonly triangles: number;
  dispose(): void;
}

/**
 * Downloads every generated street prop. Never rejects: a prop that fails is
 * left to its procedural fallback.
 */
export async function loadStreetPropModels(
  baseUrl = '/',
  timeoutMs = 15000,
): Promise<StreetPropModels> {
  const library = new ModelLibrary();
  const parts = new Map<PropKey, PropPart[]>();
  const loaded: PropKey[] = [];
  const missing: PropKey[] = [];
  let triangles = 0;

  const entries = Object.entries(MODELS) as [PropKey, StreetPropModel][];
  await Promise.all(
    entries.map(async ([key, model]) => {
      const spec = PROP_SPECS[key];
      const result = await library.load(key, {
        url: `${baseUrl}models/street/${model.file}.glb`,
        targetHeight: spec.height,
        timeoutMs,
      });
      if (!result) {
        missing.push(key);
        return;
      }
      const turn = FRONT_TURNS[model.front];
      if (turn !== 0) {
        result.geometry.rotateY(turn);
        result.geometry.computeBoundingBox();
        result.geometry.computeBoundingSphere();
      }
      parts.set(key, [
        { key: BATCH_KEY, geometry: result.geometry, material: result.material },
      ]);
      triangles += result.triangles;
      loaded.push(key);
    }),
  );

  return {
    parts,
    loaded,
    missing,
    triangles,
    dispose(): void {
      library.dispose();
    },
  };
}
