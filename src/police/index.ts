/**
 * The police layer's public surface.
 */

export { PoliceSystem } from './PoliceSystem';
export type {
  PoliceContext,
  PoliceEffects,
  PoliceStats,
  PoliceSystemOptions,
  PursuitTraffic,
} from './PoliceSystem';
export {
  ARREST_HEALTH,
  ARREST_RANGE,
  MAX_OFFICERS,
  MAX_UNITS,
  canArrest,
  carsForStars,
  dispatchInterval,
  officersPerCar,
  shootsOnSight,
} from './policy';
