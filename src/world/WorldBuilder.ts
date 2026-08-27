/**
 * Turns everything the builders emit into a small number of draw calls.
 *
 * Builders emit loose world-space geometry, prop instances, colliders, lights
 * and interaction points without knowing anything about batching. This module
 * collects all of that, buckets it into fixed world chunks, merges each chunk
 * down to one mesh per material, and builds instanced draws for the props. A
 * city of ~120 buildings and ~2000 props ends up in a few hundred draw calls
 * instead of tens of thousands.
 *
 * How coarsely each is chunked is a measured decision rather than a stylistic
 * one; see `CHUNK_SIZE` and `PROP_CHUNK_SIZE` for the numbers behind each.
 */

import {
  BufferAttribute,
  BufferGeometry,
  StaticDrawUsage,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Object3D,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { TRANSPARENT_KEYS, type MaterialKey, type MaterialLibrary } from '../render/materials';
import type {
  BuildStats,
  ColliderBox,
  GeometrySink,
  InteractionPoint,
  LightRequest,
  PropKey,
} from './build/types';

/**
 * Edge length of one world chunk, in metres.
 *
 * Measured, not guessed - twice, in opposite directions. At 96 m the city
 * baked into 24 chunks and 959 draw calls, and submitting those alone cost
 * about 11 ms per frame; widening to 192 m brought that to 7 chunks and ~350.
 *
 * Merging further, into a single city-wide batch per material, was tried after
 * profiling showed draw-call submission dominating: it cut 132 draws and made
 * the frame 1.4 ms SLOWER. The reason is the shadow pass. Chunking is what
 * lets far geometry stop casting (see `setShadowsEnabled`), and pushing all
 * 317 K world triangles through a 2048 shadow map every frame costs far more
 * than the draw calls it saves. Chunk size trades draw calls against shadow
 * and frustum culling, and 192 m is the measured optimum for this city.
 */
export const CHUNK_SIZE = 192;

function chunkKey(x: number, z: number): string {
  return `${Math.floor(x / CHUNK_SIZE)}:${Math.floor(z / CHUNK_SIZE)}`;
}

/**
 * DO NOT enable frustum culling on the prop instances, and do not split them
 * into per-chunk draws to make culling effective. Both were tried and measured.
 *
 * The street lamp is 8,408 triangles across 165 copies - 1.39 M triangles,
 * more than four times the entire rest of the world - so culling it looks like
 * an obvious win, and it does cut a million triangles per frame. It also
 * changes the picture, which is not allowed here.
 *
 * The reason is the sun. It sits at 11 degrees elevation, so shadows are very
 * long, and a caster well outside the shadow camera still throws a shadow into
 * view. `frustumCulled = false` is what keeps those casters rendering into the
 * shadow map. Turning culling on deleted their shadows: measured against the
 * uncalled build, 5.4 per cent of all colour channels changed in the Old
 * Quarter, peaking at 132 levels out of 255. Ranging `castShadow` by distance
 * did the same damage for the same reason.
 *
 * The triangles are not what this scene is short of anyway - see the note in
 * `CHUNK_SIZE`. Cutting a million of them moved the frame time by less than
 * the run-to-run noise.
 */

/**
 * One drawable part of a prop. `material` overrides the palette lookup, which
 * is how a generated asset keeps its own textures.
 */
export interface PropPart {
  readonly key: MaterialKey;
  readonly geometry: BufferGeometry;
  readonly material?: Material | undefined;
}

interface ChunkBucket {
  readonly key: string;
  readonly geometries: Map<MaterialKey, BufferGeometry[]>;
  centreX: number;
  centreZ: number;
  count: number;
}

/**
 * Ensures a geometry can be merged with its neighbours: same attribute set,
 * same index-ness. Geometry arriving without uv or normal data is completed
 * rather than rejected, so a builder can stay simple.
 */
function normalise(geometry: BufferGeometry): BufferGeometry | null {
  const position = geometry.getAttribute('position');
  if (!position || position.count === 0) {
    geometry.dispose();
    return null;
  }
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  if (!geometry.getAttribute('uv')) {
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array(position.count * 2), 2));
  }
  // Drop anything a builder added that would break the merge.
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') geometry.deleteAttribute(name);
  }
  if (!geometry.index) {
    const count = position.count;
    const index = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
    for (let i = 0; i < count; i += 1) index[i] = i;
    geometry.setIndex(new BufferAttribute(index, 1));
  }
  return geometry;
}

