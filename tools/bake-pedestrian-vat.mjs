#!/usr/bin/env node
/**
 * Bakes a Tripo rigged character + its retargeted clips into a vertex
 * animation texture (VAT) the crowd can draw with ONE instanced draw call.
 *
 * WHY THIS EXISTS. The measured budget for Meridian Bay says a draw call costs
 * about 13 microseconds and 200 `SkinnedMesh` pedestrians cost 2.6 ms of pure
 * submission - a third of the frame. Real skinning also needs 16-32 dependent
 * texture fetches per vertex for the bone matrices. Baking the clips offline
 * turns both problems into 2-4 fetches per vertex on ONE `InstancedMesh`.
 *
 * WHAT IT PRODUCES (per character, in `public/models/pedestrians/`):
 *   <id>.json  metadata: counts, clip table, stride, texture layout
 *   <id>.bin   uv + index + VAT position (half float) + VAT normal (rgba8)
 *   <id>.png   the albedo, lifted out of the rig GLB and downscaled
 *
 * TEXTURE LAYOUT. One ROW per vertex, one COLUMN per animation frame, with
 * each clip's first frame duplicated after its last. Frames of one vertex are
 * therefore ADJACENT texels, so hardware linear filtering along x interpolates
 * between frames for free and the shader needs a single fetch per clip. The y
 * coordinate is always sampled at a row centre, so nothing blends between two
 * different vertices.
 *
 * ROOT MOTION. Tripo's presets bake the forward travel into the pose - the
 * `Root.position` track holds two identical keys - and the generator skill
 * forbids `animate_in_place` because it corrupts the bake. So the travel is
 * measured here, as the least-squares slope of the body centroid through the
 * cycle, and subtracted as a linear ramp. That preserves the hip sway a
 * per-frame subtraction would flatten.
 *
 * WHAT REPLACES THE STRIDE. A planted foot only stays planted if the body
 * advances by exactly as much as the foot slides backwards through the pose.
 * One stride constant can only satisfy that if every step is the same length,
 * and Tripo's walk preset's two gait cycles differ by about 4 per cent - worth
 * 57 mm of skating on a 1.75 m person. So the bake emits a TRAVEL CURVE: the
 * cumulative distance at each frame, integrated from whichever foot is on the
 * ground. The runtime inverts it, turning distance walked into a cycle
 * position, which is the same no-slide property `gait.ts` gives the procedural
 * rig - playback rate follows ground speed, never a clock.
 *
 * USAGE
 *   node tools/bake-pedestrian-vat.mjs \
 *     --id ped-a \
 *     --rig  tripo-out/mb-ped-a-rig/.../model.glb \
 *     --clip walk=tripo-out/mb-ped-a-walk/.../model.fbx:24 \
 *     --clip idle=tripo-out/mb-ped-a-idle/.../model.fbx:16 \
 *     --out public/models/pedestrians
 *
 * Re-runnable: it reads only the downloaded provider artifacts and writes only
 * the three runtime files. `--report` prints the validation numbers without
 * writing anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// --- Browser shims FBXLoader touches ----------------------------------------
// FBXLoader only reaches for `window.URL.createObjectURL` when the FBX embeds
// texture blobs, and for a TextureLoader when it references external images.
// Tripo's retarget FBX carries neither, but stubbing both keeps the tool from
// depending on that.
class StubBlob {
  constructor(parts, options) {
    this.parts = parts;
    this.type = options?.type ?? '';
  }
}
globalThis.Blob = globalThis.Blob ?? StubBlob;
globalThis.window = globalThis.window ?? { URL: { createObjectURL: () => 'blob:stub' } };
globalThis.self = globalThis.self ?? globalThis;

const CLAMP_LO = Number(process.env.MB_CLAMP_LO ?? 0.4);
const CLAMP_HI = Number(process.env.MB_CLAMP_HI ?? 1.7);

const THREE = await import('three');
const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');

// --- Argument parsing --------------------------------------------------------

function parseArgs(argv) {
  const args = { clips: [], frames: {}, out: 'public/models/pedestrians', textureSize: 512 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${token} needs a value`);
      i += 1;
      return value;
    };
    if (token === '--id') args.id = next();
    else if (token === '--rig') args.rig = next();
    else if (token === '--out') args.out = next();
    else if (token === '--texture-size') args.textureSize = Number(next());
    else if (token === '--report') args.report = true;
    else if (token === '--min-period') {
      const raw = next();
      const eq = raw.indexOf('=');
      if (eq < 0) throw new Error(`--min-period wants name=seconds, got ${raw}`);
      args.minPeriod = { ...(args.minPeriod ?? {}), [raw.slice(0, eq)]: Number(raw.slice(eq + 1)) };
    }
    else if (token === '--static') {
      // name=start:end, in seconds of the SOURCE clip.
      //
      // For an action that is not locomotion. The whole travel-curve machinery
      // below assumes a looping gait: it fits a linear ramp to the centroid
      // over the cycle and subtracts it, which is exactly right for a walk and
      // catastrophic for a clip that crouches once and holds - the fit reads
      // the crouch as forward travel and slides the character several metres
      // backwards through its own animation. A static clip samples a window of
      // the source, keeps its travel at zero, and skips the analysis entirely.
      const raw = next();
      const eq = raw.indexOf('=');
      if (eq < 0) throw new Error(`--static wants name=start:end, got ${raw}`);
      const name = raw.slice(0, eq);
      const [start, end] = raw.slice(eq + 1).split(':').map(Number);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new Error(`--static wants name=start:end in seconds, got ${raw}`);
      }
      args.static = { ...(args.static ?? {}), [name]: { start, end } };
    }
    else if (token === '--flip-v') args.flipV = true;
    else if (token === '--clip') {
      // name=path[:frames]
      const raw = next();
      const eq = raw.indexOf('=');
      if (eq < 0) throw new Error(`--clip wants name=path[:frames], got ${raw}`);
      const name = raw.slice(0, eq);
      let file = raw.slice(eq + 1);
      let frames = 24;
      const colon = file.lastIndexOf(':');
      if (colon > 2) {
        const tail = file.slice(colon + 1);
        if (/^\d+$/.test(tail)) {
          frames = Number(tail);
          file = file.slice(0, colon);
        }
      }
      args.clips.push({ name, file, frames });
    } else throw new Error(`unknown argument ${token}`);
  }
  if (!args.id) throw new Error('--id is required');
  if (args.clips.length === 0) throw new Error('at least one --clip is required');
  return args;
}

// --- FBX intake --------------------------------------------------------------

const textureStub = {
  load: () => new THREE.Texture(),
  setPath() {
    return this;
  },
  setCrossOrigin() {
    return this;
  },
};

function loadFbx(file) {
  const buffer = fs.readFileSync(file);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const manager = new THREE.LoadingManager();
  for (const ext of ['png', 'jpg', 'jpeg', 'tga', 'bmp', 'webp']) {
    manager.addHandler(new RegExp(`\\.${ext}$`, 'i'), textureStub);
  }
  return new FBXLoader(manager).parse(arrayBuffer, '');
}

/**
 * FBXLoader emits every take twice, under node paths of different depth. The
 * generator skill's integration notes say to keep the SHALLOWEST path; the
 * deep variant binds its tracks incorrectly. Zero-length takes are the FBX's
 * own empty `ArmatureAction`.
 */
