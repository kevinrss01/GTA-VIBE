/**
 * How loud the bay is at a world position.
 *
 * The sea is the one ambience in Meridian Bay that is a *place* rather than a
 * mood: it radiates from the water along the west edge of the map and from
 * nowhere else. Choosing it by district cannot express that - a district is a
 * membership test, and the player is either in it at full level or out of it at
 * none - so the sea layer is driven from the listener's measured distance to
 * the waterline instead, and `AudioDirector` ramps the loop's gain from the
 * value returned here.
 *
 * `shorelineX` is imported from the world rather than copied, so moving the
 * waterline moves the sound with it and the two cannot drift apart.
 *
 * Everything here is pure scalar maths on numbers: no allocation, no context,
 * no renderer, because it runs once per frame at up to 120 Hz and is unit
 * tested without WebGL or Web Audio.
 */

import { smoothstep } from '../core/mathx';
import { shorelineX } from '../world/elevation';

/**
 * Distance from the waterline, in metres, inside which the bay plays at full
 * level.
 *
 * Measured against the real map: `shorelineX(z)` runs between -205.9 (at
 * z = -142) and -186.4 (at z = 78), so the water sits anywhere from 26.4 m to
 * 45.9 m west of the Harbour Walk centreline (x = -160) depending on where
 * along the quay you stand, and 14.4 m to 33.9 m west of its seaward pavement
 * edge (x = -172, just outside SEAWALL_X = -173).
 *
 * Anchoring full level at the far end of that spread - 46 m - keeps the whole
 * promenade, the seawall, the beach and the player's spawn at (-153, 18), which
 * is 40.3 m out, at the top of the curve. Any shorter value would pump the sea
 * up and down as the player walks north-south along a quay that is at a
 * constant x, purely because the shoreline in front of them wobbles by 19.5 m.
 */
export const SEA_FULL_DISTANCE = 46;

/**
 * Distance, in metres, at which the bay is exactly silent.
 *
 * Measured: Cannery Row (x = -74) is 112.4 m to 131.9 m from the water. It is
 * the third line inland and the first one with a solid block of harbour-front
 * buildings standing between it and the bay, so 130 m lets the sea die out as
 * the player crosses it and makes everything further east silent by
 * construction rather than merely quiet. For scale, on the same measurement
 * Dock Street is 68-88 m out, Meridian Avenue 158-178 m, the Lantern Park
 * fountain 278-298 m and the east ridge 376-396 m.
 */
export const SEA_SILENT_DISTANCE = 130;

/**
 * Horizontal distance in metres from a position to the nearest open water, and
 * zero anywhere in the bay itself.
 *
 * The waterline runs very nearly north-south, so the x offset to it is the
 * perpendicular distance and no search along the shore is needed. The error is
 * bounded and small: `shorelineX` has a steepest slope of dx/dz = 0.237, i.e.
 * 13.3 degrees off the z axis, so the offset overstates the true perpendicular
 * distance by at most 2.7 per cent - 3.5 m at the 130 m silence line, about one
 * pace, and far below the resolution of a broadband ambience bed.
 */
export function shoreDistance(x: number, z: number): number {
  const offset = x - shorelineX(z);
  return offset > 0 ? offset : 0;
}

/**
 * The sea layer's level at a position, 0 to 1, before the mix applies its
 * indoor duck.
 *
 * Inside `SEA_FULL_DISTANCE` this is the inverse-distance law - the same 1/r
 * the `PannerNode`s in this codebase use with `distanceModel: 'inverse'`,
 * `rolloffFactor` 1 and `refDistance` = `SEA_FULL_DISTANCE`, which reduces
 * exactly to `SEA_FULL_DISTANCE / distance`. Web Audio's own implementation
 * flattens that curve out at `maxDistance` instead of reaching zero, which is
 * precisely the "still faintly there 300 m inland" artefact being fixed here,
 * so the law is windowed by a smoothstep that reaches zero at
 * `SEA_SILENT_DISTANCE` and leaves the curve C1-continuous at both ends.
 *
 * The resulting profile, in dB, at the distances measured above: 0 dB across
 * the beach and the whole promenade, -2.5 dB at Harbour Walk's landward
 * pavement edge (57.9 m), -5.1 dB at Dock Street (68.4 m), -11.6 dB at its far
 * kerb (87.9 m), -26.7 dB at the near side of Cannery Row (112.4 m), and
 * exactly zero from 130 m inland.
 */
export function seaGain(x: number, z: number): number {
  const distance = shoreDistance(x, z);
  if (distance >= SEA_SILENT_DISTANCE) return 0;
  if (distance <= SEA_FULL_DISTANCE) return 1;
  return (
    (SEA_FULL_DISTANCE / distance) *
    (1 - smoothstep(SEA_FULL_DISTANCE, SEA_SILENT_DISTANCE, distance))
  );
}
