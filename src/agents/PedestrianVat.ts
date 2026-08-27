/**
 * Loads a baked Tripo character and its vertex animation texture.
 *
 * The files come from `tools/bake-pedestrian-vat.mjs`, which takes a Tripo
 * `animate_rig` GLB plus its `animate_retarget` FBX clips and flattens the
 * skinning into a texture. Nothing here does any skinning: a frame of
 * animation is a row of texels, and the vertex shader reads it.
 *
 * WHY A TEXTURE INSTEAD OF A SKELETON. The crowd is one `InstancedMesh`, so
 * every person must share one geometry and one draw call. A `SkinnedMesh` per
 * person was measured at 2.6 ms of draw submission at 200 people. Sampling
 * bone matrices per vertex would work with instancing but costs 16 to 32
 * dependent texture fetches per vertex; a baked pose costs one, or two while a
 * person is between walking and standing.
 *
 * TEXTURE LAYOUT (mirrored in the bake tool - change both together):
 *   row    = vertex index
 *   column = animation frame, clips laid end to end, each clip's first frame
 *            duplicated after its last
 * Frames of one vertex are therefore adjacent texels, so `LinearFilter` along
 * x interpolates between frames for free. The y coordinate is always sampled
 * at a row centre so nothing ever blends two different vertices together.
 */

import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  RGBAFormat,
  SRGBColorSpace,
  TextureLoader,
  UnsignedByteType,
  type Texture,
} from 'three';

import { lerp } from '../core/mathx';

/** Where the runtime assets live, relative to the site root. */
export const PEDESTRIAN_VAT_BASE = 'models/pedestrians';

/**
 * The characters the crowd draws from. Each costs one colour draw call and one
 * shadow draw call, so this list is a rendering budget as much as a cast list.
 */
export const PEDESTRIAN_VAT_IDS = ['ped-a', 'ped-b', 'ped-c', 'ped-d'] as const;

interface RawHandTrack {
  readonly hand: readonly (readonly number[])[];
  readonly forearm: readonly (readonly number[])[];
}

interface RawClip {
  readonly name: string;
  readonly column: number;
  readonly frames: number;
  readonly duration: number;
  readonly travelPerCycle: number;
  readonly travel: readonly number[];
  readonly slip: number;
  readonly hand?: RawHandTrack | null;
}

interface RawSection {
  readonly offset: number;
  readonly length: number;
}

interface RawMeta {
  readonly version: number;
  readonly id: string;
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly indexType: 'uint16' | 'uint32';
  readonly texture: { readonly width: number; readonly height: number };
  readonly clips: readonly RawClip[];
  readonly albedo: string | null;
  readonly layout: Readonly<Record<string, RawSection>>;
  readonly heightUnits: number;
}

/** Resolution of the distance-to-phase table. 256 steps is 6 mm on a stride. */
const INVERSE_STEPS = 256;

export class VatClip {
  readonly column: number;
  readonly frames: number;
  readonly duration: number;
  /** Distance covered in one cycle, in rig units (1 unit = one body height). */
  readonly travelPerCycle: number;
  /** Worst measured slide of a planted foot, in rig units. */
  readonly slip: number;
  /**
   * Where the right hand is, per frame, in rig units.
   *
   * A VAT has no skeleton at runtime - that is what makes it one draw call -
   * so anything that has to be held in a hand needs the hand's path measured
   * at bake time and shipped alongside the texture. `xyz` triples, `frames`
   * of them. Null for a bake made before the tool recorded it.
   */
  readonly hand: Float32Array | null;
  private readonly inverse: Float32Array;

  constructor(raw: RawClip) {
    this.column = raw.column;
    this.frames = raw.frames;
    this.duration = raw.duration;
    this.travelPerCycle = raw.travelPerCycle;
    this.slip = raw.slip;
    this.inverse = buildInverse(raw.travel);
    this.hand = packTrack(raw.hand?.hand, raw.frames);
  }

  /**
   * The right hand's position at a cycle position, written into `out`.
   *
   * Interpolated between frames and wrapped, exactly as the texture fetch is,
   * so a weapon in the hand never lags the hand that is holding it.
   */
  handAt(phase: number, out: { x: number; y: number; z: number }): boolean {
    const track = this.hand;
    if (!track || this.frames <= 0) return false;
    let t = phase % 1;
    if (t < 0) t += 1;
    const x = t * this.frames;
    const a = Math.min(this.frames - 1, Math.floor(x));
    const b = (a + 1) % this.frames;
    const f = x - a;
    out.x = lerp(track[a * 3] ?? 0, track[b * 3] ?? 0, f);
    out.y = lerp(track[a * 3 + 1] ?? 0, track[b * 3 + 1] ?? 0, f);
    out.z = lerp(track[a * 3 + 2] ?? 0, track[b * 3 + 2] ?? 0, f);
    return true;
  }