/** Collects builder output and can then bake it into scene objects. */
export class WorldSink implements GeometrySink {
  private readonly chunks = new Map<string, ChunkBucket>();
  /**
   * Prop placements for the whole city, bucketed into draws at bake time.
   *
   * Most prop parts become a single InstancedMesh covering the entire city:
   * one draw call no matter how many hundreds of copies it holds. Parts heavy
   * enough to be worth culling are split per chunk instead - see
   * `PROP_CHUNK_TRIANGLE_BUDGET`.
   */
  private readonly props = new Map<PropKey, Matrix4[]>();
  readonly colliders: ColliderBox[] = [];
  readonly lights: LightRequest[] = [];
  readonly interactions: InteractionPoint[] = [];
  readonly stats: BuildStats = {
    geometries: 0,
    triangles: 0,
    instances: 0,
    colliders: 0,
    lights: 0,
  };


  /** Total prop instances currently held, for reporting. */
  get propCount(): number {
    let total = 0;
    for (const list of this.props.values()) total += list.length;
    return total;
  }

  private bucketFor(x: number, z: number): ChunkBucket {
    const key = chunkKey(x, z);
    let bucket = this.chunks.get(key);
    if (!bucket) {
      bucket = { key, geometries: new Map(), centreX: 0, centreZ: 0, count: 0 };
      this.chunks.set(key, bucket);
    }
    bucket.centreX += x;
    bucket.centreZ += z;
    bucket.count += 1;
    return bucket;
  }

  add(key: MaterialKey, geometry: BufferGeometry): void {
    const clean = normalise(geometry);
    if (!clean) return;
    clean.computeBoundingBox();
    const box = clean.boundingBox;
    const cx = box ? (box.min.x + box.max.x) * 0.5 : 0;
    const cz = box ? (box.min.z + box.max.z) * 0.5 : 0;

    const bucket = this.bucketFor(cx, cz);
    const list = bucket.geometries.get(key);
    if (list) list.push(clean);
    else bucket.geometries.set(key, [clean]);

    this.stats.geometries += 1;
    this.stats.triangles += (clean.index?.count ?? 0) / 3;
  }

  instance(prop: PropKey, matrix: Matrix4): void {
    const list = this.props.get(prop);
    if (list) list.push(matrix.clone());
    else this.props.set(prop, [matrix.clone()]);
    this.stats.instances += 1;
  }

  collider(box: ColliderBox): void {
    this.colliders.push(box);
    this.stats.colliders += 1;
  }

  light(request: LightRequest): void {
    this.lights.push(request);
    this.stats.lights += 1;
  }

  interaction(point: InteractionPoint): void {
    this.interactions.push(point);
  }

