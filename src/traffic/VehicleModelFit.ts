/**
 * Fitting a generated model to a vehicle's physical box.
 *
 * Every Tripo asset arrives normalised into a unit box with a CENTRE pivot, in
 * arbitrary units and an arbitrary heading. None of that is usable directly:
 * the traffic simulation owns the physical size of a vehicle through
 * `ChassisSpec`, and the drawn mesh has to be made to agree with it, never the
 * other way round. So each model is measured, scaled into metres, turned to
 * face -Z and re-origined onto its own footprint at ground level, exactly the
 * way `world/ModelLibrary` treats the street lamp.
 *
 * TWO MEASUREMENTS ARE ROBUST ON PURPOSE. A raw bounding box lies about a car:
 *
 * - WIDTH. Wing mirrors stand 100-150 mm proud of the widest body panel, so a
 *   bounding box makes a saloon read as 0.51 wide against 1.00 long where the
 *   real ratio is 0.40. Fitting to that would shrink the car until its length
 *   was wrong. The body width is therefore measured only in the lower half of
 *   the model, below the belt line where mirrors live, and at the 99th
 *   percentile rather than the maximum so one stray vertex cannot set it.
 * - HEIGHT. A roof aerial is one thin spike that can add 10 per cent to the
 *   box. Height is measured over the middle 60 per cent of the length - past
 *   the nose and tail tips - again at the 99th percentile.
 *
 * The functions here are pure arithmetic over a position array so they can be
 * unit tested against synthetic point clouds and run against the real assets
 * offline, without a renderer.
 *
 * OUTPUT CONVENTION matches `MeshBuilder`: nose at -Z, +X to the driver's
 * right, y = 0 on the ground contact plane.
 */

/** Index of a horizontal axis in a model-space position triple. */
export type HorizontalAxis = 0 | 2;

/** Column-major, ready for `Matrix4.fromArray`. */
export type Matrix16 = readonly number[];

export interface BodyMeasurement {
  /** Which model axis runs nose to tail. */
  readonly lengthAxis: HorizontalAxis;
  /** Which model axis runs across the vehicle. */
  readonly widthAxis: HorizontalAxis;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** Nose-to-tail extent, model units. */
  readonly length: number;
  /** Widest body panel, mirrors and other outliers excluded. */
  readonly width: number;
  /** Raw bounding-box width. Wider than `width` by the mirrors. */
  readonly widthWithMirrors: number;
  /** Roof height above the lowest point, aerials excluded. */
  readonly height: number;
  /** Raw bounding-box height. */
  readonly heightWithAerial: number;
  readonly vertices: number;
}

export interface BodyTarget {
  readonly length: number;
  readonly width: number;
  readonly height: number;
}

export interface BodyFit {
  /** Applied along the model's own axes, before the turn. */
  readonly scale: readonly [number, number, number];
  /** Radians about Y, a multiple of a quarter turn, applied after the scale. */
  readonly yaw: number;
  /** Applied last, to land the footprint centre on the origin at ground level. */
  readonly offset: readonly [number, number, number];
  readonly matrix: Matrix16;
  /** Fitted size in metres, in the vehicle's own frame. */
  readonly metres: {
    readonly length: number;
    readonly width: number;
    readonly widthWithMirrors: number;
    readonly height: number;
  };
  /** Fitted width over the target width. 1 is an exact fit. */
  readonly widthRatio: number;
  /** Fitted height over the target height. */
  readonly heightRatio: number;
}

/**
 * How far the width and height scales may drift from the length scale.
 *
 * The length scale is always exact, because a queue of cars makes any error in
 * nose-to-tail size obvious. Width and height are allowed to miss their target
 * by up to this factor rather than distort the model: a car 5 per cent wider
 * than its collision box is invisible, a car squashed 20 per cent vertically
 * is not.
 */
export const MAX_SCALE_RATIO = 1.12;

/** Below the belt line, as a fraction of the raw height. Mirrors sit above it. */
const WIDTH_BAND = 0.5;
/** Ignored fraction of the length at each end when measuring the roof. */
const HEIGHT_MARGIN = 0.2;
const OUTLIER_PERCENTILE = 0.99;
/** Below this many samples the robust measurement is not trustworthy. */
const MIN_SAMPLES = 16;

function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)));
  return sorted[index] ?? 0;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** Column-major 3x3 rotation about Y. Columns are the images of the basis. */
function rotationY(angle: number): number[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, 0, -s, 0, 1, 0, s, 0, c];
}

/** Column-major 3x3 rotation about Z. */
function rotationZ(angle: number): number[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, s, 0, -s, c, 0, 0, 0, 1];
}

/** `T * R * S`, with `S` diagonal in the model's own axes. */
function compose(
  rotation: readonly number[],
  scale: readonly number[],
  offset: readonly number[],
): number[] {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 3; column += 1) {
    const s = scale[column] ?? 1;
    for (let row = 0; row < 3; row += 1) {
      out[column * 4 + row] = (rotation[column * 3 + row] ?? 0) * s;
    }
  }
  out[12] = offset[0] ?? 0;
  out[13] = offset[1] ?? 0;
  out[14] = offset[2] ?? 0;
  out[15] = 1;
  return out;
}

