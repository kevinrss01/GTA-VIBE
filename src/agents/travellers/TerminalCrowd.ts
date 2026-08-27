/**
 * The people inside Meridian Bay Regional's terminal.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   import { TerminalCrowd } from './agents/travellers';
 *
 *   const travellers = new TerminalCrowd({
 *     region:    { minX, maxX, minZ, maxZ },  // WALKABLE floor, inside the walls
 *     obstacles: terminalColliders,           // readonly ColliderBox[]
 *     seats:     gateSeatAnchors,             // [{ x, z, heading, y? }]
 *     queues:    [checkInHead, securityHead], // [{ x, z, heading, slots? }]
 *     floorY:    TERMINAL_FLOOR,
 *     baseUrl:   import.meta.env.BASE_URL,
 *     quality:   'high',
 *   });
 *   engine.scene.add(travellers.group);
 *   void travellers.load();                   // off the critical path
 *
 *   // once per frame, after the controller has moved the player
 *   travellers.update(dt, { x: state.x, y: state.y, z: state.z, time: elapsed });
 *
 *   travellers.setQuality(level);              // optional
 *   travellers.dispose();                      // on unload
 *
 * `group.userData.travellers` is this object, so automated QA can read `stats`
 * without a second export path.
 *
 * ============================================================================
 *
 * ## What it costs
 *
 * One colour draw call per baked character (four), one per luggage model
 * (three) and one per seated model (two): NINE, doubled to eighteen at 'high'
 * where they also cast. Everything is instanced, so fifty travellers cost the
 * same submission as five. At the shipped population that is about 270 000
 * triangles - 52 people at ~2 900, 32 seated at ~2 880 and 32 bags at ~830 -
 * against the 4.10 M the city already draws.
 *
 * The simulation costs 22 microseconds a frame, measured. See `travellerSim`.
 *
 * And NOTHING while the player is elsewhere. `update` measures the distance to
 * the walkable rectangle first and returns before it simulates or writes a
 * single instance; the group is switched off, so Three.js does not walk it
 * either. The city pays exactly zero for the terminal's population from
 * downtown, which is the point: this population only exists inside one
 * building 400 m south of the city edge.
 *
 * ## Why it is not `PedestrianSystem`
 *
 * The street crowd cannot come indoors. `buildPavementGraph` builds links only
 * from street pavements and crossings - no parcel, no door, no floor - and
 * `crowd.project()` hard-clamps every agent into its link corridor. That clamp
 * is precisely what keeps three hundred people out of the city's buildings, so
 * the way to get travellers into the terminal is a second, small system that
 * owns its own space, not a hole in the first one's only guarantee.
 *
 * What IS shared is everything expensive: the same baked characters, the same
 * vertex-animation-texture shader, and - through `customProgramCacheKey` - the
 * same compiled program, so the terminal adds no shader compiles at all.
 *
 * ## Known cost, honestly
 *
 * The four bakes are downloaded and uploaded a SECOND time, because
 * `PedestrianSystem` keeps its loaded characters private and this module must
 * not edit it. That is 7.4 MB of texture memory (1.84 MB a character) and four
 * cache hits on the network. `characters` in the options exists so a caller
 * that can reach the crowd's copies can hand them over and pay none of it.
 */

import { Group, InstancedMesh, type BufferGeometry, type Object3D } from 'three';

import { clamp, type Rect } from '../../core/mathx';
import { createRng, hash2 } from '../../core/rng';
import { ModelLibrary, type LoadedModel } from '../../world/ModelLibrary';
import type { ColliderBox } from '../../world/build/types';
import { createPedestrianVatMesh, type PedestrianVatBundle } from '../PedestrianRig';
import {
  loadPedestrianVat,
  PEDESTRIAN_VAT_BASE,
  PEDESTRIAN_VAT_IDS,
  type PedestrianVatCharacter,
} from '../PedestrianVat';
import {
  LUGGAGE_KINDS,
  LUGGAGE_SPECS,
  placeLuggage,
  placeSeated,
  SEATED_MODELS,
  SEATED_SPECS,
  type LuggageKind,
  type PropPlacement,
  type SeatedModel,
} from './props';
import {
  BoxIndex,
  buildTerminalGraph,
  type TerminalPaths,
  type QueueAnchor,
  type SeatAnchor,
  type TerminalGraph,
} from './terminalSpace';
import { TravellerSim, type Traveller } from './travellerSim';

