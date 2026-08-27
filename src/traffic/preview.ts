/**
 * Development harness for the traffic system.
 *
 * NOT part of the game. It exists so traffic can be looked at, driven around
 * and profiled in a real browser without waiting for it to be wired into
 * `src/main.ts`, and so the A/B frame-time measurement in the report can be
 * taken with and without the fleet in the same session and the same scene.
 *
 * Open it with `npm run dev` at /src/traffic/preview.html. It is not part of
 * the production bundle: Vite only builds `index.html`. Delete this file and
 * `preview.html` once traffic is live in the game.
 */

import { Vector3 } from 'three';

import { Engine } from '../core/Engine';
import { MaterialLibrary } from '../render/materials';
import { Lighting, type QualityLevel } from '../render/Lighting';
import { Sky } from '../render/Sky';
import { buildRoadNetwork, signalFor } from '../city/RoadNetwork';
import { getCityPlan } from '../world/CityPlan';
import { CityGround } from '../world/CityGround';
import { WorldSink, type PropPart } from '../world/WorldBuilder';
import type { PropKey } from '../world/build/types';
import { buildBuilding } from '../world/build/BuildingFactory';
import { buildBlockGround, buildIntersections, buildStreet } from '../world/build/StreetBuilder';
import { TrafficSystem } from './TrafficSystem';
import { loadVehicleModels } from './VehicleModels';

interface PreviewApi {
  look(x: number, z: number, yaw: number, pitch?: number, height?: number): unknown;
  /** Frames one vehicle from a given angle and distance. Development only. */
  focus(id: number, distance?: number, side?: number, height?: number): unknown;
  /** Every vehicle of a kind, nearest first, so a shell can be found to look at. */
  find(kind?: string): unknown;
  setTime(seconds: number): void;
  /** Runs the simulation forward synchronously, for a throttled tab. */
  advance(seconds: number, dt?: number): unknown;
  /** Signal state of the junction nearest a point, for both axes. */
  signal(x: number, z: number): unknown;
  setTimeScale(scale: number): void;
  setTrafficVisible(visible: boolean): void;
  setQuality(level: QualityLevel): void;
  renderBenchmark(frames?: number, width?: number, height?: number): unknown;
  readonly stats: unknown;
  readonly nearest: unknown;
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport');
  const hud = document.getElementById('hud');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('no canvas');

  const plan = getCityPlan();
  const ground = new CityGround(plan);
  const network = buildRoadNetwork(plan);

  const engine = new Engine(canvas);
  const materials = new MaterialLibrary();
  const sky = new Sky();
  engine.scene.add(sky.mesh);
  engine.scene.environment = sky.createEnvironment(engine.renderer);
  const lighting = new Lighting();
  lighting.addTo(engine.scene);

  const sink = new WorldSink();
  for (const street of plan.streets) buildStreet(street, plan, sink);
  buildIntersections(plan, sink);
  for (const block of plan.blocks) buildBlockGround(block, plan, sink);
  for (const parcel of plan.parcels) buildBuilding(parcel, sink);
  const { group } = sink.bake(materials, new Map<PropKey, readonly PropPart[]>());
  engine.scene.add(group);

  // The generated fleet, exactly as the game loads it. Without this the
  // harness drew the authored fallback shells, which is the one thing it must
  // not do: the whole point of looking at a vehicle here is to look at the
  // asset that actually ships.
  const models = await loadVehicleModels({ baseUrl: import.meta.env.BASE_URL });
  const traffic = new TrafficSystem({ plan, ground, network, quality: 'high', models });
  engine.scene.add(traffic.group);
  // One update at build time so the views exist before the first frame; a
  // backgrounded tab may not get a frame for a long time.
  traffic.update(0, { x: plan.spawn.x, z: plan.spawn.z, time: 0 });

  let clock = 0;
  let timeScale = 1;
  let frozen = false;

  const camera = engine.camera;
  const place = (x: number, z: number, yaw: number, pitch = 0, height = 1.75): void => {
    camera.position.set(x, ground.heightAt(x, z) + height, z);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
  };
  place(plan.spawn.x, plan.spawn.z, plan.spawn.heading);

  engine.onUpdate = (dt) => {
    materials.update(clock);
    if (!frozen) clock += dt * timeScale;
    lighting.update(camera.position.x, camera.position.y, camera.position.z);
    sky.follow(camera.position.x, camera.position.y, camera.position.z);
    traffic.update(frozen ? 0 : dt * timeScale, {
      x: camera.position.x,
      z: camera.position.z,
      time: clock,
    });
    if (hud) {
      const stats = engine.getStats();
      const t = traffic.stats;
      hud.textContent =
        `fps ${stats.fps.toFixed(0)}  draws ${stats.drawCalls}  tris ${(stats.triangles / 1000).toFixed(0)}k\n` +
        `traffic ${t.active}/${t.population} drawn ${t.drawnVehicles}  clock ${clock.toFixed(1)}s\n` +
        `cam ${camera.position.x.toFixed(0)}, ${camera.position.z.toFixed(0)}`;
    }
  };

  await engine.renderer.compileAsync(engine.scene, engine.camera);
  engine.renderer.render(engine.scene, engine.camera);
  engine.start();