/** Applies a column-major 3x3 to a point. */
function apply3(rotation: readonly number[], point: readonly number[]): [number, number, number] {
  const x = point[0] ?? 0;
  const y = point[1] ?? 0;
  const z = point[2] ?? 0;
  return [
    (rotation[0] ?? 0) * x + (rotation[3] ?? 0) * y + (rotation[6] ?? 0) * z,
    (rotation[1] ?? 0) * x + (rotation[4] ?? 0) * y + (rotation[7] ?? 0) * z,
    (rotation[2] ?? 0) * x + (rotation[5] ?? 0) * y + (rotation[8] ?? 0) * z,
  ];
}

/**
 * Applies a fit matrix to a position array.
 *
 * At runtime three does this through `BufferGeometry.applyMatrix4`, which also
 * carries the normals; this is the same arithmetic for positions alone, so the
 * tests can check where an asset lands without a renderer.
 */
export function transformPositions(
  positions: ArrayLike<number>,
  matrix: Matrix16,
): Float32Array {
  const count = Math.floor(positions.length / 3);
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const x = positions[i * 3] ?? 0;
    const y = positions[i * 3 + 1] ?? 0;
    const z = positions[i * 3 + 2] ?? 0;
    out[i * 3] =
      (matrix[0] ?? 0) * x + (matrix[4] ?? 0) * y + (matrix[8] ?? 0) * z + (matrix[12] ?? 0);
    out[i * 3 + 1] =
      (matrix[1] ?? 0) * x + (matrix[5] ?? 0) * y + (matrix[9] ?? 0) * z + (matrix[13] ?? 0);
    out[i * 3 + 2] =
      (matrix[2] ?? 0) * x + (matrix[6] ?? 0) * y + (matrix[10] ?? 0) * z + (matrix[14] ?? 0);
  }
  return out;
}

/** Measures a vehicle body from a flat `[x, y, z, ...]` position array. */
export function measureBody(positions: ArrayLike<number>): BodyMeasurement {
  const count = Math.floor(positions.length / 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[i * 3 + axis] ?? 0;
      if (value < (min[axis] as number)) min[axis] = value;
      if (value > (max[axis] as number)) max[axis] = value;
    }
  }
  if (count === 0) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }

  const extentX = max[0] - min[0];
  const extentZ = max[2] - min[2];
  const lengthAxis: HorizontalAxis = extentX >= extentZ ? 0 : 2;
  const widthAxis: HorizontalAxis = lengthAxis === 0 ? 2 : 0;

  const length = max[lengthAxis] - min[lengthAxis];
  const rawHeight = max[1] - min[1];
  const rawWidth = max[widthAxis] - min[widthAxis];
  const widthCentre = (min[widthAxis] + max[widthAxis]) * 0.5;
  const span = length > 1e-9 ? length : 1;

  const widthSamples: number[] = [];
  const heightSamples: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const y = positions[i * 3 + 1] ?? 0;
    if (y - min[1] <= WIDTH_BAND * rawHeight) {
      widthSamples.push(Math.abs((positions[i * 3 + widthAxis] ?? 0) - widthCentre));
    }
    const t = ((positions[i * 3 + lengthAxis] ?? 0) - min[lengthAxis]) / span;
    if (t > HEIGHT_MARGIN && t < 1 - HEIGHT_MARGIN) heightSamples.push(y - min[1]);
  }

  return {
    lengthAxis,
    widthAxis,
    min,
    max,
    length,
    width:
      widthSamples.length >= MIN_SAMPLES
        ? 2 * percentile(widthSamples, OUTLIER_PERCENTILE)
        : rawWidth,
    widthWithMirrors: rawWidth,
    height:
      heightSamples.length >= MIN_SAMPLES
        ? percentile(heightSamples, OUTLIER_PERCENTILE)
        : rawHeight,
    heightWithAerial: rawHeight,
    vertices: count,
  };
}

/**
 * Builds the transform that puts a measured body into the vehicle's own frame.
 *
 * `noseTowardsMax` says which end of the model's length axis is the nose. It
 * cannot be derived reliably from the mesh - a saloon's boot lid and bonnet
 * are within a few centimetres of each other - so it is recorded per asset and
 * confirmed by looking at the car in the game.
 */
export function fitBody(
  measurement: BodyMeasurement,
  target: BodyTarget,
  noseTowardsMax: boolean,
  maxScaleRatio: number = MAX_SCALE_RATIO,
): BodyFit {
  const safeLength = measurement.length > 1e-9 ? measurement.length : 1;
  const safeWidth = measurement.width > 1e-9 ? measurement.width : 1;
  const safeHeight = measurement.height > 1e-9 ? measurement.height : 1;

  const scaleLength = target.length / safeLength;
  const low = scaleLength / maxScaleRatio;
  const high = scaleLength * maxScaleRatio;
  const scaleWidth = clamp(target.width / safeWidth, low, high);
  const scaleHeight = clamp(target.height / safeHeight, low, high);

  const scale: [number, number, number] = [0, 0, 0];
  scale[measurement.lengthAxis] = scaleLength;
  scale[measurement.widthAxis] = scaleWidth;
  scale[1] = scaleHeight;

  // A quarter turn brings the model's length axis onto Z; a half turn on top
  // of it swings the nose round to -Z.
  const yaw =
    (measurement.lengthAxis === 0 ? -Math.PI / 2 : 0) + (noseTowardsMax ? Math.PI : 0);
  const rotation = rotationY(yaw);

  // The point that must end up at the origin: the footprint centre, at the
  // lowest point of the model.
  const anchor: [number, number, number] = [0, 0, 0];
  anchor[measurement.lengthAxis] =
    ((measurement.min[measurement.lengthAxis] + measurement.max[measurement.lengthAxis]) * 0.5) *
    scale[measurement.lengthAxis];
  anchor[measurement.widthAxis] =
    ((measurement.min[measurement.widthAxis] + measurement.max[measurement.widthAxis]) * 0.5) *
    scale[measurement.widthAxis];
  anchor[1] = measurement.min[1] * scaleHeight;
  const rotated = apply3(rotation, anchor);
  const offset: [number, number, number] = [-rotated[0], -rotated[1], -rotated[2]];

  const metresWidth = measurement.width * scaleWidth;
  const metresHeight = measurement.height * scaleHeight;
  return {
    scale,
    yaw,
    offset,
    matrix: compose(rotation, scale, offset),
    metres: {
      length: measurement.length * scaleLength,
      width: metresWidth,
      widthWithMirrors: measurement.widthWithMirrors * scaleWidth,
      height: metresHeight,
    },
    widthRatio: metresWidth / target.width,
    heightRatio: metresHeight / target.height,
  };
}

