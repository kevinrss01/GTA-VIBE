/**
 * Everything the rest of the game needs from the air module, in one import.
 *
 *   import { AircraftSystem, Flying, FLIGHT_CONTROLS, airQaSection } from './air';
 *
 * `main.ts` should need nothing from inside `src/air` beyond this file.
 */

export {
  AIRCRAFT,
  ALL_AIRCRAFT_TYPES,
  FLYABLE_AIRCRAFT_TYPES,
  approachSpeed,
  neverExceedSpeed,
  rotateSpeed,
  stallSpeed,
  wingLoading,
  type AircraftSpec,
  type AircraftType,
  type EngineKind,
} from './AircraftCatalogue';

export {
  AircraftSystem,
  STAND_FLEET,
  enterRadius,
  type AircraftHandle,
  type AircraftInfo,
  type AircraftPose,
  type AircraftSystemOptions,
  type AircraftSystemStats,
} from './AircraftSystem';

export {
  FLIGHT_CONTROLS,
  Flying,
  flightControlHints,
  type EngineReport,
  type FlyingOptions,
  type FlyingPlayer,
  type FlyingState,
} from './Flying';

export {
  FLIGHT_STEP,
  advanceFlight,
  airDensity,
  createFlightControls,
  createFlightEvents,
  createFlightState,
  dragCoefficient,
  levelFlightSpeed,
  liftCoefficient,
  stallFraction,
  stepFlight,
  thrustAt,
  trimLevelFlight,
  type FlightControls,
  type FlightEvents,
  type FlightState,
  type FlightWorld,
  type TrimSolution,
} from './flight';

import type { AircraftSystem as System } from './AircraftSystem';
import type { AircraftType } from './AircraftCatalogue';
import type { Flying as Pilot } from './Flying';

/**
 * The `air` section of `window.__meridian`, ready to be dropped in.
 *
 * A getter-based object rather than a snapshot so QA always reads the live
 * state, and a plain structure so it survives `JSON.stringify` in a browser
 * automation step. `place` is the one thing here that is not read-only: it
 * moves a parked aircraft to a point and puts the player in it, which is what
 * makes an airborne check reproducible without flying a take-off first.
 */
export function airQaSection(aircraft: System, flying: Pilot): {
  readonly aircraft: unknown;
  readonly flight: unknown;
  readonly stats: unknown;
  place(type: AircraftType, x: number, z: number, heading?: number, altitude?: number): boolean;
  nearest(x: number, z: number): unknown;
  exit(): boolean;
} {
  return {
    get aircraft(): unknown {
      return aircraft.list.map((craft) => ({
        id: craft.id,
        type: craft.type,
        x: craft.x,
        y: craft.y,
        z: craft.z,
        yaw: craft.yaw,
        piloted: craft.piloted,
        standId: craft.standId,
        wrecked: craft.wrecked,
        flyable: craft.spec.flyable,
      }));
    },
    get flight(): unknown {
      return flying.state;
    },
    get stats(): unknown {
      return aircraft.stats;
    },
    place(
      type: AircraftType,
      x: number,
      z: number,
      heading = 0,
      altitude?: number,
    ): boolean {
      return altitude === undefined
        ? flying.placeInAircraft(type, x, z, heading)
        : flying.placeInAircraft(type, x, z, heading, altitude);
    },
    nearest(x: number, z: number): unknown {
      return flying.candidateAt(x, z);
    },
    exit(): boolean {
      return flying.exit();
    },
  };
}
