/**
 * The terminal's population.
 *
 * `TerminalCrowd` is the only thing a caller needs; everything else is
 * exported because the tests and the QA overlay read it.
 */

export {
  TerminalCrowd,
  type SeatPlan,
  type TerminalCrowdContext,
  type TerminalCrowdOptions,
  type TerminalCrowdStats,
  type TravellerQuality,
} from './TerminalCrowd';
export {
  BoxIndex,
  buildTerminalGraph,
  TerminalPaths,
  TRAVELLER_RADIUS,
  type FloorAnchor,
  type QueueAnchor,
  type SeatAnchor,
  type TerminalGraph,
  type TerminalGraphOptions,
} from './terminalSpace';
export {
  DEFAULT_QUEUE_SLOTS,
  QUEUE_PITCH,
  TravellerSim,
  type QueueState,
  type Traveller,
  type TravellerSimOptions,
  type TravellerSimStats,
  type TravellerState,
} from './travellerSim';
export {
  FRONT_TURNS,
  LUGGAGE_KINDS,
  LUGGAGE_SPECS,
  placeLuggage,
  placeSeated,
  SEAT_LIFT_LIMIT,
  SEATED_MODELS,
  SEATED_SPECS,
  type Carrier,
  type LuggageKind,
  type LuggageSpec,
  type PropPlacement,
  type SeatedModel,
  type SeatedSpec,
} from './props';