export type TravellerQuality = 'low' | 'medium' | 'high';

/**
 * Simulated travellers per quality level.
 *
 * The terminal is 62 by 190 metres. Fifty-two people in it is a quiet regional
 * field an hour before a departure, which is the read this is aiming for; two
 * hundred would be an international pier and would cost four times the vertex
 * work for a building the player passes through.
 */
const POPULATION: Readonly<Record<TravellerQuality, number>> = {
  low: 24,
  medium: 38,
  high: 52,
};

/** Seats filled per quality level, capped by however many anchors exist. */
const SEATED: Readonly<Record<TravellerQuality, number>> = {
  low: 12,
  medium: 22,
  high: 32,
};

/** Beyond this a traveller is not drawn. The concourse is long. */
const DRAW_RADIUS: Readonly<Record<TravellerQuality, number>> = {
  low: 55,
  medium: 75,
  high: 95,
};

/**
 * How close the player has to get before the terminal is populated at all,
 * and how far they have to go before it stops. The gap is hysteresis: without
 * it, standing on the threshold flickers the whole population on and off.
 */
const ENTER_RANGE = 58;
const EXIT_RANGE = 72;

/** Share of the seat anchors that get somebody on them. */
const SEAT_OCCUPANCY = 0.58;

/** Share of seated figures that use the wide leaning pose, where it fits. */
const LEANING_SHARE = 0.34;

export interface TerminalCrowdOptions {
  /** The WALKABLE floor: the terminal's interior, inset from its walls. */
  readonly region: Rect;
  /** Everything solid inside it. Pass the terminal's own collider boxes. */
  readonly obstacles: readonly ColliderBox[];
  /** Gate lounge seats. `heading` is the direction the sitter faces. */
  readonly seats: readonly SeatAnchor[];
  /** Check-in and security. `x`/`z` is where the person at the HEAD stands. */
  readonly queues: readonly QueueAnchor[];
  readonly floorY: number;
  /** Site root, for the generated GLBs. Defaults to a document-relative path. */
  readonly baseUrl?: string | undefined;
  readonly quality?: TravellerQuality | undefined;
  /** Overrides the quality level's walking population. */
  readonly count?: number | undefined;
  /** Overrides the quality level's number of occupied seats. */
  readonly seatedCount?: number | undefined;
  readonly seed?: number | undefined;
  /**
   * Baked characters to reuse instead of downloading a second copy.
   *
   * The caller keeps ownership - they are never disposed here - and it is safe
   * to pass characters that are already drawing somewhere else: their geometry
   * is cloned before use. It has to be. `PedestrianVatBundle.install` binds
   * its own per-instance `iAnim` and `iTint` buffers onto the character's
   * geometry, so two systems sharing one geometry would each be reading the
   * other's animation buffer. The clone is about 95 kB of vertex data per
   * character; what it preserves is the 1.84 MB animation texture, which is
   * the whole reason to share in the first place.
   */
  readonly characters?: readonly PedestrianVatCharacter[] | undefined;
}

/**
 * What `update` needs each frame.
 *
 * `y` is accepted and ignored so the very same context object the street
 * crowd, the traffic and the police are already handed can be passed straight
 * through - a caller should not have to build a second one to leave out a
 * field.
 */
export interface TerminalCrowdContext {
  readonly x: number;
  readonly y?: number | undefined;
  readonly z: number;
  /** Seconds since start, the same clock every other system uses. */
  readonly time: number;
}

export interface TerminalCrowdStats {
  /** False while the player is nowhere near; everything below is then zero. */
  readonly active: boolean;
  readonly population: number;
  readonly walking: number;
  readonly queueing: number;
  readonly paused: number;
  readonly seated: number;
  /** People served at a desk since the start. Proof the queues move. */
  readonly served: number;
  readonly rendered: number;
  readonly luggage: number;
  /** Walkable graph nodes. Zero means the region was furnished solid. */
  readonly nodes: number;
  readonly obstacles: number;
  readonly characters: number;
  /** Colour draw calls this frame, shadows excluded. */
  readonly drawCalls: number;
  readonly triangles: number;
  readonly missing: readonly string[];
  /**
   * Where a seated figure's hips land above the floor when its feet are on it.
   * Build the gate bench's seat pad at this height and nobody floats.
   */
  readonly impliedSeatPadY: number;
  /** Mean milliseconds in `update` over the last 60 active calls. */
  readonly updateMs: number;
}