export interface WheelCutParams {
  /** Fitted body half width in metres. */
  readonly halfWidth: number;
  readonly length: number;
  readonly wheelRadius: number;
  readonly wheelWidth: number;
  /** Blueprint axle positions in the vehicle's frame: front negative. */
  readonly frontAxleZ: number;
  readonly rearAxleZ: number;
  readonly track: number;
  /** Lowest point of the painted body above the road, for a model with no wheels. */
  readonly rideHeight: number;
  /** Per-vertex normals, so a cut triangle's pieces keep their shading. */
  readonly normals?: ArrayLike<number> | undefined;
  /** Per-vertex UVs, so a cut triangle's pieces keep their texture. */
  readonly uvs?: ArrayLike<number> | undefined;
}

/** Where the renderer should mount this model's wheels, in the vehicle's frame. */
export interface WheelMount {
  readonly frontZ: number;
  readonly rearZ: number;
  readonly halfTrack: number;
  /**
   * Rolling radius of the wheel this model was drawn with, or 0 when nothing
   * was detected.
   *
   * The renderer used to scale every wheel to the BLUEPRINT radius, which is
   * the simulation's number and need not match the arch the generator drew: a
   * cluster is accepted anywhere between 0.72 and 1.6 of it. A wheel smaller
   * than its own arch leaves a ring of liner showing all the way round, and a
   * wheel larger than it pushes through the wing. Drawing it at the radius the
   * arch was cut at makes it fill the arch exactly, and it still stands on the
   * road because the arch was measured from a model whose own wheel did.
   */
  readonly radius: number;
}

/**
 * One opening the cut left in the body.
 *
 * The cut is a disc about the wheel's own axle, so the hole it leaves is
 * described by exactly these three numbers - and a hole nothing fills is a
 * hole you can see the inside of the car through. `VehicleModels` builds the
 * wheel well that closes it from this.
 */
export interface WheelArch {
  /** Along the vehicle, in its own frame: nose at -Z. */
  readonly z: number;
  /** Height of the axle the arch was cut around. */
  readonly centreY: number;
  /**
   * Radius of the opening in the bodywork.
   *
   * This is the radius the cut REACHED, not the radius it swept. A triangle is
   * dropped when its centroid falls inside the wheel, so a triangle straddling
   * the boundary goes with the rest and takes bodywork out past the circle -
   * on these assets by up to a fifth of the wheel's radius. Sizing a wheel
   * well to the swept circle therefore leaves a ring of the opening
   * uncovered, and a viewer looking along the axle sees straight through it.
   */
  readonly radius: number;
}

/**
 * Vertices the arch clip had to invent, appended after the model's own.
 *
 * A triangle that straddles the edge of an arch is not kept or dropped, it is
 * CUT, and the pieces need vertices the model never had. They are appended
 * rather than replacing anything so every original index stays valid and the
 * caller only has to concatenate.
 */
export interface ClippedVertices {
  readonly position: Float32Array;
  readonly normal: Float32Array | null;
  readonly uv: Float32Array | null;
  /** How many vertices were appended. */
  readonly count: number;
}

export interface WheelDetection {
  readonly mount: WheelMount;
  /** The openings the cut left, front first. Empty when nothing was cut. */
  readonly arches: readonly WheelArch[];
  /** True when the model arrived with wheels and they were removed. */
  readonly cut: boolean;
  /** The index buffer with the wheel triangles dropped or cut. */
  readonly index: Uint32Array;
  readonly removed: number;
  /** Vertices the clip appended, or null when nothing needed cutting. */
  readonly extra: ClippedVertices | null;
  /** Metres the body must be lifted so it sits on its wheels rather than its sills. */
  readonly lift: number;
  /** Tyres found in the model. */
  readonly detected: number;
  /**
   * Tyres left in place because the renderer only draws four wheels. A three
   * axle truck keeps its spare bogie pair, which cannot turn; an empty arch
   * would read worse than a wheel that does not spin.
   */
  readonly leftInPlace: number;
}

/** A run of z bins where the model reaches the road, i.e. a tyre. */
interface WheelCluster {
  readonly z: number;
  readonly radius: number;
}

