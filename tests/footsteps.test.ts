/**
 * Footstep surface classification.
 *
 * Two layers, both deterministic and both headless:
 *
 *   1. the RULE and the MIXER, as pure functions - given authoritative world
 *      metadata, does the right recording family come out;
 *   2. the same rule driven over the REAL built world, so "the runway sounds
 *      like concrete" is asserted against the colliders the game actually
 *      ships rather than against a fixture invented here.
 *
 * The world build is the same one `tests/placement.test.ts` runs: a recording
 * sink, no WebGL, no browser.
 */

import { describe, expect, it } from 'vitest';

import { footstepFamily } from '../src/audio/AudioDirector';
import { STEP_FAMILIES, type StepFamily } from '../src/audio/manifest';
import { CollisionWorld } from '../src/player/Collision';
import {
  ColliderSurfaceIndex,
  SURFACE_COMMIT_TIME,
  SurfaceDebounce,
  resolveStepGround,
  type StepGround,
} from '../src/player/FirstPersonController';
import { CityGround, type SurfaceId } from '../src/world/CityGround';
import { getCityPlan } from '../src/world/CityPlan';
import { buildEnvironment } from '../src/world/Environment';
import { buildAirport } from '../src/world/airport';
import { buildBuilding } from '../src/world/build/BuildingFactory';
import { buildInterior } from '../src/world/build/InteriorBuilder';
import { scatterStreetProps } from '../src/world/build/PropScatter';
import {
  buildBlockGround,
  buildIntersections,
  buildStreet,
} from '../src/world/build/StreetBuilder';
import type { MaterialKey } from '../src/render/materials';
import { RecordingSink } from '../src/world/validate';

// ---------------------------------------------------------------------------
// The world, built once
// ---------------------------------------------------------------------------

const plan = getCityPlan();
const ground = new CityGround(plan);
const sink = new RecordingSink();
for (const street of plan.streets) buildStreet(street, plan, sink);
buildIntersections(plan, sink);
for (const block of plan.blocks) buildBlockGround(block, plan, sink);
for (const parcel of plan.parcels) buildBuilding(parcel, sink);
for (const parcel of plan.parcels) if (parcel.enterable) buildInterior(parcel, sink);
scatterStreetProps(plan, sink);
buildAirport(plan, ground, sink);
buildEnvironment(sink, ground);

const collision = new CollisionWorld(sink.colliders);
const index = new ColliderSurfaceIndex(sink.colliders);

/** Exactly what the controller does at a point, without the controller. */
function groundAt(x: number, z: number): StepGround {
  const here = ground.sample(x, z);
  const support = collision.supportAt(x, z, here.y, here.y);
  const material = index.materialAt(x, z, support.y);
  return resolveStepGround({
    terrain: here.surface,
    built: support.built,
    supportY: support.y,
    terrainY: here.y,
    indoors: ground.isBuilt(x, z, -0.2),
    material,
  });
}

/** What the mixer would play there. */
function familyAt(x: number, z: number): StepFamily {
  return footstepFamily(groundAt(x, z));
}

// ---------------------------------------------------------------------------
// The rule, table driven
// ---------------------------------------------------------------------------