interface FittedModel {
  readonly model: LoadedModel;
  /** Uniform scale from the normalised model to real metres. */
  readonly scale: number;
  /** Real height after scaling, in metres. */
  readonly height: number;
}

/** One person the lounge was dressed with, decided before anything loaded. */
export interface SeatPlan {
  readonly anchor: SeatAnchor;
  readonly model: SeatedModel;
  /** This sitter's seated height in metres; also the model's uniform scale. */
  readonly stature: number;
}

/**
 * A near-neutral per-instance tint.
 *
 * The same trick `PedestrianSystem` uses and, deliberately, the same numbers:
 * four characters must not read as fifty clones, and pushing the albedo hard
 * enough to matter turns skin a colour skin is not. It is duplicated rather
 * than imported because it is a private function of a module this workstream
 * must not edit.
 */
function tintFor(look: { readonly topColor: number; readonly bottomColor: number }): {
  r: number;
  g: number;
  b: number;
} {
  const packed = look.topColor;
  const r = Math.floor(packed / 65536) / 255;
  const g = (Math.floor(packed / 256) % 256) / 255;
  const b = (packed % 256) / 255;
  const mean = (r + g + b) / 3;
  const value = 0.9 + 0.2 * hash2(look.topColor, look.bottomColor, 17);
  return {
    r: (1 + (r - mean) * 0.5) * value,
    g: (1 + (g - mean) * 0.5) * value,
    b: (1 + (b - mean) * 0.5) * value,
  };
}

/** Distance from a point to a rectangle. Zero inside it. */
function distanceToRect(rect: Rect, x: number, z: number): number {
  const dx = Math.max(rect.minX - x, 0, x - rect.maxX);
  const dz = Math.max(rect.minZ - z, 0, z - rect.maxZ);
  return Math.hypot(dx, dz);
}

/** Writes `translate(x, y, z) * rotationY(yaw) * scale(k)` at instance `n`. */
function writeInstance(
  matrices: Float32Array,
  n: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
  k: number,
): void {
  const m = n * 16;
  const c = Math.cos(yaw) * k;
  const s = Math.sin(yaw) * k;
  matrices[m] = c;
  matrices[m + 1] = 0;
  matrices[m + 2] = -s;
  matrices[m + 3] = 0;
  matrices[m + 4] = 0;
  matrices[m + 5] = k;
  matrices[m + 6] = 0;
  matrices[m + 7] = 0;
  matrices[m + 8] = s;
  matrices[m + 9] = 0;
  matrices[m + 10] = c;
  matrices[m + 11] = 0;
  matrices[m + 12] = x;
  matrices[m + 13] = y;
  matrices[m + 14] = z;
  matrices[m + 15] = 1;
}

export class TerminalCrowd {
  readonly group: Object3D;
  readonly graph: TerminalGraph;
  readonly sim: TravellerSim;
  /**
   * The furniture people walk around, including the occupied seats. Public
   * because the tests and the QA overlay have to be able to ask whether
   * somebody is standing in a desk, and there is no other way to find out.
   */
  readonly obstacleIndex: BoxIndex;

  private readonly region: Rect;
  private readonly floorY: number;
  private readonly baseUrl: string;
  private readonly bundles: PedestrianVatBundle[] = [];
  private readonly characters: PedestrianVatCharacter[] = [];
  private readonly ownedCharacters: PedestrianVatCharacter[] = [];
  /** Geometry cloned from a caller's characters; disposed with this object. */
  private readonly clonedGeometry: BufferGeometry[] = [];
  private readonly loadedBundles: PedestrianVatBundle[] = [];
  private readonly models = new ModelLibrary();
  private readonly luggage = new Map<LuggageKind, FittedModel>();
  private readonly luggageMeshes = new Map<LuggageKind, InstancedMesh>();
  private readonly seatPlans: SeatPlan[] = [];
  private readonly seatedMeshes = new Map<SeatedModel, InstancedMesh>();
  private readonly missing: string[] = [];
  private readonly counts: Int32Array;
  private readonly luggageCounts = new Map<LuggageKind, number>();
  private readonly placement: PropPlacement = { x: 0, y: 0, z: 0, yaw: 0 };
  private readonly seed: number;
  private readonly presetCharacters: readonly PedestrianVatCharacter[] | null;
  private quality: TravellerQuality;
  private drawRadius: number;
  private seatedPlaced = 0;
  private renderedLast = 0;
  private luggageLast = 0;
  private trianglesLast = 0;
  private drawCallsLast = 0;
  private active = false;
  private timeSum = 0;
  private timeCount = 0;
  private lastUpdateMs = 0;
  private disposed = false;

