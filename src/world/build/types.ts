/**
 * The contract every geometry builder in the city writes against.
 *
 * A builder never creates a material, a mesh, or a scene node. It emits
 * geometry under a material key, instances of shared props, colliders, and
 * lights, and the chunk that owns it decides how to batch all of that. Keeping
 * builders on this narrow interface is what lets the whole city be merged down
 * to a handful of draw calls per chunk without any builder knowing about it.
 *
 * All geometry is emitted in WORLD SPACE. Builders apply their own transforms
 * before handing geometry over.
 */

import type { BufferGeometry, Matrix4 } from 'three';

import type { MaterialKey } from '../../render/materials';

/** An axis-aligned collision box in world space, optionally rotated about Y. */
export interface ColliderBox {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  /** Floor height. The player can step onto this if the rise is small enough. */
  readonly bottom: number;
  readonly top: number;
  /** Solid boxes block movement; `false` marks a walkable platform such as a step. */
  readonly solid: boolean;
  /**
   * What this box is MADE OF, when the builder happens to know.
   *
   * Optional, and most builders leave it off. It exists so a bullet striking a
   * shopfront can throw glass rather than the same pale stone dust every other
   * surface throws, and so a footstep on a hangar floor is not decided by
   * guessing from the terrain underneath it. Nothing about collision reads it -
   * a box with no surface behaves exactly as it always did.
   */
  readonly surface?: MaterialKey;
}

/** A shared prop placed many times through an InstancedMesh. */
export type PropKey =
  | 'streetLamp'
  | 'bollard'
  | 'bench'
  | 'litterBin'
  | 'hydrant'
  | 'utilityPole'
  | 'drainGrate'
  | 'trafficSign'
  | 'planter'
  | 'acUnit'
  | 'satelliteDish'
  | 'roofVent'
  | 'waterTank'
  | 'palmTree'
  | 'broadleafTree'
  | 'shrub'
  | 'crate'
  | 'pallet'
  | 'dumpster'
  | 'meterBox'
  | 'cafeTable'
  | 'cafeChair'
  | 'newsBox'
  | 'mooringBollard'
  | 'busShelter'
  | 'phoneKiosk'
  | 'newsStand'
  /* Airside ground equipment and the airfield's own furniture. */
  | 'airStairs'
  | 'baggageTug'
  | 'baggageCart'
  | 'fuelBowser'
  | 'gpuCart'
  | 'windsock';

/** A point light the world wants; the renderer decides how many it can afford. */
export interface LightRequest {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly color: number;
  readonly intensity: number;
  readonly distance: number;
  /** Higher priority lights survive when the budget is exceeded. */
  readonly priority: number;
}

/** A place the player can interact with using E. */
export interface InteractionPoint {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly prompt: string;
  readonly kind: 'door' | 'sign' | 'view';
  /** For doors: where the player ends up, and which side they came from. */
  readonly target?: { x: number; y: number; z: number; heading: number } | undefined;
  readonly parcelId?: string | undefined;
}

export interface GeometrySink {
  /**
   * Adds world-space geometry under a material key. The sink takes ownership;
   * the caller must not reuse or dispose the geometry afterwards.
   */
  add(key: MaterialKey, geometry: BufferGeometry): void;
  /** Places one instance of a shared prop. */
  instance(prop: PropKey, matrix: Matrix4): void;
  /** Registers a collider. */
  collider(box: ColliderBox): void;
  /** Requests a local light. */
  light(request: LightRequest): void;
  /** Registers something the player can interact with. */
  interaction(point: InteractionPoint): void;
}

/** Counters a sink keeps so the build can be reported and budgeted. */
export interface BuildStats {
  geometries: number;
  triangles: number;
  instances: number;
  colliders: number;
  lights: number;
}

/** Every prop the world can place. Used to build the instanced geometry table. */
export const ALL_PROP_KEYS: readonly PropKey[] = [
  'streetLamp',
  'bollard',
  'bench',
  'litterBin',
  'hydrant',
  'utilityPole',
  'drainGrate',
  'trafficSign',
  'planter',
  'acUnit',
  'satelliteDish',
  'roofVent',
  'waterTank',
  'palmTree',
  'broadleafTree',
  'shrub',
  'crate',
  'pallet',
  'dumpster',
  'meterBox',
  'cafeTable',
  'cafeChair',
  'newsBox',
  'mooringBollard',
  'busShelter',
  'phoneKiosk',
  'newsStand',
  'airStairs',
  'baggageTug',
  'baggageCart',
  'fuelBowser',
  'gpuCart',
  'windsock',
];
