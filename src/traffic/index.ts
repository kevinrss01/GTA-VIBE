/**
 * Public surface of the traffic system.
 *
 * Only these names are meant to be imported from outside `src/traffic`.
 */

export { TrafficSystem, type TrafficSystemOptions } from './TrafficSystem';
export type { TrafficCollision } from './TrafficSim';
export type {
  ChassisSpec,
  ImpactReport,
  TrafficContext,
  TrafficObstacle,
  VehicleControl,
  VehicleHandle,
  VehicleImpact,
  VehicleKind,
  VehicleView,
} from './types';
// The damage scale, so combat and the police can talk about a write-off in the
// same units the simulation uses rather than each carrying their own number.
export { VEHICLE_INTEGRITY, impactDamage } from './types';
export { ALL_VEHICLE_KINDS, POLICE_KINDS, VEHICLE_BLUEPRINTS } from './VehicleCatalogue';