/** Bins along the length used to find the tyres. */
const WHEEL_BINS = 80;
/** A triangle this far out from the centreline is on the flank, not the floorpan. */
const FLANK_FRACTION = 0.55;
/** Height below which a flank triangle counts as touching the road. */
const GROUND_FRACTION = 0.4;
/** How far a detected tyre may sit from the blueprint's axle and still be it. */
const AXLE_TOLERANCE = 0.9;
/**
 * Sides of the polygon the arch is cut against.
 *
 * WHY A POLYGON AND NOT A CIRCLE. Clipping a triangle against a straight edge
 * is exact and produces another convex polygon; clipping it against a curve is
 * neither. Sixteen tangent edges put the worst corner 2.0 per cent outside the
 * tyre, which on a 0.33 m wheel is 6 mm - a millimetre or two of dark liner
 * visible at the corners of the arch, which is what a real wheel arch has
 * there anyway.
 */
const ARCH_SIDES = 16;

/**
 * How far in each of the polygon's edges sits, as a multiple of the radius.
 *
 * The polygon is INSCRIBED - its corners are ON the tyre's circle and its
 * edges cut a little inside it - which is the choice that matters:
 *
 *  - Circumscribed, every edge tangent, would guarantee no scrap of the
 *    generated wheel survives, at the cost of an opening two per cent WIDER
 *    than the wheel that fills it. Two per cent of a wheel is a 6 mm ring of
 *    dark liner all the way round every arch, sixteen times over. That ring,
 *    much larger, is exactly what this whole change exists to remove.
 *  - Inscribed leaves the opening never wider than the wheel, so the drawn
 *    wheel covers it completely: no ring, and no sight line into the car.
 *    What it costs is up to 1.9 per cent of a radius of the model's own tyre
 *    surviving at each corner - about 6 mm of black rubber, sitting INSIDE the
 *    black rubber of the wheel that is drawn over it.
 *
 * Six millimetres of hidden tyre is a better trade than six millimetres of
 * visible hole, sixteen times per wheel.
 */
const ARCH_EDGE_INSET = Math.cos(Math.PI / ARCH_SIDES);

/**
 * How steeply downward an edge's normal has to point before it is dropped from
 * the clip.
 *
 * The arch is NOT a closed circle. Under the wheel there is no bodywork at all
 * on a real car - the wing sweeps down past the tyre and stops, and you can see
 * the road under the sill - so the bottom of the polygon is left open and the
 * cut runs straight down to the road and past it. Closing it would leave a
 * skirt of sheet metal reaching the ground on both sides of every wheel, which
 * is both wrong to look at and would put the body's lowest point on the road.
 *
 * How far down that open bottom reaches is bounded by which triangles are
 * eligible to be clipped at all - `TRIANGLE_MARGIN` around the arch - so the
 * floorpan and the sills away from the wheels are never touched.
 */
const ARCH_OPEN_BELOW = 0.2;

/** True when this edge of the arch polygon takes part in the cut. */
function archEdgeUsed(ny: number): boolean {
  return ny >= -ARCH_OPEN_BELOW;
}

/**
 * Slack added when deciding whether a triangle is worth clipping at all.
 *
 * Only an optimisation: a triangle whose centroid is this far outside the arch
 * cannot reach it, so it is kept whole without running the clipper. Generous
 * enough for the largest triangle in any of the generated bodies.
 */
const TRIANGLE_MARGIN = 0.45;

/**
 * How the arch clip disposed of one triangle.
 *
 * `cut` and `dropped` are both counted as removals; the distinction exists so
 * the tests can tell "this triangle was split" from "this triangle was inside
 * the tyre".
 */
type ClipResult = 'kept' | 'dropped' | 'cut';

/** Floats per clipped vertex: position, normal, uv. */
const CLIP_STRIDE = 8;

/**
 * Cuts the bodywork open around a wheel, exactly.
 *
 * WHAT THIS REPLACED, AND WHY IT MATTERED. The first version dropped a whole
 * triangle whenever its CENTROID fell inside the tyre. On a body of about
 * fifteen hundred triangles a triangle is 10-20 cm across, so the hole that
 * left was up to a triangle's width wider than the tyre in every direction -
 * measured on the fleet, a 33 cm wheel in a 49 cm hole. Something had to be
 * behind that 16 cm ring or you could see through the car, and what was behind
 * it was the dark grey wheel-well liner. That is the "ugly 3D element around
 * the wheels": not a thing that was added, but the inside of the car showing
 * through bodywork that should never have been removed.
 *
 * This cuts the triangles instead. Each one that straddles the arch is split
 * against the sixteen tangent edges of the polygon around the tyre, the pieces
 * outside are kept and the piece inside is discarded, so the opening is the
 * polygon and nothing else. The liner behind it is then 2 per cent of a wheel
 * radius wide - a hairline, which is what a wheel arch looks like.
 *
 * The clip is in the (y, z) plane and x rides along on the interpolation,
 * which is right because the arch is a hole through a flank: the cut is a
 * cylinder along the axle, not a sphere.
 */
class ArchClipper {
  /** Appended vertices, eight floats each. */
  private readonly extra: number[] = [];
  private readonly baseCount: number;
  private readonly hasNormals: boolean;
  private readonly hasUvs: boolean;
  /**
   * Scratch polygons, rotated between the three roles each edge needs.
   *
   * They are reused rather than reallocated per edge; the clip itself still
   * allocates a small array per crossing vertex, which is fine because this
   * runs once per body at load and never in a frame.
   */
  private a: number[] = [];
  private b: number[] = [];
  private c: number[] = [];

