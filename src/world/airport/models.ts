/**
 * Generated models for the airport.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   import { loadAirportModels } from './world/airport/models';
 *
 *   // beside the existing `loadStreetPropModels` call, BEFORE `sink.bake`
 *   const airport = await loadAirportModels(import.meta.env.BASE_URL);
 *   for (const [key, parts] of airport.parts) propGeometry.set(key, parts);
 *   // ...bake, then:
 *   engine.scene.add(airport.interior);
 *   // on unload: airport.dispose();
 *
 * ============================================================================
 *
 * Two different jobs, because the two kinds of asset live in different parts
 * of the renderer.
 *
 * The AIRSIDE equipment is street furniture in every way that matters: it
 * stands on the ground, it is placed by a builder, and there are many of each.
 * So it goes through the same route the generated bench does - overwrite the
 * procedural entry in `propGeometry` before the city is baked, and it inherits
 * per-chunk instancing, culling and shadows for nothing. `PropLibrary` still
 * authors a procedural version of every one of them, so a failed download is a
 * plainer tug rather than an empty apron.
 *
 * The TERMINAL INTERIOR models cannot: they arrive with their own PBR material
 * and three textures each, and `GeometrySink.add` may only take geometry under
 * a palette key. They are meshes in a group of their own, exactly as
 * `Furnishings` does for the city's interiors, hung off one group that the
 * caller adds to the scene.
 *
 * ## Fitting
 *
 * Every model arrives normalised into a unit box with a CENTRE pivot, so one
 * dimension is 0.998 and the rest are smaller - and WHICH one differs per
 * model. `ModelLibrary` is asked for a target height of exactly one metre,
 * which puts the origin at the centre of the footprint at floor level and
 * makes the returned `size` the model's proportions; the real size is then one
 * division by whichever axis is known. Fitting a bowser - whose long axis is
 * its LENGTH - by its height would produce a three-storey tanker.
 */

import {
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  type BufferGeometry,
  type Material,
} from 'three';

import { ModelLibrary } from '../ModelLibrary';
import type { PropPart } from '../WorldBuilder';
import type { PropKey } from '../build/types';
import { terminalModelAnchors, type TerminalModelAnchor } from './terminal';

/**
 * What each model is, and how to fit it.
 *
 * `axis` is the dimension `metres` describes. Measured from the meshes: the
 * long axis is the height for the stairs, the cart, the trolley and the sock;
 * it is X for the tug and the ground power unit; it is Z for the desk, the
 * board, the bench, the bowser and the scanner.
 */
interface AirportModel {
  readonly file: string;
  readonly axis: 'x' | 'y' | 'z';
  readonly metres: number;
  /** The model's own forward axis, so it can be turned onto a heading. */
  readonly front: 'x' | '-x' | 'z' | '-z';
}

/** Props: replaced in the prop geometry table before the world is baked. */
const PROP_MODELS: Readonly<Partial<Record<PropKey, AirportModel>>> = {
  airStairs: { file: 'air-stairs', axis: 'y', metres: 3.4, front: '-z' },
  baggageTug: { file: 'baggage-tug', axis: 'x', metres: 2.9, front: '-x' },
  baggageCart: { file: 'baggage-cart', axis: 'y', metres: 1.6, front: '-z' },
  fuelBowser: { file: 'fuel-bowser', axis: 'z', metres: 7.0, front: '-z' },
  gpuCart: { file: 'gpu-cart', axis: 'x', metres: 2.0, front: '-x' },
  windsock: { file: 'windsock', axis: 'y', metres: 6.5, front: '-z' },
};

/** Interior models: meshes in their own group. */
const INTERIOR_MODELS: Readonly<Record<TerminalModelAnchor['model'], AirportModel>> = {
  'checkin-desk': { file: 'checkin-desk', axis: 'z', metres: 4.6, front: '-x' },
  scanner: { file: 'scanner', axis: 'z', metres: 2.4, front: '-z' },
  'flight-board': { file: 'flight-board', axis: 'z', metres: 3.2, front: '-z' },
  trolley: { file: 'trolley', axis: 'y', metres: 1.05, front: '-z' },
  'gate-seats': { file: 'gate-seats', axis: 'z', metres: 3.6, front: '-z' },
};

/**
 * Rotation that turns a model's forward axis onto the props' convention of
 * facing -Z. Solving `rotationY(t) * front == (0, 0, -1)` gives these four.
 */
