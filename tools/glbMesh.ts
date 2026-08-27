/**
 * Reads the mesh out of a `.glb` without a renderer.
 *
 * `inspect-glb.mjs` reports what a model claims about itself from its accessor
 * bounds; this reads the actual vertices, which is what the vehicle fitting
 * needs. It exists so the tests can validate every shipped vehicle asset -
 * triangle count, real bounds, the size it fits to in metres, whether it sits
 * on the road - against the same code the game runs, on a machine with no GPU.
 *
 * Only what a Tripo GLB actually contains is supported: one buffer, embedded,
 * with float positions and normals and unsigned indices.
 */

import { readFileSync } from 'node:fs';

const COMPONENT_BYTES: Readonly<Record<number, number>> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
const TYPE_COUNTS: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

interface GltfAccessor {
  readonly bufferView: number;
  readonly byteOffset?: number;
  readonly componentType: number;
  readonly count: number;
  readonly type: string;
}

interface GltfBufferView {
  readonly byteOffset?: number;
  readonly byteLength: number;
  readonly byteStride?: number;
}

interface GltfPrimitive {
  readonly attributes: Record<string, number>;
  readonly indices?: number;
}

interface GltfJson {
  readonly accessors?: GltfAccessor[];
  readonly bufferViews?: GltfBufferView[];
  readonly meshes?: { primitives: GltfPrimitive[] }[];
  readonly materials?: unknown[];
  readonly textures?: unknown[];
  readonly images?: { mimeType?: string; bufferView?: number }[];
  readonly animations?: unknown[];
  readonly skins?: unknown[];
  readonly nodes?: unknown[];
}

export interface GlbMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array | null;
  readonly index: Uint32Array;
  readonly triangles: number;
  readonly vertices: number;
  readonly primitives: number;
  readonly meshes: number;
  readonly materials: number;
  readonly textures: number;
  readonly images: number;
  readonly animations: number;
  readonly skins: number;
  readonly fileBytes: number;
  /** Largest embedded image, in bytes. Stands in for the texture budget. */
  readonly largestImageBytes: number;
}

function parseGlb(buffer: Buffer): { json: GltfJson; bin: Buffer } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('not a glb file');
  let offset = 12;
  let json: GltfJson | null = null;
  let bin: Buffer | null = null;
  while (offset < view.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === 0x4e4f534a) {
      json = JSON.parse(new TextDecoder().decode(buffer.subarray(start, start + length))) as GltfJson;
    } else if (type === 0x004e4942) {
      bin = buffer.subarray(start, start + length);
    }
    offset = start + length;
  }
  if (!json || !bin) throw new Error('glb is missing a chunk');
  return { json, bin };
}

function readAccessor(json: GltfJson, bin: Buffer, index: number): Float64Array {
  const accessor = json.accessors?.[index];
  if (!accessor) throw new Error(`missing accessor ${index}`);
  const view = json.bufferViews?.[accessor.bufferView];
  if (!view) throw new Error(`missing buffer view ${accessor.bufferView}`);
  const components = TYPE_COUNTS[accessor.type] ?? 1;
  const bytes = COMPONENT_BYTES[accessor.componentType] ?? 4;
  const stride = view.byteStride ?? components * bytes;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const out = new Float64Array(accessor.count * components);
  for (let i = 0; i < accessor.count; i += 1) {
    const base = start + i * stride;
    for (let c = 0; c < components; c += 1) {
      const at = base + c * bytes;
      let value: number;
      switch (accessor.componentType) {
        case 5126:
          value = bin.readFloatLE(at);
          break;
        case 5125:
          value = bin.readUInt32LE(at);
          break;
        case 5123:
          value = bin.readUInt16LE(at);
          break;
        case 5121:
          value = bin.readUInt8(at);
          break;
        case 5122:
          value = bin.readInt16LE(at);
          break;
        default:
          value = bin.readInt8(at);
          break;
      }
      out[i * components + c] = value;
    }
  }
  return out;
}

/** Reads the first primitive of the first mesh, which is all a Tripo GLB has. */
export function readGlbMesh(path: string): GlbMesh {
  const buffer = readFileSync(path);
  const { json, bin } = parseGlb(buffer);
  const meshes = json.meshes ?? [];
  const primitive = meshes[0]?.primitives?.[0];
  if (!primitive) throw new Error(`${path} has no mesh`);

  const positionIndex = primitive.attributes.POSITION;
  if (positionIndex === undefined) throw new Error(`${path} has no positions`);
  const positions = Float32Array.from(readAccessor(json, bin, positionIndex));
  const normalIndex = primitive.attributes.NORMAL;
  const normals =
    normalIndex === undefined
      ? new Float32Array(positions.length)
      : Float32Array.from(readAccessor(json, bin, normalIndex));
  const uvIndex = primitive.attributes.TEXCOORD_0;
  const uvs = uvIndex === undefined ? null : Float32Array.from(readAccessor(json, bin, uvIndex));
  const index =
    primitive.indices === undefined
      ? Uint32Array.from({ length: positions.length / 3 }, (_, i) => i)
      : Uint32Array.from(readAccessor(json, bin, primitive.indices));

  let largestImageBytes = 0;
  for (const image of json.images ?? []) {
    const view = image.bufferView === undefined ? null : json.bufferViews?.[image.bufferView];
    if (view) largestImageBytes = Math.max(largestImageBytes, view.byteLength);
  }

  let primitives = 0;
  for (const mesh of meshes) primitives += mesh.primitives.length;

  return {
    positions,
    normals,
    uvs,
    index,
    triangles: index.length / 3,
    vertices: positions.length / 3,
    primitives,
    meshes: meshes.length,
    materials: (json.materials ?? []).length,
    textures: (json.textures ?? []).length,
    images: (json.images ?? []).length,
    animations: (json.animations ?? []).length,
    skins: (json.skins ?? []).length,
    fileBytes: buffer.byteLength,
    largestImageBytes,
  };
}