  constructor(
    private readonly positions: ArrayLike<number>,
    private readonly normals: ArrayLike<number> | undefined,
    private readonly uvs: ArrayLike<number> | undefined,
  ) {
    this.baseCount = Math.floor(positions.length / 3);
    this.hasNormals = normals !== undefined && normals.length >= this.baseCount * 3;
    this.hasUvs = uvs !== undefined && uvs.length >= this.baseCount * 2;
  }

  /**
   * Keeps whatever of one triangle lies outside the arch, writing any pieces
   * into `out` as triangles.
   *
   * Returns `kept` when the triangle never touched the arch (nothing is
   * written and the caller should emit it unchanged), `dropped` when it was
   * entirely inside, and `cut` when pieces were written.
   */
  subtractArch(
    ia: number,
    ib: number,
    ic: number,
    archZ: number,
    radius: number,
    out: number[],
  ): ClipResult {
    if (!(radius > 1e-6)) return 'kept';
    const centreY = radius;

    let inside = 0;
    if (this.insidePolygon(ia, archZ, centreY, radius)) inside += 1;
    if (this.insidePolygon(ib, archZ, centreY, radius)) inside += 1;
    if (this.insidePolygon(ic, archZ, centreY, radius)) inside += 1;
    if (inside === 3) return 'dropped';
    // A triangle can miss the arch with all three corners and still cover it -
    // one large panel spanning a whole wheel does exactly that - so "no corner
    // inside" is not the same question as "does not overlap". The disc used
    // here is the circle the polygon is inscribed in; the region's open bottom
    // only ever makes it larger, so this stays conservative.
    if (inside === 0 && !this.overlapsArch(ia, ib, ic, archZ, centreY, radius)) {
      return 'kept';
    }

    // `remaining` starts as the whole triangle and is whittled down: each edge
    // of the polygon peels off the part outside that edge - which is outside
    // the tyre and therefore kept - leaving the part inside it to face the
    // next edge. What survives all sixteen is the part inside the polygon,
    // which is the hole.
    let remaining = this.a;
    let outside = this.b;
    let next = this.c;
    remaining.length = 0;
    this.push(remaining, ia);
    this.push(remaining, ib);
    this.push(remaining, ic);

    let wrote = false;
    for (let side = 0; side < ARCH_SIDES && remaining.length > 0; side += 1) {
      const angle = ((side + 0.5) / ARCH_SIDES) * Math.PI * 2;
      // Outward normal of this edge, in (y, z). The edge itself is tangent to
      // the tyre, so a point is outside the polygon through this edge when its
      // signed distance along the normal exceeds the radius.
      const ny = Math.sin(angle);
      const nz = Math.cos(angle);
      if (!archEdgeUsed(ny)) continue;
      const offset = radius * ARCH_EDGE_INSET + ny * centreY + nz * archZ;

      outside.length = 0;
      next.length = 0;
      clipHalfPlane(remaining, ny, nz, offset, outside, next);
      if (outside.length >= 3 * CLIP_STRIDE) {
        this.emit(outside, out);
        wrote = true;
      }
      const swap = remaining;
      remaining = next;
      next = swap;
      // `outside` is finished with; reuse it as the next spare.
      const spare = outside;
      outside = next;
      next = spare;
    }
    this.a = remaining;
    this.b = outside;
    this.c = next;
    return wrote ? 'cut' : 'dropped';
  }

  /** The appended vertices, or null when nothing was cut. */
  harvest(): ClippedVertices | null {
    const count = this.extra.length / CLIP_STRIDE;
    if (count === 0) return null;
    const position = new Float32Array(count * 3);
    const normal = this.hasNormals ? new Float32Array(count * 3) : null;
    const uv = this.hasUvs ? new Float32Array(count * 2) : null;
    for (let i = 0; i < count; i += 1) {
      const at = i * CLIP_STRIDE;
      position[i * 3] = this.extra[at] as number;
      position[i * 3 + 1] = this.extra[at + 1] as number;
      position[i * 3 + 2] = this.extra[at + 2] as number;
      if (normal) {
        normal[i * 3] = this.extra[at + 3] as number;
        normal[i * 3 + 1] = this.extra[at + 4] as number;
        normal[i * 3 + 2] = this.extra[at + 5] as number;
      }
      if (uv) {
        uv[i * 2] = this.extra[at + 6] as number;
        uv[i * 2 + 1] = this.extra[at + 7] as number;
      }
    }
    return { position, normal, uv, count };
  }

  /**
   * True when the triangle and the arch's circle overlap at all, in (y, z).
   *
   * Two convex shapes overlap when either contains a point of the other, and
   * for a triangle and a disc that reduces to: the centre is inside the
   * triangle, or some edge passes within the radius.
   */
  private overlapsArch(
    ia: number,
    ib: number,
    ic: number,
    archZ: number,
    centreY: number,
    radius: number,
  ): boolean {
    const ay = this.positions[ia * 3 + 1] ?? 0;
    const az = this.positions[ia * 3 + 2] ?? 0;
    const by = this.positions[ib * 3 + 1] ?? 0;
    const bz = this.positions[ib * 3 + 2] ?? 0;
    const cy = this.positions[ic * 3 + 1] ?? 0;
    const cz = this.positions[ic * 3 + 2] ?? 0;

    // Same sign on all three cross products means the centre is inside.
    const s1 = (by - ay) * (archZ - az) - (bz - az) * (centreY - ay);
    const s2 = (cy - by) * (archZ - bz) - (cz - bz) * (centreY - by);
    const s3 = (ay - cy) * (archZ - cz) - (az - cz) * (centreY - cy);
    if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) return true;