  constructor(options: TerminalCrowdOptions) {
    this.region = options.region;
    this.floorY = options.floorY;
    this.baseUrl = options.baseUrl ?? '';
    this.quality = options.quality ?? 'high';
    this.drawRadius = DRAW_RADIUS[this.quality];
    this.seed = options.seed ?? 0x7a11e4;
    this.presetCharacters = options.characters ?? null;

    // Who is sitting where is decided FIRST, because an occupied seat is an
    // obstacle. A seated figure is 0.8 m from its back to its toes and those
    // toes stick out into the aisle; without this the concourse routes people
    // straight through the lounge's knees, which is the single most obvious
    // thing wrong with a crowd in a waiting area.
    this.planSeats(options.seats, options.seatedCount ?? SEATED[this.quality]);
    this.obstacleIndex = new BoxIndex(
      [...options.obstacles, ...this.seatColliders(options.floorY)],
      options.region,
      options.floorY,
    );
    this.graph = buildTerminalGraph({ region: options.region, obstacles: this.obstacleIndex });

    const population = Math.max(0, options.count ?? POPULATION[this.quality]);
    this.sim = new TravellerSim({
      region: options.region,
      obstacles: this.obstacleIndex,
      graph: this.graph,
      queues: options.queues,
      population,
      variants: PEDESTRIAN_VAT_IDS.length,
      seed: this.seed,
    });

    this.group = new Group();
    this.group.name = 'terminal-travellers';
    this.group.visible = false;
    this.counts = new Int32Array(PEDESTRIAN_VAT_IDS.length);

    // Every character's mesh joins the scene EMPTY, before its files exist, so
    // `main.ts`'s pre-compile pass behind the loading screen builds its
    // program. It shares `customProgramCacheKey` with the street crowd, so in
    // practice that pass finds the program already built and this costs
    // nothing at all.
    for (let slot = 0; slot < PEDESTRIAN_VAT_IDS.length; slot += 1) {
      // Slot 10 upward: the crowd owns 0-3 and the police 4. The number only
      // ever reaches a debug name.
      const bundle = createPedestrianVatMesh(Math.max(1, population), 10 + slot);
      bundle.mesh.name = `traveller-${PEDESTRIAN_VAT_IDS[slot] ?? slot}`;
      bundle.mesh.castShadow = this.castsShadows;
      bundle.mesh.receiveShadow = true;
      this.bundles.push(bundle);
      this.group.add(bundle.mesh);
    }

    this.group.userData.travellers = this;
  }

  /**
   * An axis-aligned footprint for every occupied seat.
   *
   * The seated pose is an oriented rectangle - `depthFraction` from the back
   * to the toes, `widthFraction` across - and the collider format is
   * axis-aligned, so this is that rectangle's bounding box. Slightly generous
   * at a diagonal heading, which errs toward giving the sitter room.
   */
  private seatColliders(floorY: number): ColliderBox[] {
    return this.seatPlans.map((plan) => {
      const spec = SEATED_SPECS[plan.model];
      const halfDepth = (spec.depthFraction * plan.stature) / 2;
      const halfWidth = (spec.widthFraction * plan.stature) / 2;
      const fx = -Math.sin(plan.anchor.heading);
      const fz = -Math.cos(plan.anchor.heading);
      const ex = Math.abs(halfDepth * fx) + Math.abs(halfWidth * fz);
      const ez = Math.abs(halfDepth * fz) + Math.abs(halfWidth * fx);
      return {
        minX: plan.anchor.x - ex,
        maxX: plan.anchor.x + ex,
        minZ: plan.anchor.z - ez,
        maxZ: plan.anchor.z + ez,
        bottom: floorY,
        top: floorY + spec.stature,
        solid: true,
      };
    });
  }

  /** Who is sitting where. Fixed at construction and never changes. */
  get seating(): readonly SeatPlan[] {
    return this.seatPlans;
  }

  /** The simulation's own path finder, for QA and for the tests. */
  get paths(): TerminalPaths {
    return this.sim.paths;
  }

