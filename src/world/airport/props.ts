/**
 * Airside ground equipment, the windsock and the landside dressing.
 *
 * Placed directly rather than through `PropScatter`, which is built for street
 * corridors and pavements and knows nothing about stands or a taxiway. The one
 * rule it enforces that matters here is enforced here too: every prop is
 * seated on `CityGround.sample(x, z).y`, which is what `validateProps` checks
 * to within 0.08 m.
 *
 * Nothing is placed on the runway, the taxiway or their strips. A baggage cart
 * parked on a runway is not a dressing decision.
 */

import { Matrix4 } from 'three';

import { hash2 } from '../../core/rng';
import type { CityGround } from '../CityGround';
import { PROP_SPECS } from '../build/PropLibrary';
import type { GeometrySink, PropKey } from '../build/types';
import { APRON, CAR_PARK, HANGARS, RUNWAY, STANDS, TAXIWAY, TERMINAL } from './layout';
import { SOUTH_APRON, STAND_ENVELOPE } from './plan';

/** Placed equipment: what, where, and which way it points. */
interface Placement {
  readonly prop: PropKey;
  readonly x: number;
  readonly z: number;
  readonly heading: number;
}

/**
 * The apron's working equipment, arranged around the stands.
 *
 * A stand with nothing on it reads as a car park. Each one gets the set that
 * would actually be there between turnarounds - stairs at the door, a tug and
 * a cart at the tail, a ground power unit alongside - and the two ends of the
 * apron get the bowser and the spare carts that live there.
 *
 * ## Everything here is placed off the STAND ENVELOPE, and that is the fix
 *
 * The ground power unit used to be at a flat `stand.x + 9.5`. The stands face
 * +X, so on stand 3 that put the cart's near face at x = 248.5 with the parked
 * twin turboprop's nose at 247.9 - 0.6 m of clearance directly across the only
 * way off the stand. Measured in a production build: the twin at full throttle
 * for five seconds moved exactly 0.60 m and stopped at 0.000 m/s. The jet on
 * stand 2 escaped only because its longer fuselage already contained the cart
 * and a containment waiver let it through, which is not a fix, it is the same
 * bug with a different outcome.
 *
 * So nothing is placed at a fixed offset any more. Every position is derived
 * from `STAND_ENVELOPE`, and the two rules a real apron works to are the two
 * rules here: equipment goes OUTSIDE the fuselage, and BEHIND the nose - never
 * in the taxi-out corridor `standTaxiCorridor` describes.
 * `tests/apronClearance.test.ts` asserts it against the real fleet.
 */
function apronEquipment(): Placement[] {
  const out: Placement[] = [];
  const east = -Math.PI / 2;
  const west = Math.PI / 2;

  for (let i = 0; i < STANDS.length; i += 1) {
    const stand = STANDS[i] as (typeof STANDS)[number];
    // Only the first three stands are worked; the light stands at the south
    // end are left empty, which is what makes the busy ones read as busy.
    if (i > 2) continue;
    const env = STAND_ENVELOPE[stand.size];
    // Port side is -z with the nose at +x, which is where an airstair and a
    // ground power unit go on a real turnaround: at the forward door and at
    // the nose receptacle, both clear of the fuselage and of the lead-in line.
    const port = stand.z - env.halfFuselage;
    const starboard = stand.z + env.halfFuselage;
    out.push({ prop: 'airStairs', x: stand.x + env.halfLength * 0.45, z: port - 2.4, heading: east });
    // Abeam the nose, not off it: 0.72 of the half-length leaves the unit and
    // its 0.6 m half-depth a clear margin behind the nose on every class.
    out.push({ prop: 'gpuCart', x: stand.x + env.halfLength * 0.72, z: port - 4.2, heading: west });
    if (i < 2) {
      // Baggage train aft of the wing root, on the starboard side.
      out.push({ prop: 'baggageTug', x: stand.x - env.halfLength * 0.5, z: starboard + 2.4, heading: east });
      out.push({ prop: 'baggageCart', x: stand.x - env.halfLength * 0.5, z: starboard + 6.1, heading: east });
      out.push({ prop: 'baggageCart', x: stand.x - env.halfLength * 0.5, z: starboard + 9.8, heading: east });
    }
  }

  // Equipment park against the apron's west edge, clear of the lead-in lines.
  const parkX = APRON.minX + 3.5;
  for (let k = 0; k < 4; k += 1) {
    out.push({ prop: 'baggageCart', x: parkX, z: APRON.maxZ - 12 - k * 3.7, heading: Math.PI });
  }
  out.push({ prop: 'baggageTug', x: parkX + 4, z: APRON.maxZ - 14, heading: Math.PI });
  out.push({ prop: 'fuelBowser', x: parkX + 9, z: APRON.maxZ - 22, heading: Math.PI });

  return out;
}

