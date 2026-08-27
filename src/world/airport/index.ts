/**
 * Meridian Bay Regional, assembled.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   import { buildAirport } from './world/airport';
 *
 *   // in main.ts, beside the other world builders and BEFORE `buildEnvironment`
 *   buildAirport(plan, ground, sink);
 *
 * ============================================================================
 *
 * One call. Everything else the airport needs is already automatic:
 *
 *  - its roads are ordinary `Street` records in `plan.streets`, so `buildStreet`
 *    and `buildIntersections` pave them, `PropScatter` lights them, `RoadNetwork`
 *    gives them lanes and pavements and the minimap draws them;
 *  - its ground is `airportSurfaceAt`, which `CityGround.sample` consults;
 *  - its platform is in `landElevation`, so every height in the world already
 *    agrees with it.
 *
 * `buildAirport` must run BEFORE `buildEnvironment`, for the same reason the
 * street builders do: `buildTerrain` samples `CityGround` per quad to decide
 * whether to sink it, and that answer does not depend on build order, but the
 * ordering keeps the loading-progress story honest.
 */

import type { CityGround } from '../CityGround';
import type { CityPlan } from '../CityPlan';
import type { GeometrySink } from '../build/types';
import {
  buildAirfieldLighting,
  buildAirportSignage,
  buildFence,
  buildHangars,
  buildTerminalShell,
  buildTower,
} from './buildings';
import { scatterAirportProps } from './props';
import {
  buildAirportPaving,
  buildApronMarkings,
  buildCarParkMarkings,
  buildForecourtMarkings,
  buildRunwayMarkings,
  buildTaxiwayMarkings,
} from './surfaces';
import { buildTerminalInterior } from './terminal';

export function buildAirport(plan: CityPlan, ground: CityGround, sink: GeometrySink): void {
  buildAirportPaving(plan, sink);
  buildRunwayMarkings(sink);
  buildTaxiwayMarkings(sink);
  buildApronMarkings(sink);
  buildCarParkMarkings(sink);
  buildForecourtMarkings(sink);

  buildTerminalShell(sink);
  buildTerminalInterior(sink);
  buildTower(sink);
  buildHangars(sink);
  buildFence(sink);
  buildAirfieldLighting(sink);
  buildAirportSignage(sink);

  scatterAirportProps(ground, sink);
}

export { AIRPORT_EXTENT, GATE_SEATS, TERMINAL_QUEUES, airportSurfaceAt, inAirportSite } from './plan';
export { terminalModelAnchors, type TerminalModelAnchor } from './terminal';
