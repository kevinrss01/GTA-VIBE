#!/usr/bin/env node
/**
 * Inspects a .glb without a renderer.
 *
 * Reports the transformed world bounding box, triangle and vertex counts,
 * material and texture counts, and the offset of the pivot from the bottom of
 * the mesh. Generated assets routinely arrive with an arbitrary pivot and an
 * arbitrary scale, so every downloaded model is measured here before anything
 * in the world is allowed to reference it.
 *
 *   node tools/inspect-glb.mjs <file.glb> [--json]
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function parseGlb(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('not a glb file');
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < view.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(buffer.subarray(start, start + length)));
    else if (type === 0x004e4942) bin = buffer.subarray(start, start + length);
    offset = start + length;
  }
  if (!json) throw new Error('glb has no json chunk');
  return { json, bin };
}

function identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

function composeTrs(node) {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function transformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

export function inspectGlb(path) {
  const buffer = readFileSync(path);
  const { json, bin } = parseGlb(buffer);
  const accessors = json.accessors ?? [];
  const meshes = json.meshes ?? [];
  const nodes = json.nodes ?? [];

  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  let triangles = 0;
  let vertices = 0;
  let primitives = 0;
  const invalidTransforms = [];

  const visit = (nodeIndex, parentMatrix) => {
    const node = nodes[nodeIndex];
    if (!node) return;
    const local = composeTrs(node);
    if (local.some((v) => !Number.isFinite(v))) invalidTransforms.push(node.name ?? `node${nodeIndex}`);
    const world = multiply(parentMatrix, local);
    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];
      for (const primitive of mesh?.primitives ?? []) {
        primitives += 1;
        const position = accessors[primitive.attributes?.POSITION];
        if (position?.min && position?.max) {
          vertices += position.count ?? 0;
          // Every corner of the local box, so rotation is accounted for.
          for (let corner = 0; corner < 8; corner += 1) {
            const p = [
              corner & 1 ? position.max[0] : position.min[0],
              corner & 2 ? position.max[1] : position.min[1],
              corner & 4 ? position.max[2] : position.min[2],
            ];
            const w = transformPoint(world, p);
            for (let axis = 0; axis < 3; axis += 1) {
              box.min[axis] = Math.min(box.min[axis], w[axis]);
              box.max[axis] = Math.max(box.max[axis], w[axis]);
            }
          }
        }
        const indices = accessors[primitive.indices];
        const count = indices ? indices.count : (position?.count ?? 0);
        triangles += Math.floor(count / 3);
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };

  const scene = json.scenes?.[json.scene ?? 0];
  for (const root of scene?.nodes ?? nodes.map((_, i) => i)) visit(root, identity());

  const size = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
  let binBytes = bin ? bin.byteLength : 0;
  let bufferBytes = 0;
  for (const buf of json.buffers ?? []) bufferBytes += buf.byteLength ?? 0;

  let accessorBytes = 0;
  for (const accessor of accessors) {
    accessorBytes +=
      (accessor.count ?? 0) *
      (TYPE_COUNTS[accessor.type] ?? 1) *
      (COMPONENT_BYTES[accessor.componentType] ?? 4);
  }

  return {
    file: basename(path),
    fileBytes: buffer.byteLength,
    binBytes,
    bufferBytes,
    accessorBytes,
    triangles,
    vertices,
    primitives,
    meshes: meshes.length,
    materials: (json.materials ?? []).length,
    textures: (json.textures ?? []).length,
    images: (json.images ?? []).length,
    animations: (json.animations ?? []).length,
    skins: (json.skins ?? []).length,
    box: { min: box.min, max: box.max, size },
    /** Distance from the origin to the lowest point. Zero means a base pivot. */
    pivotAboveBottom: -box.min[1],
    /** Horizontal offset of the footprint centre from the origin. */
    pivotOffsetXZ: [(box.min[0] + box.max[0]) / 2, (box.min[2] + box.max[2]) / 2],
    invalidTransforms,
  };
}

const entry = process.argv[2];
if (entry) {
  const report = inspectGlb(entry);
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const f = (n) => (typeof n === 'number' ? n.toFixed(3) : String(n));
    process.stdout.write(
      [
        `${report.file}  ${(report.fileBytes / 1024).toFixed(0)} KiB`,
        `  triangles ${report.triangles}  vertices ${report.vertices}  primitives ${report.primitives}`,
        `  meshes ${report.meshes}  materials ${report.materials}  textures ${report.textures}  images ${report.images}`,
        `  animations ${report.animations}  skins ${report.skins}`,
        `  size  X ${f(report.box.size[0])}  Y ${f(report.box.size[1])}  Z ${f(report.box.size[2])} (model units)`,
        `  min   ${report.box.min.map(f).join(', ')}`,
        `  max   ${report.box.max.map(f).join(', ')}`,
        `  pivot ${f(report.pivotAboveBottom)} above the bottom; XZ offset ${report.pivotOffsetXZ.map(f).join(', ')}`,
        report.invalidTransforms.length
          ? `  INVALID TRANSFORMS: ${report.invalidTransforms.join(', ')}`
          : '  transforms ok',
      ].join('\n') + '\n',
    );
  }
}