  get stats(): TerminalCrowdStats {
    const sim = this.sim.stats;
    const a = SEATED_SPECS['seated-a'];
    return {
      active: this.active,
      population: sim.population,
      walking: this.active ? sim.walking : 0,
      queueing: this.active ? sim.queueing : 0,
      paused: this.active ? sim.paused : 0,
      seated: this.seatedPlaced,
      served: sim.served,
      rendered: this.renderedLast,
      luggage: this.luggageLast,
      nodes: this.graph.count,
      obstacles: this.obstacleIndex.count,
      characters: this.characters.length,
      drawCalls: this.drawCallsLast,
      triangles: this.trianglesLast,
      missing: [...this.missing],
      impliedSeatPadY: this.floorY + a.padFraction * a.stature,
      updateMs: this.lastUpdateMs,
    };
  }

  /**
   * Downloads the characters and the props, and dresses the lounge.
   *
   * Nothing here can reject. A character that fails to arrive leaves a smaller
   * cast, a luggage model that fails leaves people walking empty-handed, and a
   * seated model that fails leaves the bench bare. All three are degraded
   * visuals, not errors - the same contract `Furnishings` and the street crowd
   * already keep.
   */
  async load(): Promise<void> {
    if (this.disposed) return;
    const vatBase = `${this.baseUrl}${PEDESTRIAN_VAT_BASE}`;
    const characters = this.presetCharacters
      ? this.presetCharacters.slice(0, PEDESTRIAN_VAT_IDS.length).map((character) => {
          const geometry = character.geometry.clone();
          this.clonedGeometry.push(geometry);
          return { ...character, geometry };
        })
      : await Promise.all(PEDESTRIAN_VAT_IDS.map((id) => loadPedestrianVat(id, vatBase)));

    if (this.disposed) {
      // Disposed while the download was in flight. Whatever arrived is ours to
      // clean up; a caller's own characters are not, but the geometry cloned
      // from them is.
      if (this.presetCharacters) {
        for (const geometry of this.clonedGeometry) geometry.dispose();
        this.clonedGeometry.length = 0;
      } else {
        for (const character of characters) character?.dispose();
      }
      return;
    }
    for (let i = 0; i < characters.length; i += 1) {
      const character = characters[i];
      const bundle = this.bundles[i];
      if (!character || !bundle) {
        if (!character) this.missing.push(PEDESTRIAN_VAT_IDS[i] ?? `character-${i}`);
        continue;
      }
      bundle.install(character);
      this.characters.push(character);
      this.loadedBundles.push(bundle);
      if (!this.presetCharacters) this.ownedCharacters.push(character);
    }

    await Promise.all([this.loadLuggage(), this.loadSeated()]);
  }

  /**
   * Shadows only at 'high'.
   *
   * Every caster is a second draw call and a second pass over its vertices, so
   * turning them on doubles this system's submission - nine calls to eighteen.
   * Indoors that buys much less than it does on the street: the terminal is a
   * roofed box, so the sun's contribution is whatever comes through the
   * glazing, and the thing a traveller most needs is contact with the floor,
   * which the receive side gives for nothing.
   */
  private get castsShadows(): boolean {
    return this.quality === 'high';
  }

  setQuality(quality: TravellerQuality): void {
    if (this.quality === quality) return;
    this.quality = quality;
    this.drawRadius = DRAW_RADIUS[quality];
    const casts = this.castsShadows;
    for (const bundle of this.bundles) bundle.mesh.castShadow = casts;
    for (const mesh of this.luggageMeshes.values()) mesh.castShadow = casts;
    for (const mesh of this.seatedMeshes.values()) mesh.castShadow = casts;
  }