  const api: PreviewApi = {
    look(x, z, yaw, pitch = 0, height = 1.75) {
      place(x, z, yaw, pitch, height);
      traffic.update(0, { x, z, time: clock });
      lighting.update(camera.position.x, camera.position.y, camera.position.z);
      sky.follow(camera.position.x, camera.position.y, camera.position.z);
      engine.renderer.render(engine.scene, engine.camera);
      return { x, z, yaw, pitch, y: camera.position.y };
    },
    focus(id, distance = 8, side = 1, height = 1.7) {
      const view = traffic.vehicles.find((v) => v.id === id);
      if (!view) return null;
      const angle = view.yaw + side;
      const cx = view.x + Math.sin(angle) * distance;
      const cz = view.z + Math.cos(angle) * distance;
      const dx = view.x - cx;
      const dz = view.z - cz;
      const length = Math.hypot(dx, dz) || 1;
      const yaw = Math.atan2(-dx / length, -dz / length);
      place(cx, cz, yaw, -0.12, height);
      traffic.update(0, { x: cx, z: cz, time: clock });
      lighting.update(camera.position.x, camera.position.y, camera.position.z);
      sky.follow(camera.position.x, camera.position.y, camera.position.z);
      engine.renderer.render(engine.scene, engine.camera);
      return { id: view.id, kind: view.kind, x: view.x, z: view.z, yaw: view.yaw };
    },
    find(kind) {
      return traffic.vehicles
        .filter((v) => !kind || v.kind === kind)
        .map((v) => ({ id: v.id, kind: v.kind, x: Number(v.x.toFixed(1)), z: Number(v.z.toFixed(1)), speed: Number(v.speed.toFixed(1)) }));
    },
    signal(x, z) {
      let best = network.junctions[0];
      let bestDistance = Infinity;
      for (const junction of network.junctions) {
        const d = Math.hypot(junction.x - x, junction.z - z);
        if (d < bestDistance) {
          bestDistance = d;
          best = junction;
        }
      }
      if (!best) return null;
      return {
        id: best.id,
        x: best.x,
        z: best.z,
        northSouth: signalFor(best, 'x', clock),
        eastWest: signalFor(best, 'z', clock),
        clock: Number(clock.toFixed(2)),
      };
    },
    setTime(seconds) {
      clock = seconds;
    },
    advance(seconds, dt = 1 / 60) {
      const steps = Math.max(1, Math.round(seconds / dt));
      for (let i = 0; i < steps; i += 1) {
        clock += dt;
        traffic.update(dt, { x: camera.position.x, z: camera.position.z, time: clock });
      }
      materials.update(clock);
      lighting.update(camera.position.x, camera.position.y, camera.position.z);
      sky.follow(camera.position.x, camera.position.y, camera.position.z);
      engine.renderer.render(engine.scene, engine.camera);
      return { clock, steps, ...traffic.stats };
    },
    setTimeScale(scale) {
      timeScale = scale;
      frozen = scale === 0;
    },
    setTrafficVisible(visible) {
      traffic.group.visible = visible;
    },
    setQuality(level) {
      engine.setQuality(level);
      lighting.applyQuality(level);
      traffic.setQuality(level);
    },
    renderBenchmark(frames = 90, width, height) {
      if (width && height) engine.renderer.setSize(width, height, false);
      const gl = engine.renderer.getContext();
      const pixel = new Uint8Array(4);
      const sync = (): void => {
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      };
      for (let i = 0; i < 8; i += 1) engine.renderer.render(engine.scene, engine.camera);
      sync();
      const samples: number[] = [];
      let calls = 0;
      let triangles = 0;
      for (let i = 0; i < frames; i += 1) {
        const t0 = performance.now();
        engine.renderer.info.reset();
        engine.renderer.render(engine.scene, engine.camera);
        sync();
        samples.push(performance.now() - t0);
        calls = engine.renderer.info.render.calls;
        triangles = engine.renderer.info.render.triangles;
      }
      samples.sort((a, b) => a - b);
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      const size = [engine.renderer.domElement.width, engine.renderer.domElement.height];
      if (width && height) engine.resize();
      return {
        frames,
        renderedAt: size,
        meanMs: Number(mean.toFixed(3)),
        medianMs: Number((samples[Math.floor(samples.length / 2)] ?? 0).toFixed(3)),
        drawCalls: calls,
        triangles,
      };
    },
    get stats() {
      return { ...traffic.stats, engine: engine.getStats(), clock };
    },
    get nearest() {
      const out: unknown[] = [];
      traffic.forEachNear(camera.position.x, camera.position.z, 45, (view) => {
        out.push({
          id: view.id,
          kind: view.kind,
          police: view.police,
          x: Number(view.x.toFixed(2)),
          y: Number(view.y.toFixed(2)),
          z: Number(view.z.toFixed(2)),
          yaw: Number(view.yaw.toFixed(3)),
          speed: Number(view.speed.toFixed(2)),
          pitch: Number(view.pitch.toFixed(4)),
          roll: Number(view.roll.toFixed(4)),
          braking: view.braking,
        });
      });
      return out;
    },
  };

  const target = window as unknown as Record<string, unknown>;
  target.__traffic = api;
  // The scene itself, so automated checks can read the instanced attributes
  // and confirm what is actually being sent to the GPU.
  target.__scene = engine.scene;
  const scratch = new Vector3();
  target.__cam = (): unknown => camera.getWorldDirection(scratch).toArray();
}

void boot().catch((error: unknown) => {
  const hud = document.getElementById('hud');
  if (hud) hud.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
  // eslint-disable-next-line no-console
  console.error('[traffic preview]', error);
});