    const near = radius * radius;
    return (
      segmentDistanceSquared(ay, az, by, bz, centreY, archZ) <= near ||
      segmentDistanceSquared(by, bz, cy, cz, centreY, archZ) <= near ||
      segmentDistanceSquared(cy, cz, ay, az, centreY, archZ) <= near
    );
  }

  private insidePolygon(vertex: number, archZ: number, centreY: number, radius: number): boolean {
    const y = this.positions[vertex * 3 + 1] ?? 0;
    const z = this.positions[vertex * 3 + 2] ?? 0;
    for (let side = 0; side < ARCH_SIDES; side += 1) {
      const angle = ((side + 0.5) / ARCH_SIDES) * Math.PI * 2;
      const ny = Math.sin(angle);
      const nz = Math.cos(angle);
      if (!archEdgeUsed(ny)) continue;
      if (ny * (y - centreY) + nz * (z - archZ) > radius * ARCH_EDGE_INSET) return false;
    }
    return true;
  }

  /** Appends one of the model's own vertices to a working polygon. */
  private push(polygon: number[], vertex: number): void {
    polygon.push(
      this.positions[vertex * 3] ?? 0,
      this.positions[vertex * 3 + 1] ?? 0,
      this.positions[vertex * 3 + 2] ?? 0,
      this.hasNormals ? (this.normals?.[vertex * 3] ?? 0) : 0,
      this.hasNormals ? (this.normals?.[vertex * 3 + 1] ?? 1) : 1,
      this.hasNormals ? (this.normals?.[vertex * 3 + 2] ?? 0) : 0,
      this.hasUvs ? (this.uvs?.[vertex * 2] ?? 0) : 0,
      this.hasUvs ? (this.uvs?.[vertex * 2 + 1] ?? 0) : 0,
    );
  }

  /** Fans a convex polygon into triangles of newly appended vertices. */
  private emit(polygon: number[], out: number[]): void {
    const corners = polygon.length / CLIP_STRIDE;
    if (corners < 3) return;
    const first = this.baseCount + this.extra.length / CLIP_STRIDE;
    for (let i = 0; i < corners; i += 1) {
      for (let f = 0; f < CLIP_STRIDE; f += 1) {
        this.extra.push(polygon[i * CLIP_STRIDE + f] as number);
      }
    }
    for (let i = 1; i + 1 < corners; i += 1) {
      out.push(first, first + i, first + i + 1);
    }
  }
}

/**
 * Sutherland-Hodgman against one half-plane in (y, z), splitting a polygon
 * into the part beyond `n . p > offset` and the part at or under it.
 *
 * Every attribute rides along on the same parameter, so a cut edge's position,
 * normal and texture coordinate all land at the same point of the original
 * triangle.
 */
function clipHalfPlane(
  polygon: readonly number[],
  ny: number,
  nz: number,
  offset: number,
  beyond: number[],
  under: number[],
): void {
  const corners = polygon.length / CLIP_STRIDE;
  if (corners === 0) return;
  const distance = (i: number): number =>
    ny * (polygon[i * CLIP_STRIDE + 1] as number) + nz * (polygon[i * CLIP_STRIDE + 2] as number) - offset;

  for (let i = 0; i < corners; i += 1) {
    const j = (i + 1) % corners;
    const di = distance(i);
    const dj = distance(j);
    if (di >= 0) beyond.push(...slice(polygon, i));
    if (di <= 0) under.push(...slice(polygon, i));
    if ((di > 0 && dj < 0) || (di < 0 && dj > 0)) {
      const t = di / (di - dj);
      const crossing = lerpVertex(polygon, i, j, t);
      beyond.push(...crossing);
      under.push(...crossing);
    }
  }
}

