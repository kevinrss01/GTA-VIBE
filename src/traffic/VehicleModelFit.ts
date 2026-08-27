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
}

/** Where the renderer should mount this model's wheels, in the vehicle's frame. */
export interface WheelMount {
  readonly frontZ: number;
  readonly rearZ: number;
  readonly halfTrack: number;
}

export interface WheelDetection {
  readonly mount: WheelMount;
  /** True when the model arrived with wheels and they were removed. */
  readonly cut: boolean;
  /** The index buffer with the wheel triangles dropped. */
  readonly index: Uint32Array;
  readonly removed: number;
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
 * How far past the measured tyre radius the cut reaches.
 *
 * The radius is inferred from the run of bins the tyre grounds in, which
 * under-reads it; cutting at the bare figure leaves a ring of black triangles
 * round the top of the arch that reads as a row of teeth. Reaching well past
 * it clears the tyre completely, and the arch opening is wider than the tyre
 * anyway, so nothing of the bodywork goes with it.
 */
const WHEEL_CUT_REACH = 1.18;

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
      },
      cut: false,
      index: Uint32Array.from(index as ArrayLike<number>),
      removed: 0,
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
  const kept: number[] = [];
  let removed = 0;
  for (let t = 0; t < triangles; t += 1) {
    let drop = false;
    if (Math.abs(centroidX[t] as number) >= xCut) {
      for (const cluster of chosen) {
        const dy = (centroidY[t] as number) - cluster.radius;
        const dz = (centroidZ[t] as number) - cluster.z;
        const reach = cluster.radius * WHEEL_CUT_REACH;
        // The disc itself, plus a sweep along the bottom that catches the last
        // sliver of tyre the circle test leaves behind.
        if (
          dy * dy + dz * dz < reach * reach ||
          (Math.abs(dz) < cluster.radius * 1.15 && (centroidY[t] as number) < cluster.radius * 0.55)
        ) {
          drop = true;
          break;
        }
      }
    }
    if (drop) {
      removed += 1;
      continue;
    }
    kept.push(index[t * 3] ?? 0, index[t * 3 + 1] ?? 0, index[t * 3 + 2] ?? 0);
  }

  return {
    mount: {
      frontZ: front ? front.z : params.frontAxleZ,
      rearZ: rear ? rear.z : params.rearAxleZ,
      halfTrack: trackCount > 20 ? trackSum / trackCount : params.track * 0.5,
    },
    cut: true,
    index: Uint32Array.from(kept),
    removed,
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