function pickClip(root) {
  const usable = root.animations.filter((clip) => clip.duration > 1e-3);
  if (usable.length === 0) throw new Error('FBX carries no non-empty animation');
  usable.sort((a, b) => a.name.split('|').length - b.name.split('|').length);
  return usable[0];
}

function findSkinnedMesh(root) {
  let found = null;
  root.traverse((child) => {
    if (child.isSkinnedMesh && !found) found = child;
  });
  if (!found) throw new Error('FBX carries no SkinnedMesh');
  return found;
}

// --- Vertex welding ----------------------------------------------------------

/**
 * Tripo's FBX geometry arrives fully split - three unique vertices per
 * triangle. The VAT costs one texture row per vertex, so welding identical
 * corners back together is a direct 2-3x saving on the runtime asset.
 */
function weld(geometry) {
  const position = geometry.attributes.position;
  const normal = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  const count = position.count;
  const index = geometry.index ? geometry.index.array : null;

  const map = new Map();
  const remap = new Uint32Array(count);
  const keep = [];
  const q = (value, scale) => Math.round(value * scale);

  for (let i = 0; i < count; i += 1) {
    const key =
      `${q(position.getX(i), 1e5)},${q(position.getY(i), 1e5)},${q(position.getZ(i), 1e5)},` +
      `${q(normal.getX(i), 1e3)},${q(normal.getY(i), 1e3)},${q(normal.getZ(i), 1e3)},` +
      `${uv ? `${q(uv.getX(i), 1e5)},${q(uv.getY(i), 1e5)}` : ''}`;
    const existing = map.get(key);
    if (existing === undefined) {
      const slot = keep.length;
      map.set(key, slot);
      keep.push(i);
      remap[i] = slot;
    } else {
      remap[i] = existing;
    }
  }

  const sourceIndices = index ?? Uint32Array.from({ length: count }, (_, i) => i);
  const outIndex = new Uint32Array(sourceIndices.length);
  for (let i = 0; i < sourceIndices.length; i += 1) outIndex[i] = remap[sourceIndices[i]];

  return { keep, index: outIndex, sourceCount: count };
}

// --- CPU skinning ------------------------------------------------------------

const _skinIndex = new THREE.Vector4();
const _skinWeight = new THREE.Vector4();
const _boneMatrix = new THREE.Matrix4();
const _skinMatrix = new THREE.Matrix4();

/**
 * The blended skinning matrix for one vertex, in the mesh's local space.
 * This mirrors `SkinnedMesh.applyBoneTransform` exactly, but returns the
 * matrix so the same transform can be applied to the normal as well.
 */
function skinMatrixFor(mesh, vertexIndex, target) {
  const geometry = mesh.geometry;
  const skeleton = mesh.skeleton;
  _skinIndex.fromBufferAttribute(geometry.attributes.skinIndex, vertexIndex);
  _skinWeight.fromBufferAttribute(geometry.attributes.skinWeight, vertexIndex);

  const elements = target.elements;
  for (let i = 0; i < 16; i += 1) elements[i] = 0;

  for (let i = 0; i < 4; i += 1) {
    const weight = _skinWeight.getComponent(i);
    if (weight === 0) continue;
    const boneIndex = _skinIndex.getComponent(i);
    const bone = skeleton.bones[boneIndex];
    if (!bone) continue;
    _boneMatrix.multiplyMatrices(bone.matrixWorld, skeleton.boneInverses[boneIndex]);
    for (let e = 0; e < 16; e += 1) elements[e] += _boneMatrix.elements[e] * weight;
  }

  // bindMatrixInverse * skin * bindMatrix, the same sandwich the GPU path uses.
  _skinMatrix.multiplyMatrices(target, mesh.bindMatrix);
  target.multiplyMatrices(mesh.bindMatrixInverse, _skinMatrix);
  return target;
}

// --- GLB texture extraction --------------------------------------------------

/** Pulls the first embedded image out of a GLB without a full glTF parse. */
function extractGlbImage(file) {
  const data = fs.readFileSync(file);
  if (data.readUInt32LE(0) !== 0x46546c67) throw new Error(`${file} is not a GLB`);
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset + 8 <= data.length) {
    const length = data.readUInt32LE(offset);
    const type = data.readUInt32LE(offset + 4);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body));
    else if (type === 0x004e4942) bin = body;
    offset += 8 + length + ((4 - (length % 4)) % 4) * 0;
    offset += (4 - (offset % 4)) % 4;
  }
  if (!json?.images?.length || !bin) return null;
  // Tripo rig GLBs carry several images and the NORMAL MAP is images[0], so
  // follow the material's base-colour reference rather than taking the first.
  let source = 0;
  const base = json.materials?.[0]?.pbrMetallicRoughness?.baseColorTexture?.index;
  if (base !== undefined) {
    const texture = json.textures?.[base];
    if (texture?.source !== undefined) source = texture.source;
  }
  const image = json.images[source];
  if (image?.bufferView === undefined) return null;
  const view = json.bufferViews[image.bufferView];
  const start = view.byteOffset ?? 0;
  return {
    mime: image.mimeType ?? 'image/png',
    data: bin.subarray(start, start + view.byteLength),
  };
}

// --- Half float --------------------------------------------------------------

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);