  /**
   * Merges everything into scene objects.
   *
   * `propGeometry` supplies the shared geometry for each prop type, already
   * split by material. Props whose geometry is missing are skipped rather than
   * throwing, so a partially-built prop library still yields a playable city.
   */
  bake(
    materials: MaterialLibrary,
    propGeometry: ReadonlyMap<PropKey, readonly PropPart[]>,
  ): { group: Group; chunks: WorldChunk[] } {
    const group = new Group();
    group.name = 'city';
    const chunks: WorldChunk[] = [];

    for (const bucket of this.chunks.values()) {
      const chunkGroup = new Group();
      chunkGroup.name = `chunk-${bucket.key}`;
      const owned: BufferGeometry[] = [];
      let hasBackground = false;

      for (const [key, list] of bucket.geometries) {
        const merged = list.length === 1 ? (list[0] as BufferGeometry) : mergeGeometries(list, false);
        if (!merged) continue;
        if (list.length > 1) for (const g of list) g.dispose();

        const mesh = new Mesh(merged, materials.get(key) as Material);
        mesh.name = `${bucket.key}-${key}`;
        // The distant skyline is 400+ m out and the sun's shadow camera reaches
        // 260 m, so it can never darken a pixel - but with `castShadow` on it
        // still pays a full draw in the shadow pass every frame it is near the
        // camera. Excluded for the same reason the sea is.
        const background = key === 'skyline';
        if (background) hasBackground = true;
        mesh.castShadow = !TRANSPARENT_KEYS.has(key) && key !== 'water' && !background;
        // The sea must not receive shadows. It is one plane spanning far beyond
        // the shadow camera, so any sampling at its edge stains the whole bay.
        mesh.receiveShadow = key !== 'water';
        mesh.matrixAutoUpdate = false;
        mesh.updateMatrix();
        chunkGroup.add(mesh);
        owned.push(merged);
      }

      if (chunkGroup.children.length === 0) continue;

      const centreX = bucket.count > 0 ? bucket.centreX / bucket.count : 0;
      const centreZ = bucket.count > 0 ? bucket.centreZ / bucket.count : 0;
      group.add(chunkGroup);
      chunks.push(new WorldChunk(bucket.key, chunkGroup, centreX, centreZ, owned, hasBackground));
    }

    // One instanced draw per prop part for the entire city. Never culled - see
    // the note above the chunk constants.
    const propGroup = new Group();
    propGroup.name = 'props';
    for (const [prop, matrices] of this.props) {
      const parts = propGeometry.get(prop);
      if (!parts || parts.length === 0 || matrices.length === 0) continue;
      for (const part of parts) {
        // A generated GLB brings its own textured material; procedural props
        // use the shared palette.
        const material = part.material ?? (materials.get(part.key) as Material);
        const instanced = new InstancedMesh(part.geometry, material, matrices.length);
        instanced.name = `props-${prop}-${part.key}`;
        for (let i = 0; i < matrices.length; i += 1) {
          instanced.setMatrixAt(i, matrices[i] as Matrix4);
        }
        instanced.instanceMatrix.needsUpdate = true;
        // Written once at bake time and never touched again, so tell the
        // driver it is static; a dynamic hint makes it re-orphan the buffer.
        instanced.instanceMatrix.setUsage(StaticDrawUsage);
        instanced.castShadow = true;
        instanced.receiveShadow = true;
        instanced.frustumCulled = false;
        // The mesh itself never moves - every placement lives in the instance
        // matrices - so the renderer need not recompose its world matrix.
        instanced.matrixAutoUpdate = false;
        instanced.updateMatrix();
        propGroup.add(instanced);
      }
    }
    if (propGroup.children.length > 0) group.add(propGroup);

    return { group, chunks };
  }

  /** Frees anything that was never baked. Safe to call twice. */
  dispose(): void {
    for (const bucket of this.chunks.values()) {
      for (const list of bucket.geometries.values()) for (const g of list) g.dispose();
    }
    this.chunks.clear();
  }
}

/**
 * One baked world cell. Visibility is driven by distance so that the far side
 * of the city stops submitting draw calls once fog has swallowed it; the
 * renderer's own frustum culling handles the rest.
 */
export class WorldChunk {
  readonly id: string;
  readonly group: Group;
  readonly centreX: number;
  readonly centreZ: number;
  private readonly geometries: BufferGeometry[];

  /**
   * True when this chunk holds background geometry such as the distant
   * skyline. Distance culling is measured to a chunk's CENTROID, and the
   * skyline's centroid can be 400 m away while the buildings themselves ring
   * the horizon - so the ordinary visible range would blink the whole far
   * shore out of existence from one corner of the map.
   */
  private readonly background: boolean;

  constructor(
    id: string,
    group: Group,
    centreX: number,
    centreZ: number,
    geometries: BufferGeometry[],
    background = false,
  ) {
    this.id = id;
    this.group = group;
    this.centreX = centreX;
    this.centreZ = centreZ;
    this.geometries = geometries;
    this.background = background;
  }

  distanceTo(x: number, z: number): number {
    return Math.hypot(this.centreX - x, this.centreZ - z);
  }

  setVisible(visible: boolean): void {
    // Background chunks ignore distance culling entirely - see `background`.
    const next = this.background ? true : visible;
    if (this.group.visible !== next) this.group.visible = next;
  }

  private shadowsEnabled = true;

  /**
   * Turns shadow casting off for far chunks, the cheapest useful LOD we have.
   * The traversal only runs when the state actually flips: walking back and
   * forth across the threshold otherwise re-walked every mesh in the chunk
   * several times a second for no change at all.
   */
  setShadowsEnabled(enabled: boolean): void {
    if (this.shadowsEnabled === enabled) return;
    this.shadowsEnabled = enabled;
    this.group.traverse((child: Object3D) => {
      const mesh = child as Mesh;
      if (mesh.isMesh) mesh.castShadow = enabled;
    });
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    this.geometries.length = 0;
    this.group.clear();
  }
}
