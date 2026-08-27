/**
 * The traffic signals you can actually see.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   import { SignalHeads } from './city/SignalHeads';
 *
 *   const signals = new SignalHeads({
 *     network,                                  // the shared RoadNetwork
 *     materials,                                // the MaterialLibrary
 *     heightAt: (x, z) => ground.heightAt(x, z),
 *   });
 *   engine.scene.add(signals.group);
 *
 *   // once per frame, with THE SAME clock traffic.update is given
 *   signals.update(elapsed);
 *
 *   signals.dispose();                          // on unload
 *
 * ============================================================================
 *
 * ## This module decides nothing
 *
 * `RoadNetwork.signalFor` already owns the timing, and `TrafficSim` already
 * makes cars stop for it. Re-deriving either here would let the heads and the
 * traffic drift apart, which is exactly the failure a player notices. So this
 * reads `signalFor(junction, axis, time)` with the clock the caller passes in
 * and lights a lens. Nothing else. If a car does not stop, the bug is in the
 * simulation and this will be showing the red that the car ignored.
 *
 * ## Where a head goes, and which way it looks
 *
 * One head per approach, four per junction, on the near-side kerb at the stop
 * line - on the driver's RIGHT, because traffic here drives on the right. Each
 * of the four lands on a different corner of the junction, so a head never
 * shares a post with another and the junction reads correctly from any
 * approach. The head faces back down the road at the traffic it governs.
 *
 * The axis a head shows is the axis of the street it stands on, not the street
 * it looks across: a driver heading south on an 'x' street is stopped by
 * `signalFor(junction, 'x', t)`.
 *
 * ## Cost
 *
 * Three draw calls for the whole city, and no lights of any kind.
 *
 *   masts    1 colour draw + 1 shadow draw, one InstancedMesh for every head
 *   lenses   1 colour draw, one InstancedMesh for every lens
 *
 * Point lights were measured at 61 per cent of this project's frame, so a lit
 * lens here is an unlit, un-tone-mapped material carrying a per-instance
 * colour: bright where it is lit, near-black where it is not, and free.
 *
 * The colour buffer is only re-uploaded on a frame where a junction actually
 * changed phase. With 55 junctions on a 26 s cycle that is about thirteen
 * frames a second in which any Web GL work happens at all; on every other
 * frame `update` costs 110 integer comparisons.
 */