/** Squared distance from a point to a segment, in the plane. */
function segmentDistanceSquared(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = 0;
  if (lengthSquared > 1e-12) {
    t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const cx = ax + dx * t - px;
  const cy = ay + dy * t - py;
  return cx * cx + cy * cy;
}

function slice(polygon: readonly number[], i: number): number[] {
  const at = i * CLIP_STRIDE;
  return polygon.slice(at, at + CLIP_STRIDE) as number[];
}

function lerpVertex(polygon: readonly number[], i: number, j: number, t: number): number[] {
  const a = i * CLIP_STRIDE;
  const b = j * CLIP_STRIDE;
  const out = new Array<number>(CLIP_STRIDE);
  for (let f = 0; f < CLIP_STRIDE; f += 1) {
    const va = polygon[a + f] as number;
    const vb = polygon[b + f] as number;
    out[f] = va + (vb - va) * t;
  }
  return out;
}

/**
 * Finds and removes the wheels a generated body arrived with.
 *
 * The bodies were all asked for with empty arches and all came back with
 * wheels anyway, which is a problem rather than a bonus: wheels have to spin
 * and steer, so they must be separate instances. A baked wheel is easy to
 * recognise without recognising anything else about the mesh - it is the only
 * part of a car that touches the road, and it does so in two short runs along
 * the length, out at the flanks. Everything inside those cylinders goes.
 *
 * The transform is deliberately computed BEFORE this runs, so the car keeps
 * the ride height its own tyres gave it. A model that never had wheels is
 * lifted by the blueprint's ride height instead, because its lowest point is
 * its underbody.
 *
 * Returns the axle positions it found as well: the generated wheelbase can
 * differ from the blueprint's by most of a metre on a truck, and drawing the
 * wheels where the arches actually are matters more than agreeing with a
 * number the simulation only uses for its own steering model.
 */
export function detectAndCutWheels(
  positions: ArrayLike<number>,
  index: ArrayLike<number>,
  params: WheelCutParams,
): WheelDetection {
  const triangles = Math.floor(index.length / 3);
  const halfLength = params.length * 0.5;
  const flank = FLANK_FRACTION * params.halfWidth;
  const step = params.length / WHEEL_BINS;

  const centroidX = new Float64Array(triangles);
  const centroidY = new Float64Array(triangles);
  const centroidZ = new Float64Array(triangles);
  const binLowest = new Float64Array(WHEEL_BINS).fill(Infinity);
  for (let t = 0; t < triangles; t += 1) {
    const a = index[t * 3] ?? 0;
    const b = index[t * 3 + 1] ?? 0;
    const c = index[t * 3 + 2] ?? 0;
    const x = ((positions[a * 3] ?? 0) + (positions[b * 3] ?? 0) + (positions[c * 3] ?? 0)) / 3;
    const y =
      ((positions[a * 3 + 1] ?? 0) + (positions[b * 3 + 1] ?? 0) + (positions[c * 3 + 1] ?? 0)) / 3;
    const z =
      ((positions[a * 3 + 2] ?? 0) + (positions[b * 3 + 2] ?? 0) + (positions[c * 3 + 2] ?? 0)) / 3;
    centroidX[t] = x;
    centroidY[t] = y;
    centroidZ[t] = z;
    if (Math.abs(x) < flank) continue;
    const bin = Math.min(WHEEL_BINS - 1, Math.max(0, Math.floor((z + halfLength) / step)));
    if (y < (binLowest[bin] as number)) binLowest[bin] = y;
  }

  const threshold = GROUND_FRACTION * params.wheelRadius;
  const clusters: WheelCluster[] = [];
  let start = -1;
  for (let bin = 0; bin <= WHEEL_BINS; bin += 1) {
    const grounded = bin < WHEEL_BINS && (binLowest[bin] as number) < threshold;
    if (grounded && start < 0) start = bin;
    if (!grounded && start >= 0) {
      const z0 = -halfLength + start * step;
      const z1 = -halfLength + bin * step;
      // The run is the chord of the tyre at the detection height, which for a
      // circle cut at 0.4 of its radius is 1.6 radii wide.
      const radius = (z1 - z0) / 1.6;
      const centre = (z0 + z1) * 0.5;
      if (
        radius > 0.72 * params.wheelRadius &&
        radius < 1.6 * params.wheelRadius &&
        Math.abs(centre) < 0.4 * params.length
      ) {
        clusters.push({ z: centre, radius });
      }
      start = -1;
    }
  }

  const nearest = (target: number): WheelCluster | null => {
    let best: WheelCluster | null = null;
    let bestDistance = AXLE_TOLERANCE;
    for (const cluster of clusters) {
      const distance = Math.abs(cluster.z - target);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = cluster;
      }
    }
    return best;
  };
  const front = nearest(params.frontAxleZ);
  const rear = nearest(params.rearAxleZ);
  const chosen = [front, rear].filter((c): c is WheelCluster => c !== null);

  if (chosen.length === 0) {
    return {
      mount: {
        frontZ: params.frontAxleZ,
        rearZ: params.rearAxleZ,
        halfTrack: params.track * 0.5,
        radius: 0,
      },
      arches: [],
      cut: false,
      index: Uint32Array.from(index as ArrayLike<number>),
      removed: 0,
      extra: null,
      // Nothing touched the road, so the model's floor is its underbody and it
      // has to be lifted onto the wheels the renderer will draw for it.
      lift: params.rideHeight,
      detected: clusters.length,
      leftInPlace: clusters.length,
    };
  }

  // Track: the tyres' own centre plane, taken from the contact patches.
  let trackSum = 0;
  let trackCount = 0;
  for (let t = 0; t < triangles; t += 1) {
    if ((centroidY[t] as number) > 0.35 * params.wheelRadius) continue;
    if (Math.abs(centroidX[t] as number) < 0.5 * params.halfWidth) continue;
    for (const cluster of chosen) {
      if (Math.abs((centroidZ[t] as number) - cluster.z) < cluster.radius * 0.6) {
        trackSum += Math.abs(centroidX[t] as number);
        trackCount += 1;
        break;
      }
    }
  }

  const xCut = (trackCount > 20 ? trackSum / trackCount : params.track * 0.5) - params.wheelWidth * 1.15;
  const clip = new ArchClipper(positions, params.normals, params.uvs);
  const kept: number[] = [];
  let removed = 0;

  for (let t = 0; t < triangles; t += 1) {
    const a = index[t * 3] ?? 0;
    const b = index[t * 3 + 1] ?? 0;
    const c = index[t * 3 + 2] ?? 0;
    let hitCluster = -1;
    if (Math.abs(centroidX[t] as number) >= xCut) {
      for (let i = 0; i < chosen.length; i += 1) {
        const cluster = chosen[i] as WheelCluster;
        // Eligible when the triangle comes anywhere near this arch. The clip
        // decides what actually goes; this is only which arch to test against.
        const reach = cluster.radius + TRIANGLE_MARGIN;
        const dy = (centroidY[t] as number) - cluster.radius;
        const dz = (centroidZ[t] as number) - cluster.z;
        if (dy * dy + dz * dz < reach * reach) {
          hitCluster = i;
          break;
        }
      }
    }
    if (hitCluster < 0) {
      kept.push(a, b, c);
      continue;
    }
    const cluster = chosen[hitCluster] as WheelCluster;
    const result = clip.subtractArch(a, b, c, cluster.z, cluster.radius, kept);
    if (result === 'dropped' || result === 'cut') removed += 1;
    if (result === 'kept') kept.push(a, b, c);
  }

  return {
    mount: {
      frontZ: front ? front.z : params.frontAxleZ,
      rearZ: rear ? rear.z : params.rearAxleZ,
      halfTrack: trackCount > 20 ? trackSum / trackCount : params.track * 0.5,
      // The mean of the tyres actually found, so a model whose front and rear
      // wheels measured a few millimetres apart gets one radius rather than a
      // wheel that changes size front to back.
      radius: chosen.reduce((sum, cluster) => sum + cluster.radius, 0) / chosen.length,
    },
    // The opening the clip left is EXACTLY the polygon it cut against, so the
    // well behind it only has to be the corner radius of that polygon. This is
    // the number that used to be a guess plus whatever the worst dropped
    // triangle reached, and the difference is the whole reason a dark ring
    // used to ring every wheel: see the comment on `subtractArch`.
    arches: chosen.map((cluster) => ({
      z: cluster.z,
      centreY: cluster.radius,
      // The polygon's own corner radius, which is the tyre's: an inscribed
      // polygon touches the circle at its vertices and is inside it elsewhere.
      radius: cluster.radius,
    })),
    cut: true,
    index: Uint32Array.from(kept),
    removed,
    extra: clip.harvest(),
    lift: 0,
    detected: clusters.length,
    leftInPlace: clusters.length - chosen.length,
  };
}