describe('footstep family from authoritative metadata', () => {
  const cases: Array<{
    what: string;
    terrain: SurfaceId;
    material: MaterialKey | null;
    built: boolean;
    indoors: boolean;
    family: StepFamily;
  }> = [
    // A road is a road because the ground sampler says so, and nothing built
    // stands on it. This is the case the dead `onRoad` argument existed for.
    { what: 'a carriageway', terrain: 'asphalt', material: null, built: false, indoors: false, family: 'asphalt' },
    { what: 'a sidewalk', terrain: 'pavement', material: null, built: false, indoors: false, family: 'pavement' },
    { what: 'the airfield verge', terrain: 'grass', material: null, built: false, indoors: false, family: 'grass' },
    { what: 'the apron', terrain: 'concrete', material: null, built: false, indoors: false, family: 'concrete' },
    { what: 'Harbour Walk', terrain: 'boardwalk', material: null, built: false, indoors: false, family: 'boardwalk' },
    // Built floors: the collider's material decides, not the ground under it.
    { what: 'the terminal concourse', terrain: 'concrete', material: 'tileFloor', built: true, indoors: true, family: 'terminal' },
    { what: 'a club timber floor', terrain: 'pavement', material: 'timberDark', built: true, indoors: true, family: 'boardwalk' },
    { what: 'a hangar slab', terrain: 'concrete', material: 'concrete', built: true, indoors: true, family: 'concrete' },
    { what: 'a jetway deck', terrain: 'concrete', material: 'metalLight', built: true, indoors: true, family: 'terminal' },
    // An untagged built floor: indoors is the tile bucket, outdoors is the
    // ground it stands on. The second row is the whole bug.
    { what: 'an untagged shop interior', terrain: 'pavement', material: null, built: true, indoors: true, family: 'interior' },
    { what: 'a shop plinth outdoors', terrain: 'gravel', material: null, built: true, indoors: false, family: 'gravel' },
  ];

  for (const c of cases) {
    it(`plays ${c.family} on ${c.what}`, () => {
      const resolved = resolveStepGround({
        terrain: c.terrain,
        built: c.built,
        supportY: c.built ? 1 : 0,
        terrainY: 0,
        indoors: c.indoors,
        material: c.material,
      });
      expect(footstepFamily(resolved)).toBe(c.family);
    });
  }

  it('gives every family two distinct real assets', () => {
    for (const [family, variants] of Object.entries(STEP_FAMILIES)) {
      expect(variants, family).toHaveLength(2);
      expect(variants[0]).not.toBe(variants[1]);
    }
  });

  it('never returns the same pair for two different families', () => {
    const seen = new Map<string, string>();
    for (const [family, variants] of Object.entries(STEP_FAMILIES)) {
      const key = variants.join('|');
      expect(seen.get(key), `${family} duplicates ${seen.get(key) ?? ''}`).toBeUndefined();
      seen.set(key, family);
    }
  });
});

// ---------------------------------------------------------------------------
// The rule, against the world that ships
// ---------------------------------------------------------------------------

describe('footstep family in the built world', () => {
  const places: Array<{ what: string; x: number; z: number; family: StepFamily }> = [
    { what: 'the harbour carriageway', x: -158, z: 12, family: 'asphalt' },
    { what: 'Harbour Walk', x: -151, z: 18, family: 'boardwalk' },
    { what: 'the terminal concourse', x: 180, z: 450, family: 'terminal' },
    { what: 'the apron', x: 240, z: 450, family: 'concrete' },
    { what: 'the taxiway', x: 275, z: 450, family: 'concrete' },
    { what: 'the runway centreline', x: 340, z: 450, family: 'concrete' },
    { what: 'the airfield verge', x: 300, z: 450, family: 'grass' },
  ];

  for (const place of places) {
    it(`plays ${place.family} on ${place.what}`, () => {
      expect(familyAt(place.x, place.z)).toBe(place.family);
    });
  }

  /**
   * The regression itself, as a number.
   *
   * The old rule was `support.built && support.y > here.y + 0.05 ? 'interior'`,
   * and this counts how many walkable points it disagreed with the world about.
   */
  it('no longer plays a domestic tile on outdoor ground', () => {
    let oldWrong = 0;
    let stillTile = 0;
    for (let x = -420; x <= 460; x += 1.5) {
      for (let z = -420; z <= 660; z += 1.5) {
        const here = ground.sample(x, z);
        if (here.surface === 'water') continue;
        const support = collision.supportAt(x, z, here.y, here.y);
        const builtFloor = support.built && support.y > here.y + 0.05;
        if (!builtFloor) continue;
        const indoors = ground.isBuilt(x, z, -0.2);
        if (!indoors) oldWrong += 1;
        if (!indoors && familyAt(x, z) === 'interior') stillTile += 1;
      }
    }
    // The defect was real and large, and it is now exactly zero.
    expect(oldWrong).toBeGreaterThan(300);
    expect(stillTile).toBe(0);
  });

  it('hears asphalt on every carriageway without being told it is one', () => {
    // `main.ts` passed `GroundSample.onRoad` down as an override because the
    // classification "was wrong on roads". Swept over the whole world, it never
    // was: this is the measurement that retires the third argument.
    let wrong = 0;
    let roads = 0;
    for (let x = -420; x <= 460; x += 3) {
      for (let z = -420; z <= 660; z += 3) {
        if (!ground.sample(x, z).onRoad) continue;
        roads += 1;
        if (familyAt(x, z) !== 'asphalt') wrong += 1;
      }
    }
    expect(roads).toBeGreaterThan(5000);
    expect(wrong).toBe(0);
  });

  it('finds the terminal floor rather than the plinth it was laid on', () => {
    // Both colliders top out at the same height; the fitout is laid last and
    // is the thing being stood on. Getting the tie-break wrong here plays a
    // bare concrete apron in the middle of a departure hall.
    const material = groundAt(180, 450).material;
    expect(material).toBe('tileFloor');
  });
});

