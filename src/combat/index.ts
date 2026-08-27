/**
 * The combat layer's public surface.
 *
 * `main.ts` should only ever need these. Everything else in `src/combat` is an
 * implementation detail of hit registration or of the effect pools.
 */

export { CombatSystem } from './CombatSystem';
export type {
  CombatContext,
  CombatHud,
  CombatStats,
  CombatSystemOptions,
  CombatVehicleView,
  VehicleQuery,
  WitnessSource,
} from './CombatSystem';
export { CrowdTargets } from './CrowdTargets';
export { WeaponViewmodel, defaultViewmodels } from './WeaponViewmodel';
export type { ViewmodelSpec } from './WeaponViewmodel';
export { RespawnDirector } from './Respawn';
export type { BustReason, RespawnOptions } from './Respawn';
export { WorldRayIndex, hasLineOfSight } from './rays';
export { ACTOR_HEALTH, damageAtRange } from './ballistics';
export type { ActorSource, ActorTarget, DamageResult, LawTargets } from './targets';
