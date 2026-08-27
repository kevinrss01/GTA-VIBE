/**
 * Public surface of the traffic system.
 *
 * Only these names are meant to be imported from outside `src/traffic`.
 */

export { TrafficSystem, type TrafficSystemOptions } from './TrafficSystem';
export type {
  ChassisSpec,
  TrafficContext,
  TrafficObstacle,
  VehicleControl,
  VehicleHandle,
  VehicleKind,
  VehicleView,
} from './types';
export { ALL_VEHICLE_KINDS, POLICE_KINDS, VEHICLE_BLUEPRINTS } from './VehicleCatalogue';
