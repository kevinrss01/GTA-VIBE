/**
 * Meridian Bay's pedestrian crowd.
 *
 * ============================ INTEGRATION CONTRACT ==========================
 *
 *   import { PedestrianSystem } from './agents/PedestrianSystem';
 *
 *   const pedestrians = new PedestrianSystem({ plan, ground, network, quality });
 *   engine.scene.add(pedestrians.group);
 *
 *   // once per frame, after the controller has moved the player
 *   pedestrians.update(dt, {
 *     x: state.x, y: state.y, z: state.z,
 *     time: elapsed,            // the SAME clock passed to signalFor/walkSignal
 *     vehicles: traffic.agents, // optional
 *   });
 *
 *   pedestrians.setQuality(level);   // optional, from the quality menu
 *   pedestrians.dispose();           // on unload
 *
 * `group` is a `THREE.Object3D` holding one `InstancedMesh`. Adding it costs
 * ONE colour draw call, plus one shadow draw call above 'low' quality, for the
 * entire population. It adds no lights: the measured profile for this game says
 * point lights are 61 per cent of the frame, so the crowd uses none. A person a
 * car has knocked over is drawn by the SAME instance of the SAME mesh - the
 * topple rides in the instance matrix - so a street full of casualties costs
 * exactly what a street full of walkers does. See `writeMatrix`.
 *
 * Two hooks another layer is expected to attach, both documented at their
 * definitions with the exact call to make:
 *   `onImpact`               a vehicle knocked somebody down; jolt the car and
 *                            charge the player for it.
 *   `downAt`                 put somebody on the ground, for a shot civilian.
 *   `carriagewayObstacles`   people on a crossing, so traffic brakes for them.
 *   `crossingBlocked`
 *
 * `ctx.time` must be the same seconds-since-start the traffic signals use, or
 * pedestrians and vehicles will disagree about who has right of way.
 *
 * `ctx.vehicles` is structural and optional. Anything with `{ x, z }` works;
 * `vx`/`vz` (m/s) and `halfLength`/`halfWidth` (m) improve the behaviour and
 * default to stationary and to a family car respectively. Without it the crowd
 * still obeys the crossing signals, it simply cannot also check for a driver
 * who is not obeying them.
 *
 * Two optional inputs are worth wiring if they are cheap to reach:
 *   `obstacles` - pass `sink.colliders` to skip re-deriving street furniture
 *                 (saves the constructor a `scatterStreetProps` pass).
 *   `density`   - overrides the population the quality level would pick.
 *
 * `group.userData.pedestrians` is this object, so automated QA can read
 * `stats` without a second export path.
 *
 * NOTE FOR WHOEVER OWNS `RoadNetwork`: this system takes its junctions,
 * crossings and `walkSignal` clock from the shared network, but NOT the
 * published `walkNodes` / `walkEdges` geometry - measured against `CityGround`,
 * 188 of those 220 nodes and 326 of the 376 non-crossing edges are on a
 * carriageway. `pavement.ts` explains and rebuilds only that geometry.
 *
 * ============================================================================
 *
 * Everything interesting lives in the modules this one composes:
 *   `pavement.ts`      the walkable surface, rectified from the shared graph
 *   `crowd.ts`         the simulation: routing, signals, steering, LOD
 *   `appearance.ts`    per-person body, clothing and gait
 *   `PedestrianRig.ts` the instanced mesh and its baked-animation lookup
 *   `PedestrianVat.ts`  the baked character files and their travel curves
 *   `PedestrianProcRig.ts` the procedural crowd used until those load
 *   `obstacles.ts`     the street furniture people walk around
 */

import { Group, type Object3D } from 'three';

import type { RoadNetwork } from '../city/RoadNetwork';
import type { CityGround } from '../world/CityGround';
import type { CityPlan } from '../world/CityPlan';
import type { ColliderBox } from '../world/build/types';
import { hash2 } from '../core/rng';
import {
  Crowd,
  RENDER_RADIUS,
  type CrowdContext,
  type CrowdVehicle,
  type PedestrianImpact,
} from './crowd';
import { ObstacleIndex } from './obstacles';
import { buildPavementGraph, type PavementGraph } from './pavement';
import { hipAmplitude } from './gait';
import { createProcPedestrianMesh, type ProcPedestrianMeshBundle } from './PedestrianProcRig';
import { createPedestrianVatMesh, type PedestrianVatBundle } from './PedestrianRig';
import {
  loadPedestrianVat,
  PEDESTRIAN_VAT_IDS,
  type PedestrianVatCharacter,
} from './PedestrianVat';