  /**
   * Steps the terminal and writes its instance buffers.
   *
   * `ctx.time` is the same seconds-since-start every other system uses; it
   * drives the idle clip, which has no travel to key a phase off.
   */
  update(dt: number, ctx: TerminalCrowdContext): void {
    if (this.disposed) return;

    // The cull, before anything else costs anything. Hysteresis so standing on
    // the threshold does not flicker the population.
    const distance = distanceToRect(this.region, ctx.x, ctx.z);
    const wanted = this.active ? distance < EXIT_RANGE : distance < ENTER_RANGE;
    if (!wanted) {
      if (this.active) this.deactivate();
      return;
    }

    const started = performance.now();
    this.active = true;
    this.group.visible = true;
    this.sim.update(dt, ctx);
    this.writeCharacters(ctx);
    this.writeLuggage(ctx);
    this.countDrawCalls();

    this.timeSum += performance.now() - started;
    this.timeCount += 1;
    if (this.timeCount >= 60) {
      this.lastUpdateMs = Number((this.timeSum / this.timeCount).toFixed(3));
      this.timeSum = 0;
      this.timeCount = 0;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const bundle of this.bundles) {
      this.group.remove(bundle.mesh);
      bundle.dispose();
    }
    this.bundles.length = 0;
    this.loadedBundles.length = 0;
    for (const mesh of this.luggageMeshes.values()) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    this.luggageMeshes.clear();
    for (const mesh of this.seatedMeshes.values()) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    this.seatedMeshes.clear();
    // Only the characters this instance downloaded; a caller that supplied its
    // own keeps them.
    for (const character of this.ownedCharacters) character.dispose();
    this.ownedCharacters.length = 0;
    for (const geometry of this.clonedGeometry) geometry.dispose();
    this.clonedGeometry.length = 0;
    this.characters.length = 0;
    this.models.dispose();
    this.group.clear();
  }

  private deactivate(): void {
    this.active = false;
    this.group.visible = false;
    for (const bundle of this.bundles) bundle.mesh.count = 0;
    for (const mesh of this.luggageMeshes.values()) mesh.count = 0;
    this.renderedLast = 0;
    this.luggageLast = 0;
    this.trianglesLast = 0;
    this.drawCallsLast = 0;
  }

  private async loadLuggage(): Promise<void> {
    await Promise.all(
      LUGGAGE_KINDS.map(async (kind) => {
        const spec = LUGGAGE_SPECS[kind];
        const model = await this.models.load(`luggage-${kind}`, {
          url: `${this.baseUrl}${spec.url}`,
          targetHeight: 1,
          timeoutMs: 15000,
        });
        if (!model) {
          this.missing.push(kind);
          return;
        }
        const proportion =
          spec.fit === 'x' ? model.size.x : spec.fit === 'z' ? model.size.z : model.size.y;
        if (!(proportion > 1e-6)) {
          this.missing.push(kind);
          return;
        }
        const scale = spec.metres / proportion;
        this.luggage.set(kind, { model, scale, height: model.size.y * scale });
      }),
    );
    if (this.disposed) return;

    for (const kind of LUGGAGE_KINDS) {
      const fitted = this.luggage.get(kind);
      if (!fitted) continue;
      const capacity = this.sim.travellers.length;
      if (capacity === 0) continue;
      const mesh = new InstancedMesh(fitted.model.geometry, fitted.model.material, capacity);
      mesh.name = `traveller-luggage-${kind}`;
      mesh.castShadow = this.castsShadows;
      mesh.receiveShadow = true;
      // Every instance moves every frame, so the mesh has no stable bounding
      // volume; distance compaction in `writeLuggage` is the culling.
      mesh.frustumCulled = false;
      mesh.count = 0;
      this.luggageMeshes.set(kind, mesh);
      this.group.add(mesh);
    }
  }

  private async loadSeated(): Promise<void> {
    const wanted = new Set(this.seatPlans.map((plan) => plan.model));
    const fitted = new Map<SeatedModel, FittedModel>();
    await Promise.all(
      SEATED_MODELS.filter((id) => wanted.has(id)).map(async (id) => {
        const spec = SEATED_SPECS[id];
        const model = await this.models.load(id, {
          url: `${this.baseUrl}${spec.url}`,
          targetHeight: 1,
          timeoutMs: 15000,
        });
        if (!model || !(model.size.y > 1e-6)) {
          this.missing.push(id);
          return;
        }
        fitted.set(id, { model, scale: 1, height: model.size.y });
      }),
    );
    if (this.disposed) return;

    for (const id of SEATED_MODELS) {
      const entry = fitted.get(id);
      if (!entry) continue;
      const plans = this.seatPlans.filter((plan) => plan.model === id);
      if (plans.length === 0) continue;
      const spec = SEATED_SPECS[id];
      const mesh = new InstancedMesh(entry.model.geometry, entry.model.material, plans.length);
      mesh.name = `traveller-seated-${id}`;
      mesh.castShadow = this.castsShadows;
      mesh.receiveShadow = true;
      const matrices = mesh.instanceMatrix.array as Float32Array;
      for (let i = 0; i < plans.length; i += 1) {
        const plan = plans[i];
        if (!plan) continue;
        placeSeated(spec, plan.anchor, this.floorY, plan.stature, plan.anchor.y, this.placement);
        writeInstance(
          matrices,
          i,
          this.placement.x,
          this.placement.y,
          this.placement.z,
          this.placement.yaw,
          plan.stature,
        );
      }
      mesh.count = plans.length;
      mesh.instanceMatrix.needsUpdate = true;
      // Static for the session, so a real bounding sphere is worth having and
      // Three.js can frustum-cull the whole lounge in one test.
      mesh.computeBoundingSphere();
      this.seatedPlaced += plans.length;
      this.seatedMeshes.set(id, mesh);
      this.group.add(mesh);
    }
  }

