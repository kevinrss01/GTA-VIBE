/**
 * TEMPORARY verification harness for the combat, wanted and police layers.
 *
 * `src/main.ts` belongs to another workstream and is not ours to change, so
 * this boots the same city the game boots - the same plan, ground, colliders,
 * road network, traffic and crowd - and wires the combat layer into it exactly
 * as `main.ts` should. It exists to prove the loop end to end in a real
 * browser and to be the reference the wiring instructions are copied from.
 *
 * DELETE THIS FILE, and `dev-combat.html`, once `main.ts` carries the wiring.
 * Nothing in the shipped bundle imports it: `vite build` has one entry point.
 */

import { Vector3 } from 'three';

import { PedestrianSystem } from '../agents/PedestrianSystem';
import { buildRoadNetwork } from '../city/RoadNetwork';
import { Engine } from '../core/Engine';
import { CollisionWorld } from '../player/Collision';
import { Driving } from '../player/Driving';
import { FirstPersonController } from '../player/FirstPersonController';
import { MAX_HEALTH, PlayerState } from '../player/PlayerState';
import { PoliceSystem } from '../police/PoliceSystem';
import { Lighting } from '../render/Lighting';
import { MaterialLibrary } from '../render/materials';
import { Sky } from '../render/Sky';
import { TrafficSystem } from '../traffic/TrafficSystem';
import { Hud } from '../ui/Hud';
import { CityGround } from '../world/CityGround';
import { getCityPlan } from '../world/CityPlan';
import { buildBuilding } from '../world/build/BuildingFactory';
import { createPropGeometry } from '../world/build/PropLibrary';
import { scatterStreetProps } from '../world/build/PropScatter';
import { buildBlockGround, buildIntersections, buildStreet } from '../world/build/StreetBuilder';
import { ALL_PROP_KEYS, type PropKey } from '../world/build/types';
import { WorldSink, type PropPart } from '../world/WorldBuilder';
import { CombatSystem } from './CombatSystem';
import { CrowdTargets } from './CrowdTargets';
import { WorldRayIndex } from './rays';
import { RespawnDirector } from './Respawn';
import { defaultViewmodels } from './WeaponViewmodel';

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport');
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error('viewport canvas is missing');

  const plan = getCityPlan();
  const ground = new CityGround(plan);
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
  scatterStreetProps(plan, sink);

  const propGeometry = new Map<PropKey, PropPart[]>();
  for (const key of ALL_PROP_KEYS) {
    const parts = createPropGeometry(key);
    if (parts.length > 0) propGeometry.set(key, parts as PropPart[]);
  }
  const { group } = sink.bake(materials, propGeometry);
  engine.scene.add(group);

  const collision = new CollisionWorld(sink.colliders);
  lighting.setLightRequests(sink.lights);

  const network = buildRoadNetwork(plan);
  const pedestrians = new PedestrianSystem({
    plan, ground, network, quality: 'high', obstacles: sink.colliders,
  });
  engine.scene.add(pedestrians.group);
  const traffic = new TrafficSystem({ plan, ground, network, quality: 'high' });
  engine.scene.add(traffic.group);

  const controller = new FirstPersonController({
    ground, collision, camera: engine.camera, domElement: canvas, spawn: plan.spawn,
  });
  const driving = new Driving({
    traffic, ground, collision, camera: engine.camera, controller, domElement: canvas,
  });

  const hud = new Hud({
    onMusicToggle: () => undefined,
    onResume: () => undefined,
    onQualityChange: () => undefined,
  });
  document.body.appendChild(hud.element);

  // ===================== THE WIRING UNDER TEST =============================

  const player = new PlayerState();
  const worldRays = new WorldRayIndex(sink.colliders);
  // Wired exactly as `main.ts` wires it: a lethal hit is forwarded to the
  // crowd with the round's CONTACT POINT and direction of travel, so the right
  // person goes down the right way and stays down.
  const civilians = new CrowdTargets(pedestrians.group, {
    removeAt: (x: number, y: number, z: number, dirX?: number, dirZ?: number) => {
      pedestrians.downAt(x, y, z, undefined, dirX, dirZ);
    },
  });

  const police = new PoliceSystem({
    player,
    traffic,
    network,
    collision,
    world: worldRays,
    heightAt: (x, z) => ground.heightAt(x, z),
    quality: 'high',
    seed: plan.seed,
    onArrest: () => respawn.bust('busted'),
  });
  engine.scene.add(police.group);

  const combat = new CombatSystem({
    player,
    camera: engine.camera,
    domElement: canvas,
    world: worldRays,
    heightAt: (x, z) => ground.heightAt(x, z),
    civilians,
    vehicles: traffic,
    law: police,
    hud,
    seed: plan.seed,
    viewmodels: defaultViewmodels(import.meta.env.BASE_URL),
  });
  engine.scene.add(combat.group);
  police.setEffects(combat.effects);

  const respawn = new RespawnDirector({
    player,
    spawn: plan.spawn,
    teleport: (x, z, heading) => controller.teleport(x, z, heading),
    // Every seat the player can be in. This harness has no flight layer; the
    // game does, and `main.ts` has to list it here too or a player killed in
    // the air is respawned still nominally flying. See `RespawnDirector`.
    mounts: [{ occupied: () => driving.driving, exit: () => driving.exit() }],
    setPaused: (paused) => controller.setPaused(paused),
    onBanner: (title, detail) => hud.setBanner(title, detail),
    onBust: () => {
      police.standDown();
      combat.reset();
    },
  });

  const forward = new Vector3();
  /**
   * When frozen, the rAF loop still RENDERS but simulates nothing.
   *
   * The canvas has no preserved drawing buffer, so a screenshot taken while
   * the loop is stopped is black; the world has to keep being drawn while it
   * is being looked at, and `step` is what advances it.
   */
  let frozen = false;
  const simulate = (dt: number, elapsed: number): void => {
    materials.update(elapsed);
    controller.update(dt);
    driving.update(dt);
    const walk = controller.state;
    const drive = driving.state;
    const state = drive.driving
      ? { ...walk, x: drive.x, y: drive.y, z: drive.z, yaw: drive.yaw, speed: Math.abs(drive.speed) }
      : walk;

    traffic.update(dt, { x: state.x, z: state.z, time: elapsed });
    pedestrians.update(dt, { x: state.x, y: state.y, z: state.z, time: elapsed });

    forward.set(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
    police.update(dt, {
      time: elapsed,
      playerX: state.x,
      playerY: state.y,
      playerZ: state.z,
      playerSpeed: state.speed,
      forwardX: forward.x,
      forwardZ: forward.z,
      driving: drive.driving,
    });
    combat.update(dt, {
      driving: drive.driving,
      playerX: state.x,
      playerY: state.y,
      playerZ: state.z,
      playerSpeed: state.speed,
    });
    respawn.update(dt);

    hud.setWanted(player.wanted);
    hud.setHealth(player.health, MAX_HEALTH);
    hud.setMoney(player.money);

    sky.follow(state.x, state.y, state.z);
    lighting.update(state.x, state.y + 1.6, state.z);
  };

  engine.onUpdate = (dt, elapsed) => {
    if (!frozen) simulate(dt, elapsed);
  };

  // =========================================================================

  let clock = 0;
  engine.start();
  hud.setPointerLocked(true);

  const handle = {
    /**
     * Stops or starts the rAF loop. Automated verification drives the game
     * with `step` alone, and a screenshot forces the pane to composite - which
     * restarts rAF and advances the world between two tool calls.
     */
    loop(on: boolean): void {
      if (on) engine.start();
      else engine.stop();
    },
    /** Stops the world advancing while leaving it being drawn. */
    freeze(on: boolean): void {
      frozen = on;
    },
    step(frames = 60, dt = 1 / 60): void {
      const was = frozen;
      frozen = true;
      for (let i = 0; i < frames; i += 1) {
        simulate(dt, clock);
        clock += dt;
        engine.stepOnce(0);
      }
      frozen = was;
    },
    look(x: number, z: number, yaw: number, pitch = 0): unknown {
      controller.teleport(x, z, yaw);
      controller.setPitch(pitch);
      controller.update(1 / 60);
      return controller.state;
    },
    give(id: 'pistol' | 'smg' | 'shotgun' | 'rifle', magazines = 8): boolean {
      player.earn(50_000);
      player.buyWeapon(id);
      for (let i = 0; i < magazines; i += 1) player.buyAmmo(id);
      return player.equip(id);
    },
    fire(times = 1): number {
      let fired = 0;
      for (let i = 0; i < times; i += 1) {
        if (combat.fireOnce()) fired += 1;
        engine.stepOnce(1 / 60);
      }
      return fired;
    },
    hold(on: boolean): void {
      combat.setTrigger(on);
    },
    get state(): unknown {
      const s = controller.state;
      return {
        health: player.health,
        money: player.money,
        heat: Number(player.heat.toFixed(1)),
        stars: player.wanted,
        alive: player.alive,
        equipped: player.equipped,
        magazine: combat.magazine,
        reserve: player.equipped ? player.ammo(player.equipped) : 0,
        respawns: respawn.count,
        outcome: respawn.outcome,
        position: { x: Number(s.x.toFixed(1)), y: Number(s.y.toFixed(1)), z: Number(s.z.toFixed(1)) },
        driving: driving.driving,
        viewmodelReady: combat.viewmodelReady,
        viewmodelFailed: combat.viewmodelFailures,
      };
    },
    get combat(): unknown {
      return combat.stats;
    },
    get police(): unknown {
      return police.stats;
    },
    get units(): unknown {
      const s = controller.state;
      return police.unitReport.map((u) => ({
        ...u,
        distance: Number(Math.hypot(u.x - s.x, u.z - s.z).toFixed(1)),
      }));
    },
    get crowd(): unknown {
      return { drawn: civilians.liveCount, tracked: civilians.trackedCount, down: civilians.downCount };
    },
    get traffic(): unknown {
      return traffic.stats;
    },
    /** The scene, so the viewmodel transform can be tuned live. */
    get scene(): unknown {
      return engine.scene;
    },
    get engineStats(): unknown {
      return engine.getStats();
    },
    /** Renders N frames back to back with a GPU sync, for a truthful cost. */
    bench(frames = 90, width?: number, height?: number): unknown {
      if (width && height) engine.renderer.setSize(width, height, false);
      const gl = engine.renderer.getContext();
      const pixel = new Uint8Array(4);
      const sync = (): void => {
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      };
      for (let i = 0; i < 6; i += 1) engine.renderer.render(engine.scene, engine.camera);
      sync();
      const samples: number[] = [];
      for (let i = 0; i < frames; i += 1) {
        const t0 = performance.now();
        engine.renderer.info.reset();
        engine.renderer.render(engine.scene, engine.camera);
        sync();
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      const info = engine.renderer.info;
      const size = [engine.renderer.domElement.width, engine.renderer.domElement.height];
      if (width && height) engine.resize();
      return {
        frames,
        renderedAt: size,
        meanMs: Number(mean.toFixed(2)),
        medianMs: Number((samples[Math.floor(frames * 0.5)] ?? 0).toFixed(2)),
        p95Ms: Number((samples[Math.floor(frames * 0.95)] ?? 0).toFixed(2)),
        drawCalls: info.render.calls,
        triangles: info.render.triangles,
      };
    },
    /** CPU cost of one simulation update, averaged. Excludes rendering. */
    cpu(frames = 240): unknown {
      const was = frozen;
      frozen = true;
      const started = performance.now();
      for (let i = 0; i < frames; i += 1) {
        simulate(1 / 60, clock);
        clock += 1 / 60;
      }
      const ms = (performance.now() - started) / frames;
      frozen = was;
      return { frames, msPerFrame: Number(ms.toFixed(3)) };
    },
    heat(amount: number): void {
      player.addHeat(amount);
    },
    standDown(): void {
      police.standDown();
      player.clearHeat();
    },
    kill(): void {
      player.hurt(MAX_HEALTH);
    },
  };

  Object.defineProperty(window, '__combat', { value: handle, writable: false });
  // eslint-disable-next-line no-console
  console.warn('[harness] ready. window.__combat');
}

void boot().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[harness] boot failed', error);
});
