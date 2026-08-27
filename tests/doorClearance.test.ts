/**
 * Nothing may be scattered into a doorway.
 *
 * The prop rules only knew about ground, roads and other props, so a news box
 * was placed 0.13 m in front of the cafe's front door - legal by every rule it
 * checked, and squarely in the one place the player has to stand to get in.
 */

import { describe, expect, it } from 'vitest';

import { getCityPlan } from '../src/world/CityPlan';
import { doorApproach, doorwayFor } from '../src/world/build/doorway';
import { scatterStreetProps } from '../src/world/build/PropScatter';
import { RecordingSink } from '../src/world/validate';
import { PROP_SPECS } from '../src/world/build/PropLibrary';

const plan = getCityPlan();
const sink = new RecordingSink();
scatterStreetProps(plan, sink);

describe('doorway clearance', () => {
  it('scatters a real number of props', () => {
    expect(sink.instances.length).toBeGreaterThan(300);
  });

  it('keeps every prop clear of every entrance', () => {
    const offenders: string[] = [];
    for (const parcel of plan.parcels) {
      if (!parcel.enterable) continue;
      const door = doorwayFor(parcel);
      const approach = doorApproach(door, 1.6);
      for (const instance of sink.instances) {
        const spec = PROP_SPECS[instance.prop];
        // Measure to the prop's own footprint, not its centre: a wide bin
        // blocks a door its centre is comfortably clear of.
        const footprint = spec.collider
          ? Math.max(spec.collider.halfX, spec.collider.halfZ)
          : Math.max(spec.width, spec.depth) * 0.5;
        for (const [px, pz, label] of [
          [door.x, door.z, 'threshold'],
          [approach.x, approach.z, 'approach'],
        ] as const) {
          const gap = Math.hypot(instance.x - px, instance.z - pz) - footprint;
          if (gap < 0.9) {
            offenders.push(
              `${instance.prop} is ${gap.toFixed(2)}m from ${parcel.id} ${label}`,
            );
          }
        }
      }
    }
    expect(offenders.slice(0, 6).join('\n')).toBe('');
  });
});