export type PedestrianQuality = 'low' | 'medium' | 'high';

export interface PedestrianSystemOptions {
  readonly plan: CityPlan;
  readonly ground: CityGround;
  readonly network: RoadNetwork;
  readonly quality: PedestrianQuality;
  /** Street furniture to walk around. Defaults to re-deriving it from `plan`. */
  readonly obstacles?: readonly ColliderBox[] | undefined;
  /** Overrides the quality level's population. */
  readonly density?: number | undefined;
}

export type { CrowdVehicle, CrowdContext, PedestrianImpact };

/**
 * People simulated at once, per quality level.
 *
 * Simulation cost is linear and small (measured below 0.5 ms for the whole
 * population); the reason 'low' cuts it is that every rendered person is
 * vertex work and shadow-map work on a machine that already could not afford
 * the shadows.
 */
const POPULATION: Readonly<Record<PedestrianQuality, number>> = {
  low: 90,
  medium: 180,
  high: 270,
};

/** Triangles in one procedural person, reported when no character loaded. */
const PROC_TRIANGLES = 560;

/**
 * Half a torso's thickness, in rig units. Raises a body lying flat so it rests
 * ON the pavement rather than half inside it. See `writeMatrix`.
 */
const DOWN_LIFT = 0.12;

/** How far from the reported point `downAt` will look for a body, in metres. */
const DOWN_SEARCH = 1;

/** Beyond this a pedestrian is not drawn at all. Fog hides the difference. */
const DRAW_RADIUS: Readonly<Record<PedestrianQuality, number>> = {
  low: 95,
  medium: 125,
  high: RENDER_RADIUS,
};

export interface PedestrianStats {
  readonly population: number;
  readonly active: number;
  readonly rendered: number;
  /** Agents stepped last frame. Below `active` by exactly the LOD saving. */
  readonly stepped: number;
  readonly near: number;
  readonly mid: number;
  readonly far: number;
  readonly waiting: number;
  readonly crossing: number;
  readonly detours: number;
  /** People currently on the ground, knocked down or shot. */
  readonly down: number;
  /** Times a vehicle has knocked somebody down. Cumulative. */
  readonly struck: number;
  readonly obstacles: number;
  readonly links: number;
  /** Mean milliseconds spent in `update` over the last 60 calls. */
  readonly updateMs: number;
  /** Tripo characters actually loaded. 0 means the procedural crowd is up. */
  readonly characters: number;
  /** Triangles in one person, for whichever crowd is being drawn. */
  readonly trianglesPerPerson: number;
}