/** IEEE 754 binary16, round-to-nearest. Values here are all well inside range. */
function toHalf(value) {
  _f32[0] = value;
  const bits = _u32[0];
  const sign = (bits >>> 16) & 0x8000;
  let exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;
  if (exponent === 255) return sign | 0x7c00 | (mantissa ? 0x200 : 0);
  exponent -= 127 - 15;
  if (exponent >= 31) return sign | 0x7c00;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    mantissa |= 0x800000;
    const shift = 14 - exponent;
    const half = (mantissa + (1 << (shift - 1))) >>> shift;
    return sign | half;
  }
  const rounded = mantissa + 0x1000;
  if (rounded & 0x800000) {
    exponent += 1;
    if (exponent >= 31) return sign | 0x7c00;
    return sign | (exponent << 10);
  }
  return sign | (exponent << 10) | (rounded >>> 13);
}

// --- The bake ----------------------------------------------------------------

/**
 * Skins the mesh at each of `times`.
 *
 * `step` samples every nth welded vertex, which is how the period search
 * affords hundreds of candidate poses. Each frame also records the horizontal
 * centroid, because Tripo's forward travel is NOT on the `Root` bone - that
 * track holds two identical keys - so the body's own centroid is the only
 * reliable measure of how far the clip walks.
 */
function sampleClip(root, mesh, clip, times, welded, step = 1) {
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.play();

  const indices = [];
  for (let v = 0; v < welded.keep.length; v += step) indices.push(welded.keep[v]);
  const vertexCount = indices.length;

  const positions = [];
  const normals = [];
  const centroids = [];
  const bones = {};

  const matrix = new THREE.Matrix4();
  const normalMatrix = new THREE.Matrix3();
  const meshNormalMatrix = new THREE.Matrix3().setFromMatrix4(mesh.matrixWorld);
  const vector = new THREE.Vector3();
  const geometry = mesh.geometry;

  for (const time of times) {
    mixer.setTime(0);
    mixer.setTime(time);
    root.updateMatrixWorld(true);

    const framePositions = new Float32Array(vertexCount * 3);
    const frameNormals = new Float32Array(vertexCount * 3);
    let sumX = 0;
    let sumZ = 0;
    for (let v = 0; v < vertexCount; v += 1) {
      const source = indices[v];
      skinMatrixFor(mesh, source, matrix);
      vector.fromBufferAttribute(geometry.attributes.position, source).applyMatrix4(matrix);
      // The mesh may sit under a transformed Armature node; bake that in too.
      vector.applyMatrix4(mesh.matrixWorld);
      framePositions[v * 3] = vector.x;
      framePositions[v * 3 + 1] = vector.y;
      framePositions[v * 3 + 2] = vector.z;
      sumX += vector.x;
      sumZ += vector.z;

      normalMatrix.setFromMatrix4(matrix);
      vector.fromBufferAttribute(geometry.attributes.normal, source).applyMatrix3(normalMatrix);
      vector.applyMatrix3(meshNormalMatrix).normalize();
      frameNormals[v * 3] = vector.x;
      frameNormals[v * 3 + 1] = vector.y;
      frameNormals[v * 3 + 2] = vector.z;
    }
    positions.push(framePositions);
    normals.push(frameNormals);
    centroids.push(new THREE.Vector3(sumX / vertexCount, 0, sumZ / vertexCount));

    // The feet are for the travel measurement; the right forearm and hand are
    // for the weapon the runtime puts in that hand. Both go through the same
    // list so they get the same in-place conversion, yaw, scale and lift the
    // vertices do - a hand track in a different space to the mesh would put
    // the pistol somewhere near the officer rather than in their grip.
    for (const name of ['L_Foot', 'R_Foot', 'L_ToeBase', 'R_ToeBase', 'R_Forearm', 'R_Hand']) {
      const bone = root.getObjectByName(name);
      if (!bone) continue;
      (bones[name] ??= []).push(new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld));
    }
  }

  action.stop();
  mixer.uncacheClip(clip);
  return { positions, normals, centroids, bones };
}

/**
 * How far each foot's ground contact slides per frame, and the worst slide a
 * viewer would see over a whole contact.
 *
 * A vertex low enough to be touching the ground at BOTH ends of a frame
 * interval must translate backwards by exactly the distance the body moved
 * forwards - that is what "not sliding" means. The median over such vertices
 * is that foot's contact displacement; a run of consecutive frames where it is
 * defined is one footfall, and the spread of the accumulated difference from
 * the playback rate over that run is the slide.
 *
 * Two earlier estimators were wrong and are worth recording. The toe BONE
 * loses 10 per cent of the stride, because the foot pivots under it through a
 * heel-to-toe roll. The mean of the lowest band of sole vertices loses 24 per
 * cent, because the band itself slides from heel to toe as the foot rolls -
 * the set changes even though its members do not move.
 */
function measureContact(positions, footTags) {
  const frames = positions.length;
  let ground = Infinity;
  for (const frame of positions) {
    for (const side of footTags) {
      for (const v of side) ground = Math.min(ground, frame[v * 3 + 1]);
    }
  }
  // 2 cm on a one-unit figure, which is 3.5 cm on a 1.75 m person: generous
  // enough to catch a stance foot that the retarget leaves a shade off the
  // floor, tight enough to exclude a swinging one.
  const ceiling = ground + 0.02;

  const perFoot = footTags.map((members) => {
    const steps = new Array(frames).fill(null);
    for (let f = 0; f < frames; f += 1) {
      const here = positions[f];
      const there = positions[(f + 1) % frames];
      const deltas = [];
      for (const v of members) {
        if (here[v * 3 + 1] > ceiling || there[v * 3 + 1] > ceiling) continue;
        deltas.push(there[v * 3 + 2] - here[v * 3 + 2]);
      }
      if (deltas.length < 5) continue;
      deltas.sort((a, b) => a - b);
      const median = deltas[deltas.length >> 1];
      // A foot that is genuinely on the ground can only travel BACKWARDS
      // through the pose. A forward median means the search caught a foot on
      // its way down at heel strike, whose sole grazes the ceiling while it is
      // still swinging; counting it would invent slide that is not there.
      if (median < 0) continue;
      steps[f] = median;
    }
    return steps;
  });

  return { ground, ceiling, perFoot };
}

/**
 * The slide a VIEWER would see: the horizontal excursion of an individual sole
 * vertex over one footfall, once the travel curve has been subtracted.
 *
 * Harsher than the median-over-contact-points figure the curve is fitted to,
 * because it also catches the part of the shoe that rotates through a
 * heel-to-toe roll. It is the number worth quoting, so it is the one reported
 * and the one `tests/pedestrianVat.test.ts` guards.
 */