  /**
   * Cycle position for a walker who has covered `distance` rig units.
   *
   * THIS IS THE NO-SLIDE CONDITION. The clip is driven by distance travelled,
   * never by a clock, so the pose always shows the feet where the ground says
   * they are. It is the same property `gait.ts` gives the procedural rig, and
   * for the same reason: a foot that is planted must not move.
   */
  phaseFor(distance: number): number {
    if (!(this.travelPerCycle > 1e-6)) return 0;
    let t = (distance / this.travelPerCycle) % 1;
    if (t < 0) t += 1;
    const x = t * INVERSE_STEPS;
    const index = Math.min(INVERSE_STEPS - 1, Math.floor(x));
    const a = this.inverse[index] ?? 0;
    const b = this.inverse[index + 1] ?? a;
    return lerp(a, b, x - index);
  }
}

export interface PedestrianVatCharacter {
  readonly id: string;
  readonly geometry: BufferGeometry;
  readonly position: DataTexture;
  readonly normal: DataTexture;
  readonly albedo: Texture | null;
  readonly walk: VatClip;
  readonly idle: VatClip | null;
  /**
   * An action pose that plays over the top of the gait, if the bake has one.
   *
   * Baked static - no travel, no loop - because it is not locomotion: see the
   * `--static` flag in `tools/bake-pedestrian-vat.mjs`. Only the police
   * character carries one.
   */
  readonly action: VatClip | null;
  readonly triangles: number;
  readonly vertices: number;
  readonly bytes: number;
  dispose(): void;
}

/**
 * Inverts the bake's cumulative travel curve into a lookup table.
 *
 * The curve says how far the body has moved by each frame; the runtime needs
 * the opposite, and needs it without a search in the hot loop. The curve is
 * monotone, so a uniform table over distance is exact between its samples.
 */
function buildInverse(travel: readonly number[]): Float32Array {
  const frames = travel.length - 1;
  const out = new Float32Array(INVERSE_STEPS + 1);
  const total = travel[frames] ?? 0;
  if (frames <= 0 || !(total > 1e-9)) return out;

  let frame = 0;
  for (let k = 0; k <= INVERSE_STEPS; k += 1) {
    const target = (k / INVERSE_STEPS) * total;
    while (frame < frames - 1 && (travel[frame + 1] ?? 0) < target) frame += 1;
    const a = travel[frame] ?? 0;
    const b = travel[frame + 1] ?? a;
    const t = b > a ? (target - a) / (b - a) : 0;
    out[k] = (frame + t) / frames;
  }
  return out;
}

/** Flattens a per-frame `[x, y, z]` list into one array, or null if absent. */
function packTrack(
  track: readonly (readonly number[])[] | undefined,
  frames: number,
): Float32Array | null {
  if (!track || track.length < frames) return null;
  const out = new Float32Array(frames * 3);
  for (let f = 0; f < frames; f += 1) {
    const point = track[f];
    if (!point) return null;
    out[f * 3] = point[0] ?? 0;
    out[f * 3 + 1] = point[1] ?? 0;
    out[f * 3 + 2] = point[2] ?? 0;
  }
  return out;
}

/** IEEE 754 binary16 to a JavaScript number. */
function fromHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 31) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * (mantissa + 1024) * 2 ** (exponent - 25);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
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

function section(meta: RawMeta, bin: ArrayBuffer, name: string): ArrayBuffer {
  const entry = meta.layout[name];
  if (!entry) throw new Error(`${meta.id}: no ${name} section`);
  return bin.slice(entry.offset, entry.offset + entry.length);
}

/**
 * Loads one character. Returns null on any failure so a missing generated
 * asset degrades to the procedural crowd instead of emptying the streets.
 */