import {
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  StaticDrawUsage,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { signalFor, type Junction, type RoadNetwork, type SignalState } from './RoadNetwork';
import type { MaterialLibrary } from '../render/materials';

// ---------------------------------------------------------------------------
// Dimensions, in metres
// ---------------------------------------------------------------------------

/** Height of the post under the head. A UK/EU-style near-side signal. */
const POST_HEIGHT = 2.3;
const POST_RADIUS = 0.075;
/** Sides on the post. Six is invisible at this diameter and a third cheaper. */
const POST_SIDES = 6;

const HOUSING_WIDTH = 0.34;
const HOUSING_DEPTH = 0.22;
const HOUSING_BOTTOM = 2.2;
const HOUSING_TOP = 3.24;

/** Lens centres, measured up from the post base: red on top, green at the foot. */
const LENS_Y: readonly number[] = [3.03, 2.72, 2.41];
const LENS_RADIUS = 0.105;
const LENS_SIDES = 10;
/** Just clear of the housing's front face, so the lens never z-fights it. */
const LENS_Z = -(HOUSING_DEPTH * 0.5) - 0.012;

/** Visor over each lens, which is most of a signal head's silhouette. */
const HOOD_DROP = 0.145;
const HOOD_REACH = 0.15;

/** How far past the carriageway edge the post stands, and back from the box. */
const POST_OUT = 0.9;
const POST_BACK = 0.6;

/**
 * Lens colours, authored in sRGB.
 *
 * Lit values are bright but not primary - a fully saturated primary is one of
 * the strongest "generated" tells, and the rest of this city's palette
 * deliberately avoids them. The unlit values are a dark tint of the same hue
 * rather than black, which is what makes an unlit lens read as coloured glass
 * in daylight instead of as a hole in the housing.
 */
const LIT: readonly number[] = [0xff3524, 0xffab1f, 0x3ce070];
const UNLIT: readonly number[] = [0x2b0f0b, 0x2b1e09, 0x0b2614];

/** Lens index for each state, so `update` is a lookup rather than a branch. */
const LIT_INDEX: Readonly<Record<SignalState, number>> = { red: 0, amber: 1, green: 2 };

/** Reused so a phase change allocates nothing on the frame it lands on. */
const SCRATCH_COLOUR = new Color();

// ---------------------------------------------------------------------------
// Approach layout
// ---------------------------------------------------------------------------

/**
 * One approach to a junction.
 *
 * `yaw` follows the game's convention, where a heading of `yaw` points along
 * `(-sin yaw, 0, -cos yaw)`. The head geometry is authored facing local -Z, so
 * rotating it by `yaw` points its face along that vector - which is set here to
 * point back UP the approach, at the driver.
 */
interface Approach {
  readonly junction: Junction;
  readonly axis: 'x' | 'z';
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

/**
 * The four approaches to a junction.
 *
 * Traffic drives on the right. Facing +Z the driver's right hand points to -X,
 * and facing +X it points to +Z; those two facts place all four posts, and put
 * each of them on a different corner.
 *
 * `halfX` is the half-width of the north-south ('x' axis) street and `halfZ`
 * that of the east-west one, so a post displaced along X clears `halfX` and a
 * post displaced along Z clears `halfZ`. Swapping those is the classic way to
 * end up with a signal standing in the middle of the road.
 */
export function approachesFor(junction: Junction): Approach[] {
  const { x, z, halfX, halfZ } = junction;
  const outX = halfX + POST_OUT;
  const outZ = halfZ + POST_OUT;
  const backX = halfX + POST_BACK;
  const backZ = halfZ + POST_BACK;

  return [
    // Southbound on the 'x' street: comes from -Z, right hand to -X.
    { junction, axis: 'x', x: x - outX, z: z - backZ, yaw: 0 },
    // Northbound on the 'x' street: comes from +Z, right hand to +X.
    { junction, axis: 'x', x: x + outX, z: z + backZ, yaw: Math.PI },
    // Eastbound on the 'z' street: comes from -X, right hand to +Z.
    { junction, axis: 'z', x: x - backX, z: z + outZ, yaw: Math.PI / 2 },
    // Westbound on the 'z' street: comes from +X, right hand to -Z.
    { junction, axis: 'z', x: x + backX, z: z - outZ, yaw: -Math.PI / 2 },
  ];
}

/** Every approach in the city, in a stable order. */
export function cityApproaches(network: RoadNetwork): Approach[] {
  const out: Approach[] = [];
  for (const junction of network.junctions) out.push(...approachesFor(junction));
  return out;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * One signal head, authored at the origin with its base on y=0 and its face
 * looking down local -Z. Merged into a single geometry so the whole city's
 * heads are one instanced draw.
 */
function buildMastGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  const post = new CylinderGeometry(POST_RADIUS, POST_RADIUS * 1.25, POST_HEIGHT, POST_SIDES, 1);
  post.translate(0, POST_HEIGHT * 0.5, 0);
  parts.push(post);

  const housingHeight = HOUSING_TOP - HOUSING_BOTTOM;
  const housing = new BoxGeometry(HOUSING_WIDTH, housingHeight, HOUSING_DEPTH);
  housing.translate(0, HOUSING_BOTTOM + housingHeight * 0.5, 0);
  parts.push(housing);

  for (const y of LENS_Y) {
    const hood = new BoxGeometry(HOUSING_WIDTH, 0.035, HOOD_REACH);
    // Sits above the lens and reaches out in front of it, so from below the
    // head has the stepped profile a real one has rather than a flat face.
    hood.translate(0, y + HOOD_DROP, LENS_Z - HOOD_REACH * 0.5 + 0.01);
    parts.push(hood);
  }

  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error('signal head geometry could not be merged');
  return merged;
}

/**
 * One lens: a disc facing local -Z.
 *
 * A disc rather than a short cylinder because it is only ever seen from the
 * front - the housing is behind it and the material is single-sided - and ten
 * triangles times 660 lenses is a rounding error where forty would not be.
 */
function buildLensGeometry(): BufferGeometry {
  const lens = new CircleGeometry(LENS_RADIUS, LENS_SIDES);
  // CircleGeometry faces +Z; the head faces -Z.
  lens.rotateY(Math.PI);
  return lens;
}

// ---------------------------------------------------------------------------
// SignalHeads
// ---------------------------------------------------------------------------

export interface SignalHeadsOptions {
  readonly network: RoadNetwork;
  readonly materials: MaterialLibrary;
  /** Walkable ground height, so a post stands on the pavement it is beside. */
  readonly heightAt: (x: number, z: number) => number;
}

export interface SignalHeadsStats {
  readonly junctions: number;
  readonly heads: number;
  readonly lenses: number;
  /** Colour draws plus the mast's shadow draw. */
  readonly drawCalls: number;
  readonly triangles: number;
  /** Frames on which the lens colour buffer was actually re-uploaded. */
  readonly uploads: number;
}

export class SignalHeads {
  /** Add this to the scene. It owns two InstancedMeshes and nothing else. */
  readonly group: Object3D;

  private readonly approaches: Approach[];
  private readonly masts: InstancedMesh;
  private readonly lenses: InstancedMesh;
  private readonly mastGeometry: BufferGeometry;
  private readonly lensGeometry: BufferGeometry;
  /**
   * Last state pushed for each approach, so a still frame uploads nothing.
   *
   * `null` means "nothing written yet", which is why it is not simply seeded
   * with a state: seeding it with `green` would silently skip every approach
   * that really is green on the first frame and leave those lenses dark.
   */
  private readonly shown: (SignalState | null)[];
  private uploads = 0;
  private disposed = false;

  constructor(options: SignalHeadsOptions) {
    this.approaches = cityApproaches(options.network);
    const heads = this.approaches.length;

    this.mastGeometry = buildMastGeometry();
    this.lensGeometry = buildLensGeometry();

    this.masts = new InstancedMesh(
      this.mastGeometry,
      options.materials.get('signalHousing') as Material,
      heads,
    );
    this.masts.name = 'signal-masts';
    this.masts.castShadow = true;
    this.masts.receiveShadow = true;
    // Matches the prop instances: the sun sits at 11 degrees, so a caster
    // outside the view still throws a shadow into it.
    this.masts.frustumCulled = false;
    this.masts.matrixAutoUpdate = false;

    this.lenses = new InstancedMesh(
      this.lensGeometry,
      options.materials.get('signalLens') as Material,
      heads * LENS_Y.length,
    );
    this.lenses.name = 'signal-lenses';
    this.lenses.castShadow = false;
    this.lenses.receiveShadow = false;
    this.lenses.frustumCulled = false;
    this.lenses.matrixAutoUpdate = false;

    const matrix = new Matrix4();
    const lensMatrix = new Matrix4();
    const offset = new Matrix4();
    const colour = new Color();

    for (let i = 0; i < heads; i += 1) {
      const approach = this.approaches[i] as Approach;
      const y = options.heightAt(approach.x, approach.z);
      matrix.makeRotationY(approach.yaw);
      matrix.setPosition(approach.x, y, approach.z);
      this.masts.setMatrixAt(i, matrix);

      for (let lens = 0; lens < LENS_Y.length; lens += 1) {
        offset.makeTranslation(0, LENS_Y[lens] as number, LENS_Z);
        lensMatrix.multiplyMatrices(matrix, offset);
        const index = i * LENS_Y.length + lens;
        this.lenses.setMatrixAt(index, lensMatrix);
        colour.setHex(UNLIT[lens] as number).convertSRGBToLinear();
        this.lenses.setColorAt(index, colour);
      }
    }

    this.masts.instanceMatrix.needsUpdate = true;
    this.masts.instanceMatrix.setUsage(StaticDrawUsage);
    this.lenses.instanceMatrix.needsUpdate = true;
    this.lenses.instanceMatrix.setUsage(StaticDrawUsage);
    if (this.lenses.instanceColor) this.lenses.instanceColor.needsUpdate = true;

    this.shown = new Array<SignalState | null>(heads).fill(null);

    this.group = new Group();
    this.group.name = 'traffic-signals';
    this.group.add(this.masts);
    this.group.add(this.lenses);
    // A handle for automated QA, which has no other route to this object.
    this.group.userData.signals = this;

    // Correct on the very first rendered frame, which in this game happens
    // behind the loading screen before the update loop has run once.
    this.update(0);
  }

  /**
   * Lights the lenses for `time`.
   *
   * `time` MUST be the same seconds-since-start passed to `traffic.update`, or
   * the heads will show one phase while the cars obey another.
   */
  update(time: number): void {
    if (this.disposed) return;

    let changed = false;
    const colour = SCRATCH_COLOUR;

    for (let i = 0; i < this.approaches.length; i += 1) {
      const approach = this.approaches[i] as Approach;
      const state = signalFor(approach.junction, approach.axis, time);
      if (state === this.shown[i]) continue;
      this.shown[i] = state;
      changed = true;

      const lit = LIT_INDEX[state];
      for (let lens = 0; lens < LENS_Y.length; lens += 1) {
        const hex = lens === lit ? (LIT[lens] as number) : (UNLIT[lens] as number);
        colour.setHex(hex).convertSRGBToLinear();
        this.lenses.setColorAt(i * LENS_Y.length + lens, colour);
      }
    }

    if (!changed) return;
    this.uploads += 1;
    if (this.lenses.instanceColor) this.lenses.instanceColor.needsUpdate = true;
  }

  /** The state a given approach is currently showing. For tests and QA. */
  stateAt(index: number): SignalState | null {
    return this.shown[index] ?? null;
  }

  /** Colour a given lens is currently displaying, in linear RGB. For tests. */
  lensColour(head: number, lens: number): { r: number; g: number; b: number } | null {
    const colour = this.lenses.instanceColor;
    if (!colour) return null;
    const at = (head * LENS_Y.length + lens) * 3;
    return {
      r: colour.array[at] ?? 0,
      g: colour.array[at + 1] ?? 0,
      b: colour.array[at + 2] ?? 0,
    };
  }

  /** Every approach with the state it is showing. For automated QA. */
  describe(): {
    junctionId: string;
    axis: 'x' | 'z';
    x: number;
    z: number;
    yaw: number;
    state: SignalState;
  }[] {
    return this.approaches.map((approach, i) => ({
      junctionId: approach.junction.id,
      axis: approach.axis,
      x: approach.x,
      z: approach.z,
      yaw: approach.yaw,
      state: this.shown[i] ?? 'red',
    }));
  }

  get stats(): SignalHeadsStats {
    const mastTris = (this.mastGeometry.index?.count ?? 0) / 3;
    const lensTris = (this.lensGeometry.index?.count ?? 0) / 3;
    return {
      junctions: this.approaches.length / 4,
      heads: this.approaches.length,
      lenses: this.lenses.count,
      drawCalls: 3,
      triangles: mastTris * this.masts.count + lensTris * this.lenses.count,
      uploads: this.uploads,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.remove(this.masts);
    this.group.remove(this.lenses);
    this.masts.dispose();
    this.lenses.dispose();
    this.mastGeometry.dispose();
    this.lensGeometry.dispose();
    // The materials belong to the library, which disposes them itself.
  }
}