function vertexSlide(positions, footTags, curve) {
  const frames = positions.length;
  // A walk lifts each foot for most of the cycle, so a run longer than half of
  // it has merged two footfalls. A clip that does not travel - an idle - keeps
  // both feet down throughout, and that whole stretch is one footfall.
  const longest = curve[frames] > 0.05 ? frames * 0.45 : frames;
  const excursions = [];
  for (const members of footTags) {
    for (const v of members) {
      let ground = Infinity;
      for (const frame of positions) ground = Math.min(ground, frame[v * 3 + 1]);
      let run = [];
      const flush = () => {
        if (run.length >= frames * 0.08 && run.length <= longest) {
          excursions.push(Math.max(...run) - Math.min(...run));
        }
        run = [];
      };
      for (let f = 0; f < frames; f += 1) {
        const frame = positions[f];
        if (frame[v * 3 + 1] < ground + 0.008) run.push(frame[v * 3 + 2] - curve[f]);
        else flush();
      }
      flush();
    }
  }
  excursions.sort((a, b) => a - b);
  const at = (q) =>
    excursions[Math.min(excursions.length - 1, Math.floor(excursions.length * q))] ?? 0;
  return { count: excursions.length, median: at(0.5), p90: at(0.9), worst: at(0.999) };
}

/**
 * Worst slide of a planted foot when the clip is played back at `ratePerFrame`
 * of forward travel. This is the number the bake is judged on: it is exactly
 * what skating looks like.
 */
function slipOf(contact, rate) {
  const frames = contact.perFoot[0].length;
  const rateAt = (f) => (typeof rate === 'number' ? rate : rate[f]);
  let worst = 0;
  for (const steps of contact.perFoot) {
    let drift = 0;
    let min = Infinity;
    let max = -Infinity;
    let length = 0;
    const flush = () => {
      if (length >= 3) worst = Math.max(worst, max - min);
      drift = 0;
      min = Infinity;
      max = -Infinity;
      length = 0;
    };
    // Two passes so a footfall spanning the loop seam is seen whole.
    for (let f = 0; f < frames * 2; f += 1) {
      const step = steps[f % frames];
      if (step === null) {
        flush();
        continue;
      }
      min = Math.min(min, drift);
      max = Math.max(max, drift);
      drift += step - rateAt(f % frames);
      length += 1;
      if (length > frames) flush();
    }
    flush();
  }
  return worst;
}

/** RMS distance between two centroid-relative poses. */
function poseError(a, b, ca, cb) {
  let error = 0;
  for (let i = 0; i < a.length; i += 3) {
    const dx = a[i] - ca.x - (b[i] - cb.x);
    const dy = a[i + 1] - b[i + 1];
    const dz = a[i + 2] - ca.z - (b[i + 2] - cb.z);
    error += dx * dx + dy * dy + dz * dz;
  }
  return Math.sqrt(error / (a.length / 3));
}

/**
 * Shortest loop period of a cyclic clip.
 *
 * Tripo's `preset:biped:walk` runs 2.333 s, which is TWO gait cycles; its
 * `preset:biped:idle` runs 12.267 s. Baking a whole clip when a shorter loop
 * exists multiplies the texture for no extra motion, so the period is the
 * smallest T for which pose(t) and pose(t + T) agree once the horizontal
 * travel is taken out. Every candidate is scored on a subsampled mesh, then
 * the winner is re-scored on the full one.
 *
 * `tolerance` is in model units where the body is about 1.0 tall, so 0.012 is
 * just over a centimetre on a 1 m figure - below what a viewer can see popping
 * at a loop seam.
 */
function findPeriod(root, mesh, clip, welded, { tolerance = 0.012, minPeriod = 0.7 } = {}) {
  const duration = clip.duration;
  const probes = 6;
  const step = Math.max(1, Math.floor(welded.keep.length / 260));

  const score = (period, vertexStep) => {
    const times = [];
    for (let i = 0; i < probes; i += 1) times.push((i / probes) * period);
    for (let i = 0; i < probes; i += 1) times.push(period + (i / probes) * period);
    const s = sampleClip(root, mesh, clip, times, welded, vertexStep);
    let worst = 0;
    for (let i = 0; i < probes; i += 1) {
      worst = Math.max(
        worst,
        poseError(s.positions[i], s.positions[i + probes], s.centroids[i], s.centroids[i + probes]),
      );
    }
    return worst;
  };

  // A fine grid finds sub-loops inside a long idle; the exact fractions of the
  // clip length are added because a preset that IS periodic is periodic at
  // those, and hitting one 1 per cent short leaves a visible pop at the seam.
  const candidates = new Set();
  for (let period = minPeriod; period <= Math.min(duration, 6) + 1e-6; period += 0.05) {
    candidates.add(Number(period.toFixed(3)));
  }
  for (const divisor of [4, 3, 2]) {
    const period = duration / divisor;
    if (period >= minPeriod) candidates.add(Number(period.toFixed(3)));
  }
  const ordered = [...candidates].sort((a, b) => a - b);

  for (const period of ordered) {
    if (score(period, step) >= tolerance) continue;
    // Refine to 5 ms around the first acceptable candidate, at full resolution.
    let best = { period, error: score(period, 1) };
    for (let t = period - 0.05; t <= period + 0.05 + 1e-9; t += 0.005) {
      if (t < minPeriod) continue;
      const error = score(t, 1);
      if (error < best.error) best = { period: t, error };
    }
    return best;
  }

  // Nothing shorter loops cleanly, so use the clip itself: whatever else it
  // is, a clip always loops perfectly at its own duration.
  return { period: duration, error: score(duration, 1) };
}

/**
 * Per-frame right-hand and forearm positions, rounded, or null when the rig
 * did not carry those bones.
 *
 * Rounded to a tenth of a millimetre on a 1.75 m person, which keeps the JSON
 * small and is two orders of magnitude finer than anything a player can see in
 * the position of a pistol.
 */