/**
 * A near-neutral per-instance tint.
 *
 * Three characters would otherwise read as three hundred clones. The tint
 * keeps the luminance of the texture and only pushes its hue towards whatever
 * `appearance.ts` picked for this person's top, which is enough to break up a
 * street without turning anyone's skin green. The whole albedo is affected -
 * there is no per-garment mask on a generated character - so the shift is
 * deliberately small.
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

export class PedestrianSystem {
  readonly group: Object3D;

  private readonly crowd: Crowd;
  private readonly fallback: ProcPedestrianMeshBundle;
  private readonly bundles: PedestrianVatBundle[] = [];
  /**
   * The characters that actually downloaded, and the mesh each one was
   * installed into. Kept as two parallel arrays rather than indexing `bundles`
   * directly, because a character that fails to load leaves a hole: variant 1
   * of three survivors is not necessarily slot 1 of four meshes.
   */
  private readonly characters: PedestrianVatCharacter[] = [];
  private readonly loadedBundles: PedestrianVatBundle[] = [];
  private readonly graph: PavementGraph;
  private readonly obstacleCount: number;
  private readonly capacity: number;
  /**
   * Distance each pool slot has walked, in the rig's own units. This, not a
   * clock, is what drives the walk cycle: see `VatClip.phaseFor`. It is
   * advanced for every ACTIVE agent, not only the drawn ones, so nobody is
   * frozen mid-stride when they come into view.
   *
   * THE UNIT MATTERS. The instance matrix scales a pedestrian by `girth`
   * HORIZONTALLY and by `height` vertically, so a stride the bake measured as
   * 1.58 rig units lands on the ground as 1.58 * girth metres, not
   * 1.58 * height. Dividing by the wrong one runs the cycle about 1.7 times
   * too fast, which was measured in the browser as 130 mm of forward foot
   * slide per footfall before this was corrected.
   */
  private readonly walked: Float32Array;
  /** Previous position of each slot, so the REALISED displacement is used. */
  private readonly lastX: Float32Array;
  private readonly lastZ: Float32Array;
  private quality: PedestrianQuality;
  private drawRadius: number;
  private timeSum = 0;
  private timeCount = 0;
  private lastUpdateMs = 0;
  private disposed = false;

  constructor(options: PedestrianSystemOptions) {
    this.quality = options.quality;
    this.graph = buildPavementGraph(options.plan, options.network);

    const index = new ObstacleIndex(options.plan, options.ground, options.obstacles);
    this.obstacleCount = index.count;

    // The pool is always sized for the largest population so raising quality
    // mid-session never reallocates a buffer or restarts the crowd.
    this.capacity = options.density ?? POPULATION.high;
    this.crowd = new Crowd({
      ground: options.ground,
      network: options.network,
      graph: this.graph,
      obstacles: index,
      population: this.capacity,
      seed: options.plan.seed,
    });
    this.crowd.budget = options.density ?? POPULATION[this.quality];
    this.walked = new Float32Array(this.capacity);
    this.lastX = new Float32Array(this.capacity);
    this.lastZ = new Float32Array(this.capacity);

    this.fallback = createProcPedestrianMesh(this.capacity);
    this.drawRadius = options.density !== undefined ? RENDER_RADIUS : DRAW_RADIUS[this.quality];
    this.fallback.mesh.castShadow = this.quality !== 'low';

    this.group = new Group();
    this.group.name = 'pedestrians';
    this.group.add(this.fallback.mesh);

    // Every character's mesh joins the scene EMPTY, before its files exist, so
    // that `main.ts`'s pre-compile pass behind the loading screen builds their
    // programs. A material compiled on the first playable frame costs a 200 ms
    // freeze at the exact moment the player takes control.
    for (let slot = 0; slot < PEDESTRIAN_VAT_IDS.length; slot += 1) {
      const bundle = createPedestrianVatMesh(this.capacity, slot);
      bundle.mesh.castShadow = this.quality !== 'low';
      this.bundles.push(bundle);
      this.group.add(bundle.mesh);
    }

    // A handle for automated QA, which cannot reach this object any other way.
    this.group.userData.pedestrians = this;

    void this.loadCharacters();
  }

  /**
   * Downloads the baked characters and swaps them in.
   *
   * Whatever arrives is used: three of four is a slightly less varied crowd,
   * none of four leaves the procedural one up. Nothing here can reject.
   */
  private async loadCharacters(): Promise<void> {
    const loaded = await Promise.all(PEDESTRIAN_VAT_IDS.map((id) => loadPedestrianVat(id)));
    if (this.disposed) {
      for (const character of loaded) character?.dispose();
      return;
    }
    for (let i = 0; i < loaded.length; i += 1) {
      const character = loaded[i];
      const bundle = this.bundles[i];
      if (!character || !bundle) continue;
      bundle.install(character);
      this.characters.push(character);
      this.loadedBundles.push(bundle);
    }
    // Only stop drawing the placeholders once at least one real person exists.
    if (this.characters.length > 0) {
      this.fallback.mesh.visible = false;
      this.fallback.mesh.count = 0;
    }
  }

  private get ready(): boolean {
    return this.characters.length > 0;
  }

  /**
   * Reports every genuine vehicle-versus-pedestrian collision.
   *
   * WIRING, for whoever owns the driving layer and the wanted level. Set this
   * once after construction:
   *
   *     pedestrians.onImpact = (hit) => {
   *       // `hit.vehicle` is the very object handed to `update` in
   *       // `ctx.vehicles`, so identity is enough to tell your own car from
   *       // ambient traffic - no coordinate matching.
   *       if (hit.vehicle === myCrowdCarForThePlayer) {
   *         driving.reportImpact(hit.speed, hit.dirX, hit.dirZ);  // jolt + scrub
   *         player.addHeat(HEAT.vehicleImpact);                   // = 8
   *       }
   *     };
   *
   * It is a REAL collision - the chassis box grown by a shoulder and six
   * centimetres, moving above 1.6 m/s - so it cannot fire for driving past a
   * queue, which is the only reason it is safe to attach heat to it. One call
   * per person per knock-down; somebody already on the ground is never struck
   * twice.
   */
  set onImpact(listener: ((impact: PedestrianImpact) => void) | null) {
    this.crowd.onImpact = listener;
  }

  get onImpact(): ((impact: PedestrianImpact) => void) | null {
    return this.crowd.onImpact;
  }

  /**
   * Puts the person nearest a world point on the ground, permanently.
   *
   * This is the hook `CrowdTargets` documents as missing - "three lines in
   * `PedestrianSystem` exposing kill the agent nearest this point". Wire it as:
   *
   *     new CrowdTargets(pedestrians.group, {
   *       removeAt: (x, y, z) => { pedestrians.downAt(x, y, z); },
   *     });
   *
   * A shot civilian goes down through exactly the same state a struck one does,
   * so there is one kind of body in this city and the crowd only has to know
   * about one. Returns false when nobody was close enough - the pool slot may
   * have been recycled between the shot and the call.
   */
  downAt(x: number, _y: number, z: number, radius = DOWN_SEARCH): boolean {
    return this.crowd.downNearest(x, z, radius, true);
  }

  /**
   * Throws everybody inside a blast radius flat.
   *
   * Called by the combat layer AFTER it has decided who the explosion killed:
   * this is the visible consequence, not the damage model. Returns how many
   * people were moved, for diagnostics.
   */
  blastAt(x: number, z: number, radius: number): number {
    return this.crowd.blastAt(x, z, radius);
  }

  /**
   * Everybody standing on a carriageway, so traffic can brake for them.
   *
   * WIRING, for whoever owns `main.ts`. Two lines, once, after both systems
   * exist:
   *
   *     traffic.setObstacles(pedestrians.carriagewayObstacles());
   *     traffic.setCrossingBlocked((id) => pedestrians.crossingBlocked(id));
   *
   * `setObstacles` keeps the array by reference and this one is rebuilt in
   * place, so it never needs calling again.
   *
   * WHY IT MATTERS. Nothing in the shipped game makes a driver aware of a
   * pedestrian, and the crowd cannot make up the difference from its own side:
   * measured over ten minutes with 240 vehicles and 270 people, letting every
   * car hit somebody produced 210 knock-downs, of which 20 per cent were
   * traffic turning off the cross street on a green that runs at the same time
   * as the walk signal and 37 per cent were cars clearing the junction across
   * the far crossing during the 1.5 s all-red. A pedestrian cannot see either
   * coming. Until these are wired, `Crowd.trafficStrikes` stays off and only
   * the player's own vehicle knocks anybody over.
   */
  carriagewayObstacles(): readonly { x: number; z: number; radius: number }[] {
    return this.crowd.carriagewayObstacles();
  }

  /** True when somebody is standing on the crossing with this `Crossing.id`. */
  crossingBlocked(id: string): boolean {
    return this.crowd.crossingBlocked(id);
  }

  setQuality(quality: PedestrianQuality): void {
    if (this.quality === quality) return;
    this.quality = quality;
    this.crowd.budget = Math.min(this.capacity, POPULATION[quality]);
    this.drawRadius = DRAW_RADIUS[quality];
    this.fallback.mesh.castShadow = quality !== 'low';
    for (const bundle of this.bundles) bundle.mesh.castShadow = quality !== 'low';
  }

  get stats(): PedestrianStats {
    const s = this.crowd.stats;
    const character = this.characters[0];
    return {
      population: this.crowd.budget,
      active: s.active,
      rendered: s.rendered,
      stepped: s.stepped,
      near: s.near,
      mid: s.mid,
      far: s.far,
      waiting: s.waiting,
      crossing: s.crossing,
      detours: s.detours,
      down: s.down,
      struck: s.struck,
      obstacles: this.obstacleCount,
      links: this.graph.links.length,
      updateMs: this.lastUpdateMs,
      characters: this.characters.length,
      trianglesPerPerson: character ? character.triangles : PROC_TRIANGLES,
    };
  }

  update(dt: number, ctx: CrowdContext): void {
    if (this.disposed) return;
    const started = performance.now();
    this.crowd.update(dt, ctx);
    this.crowd.avoidPlayer(ctx.x, ctx.z, Math.min(dt, 0.1));

    // Distance actually covered, per active agent, in rig units.
    //
    // The REALISED displacement, not `speed * dt`: the crowd separates
    // overlapping people, clamps them inside the pavement corridor and pushes
    // them around street furniture after integrating velocity, so the speed it
    // reports is not the distance it moved. Projecting onto the heading keeps
    // a sideways shove from spinning the legs.
    //
    // A pool slot keeps its accumulator across a respawn on purpose: it is
    // only ever used modulo one cycle, and letting it run is what keeps the
    // crowd out of lockstep without a second source of randomness.
    for (let i = 0; i < this.crowd.peds.length; i += 1) {
      const ped = this.crowd.peds[i];
      if (!ped) continue;
      const dx = ped.x - (this.lastX[i] ?? 0);
      const dz = ped.z - (this.lastZ[i] ?? 0);
      this.lastX[i] = ped.x;
      this.lastZ[i] = ped.z;
      if (!ped.active) continue;
      // A respawn teleports the agent across the city; that is not a step, and
      // neither is being thrown along the road on your back.
      if (dx * dx + dz * dz > 2.25 || ped.state === 'down') continue;
      const forward = -dx * Math.sin(ped.heading) - dz * Math.cos(ped.heading);
      if (forward <= 0) continue;
      this.walked[i] = (this.walked[i] ?? 0) + forward / Math.max(0.4, ped.look.girth);
    }

    if (this.ready) this.writeVat(ctx);
    else this.writeFallback(ctx);

    this.timeSum += performance.now() - started;
    this.timeCount += 1;
    if (this.timeCount >= 60) {
      this.lastUpdateMs = Number((this.timeSum / this.timeCount).toFixed(3));
      this.timeSum = 0;
      this.timeCount = 0;
    }
  }

  /**
   * Writes the instance matrix for one person into `matrices` at slot `n`.
   *
   * The 3x3 is `Ry(heading) * Rx(tilt) * scale(girth, height, girth)`, stored
   * column-major as Three.js expects. `tilt` is zero for everybody on their
   * feet, which collapses to the yaw-and-scale form this used to write; for
   * somebody a car has knocked down it is the topple, and THAT IS THE WHOLE
   * KNOCK-DOWN RENDERER. A body on the ground is the same instance of the same
   * `InstancedMesh`, drawn by the same program from the same vertex animation
   * texture, so the crowd is still 270 people in six draw calls whether they
   * are walking or lying in the road.
   *
   * The four off-diagonal slots a tilt uses are written unconditionally rather
   * than left at the zero they were initialised to, because a pool slot that
   * held a body last frame and a walker this frame would otherwise keep the
   * body's shear.
   */
  private writeMatrix(matrices: Float32Array, n: number, ped: Crowd['peds'][number]): void {
    const m = n * 16;
    const c = Math.cos(ped.heading);
    const s = Math.sin(ped.heading);
    const width = ped.look.girth;
    const height = ped.look.height;
    const tilt = Crowd.tilt(ped);
    const ct = Math.cos(tilt);
    const st = Math.sin(tilt);
    matrices[m] = c * width;
    matrices[m + 1] = 0;
    matrices[m + 2] = -s * width;
    matrices[m + 4] = s * height * st;
    matrices[m + 5] = height * ct;
    matrices[m + 6] = c * height * st;
    matrices[m + 8] = s * width * ct;
    matrices[m + 9] = -width * st;
    matrices[m + 10] = c * width * ct;
    matrices[m + 12] = ped.x;
    // A body that has gone over is pivoting about its feet, so its front-back
    // axis is now the vertical one and half its thickness would be under the
    // pavement. Lifting by that half - the rig is authored one unit tall, so a
    // torso is about 0.12 of it - is the whole correction, and it is zero for
    // anybody upright.
    matrices[m + 13] = ped.y + DOWN_LIFT * width * Math.abs(st);
    matrices[m + 14] = ped.z;
  }

  /**
   * Packs the simulation into the baked characters' instance buffers.
   *
   * Rendered instances are compacted to the front of each character's buffer
   * so `count` can simply be the number drawn; that is the whole of the
   * render-side culling, and it means a person the player cannot see costs
   * nothing but the few arithmetic operations that moved them.
   */
  private writeVat(ctx: CrowdContext): void {
    const cutoff = this.drawRadius * this.drawRadius;
    const variants = this.characters.length;
    const counts = new Int32Array(variants);
    // Any character that failed to download keeps its mesh empty.
    for (const bundle of this.bundles) bundle.mesh.count = 0;

    for (let i = 0; i < this.crowd.peds.length; i += 1) {
      const ped = this.crowd.peds[i];
      if (!ped || !ped.active) continue;
      const dx = ped.x - ctx.x;
      const dz = ped.z - ctx.z;
      if (dx * dx + dz * dz > cutoff) continue;

      const look = ped.look;
      // Stable per person and re-rolled when a pool slot is recycled, because
      // it is derived from the appearance the crowd already generated. No new
      // draw on the shared RNG, so the simulation stays bit-identical.
      const variant = Math.min(
        variants - 1,
        Math.floor(hash2(look.topColor, look.skinColor, 3) * variants),
      );
      const character = this.characters[variant];
      const bundle = this.loadedBundles[variant];
      if (!character || !bundle) continue;

      const n = counts[variant] ?? 0;
      counts[variant] = n + 1;

      this.writeMatrix(bundle.mesh.instanceMatrix.array as Float32Array, n, ped);

      const anim = bundle.anim.array as Float32Array;
      const a = n * 4;
      anim[a] = character.walk.phaseFor(this.walked[i] ?? 0);
      // The idle has no travel to key off, so it runs on the clock with a
      // per-person rate and offset; two neighbours breathing in unison is the
      // giveaway this avoids.
      const idle = character.idle;
      if (ped.state === 'down') {
        // A body does not shift its weight. The clip is frozen at this
        // person's own offset, which keeps a row of casualties from all
        // holding an identical pose.
        anim[a + 1] = hash2(look.height, look.girth, 23);
      } else if (idle && idle.duration > 1e-3) {
        const rate = (0.85 + 0.3 * hash2(look.preferredSpeed, look.cadence, 11)) / idle.duration;
        anim[a + 1] = (hash2(look.height, look.girth, 23) + ctx.time * rate) % 1;
      } else {
        anim[a + 1] = 0;
      }
      anim[a + 2] = ped.gait;
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
      if (!bundle) continue;
      const n = counts[v] ?? 0;
      bundle.mesh.count = n;
      if (n > 0) {
        bundle.mesh.instanceMatrix.needsUpdate = true;
        bundle.anim.needsUpdate = true;
        bundle.tint.needsUpdate = true;
      }
    }
  }

  /** The procedural crowd, shown until the generated characters arrive. */
  private writeFallback(ctx: CrowdContext): void {
    const mesh = this.fallback.mesh;
    const matrices = mesh.instanceMatrix.array as Float32Array;
    const anim = this.fallback.anim.array as Float32Array;
    const anim2 = this.fallback.anim2.array as Float32Array;
    const colors = this.fallback.colors.array as Float32Array;
    const extra = this.fallback.extra.array as Float32Array;
    const cutoff = this.drawRadius * this.drawRadius;

    let n = 0;
    for (const ped of this.crowd.peds) {
      if (!ped.active) continue;
      const dx = ped.x - ctx.x;
      const dz = ped.z - ctx.z;
      if (dx * dx + dz * dz > cutoff) continue;

      const look = ped.look;
      this.writeMatrix(matrices, n, ped);

      // Hip swing that makes the planted foot travel exactly as far as the
      // body does in one stance phase. This is the no-sliding condition, and
      // the cadence `crowd.ts` used was chosen so it is always satisfiable.
      const amp = hipAmplitude(ped.speed, ped.cadenceNow, look.height) * ped.gait;

      const a = n * 4;
      anim[a] = ped.phase;
      anim[a + 1] = amp;
      anim[a + 2] = amp * look.armSwing * 0.85;
      anim[a + 3] = ped.gait;

      anim2[a] = look.bob;
      anim2[a + 1] = look.lean;
      anim2[a + 2] = look.shoulderRoll;
      anim2[a + 3] = look.shape;

      colors[a] = look.topColor;
      colors[a + 1] = look.bottomColor;
      colors[a + 2] = look.skinColor;
      colors[a + 3] = look.hairColor;

      extra[a] = look.accentColor;
      extra[a + 1] = look.shoeColor;

      n += 1;
    }

    mesh.count = n;
    if (n > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      this.fallback.anim.needsUpdate = true;
      this.fallback.anim2.needsUpdate = true;
      this.fallback.colors.needsUpdate = true;
      this.fallback.extra.needsUpdate = true;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.remove(this.fallback.mesh);
    this.fallback.dispose();
    for (const bundle of this.bundles) {
      this.group.remove(bundle.mesh);
      bundle.dispose();
    }
    for (const character of this.characters) character.dispose();
    this.characters.length = 0;
    this.loadedBundles.length = 0;
  }
}