  /**
   * Decides who is sitting where, before anything has downloaded.
   *
   * Deterministic from the seed, so the same lounge comes back on every load.
   *
   * The wide leaning pose is only given to a seat whose occupied neighbours
   * are far enough away to take it: the two staged figures are 0.53 m and
   * 0.79 m across at the knees, and a gate bench's seat pitch is around
   * 0.55 m, so a row of the wide one would be a row of people sitting inside
   * each other. Rejecting the pose is better than scaling it thin.
   */
  private planSeats(seats: readonly SeatAnchor[], wanted: number): void {
    if (seats.length === 0 || wanted <= 0) return;
    const rng = createRng(this.seed ^ 0x5ea7);
    const taken: { x: number; z: number; halfWidth: number; halfDepth: number }[] = [];
    const order = rng.shuffle(seats.map((_, i) => i));
    const limit = Math.min(wanted, seats.length);

    for (const index of order) {
      if (taken.length >= limit) break;
      const anchor = seats[index];
      if (!anchor) continue;
      if (!rng.chance(SEAT_OCCUPANCY) && taken.length + 1 < limit) continue;

      const wantLean = rng.chance(LEANING_SHARE);
      const candidates: SeatedModel[] = wantLean ? ['seated-b', 'seated-a'] : ['seated-a'];
      const right = { x: Math.cos(anchor.heading), z: -Math.sin(anchor.heading) };
      const forward = { x: -Math.sin(anchor.heading), z: -Math.cos(anchor.heading) };

      for (const model of candidates) {
        const spec = SEATED_SPECS[model];
        const stature = spec.stature * rng.range(0.96, 1.04);
        const halfWidth = (spec.widthFraction * stature) / 2;
        const halfDepth = (spec.depthFraction * stature) / 2;
        let clash = false;
        for (const other of taken) {
          const dx = anchor.x - other.x;
          const dz = anchor.z - other.z;
          const lateral = Math.abs(dx * right.x + dz * right.z);
          const along = Math.abs(dx * forward.x + dz * forward.z);
          if (lateral < halfWidth + other.halfWidth && along < halfDepth + other.halfDepth) {
            clash = true;
            break;
          }
        }
        if (clash) continue;
        this.seatPlans.push({ anchor, model, stature });
        taken.push({ x: anchor.x, z: anchor.z, halfWidth, halfDepth });
        break;
      }
    }
  }

