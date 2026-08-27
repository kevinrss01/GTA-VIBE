/**
 * The generated fleet: Tripo bodies and one Tripo wheel, made drawable.
 *
 * Every silhouette on the street is a generated GLB rather than authored
 * geometry. Eight bodies and one wheel cover eleven kinds; `BODY_FOR_KIND` records which kind
 * borrows which body and `docs/vehicle-assets.md` records what each cost.
 *
 * WHAT THIS MODULE HAS TO SOLVE
 *
 * 1. SIZE. An asset arrives normalised into a unit box with a centre pivot and
 *    an arbitrary heading, and the simulation - not the mesh - owns how big a
 *    vehicle is. `VehicleModelFit` measures each model robustly and returns the
 *    transform that puts it in the vehicle's own frame at the blueprint's size,
 *    nose at -Z, sitting on y = 0.
 * 2. WHEELS. Wheels have to spin and steer, so they cannot be part of the body
 *    mesh. Every body was asked for with empty arches and every one came back
 *    with wheels fitted anyway, so `detectAndCutWheels` finds and removes them
 *    and reports where the arches are; the renderer then instances one wheel
 *    asset into them, scaled per vehicle.
 * 3. LAMPS. A fused generated mesh has no surface the shader can single out as
 *    a brake light, and this project cannot afford point lights (measured at
 *    61 per cent of the frame). Instead the lamp is recovered from the model's
 *    own base colour map: red-dominant texels at the back of a car painted
 *    plain grey are its tail lenses, and those vertices get the brake channel.
 *    No geometry is added and nothing is drawn over the model.
 *
 * NOTHING ON A VEHICLE IS AUTHORED GEOMETRY. Every triangle the fleet draws
 * came out of the generator.
 *
 * A failed load is a degraded visual, never a crash: `TrafficRenderer` falls
 * back to the authored shells in `VehicleGeometry` when this returns null.
 */

