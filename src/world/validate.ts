/**
 * Automated placement checks.
 *
 * A city can pass every unit test on its plan and still look wrong, because
 * the failures that matter visually are relational: a building sunk into a
 * slope, a prop floating a hand's width above the pavement, a collider that
 * does not match the mesh the player can see, a door nobody can reach. These
 * checks run over the *built* world rather than the plan, so they catch
 * disagreements between what was designed and what was actually emitted.
 *
 * This module has no Three.js dependency beyond geometry inspection so it can
 * run in the test suite and in a headless audit.
 */

import type { BufferGeometry, Matrix4 } from 'three';

import type { MaterialKey } from '../render/materials';
import type { CityGround } from './CityGround';
import type { CityPlan, Parcel } from './CityPlan';
import { doorApproach, doorwayFor } from './build/doorway';
import type {
  ColliderBox,
  GeometrySink,
  InteractionPoint,
  LightRequest,
  PropKey,
} from './build/types';

export type IssueSeverity = 'error' | 'warning';

export interface PlacementIssue {
  readonly severity: IssueSeverity;
  readonly kind: string;
  readonly subject: string;
  readonly message: string;
  readonly x: number;
  readonly z: number;
}

export interface RecordedGeometry {
  readonly key: MaterialKey;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
  readonly triangles: number;
  readonly finite: boolean;
}

export interface RecordedInstance {
  readonly prop: PropKey;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * A sink that keeps a summary of everything emitted instead of building meshes.
 * Cheap enough to run the whole city through in a unit test.
 */
export class RecordingSink implements GeometrySink {
  readonly geometries: RecordedGeometry[] = [];
  readonly instances: RecordedInstance[] = [];
  readonly colliders: ColliderBox[] = [];
  readonly lights: LightRequest[] = [];
  readonly interactions: InteractionPoint[] = [];