export async function loadPedestrianVat(
  id: string,
  base = PEDESTRIAN_VAT_BASE,
  timeoutMs = 20000,
): Promise<PedestrianVatCharacter | null> {
  try {
    const metaResponse = await withTimeout(fetch(`${base}/${id}.json`), timeoutMs, `${id}.json`);
    if (!metaResponse.ok) throw new Error(`${id}.json returned ${metaResponse.status}`);
    const meta = (await metaResponse.json()) as RawMeta;
    if (meta.version !== 1) throw new Error(`${id}: unsupported bake version ${meta.version}`);

    const binResponse = await withTimeout(fetch(`${base}/${id}.bin`), timeoutMs, `${id}.bin`);
    if (!binResponse.ok) throw new Error(`${id}.bin returned ${binResponse.status}`);
    const bin = await binResponse.arrayBuffer();

    const width = meta.texture.width;
    const height = meta.texture.height;
    const vertexCount = meta.vertexCount;

    const positionData = new Uint16Array(section(meta, bin, 'position'));
    const normalData = new Uint8Array(section(meta, bin, 'normal'));
    const uv = new Float32Array(section(meta, bin, 'uv'));
    const indexData =
      meta.indexType === 'uint16'
        ? new Uint16Array(section(meta, bin, 'index'))
        : new Uint32Array(section(meta, bin, 'index'));

    // The rest pose is column 0 of the first clip. Three.js needs a real
    // `position` and `normal` attribute even though the shader replaces both:
    // they size the buffers and give the geometry a bounding volume.
    const restPosition = new Float32Array(vertexCount * 3);
    const restNormal = new Float32Array(vertexCount * 3);
    const vertexId = new Float32Array(vertexCount);
    for (let v = 0; v < vertexCount; v += 1) {
      const texel = v * width * 4;
      for (let c = 0; c < 3; c += 1) {
        restPosition[v * 3 + c] = fromHalf(positionData[texel + c] ?? 0);
        restNormal[v * 3 + c] = ((normalData[texel + c] ?? 128) / 255) * 2 - 1;
      }
      vertexId[v] = v;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(restPosition, 3));
    geometry.setAttribute('normal', new BufferAttribute(restNormal, 3));
    geometry.setAttribute('uv', new BufferAttribute(uv, 2));
    geometry.setAttribute('aVid', new BufferAttribute(vertexId, 1));
    geometry.setIndex(new BufferAttribute(indexData, 1));
    geometry.computeBoundingSphere();

    const position = new DataTexture(positionData, width, height, RGBAFormat, HalfFloatType);
    position.magFilter = LinearFilter;
    position.minFilter = LinearFilter;
    position.wrapS = ClampToEdgeWrapping;
    position.wrapT = ClampToEdgeWrapping;
    position.generateMipmaps = false;
    position.colorSpace = NoColorSpace;
    position.needsUpdate = true;

    const normal = new DataTexture(normalData, width, height, RGBAFormat, UnsignedByteType);
    normal.magFilter = LinearFilter;
    normal.minFilter = LinearFilter;
    normal.wrapS = ClampToEdgeWrapping;
    normal.wrapT = ClampToEdgeWrapping;
    normal.generateMipmaps = false;
    normal.colorSpace = NoColorSpace;
    normal.needsUpdate = true;

    let albedo: Texture | null = null;
    if (meta.albedo) {
      albedo = await withTimeout(
        new TextureLoader().loadAsync(`${base}/${meta.albedo}`),
        timeoutMs,
        meta.albedo,
      );
      albedo.colorSpace = SRGBColorSpace;
      // The UVs come from the FBX, whose V axis runs the other way from glTF's;
      // `TextureLoader` flips by default, which is exactly the right pairing.
      albedo.anisotropy = 4;
    }

    const walkRaw = meta.clips.find((clip) => clip.name === 'walk') ?? meta.clips[0];
    if (!walkRaw) throw new Error(`${id}: bake carries no clips`);
    const idleRaw = meta.clips.find((clip) => clip.name === 'idle');
    const actionRaw = meta.clips.find((clip) => clip.name === 'shoot');

    return {
      id,
      geometry,
      position,
      normal,
      albedo,
      walk: new VatClip(walkRaw),
      idle: idleRaw ? new VatClip(idleRaw) : null,
      action: actionRaw ? new VatClip(actionRaw) : null,
      triangles: meta.indexCount / 3,
      vertices: vertexCount,
      bytes: bin.byteLength,
      dispose(): void {
        geometry.dispose();
        position.dispose();
        normal.dispose();
        albedo?.dispose();
      },
    };
  } catch (error) {
    // A generated asset that fails to load is a degraded visual, not a crash.
    // eslint-disable-next-line no-console
    console.warn(`[meridian] pedestrian ${id} unavailable, using the procedural rig`, error);
    return null;
  }
}