  /** Packs the simulation into the baked characters' instance buffers. */
  private writeCharacters(ctx: TerminalCrowdContext): void {
    const variants = this.characters.length;
    for (const bundle of this.bundles) bundle.mesh.count = 0;
    this.renderedLast = 0;
    this.trianglesLast = 0;
    if (variants === 0) return;

    this.counts.fill(0);
    const cutoff = this.drawRadius * this.drawRadius;
    for (const t of this.sim.travellers) {
      const dx = t.x - ctx.x;
      const dz = t.z - ctx.z;
      if (dx * dx + dz * dz > cutoff) continue;

      // A character that failed to download leaves a hole, so the variant a
      // person was born with is folded onto whatever actually arrived.
      const variant = t.variant % variants;
      const character = this.characters[variant];
      const bundle = this.loadedBundles[variant];
      if (!character || !bundle) continue;

      const n = this.counts[variant] ?? 0;
      if (n >= bundle.mesh.instanceMatrix.count) continue;
      this.counts[variant] = n + 1;

      const look = t.look;
      writeInstance(
        bundle.mesh.instanceMatrix.array as Float32Array,
        n,
        t.x,
        this.floorY,
        t.z,
        t.heading,
        look.girth,
      );
      // The Y scale is the person's height, not their girth: the rig is
      // authored one unit tall and the crowd's own matrix scales it that way.
      // `writeInstance` wrote a uniform scale, so only element 5 has to change.
      (bundle.mesh.instanceMatrix.array as Float32Array)[n * 16 + 5] = look.height;

      const anim = bundle.anim.array as Float32Array;
      const a = n * 4;
      anim[a] = character.walk.phaseFor(t.walked);
      const idle = character.idle;
      if (idle && idle.duration > 1e-3) {
        // The idle has no travel to key off, so it runs on the clock at a
        // per-person rate and offset. Two neighbours breathing in unison is
        // the giveaway a queue makes most obvious.
        const rate = (0.85 + 0.3 * hash2(look.preferredSpeed, look.cadence, 11)) / idle.duration;
        anim[a + 1] = (hash2(look.height, look.girth, 23) + ctx.time * rate) % 1;
      } else {
        anim[a + 1] = 0;
      }
      anim[a + 2] = clamp(t.gait, 0, 1);
      // The civilian bakes carry no action clip, so the blend stays at zero
      // and the shader never fetches it.
      anim[a + 3] = 0;

      const tint = bundle.tint.array as Float32Array;
      const colour = tintFor(look);
      tint[a] = colour.r;
      tint[a + 1] = colour.g;
      tint[a + 2] = colour.b;
      tint[a + 3] = 1;
    }

    for (let v = 0; v < variants; v += 1) {
      const bundle = this.loadedBundles[v];
      const character = this.characters[v];
      if (!bundle || !character) continue;
      const n = this.counts[v] ?? 0;
      bundle.mesh.count = n;
      this.renderedLast += n;
      this.trianglesLast += n * character.triangles;
      if (n > 0) {
        bundle.mesh.instanceMatrix.needsUpdate = true;
        bundle.anim.needsUpdate = true;
        bundle.tint.needsUpdate = true;
      }
    }
  }

  /** Puts every drawn traveller's bag where their body says it is. */
  private writeLuggage(ctx: TerminalCrowdContext): void {
    this.luggageLast = 0;
    if (this.luggageMeshes.size === 0) return;
    for (const kind of LUGGAGE_KINDS) this.luggageCounts.set(kind, 0);

    const cutoff = this.drawRadius * this.drawRadius;
    for (const t of this.sim.travellers) {
      const kind = t.luggage;
      if (!kind) continue;
      const dx = t.x - ctx.x;
      const dz = t.z - ctx.z;
      if (dx * dx + dz * dz > cutoff) continue;
      const mesh = this.luggageMeshes.get(kind);
      const fitted = this.luggage.get(kind);
      if (!mesh || !fitted) continue;
      const n = this.luggageCounts.get(kind) ?? 0;
      if (n >= mesh.instanceMatrix.count) continue;
      this.luggageCounts.set(kind, n + 1);
      this.placeFor(t, kind, fitted);
      writeInstance(
        mesh.instanceMatrix.array as Float32Array,
        n,
        this.placement.x,
        this.placement.y,
        this.placement.z,
        this.placement.yaw,
        fitted.scale,
      );
    }

    for (const [kind, mesh] of this.luggageMeshes) {
      const n = this.luggageCounts.get(kind) ?? 0;
      mesh.count = n;
      this.luggageLast += n;
      const fitted = this.luggage.get(kind);
      if (fitted) this.trianglesLast += n * fitted.model.triangles;
      if (n > 0) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** Where one traveller's luggage goes, into the shared scratch placement. */
  private placeFor(t: Traveller, kind: LuggageKind, fitted: FittedModel): void {
    placeLuggage(
      LUGGAGE_SPECS[kind],
      { x: t.x, z: t.z, heading: t.heading, height: t.look.height, girth: t.look.girth },
      this.floorY,
      fitted.height,
      this.placement,
    );
  }

  /**
   * Colour draw calls the terminal is submitting this frame, and the triangles
   * with them. The seated lounge is counted here rather than in
   * `writeCharacters` because it is written once and never touched again.
   */
  private countDrawCalls(): void {
    let calls = 0;
    for (const bundle of this.bundles) if (bundle.mesh.count > 0) calls += 1;
    for (const mesh of this.luggageMeshes.values()) if (mesh.count > 0) calls += 1;
    for (const mesh of this.seatedMeshes.values()) {
      if (mesh.count === 0) continue;
      calls += 1;
      const geometry = mesh.geometry;
      const indices = geometry.index?.count ?? geometry.getAttribute('position').count;
      this.trianglesLast += (indices / 3) * mesh.count;
    }
    this.drawCallsLast = calls;
  }
}