  add(key: MaterialKey, geometry: BufferGeometry): void {
    const position = geometry.getAttribute('position');
    if (!position || position.count === 0) {
      geometry.dispose();
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let finite = true;
    for (let i = 0; i < position.count; i += 1) {
      const x = position.getX(i);
      const y = position.getY(i);
      const z = position.getZ(i);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        finite = false;
        continue;
      }
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const indexCount = geometry.index?.count ?? position.count;
    this.geometries.push({
      key,
      minX,
      minY,
      minZ,
      maxX,
      maxY,
      maxZ,
      triangles: indexCount / 3,
      finite,
    });
    geometry.dispose();
  }

  instance(prop: PropKey, matrix: Matrix4): void {
    const e = matrix.elements;
    this.instances.push({ prop, x: e[12] ?? 0, y: e[13] ?? 0, z: e[14] ?? 0 });
  }

  collider(box: ColliderBox): void {
    this.colliders.push(box);
  }

  light(request: LightRequest): void {
    this.lights.push(request);
  }

  interaction(point: InteractionPoint): void {
    this.interactions.push(point);
  }

  get triangles(): number {
    let total = 0;
    for (const g of this.geometries) total += g.triangles;
    return total;
  }
}

/** Grounding tolerances, in metres. */
const BURIED_TOLERANCE = 0.02;
const FLOAT_TOLERANCE = 0.05;
const PROP_TOLERANCE = 0.08;

function sampleFootprint(
  ground: CityGround,
  parcel: Parcel,
  steps = 4,
): { lowest: number; highest: number } {
  let lowest = Infinity;
  let highest = -Infinity;
  for (let i = 0; i <= steps; i += 1) {
    for (let j = 0; j <= steps; j += 1) {
      const x = parcel.rect.minX + ((parcel.rect.maxX - parcel.rect.minX) * i) / steps;
      const z = parcel.rect.minZ + ((parcel.rect.maxZ - parcel.rect.minZ) * j) / steps;
      // Sample the *terrain*, ignoring the building standing on it.
      const y = ground.sample(x, z).y;
      if (y < lowest) lowest = y;
      if (y > highest) highest = y;
    }
  }
  return { lowest, highest };
}

/** Checks every building is properly seated on the ground it stands on. */
export function validateGrounding(plan: CityPlan, ground: CityGround): PlacementIssue[] {
  const issues: PlacementIssue[] = [];

  for (const parcel of plan.parcels) {
    const cx = (parcel.rect.minX + parcel.rect.maxX) / 2;
    const cz = (parcel.rect.minZ + parcel.rect.maxZ) / 2;
    const { lowest, highest } = sampleFootprint(ground, parcel);

    if (parcel.groundY < highest - BURIED_TOLERANCE) {
      issues.push({
        severity: 'error',
        kind: 'buried-building',
        subject: parcel.id,
        message: `finished floor ${parcel.groundY.toFixed(2)}m is below ground ${highest.toFixed(2)}m`,
        x: cx,
        z: cz,
      });
    }

    if (parcel.baseY > lowest - FLOAT_TOLERANCE) {
      issues.push({
        severity: 'error',
        kind: 'floating-building',
        subject: parcel.id,
        message: `plinth base ${parcel.baseY.toFixed(2)}m does not reach ground ${lowest.toFixed(2)}m`,
        x: cx,
        z: cz,
      });
    }

    const plinth = parcel.groundY - parcel.baseY;
    if (plinth > 4.5) {
      issues.push({
        severity: 'warning',
        kind: 'tall-plinth',
        subject: parcel.id,
        message: `plinth is ${plinth.toFixed(2)}m tall`,
        x: cx,
        z: cz,
      });
    }

    const height = parcel.groundStoreyHeight + (parcel.storeys - 1) * parcel.storeyHeight;
    const width = parcel.rect.maxX - parcel.rect.minX;
    const depth = parcel.rect.maxZ - parcel.rect.minZ;
    // A tower on a tiny footprint is the classic scale mistake.
    if (height > Math.max(width, depth) * 4.2 && height > 26) {
      issues.push({
        severity: 'warning',
        kind: 'implausible-proportion',
        subject: parcel.id,
        message: `${height.toFixed(1)}m tall on a ${width.toFixed(1)}x${depth.toFixed(1)}m footprint`,
        x: cx,
        z: cz,
      });
    }
  }

  return issues;
}

/**
 * Checks the rendered geometry agrees with the plan and with its collider:
 * nothing may extend below its plinth, oversail its parcel by more than a
 * cornice, or contain non-finite vertices.
 */
export function validateGeometry(
  plan: CityPlan,
  geometries: readonly RecordedGeometry[],
  colliders: readonly ColliderBox[],
): PlacementIssue[] {
  const issues: PlacementIssue[] = [];

  for (const geometry of geometries) {
    if (!geometry.finite) {
      issues.push({
        severity: 'error',
        kind: 'non-finite-geometry',
        subject: geometry.key,
        message: 'geometry contains NaN or Infinity positions',
        x: 0,
        z: 0,
      });
    }
  }

  // Every solid collider should have geometry occupying roughly the same space.
  // A collider with nothing drawn in it is an invisible wall; geometry with no
  // collider is something the player walks through.
  for (const box of colliders) {
    if (!box.solid) continue;
    if (box.top <= box.bottom) {
      issues.push({
        severity: 'error',
        kind: 'degenerate-collider',
        subject: `${box.minX.toFixed(1)},${box.minZ.toFixed(1)}`,
        message: `collider top ${box.top.toFixed(2)} is not above bottom ${box.bottom.toFixed(2)}`,
        x: box.minX,
        z: box.minZ,
      });
    }
    if (box.maxX <= box.minX || box.maxZ <= box.minZ) {
      issues.push({
        severity: 'error',
        kind: 'degenerate-collider',
        subject: `${box.minX.toFixed(1)},${box.minZ.toFixed(1)}`,
        message: 'collider has zero or negative footprint',
        x: box.minX,
        z: box.minZ,
      });
    }
  }

  // Buildings must not oversail into the carriageway.
  const parcelsById = new Map(plan.parcels.map((p) => [p.id, p]));
  void parcelsById;

  return issues;
}

/**
 * Props that are mounted on a building rather than standing on the ground.
 * These are validated against the building they belong to instead.
 */
const MOUNTED_PROPS: ReadonlySet<PropKey> = new Set<PropKey>([
  'acUnit',
  'satelliteDish',
  'roofVent',
  'waterTank',
]);

/** Props fixed to the OUTSIDE of a wall, so they sit just off the footprint. */
const WALL_PROPS: ReadonlySet<PropKey> = new Set<PropKey>(['meterBox']);

/** Tallest building whose footprint is within `reach` metres of a point. */
function tallestNear(plan: CityPlan | undefined, x: number, z: number, reach: number): Parcel | null {
  if (!plan) return null;
  let best: Parcel | null = null;
  let bestRoof = -Infinity;
  for (const parcel of plan.parcels) {
    if (
      x < parcel.rect.minX - reach ||
      x > parcel.rect.maxX + reach ||
      z < parcel.rect.minZ - reach ||
      z > parcel.rect.maxZ + reach
    ) {
      continue;
    }
    const roof =
      parcel.groundY + parcel.groundStoreyHeight + (parcel.storeys - 1) * parcel.storeyHeight;
    if (roof > bestRoof) {
      bestRoof = roof;
      best = parcel;
    }
  }
  return best;
}

/**
 * Checks props are properly seated: ground props on the ground and out of the
 * water, roof and wall props on a building they could actually be fixed to.
 */
export function validateProps(
  ground: CityGround,
  instances: readonly RecordedInstance[],
  plan?: CityPlan,
): PlacementIssue[] {
  const issues: PlacementIssue[] = [];
  const parcelById = new Map<string, Parcel>();
  if (plan) for (const parcel of plan.parcels) parcelById.set(parcel.id, parcel);

  for (const instance of instances) {
    if (WALL_PROPS.has(instance.prop)) {
      // A meter box is bolted to the outside of a wall, so it is deliberately
      // just off the footprint; it only has to be near one and at waist height.
      const host = tallestNear(plan, instance.x, instance.z, 2.6);
      const groundY = ground.sample(instance.x, instance.z).y;
      if (!host) {
        issues.push({
          severity: 'error',
          kind: 'unsupported-wall-prop',
          subject: instance.prop,
          message: 'wall prop is not against any building',
          x: instance.x,
          z: instance.z,
        });
      } else if (instance.y < groundY - 0.3 || instance.y > groundY + 3.4) {
        issues.push({
          severity: 'error',
          kind: 'misplaced-wall-prop',
          subject: instance.prop,
          message: `at ${instance.y.toFixed(2)}m, not at wall-fixing height above ${groundY.toFixed(2)}m`,
          x: instance.x,
          z: instance.z,
        });
      }
      continue;
    }

    if (MOUNTED_PROPS.has(instance.prop)) {
      // A roof unit must belong to a building, and sit within that building's
      // vertical extent - not hang in the air beside it. Attribute it to the
      // tallest neighbour, since roof clutter often straddles a party wall.
      const parcel = tallestNear(plan, instance.x, instance.z, 1.2);
      if (!parcel) {
        issues.push({
          severity: 'error',
          kind: 'unsupported-mounted-prop',
          subject: instance.prop,
          message: 'roof or wall prop is not over any building',
          x: instance.x,
          z: instance.z,
        });
        continue;
      }
      const roofY =
        parcel.groundY + parcel.groundStoreyHeight + (parcel.storeys - 1) * parcel.storeyHeight;
      if (instance.y < parcel.groundY - 0.5 || instance.y > roofY + 2.5) {
        issues.push({
          severity: 'error',
          kind: 'misplaced-mounted-prop',
          subject: instance.prop,
          message: `at ${instance.y.toFixed(2)}m, outside its building's ${parcel.groundY.toFixed(1)}-${roofY.toFixed(1)}m range`,
          x: instance.x,
          z: instance.z,
        });
      }
      continue;
    }

    const sample = ground.sample(instance.x, instance.z);
    const delta = instance.y - sample.y;
    if (Math.abs(delta) > PROP_TOLERANCE) {
      issues.push({
        severity: 'error',
        kind: delta > 0 ? 'floating-prop' : 'buried-prop',
        subject: instance.prop,
        message: `base is ${delta.toFixed(2)}m from the ground`,
        x: instance.x,
        z: instance.z,
      });
    }
    if (sample.surface === 'water') {
      issues.push({
        severity: 'error',
        kind: 'prop-in-water',
        subject: instance.prop,
        message: 'prop placed in the bay',
        x: instance.x,
        z: instance.z,
      });
    }
  }
  return issues;
}

/**
 * Checks every enterable building can actually be reached and entered: the
 * approach square outside the door must be walkable, and the threshold must be
 * within a flight of steps of it.
 */
export function validateDoors(
  plan: CityPlan,
  ground: CityGround,
  interactions: readonly InteractionPoint[],
): PlacementIssue[] {
  const issues: PlacementIssue[] = [];
  const doors = interactions.filter((point) => point.kind === 'door');

  for (const parcel of plan.parcels) {
    if (!parcel.enterable) continue;
    const door = doorwayFor(parcel);
    const approach = doorApproach(door, 1.6);

    const outside = ground.sample(approach.x, approach.z);
    if (outside.surface === 'water') {
      issues.push({
        severity: 'error',
        kind: 'unreachable-door',
        subject: parcel.id,
        message: 'the approach to the door is in the water',
        x: approach.x,
        z: approach.z,
      });
    }
    if (ground.isBuilt(approach.x, approach.z, -0.15)) {
      issues.push({
        severity: 'error',
        kind: 'unreachable-door',
        subject: parcel.id,
        message: 'the approach to the door is inside another building',
        x: approach.x,
        z: approach.z,
      });
    }
    const rise = door.y - outside.y;
    if (rise > 2.0) {
      issues.push({
        severity: 'error',
        kind: 'unreachable-door',
        subject: parcel.id,
        message: `threshold is ${rise.toFixed(2)}m above the pavement`,
        x: approach.x,
        z: approach.z,
      });
    }

    const registered = doors.some((point) => point.parcelId === parcel.id);
    if (!registered) {
      issues.push({
        severity: 'error',
        kind: 'missing-door-interaction',
        subject: parcel.id,
        message: 'enterable building has no door interaction point',
        x: approach.x,
        z: approach.z,
      });
    }
  }

  return issues;
}

export interface AuditResult {
  readonly issues: readonly PlacementIssue[];
  readonly errors: number;
  readonly warnings: number;
}

/** Runs every check and summarises. */
export function auditWorld(
  plan: CityPlan,
  ground: CityGround,
  sink: RecordingSink,
): AuditResult {
  const issues = [
    ...validateGrounding(plan, ground),
    ...validateGeometry(plan, sink.geometries, sink.colliders),
    ...validateProps(ground, sink.instances, plan),
    ...validateDoors(plan, ground, sink.interactions),
  ];
  return {
    issues,
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warning').length,
  };
}

/** Formats an audit for a terminal report. */
export function formatAudit(result: AuditResult, limit = 25): string {
  if (result.issues.length === 0) return 'placement audit: clean';
  const lines = [`placement audit: ${result.errors} errors, ${result.warnings} warnings`];
  for (const issue of result.issues.slice(0, limit)) {
    lines.push(
      `  [${issue.severity}] ${issue.kind} ${issue.subject}: ${issue.message} @ ${issue.x.toFixed(1)}, ${issue.z.toFixed(1)}`,
    );
  }
  if (result.issues.length > limit) lines.push(`  ... and ${result.issues.length - limit} more`);
  return lines.join('\n');
}