import {
  BufferGeometry,
  Matrix4,
  Mesh,
  type Material,
  type MeshStandardMaterial,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

import { withTimeout } from '../world/ModelLibrary';
import { CHANNEL_BRAKE, VehicleMeshBuilder, type SurfaceStyle } from './MeshBuilder';
import { adoptVehicleMaterial } from './VehicleMaterial';
import { VEHICLE_BLUEPRINTS } from './VehicleCatalogue';
import {
  detectAndCutWheels,
  fitBody,
  fitWheel,
  measureBody,
  measureWheel,
  type BodyFit,
  type BodyMeasurement,
  type WheelArch,
  type WheelMount,
} from './VehicleModelFit';
import type { VehicleShell } from './VehicleGeometry';
import type { VehicleKind } from './types';

export type VehicleBodyId =
  | 'saloon'
  | 'compact'
  | 'crossover'
  | 'wagon'
  | 'pickup'
  | 'van'
  | 'boxTruck'
  | 'patrol';

interface BodyAsset {
  readonly path: string;
  /**
   * Which end of the model's length axis is the nose. A saloon's bonnet and
   * boot lid are within centimetres of each other, so this cannot be measured;
   * it is read off the asset and confirmed by looking at the car in the game.
   */
  readonly noseTowardsMax: boolean;
  /**
   * Whether the per-instance paint colour may recolour this body. False for a
   * model generated with its own livery, which must stay the colour it was
   * generated in.
   */
  readonly tintable: boolean;
}

/**
 * Where each body comes from.
 *
 * All eight assets share one generation recipe: plain light grey paint, dark
 * glazing, no wheels. The grey is deliberate - see `VehicleMaterial` - because
 * it is what lets one body serve a street full of differently painted cars.
 */
export const VEHICLE_BODY_ASSETS: Readonly<Record<VehicleBodyId, BodyAsset>> = {
  saloon: { path: 'models/vehicles/saloon.glb', noseTowardsMax: true, tintable: true },
  compact: { path: 'models/vehicles/compact.glb', noseTowardsMax: true, tintable: true },
  crossover: { path: 'models/vehicles/crossover.glb', noseTowardsMax: true, tintable: true },
  wagon: { path: 'models/vehicles/wagon.glb', noseTowardsMax: true, tintable: true },
  pickup: { path: 'models/vehicles/pickup.glb', noseTowardsMax: true, tintable: true },
  van: { path: 'models/vehicles/van.glb', noseTowardsMax: true, tintable: true },
  boxTruck: { path: 'models/vehicles/box-truck.glb', noseTowardsMax: true, tintable: true },
  patrol: { path: 'models/vehicles/patrol.glb', noseTowardsMax: true, tintable: false },
};

/**
 * Which body each kind is drawn with.
 *
 * Eight bodies cover eleven kinds. Three of them do double duty, and each of
 * those pairs is a real proportional match rather than a convenience: the
 * saloon body carries both the saloon and the coupe, the estate carries the
 * taxi, and the patrol saloon carries the patrol SUV because a second liveried
 * body was outside the credit budget.
 *
 * A ninth body was generated for the saloon and is NOT used: it came back as a
 * factory body-in-white with open window apertures and no glass, which reads as
 * a see-through car from across the street. Sharing an already-glazed body
 * costs one silhouette and fixes a quarter of the fleet - and hands those cars
 * working brake lights, because the unglazed shell had no red on it for the
 * lamp search to find. `docs/vehicle-assets.md` records what regenerating it
 * would cost.
 */
export const BODY_FOR_KIND: Readonly<Record<VehicleKind, VehicleBodyId>> = {
  sedan: 'saloon',
  coupe: 'saloon',
  taxi: 'wagon',
  compact: 'compact',
  crossover: 'crossover',
  wagon: 'wagon',
  pickup: 'pickup',
  van: 'van',
  boxTruck: 'boxTruck',
  patrolSedan: 'patrol',
  patrolSuv: 'patrol',
};

const WHEEL_ASSET = {
  path: 'models/vehicles/wheel.glb',
  /** Which way the styled face of the rim points along the axle. */
  outerFaceTowardsMax: true,
};

/** Surface values used where the generated maps do not reach. */
const GENERATED_BODY: SurfaceStyle = { albedo: 0xffffff, roughness: 0.35, metalness: 0.0 };
/**
 * The inside of a car: wheel wells and underbody.
 *
 * Deliberately not paintable and deliberately dark. A wheel well is moulded
 * liner and a floorpan is underseal, and neither is the colour of the car - a
 * yellow taxi with yellow wheel arches is a worse lie than the hole this
 * replaces. It carries no texture either (`aTex` stays 0 for authored
 * geometry), so it reads off `albedo` and shares the body's draw call.
 */
const VEHICLE_INTERIOR: SurfaceStyle = { albedo: 0x33373b, roughness: 0.9, metalness: 0.0 };
/**
 * How far inside the cut opening the well surface sits.
 *
 * The well is a strip of the same cylinder the cut swept. Drawing it at
 * exactly the cut radius would leave it fighting the bodywork it is supposed
 * to hide behind; a few per cent inside is enough to stay behind the panel at
 * every angle without opening a visible rim.
 */
const WELL_INSET = 0.99;
/** Clearance between the well and the wheel the renderer drops into it. */
const WELL_WHEEL_CLEARANCE = 1.06;
/**
 * How far past the cut radius the inner wing reaches.
 *
 * The cut drops a whole triangle whenever its centroid lands inside the wheel,
 * so the opening it leaves is wider than the circle it swept. The plate behind
 * the well has to cover that margin as well as the circle, and inboard there
 * is nothing for it to collide with.
 */
const WELL_CAP_MARGIN = 1.02;
/** Highest the inner wing may reach, as a fraction of the body height. */
const WELL_CAP_CEILING = 0.55;
const GENERATED_WHEEL: SurfaceStyle = { albedo: 0xffffff, roughness: 0.6, metalness: 0.0 };
/**
 * What a lit brake lamp adds. Softer than the authored shells used, because
 * here it sits on top of a lens the texture has already painted red rather
 * than on a flat dark face that has to do all the work itself.
 */
const BRAKE_EMISSION: SurfaceStyle = {
  albedo: 0xffffff,
  roughness: 0.14,
  emissive: 0xff2a0c,
  emissiveIntensity: 3.0,
  channel: CHANNEL_BRAKE,
};

/** What a load produced, for the asset report and the tests. */
export interface VehicleModelReport {
  readonly id: string;
  readonly url: string;
  readonly triangles: number;
  readonly measurement: BodyMeasurement;
}

interface LoadedAsset {
  readonly geometry: BufferGeometry;
  readonly material: MeshStandardMaterial;
  readonly measurement: BodyMeasurement;
  readonly triangles: number;
}

/** One wheel well, already sized to the opening it has to sit behind. */
interface FittedWell {
  readonly archZ: number;
  readonly centreY: number;
  readonly radius: number;
  /** Half extent of the inner wing, which has to cover the whole opening. */
  readonly capRadius: number;
  /** The inner wing is clipped to this band so it stays inside the body. */
  readonly capBottom: number;
  readonly capTop: number;
  readonly xInner: number;
  readonly xOuter: number;
}

interface FittedBody {
  /** Positions already in the vehicle's frame, metres, nose at -Z. */
  readonly geometry: BufferGeometry;
  readonly material: MeshStandardMaterial;
  readonly fit: BodyFit;
  readonly tintable: boolean;
  readonly mount: WheelMount;
  /** Where the cut opened the bodywork, and how wide the flank is there. */
  readonly wells: readonly FittedWell[];
  /** Height and extent of the plate that closes the underbody. */
  readonly floor: { readonly y: number; readonly halfWidth: number; readonly from: number; readonly to: number } | null;
  /** Wheel triangles removed from the generated body. */
  readonly wheelsRemoved: number;
  /** Vertices sitting on the model's own tail lamps, or null if it has none. */
  readonly brakeLamps: Uint8Array | null;
}

/**
 * Flattens a loaded scene into one geometry with the node transforms baked in.
 *
 * Generated vehicle assets are a single mesh with a single material in
 * practice; anything else is refused rather than silently drawn with the wrong
 * surface, because a car is too visible to degrade quietly.
 */
function flatten(root: Object3D): { geometry: BufferGeometry; material: MeshStandardMaterial } | null {
  const geometries: BufferGeometry[] = [];
  let material: MeshStandardMaterial | null = null;

  root.updateMatrixWorld(true);
  root.traverse((child: Object3D) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const geometry = mesh.geometry.clone();
    geometry.applyMatrix4(mesh.matrixWorld);
    for (const name of Object.keys(geometry.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') geometry.deleteAttribute(name);
    }
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    geometries.push(geometry);
    if (!material) {
      const first = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      material = (first as MeshStandardMaterial) ?? null;
    }
  });

  if (geometries.length === 0 || !material) return null;
  const merged =
    geometries.length === 1
      ? (geometries[0] as BufferGeometry)
      : mergeGeometries(geometries, false);
  if (!merged) return null;
  if (geometries.length > 1) for (const g of geometries) g.dispose();
  if (!merged.getIndex()) {
    // Everything downstream walks an index buffer.
    const count = merged.getAttribute('position').count;
    const index = new Uint32Array(count);
    for (let i = 0; i < count; i += 1) index[i] = i;
    merged.setIndex(Array.from(index));
  }
  return { geometry: merged, material };
}

/**
 * Reads a texture into a small pixel buffer so the loader can look at it.
 *
 * Returns null wherever the browser will not hand the pixels back - a missing
 * image, no 2D context - because a car without brake lights is a small loss
 * and a car that fails to load is not.
 */
function readTexture(image: unknown, size: number): ImageData | null {
  try {
    const source = image as CanvasImageSource | null;
    if (!source) return null;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(source, 0, 0, size, size);
    return context.getImageData(0, 0, size, size);
  } catch {
    return null;
  }
}

/** Sampling resolution for the lamp search. The lenses are about 1% of the map. */
const LAMP_SAMPLE_SIZE = 512;
/** How far back a lamp texel has to be, as a fraction of the half length. */
const LAMP_REAR_FRACTION = 0.55;

/**
 * Finds the vertices sitting on the model's own tail lamps.
 *
 * This is the answer to a problem a fused generated mesh creates: the whole
 * car is one material, so there is no surface the renderer can single out and
 * light up when `vehicle.braking` goes true. But the models were generated
 * with red lenses, and red is the one thing on a car painted plain grey that
 * nothing else is - so the lamp can be recovered from the base colour map
 * itself. Every vertex whose texel is red-dominant and which sits in the back
 * of the car gets the brake channel, and the shader adds emission there when
 * the instance is braking.
 *
 * It adds no geometry and no lights, and it fails cleanly: a body generated
 * with no red on it anywhere gets no mask and simply has no responsive brake
 * lights. Every body actually shipped has lenses, so every car has them.
 */
function findBrakeLamps(
  material: MeshStandardMaterial,
  uv: ArrayLike<number> | null,
  positions: ArrayLike<number>,
  halfLength: number,
): Uint8Array | null {
  if (!uv) return null;
  const pixels = readTexture(material.map?.image, LAMP_SAMPLE_SIZE);
  if (!pixels) return null;

  const count = Math.floor(positions.length / 3);
  const mask = new Uint8Array(count);
  const data = pixels.data;
  const size = pixels.width;
  const rearFrom = halfLength * LAMP_REAR_FRACTION;
  let found = 0;
  for (let i = 0; i < count; i += 1) {
    if ((positions[i * 3 + 2] ?? 0) < rearFrom) continue;
    const u = uv[i * 2] ?? 0;
    // glTF UVs have V running down from the top left, which is also how the
    // canvas lays the image out, so no flip is needed here.
    const v = uv[i * 2 + 1] ?? 0;
    const px = Math.min(size - 1, Math.max(0, Math.round(u * (size - 1))));
    const py = Math.min(size - 1, Math.max(0, Math.round(v * (size - 1))));
    const at = (py * size + px) * 4;
    const r = data[at] ?? 0;
    const g = data[at + 1] ?? 0;
    const b = data[at + 2] ?? 0;
    if (r > 60 && r - Math.max(g, b) > 26) {
      mask[i] = 1;
      found += 1;
    }
  }
  return found > 0 ? mask : null;
}

/**
 * How far out the bodywork reaches beside one wheel arch.
 *
 * The well has to end flush with the flank it sits behind, and the flank is
 * not where the bounding box says it is: a saloon's widest point is its belt
 * line, well above the arch, and its sills tuck in below. Measuring the kept
 * triangles in the arch's own band gives the number the well actually needs,
 * and taking it from the kept index rather than the raw vertex array is what
 * keeps the tyre that was just cut away from setting it.
 */
function flankAtArch(
  positions: ArrayLike<number>,
  index: ArrayLike<number>,
  arch: WheelArch,
): number {
  let widest = 0;
  const lowest = 0.02;
  const highest = arch.centreY + arch.radius;
  for (let i = 0; i < index.length; i += 1) {
    const v = index[i] ?? 0;
    const y = positions[v * 3 + 1] ?? 0;
    if (y < lowest || y > highest) continue;
    const z = positions[v * 3 + 2] ?? 0;
    if (Math.abs(z - arch.z) > arch.radius) continue;
    const x = Math.abs(positions[v * 3] ?? 0);
    if (x > widest) widest = x;
  }
  return widest;
}

/**
 * Sizes the wheel wells and the underbody plate for one fitted body.
 *
 * Everything here is derived from what the cut actually did rather than from
 * the blueprint, because the two disagree: a generated wheelbase can be most
 * of a metre away from the blueprint's on a truck, and a well in the wrong
 * place is a hole in a different position rather than no hole.
 */
function fitInterior(
  positions: ArrayLike<number>,
  index: ArrayLike<number>,
  arches: readonly WheelArch[],
  mount: WheelMount,
  wheelRadius: number,
  wheelWidth: number,
  bodyHeight: number,
): { wells: FittedWell[]; floor: FittedBody['floor'] } {
  let lowest = Infinity;
  for (let i = 0; i < index.length; i += 1) {
    const v = index[i] ?? 0;
    const y = positions[v * 3 + 1] ?? 0;
    if (y < lowest) lowest = y;
  }
  const floorY = (Number.isFinite(lowest) ? lowest : 0) + 0.03;
  const wells: FittedWell[] = [];
  const xInner = Math.max(0.05, mount.halfTrack - wheelWidth * 0.5 - 0.07);
  for (const arch of arches) {
    // Inside the opening so the panel always covers the join, but never so
    // tight that the wheel the renderer drops in pokes through it.
    const radius = Math.max(arch.radius * WELL_INSET, wheelRadius * WELL_WHEEL_CLEARANCE);
    const flank = flankAtArch(positions, index, arch);
    const xOuter = Math.max(flank, mount.halfTrack + wheelWidth * 0.5);
    if (xOuter <= xInner) continue;
    wells.push({
      archZ: arch.z,
      centreY: arch.centreY,
      radius,
      capRadius: Math.max(radius, arch.radius) * WELL_CAP_MARGIN,
      // Never below the floorpan and never up into the glazing: outside that
      // band there is no bodywork to hide behind.
      capBottom: floorY,
      capTop: bodyHeight * WELL_CAP_CEILING,
      xInner,
      xOuter,
    });
  }

  // The underbody: what you see when you crouch beside a car and look under
  // it. Set just above the model's own lowest point, so a body that already
  // has a floor keeps it - that one is nearer the eye and wins the depth test
  // - and one that does not gets this instead of a view up into the roof.
  const first = wells[0];
  const last = wells[wells.length - 1];
  const floor =
    first && last && Number.isFinite(lowest)
      ? {
          y: floorY,
          halfWidth: xInner,
          from: Math.min(first.archZ, last.archZ) - first.radius,
          to: Math.max(first.archZ, last.archZ) + last.radius,
        }
      : null;
  return { wells, floor };
}

function buildFitted(fitted: FittedBody, lamps: boolean): VehicleShell {
  const mesh = new VehicleMeshBuilder();
  const position = fitted.geometry.getAttribute('position');
  const normal = fitted.geometry.getAttribute('normal');
  const uv = fitted.geometry.getAttribute('uv');
  const index = fitted.geometry.getIndex();
  mesh.appendTextured(
    position.array,
    normal.array,
    uv ? uv.array : null,
    index ? index.array : [],
    { ...GENERATED_BODY, paint: fitted.tintable },
    lamps ? fitted.brakeLamps : null,
    BRAKE_EMISSION,
  );

  // Close what the wheel cut opened. This is authored geometry appended to the
  // SAME builder, so it joins the body's own batch: the fleet still draws in
  // one call per shell plus one for every wheel in the city.
  for (const well of fitted.wells) {
    for (const side of [-1, 1] as const) {
      mesh.wheelWell(
        side,
        well.archZ,
        well.centreY,
        well.radius,
        well.capRadius,
        well.capBottom,
        well.capTop,
        well.xInner,
        well.xOuter,
        VEHICLE_INTERIOR,
      );
    }
  }
  const floor = fitted.floor;
  if (floor) {
    mesh.quad(
      [-floor.halfWidth, floor.y, floor.from],
      [floor.halfWidth, floor.y, floor.from],
      [floor.halfWidth, floor.y, floor.to],
      [-floor.halfWidth, floor.y, floor.to],
      VEHICLE_INTERIOR,
      [0, -1, 0],
    );
  }
  return { geometry: mesh.build(), triangles: mesh.triangleCount };
}

export interface VehicleModelOptions {
  /** Prefix for the asset URLs, normally `import.meta.env.BASE_URL`. */
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  /** Lay emissive brake and head lamps on the generated bodies. Default true. */
  readonly lamps?: boolean;
}

/**
 * The loaded fleet. Built by `loadVehicleModels`; owned and disposed by
 * `TrafficSystem`.
 */
export class VehicleModelSet {
  private readonly fitted = new Map<VehicleKind, FittedBody>();
  private readonly assets = new Map<VehicleBodyId, LoadedAsset>();
  private wheelGeometry: BufferGeometry | null = null;
  private wheelMaterialValue: MeshStandardMaterial | null = null;
  private readonly lamps: boolean;

  readonly reports: VehicleModelReport[] = [];

  constructor(lamps: boolean) {
    this.lamps = lamps;
  }

  /** True once every kind and the wheel are ready to draw. */
  get complete(): boolean {
    return this.fitted.size === Object.keys(BODY_FOR_KIND).length && this.wheelGeometry !== null;
  }

  addBody(id: VehicleBodyId, asset: LoadedAsset, report: VehicleModelReport): void {
    this.assets.set(id, asset);
    this.reports.push(report);
    const bodyAsset = VEHICLE_BODY_ASSETS[id];
    for (const kind of Object.keys(BODY_FOR_KIND) as VehicleKind[]) {
      if (BODY_FOR_KIND[kind] !== id) continue;
      const bp = VEHICLE_BLUEPRINTS[kind];
      const fit = fitBody(
        asset.measurement,
        { length: bp.length, width: bp.width, height: bp.height },
        bodyAsset.noseTowardsMax,
      );
      const geometry = asset.geometry.clone();
      geometry.applyMatrix4(new Matrix4().fromArray(fit.matrix as number[]));

      // The generated bodies all came back with wheels fitted, which have to
      // go: a wheel that cannot spin or steer is worse than no wheel at all.
      const positions = geometry.getAttribute('position');
      const sourceIndex = geometry.getIndex();
      const detection = detectAndCutWheels(positions.array, sourceIndex ? sourceIndex.array : [], {
        halfWidth: fit.metres.width * 0.5,
        length: bp.length,
        wheelRadius: bp.wheelRadius,
        wheelWidth: bp.wheelWidth,
        frontAxleZ: -bp.chassis.frontAxle,
        rearAxleZ: bp.chassis.wheelbase - bp.chassis.frontAxle,
        track: bp.chassis.track,
        rideHeight: bp.rideHeight,
      });
      if (detection.removed > 0) geometry.setIndex(Array.from(detection.index));
      if (detection.lift !== 0) {
        geometry.applyMatrix4(new Matrix4().makeTranslation(0, detection.lift, 0));
      }
      geometry.computeBoundingBox();

      const uv = geometry.getAttribute('uv');
      const keptIndex = geometry.getIndex();
      const interior = fitInterior(
        geometry.getAttribute('position').array,
        keptIndex ? keptIndex.array : [],
        detection.arches,
        detection.mount,
        bp.wheelRadius,
        bp.wheelWidth,
        bp.height,
      );
      this.fitted.set(kind, {
        geometry,
        material: asset.material,
        fit,
        tintable: bodyAsset.tintable,
        mount: detection.mount,
        wells: interior.wells,
        floor: interior.floor,
        wheelsRemoved: detection.removed,
        brakeLamps: findBrakeLamps(
          asset.material,
          uv ? uv.array : null,
          geometry.getAttribute('position').array,
          bp.length * 0.5,
        ),
      });
    }
  }

  addWheel(geometry: BufferGeometry, material: MeshStandardMaterial, report: VehicleModelReport): void {
    this.wheelGeometry = geometry;
    this.wheelMaterialValue = material;
    this.reports.push(report);
  }

  /** How the model for one kind ended up sized, in metres. */
  fitFor(kind: VehicleKind): BodyFit | null {
    return this.fitted.get(kind)?.fit ?? null;
  }

  /**
   * Where this model's arches are, so the renderer can put the wheels in them.
   * Null falls the renderer back to the chassis numbers.
   */
  wheelMountFor(kind: VehicleKind): WheelMount | null {
    return this.fitted.get(kind)?.mount ?? null;
  }

  /** Wheel triangles removed from one kind's generated body. */
  wheelsRemovedFor(kind: VehicleKind): number {
    return this.fitted.get(kind)?.wheelsRemoved ?? 0;
  }

  materialFor(kind: VehicleKind): Material | null {
    return this.fitted.get(kind)?.material ?? null;
  }

  get wheelMaterial(): Material | null {
    return this.wheelMaterialValue;
  }

  /** A fresh shell for one kind. The caller owns and disposes the geometry. */
  buildShell(kind: VehicleKind): VehicleShell | null {
    const fitted = this.fitted.get(kind);
    if (!fitted) return null;
    return buildFitted(fitted, this.lamps);
  }

  /** A fresh wheel. The caller owns and disposes the geometry. */
  buildWheel(): VehicleShell | null {
    const source = this.wheelGeometry;
    if (!source) return null;
    const mesh = new VehicleMeshBuilder();
    const position = source.getAttribute('position');
    const normal = source.getAttribute('normal');
    const uv = source.getAttribute('uv');
    const index = source.getIndex();
    mesh.appendTextured(position.array, normal.array, uv ? uv.array : null, index ? index.array : [], {
      ...GENERATED_WHEEL,
      paint: true,
    });
    return { geometry: mesh.build(), triangles: mesh.triangleCount };
  }

  dispose(): void {
    for (const fitted of this.fitted.values()) fitted.geometry.dispose();
    this.fitted.clear();
    for (const asset of this.assets.values()) {
      asset.geometry.dispose();
      asset.material.dispose();
    }
    this.assets.clear();
    this.wheelGeometry?.dispose();
    this.wheelGeometry = null;
    this.wheelMaterialValue?.dispose();
    this.wheelMaterialValue = null;
  }
}

/**
 * Loads every vehicle asset. Returns null if any of them is missing or
 * malformed, so the fleet is either wholly generated or wholly authored and
 * never a mixture of two different looks.
 */
export async function loadVehicleModels(
  options: VehicleModelOptions,
): Promise<VehicleModelSet | null> {
  const loader = new GLTFLoader();
  const timeoutMs = options.timeoutMs ?? 20000;
  const set = new VehicleModelSet(options.lamps ?? true);

  const loadOne = async (
    url: string,
  ): Promise<{ geometry: BufferGeometry; material: MeshStandardMaterial } | null> => {
    const gltf = await withTimeout(loader.loadAsync(url), timeoutMs, url);
    return flatten(gltf.scene);
  };

  try {
    const bodyIds = Object.keys(VEHICLE_BODY_ASSETS) as VehicleBodyId[];
    const bodies = await Promise.all(
      bodyIds.map(async (id) => {
        const url = `${options.baseUrl}${VEHICLE_BODY_ASSETS[id].path}`;
        return { id, url, flat: await loadOne(url) };
      }),
    );
    const wheelUrl = `${options.baseUrl}${WHEEL_ASSET.path}`;
    const wheelFlat = await loadOne(wheelUrl);

    // All or nothing: a fleet that is half generated and half authored would
    // put two different looks on the same street. Anything already loaded is
    // released here rather than left to the collector.
    if (!wheelFlat || bodies.some((body) => !body.flat)) {
      wheelFlat?.geometry.dispose();
      for (const body of bodies) {
        body.flat?.geometry.dispose();
        body.flat?.material.dispose();
      }
      return null;
    }

    for (const body of bodies) {
      if (!body.flat) return null;
      const positions = body.flat.geometry.getAttribute('position').array;
      const measurement = measureBody(positions);
      const index = body.flat.geometry.getIndex();
      const triangles = (index ? index.count : positions.length / 3) / 3;
      set.addBody(
        body.id,
        {
          geometry: body.flat.geometry,
          material: adoptVehicleMaterial(body.flat.material, `vehicle-${body.id}`),
          measurement,
          triangles,
        },
        { id: body.id, url: body.url, triangles, measurement },
      );
    }

    const wheelPositions = wheelFlat.geometry.getAttribute('position').array;
    const wheelMeasurement = measureWheel(wheelPositions);
    const wheelFit = fitWheel(wheelMeasurement, WHEEL_ASSET.outerFaceTowardsMax);
    wheelFlat.geometry.applyMatrix4(new Matrix4().fromArray(wheelFit.matrix as number[]));
    wheelFlat.geometry.computeBoundingBox();
    const wheelIndex = wheelFlat.geometry.getIndex();
    set.addWheel(
      wheelFlat.geometry,
      adoptVehicleMaterial(wheelFlat.material, 'vehicle-wheel', { rubberFloor: true }),
      {
        id: 'wheel',
        url: wheelUrl,
        triangles: (wheelIndex ? wheelIndex.count : wheelPositions.length / 3) / 3,
        measurement: measureBody(wheelPositions),
      },
    );

    if (!set.complete) {
      set.dispose();
      return null;
    }
    return set;
  } catch (error) {
    // A generated asset that fails to load is a degraded visual, not a crash.
    // eslint-disable-next-line no-console
    console.warn('[meridian] vehicle models unavailable, using the authored shells', error);
    set.dispose();
    return null;
  }
}