export interface WheelMeasurement {
  /** Model axis the wheel turns about: its shortest extent. */
  readonly axleAxis: 0 | 1 | 2;
  readonly halfWidth: number;
  readonly radius: number;
  readonly centre: readonly [number, number, number];
  readonly vertices: number;
}

export interface WheelFit {
  readonly scale: readonly [number, number, number];
  readonly matrix: Matrix16;
}

/** Measures a road wheel: shortest axis is the axle, the others the rolling circle. */
export function measureWheel(positions: ArrayLike<number>): WheelMeasurement {
  const count = Math.floor(positions.length / 3);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[i * 3 + axis] ?? 0;
      if (value < (min[axis] as number)) min[axis] = value;
      if (value > (max[axis] as number)) max[axis] = value;
    }
  }
  if (count === 0) {
    min[0] = min[1] = min[2] = 0;
    max[0] = max[1] = max[2] = 0;
  }
  const extent: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  let axleAxis: 0 | 1 | 2 = 0;
  if (extent[1] < extent[axleAxis]) axleAxis = 1;
  if (extent[2] < extent[axleAxis]) axleAxis = 2;
  const rolling = [0, 1, 2].filter((axis) => axis !== axleAxis) as [number, number];
  return {
    axleAxis,
    halfWidth: extent[axleAxis] * 0.5,
    radius: Math.max(extent[rolling[0]] ?? 0, extent[rolling[1]] ?? 0) * 0.5,
    centre: [(min[0] + max[0]) * 0.5, (min[1] + max[1]) * 0.5, (min[2] + max[2]) * 0.5],
    vertices: count,
  };
}

/**
 * Normalises a wheel to unit radius and unit half width with its axle on X,
 * which is the shape `TrafficRenderer` scales per vehicle.
 *
 * `outerFaceTowardsMax` says which way the styled face of the rim points; the
 * wheel is turned so it ends up at +X, and the renderer swings the near-side
 * wheels through half a turn so both sides of the car show the rim.
 */
export function fitWheel(measurement: WheelMeasurement, outerFaceTowardsMax: boolean): WheelFit {
  const halfWidth = measurement.halfWidth > 1e-9 ? measurement.halfWidth : 1;
  const radius = measurement.radius > 1e-9 ? measurement.radius : 1;
  const scale: [number, number, number] = [1 / radius, 1 / radius, 1 / radius];
  scale[measurement.axleAxis] = 1 / halfWidth;

  let rotation: number[];
  if (measurement.axleAxis === 0) rotation = rotationY(0);
  else if (measurement.axleAxis === 1) rotation = rotationZ(-Math.PI / 2);
  else rotation = rotationY(Math.PI / 2);
  if (!outerFaceTowardsMax) {
    // Half a turn about the wheel's own vertical swaps which face points out.
    const flip = rotationY(Math.PI);
    const combined = new Array<number>(9).fill(0);
    for (let column = 0; column < 3; column += 1) {
      const mapped = apply3(rotation, [
        column === 0 ? 1 : 0,
        column === 1 ? 1 : 0,
        column === 2 ? 1 : 0,
      ]);
      const turned = apply3(flip, mapped);
      combined[column * 3] = turned[0];
      combined[column * 3 + 1] = turned[1];
      combined[column * 3 + 2] = turned[2];
    }
    rotation = combined;
  }

  const anchor: [number, number, number] = [
    (measurement.centre[0] ?? 0) * scale[0],
    (measurement.centre[1] ?? 0) * scale[1],
    (measurement.centre[2] ?? 0) * scale[2],
  ];
  const rotated = apply3(rotation, anchor);
  return {
    scale,
    matrix: compose(rotation, scale, [-rotated[0], -rotated[1], -rotated[2]]),
  };
}