function handTrack(bones, frames) {
  const hand = bones['R_Hand'];
  const forearm = bones['R_Forearm'];
  if (!hand || !forearm || hand.length < frames || forearm.length < frames) return null;
  const round = (v) => [
    Number(v.x.toFixed(5)),
    Number(v.y.toFixed(5)),
    Number(v.z.toFixed(5)),
  ];
  return {
    hand: hand.slice(0, frames).map(round),
    forearm: forearm.slice(0, frames).map(round),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ---- intake -------------------------------------------------------------
  const loaded = args.clips.map((spec) => {
    const root = loadFbx(spec.file);
    const mesh = findSkinnedMesh(root);
    const clip = pickClip(root);
    return { ...spec, root, mesh, clip };
  });

  const primary = loaded[0];
  const welded = weld(primary.mesh.geometry);
  const vertexCount = welded.keep.length;
  for (const entry of loaded) {
    if (entry.mesh.geometry.attributes.position.count !== welded.sourceCount) {
      throw new Error(`${entry.name} has a different mesh from ${primary.name}`);
    }
  }

  console.log(`[${args.id}] source verts ${welded.sourceCount} -> welded ${vertexCount}`);
  console.log(`[${args.id}] triangles ${welded.index.length / 3}`);

  // Which welded vertices belong to which foot, by dominant skin weight. Used
  // only to find the sole's contact patch when measuring travel.
  {
    const skeleton = primary.mesh.skeleton;
    const skinIndex = primary.mesh.geometry.attributes.skinIndex;
    const skinWeight = primary.mesh.geometry.attributes.skinWeight;
    const sideOf = (bone) => {
      if (!bone) return -1;
      if (/^L_(Foot|ToeBase)/.test(bone.name)) return 0;
      if (/^R_(Foot|ToeBase)/.test(bone.name)) return 1;
      return -1;
    };
    const tags = [[], []];
    for (let v = 0; v < vertexCount; v += 1) {
      const source = welded.keep[v];
      const weights = [0, 0];
      for (let i = 0; i < 4; i += 1) {
        const side = sideOf(skeleton.bones[skinIndex.getComponent(source, i)]);
        if (side >= 0) weights[side] += skinWeight.getComponent(source, i);
      }
      if (weights[0] > 0.6) tags[0].push(v);
      else if (weights[1] > 0.6) tags[1].push(v);
    }
    welded.footTags = tags;
    console.log(`[${args.id}] foot vertices L ${tags[0].length} R ${tags[1].length}`);
  }

  // ---- clip periods and frame times --------------------------------------
  const baked = [];
  for (const entry of loaded) {
    const window = args.static?.[entry.name];
    if (window) {
      const times = [];
      const span = window.end - window.start;
      for (let i = 0; i < entry.frames; i += 1) {
        times.push(window.start + (i / entry.frames) * span);
      }
      const sample = sampleClip(entry.root, entry.mesh, entry.clip, times, welded);
      console.log(
        `[${args.id}] ${entry.name}: static window ${window.start.toFixed(2)}-` +
          `${window.end.toFixed(2)}s of ${entry.clip.duration.toFixed(3)}s, ${entry.frames} frames`,
      );
      baked.push({ ...entry, period: span, sample, isStatic: true });
      continue;
    }
    const minPeriod = args.minPeriod?.[entry.name];
    const period = findPeriod(
      entry.root,
      entry.mesh,
      entry.clip,
      welded,
      minPeriod === undefined ? {} : { minPeriod },
    );
    const times = [];
    for (let i = 0; i < entry.frames; i += 1) times.push((i / entry.frames) * period.period);
    const sample = sampleClip(entry.root, entry.mesh, entry.clip, times, welded);
    console.log(
      `[${args.id}] ${entry.name}: clip ${entry.clip.duration.toFixed(3)}s -> period ` +
        `${period.period.toFixed(3)}s (loop rms ${period.error.toFixed(4)}), ${entry.frames} frames`,
    );
    baked.push({ ...entry, period: period.period, sample });
  }

  // ---- in-place conversion + travel --------------------------------------
  // Tripo bakes forward travel into the pose, not into `Root.position`, so the
  // conversion subtracts a LINEAR RAMP of the measured per-cycle travel rather
  // than any single bone's instantaneous position. A ramp removes exactly the
  // net translation and preserves the hip sway and fore-aft oscillation that
  // make the walk read as a walk. Y is untouched: the vertical bob is the gait.
  for (const entry of baked) {
    const centroids = entry.sample.centroids;
    const frames = entry.frames;
    // Least squares slope of the centroid against cycle position. Fitting the
    // whole cycle rather than differencing its ends is what makes this robust:
    // the gait's own fore-aft oscillation is periodic, so it cancels out, and
    // there is no wrap-around sample to get wrong.
    let meanU = 0;
    for (let f = 0; f < frames; f += 1) meanU += f / frames;
    meanU /= frames;
    let meanX = 0;
    let meanZ = 0;
    for (let f = 0; f < frames; f += 1) {
      meanX += centroids[f].x;
      meanZ += centroids[f].z;
    }
    meanX /= frames;
    meanZ /= frames;
    let sxx = 0;
    let sxy = 0;
    let szy = 0;
    for (let f = 0; f < frames; f += 1) {
      const du = f / frames - meanU;
      sxx += du * du;
      sxy += du * (centroids[f].x - meanX);
      szy += du * (centroids[f].z - meanZ);
    }
    // A static clip is not going anywhere: subtracting a fitted ramp from a
    // crouch would slide it backwards through its own hold.
    const travel = entry.isStatic ? { x: 0, z: 0 } : { x: sxy / sxx, z: szy / sxx };

    for (let f = 0; f < frames; f += 1) {
      const u = f / frames;
      const dx = travel.x * u;
      const dz = travel.z * u;
      const p = entry.sample.positions[f];
      for (let i = 0; i < p.length; i += 3) {
        p[i] -= dx;
        p[i + 2] -= dz;
      }
      for (const list of Object.values(entry.sample.bones)) {
        list[f].x -= dx;
        list[f].z -= dz;
      }
    }
    entry.rootTravel = travel;
  }

  // ---- orientation --------------------------------------------------------
  // The project's yaw convention points a character's face at -Z. A forward
  // walk travels the way the character faces, so the walk's root travel is the
  // facing direction; rotate every clip so it runs to -Z.
  const walk = baked.find((entry) => entry.name === 'walk') ?? baked[0];
  const travel = Math.hypot(walk.rootTravel.x, walk.rootTravel.z);
  let yaw = 0;
  if (travel > 1e-3) {
    // The heading of the travel vector in the project's convention (0 = -Z);
    // rotating the whole bake by it puts the walk, and so the face, on -Z.
    yaw = Math.atan2(walk.rootTravel.x, -walk.rootTravel.z);
  }
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  console.log(
    `[${args.id}] walk travel (${walk.rootTravel.x.toFixed(3)}, ${walk.rootTravel.z.toFixed(3)}) ` +
      `= ${travel.toFixed(3)} units, yaw correction ${((yaw * 180) / Math.PI).toFixed(1)} deg`,
  );

  const rotate = (x, z) => ({ x: x * cos + z * sin, z: -x * sin + z * cos });
  for (const entry of baked) {
    for (const p of entry.sample.positions) {
      for (let i = 0; i < p.length; i += 3) {
        const r = rotate(p[i], p[i + 2]);
        p[i] = r.x;
        p[i + 2] = r.z;
      }
    }
    for (const nrm of entry.sample.normals) {
      for (let i = 0; i < nrm.length; i += 3) {
        const r = rotate(nrm[i], nrm[i + 2]);
        nrm[i] = r.x;
        nrm[i + 2] = r.z;
      }
    }
    for (const list of Object.values(entry.sample.bones)) {
      for (const v of list) {
        const r = rotate(v.x, v.z);
        v.x = r.x;
        v.z = r.z;
      }
    }
    const r = rotate(entry.rootTravel.x, entry.rootTravel.z);
    entry.rootTravel = r;
  }

  /*
   * A static clip has to be brought back over the origin.
   *
   * A locomotion clip is centred by construction: the ramp subtraction above
   * removes its net travel, and the reference normalisation below centres the
   * footprint. Neither does anything for a window cut out of the MIDDLE of an
   * action clip - the shoot preset walks forward before it crouches, so the
   * window at 3.3 s sits 2.78 body heights down -Z of the origin, and an
   * officer would have been drawn firing from most of three metres behind
   * where they are standing. Matching the reference clip's mean centroid puts
   * it back without disturbing the pose.
   */
  {
    // Measured from the transformed vertices rather than the sampled
    // centroids: by this point the poses have been through the in-place
    // conversion and the yaw correction, and the centroids captured at sample
    // time have not.
    const meanXZ = (entry) => {
      let x = 0;
      let z = 0;
      let n = 0;
      for (const p of entry.sample.positions) {
        for (let i = 0; i < p.length; i += 3) {
          x += p[i];
          z += p[i + 2];
          n += 1;
        }
      }
      return n > 0 ? { x: x / n, z: z / n } : { x: 0, z: 0 };
    };
    const anchor = baked.find((entry) => entry.name === 'idle') ?? baked[0];
    const anchorMean = meanXZ(anchor);
    for (const entry of baked) {
      if (!entry.isStatic || entry === anchor) continue;
      const mean = meanXZ(entry);
      const dx = mean.x - anchorMean.x;
      const dz = mean.z - anchorMean.z;
      if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) continue;
      for (const p of entry.sample.positions) {
        for (let i = 0; i < p.length; i += 3) {
          p[i] -= dx;
          p[i + 2] -= dz;
        }
      }
      for (const list of Object.values(entry.sample.bones)) {
        for (const v of list) {
          v.x -= dx;
          v.z -= dz;
        }
      }
      console.log(
        `[${args.id}] ${entry.name}: recentred by (${dx.toFixed(3)}, ${dz.toFixed(3)}) units`,
      );
    }
  }

  // ---- normalisation: 1 unit tall, feet on y = 0, footprint centred -------
  // Tripo output is normalised to a unit box with a CENTRE pivot (failure
  // lesson 3). The reference pose is the resting frame of the idle clip when
  // there is one, otherwise the walk's first frame.
  const reference = (baked.find((entry) => entry.name === 'idle') ?? baked[0]).sample.positions[0];
  let minY = Infinity;
  let maxY = -Infinity;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < reference.length; i += 3) {
    minX = Math.min(minX, reference[i]);
    maxX = Math.max(maxX, reference[i]);
    minY = Math.min(minY, reference[i + 1]);
    maxY = Math.max(maxY, reference[i + 1]);
    minZ = Math.min(minZ, reference[i + 2]);
    maxZ = Math.max(maxZ, reference[i + 2]);
  }
  const scale = 1 / (maxY - minY);
  const offsetX = -((minX + maxX) / 2) * scale;
  const offsetZ = -((minZ + maxZ) / 2) * scale;
  const offsetY = -minY * scale;
  console.log(
    `[${args.id}] reference bounds ${(maxX - minX).toFixed(3)} x ${(maxY - minY).toFixed(3)} x ` +
      `${(maxZ - minZ).toFixed(3)} units -> scale ${scale.toFixed(4)}`,
  );

  for (const entry of baked) {
    for (const p of entry.sample.positions) {
      for (let i = 0; i < p.length; i += 3) {
        p[i] = p[i] * scale + offsetX;
        p[i + 1] = p[i + 1] * scale + offsetY;
        p[i + 2] = p[i + 2] * scale + offsetZ;
      }
    }
    for (const list of Object.values(entry.sample.bones)) {
      for (const v of list) {
        v.x = v.x * scale + offsetX;
        v.y = v.y * scale + offsetY;
        v.z = v.z * scale + offsetZ;
      }
    }
    entry.rootTravel = { x: entry.rootTravel.x * scale, z: entry.rootTravel.z * scale };
  }

  // The reference pose puts the idle's soles on y = 0, but a walk's stance leg
  // dips a little lower than a standing one. Everything is dropped so the
  // lowest point of the walk sits a shade UNDER the ground: a rounding error
  // then reads as contact rather than as a floating foot.
  const SINK = 0.004;
  let walkLow = Infinity;
  for (const p of walk.sample.positions) {
    for (let i = 1; i < p.length; i += 3) walkLow = Math.min(walkLow, p[i]);
  }
  const lift = -SINK - walkLow;
  for (const entry of baked) {
    for (const p of entry.sample.positions) {
      for (let i = 1; i < p.length; i += 3) p[i] += lift;
    }
    for (const list of Object.values(entry.sample.bones)) for (const v of list) v.y += lift;
  }
  console.log(`[${args.id}] ground correction ${(lift * 1750).toFixed(1)} mm on a 1.75 m person`);

  /*
   * A static action pose stands on the ground on its own terms.
   *
   * The normalisation above is anchored to the IDLE clip's soles, which is the
   * right anchor for locomotion because every locomotion clip shares that
   * stance. An action clip need not: the shoot preset drops into a low
   * crouch whose lowest point is a shin rather than a sole, and measured on
   * `ped-police` that sat 159 mm THROUGH the pavement. Lifting each static
   * clip by its own worst penetration is the only correction that works
   * without knowing which body part is touching, and it cannot affect the
   * locomotion clips because it is only ever applied to static ones.
   */
  for (const entry of baked) {
    if (!entry.isStatic) continue;
    let low = Infinity;
    for (const p of entry.sample.positions) {
      for (let i = 1; i < p.length; i += 3) low = Math.min(low, p[i]);
    }
    const clipLift = -SINK - low;
    if (Math.abs(clipLift) < 1e-5) continue;
    for (const p of entry.sample.positions) {
      for (let i = 1; i < p.length; i += 3) p[i] += clipLift;
    }
    for (const list of Object.values(entry.sample.bones)) for (const v of list) v.y += clipLift;
    console.log(
      `[${args.id}] ${entry.name}: static ground lift ${(clipLift * 1750).toFixed(1)} mm ` +
        'on a 1.75 m person',
    );
  }

  // ---- travel curve and slip measurement ---------------------------------
  //
  // THE NO-SLIDE CONDITION. A planted foot's world position is
  // `bodyZ(t) + footZ(u)`. Holding it still means the body must advance by
  // exactly as much as the planted foot slides backwards through the pose. So
  // the clip does not have one stride, it has a TRAVEL CURVE D(u): the
  // distance the body must have covered by cycle position u.
  //
  // A single constant would be enough if every step were the same length, and
  // it is not: measured on Tripo's `preset:biped:walk`, the clip's two gait
  // cycles differ by about 4 per cent, which a constant stride turns into
  // 57 mm of foot slide on a 1.75 m person. D(u) is integrated from whichever
  // foot is actually on the ground, so each step gets its own length and the
  // runtime looks u up by distance travelled instead of multiplying by a rate.
  for (const entry of baked) {
    const frames = entry.sample.positions.length;
    if (entry.isStatic) {
      // No travel, so nothing to spread and nothing to invert: the runtime
      // drives a static clip's phase from its own timer, never from distance.
      entry.travelCurve = new Array(frames + 1).fill(0);
      entry.stride = 0;
      entry.slip = 0;
      console.log(`[${args.id}] ${entry.name}: static, no travel curve`);
      continue;
    }
    // Over a whole cycle the body returns to the same pose, so the distance the
    // feet carried it is exactly the distance the centroid moved. That makes
    // the centroid the ground truth for the TOTAL; the per-frame contact
    // measurements only have to say how it is spread.
    const travel = -entry.rootTravel.z;
    const contact = measureContact(entry.sample.positions, welded.footTags);

    // Per frame, the supporting foot is whichever measured the larger backward
    // displacement. Frames with no confident contact - the swap, and any frame
    // the retarget lifts both feet - take an equal share of whatever the
    // measured frames did not account for, which is where that distance
    // physically went.
    const steps = new Array(frames).fill(null);
    let measuredSum = 0;
    let measuredCount = 0;
    for (let f = 0; f < frames; f += 1) {
      let best = null;
      for (const perFoot of contact.perFoot) {
        const value = perFoot[f];
        if (value !== null && (best === null || value > best)) best = value;
      }
      if (best === null) continue;
      steps[f] = Math.max(0, best);
      measuredSum += steps[f];
      measuredCount += 1;
    }
    const gaps = frames - measuredCount;
    const share = gaps > 0 ? Math.max(0, travel - measuredSum) / gaps : 0;
    const rate = steps.map((step) => (step === null ? share : step));

    // Clamp to a plausible band around the even rate and renormalise to the
    // known total. A single frame where the contact search latches onto the
    // wrong foot would otherwise stall the curve and show up as a hitch, and
    // the clamp costs nothing when the measurement is good.
    if (travel > 1e-3) {
      const even = travel / frames;
      for (let f = 0; f < frames; f += 1) {
        rate[f] = Math.min(Math.max(rate[f], even * CLAMP_LO), even * CLAMP_HI);
      }
    }
    let sum = 0;
    for (const value of rate) sum += value;
    if (sum > 1e-6) {
      const correction = travel / sum;
      for (let f = 0; f < frames; f += 1) rate[f] *= correction;
    }

    const flat = travel / frames;
    const flatSlip = slipOf(contact, flat);
    const curveSlip = slipOf(contact, rate);
    const useCurve = curveSlip < flatSlip * 0.75;

    const curve = [0];
    for (let f = 0; f < frames; f += 1) {
      curve.push(curve[f] + (useCurve ? rate[f] : flat));
    }
    entry.travelCurve = curve;
    entry.stride = curve[frames];
    const seen = vertexSlide(entry.sample.positions, welded.footTags, curve);
    entry.slip = seen.worst;

    if (args.report) {
      for (let side = 0; side < 2; side += 1) {
        const members = welded.footTags[side];
        const lows = entry.sample.positions.map((frame) => {
          let low = Infinity;
          for (const v of members) low = Math.min(low, frame[v * 3 + 1]);
          return low;
        });
        console.log(
          `        foot ${side} clearance ${lows.map((v) => (v * 1000).toFixed(0).padStart(3)).join('')}`,
        );
        console.log(
          `        foot ${side} steps     ${contact.perFoot[side].map((v) => (v === null ? '  .' : (v * 1000).toFixed(0).padStart(3))).join('')}`,
        );
      }
      console.log(
        `        measured steps ${steps.map((v) => (v === null ? '  .' : (v * 1000).toFixed(0).padStart(3))).join('')}`,
      );
      console.log(`        even rate would be ${((travel / frames) * 1000).toFixed(0)}`);
    }
    console.log(
      `[${args.id}] ${entry.name}: travel ${travel.toFixed(4)} u/cycle, ` +
        `${measuredCount}/${frames} frames with a measurable ground contact, ` +
        `${useCurve ? 'measured curve' : 'constant rate'} ` +
        `(contact-point slide ${(flatSlip * 1750).toFixed(0)} mm flat vs ` +
        `${(curveSlip * 1750).toFixed(0)} mm curved)`,
    );
    console.log(
      `[${args.id}] ${entry.name}: per-vertex foot slide over ${seen.count} footfalls - ` +
        `median ${(seen.median * 1750).toFixed(0)} mm, p90 ${(seen.p90 * 1750).toFixed(0)} mm, ` +
        `worst ${(seen.worst * 1750).toFixed(0)} mm on a 1.75 m person`,
    );
  }

  // ---- ground contact -----------------------------------------------------
  for (const entry of baked) {
    let lowest = Infinity;
    let highestLowest = -Infinity;
    for (const p of entry.sample.positions) {
      let frameMin = Infinity;
      for (let i = 1; i < p.length; i += 3) frameMin = Math.min(frameMin, p[i]);
      lowest = Math.min(lowest, frameMin);
      highestLowest = Math.max(highestLowest, frameMin);
    }
    entry.groundLow = lowest;
    entry.groundHigh = highestLowest;
    console.log(
      `[${args.id}] ${entry.name}: lowest vertex ${lowest.toFixed(4)} .. ${highestLowest.toFixed(4)} u ` +
        `(${(lowest * 1750).toFixed(0)} .. ${(highestLowest * 1750).toFixed(0)} mm on a 1.75 m person)`,
    );
  }

  if (args.report) return;

  // ---- pack ---------------------------------------------------------------
  // One row per vertex; one column per frame with each clip's first frame
  // duplicated after its last so linear filtering wraps cleanly.
  const clipTable = [];
  let columns = 0;
  for (const entry of baked) {
    clipTable.push({
      name: entry.name,
      column: columns,
      frames: entry.sample.positions.length,
      duration: Number(entry.period.toFixed(6)),
      /** Distance covered per cycle, in rig units (1 unit = one body height). */
      travelPerCycle: Number(entry.stride.toFixed(6)),
      /**
       * Cumulative travel at each frame boundary, `frames + 1` entries ending
       * at `travelPerCycle`. The runtime inverts this to turn distance walked
       * into a cycle position, which is what keeps the planted foot still.
       */
      travel: entry.travelCurve.map((value) => Number(value.toFixed(6))),
      /** Worst measured residual slip of a planted foot, in rig units. */
      slip: Number(entry.slip.toFixed(6)),
      /**
       * The right hand and the forearm behind it, per frame, in rig units.
       *
       * This is what lets the runtime draw a weapon in a baked character's
       * hand. A VAT has no skeleton at runtime - that is the whole point of
       * baking - so the hand's path has to be measured here and shipped
       * alongside the texture. Two points rather than a full transform: the
       * forearm-to-hand vector is the barrel axis, and world up completes the
       * frame, which is enough to hold a pistol and costs seven numbers a
       * frame instead of sixteen.
       */
      hand: handTrack(entry.sample.bones, entry.sample.positions.length),
    });
    columns += entry.sample.positions.length + 1;
  }

  const texWidth = columns;
  const texHeight = vertexCount;
  const posData = new Uint16Array(texWidth * texHeight * 4);
  const nrmData = new Uint8Array(texWidth * texHeight * 4);

  for (const clip of clipTable) {
    const entry = baked.find((item) => item.name === clip.name);
    for (let column = 0; column <= clip.frames; column += 1) {
      const frame = column % clip.frames;
      const p = entry.sample.positions[frame];
      const n = entry.sample.normals[frame];
      for (let v = 0; v < vertexCount; v += 1) {
        const texel = (v * texWidth + clip.column + column) * 4;
        posData[texel] = toHalf(p[v * 3]);
        posData[texel + 1] = toHalf(p[v * 3 + 1]);
        posData[texel + 2] = toHalf(p[v * 3 + 2]);
        posData[texel + 3] = 0x3c00; // 1.0
        nrmData[texel] = Math.round((n[v * 3] * 0.5 + 0.5) * 255);
        nrmData[texel + 1] = Math.round((n[v * 3 + 1] * 0.5 + 0.5) * 255);
        nrmData[texel + 2] = Math.round((n[v * 3 + 2] * 0.5 + 0.5) * 255);
        nrmData[texel + 3] = 255;
      }
    }
  }

  const uvAttribute = primary.mesh.geometry.attributes.uv;
  const uvData = new Float32Array(vertexCount * 2);
  for (let v = 0; v < vertexCount; v += 1) {
    const source = welded.keep[v];
    uvData[v * 2] = uvAttribute.getX(source);
    uvData[v * 2 + 1] = args.flipV ? 1 - uvAttribute.getY(source) : uvAttribute.getY(source);
  }

  const use16 = vertexCount <= 65535;
  const indexData = use16 ? new Uint16Array(welded.index) : new Uint32Array(welded.index);

  const sections = [
    { name: 'uv', bytes: new Uint8Array(uvData.buffer) },
    { name: 'index', bytes: new Uint8Array(indexData.buffer) },
    { name: 'position', bytes: new Uint8Array(posData.buffer) },
    { name: 'normal', bytes: new Uint8Array(nrmData.buffer) },
  ];
  let offset = 0;
  const layout = {};
  for (const section of sections) {
    layout[section.name] = { offset, length: section.bytes.length };
    offset += section.bytes.length;
  }
  const bin = new Uint8Array(offset);
  for (const section of sections) bin.set(section.bytes, layout[section.name].offset);

  fs.mkdirSync(args.out, { recursive: true });
  const binPath = path.join(args.out, `${args.id}.bin`);
  fs.writeFileSync(binPath, bin);

  // ---- albedo -------------------------------------------------------------
  let textureFile = null;
  if (args.rig) {
    const image = extractGlbImage(args.rig);
    if (image) {
      const ext = image.mime === 'image/jpeg' ? 'jpg' : 'png';
      textureFile = `${args.id}.${ext}`;
      const target = path.join(args.out, textureFile);
      fs.writeFileSync(target, image.data);
      try {
        // macOS ships `sips`; a 4K character sheet is pointless on a person
        // who is at most a couple of hundred pixels tall on screen.
        execFileSync('sips', ['-Z', String(args.textureSize), target], { stdio: 'ignore' });
      } catch {
        console.warn(`[${args.id}] could not downscale ${textureFile}; shipping it as-is`);
      }
    }
  }

  const meta = {
    version: 1,
    id: args.id,
    vertexCount,
    indexCount: indexData.length,
    indexType: use16 ? 'uint16' : 'uint32',
    texture: { width: texWidth, height: texHeight },
    clips: clipTable,
    albedo: textureFile,
    layout,
    // Everything is authored 1 unit tall with the feet on y = 0 and the face
    // toward -Z, so the runtime only scales by the person's height in metres.
    heightUnits: 1,
  };
  const jsonPath = path.join(args.out, `${args.id}.json`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(meta, null, 2)}\n`);

  const sizes = [binPath, jsonPath, textureFile && path.join(args.out, textureFile)]
    .filter(Boolean)
    .map((file) => `${path.basename(file)} ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  console.log(`[${args.id}] wrote ${sizes.join(', ')}`);
  console.log(`[${args.id}] VAT texture ${texWidth} x ${texHeight}`);
}

await main();