/** Equipment round the hangars and the tower, and a second bowser at the farm. */
function maintenanceEquipment(): Placement[] {
  const out: Placement[] = [];
  for (const hangar of HANGARS) {
    const z = (hangar.minZ + hangar.maxZ) / 2;
    out.push({ prop: 'baggageTug', x: hangar.maxX + 5, z: z - 12, heading: -Math.PI / 2 });
    out.push({ prop: 'gpuCart', x: hangar.maxX + 5, z: z + 12, heading: -Math.PI / 2 });
  }
  out.push({ prop: 'fuelBowser', x: SOUTH_APRON.minX + 8, z: SOUTH_APRON.maxZ - 30, heading: 0 });
  return out;
}

/**
 * Windsocks.
 *
 * Two, and their positions are not decoration: a windsock goes where it can be
 * seen from the runway without being an obstacle on it, which in practice
 * means level with a threshold and well outside the strip. These sit 70 m west
 * of the runway centreline at each end, on the grass between the runway and
 * the taxiway.
 */
function windsocks(): Placement[] {
  const x = (TAXIWAY.centreX + RUNWAY.centreX) / 2 + 12;
  return [
    { prop: 'windsock', x, z: RUNWAY.northZ + 18, heading: 0 },
    { prop: 'windsock', x, z: RUNWAY.southZ - 18, heading: 0 },
  ];
}

/** Bollards and bins along the terminal frontage and the car park. */
function landsideDressing(): Placement[] {
  const out: Placement[] = [];
  // A bollard line along the forecourt kerb outside the terminal doors, which
  // is what every airport frontage has and what stops it reading as apron.
  for (let x = TERMINAL.minX + 6; x <= TERMINAL.maxX - 6; x += 3) {
    out.push({ prop: 'bollard', x, z: TERMINAL.minZ - 9.5, heading: 0 });
  }
  for (const z of [TERMINAL.minZ - 12, TERMINAL.minZ - 20]) {
    out.push({ prop: 'litterBin', x: 172, z, heading: 0 });
    out.push({ prop: 'litterBin', x: 196, z, heading: 0 });
  }
  // Bins and a shelter at the head of the car park.
  out.push({ prop: 'litterBin', x: CAR_PARK.minX + 22, z: CAR_PARK.minZ + 3, heading: 0 });
  out.push({ prop: 'litterBin', x: CAR_PARK.maxX - 8, z: CAR_PARK.minZ + 3, heading: 0 });
  return out;
}

/** True where nothing may be parked: the runway and taxiway and their strips. */
function onMovementArea(x: number, z: number): boolean {
  const nearRunway =
    Math.abs(x - RUNWAY.centreX) <= RUNWAY.halfWidth + 25 &&
    z >= RUNWAY.northZ - RUNWAY.overrun - 20 &&
    z <= RUNWAY.southZ + RUNWAY.overrun + 20;
  const nearTaxiway =
    Math.abs(x - TAXIWAY.centreX) <= TAXIWAY.halfWidth + 8 &&
    z >= TAXIWAY.fromZ - 8 &&
    z <= TAXIWAY.toZ + 8;
  return nearRunway || nearTaxiway;
}

export function scatterAirportProps(ground: CityGround, sink: GeometrySink): void {
  const matrix = new Matrix4();
  const placements = [
    ...apronEquipment(),
    ...maintenanceEquipment(),
    ...windsocks(),
    ...landsideDressing(),
  ];

  for (const placement of placements) {
    // The windsock is the only thing allowed inside the movement area, and it
    // is allowed because it is frangible and sited to be.
    if (placement.prop !== 'windsock' && onMovementArea(placement.x, placement.z)) continue;
    const sample = ground.sample(placement.x, placement.z);
    if (sample.surface === 'water') continue;
    // A tiny per-position yaw jitter, so a row of carts is not a stamped array.
    const jitter = (hash2(placement.x, placement.z, 211) - 0.5) * 0.09;
    matrix.makeRotationY(placement.heading + jitter);
    matrix.setPosition(placement.x, sample.y, placement.z);
    sink.instance(placement.prop, matrix);

    const collider = PROP_SPECS[placement.prop].collider;
    if (!collider) continue;
    const cos = Math.abs(Math.cos(placement.heading));
    const sin = Math.abs(Math.sin(placement.heading));
    const ex = collider.halfX * cos + collider.halfZ * sin;
    const ez = collider.halfX * sin + collider.halfZ * cos;
    sink.collider({
      minX: placement.x - ex,
      maxX: placement.x + ex,
      minZ: placement.z - ez,
      maxZ: placement.z + ez,
      bottom: sample.y,
      top: sample.y + collider.top,
      solid: true,
    });
  }
}