// ---------------------------------------------------------------------------
// Prompt AND stable
// ---------------------------------------------------------------------------

describe('surface debounce', () => {
  const STEP = 1 / 120;
  const pavement: StepGround = { surface: 'pavement', material: null };
  const asphalt: StepGround = { surface: 'asphalt', material: null };

  it('commits a genuine crossing inside the commit time', () => {
    const debounce = new SurfaceDebounce('pavement');
    for (let t = 0; t < 1; t += STEP) debounce.sample(STEP, pavement);
    let elapsed = 0;
    while (debounce.held.surface !== 'asphalt' && elapsed < 1) {
      debounce.sample(STEP, asphalt);
      elapsed += STEP;
    }
    expect(debounce.held.surface).toBe('asphalt');
    // One extra fixed step: the sample that first reports the new material
    // starts the timer rather than adding to it.
    expect(elapsed).toBeLessThanOrEqual(SURFACE_COMMIT_TIME + STEP * 3);
  });

  it('is prompt: the first footfall after a kerb is already the new material', () => {
    // A walk at WALK_SPEED across a kerb, sampled at the fixed step and asked
    // for a footstep every 1.45 m as the controller does. The crossing happens
    // just after a footfall, which is the worst case for a hold counted in
    // steps: a two-step hold would report pavement on the NEXT one too.
    const debounce = new SurfaceDebounce('pavement');
    const speed = 2.8;
    const stride = 1.45;
    let travelled = 0;
    let sinceStep = 0;
    let firstAfterCrossing: SurfaceId | null = null;
    for (let i = 0; i < 1200; i += 1) {
      travelled += speed * STEP;
      sinceStep += speed * STEP;
      debounce.sample(STEP, travelled < 5 ? pavement : asphalt);
      if (sinceStep >= stride) {
        sinceStep -= stride;
        if (travelled >= 5 && firstAfterCrossing === null) {
          firstAfterCrossing = debounce.held.surface;
        }
      }
    }
    expect(firstAfterCrossing).toBe('asphalt');
  });

  it('is stable: a boundary the player weaves across is never heard flickering', () => {
    // The sampler alternates every fixed step, which is what walking the lip of
    // an apron does. Nothing may commit.
    const debounce = new SurfaceDebounce('pavement');
    let changes = 0;
    let previous = debounce.held.surface;
    for (let i = 0; i < 1200; i += 1) {
      const held = debounce.sample(STEP, i % 2 === 0 ? pavement : asphalt).surface;
      if (held !== previous) changes += 1;
      previous = held;
    }
    expect(changes).toBe(0);
  });

  it('is stable at a slower weave too, and bounded when it does commit', () => {
    // Half a second either side is a player genuinely stepping on and off a
    // kerb, and that IS a change - but it is bounded by the commit time rather
    // than free-running with the footstep cadence.
    const debounce = new SurfaceDebounce('pavement');
    let changes = 0;
    let previous = debounce.held.surface;
    const seconds = 10;
    for (let i = 0; i < seconds / STEP; i += 1) {
      const t = i * STEP;
      const held = debounce.sample(STEP, Math.floor(t * 2) % 2 === 0 ? pavement : asphalt).surface;
      if (held !== previous) changes += 1;
      previous = held;
    }
    expect(changes).toBeGreaterThan(0);
    expect(changes).toBeLessThanOrEqual(seconds / (2 * SURFACE_COMMIT_TIME));
  });

  it('treats a material change on the same terrain as a change', () => {
    const debounce = new SurfaceDebounce('concrete');
    const bare: StepGround = { surface: 'concrete', material: null };
    const slab: StepGround = { surface: 'concrete', material: 'tileFloor' };
    for (let i = 0; i < 60; i += 1) debounce.sample(STEP, bare);
    expect(footstepFamily(debounce.held)).toBe('concrete');
    for (let i = 0; i < 60; i += 1) debounce.sample(STEP, slab);
    expect(footstepFamily(debounce.held)).toBe('terminal');
  });
});