const FRONT_TURNS: Readonly<Record<AirportModel['front'], number>> = {
  z: Math.PI,
  '-z': 0,
  x: Math.PI / 2,
  '-x': -Math.PI / 2,
};

/** The palette key generated geometry reports itself under, for batching. */
const BATCH_KEY = 'metalDark' as const;

export interface AirportModels {
  /** Prop geometry overrides, to merge into the table before baking. */
  readonly parts: Map<PropKey, PropPart[]>;
  /** Terminal interior meshes. Add to the scene; empty if nothing loaded. */
  readonly interior: Group;
  readonly loaded: readonly string[];
  readonly missing: readonly string[];
  readonly triangles: number;
  dispose(): void;
}

/**
 * Loads everything and returns it ready to place.
 *
 * Nothing here can fail the world build. `ModelLibrary.load` already returns
 * null rather than throwing, and a null model simply leaves its procedural
 * fallback in place or its anchors empty.
 */
export async function loadAirportModels(baseUrl: string): Promise<AirportModels> {
  const library = new ModelLibrary();
  const parts = new Map<PropKey, PropPart[]>();
  const interior = new Group();
  interior.name = 'airport-interior';
  const loaded: string[] = [];
  const missing: string[] = [];
  let triangles = 0;

  /** Loads one model at unit height, then rescales by its known dimension. */
  const fit = async (
    id: string,
    spec: AirportModel,
  ): Promise<{ geometry: BufferGeometry; material: Material } | null> => {
    const model = await library.load(id, {
      url: `${baseUrl}models/airport/${spec.file}.glb`,
      targetHeight: 1,
      timeoutMs: 20000,
    });
    if (!model) {
      missing.push(id);
      return null;
    }
    const proportion = spec.axis === 'x' ? model.size.x : spec.axis === 'y' ? model.size.y : model.size.z;
    if (!(proportion > 1e-6)) {
      missing.push(id);
      return null;
    }
    const scale = spec.metres / proportion;
    const transform = new Matrix4()
      .makeScale(scale, scale, scale)
      .multiply(new Matrix4().makeRotationY(FRONT_TURNS[spec.front]));
    model.geometry.applyMatrix4(transform);
    model.geometry.computeBoundingBox();
    model.geometry.computeBoundingSphere();
    triangles += model.triangles;
    loaded.push(id);
    return { geometry: model.geometry, material: model.material };
  };

  const propEntries = Object.entries(PROP_MODELS) as [PropKey, AirportModel][];
  const interiorEntries = Object.entries(INTERIOR_MODELS) as [
    TerminalModelAnchor['model'],
    AirportModel,
  ][];

  // All of them at once: they are independent, and serialising fourteen
  // downloads makes the slowest one set the whole loading time.
  const propResults = await Promise.all(propEntries.map(([key, spec]) => fit(key, spec)));
  const interiorResults = await Promise.all(interiorEntries.map(([key, spec]) => fit(key, spec)));

  for (let i = 0; i < propEntries.length; i += 1) {
    const entry = propEntries[i];
    const result = propResults[i];
    if (!entry || !result) continue;
    parts.set(entry[0], [{ key: BATCH_KEY, geometry: result.geometry, material: result.material }]);
  }

  const byModel = new Map<TerminalModelAnchor['model'], (typeof interiorResults)[number]>();
  for (let i = 0; i < interiorEntries.length; i += 1) {
    const entry = interiorEntries[i];
    const result = interiorResults[i];
    if (!entry || !result) continue;
    byModel.set(entry[0], result);
  }

  // One InstancedMesh per model, which is at most five draw calls for the
  // whole terminal fit-out.
  const anchors = terminalModelAnchors();
  const dummy = new Object3D();
  for (const [model, result] of byModel) {
    if (!result) continue;
    const mine = anchors.filter((a) => a.model === model);
    if (mine.length === 0) continue;
    const mesh = new InstancedMesh(result.geometry, result.material, mine.length);
    mesh.name = `airport-${model}`;
    for (let i = 0; i < mine.length; i += 1) {
      const anchor = mine[i] as TerminalModelAnchor;
      dummy.position.set(anchor.x, anchor.y, anchor.z);
      dummy.rotation.set(0, anchor.heading, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    interior.add(mesh);
  }

  return {
    parts,
    interior,
    loaded,
    missing,
    triangles,
    dispose(): void {
      interior.traverse((child: Object3D) => {
        const mesh = child as Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
      interior.clear();
      library.dispose();
    },
  };
}
